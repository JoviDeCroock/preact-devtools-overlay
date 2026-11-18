// Self-reference through package.json "exports".
import {
	mountOverlay,
	defineOverlayElement,
	PreactDevtoolsOverlay,
	type OverlayTab,
} from "preact-devtools-overlay";
import "preact-devtools-overlay/auto";
import { configureSignalsDebug } from "preact-devtools-overlay/client";
import { preactDevtoolsOverlay } from "preact-devtools-overlay/vite";

const el: PreactDevtoolsOverlay = mountOverlay({ open: true, tab: "signals" });
const tab: OverlayTab = el.tab;
el.toggle();
defineOverlayElement("my-devtools");
configureSignalsDebug(() => {}, { consoleLogging: false });
preactDevtoolsOverlay({ apply: "serve", overlay: { position: "top-left" } });

// @ts-expect-error - types must not silently degrade to `any`.
el.definitelyNotAMethod();
// @ts-expect-error - invalid tab
mountOverlay({ tab: "nope" });

export { tab };
