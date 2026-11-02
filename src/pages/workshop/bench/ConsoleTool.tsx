// Engine console: everything the engine logs (cb_log, trace, WASI output) and the host's notes.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Icon } from "@/components";
import { toast } from "@/app/toast";
import type { EngineSession } from "../session";

export function useConsoleLines(session: EngineSession): readonly string[] {
  return useSyncExternalStore(session.subscribeLog, session.getLog, session.getLog);
}

export function ConsoleTool({ session, visible }: { session: EngineSession; visible: boolean }) {
  const lines = useConsoleLines(session);
  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow new output while scrolled to the bottom.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  }, [lines, visible]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onScroll = () => {
      stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    };
    box.addEventListener("scroll", onScroll);
    return () => box.removeEventListener("scroll", onScroll);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast("Console copied", { kind: "success" });
    } catch {
      toast("Could not copy to the clipboard", { kind: "error" });
    }
  };

  return (
    <div className="workshop-tool workshop-console-tool">
      <div className="row-wrap">
        <span className="small muted num">{lines.length === 0 ? "No output yet" : `${lines.length} line${lines.length === 1 ? "" : "s"}`}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copy()} disabled={lines.length === 0}>
          <Icon name="copy" size={14} /> Copy
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => session.clearLog()} disabled={lines.length === 0}>
          <Icon name="trash" size={14} /> Clear
        </button>
      </div>
      <div className="workshop-console" ref={boxRef} role="log" aria-live="off" tabIndex={0} aria-label="Engine output">
        {lines.length === 0 ? (
          <div className="workshop-console-empty">Output from cb_log and notes from the host appear here once the engine runs.</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={"workshop-console-line" + (l.startsWith("[host]") ? " host" : l.startsWith("[workshop]") ? " note" : "")}>
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
