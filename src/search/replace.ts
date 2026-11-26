import type { Range } from "./highlight.ts";
import { findAll, lineOf } from "./text-index.ts";

/** A text with the query replaced, and how many places of the query were replaced. */
export interface Replaced {
  text: string;
  count: number;
}

/** A part of a line as it is shown before it is replaced. */
export interface Piece {
  text: string;
  /** What stays, what is replaced, and what takes its place */
  kind: "same" | "old" | "new";
}

/** Puts the replacement in the place of each range. The ranges are in order and do not overlap. */
function replaceRanges(text: string, ranges: Range[], replacement: string): string {
  let result = "";
  let cursor = 0;
  for (const { start, end } of ranges) {
    result += text.slice(cursor, start) + replacement;
    cursor = end;
  }
  return result + text.slice(cursor);
}

/**
 * Replaces every place of the query in a text, whatever its case, as the
 * search finds it. The replacement is taken as it is typed: `$&` in it is no
 * pattern.
 */
export function replaceAll(text: string, query: string, replacement: string): Replaced {
  const ranges = findAll(text, query);
  return { text: replaceRanges(text, ranges, replacement), count: ranges.length };
}

/**
 * Replaces the query in one line of a text.
 *
 * @param line the number of the line, starting at 0
 * @param expected the line as it was when it was found. When the line reads
 *   otherwise now, the text was changed since, and nothing is replaced.
 * @returns the text with the line replaced, or null if the line is not as expected
 */
export function replaceInLine(
  text: string,
  line: number,
  expected: string,
  query: string,
  replacement: string,
): Replaced | null {
  let start = 0;
  for (let number = 0; number < line; number++) {
    const lineBreak = text.indexOf("\n", start);
    if (lineBreak === -1) {
      return null;
    }
    start = lineBreak + 1;
  }
  const lineText = lineOf(text, start, text.indexOf("\n", start));
  if (lineText !== expected) {
    return null;
  }
  const replaced = replaceAll(lineText, query, replacement);
  return {
    text: text.slice(0, start) + replaced.text + text.slice(start + lineText.length),
    count: replaced.count,
  };
}

/**
 * Cuts a line into what stays and what is replaced, with the replacement
 * after each place it replaces.
 *
 * @param ranges where the query is in the line, in order and not overlapping
 */
export function toPieces(text: string, ranges: Range[], replacement: string): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start > cursor) {
      pieces.push({ text: text.slice(cursor, start), kind: "same" });
    }
    pieces.push({ text: text.slice(start, end), kind: "old" });
    if (replacement !== "") {
      pieces.push({ text: replacement, kind: "new" });
    }
    cursor = end;
  }
  if (cursor < text.length) {
    pieces.push({ text: text.slice(cursor), kind: "same" });
  }
  return pieces;
}
