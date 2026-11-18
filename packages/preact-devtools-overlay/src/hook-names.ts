/**
 * Names stateful hooks after the variable they're assigned to:
 *
 *   const [count, setCount] = useState(0);
 *   // becomes
 *   const [count, setCount] = __pdoHookName(useState(0), "count");
 *
 * `addHookName` (from `preact/devtools`) passes the name to the devtools,
 * which show it in the Hooks panel, and to the render log, which reports
 * `count: 0 → 1` instead of `useState[0]: 0 → 1`.
 *
 * @preact/preset-vite does the same, but only with `devToolsEnabled`, which
 * people turn off next to this plugin (it loads `preact/debug` itself).
 * Applying both is harmless: an already wrapped call is skipped.
 *
 * Node only.
 */
import MagicString from "magic-string";

const HOOK_SOURCES = new Set(["preact/hooks", "preact/compat", "react"]);
const HOOKS = new Set(["useState", "useReducer", "useRef", "useMemo"]);
const MAYBE_HOOKS = /\buse(?:State|Reducer|Ref|Memo)\b/;
const HELPER = "__pdoHookName";
const OURS = /^__pdoHookName\d*$/;

export const HOOK_NAMES_FILE = /\.[cm]?[jt]sx?$/;

interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

/** The first name a pattern binds: `[count, setCount]` → `count`. */
function firstName(node: any): string | null {
	if (!node) return null;
	switch (node.type) {
		case "Identifier":
			return node.name;
		case "ArrayPattern":
			for (const el of node.elements) {
				const name = firstName(el);
				if (name) return name;
			}
			return null;
		case "ObjectPattern":
			for (const prop of node.properties) {
				const name = firstName(prop.type === "RestElement" ? prop.argument : prop.value);
				if (name) return name;
			}
			return null;
		case "AssignmentPattern":
			return firstName(node.left);
		case "RestElement":
			return firstName(node.argument);
		default:
			return null;
	}
}

function bindingName(parent: any): string | null {
	if (parent?.type === "VariableDeclarator") return firstName(parent.id);
	if (parent?.type === "AssignmentExpression") return firstName(parent.left);
	return null;
}

/**
 * `useState` & co. imported by their own name from a hooks module, and the
 * local names of `addHookName` (already wrapped calls are left alone).
 */
function imports(program: any): { hooks: Set<string>; namers: Set<string> } {
	const hooks = new Set<string>();
	const namers = new Set<string>(["addHookName"]);
	for (const node of program.body) {
		if (node.type !== "ImportDeclaration" || node.importKind === "type") continue;
		const source = node.source.value;
		for (const spec of node.specifiers) {
			if (spec.type !== "ImportSpecifier") continue;
			const imported = spec.imported.name ?? spec.imported.value;
			if (HOOK_SOURCES.has(source) && HOOKS.has(imported) && spec.local.name === imported) hooks.add(imported);
			if (source === "preact/devtools" && imported === "addHookName") namers.add(spec.local.name);
		}
	}
	return { hooks, namers };
}

function walk(node: any, parent: any, visit: (node: Node, parent: any) => void): void {
	visit(node, parent);
	for (const key in node) {
		if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const child of value) {
				if (child && typeof child.type === "string") walk(child, node, visit);
			}
		} else if (value && typeof value.type === "string") {
			walk(value, node, visit);
		}
	}
}

/**
 * Wraps named `useState` / `useReducer` / `useRef` / `useMemo` calls in
 * `code`. `parse` returns an ESTree program with `start`/`end` offsets
 * (Vite's `this.parse`). Returns null when there's nothing to name.
 */
export function transformHookNames(
	code: string,
	parse: (code: string) => unknown,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
	if (!MAYBE_HOOKS.test(code)) return null;
	let program: any;
	try {
		program = parse(code);
	} catch {
		return null;
	}
	if (!program || !Array.isArray(program.body)) return null;
	const { hooks, namers } = imports(program);
	if (hooks.size === 0) return null;

	const identifiers = new Set<string>();
	const calls: Array<{ start: number; end: number; name: string }> = [];
	walk(program, null, (node, parent) => {
		if (node.type === "Identifier" || node.type === "JSXIdentifier") identifiers.add(node.name as string);
		if (node.type !== "CallExpression") return;
		const callee = node.callee as any;
		if (callee?.type !== "Identifier" || !hooks.has(callee.name)) return;
		// Already wrapped (@preact/preset-vite's transform, or by hand).
		const wrapper = parent?.type === "CallExpression" && parent.callee?.type === "Identifier" ? parent.callee.name : null;
		if (wrapper && (namers.has(wrapper) || OURS.test(wrapper))) return;
		// Unassigned calls get "": the devtools adapter hands names out by
		// position, so every call must pass one for the others to line up.
		calls.push({ start: node.start, end: node.end, name: bindingName(parent) ?? "" });
	});
	if (calls.length === 0) return null;

	// Not a name the module already uses: as an identifier (escapes are
	// decoded by the parser) or anywhere in its text.
	let helper = HELPER;
	for (let i = 1; identifiers.has(helper) || code.includes(helper); i++) helper = `${HELPER}${i}`;

	const s = new MagicString(code);
	for (const call of calls) {
		s.appendLeft(call.start, `${helper}(`);
		s.prependRight(call.end, `, ${JSON.stringify(call.name)})`);
	}

	// After a hashbang and directives ("use client"), which must stay first.
	let at = code.startsWith("#!") ? code.indexOf("\n") + 1 || code.length : 0;
	for (const node of program.body) {
		if (node.type === "ExpressionStatement" && typeof node.directive === "string") at = node.end;
		else break;
	}
	const helperImport = `import { addHookName as ${helper} } from "preact/devtools";\n`;
	if (at === 0) s.prepend(helperImport);
	else if (code[at - 1] === "\n") s.appendLeft(at, helperImport);
	else s.appendLeft(at, `\n${helperImport}`);
	return { code: s.toString(), map: s.generateMap({ hires: "boundary" }) };
}
