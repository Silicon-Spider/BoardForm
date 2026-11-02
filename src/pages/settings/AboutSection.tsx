// Settings → About & credits: what the app is, versions, and the open-source work it builds on.
import { Link } from "@/app/router";
import { COMPILER_VERSION } from "@/compiler/version";
import { ABI_VERSION } from "@/engine-host/abi";
import { PageIcon } from "@/pages/engines/icons";
import { version as APP_VERSION } from "../../../package.json";
import { SettingsSection } from "./controls";

interface Credit {
  name: string;
  url: string;
  /** SPDX licence id (omitted for credits that are not software packages). */
  licence?: string;
  /** What it is used for / who made it. */
  note: string;
  /** Extra link, e.g. the licence notice shipped with the app. */
  notice?: { label: string; url: string };
}

const CREDITS: readonly Credit[] = [
  {
    name: "Chessnut pieces",
    url: "https://github.com/LexLuengas/chessnut-pieces",
    licence: "Apache-2.0",
    note: "Piece set by Alexis Luengas, via lichess.org",
    notice: { label: "NOTICE", url: "/pieces/chessnut/NOTICE.txt" },
  },
  { name: "chess.js", url: "https://github.com/jhlywa/chess.js", licence: "BSD-2-Clause", note: "Chess rules, move validation and PGN" },
  { name: "Blockly", url: "https://github.com/google/blockly", licence: "Apache-2.0", note: "The drag-and-drop blocks editor" },
  { name: "AssemblyScript", url: "https://www.assemblyscript.org", licence: "Apache-2.0", note: "The TypeScript-like language engines are written in, and its compiler" },
  { name: "Binaryen", url: "https://github.com/WebAssembly/binaryen", licence: "Apache-2.0", note: "WebAssembly optimizer used by the compiler" },
  { name: "CodeMirror", url: "https://codemirror.net", licence: "MIT", note: "The code editor" },
  { name: "React", url: "https://react.dev", licence: "MIT", note: "The user interface" },
  { name: "zustand", url: "https://github.com/pmndrs/zustand", licence: "MIT", note: "State for background services" },
  { name: "idb", url: "https://github.com/jakearchibald/idb", licence: "ISC", note: "IndexedDB storage" },
  { name: "marked", url: "https://marked.js.org", licence: "MIT", note: "Markdown in the help pages" },
  {
    name: "PeSTO piece-square tables",
    url: "https://www.chessprogramming.org/PeSTO%27s_Evaluation_Function",
    note: "By Ronald Friederich — used by the template evaluation and the starter blocks",
  },
];

export function AboutSection() {
  return (
    <SettingsSection id="about" title="About & credits" icon={<PageIcon name="heart" size={18} />}>
      <div className="settings-about">
        <p className="settings-about-lead">
          <strong>Chess Builder</strong> lets you create your own chess engines — from drag-and-drop blocks, an evaluation function, a
          complete engine or an empty file — compile them to WebAssembly in your browser, train NNUE networks with self-play, and play
          against them or pit them against each other. Everything runs on your device and is saved in this browser.
        </p>
        <dl className="settings-facts">
          <div>
            <dt>Version</dt>
            <dd className="num">{APP_VERSION}</dd>
          </div>
          <div>
            <dt>Engine ABI</dt>
            <dd>
              <Link to="/help/abi">Version {ABI_VERSION}</Link>
            </dd>
          </div>
          <div>
            <dt>Compiler</dt>
            <dd>{COMPILER_VERSION}</dd>
          </div>
        </dl>
        <h3 className="settings-subheading">Built with</h3>
        <ul className="settings-credits">
          {CREDITS.map((c) => (
            <li key={c.name} className="settings-credit">
              <div className="settings-credit-main">
                <a href={c.url} target="_blank" rel="noreferrer" className="settings-credit-name">
                  {c.name}
                </a>
                <span className="settings-credit-note">{c.note}</span>
              </div>
              <span className="settings-credit-licence">
                {c.licence && <span className="badge">{c.licence}</span>}
                {c.notice && (
                  <a href={c.notice.url} target="_blank" rel="noreferrer" className="small">
                    {c.notice.label}
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </SettingsSection>
  );
}
