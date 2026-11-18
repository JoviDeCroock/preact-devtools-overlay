/**
 * Shared by the three parts of the agent bridge:
 *
 *   MCP server / curl ──HTTP──► Vite dev server ──HMR websocket──► page
 *   (src/mcp.ts)                (src/bridge/server.ts)             (src/bridge/page.ts)
 *
 * Browser-safe: no Node imports.
 */

/** `POST { method, args?, tab? }` → `{ ok, result, tab }`. */
export const API_PATH = "/__preact-devtools-overlay/api";
/** `GET` → `{ tabs }`. */
export const TABS_PATH = "/__preact-devtools-overlay/tabs";

/** Custom HMR events (`import.meta.hot.send` / `server.ws.on`). */
export const EVENTS = {
	/** page → server: a tab connected, or reconnected. Payload: `TabState`. */
	hello: "preact-devtools-overlay:hello",
	/** page → server: url, title, visibility or focus changed. Payload: `TabState`. */
	state: "preact-devtools-overlay:state",
	/** server → page. Payload: `BridgeRequest`. */
	request: "preact-devtools-overlay:request",
	/** page → server. Payload: `BridgeResponse`. */
	response: "preact-devtools-overlay:response",
} as const;

/**
 * Agent API methods that can be called through the bridge. Everything here
 * only reads, except `update` (needs `agentBridge: { allowUpdate: true }`)
 * and the recording cursor of `startRecording` / `stopRecording`.
 */
export const BRIDGE_METHODS = [
	"help",
	"status",
	"getTree",
	"find",
	"inspect",
	"getRenders",
	"whyDidRender",
	"mark",
	"startRecording",
	"stopRecording",
	"getSignals",
	"getSignalUpdates",
	"getSignalGraph",
	"getLeaks",
	"getRemounts",
	"update",
] as const;
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/** Methods that change the app's state. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set(["update"]);

export function isBridgeMethod(method: unknown): method is BridgeMethod {
	return typeof method === "string" && (BRIDGE_METHODS as readonly string[]).includes(method);
}

/** What a page reports about itself. */
export interface TabState {
	url: string;
	title: string;
	/** `document.visibilityState === "visible"` */
	visible: boolean;
	/** `document.hasFocus()` */
	focused: boolean;
	/** `false` inside an iframe. */
	top: boolean;
}

/** A connected tab, as listed by `GET /__preact-devtools-overlay/tabs`. */
export interface TabInfo extends TabState {
	id: string;
	/** ms since epoch (server clock) the tab was last seen focused or visible. */
	lastActive: number;
	connectedAt: number;
	/** The tab requests go to when no `tab` is given. */
	default: boolean;
}

export interface BridgeRequest {
	id: number;
	method: BridgeMethod;
	args: unknown[];
}

export type BridgeResponse =
	| { id: number; ok: true; result: unknown; state: TabState }
	| { id: number; ok: false; error: string; code?: BridgeErrorCode; state?: TabState };

export type BridgeErrorCode =
	| "no-api"
	| "not-allowed"
	| "unknown-method"
	| "not-serializable"
	| "error";

/**
 * What the dev server writes to `server.json` (see `info.ts` for where), for
 * the MCP server to find it.
 */
export interface ServerInfo {
	/** Origin of the dev server, e.g. `http://localhost:5173`. `null` in middleware mode. */
	url: string | null;
	/** Send as `Authorization: Bearer <token>`. */
	token: string;
	pid: number;
	/** Vite root. */
	root: string;
	version: string;
}
