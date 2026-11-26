import type { Range } from "./highlight.ts";
import { forEachLine, lineBreakOf, lineOf } from "./lines.ts";
import type { Matcher } from "./matcher.ts";

/** A text with the matches replaced, and how many matches were replaced. */
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

/** A match in a line, and the text that takes its place. */
export interface Swap extends Range {
  text: string;
}

/** `\u` and `\l` change the next character. `\U` and `\L` change all that follows, until `\E`. */
type CaseChange = "u" | "l" | "U" | "L" | "E";

/** A part of a replacement that brings in a regular expression's match. */
type Token =
  | { kind: "text"; text: string }
  /** `\0`-`\9`, `&`, `$&`: a group by its number, or the whole match for 0 */
  | { kind: "group"; group: number }
  /** `$1`-`$99`: a group by its number, of one or two digits as the pattern has groups */
  | { kind: "dollar"; digits: string }
  /** `$<name>`: a named group */
  | { kind: "named"; name: string; typed: string }
  | { kind: "lineBreak" }
  | { kind: "case"; change: CaseChange };

function isDigit(character: string | undefined): character is string {
  return character !== undefined && character >= "0" && character <= "9";
}

/** Reads what a replacement for a regular expression is made of. */
function parse(typed: string): Token[] {
  const tokens: Token[] = [];
  const addText = (text: string): void => {
    const last = tokens[tokens.length - 1];
    if (last?.kind === "text") {
      last.text += text;
    } else {
      tokens.push({ kind: "text", text });
    }
  };
  for (let i = 0; i < typed.length; i++) {
    const character = typed[i];
    const next = typed[i + 1];
    if (character === "\\" && next !== undefined) {
      i++;
      if (next === "n" || next === "r") {
        tokens.push({ kind: "lineBreak" });
        if (next === "r" && typed[i + 1] === "\\" && typed[i + 2] === "n") {
          // `\r\n` is one line break, as `\n` and `\r` are
          i += 2;
        }
      } else if (next === "t") {
        addText("\t");
      } else if (isDigit(next)) {
        tokens.push({ kind: "group", group: Number(next) });
      } else if (next === "u" || next === "l" || next === "U" || next === "L" || next === "E") {
        tokens.push({ kind: "case", change: next });
      } else if (next === "e") {
        tokens.push({ kind: "case", change: "E" });
      } else {
        // `\\`, `\&`, `\$`: the character itself
        addText(next);
      }
    } else if (character === "&") {
      tokens.push({ kind: "group", group: 0 });
    } else if (character === "$" && next === "$") {
      addText("$");
      i++;
    } else if (character === "$" && next === "&") {
      tokens.push({ kind: "group", group: 0 });
      i++;
    } else if (character === "$" && isDigit(next)) {
      const digits = isDigit(typed[i + 2]) ? next + typed[i + 2] : next;
      tokens.push({ kind: "dollar", digits });
      i += digits.length;
    } else if (character === "$" && next === "<" && typed.indexOf(">", i + 2) !== -1) {
      const close = typed.indexOf(">", i + 2);
      tokens.push({ kind: "named", name: typed.slice(i + 2, close), typed: typed.slice(i, close + 1) });
      i = close;
    } else {
      addText(character);
    }
  }
  return tokens;
}

/**
 * The text of `$` with one or two digits. Two digits are a group if the
 * pattern has that many groups, and otherwise the first digit is the group
 * and the second one follows it. `$0` is the whole match. A group that the
 * pattern does not have leaves the text as it is typed.
 */
function dollarText(found: RegExpExecArray, digits: string): string {
  const groups = found.length - 1;
  const both = Number(digits);
  if (digits.length === 2 && both >= 1 && both <= groups) {
    return found[both] ?? "";
  }
  const first = Number(digits[0]);
  const rest = digits.slice(1);
  if (first <= groups) {
    return (found[first] ?? "") + rest;
  }
  return `$${digits}`;
}

/**
 * A replacement as it is typed. For a plain query it is taken as it is. For a
 * regular expression it can bring in what each match has, as in Vim and in
 * JavaScript:
 *
 * - `\0`, `&`, `$&`, `$0`: the whole match
 * - `\1`-`\9`, `$1`-`$99`: a group
 * - `$<name>`: a named group
 * - `\n`, `\r`, `\r\n`: a line break, the kind that the note has
 * - `\t`: a tab
 * - `\u`, `\l`: the next character in upper or lower case
 * - `\U`, `\L`: what follows in upper or lower case, until `\E` or `\e`
 * - `\` and another character, `$$`: that character as it is
 */
export class Replacement {
  readonly typed: string;
  readonly isTemplate: boolean;
  /** What the replacement is made of */
  private readonly tokens: Token[];
  /**
   * The text of every match when the replacement brings in nothing of the
   * match, as for a plain query, or null. A replacement of many matches
   * is then quicker.
   */
  private readonly constant: string | null;

  constructor(typed: string, isTemplate: boolean) {
    this.typed = typed;
    this.isTemplate = isTemplate;
    this.tokens = isTemplate ? parse(typed) : [{ kind: "text", text: typed }];
    const [only, ...rest] = this.tokens;
    this.constant = only === undefined ? "" : only.kind === "text" && rest.length === 0 ? only.text : null;
  }

  /**
   * The text that takes the place of a match.
   *
   * @param lineBreak the line break of the note
   */
  textFor(found: RegExpExecArray, lineBreak: string): string {
    if (this.constant !== null) {
      return this.constant;
    }
    let text = "";
    let following: "U" | "L" | null = null;
    let next: "u" | "l" | null = null;
    // What \U or \L changes. It is changed as a whole, as a word is: a Greek
    // sigma in lower case is final only at the end of the word.
    let run = "";
    const endRun = (): void => {
      if (run !== "") {
        text += following === "U" ? run.toUpperCase() : run.toLowerCase();
        run = "";
      }
    };
    const add = (part: string | undefined): void => {
      if (part === undefined || part === "") {
        return;
      }
      let rest = part;
      if (next !== null) {
        endRun();
        const first = String.fromCodePoint(rest.codePointAt(0) ?? 0);
        text += next === "u" ? first.toUpperCase() : first.toLowerCase();
        rest = rest.slice(first.length);
        next = null;
      }
      if (following === null) {
        text += rest;
      } else {
        run += rest;
      }
    };
    const groups = found.length - 1;
    for (const token of this.tokens) {
      switch (token.kind) {
        case "text":
          add(token.text);
          break;
        case "group":
          add(token.group <= groups ? found[token.group] : undefined);
          break;
        case "dollar":
          add(dollarText(found, token.digits));
          break;
        case "named":
          add(found.groups && token.name in found.groups ? found.groups[token.name] : token.typed);
          break;
        case "lineBreak":
          add(lineBreak);
          break;
        case "case":
          if (token.change === "u" || token.change === "l") {
            next = token.change;
          } else {
            endRun();
            following = token.change === "E" ? null : token.change;
          }
          break;
      }
    }
    endRun();
    return text;
  }
}

/**
 * Finds the matches in a line, with what takes the place of each.
 *
 * @param lineBreak the line break of the note
 * @param span how far after the start of the first match to look. Left out, every match is found.
 */
export function swapsOf(
  line: string,
  matcher: Matcher,
  replacement: Replacement,
  lineBreak: string,
  span = Infinity,
): Swap[] {
  return matcher.execAll(line, span).map((found) => ({
    start: found.index,
    end: found.index + found[0].length,
    text: replacement.textFor(found, lineBreak),
  }));
}

/** Puts the text of each swap in the place of its match. */
function applySwaps(line: string, swaps: readonly Swap[]): string {
  let result = "";
  let cursor = 0;
  for (const { start, end, text } of swaps) {
    result += line.slice(cursor, start) + text;
    cursor = end;
  }
  return result + line.slice(cursor);
}

/** Replaces every match in a text, as the search finds it. */
export function replaceAll(text: string, matcher: Matcher, replacement: Replacement): Replaced {
  const lineBreak = lineBreakOf(text);
  if (!matcher.query.regex) {
    // A plain query has no line break in it, so the text is taken as one line
    const swaps = swapsOf(text, matcher, replacement, lineBreak);
    return { text: applySwaps(text, swaps), count: swaps.length };
  }
  let result = "";
  let cursor = 0;
  let count = 0;
  forEachLine(text, (start, line) => {
    const swaps = swapsOf(line, matcher, replacement, lineBreak);
    if (swaps.length > 0) {
      result += text.slice(cursor, start) + applySwaps(line, swaps);
      cursor = start + line.length;
      count += swaps.length;
    }
  });
  return { text: result + text.slice(cursor), count };
}

/** How many matches a text has: as many as replaceAll replaces. */
export function countMatches(text: string, matcher: Matcher): number {
  if (!matcher.query.regex) {
    return matcher.execAll(text).length;
  }
  let count = 0;
  forEachLine(text, (_start, line) => {
    count += matcher.execAll(line).length;
  });
  return count;
}

/**
 * Replaces the matches in one line of a text.
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
  matcher: Matcher,
  replacement: Replacement,
): Replaced | null {
  let start = 0;
  for (let number = 0; number < line; number++) {
    const lineBreak = text.indexOf("\n", start);
    if (lineBreak === -1 || lineBreak === text.length - 1) {
      // As in Vim, a line break at the end of the text starts no line
      return null;
    }
    start = lineBreak + 1;
  }
  const lineText = lineOf(text, start, text.indexOf("\n", start));
  if (lineText !== expected) {
    return null;
  }
  const swaps = swapsOf(lineText, matcher, replacement, lineBreakOf(text));
  return {
    text: text.slice(0, start) + applySwaps(lineText, swaps) + text.slice(start + lineText.length),
    count: swaps.length,
  };
}

/**
 * Cuts a line into what stays and what is replaced, with the replacement
 * after each match.
 *
 * @param swaps the matches, in order and not overlapping, with their replacements
 */
export function toPieces(line: string, swaps: readonly Swap[]): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const { start, end, text } of swaps) {
    if (start > cursor) {
      pieces.push({ text: line.slice(cursor, start), kind: "same" });
    }
    if (end > start) {
      pieces.push({ text: line.slice(start, end), kind: "old" });
    }
    if (text !== "") {
      pieces.push({ text, kind: "new" });
    }
    cursor = end;
  }
  if (cursor < line.length) {
    pieces.push({ text: line.slice(cursor), kind: "same" });
  }
  return pieces;
}
