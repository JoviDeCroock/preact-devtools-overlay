/**
 * Render log types, kept apart from `render-log.ts` so the published type
 * declarations don't reach into vendored code.
 */

export type RenderReason =
	| "mount"
	| "signal"
	| "hooks"
	| "state"
	| "props"
	| "context"
	| "parent"
	| "force";

export interface Change {
	key: string;
	prev: unknown;
	next: unknown;
}

export interface RenderLogEntry {
	/** Increases by one per Preact commit (across all roots). */
	commit: number;
	/** `performance.now()` when the component rendered. */
	time: number;
	name: string;
	/** Main reason; see `reasons` for all of them. */
	reason: RenderReason;
	reasons: RenderReason[];
	props?: Change[];
	state?: Change[];
	/** Changed `useState`/`useReducer` values, keyed `useState[<hook index>]`. */
	hooks?: Change[];
	/** Signals read during the previous render whose value changed since. */
	signals?: Change[];
	/** Consumed contexts (`useContext`, `contextType`) whose value changed, keyed by display name. */
	context?: Change[];
	/** Render time of the component itself plus its subtree. */
	durationMs: number;
	/** @internal Used to resolve the devtools id at query time. */
	component: WeakRef<object> | null;
}
