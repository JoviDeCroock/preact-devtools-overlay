/**
 * Page-side history of `@preact/signals-debug` updates.
 *
 * signals-debug drops updates while nobody listens, and the Signals pane is
 * only loaded when its tab is first opened, so everything that happened
 * during startup used to be lost. The client subscribes as soon as
 * signals-debug defines `window.__PREACT_SIGNALS_DEVTOOLS__`, keeps a bounded
 * history, and hands the pane a relay that replays it on connect.
 */
import { RingBuffer } from "./ring-buffer.js";

/** Mirrors `FormattedSignalUpdate` from `@preact/signals-debug`. */
export interface SignalUpdate {
	type: "update" | "effect" | "component";
	signalType: "signal" | "computed" | "effect" | "component";
	signalName: string;
	signalId: string;
	prevValue?: unknown;
	newValue?: unknown;
	timestamp: number;
	depth: number;
	subscribedTo?: string;
	allDependencies?: Array<{ id: string; name: string; type: "signal" | "computed" }>;
	recomputed?: true;
	outputChanged?: boolean;
}

/** Mirrors `FormattedSignalDisposed` from `@preact/signals-debug`. */
export interface SignalDisposal {
	type: "disposed";
	signalType: "signal" | "computed" | "effect" | "component";
	signalName: string;
	signalId: string;
	timestamp: number;
}

/** The subset of `SignalsDevToolsAPI` (signals-debug) we use. */
export interface SignalsDebugApi {
	onUpdate(cb: (updates: SignalUpdate[]) => void): () => void;
	onDisposal?(cb: (disposals: SignalDisposal[]) => void): () => void;
	onInit(cb: () => void): () => void;
	sendConfig?(config: unknown): void;
	sendUpdate?(updates: unknown[]): void;
	sendDisposal?(...args: unknown[]): void;
}

const GUARDED = Symbol.for("preact-devtools-overlay.guarded");
let warned = false;

/**
 * signals-debug only formats updates while someone listens, and its
 * formatter throws on values with a throwing getter. That happens inside its
 * flush microtask, before it resets its `scheduled` flag, so every later
 * update would be lost. Since we listen from page load (not only while the
 * Signals pane is open), contain that here.
 */
function guardSignalsDebug(api: SignalsDebugApi) {
	for (const name of ["sendUpdate", "sendDisposal"] as const) {
		const fn = api[name] as any;
		if (typeof fn !== "function" || fn[GUARDED]) continue;
		const guarded = function (this: unknown, ...args: unknown[]) {
			try {
				return fn.apply(this, args);
			} catch (err) {
				if (!warned) {
					warned = true;
					console.warn("[preact-devtools-overlay] @preact/signals-debug failed to report a signal update.", err);
				}
			}
		};
		(guarded as any)[GUARDED] = true;
		try {
			(api as any)[name] = guarded;
		} catch {
			// Frozen: nothing we can do.
		}
	}
}

export interface KnownSignal {
	id: string;
	name: string;
	type: SignalUpdate["signalType"];
	/** Last value reported by an update (signals and computeds only). */
	value?: unknown;
	hasValue: boolean;
	updates: number;
	lastUpdate: number;
	/** Ids of the signals/computeds this one last depended on. */
	dependencies: string[];
	disposed: boolean;
}

export const SIGNALS_GLOBAL = "__PREACT_SIGNALS_DEVTOOLS__";
export const PROBE_EFFECT_NAME = "preact-devtools-overlay:probe";
/** Updates kept for the agent API and for replay into the Signals pane. */
export const MAX_SIGNAL_UPDATES = 2000;
/** Upper bound for `known`, so a page creating signals in a loop can't grow it forever. */
const MAX_KNOWN_SIGNALS = 5000;

export class SignalsStore {
	readonly updates: RingBuffer<{ batch: number; update: SignalUpdate }>;
	readonly disposals: RingBuffer<SignalDisposal>;
	readonly known = new Map<string, KnownSignal>();
	api: SignalsDebugApi | null = null;
	#batch = 0;
	#updateListeners = new Set<(updates: SignalUpdate[]) => void>();
	#disposalListeners = new Set<(disposals: SignalDisposal[]) => void>();
	#unsubscribe: Array<() => void> = [];

	constructor(nextSeq: () => number) {
		this.updates = new RingBuffer(MAX_SIGNAL_UPDATES, nextSeq);
		this.disposals = new RingBuffer(500, nextSeq);
	}

	/** Subscribes to signals-debug. Safe to call again with a new API object. */
	attach(api: SignalsDebugApi) {
		if (this.api === api) return;
		this.#unsubscribe.forEach(fn => fn());
		this.#unsubscribe = [];
		this.api = api;
		guardSignalsDebug(api);
		this.#unsubscribe.push(api.onUpdate(updates => this.#onUpdates(updates)));
		if (api.onDisposal) {
			this.#unsubscribe.push(api.onDisposal(disposals => this.#onDisposals(disposals)));
		}
	}

	/** Called with every batch of updates (after it was recorded). */
	onUpdates(cb: (updates: SignalUpdate[]) => void): () => void {
		this.#updateListeners.add(cb);
		return () => this.#updateListeners.delete(cb);
	}

	#onUpdates(updates: SignalUpdate[]) {
		if (!Array.isArray(updates)) return;
		// Our own probe effect (registry.ts), created before the app runs.
		updates = updates.filter(u => u?.signalName !== PROBE_EFFECT_NAME);
		if (updates.length === 0) return;
		const batch = ++this.#batch;
		for (const update of updates) {
			this.updates.push({ batch, update });
			this.#track(update);
		}
		this.#updateListeners.forEach(cb => {
			try {
				cb(updates);
			} catch {
				// A listener must not stop the others (or signals-debug).
			}
		});
	}

	#onDisposals(disposals: SignalDisposal[]) {
		if (!Array.isArray(disposals)) return;
		for (const d of disposals) {
			this.disposals.push(d);
			const known = this.known.get(d.signalId);
			if (known) known.disposed = true;
		}
		this.#disposalListeners.forEach(cb => cb(disposals));
	}

	#track(update: SignalUpdate) {
		let known = this.known.get(update.signalId);
		if (!known) {
			if (this.known.size >= MAX_KNOWN_SIGNALS) {
				// Evict the least recently updated entry.
				let oldest: KnownSignal | undefined;
				for (const k of this.known.values()) {
					if (!oldest || k.lastUpdate < oldest.lastUpdate) oldest = k;
				}
				if (oldest) this.known.delete(oldest.id);
			}
			known = {
				id: update.signalId,
				name: update.signalName,
				type: update.signalType,
				hasValue: false,
				updates: 0,
				lastUpdate: update.timestamp,
				dependencies: [],
				disposed: false,
			};
			this.known.set(update.signalId, known);
		}
		known.name = update.signalName;
		// signals-debug reports a disposal when the last subscriber leaves; the
		// same signal can be subscribed to (and update) again later.
		known.disposed = false;
		known.updates++;
		known.lastUpdate = update.timestamp;
		if (update.type === "update" && "newValue" in update) {
			known.value = update.newValue;
			known.hasValue = true;
		}
		if (update.allDependencies) known.dependencies = update.allDependencies.map(d => d.id);
		for (const dep of update.allDependencies ?? []) {
			if (!this.known.has(dep.id) && this.known.size < MAX_KNOWN_SIGNALS) {
				this.known.set(dep.id, {
					id: dep.id,
					name: dep.name,
					type: dep.type,
					hasValue: false,
					updates: 0,
					lastUpdate: update.timestamp,
					dependencies: [],
					disposed: false,
				});
			}
		}
	}

	/** Buffered updates regrouped into their original batches. */
	#batches(): SignalUpdate[][] {
		const out: SignalUpdate[][] = [];
		let current = -1;
		for (const { value } of this.updates.read()) {
			if (value.batch !== current) {
				current = value.batch;
				out.push([]);
			}
			out[out.length - 1].push(value.update);
		}
		return out;
	}

	/**
	 * A stand-in for `window` to give the Signals pane's `DirectAdapter`: it
	 * looks the same, but `onUpdate`/`onDisposal` first replay the history.
	 */
	/**
	 * Re-attaches if `win.__PREACT_SIGNALS_DEVTOOLS__` was replaced in a way
	 * our accessor didn't see (e.g. `Object.defineProperty`).
	 */
	sync(win: Window) {
		try {
			const live = (win as any)[SIGNALS_GLOBAL];
			if (live && typeof live.onUpdate === "function" && live !== this.api) this.attach(live);
		} catch {
			// ignore
		}
	}

	relayWindow(win: Window): Window {
		const store = this;
		const relay = {
			onUpdate(cb: (updates: SignalUpdate[]) => void) {
				for (const batch of store.#batches()) cb(batch);
				store.#updateListeners.add(cb);
				return () => store.#updateListeners.delete(cb);
			},
			onDisposal(cb: (disposals: SignalDisposal[]) => void) {
				const past = store.disposals.read().map(x => x.value);
				if (past.length) cb(past);
				store.#disposalListeners.add(cb);
				return () => store.#disposalListeners.delete(cb);
			},
			onInit(cb: () => void) {
				return store.api ? store.api.onInit(cb) : () => {};
			},
			sendConfig(config: unknown) {
				store.api?.sendConfig?.(config);
			},
		};
		return {
			get [SIGNALS_GLOBAL]() {
				store.sync(win);
				return store.api ? relay : undefined;
			},
			postMessage: (message: unknown, targetOrigin: string) =>
				win.postMessage(message, targetOrigin),
			location: win.location,
		} as unknown as Window;
	}
}

/**
 * Calls `onApi` with signals-debug's API as soon as it is defined on `win`
 * (signals-debug is imported after our client), and on every redefinition.
 */
export function watchSignalsDebug(win: Window, onApi: (api: SignalsDebugApi) => void) {
	const w = win as any;
	let current = w[SIGNALS_GLOBAL];
	if (current) onApi(current);
	const desc = Object.getOwnPropertyDescriptor(w, SIGNALS_GLOBAL);
	if (desc && !desc.configurable) return;
	// Someone else's accessor: keep it working and observe through it.
	const get = desc?.get;
	const set = desc?.set;
	try {
		Object.defineProperty(w, SIGNALS_GLOBAL, {
			configurable: true,
			enumerable: true,
			get: get ? () => get.call(w) : () => current,
			set(api) {
				if (set) set.call(w, api);
				current = get ? get.call(w) : api;
				if (current) onApi(current);
			},
		});
	} catch {
		// Fall back to whatever the pane/agent API finds later.
	}
}
