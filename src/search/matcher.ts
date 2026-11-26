import type { Range } from "./highlight.ts";

/** What to find in the text of the notes, and how. */
export interface TextQuery {
  /** The query as it is typed */
  text: string;
  /** True to take the query as a regular expression */
  regex: boolean;
  /** True to find only what has the case of the query */
  matchCase: boolean;
}

/** True if two queries find the same. */
export function sameQuery(a: TextQuery, b: TextQuery): boolean {
  return a.text === b.text && a.regex === b.regex && a.matchCase === b.matchCase;
}

/** The characters that have a meaning in a regular expression */
const SYNTAX = /[.*+?^${}()|[\]\\]/g;
/** What a backslash may stand before in a Unicode pattern to make a character itself */
const UNICODE_ESCAPES = "^$\\.*+?()[]{}|/";
/** What makes an escape with a backslash before it, as in `\d`, or nothing, after a backslash at the end */
const LETTER_OR_DIGIT = /^[A-Za-z0-9]?$/;
/** A repeat in braces, as in `{2}`, `{2,}` and `{2,5}` */
const REPEAT = /^\{\d+(?:,\d*)?\}/;
/** A kind of character, as `\w` and `\p{L}`, which cannot be an end of a range in a class */
const KIND = /^\\(?:[dDsSwW]|[pP]\{[^}]*\})/;
/** A code point in braces, as `\u{1F4DD}` */
const CODE_POINT = /^\\u\{[^}]*\}/;
/** How far ahead to look for one of these. A pattern can be long. */
const LOOK_AHEAD = 64;

/**
 * Rewrites what a pattern without Unicode takes as a character itself, in the
 * way that a Unicode pattern needs it: a backslash before a character that
 * means nothing, as in `\#` or `\-`, a brace that starts no repeat, as in
 * `a{`, and a `-` next to a kind of character in a class, as in `[\w-.]`.
 * Escapes with letters and digits are left as they are.
 */
function toUnicodeSource(source: string): string {
  let result = "";
  let inClass = false;
  /** True right after a kind of character in a class */
  let afterKind = false;
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    const wasAfterKind = afterKind;
    afterKind = false;
    const ahead = source.slice(i, i + LOOK_AHEAD);
    if (character === "\\") {
      const kind = KIND.exec(ahead)?.[0];
      const special = kind ?? CODE_POINT.exec(ahead)?.[0];
      if (special !== undefined) {
        result += special;
        i += special.length - 1;
        afterKind = inClass && kind !== undefined;
        continue;
      }
      const next = source[i + 1] ?? "";
      i++;
      const isKept = LETTER_OR_DIGIT.test(next) || UNICODE_ESCAPES.includes(next) || (inClass && next === "-");
      result += isKept ? `\\${next}` : next;
    } else if (inClass) {
      inClass = character !== "]";
      // A range cannot end in a kind of character, so such a `-` is one itself
      const isDash = character === "-" && (wasAfterKind || KIND.test(ahead.slice(1)));
      result += isDash ? "\\-" : character;
    } else if (character === "[") {
      inClass = true;
      result += character;
    } else if (character === "{") {
      const repeat = REPEAT.exec(ahead)?.[0];
      result += repeat ?? "\\{";
      i += repeat === undefined ? 0 : repeat.length - 1;
    } else if (character === "}" || character === "]") {
      result += `\\${character}`;
    } else {
      result += character;
    }
  }
  return result;
}

/**
 * Makes the pattern of a regular expression. It is Unicode aware, unless that
 * makes it not valid. A backslash before a character that means nothing, as
 * in `\#` or `\-`, is the character, and a `{` that starts no repeat is a `{`,
 * as without Unicode. A pattern that is not valid with Unicode for another
 * reason is taken as without Unicode.
 *
 * @throws {SyntaxError} if the expression is not valid any way: the error with
 *   Unicode, once the characters that mean nothing are taken as themselves
 */
function compile(source: string, matchCase: boolean): RegExp {
  const flags = matchCase ? "g" : "gi";
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    // Tried again as rewritten
  }
  try {
    return new RegExp(toUnicodeSource(source), `${flags}u`);
  } catch (unicodeError: unknown) {
    try {
      return new RegExp(source, flags);
    } catch {
      throw unicodeError instanceof Error ? unicodeError : new SyntaxError(String(unicodeError));
    }
  }
}

/** Where the character after the one at an index starts. A character outside the basic plane is two code units long. */
function nextCharacter(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  return index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

/** True if an index is in the middle of a character outside the basic plane, between its two halves. */
function splitsCharacter(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  const before = text.charCodeAt(index - 1);
  return code >= 0xdc00 && code <= 0xdfff && before >= 0xd800 && before <= 0xdbff;
}

/**
 * True if a match is of whole characters. Without Unicode, `.` can match half
 * of an emoji. And V8 can find a match of nothing in the middle of one, as
 * for `\B`. Such a match is not one: replacing it would leave half a
 * character in the note.
 */
function isWhole(line: string, found: RegExpExecArray): boolean {
  return !splitsCharacter(line, found.index) && !splitsCharacter(line, found.index + found[0].length);
}

/** A text with a half of a character outside the basic plane */
const SURROGATE = /[\uD800-\uDFFF]/;

/**
 * Finds a query in the lines of the notes.
 *
 * A plain query is found as it is typed. A regular expression is matched
 * against one line at a time, as in Vim: `^` and `$` are the start and the end
 * of a line, and a match does not go on into the next line.
 */
export class Matcher {
  readonly query: TextQuery;
  /** True when there is nothing to find: the query is empty, or blank and plain */
  readonly isEmpty: boolean;
  /**
   * Finds the matches of a plain query in a whole note, which is faster than
   * trying each line: a plain query has no line break in it, so what it finds
   * is in one line, and it is of whole characters.
   *
   * Null for a regular expression, which is tried on each line by itself. Over
   * a whole note it could find a match that goes on into the next line, and
   * it could take far longer: a pattern that tries many ways to match would
   * try them over all the lines instead of one.
   *
   * It is a pattern of its own, as a scan keeps its place in the note in it
   * while the line that it found is looked at with the pattern of the lines.
   */
  readonly scan: RegExp | null;
  /** Finds the matches in a line */
  private readonly pattern: RegExp;

  /** @throws {SyntaxError} if the query is a regular expression that is not valid */
  constructor(query: TextQuery) {
    this.query = query;
    const { text, regex, matchCase } = query;
    if (regex) {
      this.pattern = compile(text, matchCase);
      this.isEmpty = text === "";
      this.scan = null;
    } else {
      // A note is read as it is, so no lowercased copy of it has to be kept
      const source = text.replace(SYNTAX, "\\$&");
      const flags = matchCase ? "gu" : "giu";
      this.pattern = new RegExp(source, flags);
      this.isEmpty = text.trim() === "";
      this.scan = new RegExp(source, flags);
    }
  }

  /**
   * Finds the matches in a line, in order. After a match of nothing, the next
   * one is looked for from the next character on. A match that would split a
   * character outside the basic plane is left out.
   *
   * A plain query can be found in a whole text this way, as it has no line break in it.
   *
   * @param span how far after the start of the first match to look. A part of
   *   a long line that is shown around its first match needs no more. Left
   *   out, every match is found.
   */
  execAll(line: string, span = Infinity): RegExpExecArray[] {
    const all: RegExpExecArray[] = [];
    if (this.isEmpty) {
      return all;
    }
    const { pattern } = this;
    pattern.lastIndex = 0;
    let end = Infinity;
    for (let found = pattern.exec(line); found !== null && found.index < end; found = pattern.exec(line)) {
      if (!isWhole(line, found)) {
        pattern.lastIndex = nextCharacter(line, found.index);
        continue;
      }
      if (all.length === 0) {
        end = found.index + span;
      }
      all.push(found);
      if (found[0] === "") {
        pattern.lastIndex = nextCharacter(line, pattern.lastIndex);
      }
    }
    return all;
  }

  /**
   * Finds where the matches of a line are.
   *
   * @param span how far after the start of the first match to look, as for execAll
   */
  findAll(line: string, span = Infinity): Range[] {
    return this.execAll(line, span).map((found) => ({
      start: found.index,
      end: found.index + found[0].length,
    }));
  }

  /** Finds where the first match of a line is, as execAll finds it, or null if the line has none. */
  first(line: string): Range | null {
    if (this.isEmpty) {
      return null;
    }
    const { pattern } = this;
    pattern.lastIndex = 0;
    for (let found = pattern.exec(line); found !== null; found = pattern.exec(line)) {
      if (isWhole(line, found)) {
        return { start: found.index, end: found.index + found[0].length };
      }
      pattern.lastIndex = nextCharacter(line, found.index);
    }
    return null;
  }

  /** True if a line has a match, as execAll finds it. */
  test(line: string): boolean {
    if (this.isEmpty) {
      return false;
    }
    this.pattern.lastIndex = 0;
    // Most lines have no match, which a test tells without making one. Where
    // the match is matters only in a line with a character outside the basic plane.
    return this.pattern.test(line) && (!SURROGATE.test(line) || this.first(line) !== null);
  }

  /**
   * Goes through all the matches of a line, as execAll does, but keeps none
   * of them: the time it takes is the time the pattern needs.
   */
  tryAll(line: string): void {
    if (!this.isEmpty) {
      line.replace(this.pattern, "");
    }
  }
}
