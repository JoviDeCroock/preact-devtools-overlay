/**
 * Which contexts a component consumes, and which provider supplies each.
 *
 * Preact keeps, per component, a map from context id (`__cC<n>`) to the
 * nearest `<Context.Provider>` *instance* (`component.context`). The
 * provider's `props.value` is the current value. A component consumes a
 * context through `useContext` (the hook state keeps the context object) or
 * a class `contextType` (which `<Context.Consumer>` uses too).
 */

/** Mangled names: `_id`, `_defaultValue`, and the hook state's `_context`. */
function contextId(ctx: any): string | null {
	const id = ctx?._id ?? ctx?.__c;
	return typeof id === "string" && /^__cC\d+$/.test(id) ? id : null;
}

/**
 * Preact 10.25+ contexts are functions (the context is its own Provider);
 * older ones are plain objects with a `Provider` and a `Consumer`.
 */
function isContext(x: any): boolean {
	if (contextId(x) === null) return false;
	return typeof x === "function" || (typeof x === "object" && typeof x.Provider === "function");
}

export function contextName(ctx: any): string {
	const name = ctx?.displayName;
	return typeof name === "string" && name ? name : "Context";
}

export interface ConsumedContext {
	context: any;
	name: string;
	/** The `<Context.Provider>` component instance, or null (default value). */
	provider: any;
	value: unknown;
}

/** Contexts a component reads. `hooks` is its hook state list (`__H.__`). */
export function consumedContexts(
	component: any,
	hooks: any[] | null | undefined,
): Map<object, ConsumedContext> {
	const out = new Map<object, ConsumedContext>();
	if (!component) return out;
	const add = (ctx: any) => {
		if (!isContext(ctx) || out.has(ctx)) return;
		// `_globalContext` (mangled `__n`): id -> provider for every context
		// above. `component.context` is the value itself with `contextType`.
		const providers = component._globalContext ?? component.__n ?? component.context;
		const provider = providers?.[contextId(ctx)!] ?? null;
		out.set(ctx, {
			context: ctx,
			name: contextName(ctx),
			provider,
			value: provider ? provider.props?.value : "_defaultValue" in ctx ? ctx._defaultValue : ctx.__,
		});
	};
	const contextType = component.constructor?.contextType;
	if (contextType) add(contextType);
	if (Array.isArray(hooks)) {
		for (const state of hooks) {
			// `_context`, mangled to `c` (or `__c` in older Preact versions).
			if (state && typeof state === "object") {
				add(state._context);
				add(state.c);
				add(state.__c);
			}
		}
	}
	return out;
}

/** A component's hook state list, like the adapter's `getStatefulHooks`. */
export function hookList(component: any): any[] | null {
	const hooks = component?.__hooks ?? component?.__H;
	const list = hooks?._list ?? hooks?.__ ?? hooks?.i;
	return Array.isArray(list) ? list : null;
}
