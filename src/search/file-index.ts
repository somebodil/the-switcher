import { fold, startsWith, stripEmoji } from "./fold.ts";
import { locate, type Range, type Segment, toSegments } from "./highlight.ts";
import type { Term } from "./query.ts";

/** What the search needs to know about a file. */
export interface FileInfo {
  /** Path from the root of the vault */
  path: string;
  /** File name without the extension */
  basename: string;
  extension: string;
  /** Path of the folder that holds the file ("/" for the root of the vault) */
  folder: string;
  /** Time of the last modification */
  mtime: number;
  aliases: string[];
}

/** A file with the folded texts that terms are compared with. */
export interface Entry {
  file: FileInfo;
  /** Name that terms look at. Only Markdown files go without the extension. */
  name: string;
  /** Folded aliases, in the order of `file.aliases` */
  aliases: string[];
  folder: string;
  /** Text that places the file in the alphabetical order */
  sortText: string;
  isMarkdown: boolean;
  /** Position among the recently opened files (the lower, the more recent) */
  recency: number;
}

/** A file that matches a query. */
export interface Hit {
  entry: Entry;
  /** How many terms the name or an alias starts with */
  prefixCount: number;
  /** Text that places the hit in the alphabetical order: the name or an alias */
  sortText: string;
}

/** How a hit is shown. */
export interface HitView {
  /** The basename, cut where the terms match */
  name: Segment[];
  /** The extension, or null for a Markdown file */
  extension: string | null;
  /** Name of the folder that holds the file */
  folderName: string;
  /** The aliases that the terms match, cut where they match */
  aliases: Segment[][];
}

const NOT_RECENT = Number.MAX_SAFE_INTEGER;

const collator = new Intl.Collator();

function toSortText(label: string): string {
  return stripEmoji(label).toLowerCase();
}

function searchableName(file: FileInfo): string {
  return file.extension === "md"
    ? file.basename
    : `${file.basename}.${file.extension}`;
}

/**
 * A term matches a file if the folder path has the whole term, or if the
 * folder path has every folder part of the term and the name or an alias has
 * its name part.
 */
function matches(entry: Entry, term: Term): boolean {
  if (entry.folder.includes(term.text)) {
    return true;
  }
  if (!term.folders.every((folder) => entry.folder.includes(folder))) {
    return false;
  }
  return (
    term.name === "" ||
    entry.name.includes(term.name) ||
    entry.aliases.some((alias) => alias.includes(term.name))
  );
}

function isPrefixOf(entry: Entry, term: Term): boolean {
  return (
    term.name !== "" &&
    (startsWith(entry.name, term.name) ||
      entry.aliases.some((alias) => startsWith(alias, term.name)))
  );
}

/**
 * A file is listed under its name. If the first term finds only an alias, the
 * file is listed under that alias instead. Among several such aliases, one
 * that starts with the term wins, then the shortest one.
 */
function sortTextFor(entry: Entry, term: Term): string {
  if (term.name === "" || entry.name.includes(term.name)) {
    return entry.sortText;
  }

  let best: string | null = null;
  let bestIsPrefix = false;
  entry.aliases.forEach((folded, i) => {
    if (!folded.includes(term.name)) {
      return;
    }
    const alias = entry.file.aliases[i];
    const isPrefix = startsWith(folded, term.name);
    if (
      best === null ||
      (isPrefix && !bestIsPrefix) ||
      (isPrefix === bestIsPrefix && alias.length < best.length)
    ) {
      best = alias;
      bestIsPrefix = isPrefix;
    }
  });
  return best === null ? entry.sortText : toSortText(best);
}

/**
 * Order of the results:
 * 1. the more terms the name or an alias starts with, the higher
 * 2. alphabetical
 * 3. Markdown files first
 * 4. recently opened files first
 * 5. recently modified files first
 */
function compare(a: Hit, b: Hit): number {
  return (
    b.prefixCount - a.prefixCount ||
    collator.compare(a.sortText, b.sortText) ||
    Number(b.entry.isMarkdown) - Number(a.entry.isMarkdown) ||
    a.entry.recency - b.entry.recency ||
    b.entry.file.mtime - a.entry.file.mtime
  );
}

/** The files of a vault, ready to be searched by name. */
export class FileIndex {
  /** Every file as a hit of a search without terms, in the order of that search */
  private readonly all: Hit[];
  /** The files that are not excluded */
  private visible: Hit[];

  /**
   * @param recentPaths paths of the recently opened files, the most recent first
   */
  constructor(files: FileInfo[], recentPaths: string[] = []) {
    const recency = new Map(recentPaths.map((path, i) => [path, i]));
    this.all = files
      .map((file): Hit => {
        const sortText = toSortText(file.basename);
        return {
          entry: {
            file,
            name: fold(searchableName(file)),
            aliases: file.aliases.map(fold),
            folder: fold(file.folder),
            sortText,
            isMarkdown: file.extension === "md",
            recency: recency.get(file.path) ?? NOT_RECENT,
          },
          prefixCount: 0,
          sortText,
        };
      })
      .sort(compare);
    this.visible = this.all;
  }

  /** Hides the files whose path matches one of the patterns. */
  exclude(patterns: RegExp[]): void {
    this.visible =
      patterns.length === 0
        ? this.all
        : this.all.filter(
            ({ entry }) =>
              !patterns.some((pattern) => pattern.test(entry.file.path)),
          );
  }

  /** Returns the files that match every term, the best match first. */
  search(terms: Term[]): Hit[] {
    if (terms.length === 0) {
      return this.visible;
    }

    const wanted = terms.filter((term) => !term.negated);
    const unwanted = terms.filter((term) => term.negated);
    const remaining = this.visible.filter(
      ({ entry }) =>
        !unwanted.some((term) => matches(entry, term)) &&
        wanted.every((term) => matches(entry, term)),
    );

    const first = wanted[0];
    if (!first) {
      // Only negated terms. The order of a search without terms still holds.
      return remaining;
    }

    // A term that is typed twice counts once
    const distinct = [
      ...new Map(wanted.map((term) => [term.text, term])).values(),
    ];
    return remaining
      .map(
        ({ entry }): Hit => ({
          entry,
          prefixCount: distinct.filter((term) => isPrefixOf(entry, term)).length,
          sortText: sortTextFor(entry, first),
        }),
      )
      .sort(compare);
  }
}

/** Works out how to show a hit: where the terms match its name and its aliases. */
export function describe(hit: Hit, terms: Term[]): HitView {
  const { file } = hit.entry;
  const words = terms
    .filter((term) => !term.negated && term.name !== "")
    .map((term) => term.name);
  const rangesIn = (text: string): Range[] =>
    words.flatMap((word) => locate(text, word) ?? []);

  return {
    // The ranges are found in the name with the extension. `toSegments` drops
    // what falls on the extension, which is shown apart from the name.
    name: toSegments(file.basename, rangesIn(searchableName(file))),
    extension: file.extension === "md" ? null : file.extension,
    folderName: file.folder.split("/").pop() ?? "",
    aliases: file.aliases
      .map((alias) => ({ alias, ranges: rangesIn(alias) }))
      .filter(({ ranges }) => ranges.length > 0)
      .map(({ alias, ranges }) => toSegments(alias, ranges)),
  };
}
