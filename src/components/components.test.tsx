// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { START_FEN } from "@/chess";
import type { EngineRecord } from "@/types";

// Decouple from the storage implementation (IndexedDB is not available in jsdom).
vi.mock("@/storage", () => ({ useEngines: () => undefined }));

import { Chessboard } from "./Chessboard";
import { MoveList } from "./MoveList";
import { BoardEditor } from "./BoardEditor";
import { LimitsEditor } from "./LimitsEditor";
import { EnginePicker } from "./EnginePicker";
import { Modal } from "./Modal";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function render(ui: React.ReactNode) {
  act(() => root.render(ui));
}

const SIZE = 400;

/** jsdom has no layout: give an element a fixed 400×400 box at the origin. */
function mockRect(el: Element) {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, width: SIZE, height: SIZE, right: SIZE, bottom: SIZE, toJSON() {} }) as DOMRect;
}

function center(square: string, orientation: "white" | "black" = "white") {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const col = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;
  const s = SIZE / 8;
  return { x: (col + 0.5) * s, y: (row + 0.5) * s };
}

function pointer(el: Element, type: string, square: string, extra: PointerEventInit = {}) {
  const { x, y } = center(square);
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", ...extra }),
    );
  });
}

function board(): HTMLElement {
  const el = container.querySelector<HTMLElement>(".cb-board");
  if (!el) throw new Error("board not rendered");
  mockRect(el);
  return el;
}

function buttonByText(text: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`button "${text}" not found`);
  return b;
}

describe("Chessboard", () => {
  it("renders 32 pieces at the start position", () => {
    render(<Chessboard fen="startpos" />);
    const pieces = container.querySelectorAll(".cb-piece");
    expect(pieces).toHaveLength(32);
    expect(container.querySelector('[data-square="e1"]')?.getAttribute("data-piece")).toBe("wK");
    expect(container.querySelector('[data-square="d8"]')?.getAttribute("data-piece")).toBe("bQ");
    expect(container.querySelectorAll(".cb-coord")).toHaveLength(16);
  });

  it("click-to-move fires onMove with a legal move only", () => {
    const onMove = vi.fn();
    render(<Chessboard fen={START_FEN} onMove={onMove} />);
    const b = board();
    pointer(b, "pointerdown", "e2");
    pointer(b, "pointerup", "e2");
    expect(container.querySelectorAll(".cb-hl--dest")).toHaveLength(2);
    expect(container.querySelector(".cb-hl--selected")?.getAttribute("data-square")).toBe("e2");
    pointer(b, "pointerdown", "e5"); // illegal target: just deselects
    expect(onMove).not.toHaveBeenCalled();
    pointer(b, "pointerup", "e5");
    pointer(b, "pointerdown", "e2");
    pointer(b, "pointerup", "e2");
    pointer(b, "pointerdown", "e4");
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith({ from: "e2", to: "e4" });
  });

  it("does not let the side not to move or a view-only board move", () => {
    const onMove = vi.fn();
    render(<Chessboard fen={START_FEN} onMove={onMove} interactive="black" />);
    const b = board();
    pointer(b, "pointerdown", "e2");
    pointer(b, "pointerup", "e2");
    expect(container.querySelector(".cb-hl--selected")).toBeNull();
    pointer(b, "pointerdown", "e4");
    expect(onMove).not.toHaveBeenCalled();
  });

  it("supports drag and drop with a ghost piece", () => {
    const onMove = vi.fn();
    render(<Chessboard fen={START_FEN} onMove={onMove} />);
    const b = board();
    pointer(b, "pointerdown", "g1");
    pointer(b, "pointermove", "g2");
    expect(document.querySelector(".cb-ghost")?.getAttribute("data-piece")).toBe("wN");
    pointer(b, "pointermove", "f3");
    pointer(b, "pointerup", "f3");
    expect(onMove).toHaveBeenCalledWith({ from: "g1", to: "f3" });
    expect(document.querySelector(".cb-ghost")).toBeNull();
  });

  it("asks for the promotion piece before reporting the move", () => {
    const onMove = vi.fn();
    render(<Chessboard fen="8/1P4k1/8/8/8/8/5K2/8 w - - 0 1" onMove={onMove} />);
    const b = board();
    pointer(b, "pointerdown", "b7");
    pointer(b, "pointerup", "b7");
    pointer(b, "pointerdown", "b8");
    expect(onMove).not.toHaveBeenCalled();
    const knight = container.querySelector<HTMLButtonElement>('[data-promotion="n"]');
    expect(knight).not.toBeNull();
    act(() => knight!.click());
    expect(onMove).toHaveBeenCalledWith({ from: "b7", to: "b8", promotion: "n" });
  });

  it("maps king-onto-rook to castling", () => {
    const onMove = vi.fn();
    render(<Chessboard fen="r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1" onMove={onMove} />);
    const b = board();
    pointer(b, "pointerdown", "e1");
    pointer(b, "pointerup", "e1");
    pointer(b, "pointerdown", "h1");
    expect(onMove).toHaveBeenCalledWith({ from: "e1", to: "g1" });
  });
});

describe("MoveList", () => {
  it("renders numbered pairs and selects plies", () => {
    const onSelect = vi.fn();
    render(<MoveList san={["e4", "e5", "Nf3", "Nc6", "Bb5"]} currentPly={3} onSelectPly={onSelect} />);
    const rows = Array.from(container.querySelectorAll(".cb-ml-row")).map((r) => r.textContent);
    expect(rows).toEqual(["1.e4e5", "2.Nf3Nc6", "3.Bb5"]);
    expect(container.querySelector(".cb-ml-move--current")?.textContent).toBe("Nf3");
    act(() => buttonByText("Bb5").click());
    expect(onSelect).toHaveBeenCalledWith(5);
  });

  it("starts with an ellipsis when Black moves first", () => {
    render(<MoveList san={["e5", "Nf3", "Nc6"]} startPly={1} />);
    const rows = Array.from(container.querySelectorAll(".cb-ml-row")).map((r) => r.textContent);
    expect(rows).toEqual(["1.…e5", "2.Nf3Nc6"]);
  });
});

describe("BoardEditor", () => {
  it("only reports valid positions", () => {
    const onChange = vi.fn();
    render(<BoardEditor fen={START_FEN} onChange={onChange} />);
    act(() => buttonByText("Clear board").click());
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector(".cb-editor-status")?.textContent).toMatch(/missing white king/i);
    // Back to the position the parent already has: nothing new to report.
    act(() => buttonByText("Start position").click());
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector(".cb-editor-status")?.textContent).toMatch(/valid position/i);
    act(() => document.querySelector<HTMLButtonElement>('.cb-editor-turn [role="radio"]:last-child')!.click());
    expect(onChange).toHaveBeenLastCalledWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1");
  });

  it("accepts a typed FEN and shows errors for invalid ones", () => {
    const onChange = vi.fn();
    render(<BoardEditor fen={START_FEN} onChange={onChange} />);
    const input = container.querySelector<HTMLInputElement>(".cb-editor-fen input")!;
    const type = (value: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    type("8/8/8/8/8/8/8/K6k w - - 0 1 extra");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector(".cb-editor-status")?.textContent).toMatch(/six/i);
    type("8/8/4k3/8/8/4K3/8/8 b");
    expect(onChange).toHaveBeenLastCalledWith("8/8/4k3/8/8/4K3/8/8 b - - 0 1");
    expect(container.querySelectorAll(".cb-piece")).toHaveLength(2);
  });

  it("disables impossible castling rights and drops pieces dragged off the board", () => {
    const onChange = vi.fn();
    render(<BoardEditor fen={START_FEN} onChange={onChange} />);
    const b = board();
    // Drag the h1 rook off the board: White loses O-O.
    pointer(b, "pointerdown", "h1");
    pointer(b, "pointermove", "h3");
    act(() => {
      b.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: SIZE + 80, clientY: SIZE + 80, pointerId: 1 }));
    });
    expect(onChange).toHaveBeenLastCalledWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w Qkq - 0 1");
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>(".cb-editor-castling input"));
    expect(boxes.map((x) => x.disabled)).toEqual([true, false, false, false]);
  });
});

describe("LimitsEditor", () => {
  it("emits presets and caps", () => {
    const onChange = vi.fn();
    render(<LimitsEditor value={{ limits: {}, timeControl: null }} onChange={onChange} />);
    act(() => buttonByText("3+2").click());
    expect(onChange).toHaveBeenLastCalledWith({ limits: {}, timeControl: { baseMs: 180_000, incMs: 2_000 } });
    const depth = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))[0];
    act(() => depth.click());
    expect(onChange).toHaveBeenLastCalledWith({ limits: { depth: 8 }, timeControl: null });
    expect(container.textContent).toMatch(/Max positions searched \(nodes\)/);
  });
});

describe("Modal", () => {
  it("closes on Escape unless an inner widget handled it", () => {
    const onClose = vi.fn();
    render(
      <Modal open title="Dialog" onClose={onClose}>
        <input
          className="inner"
          onKeyDown={(e) => {
            if (e.key === "Escape" && e.currentTarget.value === "consume") e.preventDefault();
          }}
        />
      </Modal>,
    );
    const input = document.querySelector<HTMLInputElement>(".modal input.inner")!;
    expect(document.activeElement).toBe(input); // focus moved into the dialog
    input.value = "consume";
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    input.value = "";
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("EnginePicker", () => {
  const engines: EngineRecord[] = [
    { id: "a", name: "Alpha", kind: "blocks", color: "#f00", description: "", createdAt: 0, updatedAt: 0, options: { hashMb: 16 } },
    { id: "b", name: "Beta", kind: "nnue", color: "#0f0", description: "", createdAt: 0, updatedAt: 0, options: { hashMb: 16 } },
  ];

  it("shows a loading state while the store loads", () => {
    render(<EnginePicker value={null} onChange={() => {}} />);
    expect(container.textContent).toMatch(/Loading engines/);
  });

  it("lists engines and reports the choice", () => {
    const onChange = vi.fn();
    render(<EnginePicker value={null} onChange={onChange} engines={engines} filter={(e) => e.kind === "nnue"} />);
    act(() => container.querySelector<HTMLButtonElement>(".cb-ep-button")!.click());
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    expect(options.map((o) => o.textContent)).toEqual(["BetaNNUE"]);
    act(() => (options[0] as HTMLElement).click());
    expect(onChange).toHaveBeenCalledWith("b", engines[1]);
  });
});
