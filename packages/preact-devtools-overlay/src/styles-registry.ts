/**
 * Collects the compiled CSS of every stylesheet imported by this package.
 * Populated by `build/css-plugin.mjs`, which turns each `.css` import into a
 * `registerStyle()` call so the CSS can be adopted by shadow roots (or the
 * page, for the in-page highlighter) instead of being injected globally.
 */
export type StyleScope = "preact" | "signals" | "insights" | "shell";

const styles: Record<StyleScope, string[]> = {
	preact: [],
	signals: [],
	insights: [],
	shell: [],
};

export function registerStyle(scope: StyleScope, css: string) {
	styles[scope].push(css);
}

export function getStyles(scope: StyleScope): string {
	return styles[scope].join("\n");
}

export function createStyleElement(
	doc: Document,
	scope: StyleScope,
	extra = "",
): HTMLStyleElement {
	const el = doc.createElement("style");
	el.dataset.preactDevtoolsOverlay = scope;
	el.textContent = getStyles(scope) + extra;
	return el;
}
