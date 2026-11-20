import type { Range } from "./highlight.ts";

/** A line of a note that has the text that was searched for. */
export interface LineMatch {
  /** Path of the note */
  path: string;
  /** Number of the line, starting at 0 */
  line: number;
  /** The line, without the line break */
  text: string;
  /** Where the searched text is in the line */
  ranges: Range[];
}

export interface TextSearchResult {
  /** The first matching lines, up to the limit */
  matches: LineMatch[];
  /** How many lines match in all */
  total: number;
}

/** A part of a note: the lines from `first` on. */
export interface Excerpt {
  /** Number of the first line, starting at 0 */
  first: number;
  lines: string[];
}

interface Note {
  text: string;
  /** Lowercased text, to find a query whatever its case */
  lower: string;
  /** The lines of the text. Split only once a line is needed. */
  lines?: string[];
}

/**
 * Finds every place where a lowercased line has the lowercased query.
 * Lowercasing may change the length of unusual text. Then the places would not
 * fit the line, so none are returned.
 */
export function findAll(line: string, query: string): Range[] {
  const ranges: Range[] = [];
  const lowerLine = line.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerQuery === "" || lowerLine.length !== line.length) {
    return ranges;
  }
  for (
    let at = lowerLine.indexOf(lowerQuery);
    at !== -1;
    at = lowerLine.indexOf(lowerQuery, at + lowerQuery.length)
  ) {
    ranges.push({ start: at, end: at + lowerQuery.length });
  }
  return ranges;
}

/** The texts of the notes, searchable line by line. */
export class TextIndex {
  private readonly notes = new Map<string, Note>();

  /** Adds a note or replaces its text. */
  set(path: string, text: string): void {
    this.notes.set(path, { text, lower: text.toLowerCase() });
  }

  /** Forgets every note whose path is not among the given ones. */
  retain(paths: Set<string>): void {
    for (const path of this.notes.keys()) {
      if (!paths.has(path)) {
        this.notes.delete(path);
      }
    }
  }

  /**
   * Finds the lines that have the query as it is typed, whatever its case.
   * A line is listed once, however often it has the query.
   *
   * @param paths the notes to look in. Their order is the order of the result.
   * @param limit how many matching lines to return. All of them are counted.
   */
  search(query: string, paths: string[], limit: number): TextSearchResult {
    const result: TextSearchResult = { matches: [], total: 0 };
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.trim() === "") {
      return result;
    }

    for (const path of paths) {
      const note = this.notes.get(path);
      if (!note) {
        continue;
      }
      const { lower } = note;
      let line = 0;
      // Where the line that is being looked at starts
      let lineStart = 0;
      let at = lower.indexOf(lowerQuery);
      while (at !== -1) {
        // Count the line breaks up to the match to know its line
        for (
          let lineBreak = lower.indexOf("\n", lineStart);
          lineBreak !== -1 && lineBreak < at;
          lineBreak = lower.indexOf("\n", lineStart)
        ) {
          line++;
          lineStart = lineBreak + 1;
        }

        result.total++;
        if (result.matches.length < limit) {
          const text = this.linesOf(note)[line] ?? "";
          result.matches.push({ path, line, text, ranges: findAll(text, query) });
        }

        // Go on after this line, so that it is listed once
        const lineEnd = lower.indexOf("\n", at);
        if (lineEnd === -1) {
          break;
        }
        line++;
        lineStart = lineEnd + 1;
        at = lower.indexOf(lowerQuery, lineStart);
      }
    }
    return result;
  }

  /** Returns the lines around a line of a note, or null if the note is unknown. */
  excerpt(path: string, line: number, radius: number): Excerpt | null {
    const note = this.notes.get(path);
    if (!note) {
      return null;
    }
    const lines = this.linesOf(note);
    const first = Math.max(0, line - radius);
    return { first, lines: lines.slice(first, line + radius + 1) };
  }

  private linesOf(note: Note): string[] {
    note.lines ??= note.text.split("\n").map((line) => line.replace(/\r$/, ""));
    return note.lines;
  }
}

/** A line as a result shows it. */
export interface Snippet {
  text: string;
  ranges: Range[];
}

/** How much of a cut line is shown before the match */
const SNIPPET_LEAD = 40;
const ELLIPSIS = "\u2026";

/**
 * Shortens a line for a list of results: without the indentation, and cut so
 * that the match is in sight if it is far into a long line.
 *
 * @param length how many characters of the line to show
 */
export function toSnippet(match: LineMatch, length: number): Snippet {
  const indentation = match.text.length - match.text.trimStart().length;
  const firstMatch = match.ranges[0]?.start ?? indentation;
  const isCut = firstMatch - indentation > length - SNIPPET_LEAD;
  const start = isCut ? firstMatch - SNIPPET_LEAD : indentation;
  const prefix = isCut ? ELLIPSIS : "";
  const shift = prefix.length - start;
  return {
    text: prefix + match.text.slice(start, start + length),
    ranges: match.ranges
      .filter((range) => range.start >= start)
      .map((range) => ({ start: range.start + shift, end: range.end + shift })),
  };
}
