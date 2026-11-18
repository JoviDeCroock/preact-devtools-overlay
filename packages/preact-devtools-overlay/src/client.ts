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
import { createStyleElement } from "./styles-registry";
import { isPageHookMessage, type OverlayClientState } from "./shared";

declare const __PDO_VERSION__: string;

function install() {
	if (window.__PREACT_DEVTOOLS_OVERLAY__) return;

	const state: OverlayClientState = {
		version: __PDO_VERSION__,
		reusedExistingHook: !!window.__PREACT_DEVTOOLS__,
		attachEvents: [],
	};
	window.__PREACT_DEVTOOLS_OVERLAY__ = state;

	// Buffer `attach` events until a panel is mounted. They carry the
	// renderer's feature flags (profiling, hooks, render reasons) and are only
	// sent once per renderer, so a late-mounted panel would otherwise never
	// see them.
	window.addEventListener("message", e => {
		if (isPageHookMessage(e, window) && e.data.type === "attach") {
			state.attachEvents.push({ type: "attach", data: e.data.data });
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

export {};
