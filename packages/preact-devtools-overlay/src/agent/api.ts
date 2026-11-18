/**
 * `window.__PREACT_DEVTOOLS_OVERLAY__.api`: the devtools as data, for AI
 * coding agents (and anyone scripting the page via Playwright, CDP or the
 * console). See AGENTS.md for recipes.
 */
import type { ComponentTree, TreeNode } from "./tree.js";
import type { RenderLogEntry } from "./render-types.js";
import type { RingBuffer } from "./ring-buffer.js";
import type { SignalsStore, SignalUpdate } from "./signals.js";
import {
	describeChange,
	fitToBudget,
	fromSerialized,
	preview,
	signalName,
	toAgentValue,
} from "./values.js";

/** What a renderer from `__PREACT_DEVTOOLS__.renderers` offers us. */
interface RendererLike {
	getVNodeById(id: number): any;
	findVNodeIdForDom(node: HTMLElement | Text): number;
	inspect(id: number): any;
	update(id: number, type: string, path: Array<string | number>, value: unknown): void;
	updateHook?(id: number, index: number, value: unknown): void;
	updateSignal?(id: number, index: number, value: unknown): void;
}

/** A component: its devtools id, a DOM element inside it, a component name or a CSS selector. */
export type Target = number | Element | string | { id: number };
export type Format = "json" | "text";

export interface AgentApiDeps {
	tree: ComponentTree;
	renders: RingBuffer<RenderLogEntry>;
	signals: SignalsStore;
	getRenderers(): Iterable<RendererLike>;
	/** Current value of the shared sequence counter, for `mark()`. */
	currentSeq(): number;
	version: string;
	/** `true` when the tree is fed asynchronously (extension's hook reused). */
	asyncTree: boolean;
}

const HELP = `preact-devtools-overlay agent API (window.__PREACT_DEVTOOLS_OVERLAY__.api)

Targets: a devtools id (number), a DOM element inside the component, a component
name ("TodoItem", must start with an uppercase letter) or a CSS selector
("[data-testid=save]"). Ids change on every page load.
Most queries accept { format: "text" } for a compact, token-friendly answer.

Components
  getTree({ root?, depth?, format? })     component tree (what the Components tab shows)
  find(query, { limit? })                 [{ id, name, key, path }] matching a name or selector
  inspect(target, { maxBytes? })          props, state, hooks, context, signals, source location
  update(target, kind, path, value)       kind: "props" | "state" | "context" (path: "a.b"),
                                          "hook" | "signal" (path: index from inspect())

Renders
  getRenders({ since?, last?, target?, format? })  every component render, with the reason and
                                          changed values (props, state, hooks, signals)
  whyDidRender(target, { last?, format? })  the last renders of one component
  mark()                                  cursor for { since } in getRenders/getSignalUpdates
  startRecording() / stopRecording({ format? })  renders + signal updates in between

Signals (needs @preact/signals-debug, which the Vite plugin adds)
  getSignals({ name?, format? })          known signals/computeds with value and readers
  getSignalUpdates({ since?, last?, name?, format? })
  getSignalGraph()                        { nodes, links } dependency graph

Notes
  inspect() re-runs the component's hooks to read them (like the Components tab). Call it
  per component, not in a loop over the whole tree.
  Renders are recorded from page load (last 500), signal updates too (last 2000).`;

const MAX_RENDERS_DEFAULT = 50;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function withoutDevProps(props: Record<string, unknown> | null | undefined) {
	if (!props || typeof props !== "object") return null;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(props)) {
		if (key === "__source" || key === "__self") continue;
		const desc = Object.getOwnPropertyDescriptor(props, key);
		if (desc) Object.defineProperty(out, key, { ...desc, enumerable: true });
	}
	return Object.keys(out).length ? out : null;
}

/** Context minus Preact's internal `__cC<n>` entries. */
function withoutInternalContext(context: Record<string, unknown> | null | undefined) {
	if (!context || typeof context !== "object") return null;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(context)) {
		if (/^__cC\d+$/.test(key)) continue;
		const desc = Object.getOwnPropertyDescriptor(context, key);
		if (desc) Object.defineProperty(out, key, { ...desc, enumerable: true });
	}
	return Object.keys(out).length ? out : null;
}

function nameQuery(query: string): boolean {
	return /^[A-Z][\w$.]*$/.test(query);
}

export function createAgentApi(deps: AgentApiDeps) {
	const { tree, renders, signals } = deps;
	let recording: number | null = null;

	const renderers = () => Array.from(deps.getRenderers());

	function rendererFor(id: number): RendererLike | null {
		for (const r of renderers()) {
			try {
				if (r.getVNodeById(id) != null) return r;
			} catch {
				// ignore
			}
		}
		return null;
	}

	function idForElement(el: Element): number {
		const list = renderers();
		// The adapter only maps DOM nodes it has seen, so walk up to the
		// closest one any renderer knows. Closest first: with an app mounted
		// inside another app's DOM, the inner one owns the element.
		for (let node: Element | null = el; node; node = node.parentElement) {
			for (const r of list) {
				try {
					const id = r.findVNodeIdForDom(node as HTMLElement);
					if (id !== -1 && tree.get(id)) return id;
				} catch {
					// ignore
				}
			}
		}
		return -1;
	}

	function findIds(query: Target, limit = 20): number[] {
		if (typeof query === "number") return tree.get(query) ? [query] : [];
		// Before the `{ id }` check: elements have an `id` property too.
		if (typeof Element !== "undefined" && query instanceof Element) {
			const id = idForElement(query);
			return id === -1 ? [] : [id];
		}
		if (query && typeof query === "object" && typeof query.id === "number") {
			return findIds(query.id, limit);
		}
		if (typeof query !== "string" || !query) return [];

		if (nameQuery(query)) {
			const out: number[] = [];
			for (const node of tree.nodes.values()) {
				if (node.name === query || node.hocs?.includes(query)) {
					out.push(node.id);
					if (out.length >= limit) break;
				}
			}
			return out;
		}

		let elements: Element[];
		try {
			elements = Array.from(document.querySelectorAll(query));
		} catch {
			throw new Error(
				`"${query}" is neither a component name (must start with an uppercase letter) nor a valid CSS selector`,
			);
		}
		const out = new Set<number>();
		for (const el of elements) {
			const id = idForElement(el);
			if (id !== -1) out.add(id);
			if (out.size >= limit) break;
		}
		return [...out];
	}

	function resolve(target: Target): number {
		const [id] = findIds(target, 1);
		if (id === undefined) {
			throw new Error(
				`No component found for ${typeof target === "string" ? JSON.stringify(target) : String(target)}`,
			);
		}
		return id;
	}

	/**
	 * The adapter's string table drops numeric keys (`key={todo.id}`), so the
	 * decoded tree only has string keys. Read the rest from the vnode.
	 */
	function keyOf(node: TreeNode): string {
		if (node.key) return node.key;
		try {
			const key = rendererFor(node.id)?.getVNodeById(node.id)?.key;
			return key == null ? "" : String(key);
		} catch {
			return "";
		}
	}

	function summary(node: TreeNode) {
		const key = keyOf(node);
		return {
			id: node.id,
			name: node.name,
			kind: node.kind,
			...(key ? { key } : {}),
			path: tree.path(node.id).join(" > "),
		};
	}

	// Component instance -> devtools id, rebuilt when the tree changed.
	let instanceIds: { version: number; map: WeakMap<object, number> } | null = null;
	function idForInstance(component: object | undefined): number | null {
		if (!component) return null;
		if (!instanceIds || instanceIds.version !== tree.version) {
			const map = new WeakMap<object, number>();
			for (const r of renderers()) {
				for (const id of tree.nodes.keys()) {
					try {
						const vnode = r.getVNodeById(id);
						const c = vnode && (vnode.__c ?? vnode._component);
						if (c) map.set(c, id);
					} catch {
						// ignore
					}
				}
			}
			instanceIds = { version: tree.version, map };
		}
		return instanceIds.map.get(component) ?? null;
	}

	function renderToJson(seq: number, e: RenderLogEntry) {
		const id = idForInstance(e.component?.deref());
		return {
			seq,
			commit: e.commit,
			time: Math.round(e.time),
			id,
			name: e.name,
			reason: e.reason,
			...(e.reasons.length > 1 ? { reasons: e.reasons } : {}),
			...(e.signals ? { signals: e.signals } : {}),
			...(e.hooks ? { hooks: e.hooks } : {}),
			...(e.state ? { state: e.state } : {}),
			...(e.props ? { props: e.props } : {}),
			durationMs: e.durationMs,
		};
	}

	function renderToText(r: ReturnType<typeof renderToJson>): string {
		const changes = [...(r.signals ?? []), ...(r.hooks ?? []), ...(r.state ?? []), ...(r.props ?? [])]
			.flatMap(c => describeChange(c.key, c.prev, c.next))
			.join(", ");
		const reason = r.reason === "force" ? "force (forceUpdate or context)" : r.reason;
		const id = r.id === null ? "" : ` #${r.id}`;
		return `[${r.seq}] commit ${r.commit}: ${r.name}${id} ${reason}${changes ? ` (${changes})` : ""} ${r.durationMs}ms`;
	}

	function getRenders(
		opts: { since?: number; last?: number; target?: Target; format?: Format } = {},
	) {
		let ids: Set<number> | null = null;
		let name: string | null = null;
		if (opts.target !== undefined) {
			if (typeof opts.target === "string" && nameQuery(opts.target)) {
				// By name also matches renders of components that have unmounted since.
				name = opts.target;
			} else {
				ids = new Set(findIds(opts.target, 1000));
			}
		}
		const last = opts.last ?? (opts.since === undefined ? MAX_RENDERS_DEFAULT : undefined);
		let rows = renders.read({ since: opts.since }).map(({ seq, value }) => renderToJson(seq, value));
		if (name !== null) rows = rows.filter(r => r.name === name);
		if (ids !== null) rows = rows.filter(r => r.id !== null && ids!.has(r.id));
		if (last !== undefined && rows.length > last) rows = rows.slice(rows.length - last);
		if (opts.format === "text") {
			return rows.length ? rows.map(renderToText).join("\n") : "(no renders recorded)";
		}
		return rows;
	}

	function signalUpdateToJson(seq: number, u: SignalUpdate) {
		return {
			seq,
			time: u.timestamp,
			id: u.signalId,
			name: u.signalName,
			type: u.signalType,
			...(u.type === "update"
				? { prev: toAgentValue(u.prevValue), next: toAgentValue(u.newValue) }
				: {}),
			...(u.subscribedTo ? { triggeredBy: u.subscribedTo } : {}),
			...(u.recomputed ? { recomputed: true, outputChanged: !!u.outputChanged } : {}),
			depth: u.depth,
		};
	}

	function getSignalUpdates(
		opts: { since?: number; last?: number; name?: string; format?: Format } = {},
	) {
		if (typeof window !== "undefined") signals.sync(window);
		const last = opts.last ?? (opts.since === undefined ? 100 : undefined);
		let rows = signals.updates
			.read({ since: opts.since })
			.map(({ seq, value }) => signalUpdateToJson(seq, value.update));
		if (opts.name) rows = rows.filter(r => r.name === opts.name);
		if (last !== undefined && rows.length > last) rows = rows.slice(rows.length - last);
		if (opts.format === "text") {
			if (!signals.api) return "(@preact/signals-debug is not loaded)";
			return rows.length
				? rows
						.map(r =>
							"next" in r
								? `[${r.seq}] ${r.type} ${describeChange(r.name, r.prev, r.next).join(", ")}`
								: `[${r.seq}] ${r.type} ${r.name} ran`,
						)
						.join("\n")
				: "(no signal updates recorded)";
		}
		return rows;
	}

	/** Signals each mounted component read during its last render. */
	function componentReaders(): Map<object, Array<{ id: number; name: string }>> {
		const out = new Map<object, Array<{ id: number; name: string }>>();
		for (const node of tree.nodes.values()) {
			const r = rendererFor(node.id);
			const vnode = r?.getVNodeById(node.id);
			const c = vnode && (vnode.__c ?? vnode._component);
			let src = c?.__$u?.s;
			const seen = new Set();
			while (src != null && !seen.has(src)) {
				seen.add(src);
				if (src.S) {
					const list = out.get(src.S) ?? [];
					list.push({ id: node.id, name: node.name });
					out.set(src.S, list);
				}
				src = src.n;
			}
		}
		return out;
	}

	/** signals-debug's id for a signal object, if it assigned one. */
	function debugId(signal: any): string | null {
		// `_debugId`, mangled (see @preact/signals' mangle.json).
		const id = signal?.a;
		return typeof id === "string" && id.startsWith("signal_") ? id : null;
	}

	function getSignals(opts: { name?: string; format?: Format } = {}) {
		if (typeof window !== "undefined") signals.sync(window);
		type Row = {
			id: string | null;
			name: string;
			type: string;
			value?: unknown;
			updates: number;
			readBy?: Array<{ id: number; name: string }>;
			dependsOn?: string[];
			disposed?: true;
		};
		const rows = new Map<string, Row>();
		for (const k of signals.known.values()) {
			if (k.type === "effect" || k.type === "component") continue;
			rows.set(k.id, {
				id: k.id,
				name: k.name,
				type: k.type,
				...(k.hasValue ? { value: toAgentValue(k.value) } : {}),
				updates: k.updates,
				...(k.dependencies.length ? { dependsOn: k.dependencies } : {}),
				...(k.disposed ? { disposed: true as const } : {}),
			});
		}
		let anon = 0;
		for (const [signal, readers] of componentReaders()) {
			const s = signal as any;
			const id = debugId(s);
			const key = id ?? `live:${anon++}`;
			const row: Row = rows.get(key) ?? {
				id,
				name: signalName(s) ?? (typeof s.x === "function" ? "(anonymous computed)" : "(anonymous signal)"),
				type: typeof s.x === "function" ? "computed" : "signal",
				updates: 0,
			};
			try {
				row.value = toAgentValue(s.peek());
			} catch {
				// keep the last reported value
			}
			row.readBy = readers;
			rows.set(key, row);
		}
		let list = [...rows.values()];
		if (opts.name) list = list.filter(r => r.name === opts.name);
		if (opts.format === "text") {
			if (!list.length) return signals.api ? "(no signals seen yet)" : "(@preact/signals-debug is not loaded)";
			return list
				.map(r => {
					const readers = r.readBy ? `, read by ${r.readBy.map(x => `${x.name} #${x.id}`).join(", ")}` : "";
					const value = "value" in r ? ` = ${preview(r.value, 60)}` : "";
					return `${r.name}${value} (${r.type}, ${r.updates} updates${readers})${r.disposed ? " [disposed]" : ""}`;
				})
				.join("\n");
		}
		return list;
	}

	function getSignalGraph() {
		const nodes = new Map<string, { id: string; name: string; type: string }>();
		const links = new Map<string, { source: string; target: string }>();
		const link = (source: string, target: string) => {
			links.set(`${source}->${target}`, { source, target });
		};
		for (const k of signals.known.values()) {
			nodes.set(k.id, { id: k.id, name: k.name, type: k.type });
			for (const dep of k.dependencies) link(dep, k.id);
		}
		for (const [signal, readers] of componentReaders()) {
			const id = debugId(signal);
			if (!id) continue;
			if (!nodes.has(id)) {
				nodes.set(id, {
					id,
					name: signalName(signal) ?? "(anonymous)",
					type: typeof (signal as any).x === "function" ? "computed" : "signal",
				});
			}
			for (const reader of readers) {
				const cid = `component:${reader.id}`;
				nodes.set(cid, { id: cid, name: reader.name, type: "component" });
				link(id, cid);
			}
		}
		return { nodes: [...nodes.values()], links: [...links.values()] };
	}

	function treeToJson(id: number, depth: number): unknown {
		const node = tree.get(id);
		if (!node) return null;
		const key = keyOf(node);
		return {
			id: node.id,
			name: node.name,
			kind: node.kind,
			...(key ? { key } : {}),
			...(node.hocs ? { hocs: node.hocs } : {}),
			children:
				depth <= 0
					? node.children.length
						? `${node.children.length} more`
						: []
					: node.children.map(c => treeToJson(c, depth - 1)),
		};
	}

	function treeToText(id: number, depth: number, indent: string, out: string[]) {
		const node = tree.get(id);
		if (!node) return;
		const key = keyOf(node);
		const extra = [
			node.kind === "class" ? "class" : node.kind !== "function" ? node.kind : "",
			key ? `key=${JSON.stringify(key)}` : "",
			node.hocs?.length ? `hocs=${node.hocs.join(",")}` : "",
		]
			.filter(Boolean)
			.join(" ");
		out.push(`${indent}${node.name} #${node.id}${extra ? ` [${extra}]` : ""}`);
		if (depth <= 0) {
			if (node.children.length) out.push(`${indent}  … ${node.children.length} children`);
			return;
		}
		for (const child of node.children) treeToText(child, depth - 1, `${indent}  `, out);
	}

	function hooksToJson(data: any[] | null): unknown[] | null {
		if (!Array.isArray(data)) return null;
		const byId = new Map<string, any>(data.map(d => [d.id, d]));
		const build = (id: string): unknown => {
			const d = byId.get(id);
			if (!d) return null;
			const native = d.meta && typeof d.meta === "object" && "index" in d.meta;
			if (native) {
				return {
					hook: d.name,
					index: d.meta.index,
					value: d.value === "__preact_empty__" ? undefined : fromSerialized(d.value),
					...(d.editable ? { editable: true } : {}),
				};
			}
			return {
				hook: d.name,
				...(d.value !== "__preact_empty__" && d.value != null ? { debugValue: fromSerialized(d.value) } : {}),
				children: (d.children as string[])
					.filter(c => byId.get(c)?.meta != null)
					.map(build),
			};
		};
		const root = byId.get("root");
		return root ? (root.children as string[]).map(build) : null;
	}

	function liveSignals(vnode: any) {
		const c = vnode && (vnode.__c ?? vnode._component);
		const out: unknown[] = [];
		let node = c?.__$u?.s;
		const seen = new Set();
		let index = 0;
		while (node != null && !seen.has(node)) {
			seen.add(node);
			const s = node.S;
			let value: unknown;
			try {
				value = toAgentValue(s?.peek());
			} catch {
				value = "[Unreadable]";
			}
			out.push({
				index: index++,
				...(debugId(s) ? { id: debugId(s) } : {}),
				name: signalName(s) ?? null,
				type: typeof s?.x === "function" ? "computed" : "signal",
				value,
			});
			node = node.n;
		}
		return out.length ? out : null;
	}

	function inspect(target: Target, opts: { maxBytes?: number } = {}) {
		const id = resolve(target);
		const r = rendererFor(id);
		const vnode = r?.getVNodeById(id);
		const node = tree.get(id);
		if (!r || !vnode || !node) return null;
		const c = vnode.__c ?? vnode._component;

		// Hooks can only be read by re-running them, which the adapter does
		// (exactly like selecting the component in the Components tab).
		let data: any = null;
		let hooks: unknown;
		try {
			data = r.inspect(id);
			hooks = hooksToJson(data?.hooks ?? null);
		} catch (err) {
			hooks = `[Unreadable: ${err instanceof Error ? err.message : String(err)}]`;
		}

		const state =
			node.kind === "class" && c?.state && typeof c.state === "object" && Object.keys(c.state).length
				? c.state
				: null;
		const key = keyOf(node);
		const src = vnode.__source;
		const out: Record<string, unknown> = {
			id,
			name: node.name,
			kind: node.kind,
			...(key ? { key } : {}),
			path: tree.path(id).join(" > "),
			...(src?.fileName
				? { source: `${src.fileName}:${src.lineNumber ?? 0}:${src.columnNumber ?? 0}` }
				: {}),
			props: toAgentValue(withoutDevProps(vnode.props)) ?? null,
			state: toAgentValue(state) ?? null,
			hooks,
			signals: liveSignals(vnode),
			context: toAgentValue(withoutInternalContext(c?.context)) ?? null,
			...(data?.canSuspend ? { suspended: data.suspended } : {}),
		};
		return fitToBudget(out, opts.maxBytes ?? 20_000);
	}

	function update(target: Target, kind: string, path: string | number | Array<string | number>, value: unknown) {
		const id = resolve(target);
		const r = rendererFor(id);
		if (!r) throw new Error(`Component #${id} is gone`);
		switch (kind) {
			case "props":
			case "state":
			case "context": {
				const parts = Array.isArray(path)
					? path
					: String(path)
							.split(".")
							.filter(Boolean)
							.map(p => (/^\d+$/.test(p) ? Number(p) : p));
				// The adapter follows inherited properties when setting values.
				const bad = parts.find(p => FORBIDDEN_KEYS.has(String(p)));
				if (bad !== undefined) throw new Error(`Refusing to update "${String(bad)}"`);
				if (parts.length === 0) throw new Error("update() needs a path, e.g. \"label\" or \"todo.done\"");
				r.update(id, kind, parts, value);
				return true;
			}
			case "hook":
				if (!r.updateHook) throw new Error("This Preact version doesn't support editing hooks");
				r.updateHook(id, Number(path), value);
				return true;
			case "signal":
				if (!r.updateSignal) throw new Error("This Preact version doesn't support editing signals");
				r.updateSignal(id, Number(path), value);
				return true;
			default:
				throw new Error(`Unknown kind "${kind}", use props, state, context, hook or signal`);
		}
	}

	return {
		version: deps.version,
		help: () => HELP,

		getTree(opts: { root?: Target; depth?: number; format?: Format } = {}) {
			const depth = opts.depth ?? 50;
			const roots = opts.root !== undefined ? [resolve(opts.root)] : tree.topLevel();
			if (opts.format === "text") {
				const out: string[] = [];
				for (const id of roots) treeToText(id, depth, "", out);
				return out.length ? out.join("\n") : "(no Preact roots rendered yet)";
			}
			return roots.map(id => treeToJson(id, depth));
		},

		find(query: Target, opts: { limit?: number } = {}) {
			return findIds(query, opts.limit ?? 20)
				.map(id => tree.get(id))
				.filter((n): n is TreeNode => !!n)
				.map(summary);
		},

		inspect,
		update,
		getRenders,

		whyDidRender(target: Target, opts: { last?: number; format?: Format } = {}) {
			return getRenders({ target, last: opts.last ?? 5, format: opts.format });
		},

		mark: () => deps.currentSeq() + 1,

		startRecording() {
			recording = deps.currentSeq() + 1;
			return recording;
		},

		stopRecording(opts: { format?: Format } = {}) {
			const since = recording ?? deps.currentSeq() + 1;
			recording = null;
			if (opts.format === "text") {
				return `Renders:\n${getRenders({ since, format: "text" })}\n\nSignal updates:\n${getSignalUpdates({ since, format: "text" })}`;
			}
			return {
				renders: getRenders({ since }),
				signalUpdates: getSignalUpdates({ since }),
			};
		},

		getSignals,
		getSignalUpdates,
		getSignalGraph,

		/** Diagnostics: what is (not) connected. */
		status() {
			return {
				version: deps.version,
				renderers: renderers().length,
				components: tree.nodes.size,
				roots: tree.roots.length,
				signalsDebug: !!signals.api,
				asyncTree: deps.asyncTree,
				renders: { buffered: renders.size, dropped: renders.dropped },
				signalUpdates: { buffered: signals.updates.size, dropped: signals.updates.dropped },
			};
		},
	};
}

export type AgentApi = ReturnType<typeof createAgentApi>;
