import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ErrorCode,
	MAX_TOOL_TEXT,
	SUPPORTED_PROTOCOL_VERSIONS,
	TOOLS,
	createMcpServer,
	parseArgs,
	serveStdio,
	toTarget,
	type ToolBridge,
} from "../src/mcp";
import { BridgeError, createBridgeClient, findServerInfo } from "../src/bridge/client";
import { SERVER_INFO_FILE } from "../src/bridge/protocol";

function fakeBridge(results: Record<string, unknown> = {}) {
	const calls: Array<{ method: string; args: unknown[]; tab?: string }> = [];
	const bridge: ToolBridge = {
		async call(method, args = [], tab) {
			calls.push({ method, args, ...(tab ? { tab } : {}) });
			const r = results[method];
			if (r instanceof Error) throw r;
			return { result: typeof r === "function" ? r(...args) : r, tab: { id: "1", url: "http://localhost:5173/", title: "App" } };
		},
		async tabs() {
			return (results.tabs as any) ?? [];
		},
	};
	return { bridge, calls };
}

const rpc = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });

describe("MCP server", () => {
	it("negotiates the protocol version", async () => {
		const { handle } = createMcpServer({ bridge: fakeBridge().bridge, version: "1.2.3" });
		for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
			const res: any = await handle(rpc(1, "initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "0" } }));
			expect(res.result.protocolVersion).toBe(v);
		}
		const res: any = await handle(rpc(2, "initialize", { protocolVersion: "1999-01-01" }));
		expect(res).toMatchObject({
			jsonrpc: "2.0",
			id: 2,
			result: {
				protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "preact-devtools-overlay", version: "1.2.3" },
				instructions: expect.stringContaining("mark"),
			},
		});
		expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe("2025-11-25");
	});

	it("answers ping, ignores notifications and rejects unknown methods", async () => {
		const { handle } = createMcpServer({ bridge: fakeBridge().bridge });
		expect(await handle(rpc("a", "ping"))).toEqual({ jsonrpc: "2.0", id: "a", result: {} });
		expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
		expect(await handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).toBeNull();
		// Dual-era clients probe with server/discover and fall back to initialize on this error.
		expect(await handle(rpc(3, "server/discover"))).toMatchObject({ id: 3, error: { code: ErrorCode.MethodNotFound } });
		expect(await handle(rpc(4, "resources/list"))).toMatchObject({ error: { code: ErrorCode.MethodNotFound } });
	});

	it("rejects invalid messages", async () => {
		const { handle } = createMcpServer({ bridge: fakeBridge().bridge });
		expect(await handle({ id: 1, method: "ping" })).toMatchObject({ id: 1, error: { code: ErrorCode.InvalidRequest } });
		expect(await handle({ jsonrpc: "2.0", id: 2 })).toMatchObject({ id: 2, error: { code: ErrorCode.InvalidRequest } });
		expect(await handle({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" })).toMatchObject({ id: null, error: { code: ErrorCode.InvalidRequest } });
		expect(await handle("hello")).toMatchObject({ id: null, error: { code: ErrorCode.InvalidRequest } });
		expect(await handle([])).toMatchObject({ error: { code: ErrorCode.InvalidRequest } });
		// Responses (to requests we never send) are ignored.
		expect(await handle({ jsonrpc: "2.0", id: 5, result: {} })).toBeNull();
	});

	it("handles batches", async () => {
		const { handle } = createMcpServer({ bridge: fakeBridge().bridge });
		expect(await handle([rpc(1, "ping"), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc(2, "ping")])).toEqual([
			{ jsonrpc: "2.0", id: 1, result: {} },
			{ jsonrpc: "2.0", id: 2, result: {} },
		]);
	});

	it("lists tools with schemas and annotations", async () => {
		const { handle } = createMcpServer({ bridge: fakeBridge().bridge });
		const res: any = await handle(rpc(1, "tools/list"));
		const names = res.result.tools.map((t: any) => t.name);
		expect(names).toEqual([
			"list_tabs",
			"get_tree",
			"find",
			"inspect",
			"why_did_render",
			"get_renders",
			"mark",
			"get_signals",
			"get_signal_updates",
			"get_signal_graph",
			"status",
			"update",
		]);
		for (const tool of res.result.tools) {
			expect(tool.description.length).toBeGreaterThan(50);
			expect(tool.inputSchema.type).toBe("object");
			expect(tool.annotations.readOnlyHint).toBe(tool.name !== "update");
			if (tool.name !== "list_tabs") expect(tool.inputSchema.properties.tab).toBeDefined();
		}
	});

	it("maps tool calls to agent API calls, in text format by default", async () => {
		const { bridge, calls } = fakeBridge({ getTree: "App #1\n  Counter #2", inspect: { id: 2, name: "Counter" }, mark: 42 });
		const { handle } = createMcpServer({ bridge });

		const tree: any = await handle(rpc(1, "tools/call", { name: "get_tree", arguments: { depth: 2 } }));
		expect(tree.result).toEqual({ content: [{ type: "text", text: "App #1\n  Counter #2" }] });

		const inspect: any = await handle(rpc(2, "tools/call", { name: "inspect", arguments: { target: "#2", tab: "/settings" } }));
		expect(JSON.parse(inspect.result.content[0].text)).toEqual({ id: 2, name: "Counter" });

		await handle(rpc(3, "tools/call", { name: "get_renders", arguments: { since: "42", target: "TodoItem", format: "json" } }));
		await handle(rpc(4, "tools/call", { name: "why_did_render", arguments: { target: "[data-testid=save]" } }));
		const mark: any = await handle(rpc(5, "tools/call", { name: "mark" }));
		expect(mark.result.content[0].text).toBe("since: 42");

		expect(calls).toEqual([
			{ method: "getTree", args: [{ depth: 2, format: "text" }] },
			{ method: "inspect", args: [2, {}], tab: "/settings" },
			{ method: "getRenders", args: [{ since: 42, target: "TodoItem", format: "json" }] },
			{ method: "whyDidRender", args: ["[data-testid=save]", { format: "text" }] },
			{ method: "mark", args: [] },
		]);
	});

	it("returns tool errors as isError results so the model can recover", async () => {
		const { bridge, calls } = fakeBridge({ getTree: new BridgeError("No browser tab is connected to the dev server.", 503) });
		const { handle } = createMcpServer({ bridge });
		expect(await handle(rpc(1, "tools/call", { name: "get_tree", arguments: {} }))).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: { content: [{ type: "text", text: "No browser tab is connected to the dev server." }], isError: true },
		});
		const bad: any = await handle(rpc(2, "tools/call", { name: "get_renders", arguments: { since: "soon" } }));
		expect(bad.result).toMatchObject({ isError: true, content: [{ text: "since must be an integer" }] });
		const format: any = await handle(rpc(3, "tools/call", { name: "get_tree", arguments: { format: "yaml" } }));
		expect(format.result.isError).toBe(true);
		expect(calls).toHaveLength(1);
		// Unknown tools are protocol errors.
		expect(await handle(rpc(4, "tools/call", { name: "rm_rf" }))).toMatchObject({ error: { code: ErrorCode.InvalidParams } });
	});

	it("lists tabs and cuts very long answers", async () => {
		const { bridge } = fakeBridge({
			getTree: "x".repeat(MAX_TOOL_TEXT + 10),
			tabs: [
				{ id: "2", url: "http://localhost:5173/b", title: "B", visible: true, focused: true, top: true, default: true, lastActive: 0, connectedAt: 0 },
				{ id: "1", url: "http://localhost:5173/a", title: "", visible: false, focused: false, top: true, default: false, lastActive: 0, connectedAt: 0 },
			],
		});
		const { handle } = createMcpServer({ bridge });
		const tabs: any = await handle(rpc(1, "tools/call", { name: "list_tabs" }));
		expect(tabs.result.content[0].text).toBe(
			'2  http://localhost:5173/b  "B"  (visible, focused, default)\n1  http://localhost:5173/a  (hidden)',
		);
		const tree: any = await handle(rpc(2, "tools/call", { name: "get_tree" }));
		expect(tree.result.content[0].text).toMatch(/^x+\n… \(10 more characters cut/);
	});

	it("speaks newline-delimited JSON over stdio", async () => {
		const server = createMcpServer({ bridge: fakeBridge({ getTree: "App #1" }).bridge });
		const stdin = new EventEmitter();
		const out: string[] = [];
		const done = serveStdio(server, { stdin: stdin as any, stdout: { write: (s: string) => out.push(s) } });
		stdin.emit("data", Buffer.from(JSON.stringify(rpc(1, "ping")) + "\n{oops\n"));
		stdin.emit("data", JSON.stringify(rpc(2, "tools/call", { name: "get_tree" })).slice(0, 10));
		stdin.emit("data", JSON.stringify(rpc(2, "tools/call", { name: "get_tree" })).slice(10) + "\r\n");
		stdin.emit("end");
		await done;
		const messages = out.map(line => {
			expect(line.endsWith("\n")).toBe(true);
			expect(line.slice(0, -1)).not.toContain("\n");
			return JSON.parse(line);
		});
		expect(messages).toEqual(
			expect.arrayContaining([
				{ jsonrpc: "2.0", id: 1, result: {} },
				{ jsonrpc: "2.0", id: null, error: { code: ErrorCode.ParseError, message: "Parse error" } },
				{ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "App #1" }] } },
			]),
		);
		expect(messages).toHaveLength(3);
	});
});

describe("tool helpers", () => {
	it("turns ids into numbers and keeps names and selectors", () => {
		expect(toTarget("#12")).toBe(12);
		expect(toTarget("12")).toBe(12);
		expect(toTarget(7)).toBe(7);
		expect(toTarget("TodoItem")).toBe("TodoItem");
		expect(toTarget("li:nth-child(2)")).toBe("li:nth-child(2)");
		expect(() => toTarget("")).toThrow();
	});

	it("parses CLI flags and environment", () => {
		expect(parseArgs(["--root", "app", "--url=http://localhost:1", "--timeout", "500"], { PREACT_DEVTOOLS_OVERLAY_TOKEN: "t" })).toEqual({
			root: "app",
			url: "http://localhost:1",
			token: "t",
			timeout: 500,
		});
		expect(() => parseArgs(["--nope"])).toThrow("Unknown option");
		expect(() => parseArgs(["--root"])).toThrow("needs a value");
	});

	it("has one tool per bridge method it uses", () => {
		expect(new Set(TOOLS.map(t => t.name)).size).toBe(TOOLS.length);
	});
});

describe("bridge client", () => {
	const dirs: string[] = [];
	const tmp = () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdo-mcp-"));
		dirs.push(dir);
		return dir;
	};
	const writeInfo = (root: string, info: object) => {
		const file = path.join(root, SERVER_INFO_FILE);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(info));
		return file;
	};
	afterEach(() => {
		vi.unstubAllGlobals();
		for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});

	it("finds server.json in the root, a parent, or a subdirectory", () => {
		const repo = tmp();
		const app = path.join(repo, "apps", "web");
		fs.mkdirSync(path.join(app, "src"), { recursive: true });
		expect(findServerInfo(repo)).toBeNull();

		writeInfo(app, { url: "http://localhost:1", token: "a" });
		// From the repository root (grandchild) and from inside the app (parent).
		expect(findServerInfo(repo)?.info.token).toBe("a");
		expect(findServerInfo(path.join(app, "src"))?.info.token).toBe("a");
	});

	it("sends the token and surfaces the bridge's errors", async () => {
		const root = tmp();
		writeInfo(root, { url: "http://localhost:1234/", token: "secret" });
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
			new Response(JSON.stringify({ ok: false, error: "No browser tab is connected." }), { status: 503 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = createBridgeClient({ root });
		await expect(client.call("getTree", [{ format: "text" }], "/a")).rejects.toThrow("No browser tab is connected.");
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("http://localhost:1234/__preact-devtools-overlay/api");
		expect(init.headers).toMatchObject({ authorization: "Bearer secret" });
		expect(JSON.parse(String(init.body))).toEqual({ method: "getTree", args: [{ format: "text" }], tab: "/a" });
	});

	it("explains a missing or stopped dev server", async () => {
		const root = tmp();
		await expect(createBridgeClient({ root }).tabs()).rejects.toThrow(/No running Vite dev server/);

		writeInfo(root, { url: "http://127.0.0.1:9", token: "x" });
		vi.stubGlobal("fetch", async () => {
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		});
		await expect(createBridgeClient({ root }).tabs()).rejects.toThrow(/Could not reach the dev server at http:\/\/127.0.0.1:9 \(ECONNREFUSED\).*no longer running/);
	});
});
