/**
 * Page-side hook. Must be evaluated before Preact's `preact/devtools` (or
 * `preact/debug`) module, because that module looks for
 * `window.__PREACT_DEVTOOLS__` once, at import time.
 *
 *   import "preact-devtools-overlay/client"; // first import of your app
 *   import "preact/debug";
 *
 * This is the in-page equivalent of the browser extension's `installHook`
 * content script, using the exact same adapter code.
 */
import { createHook } from "../vendor/preact-devtools/src/adapter/hook";
import { createPortForHook } from "../vendor/preact-devtools/src/adapter/adapter/port";
import {
	PROFILE_RELOAD,
	STATS_RELOAD,
} from "../vendor/preact-devtools/src/constants";
import { createStyleElement } from "./styles-registry.js";
import {
	isPageHookMessage,
	MAX_SESSION_EVENTS,
	type OverlayClientState,
} from "./shared.js";

declare const __PDO_VERSION__: string;

function install() {
	if (window.__PREACT_DEVTOOLS_OVERLAY__) return;

	const state: OverlayClientState = {
		version: __PDO_VERSION__,
		reusedExistingHook: !!window.__PREACT_DEVTOOLS__,
		attachEvents: [],
		reloadSession: null,
	};
	window.__PREACT_DEVTOOLS_OVERLAY__ = state;

	// Must be read before the hook consumes (and removes) these flags when
	// the first renderer attaches.
	try {
		if (localStorage.getItem(PROFILE_RELOAD) !== null) {
			state.reloadSession = { kind: "profile", events: [], truncated: false };
		} else if (localStorage.getItem(STATS_RELOAD) !== null) {
			state.reloadSession = { kind: "stats", events: [], truncated: false };
		}
	} catch {
		// Storage disabled: the hook can't read the flags either.
	}

	window.addEventListener("message", e => {
		if (!isPageHookMessage(e, window)) return;
		const { type, data } = e.data;
		// `attach` carries the renderer's feature flags (profiling, hooks,
		// render reasons) and is sent only once per renderer, so a panel that
		// mounts later would otherwise never see it.
		if (type === "attach") state.attachEvents.push({ type, data });

		const session = state.reloadSession;
		if (session) {
			if (session.events.length < MAX_SESSION_EVENTS) {
				session.events.push({ type, data });
			} else {
				session.truncated = true;
			}
		}
	});

	if (!state.reusedExistingHook) {
		window.__PREACT_DEVTOOLS__ = createHook(createPortForHook(window));
	}

	// Styles for the element highlighter / render-update canvas, which are
	// rendered into the page itself (outside of the overlay's shadow root).
	const style = createStyleElement(document, "preact");
	(document.head || document.documentElement).appendChild(style);
}

if (typeof window !== "undefined") {
	install();
}

/**
 * Applies options to `@preact/signals-debug`. Pass its `setDebugOptions`:
 *
 *   import { setDebugOptions } from "@preact/signals-debug";
 *   configureSignalsDebug(setDebugOptions, { consoleLogging: false });
 *
 * Calling `setDebugOptions` alone isn't enough: signals-debug keeps a second
 * copy of its config for devtools, which it reports to the Signals panel and
 * re-applies whenever settings change there. That copy is only updated
 * through a `CONFIGURE_DEBUG` message.
 */
export function configureSignalsDebug(
	setDebugOptions: (options: { consoleLogging?: boolean }) => void,
	options: { consoleLogging?: boolean } = {},
) {
	const config = { consoleLogging: options.consoleLogging ?? false };
	// Synchronously, so it applies to signals created right after this call.
	setDebugOptions(config);
	if (typeof window !== "undefined") {
		if (window.__PREACT_DEVTOOLS_OVERLAY__) {
			window.__PREACT_DEVTOOLS_OVERLAY__.signalsDebugConfig = config;
		}
		window.postMessage(
			{ type: "CONFIGURE_DEBUG", payload: config },
			window.location.origin,
		);
	}
}
