import { parseAst } from "vite";
import { describe, expect, it } from "vitest";
import { transformHookNames } from "../src/hook-names";
import { preactDevtoolsOverlay } from "../src/vite";

const run = (code: string) => transformHookNames(code, parseAst)?.code ?? null;
const IMPORT = `import { addHookName as __pdoHookName } from "preact/devtools";\n`;

describe("transformHookNames()", () => {
	it("names useState, useReducer, useRef and useMemo after their variable", () => {
		const code = [
			`import { useState, useReducer, useRef, useMemo, useEffect } from "preact/hooks";`,
			`export function App() {`,
			`  const [count, setCount] = useState(0);`,
			`  const [{ items }, dispatch] = useReducer(r, null);`,
			`  const input = useRef(null);`,
			`  let total;`,
			`  total = useMemo(() => count * 2, [count]);`,
			`  useEffect(() => {}, []);`,
			`  useState(1);`,
			`}`,
		].join("\n");
		expect(run(code)).toBe(
			IMPORT +
				[
					`import { useState, useReducer, useRef, useMemo, useEffect } from "preact/hooks";`,
					`export function App() {`,
					`  const [count, setCount] = __pdoHookName(useState(0), "count");`,
					`  const [{ items }, dispatch] = __pdoHookName(useReducer(r, null), "items");`,
					`  const input = __pdoHookName(useRef(null), "input");`,
					`  let total;`,
					`  total = __pdoHookName(useMemo(() => count * 2, [count]), "total");`,
					`  useEffect(() => {}, []);`,
					`  __pdoHookName(useState(1), "");`,
					`}`,
				].join("\n"),
		);
	});

	it("accepts preact/compat and react imports", () => {
		expect(run(`import { useState } from "preact/compat";\nconst [a] = useState();`)).toContain(
			`__pdoHookName(useState(), "a")`,
		);
		expect(run(`import { useRef } from "react";\nconst b = useRef();`)).toContain(
			`__pdoHookName(useRef(), "b")`,
		);
	});

	it("leaves other files alone", () => {
		// Not imported from a hooks module.
		expect(run(`import { useState } from "./my-hooks";\nconst [a] = useState();`)).toBeNull();
		// Renamed on import.
		expect(run(`import { useState as s } from "preact/hooks";\nconst [a] = s();`)).toBeNull();
		// No hooks at all, or a syntax error.
		expect(run(`const a = 1;`)).toBeNull();
		expect(run(`import { useState } from "preact/hooks"; const [a] = useState(`)).toBeNull();
	});

	it("skips calls @preact/preset-vite already named", () => {
		const code = `import { addHookName } from "preact/devtools";\nimport { useState } from "preact/hooks";\nconst [a] = addHookName(useState(0), "a");`;
		expect(run(code)).toBeNull();
	});

	it("picks a helper name the module doesn't use", () => {
		const out = run(
			`import { useState } from "preact/hooks";\nconst __pdoHookName = 1;\nfunction f(__pdoHookName1) { const [a] = useState(); }`,
		)!;
		expect(out).toContain(`import { addHookName as __pdoHookName2 } from "preact/devtools";`);
		expect(out).toContain(`__pdoHookName2(useState(), "a")`);
		expect(() => parseAst(out)).not.toThrow();
	});

	it("leaves calls wrapped by an aliased addHookName alone", () => {
		expect(
			run(`import { addHookName as label } from "preact/devtools";\nimport { useState } from "preact/hooks";\nconst [a] = label(useState(0), "count");`),
		).toBeNull();
	});

	it("sees escaped identifiers when picking the helper name", () => {
		const out = run(`import { useState } from "preact/hooks";\nconst __pdoHookNam\\u0065 = 1;\nconst [a] = useState();`)!;
		expect(out).toContain(`import { addHookName as __pdoHookName1 }`);
		expect(() => parseAst(out)).not.toThrow();
	});

	it("keeps a hashbang first", () => {
		const out = run(`#!/usr/bin/env node\nimport { useState } from "preact/hooks";\nconst [a] = useState();`)!;
		expect(out.startsWith(`#!/usr/bin/env node\n${IMPORT}`)).toBe(true);
		expect(run(`#!/usr/bin/env node\n"use client";\nimport { useRef } from "preact/hooks";\nconst a = useRef();`)!).toMatch(
			/^#!\/usr\/bin\/env node\n"use client";\nimport \{ addHookName/,
		);
	});

	it("keeps directives first", () => {
		const out = run(`"use client";\nimport { useState } from "preact/hooks";\nconst [a] = useState();`)!;
		expect(out.startsWith(`"use client";\n${IMPORT}`)).toBe(true);
	});

	it("returns a source map", () => {
		const result = transformHookNames(
			`import { useState } from "preact/hooks";\nconst [a] = useState();`,
			parseAst,
		)!;
		expect(result.map.mappings).not.toBe("");
	});
});

describe("preactDevtoolsOverlay() hook names", () => {
	const transform = (options = {}) => {
		const plugin = preactDevtoolsOverlay(options).find(p => p.name === "preact-devtools-overlay:hook-names") as any;
		const ctx = { parse: parseAst };
		return (code: string, id: string) => plugin.transform.call(ctx, code, id)?.code ?? null;
	};
	const code = `import { useState } from "preact/hooks";\nconst [a] = useState();`;

	it("runs after prefresh, in a plugin of its own", () => {
		const plugins = preactDevtoolsOverlay();
		expect(plugins.map(p => [p.name, p.enforce])).toEqual([
			["preact-devtools-overlay", undefined],
			["preact-devtools-overlay:hook-names", "post"],
		]);
		// Hook-level "post" would run after import analysis.
		expect(typeof plugins[1].transform).toBe("function");
		expect((preactDevtoolsOverlay({ apply: "build" })[1] as any).apply({}, { command: "serve" })).toBe(false);
	});

	it("names hooks in the app's own modules", () => {
		const t = transform();
		expect(t(code, "/app/src/main.tsx")).toContain(`__pdoHookName(useState(), "a")`);
		expect(t(code, "/app/src/main.tsx?v=123")).toContain(`__pdoHookName`);
		expect(t(code, "/app/node_modules/lib/index.js")).toBeNull();
		expect(t(code, "\0virtual:thing.js")).toBeNull();
		expect(t(code, "/app/src/style.css")).toBeNull();
	});

	it("can be turned off", () => {
		expect(preactDevtoolsOverlay({ hookNames: false }).map(p => p.name)).toEqual(["preact-devtools-overlay"]);
	});

	it("pre-bundles preact/devtools for the injected import", () => {
		const plugin = preactDevtoolsOverlay({ signals: false })[0] as any;
		const config = plugin.config({ root: "/nowhere" }, { command: "serve", mode: "development" });
		expect(config.optimizeDeps.include).toContain("preact/devtools");
	});
});
