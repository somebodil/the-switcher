import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dragHeight,
  dragSplit,
  dragWidth,
  MAX_SPLIT,
  MIN_HEIGHT,
  MIN_PANE,
  MIN_SPLIT,
  MIN_WIDTH,
  readLayout,
} from "./layout.ts";

describe("readLayout", () => {
  it("keeps the numbers of a saved layout", () => {
    assert.deepEqual(readLayout({ width: 900, height: 600, split: 0.3 }), {
      width: 900,
      height: 600,
      split: 0.3,
    });
  });

  it("leaves out what was not saved", () => {
    assert.deepEqual(readLayout({ width: 900 }), { width: 900 });
    assert.deepEqual(readLayout(null), {});
    assert.deepEqual(readLayout(undefined), {});
    assert.deepEqual(readLayout("900"), {});
  });

  it("leaves out what is not a number", () => {
    assert.deepEqual(
      readLayout({ width: "900", height: Number.NaN, split: Infinity }),
      {},
    );
  });

  it("brings a size that is too small or a split that is too far up to the limit", () => {
    assert.deepEqual(readLayout({ width: 10, height: 10, split: 0 }), {
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
      split: MIN_SPLIT,
    });
    assert.deepEqual(readLayout({ split: 1 }), { split: MAX_SPLIT });
  });
});

describe("dragWidth", () => {
  it("grows a centered dialog on both sides, so that the side follows the pointer", () => {
    assert.equal(dragWidth(700, 50, "right", true, 2000), 800);
    assert.equal(dragWidth(700, -50, "left", true, 2000), 800);
  });

  it("shrinks when the side is dragged inward", () => {
    assert.equal(dragWidth(700, -50, "right", true, 2000), 600);
    assert.equal(dragWidth(700, 50, "left", true, 2000), 600);
  });

  it("grows a dialog that is not centered on the dragged side only", () => {
    assert.equal(dragWidth(700, 50, "right", false, 2000), 750);
  });

  it("stays between the least width and the width of the window", () => {
    assert.equal(dragWidth(700, -1000, "right", true, 2000), MIN_WIDTH);
    assert.equal(dragWidth(700, 1000, "right", true, 1200), 1200);
  });
});

describe("dragHeight", () => {
  it("follows the pointer", () => {
    assert.equal(dragHeight(500, 80, 1000), 580);
    assert.equal(dragHeight(500, -80, 1000), 420);
  });

  it("stays between the least height and the height that fits the window", () => {
    assert.equal(dragHeight(500, -1000, 1000), MIN_HEIGHT);
    assert.equal(dragHeight(500, 1000, 800), 800);
  });
});

describe("dragSplit", () => {
  it("is the part of the width that is left of the pointer", () => {
    assert.equal(dragSplit(400, 100, 1000), 0.3);
  });

  it("leaves room for the results and for the preview", () => {
    assert.equal(dragSplit(0, 100, 1000), MIN_SPLIT);
    assert.equal(dragSplit(5000, 100, 1000), MAX_SPLIT);
  });

  it("leaves each of them a least width in a narrow dialog", () => {
    assert.equal(dragSplit(0, 100, 400), MIN_PANE / 400);
    assert.equal(dragSplit(5000, 100, 400), 1 - MIN_PANE / 400);
    assert.equal(dragSplit(300, 100, 400), 0.5);
  });

  it("halves a dialog that is too narrow for the least widths", () => {
    assert.equal(dragSplit(0, 100, 2 * MIN_PANE - 1), 0.5);
    assert.equal(dragSplit(400, 100, 0), 0.5);
  });
});
