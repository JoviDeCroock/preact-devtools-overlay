import { expect, test, type Page } from "@playwright/test";
// Types for window.__PREACT_DEVTOOLS_OVERLAY__.
import type {} from "preact-devtools-overlay/client";

// The recipes from AGENTS.md, run against the playground.

const overlay = (page: Page) => page.locator("preact-devtools-overlay");
const api = (page: Page) =>
	page.waitForFunction(() => !!window.__PREACT_DEVTOOLS_OVERLAY__?.api);

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", err => errors.push(err.message));
	(page as any).__errors = errors;
	await page.goto("/");
	await expect(page.getByTestId("counter")).toBeVisible();
	await api(page);
});

test.afterEach(async ({ page }) => {
	expect((page as any).__errors).toEqual([]);
});

test("describes the component tree", async ({ page }) => {
	const tree = await page.evaluate(() => window.__PREACT_DEVTOOLS_OVERLAY__!.api!.getTree({ format: "text" }));
	expect(tree).toMatch(/^App #\d+\n {2}Counter #\d+\n {2}SignalCounter #\d+\n {2}Stopwatch #\d+ \[class\]\n {2}TodoItem #\d+ \[key="1"\]/);

	const found = await page.evaluate(() => {
		const a = window.__PREACT_DEVTOOLS_OVERLAY__!.api!;
		return { byName: a.find("Stopwatch"), bySelector: a.find("[data-testid=stopwatch]") };
	});
	expect(found.byName).toEqual(found.bySelector);
	expect(found.byName[0]).toMatchObject({ name: "Stopwatch", kind: "class", path: "App > Stopwatch" });
});

test("inspects hooks, class state, signals and source locations", async ({ page }) => {
	const [counter, stopwatch, signalCounter] = await page.evaluate(() => {
		const a = window.__PREACT_DEVTOOLS_OVERLAY__!.api!;
		return [a.inspect("Counter"), a.inspect("[data-testid=stopwatch]"), a.inspect("SignalCounter")] as any[];
	});
	expect(counter.hooks).toEqual([{ hook: "useState", index: 0, value: 0, editable: true }]);
	expect(counter.source).toMatch(/src\/main\.tsx:\d+:\d+$/);
	expect(stopwatch).toMatchObject({ props: { label: "Class stopwatch" }, state: { running: false, seconds: 0 } });
	expect(signalCounter.hooks[0]).toMatchObject({ hook: "useSignal" });
});

test("explains why components rendered", async ({ page }) => {
	const mark = await page.evaluate(() => window.__PREACT_DEVTOOLS_OVERLAY__!.api!.mark());
	await page.getByTestId("counter").click();
	await page.getByTestId("stopwatch").click();
	await page.locator("li input").first().click();
	await expect(page.getByText("Todos (0 remaining)")).toBeVisible();

	const text = await page.evaluate(
		since => window.__PREACT_DEVTOOLS_OVERLAY__!.api!.getRenders({ since, format: "text" }),
		mark,
	);
	const lines = (text as string).split("\n");
	expect(lines[0]).toMatch(/Counter #\d+ hooks \(useState\[0\]: 0 → 1\)/);
	expect(lines[1]).toMatch(/Stopwatch #\d+ state \(running: false → true\)/);
	expect(text).toMatch(/App #\d+ signal \(todos\[0\]\.done: false → true\)/);
	expect(text).toMatch(/TodoItem #\d+ props \(todo\.done: false → true\)/);

	const why = await page.evaluate(() =>
		window.__PREACT_DEVTOOLS_OVERLAY__!.api!.whyDidRender("Counter", { last: 1 }),
	);
	expect(why).toMatchObject([{ name: "Counter", reason: "hooks", hooks: [{ key: "useState[0]", prev: 0, next: 1 }] }]);
});

test("records signal updates from page load, before any panel is open", async ({ page }) => {
	await page.locator("li input").first().click();
	const result = await page.evaluate(() => {
		const a = window.__PREACT_DEVTOOLS_OVERLAY__!.api!;
		return {
			updates: a.getSignalUpdates({ name: "todos" }),
			todos: a.getSignals({ name: "todos" }),
			remaining: a.getSignals({ name: "remaining" }),
		};
	});
	expect(result.updates).toMatchObject([{ name: "todos", type: "signal" }]);
	expect(result.todos).toMatchObject([{ name: "todos", type: "signal", readBy: [{ name: "App" }] }]);
	// Only bound as text (`{remaining}`), so no component re-renders for it.
	expect(result.remaining).toMatchObject([{ name: "remaining", type: "computed", value: 0 }]);
});

test("the Signals tab shows updates from before it was opened", async ({ page }) => {
	await page.getByTestId("signal-counter").click();
	await page.getByTestId("signal-counter").click();
	await page.keyboard.press("Alt+Shift+D");
	await overlay(page).getByRole("tab", { name: "Signals" }).click();
	await expect(overlay(page).getByText("Updates: 2")).toBeVisible();
	await expect(overlay(page).getByText("1→2").first()).toBeVisible();
});

test("edits state through the API", async ({ page }) => {
	await page.evaluate(() => window.__PREACT_DEVTOOLS_OVERLAY__!.api!.update("Counter", "hook", 0, 41));
	await expect(page.getByTestId("counter")).toHaveText("Hook count: 41");
});

test("explains context re-renders and names the provider", async ({ page }) => {
	const mark = await page.evaluate(() => window.__PREACT_DEVTOOLS_OVERLAY__!.api!.mark());
	await page.getByTestId("theme-toggle").click();
	await expect(page.getByTestId("theme")).toHaveText("Theme: dark");
	const result = await page.evaluate(since => {
		const a = window.__PREACT_DEVTOOLS_OVERLAY__!.api!;
		return { renders: a.getRenders({ since, format: "text" }), label: a.inspect("ThemeLabel") as any };
	}, mark);
	expect(result.renders).toMatch(/ThemeLabel #\d+ context \(Theme: "light" → "dark"\)/);
	expect(result.label.contexts).toEqual([
		{ name: "Theme", value: "dark", provider: { id: expect.any(Number), path: "App > ThemeProvider > Theme.Provider" } },
	]);
});

test("flags remounts and leaked effects", async ({ page }) => {
	await page.getByTestId("remount").click();
	await page.getByTestId("leaky-toggle").click();
	await expect(page.getByTestId("leaky-toggle")).toHaveText("Mount leaky ticker");
	const result = await page.evaluate(() => {
		const a = window.__PREACT_DEVTOOLS_OVERLAY__!.api!;
		return { remounts: a.getRemounts({ format: "text" }), leaks: a.getLeaks({ format: "text" }) };
	});
	expect(result.remounts).toMatch(/App > RemountDemo > Inner remounted \(no key/);
	expect(result.leaks).toContain("LeakyTicker: 1 effect (leakyEffect) still running after it unmounted");
});

test("lists every signal with its subscribers", async ({ page }) => {
	const signals = await page.evaluate(() => window.__PREACT_DEVTOOLS_OVERLAY__!.api!.getSignals());
	const remaining = (signals as any[]).find(s => s.name === "remaining");
	expect(remaining).toMatchObject({ type: "computed", value: 1 });
	expect(remaining.subscribers).toBeGreaterThan(0);
	// Internal text-binding signals of @preact/signals are left out.
	expect((signals as any[]).some(s => s.name === "ReactiveDom")).toBe(false);
});

test("?devtools=off keeps the UI out but the API in", async ({ page }) => {
	await page.goto("/?devtools=off");
	await api(page);
	await page.waitForTimeout(300);
	await expect(overlay(page)).toHaveCount(0);
});
