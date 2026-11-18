/**
 * "Why did this render?" for every component render, with values.
 *
 * The devtools adapter only computes render reasons while the Profiler
 * records (with "Capture render reasons"), and then only as key names. Here
 * we install our own, lightweight `options` hooks next to the adapter's and
 * keep a snapshot of each component's props, state, stateful hook values and
 * the signals it read during its last render. When it renders again, the
 * difference is the reason.
 */
import type { Options } from "preact";
import type { PreactBindings } from "../../vendor/preact-devtools/src/adapter/shared/bindings";
import type { RendererConfig } from "../../vendor/preact-devtools/src/adapter/shared/renderer";
import { signalName, toAgentValue, type ValueLimits } from "./values.js";
import type { Change, RenderLogEntry, RenderReason } from "./render-types.js";
import type { RenderContext } from "./registry.js";
import { consumedContexts } from "./contexts.js";

export type { Change, RenderLogEntry, RenderReason };

interface Snapshot {
	props: Record<string, unknown>;
	state: Record<string, unknown> | null;
	hooks: Map<number, unknown>;
	signals: Map<object, { version: number; value: unknown }>;
	contexts: Map<object, { name: string; value: unknown }>;
}

export interface RenderObserver {
	/** Updated while a component renders; read by the signal registry. */
	rendering?: RenderContext;
	onRerender?(component: object): void;
	onUnmount?(component: object): void;
}

const CHANGE_LIMITS: ValueLimits = { depth: 2, breadth: 10, string: 120 };

function change(key: string, prev: unknown, next: unknown): Change {
	return {
		key,
		prev: toAgentValue(prev, CHANGE_LIMITS),
		next: toAgentValue(next, CHANGE_LIMITS),
	};
}

function shallowChanges(
	prev: Record<string, unknown> | null,
	next: Record<string, unknown> | null,
): Change[] {
	const a = prev ?? {};
	const b = next ?? {};
	const out: Change[] = [];
	for (const key in a) {
		if (key === "__source" || key === "__self") continue;
		if (!(key in b) || !Object.is(a[key], b[key])) out.push(change(key, a[key], b[key]));
	}
	for (const key in b) {
		if (key === "__source" || key === "__self") continue;
		if (!(key in a)) out.push(change(key, undefined, b[key]));
	}
	return out;
}

/** Signals (and computeds) the component's signals updater currently tracks. */
function trackedSignals(component: any): Map<object, { version: number; value: unknown }> {
	const out = new Map<object, { version: number; value: unknown }>();
	// `_updater` / `_sources` / `_source` / `_nextSource` / `_version`, as
	// mangled by @preact/signals (see its mangle.json).
	const updater = component.__$u;
	let node = updater?.s;
	const seen = new Set();
	while (node != null && !seen.has(node)) {
		seen.add(node);
		const signal = node.S;
		if (signal && typeof signal.peek === "function") {
			let value: unknown;
			try {
				value = signal.peek();
			} catch (err) {
				value = err;
			}
			out.set(signal, { version: signal.i, value });
		}
		node = node.n;
	}
	return out;
}

function isSignalTextComponent(type: any): boolean {
	return type.displayName === "_st" || type.displayName === "ReactiveTextNode";
}

export interface RenderInstrumentation {
	teardown(): void;
}

/**
 * Hooks into `options` of one Preact copy. Must be called after the
 * devtools adapter installed its own hooks (`hook.attachPreact`).
 */
const SUSPENDING = Symbol("preact-devtools-overlay:suspending");

/**
 * Wraps pending `useEffect` callbacks (hook state `_value`, mangled `__`) so
 * nothing they create is attributed to the component rendering meanwhile.
 */
function suspendDuring(pendingEffects: unknown, rendering: RenderContext) {
	if (!Array.isArray(pendingEffects)) return;
	for (const state of pendingEffects) {
		const fn = state?.__;
		if (typeof fn !== "function" || fn[SUSPENDING]) continue;
		const wrapped = function (this: unknown, ...args: unknown[]) {
			rendering.suspended++;
			try {
				return fn.apply(this, args);
			} finally {
				rendering.suspended--;
			}
		};
		(wrapped as any)[SUSPENDING] = true;
		Object.defineProperty(wrapped, "name", { value: fn.name });
		state.__ = wrapped;
	}
}

export function instrumentRenders(
	options: Options,
	config: RendererConfig,
	bindings: PreactBindings<any>,
	onCommit: (entries: RenderLogEntry[]) => void,
	nextCommit: () => number,
	observer: RenderObserver = {},
): RenderInstrumentation {
	const rendering = observer.rendering;
	const o = options as any;
	// Mangled names only: Preact's builds only read those. Never set the
	// unmangled ones (`_hook`): the devtools adapter prefers them when it
	// re-wraps, and a stale one would cut @preact/signals out of the chain.
	const prevRoot = o.__;
	const prevDiff = o.__b;
	const prevRender = o.__r;
	const prevDiffed = options.diffed;
	const prevCommit = o.__c;
	const prevUnmount = options.unmount;
	const prevCatchError = o.__e;

	const snapshots = new WeakMap<object, Snapshot>();
	// Weak: a render that throws never reaches `diffed`, and its component
	// may never be unmounted either.
	const renderStart = new WeakMap<object, number>();
	let pending: RenderLogEntry[] = [];
	const hasWeakRef = typeof WeakRef !== "undefined";

	const notRendering = () => {
		if (rendering) {
			rendering.component = null;
			rendering.name = null;
		}
	};

	const root = (vnode: any, parent: any) => {
		// A new `render()` call. Anything still pending belongs to a render
		// that threw before it committed.
		pending = [];
		notRendering();
		if (prevRoot) prevRoot(vnode, parent);
	};

	const diff = (vnode: any) => {
		// Before a class component's constructor runs: anything it creates
		// must not be attributed to whatever rendered last.
		notRendering();
		if (prevDiff) prevDiff(vnode);
	};

	const render = (vnode: any, parent: any) => {
		const type = vnode.type;
		if (typeof type === "function" && type !== config.Fragment) {
			const c = bindings.getComponent(vnode);
			if (c) {
				renderStart.set(c, performance.now());
				if (rendering) {
					const firstRender = !snapshots.has(c);
					rendering.render++;
					rendering.firstRender = firstRender;
					if (!firstRender) {
						try {
							observer.onRerender?.(c);
						} catch {
							// ignore
						}
					}
					let name: string | null = null;
					try {
						name = bindings.getDisplayName(vnode, config);
					} catch {
						// ignore
					}
					// preact/hooks runs the effects still pending from the last
					// render in its render hook, before or after this one. What
					// they create isn't the render's doing.
					suspendDuring((c.__hooks ?? c.__H)?.__h, rendering);
					rendering.component = c;
					rendering.name = name;
					if (prevRender) prevRender(vnode, parent);
					return;
				}
			}
		}
		if (prevRender) prevRender(vnode, parent);
	};

	const diffed = (vnode: any) => {
		// The component's own render function has returned long ago (its
		// children render in between); nothing is rendering now.
		notRendering();
		if (prevDiffed) prevDiffed(vnode);

		const type = vnode.type;
		if (typeof type !== "function" || type === config.Fragment) return;
		const c = bindings.getComponent(vnode);
		if (!c) return;
		const start = renderStart.get(c);
		// Not rendered in this pass (e.g. `shouldComponentUpdate` / memo bail-out).
		if (start === undefined) return;
		renderStart.delete(c);
		if (isSignalTextComponent(type)) return;

		try {
			record(vnode, c, start);
		} catch {
			// Never break the app because of the agent API.
		}
	};

	const record = (vnode: any, c: any, start: number) => {
		const hooks = new Map<number, unknown>();
		const list = bindings.getStatefulHooks(vnode);
		if (list) {
			for (let i = 0; i < list.length; i++) {
				if (list[i] && bindings.isUseReducerOrState(list[i])) {
					hooks.set(i, bindings.getStatefulHookValue(list[i]));
				}
			}
		}
		const state =
			c.state && typeof c.state === "object" && Object.keys(c.state).length > 0
				? { ...c.state }
				: null;
		const next: Snapshot = {
			props: vnode.props ?? {},
			state,
			hooks,
			signals: trackedSignals(c),
			contexts: consumedContexts(c, list),
		};
		const prev = snapshots.get(c);
		snapshots.set(c, next);

		const entry: RenderLogEntry = {
			commit: 0,
			time: start,
			name: bindings.getDisplayName(vnode, config),
			reason: "mount",
			reasons: [],
			durationMs: Math.round((performance.now() - start) * 1000) / 1000,
			component: hasWeakRef ? new WeakRef(c) : null,
		};

		if (!prev) {
			entry.reasons.push("mount");
			pending.push(entry);
			return;
		}

		const signals: Change[] = [];
		for (const [signal, before] of prev.signals) {
			const now = (signal as any).i;
			if (now !== before.version) {
				let value: unknown;
				try {
					value = (signal as any).peek();
				} catch (err) {
					value = err;
				}
				signals.push(change(signalName(signal) ?? "(anonymous signal)", before.value, value));
			}
		}
		const hookChanges: Change[] = [];
		for (const [index, value] of next.hooks) {
			if (prev.hooks.has(index) && !Object.is(prev.hooks.get(index), value)) {
				hookChanges.push(change(`useState[${index}]`, prev.hooks.get(index), value));
			}
		}
		const stateChanges = prev.state || next.state ? shallowChanges(prev.state, next.state) : [];
		const propChanges = prev.props !== next.props ? shallowChanges(prev.props, next.props) : [];
		const contextChanges: Change[] = [];
		for (const [ctx, now] of next.contexts) {
			const before = prev.contexts.get(ctx);
			if (before && !Object.is(before.value, now.value)) {
				contextChanges.push(change(now.name, before.value, now.value));
			}
		}

		if (signals.length) (entry.signals = signals), entry.reasons.push("signal");
		if (hookChanges.length) (entry.hooks = hookChanges), entry.reasons.push("hooks");
		if (stateChanges.length) (entry.state = stateChanges), entry.reasons.push("state");
		if (propChanges.length) (entry.props = propChanges), entry.reasons.push("props");
		if (contextChanges.length) (entry.context = contextChanges), entry.reasons.push("context");
		if (entry.reasons.length === 0) {
			// Same values: either the parent re-rendered and passed equal props,
			// or the component was force-updated (forceUpdate, or a context we
			// couldn't see, e.g. one consumed by a custom hook's own component).
			entry.reasons.push(prev.props !== next.props ? "parent" : "force");
		}
		entry.reason = entry.reasons[0];
		pending.push(entry);
	};

	const commit = (vnode: any, queue: any) => {
		notRendering();
		// Flush before calling on: the previous hooks run layout effects and
		// callbacks, which can render (and commit) again.
		if (pending.length > 0) {
			// `diffed` fires children-first; report parents first.
			const entries = pending.sort((a, b) => a.time - b.time);
			pending = [];
			const n = nextCommit();
			for (const entry of entries) entry.commit = n;
			try {
				onCommit(entries);
			} catch {
				// ignore
			}
		}
		if (prevCommit) prevCommit(vnode, queue);
	};

	const catchError = (error: any, vnode: any, oldVNode: any, errorInfo: any) => {
		// A render threw: it never reaches `diffed`.
		notRendering();
		return prevCatchError(error, vnode, oldVNode, errorInfo);
	};

	const unmount = (vnode: any) => {
		if (typeof vnode.type === "function") {
			const c = bindings.getComponent(vnode);
			if (c) {
				snapshots.delete(c);
				renderStart.delete(c);
				try {
					observer.onUnmount?.(c);
				} catch {
					// ignore
				}
			}
		}
		if (prevUnmount) prevUnmount(vnode);
	};

	o.__ = root;
	if (rendering) o.__b = diff;
	o.__r = render;
	options.diffed = diffed;
	o.__c = commit;
	options.unmount = unmount;
	// Preact always has one (it rethrows when no boundary catches).
	if (rendering && typeof prevCatchError === "function") o.__e = catchError;

	return {
		teardown() {
			if (o.__ === root) o.__ = prevRoot;
			if (o.__b === diff) o.__b = prevDiff;
			if (o.__r === render) o.__r = prevRender;
			if (options.diffed === diffed) options.diffed = prevDiffed;
			if (o.__c === commit) o.__c = prevCommit;
			if (options.unmount === unmount) options.unmount = prevUnmount;
			if (o.__e === catchError) o.__e = prevCatchError;
		},
	};
}
