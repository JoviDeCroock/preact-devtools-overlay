/**
 * A page-side copy of the component tree the Components panel shows.
 *
 * The devtools hook describes every commit as an `operation_v2` message (the
 * same stream the extension relays to its panel). The panel decodes it into
 * immutable maps (`ops2Tree`), copying the whole tree per commit. This
 * decoder follows the exact same format but mutates in place, so keeping it
 * up to date on every commit stays cheap even when nobody looks at it.
 */
import { parseTable } from "../../vendor/preact-devtools/src/adapter/protocol/string-table";
import { parseStats } from "../../vendor/preact-devtools/src/adapter/shared/stats";

// Mirrors `MsgTypes` in the vendored `protocol/events.ts`. Duplicated so this
// module doesn't import the panel-side half of that file.
const ADD_ROOT = 1;
const ADD_VNODE = 2;
const REMOVE_VNODE = 3;
const UPDATE_VNODE_TIMINGS = 4;
const REORDER_CHILDREN = 5;
const RENDER_REASON = 6;
const COMMIT_STATS = 7;
const HOC_NODES = 8;

/** Mirrors `DevNodeType` in the vendored `view/store/types.ts`. */
export const NODE_KINDS = [
	"group",
	"element",
	"class",
	"function",
	"forwardRef",
	"memo",
	"suspense",
	"context",
	"consumer",
	"portal",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export interface TreeNode {
	id: number;
	name: string;
	kind: NodeKind;
	key: string;
	parent: number;
	owner: number;
	children: number[];
	depth: number;
	/** Names of higher-order components folded into this node. */
	hocs: string[] | null;
}

export interface AppliedCommit {
	rootId: number;
	/** Nodes that rendered in this commit (mounted or updated). */
	rendered: number[];
	mounted: number[];
	unmounted: number[];
}

export class ComponentTree {
	readonly nodes = new Map<number, TreeNode>();
	readonly roots: number[] = [];
	/** Bumped for every applied message, so callers can cache derived data. */
	version = 0;

	get(id: number): TreeNode | undefined {
		return this.nodes.get(id);
	}

	/**
	 * Names from the top down to `id` (inclusive). Like the Components panel,
	 * leaves out the root node (the `Fragment` Preact wraps every `render()` in).
	 */
	path(id: number): string[] {
		const out: string[] = [];
		const seen = new Set<number>();
		let node = this.nodes.get(id);
		while (node && !seen.has(node.id) && !this.roots.includes(node.id)) {
			seen.add(node.id);
			out.unshift(node.name);
			node = this.nodes.get(node.parent);
		}
		return out;
	}

	/** Top-level components: the children of every root. */
	topLevel(): number[] {
		return this.roots.flatMap(id => this.nodes.get(id)?.children ?? []);
	}

	/** Decodes one `operation_v2` message. Malformed input throws. */
	apply(ops: number[]): AppliedCommit {
		this.version++;
		const rootId = ops[0];
		const result: AppliedCommit = { rootId, rendered: [], mounted: [], unmounted: [] };

		let i = ops[1] + 1;
		const strings = parseTable(ops.slice(1, i + 1));

		for (i += 1; i < ops.length; i++) {
			switch (ops[i]) {
				case ADD_ROOT:
					if (!this.roots.includes(ops[i + 1])) this.roots.push(ops[i + 1]);
					i += 1;
					break;
				case ADD_VNODE: {
					const id = ops[i + 1];
					const parentId = ops[i + 3];
					const parent = this.nodes.get(parentId);
					// Like `ops2Tree`: ids are unique per mount, so no duplicate check
					// (which would be quadratic for wide lists).
					if (parent) parent.children.push(id);
					this.nodes.set(id, {
						id,
						name: strings[ops[i + 5] - 1],
						kind: NODE_KINDS[ops[i + 2]] ?? "function",
						key: ops[i + 6] > 0 ? strings[ops[i + 6] - 1] : "",
						parent: parentId,
						owner: ops[i + 4],
						children: [],
						depth: parent ? parent.depth + 1 : 0,
						hocs: null,
					});
					result.rendered.push(id);
					result.mounted.push(id);
					i += 8;
					break;
				}
				case UPDATE_VNODE_TIMINGS:
					result.rendered.push(ops[i + 1]);
					i += 3;
					break;
				case REMOVE_VNODE: {
					const count = ops[i + 1];
					i += 2;
					const end = i + count;
					for (; i < end; i++) this.#remove(ops[i], result);
					// The outer loop increments `i` once more.
					if (count > 0) i--;
					break;
				}
				case REORDER_CHILDREN: {
					const parent = this.nodes.get(ops[i + 1]);
					const count = ops[i + 2];
					if (parent) parent.children = ops.slice(i + 3, i + 3 + count);
					i += 2 + count;
					break;
				}
				case RENDER_REASON:
					// Only sent while profiling with "capture render reasons". The
					// agent API computes its own, richer reasons (render-log.ts).
					i += 3 + ops[i + 3];
					break;
				case COMMIT_STATS:
					i = parseStats(i + 1, ops).i;
					break;
				case HOC_NODES: {
					const node = this.nodes.get(ops[i + 1]);
					const count = ops[i + 2];
					if (node) {
						node.hocs = ops.slice(i + 3, i + 3 + count).map(s => strings[s - 1]);
					}
					i += 2 + count;
					break;
				}
				default:
					throw new Error(`Unknown devtools operation ${ops[i]} at ${i}`);
			}
		}

		return result;
	}

	#remove(id: number, result: AppliedCommit) {
		const node = this.nodes.get(id);
		if (!node) return;
		const parent = this.nodes.get(node.parent);
		if (parent) {
			const idx = parent.children.indexOf(id);
			if (idx > -1) parent.children.splice(idx, 1);
		}
		const rootIdx = this.roots.indexOf(id);
		if (rootIdx > -1) this.roots.splice(rootIdx, 1);

		const stack = [id];
		let item;
		while ((item = stack.pop()) !== undefined) {
			const child = this.nodes.get(item);
			if (!child) continue;
			this.nodes.delete(item);
			result.unmounted.push(item);
			stack.push(...child.children);
		}
	}

	clear() {
		this.version++;
		this.nodes.clear();
		this.roots.length = 0;
	}
}
