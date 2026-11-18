import { describe, expect, it } from "vitest";
import path from "node:path";
import { preactDevtoolsOverlay, type PreactDevtoolsOverlayOptions } from "../src/vite";

const ENTRY_URL = "/@preact-devtools-overlay/entry.js";

const CONFIG_URL = "/@preact-devtools-overlay/config.js";

async function entryFor(
	options: PreactDevtoolsOverlayOptions = {},
	root = process.cwd(),
	command: "serve" | "build" = "serve",
) {
	const plugin = preactDevtoolsOverlay(options) as any;
	const config = plugin.config({ root }, { command, mode: "development" });
	const ctx = {
		resolve: async (id: string) =>
			id === "@preact/signals-debug" ? { id: "/abs/signals-debug.mjs" } : null,
		warn() {},
	};
	const id = plugin.resolveId(ENTRY_URL);
	const code: string = await plugin.load.call(ctx, id);
	return { plugin, config, code };
}

describe("preactDevtoolsOverlay()", () => {
	it("only applies to the dev server by default", () => {
		const plugin = preactDevtoolsOverlay() as any;
		expect(plugin.apply({}, { command: "serve" })).toBe(true);
		expect(plugin.apply({}, { command: "build" })).toBe(false);
		expect((preactDevtoolsOverlay({ apply: "build" }) as any).apply({}, { command: "build" })).toBe(true);
		expect((preactDevtoolsOverlay({ apply: "always" }) as any).apply).toBeUndefined();
	});

	it("prepends a single module script to <head>", () => {
		const plugin = preactDevtoolsOverlay() as any;
		expect(plugin.transformIndexHtml.order).toBe("pre");
		expect(plugin.transformIndexHtml.handler()).toEqual([
			{ tag: "script", attrs: { type: "module", src: ENTRY_URL }, injectTo: "head-prepend" },
		]);
	});

	it("installs the hook before preact/debug and signals-debug", async () => {
		const { code } = await entryFor({ signals: true });
		const client = code.indexOf("client.js");
		const debug = code.indexOf(`"preact/debug"`);
		const signals = code.indexOf("/abs/signals-debug.mjs");
		expect(client).toBeGreaterThan(-1);
		expect(debug).toBeGreaterThan(client);
		expect(signals).toBeGreaterThan(debug);
		// Both the live options and signals-debug's devtools copy of them.
		expect(code).toContain("configureSignalsDebug(setDebugOptions, { consoleLogging: false })");
		expect(code).toMatch(/import\(".*index\.js"\)\.then\(m => m\.mountOverlay\(\{\}\)\)/);
	});

	it("can keep signals console logging on", async () => {
		const { code } = await entryFor({ signals: true, signalsConsoleLogging: true });
		expect(code).toContain("{ consoleLogging: true }");
	});

	it("respects opt-outs", async () => {
		const { code, config } = await entryFor({
			preactDebug: false,
			signals: false,
			overlay: false,
		});
		expect(code).not.toContain("preact/debug");
		expect(code).not.toContain("signals-debug");
		expect(code).not.toContain("mountOverlay");
		expect(config.optimizeDeps.include).toEqual([]);
	});

	it("passes overlay options through", async () => {
		const { code } = await entryFor({
			signals: false,
			overlay: { open: true, tab: "signals" },
		});
		expect(code).toContain(`mountOverlay({"open":true,"tab":"signals"})`);
	});

	it("configures the agent API before the client loads", async () => {
		const { code, plugin } = await entryFor({ signals: false });
		expect(code.indexOf(CONFIG_URL)).toBeGreaterThan(-1);
		expect(code.indexOf(CONFIG_URL)).toBeLessThan(code.indexOf("client.js"));
		const config = await plugin.load(plugin.resolveId(CONFIG_URL));
		expect(config).toBe(`window.__PREACT_DEVTOOLS_OVERLAY_CONFIG__ = {"agentApi":true};\n`);
	});

	it("turns the agent API off in builds unless asked for", async () => {
		const configFor = async (options: PreactDevtoolsOverlayOptions, command: "serve" | "build") => {
			const { plugin } = await entryFor({ signals: false, ...options }, process.cwd(), command);
			return plugin.load(plugin.resolveId(CONFIG_URL));
		};
		expect(await configFor({ apply: "always" }, "build")).toContain(`"agentApi":false`);
		expect(await configFor({ apply: "always", agentApi: true }, "build")).toContain(`"agentApi":true`);
		expect(await configFor({ agentApi: false }, "serve")).toContain(`"agentApi":false`);
	});

	it("points the client at Vite's open-in-editor endpoint on the dev server", async () => {
		const configFor = async (command: "serve" | "build", base: string) => {
			const { plugin } = await entryFor({ signals: false, apply: "always" }, process.cwd(), command);
			plugin.configResolved({ command, base });
			return plugin.load(plugin.resolveId(CONFIG_URL));
		};
		expect(await configFor("serve", "/app/")).toContain(`"openInEditor":"/app/__open-in-editor"`);
		expect(await configFor("serve", "/")).toContain(`"openInEditor":"/__open-in-editor"`);
		expect(await configFor("serve", "./")).toContain(`"openInEditor":"/__open-in-editor"`);
		expect(await configFor("build", "/")).not.toContain("openInEditor");
	});

	it("tracks signal construction with the app's signals package", async () => {
		const withSignals = path.resolve(import.meta.dirname, "../../../playground");
		const { code, config } = await entryFor({}, withSignals);
		expect(code).toContain(
			`import { Signal as __pdoSignal, effect as __pdoEffect, computed as __pdoComputed } from "@preact/signals";`,
		);
		expect(code.indexOf("trackSignals(")).toBeGreaterThan(code.indexOf("configureSignalsDebug("));
		expect(config.optimizeDeps.include).toContain("@preact/signals");
		const { code: off } = await entryFor({ agentApi: false }, withSignals);
		expect(off).not.toContain("trackSignals");
	});

	it("supports compact signals console logging", async () => {
		const { code } = await entryFor({ signals: true, signalsConsoleLogging: "compact" });
		expect(code).toContain(`{ consoleLogging: "compact" }`);
	});

	it("skips the overlay UI with ?devtools=off", async () => {
		const { code } = await entryFor({ signals: false });
		expect(code).toMatch(/if \(!\/\[\?&\]devtools=off\(&\|\$\)\/\.test\(location\.search\)\) import\(/);
	});

	it("auto-detects signals from the project root", async () => {
		const withSignals = path.resolve(import.meta.dirname, "../../../playground");
		const { code, config } = await entryFor({}, withSignals);
		expect(code).toContain("signals-debug");
		expect(config.optimizeDeps.include).toContain(
			"preact-devtools-overlay > @preact/signals-debug",
		);

		const { code: none } = await entryFor({}, "/");
		expect(none).not.toContain("signals-debug");
	});
});
