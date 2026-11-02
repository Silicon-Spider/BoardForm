// Doc comments use `backticks` for code; this splits them for rendering. Headless.

export interface DocPart {
  code: boolean;
  text: string;
}

/** "Bitboard of `sq`." -> [{ text: "Bitboard of " }, { code: true, text: "sq" }, { text: "." }] */
export function docParts(text: string): DocPart[] {
  const parts: DocPart[] = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) });
    parts.push({ code: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}
