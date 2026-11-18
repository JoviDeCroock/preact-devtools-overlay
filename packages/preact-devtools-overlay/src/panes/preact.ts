/**
 * "Components" pane: the upstream preact-devtools UI, wired directly to the
 * page hook over `window.postMessage` instead of through the extension's
 * content-script / background-page relay.
 */
import { h, render } from "preact";
import { effect } from "@preact/signals";
import { DevTools } from "../../vendor/preact-devtools/src/view/components/Devtools";
import { createStore } from "../../vendor/preact-devtools/src/view/store";
import { applyEvent } from "../../vendor/preact-devtools/src/adapter/protocol/events";
import { DevtoolsToClient } from "../../vendor/preact-devtools/src/constants";
import type { Store } from "../../vendor/preact-devtools/src/view/store/types";
import sprite from "../../vendor/preact-devtools/src/view/sprite.svg?raw";
import { createStyleElement } from "../styles-registry";
import { isPageHookMessage } from "../shared";

const SETTINGS_KEY = "preact-devtools-overlay:components-settings";

interface PersistedSettings {
	theme?: "auto" | "light" | "dark";
	captureRenderReasons?: boolean;
	highlightUpdates?: boolean;
	debugMode?: boolean;
	componentFilters?: unknown;
}

const BASE_CSS = `
:host { display: block; height: 100%; --color-text: #333; }
.pdo-root { height: 100%; }
.pdo-sprite { display: none; }
`;

function readSettings(): PersistedSettings {
	try {
		return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") ?? {};
	} catch {
		return {};
	}
}

function writeSettings(patch: PersistedSettings) {
	try {
		localStorage.setItem(
			SETTINGS_KEY,
			JSON.stringify({ ...readSettings(), ...patch }),
		);
	} catch {
		// Persisting settings is best-effort only.
	}
}

function restoreSettings(store: Store) {
	const s = readSettings();
	if (s.theme === "auto" || s.theme === "light" || s.theme === "dark") {
		store.theme.value = s.theme;
	}
	store.profiler.captureRenderReasons.value = !!s.captureRenderReasons;
	store.profiler.highlightUpdates.value = !!s.highlightUpdates;
	store.debugMode.value = !!s.debugMode;
	if (s.componentFilters) {
		try {
			store.filter.restore(s.componentFilters as any);
		} catch {
			// Ignore filters persisted by an incompatible version.
		}
	}
}

export interface PreactPane {
	store: Store;
	destroy(): void;
}

export function mountPreactPane(shadow: ShadowRoot, win: Window): PreactPane {
	const doc = shadow.ownerDocument;
	shadow.appendChild(createStyleElement(doc, "preact", BASE_CSS));

	// Icons are referenced via `<use href="#id">`, which resolves inside the
	// shadow tree, so the sprite has to live in the same root.
	const spriteHost = doc.createElement("div");
	spriteHost.className = "pdo-sprite";
	spriteHost.innerHTML = sprite;
	shadow.appendChild(spriteHost);

	const container = doc.createElement("div");
	container.className = "pdo-root";
	// Picked up by the patched ThemeSwitcher (see patches/preact-devtools).
	container.setAttribute("data-devtools-theme-root", "");
	shadow.appendChild(container);

	const store = createStore();
	restoreSettings(store);

	const disposers: Array<() => void> = [
		effect(() => writeSettings({ theme: store.theme.value })),
		effect(() =>
			writeSettings({
				captureRenderReasons: store.profiler.captureRenderReasons.value,
			}),
		),
		effect(() =>
			writeSettings({ highlightUpdates: store.profiler.highlightUpdates.value }),
		),
		effect(() => writeSettings({ debugMode: store.debugMode.value })),
	];

	const send = (type: string, data: unknown) =>
		win.postMessage({ type, data, source: DevtoolsToClient }, "*");

	const onMessage = (e: MessageEvent) => {
		if (isPageHookMessage(e, win)) applyEvent(store, e.data.type, e.data.data);
	};
	win.addEventListener("message", onMessage);

	disposers.push(
		store.subscribe((type, data) => {
			send(type, data);

			// The extension implements these through privileged devtools APIs
			// (`inspect()`). The closest in-page equivalent is logging the
			// value, which the browser console renders as a clickable reference.
			const hook = win.__PREACT_DEVTOOLS__;
			if (type === "update-filter") {
				writeSettings({ componentFilters: data });
			} else if (type === "inspect-host-node") {
				if (hook?.$0) console.log("[preact-devtools] DOM node:", hook.$0);
			} else if (type === "view-source") {
				// The hook resolves `$type` in response to the message above,
				// which is delivered asynchronously.
				setTimeout(() => {
					if (hook?.$type) {
						console.log("[preact-devtools] Component source:", hook.$type);
					}
				}, 0);
			}
		}),
	);

	// Replay renderer feature flags that were emitted before we mounted.
	for (const ev of win.__PREACT_DEVTOOLS_OVERLAY__?.attachEvents ?? []) {
		applyEvent(store, ev.type, ev.data);
	}

	render(h(DevTools, { store, window: win }), container);

	// Mark the hook as connected and ask every renderer for its full tree.
	send("init", null);
	send("refresh", null);

	return {
		store,
		destroy() {
			send("disconnect", null);
			win.removeEventListener("message", onMessage);
			disposers.forEach(d => d());
			render(null, container);
			shadow.replaceChildren();
		},
	};
}
