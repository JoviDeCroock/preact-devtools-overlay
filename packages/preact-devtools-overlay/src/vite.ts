/**
 * Vite plugin that wires up both devtools for you:
 *
 *   import { preactDevtoolsOverlay } from "preact-devtools-overlay/vite";
 *   export default defineConfig({
 *     plugins: [preact(), preactDevtoolsOverlay()],
 *   });
 *
 * It injects a single module script at the very top of `<head>` which, in
 * order:
 *   1. installs the Preact devtools hook (`preact-devtools-overlay/client`),
 *   2. imports `preact/debug` so Preact attaches to that hook,
 *   3. imports `@preact/signals-debug` so signals are instrumented before the
 *      app creates any,
 *   4. lazily loads and mounts the `<preact-devtools-overlay>` element.
 *
 * Module scripts execute in document order, so all of this runs before the
 * app's own entry module.
 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export interface PreactDevtoolsOverlayOptions {
	/**
	 * When to inject the devtools. Defaults to `"serve"` (dev server only).
	 * Use `"build"` or `"always"` to also include them in production builds,
	 * e.g. for staging deployments.
	 */
	apply?: "serve" | "build" | "always";
	/** Import `preact/debug` for you. Defaults to `true`. */
	preactDebug?: boolean;
	/**
	 * Enable the Signals panel by importing `@preact/signals-debug`.
	 * `"auto"` (default) enables it when `@preact/signals` or
	 * `@preact/signals-core` can be resolved from the project root.
	 */
	signals?: boolean | "auto";
	/**
	 * `@preact/signals-debug` logs every signal update to the console by
	 * default. That is noisy next to a visual panel, so this defaults to
	 * `false`.
	 */
	signalsConsoleLogging?: boolean;
	/**
	 * Expose `window.__PREACT_DEVTOOLS_OVERLAY__.api` (component tree, render
	 * log with reasons, signals) for AI coding agents and scripts. Recording
	 * renders costs a little on every commit. Defaults to `true` on the dev
	 * server and `false` when the overlay is included in a build.
	 */
	agentApi?: boolean;
	/**
	 * Mount the overlay UI. Pass `false` to only install the hooks (e.g. to
	 * mount `<preact-devtools-overlay>` yourself), or an object to configure
	 * the initial state.
	 */
	overlay?:
		| boolean
		| {
				open?: boolean;
				tab?: "components" | "signals";
				position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
		  };
}

const ENTRY_URL = "/@preact-devtools-overlay/entry.js";
const ENTRY_ID = "\0preact-devtools-overlay:entry";
const CONFIG_URL = "/@preact-devtools-overlay/config.js";
const CONFIG_ID = "\0preact-devtools-overlay:config";

const distDir = path.dirname(fileURLToPath(import.meta.url));
const clientFile = path.join(distDir, "client.js");
const overlayFile = path.join(distDir, "index.js");
const toPosix = (p: string) => p.split(path.sep).join("/");

/** Node-style lookup of `node_modules/<name>` from `dir` upwards. */
function hasPackage(dir: string, name: string): boolean {
	let current = path.resolve(dir);
	while (true) {
		if (fs.existsSync(path.join(current, "node_modules", name, "package.json"))) {
			return true;
		}
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

export function preactDevtoolsOverlay(
	options: PreactDevtoolsOverlayOptions = {},
): Plugin {
	const {
		apply = "serve",
		preactDebug = true,
		signals = "auto",
		signalsConsoleLogging = false,
		overlay = true,
	} = options;

	let enableSignals = signals === true;
	let agentApi = options.agentApi ?? true;

	return {
		name: "preact-devtools-overlay",
		apply:
			apply === "always"
				? undefined
				: (_, env) => env.command === apply,

		config(userConfig, env) {
			agentApi = options.agentApi ?? env.command === "serve";
			if (signals === "auto") {
				const root = path.resolve(userConfig.root ?? process.cwd());
				enableSignals =
					hasPackage(root, "@preact/signals") ||
					hasPackage(root, "@preact/signals-core");
			}
			return {
				optimizeDeps: {
					// Pre-bundle these together with the app's dependencies so they
					// share the app's `preact` / `@preact/signals-core` instances.
					include: [
						...(preactDebug ? ["preact/debug"] : []),
						...(enableSignals
							? ["preact-devtools-overlay > @preact/signals-debug"]
							: []),
					],
					// Already bundled, self-contained ESM.
					exclude: ["preact-devtools-overlay"],
				},
			};
		},

		resolveId(id) {
			if (id === ENTRY_URL) return ENTRY_ID;
			if (id === CONFIG_URL) return CONFIG_ID;
		},

		async load(id) {
			if (id === CONFIG_ID) {
				// Its own module: imports are evaluated in order, so this runs
				// before the client reads the config.
				return `window.__PREACT_DEVTOOLS_OVERLAY_CONFIG__ = ${JSON.stringify({ agentApi })};\n`;
			}
			if (id !== ENTRY_ID) return;

			const lines = [
				`import ${JSON.stringify(CONFIG_URL)};`,
				`import ${JSON.stringify(toPosix(clientFile))};`,
			];
			if (preactDebug) lines.push(`import "preact/debug";`);

			if (enableSignals) {
				// Resolved from this package, which depends on it. Its own
				// `@preact/signals-core` import is a peer dependency, so it binds to
				// the app's copy.
				const debug = await this.resolve(
					"@preact/signals-debug",
					path.join(distDir, "vite.js"),
					{ skipSelf: true },
				);
				if (!debug) {
					this.warn(
						"Could not resolve @preact/signals-debug, the Signals panel will be empty.",
					);
				} else {
					lines.push(
						`import { setDebugOptions } from ${JSON.stringify(debug.id)};`,
						`import { configureSignalsDebug } from ${JSON.stringify(toPosix(clientFile))};`,
						`configureSignalsDebug(setDebugOptions, { consoleLogging: ${!!signalsConsoleLogging} });`,
					);
				}
			}

			if (overlay !== false) {
				const mountOptions = typeof overlay === "object" ? overlay : {};
				lines.push(
					// Loaded lazily so the overlay never delays the app's own startup.
					`import(${JSON.stringify(toPosix(overlayFile))}).then(m => m.mountOverlay(${JSON.stringify(mountOptions)}));`,
				);
			}

			return lines.join("\n") + "\n";
		},

		transformIndexHtml: {
			order: "pre",
			handler() {
				return [
					{
						tag: "script",
						attrs: { type: "module", src: ENTRY_URL },
						injectTo: "head-prepend",
					},
				];
			},
		},
	};
}

export default preactDevtoolsOverlay;
