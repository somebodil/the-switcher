import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseQuery, splitWords } from "./query.ts";

describe("splitWords", () => {
  it("splits at spaces and drops empty words", () => {
    assert.deepEqual(splitWords("alpha  beta "), ["alpha", "beta"]);
    assert.deepEqual(splitWords("   "), []);
  });

  it("keeps the spaces between double quotes", () => {
    assert.deepEqual(splitWords('"alpha beta" gamma'), ["alpha beta", "gamma"]);
    assert.deepEqual(splitWords('al"pha be"ta'), ["alpha beta"]);
    assert.deepEqual(splitWords('"not closed yet'), ["not closed yet"]);
  });

  it("reads an escaped quote as a quote character", () => {
    assert.deepEqual(splitWords('say \\"hi\\" now'), ["say", '"hi"', "now"]);
  });
});

describe("parseQuery", () => {
  it("folds a plain word", () => {
    assert.deepEqual(parseQuery("Alpha"), [
      { text: "alpha", folders: [], name: "alpha", negated: false },
    ]);
  });

  it("drops the spaces of a quoted word", () => {
    assert.deepEqual(parseQuery('"Alpha Beta"'), [
      { text: "alphabeta", folders: [], name: "alphabeta", negated: false },
    ]);
  });

  it("reads a word that starts with a dash as negated", () => {
    assert.deepEqual(parseQuery("-old"), [
      { text: "old", folders: [], name: "old", negated: true },
    ]);
  });

  it("skips a dash that has no word yet", () => {
    assert.deepEqual(parseQuery("al -"), [
      { text: "al", folders: [], name: "al", negated: false },
    ]);
  });

  it("separates the folders from the name at the last slash", () => {
    assert.deepEqual(parseQuery("Projects/Deep/Plan"), [
      {
        text: "projects/deep/plan",
        folders: ["projects", "deep"],
        name: "plan",
        negated: false,
      },
    ]);
  });

  it("leaves the name empty for a word that ends with a slash", () => {
    assert.deepEqual(parseQuery("Notes/"), [
      { text: "notes/", folders: ["notes"], name: "", negated: false },
    ]);
  });

  it("puts the current folder in place of <cd>", () => {
    assert.deepEqual(parseQuery("<cd>/al", "Notes/Sub"), [
      {
        text: "notes/sub/al",
        folders: ["notes", "sub"],
        name: "al",
        negated: false,
      },
    ]);
  });
});
