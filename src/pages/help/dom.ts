// DOM helpers for the help page: the scroll container, scrolling to a section, the clipboard.

/** The element that scrolls the page (the app's main area), or the document's scrolling element. */
export function scrollParentOf(el: HTMLElement | null): HTMLElement {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The heading with this anchor inside `root`, if any. */
export function findSection(root: ParentNode | null, anchor: string): HTMLElement | null {
  if (!root) return null;
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(anchor) : anchor.replace(/"/g, '\\"');
  return root.querySelector<HTMLElement>(`[data-anchor="${escaped}"]`);
}

/**
 * Scrolls a section heading into view and moves keyboard focus to it (without a second scroll), so
 * Tab continues from the section. Returns false when the section doesn't exist.
 */
export function scrollToSection(root: ParentNode | null, anchor: string, smooth: boolean): boolean {
  const heading = findSection(root, anchor);
  if (!heading) return false;
  heading.scrollIntoView({ behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto", block: "start" });
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
  return true;
}

/** Copies text to the clipboard; resolves false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall back below
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** True while the user is typing somewhere (so global shortcuts such as "/" must not fire). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
