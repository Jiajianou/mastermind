import ts from "typescript";
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const page = import.meta.glob<string>("../index.html", {
  query: "?raw",
  import: "default",
  eager: true,
});

const forbidden = /\b(?:merg(?:e|es|ed|ing)|land(?:s|ed|ing)?)\b/i;

function uiStrings(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node))
      found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("wording", () => {
  it("never says Merge or Land in any string the web app can show", () => {
    const strings = Object.entries(sources).flatMap(([path, source]) =>
      uiStrings(path, source).map((text) => `${path}: ${text}`),
    );
    const html = Object.entries(page).map(([path, text]) => `${path}: ${text}`);

    expect(strings.length).toBeGreaterThan(500);
    expect([...strings, ...html].filter((text) => forbidden.test(text))).toEqual([]);
  });
});
