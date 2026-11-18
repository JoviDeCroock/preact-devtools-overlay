/**
 * Dev-server side of the agent bridge: an HTTP endpoint that relays agent API
 * calls to a browser tab over Vite's HMR websocket, for agents (and the MCP
 * server in `src/mcp.ts`) that can't drive a browser themselves.
 *
 * The endpoint runs code in the page, and the dev server is reachable from
 * the network with `--host`, so every request needs:
 *   - the per-server token from `server.json` (only readable by the user who
 *     started Vite), as `Authorization: Bearer <token>`,
 *   - a loopback remote address, unless `allowRemote` is set,
 *   - no `Origin` header: it's for tools, not web pages.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import {
	API_PATH,
	EVENTS,
	MUTATING_METHODS,
	SERVER_INFO_FILE,
	TABS_PATH,
	isBridgeMethod,
	type BridgeMethod,
	type BridgeResponse,
	type ServerInfo,
	type TabInfo,
	type TabState,
} from "./protocol.js";

export interface AgentBridgeOptions {
	/**
	 * Accept API requests, and tabs, from other machines. By default both
	 * must come from a loopback address (`127.0.0.0/8`, `::1`), even when
	 * the dev server listens on the network (`--host`). The token is
	 * required either way.
	 */
	allowRemote?: boolean;
	/** Relay `update()`, which changes app state. Defaults to `false`. */
	allowUpdate?: boolean;
	/** How long to wait for the page to answer, in ms. Defaults to 10000. */
	timeout?: number;
}

/**
 * One HMR websocket: a raw `ws` socket from the server's `connection` event.
 * We don't use custom-event listeners (`server.ws.on(event, (data, client))`):
 * in Vite 6 and 7 they get a new client object for every message, without
 * the socket, so we couldn't tell which tab sent it or when it went away.
 */
export interface RawSocket {
	readyState: number;
	send(data: string): void;
	on(event: "message", cb: (data: unknown) => void): unknown;
	on(event: "close", cb: () => void): unknown;
}

interface WsClient {
	socket: RawSocket;
	remote: string | undefined;
}

interface Tab {
	id: string;
	client: WsClient;
	state: TabState;
	lastActive: number;
	connectedAt: number;
}

type Answer = BridgeResponse | { id: number; ok: false; error: string; status: number };

interface Pending {
	tab: Tab;
	resolve(res: Answer): void;
	timer: ReturnType<typeof setTimeout>;
}

const MAX_BODY = 1024 * 1024;
const WS_OPEN = 1;

export function isLoopback(address: string | undefined): boolean {
	if (!address) return false;
	const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
	return v4.startsWith("127.") || address === "::1";
}

function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function normalizeState(data: unknown): TabState | null {
	if (!data || typeof data !== "object") return null;
	const d = data as Record<string, unknown>;
	return {
		url: String(d.url ?? "").slice(0, 2048),
		title: String(d.title ?? "").slice(0, 256),
		visible: d.visible === true,
		focused: d.focused === true,
		top: d.top !== false,
	};
}

/** Tabs that said hello. */
export class TabRegistry<C = unknown> {
	private tabs = new Map<C, Tab & { client: C }>();
	private nextId = 1;

	constructor(private now: () => number = Date.now) {}

	upsert(client: C, state: TabState) {
		const now = this.now();
		let tab = this.tabs.get(client);
		if (!tab) {
			tab = { id: String(this.nextId++), client, state, lastActive: now, connectedAt: now } as Tab & { client: C };
			this.tabs.set(client, tab);
		}
		const wasVisible = tab.state.visible;
		tab.state = state;
		// Gaining focus, or becoming visible, counts as activity.
		if (state.focused || (state.visible && !wasVisible)) tab.lastActive = now;
		return tab;
	}

	get(client: C) {
		return this.tabs.get(client);
	}

	remove(client: C) {
		const tab = this.tabs.get(client);
		this.tabs.delete(client);
		return tab;
	}

	get size() {
		return this.tabs.size;
	}

	/** Visible before hidden, then top-level, focused, most recently active, newest. */
	sorted() {
		const score = (t: Tab) => [+t.state.visible, +t.state.top, +t.state.focused, t.lastActive, t.connectedAt];
		return [...this.tabs.values()].sort((a, b) => {
			const sa = score(a);
			const sb = score(b);
			for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i]! - sa[i]!;
			return 0;
		});
	}

	/**
	 * `selector`: a tab id, or part of a tab's URL. Without one, the most
	 * recently focused visible tab.
	 */
	pick(selector?: string) {
		const list = this.sorted();
		if (selector === undefined || selector === "") return list[0];
		return list.find(t => t.id === selector) ?? list.find(t => t.state.url.includes(selector));
	}

	list(): TabInfo[] {
		const list = this.sorted();
		return list.map((t, i) => ({
			id: t.id,
			...t.state,
			lastActive: t.lastActive,
			connectedAt: t.connectedAt,
			default: i === 0,
		}));
	}
}

function send(res: ServerResponse, status: number, body: unknown) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new Error("Request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

export function serverInfoPath(root: string): string {
	return path.join(root, SERVER_INFO_FILE);
}

/** Writes `server.json`, readable by the current user only. */
export function writeServerInfo(file: string, info: ServerInfo): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
	// `mode` only applies when the file is created.
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
}

/** Removes `server.json` if it still belongs to the server with `token`. */
export function removeServerInfo(file: string, token: string): void {
	try {
		const info = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ServerInfo>;
		if (info.token === token) fs.rmSync(file, { force: true });
	} catch {
		// Already gone, or not ours.
	}
}

export function originFor(address: string | AddressInfo | null, https: boolean): string | null {
	if (!address || typeof address === "string") return null;
	let host = address.address;
	// Wildcards: connect over loopback.
	if (host === "::" || host === "") host = "localhost";
	else if (host === "0.0.0.0") host = "127.0.0.1";
	else if (host.includes(":")) host = `[${host}]`;
	return `${https ? "https" : "http"}://${host}:${address.port}`;
}

// One token per Vite root for the lifetime of the process, so it survives
// dev server restarts (e.g. after editing vite.config.ts).
const tokens = new Map<string, string>();

export interface AgentBridge {
	readonly token: string;
	readonly tabs: TabRegistry<WsClient>;
	/** Path of `server.json`. */
	readonly file: string;
	middleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void;
	call(method: BridgeMethod, args: unknown[], tab?: string): Promise<{ status: number; body: unknown }>;
	close(): void;
}

type DevServerLike = Pick<ViteDevServer, "config" | "middlewares" | "ws" | "httpServer">;

const UPDATE_DISABLED = (method: string) =>
	`${method}() changes app state and is disabled over the bridge. Enable it with preactDevtoolsOverlay({ agentBridge: { allowUpdate: true } }).`;

export function setupAgentBridge(
	server: DevServerLike,
	options: AgentBridgeOptions & { version: string },
): AgentBridge {
	const { allowRemote = false, allowUpdate = false, timeout = 10_000, version } = options;
	const root = server.config.root;
	const logger = server.config.logger;
	const file = serverInfoPath(root);
	let token = tokens.get(root);
	if (!token) {
		token = crypto.randomBytes(32).toString("base64url");
		tokens.set(root, token);
	}
	const tabs = new TabRegistry<WsClient>();
	const pending = new Map<number, Pending>();
	let nextRequest = 1;
	const warned = new Set<string | undefined>();

	const dropTab = (client: WsClient) => {
		const tab = tabs.remove(client);
		if (!tab) return;
		for (const [id, p] of pending) {
			if (p.tab !== tab) continue;
			clearTimeout(p.timer);
			pending.delete(id);
			p.resolve({ id, ok: false, status: 503, error: `Tab ${tab.id} (${tab.state.url}) closed before it answered.` });
		}
	};

	const accept = (client: WsClient): boolean => {
		if (allowRemote || isLoopback(client.remote)) return true;
		if (!warned.has(client.remote)) {
			warned.add(client.remote);
			logger.warn(
				`[preact-devtools-overlay] The agent bridge ignores tabs from other machines (${client.remote ?? "unknown address"}). Set agentBridge: { allowRemote: true } to allow them.`,
			);
		}
		return false;
	};

	const onMessage = (client: WsClient, event: string, data: unknown) => {
		if (event === EVENTS.hello) {
			const state = normalizeState(data);
			if (state && accept(client)) tabs.upsert(client, state);
		} else if (event === EVENTS.state) {
			const state = normalizeState(data);
			if (state && tabs.get(client)) tabs.upsert(client, state);
		} else if (event === EVENTS.response) {
			const res = data as BridgeResponse | null;
			if (!res || typeof res !== "object" || typeof res.id !== "number") return;
			const p = pending.get(res.id);
			// Only the tab we asked may answer.
			if (!p || p.tab.client !== client) return;
			clearTimeout(p.timer);
			pending.delete(res.id);
			const state = normalizeState(res.state);
			if (state) tabs.upsert(client, state);
			p.resolve(res);
		}
	};

	const onConnection = (socket: RawSocket, req: IncomingMessage) => {
		const client: WsClient = { socket, remote: req?.socket?.remoteAddress };
		socket.on("message", raw => {
			const text = String(raw);
			// Cheap pre-check: this sees every HMR message.
			if (!text.includes('"preact-devtools-overlay:')) return;
			let msg: { type?: unknown; event?: unknown; data?: unknown } | null;
			try {
				msg = JSON.parse(text);
			} catch {
				return;
			}
			if (msg?.type === "custom" && typeof msg.event === "string") onMessage(client, msg.event, msg.data);
		});
		socket.on("close", () => dropTab(client));
	};

	// `connection` is forwarded to the underlying `ws` server, with the
	// upgrade request, in every Vite version we support.
	const ws = server.ws as unknown as {
		on(event: "connection", cb: (socket: RawSocket, req: IncomingMessage) => void): void;
		off?(event: "connection", cb: (socket: RawSocket, req: IncomingMessage) => void): void;
	};
	ws.on("connection", onConnection);

	const summary = (tab: Tab) => ({ id: tab.id, url: tab.state.url, title: tab.state.title });

	async function call(method: BridgeMethod, args: unknown[], selector?: string) {
		if (MUTATING_METHODS.has(method) && !allowUpdate) {
			return { status: 403, body: { ok: false, error: UPDATE_DISABLED(method) } };
		}
		const tab = tabs.pick(selector);
		if (!tab) {
			if (tabs.size === 0) {
				return {
					status: 503,
					body: {
						ok: false,
						error: "No browser tab is connected to the dev server. Open the app in a browser first (served by this Vite dev server, with HMR enabled).",
					},
				};
			}
			const known = tabs
				.list()
				.map(t => `${t.id} (${t.url})`)
				.join(", ");
			return { status: 404, body: { ok: false, error: `No tab matches ${JSON.stringify(selector)}. Connected tabs: ${known}.` } };
		}
		const id = nextRequest++;
		const res = await new Promise<Answer>(resolve => {
			const timer = setTimeout(() => {
				pending.delete(id);
				resolve({
					id,
					ok: false,
					status: 504,
					error: `Tab ${tab.id} (${tab.state.url}) didn't answer within ${timeout}ms. Is it paused in the debugger, frozen in the background, or still loading?`,
				});
			}, timeout);
			pending.set(id, { tab, resolve, timer });
			try {
				const socket = tab.client.socket;
				if (socket.readyState !== WS_OPEN) throw new Error("its websocket is not open");
				// Vite's HMR payload for custom events (`import.meta.hot.on`).
				socket.send(JSON.stringify({ type: "custom", event: EVENTS.request, data: { id, method, args } }));
			} catch (err) {
				clearTimeout(timer);
				pending.delete(id);
				resolve({ id, ok: false, status: 503, error: `Could not reach tab ${tab.id}: ${err instanceof Error ? err.message : String(err)}` });
			}
		});
		if (res.ok) return { status: 200, body: { ok: true, result: res.result, tab: summary(tab) } };
		let status = 422;
		if ("status" in res) status = res.status;
		else if (res.code === "not-allowed") status = 403;
		else if (res.code === "unknown-method") status = 400;
		const code = "code" in res ? res.code : undefined;
		return { status, body: { ok: false, error: res.error, ...(code ? { code } : {}), tab: summary(tab) } };
	}

	function middleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) {
		const pathname = (req.url ?? "").split("?")[0];
		if (pathname !== API_PATH && pathname !== TABS_PATH) return next();

		if (!allowRemote && !isLoopback(req.socket?.remoteAddress)) {
			return send(res, 403, {
				ok: false,
				error: "The agent bridge only accepts requests from this machine. Set agentBridge: { allowRemote: true } to change that.",
			});
		}
		// Browsers always send Origin on POST (and cross-origin GET). Pages
		// can use window.__PREACT_DEVTOOLS_OVERLAY__.api directly.
		if (req.headers.origin) {
			return send(res, 403, { ok: false, error: "Requests from web pages are not accepted." });
		}
		const auth = req.headers.authorization ?? "";
		const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
		if (!given || !safeEqual(given, token!)) {
			return send(res, 401, {
				ok: false,
				error: `Missing or wrong token. Send "Authorization: Bearer <token>" with the token from ${SERVER_INFO_FILE} in the Vite root.`,
			});
		}

		if (pathname === TABS_PATH) {
			if (req.method !== "GET") return send(res, 405, { ok: false, error: "Use GET." });
			return send(res, 200, { ok: true, tabs: tabs.list() });
		}

		if (req.method !== "POST") return send(res, 405, { ok: false, error: "Use POST." });
		const usage = "Body must be JSON: { method, args?, tab? }.";
		readBody(req).then(
			async raw => {
				let body: { method?: unknown; args?: unknown; tab?: unknown } | null;
				try {
					body = JSON.parse(raw);
				} catch {
					return send(res, 400, { ok: false, error: usage });
				}
				if (!body || typeof body !== "object") return send(res, 400, { ok: false, error: usage });
				if (!isBridgeMethod(body.method)) {
					return send(res, 400, { ok: false, error: `Unknown method ${JSON.stringify(body.method)}.` });
				}
				const args = body.args ?? [];
				if (!Array.isArray(args)) return send(res, 400, { ok: false, error: "args must be an array." });
				const tab = body.tab == null ? undefined : String(body.tab);
				const out = await call(body.method, args, tab);
				send(res, out.status, out.body);
			},
			err => send(res, 413, { ok: false, error: err instanceof Error ? err.message : String(err) }),
		);
	}

	server.middlewares.use(middleware);

	const write = () => {
		const https = !!server.config.server?.https;
		const url = server.httpServer ? originFor(server.httpServer.address(), https) : null;
		try {
			writeServerInfo(file, { url, token: token!, pid: process.pid, root, version });
		} catch (err) {
			logger.warn(`[preact-devtools-overlay] Could not write ${file}: ${String(err)}`);
		}
	};
	const removeFile = () => removeServerInfo(file, token!);

	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		removeFile();
		process.off("exit", removeFile);
		for (const [id, p] of pending) {
			clearTimeout(p.timer);
			p.resolve({ id, ok: false, status: 503, error: "The dev server is shutting down." });
		}
		pending.clear();
		ws.off?.("connection", onConnection);
	};

	if (server.httpServer) {
		if (server.httpServer.listening) write();
		else server.httpServer.once("listening", write);
		server.httpServer.once("close", close);
	} else {
		// Middleware mode: the URL is unknown, the MCP server needs --url.
		write();
	}
	process.once("exit", removeFile);

	return { token, tabs, file, middleware, call, close };
}
