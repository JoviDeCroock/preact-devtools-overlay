/**
 * `<preact-devtools-overlay>`: a floating launcher + resizable drawer that
 * hosts both devtools UIs, each in its own nested shadow root so their
 * global resets and theme variables can't collide with each other or with
 * the host page.
 *
 * The panes are code-split and only loaded the first time they are shown.
 */
import "./shell.css";
import { createStyleElement } from "./styles-registry";
import type { PreactPane } from "./panes/preact";
import type { SignalsPane } from "./panes/signals";

export type OverlayTab = "components" | "signals";
export type OverlayPosition =
	| "bottom-right"
	| "bottom-left"
	| "top-right"
	| "top-left";

const TABS: Array<{ id: OverlayTab; label: string }> = [
	{ id: "components", label: "Components" },
	{ id: "signals", label: "Signals" },
];
const POSITIONS: OverlayPosition[] = [
	"bottom-right",
	"bottom-left",
	"top-right",
	"top-left",
];

const STATE_KEY = "preact-devtools-overlay:state";
const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT_RATIO = 0.4;

interface PersistedState {
	open?: boolean;
	tab?: OverlayTab;
	height?: number;
}

const PREACT_LOGO = `<svg viewBox="-256 -256 512 512" aria-hidden="true" width="20" height="20"><path d="M0,-256 221.7025033688164,-128 221.7025033688164,128 0,256 -221.7025033688164,128 -221.7025033688164,-128z" fill="currentColor"/><ellipse cx="0" cy="0" rx="75" ry="196" stroke-width="16" fill="none" stroke="#fff" transform="rotate(52.5)"/><ellipse cx="0" cy="0" rx="75" ry="196" stroke-width="16" fill="none" stroke="#fff" transform="rotate(-52.5)"/><circle cx="0" cy="0" r="34" fill="#fff"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

function readState(): PersistedState {
	try {
		const raw = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}

function writeState(patch: PersistedState) {
	try {
		localStorage.setItem(STATE_KEY, JSON.stringify({ ...readState(), ...patch }));
	} catch {
		// Best-effort only (e.g. storage disabled).
	}
}

function isTab(v: unknown): v is OverlayTab {
	return v === "components" || v === "signals";
}

/** Base class that is safe to reference during SSR. */
const BaseElement: typeof HTMLElement =
	typeof HTMLElement === "undefined"
		? (class {} as unknown as typeof HTMLElement)
		: HTMLElement;

export class PreactDevtoolsOverlay extends BaseElement {
	static observedAttributes = ["open", "tab", "position"];

	#shadow: ShadowRoot;
	#drawer!: HTMLElement;
	#launcher!: HTMLButtonElement;
	#tabButtons = new Map<OverlayTab, HTMLButtonElement>();
	#paneHosts = new Map<OverlayTab, HTMLElement>();
	#preactPane: PreactPane | null = null;
	#signalsPane: Promise<SignalsPane | null> | null = null;
	#destroyed = false;
	#height = 0;
	/** Set once `open` was assigned explicitly, so persisted state won't override it. */
	#openExplicit = false;
	#cleanup: Array<() => void> = [];

	constructor() {
		super();
		this.#shadow = this.attachShadow({ mode: "open" });
		this.#render();
	}

	/** Whether the drawer is open. Reflects the `open` attribute. */
	get open(): boolean {
		return this.hasAttribute("open");
	}
	set open(value: boolean) {
		this.#openExplicit = true;
		this.toggleAttribute("open", !!value);
	}

	/** Currently selected tab. Reflects the `tab` attribute. */
	get tab(): OverlayTab {
		const t = this.getAttribute("tab");
		return isTab(t) ? t : "components";
	}
	set tab(value: OverlayTab) {
		this.setAttribute("tab", value);
	}

	/** Corner the launcher button sits in. Reflects `position`. */
	get position(): OverlayPosition {
		const p = this.getAttribute("position") as OverlayPosition;
		return POSITIONS.includes(p) ? p : "bottom-right";
	}
	set position(value: OverlayPosition) {
		this.setAttribute("position", value);
	}

	toggle(force?: boolean) {
		this.open = force ?? !this.open;
	}

	connectedCallback() {
		this.#destroyed = false;
		const state = readState();
		if (!this.hasAttribute("tab") && isTab(state.tab)) this.tab = state.tab;
		if (!this.hasAttribute("open") && !this.#openExplicit && state.open) {
			this.toggleAttribute("open", true);
		}
		this.#setHeight(state.height ?? window.innerHeight * DEFAULT_HEIGHT_RATIO);

		const onKeyDown = (e: KeyboardEvent) => {
			// Alt+Shift+D. Use `code`, as Option changes `key` on macOS.
			if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyD") {
				e.preventDefault();
				this.toggle();
			}
		};
		const onResize = () => this.#setHeight(this.#height);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", onResize);
		this.#cleanup.push(
			() => window.removeEventListener("keydown", onKeyDown),
			() => window.removeEventListener("resize", onResize),
		);
		this.#sync();
	}

	disconnectedCallback() {
		this.#destroyed = true;
		this.#cleanup.forEach(fn => fn());
		this.#cleanup = [];
		this.#preactPane?.destroy();
		this.#preactPane = null;
		const signals = this.#signalsPane;
		this.#signalsPane = null;
		signals?.then(p => p?.destroy());
		// Recreate empty pane hosts so the element can be re-attached later.
		for (const [id, host] of this.#paneHosts) {
			const fresh = host.cloneNode(false) as HTMLElement;
			host.replaceWith(fresh);
			this.#paneHosts.set(id, fresh);
		}
	}

	attributeChangedCallback() {
		this.#sync();
	}

	#render() {
		const shadow = this.#shadow;
		shadow.appendChild(createStyleElement(this.ownerDocument, "shell"));

		const launcher = document.createElement("button");
		launcher.className = "launcher";
		launcher.part.add("launcher");
		launcher.type = "button";
		launcher.title = "Toggle Preact Devtools (Alt+Shift+D)";
		launcher.setAttribute("aria-label", "Toggle Preact Devtools");
		launcher.innerHTML = PREACT_LOGO;
		launcher.addEventListener("click", () => this.toggle());
		this.#launcher = launcher;

		const drawer = document.createElement("section");
		drawer.className = "drawer";
		drawer.part.add("drawer");
		drawer.setAttribute("aria-label", "Preact Devtools");

		const handle = document.createElement("div");
		handle.className = "resize-handle";
		handle.setAttribute("role", "separator");
		handle.setAttribute("aria-orientation", "horizontal");
		handle.setAttribute("aria-label", "Resize devtools");
		this.#setupResize(handle);

		const bar = document.createElement("header");
		bar.className = "bar";
		const brand = document.createElement("span");
		brand.className = "brand";
		brand.innerHTML = PREACT_LOGO;

		const tablist = document.createElement("div");
		tablist.className = "tabs";
		tablist.setAttribute("role", "tablist");
		for (const { id, label } of TABS) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "tab";
			btn.id = `pdo-tab-${id}`;
			btn.textContent = label;
			btn.setAttribute("role", "tab");
			btn.setAttribute("aria-controls", `pdo-pane-${id}`);
			btn.addEventListener("click", () => (this.tab = id));
			tablist.appendChild(btn);
			this.#tabButtons.set(id, btn);
		}
		tablist.addEventListener("keydown", e => {
			if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
			const idx = TABS.findIndex(t => t.id === this.tab);
			const next = TABS[(idx + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
			this.tab = next.id;
			this.#tabButtons.get(next.id)?.focus();
		});

		const close = document.createElement("button");
		close.type = "button";
		close.className = "close";
		close.title = "Close (Alt+Shift+D)";
		close.setAttribute("aria-label", "Close Preact Devtools");
		close.innerHTML = CLOSE_ICON;
		close.addEventListener("click", () => (this.open = false));

		bar.append(brand, tablist, close);

		const panes = document.createElement("div");
		panes.className = "panes";
		for (const { id } of TABS) {
			const host = document.createElement("div");
			host.className = "pane";
			host.id = `pdo-pane-${id}`;
			host.setAttribute("role", "tabpanel");
			host.setAttribute("aria-labelledby", `pdo-tab-${id}`);
			panes.appendChild(host);
			this.#paneHosts.set(id, host);
		}

		drawer.append(handle, bar, panes);
		shadow.append(launcher, drawer);
		this.#drawer = drawer;
	}

	#setupResize(handle: HTMLElement) {
		handle.addEventListener("pointerdown", e => {
			if (e.button !== 0) return;
			e.preventDefault();
			handle.setPointerCapture(e.pointerId);
			this.#drawer.classList.add("resizing");
			const onMove = (ev: PointerEvent) =>
				this.#setHeight(window.innerHeight - ev.clientY);
			const onUp = () => {
				handle.removeEventListener("pointermove", onMove);
				handle.removeEventListener("pointerup", onUp);
				handle.removeEventListener("pointercancel", onUp);
				this.#drawer.classList.remove("resizing");
				writeState({ height: this.#height });
				this.#notifyPaneResize();
			};
			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", onUp);
			handle.addEventListener("pointercancel", onUp);
		});
		handle.addEventListener("dblclick", () => {
			this.#setHeight(window.innerHeight * DEFAULT_HEIGHT_RATIO);
			writeState({ height: this.#height });
			this.#notifyPaneResize();
		});
	}

	#setHeight(px: number) {
		const max = Math.max(MIN_HEIGHT, window.innerHeight - 40);
		const h = Math.round(Math.min(max, Math.max(MIN_HEIGHT, px || 0)));
		this.#height = h;
		this.style.setProperty("--pdo-height", `${h}px`);
	}

	/**
	 * The components tree virtualizes its rows and only re-measures on window
	 * `resize`, so let it know the drawer height changed.
	 */
	#notifyPaneResize() {
		if (this.#preactPane) window.dispatchEvent(new Event("resize"));
	}

	#sync() {
		if (!this.#drawer) return;
		const open = this.open;
		const tab = this.tab;

		this.#drawer.hidden = !open;
		this.#launcher.setAttribute("aria-expanded", String(open));
		this.#launcher.dataset.position = this.position;
		for (const [id, btn] of this.#tabButtons) {
			const selected = id === tab;
			btn.setAttribute("aria-selected", String(selected));
			btn.tabIndex = selected ? 0 : -1;
			this.#paneHosts.get(id)!.hidden = !selected;
		}

		if (!this.isConnected) return;
		writeState({ open, tab });
		if (open) this.#ensurePane(tab);
	}

	#ensurePane(tab: OverlayTab) {
		const host = this.#paneHosts.get(tab)!;
		if (tab === "components" && !this.#preactPane) {
			const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
			// Claim the slot synchronously so concurrent syncs don't double-mount.
			const placeholder: PreactPane = { store: null!, destroy() {} };
			this.#preactPane = placeholder;
			import("./panes/preact")
				.then(({ mountPreactPane }) => {
					if (this.#destroyed || this.#preactPane !== placeholder) return;
					this.#preactPane = mountPreactPane(root, window);
				})
				.catch(err => this.#showError(root, "Components", err));
		} else if (tab === "signals" && !this.#signalsPane) {
			const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
			const pending: Promise<SignalsPane | null> = import("./panes/signals")
				.then(async ({ mountSignalsPane }) => {
					if (this.#destroyed || this.#signalsPane !== pending) return null;
					const pane = await mountSignalsPane(root, window);
					if (this.#destroyed || this.#signalsPane !== pending) {
						pane.destroy();
						return null;
					}
					return pane;
				})
				.catch(err => {
					this.#showError(root, "Signals", err);
					return null;
				});
			this.#signalsPane = pending;
		}
	}

	#showError(root: ShadowRoot, name: string, err: unknown) {
		console.error(`[preact-devtools-overlay] Failed to load the ${name} panel`, err);
		const msg = document.createElement("p");
		msg.style.cssText = "padding:1rem;font:13px/1.4 system-ui,sans-serif;color:#b00020";
		msg.textContent = `Failed to load the ${name} panel. See the console for details.`;
		root.replaceChildren(msg);
	}
}

export function defineOverlayElement(tagName = "preact-devtools-overlay") {
	if (typeof customElements === "undefined") return;
	if (!customElements.get(tagName)) {
		// A subclass per tag name: the same constructor can't be registered twice.
		customElements.define(tagName, class extends PreactDevtoolsOverlay {});
	}
}
