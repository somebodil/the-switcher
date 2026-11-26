import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Matcher } from "./matcher.ts";
import {
  countMatches,
  replaceAll,
  Replacement,
  replaceInLine,
  swapsOf,
  toPieces,
} from "./replace.ts";
import { TextIndex } from "./text-index.ts";

const plain = (text: string, matchCase = false): Matcher => new Matcher({ text, regex: false, matchCase });
const regex = (text: string, matchCase = false): Matcher => new Matcher({ text, regex: true, matchCase });
const literal = (text: string): Replacement => new Replacement(text, false);
const template = (text: string): Replacement => new Replacement(text, true);

/** Replaces with a regular expression and a replacement for it. */
function substitute(text: string, pattern: string, replacement: string): string {
  return replaceAll(text, regex(pattern), template(replacement)).text;
}

describe("replaceAll with a plain query", () => {
  it("replaces every place of the query, whatever its case", () => {
    assert.deepEqual(replaceAll("Fox and fox and FOX", plain("fox"), literal("cat")), {
      text: "cat and cat and cat",
      count: 3,
    });
  });

  it("replaces only what has the case of the query when the case is to match", () => {
    assert.deepEqual(replaceAll("Fox and fox and FOX", plain("fox", true), literal("cat")), {
      text: "Fox and cat and FOX",
      count: 1,
    });
  });

  it("replaces what the search finds, and nothing else", () => {
    const text = "# Fox\n\nThe fox.\r\nNo animal.\nfoxfox";
    const index = new TextIndex();
    index.set("n.md", text);
    const search = index.searchOn(null, plain("fox"), ["n.md"], 10);
    search.run();
    const replaced = replaceAll(text, plain("fox"), literal("dog"));
    assert.equal(replaced.text, "# dog\n\nThe dog.\r\nNo animal.\ndogdog");
    assert.equal(replaced.count, 4);
    assert.equal(search.total, 3);
  });

  it("takes the replacement as it is typed", () => {
    for (const replacement of ["$&", "$1", "$$", "$`", "\\n", "\\1", "&", "\n"]) {
      assert.equal(replaceAll("a fox", plain("fox"), literal(replacement)).text, `a ${replacement}`);
    }
  });

  it("takes the characters of a regular expression in the query as they are", () => {
    assert.equal(replaceAll("a.b axb [[a.b]]", plain("a.b"), literal("c")).text, "c axb [[c]]");
    assert.equal(replaceAll("C++ c++", plain("c++"), literal("Rust")).text, "Rust Rust");
  });

  it("does not replace inside what it put in", () => {
    assert.deepEqual(replaceAll("fox fox", plain("fox"), literal("foxes")), { text: "foxes foxes", count: 2 });
    assert.deepEqual(replaceAll("aaaa", plain("aa"), literal("a")), { text: "aa", count: 2 });
  });

  it("removes the query when the replacement is empty", () => {
    assert.equal(replaceAll("a fox b", plain(" fox"), literal("")).text, "a b");
  });

  it("changes nothing for an empty query or a text without it", () => {
    assert.deepEqual(replaceAll("fox", plain(""), literal("cat")), { text: "fox", count: 0 });
    assert.deepEqual(replaceAll("dog", plain("fox"), literal("cat")), { text: "dog", count: 0 });
  });

  it("keeps what is around a match, emoji and Korean included", () => {
    assert.equal(replaceAll("📝 예산 fox 📝", plain("FOX"), literal("여우")).text, "📝 예산 여우 📝");
    assert.equal(replaceAll("İ fox İ", plain("fox"), literal("cat")).text, "İ cat İ");
  });
});

describe("replaceAll with a regular expression", () => {
  it("brings in the whole match and the groups, as in Vim and in JavaScript", () => {
    const text = "mail anna@example and bob@test";
    const pattern = "(\\w+)@(\\w+)";
    assert.equal(substitute(text, pattern, "\\2 of \\1"), "mail example of anna and test of bob");
    assert.equal(substitute(text, pattern, "$2 of $1"), "mail example of anna and test of bob");
    for (const whole of ["&", "\\0", "$&", "$0"]) {
      assert.equal(substitute(text, pattern, `<${whole}>`), "mail <anna@example> and <bob@test>", whole);
    }
  });

  it("brings in a named group", () => {
    assert.equal(substitute("anna@example", "(?<user>\\w+)@(?<host>\\w+)", "$<host>/$<user>"), "example/anna");
  });

  it("changes the case of what follows", () => {
    assert.equal(substitute("hello world", "(\\w+) (\\w+)", "\\u\\1 \\U\\2\\E!"), "Hello WORLD!");
    assert.equal(substitute("HELLO World", "\\w+", "\\L&"), "hello world");
    assert.equal(substitute("HELLO", "\\w+", "\\l&"), "hELLO");
    assert.equal(substitute("hello world", "(\\w+) (\\w+)", "\\U\\1\\e \\2"), "HELLO world");
    // Upper case for the first character, lower case for the rest
    assert.equal(substitute("hELLO", "\\w+", "\\L\\u&"), "Hello");
    // The next character after a group that is empty
    assert.equal(substitute("ab", "(x?)(a)", "\\u\\1\\2"), "Ab");
    assert.equal(substitute("straße", ".+", "\\U&"), "STRASSE");
    assert.equal(substitute("ǆ", ".", "\\u&"), "Ǆ");
  });

  it("changes the case of what \\U or \\L covers as a whole, as of a word", () => {
    // A Greek sigma in lower case is final only at the end of a word
    assert.equal(substitute("ΑΣΩ", "(ΑΣ)(Ω)", "\\L\\1\\2"), "ασω");
    assert.equal(substitute("ΟΔΟΣ", ".+", "\\L&"), "οδος");
    assert.equal(substitute("ΟΔΟΣ ΑΣ", "(\\S+) (\\S+)", "\\L\\1-\\2\\E!"), "οδος-ας!");
    assert.equal(substitute("ab cd", "(\\w+) (\\w+)", "\\U\\1\\l\\2\\E"), "ABcD");
  });

  it("puts in a line break of the kind that the note has", () => {
    assert.equal(substitute("a, b\nc", ", ", "\\n"), "a\nb\nc");
    assert.equal(substitute("a, b\r\nc, d", ", ", "\\n"), "a\r\nb\r\nc\r\nd");
    assert.equal(substitute("a, b", ", ", "\\r"), "a\nb");
    assert.equal(substitute("a\tb", "\\t", "\\t\\t"), "a\t\tb");
  });

  it("takes \\r\\n as one line break, as other editors write it", () => {
    assert.equal(substitute("a, b\r\nc", ", ", "\\r\\n"), "a\r\nb\r\nc");
    assert.equal(substitute("a, b", ", ", "\\r\\n"), "a\nb");
    assert.equal(substitute("a, b", ", ", "\\n\\r"), "a\n\nb");
    assert.equal(substitute("a, b", ", ", "\\r\\\\n"), "a\n\\nb");
  });

  it("takes a character after a backslash as it is, and $$ as $", () => {
    assert.equal(substitute("x", "x", "\\&\\\\\\$\\/$$"), "&\\$/$");
    assert.equal(substitute("x", "x", "a\\"), "a\\");
    assert.equal(substitute("x", "x", "$"), "$");
    assert.equal(substitute("x", "x", "$<x"), "$<x");
    assert.equal(substitute("x", "x", "$x"), "$x");
  });

  it("leaves a group that the pattern does not have as JavaScript does, and empty after a backslash", () => {
    assert.equal(substitute("a", "(a)", "[$2]"), "[$2]");
    assert.equal(substitute("a", "(a)", "[\\2]"), "[]");
    assert.equal(substitute("a", "(a)", "[$10]"), "[a0]");
    assert.equal(substitute("a", "a", "[$<x>]"), "[$<x>]");
    // A named group that is there but has not matched
    assert.equal(substitute("y", "(?<a>x)|y", "[$<a>]"), "[]");
    assert.equal(substitute("y", "(x)|y", "[$1\\1]"), "[]");
  });

  it("takes two digits after $ as a group when the pattern has that many", () => {
    const pattern = "(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)";
    assert.equal(substitute("abcdefghijk", pattern, "$11$10$1"), "kja");
    assert.equal(substitute("abcdefghijk", pattern, "\\11"), "a1");
  });

  it("matches one line at a time: ^ and $ are its start and end, and a match does not go into the next line", () => {
    assert.equal(substitute("a\nb\r\nc", "^", "- "), "- a\n- b\r\n- c");
    assert.equal(substitute("a\nb\r\nc", "$", ";"), "a;\nb;\r\nc;");
    assert.deepEqual(replaceAll("a\nb", regex("a\\s*b"), template("x")), { text: "a\nb", count: 0 });
    assert.equal(substitute("a b\nc d", "\\w \\w", "&!"), "a b!\nc d!");
  });

  it("takes a final line break as the end of the last line, as Vim does, and not as one more line", () => {
    assert.deepEqual(replaceAll("a\nb\n", regex("^"), template("- ")), { text: "- a\n- b\n", count: 2 });
    assert.equal(substitute("a\r\nb\r\n", "$", ";"), "a;\r\nb;\r\n");
    assert.equal(substitute("a\n\n", "^$", "empty"), "a\nempty\n");
    assert.equal(substitute("", "^$", "empty"), "empty");
    assert.equal(substitute("\n", "^$", "empty"), "empty\n");
    assert.equal(countMatches("a\nb\n", regex("^")), 2);
  });

  it("replaces matches of nothing as JavaScript does", () => {
    assert.deepEqual(replaceAll("abc", regex("x*"), template("-")), { text: "-a-b-c-", count: 4 });
    assert.equal(substitute("aab", "a*", "-"), "--b-");
    assert.equal(substitute("📝", "x*", "-"), "-📝-");
  });

  it("leaves no half of an emoji in the text", () => {
    assert.equal(substitute("hi📝", "\\B", " "), "h i📝 ");
    assert.equal(substitute("#📝", "\\#.", "X"), "X");
    assert.equal(substitute("e📝 ex", "\\e.", "X"), "e📝 X");
    assert.equal(countMatches("x📝y", regex("\\B")), 0);
  });

  it("keeps the lines without a match as they are", () => {
    const text = "keep\r\nfox\n\nkeep too\r\n";
    assert.equal(substitute(text, "fox", "cat"), "keep\r\ncat\n\nkeep too\r\n");
    assert.deepEqual(replaceAll(text, regex("none"), template("x")), { text, count: 0 });
  });

  it("finds whatever the case unless the case is to match", () => {
    assert.equal(replaceAll("Ab ab", regex("a(b)"), template("$1")).text, "b b");
    assert.equal(replaceAll("Ab ab", regex("a(b)", true), template("$1")).text, "Ab b");
  });
});

describe("countMatches", () => {
  it("counts what replaceAll replaces", () => {
    const text = "fox Fox\r\nfoxfox\n\nno\nfox";
    const cases: [Matcher, string][] = [
      [plain("fox"), text],
      [plain("fox", true), text],
      [regex("^"), text],
      [regex("x*"), "abc\nde"],
      [regex("(?<=f)o"), text],
      [regex("o\\s*x"), "o\nx o x"],
    ];
    for (const [matcher, sample] of cases) {
      assert.equal(countMatches(sample, matcher), replaceAll(sample, matcher, literal("_")).count, matcher.query.text);
    }
    assert.equal(countMatches(text, plain("fox")), 5);
  });
});

describe("replaceInLine", () => {
  const text = "fox one\r\nfox two, FOX\nfox three";

  it("replaces the query in that line only", () => {
    assert.deepEqual(replaceInLine(text, 1, "fox two, FOX", plain("fox"), literal("cat")), {
      text: "fox one\r\ncat two, cat\nfox three",
      count: 2,
    });
  });

  it("keeps the line break of the line", () => {
    assert.deepEqual(replaceInLine(text, 0, "fox one", plain("fox"), literal("cat")), {
      text: "cat one\r\nfox two, FOX\nfox three",
      count: 1,
    });
  });

  it("replaces in the last line", () => {
    assert.equal(replaceInLine(text, 2, "fox three", plain("fox"), literal("cat"))?.text, "fox one\r\nfox two, FOX\ncat three");
    assert.equal(replaceInLine("a\nfox\n", 1, "fox", plain("fox"), literal("cat"))?.text, "a\ncat\n");
  });

  it("replaces with a regular expression in the line as it is by itself", () => {
    assert.equal(replaceInLine(text, 1, "fox two, FOX", regex("^(\\w+)"), template("[\\1]"))?.text, "fox one\r\n[fox] two, FOX\nfox three");
    assert.equal(replaceInLine(text, 0, "fox one", regex("$"), template("\\n"))?.text, "fox one\r\n\r\nfox two, FOX\nfox three");
  });

  it("tells how many matches it replaced, also when the line stays the same", () => {
    assert.deepEqual(replaceInLine("ab", 0, "ab", regex("(a)"), template("$1")), { text: "ab", count: 1 });
  });

  it("replaces nothing when the line reads otherwise now", () => {
    assert.equal(replaceInLine(text, 1, "fox two", plain("fox"), literal("cat")), null);
    assert.equal(replaceInLine(text, 0, "fox two, FOX", plain("fox"), literal("cat")), null);
  });

  it("replaces nothing in a line after the end of the text", () => {
    assert.equal(replaceInLine(text, 3, "fox", plain("fox"), literal("cat")), null);
    assert.equal(replaceInLine(text, 9, "", plain("fox"), literal("cat")), null);
    // As in Vim, a line break at the end starts no line: an empty line that was there is gone
    assert.equal(replaceInLine("a\n", 1, "", regex("^$"), template("empty")), null);
    assert.equal(replaceInLine("a\r\n", 1, "", regex("^$"), template("empty")), null);
    assert.deepEqual(replaceInLine("a\n\n", 1, "", regex("^$"), template("empty")), { text: "a\nempty\n", count: 1 });
  });
});

describe("toPieces", () => {
  it("puts the replacement after each place it replaces", () => {
    const line = "a fox, a FOX.";
    assert.deepEqual(toPieces(line, swapsOf(line, plain("fox"), literal("cat"), "\n")), [
      { text: "a ", kind: "same" },
      { text: "fox", kind: "old" },
      { text: "cat", kind: "new" },
      { text: ", a ", kind: "same" },
      { text: "FOX", kind: "old" },
      { text: "cat", kind: "new" },
      { text: ".", kind: "same" },
    ]);
  });

  it("gives each match the replacement that it makes", () => {
    const line = "a1 b2";
    assert.deepEqual(toPieces(line, swapsOf(line, regex("(\\w)(\\d)"), template("\\2\\U\\1"), "\n")), [
      { text: "a1", kind: "old" },
      { text: "1A", kind: "new" },
      { text: " ", kind: "same" },
      { text: "b2", kind: "old" },
      { text: "2B", kind: "new" },
    ]);
  });

  it("puts in what replaces a match of nothing", () => {
    assert.deepEqual(toPieces("ab", swapsOf("ab", regex("^"), template("- "), "\n")), [
      { text: "- ", kind: "new" },
      { text: "ab", kind: "same" },
    ]);
  });

  it("keeps places that touch apart", () => {
    assert.deepEqual(toPieces("aaaa", swapsOf("aaaa", plain("aa"), literal("b"), "\n")), [
      { text: "aa", kind: "old" },
      { text: "b", kind: "new" },
      { text: "aa", kind: "old" },
      { text: "b", kind: "new" },
    ]);
  });

  it("has nothing new when the replacement is empty", () => {
    assert.deepEqual(toPieces("fox!", [{ start: 0, end: 3, text: "" }]), [
      { text: "fox", kind: "old" },
      { text: "!", kind: "same" },
    ]);
  });

  it("leaves a line without a match as it is", () => {
    assert.deepEqual(toPieces("plain", []), [{ text: "plain", kind: "same" }]);
    assert.deepEqual(toPieces("", []), []);
  });
});

describe("swapsOf with a span", () => {
  it("has the replacements of the matches within the span of the first one", () => {
    const line = `${"=".repeat(1000)}a1 b2 c3 d4`;
    assert.deepEqual(swapsOf(line, regex("(\\w)(\\d)"), template("\\2\\1"), "\n", 4), [
      { start: 1000, end: 1002, text: "1a" },
      { start: 1003, end: 1005, text: "2b" },
    ]);
    assert.equal(swapsOf(line, regex("(\\w)(\\d)"), template("\\2\\1"), "\n").length, 4);
  });
});
