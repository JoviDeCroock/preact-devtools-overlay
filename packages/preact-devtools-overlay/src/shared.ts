import { PageHookName } from "../vendor/preact-devtools/src/constants";

/** Global set by `preact-devtools-overlay/client`. */
export const OVERLAY_GLOBAL = "__PREACT_DEVTOOLS_OVERLAY__";

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
}

declare global {
	interface Window {
		__PREACT_DEVTOOLS__?: any;
		__PREACT_DEVTOOLS_OVERLAY__?: OverlayClientState;
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
