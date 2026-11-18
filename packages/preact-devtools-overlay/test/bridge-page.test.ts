// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENTS } from "../src/bridge/protocol";

async function load() {
	vi.resetModules();
	return import("../src/bridge/page");
}

function fakeApi(overrides: Record<string, unknown> = {}) {
	window.__PREACT_DEVTOOLS_OVERLAY__ = {
		api: {
			getTree: (opts: unknown) => ({ tree: opts }),
			inspect: () => {
				throw new Error('No component found for "Nope"');
			},
			update: vi.fn(() => true),
			status: () => {
				const a: any = {};
				a.self = a;
				return a;
			},
			...overrides,
		},
	} as any;
}

afterEach(() => {
	delete window.__PREACT_DEVTOOLS_OVERLAY__;
});

describe("bridge page side", () => {
	it("calls the agent API and reports the tab state", async () => {
		const { handleRequest } = await load();
		fakeApi();
		document.title = "Playground";
		const res = await handleRequest({ id: 1, method: "getTree", args: [{ format: "text" }] });
		expect(res).toEqual({
			id: 1,
			ok: true,
			result: { tree: { format: "text" } },
			state: expect.objectContaining({ url: location.href, title: "Playground", top: true }),
		});
	});

	it("returns errors instead of throwing", async () => {
		const { handleRequest } = await load();
		fakeApi();
		expect(await handleRequest({ id: 2, method: "inspect", args: ["Nope"] })).toMatchObject({
			ok: false,
			code: "error",
			error: 'No component found for "Nope"',
		});
		expect(await handleRequest({ id: 3, method: "status", args: [] })).toMatchObject({
			ok: false,
			code: "not-serializable",
		});
	});

	it("refuses methods outside the whitelist and update() unless allowed", async () => {
		const { handleRequest } = await load();
		const evil = vi.fn();
		fakeApi({ constructor: evil });
		for (const method of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
			expect(await handleRequest({ id: 4, method: method as any, args: [] })).toMatchObject({
				ok: false,
				code: "unknown-method",
			});
		}
		expect(await handleRequest({ id: 5, method: "update", args: ["Counter", "hook", 0, 1] })).toMatchObject({
			ok: false,
			code: "not-allowed",
		});
		const api = window.__PREACT_DEVTOOLS_OVERLAY__!.api as any;
		expect(api.update).not.toHaveBeenCalled();
		expect(
			await handleRequest({ id: 6, method: "update", args: ["Counter", "hook", 0, 1] }, { allowUpdate: true }),
		).toMatchObject({ ok: true, result: true });
		expect(api.update).toHaveBeenCalledWith("Counter", "hook", 0, 1);
	});

	it("explains a missing or disabled agent API", async () => {
		const { handleRequest } = await load();
		expect(await handleRequest({ id: 7, method: "getTree", args: [] })).toMatchObject({
			ok: false,
			code: "no-api",
			error: expect.stringContaining("not loaded"),
		});
		window.__PREACT_DEVTOOLS_OVERLAY__ = {} as any;
		expect(await handleRequest({ id: 8, method: "getTree", args: [] })).toMatchObject({
			ok: false,
			code: "no-api",
			error: expect.stringContaining("agentApi: false"),
		});
	});

	it("says hello over the HMR channel and answers requests", async () => {
		const { connectBridge } = await load();
		fakeApi();
		const listeners = new Map<string, (data: any) => void>();
		const sent: Array<[string, any]> = [];
		const hot = {
			send: (event: string, data: unknown) => sent.push([event, data]),
			on: (event: string, cb: (data: any) => void) => listeners.set(event, cb),
		};
		connectBridge(hot);
		expect(sent).toEqual([[EVENTS.hello, expect.objectContaining({ url: location.href })]]);

		listeners.get(EVENTS.request)!({ id: 9, method: "getTree", args: [] });
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]).toEqual([EVENTS.response, expect.objectContaining({ id: 9, ok: true, result: {} })]);

		// Reconnects say hello again; state changes are reported once.
		listeners.get("vite:ws:connect")!(undefined);
		expect(sent.at(-1)![0]).toBe(EVENTS.hello);
		document.title = "Changed";
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("focus"));
		expect(sent.filter(([e]) => e === EVENTS.state)).toEqual([
			[EVENTS.state, expect.objectContaining({ title: "Changed" })],
		]);
	});
});
