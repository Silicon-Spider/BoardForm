// Self-contained replacements for Blockly's media files.
//
// Blockly loads sprites (trashcan, zoom buttons, menu check marks) from `options.media`, which
// defaults to an external CDN — that breaks offline use and is blocked by our COEP headers. We
// pass a data: URL of our own sprite sheet (same layout as Blockly's sprites.svg, colours that
// work on dark and light backgrounds) followed by "#": Blockly appends "/sprites.svg", which
// becomes a harmless URL fragment. The few other images Blockly creates (comment bubble icons)
// are swapped for inline versions by `patchMediaImages`; the .cur cursors are overridden in CSS.

const GREY = "#8b95a5";

/** Same geometry as blockly/media/sprites.svg (96 × 124). */
const SPRITES_SVG = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="96px" height="124px">
<style>
.arrows{fill:${GREY};stroke:none}
.selected>.arrows{fill:#fff}
.checkmark{fill:${GREY};font-family:sans-serif;font-size:10pt;text-anchor:middle}
.trash{fill:${GREY}}
.zoom{fill:none;stroke:${GREY};stroke-width:2;stroke-linecap:round}
.zoom>.center{fill:${GREY};stroke-width:0}
</style>
<rect width="96" height="124" x="0" y="0" fill="none"/>
<g><path class="arrows" d="M 13,1.5 13,14.5 1.74,8 z"/><path class="arrows" d="M 17.5,3 30.5,3 24,14.26 z"/><path class="arrows" d="M 35,1.5 35,14.5 46.26,8 z"/></g>
<g class="selected" transform="translate(0, 16)"><path class="arrows" d="M 13,1.5 13,14.5 1.74,8 z"/><path class="arrows" d="M 17.5,3 30.5,3 24,14.26 z"/><path class="arrows" d="M 35,1.5 35,14.5 46.26,8 z"/></g>
<text class="checkmark" x="55.5" y="28">&#10003;</text>
<g class="trash"><path d="M 2,41 v 6 h 42 v -6 h -10.5 l -3,-3 h -15 l -3,3 z"/><rect width="36" height="20" x="5" y="50"/><rect width="36" height="42" x="5" y="50" rx="4" ry="4"/></g>
<g class="zoom"><circle r="11.5" cx="16" cy="108"/><circle r="4.3" cx="16" cy="108" class="center"/><path d="m 28,108 h3"/><path d="m 1,108 h3"/><path d="m 16,120 v3"/><path d="m 16,93 v3"/></g>
<g class="zoom"><circle r="15" cx="48" cy="108"/><path d="m 48,101.6 v12.8"/><path d="m 41.6,108 h12.8"/></g>
<g class="zoom"><circle r="15" cx="80" cy="108"/><path d="m 73.6,108 h12.8"/></g>
</svg>`;

const ICONS: Record<string, string> = {
  "resize-handle.svg": `<svg xmlns="http://www.w3.org/2000/svg" height="8" viewBox="0 0 8 8" width="8" stroke="${GREY}"><line x1="2.67" y1="7" x2="7" y2="2.67"/><line x1="5.33" y1="7" x2="7" y2="5.33"/></svg>`,
  "foldout-icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24" fill="${GREY}"><path d="M480-360 280-560h400L480-360Z"/></svg>`,
  "delete-icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24" fill="${GREY}"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg>`,
};

function dataUrl(svg: string): string {
  // base64 keeps the URL free of characters that would break an unquoted CSS url(...).
  const bytes = new TextEncoder().encode(svg);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

let mediaPrefix: string | null = null;
const iconUrls = new Map<string, string>();

/** Value for Blockly's `media` option. */
export function blocklyMediaPath(): string {
  mediaPrefix ??= dataUrl(SPRITES_SVG) + "#";
  return mediaPrefix;
}

function iconUrl(name: string): string | null {
  const svg = ICONS[name];
  if (!svg) return null;
  let url = iconUrls.get(name);
  if (!url) iconUrls.set(name, (url = dataUrl(svg)));
  return url;
}

const XLINK = "http://www.w3.org/1999/xlink";

function patchImage(img: Element): void {
  for (const [ns, attr] of [
    [null, "href"],
    [XLINK, "href"],
  ] as const) {
    const href = ns ? img.getAttributeNS(ns, attr) : img.getAttribute(attr);
    if (!href || !href.startsWith("data:image/svg+xml;base64,") || !href.includes("#/")) continue;
    const name = href.slice(href.lastIndexOf("/") + 1);
    const url = iconUrl(name);
    if (!url) continue;
    if (ns) img.setAttributeNS(ns, "xlink:href", url);
    else img.setAttribute(attr, url);
  }
}

/** Replaces Blockly's media images inside `root` (now and when added later). Returns a disposer. */
export function patchMediaImages(root: Element): () => void {
  root.querySelectorAll("image").forEach(patchImage);
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes" && r.target instanceof Element && r.target.localName === "image") patchImage(r.target);
      r.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        if (n.localName === "image") patchImage(n);
        n.querySelectorAll?.("image").forEach(patchImage);
      });
    }
  });
  obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  return () => obs.disconnect();
}
