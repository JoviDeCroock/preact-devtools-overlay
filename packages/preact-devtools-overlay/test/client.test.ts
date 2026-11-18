// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILE_RELOAD, STATS_RELOAD, PageHookName } from "../vendor/preact-devtools/src/constants";
import { MAX_SESSION_EVENTS } from "../src/shared";

async function loadClient() {
	vi.resetModules();
	return import("../src/client");
}

/** jsdom's postMessage doesn't set `event.source`, so dispatch directly. */
function hookMessage(type: string, data: unknown = null) {
	window.dispatchEvent(
		new MessageEvent("message", { source: window, data: { source: PageHookName, type, data } }),
	);
}

describe("preact-devtools-overlay/client", () => {
	beforeEach(() => {
		localStorage.clear();
		delete window.__PREACT_DEVTOOLS__;
		delete window.__PREACT_DEVTOOLS_OVERLAY__;
	});
	afterEach(() => {
		delete window.__PREACT_DEVTOOLS__;
		delete window.__PREACT_DEVTOOLS_OVERLAY__;
	});

	it("exposes the agent API unless disabled", async () => {
		await loadClient();
		expect(typeof window.__PREACT_DEVTOOLS_OVERLAY__!.api!.getTree).toBe("function");
		delete window.__PREACT_DEVTOOLS__;
		delete window.__PREACT_DEVTOOLS_OVERLAY__;
		window.__PREACT_DEVTOOLS_OVERLAY_CONFIG__ = { agentApi: false };
		try {
			await loadClient();
			expect(window.__PREACT_DEVTOOLS_OVERLAY__!.api).toBeUndefined();
		} finally {
			delete window.__PREACT_DEVTOOLS_OVERLAY_CONFIG__;
		}
	});

	it("installs the hook and buffers attach events", async () => {
		await loadClient();
		expect(typeof window.__PREACT_DEVTOOLS__.attachPreact).toBe("function");
		const state = window.__PREACT_DEVTOOLS_OVERLAY__!;
		expect(state.reusedExistingHook).toBe(false);
		expect(state.reloadSession).toBeNull();
		hookMessage("attach", { id: 1 });
		hookMessage("operation_v2", [1]);
		expect(state.attachEvents).toEqual([{ type: "attach", data: { id: 1 } }]);
	});

	it("starts a replayable session for reload-and-profile", async () => {
		localStorage.setItem(PROFILE_RELOAD, "{}");
		await loadClient();
		const session = window.__PREACT_DEVTOOLS_OVERLAY__!.reloadSession!;
		expect(session.kind).toBe("profile");
		hookMessage("attach", { id: 1 });
		hookMessage("operation_v2", [1]);
		expect(session.events.map(e => e.type)).toEqual(["attach", "operation_v2"]);
	});

	it("caps the session buffer and marks it truncated", async () => {
		localStorage.setItem(STATS_RELOAD, "true");
		await loadClient();
		const session = window.__PREACT_DEVTOOLS_OVERLAY__!.reloadSession!;
		expect(session.kind).toBe("stats");
		for (let i = 0; i < MAX_SESSION_EVENTS + 5; i++) hookMessage("operation_v2", i);
		expect(session.events).toHaveLength(MAX_SESSION_EVENTS);
		expect(session.truncated).toBe(true);
	});

	it("leaves an existing hook (e.g. the extension's) and its reload flags alone", async () => {
		const existing = { attachPreact() {} };
		window.__PREACT_DEVTOOLS__ = existing;
		localStorage.setItem(PROFILE_RELOAD, "{}");
		await loadClient();
		expect(window.__PREACT_DEVTOOLS__).toBe(existing);
		const state = window.__PREACT_DEVTOOLS_OVERLAY__!;
		expect(state.reusedExistingHook).toBe(true);
		expect(state.reloadSession).toBeNull();
		expect(localStorage.getItem(PROFILE_RELOAD)).toBe("{}");
	});

	it("configureSignalsDebug updates both configs and records them", async () => {
		const { configureSignalsDebug } = await loadClient();
		const posted: unknown[] = [];
		const spy = vi.spyOn(window, "postMessage").mockImplementation((m: unknown) => {
			posted.push(m);
		});
		const setDebugOptions = vi.fn();
		configureSignalsDebug(setDebugOptions);
		spy.mockRestore();
		expect(setDebugOptions).toHaveBeenCalledWith({ consoleLogging: false });
		expect(posted).toEqual([{ type: "CONFIGURE_DEBUG", payload: { consoleLogging: false } }]);
		expect(window.__PREACT_DEVTOOLS_OVERLAY__!.signalsDebugConfig).toEqual({ consoleLogging: false });
	});
});
