import { PageHookName } from "../vendor/preact-devtools/src/constants";
import type { AgentApi } from "./agent/api.js";
import type { SignalsStore } from "./agent/signals.js";
import type { SignalRegistry } from "./agent/registry.js";

/** Global set by `preact-devtools-overlay/client`. */
export const OVERLAY_GLOBAL = "__PREACT_DEVTOOLS_OVERLAY__";

/**
 * Read by `preact-devtools-overlay/client` when it installs. Must be set
 * before the client runs; the Vite plugin does that for you.
 */
export interface OverlayClientConfig {
	/**
	 * Expose the agent API (`__PREACT_DEVTOOLS_OVERLAY__.api`) and record
	 * renders for it. Defaults to `true`.
	 */
	agentApi?: boolean;
	/**
	 * URL of the dev server's open-in-editor endpoint
	 * (`?file=path:line:column`). The Vite plugin sets it to Vite's
	 * `__open-in-editor`; without it, "Open in editor" isn't offered.
	 */
	openInEditor?: string;
}

export interface OverlayClientState {
	/** Package version of the client that installed the hook. */
	version: string;
	/**
	 * `true` when `window.__PREACT_DEVTOOLS__` was already defined before our
	 * client ran (most likely by the Preact Devtools browser extension). In
	 * that case we reuse the existing hook instead of replacing it.
	 */
	reusedExistingHook: boolean;
	/**
	 * `attach` events the hook emitted before the overlay panel was mounted.
	 * The panel replays them on mount; the component tree itself is
	 * re-requested via a `refresh` message, so nothing else is buffered.
	 */
	attachEvents: Array<{ type: "attach"; data: unknown }>;
	/**
	 * Set when this page load was triggered by "Reload and profile" or
	 * "Reload and record stats". The extension's panel survives the reload and
	 * keeps listening; ours is reloaded with the page, so every hook message
	 * is buffered until the panel mounts and can replay the whole session.
	 * Cleared by the panel once consumed.
	 */
	reloadSession: {
		kind: "profile" | "stats";
		events: Array<{ type: string; data: unknown }>;
		/** `true` once the buffer cap was hit and events were dropped. */
		truncated: boolean;
	} | null;
	/**
	 * Options applied through `configureSignalsDebug()`. signals-debug never
	 * reports its config to the in-page Signals panel, which would otherwise
	 * show (and on "Apply", re-send) its hard-coded defaults.
	 */
	signalsDebugConfig?: { consoleLogging: boolean };
	/** Every signal/computed/effect created since `trackSignals()` (agent API). */
	registry?: SignalRegistry;
	/**
	 * History of `@preact/signals-debug` updates since page load. The Signals
	 * pane replays it when it connects.
	 */
	signals?: SignalsStore;
	/** The agent API, unless disabled with `agentApi: false`. */
	api?: AgentApi;
}

/** Upper bound for `reloadSession.events`, so a never-opened panel can't grow it forever. */
export const MAX_SESSION_EVENTS = 20_000;

declare global {
	interface Window {
		__PREACT_DEVTOOLS__?: any;
		__PREACT_DEVTOOLS_OVERLAY__?: OverlayClientState;
		__PREACT_DEVTOOLS_OVERLAY_CONFIG__?: OverlayClientConfig;
		__PREACT_SIGNALS_DEVTOOLS__?: unknown;
	}
}

export function isPageHookMessage(e: MessageEvent, win: Window): boolean {
	return (
		e.source === win &&
		e.data != null &&
		typeof e.data === "object" &&
		e.data.source === PageHookName
	);
}

/**
 * Must match `CONTAINER_RESIZE_EVENT` in the patched upstream
 * `view/components/utils.ts`. Duplicated so the always-loaded element chunk
 * doesn't pull in the devtools view code (asserted by a unit test).
 */
export const CONTAINER_RESIZE_EVENT = "preact-devtools:container-resize";
