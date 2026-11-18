import { defineConfig } from "vitest/config";
import path from "node:path";
// @ts-expect-error - plain ESM build helper without types
import { shadowCssPlugin } from "./build/css-plugin.mjs";

const root = import.meta.dirname;

export default defineConfig({
	plugins: [shadowCssPlugin({ root })],
	define: {
		__DEBUG__: "false",
		__PDO_VERSION__: JSON.stringify("test"),
		"process.env.BROWSER": JSON.stringify("inline"),
	},
	resolve: {
		alias: {
			"@preact/signals-devtools-adapter": path.join(
				root,
				"vendor/signals-devtools/devtools-adapter/src/index.ts",
			),
		},
	},
	oxc: {
		jsx: { runtime: "automatic", importSource: "preact" },
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
