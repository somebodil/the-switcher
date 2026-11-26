import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Matcher } from "./matcher.ts";
import { type LineMatch, TextIndex, type TextSearch, toSnippet } from "./text-index.ts";

const plain = (text: string, matchCase = false): Matcher => new Matcher({ text, regex: false, matchCase });
const regex = (text: string, matchCase = false): Matcher => new Matcher({ text, regex: true, matchCase });

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
  const search = index.searchOn(null, plain(query), paths, limit);
  search.run();
  assert.equal(search.done, true);
  return { matches: search.matches, total: search.total };
}

const notes = {
  "a.md": "# Alpha\n\nThe quick brown fox.\nNo animal here.\nfox and FOX again",
  "b.md": "Budget review\r\nA Fox on line two\r\n",
  "c.md": "nothing to see",
};

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
          first: { start: 16, end: 19 },
        },
        {
          path: "a.md",
          line: 4,
          text: "fox and FOX again",
          first: { start: 0, end: 3 },
        },
        {
          path: "b.md",
          line: 1,
          text: "A Fox on line two",
          first: { start: 2, end: 5 },
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
      { path: "a.md", line: 1, text: "İ fox İ", first: { start: 2, end: 5 } },
      { path: "a.md", line: 2, text: "fox", first: { start: 0, end: 3 } },
    ]);
  });

  it("finds Korean text", () => {
    const korean = indexOf({ "k.md": "제목\n11월 예산 정산을 마쳤다." });
    assert.deepEqual(find(korean, "예산 정산", ["k.md"], 10).matches, [
      {
        path: "k.md",
        line: 1,
        text: "11월 예산 정산을 마쳤다.",
        first: { start: 4, end: 9 },
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
    const search = index.searchOn(null, plain("fox"), paths, 5);
    assert.equal(search.done, false);
    assert.equal(search.total, 0);
    assert.deepEqual(search.matches, []);
  });

  it("is done at once when there is nothing to look for or nowhere to look", () => {
    assert.equal(index.searchOn(null, plain(""), paths, 5).done, true);
    assert.equal(index.searchOn(null, plain(" "), paths, 5).done, true);
    assert.equal(index.searchOn(null, plain("fox"), [], 5).done, true);
  });

  it("pauses when it is told to, and goes on where it stopped", () => {
    const search = index.searchOn(null, plain("fox"), paths, 5);
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
      const search = index.searchOn(null, plain("fox"), paths, 7);
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
    const search = index.searchOn(null, plain("fox"), ["n00.md"], 5);
    search.run(() => true);
    assert.equal(search.done, true);
  });

  it("does nothing more once it is done", () => {
    const search = index.searchOn(null, plain("fox"), paths, 5);
    search.run();
    search.run();
    assert.equal(search.total, 40);
  });

  it("skips a path without a note", () => {
    const search = index.searchOn(null, plain("fox"), ["gone.md", "n00.md", "gone.md"], 5);
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
  const snip = (text: string, query: string, length: number, keepIndentation = false) =>
    toSnippet(text, plain(query).findAll(text), length, keepIndentation);

  it("drops the indentation and moves the ranges with the text", () => {
    assert.deepEqual(snip("    - a fox here", "fox", 80), {
      text: "- a fox here",
      ranges: [{ start: 4, end: 7 }],
    });
  });

  it("keeps the indentation when told to", () => {
    assert.deepEqual(snip("    - a fox here", "fox", 80, true), {
      text: "    - a fox here",
      ranges: [{ start: 8, end: 11 }],
    });
  });

  it("shows a match that starts in the indentation whole", () => {
    assert.deepEqual(snip("    - a fox", " - ", 80), {
      text: " - a fox",
      ranges: [{ start: 0, end: 3 }],
    });
    assert.deepEqual(snip("\t\tfox", "\tfox", 80), {
      text: "\tfox",
      ranges: [{ start: 0, end: 4 }],
    });
  });

  it("leaves out a match that is all in the indentation", () => {
    assert.deepEqual(snip("    fox", "  ", 80), {
      text: "fox",
      ranges: [],
    });
  });

  it("shows a match that the cut goes through whole, and leaves out what comes after", () => {
    const snippet = snip(`fox ${"x".repeat(44)}fox fox`, "fox", 50);
    assert.equal(snippet.text, `fox ${"x".repeat(44)}fox…`);
    assert.deepEqual(snippet.ranges, [
      { start: 0, end: 3 },
      { start: 48, end: 51 },
    ]);
  });

  it("cuts a match that is longer than twice the line it shows", () => {
    const line = `a ${"b".repeat(300)}`;
    const snippet = toSnippet(line, [{ start: 2, end: 302 }], 50);
    assert.equal(snippet.text, `${line.slice(0, 50)}…`);
    assert.deepEqual(snippet.ranges, [{ start: 2, end: 50 }]);
  });

  it("cuts a long line after the given number of characters, with an ellipsis", () => {
    const snippet = snip(`fox ${"x".repeat(200)}`, "fox", 50);
    assert.equal(snippet.text, `fox ${"x".repeat(46)}…`);
    assert.deepEqual(snippet.ranges, [{ start: 0, end: 3 }]);
  });

  it("starts shortly before a match that is far into the line", () => {
    const snippet = snip(`${"a".repeat(100)} fox tail`, "fox", 60);
    assert.equal(snippet.text.startsWith("…"), true);
    const [range] = snippet.ranges;
    assert.ok(range);
    assert.equal(snippet.text.slice(range.start, range.end), "fox");
    assert.equal(snippet.text.endsWith(" fox tail"), true);
  });

  it("does not cut a character outside the basic plane in half", () => {
    const line = `${"📝".repeat(30)}fox`;
    for (const length of [9, 10, 11, 12]) {
      const snippet = snip(line, "fox", length);
      assert.doesNotMatch(snippet.text, /\p{Cs}/u, `${length}`);
      const [range] = snippet.ranges;
      assert.ok(range, `${length}`);
      assert.equal(snippet.text.slice(range.start, range.end), "fox");
    }
    assert.equal(snip("📝📝📝", "zzz", 3).text, "📝📝…");
  });

  it("keeps a match of nothing at either end of what it shows", () => {
    assert.deepEqual(toSnippet("abc", [{ start: 0, end: 0 }, { start: 3, end: 3 }], 80), {
      text: "abc",
      ranges: [
        { start: 0, end: 0 },
        { start: 3, end: 3 },
      ],
    });
    assert.deepEqual(toSnippet("  abc", [{ start: 0, end: 0 }], 80).ranges, []);
  });

  it("keeps what else the ranges have", () => {
    assert.deepEqual(toSnippet("  ab", [{ start: 2, end: 3, text: "x" }], 80), {
      text: "ab",
      ranges: [{ start: 0, end: 1, text: "x" }],
    });
  });

  it("leaves a line without a match as it is, apart from the indentation", () => {
    assert.deepEqual(snip("  plain line", "zzz", 80), {
      text: "plain line",
      ranges: [],
    });
  });

  it("has no ellipsis at the start when the cut moves back to it, not to split an emoji", () => {
    const line = `📝${"a".repeat(39)}fox`;
    assert.deepEqual(toSnippet(line, [{ start: 41, end: 44 }], 80), {
      text: line,
      ranges: [{ start: 41, end: 44 }],
    });
  });
});

describe("TextIndex.searchOn", () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 60; i++) {
    many[`n${String(i).padStart(2, "0")}.md`] = [
      i % 3 === 0 ? "A quick Fox" : "nothing",
      i % 4 === 0 ? "fox hunting season\nmore foxes" : "calm",
      i % 5 === 0 ? "가계부 정산 fox" : "여행",
    ].join("\n");
  }
  const index = indexOf(many);
  const paths = Object.keys(many);

  it("finds what a search of all notes finds, while a query is typed key by key", () => {
    for (const query of ["fox hunt", "Fox", "가계부 정", "foxes", "zz", "a quick fox"]) {
      let before: TextSearch | null = null;
      for (let i = 1; i <= query.length; i++) {
        const typed = query.slice(0, i);
        const on = index.searchOn(before, plain(typed), paths, 7);
        on.run();
        const all = index.searchOn(null, plain(typed), paths, 7);
        all.run();
        assert.deepEqual([on.matches, on.total, on.found], [all.matches, all.total, all.found], `"${typed}"`);
        before = on;
      }
    }
  });

  it("looks at all notes after a search that is not done, and after a query that this one does not have in it", () => {
    const half = index.searchOn(null, plain("fox"), paths, 7);
    half.run(() => true);
    assert.equal(half.done, false);
    const afterHalf = index.searchOn(half, plain("foxes"), paths, 7);
    afterHalf.run();
    const all = index.searchOn(null, plain("foxes"), paths, 7);
    all.run();
    assert.deepEqual([afterHalf.matches, afterHalf.total], [all.matches, all.total]);

    const quick = index.searchOn(null, plain("quick"), paths, 7);
    quick.run();
    const other = index.searchOn(quick, plain("hunting"), paths, 7);
    other.run();
    assert.equal(other.total, 15);
    // Nothing was typed yet: every note is still to be looked at
    const blank = index.searchOn(null, plain(" "), paths, 7);
    const afterBlank = index.searchOn(blank, plain(" fox"), paths, 7);
    afterBlank.run();
    const allOfIt = index.searchOn(null, plain(" fox"), paths, 7);
    allOfIt.run();
    assert.ok(allOfIt.total > 0);
    assert.deepEqual([afterBlank.matches, afterBlank.total], [allOfIt.matches, allOfIt.total]);
  });
});

/** What a search for a regular expression has to find: each line tried by itself */
function lineByLine(
  texts: Record<string, string>,
  source: string,
  flags: string,
  paths: string[],
  limit: number,
): { lines: [string, number, string][]; total: number; found: string[] } {
  const pattern = new RegExp(source, flags);
  const lines: [string, number, string][] = [];
  const found: string[] = [];
  let total = 0;
  for (const path of paths) {
    const text = texts[path];
    if (text === undefined) {
      continue;
    }
    // As in Vim, a final line break ends the last line and starts no other
    const raws = text.split("\n");
    if (raws.length > 1 && raws[raws.length - 1] === "") {
      raws.pop();
    }
    raws.forEach((raw, line) => {
      const lineText = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (pattern.test(lineText)) {
        total++;
        if (found[found.length - 1] !== path) {
          found.push(path);
        }
        if (lines.length < limit) {
          lines.push([path, line, lineText]);
        }
      }
    });
  }
  return { lines, total, found };
}

describe("TextIndex.search with a regular expression", () => {
  const texts: Record<string, string> = {
    "a.md": "# Alpha\n\nThe quick brown fox.\nNo animal here.\nfox and FOX again",
    "b.md": "Budget review\r\nA Fox on line two\r\n\r\n  indented fox\r",
    "c.md": "nothing to see",
    "d.md": "a\nb\n\n\nab\nba\n\u2028x\ry\nend",
    "e.md": "📝 note\n𐐀 deseret 𐐨\n가계부 fox 정산\n\tTab\there\n",
    "f.md": "",
    "g.md": "\n\n",
    "h.md": "foo bar\nbar foo\nfoofoo\nfo\no\n",
  };
  const index = new TextIndex();
  for (const [path, text] of Object.entries(texts)) {
    index.set(path, text);
  }
  const paths = Object.keys(texts);
  const sources = [
    "fox", "^fox", "fox$", "\\.$", "^$", "^", "$", "x*", "\\b", "o\\s*x", "a\\s+b", "[^a]+",
    "\\s", "^\\s+\\w", "(?<=\\s)fox", "(?<!\\s)fox", "fox(?=\\.)", "fox(?!\\s)", "(?<!.)\\w",
    "\\w(?![\\s\\S])", "^.$", "📝", "\\p{L}+", "𐐨", "(o)\\1", "foo|bar", "^(foo|bar) (foo|bar)$",
    "\\r", "\\n", "y$", "^y", "\\t", ".", "end$", "\\u2028", "^x",
  ];

  it("finds the lines that the pattern matches by themselves", () => {
    for (const source of sources) {
      for (const matchCase of [false, true]) {
        for (const limit of [0, 2, 100]) {
          const matcher = regex(source, matchCase);
          const search = index.searchOn(null, matcher, paths, limit);
          search.run();
          const expected = lineByLine(texts, source, matchCase ? "u" : "iu", paths, limit);
          const label = `/${source}/ ${matchCase ? "case" : "any case"} limit ${limit}`;
          assert.deepEqual(
            search.matches.map((match) => [match.path, match.line, match.text]),
            expected.lines,
            label,
          );
          assert.equal(search.total, expected.total, label);
          assert.deepEqual(search.found, expected.found, label);
          for (const match of search.matches) {
            assert.deepEqual(match.first, matcher.findAll(match.text)[0], label);
          }
        }
      }
    }
  });

  it("finds the same in parts as in one go", () => {
    for (const source of ["fox", "^", "(?<!\\s)fox", "o\\s*x"]) {
      const whole = index.searchOn(null, regex(source), paths, 3);
      whole.run();
      const parts = index.searchOn(null, regex(source), paths, 3);
      while (!parts.done) {
        parts.run(() => true);
      }
      assert.deepEqual([parts.matches, parts.total, parts.found], [whole.matches, whole.total, whole.found], source);
    }
  });

  it("looks only at the notes of a search for the same query, and at all of them for a regular expression typed on", () => {
    const fox = index.searchOn(null, regex("fox"), paths, 100);
    fox.run();
    const again = index.searchOn(fox, regex("fox"), paths, 100);
    again.run();
    assert.deepEqual([again.matches, again.total], [fox.matches, fox.total]);

    // "fox|a" has "fox" in it, and finds lines that "fox" does not
    const wider = index.searchOn(fox, regex("fox|a"), paths, 100);
    wider.run();
    const all = index.searchOn(null, regex("fox|a"), paths, 100);
    all.run();
    assert.deepEqual([wider.matches, wider.total], [all.matches, all.total]);
    assert.ok(all.total > fox.total);

    // A plain query of before does not narrow a regular expression, nor the other way around
    const plainFox = index.searchOn(null, plain("fox"), paths, 100);
    plainFox.run();
    const fromPlain = index.searchOn(plainFox, regex("fox|a"), paths, 100);
    fromPlain.run();
    assert.equal(fromPlain.total, all.total);
    const toPlain = index.searchOn(wider, plain("fox|a"), paths, 100);
    toPlain.run();
    assert.equal(toPlain.total, 0);
  });

  it("narrows a plain query only with the same switch for the case", () => {
    const anyCase = index.searchOn(null, plain("Fox", true), paths, 100);
    anyCase.run();
    const typedOn = index.searchOn(anyCase, plain("fox a"), paths, 100);
    typedOn.run();
    const all = index.searchOn(null, plain("fox a"), paths, 100);
    all.run();
    assert.deepEqual([typedOn.matches, typedOn.total], [all.matches, all.total]);
  });
});

describe("TextSearch.run with notes that are not ready", () => {
  const index = new TextIndex();
  for (const [path, text] of [["a.md", "fox"], ["b.md", "fox"], ["c.md", "fox"]]) {
    index.set(path, text);
  }
  const paths = ["a.md", "b.md", "c.md"];

  it("waits at the first note that is not ready, and goes on once it is", () => {
    const ready = new Set(["a.md"]);
    const search = index.searchOn(null, regex("fox"), paths, 10);
    search.run(undefined, (path) => ready.has(path));
    assert.deepEqual([search.total, search.done, search.isWaiting], [1, false, true]);
    ready.add("c.md");
    search.run(undefined, (path) => ready.has(path));
    assert.deepEqual([search.total, search.done, search.isWaiting], [1, false, true]);
    ready.add("b.md");
    search.run(undefined, (path) => ready.has(path));
    assert.deepEqual([search.total, search.done, search.isWaiting], [3, true, false]);
  });
});

describe("TextIndex.versionOf", () => {
  it("gives a new number each time a text is set, and none for a note that is forgotten", () => {
    const index = new TextIndex();
    assert.equal(index.versionOf("a.md"), undefined);
    index.set("a.md", "one");
    const first = index.versionOf("a.md");
    index.set("b.md", "two");
    index.set("a.md", "one");
    assert.ok(first !== undefined && index.versionOf("a.md") !== first);
    index.delete("a.md");
    assert.equal(index.versionOf("a.md"), undefined);
    index.retain(new Set());
    assert.equal(index.versionOf("b.md"), undefined);
  });
});
