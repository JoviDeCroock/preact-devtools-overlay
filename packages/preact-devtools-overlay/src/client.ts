/**
 * Page-side hook. Must be evaluated before Preact's `preact/devtools` (or
 * `preact/debug`) module, because that module looks for
 * `window.__PREACT_DEVTOOLS__` once, at import time.
 *
 *   import "preact-devtools-overlay/client"; // first import of your app
 *   import "preact/debug";
 *
 * This is the in-page equivalent of the browser extension's `installHook`
 * content script, using the exact same adapter code.
 */
import { createHook } from "../vendor/preact-devtools/src/adapter/hook";
import { createPortForHook } from "../vendor/preact-devtools/src/adapter/adapter/port";
import {
	PROFILE_RELOAD,
	STATS_RELOAD,
} from "../vendor/preact-devtools/src/constants";
import { bindingsV10 } from "../vendor/preact-devtools/src/adapter/10/bindings";
import { bindingsV11 } from "../vendor/preact-devtools/src/adapter/11/bindings";
import { createStyleElement } from "./styles-registry.js";
import {
	isPageHookMessage,
	MAX_SESSION_EVENTS,
	type OverlayClientState,
} from "./shared.js";
import { ComponentTree } from "./agent/tree.js";
import { RingBuffer } from "./agent/ring-buffer.js";
import { instrumentRenders, type RenderLogEntry } from "./agent/render-log.js";
import { SignalsStore, watchSignalsDebug } from "./agent/signals.js";
import { createAgentApi } from "./agent/api.js";

declare const __PDO_VERSION__: string;

/** Renders kept for the agent API. */
export type { AgentApi, Target, Format } from "./agent/api.js";
export type { RenderReason } from "./agent/render-types.js";
// Also brings the `window.__PREACT_DEVTOOLS_OVERLAY__` global into scope.
export type { OverlayClientState, OverlayClientConfig } from "./shared.js";

export const MAX_RENDER_LOG = 500;

function install() {
	if (window.__PREACT_DEVTOOLS_OVERLAY__) return;

	const config = window.__PREACT_DEVTOOLS_OVERLAY_CONFIG__ ?? {};
	const agentApi = config.agentApi !== false;

	// One counter for every buffer, so a single `mark()` cursor works for all.
	let seq = 0;
	const nextSeq = () => ++seq;

	const state: OverlayClientState = {
		version: __PDO_VERSION__,
		reusedExistingHook: !!window.__PREACT_DEVTOOLS__,
		attachEvents: [],
		reloadSession: null,
		signals: new SignalsStore(nextSeq),
	};
	window.__PREACT_DEVTOOLS_OVERLAY__ = state;
	watchSignalsDebug(window, api => state.signals!.attach(api));

	// Must be read before the hook consumes (and removes) these flags when
	// the first renderer attaches. When we reuse a hook we didn't install
	// (the browser extension's), the flags belong to that devtools instance.
	if (!state.reusedExistingHook) {
		try {
			if (localStorage.getItem(PROFILE_RELOAD) !== null) {
				state.reloadSession = { kind: "profile", events: [], truncated: false };
			} else if (localStorage.getItem(STATS_RELOAD) !== null) {
				state.reloadSession = { kind: "stats", events: [], truncated: false };
			}
		} catch {
			// Storage disabled: the hook can't read the flags either.
		}
	}

	// Agent API: a page-side copy of the component tree, fed by the same
	// messages the Components panel receives.
	const tree = new ComponentTree();
	let treeBroken = false;
	const onHookEvent = (type: string, data: unknown) => {
		if (type !== "operation_v2" || treeBroken || !Array.isArray(data)) return;
		try {
			tree.apply(data);
		} catch (err) {
			// A message we can't decode means the tree is out of sync for good.
			treeBroken = true;
			tree.clear();
			console.warn("[preact-devtools-overlay] agent API: lost track of the component tree.", err);
		}
	};

	window.addEventListener("message", e => {
		if (!isPageHookMessage(e, window)) return;
		const { type, data } = e.data;
		// With a hook we didn't install, messages are the only way to see commits.
		if (agentApi && state.reusedExistingHook) onHookEvent(type, data);
		// `attach` carries the renderer's feature flags (profiling, hooks,
		// render reasons) and is sent only once per renderer, so a panel that
		// mounts later would otherwise never see it.
		if (type === "attach") state.attachEvents.push({ type, data });

		const session = state.reloadSession;
		if (session) {
			if (session.events.length < MAX_SESSION_EVENTS) {
				session.events.push({ type, data });
			} else {
				session.truncated = true;
			}
		}
	});

	if (!state.reusedExistingHook) {
		const port = createPortForHook(window);
		if (agentApi) {
			// See every hook event synchronously, inside the commit that caused
			// it, so the agent API is up to date as soon as a render finished.
			const send = port.send;
			port.send = ((type: string, data: unknown) => {
				onHookEvent(type, data);
				return send(type as any, data as any);
			}) as typeof port.send;
		}
		window.__PREACT_DEVTOOLS__ = createHook(port);
	}

	if (agentApi) {
		const hook = window.__PREACT_DEVTOOLS__;
		const renders = new RingBuffer<RenderLogEntry>(MAX_RENDER_LOG, nextSeq);
		let commit = 0;
		const attachPreact = hook?.attachPreact;
		if (typeof attachPreact === "function") {
			try {
				hook.attachPreact = (version: string, options: any, rendererConfig: any) => {
					const id = attachPreact.call(hook, version, options, rendererConfig);
					if (id !== -1 && options && rendererConfig) {
						try {
							instrumentRenders(
								options,
								rendererConfig,
								/^11\./.test(String(version)) ? bindingsV11 : bindingsV10,
								entries => entries.forEach(e => renders.push(e)),
								() => ++commit,
							);
						} catch (err) {
							console.warn("[preact-devtools-overlay] agent API: could not record renders.", err);
						}
					}
					return id;
				};
			} catch {
				// A frozen hook (not ours): the render log stays empty.
			}
		}

		state.api = createAgentApi({
			tree,
			renders,
			signals: state.signals!,
			getRenderers: () => (hook?.renderers instanceof Map ? hook.renderers.values() : []),
			currentSeq: () => seq,
			version: __PDO_VERSION__,
			asyncTree: state.reusedExistingHook,
		});
	}

	// Styles for the element highlighter / render-update canvas, which are
	// rendered into the page itself (outside of the overlay's shadow root).
	const style = createStyleElement(document, "preact");
	(document.head || document.documentElement).appendChild(style);
}

if (typeof window !== "undefined") {
	install();
}

/**
 * Applies options to `@preact/signals-debug`. Pass its `setDebugOptions`:
 *
 *   import { setDebugOptions } from "@preact/signals-debug";
 *   configureSignalsDebug(setDebugOptions, { consoleLogging: false });
 *
 * Calling `setDebugOptions` alone isn't enough: signals-debug keeps a second
 * copy of its config for devtools, which it reports to the Signals panel and
 * re-applies whenever settings change there. That copy is only updated
 * through a `CONFIGURE_DEBUG` message.
 */
export function configureSignalsDebug(
	setDebugOptions: (options: { consoleLogging?: boolean }) => void,
	options: { consoleLogging?: boolean } = {},
) {
	const config = { consoleLogging: options.consoleLogging ?? false };
	// Synchronously, so it applies to signals created right after this call.
	setDebugOptions(config);
	if (typeof window !== "undefined") {
		if (window.__PREACT_DEVTOOLS_OVERLAY__) {
			window.__PREACT_DEVTOOLS_OVERLAY__.signalsDebugConfig = config;
		}
		window.postMessage(
			{ type: "CONFIGURE_DEBUG", payload: config },
			window.location.origin,
		);
	}
}
