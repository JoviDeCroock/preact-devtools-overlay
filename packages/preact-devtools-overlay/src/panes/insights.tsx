/**
 * "Insights" pane: what the agent API knows, for humans. Why the selected
 * component rendered, the signals it reads and the providers of its
 * contexts, plus app-wide remounts, leaked effects and the signal inventory.
 *
 * Our own UI, so none of this needs patches to the vendored panels. It
 * follows the Components tab's selection and links back to it.
 */
import { Fragment, render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentApi } from "../agent/api.js";
import { createStyleElement } from "../styles-registry.js";
import { openInEditor, canOpenInEditor } from "../editor.js";

export interface InsightsBridge {
	/** Component selected in the Components tab (null if it isn't loaded). */
	selectedComponent(): number | null;
	/** Switch to the Components tab and select a component there. */
	showComponent(id: number): void;
	showTab(tab: "components" | "signals"): void;
}

export interface InsightsPane {
	destroy(): void;
}

const POLL_MS = 500;
/** Signals created outside renders don't move `mark()`: re-read now and then. */
const FULL_REFRESH_MS = 2000;

const CSS = `
:host { display: block; height: 100%; }
.ins { height: 100%; overflow: auto; box-sizing: border-box; padding: 8px 12px 24px;
  font: 12px/1.5 system-ui, -apple-system, sans-serif; color: #222; background: #fff; }
@media (prefers-color-scheme: dark) { .ins { color: #ddd; background: #242424; } }
.ins h2 { font-size: 12px; margin: 0; display: inline; }
.ins details { border-top: 1px solid #8884; padding: 6px 0; }
.ins details:first-of-type { border-top: 0; }
.ins summary { cursor: pointer; user-select: none; padding: 2px 0; }
.ins .count { opacity: .6; font-weight: normal; margin-left: 4px; }
.ins .empty, .ins .hint { opacity: .65; margin: 4px 0; }
.ins ul { list-style: none; margin: 4px 0; padding: 0; }
.ins li { padding: 1px 0; overflow-wrap: anywhere; }
.ins code, .ins .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.ins .link { background: none; border: 0; padding: 0; font: inherit; color: #673ab8; cursor: pointer; text-decoration: underline dotted; }
@media (prefers-color-scheme: dark) { .ins .link { color: #b39ddb; } }
.ins .reason { display: inline-block; min-width: 52px; padding: 0 4px; border-radius: 3px; background: #8882; font-size: 11px; text-align: center; margin-right: 6px; }
.ins .reason.mount { background: #4caf5033; } .ins .reason.signal { background: #673ab833; }
.ins .reason.parent, .ins .reason.force { background: #ff980033; }
.ins .warn { color: #b26a00; } @media (prefers-color-scheme: dark) { .ins .warn { color: #ffb74d; } }
.ins .muted { opacity: .6; }
.ins .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-bottom: 2px; }
.ins .btn { font: inherit; font-size: 11px; padding: 1px 6px; border: 1px solid #8886; border-radius: 3px; background: none; color: inherit; cursor: pointer; }
.ins table { border-collapse: collapse; width: 100%; }
.ins td, .ins th { text-align: left; padding: 1px 8px 1px 0; vertical-align: top; }
.ins th { font-weight: 600; opacity: .7; }
`;

type Json = any;

interface Snapshot {
	selected: {
		info: Json;
		renders: Json[];
	} | null;
	renders: Json[];
	remounts: Json[];
	leaks: Json[];
	signals: Json[];
	status: Json;
}

function take(api: AgentApi, focus: number | null): Snapshot {
	let selected: Snapshot["selected"] = null;
	if (focus !== null) {
		try {
			selected = {
				info: api.inspect(focus, { hooks: false }),
				renders: api.whyDidRender(focus, { last: 8 }) as Json[],
			};
		} catch {
			selected = null; // unmounted
		}
	}
	return {
		selected,
		renders: (api.getRenders({ last: 40 }) as Json[]).slice().reverse(),
		remounts: (api.getRemounts({ last: 20 }) as Json[]).slice().reverse(),
		leaks: api.getLeaks() as Json[],
		signals: api.getSignals({ limit: 150 }) as Json[],
		status: api.status(),
	};
}

function short(value: unknown, max = 60): string {
	let s: string;
	try {
		s = value === undefined ? "undefined" : (JSON.stringify(value) ?? String(value));
	} catch {
		s = String(value);
	}
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function changesOf(r: Json): string {
	const all = [...(r.signals ?? []), ...(r.hooks ?? []), ...(r.state ?? []), ...(r.props ?? []), ...(r.context ?? [])];
	return all.map((c: Json) => `${c.key}: ${short(c.prev, 30)} → ${short(c.next, 30)}`).join(", ");
}

interface CompProps {
	/** Not a number when unknown, or cut by `inspect()`'s size budget. */
	id: unknown;
	name: string;
	focus(id: number): void;
	bridge: InsightsBridge;
}

function Comp({ id, name, focus, bridge }: CompProps) {
	return typeof id !== "number" ? (
		<span class="muted">{name}</span>
	) : (
		<button
			class="link"
			title="Show here; double-click to select it in the Components tab"
			onClick={() => focus(id)}
			onDblClick={() => bridge.showComponent(id)}
		>
			{name}
		</button>
	);
}

/** `inspect()` cuts big fields to a string like `"[Array(2000)]"`. */
const list = (x: unknown): Json[] | null => (Array.isArray(x) ? x : null);

function Insights({ api, bridge, visible }: { api: AgentApi; bridge: InsightsBridge; visible(): boolean }) {
	const focusRef = useRef<number | null>(null);
	const refresh = useRef<(force?: boolean) => void>(() => {});
	const [snap, setSnap] = useState<Snapshot>(() => take(api, null));

	useEffect(() => {
		let lastSeq = -1;
		let lastFocus: number | null | undefined;
		let lastSelected: number | null = null;
		let lastFull = 0;
		let wasVisible = true;
		const tick = (force = false) => {
			// Only while the pane is on screen: a snapshot isn't free.
			if (document.visibilityState !== "visible" || !visible()) {
				wasVisible = false;
				return;
			}
			if (!wasVisible) force = true;
			wasVisible = true;
			const now = Date.now();
			if (now - lastFull >= FULL_REFRESH_MS) force = true;
			// Follow the Components tab's selection when it changes.
			const sel = bridge.selectedComponent();
			if (sel !== lastSelected) {
				lastSelected = sel;
				if (sel !== null && sel >= 0) focusRef.current = sel;
			}
			const seq = api.mark();
			const focus = focusRef.current;
			if (!force && seq === lastSeq && focus === lastFocus) return;
			lastSeq = seq;
			lastFocus = focus;
			lastFull = now;
			try {
				setSnap(take(api, focus));
			} catch (err) {
				console.warn("[preact-devtools-overlay] Insights failed to refresh", err);
			}
		};
		refresh.current = tick;
		tick();
		const timer = setInterval(() => tick(), POLL_MS);
		return () => clearInterval(timer);
	}, [api, bridge]);

	const focus = (id: number) => {
		focusRef.current = id;
		refresh.current(true);
	};
	const link = (id: unknown, name: string) => (
		<Comp id={id} name={name} focus={focus} bridge={bridge} />
	);

	const sel = snap.selected?.info;
	const selSignals = list(sel?.signals);
	const selContexts = list(sel?.contexts);
	const editor = useMemo(() => canOpenInEditor(), []);

	return (
		<div class="ins">
			<details open>
				<summary>
					<h2>Selected component</h2>
				</summary>
				{!sel ? (
					<p class="hint">Select a component in the Components tab, or click a component name below.</p>
				) : (
					<div>
						<div class="head">
							<strong class="mono">&lt;{sel.name}&gt;</strong>
							<span class="muted mono">#{sel.id}</span>
							<button class="btn" onClick={() => bridge.showComponent(sel.id)}>Show in Components</button>
						</div>
						<div class="muted">{sel.path}</div>
						{sel.source && (
							<div>
								<span class="mono">{sel.source}</span>{" "}
								{editor && (
									<button class="btn" onClick={() => openInEditor(sel.source)}>Open in editor</button>
								)}
							</div>
						)}
						<p class="hint" style="margin-top:8px">Why did it render? (newest last)</p>
						{snap.selected!.renders.length === 0 ? (
							<p class="empty">No renders recorded.</p>
						) : (
							<ul>
								{snap.selected!.renders.map((r: Json) => (
									<li key={r.seq}>
										<span class={`reason ${r.reason}`}>{r.reason}</span>
										<span class="muted">commit {r.commit}</span> {changesOf(r)}
									</li>
								))}
							</ul>
						)}
						{typeof sel.signals === "string" && <p class="hint">Signals it reads: {sel.signals}</p>}
						{selSignals && (
							<>
								<p class="hint">Signals it reads</p>
								<ul>
									{selSignals.map((s: Json) => (
										<li key={s.index} class="mono">
											{s.name ?? `(anonymous ${s.type})`} = {short(s.value)}
										</li>
									))}
								</ul>
							</>
						)}
						{typeof sel.contexts === "string" && <p class="hint">Contexts: {sel.contexts}</p>}
						{selContexts && (
							<>
								<p class="hint">Contexts</p>
								<ul>
									{selContexts.map((c: Json) => (
										<li key={c.name}>
											<span class="mono">{c.name} = {short(c.value)}</span>{" "}
											{c.provider && typeof c.provider === "object" ? (
												<>
													<span class="muted">from</span> {link(c.provider.id, c.provider.path ?? "provider")}
												</>
											) : c.provider ? (
												<span class="muted">{String(c.provider)}</span>
											) : (
												<span class="muted">(no provider, default value)</span>
											)}
										</li>
									))}
								</ul>
							</>
						)}
					</div>
				)}
			</details>

			<details open>
				<summary>
					<h2>Renders</h2>
					<span class="count">newest first</span>
				</summary>
				{snap.renders.length === 0 ? (
					<p class="empty">No renders recorded.</p>
				) : (
					<ul>
						{snap.renders.map((r: Json) => (
							<li key={r.seq}>
								<span class={`reason ${r.reason}`}>{r.reason}</span>
								{link(r.id, r.name)} <span class="muted">commit {r.commit}</span>{" "}
								<span class="mono">{changesOf(r)}</span>
							</li>
						))}
					</ul>
				)}
			</details>

			<details open={snap.remounts.length > 0}>
				<summary>
					<h2>Remounts</h2>
					<span class="count">{snap.remounts.length}</span>
				</summary>
				<p class="hint">Components that unmounted and mounted again in one commit, losing their state: an unstable or missing key, or a component type created during render.</p>
				<ul>
					{snap.remounts.map((r: Json) => (
						<li key={r.seq} class="warn">
							{link(r.id, r.path)}{" "}
							{r.prevKey !== r.key
								? `key ${JSON.stringify(r.prevKey)} → ${JSON.stringify(r.key)}`
								: r.key
									? `same key: component type created during render?`
									: "no key"}
						</li>
					))}
				</ul>
			</details>

			<details open={snap.leaks.length > 0}>
				<summary>
					<h2>Leaks</h2>
					<span class="count">{snap.leaks.length}</span>
				</summary>
				{!snap.status.signalTracking ? (
					<p class="empty">Signal tracking is off (the Vite plugin turns it on when the app uses signals).</p>
				) : snap.leaks.length === 0 ? (
					<p class="empty">No effects outliving their component, nothing created on every render.</p>
				) : (
					<ul>
						{snap.leaks.map((l: Json, i: number) => (
							<li key={i} class="warn">
								{link(l.owner.id, l.owner.name)}: {l.count} {l.kind}
								{l.count === 1 ? "" : "s"}
								{l.names.length ? ` (${l.names.join(", ")})` : ""}{" "}
								{l.problem === "outlived-component"
									? "still running after it unmounted"
									: `created during ${l.rerenders.creating} of its ${l.rerenders.total} re-renders`}
							</li>
						))}
					</ul>
				)}
			</details>

			<details open>
				<summary>
					<h2>Signals</h2>
					<span class="count">{snap.signals.length}</span>{" "}
					<button class="btn" onClick={e => (e.preventDefault(), bridge.showTab("signals"))}>Open Signals tab</button>
				</summary>
				{snap.signals.length === 0 ? (
					<p class="empty">No signals seen yet.</p>
				) : (
					<table>
						<thead>
							<tr>
								<th>Name</th>
								<th>Value</th>
								<th>Subscribers</th>
								<th>Read by</th>
							</tr>
						</thead>
						<tbody>
							{snap.signals.map((s: Json, i: number) => (
								<tr key={s.id ?? i}>
									<td class="mono">
										{s.name}
										{s.type === "computed" ? <span class="muted"> (computed)</span> : null}
										{s.disposed ? <span class="muted"> [disposed]</span> : null}
									</td>
									<td class="mono">{"value" in s ? short(s.value, 50) : ""}</td>
									<td>{s.subscribers ?? ""}</td>
									<td>
										{(s.readBy ?? []).map((r: Json, j: number) => (
											<Fragment key={r.id}>
												{j > 0 && ", "}
												{link(r.id, r.name)}
											</Fragment>
										))}
										{s.createdBy && !s.readBy ? (
											<span class="muted">created by {s.createdBy.name}</span>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</details>
		</div>
	);
}

export function mountInsightsPane(shadow: ShadowRoot, win: Window, bridge: InsightsBridge): InsightsPane {
	const doc = shadow.ownerDocument;
	shadow.appendChild(createStyleElement(doc, "insights", CSS));
	const container = doc.createElement("div");
	container.style.height = "100%";
	shadow.appendChild(container);

	const api = win.__PREACT_DEVTOOLS_OVERLAY__?.api;
	if (!api) {
		const p = doc.createElement("p");
		p.style.cssText = "padding:16px;font:13px/1.5 system-ui,sans-serif;opacity:.7";
		p.textContent =
			"Insights use the agent API, which is off. It is on by default on the Vite dev server; pass agentApi: true to the plugin to use it elsewhere.";
		container.appendChild(p);
	} else {
		// `hidden` on the drawer or the pane host takes it out of layout.
		const visible = () => container.getClientRects().length > 0;
		render(<Insights api={api} bridge={bridge} visible={visible} />, container);
	}
	return {
		destroy() {
			render(null, container);
			shadow.replaceChildren();
		},
	};
}
