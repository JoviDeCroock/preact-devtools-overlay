/**
 * Turns arbitrary page values into small, JSON-safe data for agents.
 *
 * Everything returned by the agent API passes through here: values end up in
 * a model's context window, so depth, breadth and string length are capped,
 * and anything that isn't plain data (functions, DOM nodes, vnodes, signals)
 * becomes a short descriptive string or object.
 */

export interface ValueLimits {
	/** Nesting depth below which objects/arrays are summarized. Default 3. */
	depth?: number;
	/** Max keys/items per object/array. Default 30. */
	breadth?: number;
	/** Max string length. Default 200. */
	string?: number;
}

const DEFAULTS: Required<ValueLimits> = { depth: 3, breadth: 30, string: 200 };

function isSignalLike(x: any): boolean {
	return (
		x !== null &&
		typeof x === "object" &&
		typeof x.peek === "function" &&
		typeof x.subscribe === "function"
	);
}

function isVNodeLike(x: any): boolean {
	return (
		x !== null &&
		typeof x === "object" &&
		"type" in x &&
		"props" in x &&
		// Preact 10: `constructor: undefined`; Preact 11: a marker symbol.
		(x.constructor === undefined || typeof x.constructor === "symbol") &&
		!isSignalLike(x)
	);
}

function typeName(type: any): string {
	if (typeof type === "string") return type;
	if (typeof type === "function") return type.displayName || type.name || "Anonymous";
	return "Fragment";
}

function elementLabel(el: Element): string {
	let out = `<${el.localName}`;
	if (el.id) out += `#${el.id}`;
	const cls = typeof el.className === "string" ? el.className.trim() : "";
	if (cls) out += "." + cls.split(/\s+/).slice(0, 3).join(".");
	return out + ">";
}

function truncateString(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

/** Signals have a name when created with `signal(v, { name })`. */
export function signalName(s: any): string | undefined {
	const name = s?.displayName ?? s?.name;
	return typeof name === "string" && name ? name : undefined;
}

/**
 * Serializes a live page value. Never throws, never runs getters on plain
 * objects and never reads signal `.value` (only `.peek()`).
 */
export function toAgentValue(value: unknown, limits: ValueLimits = {}): unknown {
	const opts = { ...DEFAULTS, ...limits };
	const seen = new WeakSet<object>();

	const walk = (v: any, depth: number): unknown => {
		switch (typeof v) {
			case "string":
				return truncateString(v, opts.string);
			case "number":
				return Number.isFinite(v) ? v : String(v);
			case "boolean":
				return v;
			case "undefined":
				return undefined;
			case "bigint":
				return `${v}n`;
			case "symbol":
				return v.toString();
			case "function":
				return `[Function ${v.displayName || v.name || "anonymous"}]`;
		}
		if (v === null) return null;

		try {
			if (isSignalLike(v)) {
				const out: Record<string, unknown> = {
					$signal: signalName(v) ?? (typeof v.x === "function" ? "computed" : "signal"),
				};
				out.value = depth >= opts.depth ? "[…]" : walk(v.peek(), depth + 1);
				return out;
			}
			if (typeof Element !== "undefined" && v instanceof Element) return elementLabel(v);
			if (typeof Node !== "undefined" && v instanceof Node) return `[${v.nodeName}]`;
			if (isVNodeLike(v)) return `<${typeName(v.type)} />`;
			if (v instanceof Date) return Number.isNaN(+v) ? "Invalid Date" : v.toISOString();
			if (v instanceof RegExp) return v.toString();
			if (v instanceof Error) return `${v.name}: ${truncateString(v.message, opts.string)}`;
			if (typeof Promise !== "undefined" && v instanceof Promise) return "[Promise]";

			if (seen.has(v)) return "[Circular]";
			if (depth >= opts.depth) {
				if (Array.isArray(v)) return `[Array(${v.length})]`;
				if (v instanceof Map) return `[Map(${v.size})]`;
				if (v instanceof Set) return `[Set(${v.size})]`;
				return `[Object]`;
			}
			seen.add(v);

			if (Array.isArray(v)) {
				// Only read the items we keep: big arrays cost nothing extra.
				const n = Math.min(v.length, opts.breadth);
				const out: unknown[] = [];
				for (let i = 0; i < n; i++) out.push(walk(v[i], depth + 1));
				if (v.length > n) out.push(`… ${v.length - n} more`);
				return out;
			}
			if (v instanceof Set) {
				const out: unknown[] = [];
				for (const x of v) {
					if (out.length >= opts.breadth) break;
					out.push(walk(x, depth + 1));
				}
				if (v.size > out.length) out.push(`… ${v.size - out.length} more`);
				return { $set: out };
			}
			if (v instanceof Map) {
				const out: unknown[] = [];
				for (const [k, val] of v) {
					if (out.length >= opts.breadth) break;
					out.push([walk(k, depth + 1), walk(val, depth + 1)]);
				}
				if (v.size > out.length) out.push([`… ${v.size - out.length} more`, null]);
				return { $map: out };
			}

			const out: Record<string, unknown> = {};
			const keys = Object.keys(v);
			for (const key of keys.slice(0, opts.breadth)) {
				// Never run getters: they can have side effects, and this runs
				// while recording renders, without anyone asking.
				const desc = Object.getOwnPropertyDescriptor(v, key);
				out[key] = !desc ? undefined : "value" in desc ? walk(desc.value, depth + 1) : "[Getter]";
			}
			if (keys.length > opts.breadth) out["…"] = `${keys.length - opts.breadth} more keys`;
			return out;
		} catch {
			return "[Unreadable]";
		}
	};

	return walk(value, 0);
}

/**
 * Converts the adapter's serialized format (as sent to the Components panel,
 * see the vendored `shared/serialize.ts`) into the same shape as
 * `toAgentValue`.
 */
export function fromSerialized(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(fromSerialized);
	if (value === "[[Circular]]") return "[Circular]";
	if (value === null || typeof value !== "object") return value;

	const v = value as Record<string, any>;
	const keys = Object.keys(v);
	const special = typeof v.type === "string" && keys.every(k => ["type", "name", "value", "entries"].includes(k));
	if (special) {
		switch (v.type) {
			case "function":
				return `[Function ${v.name}]`;
			case "vnode":
				return `<${v.name} />`;
			case "html":
				return v.name;
			case "symbol":
				return v.name;
			case "blob":
				return "[Blob]";
			case "bigint":
				return `${v.value}n`;
			case "signal":
				return {
					$signal: v.name === "computed Signal" ? "computed" : "signal",
					value: fromSerialized(v.value),
				};
			case "set":
				return { $set: fromSerialized(v.entries) };
			case "map":
				return { $map: fromSerialized(v.entries) };
		}
	}
	const out: Record<string, unknown> = {};
	for (const key of keys) out[key] = fromSerialized(v[key]);
	return out;
}

/** One-line, length-capped rendering for the text output formats. */
export function preview(value: unknown, max = 80): string {
	let s: string;
	if (typeof value === "string") s = JSON.stringify(value);
	else if (value === undefined) s = "undefined";
	else {
		try {
			s = JSON.stringify(value) ?? String(value);
		} catch {
			s = String(value);
		}
	}
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function isPlainContainer(x: unknown): x is Record<string, unknown> {
	return x !== null && typeof x === "object";
}

/**
 * Describes how `next` differs from `prev` (agent values), e.g.
 * `todo.done: false → true`. Objects are compared key by key so the text
 * shows the part that changed instead of two truncated, identical prefixes.
 */
export function describeChange(key: string, prev: unknown, next: unknown, max = 3): string[] {
	const out: string[] = [];
	const walk = (path: string, a: unknown, b: unknown, depth: number) => {
		if (out.length >= max) return;
		if (isPlainContainer(a) && isPlainContainer(b) && depth < 4) {
			const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
			let before = out.length;
			for (const k of keys) {
				const pa = (a as any)[k];
				const pb = (b as any)[k];
				if (JSON.stringify(pa) !== JSON.stringify(pb)) {
					walk(Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`, pa, pb, depth + 1);
				}
				if (out.length >= max) break;
			}
			// Same serialized content: a new object with equal values.
			if (out.length === before) out.push(`${path}: new object, same value`);
			return;
		}
		out.push(`${path}: ${preview(a, 40)} → ${preview(b, 40)}`);
	};
	walk(key, prev, next, 0);
	return out;
}

/** Collapses nested data below `depth` and shortens strings, for shrinking already-serialized output. */
function collapse(value: unknown, depth: number, maxString: number): unknown {
	if (typeof value === "string") {
		return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
	}
	if (value === null || typeof value !== "object") return value;
	if (depth <= 0) return Array.isArray(value) ? `[Array(${value.length})]` : "[Object]";
	if (Array.isArray(value)) return value.map(x => collapse(x, depth - 1, maxString));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = collapse(v, depth - 1, maxString);
	return out;
}

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

/** Size of the value as UTF-8 JSON. */
function byteLength(value: unknown): number {
	try {
		const json = JSON.stringify(value) ?? "";
		return encoder ? encoder.encode(json).length : json.length;
	} catch {
		return Infinity;
	}
}

/**
 * Shrinks `value` until its JSON fits in `maxBytes` (UTF-8): collapses deep
 * values first, then shortens strings, and as a last resort keeps only short
 * top-level scalars. Adds `truncated: true` when anything was dropped.
 */
export function fitToBudget<T extends Record<string, unknown>>(value: T, maxBytes: number): T {
	if (byteLength(value) <= maxBytes) return value;
	for (const maxString of [200, 60, 20]) {
		for (let depth = 4; depth >= 1; depth--) {
			const out = { ...(collapse(value, depth, maxString) as T), truncated: true };
			if (byteLength(out) <= maxBytes) return out;
		}
	}
	const out: Record<string, unknown> = { truncated: true };
	for (const [key, v] of Object.entries(value)) {
		if (v !== null && typeof v === "object") continue;
		const candidate = { ...out, [key]: collapse(v, 0, 20) };
		if (byteLength(candidate) <= maxBytes) out[key] = candidate[key];
	}
	return out as T;
}
