/**
 * The DOM tree that the devtools UI is rendered into. Defaults to `document`,
 * but must be set to the ShadowRoot when the UI is mounted inside a shadow
 * tree, otherwise `document.querySelector` can't see our elements.
 */
let queryRoot: ParentNode | null = null;

export function setQueryRoot(root: ParentNode | null) {
	queryRoot = root;
}

export function getQueryRoot(): ParentNode {
	return queryRoot ?? document;
}
