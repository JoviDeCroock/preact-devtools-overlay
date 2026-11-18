/**
 * Node-side client for the dev server's agent bridge (`server.ts`): finds the
 * running dev server through `server.json` and calls the HTTP endpoints.
 */
import fs from "node:fs";
import path from "node:path";
import {
	API_PATH,
	SERVER_INFO_FILE,
	TABS_PATH,
	type BridgeMethod,
	type ServerInfo,
	type TabInfo,
} from "./protocol.js";

export interface BridgeClientOptions {
	/** Directory to look for `server.json` in (the Vite root, or a parent/child of it). */
	root?: string;
	/** Dev server origin, e.g. `http://localhost:5173`. Overrides `server.json`. */
	url?: string;
	/** Overrides the token from `server.json`. */
	token?: string;
	/** Request timeout in ms. Defaults to 15000 (the dev server waits 10000 for the page). */
	timeout?: number;
}

export interface TabSummary {
	id: string;
	url: string;
	title: string;
}

export class BridgeError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "BridgeError";
	}
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

function readInfo(file: string): { file: string; info: ServerInfo; mtime: number } | null {
	try {
		const stat = fs.statSync(file);
		const info = JSON.parse(fs.readFileSync(file, "utf8")) as ServerInfo;
		if (!info || typeof info.token !== "string") return null;
		return { file, info, mtime: stat.mtimeMs };
	} catch {
		return null;
	}
}

function children(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter(d => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name))
			.map(d => path.join(dir, d.name));
	} catch {
		return [];
	}
}

/**
 * The `server.json` of a running dev server: in `start` or one of its
 * parents, else in a child or grandchild directory (monorepos, where the
 * agent runs from the repository root). The newest one wins.
 */
export function findServerInfo(start: string): { file: string; info: ServerInfo } | null {
	for (let dir = path.resolve(start); ; ) {
		const found = readInfo(path.join(dir, SERVER_INFO_FILE));
		if (found) return found;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const candidates: Array<{ file: string; info: ServerInfo; mtime: number }> = [];
	for (const child of children(path.resolve(start))) {
		for (const dir of [child, ...children(child)]) {
			const found = readInfo(path.join(dir, SERVER_INFO_FILE));
			if (found) candidates.push(found);
		}
	}
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates[0] ?? null;
}

export function createBridgeClient(options: BridgeClientOptions = {}) {
	const root = path.resolve(options.root ?? process.cwd());
	const timeout = options.timeout ?? 15_000;

	/** Read on every request: the dev server may have restarted. */
	function target(): { url: string; token: string; file: string | null } {
		const found = options.url && options.token ? null : findServerInfo(root);
		const url = options.url ?? found?.info.url ?? null;
		const token = options.token ?? found?.info.token ?? null;
		if (!found && !(options.url && options.token)) {
			throw new BridgeError(
				`No running Vite dev server with preact-devtools-overlay found: there is no ${SERVER_INFO_FILE} in ${root}, its parents or subdirectories. ` +
					"Start the dev server (with the preactDevtoolsOverlay() plugin, agentApi and agentBridge on), or pass --root <vite root>.",
			);
		}
		if (!url) {
			throw new BridgeError(`${found?.file} has no URL (Vite middleware mode?). Pass --url <dev server origin>.`);
		}
		if (!token) throw new BridgeError("No token. Pass --token, or --root so server.json can be found.");
		return { url: url.replace(/\/+$/, ""), token, file: found?.file ?? null };
	}

	async function request(pathname: string, init: { method: string; body?: unknown }): Promise<any> {
		const { url, token, file } = target();
		let res: Response;
		try {
			res = await fetch(url + pathname, {
				method: init.method,
				headers: {
					authorization: `Bearer ${token}`,
					...(init.body !== undefined ? { "content-type": "application/json" } : {}),
				},
				body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
				signal: AbortSignal.timeout(timeout),
			});
		} catch (err) {
			const cause = (err as { cause?: { code?: string } })?.cause?.code;
			if ((err as Error)?.name === "TimeoutError") {
				throw new BridgeError(`The dev server at ${url} didn't answer within ${timeout}ms.`);
			}
			throw new BridgeError(
				`Could not reach the dev server at ${url}${cause ? ` (${cause})` : ""}.` +
					(file ? ` ${file} may be left over from a dev server that is no longer running.` : ""),
			);
		}
		let body: any;
		try {
			body = await res.json();
		} catch {
			throw new BridgeError(
				`${url}${pathname} answered ${res.status} without JSON. Is the preact-devtools-overlay plugin enabled with agentBridge on?`,
				res.status,
			);
		}
		if (!res.ok || !body?.ok) throw new BridgeError(String(body?.error ?? `HTTP ${res.status}`), res.status);
		return body;
	}

	return {
		/** Calls `window.__PREACT_DEVTOOLS_OVERLAY__.api[method](...args)` in a tab. */
		async call(method: BridgeMethod, args: unknown[] = [], tab?: string): Promise<{ result: unknown; tab: TabSummary }> {
			const body = await request(API_PATH, { method: "POST", body: { method, args, ...(tab ? { tab } : {}) } });
			return { result: body.result, tab: body.tab };
		},
		async tabs(): Promise<TabInfo[]> {
			const body = await request(TABS_PATH, { method: "GET" });
			return body.tabs;
		},
	};
}

export type BridgeClient = ReturnType<typeof createBridgeClient>;
