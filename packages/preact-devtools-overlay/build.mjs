// Builds the three public entry points:
//
//   dist/client.js  – page hook, must run before Preact (browser, self-contained)
//   dist/index.js   – <preact-devtools-overlay> element + mount API (browser, self-contained)
//   dist/auto.js    – side-effect import that mounts the overlay
//   dist/vite.js    – Vite plugin (node)
//
// The browser bundles deliberately include their *own* copy of preact and
// @preact/signals. The devtools UI must never render with the app's Preact
// instance, otherwise it would show up in (and be hooked by) the very
// devtools that are inspecting the app.
import { build } from "vite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { shadowCssPlugin } from "./build/css-plugin.mjs";

const root = import.meta.dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const watch = process.argv.includes("--watch");
const r = (...p) => path.join(root, ...p);

/** @type {import("vite").InlineConfig} */
const browserShared = {
	configFile: false,
	root,
	logLevel: "warn",
	define: {
		__DEBUG__: "false",
		"process.env.BROWSER": JSON.stringify("inline"),
		"process.env.NODE_ENV": JSON.stringify("production"),
		__PDO_VERSION__: JSON.stringify(pkg.version),
	},
	resolve: {
		alias: {
			"@preact/signals-devtools-adapter": r(
				"vendor/signals-devtools/devtools-adapter/src/index.ts",
			),
		},
		// Never pick up a second copy of preact from a parent node_modules.
		dedupe: ["preact", "@preact/signals", "@preact/signals-core"],
	},
	oxc: {
		jsx: { runtime: "automatic", importSource: "preact" },
	},
	plugins: [shadowCssPlugin({ root })],
};

function browserBuild(entry, outDirEmpty) {
	return {
		...browserShared,
		build: {
			outDir: "dist",
			emptyOutDir: outDirEmpty,
			target: "es2022",
			minify: true,
			sourcemap: true,
			copyPublicDir: false,
			watch: watch ? {} : null,
			lib: {
				entry,
				formats: ["es"],
				fileName: (_format, name) => `${name}.js`,
			},
			rolldownOptions: {
				output: { chunkFileNames: "chunks/[name]-[hash].js" },
			},
		},
	};
}

// In watch mode, keep the previous output around: a dev server consuming
// dist/ (e.g. the playground) must never observe it missing.
if (!watch) fs.rmSync(r("dist"), { recursive: true, force: true });

await build(browserBuild({ client: r("src/client.ts") }, false));
await build(
	browserBuild({ index: r("src/index.ts"), auto: r("src/auto.ts") }, false),
);
await build({
	configFile: false,
	root,
	logLevel: "warn",
	build: {
		outDir: "dist",
		emptyOutDir: false,
		ssr: true,
		target: "node20",
		minify: false,
		copyPublicDir: false,
		watch: watch ? {} : null,
		lib: {
			entry: { vite: r("src/vite.ts") },
			formats: ["es"],
			fileName: (_format, name) => `${name}.js`,
		},
		rolldownOptions: {
			external: [/^node:/, /^vite($|\/)/],
		},
	},
});

if (!watch) {
	execFileSync(
		path.join(root, "node_modules/.bin/tsc"),
		["-p", "tsconfig.build.json"],
		{ stdio: "inherit", cwd: root },
	);
	for (const file of ["client.js", "index.js", "auto.js", "vite.js"]) {
		const size = fs.statSync(r("dist", file)).size;
		console.log(`dist/${file.padEnd(10)} ${(size / 1024).toFixed(1)} kB`);
	}
}
