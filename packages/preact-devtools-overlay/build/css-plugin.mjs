// Turns every `.css` import inside this package into a JS module that
// registers the compiled CSS text with `src/styles-registry.ts` instead of
// letting Vite inject it into `document.head`.
//
// Both devtools UIs are rendered inside shadow roots, so their styles must
// be adopted by those roots and must never leak into the host page. Each
// stylesheet is tagged with a scope derived from its location so the two UIs
// (which both ship global resets) never share a shadow root.
import fs from "node:fs/promises";
import path from "node:path";
import { transform } from "lightningcss";

/** Vite ids always use forward slashes, also on Windows. */
const normalizePath = p => p.replaceAll("\\", "/");

const PREFIX = "\0pdo-css:";
const SUFFIX = ".js";

/**
 * @param {{ root: string }} options
 * @returns {import("vite").Plugin}
 */
export function shadowCssPlugin({ root: rawRoot }) {
	const root = normalizePath(rawRoot);
	const registry = path.join(root, "src", "styles-registry.ts");

	/** @param {string} file */
	function scopeFor(file) {
		const rel = path.posix.relative(root, normalizePath(file));
		if (rel.startsWith("vendor/preact-devtools/")) return "preact";
		if (rel.startsWith("vendor/signals-devtools/")) return "signals";
		if (rel.startsWith("src/")) return "shell";
		throw new Error(`[pdo-css] CSS outside of a known scope: ${rel}`);
	}

	return {
		name: "pdo:shadow-css",
		enforce: "pre",
		async resolveId(source, importer) {
			if (!importer || !/\.css$/.test(source)) return null;
			const resolved = await this.resolve(source, importer, {
				skipSelf: true,
			});
			if (!resolved) return null;
			const id = normalizePath(resolved.id);
			if (!id.startsWith(root + "/")) return null;
			return PREFIX + id + SUFFIX;
		},
		async load(id) {
			if (!id.startsWith(PREFIX)) return null;
			const file = id.slice(PREFIX.length, -SUFFIX.length);
			this.addWatchFile(file);
			const code = await fs.readFile(file);
			const isModule = file.endsWith(".module.css");
			const result = transform({
				filename: file,
				code,
				// `grid: false` keeps grid-area names global, which upstream
				// preact-devtools relies on (it post-processes them back).
				cssModules: isModule
					? { pattern: "pdo_[hash]_[local]", grid: false }
					: false,
				minify: true,
				sourceMap: false,
				visitor: {
					// A shadow root can't isolate `rem` from the page's root font
					// size, and the upstream UIs use it heavily. Pin it to the
					// browser default so the devtools look the same on every page.
					Length(length) {
						if (length.unit === "rem") {
							return { unit: "px", value: length.value * 16 };
						}
						return length;
					},
					// Selectors that target the document (`:root`, `html`, `body`)
					// can't match anything inside a shadow root. Point them at the
					// shadow host instead.
					Selector(selector) {
						let changed = false;
						const next = selector.map(component => {
							if (
								(component.type === "pseudo-class" &&
									component.kind === "root") ||
								(component.type === "type" &&
									(component.name === "html" || component.name === "body"))
							) {
								changed = true;
								return { type: "pseudo-class", kind: "host" };
							}
							return component;
						});
						return changed ? next : selector;
					},
				},
			});

			const css = result.code.toString("utf8");

			const classes = {};
			for (const [key, value] of Object.entries(result.exports ?? {})) {
				classes[key] = [value.name, ...value.composes.map(c => c.name)].join(" ");
			}

			const scope = scopeFor(file);
			let js = `import { registerStyle } from ${JSON.stringify(registry)};\n`;
			js += `registerStyle(${JSON.stringify(scope)}, ${JSON.stringify(css)});\n`;
			js += `const classes = ${JSON.stringify(classes)};\n`;
			js += `export default classes;\n`;
			for (const key of Object.keys(classes)) {
				if (/^[A-Za-z_$][\w$]*$/.test(key)) {
					js += `export const ${key} = classes[${JSON.stringify(key)}];\n`;
				}
			}
			return { code: js, moduleSideEffects: true };
		},
	};
}
