/** A part of a text: from `start` up to, but not including, `end`. */
export interface Range {
  start: number;
  end: number;
}

/** A piece of a text that is either highlighted as a whole or not at all. */
export interface Segment {
  text: string;
  highlighted: boolean;
}

/**
 * Finds the first place where the text has the folded word, ignoring case and
 * whitespace, and returns that place as a range of the original text.
 */
export function locate(text: string, word: string): Range | null {
  if (word === "") {
    return null;
  }

  // Fold one character at a time to remember where each folded character came from
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const next = offset + char.length;
    if (!/\s/.test(char)) {
      const lower = char.toLowerCase();
      folded += lower;
      for (let i = 0; i < lower.length; i++) {
        starts.push(offset);
        ends.push(next);
      }
    }
    offset = next;
  }

  const at = folded.indexOf(word);
  if (at === -1) {
    return null;
  }
  return { start: starts[at], end: ends[at + word.length - 1] };
}

/** Puts the ranges in order and joins the ones that overlap or touch. */
export function mergeRanges(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Cuts the text into highlighted and plain segments.
 * Ranges may reach beyond the text. The part outside is ignored.
 */
export function toSegments(text: string, ranges: Range[]): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const range of mergeRanges(ranges)) {
    const start = Math.min(range.start, text.length);
    const end = Math.min(range.end, text.length);
    if (start >= end) {
      continue;
    }
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), highlighted: false });
    }
    segments.push({ text: text.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlighted: false });
  }
  return segments;
}

/**
 * Cuts segments in two where the text that they make up has the given offset.
 * A segment that the offset falls in is cut as well.
 */
export function splitSegments(
  segments: Segment[],
  offset: number,
): [Segment[], Segment[]] {
  const before: Segment[] = [];
  const after: Segment[] = [];
  let start = 0;
  for (const segment of segments) {
    const end = start + segment.text.length;
    if (end <= offset) {
      before.push(segment);
    } else if (start >= offset) {
      after.push(segment);
    } else {
      const cut = offset - start;
      before.push({ ...segment, text: segment.text.slice(0, cut) });
      after.push({ ...segment, text: segment.text.slice(cut) });
    }
    start = end;
  }
  return [before, after];
}
