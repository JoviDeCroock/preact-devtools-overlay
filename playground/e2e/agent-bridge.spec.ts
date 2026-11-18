import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

// The dev-server bridge and the MCP server, for agents without a browser.
// Tests run in parallel against one dev server, so every test opens its
// page with a unique query string and targets that tab by URL.

const playground = path.resolve(import.meta.dirname, "..");
const serverJson = path.join(playground, "node_modules/.cache/preact-devtools-overlay/server.json");
const mcpBin = path.resolve(playground, "../packages/preact-devtools-overlay/dist/mcp-cli.js");

function serverInfo(): { url: string; token: string } {
	return JSON.parse(fs.readFileSync(serverJson, "utf8"));
}

async function openTab(page: Page, testId: string) {
	const marker = `bridge=${testId}-${Math.random().toString(36).slice(2)}`;
	await page.goto(`/?${marker}`);
	await expect(page.getByTestId("counter")).toBeVisible();
	await page.waitForFunction(() => !!window.__PREACT_DEVTOOLS_OVERLAY__?.api);
	return marker;
}

async function callApi(
	request: APIRequestContext,
	body: { method: string; args?: unknown[]; tab?: string },
	token = serverInfo().token,
) {
	const res = await request.post(`${serverInfo().url}/__preact-devtools-overlay/api`, {
		headers: { authorization: `Bearer ${token}` },
		data: body,
	});
	return { status: res.status(), body: await res.json() };
}

/** The tab registers over the HMR socket, which may connect after the app rendered. */
async function waitForTab(request: APIRequestContext, marker: string) {
	await expect
		.poll(async () => {
			const res = await request.get(`${serverInfo().url}/__preact-devtools-overlay/tabs`, {
				headers: { authorization: `Bearer ${serverInfo().token}` },
			});
			const { tabs } = await res.json();
			return tabs.some((t: { url: string }) => t.url.includes(marker));
		})
		.toBe(true);
}

test("writes server.json for the current user only", async () => {
	const info = serverInfo();
	expect(info.url).toMatch(/^http:\/\/.+:\d+$/);
	expect(info.token.length).toBeGreaterThanOrEqual(40);
	if (process.platform !== "win32") {
		expect(fs.statSync(serverJson).mode & 0o777).toBe(0o600);
	}
});

test("relays agent API calls to the tab over the HMR websocket", async ({ page, request }) => {
	const tab = await openTab(page, "tree");
	await waitForTab(request, tab);

	const tree = await callApi(request, { method: "getTree", args: [{ format: "text" }], tab });
	expect(tree.status).toBe(200);
	expect(tree.body.tab.url).toContain(tab);
	expect(tree.body.result).toMatch(/^App #\d+\n {2}Counter #\d+\n {2}SignalCounter #\d+/);

	const before = await callApi(request, { method: "mark", tab });
	await page.getByTestId("counter").click();
	const renders = await callApi(request, { method: "getRenders", args: [{ since: before.body.result, format: "text" }], tab });
	expect(renders.body.result).toMatch(/Counter #\d+ hooks \(useState\[0\]: 0 → 1\)/);

	// Errors thrown by the API come back as errors.
	const missing = await callApi(request, { method: "inspect", args: ["NoSuchComponent"], tab });
	expect(missing).toMatchObject({ status: 422, body: { ok: false, error: 'No component found for "NoSuchComponent"' } });
});

test("rejects requests without the token, unknown methods and update()", async ({ page, request }) => {
	const tab = await openTab(page, "auth");
	await waitForTab(request, tab);

	expect((await callApi(request, { method: "getTree", tab }, "wrong")).status).toBe(401);
	const noAuth = await request.get(`${serverInfo().url}/__preact-devtools-overlay/tabs`);
	expect(noAuth.status()).toBe(401);
	expect((await callApi(request, { method: "constructor", tab })).status).toBe(400);
	const update = await callApi(request, { method: "update", args: ["Counter", "hook", 0, 41], tab });
	expect(update.status).toBe(403);
	expect(update.body.error).toContain("allowUpdate");
	await expect(page.getByTestId("counter")).toHaveText("Hook count: 0");
});

test("the MCP server answers tools/call get_tree", async ({ page, request, browserName }) => {
	test.skip(browserName !== "chromium", "Spawns Node; once is enough.");
	const tab = await openTab(page, "mcp");
	await waitForTab(request, tab);

	const child = spawn(process.execPath, [mcpBin, "--root", playground], { stdio: ["pipe", "pipe", "inherit"] });
	const lines = createInterface({ input: child.stdout! });
	const responses = new Map<number, any>();
	const waiters = new Map<number, (msg: any) => void>();
	lines.on("line", line => {
		const msg = JSON.parse(line);
		waiters.get(msg.id)?.(msg);
		responses.set(msg.id, msg);
	});
	const rpc = (id: number, method: string, params?: unknown) =>
		new Promise<any>(resolve => {
			waiters.set(id, resolve);
			child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});

	try {
		const init = await rpc(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "e2e", version: "0" },
		});
		expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "preact-devtools-overlay" } });
		child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

		const list = await rpc(2, "tools/list");
		expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("get_tree");

		const call = await rpc(3, "tools/call", { name: "get_tree", arguments: { tab } });
		expect(call.result.isError).toBeUndefined();
		expect(call.result.content[0].text).toMatch(/^App #\d+\n {2}Counter #\d+/);

		const tabs = await rpc(4, "tools/call", { name: "list_tabs", arguments: {} });
		expect(tabs.result.content[0].text).toContain(tab);
	} finally {
		child.stdin!.end();
		child.kill();
	}
});
