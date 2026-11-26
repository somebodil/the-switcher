import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forEachLine, lineBreakOf, lineOf } from "./lines.ts";

/** The lines of a text, with where each starts */
function linesOf(text: string): [number, string][] {
  const lines: [number, string][] = [];
  forEachLine(text, (start, line) => {
    lines.push([start, line]);
  });
  return lines;
}

describe("forEachLine", () => {
  it("gives each line without its line break, and where it starts", () => {
    assert.deepEqual(linesOf("a\nbc\r\nd"), [[0, "a"], [2, "bc"], [6, "d"]]);
  });

  it("takes a final line break as the end of the last line, as Vim does", () => {
    assert.deepEqual(linesOf("a\n"), [[0, "a"]]);
    assert.deepEqual(linesOf("a\r\n"), [[0, "a"]]);
    assert.deepEqual(linesOf("a\n\n"), [[0, "a"], [2, ""]]);
    assert.deepEqual(linesOf("\n"), [[0, ""]]);
    assert.deepEqual(linesOf("\n\n"), [[0, ""], [1, ""]]);
  });

  it("gives an empty text as one empty line", () => {
    assert.deepEqual(linesOf(""), [[0, ""]]);
  });

  it("keeps a carriage return that does not end a line", () => {
    assert.deepEqual(linesOf("a\rb\nc\r"), [[0, "a\rb"], [4, "c"]]);
  });

  it("stops at the line where the action returns false", () => {
    const seen: string[] = [];
    forEachLine("a\nb\nc", (_start, line) => {
      seen.push(line);
      return line !== "b";
    });
    assert.deepEqual(seen, ["a", "b"]);
  });
});

describe("lineOf", () => {
  it("leaves out the carriage return before the line break", () => {
    assert.equal(lineOf("ab\r\n", 0, 3), "ab");
    assert.equal(lineOf("\r\n", 0, 1), "");
    assert.equal(lineOf("x\r", 0, -1), "x");
  });
});

describe("lineBreakOf", () => {
  it("is the line break of the first line", () => {
    assert.equal(lineBreakOf("a\r\nb\nc"), "\r\n");
    assert.equal(lineBreakOf("a\nb\r\n"), "\n");
    assert.equal(lineBreakOf("no line break"), "\n");
    assert.equal(lineBreakOf("\r\n"), "\r\n");
  });
});
