import { describe, expect, it } from "vitest";
import path from "node:path";
import { preactDevtoolsOverlay, type PreactDevtoolsOverlayOptions } from "../src/vite";

const ENTRY_URL = "/@preact-devtools-overlay/entry.js";

async function entryFor(options: PreactDevtoolsOverlayOptions = {}, root = process.cwd()) {
	const plugin = preactDevtoolsOverlay(options) as any;
	const config = plugin.config({ root }, { command: "serve", mode: "development" });
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
		expect(code).toContain("setDebugOptions({ consoleLogging: false })");
		expect(code).toMatch(/import\(".*index\.js"\)\.then\(m => m\.mountOverlay\(\{\}\)\)/);
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
