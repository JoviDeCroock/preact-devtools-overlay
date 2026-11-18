/**
 * Every signal, computed and effect the app creates, from page load.
 *
 * `@preact/signals-debug` only learns about a signal when something
 * subscribes to it, so signals that are never read (or only read with
 * `peek()`) are invisible to it. We want the full inventory (#8), and we want
 * to know which component created what, to spot effects that outlive their
 * component (#10).
 *
 * signals-core has no construction hook, but its constructors start by
 * assigning a field (`this._value = …` for `Signal` and `Computed`,
 * `this._fn = …` for `Effect`; mangled to `v` and `x`). A setter for that
 * field on the prototype runs once per instance, registers it and then turns
 * itself into a plain own property, so later reads and writes are untouched.
 */

import { PROBE_EFFECT_NAME } from "./signals.js";

/** Mangled names, see @preact/signals' mangle.json. */
const SIGNAL_FIRST_FIELD = "v"; // Signal#_value
const EFFECT_FIRST_FIELD = "x"; // Effect#_fn
const SUBSCRIBE = "S"; // Signal#_subscribe
const TARGETS = "t"; // Signal#_targets
const NEXT_TARGET = "x"; // Node#_nextTarget
const FLAGS = "f"; // Effect#_flags, Computed#_flags
const DISPOSED = 1 << 3;

export const MAX_TRACKED = 20_000;

/** A component that created signals or effects while it rendered. */
export interface OwnerRecord {
	/** Unique per component instance, for grouping. */
	seq: number;
	ref: WeakRef<object>;
	name: string;
	/** It has unmounted since. */
	unmounted: boolean;
	/** Re-renders seen since it first created something. */
	rerenders: number;
	/** How many of those re-renders created something. */
	rerendersWithCreation: number;
	/** `RenderContext.render` of the last render that created something. */
	lastCreationRender: number;
}

export interface RegistryEntry {
	ref: WeakRef<object>;
	kind: "signal" | "effect";
	/** Component that was rendering when it was created, if any. */
	owner: OwnerRecord | null;
	/** Created during a render that wasn't the owner's first one. */
	createdOnRerender: boolean;
	created: number;
}

/** What `render-log.ts` tells us about the render in progress. */
export interface RenderContext {
	component: object | null;
	name: string | null;
	firstRender: boolean;
	/** Incremented for every component render. */
	render: number;
	/** > 0 while a `useEffect` callback runs inside a render. */
	suspended: number;
}

export function createRenderContext(): RenderContext {
	return { component: null, name: null, firstRender: false, render: 0, suspended: 0 };
}

/**
 * Created on more than half of its re-renders, at least twice. A `useMemo`
 * whose dependencies changed once doesn't count.
 */
export function createsOnRerender(owner: OwnerRecord | null): boolean {
	return !!owner && owner.rerendersWithCreation >= 2 && owner.rerendersWithCreation * 2 > owner.rerenders;
}

export class SignalRegistry {
	readonly entries: RegistryEntry[] = [];
	/** One record per component that created something, shared by its entries. */
	#owners = new WeakMap<object, OwnerRecord>();
	#ownerSeq = 0;
	/** `Signal` classes we hooked: an app can bundle two copies of signals-core. */
	#installed = new WeakSet<object>();
	installed = false;
	/** Number of entries dropped because the registry was full. */
	dropped = 0;
	/**
	 * > 0 while a signal gains a subscriber. `@preact/signals-debug` creates
	 * a watcher effect per signal then; it belongs to the signal, not to the
	 * component that happens to be rendering.
	 */
	#subscribing = 0;

	constructor(readonly rendering: RenderContext) {}

	/**
	 * Hooks `Signal` (and through it `Computed`) and `Effect`. Pass the app's
	 * `Signal` class and `effect` function (from `@preact/signals` or
	 * `@preact/signals-core`). Returns whether tracking works.
	 */
	install(Signal: any, effect: any, computed?: any): boolean {
		if (typeof WeakRef === "undefined" || typeof Signal !== "function") return false;
		if (this.#installed.has(Signal)) return true;
		const signalProto = Signal.prototype;
		let effectProto: any = null;
		if (typeof effect === "function") {
			try {
				// `effect()` calls its callback with the Effect as `this`.
				const dispose = effect(
					function (this: any) {
						effectProto = Object.getPrototypeOf(this);
					},
					{ name: PROBE_EFFECT_NAME },
				);
				dispose();
			} catch {
				effectProto = null;
			}
		}

		// `Computed.prototype` is a `Signal` instance (`new Signal()`), so it has
		// its own `_value` that would shadow the hook on `Signal.prototype`.
		let computedProto: any = null;
		if (typeof computed === "function") {
			try {
				computedProto = Object.getPrototypeOf(computed(() => 0));
			} catch {
				computedProto = null;
			}
		}

		const restore: Array<() => void> = [];
		const hook = (proto: any, field: string, kind: RegistryEntry["kind"]) => {
			if (!proto) return false;
			const own = Object.getOwnPropertyDescriptor(proto, field);
			// Only a leftover data property (`Computed.prototype`) may be replaced.
			if (own && !("value" in own && own.value === undefined && own.configurable)) return false;
			const registry = this;
			Object.defineProperty(proto, field, {
				configurable: true,
				enumerable: false,
				get() {
					return undefined;
				},
				set(value) {
					Object.defineProperty(this, field, {
						value,
						writable: true,
						enumerable: true,
						configurable: true,
					});
					try {
						registry.#add(this, kind);
					} catch {
						// Never break signal creation.
					}
				},
			});
			restore.push(() => {
				delete proto[field];
				if (own) Object.defineProperty(proto, field, own);
			});
			return true;
		};

		if (!hook(signalProto, SIGNAL_FIRST_FIELD, "signal")) return false;
		if (computedProto && computedProto !== signalProto) {
			hook(computedProto, SIGNAL_FIRST_FIELD, "signal");
		}
		if (effectProto) hook(effectProto, EFFECT_FIRST_FIELD, "effect");

		const wrapSubscribe = (proto: any) => {
			if (!proto || !Object.prototype.hasOwnProperty.call(proto, SUBSCRIBE)) return;
			const original = proto[SUBSCRIBE];
			if (typeof original !== "function") return;
			const registry = this;
			proto[SUBSCRIBE] = function (this: unknown, ...args: unknown[]) {
				registry.#subscribing++;
				try {
					return original.apply(this, args);
				} finally {
					registry.#subscribing--;
				}
			};
			restore.push(() => {
				proto[SUBSCRIBE] = original;
			});
		};
		wrapSubscribe(signalProto);
		if (computedProto && computedProto !== signalProto) wrapSubscribe(computedProto);

		// Check that the mangled names are what we think they are. (Compare
		// the last entry, not the count: a full registry evicts.)
		let probe: any;
		try {
			probe = new Signal(0);
		} catch {
			probe = null;
		}
		const ok =
			probe != null &&
			this.entries.at(-1)?.ref.deref() === probe &&
			Object.prototype.hasOwnProperty.call(probe, SIGNAL_FIRST_FIELD) &&
			probe.peek() === 0;
		if (!ok) {
			restore.forEach(fn => fn());
			return false;
		}
		this.entries.pop();
		this.#installed.add(Signal);
		if (this.installed) {
			console.warn(
				"[preact-devtools-overlay] A second copy of @preact/signals-core is loaded. Signals from both are tracked, but they don't see each other's updates; dedupe the package.",
			);
		}
		this.installed = true;
		return true;
	}

	#add(obj: object, kind: RegistryEntry["kind"]) {
		if (this.entries.length >= MAX_TRACKED) this.#evict();
		const { firstRender, render } = this.rendering;
		const component = this.#subscribing > 0 || this.rendering.suspended > 0 ? null : this.rendering.component;
		let owner: OwnerRecord | null = null;
		if (component) {
			owner = this.#owners.get(component) ?? null;
			if (!owner) {
				owner = {
					seq: ++this.#ownerSeq,
					ref: new WeakRef(component),
					name: this.rendering.name ?? "Anonymous",
					unmounted: false,
					rerenders: firstRender ? 0 : 1,
					rerendersWithCreation: 0,
					lastCreationRender: -1,
				};
				this.#owners.set(component, owner);
			}
			if (!firstRender && owner.lastCreationRender !== render) owner.rerendersWithCreation++;
			owner.lastCreationRender = render;
		}
		this.entries.push({
			ref: new WeakRef(obj),
			kind,
			owner,
			createdOnRerender: !!component && !firstRender,
			created: performance.now(),
		});
	}

	/**
	 * Full: drop what's gone, and if that frees less than a tenth, the oldest
	 * tenth. Each call frees at least `MAX_TRACKED / 10` slots, so the cost per
	 * signal stays constant.
	 */
	#evict() {
		this.prune();
		const target = MAX_TRACKED - Math.ceil(MAX_TRACKED / 10);
		if (this.entries.length > target) {
			const n = this.entries.length - target;
			this.entries.splice(0, n);
			this.dropped += n;
		}
	}

	/** Called by `render-log.ts` when a component renders again. */
	rerendered(component: object) {
		const owner = this.#owners.get(component);
		if (owner) owner.rerenders++;
	}

	/** Called when a component unmounts. */
	unmounted(component: object) {
		const owner = this.#owners.get(component);
		if (owner) owner.unmounted = true;
	}

	/** Drops entries whose object was garbage collected or that are disposed. */
	prune() {
		let w = 0;
		for (let r = 0; r < this.entries.length; r++) {
			const entry = this.entries[r];
			const obj = entry.ref.deref();
			if (obj === undefined || (entry.kind === "effect" && isDisposed(obj))) continue;
			this.entries[w++] = entry;
		}
		this.entries.length = w;
	}

	/** Live entries with their object. */
	*live(): Generator<{ entry: RegistryEntry; obj: any }> {
		for (const entry of this.entries) {
			const obj = entry.ref.deref();
			if (obj !== undefined) yield { entry, obj };
		}
	}
}

export function isDisposed(obj: any): boolean {
	return typeof obj?.[FLAGS] === "number" && (obj[FLAGS] & DISPOSED) !== 0;
}

export function isComputed(obj: any): boolean {
	return typeof obj?.x === "function" && typeof obj?.peek === "function";
}

/** Number of things (components, effects, computeds) subscribed to a signal. */
export function subscriberCount(signal: any): number {
	let n = 0;
	const seen = new Set();
	for (let node = signal?.[TARGETS]; node != null && !seen.has(node); node = node[NEXT_TARGET]) {
		seen.add(node);
		n++;
	}
	return n;
}
