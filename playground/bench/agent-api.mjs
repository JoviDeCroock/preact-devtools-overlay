/**
 * What does the agent API cost the app? Renders the playground with
 * `?rows=N` (N extra components) and times re-rendering all of them, with
 * the agent API on and off.
 *
 *   node bench/agent-api.mjs [rows=2000] [runs=30]
 */
import { createServer } from "vite";
import { chromium } from "@playwright/test";

const rows = Number(process.argv[2] ?? 2000);
const runs = Number(process.argv[3] ?? 30);
const root = new URL("..", import.meta.url).pathname;

async function measure(agentApi) {
	process.env.PDO_AGENT_API = agentApi ? "1" : "0";
	const server = await createServer({ root, logLevel: "error", server: { port: 0 } });
	await server.listen();
	const url = server.resolvedUrls.local[0];
	const browser = await chromium.launch();
	const page = await browser.newPage();
	await page.goto(`${url}?rows=${rows}&devtools=off`);
	await page.waitForSelector("li input");
	const result = await page.evaluate(async runs => {
		const input = document.querySelector("li input");
		const tick = () => new Promise(r => setTimeout(r, 0));
		const times = [];
		for (let i = 0; i < runs + 5; i++) {
			const t = performance.now();
			input.click(); // signal update -> App and every row re-render
			await tick();
			if (i >= 5) times.push(performance.now() - t); // skip warm-up
		}
		times.sort((a, b) => a - b);
		return {
			median: times[Math.floor(times.length / 2)],
			p90: times[Math.floor(times.length * 0.9)],
			api: !!window.__PREACT_DEVTOOLS_OVERLAY__?.api,
			renders: window.__PREACT_DEVTOOLS_OVERLAY__?.api?.status().renders,
		};
	}, runs);
	await browser.close();
	await server.close();
	return result;
}

const off = await measure(false);
const on = await measure(true);
const fmt = n => `${n.toFixed(1)}ms`;
console.log(`${rows} rows, ${runs} re-renders of all of them (median / p90):`);
console.log(`  agent API off: ${fmt(off.median)} / ${fmt(off.p90)}`);
const diff = (on.median / off.median - 1) * 100;
console.log(`  agent API on:  ${fmt(on.median)} / ${fmt(on.p90)}  (${diff >= 0 ? "+" : ""}${diff.toFixed(0)}%)`);
