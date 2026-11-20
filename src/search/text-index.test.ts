import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findAll,
  type LineMatch,
  TextIndex,
  toSnippet,
} from "./text-index.ts";

function indexOf(notes: Record<string, string>): TextIndex {
  const index = new TextIndex();
  for (const [path, text] of Object.entries(notes)) {
    index.set(path, text);
  }
  return index;
}

/** Runs a search to its end. */
function find(
  index: TextIndex,
  query: string,
  paths: string[],
  limit: number,
): { matches: LineMatch[]; total: number } {
  const search = index.search(query, paths, limit);
  search.run();
  assert.equal(search.done, true);
  return { matches: search.matches, total: search.total };
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

  it("takes the characters of a regular expression as they are", () => {
    assert.deepEqual(findAll("a.b axb (a.b)", "a.b"), [
      { start: 0, end: 3 },
      { start: 9, end: 12 },
    ]);
    assert.deepEqual(findAll("C++ and c++", "c++"), [
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
    for (const query of ["[", "(", ")", "*", "?", "\\", "^", "$", "|", "{1}", "-", "/"]) {
      assert.deepEqual(findAll(`x${query}y`, query), [
        { start: 1, end: 1 + query.length },
      ]);
    }
  });

  it("gives the places in the line as it is, also next to a character that grows in lower case", () => {
    // "İ" is one character, and two in lower case
    assert.deepEqual(findAll("İstanbul Fox", "fox"), [{ start: 9, end: 12 }]);
  });

  it("finds an emoji", () => {
    assert.deepEqual(findAll("a 📝 b", "📝"), [{ start: 2, end: 4 }]);
  });

  it("does not fail on half an emoji, and does not find it in a whole one", () => {
    assert.deepEqual(findAll("a 📝 b", "📝".slice(0, 1)), []);
    assert.deepEqual(findAll("a 📝 b", "📝".slice(1)), []);
  });

  it("finds a letter that has no single letter in upper case as it is", () => {
    assert.deepEqual(findAll("Straße STRASSE", "straße"), [{ start: 0, end: 6 }]);
  });

  it("finds letters outside the basic plane whatever their case", () => {
    // Deseret: "𐐨" is the lower case of "𐐀"
    assert.deepEqual(findAll("𐐀 𐐨", "𐐨"), [
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });
});

describe("TextIndex.search", () => {
  const index = indexOf(notes);
  const all = ["a.md", "b.md", "c.md"];

  it("lists each matching line once, in the order of the paths and the lines", () => {
    assert.deepEqual(find(index, "fox", all, 10), {
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
    const { matches } = find(index, "fox", ["b.md", "a.md"], 10);
    assert.deepEqual(
      matches.map((match) => `${match.path}:${match.line}`),
      ["b.md:1", "a.md:2", "a.md:4"],
    );
    assert.equal(find(index, "fox", ["c.md", "unknown.md"], 10).total, 0);
  });

  it("takes the query as it is typed, spaces included", () => {
    assert.equal(find(index, "quick brown", all, 10).total, 1);
    assert.equal(find(index, "brown quick", all, 10).total, 0);
    assert.equal(find(index, "fox ", all, 10).total, 2);
  });

  it("returns no more lines than the limit, but counts them all", () => {
    const result = find(index, "fox", all, 2);
    assert.equal(result.matches.length, 2);
    assert.equal(result.total, 3);
  });

  it("finds nothing for a query without a character", () => {
    assert.deepEqual(find(index, "", all, 10), { matches: [], total: 0 });
    assert.deepEqual(find(index, "  ", all, 10), { matches: [], total: 0 });
  });

  it("finds a match on the first and on the last line", () => {
    const edges = indexOf({ "e.md": "fox first\nmiddle\nlast fox" });
    assert.deepEqual(
      find(edges, "fox", ["e.md"], 10).matches.map((match) => match.line),
      [0, 2],
    );
  });

  it("counts a line once, also when it is only counted", () => {
    const index = indexOf({
      "a.md": "fox fox\nfox\nno\nfox fox fox",
      "b.md": "fox\r\nfox fox\r\n",
      "c.md": "no\nfox",
    });
    const paths = ["a.md", "b.md", "c.md"];
    for (const limit of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const result = find(index, "fox", paths, limit);
      assert.equal(result.total, 6, `limit ${limit}`);
      assert.deepEqual(
        result.matches.map((match) => `${match.path}:${match.line}`),
        ["a.md:0", "a.md:1", "a.md:3", "b.md:0", "b.md:1", "c.md:1"].slice(
          0,
          limit,
        ),
        `limit ${limit}`,
      );
    }
  });

  it("finds upper case with lower case and the other way around", () => {
    const index = indexOf({ "a.md": "IAM policy\nan iam role\nIam" });
    for (const query of ["iam", "IAM", "Iam", "iAM"]) {
      assert.equal(find(index, query, ["a.md"], 10).total, 3, query);
    }
  });

  it("takes the characters of a regular expression as they are", () => {
    const index = indexOf({ "a.md": "a.b\naxb\n(예: 1)\n[[link]]\n**bold**" });
    assert.equal(find(index, "a.b", ["a.md"], 10).total, 1);
    assert.equal(find(index, "(예:", ["a.md"], 10).total, 1);
    assert.equal(find(index, "[[", ["a.md"], 10).total, 1);
    assert.equal(find(index, "**", ["a.md"], 10).total, 1);
    assert.equal(find(index, ".*", ["a.md"], 10).total, 0);
  });

  it("leaves the line break out of a line, whatever kind it is", () => {
    const index = indexOf({ "a.md": "one fox\r\ntwo fox\nthree fox\r" });
    assert.deepEqual(
      find(index, "fox", ["a.md"], 10).matches.map((match) => match.text),
      ["one fox", "two fox", "three fox"],
    );
  });

  it("knows the line after a character that grows in lower case", () => {
    const index = indexOf({ "a.md": "İİİ\nİ fox İ\nfox" });
    assert.deepEqual(find(index, "fox", ["a.md"], 10).matches, [
      { path: "a.md", line: 1, text: "İ fox İ", ranges: [{ start: 2, end: 5 }] },
      { path: "a.md", line: 2, text: "fox", ranges: [{ start: 0, end: 3 }] },
    ]);
  });

  it("finds Korean text", () => {
    const korean = indexOf({ "k.md": "제목\n11월 예산 정산을 마쳤다." });
    assert.deepEqual(find(korean, "예산 정산", ["k.md"], 10).matches, [
      {
        path: "k.md",
        line: 1,
        text: "11월 예산 정산을 마쳤다.",
        ranges: [{ start: 4, end: 9 }],
      },
    ]);
  });
});

describe("TextSearch.run", () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 20; i++) {
    many[`n${String(i).padStart(2, "0")}.md`] = `fox ${i}\nnothing\nfox again`;
  }
  const index = indexOf(many);
  const paths = Object.keys(many);

  it("finds nothing before it is run", () => {
    const search = index.search("fox", paths, 5);
    assert.equal(search.done, false);
    assert.equal(search.total, 0);
    assert.deepEqual(search.matches, []);
  });

  it("is done at once when there is nothing to look for or nowhere to look", () => {
    assert.equal(index.search("", paths, 5).done, true);
    assert.equal(index.search(" ", paths, 5).done, true);
    assert.equal(index.search("fox", [], 5).done, true);
  });

  it("pauses when it is told to, and goes on where it stopped", () => {
    const search = index.search("fox", paths, 5);
    search.run(() => true);
    assert.equal(search.done, false);
    assert.equal(search.total, 2);
    assert.deepEqual(
      search.matches.map((match) => `${match.path}:${match.line}`),
      ["n00.md:0", "n00.md:2"],
    );

    let notes = 0;
    search.run(() => ++notes === 3);
    assert.equal(search.done, false);
    assert.equal(search.total, 8);
    assert.equal(search.matches.length, 5);

    search.run();
    assert.equal(search.done, true);
    assert.equal(search.total, 40);
    assert.equal(search.matches.length, 5);
  });

  it("finds the same in parts as in one go", () => {
    const whole = find(index, "fox", paths, 7);
    for (const every of [1, 2, 3, 7, 19, 20, 21]) {
      const search = index.search("fox", paths, 7);
      let runs = 0;
      while (!search.done) {
        let notes = 0;
        search.run(() => ++notes === every);
        assert.ok(++runs <= paths.length, "the search comes to an end");
      }
      assert.deepEqual(
        { matches: search.matches, total: search.total },
        whole,
        `a pause every ${every} notes`,
      );
    }
  });

  it("is done after the last note, also when it pauses there", () => {
    const search = index.search("fox", ["n00.md"], 5);
    search.run(() => true);
    assert.equal(search.done, true);
  });

  it("does nothing more once it is done", () => {
    const search = index.search("fox", paths, 5);
    search.run();
    search.run();
    assert.equal(search.total, 40);
  });

  it("skips a path without a note", () => {
    const search = index.search("fox", ["gone.md", "n00.md", "gone.md"], 5);
    search.run();
    assert.equal(search.done, true);
    assert.equal(search.total, 2);
  });
});

describe("TextIndex.set and retain", () => {
  it("replaces the text of a note", () => {
    const index = indexOf({ "a.md": "old fox" });
    index.set("a.md", "new cat");
    assert.equal(find(index, "fox", ["a.md"], 10).total, 0);
    assert.equal(find(index, "cat", ["a.md"], 10).total, 1);
  });

  it("forgets the notes that are not retained", () => {
    const index = indexOf(notes);
    index.retain(new Set(["b.md"]));
    assert.equal(find(index, "fox", ["a.md", "b.md"], 10).total, 1);
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

  it("returns no lines for a line after the end of the note", () => {
    assert.deepEqual(index.excerpt("n.md", 50, 2), { first: 48, lines: [] });
  });

  it("leaves the line breaks out, and has the empty line after the last one", () => {
    const breaks = indexOf({ "b.md": "a\r\nb\n", "empty.md": "" });
    assert.deepEqual(breaks.excerpt("b.md", 1, 5), {
      first: 0,
      lines: ["a", "b", ""],
    });
    assert.deepEqual(breaks.excerpt("empty.md", 0, 5), { first: 0, lines: [""] });
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
