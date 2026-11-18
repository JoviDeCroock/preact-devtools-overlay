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
 *   4. on the dev server, connects the agent bridge (see `bridge/server.ts`),
 *   5. lazily loads and mounts the `<preact-devtools-overlay>` element.
 *
 * Module scripts execute in document order, so all of this runs before the
 * app's own entry module.
 */
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { setupAgentBridge, type AgentBridgeOptions } from "./bridge/server.js";
import { HOOK_NAMES_FILE, transformHookNames } from "./hook-names.js";

declare const __PDO_VERSION__: string;

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
	 * Name `useState`, `useReducer`, `useRef` and `useMemo` hooks after the
	 * variable they're assigned to (`const [count] = useState(0)` → `count`),
	 * in the Hooks panel and in render reasons. The same transform
	 * @preact/preset-vite applies with `devToolsEnabled`. Applies to the
	 * app's own files, not `node_modules`. Defaults to `true`.
	 */
	hookNames?: boolean;
	/**
	 * Enable the Signals panel by importing `@preact/signals-debug`.
	 * `"auto"` (default) enables it when `@preact/signals` or
	 * `@preact/signals-core` can be resolved from the project root.
	 */
	signals?: boolean | "auto";
	/**
	 * `@preact/signals-debug` logs every signal update to the console by
	 * default. That is noisy next to a visual panel, so this defaults to
	 * `false`. `"compact"` logs one plain line per update instead
	 * (`[signals] signal count: 0 → 1`), which reads well in captured console
	 * output (Playwright, CDP, agents).
	 */
	signalsConsoleLogging?: boolean | "compact";
	/**
	 * Expose `window.__PREACT_DEVTOOLS_OVERLAY__.api` (component tree, render
	 * log with reasons, signals) for AI coding agents and scripts. Recording
	 * renders costs a little on every commit. Defaults to `true` on the dev
	 * server and `false` when the overlay is included in a build.
	 */
	agentApi?: boolean;
	/**
	 * Relay agent API calls from the dev server to an open tab, for agents
	 * that can't drive a browser (see the `preact-devtools-overlay-mcp` MCP
	 * server). Adds `POST /__preact-devtools-overlay/api` and
	 * `GET /__preact-devtools-overlay/tabs`. Both need the token the dev
	 * server writes to the user's cache directory
	 * (`~/.cache/preact-devtools-overlay/`) and only accept requests from
	 * this machine. Dev server only. Defaults to `true` when `agentApi` is on.
	 */
	agentBridge?: boolean | AgentBridgeOptions;
	/**
	 * Mount the overlay UI. Pass `false` to only install the hooks (e.g. to
	 * mount `<preact-devtools-overlay>` yourself), or an object to configure
	 * the initial state. Adding `?devtools=off` to the page URL also skips
	 * the UI for that page load.
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
const bridgeFile = path.join(distDir, "bridge-client.js");
const VERSION = typeof __PDO_VERSION__ === "string" ? __PDO_VERSION__ : "0.0.0";
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
): Plugin[] {
	const {
		apply = "serve",
		preactDebug = true,
		signals = "auto",
		signalsConsoleLogging = false,
		overlay = true,
		hookNames = true,
	} = options;

	let enableSignals = signals === true;
	// The package the app gets `Signal` from, for `trackSignals()`.
	let signalsPackage: string | null = null;
	let agentApi = options.agentApi ?? true;
	// Vite's own endpoint (its error overlay uses it), under `base`.
	let openInEditor: string | null = null;
	let serve = false;
	const bridgeOptions: AgentBridgeOptions | null =
		options.agentBridge === false
			? null
			: typeof options.agentBridge === "object"
				? options.agentBridge
				: {};
	const bridgeEnabled = () => serve && agentApi && bridgeOptions !== null;

	const applies: Plugin["apply"] =
		apply === "always" ? undefined : (_, env) => env.command === apply;

	const main: Plugin = {
		name: "preact-devtools-overlay",
		apply: applies,

		config(userConfig, env) {
			serve = env.command === "serve";
			agentApi = options.agentApi ?? serve;
			if (signals === "auto") {
				const root = path.resolve(userConfig.root ?? process.cwd());
				enableSignals =
					hasPackage(root, "@preact/signals") ||
					hasPackage(root, "@preact/signals-core");
			}
			signalsPackage = null;
			if (enableSignals && agentApi) {
				const root = path.resolve(userConfig.root ?? process.cwd());
				// Prefer the core (no Preact options hooks of its own); either
				// exports the same `Signal` the app uses.
				signalsPackage = hasPackage(root, "@preact/signals-core")
					? "@preact/signals-core"
					: hasPackage(root, "@preact/signals")
						? "@preact/signals"
						: null;
			}
			return {
				optimizeDeps: {
					// Pre-bundle these together with the app's dependencies so they
					// share the app's `preact` / `@preact/signals-core` instances.
					include: [
						...(preactDebug ? ["preact/debug"] : []),
						...(hookNames ? ["preact/devtools"] : []),
						...(enableSignals
							? ["preact-devtools-overlay > @preact/signals-debug"]
							: []),
						...(signalsPackage ? [signalsPackage] : []),
					],
					// Already bundled, self-contained ESM.
					exclude: ["preact-devtools-overlay"],
				},
			};
		},

		configResolved(config) {
			const base = /^\//.test(config.base) ? config.base : "/";
			openInEditor = config.command === "serve" ? `${base.replace(/\/?$/, "/")}__open-in-editor` : null;
		},

		configureServer(server) {
			if (!bridgeEnabled()) return;
			setupAgentBridge(server, { ...bridgeOptions, version: VERSION });
		},

		resolveId(id) {
			if (id === ENTRY_URL) return ENTRY_ID;
			if (id === CONFIG_URL) return CONFIG_ID;
		},

		async load(id) {
			if (id === CONFIG_ID) {
				// Its own module: imports are evaluated in order, so this runs
				// before the client reads the config.
				const config = { agentApi, ...(openInEditor ? { openInEditor } : {}) };
				return `window.__PREACT_DEVTOOLS_OVERLAY_CONFIG__ = ${JSON.stringify(config)};\n`;
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
						`configureSignalsDebug(setDebugOptions, { consoleLogging: ${JSON.stringify(signalsConsoleLogging === "compact" ? "compact" : !!signalsConsoleLogging)} });`,
					);
					if (signalsPackage) {
						// Before the app creates any signals: the full inventory and
						// the leak checks of the agent API.
						lines.push(
							`import { Signal as __pdoSignal, effect as __pdoEffect, computed as __pdoComputed } from ${JSON.stringify(signalsPackage)};`,
							`import { trackSignals } from ${JSON.stringify(toPosix(clientFile))};`,
							`trackSignals(__pdoSignal, __pdoEffect, __pdoComputed);`,
						);
					}
				}
			}

			if (bridgeEnabled()) {
				// Only Vite-served modules get `import.meta.hot`, so the page side
				// of the bridge is connected from here.
				lines.push(
					`import { connectBridge } from ${JSON.stringify(toPosix(bridgeFile))};`,
					`if (import.meta.hot) connectBridge(import.meta.hot, ${JSON.stringify({ allowUpdate: !!bridgeOptions?.allowUpdate })});`,
				);
			}

			if (overlay !== false) {
				const mountOptions = typeof overlay === "object" ? overlay : {};
				lines.push(
					// Loaded lazily so the overlay never delays the app's own startup.
					`if (!/[?&]devtools=off(&|$)/.test(location.search)) import(${JSON.stringify(toPosix(overlayFile))}).then(m => m.mountOverlay(${JSON.stringify(mountOptions)}));`,
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

	if (!hookNames) return [main];

	const names: Plugin = {
		name: "preact-devtools-overlay:hook-names",
		apply: applies,
		// A plugin of its own for the order: after Vite compiled TypeScript and
		// JSX away and after prefresh, whose HMR signatures read
		// `const [a] = useState()` (a wrapped call would lose its `a`). Before
		// Vite's import analysis, which only runs after `enforce: "post"`
		// plugins, so the injected `preact/devtools` import still gets resolved.
		enforce: "post",
		transform(code, id) {
			if (id.startsWith("\0") || id.includes("/node_modules/")) return;
			if (!HOOK_NAMES_FILE.test(id.replace(/[?#].*$/, ""))) return;
			return transformHookNames(code, source => this.parse(source)) ?? undefined;
		},
	};
	return [main, names];
}

export default preactDevtoolsOverlay;
