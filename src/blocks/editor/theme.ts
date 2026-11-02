// Blockly themes matching the app's design tokens (src/styles/global.css). Block colours are
// shared by both themes (mid-tone, white text stays readable); the chrome follows dark / light.

import * as Blockly from "blockly";

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Category colours (one per toolbox category; every block of a category shares it). */
export const CATEGORY_COLOURS = {
  structure: "#c0790f",
  points: "#cf5a3a",
  recipes: "#c0790f",
  classic: "#7a59d1",
  pieces: "#3a6fd8",
  zone: "#138f84",
  state: "#c2427f",
  loop: "#2e9150",
  logic: "#5876a0",
  math: "#8a68a8",
  variables: "#b5506b",
} as const;

function style(primary: string, hat?: string): Blockly.Theme.BlockStyle {
  return {
    colourPrimary: primary,
    colourSecondary: mix(primary, "#ffffff", 0.2),
    colourTertiary: mix(primary, "#000000", 0.28),
    hat: hat ?? "",
  };
}

const C = CATEGORY_COLOURS;

const BLOCK_STYLES: Record<string, Blockly.Theme.BlockStyle> = {
  cb_root: style(C.structure, "cap"),
  cb_structure: style(C.structure),
  cb_points: style(C.points),
  cb_classic: style(C.classic),
  cb_pieces: style(C.pieces),
  cb_zone: style(C.zone),
  cb_state: style(C.state),
  cb_loop: style(C.loop),
  cb_math: style(C.math),
  // Built-in block styles (logic / math / variables blocks from Blockly itself).
  logic_blocks: style(C.logic),
  math_blocks: style(C.math),
  variable_blocks: style(C.variables),
  variable_dynamic_blocks: style(C.variables),
  loop_blocks: style(C.loop),
  procedure_blocks: style(C.logic),
  text_blocks: style(C.math),
  list_blocks: style(C.math),
  colour_blocks: style(C.math),
  hat_blocks: style(C.structure, "cap"),
};

const CATEGORY_STYLES: Record<string, Blockly.Theme.CategoryStyle> = {
  cat_structure: { colour: C.structure },
  cat_points: { colour: C.points },
  cat_recipes: { colour: C.recipes },
  cat_classic: { colour: C.classic },
  cat_pieces: { colour: C.pieces },
  cat_zone: { colour: C.zone },
  cat_state: { colour: C.state },
  cat_loop: { colour: C.loop },
  cat_logic: { colour: C.logic },
  cat_math: { colour: C.math },
  cat_variables: { colour: C.variables },
};

const FONT: Blockly.Theme.FontStyle = {
  family: 'Inter, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  weight: "600",
  size: 11,
};

let dark: Blockly.Theme | null = null;
let light: Blockly.Theme | null = null;

export function darkTheme(): Blockly.Theme {
  dark ??= Blockly.Theme.defineTheme("chess-builder-dark", {
    name: "chess-builder-dark",
    base: Blockly.Themes.Classic,
    blockStyles: BLOCK_STYLES,
    categoryStyles: CATEGORY_STYLES,
    componentStyles: {
      workspaceBackgroundColour: "#0c0f13",
      toolboxBackgroundColour: "#161a20",
      toolboxForegroundColour: "#e6e9ef",
      flyoutBackgroundColour: "#1c2129",
      flyoutForegroundColour: "#a3acba",
      flyoutOpacity: 1,
      scrollbarColour: "#4a5465",
      scrollbarOpacity: 0.6,
      insertionMarkerColour: "#ffffff",
      insertionMarkerOpacity: 0.28,
      markerColour: "#5b9cf5",
      cursorColour: "#5b9cf5",
      selectedGlowColour: "#5b9cf5",
      selectedGlowOpacity: 0.65,
    },
    fontStyle: FONT,
    startHats: false,
  });
  return dark;
}

export function lightTheme(): Blockly.Theme {
  light ??= Blockly.Theme.defineTheme("chess-builder-light", {
    name: "chess-builder-light",
    base: Blockly.Themes.Classic,
    blockStyles: BLOCK_STYLES,
    categoryStyles: CATEGORY_STYLES,
    componentStyles: {
      workspaceBackgroundColour: "#eef1f5",
      toolboxBackgroundColour: "#ffffff",
      toolboxForegroundColour: "#17202b",
      flyoutBackgroundColour: "#f7f9fb",
      flyoutForegroundColour: "#4d5866",
      flyoutOpacity: 1,
      scrollbarColour: "#aab4c2",
      scrollbarOpacity: 0.7,
      insertionMarkerColour: "#17202b",
      insertionMarkerOpacity: 0.22,
      markerColour: "#2f6fdc",
      cursorColour: "#2f6fdc",
      selectedGlowColour: "#2f6fdc",
      selectedGlowOpacity: 0.55,
    },
    fontStyle: FONT,
    startHats: false,
  });
  return light;
}

export function isLightMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "light";
}

export function currentTheme(): Blockly.Theme {
  return isLightMode() ? lightTheme() : darkTheme();
}
