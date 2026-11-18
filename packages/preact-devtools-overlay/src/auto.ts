/**
 * Side-effect entry: mounts the overlay once the DOM is ready.
 *
 *   import "preact-devtools-overlay/auto";
 */
import { mountOverlay } from "./index.js";

if (typeof document !== "undefined") {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", () => mountOverlay(), {
			once: true,
		});
	} else {
		mountOverlay();
	}
}
