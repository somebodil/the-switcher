import type { Range } from "./highlight.ts";
import { forEachLine, lineOf } from "./lines.ts";
import { type Matcher, sameQuery, type TextQuery } from "./matcher.ts";

/** A line of a note that has the text that was searched for. */
export interface LineMatch {
  /** Path of the note */
  path: string;
  /** Number of the line, starting at 0 */
  line: number;
  /** The line, without the line break */
  text: string;
  /** Where the first match is in the line. A result is shown with the matches around it. */
  first: Range;
}

/** A part of a note: the lines from `first` on. */
export interface Excerpt {
  /** Number of the first line, starting at 0 */
  first: number;
  lines: string[];
}

/**
 * True if a search for a query needs to look only at the notes that a search
 * for the query of before found: what has the one has the other. That is so
 * for the same query, and for a plain query typed on from the one of before.
 */
function isNarrower(query: TextQuery, before: TextQuery): boolean {
  if (sameQuery(query, before)) {
    return true;
  }
  return (
    !query.regex &&
    !before.regex &&
    query.matchCase === before.matchCase &&
    before.text.trim() !== "" &&
    query.text.includes(before.text)
  );
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
   * for a narrower query needs to look at no other note.
   */
  readonly found: string[] = [];

  readonly matcher: Matcher;
  /** The notes to look in, in the order of the result */
  readonly paths: readonly string[];
  /** True while the search waits for a note to be ready, as told by run */
  isWaiting = false;
  private readonly texts: ReadonlyMap<string, string>;
  private readonly limit: number;
  /** How many of the paths were looked at */
  private next = 0;

  /**
   * @param texts the texts of the notes by their paths
   * @param paths the notes to look in. Their order is the order of the result.
   * @param limit how many matching lines to list
   */
  constructor(
    texts: ReadonlyMap<string, string>,
    matcher: Matcher,
    paths: readonly string[],
    limit: number,
  ) {
    this.texts = texts;
    this.matcher = matcher;
    this.paths = paths;
    this.limit = limit;
    this.done = matcher.isEmpty || paths.length === 0;
  }

  get query(): TextQuery {
    return this.matcher.query;
  }

  /**
   * Looks at note after note, until all are done, it is time for a pause, or
   * the next note is not ready to be looked at.
   *
   * @param isTimeForPause asked after each note. Left out, the search runs to its end.
   * @param isReady asked before each note. A note that is not ready makes the
   *   search wait there, until it is run again.
   */
  run(isTimeForPause?: () => boolean, isReady?: (path: string) => boolean): void {
    const { paths } = this;
    while (!this.done) {
      const path = paths[this.next];
      this.isWaiting = isReady !== undefined && !isReady(path);
      if (this.isWaiting) {
        return;
      }
      this.next++;
      const text = this.texts.get(path);
      if (text !== undefined) {
        this.look(path, text);
      }
      this.done = this.next >= paths.length;
      if (isTimeForPause?.()) {
        return;
      }
    }
  }

  private look(path: string, text: string): void {
    const { scan } = this.matcher;
    if (scan === null) {
      this.lookAtEachLine(path, text);
      return;
    }
    scan.lastIndex = 0;
    let line = 0;
    // Where the line that is being looked at starts
    let lineStart = 0;
    while (this.matches.length < this.limit) {
      const found = scan.exec(text);
      if (!found) {
        return;
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
      this.list(path, line, lineOf(text, lineStart, lineEnd));

      // Go on after this line, so that it is listed once
      if (lineEnd === -1) {
        return;
      }
      line++;
      lineStart = lineEnd + 1;
      scan.lastIndex = lineStart;
    }

    // The list is full. A line that is only counted needs no number and no text.
    while (scan.test(text)) {
      this.count(path);
      const lineEnd = text.indexOf("\n", scan.lastIndex);
      if (lineEnd === -1) {
        return;
      }
      scan.lastIndex = lineEnd + 1;
    }
  }

  /** Tries each line of a note by itself. */
  private lookAtEachLine(path: string, text: string): void {
    let line = 0;
    forEachLine(text, (_start, lineText) => {
      if (this.matches.length < this.limit) {
        this.list(path, line, lineText);
      } else if (this.matcher.test(lineText)) {
        this.count(path);
      }
      line++;
    });
  }

  /** Lists a line if it has a match. What the scan of a plain query finds always has one. */
  private list(path: string, line: number, text: string): void {
    const first = this.matcher.first(text);
    if (first === null) {
      return;
    }
    this.count(path);
    this.matches.push({ path, line, text, first });
  }

  private count(path: string): void {
    if (this.found[this.found.length - 1] !== path) {
      this.found.push(path);
    }
    this.total++;
  }
}

/** The texts of the notes, searchable line by line. */
export class TextIndex {
  private readonly texts = new Map<string, string>();
  /** A number for each text a note was given, which is new each time */
  private readonly versions = new Map<string, number>();
  private lastVersion = 0;

  /** Adds a note or replaces its text. */
  set(path: string, text: string): void {
    this.texts.set(path, text);
    this.versions.set(path, ++this.lastVersion);
  }

  /** Tells which text a note has: the number changes whenever the text is set. Undefined if the note is unknown. */
  versionOf(path: string): number | undefined {
    return this.versions.get(path);
  }

  /** Returns the text of a note, or undefined if the note is unknown. */
  get(path: string): string | undefined {
    return this.texts.get(path);
  }

  /** Forgets a note. */
  delete(path: string): void {
    this.texts.delete(path);
    this.versions.delete(path);
  }

  /** Forgets every note whose path is not among the given ones. */
  retain(paths: Set<string>): void {
    for (const path of this.texts.keys()) {
      if (!paths.has(path)) {
        this.delete(path);
      }
    }
  }

  /**
   * Starts a search for the lines that have a match. A line is listed once,
   * however many matches it has. Nothing is found before the search is run.
   *
   * @param before the search of before, or null. When it is done and its query
   *   was narrower, only the notes it found can have the new query, so only
   *   those are looked at. Otherwise all of the given notes are looked at.
   * @param paths the notes to look in. Their order is the order of the result.
   * @param limit how many matching lines to list. All of them are counted.
   */
  searchOn(before: TextSearch | null, matcher: Matcher, paths: readonly string[], limit: number): TextSearch {
    const within = before !== null && before.done && isNarrower(matcher.query, before.query);
    return new TextSearch(this.texts, matcher, within ? before.found : paths, limit);
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

/** A line as a result shows it, with the parts of it that stand out. */
export interface Snippet<R extends Range = Range> {
  text: string;
  ranges: R[];
}

/** How much of a cut line is shown before the match */
const SNIPPET_LEAD = 40;
const ELLIPSIS = "…";

/** True for the second half of a character outside the basic plane */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Shortens a line to show it: cut so that the first match is in sight if it is
 * far into a long line, and without the indentation unless told to keep it.
 *
 * A match that a cut goes through is shown whole, as is one that starts in the
 * indentation. Only a match that is longer than the line that is shown is cut.
 * Where the line is cut, an ellipsis stands for what is left out.
 *
 * @param ranges the matches, in order. What else they have stays with them.
 * @param length how many characters of the line to show
 */
export function toSnippet<R extends Range>(
  line: string,
  ranges: readonly R[],
  length: number,
  keepIndentation = false,
): Snippet<R> {
  const indentation = keepIndentation ? 0 : line.length - line.trimStart().length;
  const firstMatch = ranges[0]?.start ?? indentation;
  // A short line that is shown gets a lead that leaves room for the match
  const lead = Math.min(SNIPPET_LEAD, Math.floor(length / 2));
  const isCut = firstMatch - indentation > length - lead;
  let start = isCut ? firstMatch - lead : indentation;
  const crossing = ranges.find((range) => range.start < start && range.end > start);
  if (crossing) {
    start = crossing.start;
  }
  if (start > 0 && isLowSurrogate(line.charCodeAt(start))) {
    // Not half a character
    start--;
  }

  let end = Math.min(start + length, line.length);
  const cut = ranges.find((range) => range.start < end && range.end > end);
  if (cut && cut.end - start <= 2 * length) {
    end = cut.end;
  }
  if (end < line.length && isLowSurrogate(line.charCodeAt(end))) {
    end++;
  }

  // The indentation that is left out has no ellipsis
  const prefix = start > indentation ? ELLIPSIS : "";
  const suffix = end < line.length ? ELLIPSIS : "";
  const shift = prefix.length - start;
  return {
    text: prefix + line.slice(start, end) + suffix,
    ranges: ranges
      .filter((range) =>
        range.start === range.end
          ? range.start >= start && range.start <= end
          : range.end > start && range.start < end,
      )
      .map((range) => ({
        ...range,
        start: Math.max(range.start, start) + shift,
        end: Math.min(range.end, end) + shift,
      })),
  };
}
