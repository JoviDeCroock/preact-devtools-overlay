import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { preactDevtoolsOverlay } from "preact-devtools-overlay/vite";

export default defineConfig({
	plugins: [
		// preset-vite would otherwise inject `preact/debug` itself.
		preact({ devToolsEnabled: false }),
		preactDevtoolsOverlay(),
	],
});
