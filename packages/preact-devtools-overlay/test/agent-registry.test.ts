import { describe, expect, it } from "vitest";
import { Signal, computed, effect, signal } from "@preact/signals-core";
import { vi } from "vitest";
import {
	MAX_TRACKED,
	SignalRegistry,
	createRenderContext,
	createsOnRerender,
	isDisposed,
	subscriberCount,
} from "../src/agent/registry";

// One registry per file: it patches signals-core's prototypes for good.
const rendering = createRenderContext();
const registry = new SignalRegistry(rendering);
const installed = registry.install(Signal, effect, computed);

const objects = () => Array.from(registry.live(), x => x.obj);

describe("SignalRegistry", () => {
	it("installs against the real signals-core", () => {
		expect(installed).toBe(true);
	});

	it("records signals, computeds and effects at construction", () => {
		const a = signal(1, { name: "a" });
		const b = computed(() => a.value * 2, { name: "b" });
		const dispose = effect(() => void b.value);
		const list = objects();
		expect(list).toContain(a);
		expect(list).toContain(b);
		expect(registry.entries.filter(e => e.kind === "effect").length).toBeGreaterThan(0);
		// Instances behave normally.
		a.value = 2;
		expect(b.value).toBe(4);
		expect(Object.prototype.hasOwnProperty.call(a, "v")).toBe(true);
		expect(subscriberCount(a)).toBe(1);
		dispose();
		expect(subscriberCount(a)).toBe(0);
	});

	it("attributes things created while a component renders", () => {
		const component = {};
		Object.assign(rendering, { component, name: "Ticker", firstRender: false, render: rendering.render + 1 });
		let dispose!: () => void;
		try {
			signal(0, { name: "perRender" });
			dispose = effect(() => {});
		} finally {
			Object.assign(rendering, { component: null, name: null });
		}
		const mine = registry.entries.filter(e => e.owner?.name === "Ticker");
		expect(mine).toHaveLength(2);
		expect(mine.every(e => e.createdOnRerender)).toBe(true);
		// Both share one owner record.
		expect(mine[0].owner).toBe(mine[1].owner);
		registry.unmounted(component);
		expect(mine[0].owner!.unmounted).toBe(true);

		const fx = mine.find(e => e.kind === "effect")!.ref.deref();
		expect(isDisposed(fx)).toBe(false);
		dispose();
		expect(isDisposed(fx)).toBe(true);
		registry.prune();
		expect(registry.entries.some(e => e.ref.deref() === fx)).toBe(false);
	});

	it("refuses classes that don't look like signals-core", () => {
		function Fake(this: any) {
			this.value = 1;
		}
		const other = new SignalRegistry(createRenderContext());
		expect(other.install(Fake, null)).toBe(false);
		expect(Object.getOwnPropertyDescriptor(Fake.prototype, "v")).toBeUndefined();
	});

	it("only calls it creation on re-render when most re-renders create", () => {
		const component = {};
		const renderAs = (firstRender: boolean, create: boolean) => {
			Object.assign(rendering, { component, name: "Memo", firstRender, render: rendering.render + 1 });
			if (!firstRender) registry.rerendered(component);
			try {
				if (create) computed(() => 1);
			} finally {
				Object.assign(rendering, { component: null, name: null });
			}
		};
		renderAs(true, true);
		// useMemo whose deps changed once in five re-renders.
		renderAs(false, false);
		renderAs(false, true);
		renderAs(false, false);
		renderAs(false, false);
		renderAs(false, false);
		const owner = registry.entries.find(e => e.owner?.name === "Memo")!.owner;
		expect(owner!.rerenders).toBe(5);
		expect(owner!.rerendersWithCreation).toBe(1);
		expect(createsOnRerender(owner)).toBe(false);
		// Then on every re-render.
		for (let i = 0; i < 6; i++) renderAs(false, true);
		expect(createsOnRerender(owner)).toBe(true);
	});

	it("evicts in bulk when full, in constant time per signal", () => {
		const keep: unknown[] = [];
		while (registry.entries.length < MAX_TRACKED) keep.push(signal(0));
		const t = performance.now();
		for (let i = 0; i < 5000; i++) keep.push(signal(i));
		const ms = performance.now() - t;
		expect(registry.entries.length).toBeLessThanOrEqual(MAX_TRACKED);
		expect(registry.dropped).toBeGreaterThanOrEqual(5000);
		// It used to prune and shift on every construction: ~4s for this.
		expect(ms).toBeLessThan(500);
		// A second copy of signals-core installs fine while full.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		class FullSignal extends Signal {}
		expect(registry.install(FullSignal, null)).toBe(true);
		warn.mockRestore();
		registry.entries.length = 0;
	});

	it("hooks a second copy of signals-core and warns", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		class OtherSignal extends Signal {}
		expect(registry.install(OtherSignal, null)).toBe(true);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("second copy"));
		expect(registry.install(OtherSignal, null)).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
		const s = new OtherSignal(3);
		expect(objects()).toContain(s);
	});
});
