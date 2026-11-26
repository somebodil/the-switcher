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

/** A part of a note: the lines from `first` on. */
export interface Excerpt {
  /** Number of the first line, starting at 0 */
  first: number;
  lines: string[];
}

/** How many characters a text has. A character outside the basic plane counts as one. */
function countCharacters(text: string): number {
  return Array.from(text).length;
}

/**
 * Makes the pattern that finds a query as it is typed, whatever its case.
 * It reads the text of a note as it is, so no lowercased copy has to be kept.
 *
 * A letter stands for itself in lower and in upper case, and every other
 * character for itself. That is faster than a pattern that ignores case: text
 * without letters that have a case, such as Korean, is found by a plain scan.
 */
function toPattern(query: string): RegExp {
  let source = "";
  for (const character of query) {
    const cases = new Set(
      [character, character.toLowerCase(), character.toUpperCase()].filter(
        // "ß" is "SS" in upper case. Such a letter only stands for itself.
        (variant) => countCharacters(variant) === 1,
      ),
    );
    source +=
      cases.size > 1
        ? `[${Array.from(cases).join("")}]`
        : character.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
  }
  return new RegExp(source, "gu");
}

/**
 * Returns a line of a text, without its line break.
 *
 * @param start where the line starts
 * @param lineBreak where the "\n" after the line is, or -1 for the last line
 */
export function lineOf(text: string, start: number, lineBreak: number): string {
  let end = lineBreak === -1 ? text.length : lineBreak;
  if (end > start && text[end - 1] === "\r") {
    end--;
  }
  return text.slice(start, end);
}

/** The pattern of the query that was asked for last. A list of results asks for the same one line after line. */
let lastPattern: { query: string; pattern: RegExp } | null = null;

/** Finds every place where a line has the query, whatever its case. */
export function findAll(line: string, query: string): Range[] {
  if (query === "") {
    return [];
  }
  if (lastPattern?.query !== query) {
    lastPattern = { query, pattern: toPattern(query) };
  }
  const { pattern } = lastPattern;
  pattern.lastIndex = 0;
  const ranges: Range[] = [];
  for (let found = pattern.exec(line); found !== null; found = pattern.exec(line)) {
    ranges.push({ start: found.index, end: found.index + found[0].length });
  }
  return ranges;
}

/**
 * A search for the lines that have a query. It is done in parts, so that
 * whoever runs it can do something else in between, and can drop it when the
 * query changes.
 *
 * The first matching lines are listed. Once the list is full, the rest of the
 * matching lines are only counted, which takes less.
 */
export class TextSearch {
  /** The first matching lines that were found so far, up to the limit */
  readonly matches: LineMatch[] = [];
  /** How many matching lines were found so far */
  total = 0;
  /** True once every note was looked at */
  done: boolean;
  /**
   * The notes that have the query, in the order they were looked at. A search
   * for a query that has this one in it needs to look at no other note.
   */
  readonly found: string[] = [];

  readonly query: string;
  private readonly texts: ReadonlyMap<string, string>;
  private readonly paths: readonly string[];
  private readonly limit: number;
  private readonly pattern: RegExp | null;
  /** How many of the paths were looked at */
  private next = 0;

  /**
   * @param texts the texts of the notes by their paths
   * @param paths the notes to look in. Their order is the order of the result.
   * @param limit how many matching lines to list
   */
  constructor(
    texts: ReadonlyMap<string, string>,
    query: string,
    paths: readonly string[],
    limit: number,
  ) {
    this.texts = texts;
    this.query = query;
    this.paths = paths;
    this.limit = limit;
    this.pattern = query.trim() === "" ? null : toPattern(query);
    this.done = this.pattern === null || paths.length === 0;
  }

  /**
   * Looks at note after note, until all are done or it is time for a pause.
   *
   * @param isTimeForPause asked after each note. Left out, the search runs to its end.
   */
  run(isTimeForPause?: () => boolean): void {
    const { pattern, paths } = this;
    while (pattern && !this.done) {
      const path = paths[this.next++];
      const text = path === undefined ? undefined : this.texts.get(path);
      if (path !== undefined && text !== undefined) {
        this.look(path, text, pattern);
      }
      this.done = this.next >= paths.length;
      if (isTimeForPause?.()) {
        return;
      }
    }
  }

  private look(path: string, text: string, pattern: RegExp): void {
    pattern.lastIndex = 0;
    let line = 0;
    // Where the line that is being looked at starts
    let lineStart = 0;
    while (this.matches.length < this.limit) {
      const found = pattern.exec(text);
      if (!found) {
        return;
      }
      if (this.found[this.found.length - 1] !== path) {
        this.found.push(path);
      }
      // Count the line breaks up to the match to know its line
      for (
        let lineBreak = text.indexOf("\n", lineStart);
        lineBreak !== -1 && lineBreak < found.index;
        lineBreak = text.indexOf("\n", lineStart)
      ) {
        line++;
        lineStart = lineBreak + 1;
      }
      const lineEnd = text.indexOf("\n", found.index);
      const lineText = lineOf(text, lineStart, lineEnd);
      this.total++;
      this.matches.push({
        path,
        line,
        text: lineText,
        ranges: findAll(lineText, this.query),
      });

      // Go on after this line, so that it is listed once
      if (lineEnd === -1) {
        return;
      }
      line++;
      lineStart = lineEnd + 1;
      pattern.lastIndex = lineStart;
    }

    // The list is full. A line that is only counted needs no number and no text.
    while (pattern.test(text)) {
      if (this.found[this.found.length - 1] !== path) {
        this.found.push(path);
      }
      this.total++;
      const lineEnd = text.indexOf("\n", pattern.lastIndex);
      if (lineEnd === -1) {
        return;
      }
      pattern.lastIndex = lineEnd + 1;
    }
  }
}

/** The texts of the notes, searchable line by line. */
export class TextIndex {
  private readonly texts = new Map<string, string>();

  /** Adds a note or replaces its text. */
  set(path: string, text: string): void {
    this.texts.set(path, text);
  }

  /** Returns the text of a note, or undefined if the note is unknown. */
  get(path: string): string | undefined {
    return this.texts.get(path);
  }

  /** Forgets every note whose path is not among the given ones. */
  retain(paths: Set<string>): void {
    for (const path of this.texts.keys()) {
      if (!paths.has(path)) {
        this.texts.delete(path);
      }
    }
  }

  /**
   * Starts a search for the lines that have the query as it is typed, whatever
   * its case. A line is listed once, however often it has the query.
   * Nothing is found before the search is run.
   *
   * @param before the search of before, or null. When the query was typed on from the query of a search that is done, only the notes that had the query of before can have the longer one, so only those are looked at. If the search of before does not let this be done, all of the given notes are looked at.
   * @param paths the notes to look in. Their order is the order of the result.
   * @param limit how many matching lines to list. All of them are counted.
   */
  searchOn(before: TextSearch | null, query: string, paths: readonly string[], limit: number): TextSearch {
    const within = before !== null && before.done && before.query.trim() !== "" && query.includes(before.query);
    return new TextSearch(this.texts, query, within ? before.found : paths, limit);
  }

  /** Returns the lines around a line of a note, or null if the note is unknown. */
  excerpt(path: string, line: number, radius: number): Excerpt | null {
    const text = this.texts.get(path);
    if (text === undefined) {
      return null;
    }
    const first = Math.max(0, line - radius);
    const excerpt: Excerpt = { first, lines: [] };
    let lineStart = 0;
    for (let number = 0; number <= line + radius; number++) {
      const lineBreak = text.indexOf("\n", lineStart);
      if (number >= first) {
        excerpt.lines.push(lineOf(text, lineStart, lineBreak));
      }
      if (lineBreak === -1) {
        break;
      }
      lineStart = lineBreak + 1;
    }
    return excerpt;
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
  const end = Math.min(start + length, match.text.length);
  const shift = prefix.length - start;
  return {
    text: prefix + match.text.slice(start, end),
    // A match that reaches into the indentation or past the cut keeps the part that is shown
    ranges: match.ranges
      .filter((range) => range.end > start && range.start < end)
      .map((range) => ({
        start: Math.max(range.start, start) + shift,
        end: Math.min(range.end, end) + shift,
      })),
  };
}
