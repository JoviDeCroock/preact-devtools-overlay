/**
 * Opening a component's source in the editor, through the dev server.
 *
 * Vite serves `/__open-in-editor?file=<path>:<line>:<column>` (its error
 * overlay uses it too). The Vite plugin passes that URL, including the
 * configured `base`, in the client config. Without it (no Vite, or a build)
 * there's nothing to call.
 */

export function canOpenInEditor(win: Window = window): boolean {
	return typeof win.__PREACT_DEVTOOLS_OVERLAY_CONFIG__?.openInEditor === "string";
}

/** `source` is `file:line:column`, as returned by the agent API. */
export function openInEditor(source: string, win: Window = window): boolean {
	const endpoint = win.__PREACT_DEVTOOLS_OVERLAY_CONFIG__?.openInEditor;
	if (typeof endpoint !== "string" || !source) return false;
	const url = new URL(endpoint, win.location.href);
	url.searchParams.set("file", source);
	win.fetch(url).catch(err => {
		console.warn("[preact-devtools-overlay] Could not open the editor.", err);
	});
	return true;
}

/**
 * Where a component is rendered (the JSX element's `__source`, added by the
 * JSX dev transform), as `file:line:column`.
 */
export function sourceOf(id: number, win: Window = window): string | null {
	const renderers = win.__PREACT_DEVTOOLS__?.renderers;
	if (!(renderers instanceof Map)) return null;
	for (const r of renderers.values()) {
		try {
			const src = r?.getVNodeById?.(id)?.__source;
			if (src?.fileName) return `${src.fileName}:${src.lineNumber ?? 0}:${src.columnNumber ?? 0}`;
		} catch {
			// ignore
		}
	}
	return null;
}
