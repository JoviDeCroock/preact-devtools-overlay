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
import { openInEditor, sourceOf } from "../editor.js";

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

function restoreSettings(store: Store, { filters }: { filters: boolean }) {
	const s = readSettings();
	if (s.theme === "auto" || s.theme === "light" || s.theme === "dark") {
		store.theme.value = s.theme;
	}
	store.profiler.captureRenderReasons.value = !!s.captureRenderReasons;
	store.profiler.highlightUpdates.value = !!s.highlightUpdates;
	store.debugMode.value = !!s.debugMode;
	if (filters && s.componentFilters) {
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
				// On the dev server, open where it's rendered in the editor.
				const source = typeof data === "number" ? sourceOf(data, win) : null;
				if (source) openInEditor(source, win);
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

	const client = win.__PREACT_DEVTOOLS_OVERLAY__;
	const session = client?.reloadSession ?? null;
	if (client) client.reloadSession = null;
	// A replayable "Reload and profile/record stats" recording. If the buffer
	// overflowed, the recording is incomplete and the tree can't be rebuilt
	// from it, so it's discarded below instead.
	const replay = session && !session.truncated ? session : null;

	// Restoring non-default filters sends `update-filter`, which makes the
	// hook unmount and remount every tree. During a replayed recording that
	// would show up as bogus commits, so like the extension (whose filters
	// are reset by the reload) the recording runs with default filters.
	restoreSettings(store, { filters: !replay });

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

	const isRecording = () =>
		store.profiler.isRecording.value || store.stats.isRecording.value;

	const handle = (type: string, data: unknown) => {
		applyEvent(store, type as any, data);
		// The hook only starts listening once a renderer attached, so filters
		// sent before that were dropped. Re-send them for every new renderer,
		// unless a recording is running: applying filters remounts all trees,
		// which would be recorded as commits.
		if (type === "attach" && !isRecording()) store.filter.submit();
	};

	const onMessage = (e: MessageEvent) => {
		if (isPageHookMessage(e, win)) handle(e.data.type, e.data.data);
	};
	win.addEventListener("message", onMessage);

	if (replay) {
		// The hook has been recording since the page started; replay
		// everything it sent, in order.
		if (replay.kind === "profile") {
			startProfiling(store.profiler);
			store.activePanel.value = Panel.PROFILER;
		} else {
			store.stats.isRecording.value = true;
			store.activePanel.value = Panel.STATISTICS;
		}
		for (const ev of replay.events) handle(ev.type, ev.data);
	} else {
		if (session) {
			// Overflowed: stop the hook's recording and fall back to a normal
			// connect, so the tree is still correct.
			send(session.kind === "profile" ? "stop-profiling" : "stop-stats-recording", null);
			console.warn(
				`[preact-devtools-overlay] "Reload and ${session.kind === "profile" ? "profile" : "record stats"}" was discarded: the app sent too many updates before the overlay opened. Start the recording again with the overlay open.`,
			);
		}
		// Replay renderer feature flags that were emitted before we mounted.
		for (const ev of client?.attachEvents ?? []) handle(ev.type, ev.data);
	}

	render(h(DevTools, { store, window: win }), container);

	// Mark the hook as connected. Outside of a replayed recording also ask
	// every renderer for its full tree (during one, a refresh would record a
	// bogus remount commit, and the replay already contains the tree).
	send("init", null);
	if (!replay) send("refresh", null);

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
