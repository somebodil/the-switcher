import { fold } from "./fold.ts";

/** One word of a query, prepared for matching. */
export interface Term {
  /** The whole word, folded. It is looked up in the folder path. */
  text: string;
  /** The folded parts before the last "/". Each has to be in the folder path. */
  folders: string[];
  /**
   * The folded part after the last "/", or the whole word if it has no "/".
   * It is looked up in the name and the aliases. Empty for a word like "Notes/".
   */
  name: string;
  /** A word that starts with "-" removes the files it matches. */
  negated: boolean;
}

/**
 * Splits a query at spaces. Double quotes keep the spaces between them in the
 * word, and `\"` is a quote character.
 */
export function splitWords(query: string): string[] {
  const words: string[] = [];
  let word = "";
  let quoted = false;
  for (let i = 0; i < query.length; i++) {
    const char = query[i];
    if (char === "\\" && query[i + 1] === '"') {
      word += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === " " && !quoted) {
      if (word !== "") {
        words.push(word);
      }
      word = "";
    } else {
      word += char;
    }
  }
  if (word !== "") {
    words.push(word);
  }
  return words;
}

/** Turns a query into terms. */
export function parseQuery(query: string): Term[] {
  const terms: Term[] = [];
  for (const word of splitWords(query)) {
    const negated = word.startsWith("-");
    const body = negated ? word.slice(1) : word;
    const text = fold(body);
    if (text === "") {
      // Nothing to look for, for example a "-" that is still being typed
      continue;
    }

    const slash = body.lastIndexOf("/");
    terms.push({
      text,
      folders:
        slash === -1
          ? []
          : body
              .slice(0, slash)
              .split("/")
              .map(fold)
              .filter((part) => part !== ""),
      name: fold(body.slice(slash + 1)),
      negated,
    });
  }
  return terms;
}
