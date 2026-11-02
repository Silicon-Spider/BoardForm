// FieldPst — a Blockly field holding a piece-square table (64 integers, LERF order: a1 = 0).
// On the block it renders as a small 8×8 heatmap (rank 8 at the top, White's view). Clicking it
// opens an editor in Blockly's DropDownDiv: a numeric grid, presets, mirror / symmetrize / clear,
// and paste-a-table support. Serialised as a JSON array of 64 ints.

import * as Blockly from "blockly";
import {
  PST_MAX,
  PST_MIN,
  PST_PRESETS,
  PST_SIZE,
  boardViewToLerf,
  mirrorLeftToRight,
  normalizePst,
  presetValues,
  symmetrize,
} from "../pst";
import { isLightMode } from "./theme";

export interface FieldPstConfig extends Blockly.FieldConfig {
  /** Preset id used when no value is given (see PST_PRESETS). */
  preset?: string;
  value?: unknown;
}

const CELL = 6;
const PAD = 2;
const SIZE = CELL * 8 + PAD * 2;
const SVG_NS = "http://www.w3.org/2000/svg";

type Rgb = [number, number, number];
const POS: Rgb = [38, 186, 112];
const NEG: Rgb = [232, 76, 80];

function mixRgb(a: Rgb, b: Rgb, t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Strength 0..1 of a value relative to the table's largest magnitude. */
function strength(v: number, maxAbs: number): number {
  return Math.min(1, Math.abs(v) / maxAbs) ** 0.75;
}

function maxAbsOf(values: readonly number[]): number {
  let m = 25;
  for (const v of values) m = Math.max(m, Math.abs(v));
  return m;
}

function thumbColour(v: number, maxAbs: number, lightSquare: boolean): string {
  const base: Rgb = lightSquare ? [238, 240, 245] : [214, 219, 228];
  if (v === 0) return mixRgb(base, base, 0);
  return mixRgb(base, v > 0 ? POS : NEG, 0.18 + 0.82 * strength(v, maxAbs));
}

function heatBackground(v: number, maxAbs: number): string {
  if (v === 0) return "";
  const [r, g, b] = v > 0 ? POS : NEG;
  const a = (0.1 + 0.55 * strength(v, maxAbs)).toFixed(3);
  return `linear-gradient(rgba(${r}, ${g}, ${b}, ${a}), rgba(${r}, ${g}, ${b}, ${a}))`;
}

const PIECE_NAMES: Record<string, string> = {
  PAWN: "Pawns",
  KNIGHT: "Knights",
  BISHOP: "Bishops",
  ROOK: "Rooks",
  QUEEN: "Queens",
  KING: "King",
};

function sameValues(a: readonly number[] | null, b: readonly number[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class FieldPst extends Blockly.Field<number[]> {
  override EDITABLE = true;
  override SERIALIZABLE = true;

  private cells: SVGRectElement[] = [];
  private frame: SVGRectElement | null = null;
  private editor: PstEditor | null = null;

  constructor(value?: unknown, validator?: Blockly.FieldValidator<number[]> | null, config?: FieldPstConfig) {
    super(
      value === Blockly.Field.SKIP_SETUP
        ? Blockly.Field.SKIP_SETUP
        : (normalizePst(value) ?? normalizePst(config?.value) ?? presetValues(config?.preset ?? "ZERO")),
      validator,
      config,
    );
    this.size_ = new Blockly.utils.Size(SIZE, SIZE);
  }

  static override fromJson(options: FieldPstConfig): FieldPst {
    return new FieldPst(options.value, undefined, options);
  }

  // ── value ──

  protected override doClassValidation_(newValue?: unknown): number[] | null {
    return normalizePst(newValue);
  }

  override saveState(): number[] {
    return [...(this.getValue() ?? presetValues("ZERO"))];
  }

  override loadState(state: unknown): void {
    const v = normalizePst(state);
    if (v) this.setValue(v);
  }

  protected override getText_(): string {
    const v = this.getValue();
    if (!v) return "table";
    return `table ${Math.min(...v)} … ${Math.max(...v)}`;
  }

  override getAriaValue(): string {
    return this.getText_();
  }

  // ── rendering ──

  protected override initView(): void {
    const group = this.fieldGroup_;
    if (!group) return;
    group.classList.add("blocks-pst-thumb");
    this.frame = Blockly.utils.dom.createSvgElement(
      Blockly.utils.Svg.RECT,
      { x: 0, y: 0, width: SIZE, height: SIZE, rx: 3, ry: 3, class: "blocks-pst-frame" },
      group,
    );
    // Cells live in their own group: renderers style `.blocklyEditableField > rect`.
    const cellGroup = document.createElementNS(SVG_NS, "g");
    cellGroup.setAttribute("class", "blocks-pst-cells");
    group.appendChild(cellGroup);
    this.cells = [];
    for (let sq = 0; sq < PST_SIZE; sq++) {
      const file = sq & 7;
      const rank = sq >> 3;
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(PAD + file * CELL));
      rect.setAttribute("y", String(PAD + (7 - rank) * CELL));
      rect.setAttribute("width", String(CELL));
      rect.setAttribute("height", String(CELL));
      cellGroup.appendChild(rect);
      this.cells.push(rect);
    }
    this.paintCells();
  }

  private paintCells(): void {
    const v = this.getValue();
    if (!v || this.cells.length !== PST_SIZE) return;
    const m = maxAbsOf(v);
    for (let sq = 0; sq < PST_SIZE; sq++) {
      const light = ((sq & 7) + (sq >> 3)) % 2 === 1;
      this.cells[sq]!.style.fill = thumbColour(v[sq]!, m, light);
    }
  }

  protected override render_(): void {
    this.paintCells();
    this.size_ = new Blockly.utils.Size(SIZE, SIZE);
  }

  protected override updateSize_(): void {
    this.size_ = new Blockly.utils.Size(SIZE, SIZE);
  }

  /**
   * Page-coordinate box of the thumbnail, used to position the editor. (Blockly's default for
   * fields without a border rect measures the whole block *and every block stacked below it*.)
   */
  override getScaledBBox(): Blockly.utils.Rect {
    const r = this.fieldGroup_?.getBoundingClientRect();
    if (!r) return super.getScaledBBox();
    const left = r.left + window.scrollX;
    const top = r.top + window.scrollY;
    return new Blockly.utils.Rect(top, top + r.height, left, left + r.width);
  }

  override applyColour(): void {
    const block = this.getSourceBlock();
    if (this.frame && block instanceof Blockly.BlockSvg) {
      this.frame.setAttribute("stroke", block.getColourTertiary() ?? "#000");
    }
  }

  protected override doValueUpdate_(newValue: number[]): void {
    super.doValueUpdate_(newValue);
    this.editor?.refresh(newValue);
  }

  // ── editor ──

  protected override showEditor_(): void {
    // clearContent() rebuilds the DropDownDiv, so fetch the content element afterwards.
    Blockly.DropDownDiv.clearContent();
    const content = Blockly.DropDownDiv.getContentDiv();
    // The default content area is capped (menus scroll); the grid needs its full height.
    content.style.maxHeight = "none";
    content.style.overflow = "visible";
    this.editor = new PstEditor(this, this.describe());
    content.appendChild(this.editor.root);
    const lightMode = isLightMode();
    Blockly.DropDownDiv.setColour(lightMode ? "#ffffff" : "#1c2129", lightMode ? "#c3ccd7" : "#3a4352");
    Blockly.Events.setGroup(true);
    Blockly.DropDownDiv.showPositionedByField(this.asField(), () => this.onEditorHidden());
    this.editor.focusFirst();
  }

  private onEditorHidden(): void {
    this.editor = null;
    Blockly.Events.setGroup(false);
  }

  override dispose(): void {
    Blockly.DropDownDiv.hideIfOwner(this.asField(), true);
    super.dispose();
  }

  /** "Knights · middlegame" etc., from the block this field sits on. */
  private describe(): string {
    const block = this.getSourceBlock();
    const piece = block?.getField("PIECE") ? String(block.getFieldValue("PIECE")) : "";
    const phase = this.name === "MG" ? "middlegame" : this.name === "EG" ? "endgame" : "";
    const pieceName = PIECE_NAMES[piece];
    if (pieceName) return phase ? `${pieceName} · ${phase}` : pieceName;
    return "Square values";
  }

  /** Called by the editor. */
  setTable(values: number[]): void {
    if (sameValues(this.getValue(), values)) return;
    this.setValue(values);
  }

  closeEditor(): void {
    Blockly.DropDownDiv.hideIfOwner(this.asField());
  }

  /** `this` typed as a plain field (Blockly's DropDownDiv helpers are generic over Field<T>). */
  private asField(): Blockly.Field<number[]> {
    return this;
  }
}

/** The DOM editor shown in the DropDownDiv. */
class PstEditor {
  readonly root: HTMLDivElement;
  private readonly inputs: HTMLInputElement[] = []; // LERF index
  private readonly stats: HTMLDivElement;

  constructor(
    private readonly field: FieldPst,
    title: string,
  ) {
    const root = document.createElement("div");
    root.className = "blocks-pst-editor";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", `Piece-square table: ${title}`);
    this.root = root;

    const head = el("div", "blocks-pst-head");
    head.append(el("div", "blocks-pst-title", title), el("div", "blocks-pst-sub", "Centipawns per square, seen from White's side (Black uses the mirror image)"));
    root.append(head);

    const tools = el("div", "blocks-pst-tools");
    const preset = document.createElement("select");
    preset.className = "select select-sm blocks-pst-preset";
    preset.title = "Replace the whole table with a preset";
    preset.append(new Option("Presets…", ""));
    for (const group of ["Shapes", "PeSTO middlegame", "PeSTO endgame"] as const) {
      const og = document.createElement("optgroup");
      og.label = group;
      for (const p of PST_PRESETS.filter((x) => x.group === group)) og.append(new Option(p.label, p.id));
      preset.append(og);
    }
    preset.addEventListener("change", () => {
      if (!preset.value) return;
      this.apply(presetValues(preset.value));
      preset.value = "";
    });
    tools.append(
      preset,
      button("Mirror", "Copy the queenside (files a–d) onto the kingside (files e–h), mirrored", () => this.apply(mirrorLeftToRight(this.current()))),
      button("Symmetrize", "Average every square with its mirror image across the d/e line", () => this.apply(symmetrize(this.current()))),
      button("Clear", "Set every square to 0", () => this.apply(new Array<number>(PST_SIZE).fill(0))),
    );
    root.append(tools);

    const grid = el("div", "blocks-pst-grid");
    for (let row = 0; row < 8; row++) {
      const rank = 7 - row;
      grid.append(el("span", "blocks-pst-label", String(rank + 1)));
      for (let file = 0; file < 8; file++) {
        const sq = rank * 8 + file;
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "numeric";
        input.spellcheck = false;
        input.autocomplete = "off";
        input.className = `blocks-pst-cell ${(file + rank) % 2 === 1 ? "light" : "dark"}`;
        input.setAttribute("aria-label", `${"abcdefgh"[file]}${rank + 1}`);
        input.title = `${"abcdefgh"[file]}${rank + 1}`;
        input.addEventListener("input", () => this.onCellInput(sq));
        input.addEventListener("blur", () => this.refresh(this.current()));
        input.addEventListener("focus", () => input.select());
        input.addEventListener("keydown", (e) => this.onKey(e, sq));
        input.addEventListener("paste", (e) => this.onPaste(e, sq));
        this.inputs[sq] = input;
        grid.append(input);
      }
    }
    grid.append(el("span", "blocks-pst-label"));
    for (const f of "abcdefgh") grid.append(el("span", "blocks-pst-label", f));
    root.append(grid);

    const foot = el("div", "blocks-pst-foot");
    this.stats = el("div", "blocks-pst-stats");
    const done = button("Done", "Close (Esc)", () => this.field.closeEditor());
    done.classList.add("btn-primary");
    foot.append(this.stats, done);
    root.append(foot);

    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.field.closeEditor();
      }
      e.stopPropagation(); // keep Blockly's keyboard shortcuts (delete, copy …) away from the editor
    });

    this.refresh(this.current());
  }

  private current(): number[] {
    return [...(this.field.getValue() ?? new Array<number>(PST_SIZE).fill(0))];
  }

  private apply(values: number[]): void {
    const v = normalizePst(values);
    if (v) this.field.setTable(v);
    this.refresh(this.current());
  }

  /** Re-renders all cells from `values` (keeps the cell being typed in untouched). */
  refresh(values: readonly number[]): void {
    const m = maxAbsOf(values);
    const active = document.activeElement;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let sq = 0; sq < PST_SIZE; sq++) {
      const v = values[sq] ?? 0;
      const input = this.inputs[sq];
      if (!input) continue;
      if (input !== active) {
        input.value = String(v);
        input.classList.remove("invalid");
      }
      input.style.backgroundImage = heatBackground(v, m);
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    this.stats.textContent = `min ${min} · max ${max} · average ${Math.round(sum / PST_SIZE)}`;
  }

  private onCellInput(sq: number): void {
    const input = this.inputs[sq]!;
    const text = input.value.trim().replace("−", "-");
    if (text === "" || text === "-" || text === "+") {
      input.classList.add("invalid");
      return;
    }
    const n = Number(text);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      input.classList.add("invalid");
      return;
    }
    const values = this.current();
    values[sq] = Math.max(PST_MIN, Math.min(PST_MAX, n));
    this.field.setTable(values);
    this.refresh(this.current());
  }

  private onKey(e: KeyboardEvent, sq: number): void {
    const file = sq & 7;
    const rank = sq >> 3;
    let target = -1;
    // Arrow keys move between cells like a spreadsheet (rank 8 is the top row).
    if (e.key === "ArrowUp" && rank < 7) target = sq + 8;
    else if (e.key === "ArrowDown" && rank > 0) target = sq - 8;
    else if (e.key === "ArrowLeft" && file > 0) target = sq - 1;
    else if (e.key === "ArrowRight" && file < 7) target = sq + 1;
    else if (e.key === "Enter") {
      // Reading order of a printed board: left to right, rank 8 down to rank 1.
      target = file < 7 ? sq + 1 : rank > 0 ? sq - 15 : -1;
      if (target < 0) {
        e.preventDefault();
        this.field.closeEditor();
        return;
      }
    }
    if (target >= 0) {
      e.preventDefault();
      this.inputs[target]?.focus();
    }
  }

  /** Pasting 64 numbers (a printed board, rank 8 first) fills the whole table. */
  private onPaste(e: ClipboardEvent, sq: number): void {
    const text = e.clipboardData?.getData("text") ?? "";
    const nums = text.match(/-?\d+/g)?.map(Number) ?? [];
    if (nums.length >= PST_SIZE) {
      e.preventDefault();
      this.apply(boardViewToLerf(nums.slice(0, PST_SIZE)));
      this.inputs[sq]?.select();
    }
  }

  focusFirst(): void {
    // Focus after the DropDownDiv has positioned itself.
    setTimeout(() => this.inputs[56]?.focus(), 0);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "btn btn-sm", text);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}
