import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findAll, TextIndex, toSnippet } from "./text-index.ts";

function indexOf(notes: Record<string, string>): TextIndex {
  const index = new TextIndex();
  for (const [path, text] of Object.entries(notes)) {
    index.set(path, text);
  }
  return index;
}

const notes = {
  "a.md": "# Alpha\n\nThe quick brown fox.\nNo animal here.\nfox and FOX again",
  "b.md": "Budget review\r\nA Fox on line two\r\n",
  "c.md": "nothing to see",
};

describe("findAll", () => {
  it("finds every place of the query, whatever its case", () => {
    assert.deepEqual(findAll("fox and FOX again", "Fox"), [
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it("does not let the places overlap", () => {
    assert.deepEqual(findAll("aaaa", "aa"), [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("finds nothing for an empty query", () => {
    assert.deepEqual(findAll("anything", ""), []);
  });
});

describe("TextIndex.search", () => {
  const index = indexOf(notes);
  const all = ["a.md", "b.md", "c.md"];

  it("lists each matching line once, in the order of the paths and the lines", () => {
    assert.deepEqual(index.search("fox", all, 10), {
      total: 3,
      matches: [
        {
          path: "a.md",
          line: 2,
          text: "The quick brown fox.",
          ranges: [{ start: 16, end: 19 }],
        },
        {
          path: "a.md",
          line: 4,
          text: "fox and FOX again",
          ranges: [
            { start: 0, end: 3 },
            { start: 8, end: 11 },
          ],
        },
        {
          path: "b.md",
          line: 1,
          text: "A Fox on line two",
          ranges: [{ start: 2, end: 5 }],
        },
      ],
    });
  });

  it("follows the order of the paths it is given, and skips the others", () => {
    const { matches } = index.search("fox", ["b.md", "a.md"], 10);
    assert.deepEqual(
      matches.map((match) => `${match.path}:${match.line}`),
      ["b.md:1", "a.md:2", "a.md:4"],
    );
    assert.equal(index.search("fox", ["c.md", "unknown.md"], 10).total, 0);
  });

  it("takes the query as it is typed, spaces included", () => {
    assert.equal(index.search("quick brown", all, 10).total, 1);
    assert.equal(index.search("brown quick", all, 10).total, 0);
    assert.equal(index.search("fox ", all, 10).total, 2);
  });

  it("returns no more lines than the limit, but counts them all", () => {
    const result = index.search("fox", all, 2);
    assert.equal(result.matches.length, 2);
    assert.equal(result.total, 3);
  });

  it("finds nothing for a query without a character", () => {
    assert.deepEqual(index.search("", all, 10), { matches: [], total: 0 });
    assert.deepEqual(index.search("  ", all, 10), { matches: [], total: 0 });
  });

  it("finds a match on the first and on the last line", () => {
    const edges = indexOf({ "e.md": "fox first\nmiddle\nlast fox" });
    assert.deepEqual(
      edges.search("fox", ["e.md"], 10).matches.map((match) => match.line),
      [0, 2],
    );
  });

  it("finds Korean text", () => {
    const korean = indexOf({ "k.md": "제목\n11월 예산 정산을 마쳤다." });
    assert.deepEqual(korean.search("예산 정산", ["k.md"], 10).matches, [
      {
        path: "k.md",
        line: 1,
        text: "11월 예산 정산을 마쳤다.",
        ranges: [{ start: 4, end: 9 }],
      },
    ]);
  });
});

describe("TextIndex.set and retain", () => {
  it("replaces the text of a note", () => {
    const index = indexOf({ "a.md": "old fox" });
    index.set("a.md", "new cat");
    assert.equal(index.search("fox", ["a.md"], 10).total, 0);
    assert.equal(index.search("cat", ["a.md"], 10).total, 1);
  });

  it("forgets the notes that are not retained", () => {
    const index = indexOf(notes);
    index.retain(new Set(["b.md"]));
    assert.equal(index.search("fox", ["a.md", "b.md"], 10).total, 1);
    assert.equal(index.excerpt("a.md", 0, 1), null);
  });
});

describe("TextIndex.excerpt", () => {
  const index = indexOf({ "n.md": "l0\nl1\nl2\nl3\nl4\nl5" });

  it("returns the lines around a line", () => {
    assert.deepEqual(index.excerpt("n.md", 3, 1), {
      first: 2,
      lines: ["l2", "l3", "l4"],
    });
  });

  it("stops at the start and the end of the note", () => {
    assert.deepEqual(index.excerpt("n.md", 0, 2), {
      first: 0,
      lines: ["l0", "l1", "l2"],
    });
    assert.deepEqual(index.excerpt("n.md", 5, 2), {
      first: 3,
      lines: ["l3", "l4", "l5"],
    });
  });
});

describe("toSnippet", () => {
  const match = (text: string, query: string) => ({
    path: "n.md",
    line: 0,
    text,
    ranges: findAll(text, query),
  });

  it("drops the indentation and moves the ranges with the text", () => {
    assert.deepEqual(toSnippet(match("    - a fox here", "fox"), 80), {
      text: "- a fox here",
      ranges: [{ start: 4, end: 7 }],
    });
  });

  it("cuts a long line after the given number of characters", () => {
    const snippet = toSnippet(match(`fox ${"x".repeat(200)}`, "fox"), 50);
    assert.equal(snippet.text.length, 50);
    assert.deepEqual(snippet.ranges, [{ start: 0, end: 3 }]);
  });

  it("starts shortly before a match that is far into the line", () => {
    const snippet = toSnippet(match(`${"a".repeat(100)} fox tail`, "fox"), 60);
    assert.equal(snippet.text.startsWith("…"), true);
    const [range] = snippet.ranges;
    assert.ok(range);
    assert.equal(snippet.text.slice(range.start, range.end), "fox");
    assert.equal(snippet.text.endsWith(" fox tail"), true);
  });

  it("leaves a line without a match as it is, apart from the indentation", () => {
    assert.deepEqual(toSnippet(match("  plain line", "zzz"), 80), {
      text: "plain line",
      ranges: [],
    });
  });
});
