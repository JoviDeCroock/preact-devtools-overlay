/**
 * Dev-server side of the agent bridge: an HTTP endpoint that relays agent API
 * calls to a browser tab over Vite's HMR websocket, for agents (and the MCP
 * server in `src/mcp.ts`) that can't drive a browser themselves.
 *
 * The endpoint runs code in the page, and the dev server is reachable from
 * the network with `--host`, so every request needs:
 *   - the per-server token from `server.json` (in the user's cache directory,
 *     only readable by the user who started Vite; see `info.ts`), as
 *     `Authorization: Bearer <token>`,
 *   - a loopback remote address, unless `allowRemote` is set,
 *   - no `Origin` header: it's for tools, not web pages.
 *
 * Tabs register over Vite's HMR websocket. Only pages served from a
 * loopback host, this machine's addresses, `server.host` or
 * `server.allowedHosts` may: a web page from another site (including DNS
 * rebinding) can't pose as a tab. Other processes on this machine are
 * trusted, as they are by Vite itself.
 */
import crypto from "node:crypto";
import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import {
	API_PATH,
	EVENTS,
	MUTATING_METHODS,
	TABS_PATH,
	isBridgeMethod,
	type BridgeMethod,
	type BridgeResponse,
	type ServerInfo,
	type TabInfo,
	type TabState,
} from "./protocol.js";
import { removeServerInfo, serverInfoPath, writeServerInfo } from "./info.js";

export { removeServerInfo, serverInfoPath, writeServerInfo };

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
	/** `Origin` of the websocket upgrade request. */
	origin: string | undefined;
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
/** Calls waiting for a tab, across all tabs. */
export const MAX_PENDING = 64;
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

/** From an untrusted socket: only plain strings and booleans are used. */
function normalizeState(data: unknown): TabState | null {
	if (!data || typeof data !== "object") return null;
	const d = data as Record<string, unknown>;
	return {
		url: typeof d.url === "string" ? d.url.slice(0, 2048) : "",
		title: typeof d.title === "string" ? d.title.slice(0, 256) : "",
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

function hostnameOf(origin: string | undefined): string | null {
	if (!origin) return null;
	try {
		return new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
	} catch {
		return null;
	}
}

/** A page host name (not an address): `localhost`, `127.x.y.z` or `::1`. */
function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		/^127(\.\d{1,3}){3}$/.test(hostname) ||
		hostname === "::1" ||
		hostname === "0:0:0:0:0:0:0:1"
	);
}

/** This machine's addresses, for pages opened through its LAN address. */
function ownAddresses(): Set<string> {
	const out = new Set<string>();
	try {
		for (const list of Object.values(os.networkInterfaces())) {
			for (const a of list ?? []) out.add(a.address.toLowerCase().replace(/%.*$/, ""));
		}
	} catch {
		// ignore
	}
	return out;
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
	call(method: BridgeMethod, args: unknown[], tab?: string, signal?: AbortSignal): Promise<{ status: number; body: unknown }>;
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

	const warnOnce = (key: string, message: string) => {
		if (warned.has(key)) return;
		warned.add(key);
		logger.warn(`[preact-devtools-overlay] ${message}`);
	};

	/** Pages served from these hosts may register as tabs. */
	const pageHostAllowed = (hostname: string): boolean => {
		if (isLoopbackHost(hostname) || ownAddresses().has(hostname)) return true;
		const { host, allowedHosts } = (server.config.server ?? {}) as { host?: unknown; allowedHosts?: unknown };
		if (typeof host === "string" && host.toLowerCase() === hostname) return true;
		if (allowedHosts === true) return true;
		if (Array.isArray(allowedHosts)) {
			return allowedHosts.some(h => {
				if (typeof h !== "string") return false;
				const allowed = h.toLowerCase();
				// ".example.com" allows example.com and its subdomains, like Vite.
				return allowed.startsWith(".")
					? hostname === allowed.slice(1) || hostname.endsWith(allowed)
					: hostname === allowed;
			});
		}
		return false;
	};

	const accept = (client: WsClient): boolean => {
		if (!allowRemote && !isLoopback(client.remote)) {
			warnOnce(
				`remote:${client.remote}`,
				`The agent bridge ignores tabs from other machines (${client.remote ?? "unknown address"}). Set agentBridge: { allowRemote: true } to allow them.`,
			);
			return false;
		}
		// Browsers always send Origin on websocket upgrades and pages can't
		// change it: this keeps other sites' pages from posing as a tab, even
		// with `allowRemote` (that's about where the browser runs).
		const hostname = hostnameOf(client.origin);
		if (hostname === null || !pageHostAllowed(hostname)) {
			warnOnce(
				`origin:${client.origin}`,
				`The agent bridge ignores a tab from ${client.origin ?? "a client without Origin"}: only pages from this dev server's hosts (localhost, server.host, server.allowedHosts) can answer agent requests.`,
			);
			return false;
		}
		return true;
	};

	const onMessage = (client: WsClient, event: string, data: unknown) => {
		if (event === EVENTS.hello) {
			if (!accept(client)) return;
			const state = normalizeState(data);
			if (state) tabs.upsert(client, state);
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
		const origin = req?.headers?.origin;
		const client: WsClient = {
			socket,
			remote: req?.socket?.remoteAddress,
			origin: typeof origin === "string" ? origin : undefined,
		};
		socket.on("message", raw => {
			// Anything can connect to the HMR socket: never let a message throw
			// into the dev server.
			try {
				const text = String(raw);
				// Cheap pre-check: this sees every HMR message.
				if (!text.includes('"preact-devtools-overlay:')) return;
				const msg: { type?: unknown; event?: unknown; data?: unknown } | null = JSON.parse(text);
				if (msg?.type === "custom" && typeof msg.event === "string") onMessage(client, msg.event, msg.data);
			} catch {
				// Ignore malformed messages.
			}
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

	async function call(method: BridgeMethod, args: unknown[], selector?: string, signal?: AbortSignal) {
		if (MUTATING_METHODS.has(method) && !allowUpdate) {
			return { status: 403, body: { ok: false, error: UPDATE_DISABLED(method) } };
		}
		if (pending.size >= MAX_PENDING) {
			return {
				status: 429,
				body: { ok: false, error: `${MAX_PENDING} calls are already waiting for a tab. Wait for them to finish.` },
			};
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
			// The caller hung up: stop waiting.
			signal?.addEventListener(
				"abort",
				() => {
					if (!pending.delete(id)) return;
					clearTimeout(timer);
					resolve({ id, ok: false, status: 499, error: "The caller went away." });
				},
				{ once: true },
			);
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
				error: `Missing or wrong token. Send "Authorization: Bearer <token>" with the token from ${file}.`,
			});
		}

		if (pathname === TABS_PATH) {
			if (req.method !== "GET") return send(res, 405, { ok: false, error: "Use GET." });
			return send(res, 200, { ok: true, tabs: tabs.list() });
		}

		if (req.method !== "POST") return send(res, 405, { ok: false, error: "Use POST." });
		const usage = "Body must be JSON: { method, args?, tab? }.";
		const abort = new AbortController();
		res.on("close", () => {
			if (!res.writableFinished) abort.abort();
		});
		const reply = (status: number, body: unknown) => {
			if (!res.headersSent && !res.destroyed) send(res, status, body);
		};
		readBody(req)
			.then(
				async raw => {
					let body: { method?: unknown; args?: unknown; tab?: unknown } | null;
					try {
						body = JSON.parse(raw);
					} catch {
						return reply(400, { ok: false, error: usage });
					}
					if (!body || typeof body !== "object") return reply(400, { ok: false, error: usage });
					if (!isBridgeMethod(body.method)) {
						return reply(400, { ok: false, error: `Unknown method ${JSON.stringify(body.method)}.` });
					}
					const args = body.args ?? [];
					if (!Array.isArray(args)) return reply(400, { ok: false, error: "args must be an array." });
					if (body.tab != null && typeof body.tab !== "string") {
						return reply(400, { ok: false, error: "tab must be a string: a tab id or part of its URL." });
					}
					const out = await call(body.method, args, body.tab ?? undefined, abort.signal);
					reply(out.status, out.body);
				},
				err => reply(413, { ok: false, error: err instanceof Error ? err.message : String(err) }),
			)
			.catch(err => reply(500, { ok: false, error: err instanceof Error ? err.message : String(err) }));
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
