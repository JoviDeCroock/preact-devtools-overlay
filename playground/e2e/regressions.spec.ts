import { expect, test, type Page } from "@playwright/test";

const overlay = (page: Page) => page.locator("preact-devtools-overlay");
const treeItems = (page: Page) => overlay(page).locator('[data-testid="tree-item"]');

async function openComponents(page: Page) {
	await page.goto("/");
	await expect(
		overlay(page).getByRole("button", { name: "Toggle Preact Devtools" }),
	).toBeAttached();
	await page.keyboard.press("Alt+Shift+D");
	await expect(treeItems(page).filter({ hasText: /^App$/ })).toBeVisible();
}

test("persisted component filters are re-applied after reload", async ({ page }) => {
	await openComponents(page);
	// DOM nodes are hidden by default.
	await expect(treeItems(page).filter({ hasText: /^button$/ })).toHaveCount(0);

	await overlay(page).getByTestId("filter-menu-button").click();
	await overlay(page).getByLabel("DOM nodes").uncheck();
	await overlay(page).getByTestId("filter-update").click();
	await expect(treeItems(page).filter({ hasText: /^button$/ }).first()).toBeVisible();

	await page.reload();
	await expect(treeItems(page).filter({ hasText: /^App$/ })).toBeVisible();
	await expect(treeItems(page).filter({ hasText: /^button$/ }).first()).toBeVisible();
});

test("reload and profile records the initial render", async ({ page }) => {
	await openComponents(page);
	await overlay(page).getByText("Profiler", { exact: true }).click();
	await overlay(page).getByTestId("reload-and-profile-btn").click();

	await page.waitForLoadState("load");
	await expect(overlay(page).getByTitle("Stop Recording").first()).toBeVisible();
	await page.getByTestId("counter").click();
	await overlay(page).getByTitle("Stop Recording").first().click();

	// Initial mount + the click.
	await expect(overlay(page).getByText(/^\d+ \/ 2$/)).toBeVisible();
	expect(await page.evaluate(() => (window as any).__PREACT_DEVTOOLS_OVERLAY__?.reloadSession)).toBeNull();
});

test("saved filters don't add commits to a reload-and-profile recording", async ({ page }) => {
	await openComponents(page);
	await overlay(page).getByTestId("filter-menu-button").click();
	await overlay(page).getByLabel("DOM nodes").uncheck();
	await overlay(page).getByTestId("filter-update").click();

	await overlay(page).getByText("Profiler", { exact: true }).click();
	await overlay(page).getByTestId("reload-and-profile-btn").click();
	await page.waitForLoadState("load");
	await expect(overlay(page).getByTitle("Stop Recording").first()).toBeVisible();
	await page.getByTestId("counter").click();
	await overlay(page).getByTitle("Stop Recording").first().click();

	// Initial mount + the click, no remounts from re-applied filters.
	await expect(overlay(page).getByText(/^\d+ \/ 2$/)).toBeVisible();

	// Saved filters are still applied on the next normal load.
	await page.reload();
	await overlay(page).getByText("Elements", { exact: true }).click();
	await expect(treeItems(page).filter({ hasText: /^button$/ }).first()).toBeVisible();
});

test("an overflowed reload session is discarded but the tree still works", async ({ page }) => {
	const warnings: string[] = [];
	page.on("console", m => m.type() === "warning" && warnings.push(m.text()));
	await openComponents(page);

	// Pre-fill the session buffer so only the first hook messages fit.
	await page.addInitScript(() => {
		Object.defineProperty(window, "__PREACT_DEVTOOLS_OVERLAY__", {
			configurable: true,
			set(state: any) {
				let session: any = null;
				Object.defineProperty(state, "reloadSession", {
					configurable: true,
					enumerable: true,
					get: () => session,
					set(v: any) {
						if (v) for (let i = 0; i < 19_998; i++) v.events.push({ type: "noop", data: null });
						session = v;
					},
				});
				Object.defineProperty(window, "__PREACT_DEVTOOLS_OVERLAY__", {
					configurable: true,
					writable: true,
					value: state,
				});
			},
		});
	});

	await overlay(page).getByText("Profiler", { exact: true }).click();
	await overlay(page).getByTestId("reload-and-profile-btn").click();
	await page.waitForLoadState("load");

	// Falls back to a normal connect: full tree, live updates, not recording.
	await expect(treeItems(page).filter({ hasText: /^SignalCounter$/ })).toBeVisible();
	await page.getByTestId("counter").click();
	await overlay(page).getByText("Profiler", { exact: true }).click();
	await expect(overlay(page).getByTitle("Start Recording").first()).toBeVisible();
	expect(warnings.some(w => w.includes("was discarded"))).toBe(true);
});

test("tree re-measures when its pane changes size", async ({ page }) => {
	await page.setViewportSize({ width: 1200, height: 500 });
	await page.goto("/?rows=200");
	await expect(
		overlay(page).getByRole("button", { name: "Toggle Preact Devtools" }),
	).toBeAttached();
	await page.keyboard.press("Alt+Shift+D");
	await expect(treeItems(page).filter({ hasText: /^App$/ })).toBeVisible();

	// Rows rendered by the virtualized list that actually fit in its viewport.
	const visibleRows = () =>
		treeItems(page).evaluateAll(els => {
			const list = els[0]?.closest("[data-testid='elements-tree']") ?? els[0]?.parentElement;
			const bottom = list!.getBoundingClientRect().bottom;
			return els.filter(e => {
				const r = e.getBoundingClientRect();
				return r.height > 0 && r.top < bottom;
			}).length;
		});
	const initial = await visibleRows();
	expect(initial).toBeGreaterThan(3);
	expect(initial).toBeLessThan(100);

	// Resize the window while the Components pane is hidden, both by switching
	// tabs and by closing the drawer. The drawer keeps its pixel height, so the
	// list must come back at its previous size instead of the 0px it was
	// measured at while hidden.
	await overlay(page).getByRole("tab", { name: "Signals" }).click();
	await page.setViewportSize({ width: 1200, height: 700 });
	await overlay(page).getByRole("tab", { name: "Components" }).click();
	await expect.poll(visibleRows).toBe(initial);

	await page.keyboard.press("Alt+Shift+D");
	await page.setViewportSize({ width: 1200, height: 1000 });
	await page.keyboard.press("Alt+Shift+D");
	await expect.poll(visibleRows).toBe(initial);
	const afterWindowResize = await visibleRows();

	// Grow the drawer by dragging its handle. Rows must follow, and the app
	// must not see synthetic window `resize` events.
	await page.evaluate(async () => {
		window.addEventListener("resize", () => (window as any).__resizes++);
		// Let resize events from the earlier viewport changes flush first.
		for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
		(window as any).__resizes = 0;
	});
	const handle = overlay(page).locator(".resize-handle");
	const box = (await handle.boundingBox())!;
	await page.mouse.move(box.x + 100, box.y + 4);
	await page.mouse.down();
	await page.mouse.move(box.x + 100, 100, { steps: 5 });
	await page.mouse.up();
	await expect.poll(visibleRows).toBeGreaterThan(afterWindowResize);
	expect(await page.evaluate(() => (window as any).__resizes)).toBe(0);
});

test("devtools sizing ignores the page's root font size", async ({ page }) => {
	await openComponents(page);
	const rowHeight = () =>
		treeItems(page).first().evaluate(e => e.getBoundingClientRect().height);
	const before = await rowHeight();
	await page.evaluate(() => (document.documentElement.style.fontSize = "62.5%"));
	expect(await rowHeight()).toBe(before);
});

test("signals console logging stays off after changing Signals settings", async ({ page }) => {
	const logs: string[] = [];
	page.on("console", msg => logs.push(msg.text()));
	await openComponents(page);
	await overlay(page).getByRole("tab", { name: "Signals" }).click();
	await expect(overlay(page).getByRole("tabpanel", { name: "Signals" }).getByText("Connected", { exact: true })).toBeVisible();

	await overlay(page).getByRole("button", { name: "Settings" }).click();
	await expect(overlay(page).getByLabel("Enable console logging")).not.toBeChecked();
	await overlay(page).getByLabel("Group related updates").click();
	await overlay(page).getByRole("button", { name: "Apply" }).click();

	await page.getByTestId("signal-counter").click();
	await expect(overlay(page).getByText("Updates: 1")).toBeVisible();
	expect(logs.filter(l => l.includes("🎯"))).toEqual([]);
});
