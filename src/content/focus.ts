// Focus lookup that sees through the overlay's closed shadow root. From
// the document's side, focus inside a closed shadow tree reports only the
// retargeted host; the shadow root itself holds the real active element.

/** The element holding focus in `node`'s tree — the shadow root's own
 * activeElement when `node` lives in one, the document's otherwise, and
 * null for a node in a detached tree. */
export function activeElementIn(node: Node): Element | null {
  const root = node.getRootNode();
  if (root instanceof Document || root instanceof ShadowRoot) {
    return root.activeElement;
  }
  return null;
}
