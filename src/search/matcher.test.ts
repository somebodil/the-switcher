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

  it("tells why a pattern is not valid as Unicode makes it", () => {
    assert.throws(() => regex("(\\#"), /Invalid regular expression: \/\(\\#\/giu: /);
  });

  it("lets a backslash before a character that means nothing be, as without Unicode", () => {
    assert.deepEqual(regex("\\#tag").findAll("a #tag"), [{ start: 2, end: 6 }]);
    assert.deepEqual(regex("^\\- \\[ \\]").findAll("- [ ] task"), [{ start: 0, end: 5 }]);
    assert.deepEqual(regex("a{").findAll("a{b"), [{ start: 0, end: 2 }]);
    assert.deepEqual(regex("[\\w-.]+").findAll("a-b.c d"), [{ start: 0, end: 5 }, { start: 6, end: 7 }]);
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

describe("sameQuery", () => {
  it("compares the text and both switches", () => {
    const query = { text: "a", regex: false, matchCase: false };
    assert.equal(sameQuery(query, { ...query }), true);
    assert.equal(sameQuery(query, { ...query, text: "b" }), false);
    assert.equal(sameQuery(query, { ...query, regex: true }), false);
    assert.equal(sameQuery(query, { ...query, matchCase: true }), false);
  });
});
