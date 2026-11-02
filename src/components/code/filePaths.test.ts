import { describe, expect, it } from "vitest";
import { ancestorFolders, buildFileTree, normalizeFilePath, validateFilePath, type FileTreeNode } from "./filePaths";

const existing = ["main.ts", "eval.ts", "lib/util.ts", "lib/deep/more.ts"];

describe("validateFilePath", () => {
  it("accepts good names, with folders", () => {
    for (const p of ["helpers.ts", "lib/pst.ts", "lib/new/a-b_c.ts", "Eval2.ts", "x.y.ts"]) expect(validateFilePath(p, existing), p).toBeNull();
  });

  it("rejects bad names with a reason", () => {
    const bad: Array<[string, RegExp]> = [
      ["", /Enter a file name/],
      ["helpers", /must end with \.ts/],
      ["helpers.js", /must end with \.ts/],
      ["my file.ts", /spaces/],
      ["héllo.ts", /letters, digits/],
      ["a:b.ts", /letters, digits/],
      ["lib//x.ts", /can't be empty/],
      ["lib/", /can't be empty/],
      ["./x.ts".slice(2) + "/", /can't be empty/],
      ["../x.ts", /not allowed/],
      ["lib/./x.ts", /not allowed/],
      [".hidden.ts", /start with a dot/],
      ["a..ts", /single dot/],
      ["types.d.ts", /Declaration files/],
      ["lib.ts/x.ts", /Folder names can't end with \.ts/],
      ["x".repeat(130) + ".ts", /too long/],
    ];
    for (const [p, re] of bad) expect(validateFilePath(p, existing), p).toMatch(re);
  });

  it("rejects duplicates and file / folder clashes, case-insensitively", () => {
    expect(validateFilePath("eval.ts", existing)).toMatch(/already a file called eval\.ts/);
    expect(validateFilePath("EVAL.ts", existing)).toMatch(/already a file called eval\.ts/);
    expect(validateFilePath("LIB/util.ts", existing)).toMatch(/already a file/);
    expect(validateFilePath("main.ts/x.ts", ["main.ts"])).toMatch(/Folder names can't end with \.ts/);
    expect(validateFilePath("a/b.ts", ["a/b.ts/c.ts"])).toMatch(/already a folder/);
  });

  it("lets a renamed file keep its own name (e.g. to change case)", () => {
    expect(validateFilePath("Eval.ts", existing, { current: "eval.ts" })).toBeNull();
    expect(validateFilePath("main.ts", existing, { current: "eval.ts" })).toMatch(/already a file/);
  });
});

describe("normalizeFilePath", () => {
  it("trims and strips what users type by habit", () => {
    expect(normalizeFilePath("  ./lib\\x.ts ")).toBe("lib/x.ts");
    expect(normalizeFilePath("/main.ts")).toBe("main.ts");
  });
});

describe("buildFileTree", () => {
  const names = (nodes: FileTreeNode[]): unknown[] => nodes.map((n) => (n.kind === "folder" ? { [n.name]: names(n.children) } : n.name));

  it("puts folders first and sorts naturally", () => {
    const tree = buildFileTree(["main.ts", "b/z.ts", "file10.ts", "file2.ts", "a/x.ts", "b/c/d.ts", "B.ts", "main.ts"]);
    expect(names(tree)).toEqual([{ a: ["x.ts"] }, { b: [{ c: ["d.ts"] }, "z.ts"] }, "B.ts", "file2.ts", "file10.ts", "main.ts"]);
    const b = tree[1];
    expect(b.kind === "folder" && b.path).toBe("b");
    expect(b.kind === "folder" && b.children[0].path).toBe("b/c");
  });

  it("lists ancestor folders", () => {
    expect(ancestorFolders("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorFolders("c.ts")).toEqual([]);
  });
});
