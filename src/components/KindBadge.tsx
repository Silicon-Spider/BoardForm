// Engine-kind badge coloured from the --kind-* tokens.
import type { CSSProperties } from "react";
import type { EngineKind } from "@/types";
import "./KindBadge.css";

export const KIND_LABELS: Record<EngineKind, string> = {
  blocks: "Blocks",
  eval: "Eval code",
  full: "Full code",
  scratch: "Scratch",
  nnue: "NNUE",
  wasm: "WASM",
};

export const KIND_DESCRIPTIONS: Record<EngineKind, string> = {
  blocks: "Evaluation built from drag-and-drop blocks",
  eval: "Hand-written evaluation function on the stock search",
  full: "Every engine file is editable",
  scratch: "Written from a near-empty skeleton",
  nnue: "Neural-network (NNUE) evaluation",
  wasm: "Uploaded pre-compiled WebAssembly module",
};

/** CSS colour of an engine kind (theme-aware variable). */
export function kindColor(kind: EngineKind): string {
  return `var(--kind-${kind})`;
}

export interface KindBadgeProps {
  kind: EngineKind;
  className?: string;
  /** Show only the coloured dot + short label at a smaller size. */
  small?: boolean;
}

export function KindBadge({ kind, className, small }: KindBadgeProps) {
  return (
    <span
      className={["badge", "cb-kind", small && "cb-kind--sm", className].filter(Boolean).join(" ")}
      style={{ "--cb-kind": kindColor(kind) } as CSSProperties}
      title={KIND_DESCRIPTIONS[kind]}
    >
      {KIND_LABELS[kind] ?? kind}
    </span>
  );
}
