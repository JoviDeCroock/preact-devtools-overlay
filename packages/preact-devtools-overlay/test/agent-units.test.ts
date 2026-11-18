import { consumedContexts } from "../src/agent/contexts";
import { createRenderContext } from "../src/agent/registry";
import { instrumentRenders } from "../src/agent/render-log";
import { describe, expect, it, vi } from "vitest";
import { RingBuffer } from "../src/agent/ring-buffer";
import { describeChange, fitToBudget, fromSerialized, preview, toAgentValue } from "../src/agent/values";
import { ComponentTree } from "../src/agent/tree";
import { SignalsStore, watchSignalsDebug, type SignalUpdate } from "../src/agent/signals";

describe("RingBuffer", () => {
	it("keeps the newest items and counts drops", () => {
		const buf = new RingBuffer<string>(3);
		for (const x of ["a", "b", "c", "d", "e"]) buf.push(x);
		expect(buf.size).toBe(3);
		expect(buf.dropped).toBe(2);
		expect(buf.lastSeq).toBe(5);
		expect(buf.read().map(x => x.value)).toEqual(["c", "d", "e"]);
	});

	it("reads since a cursor and limits to the last n", () => {
		const buf = new RingBuffer<number>(10);
		for (let i = 1; i <= 6; i++) buf.push(i * 10);
		expect(buf.read({ since: 4 }).map(x => x.seq)).toEqual([4, 5, 6]);
		expect(buf.read({ since: 99 })).toEqual([]);
		expect(buf.read({ last: 2 }).map(x => x.value)).toEqual([50, 60]);
		expect(buf.read({ since: 2, last: 1 }).map(x => x.value)).toEqual([60]);
		expect(buf.read({ last: 0 })).toEqual([]);
	});

	it("shares a sequence counter across buffers", () => {
		let seq = 0;
		const next = () => ++seq;
		const a = new RingBuffer<string>(5, next);
		const b = new RingBuffer<string>(5, next);
		a.push("a1");
		b.push("b1");
		a.push("a2");
		expect(a.read().map(x => x.seq)).toEqual([1, 3]);
		expect(b.read({ since: 2 }).map(x => x.value)).toEqual(["b1"]);
	});

	it("returns a copy", () => {
		const buf = new RingBuffer<number>(5);
		buf.push(1);
		buf.read().pop();
		expect(buf.size).toBe(1);
	});
});

describe("toAgentValue", () => {
	it("caps depth, breadth and strings", () => {
		expect(toAgentValue({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: "[Object]" } } });
		expect(toAgentValue([[[[1]]]])).toEqual([[["[Array(1)]"]]]);
		const many = Array.from({ length: 40 }, (_, i) => i);
		const out = toAgentValue(many) as unknown[];
		expect(out).toHaveLength(31);
		expect(out[30]).toBe("… 10 more");
		expect(toAgentValue("x".repeat(250))).toBe(`${"x".repeat(200)}… (250 chars)`);
	});

	it("describes values that aren't plain data", () => {
		function onClick() {}
		const circular: any = { name: "a" };
		circular.self = circular;
		expect(toAgentValue(onClick)).toBe("[Function onClick]");
		expect(toAgentValue(circular)).toEqual({ name: "a", self: "[Circular]" });
		expect(toAgentValue(new Map([["k", 1]]))).toEqual({ $map: [["k", 1]] });
		expect(toAgentValue(new Set([1, 2]))).toEqual({ $set: [1, 2] });
		expect(toAgentValue(NaN)).toBe("NaN");
		expect(toAgentValue(10n)).toBe("10n");
		expect(toAgentValue(new Error("boom"))).toBe("Error: boom");
		expect(toAgentValue({ type: "div", props: {}, constructor: undefined })).toBe("<div />");
	});

	it("reads signals with peek(), never .value", () => {
		const value = vi.fn(() => 1);
		const s = {
			peek: () => 41,
			subscribe() {},
			name: "count",
			get value() {
				return value();
			},
		};
		expect(toAgentValue(s)).toEqual({ $signal: "count", value: 41 });
		expect(value).not.toHaveBeenCalled();
	});

	it("never runs getters", () => {
		const getter = vi.fn(() => {
			throw new Error("no");
		});
		const obj = Object.defineProperty({ a: 1 }, "boom", { get: getter, enumerable: true });
		expect(toAgentValue({ obj })).toEqual({ obj: { a: 1, boom: "[Getter]" } });
		expect(getter).not.toHaveBeenCalled();
	});

	it("only reads the items it keeps", () => {
		let reads = 0;
		const big = new Proxy(Array.from({ length: 100_000 }, (_, i) => i), {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) reads++;
				return Reflect.get(target, key, receiver);
			},
		});
		expect(toAgentValue(big, { breadth: 2 })).toEqual([0, 1, "… 99998 more"]);
		expect(reads).toBe(2);
		expect(toAgentValue(new Set([1, 2, 3]), { breadth: 1 })).toEqual({ $set: [1, "… 2 more"] });
		expect(toAgentValue(new Map([[1, 1], [2, 2]]), { breadth: 1 })).toEqual({ $map: [[1, 1], ["… 1 more", null]] });
	});
});

describe("fromSerialized", () => {
	it("converts the adapter's special values", () => {
		expect(
			fromSerialized({
				fn: { type: "function", name: "onClick" },
				node: { type: "vnode", name: "Foo" },
				big: { type: "bigint", value: "3" },
				sig: { type: "signal", name: "Signal", value: 2 },
				comp: { type: "signal", name: "computed Signal", value: 4 },
				set: { type: "set", name: "Set", entries: [1] },
				loop: "[[Circular]]",
				plain: { type: "custom", other: 1 },
			}),
		).toEqual({
			fn: "[Function onClick]",
			node: "<Foo />",
			big: "3n",
			sig: { $signal: "signal", value: 2 },
			comp: { $signal: "computed", value: 4 },
			set: { $set: [1] },
			loop: "[Circular]",
			plain: { type: "custom", other: 1 },
		});
	});
});

describe("describeChange", () => {
	it("points at the nested part that changed", () => {
		const prev = [{ id: 1, done: false }, { id: 2, done: true }];
		const next = [{ id: 1, done: true }, { id: 2, done: true }];
		expect(describeChange("todos", prev, next)).toEqual(["todos[0].done: false → true"]);
		expect(describeChange("todo", { done: false }, { done: true })).toEqual(["todo.done: false → true"]);
		expect(describeChange("count", 0, 1)).toEqual(["count: 0 → 1"]);
	});

	it("flags new objects with equal content", () => {
		expect(describeChange("style", { a: 1 }, { a: 1 })).toEqual(["style: new object, same value"]);
	});

	it("limits the number of lines", () => {
		const prev = { a: 1, b: 1, c: 1, d: 1 };
		const next = { a: 2, b: 2, c: 2, d: 2 };
		expect(describeChange("x", prev, next)).toHaveLength(3);
	});

	it("truncates long previews", () => {
		expect(preview("y".repeat(100), 10)).toHaveLength(10);
	});
});

describe("fitToBudget", () => {
	it("leaves small values alone", () => {
		const v = { a: 1 };
		expect(fitToBudget(v, 100)).toBe(v);
	});

	it("also shortens top-level strings and counts the marker", () => {
		for (const max of [40, 100, 300]) {
			const out = fitToBudget({ id: 1, source: "x".repeat(2000), props: { a: "é".repeat(500) } }, max) as any;
			expect(out.truncated).toBe(true);
			expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(max);
		}
	});

	it("collapses deep values and marks the result as truncated", () => {
		const v = { id: 1, props: { a: { b: { c: { d: "x".repeat(500) } } } } };
		const out = fitToBudget(v, 200) as any;
		expect(out.truncated).toBe(true);
		expect(out.id).toBe(1);
		expect(JSON.stringify(out).length).toBeLessThanOrEqual(200);
	});
});

/** Builds an `operation_v2` message the way the adapter encodes it. */
function ops(rendererId: number, strings: string[], body: number[]): number[] {
	const table: number[] = [];
	for (const s of strings) table.push(s.length, ...Array.from(s, c => c.charCodeAt(0)));
	return [rendererId, table.length, ...table, ...body];
}
const str = (strings: string[], s: string) => strings.indexOf(s) + 1;

describe("ComponentTree", () => {
	const names = ["Fragment", "App", "Item", "a"];
	// ADD_VNODE: 2, id, type, parent, owner, name, key, startTime, endTime
	const mount = ops(1, names, [
		1, 10, // ADD_ROOT 10
		2, 10, 0, -1, -1, str(names, "Fragment"), 0, 0, 0,
		2, 11, 3, 10, 10, str(names, "App"), 0, 0, 0,
		2, 12, 3, 11, 11, str(names, "Item"), str(names, "a"), 0, 0,
		2, 13, 3, 11, 11, str(names, "Item"), 0, 0, 0,
	]);

	it("decodes mounts and hides the root in paths", () => {
		const tree = new ComponentTree();
		const res = tree.apply(mount);
		expect(res.mounted).toEqual([10, 11, 12, 13]);
		expect(tree.roots).toEqual([10]);
		expect(tree.topLevel()).toEqual([11]);
		expect(tree.get(12)).toMatchObject({ name: "Item", key: "a", kind: "function", parent: 11, depth: 2 });
		expect(tree.path(12)).toEqual(["App", "Item"]);
	});

	it("applies timings, reorders and removals", () => {
		const tree = new ComponentTree();
		tree.apply(mount);
		const v = tree.version;
		const res = tree.apply(
			ops(1, [], [
				4, 11, 0, 1, // UPDATE_VNODE_TIMINGS
				5, 11, 2, 13, 12, // REORDER_CHILDREN
				3, 1, 12, // REMOVE_VNODE x1
			]),
		);
		expect(tree.version).toBe(v + 1);
		expect(res.rendered).toEqual([11]);
		expect(res.unmounted).toEqual([12]);
		expect(tree.get(11)!.children).toEqual([13]);
		expect(tree.get(12)).toBeUndefined();
	});

	it("removes whole subtrees", () => {
		const tree = new ComponentTree();
		tree.apply(mount);
		const res = tree.apply(ops(1, [], [3, 1, 11]));
		expect(res.unmounted.sort()).toEqual([11, 12, 13]);
		expect(tree.get(10)!.children).toEqual([]);
	});

	it("reports components that unmount and mount again in one commit", () => {
		const tree = new ComponentTree();
		tree.apply(mount);
		const res = tree.apply(
			ops(1, ["Item", "b"], [
				3, 2, 12, 13, // REMOVE both items
				2, 20, 3, 11, 11, 1, 2, 0, 0, // ADD Item key "b"
				2, 21, 3, 11, 11, 1, 0, 0, 0, // ADD Item, no key
			]),
		);
		expect(res.remounts).toEqual([
			{ id: 20, name: "Item", parent: 11, prevKey: "a", key: "b" },
			{ id: 21, name: "Item", parent: 11, prevKey: "", key: "" },
		]);
		// A replaced parent is the remount, not each of its children.
		const res2 = tree.apply(
			ops(1, ["App", "Item"], [3, 1, 11, 2, 30, 3, 10, 10, 1, 0, 0, 0, 2, 31, 3, 30, 30, 2, 0, 0, 0]),
		);
		expect(res2.remounts.map(r => r.id)).toEqual([30]);
	});

	it("doesn't call a keyed list change a remount", () => {
		const tree = new ComponentTree();
		const n = ["Fragment", "App", "Item", "a", "b", "c"];
		tree.apply(
			ops(1, n, [
				1, 10,
				2, 10, 0, -1, -1, str(n, "Fragment"), 0, 0, 0,
				2, 11, 3, 10, 10, str(n, "App"), 0, 0, 0,
				2, 12, 3, 11, 11, str(n, "Item"), str(n, "a"), 0, 0,
				2, 13, 3, 11, 11, str(n, "Item"), str(n, "b"), 0, 0,
			]),
		);
		// a, b → b, c: "a" went away and "c" is new.
		const res = tree.apply(ops(1, n, [3, 1, 12, 2, 20, 3, 11, 11, str(n, "Item"), str(n, "c"), 0, 0]));
		expect(res.remounts).toEqual([]);
		// Every item replaced with a new key in place: unstable keys.
		const n2 = [...n, "d", "e"];
		const res2 = tree.apply(
			ops(1, n2, [
				3, 2, 13, 20,
				2, 21, 3, 11, 11, str(n2, "Item"), str(n2, "d"), 0, 0,
				2, 22, 3, 11, 11, str(n2, "Item"), str(n2, "e"), 0, 0,
			]),
		);
		expect(res2.remounts.map(r => [r.prevKey, r.key])).toEqual([
			["b", "d"],
			["c", "e"],
		]);
		// A stable sibling doesn't hide one with an unstable key.
		const res3 = tree.apply(ops(1, n2, [3, 1, 22, 2, 23, 3, 11, 11, str(n2, "Item"), str(n2, "a"), 0, 0]));
		expect(res3.remounts.map(r => [r.prevKey, r.key])).toEqual([["e", "a"]]);
	});

	it("matches remounts in linear time", () => {
		const tree = new ComponentTree();
		const N = 10_000;
		const keys = Array.from({ length: 2 * N }, (_, i) => `k${i}`);
		const n = ["Fragment", "App", "Item", ...keys];
		const body = [1, 10, 2, 10, 0, -1, -1, 1, 0, 0, 0, 2, 11, 3, 10, 10, 2, 0, 0, 0];
		for (let i = 0; i < N; i++) body.push(2, 100 + i, 3, 11, 11, 3, 4 + i, 0, 0);
		tree.apply(ops(1, n, body));
		const replace = [3, N, ...Array.from({ length: N }, (_, i) => 100 + i)];
		for (let i = 0; i < N; i++) replace.push(2, 100 + N + i, 3, 11, 11, 3, 4 + N + i, 0, 0);
		const t = performance.now();
		const res = tree.apply(ops(1, n, replace));
		expect(performance.now() - t).toBeLessThan(1000);
		expect(res.remounts).toHaveLength(N);
	});

	it("throws on unknown operations", () => {
		expect(() => new ComponentTree().apply(ops(1, [], [99]))).toThrow(/Unknown devtools operation/);
	});
});

describe("SignalsStore", () => {
	function fakeApi() {
		const listeners = new Set<(u: SignalUpdate[]) => void>();
		return {
			listeners,
			onUpdate(cb: (u: SignalUpdate[]) => void) {
				listeners.add(cb);
				return () => listeners.delete(cb);
			},
			onInit: () => () => {},
			emit(updates: SignalUpdate[]) {
				listeners.forEach(cb => cb(updates));
			},
		};
	}
	const update = (id: string, newValue: number): SignalUpdate => ({
		type: "update",
		signalType: "signal",
		signalName: id,
		signalId: id,
		prevValue: newValue - 1,
		newValue,
		timestamp: newValue,
		depth: 0,
	});

	it("records updates and replays them, batched, to a late subscriber", () => {
		let seq = 0;
		const store = new SignalsStore(() => ++seq);
		const api = fakeApi();
		const win = { postMessage() {}, location: {} } as unknown as Window;
		const relay = store.relayWindow(win) as any;
		expect(relay.__PREACT_SIGNALS_DEVTOOLS__).toBeUndefined();

		store.attach(api as any);
		api.emit([update("a", 1), update("b", 1)]);
		api.emit([update("a", 2)]);
		expect(store.known.get("a")).toMatchObject({ value: 2, updates: 2 });

		const seen: SignalUpdate[][] = [];
		relay.__PREACT_SIGNALS_DEVTOOLS__.onUpdate((u: SignalUpdate[]) => seen.push(u));
		expect(seen.map(b => b.map(u => `${u.signalId}=${u.newValue}`))).toEqual([["a=1", "b=1"], ["a=2"]]);

		api.emit([update("b", 2)]);
		expect(seen).toHaveLength(3);
	});

	it("contains signals-debug errors so its flush queue keeps working", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const store = new SignalsStore(() => 1);
		const api = {
			...fakeApi(),
			sendUpdate() {
				throw new Error("getter threw");
			},
		};
		store.attach(api as any);
		expect(() => api.sendUpdate()).not.toThrow();
		warn.mockRestore();
	});

	it("un-disposes signals that update again", () => {
		const store = new SignalsStore(() => 1);
		const api = { ...fakeApi(), disposalListeners: new Set<any>(), onDisposal(cb: any) { this.disposalListeners.add(cb); return () => {}; } };
		store.attach(api as any);
		api.emit([update("a", 1)]);
		api.disposalListeners.forEach(cb => cb([{ type: "disposed", signalType: "signal", signalName: "a", signalId: "a", timestamp: 2 }]));
		expect(store.known.get("a")!.disposed).toBe(true);
		api.emit([update("a", 3)]);
		expect(store.known.get("a")!.disposed).toBe(false);
	});

	it("follows a global replaced behind the watcher's back", () => {
		const store = new SignalsStore(() => 1);
		const win: any = {};
		watchSignalsDebug(win, api => store.attach(api));
		const a = fakeApi();
		win.__PREACT_SIGNALS_DEVTOOLS__ = a;
		expect(store.api).toBe(a);
		const b = fakeApi();
		Object.defineProperty(win, "__PREACT_SIGNALS_DEVTOOLS__", { value: b, configurable: true });
		store.sync(win);
		expect(store.api).toBe(b);
	});

	it("keeps an existing accessor working", () => {
		let stored: unknown;
		const win: any = {};
		Object.defineProperty(win, "__PREACT_SIGNALS_DEVTOOLS__", {
			configurable: true,
			get: () => stored,
			set: v => (stored = v),
		});
		const seen: unknown[] = [];
		watchSignalsDebug(win, api => seen.push(api));
		const a = fakeApi();
		win.__PREACT_SIGNALS_DEVTOOLS__ = a;
		expect(stored).toBe(a);
		expect(win.__PREACT_SIGNALS_DEVTOOLS__).toBe(a);
		expect(seen).toEqual([a]);
	});

	it("re-subscribes when signals-debug is replaced", () => {
		const store = new SignalsStore(() => 1);
		const a = fakeApi();
		const b = fakeApi();
		store.attach(a as any);
		store.attach(b as any);
		expect(a.listeners.size).toBe(0);
		expect(b.listeners.size).toBe(1);
	});
});

describe("consumedContexts", () => {
	it("understands Preact <= 10.24 contexts, which are objects", () => {
		const ctx = { __c: "__cC7", __: "fallback", Provider() {}, Consumer() {}, displayName: "Old" };
		const provider = { props: { value: "provided" } };
		const found = consumedContexts({ __n: { __cC7: provider } }, [{ c: ctx }]);
		expect([...found.values()]).toEqual([{ context: ctx, name: "Old", provider, value: "provided" }]);
		expect([...consumedContexts({ __n: {} }, [{ c: ctx }]).values()][0].value).toBe("fallback");
		// Hook state that merely holds an object with a similar id isn't a context.
		expect(consumedContexts({ __n: {} }, [{ c: { __c: "__cC7" } }]).size).toBe(0);
	});
});

describe("instrumentRenders", () => {
	it("doesn't attribute what pending effects create when preact/hooks flushes them", () => {
		const rendering = createRenderContext();
		const o: any = { __e() {} };
		const bindings = { getComponent: (v: any) => v.__c, getDisplayName: () => "Comp" };
		instrumentRenders(o, { Fragment: () => null } as any, bindings as any, () => {}, () => 1, { rendering });
		// Only mangled names: a stale unmangled `_hook` made the devtools
		// adapter skip @preact/signals' hook when it re-wrapped.
		expect(Object.keys(o).filter(k => /^_[a-z]/.test(k))).toEqual([]);
		// preact/hooks, installed after us: calls us, then runs pending effects.
		const ours = o.__r;
		o.__r = (v: any) => {
			ours(v);
			for (const state of v.__c.__H.__h) state.__();
			v.__c.__H.__h = [];
		};
		const seen: unknown[] = [];
		const c = { __H: { __: [], __h: [{ __: () => seen.push([rendering.component, rendering.suspended]) }] } };
		const vnode = { type: function Comp() {}, __c: c };
		o.__b(vnode);
		o.__r(vnode);
		expect(seen).toEqual([[c, 1]]);
		expect(rendering).toMatchObject({ component: c, name: "Comp", suspended: 0 });
		// A throw clears it.
		o.__e(new Error("x"), vnode);
		expect(rendering.component).toBeNull();
	});
});
