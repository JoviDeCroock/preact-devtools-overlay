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
import { Panel, type Store } from "../../vendor/preact-devtools/src/view/store/types";
import { startProfiling } from "../../vendor/preact-devtools/src/view/components/profiler/data/commits";
import sprite from "../../vendor/preact-devtools/src/view/sprite.svg?raw";
import { createStyleElement } from "../styles-registry.js";
import { isPageHookMessage } from "../shared.js";

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
	const send = (type: string, data: unknown) =>
		win.postMessage({ type, data, source: DevtoolsToClient }, "*");

	const disposers: Array<() => void> = [
		// Subscribe before restoring settings: restoring filters emits an
		// `update-filter` that has to reach the page.
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
	];

	restoreSettings(store);

	disposers.push(
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
	);

	const handle = (type: string, data: unknown, resendFilters = true) => {
		applyEvent(store, type as any, data);
		// The hook only starts listening once a renderer attached, so filters
		// sent before that were dropped. Re-send them for every renderer.
		if (type === "attach" && resendFilters) store.filter.submit();
	};

	const onMessage = (e: MessageEvent) => {
		if (isPageHookMessage(e, win)) handle(e.data.type, e.data.data);
	};
	win.addEventListener("message", onMessage);

	const client = win.__PREACT_DEVTOOLS_OVERLAY__;
	const session = client?.reloadSession;
	if (client && session) {
		// "Reload and profile" / "Reload and record stats": the hook has been
		// recording since the page started, replay everything it sent.
		client.reloadSession = null;
		if (session.kind === "profile") {
			startProfiling(store.profiler);
			store.activePanel.value = Panel.PROFILER;
		} else {
			store.stats.isRecording.value = true;
			store.activePanel.value = Panel.STATISTICS;
		}
		if (session.truncated) {
			console.warn(
				"[preact-devtools-overlay] The recording was too long to buffer before the panel opened; early commits are missing.",
			);
		}
		// Don't re-send filters here: applying them re-flushes the whole tree,
		// which would show up in the recording. Like the extension, a reloaded
		// session runs with the hook's default filters.
		for (const ev of session.events) handle(ev.type, ev.data, false);
	} else {
		// Replay renderer feature flags that were emitted before we mounted.
		for (const ev of client?.attachEvents ?? []) handle(ev.type, ev.data);
	}

	render(h(DevTools, { store, window: win }), container);

	// Mark the hook as connected. Outside of a replayed session also ask every
	// renderer for its full tree (a refresh during a session would record a
	// bogus remount commit).
	send("init", null);
	if (!session) send("refresh", null);

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
