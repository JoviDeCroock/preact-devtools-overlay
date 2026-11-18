// Self-reference through package.json "exports".
import {
	mountOverlay,
	defineOverlayElement,
	PreactDevtoolsOverlay,
	type OverlayTab,
} from "preact-devtools-overlay";
import "preact-devtools-overlay/auto";
import { configureSignalsDebug, type AgentApi } from "preact-devtools-overlay/client";
import { preactDevtoolsOverlay } from "preact-devtools-overlay/vite";

const el: PreactDevtoolsOverlay = mountOverlay({ open: true, tab: "signals" });
const tab: OverlayTab = el.tab;
el.toggle();
defineOverlayElement("my-devtools");
configureSignalsDebug(() => {}, { consoleLogging: false });
preactDevtoolsOverlay({ apply: "serve", overlay: { position: "top-left" } });

// The agent API is typed on `window`.
const api: AgentApi | undefined = window.__PREACT_DEVTOOLS_OVERLAY__?.api;
const reason: "mount" | "signal" | "hooks" | "state" | "props" | "parent" | "force" | undefined = (
	api?.whyDidRender("App") as Array<{ reason: any }> | undefined
)?.[0]?.reason;
api?.getTree({ format: "text" });
// @ts-expect-error - unknown option value
api?.getTree({ format: "yaml" });

// @ts-expect-error - types must not silently degrade to `any`.
el.definitelyNotAMethod();
// @ts-expect-error - invalid tab
mountOverlay({ tab: "nope" });

export { tab, reason };
