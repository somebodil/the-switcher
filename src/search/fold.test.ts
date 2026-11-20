import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fold, startsWith, stripEmoji } from "./fold.ts";

describe("fold", () => {
  it("lowercases and drops whitespace", () => {
    assert.equal(fold("Alpha Beta"), "alphabeta");
    assert.equal(fold("  A\tB  C "), "abc");
    assert.equal(fold("가계부 정산"), "가계부정산");
  });

  it("keeps emoji and punctuation", () => {
    assert.equal(fold("📝 Memo-1"), "📝memo-1");
  });
});

describe("stripEmoji", () => {
  it("drops pictographs wherever they are", () => {
    assert.equal(stripEmoji("📝memo"), "memo");
    assert.equal(stripEmoji("a📘b🎯"), "ab");
  });

  it("drops emoji made of several characters as a whole", () => {
    assert.equal(stripEmoji("👨‍👩‍👧 family"), " family");
    assert.equal(stripEmoji("👍🏽 ok"), " ok");
    assert.equal(stripEmoji("🇰🇷 Korea"), " Korea");
    assert.equal(stripEmoji("☀️ sun"), " sun");
  });

  it("leaves letters, digits and punctuation alone", () => {
    assert.equal(stripEmoji("Plan #1 (v2) – 정산"), "Plan #1 (v2) – 정산");
  });
});

describe("startsWith", () => {
  it("looks past emoji at the start", () => {
    assert.equal(startsWith("📝memo", "me"), true);
    assert.equal(startsWith("📝memo", "📝me"), true);
    assert.equal(startsWith("memo", "em"), false);
  });
});
