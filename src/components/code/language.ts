// Language support for the code editor: the TypeScript grammar of @codemirror/lang-javascript,
// with two AssemblyScript touches:
//   * decorator names (@inline, @external(...)) are tagged as meta, so they stand out;
//   * a small view plugin marks AssemblyScript type names used like values (`i32(x)`,
//     `<u64>` is already a type) and calls of builtins (`unchecked(...)`, `popcnt<u64>(b)`).
// Everything is created lazily so importing this module has no side effects.
import { LanguageSupport, syntaxTree, type LRLanguage } from "@codemirror/language";
import { typescriptLanguage } from "@codemirror/lang-javascript";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { styleTags, tags } from "@lezer/highlight";
import { AS_BUILTIN_NAMES, AS_TYPE_NAMES } from "./assemblyscript";

export type EditorLanguage = "assemblyscript" | "typescript" | "markdown" | "text";

let language: LRLanguage | null = null;

/** TypeScript with decorator names styled as meta (AssemblyScript decorates plain functions). */
function scriptLanguage(): LRLanguage {
  language ??= typescriptLanguage.configure(
    {
      props: [
        styleTags({
          "Decorator/VariableName Decorator/CallExpression/VariableName Decorator/MemberExpression/PropertyName": tags.meta,
        }),
      ],
    },
    "assemblyscript",
  );
  return language;
}

const typeMark = Decoration.mark({ class: "cb-tok-astype" });
const builtinMark = Decoration.mark({ class: "cb-tok-asbuiltin" });

function asDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "VariableName") return;
        const length = node.to - node.from;
        if (length < 2 || length > 11) return;
        const text = view.state.doc.sliceString(node.from, node.to);
        if (AS_TYPE_NAMES.has(text)) {
          builder.add(node.from, node.to, typeMark);
        } else if (AS_BUILTIN_NAMES.has(text)) {
          // Only calls: `unchecked(...)`, `popcnt<u64>(...)` - not a local variable called "min".
          const parent = node.node.parent;
          if (parent && (parent.name === "CallExpression" || (parent.name === "InstantiationExpression" && parent.parent?.name === "CallExpression"))) {
            builder.add(node.from, node.to, builtinMark);
          }
        }
      },
    });
  }
  return builder.finish();
}

let highlighter: Extension | null = null;

/** Marks AssemblyScript type names and builtin calls in the visible part of the document. */
export function assemblyScriptHighlighter(): Extension {
  highlighter ??= ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = asDecorations(view);
      }
      update(u: ViewUpdate) {
        // The tree changes while the background parser catches up, too.
        if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = asDecorations(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
  return highlighter;
}

const supportCache = new Map<EditorLanguage, Extension>();

/** Language extension for a mode: AssemblyScript / TypeScript grammar, or nothing for plain text. */
export function languageExtension(mode: EditorLanguage): Extension {
  let ext = supportCache.get(mode);
  if (!ext) {
    if (mode === "assemblyscript") ext = new LanguageSupport(scriptLanguage(), [assemblyScriptHighlighter()]);
    else if (mode === "typescript") ext = new LanguageSupport(scriptLanguage());
    else ext = [];
    supportCache.set(mode, ext);
  }
  return ext;
}

/** True for modes that are source code (comment toggling, brackets, lint gutter, completion). */
export function isCodeLanguage(mode: EditorLanguage): boolean {
  return mode === "assemblyscript" || mode === "typescript";
}
