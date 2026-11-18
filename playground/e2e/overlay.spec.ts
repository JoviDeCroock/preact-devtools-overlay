import { expect, test, type Page } from "@playwright/test";

// Playwright's CSS/role locators pierce open shadow roots, so we can talk to
// both devtools UIs as if they were regular DOM.
const overlay = (page: Page) => page.locator("preact-devtools-overlay");

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", err => errors.push(err.message));
	(page as any).__errors = errors;
	await page.goto("/");
	await expect(page.getByTestId("counter")).toBeVisible();
	// The overlay UI is loaded lazily after the app; wait until it's mounted.
	await expect(
		overlay(page).getByRole("button", { name: "Toggle Preact Devtools" }),
	).toBeAttached();
});

test.afterEach(async ({ page }) => {
	expect((page as any).__errors).toEqual([]);
});

test("shows the component tree of the app, not of the devtools", async ({ page }) => {
	await overlay(page).getByRole("button", { name: "Toggle Preact Devtools" }).click();
	const tree = overlay(page).locator('[data-testid="tree-item"]');
	await expect(tree.filter({ hasText: /^App$/ })).toHaveCount(1);
	await expect(tree.filter({ hasText: /^SignalCounter$/ })).toHaveCount(1);
	// Nothing from either devtools UI may leak into the inspected tree.
	await expect(tree.filter({ hasText: /DevTools|Elements|Header|UpdatesContainer/ })).toHaveCount(0);

	await tree.filter({ hasText: /^Counter$/ }).click();
	await expect(overlay(page).getByText("useState")).toBeVisible();
});

test("picks a component from the page", async ({ page }) => {
	await page.keyboard.press("Alt+Shift+D");
	await overlay(page).getByTestId("inspect-btn").click();
	await page.getByTestId("signal-counter").hover();
	await page.getByTestId("signal-counter").click();
	await expect(overlay(page).getByText("<SignalCounter>")).toBeVisible();
	// The click was swallowed by the picker.
	await expect(page.getByTestId("signal-counter")).toHaveText("Signal count: 0");
});

test("streams signal updates into the Signals tab", async ({ page }) => {
	await page.keyboard.press("Alt+Shift+D");
	await overlay(page).getByRole("tab", { name: "Signals" }).click();
	await expect(overlay(page).getByText("Connected")).toBeVisible();

	await page.getByTestId("signal-counter").click();
	await page.getByTestId("signal-counter").click();
	await expect(overlay(page).getByText("Updates: 2")).toBeVisible();
	// Shown for both the signal and the computed text binding derived from it.
	await expect(overlay(page).getByText("1→2").first()).toBeVisible();
});

test("does not leak styles into the page", async ({ page }) => {
	await page.keyboard.press("Alt+Shift+D");
	await overlay(page).getByRole("tab", { name: "Signals" }).click();
	await expect(overlay(page).getByText("Connected")).toBeVisible();
	const body = await page.evaluate(() => ({
		className: document.body.className,
		margin: getComputedStyle(document.body).margin,
		overflow: getComputedStyle(document.body).overflow,
		globalStyles: [...document.querySelectorAll("style[data-preact-devtools-overlay]")].map(
			s => (s as HTMLElement).dataset.preactDevtoolsOverlay,
		),
	}));
	expect(body).toEqual({
		className: "",
		margin: "8px",
		overflow: "visible",
		// Only the in-page element highlighter styles.
		globalStyles: ["preact"],
	});
});

test("remembers open state and tab across reloads", async ({ page }) => {
	await page.keyboard.press("Alt+Shift+D");
	await overlay(page).getByRole("tab", { name: "Signals" }).click();
	await page.reload();
	await expect(overlay(page).getByRole("tab", { name: "Signals" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await overlay(page).getByRole("tab", { name: "Components" }).click();
	// Tree is requested from the hook after the app already rendered.
	await expect(overlay(page).locator('[data-testid="tree-item"]').filter({ hasText: /^App$/ })).toBeVisible();
});
