import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error - plain ESM build helper without types
import { shadowCssPlugin } from "../build/css-plugin.mjs";

function setup(files: Record<string, string>) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdo-css-"));
	for (const [rel, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), content);
	}
	const plugin = shadowCssPlugin({ root });
	const ctx = {
		resolve: async (source: string, importer: string) => ({
			id: path.resolve(path.dirname(importer), source),
		}),
		addWatchFile() {},
	};
	return {
		root,
		async compile(rel: string) {
			const importer = path.join(root, path.dirname(rel), "index.ts");
			const id = await plugin.resolveId.call(ctx, `./${path.basename(rel)}`, importer);
			expect(id).toMatch(/^\0pdo-css:/);
			const result = await plugin.load.call(ctx, id);
			return result.code as string;
		},
	};
}

function registered(code: string) {
	const m = code.match(/registerStyle\(("[^"]+"), (".*")\);/);
	expect(m).not.toBeNull();
	return { scope: JSON.parse(m![1]), css: JSON.parse(m![2]) as string };
}

describe("shadowCssPlugin", () => {
	it("handles Windows-style roots", async () => {
		const plugin = shadowCssPlugin({ root: "C:\\work\\pkg" });
		const ctx = { resolve: async () => ({ id: "C:/work/pkg/src/a.css" }) };
		expect(await plugin.resolveId.call(ctx, "./a.css", "C:/work/pkg/src/a.ts")).toBe(
			"\0pdo-css:C:/work/pkg/src/a.css.js",
		);
	});

	it("rewrites document-level selectors to :host", async () => {
		const { compile } = setup({
			"src/a.css": ":root { --x: 1 } html, body { margin: 0 } :root .dark { color: red } .tree-body { color: blue }",
		});
		const { scope, css } = registered(await compile("src/a.css"));
		expect(scope).toBe("shell");
		expect(css).not.toMatch(/:root|(^|[\s,}])(html|body)\b/);
		expect(css).toContain(":host{--x:1}");
		expect(css).toContain(":host .dark");
		// Class names that merely contain "body" are left alone.
		expect(css).toContain(".tree-body");
	});

	it("exports hashed CSS module class names and keeps grid areas global", async () => {
		const { compile } = setup({
			"vendor/preact-devtools/src/x.module.css":
				".root { grid-template-areas: \"switcher\" \"content\"; } .switcher { grid-area: switcher; }",
		});
		const code = await compile("vendor/preact-devtools/src/x.module.css");
		const { scope, css } = registered(code);
		expect(scope).toBe("preact");
		expect(code).toMatch(/export const root = classes\["root"\]/);
		const classes = JSON.parse(code.match(/const classes = (\{.*\});/)![1]);
		expect(classes.root).toMatch(/^pdo_.+_root$/);
		expect(css).toContain(`.${classes.root}`);
		expect(css).toContain("grid-area:switcher");
		expect(css).toContain('"switcher""content"');
	});

	it("scopes signals devtools styles separately", async () => {
		const { compile } = setup({
			"vendor/signals-devtools/devtools-ui/src/styles.css": "body { overflow: hidden }",
		});
		const { scope, css } = registered(
			await compile("vendor/signals-devtools/devtools-ui/src/styles.css"),
		);
		expect(scope).toBe("signals");
		expect(css).toBe(":host{overflow:hidden}");
	});

	it("pins rem units to 16px so the page's root font size can't leak in", async () => {
		const { compile } = setup({
			"src/rem.css": ".a { padding: 0.5rem 1rem; font-size: var(--x, 0.75rem) } @media (min-width: 37.5rem) { .a { margin: 2rem } }",
		});
		const { css } = registered(await compile("src/rem.css"));
		expect(css).not.toMatch(/\drem/);
		expect(css).toContain("padding:8px 16px");
		expect(css).toContain("12px");
		expect(css).toContain("width>=600px");
		expect(css).toContain("margin:32px");
	});

	it("ignores CSS from outside the package", async () => {
		const plugin = shadowCssPlugin({ root: "/pkg" });
		const ctx = { resolve: async (id: string) => ({ id }) };
		expect(await plugin.resolveId.call(ctx, "/elsewhere/x.css", "/elsewhere/a.ts")).toBeNull();
		// A sibling directory that merely shares the prefix is outside too.
		expect(await plugin.resolveId.call(ctx, "/pkg-other/x.css", "/pkg-other/a.ts")).toBeNull();
	});
});
