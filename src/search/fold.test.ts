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

describe("texts that are seen at a glance to need no work", () => {
  it("still finds the emoji that hide among signs and Korean", () => {
    // What a glance may take for plain: the signs of a keyboard, and the two signs that are emoji
    assert.equal(stripEmoji("가계부 #1 (정산)"), "가계부 #1 (정산)");
    assert.equal(stripEmoji("가계부 📝 정산"), "가계부  정산");
    assert.equal(stripEmoji("made by me ©"), "made by me ");
    assert.equal(stripEmoji("1️⃣ first"), "1 first");
    assert.equal(stripEmoji("café ☕"), "café ");
    assert.equal(stripEmoji(""), "");
  });

  it("folds a text with any kind of whitespace, and one with none", () => {
    assert.equal(fold("NoSpace"), "nospace");
    assert.equal(fold("a\u00A0b\u3000c\nd"), "abcd");
    assert.equal(fold(""), "");
  });
});
