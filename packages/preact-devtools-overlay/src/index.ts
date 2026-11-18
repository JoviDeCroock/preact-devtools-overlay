export {
	PreactDevtoolsOverlay,
	defineOverlayElement,
	type OverlayTab,
	type OverlayPosition,
} from "./element.js";
import {
	defineOverlayElement,
	type OverlayPosition,
	type OverlayTab,
	type PreactDevtoolsOverlay,
} from "./element.js";

export interface MountOverlayOptions {
	/** Open the drawer immediately. Defaults to the last persisted state. */
	open?: boolean;
	/** Initially selected tab. Defaults to the last persisted tab. */
	tab?: OverlayTab;
	/** Corner for the launcher button. Defaults to `"bottom-right"`. */
	position?: OverlayPosition;
	/** Element to append the overlay to. Defaults to `document.body`. */
	parent?: Element;
	/** Custom element tag name. Defaults to `"preact-devtools-overlay"`. */
	tagName?: string;
}

/**
 * Registers the custom element (if needed) and appends a single overlay
 * instance to the page. Calling it again returns the existing instance.
 *
 * Note that the page must also load `preact-devtools-overlay/client` (before
 * Preact) for the Components panel to receive any data, and
 * `@preact/signals-debug` (before any signal is created) for the Signals
 * panel. The Vite plugin (`preact-devtools-overlay/vite`) does both for you.
 */
export function mountOverlay(
	options: MountOverlayOptions = {},
): PreactDevtoolsOverlay {
	const tagName = options.tagName ?? "preact-devtools-overlay";
	defineOverlayElement(tagName);

	let el = document.querySelector(tagName) as PreactDevtoolsOverlay | null;
	if (!el) {
		el = document.createElement(tagName) as PreactDevtoolsOverlay;
		if (options.tab) el.setAttribute("tab", options.tab);
		if (options.position) el.setAttribute("position", options.position);
		if (options.open !== undefined) el.open = options.open;
		(options.parent ?? document.body).appendChild(el);
	}
	return el;
}
