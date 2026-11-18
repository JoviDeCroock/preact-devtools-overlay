/**
 * Page side of the agent bridge. The Vite plugin's entry module calls
 *
 *   if (import.meta.hot) connectBridge(import.meta.hot, { allowUpdate });
 *
 * so the dev server can relay agent API calls to this tab over the HMR
 * websocket (see `server.ts`).
 */
import {
	EVENTS,
	MUTATING_METHODS,
	isBridgeMethod,
	type BridgeRequest,
	type BridgeResponse,
	type TabState,
} from "./protocol.js";
import type {} from "../shared.js";

/** The subset of Vite's `import.meta.hot` we use. */
export interface HotChannel {
	send(event: string, data?: unknown): void;
	on(event: string, cb: (data: any) => void): void;
}

export interface BridgeOptions {
	/** Relay `update()`, which changes app state. Defaults to `false`. */
	allowUpdate?: boolean;
}

export function tabState(): TabState {
	return {
		url: location.href,
		title: document.title,
		visible: document.visibilityState === "visible",
		focused: document.hasFocus(),
		top: window.top === window,
	};
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function handleRequest(
	req: BridgeRequest,
	options: BridgeOptions = {},
): Promise<BridgeResponse> {
	const id = req.id;
	if (!isBridgeMethod(req.method)) {
		return { id, ok: false, code: "unknown-method", error: `Unknown method ${JSON.stringify(req.method)}` };
	}
	if (MUTATING_METHODS.has(req.method) && !options.allowUpdate) {
		return {
			id,
			ok: false,
			code: "not-allowed",
			error: `${req.method}() changes app state and is disabled over the bridge. Enable it with preactDevtoolsOverlay({ agentBridge: { allowUpdate: true } }).`,
		};
	}
	const api = window.__PREACT_DEVTOOLS_OVERLAY__?.api;
	if (!api) {
		return {
			id,
			ok: false,
			code: "no-api",
			state: tabState(),
			error: window.__PREACT_DEVTOOLS_OVERLAY__
				? "The agent API is disabled on this page (agentApi: false)."
				: "preact-devtools-overlay/client is not loaded on this page.",
		};
	}
	let result: unknown;
	try {
		const fn = api[req.method] as (...args: unknown[]) => unknown;
		result = await fn(...(Array.isArray(req.args) ? req.args : []));
	} catch (err) {
		return { id, ok: false, code: "error", error: message(err), state: tabState() };
	}
	try {
		// Vite stringifies the payload; check here so a bad value becomes an
		// error answer instead of a request that never returns.
		result = result === undefined ? null : JSON.parse(JSON.stringify(result));
	} catch (err) {
		return {
			id,
			ok: false,
			code: "not-serializable",
			error: `${req.method}() returned a value that can't be sent as JSON: ${message(err)}`,
			state: tabState(),
		};
	}
	return { id, ok: true, result, state: tabState() };
}

let connected = false;

export function connectBridge(hot: HotChannel, options: BridgeOptions = {}): void {
	if (connected || typeof window === "undefined") return;
	connected = true;

	let last = "";
	const report = (event: string) => {
		const state = tabState();
		const key = JSON.stringify(state);
		if (event === EVENTS.state && key === last) return;
		last = key;
		hot.send(event, state);
	};

	hot.on(EVENTS.request, (req: BridgeRequest) => {
		void handleRequest(req, options).then(res => hot.send(EVENTS.response, res));
	});
	// Sends are queued until the socket is open. Say hello again after a
	// reconnect, the server forgets tabs whose socket closed.
	report(EVENTS.hello);
	hot.on("vite:ws:connect", () => report(EVENTS.hello));

	const update = () => report(EVENTS.state);
	for (const type of ["focus", "blur", "pageshow", "popstate", "hashchange"]) {
		window.addEventListener(type, update);
	}
	document.addEventListener("visibilitychange", update);
	// Client-side navigations that don't fire events (pushState) and title
	// changes are picked up with every answer, and on this slow poll.
	setInterval(update, 5000);
}
