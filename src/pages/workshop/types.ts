// Types shared by the Workshop's components.

export type SideTabId = "test" | "code" | "api" | "source" | "build" | "settings";

/** "editor" is the main area, shown as a tab on narrow screens. */
export type TabId = SideTabId | "editor";

/**
 * A request to scroll an editor to a line. `target` names the editor: "main:<path>" (main area),
 * "source:<path>" (Engine source tab) or "generated" (Generated code tab).
 */
export interface RevealTarget {
  target: string;
  reveal: { line: number; column?: number; nonce: number };
}
