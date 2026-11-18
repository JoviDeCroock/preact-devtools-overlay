import { defineConfig, devices } from "@playwright/test";

// E2E_PORT: run next to another checkout's tests.
const PORT = Number(process.env.E2E_PORT) || 5297;

export default defineConfig({
	testDir: "e2e",
	fullyParallel: true,
	retries: process.env.CI ? 2 : 0,
	use: { baseURL: `http://localhost:${PORT}` },
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
	],
	webServer: {
		command: `vite --port ${PORT} --strictPort`,
		port: PORT,
		reuseExistingServer: !process.env.CI,
	},
});
