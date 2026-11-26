import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { takesTooLong } from "./slow-note.ts";

/**
 * A note whose lines take as many milliseconds as they say, on a clock that
 * goes on only as the lines are tried. A line that is not a number takes no time.
 */
function noteOf(lines: string[]): { run: () => boolean; tried: string[]; looks: number[] } {
  let time = 0;
  const tried: string[] = [];
  const looks: number[] = [];
  const matcher = {
    tryAll(line: string): void {
      tried.push(line);
      time += Number(line) || 0;
    },
  };
  return {
    run: () =>
      takesTooLong(
        lines.join("\n"),
        matcher,
        1000,
        () => time,
        (now) => looks.push(now),
      ),
    tried,
    looks,
  };
}

const repeat = (line: string, count: number): string[] => Array<string>(count).fill(line);

describe("takesTooLong", () => {
  it("is false for lines that go fast, and looks at the clock less often as they do", () => {
    const note = noteOf(repeat("x", 1000));
    assert.equal(note.run(), false);
    assert.equal(note.tried.length, 1000);
    // After 1, 2, 4, 8, 16 and 32 lines, and then after every 64
    assert.equal(note.looks.length, 20);
  });

  it("looks after every line while the lines are slow", () => {
    const note = noteOf(repeat("2", 5));
    assert.equal(note.run(), false);
    assert.deepEqual(note.looks, [2, 4, 6, 8, 10]);
  });

  it("stops at the first look after the limit", () => {
    const note = noteOf(repeat("150", 10));
    assert.equal(note.run(), true);
    assert.equal(note.tried.length, 7);
  });

  it("counts the lines after the last look", () => {
    // The clock is looked at after the 63 lines, and next after 64 more
    const note = noteOf([...repeat("x", 63), ...repeat("400", 3)]);
    assert.equal(note.run(), true);
    assert.equal(note.tried.length, 66);
    assert.equal(note.looks.length, 6);
  });

  it("counts slow lines at the end after slow lines that were under the limit", () => {
    const note = noteOf([...repeat("90", 10), ...repeat("x", 63), ...repeat("300", 3)]);
    assert.equal(note.run(), true);
    assert.equal(note.tried.length, 76);
  });

  it("is false up to the limit", () => {
    assert.equal(noteOf(repeat("250", 4)).run(), false);
  });

  it("lets a match that fails throw", () => {
    const matcher = {
      tryAll(): void {
        throw new RangeError("Maximum call stack size exceeded");
      },
    };
    assert.throws(() => takesTooLong("a", matcher, 1000, () => 0), RangeError);
  });
});
