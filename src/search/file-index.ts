import { fold, stripEmoji } from "./fold.ts";
import {
  locate,
  type Range,
  type Segment,
  splitSegments,
  toSegments,
} from "./highlight.ts";
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
  /**
   * The name and the aliases without emoji, to see what they start with. Kept
   * so that a search does not take the emoji out of every name for every key.
   */
  plainName: string;
  plainAliases: string[];
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
  /** Path of the folder that holds the file */
  folder: FolderView;
  /** The aliases that the terms match, cut where they match */
  aliases: Segment[][];
}

/**
 * The path of a folder in two parts, as it is shown in front of the name of a
 * file. A row that is too narrow for the path cuts the first part, so that the
 * path is shortened in its middle: the outermost folders and the innermost one
 * are the ones that tell where a file is.
 */
export interface FolderView {
  /** The folders around the innermost one, cut where the terms match. Empty if there are none. */
  outer: Segment[];
  /**
   * The innermost folder, after a "/" if it is in another, cut where the terms
   * match. Empty in the root of the vault.
   */
  inner: Segment[];
}

const NOT_RECENT = Number.MAX_SAFE_INTEGER;
/** The aliases of a file that has none. Most have none, and need no list of their own. */
const NO_ALIASES: string[] = [];

const collator = new Intl.Collator();

/** What a name is sorted by: the name without emoji and without the space they leave at its ends. */
function toSortText(label: string): string {
  return stripEmoji(label).trim().toLowerCase();
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
  for (const folder of term.folders) {
    if (!entry.folder.includes(folder)) {
      return false;
    }
  }
  if (term.name === "" || entry.name.includes(term.name)) {
    return true;
  }
  for (const alias of entry.aliases) {
    if (alias.includes(term.name)) {
      return true;
    }
  }
  return false;
}

/** True if the name or an alias starts with the name of the term, emoji aside. */
function isPrefixOf(entry: Entry, term: Term): boolean {
  const { name } = term;
  if (name === "") {
    return false;
  }
  if (entry.name.startsWith(name) || entry.plainName.startsWith(name)) {
    return true;
  }
  for (let i = 0; i < entry.aliases.length; i++) {
    if (entry.aliases[i].startsWith(name) || entry.plainAliases[i].startsWith(name)) {
      return true;
    }
  }
  return false;
}

/**
 * True if every file that the terms find is among the files that the terms
 * of before found. Then the search looks at those only. It is so when a word
 * was typed on, or a word was added: what a longer word finds, the shorter
 * one found. A word that takes a "/" is read in another way, and a word
 * that removes files removes fewer when it gets longer, so those do not count.
 */
function narrows(before: Term[], terms: Term[]): boolean {
  if (before.length === 0 || before.length > terms.length) {
    return false;
  }
  return before.every((old, i) => {
    const term = terms[i];
    if (old.negated !== term.negated) {
      return false;
    }
    if (old.negated) {
      return old.text === term.text;
    }
    return (
      term.text.includes(old.text) &&
      term.name.includes(old.name) &&
      term.folders.length === old.folders.length &&
      term.folders.every((folder, at) => folder === old.folders[at])
    );
  });
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
    const isPrefix = folded.startsWith(term.name) || entry.plainAliases[i].startsWith(term.name);
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

/** A hit of a search without terms, with what lets the next index use it again. */
interface KeptHit extends Hit {
  /** Where the file stood among all, in the order of a search without terms */
  place: number;
  /** The index that used the hit last, by its number */
  round: number;
}

/**
 * What an index worked out for the files, kept for the index that is made the
 * next time a dialog opens. Nothing of it is trusted unseen: a file that has
 * another name, folder or alias than then is worked out anew.
 */
export class KeptIndex {
  /** By the path of the file */
  readonly hits = new Map<string, KeptHit>();
  /** How many indexes were made with this */
  round = 0;
}

/** True if what the search works out for a file is the same for the two. The time of the last change is not among it. */
function sameFile(a: FileInfo, b: FileInfo): boolean {
  if (a.basename !== b.basename || a.extension !== b.extension || a.folder !== b.folder || a.path !== b.path) {
    return false;
  }
  if (a.aliases === b.aliases) {
    return true;
  }
  if (a.aliases.length !== b.aliases.length) {
    return false;
  }
  for (let i = 0; i < a.aliases.length; i++) {
    if (a.aliases[i] !== b.aliases[i]) {
      return false;
    }
  }
  return true;
}

/** The files of a vault, ready to be searched by name. */
export class FileIndex {
  /** Every file as a hit of a search without terms, in the order of that search */
  private readonly all: Hit[];
  /** The files that are not excluded */
  private visible: Hit[];
  /** The terms of the search before this one, and the files that they found, in the order of a search without terms */
  private last: { terms: Term[]; found: Hit[] } | null = null;

  /**
   * @param recentPaths paths of the recently opened files, the most recent first
   * @param kept what the index before this one worked out, to be used again and brought up to date
   */
  constructor(files: FileInfo[], recentPaths: string[] = [], kept?: KeptIndex) {
    const recency = new Map(recentPaths.map((path, i) => [path, i]));
    // Many files share a folder, and its path is folded once
    const folders = new Map<string, string>();
    const make = (file: FileInfo): KeptHit => {
      const sortText = toSortText(file.basename);
      const name = fold(searchableName(file));
      const aliases = file.aliases.length === 0 ? NO_ALIASES : file.aliases.map(fold);
      let folder = folders.get(file.folder);
      if (folder === undefined) {
        folder = fold(file.folder);
        folders.set(file.folder, folder);
      }
      return {
        entry: {
          file,
          name,
          aliases,
          plainName: stripEmoji(name),
          plainAliases: aliases.length === 0 ? NO_ALIASES : aliases.map(stripEmoji),
          folder,
          sortText,
          isMarkdown: file.extension === "md",
          recency: NOT_RECENT,
        },
        prefixCount: 0,
        sortText,
        place: -1,
        round: 0,
      };
    };

    let all: KeptHit[];
    if (kept === undefined) {
      all = files.map(make);
    } else {
      // A file that is as the index before had it keeps what was worked out for it then, and goes
      // to the place it had. So putting the files in order takes a look at each and not a sort of
      // all: between two times that a dialog opens, few files change their place. A file that the
      // index before did not have goes to the end, and finds its place from there.
      const round = ++kept.round;
      const placed = new Array<KeptHit | undefined>(kept.hits.size);
      const added: KeptHit[] = [];
      for (const file of files) {
        let hit = kept.hits.get(file.path);
        if (hit === undefined || hit.round === round || !sameFile(hit.entry.file, file)) {
          hit = make(file);
          kept.hits.set(file.path, hit);
          added.push(hit);
        } else {
          hit.entry.file = file;
          if (hit.place >= 0 && hit.place < placed.length && placed[hit.place] === undefined) {
            placed[hit.place] = hit;
          } else {
            added.push(hit);
          }
        }
        hit.round = round;
      }
      all = [];
      for (const hit of placed) {
        if (hit !== undefined) {
          all.push(hit);
        }
      }
      for (const hit of added) {
        all.push(hit);
      }
      // What is kept of files that are gone is dropped once it is a good part of all
      if (kept.hits.size > files.length + 256) {
        for (const [path, hit] of kept.hits) {
          if (hit.round !== round) {
            kept.hits.delete(path);
          }
        }
      }
    }
    for (const hit of all) {
      hit.entry.recency = recency.get(hit.entry.file.path) ?? NOT_RECENT;
    }
    all.sort(compare);
    if (kept !== undefined) {
      for (let i = 0; i < all.length; i++) {
        all[i].place = i;
      }
    }
    this.all = all;
    this.visible = this.all;
  }

  /** Hides the files whose path matches one of the patterns. */
  exclude(patterns: RegExp[]): void {
    this.last = null;
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
    // While a word is typed on, what it finds is among what it found a key ago
    const pool = this.last !== null && narrows(this.last.terms, terms) ? this.last.found : this.visible;
    const remaining: Hit[] = [];
    look: for (const hit of pool) {
      const { entry } = hit;
      for (const term of unwanted) {
        if (matches(entry, term)) {
          continue look;
        }
      }
      for (const term of wanted) {
        if (!matches(entry, term)) {
          continue look;
        }
      }
      remaining.push(hit);
    }
    this.last = { terms, found: remaining };

    const first = wanted[0];
    if (!first) {
      // Only negated terms. The order of a search without terms still holds.
      return remaining;
    }

    // A term that is typed twice counts once
    const distinct = [
      ...new Map(wanted.map((term) => [term.text, term])).values(),
    ];
    const hits: Hit[] = new Array<Hit>(remaining.length);
    for (let i = 0; i < remaining.length; i++) {
      const hit = remaining[i];
      const { entry } = hit;
      let prefixCount = 0;
      for (const term of distinct) {
        if (isPrefixOf(entry, term)) {
          prefixCount++;
        }
      }
      const sortText = sortTextFor(entry, first);
      // Most files are listed under their name, and start with no term. Their hit is the one of a
      // search without terms, which is there already.
      hits[i] = prefixCount === 0 && sortText === entry.sortText ? hit : { entry, prefixCount, sortText };
    }
    return hits.sort(compare);
  }
}

/**
 * Works out how to show the folder of a file. What a term finds in the path of
 * the folder is the whole term or the folders of the term, as in `matches`.
 */
function toFolderView(folder: string, terms: Term[]): FolderView {
  // The root of the vault is "/", and a file in it has no folder to show
  const path = folder === "/" ? "" : folder;
  const ranges = terms
    .filter((term) => !term.negated)
    .flatMap((term) => {
      const whole = locate(path, term.text);
      return whole
        ? [whole]
        : term.folders.flatMap((part) => locate(path, part) ?? []);
    });
  const segments = toSegments(path, ranges);
  const [outer, inner] = splitSegments(segments, Math.max(path.lastIndexOf("/"), 0));
  return { outer, inner };
}

/** Works out how to show a hit: where the terms match its name, its aliases and its folder. */
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
    folder: toFolderView(file.folder, terms),
    aliases: file.aliases
      .map((alias) => ({ alias, ranges: rangesIn(alias) }))
      .filter(({ ranges }) => ranges.length > 0)
      .map(({ alias, ranges }) => toSegments(alias, ranges)),
  };
}
