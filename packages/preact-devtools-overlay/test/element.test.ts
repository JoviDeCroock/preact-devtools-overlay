// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The panes pull in the full devtools UIs; the shell is what's under test.
const mountPreactPane = vi.fn(() => ({ store: {}, destroy: vi.fn() }));
const mountSignalsPane = vi.fn(async () => ({ destroy: vi.fn() }));
vi.mock("../src/panes/preact", () => ({ mountPreactPane }));
vi.mock("../src/panes/signals", () => ({ mountSignalsPane }));

const { mountOverlay } = await import("../src/index");

const flush = () => new Promise(r => setTimeout(r, 0));

describe("<preact-devtools-overlay>", () => {
	beforeEach(() => {
		localStorage.clear();
		document.body.innerHTML = "";
		mountPreactPane.mockClear();
		mountSignalsPane.mockClear();
	});
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders a closed launcher by default and lazily mounts panes", async () => {
		const el = mountOverlay();
		const shadow = el.shadowRoot!;
		const drawer = shadow.querySelector(".drawer") as HTMLElement;
		expect(drawer.hidden).toBe(true);
		expect(shadow.querySelector("style")!.textContent).toContain(".launcher");

		(shadow.querySelector(".launcher") as HTMLButtonElement).click();
		await flush();
		expect(el.open).toBe(true);
		expect(drawer.hidden).toBe(false);
		expect(mountPreactPane).toHaveBeenCalledTimes(1);
		expect(mountSignalsPane).not.toHaveBeenCalled();

		el.tab = "signals";
		await flush();
		expect(mountSignalsPane).toHaveBeenCalledTimes(1);
		expect((shadow.querySelector("#pdo-pane-components") as HTMLElement).hidden).toBe(true);

		// Switching back does not re-mount.
		el.tab = "components";
		await flush();
		expect(mountPreactPane).toHaveBeenCalledTimes(1);
	});

	it("is a singleton", () => {
		expect(mountOverlay()).toBe(mountOverlay());
		expect(document.querySelectorAll("preact-devtools-overlay")).toHaveLength(1);
	});

	it("persists and restores open state and tab", async () => {
		const el = mountOverlay();
		el.tab = "signals";
		el.open = true;
		await flush();
		el.remove();

		const again = mountOverlay();
		expect(again).not.toBe(el);
		expect(again.open).toBe(true);
		expect(again.tab).toBe("signals");
	});

	it("explicit options win over persisted state", () => {
		localStorage.setItem(
			"preact-devtools-overlay:state",
			JSON.stringify({ open: true, tab: "signals" }),
		);
		const el = mountOverlay({ open: false, tab: "components" });
		expect(el.open).toBe(false);
		expect(el.tab).toBe("components");
	});

	it("toggles with Alt+Shift+D", () => {
		const el = mountOverlay();
		window.dispatchEvent(
			new KeyboardEvent("keydown", { altKey: true, shiftKey: true, code: "KeyD" }),
		);
		expect(el.open).toBe(true);
		window.dispatchEvent(
			new KeyboardEvent("keydown", { altKey: true, shiftKey: true, code: "KeyD" }),
		);
		expect(el.open).toBe(false);
	});

	it("tears panes down when removed", async () => {
		const el = mountOverlay({ open: true });
		await flush();
		const pane = mountPreactPane.mock.results[0].value;
		el.remove();
		expect(pane.destroy).toHaveBeenCalled();
		// Shortcut listener is gone too.
		window.dispatchEvent(
			new KeyboardEvent("keydown", { altKey: true, shiftKey: true, code: "KeyD" }),
		);
		expect(el.open).toBe(true);
	});

	it("opens the Components pane for a reload-and-profile session", () => {
		localStorage.setItem(
			"preact-devtools-overlay:state",
			JSON.stringify({ open: false, tab: "signals" }),
		);
		window.__PREACT_DEVTOOLS_OVERLAY__ = {
			version: "test",
			reusedExistingHook: false,
			attachEvents: [],
			reloadSession: { kind: "profile", events: [], truncated: false },
		};
		try {
			const el = mountOverlay();
			expect(el.open).toBe(true);
			expect(el.tab).toBe("components");
		} finally {
			delete window.__PREACT_DEVTOOLS_OVERLAY__;
		}
	});

	it("ignores unknown tab/position values", () => {
		const el = mountOverlay();
		el.setAttribute("tab", "nope");
		el.setAttribute("position", "middle");
		expect(el.tab).toBe("components");
		expect(el.position).toBe("bottom-right");
	});
});
