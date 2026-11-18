import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
	MAX_PENDING,
	TabRegistry,
	isLoopback,
	originFor,
	setupAgentBridge,
	type AgentBridge,
	type AgentBridgeOptions,
} from "../src/bridge/server";
import { STATE_DIR_ENV, serverInfoPath } from "../src/bridge/info";

// Never touch the real ~/.cache.
process.env[STATE_DIR_ENV] = fs.mkdtempSync(path.join(os.tmpdir(), "pdo-state-"));
import { API_PATH, EVENTS, TABS_PATH, type TabState } from "../src/bridge/protocol";

class FakeSocket extends EventEmitter {
	readyState = 1;
	sent: any[] = [];
	/** Answers requests like the page would. */
	respond: ((req: any) => unknown) | null = null;
	send(data: string) {
		const msg = JSON.parse(data);
		this.sent.push(msg);
		if (this.respond && msg.event === EVENTS.request) {
			const req = msg.data;
			queueMicrotask(() =>
				this.message(EVENTS.response, { id: req.id, ok: true, result: this.respond!(req), state: this.state }),
			);
		}
	}
	state: TabState = { url: "http://localhost:5173/", title: "App", visible: true, focused: false, top: true };
	message(event: string, data: unknown) {
		this.emit("message", Buffer.from(JSON.stringify({ type: "custom", event, data })));
	}
	hello(state: Partial<TabState> = {}) {
		this.state = { ...this.state, ...state };
		this.message(EVENTS.hello, this.state);
	}
}

function setup(options: AgentBridgeOptions = {}, serverConfig: Record<string, unknown> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdo-bridge-"));
	const connectionListeners: Array<(socket: FakeSocket, req: unknown) => void> = [];
	let middleware: any;
	const httpServer = Object.assign(new EventEmitter(), {
		listening: true,
		address: (): AddressInfo => ({ address: "127.0.0.1", port: 5173, family: "IPv4" }),
	});
	const warn = vi.fn();
	const server = {
		config: { root, logger: { warn }, server: serverConfig },
		middlewares: { use: (fn: unknown) => (middleware = fn) },
		ws: { on: (event: string, fn: any) => event === "connection" && connectionListeners.push(fn), off() {} },
		httpServer,
	};
	const bridge = setupAgentBridge(server as any, { version: "test", ...options });
	expect(middleware).toBe(bridge.middleware);
	const connect = (remoteAddress = "127.0.0.1", origin: string | null = "http://localhost:5173") => {
		const socket = new FakeSocket();
		for (const fn of connectionListeners) fn(socket, { socket: { remoteAddress }, headers: origin ? { origin } : {} });
		return socket;
	};
	return { root, bridge, connect, warn, httpServer };
}

/** Runs the middleware behind a real HTTP server on 127.0.0.1. */
async function listen(bridge: AgentBridge) {
	const srv = http.createServer((req, res) =>
		bridge.middleware(req, res, () => {
			res.statusCode = 404;
			res.end("next");
		}),
	);
	await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
	return {
		base,
		close: () => new Promise(r => srv.close(r)),
		async post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${bridge.token}` }) {
			const res = await fetch(base + API_PATH, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: typeof body === "string" ? body : JSON.stringify(body),
			});
			return { status: res.status, body: await res.json() };
		},
	};
}

/** A request as if it came from another machine. */
function remoteRequest(bridge: AgentBridge, remoteAddress: string) {
	return new Promise<{ status: number; body: any }>(resolve => {
		const req = Object.assign(new EventEmitter(), {
			url: TABS_PATH,
			method: "GET",
			headers: { authorization: `Bearer ${bridge.token}` },
			socket: { remoteAddress },
		});
		const headers: Record<string, string> = {};
		const res = {
			statusCode: 200,
			setHeader: (k: string, v: string) => (headers[k] = v),
			end(body: string) {
				resolve({ status: res.statusCode, body: JSON.parse(body) });
			},
		};
		bridge.middleware(req as any, res as any, () => resolve({ status: 404, body: null }));
	});
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

function track<T extends { bridge: AgentBridge; root: string }>(s: T): T {
	cleanups.push(() => {
		s.bridge.close();
		fs.rmSync(s.root, { recursive: true, force: true });
	});
	return s;
}

describe("isLoopback()", () => {
	it("accepts IPv4/IPv6 loopback only", () => {
		for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a)).toBe(true);
		for (const a of ["192.168.1.2", "10.0.0.1", "::ffff:10.0.0.1", "fe80::1", "", undefined]) {
			expect(isLoopback(a)).toBe(false);
		}
	});
});

describe("originFor()", () => {
	it("connects to wildcard addresses over loopback", () => {
		expect(originFor({ address: "::", port: 1, family: "IPv6" }, false)).toBe("http://localhost:1");
		expect(originFor({ address: "0.0.0.0", port: 2, family: "IPv4" }, true)).toBe("https://127.0.0.1:2");
		expect(originFor({ address: "::1", port: 3, family: "IPv6" }, false)).toBe("http://[::1]:3");
		expect(originFor("/tmp/socket", false)).toBeNull();
	});
});

describe("TabRegistry", () => {
	const state = (s: Partial<TabState>): TabState => ({ url: "/", title: "", visible: true, focused: false, top: true, ...s });

	it("prefers the most recently focused visible tab", () => {
		let now = 0;
		const tabs = new TabRegistry(() => now);
		const a = {};
		const b = {};
		const c = {};
		tabs.upsert(a, state({ url: "/a", focused: true }));
		now = 1;
		tabs.upsert(b, state({ url: "/b" }));
		now = 2;
		tabs.upsert(c, state({ url: "/c", visible: false }));
		// a is focused.
		expect(tabs.pick()?.state.url).toBe("/a");
		now = 3;
		tabs.upsert(a, state({ url: "/a", focused: false }));
		now = 4;
		tabs.upsert(b, state({ url: "/b", focused: true }));
		expect(tabs.pick()?.state.url).toBe("/b");
		now = 5;
		tabs.upsert(b, state({ url: "/b", focused: false }));
		// Neither is focused now: b was focused last.
		expect(tabs.pick()?.state.url).toBe("/b");
		// A hidden tab is only the default when nothing is visible.
		tabs.remove(a);
		tabs.remove(b);
		expect(tabs.pick()?.state.url).toBe("/c");
	});

	it("picks tabs by id or URL substring and lists them", () => {
		const tabs = new TabRegistry(() => 0);
		tabs.upsert(1, state({ url: "http://x/settings" }));
		tabs.upsert(2, state({ url: "http://x/", focused: true }));
		expect(tabs.pick("1")?.state.url).toBe("http://x/settings");
		expect(tabs.pick("/settings")?.id).toBe("1");
		expect(tabs.pick("nope")).toBeUndefined();
		expect(tabs.list().map(t => [t.id, t.default])).toEqual([
			["2", true],
			["1", false],
		]);
	});
});

describe("setupAgentBridge()", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("writes server.json readable by the owner only, and removes it on close", () => {
		const { bridge, root, httpServer } = track(setup());
		const info = JSON.parse(fs.readFileSync(bridge.file, "utf8"));
		// Outside the project: Vite would serve it from there.
		expect(bridge.file).toBe(serverInfoPath(root));
		expect(path.relative(root, bridge.file).startsWith("..")).toBe(true);
		expect(info).toMatchObject({ url: "http://127.0.0.1:5173", token: bridge.token, pid: process.pid, root });
		expect(bridge.token.length).toBeGreaterThanOrEqual(40);
		if (process.platform !== "win32") {
			expect(fs.statSync(bridge.file).mode & 0o777).toBe(0o600);
			expect(fs.statSync(path.dirname(bridge.file)).mode & 0o777).toBe(0o700);
		}
		httpServer.emit("close");
		expect(fs.existsSync(bridge.file)).toBe(false);
	});

	it("requires the token and rejects requests from web pages", async () => {
		const { bridge, connect } = track(setup());
		const socket = connect();
		socket.respond = () => "tree";
		socket.hello();
		const http = await listen(bridge);
		cleanups.push(http.close);

		expect((await http.post({ method: "getTree" }, {})).status).toBe(401);
		expect((await http.post({ method: "getTree" }, { authorization: "Bearer nope" })).status).toBe(401);
		expect((await http.post({ method: "getTree" }, { authorization: bridge.token })).status).toBe(401);
		const fromPage = await http.post(
			{ method: "getTree" },
			{ authorization: `Bearer ${bridge.token}`, origin: "http://evil.example" },
		);
		expect(fromPage.status).toBe(403);
		expect(await http.post({ method: "getTree" })).toMatchObject({ status: 200, body: { ok: true, result: "tree" } });

		// Other paths are left to Vite.
		expect((await fetch(`${http.base}/src/main.tsx`)).status).toBe(404);
	});

	it("rejects requests from other machines unless allowRemote is set", async () => {
		const { bridge } = track(setup());
		const remote = await remoteRequest(bridge, "192.168.1.20");
		expect(remote.status).toBe(403);
		expect(remote.body.error).toContain("allowRemote");
		expect((await remoteRequest(bridge, "::1")).status).toBe(200);

		const open = track(setup({ allowRemote: true }));
		expect((await remoteRequest(open.bridge, "192.168.1.20")).status).toBe(200);
	});

	it("ignores tabs from other machines unless allowRemote is set", () => {
		const { bridge, connect, warn } = track(setup());
		connect("10.0.0.5").hello({ url: "http://10.0.0.5/" });
		expect(bridge.tabs.list().map(t => t.url)).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);

		const open = track(setup({ allowRemote: true }));
		open.connect("10.0.0.5").hello();
		expect(open.bridge.tabs.size).toBe(1);
	});

	it("only relays whitelisted methods, and update() only when allowed", async () => {
		const { bridge, connect } = track(setup());
		const socket = connect();
		socket.respond = req => req.method;
		socket.hello();
		const http = await listen(bridge);
		cleanups.push(http.close);

		for (const method of ["constructor", "__proto__", "eval", "toString", 42]) {
			expect((await http.post({ method })).status).toBe(400);
		}
		expect((await http.post({ method: "getTree", args: "nope" })).status).toBe(400);
		expect((await http.post("{not json")).status).toBe(400);
		const update = await http.post({ method: "update", args: ["Counter", "hook", 0, 1] });
		expect(update.status).toBe(403);
		expect(update.body.error).toContain("allowUpdate");
		// Nothing reached the page.
		expect(socket.sent).toEqual([]);

		const allowed = track(setup({ allowUpdate: true }));
		const s2 = allowed.connect();
		s2.respond = () => true;
		s2.hello();
		expect(await allowed.bridge.call("update", ["Counter", "hook", 0, 1])).toMatchObject({ status: 200 });
	});

	it("explains when no tab is connected or none matches", async () => {
		const { bridge, connect } = track(setup());
		const none = await bridge.call("getTree", []);
		expect(none.status).toBe(503);
		expect((none.body as any).error).toContain("No browser tab is connected");

		connect().hello({ url: "http://localhost:5173/a" });
		const missing = await bridge.call("getTree", [], "/b");
		expect(missing.status).toBe(404);
		expect((missing.body as any).error).toContain("http://localhost:5173/a");
	});

	it("times out when the tab doesn't answer", async () => {
		const { bridge, connect } = track(setup({ timeout: 30 }));
		connect().hello();
		const res = await bridge.call("getTree", []);
		expect(res.status).toBe(504);
		expect((res.body as any).error).toContain("didn't answer within 30ms");
	});

	it("routes requests to the chosen tab and ignores answers from others", async () => {
		const { bridge, connect } = track(setup());
		const a = connect();
		a.hello({ url: "http://localhost:5173/a", focused: true });
		const b = connect();
		b.respond = () => "from b";
		b.hello({ url: "http://localhost:5173/b" });

		const pending = bridge.call("getTree", [], "/a");
		await Promise.resolve();
		const req = a.sent.at(-1).data;
		expect(req).toMatchObject({ method: "getTree", args: [] });
		// b tries to answer a's request.
		b.message(EVENTS.response, { id: req.id, ok: true, result: "spoofed", state: b.state });
		a.message(EVENTS.response, { id: req.id, ok: true, result: "from a", state: { ...a.state, title: "New title" } });
		expect(await pending).toEqual({
			status: 200,
			body: { ok: true, result: "from a", tab: { id: "1", url: "http://localhost:5173/a", title: "New title" } },
		});
		expect(b.sent).toEqual([]);
	});

	it("maps page errors to HTTP errors", async () => {
		const { bridge, connect } = track(setup());
		const socket = connect();
		socket.hello();
		socket.send = (data: string) => {
			const { data: req } = JSON.parse(data);
			queueMicrotask(() =>
				socket.message(EVENTS.response, { id: req.id, ok: false, code: "error", error: "No component found for \"X\"" }),
			);
		};
		expect(await bridge.call("inspect", ["X"])).toMatchObject({
			status: 422,
			body: { ok: false, error: 'No component found for "X"', code: "error" },
		});
	});

	it("forgets tabs whose socket closed, failing their pending requests", async () => {
		const { bridge, connect } = track(setup());
		const socket = connect();
		socket.hello();
		const pending = bridge.call("getTree", []);
		socket.emit("close");
		expect(await pending).toMatchObject({ status: 503 });
		expect(bridge.tabs.list().map(t => t.url)).toEqual([]);
	});

	it("lists tabs", async () => {
		const { bridge, connect } = track(setup());
		connect().hello({ url: "http://localhost:5173/", title: "Home", focused: true });
		const res = await remoteRequest(bridge, "127.0.0.1");
		expect(res.body.tabs).toEqual([
			expect.objectContaining({ id: "1", url: "http://localhost:5173/", title: "Home", focused: true, default: true }),
		]);
	});

	it("only lets pages from this dev server's hosts register as tabs", () => {
		const { bridge, connect, warn } = track(setup({}, { allowedHosts: [".example.test"] }));
		connect("127.0.0.1", "http://evil.example").hello();
		connect("127.0.0.1", null).hello();
		// DNS rebinding: the attacker's host name, pointing at 127.0.0.1.
		connect("127.0.0.1", "http://rebind.attacker.example:5173").hello();
		connect("127.0.0.1", "http://127.attacker.example").hello();
		expect(bridge.tabs.list().map(t => t.url)).toEqual([]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignores a tab from http://evil.example"));
		connect("127.0.0.1", "http://127.0.0.1:5173").hello();
		connect("::1", "http://[::1]:5173").hello();
		connect("127.0.0.1", "http://app.example.test:5173").hello();
		expect(bridge.tabs.size).toBe(3);
	});

	it("checks the page's host even with allowRemote", () => {
		const { bridge, connect } = track(setup({ allowRemote: true }));
		connect("192.168.1.20", "http://evil.example").hello();
		expect(bridge.tabs.size).toBe(0);
		connect("192.168.1.20", "http://localhost:5173").hello();
		expect(bridge.tabs.size).toBe(1);
	});

	it("survives malformed messages from the HMR socket", () => {
		const { bridge, connect } = track(setup());
		const socket = connect();
		expect(() => socket.message(EVENTS.hello, { url: { toString: null }, title: 1 })).not.toThrow();
		expect(bridge.tabs.list()[0]).toMatchObject({ url: "", title: "" });
		expect(() => socket.emit("message", { toString: null })).not.toThrow();
		expect(() => socket.message(EVENTS.response, { id: { valueOf: null } })).not.toThrow();
	});

	it("rejects a non-string tab and caps calls waiting for a tab", async () => {
		const { bridge, connect } = track(setup({ timeout: 60_000 }));
		connect().hello(); // never answers
		const http = await listen(bridge);
		cleanups.push(http.close);
		expect((await http.post({ method: "getTree", tab: { toString: null } })).status).toBe(400);

		const waiting = Array.from({ length: MAX_PENDING }, () => bridge.call("getTree", []));
		expect(await bridge.call("getTree", [])).toMatchObject({ status: 429 });
		bridge.close();
		expect((await Promise.all(waiting)).every(r => r.status === 503)).toBe(true);
	});

	it("stops waiting when the caller hangs up", async () => {
		const { bridge, connect } = track(setup({ timeout: 60_000 }));
		connect().hello(); // never answers
		const abort = new AbortController();
		const call = bridge.call("getTree", [], undefined, abort.signal);
		abort.abort();
		expect(await call).toMatchObject({ status: 499 });
		// The slot is free again.
		const calls = Array.from({ length: MAX_PENDING - 1 }, () => bridge.call("getTree", []));
		void calls;
		expect(await Promise.race([bridge.call("getTree", []), Promise.resolve("pending")])).toBe("pending");
	});
});
