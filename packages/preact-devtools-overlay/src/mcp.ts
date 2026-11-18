/**
 * `preact-devtools-overlay/mcp`: a stdio MCP server that exposes the agent
 * API of a page open in the Vite dev server, for agents that can't drive a
 * browser. It talks to the dev server's agent bridge (`src/bridge/server.ts`),
 * which relays each call to the tab over the HMR websocket.
 *
 *   npx preact-devtools-overlay-mcp [--root <dir>] [--url <origin> --token <token>]
 *
 * JSON-RPC 2.0 over newline-delimited stdio, hand-rolled so the package has no
 * runtime dependencies. Implements the initialize handshake revisions up to
 * 2025-11-25.
 */
import { createBridgeClient, type BridgeClient, type BridgeClientOptions } from "./bridge/client.js";
import type { BridgeMethod, TabInfo } from "./bridge/protocol.js";

declare const __PDO_VERSION__: string;
const VERSION = typeof __PDO_VERSION__ === "string" ? __PDO_VERSION__ : "0.0.0";

/** Newest first. Handshake-based revisions; 2026-07-28 and later dropped `initialize`. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** Longest text a tool returns, in characters. */
export const MAX_TOOL_TEXT = 100_000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export const ErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
} as const;

/** The part of the bridge client the tools need. */
export type ToolBridge = Pick<BridgeClient, "call" | "tabs">;

interface ToolDef {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly?: boolean;
	run(args: Record<string, unknown>, bridge: ToolBridge): Promise<string>;
}

const TAB = {
	type: "string",
	description:
		"Which tab to ask: a tab id from list_tabs, or part of its URL (e.g. \"/settings\"). Default: the most recently focused visible tab.",
} as const;
const TARGET_DESCRIPTION =
	'A component: its id ("#12" or "12", from get_tree/find; ids change on every page load), a component name ("TodoItem", must start with an uppercase letter) or a CSS selector ("[data-testid=save]").';
const FORMAT = {
	type: "string",
	enum: ["text", "json"],
	description: "\"text\" (default) is compact, one line per item. \"json\" returns structured data.",
} as const;
const SINCE = {
	type: "integer",
	description: "Only return entries recorded at or after this cursor (from the mark tool).",
} as const;

function schema(properties: Record<string, unknown>, required: string[] = []) {
	return {
		type: "object",
		properties: { ...properties, tab: TAB },
		...(required.length ? { required } : {}),
		additionalProperties: false,
	};
}

/** `"#12"` / `"12"` → 12, other strings stay names or selectors. */
export function toTarget(value: unknown): number | string {
	if (typeof value === "number") return value;
	if (typeof value !== "string" || !value.trim()) throw new Error("target must be a non-empty string");
	const m = /^#?(\d+)$/.exec(value.trim());
	return m ? Number(m[1]) : value;
}

function int(value: unknown, name: string): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`${name} must be an integer`);
	return n;
}

function str(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}

function format(args: Record<string, unknown>): "text" | "json" {
	const f = args.format ?? "text";
	if (f !== "text" && f !== "json") throw new Error('format must be "text" or "json"');
	return f;
}

/** Drops `undefined` values so the page sees the API's defaults. */
function opts(o: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function render(result: unknown): string {
	if (typeof result === "string") return result;
	return JSON.stringify(result, null, 2) ?? "null";
}

function tabLine(t: TabInfo): string {
	const flags = [
		t.visible ? "visible" : "hidden",
		t.focused ? "focused" : "",
		t.top ? "" : "iframe",
		t.default ? "default" : "",
	].filter(Boolean);
	return `${t.id}  ${t.url}${t.title ? `  "${t.title}"` : ""}  (${flags.join(", ")})`;
}

async function callApi(
	bridge: ToolBridge,
	method: BridgeMethod,
	args: unknown[],
	tabArg: unknown,
): Promise<string> {
	const { result } = await bridge.call(method, args, str(tabArg, "tab"));
	return render(result);
}

export const TOOLS: ToolDef[] = [
	{
		name: "list_tabs",
		title: "List connected tabs",
		description:
			"List the browser tabs connected to the Vite dev server that can answer the other tools: id, URL, title, visibility and focus. The tab marked \"default\" answers when a tool is called without `tab`. Use this when several tabs are open, or when a tool says no tab is connected.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		readOnly: true,
		async run(_args, bridge) {
			const tabs = await bridge.tabs();
			if (!tabs.length) return "No tabs connected. Open the app in a browser (served by the Vite dev server).";
			return tabs.map(tabLine).join("\n");
		},
	},
	{
		name: "get_tree",
		title: "Component tree",
		description:
			'The Preact component tree of the page, like the Components tab of Preact Devtools. Text format is one component per line, indented by depth: `Name #id [class key="1"]`. Use `root` and `depth` to show only part of a large tree.',
		inputSchema: schema({
			root: { type: "string", description: `Only show the subtree under this component. ${TARGET_DESCRIPTION}` },
			depth: { type: "integer", minimum: 0, description: "How many levels to show below the roots. Default: 50." },
			format: FORMAT,
		}),
		readOnly: true,
		run: (a, b) =>
			callApi(
				b,
				"getTree",
				[opts({ root: a.root === undefined ? undefined : toTarget(a.root), depth: int(a.depth, "depth"), format: format(a) })],
				a.tab,
			),
	},
	{
		name: "find",
		title: "Find components",
		description:
			"Find components by name (\"TodoItem\") or by a CSS selector for DOM elements they rendered (\"[data-testid=save]\", \"main .card\"). Returns id, name, kind, key and owner path for each match.",
		inputSchema: schema(
			{
				query: { type: "string", description: "A component name (must start with an uppercase letter) or a CSS selector." },
				limit: { type: "integer", minimum: 1, description: "Maximum number of matches. Default: 20." },
			},
			["query"],
		),
		readOnly: true,
		run: (a, b) => callApi(b, "find", [toTarget(a.query), opts({ limit: int(a.limit, "limit") })], a.tab),
	},
	{
		name: "inspect",
		title: "Inspect a component",
		description:
			"Props, class state, hooks (useState/useReducer/useSignal/... values in call order, custom hooks with their children), signals the component read in its last render, context, and the source location (file:line:column) of one component. Like selecting it in the Components tab, this re-runs its hooks to read them: inspect one component at a time, not every node of the tree.",
		inputSchema: schema(
			{
				target: { type: "string", description: TARGET_DESCRIPTION },
				maxBytes: { type: "integer", minimum: 1000, description: "Cut the answer to about this many bytes. Default: 20000." },
			},
			["target"],
		),
		readOnly: true,
		run: (a, b) => callApi(b, "inspect", [toTarget(a.target), opts({ maxBytes: int(a.maxBytes, "maxBytes") })], a.tab),
	},
	{
		name: "why_did_render",
		title: "Why did a component render",
		description:
			"The last renders of one component with the reason and the values that changed. Reasons: mount, signal (a signal it read changed), hooks (useState/useReducer value changed), state (class state changed), props (a prop changed value), parent (parent re-rendered and passed equal props, a candidate for memo()), force (forceUpdate or a context change).",
		inputSchema: schema(
			{
				target: { type: "string", description: TARGET_DESCRIPTION },
				last: { type: "integer", minimum: 1, description: "How many renders. Default: 5." },
				format: FORMAT,
			},
			["target"],
		),
		readOnly: true,
		run: (a, b) =>
			callApi(b, "whyDidRender", [toTarget(a.target), opts({ last: int(a.last, "last"), format: format(a) })], a.tab),
	},
	{
		name: "get_renders",
		title: "Render log",
		description:
			"Every component render recorded since page load (last 500), oldest first, with the commit, the reason (mount, signal, hooks, state, props, parent, force) and the changed values. Example line: `[20] commit 4: TodoItem #1942 props (todo.done: false → true) 0ms`. To see what one interaction caused: call mark, have the interaction happen, then call this with `since`. Without `since`, returns the last 50.",
		inputSchema: schema({
			since: SINCE,
			last: { type: "integer", minimum: 1, description: "Only the last N renders." },
			target: { type: "string", description: `Only renders of this component. ${TARGET_DESCRIPTION}` },
			format: FORMAT,
		}),
		readOnly: true,
		run: (a, b) =>
			callApi(
				b,
				"getRenders",
				[
					opts({
						since: int(a.since, "since"),
						last: int(a.last, "last"),
						target: a.target === undefined ? undefined : toTarget(a.target),
						format: format(a),
					}),
				],
				a.tab,
			),
	},
	{
		name: "mark",
		title: "Mark a point in time",
		description:
			"Returns a cursor. Pass it as `since` to get_renders or get_signal_updates to only see what happened after this call, e.g. after the user clicked something or after an HMR update.",
		inputSchema: schema({}),
		readOnly: true,
		async run(a, b) {
			const { result } = await b.call("mark", [], str(a.tab, "tab"));
			return `since: ${render(result)}`;
		},
	},
	{
		name: "get_signals",
		title: "Signals",
		description:
			"Preact signals and computeds the page created: current value, number of updates, and which components read them. Needs @preact/signals-debug, which the Vite plugin adds when the project uses signals. Name signals (`signal(v, { name: \"todos\" })`) to find them easily.",
		inputSchema: schema({
			name: { type: "string", description: "Only the signal(s) with this name." },
			format: FORMAT,
		}),
		readOnly: true,
		run: (a, b) => callApi(b, "getSignals", [opts({ name: str(a.name, "name"), format: format(a) })], a.tab),
	},
	{
		name: "get_signal_updates",
		title: "Signal updates",
		description:
			"Signal and computed value changes recorded since page load (last 2000), oldest first, with previous and new values and what triggered recomputations. Without `since`, returns the last 100.",
		inputSchema: schema({
			since: SINCE,
			last: { type: "integer", minimum: 1, description: "Only the last N updates." },
			name: { type: "string", description: "Only updates of the signal with this name." },
			format: FORMAT,
		}),
		readOnly: true,
		run: (a, b) =>
			callApi(
				b,
				"getSignalUpdates",
				[opts({ since: int(a.since, "since"), last: int(a.last, "last"), name: str(a.name, "name"), format: format(a) })],
				a.tab,
			),
	},
	{
		name: "get_signal_graph",
		title: "Signal dependency graph",
		description:
			"The signal dependency graph as JSON `{ nodes, links }`: signals, computeds, effects and the components that read them, with links from each dependency to its dependents.",
		inputSchema: schema({}),
		readOnly: true,
		run: (a, b) => callApi(b, "getSignalGraph", [], a.tab),
	},
	{
		name: "status",
		title: "Devtools status",
		description:
			"Diagnostics for the tab: whether Preact attached (renderers > 0), number of components and roots, whether @preact/signals-debug is loaded, and buffer sizes. Use it when other tools return empty results.",
		inputSchema: schema({}),
		readOnly: true,
		async run(a, b) {
			const { result, tab } = await b.call("status", [], str(a.tab, "tab"));
			return `tab ${tab.id}: ${tab.url}\n${render(result)}`;
		},
	},
	{
		name: "update",
		title: "Edit component state",
		description:
			'Change a value in a live component to test a hypothesis: kind "props" | "state" | "context" with a dot path ("todo.done"), or "hook" | "signal" with the index from inspect(). Changes app state, so the dev server rejects it unless the Vite plugin is configured with agentBridge: { allowUpdate: true }.',
		inputSchema: schema(
			{
				target: { type: "string", description: TARGET_DESCRIPTION },
				kind: { type: "string", enum: ["props", "state", "context", "hook", "signal"] },
				path: { type: "string", description: 'Dot path for props/state/context ("todo.done"), index for hook/signal ("0").' },
				value: { description: "The new value (any JSON value)." },
			},
			["target", "kind", "path", "value"],
		),
		readOnly: false,
		async run(a, b) {
			const kind = str(a.kind, "kind")!;
			const path = kind === "hook" || kind === "signal" ? int(a.path, "path") : str(a.path, "path");
			await b.call("update", [toTarget(a.target), kind, path, a.value], str(a.tab, "tab"));
			return "Updated.";
		},
	},
];

const INSTRUCTIONS = `Reads the live Preact component tree, render reasons and signals from a browser tab that has the app open on the Vite dev server (preact-devtools-overlay). The page must be open in a browser; if a tool says no tab is connected, ask the user to open it. Component ids change on every page load: get them from get_tree or find, or use component names and CSS selectors. To find out what an interaction re-rendered and why: mark, let the interaction happen, then get_renders with since.`;

function truncate(text: string): string {
	if (text.length <= MAX_TOOL_TEXT) return text;
	return `${text.slice(0, MAX_TOOL_TEXT)}\n… (${text.length - MAX_TOOL_TEXT} more characters cut. Narrow the query, e.g. get_tree with root and depth.)`;
}

function isId(id: unknown): id is string | number {
	return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

export interface McpServerOptions {
	bridge: ToolBridge;
	version?: string;
	/** Called with diagnostics. Defaults to nothing (stdout is the protocol channel). */
	log?(message: string): void;
}

/**
 * The protocol, without a transport: `handle()` takes one parsed JSON-RPC
 * message and returns the response to write, or `null` for notifications.
 */
export function createMcpServer(options: McpServerOptions) {
	const { bridge } = options;
	const version = options.version ?? VERSION;
	const tools = new Map(TOOLS.map(t => [t.name, t]));

	const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
	const fail = (id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse => ({
		jsonrpc: "2.0",
		id,
		error: { code, message, ...(data !== undefined ? { data } : {}) },
	});

	async function callTool(params: Record<string, unknown>) {
		const tool = typeof params.name === "string" ? tools.get(params.name) : undefined;
		if (!tool) return null;
		const args = params.arguments ?? {};
		try {
			if (typeof args !== "object" || Array.isArray(args) || args === null) {
				throw new Error("arguments must be an object");
			}
			const text = await tool.run(args as Record<string, unknown>, bridge);
			return { content: [{ type: "text", text: truncate(text) }] };
		} catch (err) {
			// Tool errors go back to the model, which can correct the call.
			return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
		}
	}

	async function handle(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
		if (Array.isArray(message)) {
			// JSON-RPC batches (only allowed by 2025-03-26, harmless to accept).
			if (!message.length) return fail(null, ErrorCode.InvalidRequest, "Empty batch");
			const out = (await Promise.all(message.map(m => handleOne(m)))).filter((r): r is JsonRpcResponse => r !== null);
			return out.length ? out : null;
		}
		return handleOne(message);
	}

	async function handleOne(message: unknown): Promise<JsonRpcResponse | null> {
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			return fail(null, ErrorCode.InvalidRequest, "Invalid request");
		}
		const msg = message as JsonRpcMessage;
		const hasId = "id" in msg && msg.id !== undefined;
		const id = hasId && isId(msg.id) ? msg.id : null;
		if (msg.jsonrpc !== "2.0") return hasId ? fail(id, ErrorCode.InvalidRequest, 'jsonrpc must be "2.0"') : null;
		if (typeof msg.method !== "string") {
			// A response to a request we never send, or garbage.
			return hasId && !("result" in msg || "error" in msg) ? fail(id, ErrorCode.InvalidRequest, "Missing method") : null;
		}
		if (!hasId) return null; // Notifications: initialized, cancelled, … nothing to do.
		if (!isId(msg.id)) return fail(null, ErrorCode.InvalidRequest, "id must be a string or a number");

		const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
		try {
			switch (msg.method) {
				case "initialize": {
					const requested = params.protocolVersion;
					const protocolVersion =
						typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
							? requested
							: SUPPORTED_PROTOCOL_VERSIONS[0];
					return ok(id, {
						protocolVersion,
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: "preact-devtools-overlay", title: "Preact Devtools", version },
						instructions: INSTRUCTIONS,
					});
				}
				case "ping":
					return ok(id, {});
				case "tools/list":
					return ok(id, {
						tools: TOOLS.map(t => ({
							name: t.name,
							title: t.title,
							description: t.description,
							inputSchema: t.inputSchema,
							annotations: {
								title: t.title,
								readOnlyHint: !!t.readOnly,
								...(t.readOnly ? {} : { destructiveHint: false, idempotentHint: true }),
								openWorldHint: false,
							},
						})),
					});
				case "tools/call": {
					const result = await callTool(params);
					if (!result) return fail(id, ErrorCode.InvalidParams, `Unknown tool: ${String(params.name)}`);
					return ok(id, result);
				}
				default:
					return fail(id, ErrorCode.MethodNotFound, `Method not found: ${msg.method}`);
			}
		} catch (err) {
			options.log?.(`internal error in ${msg.method}: ${err instanceof Error ? err.stack : String(err)}`);
			return fail(id, ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
		}
	}

	return { handle };
}

export interface StdioStreams {
	stdin: { on(event: "data", cb: (chunk: string | Uint8Array) => void): unknown; on(event: "end", cb: () => void): unknown };
	stdout: { write(data: string): unknown };
}

/** Reads newline-delimited JSON-RPC from `stdin` and writes responses to `stdout`. */
export function serveStdio(server: ReturnType<typeof createMcpServer>, io: StdioStreams): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	const inflight = new Set<Promise<void>>();
	const write = (msg: unknown) => {
		io.stdout.write(JSON.stringify(msg) + "\n");
	};
	const onLine = (line: string) => {
		if (!line.trim()) return;
		let parsed: Json;
		try {
			parsed = JSON.parse(line);
		} catch {
			write({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.ParseError, message: "Parse error" } });
			return;
		}
		// Requests are answered as they finish, not in order.
		const p = server.handle(parsed).then(res => {
			if (res) write(res);
		});
		inflight.add(p);
		p.finally(() => inflight.delete(p));
	};
	return new Promise(resolve => {
		io.stdin.on("data", chunk => {
			buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				onLine(line);
			}
		});
		io.stdin.on("end", () => {
			onLine(buffer);
			buffer = "";
			void Promise.allSettled([...inflight]).then(() => resolve());
		});
	});
}

const USAGE = `Usage: preact-devtools-overlay-mcp [options]

MCP server (stdio) for the Preact devtools of a page open in the Vite dev server.

Options:
  --root <dir>     Where to look for the dev server's
                   node_modules/.cache/preact-devtools-overlay/server.json
                   (default: the current directory, its parents and subdirectories)
  --url <origin>   Dev server origin, e.g. http://localhost:5173 (default: from server.json)
  --token <token>  Bridge token (default: from server.json)
  --timeout <ms>   Request timeout (default: 15000)

Environment: PREACT_DEVTOOLS_OVERLAY_ROOT, PREACT_DEVTOOLS_OVERLAY_URL,
PREACT_DEVTOOLS_OVERLAY_TOKEN.`;

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): BridgeClientOptions & { help?: boolean } {
	const out: BridgeClientOptions & { help?: boolean } = {
		root: env.PREACT_DEVTOOLS_OVERLAY_ROOT || undefined,
		url: env.PREACT_DEVTOOLS_OVERLAY_URL || undefined,
		token: env.PREACT_DEVTOOLS_OVERLAY_TOKEN || undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
		const value = () => {
			const v = inline ?? argv[++i];
			if (v === undefined) throw new Error(`${flag} needs a value`);
			return v;
		};
		switch (flag) {
			case "--root":
				out.root = value();
				break;
			case "--url":
				out.url = value();
				break;
			case "--token":
				out.token = value();
				break;
			case "--timeout":
				out.timeout = Number(value());
				if (!Number.isFinite(out.timeout) || out.timeout <= 0) throw new Error("--timeout must be a positive number");
				break;
			case "-h":
			case "--help":
				out.help = true;
				break;
			default:
				throw new Error(`Unknown option ${arg}`);
		}
	}
	return out;
}

/** Entry point of the `preact-devtools-overlay-mcp` bin. */
export async function runMcpServer(argv: string[] = process.argv.slice(2)): Promise<void> {
	let options: ReturnType<typeof parseArgs>;
	try {
		options = parseArgs(argv, process.env);
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	const server = createMcpServer({
		bridge: createBridgeClient(options),
		log: message => process.stderr.write(`[preact-devtools-overlay-mcp] ${message}\n`),
	});
	await serveStdio(server, { stdin: process.stdin, stdout: process.stdout });
}
