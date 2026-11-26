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

/** How many characters a text has. A character outside the basic plane counts as one. */
function countCharacters(text: string): number {
  return Array.from(text).length;
}

/**
 * Makes the source of a pattern that finds a query as it is typed, whatever
 * its case. It reads the text of a note as it is, so no lowercased copy has
 * to be kept.
 *
 * A letter stands for itself in lower and in upper case, and every other
 * character for itself. That is faster than a pattern that ignores case: text
 * without letters that have a case, such as Korean, is found by a plain scan.
 */
function anyCaseSource(query: string): string {
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
        : character.replace(SYNTAX, "\\$&");
  }
  return source;
}

/**
 * Makes the pattern of a regular expression. It is Unicode aware, unless that
 * makes it not valid. Then it is taken as without Unicode, where a backslash
 * before a character that means nothing, as in `\#` or `\-`, is the character,
 * and a `{` that starts no repeat is a `{`.
 *
 * @throws {SyntaxError} the error with Unicode, if the expression is not valid either way
 */
function compile(source: string, matchCase: boolean): RegExp {
  const flags = matchCase ? "g" : "gi";
  try {
    return new RegExp(source, `${flags}u`);
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
   * is in one line.
   *
   * Null for a regular expression, which is tried on each line by itself. Over
   * a whole note it could find a match that goes on into the next line, and
   * it could take far longer: a pattern that tries many ways to match would
   * try them over all the lines instead of one.
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
      const source = matchCase ? text.replace(SYNTAX, "\\$&") : anyCaseSource(text);
      this.pattern = new RegExp(source, "gu");
      this.isEmpty = text.trim() === "";
      this.scan = new RegExp(source, "gu");
    }
  }

  /**
   * Finds every match in a line, in order. After a match of nothing, the next
   * one is looked for from the next character on.
   *
   * A plain query can be found in a whole text this way, as it has no line break in it.
   */
  execAll(line: string): RegExpExecArray[] {
    const all: RegExpExecArray[] = [];
    if (this.isEmpty) {
      return all;
    }
    const { pattern } = this;
    pattern.lastIndex = 0;
    for (let found = pattern.exec(line); found !== null; found = pattern.exec(line)) {
      all.push(found);
      if (found[0] === "") {
        pattern.lastIndex = nextCharacter(line, pattern.lastIndex);
      }
    }
    return all;
  }

  /** Finds where each match of a line is. */
  findAll(line: string): Range[] {
    return this.execAll(line).map((found) => ({
      start: found.index,
      end: found.index + found[0].length,
    }));
  }

  /** True if a line has a match. */
  test(line: string): boolean {
    if (this.isEmpty) {
      return false;
    }
    this.pattern.lastIndex = 0;
    return this.pattern.test(line);
  }
}
