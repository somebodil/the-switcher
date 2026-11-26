import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Matcher, sameQuery } from "./matcher.ts";

const plain = (text: string, matchCase = false): Matcher => new Matcher({ text, regex: false, matchCase });
const regex = (text: string, matchCase = false): Matcher => new Matcher({ text, regex: true, matchCase });
const findAll = (line: string, query: string): ReturnType<Matcher["findAll"]> => plain(query).findAll(line);

describe("Matcher with a plain query", () => {
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

  it("finds a letter whatever its case as Unicode has it, as a regular expression does", () => {
    // The final sigma is a sigma in lower case
    assert.deepEqual(findAll("οδος", "ΟΔΟΣ"), [{ start: 0, end: 4 }]);
    assert.deepEqual(findAll("ΟΔΟΣ", "οδος"), [{ start: 0, end: 4 }]);
    // The Kelvin sign is a K
    assert.deepEqual(findAll("\u212A", "k"), [{ start: 0, end: 1 }]);
    assert.deepEqual(findAll("ẞ", "ß"), [{ start: 0, end: 1 }]);
    assert.deepEqual(findAll("ß", "ẞ"), [{ start: 0, end: 1 }]);
    // The dotless i is a letter of its own, either way
    assert.deepEqual(findAll("I", "ı"), []);
    assert.deepEqual(findAll("ı", "I"), []);
    for (const [line, query] of [["οδος", "ΟΔΟΣ"], ["\u212A", "k"], ["I", "ı"], ["ı", "I"], ["ǅ", "ǆ"]] as const) {
      assert.deepEqual(findAll(line, query), regex(query).findAll(line), `${query} in ${line}`);
    }
  });

  it("finds letters outside the basic plane whatever their case", () => {
    // Deseret: "𐐨" is the lower case of "𐐀"
    assert.deepEqual(findAll("𐐀 𐐨", "𐐨"), [
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });
});

describe("Matcher with a plain query and the case to match", () => {
  it("finds only what has the case of the query", () => {
    assert.deepEqual(plain("Fox", true).findAll("fox Fox FOX"), [{ start: 4, end: 7 }]);
    assert.deepEqual(plain("straße", true).findAll("Straße straße STRASSE"), [{ start: 7, end: 13 }]);
  });

  it("takes the characters of a regular expression as they are", () => {
    for (const query of ["a.b", "(x)", "[x]", "x+", "\\d", "^", "$", "{1}"]) {
      assert.deepEqual(plain(query, true).findAll(`-${query}-`), [{ start: 1, end: 1 + query.length }], query);
    }
  });
});

describe("Matcher with a regular expression", () => {
  it("finds what the pattern matches, whatever its case unless the case is to match", () => {
    assert.deepEqual(regex("f.x").findAll("fax FIX f-x"), [
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
    assert.deepEqual(regex("f.x", true).findAll("fax FIX f-x"), [
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it("takes ^ and $ as the start and the end of the line", () => {
    assert.deepEqual(regex("^a|b$").findAll("a ab b"), [
      { start: 0, end: 1 },
      { start: 5, end: 6 },
    ]);
    assert.equal(regex("^ab$").test("ab"), true);
    assert.equal(regex("^ab$").test("xab"), false);
  });

  it("finds a match of nothing at each place, a whole character apart", () => {
    assert.deepEqual(regex("x*").findAll("ab"), [
      { start: 0, end: 0 },
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ]);
    assert.deepEqual(regex("x*").findAll("📝"), [
      { start: 0, end: 0 },
      { start: 2, end: 2 },
    ]);
    assert.deepEqual(regex("$").findAll("ab"), [{ start: 2, end: 2 }]);
    assert.deepEqual(regex("\\b").findAll("ab cd"), [
      { start: 0, end: 0 },
      { start: 2, end: 2 },
      { start: 3, end: 3 },
      { start: 5, end: 5 },
    ]);
  });

  it("finds a match of nothing right after a match, as JavaScript does", () => {
    assert.deepEqual(regex("a*").findAll("aab"), [
      { start: 0, end: 2 },
      { start: 2, end: 2 },
      { start: 3, end: 3 },
    ]);
  });

  it("takes a character outside the basic plane as one", () => {
    assert.equal(regex("^.$").test("📝"), true);
    assert.deepEqual(regex("[😀-😂]").findAll("a😁b"), [{ start: 1, end: 3 }]);
  });

  it("has groups, named groups and back references", () => {
    const [found] = regex("(?<first>\\w)(\\w)\\2").execAll("abb");
    assert.ok(found);
    assert.deepEqual([found[0], found[1], found[2], found.groups?.first], ["abb", "a", "b", "a"]);
    assert.deepEqual(regex("(\\w)\\1").findAll("aa bc DD"), [
      { start: 0, end: 2 },
      { start: 6, end: 8 },
    ]);
  });

  it("throws for a pattern that is not valid", () => {
    for (const source of ["(", "[a", "a{2,1}", "\\", "(?<a>x)(?<a>y)", "x**", "\\k<none>(?<a>x)"]) {
      assert.throws(() => regex(source), SyntaxError, source);
    }
  });

  it("tells why a pattern is not valid as Unicode makes it, and not for a backslash too many", () => {
    assert.throws(() => regex("(\\#"), /^SyntaxError: Invalid regular expression: \/.*\/giu: Unterminated group$/);
  });

  it("lets a backslash before a character that means nothing be, as without Unicode", () => {
    assert.deepEqual(regex("\\#tag").findAll("a #tag"), [{ start: 2, end: 6 }]);
    assert.deepEqual(regex("^\\- \\[ \\]").findAll("- [ ] task"), [{ start: 0, end: 5 }]);
    assert.deepEqual(regex("a{").findAll("a{b"), [{ start: 0, end: 2 }]);
    assert.deepEqual(regex("[\\w-.]+").findAll("a-b.c d"), [{ start: 0, end: 5 }, { start: 6, end: 7 }]);
  });

  it("stays Unicode aware with a backslash too many, or a brace that starts no repeat", () => {
    // `.` is a whole emoji, and a property is a property
    assert.deepEqual(regex("\\#.").findAll("#📝"), [{ start: 0, end: 3 }]);
    assert.deepEqual(regex("\\#\\p{L}+").findAll("#tag #한글"), [{ start: 0, end: 4 }, { start: 5, end: 8 }]);
    assert.deepEqual(regex("\\-\\s\\S").findAll("- 📝"), [{ start: 0, end: 4 }]);
    assert.deepEqual(regex("\\#\\u{1F4DD}").findAll("#📝"), [{ start: 0, end: 3 }]);
    assert.deepEqual(regex("\\\\#.").findAll("\\#📝"), [{ start: 0, end: 4 }]);
    assert.deepEqual(regex("a{,5}").findAll("a{,5}"), [{ start: 0, end: 5 }]);
    assert.deepEqual(regex("\\#x{2}}").findAll("#xx}"), [{ start: 0, end: 4 }]);
    // A `-` next to a kind of character in a class is a `-`
    assert.deepEqual(regex("[\\w-.]+ \\#.").findAll("a-b.c #📝"), [{ start: 0, end: 9 }]);
  });

  it("takes a pattern that is not valid with Unicode for another reason as without it", () => {
    assert.deepEqual(regex("\\e").findAll("e"), [{ start: 0, end: 1 }]);
    assert.deepEqual(regex("(?=a)*b").findAll("ab"), [{ start: 1, end: 2 }]);
  });

  it("finds no match that splits a character outside the basic plane", () => {
    // V8 finds a match of nothing between the halves of an emoji for \B
    assert.deepEqual(regex("\\B").findAll("x📝y"), []);
    assert.equal(regex("\\B").test("x📝y"), false);
    assert.equal(regex("\\B").first("x📝y"), null);
    assert.deepEqual(regex("\\B").findAll("ab📝"), [{ start: 1, end: 1 }, { start: 4, end: 4 }]);
    // Without Unicode, `.` matches half of an emoji
    assert.deepEqual(regex("\\e.").findAll("e📝 ex"), [{ start: 4, end: 6 }]);
    assert.equal(regex("\\e.").first("e📝"), null);
    assert.equal(regex("\\e.").test("e📝"), false);
    assert.equal(regex("\\e.").test("e📝 ex"), true);
  });

  it("stays Unicode aware for a pattern that is valid with Unicode", () => {
    assert.equal(regex("^.$").test("📝"), true);
    assert.deepEqual(regex("\\p{L}+").findAll("가계부 x"), [{ start: 0, end: 3 }, { start: 4, end: 5 }]);
  });

  it("is empty for an empty pattern only, and a plain query for a blank one too", () => {
    assert.equal(regex("").isEmpty, true);
    assert.equal(regex(" ").isEmpty, false);
    assert.deepEqual(regex(" ").findAll("a b"), [{ start: 1, end: 2 }]);
    assert.equal(plain(" ").isEmpty, true);
    assert.deepEqual(regex("").findAll("abc"), []);
    assert.equal(regex("").test("abc"), false);
  });

  it("scans whole notes for a plain query, and has a regular expression try each line by itself", () => {
    assert.notEqual(plain("x").scan, null);
    assert.notEqual(plain("(?=").scan, null);
    assert.equal(regex("x").scan, null);
    assert.equal(regex("a(?=b)").scan, null);
  });

  it("gives the same matches when asked again", () => {
    const matcher = regex("o");
    assert.equal(matcher.test("foo"), true);
    assert.deepEqual(matcher.findAll("foo"), [
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
    assert.deepEqual(matcher.findAll("foo"), matcher.findAll("foo"));
    assert.equal(matcher.test("foo"), true);
  });
});

describe("Matcher with a span", () => {
  it("finds the matches that start within the span of the first one, the first one included", () => {
    const line = "ab ab ab ab";
    assert.deepEqual(plain("ab").findAll(line, 0), [{ start: 0, end: 2 }]);
    assert.deepEqual(plain("ab").findAll(line, 4), [{ start: 0, end: 2 }, { start: 3, end: 5 }]);
    assert.deepEqual(plain("ab").findAll(line, 6), plain("ab").findAll(line, 4));
    assert.deepEqual(plain("ab").findAll(line, 7), plain("ab").findAll(line).slice(0, 3));
    assert.deepEqual(regex("b").findAll(`${"x".repeat(50)}b b b`, 3), [{ start: 50, end: 51 }, { start: 52, end: 53 }]);
  });

  it("counts the span from the first match, wherever it is", () => {
    const line = `${"-".repeat(100_000)}needle needle`;
    assert.deepEqual(plain("needle").findAll(line, 10), [{ start: 100_000, end: 100_006 }, { start: 100_007, end: 100_013 }]);
  });

  it("finds every match without a span, and with one wider than the line", () => {
    const line = "a1 a2 a3";
    assert.deepEqual(regex("a\\d").findAll(line, 1000), regex("a\\d").findAll(line));
    assert.equal(regex("a\\d").findAll(line).length, 3);
  });

  it("goes on past matches of nothing, as without a span", () => {
    assert.deepEqual(regex("x*").findAll("😀a😀", 4), [{ start: 0, end: 0 }, { start: 2, end: 2 }, { start: 3, end: 3 }]);
  });

  it("tells where the first match is", () => {
    assert.deepEqual(plain("fox").first("a Fox, a fox"), { start: 2, end: 5 });
    assert.deepEqual(regex("\\d+").first("x 12 345"), { start: 2, end: 4 });
    assert.deepEqual(regex("^").first("abc"), { start: 0, end: 0 });
    assert.equal(regex("z").first("abc"), null);
    assert.equal(regex("").first("abc"), null);
    assert.equal(plain(" ").first("a b"), null);
  });

  it("finds the same first match when asked again", () => {
    const matcher = regex("o");
    matcher.findAll("foo");
    assert.deepEqual(matcher.first("foo"), { start: 1, end: 2 });
    assert.deepEqual(matcher.first("foo"), { start: 1, end: 2 });
  });
});

describe("sameQuery", () => {
  it("compares the text and both switches", () => {
    const query = { text: "a", regex: false, matchCase: false };
    assert.equal(sameQuery(query, { ...query }), true);
    assert.equal(sameQuery(query, { ...query, text: "b" }), false);
    assert.equal(sameQuery(query, { ...query, regex: true }), false);
    assert.equal(sameQuery(query, { ...query, matchCase: true }), false);
  });
});
