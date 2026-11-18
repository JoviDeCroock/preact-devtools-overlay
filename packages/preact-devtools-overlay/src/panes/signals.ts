/**
 * "Signals" pane: the upstream @preact/signals devtools UI, connected to
 * `@preact/signals-debug` running in the same window via the direct adapter.
 */
import {
	getContext,
	mount,
	setQueryRoot,
} from "../../vendor/signals-devtools/devtools-ui/src/index";
import { createDirectAdapter } from "../../vendor/signals-devtools/devtools-adapter/src/index";
import "../../vendor/signals-devtools/devtools-ui/src/styles.css";
import { createStyleElement } from "../styles-registry.js";

const BASE_CSS = `
:host { display: block; height: 100%; }
.pdo-root, .pdo-root > .signals-devtools { height: 100%; }
.pdo-waiting { margin: 0; padding: 16px; font: 13px/1.5 system-ui, sans-serif; color: #666; }
@media (prefers-color-scheme: dark) { .pdo-waiting { color: #aaa; } }
`;

export interface SignalsPane {
	destroy(): void;
}

export async function mountSignalsPane(
	shadow: ShadowRoot,
	win: Window,
): Promise<SignalsPane> {
	const doc = shadow.ownerDocument;
	shadow.appendChild(createStyleElement(doc, "signals", BASE_CSS));

	const container = doc.createElement("div");
	container.className = "pdo-root";
	shadow.appendChild(container);

	// Let the (patched) theme model find `.signals-devtools` in our shadow tree.
	setQueryRoot(shadow);

	// `mount()` waits (up to 10s) for `@preact/signals-debug` to show up
	// before rendering anything. Explain what's going on in the meantime;
	// `mount()` clears the container once it renders.
	if (!win.__PREACT_SIGNALS_DEVTOOLS__) {
		const hint = doc.createElement("p");
		hint.className = "pdo-waiting";
		hint.innerHTML =
			"Waiting for <code>@preact/signals-debug</code>&hellip; It must be imported before your app creates any signals. The Vite plugin does this automatically when <code>@preact/signals</code> is installed.";
		container.appendChild(hint);
	}

	// The client has been recording signal updates since page load; the relay
	// replays them, so the pane also shows what happened before it opened.
	const store = win.__PREACT_DEVTOOLS_OVERLAY__?.signals;
	// In case it was (re)defined in a way our watcher couldn't see.
	store?.sync(win);
	const adapter = createDirectAdapter({
		targetWindow: store ? store.relayWindow(win) : win,
	});
	const unmount = await mount({ adapter, container });

	// Show the options the page actually configured instead of the panel's
	// defaults, so "Apply" doesn't silently re-enable console logging.
	const configured = win.__PREACT_DEVTOOLS_OVERLAY__?.signalsDebugConfig;
	if (configured) {
		const { settingsStore } = getContext();
		settingsStore.settings.value = { ...settingsStore.settings.value, ...configured };
	}

	return {
		destroy() {
			// Also disconnects the adapter.
			unmount();
			setQueryRoot(null);
			shadow.replaceChildren();
		},
	};
}
