import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { locate, mergeRanges, toSegments } from "./highlight.ts";

describe("locate", () => {
  it("finds a word regardless of case", () => {
    assert.deepEqual(locate("Alpha Beta", "be"), { start: 6, end: 8 });
    assert.deepEqual(locate("Alpha Beta", "alpha"), { start: 0, end: 5 });
  });

  it("finds a word that spans whitespace in the text", () => {
    assert.deepEqual(locate("Alpha Beta", "habe"), { start: 3, end: 8 });
    assert.deepEqual(locate("가계부 정산", "부정"), { start: 2, end: 5 });
  });

  it("returns the first place of several", () => {
    assert.deepEqual(locate("banana", "an"), { start: 1, end: 3 });
  });

  it("counts characters outside the basic plane as two code units", () => {
    assert.deepEqual(locate("📝memo", "me"), { start: 2, end: 4 });
    assert.deepEqual(locate("📝memo", "📝m"), { start: 0, end: 3 });
  });

  it("returns null if the word is missing or empty", () => {
    assert.equal(locate("Alpha", "x"), null);
    assert.equal(locate("Alpha", ""), null);
  });
});

describe("mergeRanges", () => {
  it("joins ranges that overlap or touch, in order", () => {
    assert.deepEqual(
      mergeRanges([
        { start: 6, end: 8 },
        { start: 0, end: 2 },
        { start: 2, end: 4 },
        { start: 3, end: 5 },
      ]),
      [
        { start: 0, end: 5 },
        { start: 6, end: 8 },
      ],
    );
  });

  it("does not change the ranges it is given", () => {
    const ranges = [
      { start: 0, end: 2 },
      { start: 1, end: 3 },
    ];
    mergeRanges(ranges);
    assert.deepEqual(ranges, [
      { start: 0, end: 2 },
      { start: 1, end: 3 },
    ]);
  });
});

describe("toSegments", () => {
  it("cuts the text into highlighted and plain parts", () => {
    assert.deepEqual(
      toSegments("Alpha Beta", [
        { start: 6, end: 8 },
        { start: 0, end: 2 },
      ]),
      [
        { text: "Al", highlighted: true },
        { text: "pha ", highlighted: false },
        { text: "Be", highlighted: true },
        { text: "ta", highlighted: false },
      ],
    );
  });

  it("returns the whole text as plain without ranges", () => {
    assert.deepEqual(toSegments("Alpha", []), [
      { text: "Alpha", highlighted: false },
    ]);
  });

  it("ignores what lies beyond the text", () => {
    assert.deepEqual(toSegments("pic", [{ start: 2, end: 6 }]), [
      { text: "pi", highlighted: false },
      { text: "c", highlighted: true },
    ]);
    assert.deepEqual(toSegments("pic", [{ start: 4, end: 7 }]), [
      { text: "pic", highlighted: false },
    ]);
  });
});
