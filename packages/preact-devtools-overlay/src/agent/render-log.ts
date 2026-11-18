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

export type { Change, RenderLogEntry, RenderReason };

interface Snapshot {
	props: Record<string, unknown>;
	state: Record<string, unknown> | null;
	hooks: Map<number, unknown>;
	signals: Map<object, { version: number; value: unknown }>;
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
export function instrumentRenders(
	options: Options,
	config: RendererConfig,
	bindings: PreactBindings<any>,
	onCommit: (entries: RenderLogEntry[]) => void,
	nextCommit: () => number,
): RenderInstrumentation {
	const o = options as any;
	const prevRoot = o._root || o.__;
	const prevRender = o._render || o.__r;
	const prevDiffed = options.diffed;
	const prevCommit = o._commit || o.__c;
	const prevUnmount = options.unmount;

	const snapshots = new WeakMap<object, Snapshot>();
	// Weak: a render that throws never reaches `diffed`, and its component
	// may never be unmounted either.
	const renderStart = new WeakMap<object, number>();
	let pending: RenderLogEntry[] = [];
	const hasWeakRef = typeof WeakRef !== "undefined";

	const root = (vnode: any, parent: any) => {
		// A new `render()` call. Anything still pending belongs to a render
		// that threw before it committed.
		pending = [];
		if (prevRoot) prevRoot(vnode, parent);
	};

	const render = (vnode: any, parent: any) => {
		const type = vnode.type;
		if (typeof type === "function" && type !== config.Fragment) {
			const c = bindings.getComponent(vnode);
			if (c) renderStart.set(c, performance.now());
		}
		if (prevRender) prevRender(vnode, parent);
	};

	const diffed = (vnode: any) => {
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

		if (signals.length) (entry.signals = signals), entry.reasons.push("signal");
		if (hookChanges.length) (entry.hooks = hookChanges), entry.reasons.push("hooks");
		if (stateChanges.length) (entry.state = stateChanges), entry.reasons.push("state");
		if (propChanges.length) (entry.props = propChanges), entry.reasons.push("props");
		if (entry.reasons.length === 0) {
			// Same values: either the parent re-rendered and passed equal props,
			// or the component was force-updated (forceUpdate, a context change).
			entry.reasons.push(prev.props !== next.props ? "parent" : "force");
		}
		entry.reason = entry.reasons[0];
		pending.push(entry);
	};

	const commit = (vnode: any, queue: any) => {
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

	const unmount = (vnode: any) => {
		if (typeof vnode.type === "function") {
			const c = bindings.getComponent(vnode);
			if (c) {
				snapshots.delete(c);
				renderStart.delete(c);
			}
		}
		if (prevUnmount) prevUnmount(vnode);
	};

	o._root = o.__ = root;
	o._render = o.__r = render;
	options.diffed = diffed;
	o._commit = o.__c = commit;
	options.unmount = unmount;

	return {
		teardown() {
			if (o.__ === root) o._root = o.__ = prevRoot;
			if (o.__r === render) o._render = o.__r = prevRender;
			if (options.diffed === diffed) options.diffed = prevDiffed;
			if (o.__c === commit) o._commit = o.__c = prevCommit;
			if (options.unmount === unmount) options.unmount = prevUnmount;
		},
	};
}
