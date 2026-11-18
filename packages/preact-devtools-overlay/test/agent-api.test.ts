// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentApi } from "../src/agent/api";
import { ComponentTree } from "../src/agent/tree";
import { RingBuffer } from "../src/agent/ring-buffer";
import { SignalsStore } from "../src/agent/signals";

/**
 * Loads the client, then Preact, `preact/debug` and signals the way the
 * Vite plugin's entry module does. Only once per file: Preact is an external
 * dependency, so `vi.resetModules()` would not give us a fresh copy.
 */
async function load() {
	const client = await import("../src/client");
	await import("preact/debug");
	const signalsDebug = await import("@preact/signals-debug");
	client.configureSignalsDebug(signalsDebug.setDebugOptions as any, { consoleLogging: "compact" });
	const preact = await import("preact");
	const hooks = await import("preact/hooks");
	const signals = await import("@preact/signals");
	expect(client.trackSignals(signals.Signal, signals.effect, signals.computed)).toBe(true);
	const api = window.__PREACT_DEVTOOLS_OVERLAY__!.api!;
	return { preact, hooks, signals, api };
}

const flush = () => new Promise(r => setTimeout(r, 20));

describe("agent API", () => {
	let container: HTMLElement;
	let env: Awaited<ReturnType<typeof load>>;

	beforeAll(async () => {
		env = await load();
	});
	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
	});
	afterEach(() => {
		env.preact.render(null, container);
		container.remove();
	});

	it("exposes the tree, render reasons and signals", async () => {
		const { preact, hooks, signals, api } = env;
		const { h, Component, render } = preact;

		const todos = signals.signal([{ id: 1, done: false }], { name: "todos" });
		let setCount!: (n: number) => void;

		function Counter() {
			const [count, set] = hooks.useState(0);
			setCount = set;
			return h("button", { id: "counter" }, `count ${count}`);
		}
		class Box extends Component<{ label: string }, { open: boolean }> {
			state = { open: false };
			render() {
				return h("p", { class: "box" }, this.props.label);
			}
		}
		function Item({ todo }: { todo: { id: number; done: boolean } }) {
			return h("li", null, String(todo.done));
		}
		function App() {
			return h(
				"main",
				null,
				h(Counter, null),
				h(Box, { label: "box" }),
				h("ul", null, todos.value.map(t => h(Item, { key: t.id, todo: t }))),
			);
		}

		render(h(App, null), container);

		expect(api.getTree({ format: "text" })).toMatch(
			/^App #\d+\n {2}Counter #\d+\n {2}Box #\d+ \[class\]\n {2}Item #\d+ \[key="1"\]$/,
		);
		const [counter] = api.find("Counter");
		expect(counter.path).toBe("App > Counter");
		expect(api.find("#counter")).toEqual([counter]);
		expect(api.find(container.querySelector(".box")!)[0].name).toBe("Box");
		expect(() => api.find("div[[")).toThrow(/neither a component name/);

		const info = api.inspect("Box") as any;
		expect(info).toMatchObject({ name: "Box", kind: "class", props: { label: "box" }, state: { open: false } });
		expect((api.inspect("Counter") as any).hooks).toEqual([
			{ hook: "useState", index: 0, value: 0, editable: true },
		]);

		// Hooks
		const mark = api.mark();
		setCount(1);
		await flush();
		expect(api.whyDidRender("Counter", { last: 1 })).toMatchObject([
			{ name: "Counter", reason: "hooks", hooks: [{ key: "useState[0]", prev: 0, next: 1 }] },
		]);

		// Signals: App re-renders because it read `todos`, Item because of its props.
		todos.value = [{ id: 1, done: true }];
		await flush();
		const renders = api.getRenders({ since: mark }) as any[];
		const app = renders.find(r => r.name === "App");
		expect(app.reason).toBe("signal");
		expect(app.signals[0].key).toBe("todos");
		expect(renders.find(r => r.name === "Item").reason).toBe("props");
		expect(renders.find(r => r.name === "Box").reason).toBe("parent");
		expect(api.getRenders({ since: mark, format: "text" })).toContain(
			"App #",
		);
		expect(api.getRenders({ since: mark, format: "text" })).toContain("todos[0].done: false → true");

		// Signal updates were recorded although no Signals pane was open.
		expect(api.getSignalUpdates({ name: "todos" })).toMatchObject([
			{ name: "todos", type: "signal", next: [{ id: 1, done: true }] },
		]);
		const known = (api.getSignals({ name: "todos" }) as any[])[0];
		expect(known.readBy.map((r: any) => r.name)).toEqual(["App"]);

		// Editing goes through the same code paths as the panel.
		api.update("Box", "props", "label", "edited");
		await flush();
		expect(container.querySelector(".box")!.textContent).toBe("edited");

		expect(api.status()).toMatchObject({ renderers: 1, signalsDebug: true, asyncTree: false });
		render(null, container);
		expect(api.getTree()).toEqual([]);
		// Renders of unmounted components stay queryable by name.
		expect((api.getRenders({ target: "Item" }) as any[]).length).toBeGreaterThan(0);
	});

	it("records renders between startRecording and stopRecording", async () => {
		const { preact, hooks, api } = env;
		let bump!: () => void;
		function Clock() {
			const [n, set] = hooks.useState(0);
			bump = () => set(x => x + 1);
			return preact.h("span", null, n);
		}
		preact.render(preact.h(Clock, null), container);
		api.startRecording();
		bump();
		await flush();
		const out = api.stopRecording() as any;
		expect(out.renders.map((r: any) => `${r.name}:${r.reason}`)).toEqual(["Clock:hooks"]);
		expect(api.stopRecording({ format: "text" })).toContain("(no renders recorded)");
	});

	it("refuses update paths that reach prototypes", () => {
		const { preact, api } = env;
		function Plain(props: { a: number }) {
			return preact.h("i", null, props.a);
		}
		preact.render(preact.h(Plain, { a: 1 }), container);
		for (const path of ["__proto__.polluted", "constructor.prototype.polluted"]) {
			expect(() => api.update("Plain", "context", path, true)).toThrow(/Refusing/);
			expect(() => api.update("Plain", "props", path.split("."), true)).toThrow(/Refusing/);
		}
		expect(({} as any).polluted).toBeUndefined();
	});

	it("keeps commits of nested renders and failed renders apart", async () => {
		const { preact, hooks, api } = env;
		const { h } = preact;
		const other = document.createElement("div");
		document.body.append(other);
		function Inner() {
			return h("b", null, "inner");
		}
		function Outer() {
			hooks.useLayoutEffect(() => {
				preact.render(h(Inner, null), other);
			}, []);
			return h("p", null, "outer");
		}
		const mark = api.mark();
		preact.render(h(Outer, null), container);
		const rows = api.getRenders({ since: mark }) as any[];
		const outer = rows.find(r => r.name === "Outer");
		const inner = rows.find(r => r.name === "Inner");
		expect(inner.commit).toBeGreaterThan(outer.commit);

		// A render that throws never commits; its finished children must not
		// show up in the next commit.
		function Child() {
			return h("span", null, "child");
		}
		function Broken(): null {
			throw new Error("broken");
		}
		const failing = document.createElement("div");
		const mark2 = api.mark();
		expect(() => preact.render(h("div", null, h(Child, null), h(Broken, null)), failing)).toThrow("broken");
		preact.render(h(Inner, null), other);
		const after = (api.getRenders({ since: mark2 }) as any[]).map(r => r.name);
		expect(after).not.toContain("Child");
		preact.render(null, other);
		other.remove();
	});

	it("explains context changes and names the provider", async () => {
		const { preact, hooks, api } = env;
		const { h } = preact;
		const Theme = preact.createContext("light");
		Theme.displayName = "Theme";
		let setTheme!: (t: string) => void;
		function Provider({ children }: { children?: any }) {
			const [theme, set] = hooks.useState("light");
			setTheme = set;
			return h(Theme.Provider, { value: theme }, children);
		}
		function Label() {
			return h("span", null, hooks.useContext(Theme));
		}
		class ClassLabel extends preact.Component {
			static contextType = Theme;
			render() {
				return h("b", null, String(this.context));
			}
		}
		preact.render(h(Provider, null, h(Label, null), h(ClassLabel, null)), container);
		expect((api.inspect("Label") as any).contexts).toEqual([
			{ name: "Theme", value: "light", provider: { id: expect.any(Number), path: "Provider > Theme.Provider" } },
		]);
		const mark = api.mark();
		setTheme("dark");
		await flush();
		const rows = api.getRenders({ since: mark }) as any[];
		for (const name of ["Label", "ClassLabel"]) {
			expect(rows.find(r => r.name === name)).toMatchObject({
				reason: "context",
				context: [{ key: "Theme", prev: "light", next: "dark" }],
			});
		}
	});

	it("finds effects that outlive their component and signals created on re-render", async () => {
		const { preact, hooks, signals, api } = env;
		const { h } = preact;
		const source = signals.signal(0, { name: "source" });
		let rerender!: () => void;
		function Leaky() {
			const [, set] = hooks.useState(0);
			rerender = () => set(n => n + 1);
			signals.effect(() => void source.value, { name: "leakyEffect" });
			return h("i", null, "leaky");
		}
		let rerenderFine!: (n: number) => void;
		function Fine() {
			const [n, set] = hooks.useState(0);
			rerenderFine = set;
			signals.useSignalEffect(() => void source.value);
			signals.useSignal(0);
			// Recreated whenever its dependency changes, here on every
			// re-render: still fine, it's memoized.
			hooks.useMemo(() => signals.computed(() => source.value + n), [n]);
			return h("i", null, "fine");
		}
		preact.render(h("div", null, h(Leaky, null), h(Fine, null)), container);
		// Re-render before the effects of the first render ran: preact/hooks
		// runs them in its render hook.
		rerenderFine(1);
		await flush();
		for (let i = 2; i <= 5; i++) {
			rerender();
			rerenderFine(i);
			await flush();
		}
		// The useSignalEffect effect ran in preact/hooks' render hook, but the
		// render didn't create it.
		const registry = (window as any).__PREACT_DEVTOOLS_OVERLAY__.registry;
		const fineEffects = registry.entries.filter(
			(e: any) => e.kind === "effect" && e.owner?.name === "Fine" && e.createdOnRerender,
		);
		expect(fineEffects).toHaveLength(0);
		expect(api.getLeaks()).toEqual([
			{
				problem: "created-on-rerender",
				owner: { id: expect.any(Number), name: "Leaky" },
				kind: "effect",
				count: 4,
				names: ["leakyEffect"],
				rerenders: { creating: 4, total: 4 },
			},
		]);
		preact.render(null, container);
		await flush();
		const leaks = api.getLeaks() as any[];
		expect(leaks.find(l => l.problem === "outlived-component")).toMatchObject({
			owner: { id: null, name: "Leaky" },
			kind: "effect",
			count: 5,
		});
		expect(leaks.some(l => l.owner.name === "Fine")).toBe(false);
		expect(api.getLeaks({ format: "text" })).toContain("Leaky: 5 effects (leakyEffect) still running after it unmounted");

		// Two instances of the same component are two groups.
		function Twice() {
			signals.effect(() => void source.value, { name: "twice" });
			return null;
		}
		preact.render(h("div", null, h(Twice, null), h(Twice, null)), container);
		preact.render(null, container);
		await flush();
		expect((api.getLeaks() as any[]).filter(l => l.owner.name === "Twice").map(l => l.count)).toEqual([1, 1]);

		// The inventory has every signal, read or not.
		const unread = signals.signal(1, { name: "neverRead" });
		expect(api.getSignals({ name: "neverRead" })).toMatchObject([{ name: "neverRead", value: 1, subscribers: 0 }]);
		void unread;
	});

	it("attributes renders that preact/hooks flushes pending effects in", async () => {
		const { preact, hooks, signals, api } = env;
		const { h } = preact;
		const source = signals.signal(0);
		function EffectsAndLeak(_: { n: number }) {
			// Before the first hook call, and an effect created in useEffect.
			signals.effect(() => void source.value, { name: "bodyEffect" });
			hooks.useEffect(() => signals.effect(() => void source.value, { name: "inUseEffect" }));
			return null;
		}
		// Synchronous re-renders, before the pending effects ran after paint.
		for (let n = 0; n < 4; n++) preact.render(h(EffectsAndLeak, { n }), container);
		preact.render(null, container);
		await flush();
		const leaks = (api.getLeaks() as any[]).filter(l => l.owner.name === "EffectsAndLeak");
		expect(leaks).toEqual([expect.objectContaining({ problem: "outlived-component", count: 4, names: ["bodyEffect"] })]);
	});

	it("doesn't let a memoized computed hide a leaking effect", async () => {
		const { preact, hooks, signals, api } = env;
		const source = signals.signal(0);
		function MemoAndLeak({ n }: { n: number }) {
			hooks.useMemo(() => signals.computed(() => source.value + n), [n]);
			signals.effect(() => void source.value, { name: "perRender" });
			return null;
		}
		for (let n = 0; n < 4; n++) {
			preact.render(preact.h(MemoAndLeak, { n }), container);
			await flush();
		}
		const leaks = (api.getLeaks() as any[]).filter(l => l.owner.name === "MemoAndLeak");
		expect(leaks).toEqual([
			expect.objectContaining({ problem: "created-on-rerender", kind: "effect", names: ["perRender"] }),
		]);
		preact.render(null, container);
		await flush();
	});

	it("forgets the rendering component when a render throws", () => {
		const { preact, signals } = env;
		function Throws(): null {
			throw new Error("boom");
		}
		expect(() => preact.render(preact.h(Throws, null), container)).toThrow("boom");
		const s = signals.signal(0, { name: "afterThrow" });
		const registry = (window as any).__PREACT_DEVTOOLS_OVERLAY__.registry;
		const entry = registry.entries.find((e: any) => e.ref.deref() === s);
		expect(entry.owner).toBeNull();
	});

	it("logs signal updates one line each in compact mode", async () => {
		const { signals } = env;
		const lines: string[] = [];
		const log = console.log;
		console.log = (...args: unknown[]) => void lines.push(args.join(" "));
		try {
			const s = signals.signal({ n: 1 }, { name: "compactDemo" });
			const dispose = signals.effect(() => void s.value);
			s.value = { n: 2 };
			await flush();
			dispose();
		} finally {
			console.log = log;
		}
		expect(lines).toContain("[signals] signal compactDemo.n: 1 → 2");
		expect(lines).toContain("[signals] effect effect ran (compactDemo)");
	});

	it("resolves a DOM target to the innermost app", () => {
		const outerEl = document.createElement("section");
		const button = document.createElement("button");
		outerEl.append(button);
		const tree = new ComponentTree();
		const names = ["Outer", "Inner"];
		const table = names.flatMap(n => [n.length, ...Array.from(n, c => c.charCodeAt(0))]);
		tree.apply([1, table.length, ...table, 1, 10, 2, 10, 0, -1, -1, 1, 0, 0, 0, 1, 20, 2, 20, 0, -1, -1, 2, 0, 0, 0]);
		const renderer = (owns: Map<Element, number>) => ({
			getVNodeById: (id: number) => ([...owns.values()].includes(id) ? {} : null),
			findVNodeIdForDom: (el: any) => owns.get(el) ?? -1,
			inspect: () => null,
			update() {},
		});
		const api = createAgentApi({
			tree,
			renders: new RingBuffer(10),
			signals: new SignalsStore(() => 1),
			// The outer app is listed first and knows the ancestor.
			getRenderers: () => [renderer(new Map([[outerEl, 10]])), renderer(new Map([[button, 20]]))],
			currentSeq: () => 0,
			version: "test",
			asyncTree: false,
		});
		expect(api.find(button).map(n => n.name)).toEqual(["Inner"]);
	});
});
