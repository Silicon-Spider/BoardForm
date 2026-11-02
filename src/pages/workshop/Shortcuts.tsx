// "Keyboard shortcuts" button for the code editors: a list of what the editor can do from the
// keyboard (src/components/code/CodeEditor.tsx binds them), so nobody has to guess.
import { useState } from "react";
import { Modal } from "@/components";
import { IS_MAC, MOD_KEY } from "./ui";

interface Shortcut {
  keys: string[][];
  what: string;
}

/** Each entry: alternative key combinations (each a list of keys pressed together). */
function groups(): Array<{ title: string; items: Shortcut[] }> {
  const mod = MOD_KEY;
  return [
    {
      title: "Engine",
      items: [
        { keys: [[mod, "S"]], what: "Save now (your changes also save by themselves)" },
        { keys: [[mod, "B"]], what: "Build" },
      ],
    },
    {
      title: "Editing",
      items: [
        { keys: [[mod, "Z"]], what: "Undo (every file has its own history)" },
        { keys: IS_MAC ? [[mod, "Shift", "Z"]] : [[mod, "Y"], [mod, "Shift", "Z"]], what: "Redo" },
        { keys: [["Ctrl", "Space"]], what: "Suggestions for the word at the cursor" },
        { keys: [["Tab"]], what: "Accept a suggestion, or indent the selected lines" },
        { keys: [["Shift", "Tab"]], what: "Remove one level of indentation" },
        { keys: [[mod, "/"]], what: "Comment out / back in" },
        { keys: [["Alt", "↑"], ["Alt", "↓"]], what: "Move the line up / down" },
        { keys: [[mod, "D"]], what: "Also select the next occurrence" },
      ],
    },
    {
      title: "Finding",
      items: [
        { keys: [[mod, "F"]], what: "Find" },
        { keys: IS_MAC ? [[mod, "F"]] : [[mod, "H"]], what: "Find and replace" },
        { keys: [["Enter"], ["F3"]], what: "Next match (Shift for the previous one)" },
        { keys: [["Ctrl", "G"]], what: "Go to line" },
        { keys: [["F8"]], what: "Next error or warning" },
        { keys: [[mod, "Shift", "M"]], what: "List the problems in this file" },
      ],
    },
  ];
}

function KeyboardIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="cb-icon">
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" />
    </svg>
  );
}

export function ShortcutsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost btn-icon workshop-shortcuts-btn" onClick={() => setOpen(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
        <KeyboardIcon />
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Keyboard shortcuts"
        width={520}
        footer={
          <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
            Done
          </button>
        }
      >
        <div className="workshop-shortcuts">
          {groups().map((g) => (
            <section key={g.title}>
              <div className="section-title">{g.title}</div>
              <dl className="workshop-shortcuts-list">
                {g.items.map((s) => (
                  <div key={s.what} className="workshop-shortcuts-row">
                    <dt>
                      {s.keys.map((combo, i) => (
                        <span key={i} className="workshop-shortcuts-combo">
                          {i > 0 && <span className="faint"> or </span>}
                          {combo.map((k, j) => (
                            <span key={j}>
                              {j > 0 && <span className="faint">+</span>}
                              <kbd>{k}</kbd>
                            </span>
                          ))}
                        </span>
                      ))}
                    </dt>
                    <dd>{s.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </Modal>
    </>
  );
}
