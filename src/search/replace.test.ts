import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replaceAll, replaceInLine, toPieces } from "./replace.ts";
import { findAll, TextIndex } from "./text-index.ts";

describe("replaceAll", () => {
  it("replaces every place of the query, whatever its case", () => {
    assert.deepEqual(replaceAll("Fox and fox and FOX", "fox", "cat"), {
      text: "cat and cat and cat",
      count: 3,
    });
  });

  it("replaces what the search finds, and nothing else", () => {
    const text = "# Fox\n\nThe fox.\r\nNo animal.\nfoxfox";
    const index = new TextIndex();
    index.set("n.md", text);
    const search = index.searchOn(null, "fox", ["n.md"], 10);
    search.run();
    const replaced = replaceAll(text, "fox", "dog");
    assert.equal(replaced.text, "# dog\n\nThe dog.\r\nNo animal.\ndogdog");
    assert.equal(replaced.count, 4);
    assert.equal(search.total, 3);
  });

  it("takes the replacement as it is typed", () => {
    for (const replacement of ["$&", "$1", "$$", "$`", "\\n", "\n"]) {
      assert.equal(replaceAll("a fox", "fox", replacement).text, `a ${replacement}`);
    }
  });

  it("takes the characters of a regular expression in the query as they are", () => {
    assert.equal(replaceAll("a.b axb [[a.b]]", "a.b", "c").text, "c axb [[c]]");
    assert.equal(replaceAll("C++ c++", "c++", "Rust").text, "Rust Rust");
  });

  it("does not replace inside what it put in", () => {
    assert.deepEqual(replaceAll("fox fox", "fox", "foxes"), { text: "foxes foxes", count: 2 });
    assert.deepEqual(replaceAll("aaaa", "aa", "a"), { text: "aa", count: 2 });
  });

  it("removes the query when the replacement is empty", () => {
    assert.equal(replaceAll("a fox b", " fox", "").text, "a b");
  });

  it("changes nothing for an empty query or a text without it", () => {
    assert.deepEqual(replaceAll("fox", "", "cat"), { text: "fox", count: 0 });
    assert.deepEqual(replaceAll("dog", "fox", "cat"), { text: "dog", count: 0 });
  });

  it("keeps what is around a match, emoji and Korean included", () => {
    assert.equal(replaceAll("📝 예산 fox 📝", "FOX", "여우").text, "📝 예산 여우 📝");
    assert.equal(replaceAll("İ fox İ", "fox", "cat").text, "İ cat İ");
  });
});

describe("replaceInLine", () => {
  const text = "fox one\r\nfox two, FOX\nfox three";

  it("replaces the query in that line only", () => {
    assert.deepEqual(replaceInLine(text, 1, "fox two, FOX", "fox", "cat"), {
      text: "fox one\r\ncat two, cat\nfox three",
      count: 2,
    });
  });

  it("keeps the line break of the line", () => {
    assert.deepEqual(replaceInLine(text, 0, "fox one", "fox", "cat"), {
      text: "cat one\r\nfox two, FOX\nfox three",
      count: 1,
    });
  });

  it("replaces in the last line", () => {
    assert.equal(replaceInLine(text, 2, "fox three", "fox", "cat")?.text, "fox one\r\nfox two, FOX\ncat three");
    assert.equal(replaceInLine("a\nfox\n", 1, "fox", "fox", "cat")?.text, "a\ncat\n");
  });

  it("replaces nothing when the line reads otherwise now", () => {
    assert.equal(replaceInLine(text, 1, "fox two", "fox", "cat"), null);
    assert.equal(replaceInLine(text, 0, "fox two, FOX", "fox", "cat"), null);
  });

  it("replaces nothing in a line after the end of the text", () => {
    assert.equal(replaceInLine(text, 3, "fox", "fox", "cat"), null);
    assert.equal(replaceInLine(text, 9, "", "fox", "cat"), null);
  });
});

describe("toPieces", () => {
  it("puts the replacement after each place it replaces", () => {
    const line = "a fox, a FOX.";
    assert.deepEqual(toPieces(line, findAll(line, "fox"), "cat"), [
      { text: "a ", kind: "same" },
      { text: "fox", kind: "old" },
      { text: "cat", kind: "new" },
      { text: ", a ", kind: "same" },
      { text: "FOX", kind: "old" },
      { text: "cat", kind: "new" },
      { text: ".", kind: "same" },
    ]);
  });

  it("keeps places that touch apart", () => {
    assert.deepEqual(toPieces("aaaa", findAll("aaaa", "aa"), "b"), [
      { text: "aa", kind: "old" },
      { text: "b", kind: "new" },
      { text: "aa", kind: "old" },
      { text: "b", kind: "new" },
    ]);
  });

  it("has nothing new when the replacement is empty", () => {
    assert.deepEqual(toPieces("fox!", [{ start: 0, end: 3 }], ""), [
      { text: "fox", kind: "old" },
      { text: "!", kind: "same" },
    ]);
  });

  it("leaves a line without a range as it is", () => {
    assert.deepEqual(toPieces("plain", [], "cat"), [{ text: "plain", kind: "same" }]);
    assert.deepEqual(toPieces("", [], "cat"), []);
  });
});
