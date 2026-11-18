/**
 * "Signals" pane: the upstream @preact/signals devtools UI, connected to
 * `@preact/signals-debug` running in the same window via the direct adapter.
 */
import {
	mount,
	setQueryRoot,
} from "../../vendor/signals-devtools/devtools-ui/src/index";
import { createDirectAdapter } from "../../vendor/signals-devtools/devtools-adapter/src/index";
import "../../vendor/signals-devtools/devtools-ui/src/styles.css";
import { createStyleElement } from "../styles-registry";

const BASE_CSS = `
:host { display: block; height: 100%; }
.pdo-root, .pdo-root > .signals-devtools { height: 100%; }
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

	const adapter = createDirectAdapter({ targetWindow: win });
	const unmount = await mount({ adapter, container });

	return {
		destroy() {
			// Also disconnects the adapter.
			unmount();
			setQueryRoot(null);
			shadow.replaceChildren();
		},
	};
}
