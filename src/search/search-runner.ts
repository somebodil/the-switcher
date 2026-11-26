import type { RegexGuard } from "../regex-guard.ts";
import { Matcher, sameQuery, type TextQuery } from "./matcher.ts";
import { countMatches } from "./replace.ts";
import type { TextIndex, TextSearch } from "./text-index.ts";

/**
 * How many milliseconds a search goes on before it makes room for a keystroke
 * and for the dialog to be painted
 */
const SEARCH_PART_MS = 10;
/** After how many notes a search looks at the clock. Looking takes time as well. */
const NOTES_PER_LOOK_AT_CLOCK = 8;
/**
 * How many milliseconds pass at least before a list that is not full yet is
 * filled again with what was found since. Filling it takes longer than a part
 * of the search, so doing it after every part would hold the search up.
 */
const LIST_AGAIN_MS = 100;

/** Why a query has no results to show */
export type Problem =
  /** The query is a regular expression that is not valid */
  | { kind: "invalid"; reason: string }
  /** The regular expression takes too long in a note */
  | { kind: "slow"; path: string }
  /**
   * Matching the regular expression failed, as it can on a line that is too
   * long for the pattern: in a note, or in one that the search came to
   */
  | { kind: "failed"; path: string | null; reason: string };

/** The results for a query: its search, which may still be going on, or why there are none */
export type Results = { search: TextSearch } | { problem: Problem };

/** What the runner asks of the list of results */
export interface ResultList {
  /** Lists the results again. The list asks the runner for them. */
  listAgain(): void;
  /** Tells how many results are listed, and how many lines have the query in all. */
  showTotal(listed: number, total: number): void;
}

/** What tries a regular expression on the notes before a search does */
export type Guard = Pick<RegexGuard, "check" | "checkedFor" | "stop">;

/** The matches that replacing all would replace */
export interface Counted {
  /** The notes that have the query, with the texts that were counted */
  texts: ReadonlyMap<string, string>;
  /** How many matches they have in all */
  count: number;
}

/** What is wrong with a regular expression, as the error that the pattern gave tells it. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // "Invalid regular expression: /(/giu: Unterminated group"
  return message.slice(message.lastIndexOf(": ") + 1).trim();
}

/**
 * Runs the search of a dialog. A search of many notes takes longer than a
 * keystroke may wait, so it is done in parts, with room for whatever else
 * comes up in between, and the list is filled again as the search finds more.
 * A keystroke that changes the query drops it.
 *
 * A regular expression is tried by the guard first, and the search looks only
 * at the notes that the guard is done with. When the guard finds that the
 * regular expression takes too long or fails, the search is given up.
 */
export class SearchRunner {
  private readonly index: TextIndex;
  private readonly guard: Guard;
  private readonly list: ResultList;
  /** How many matching lines a search lists */
  private readonly limit: number;

  /** The notes to look in, in the order of the results */
  private paths: readonly string[] = [];
  private current: TextSearch | null = null;
  /**
   * Resolves once the guard tried the regular expression of the search on all
   * of its notes: true if the search can go on to its end
   */
  private checked: Promise<boolean> = Promise.resolve(true);
  /** The search whose regular expression the guard is trying on the notes */
  private checking: TextSearch | null = null;
  /** A query that was given up on, and why. It is not tried again until it changes. */
  private givenUp: { query: TextQuery; problem: Problem } | null = null;
  /** How many matches of the search the list has, and when it got them */
  private listed = 0;
  private listedAt = 0;
  /** Calls what is to be done next, after whatever else is waiting, as a keystroke */
  private readonly channel = new MessageChannel();
  private readonly nextTasks: (() => void)[] = [];
  private isNextPartCalled = false;

  /** @param limit how many matching lines a search lists */
  constructor(index: TextIndex, guard: Guard, list: ResultList, limit: number) {
    this.index = index;
    this.guard = guard;
    this.list = list;
    this.limit = limit;
    this.channel.port1.onmessage = () => this.nextTasks.shift()?.();
  }

  /** The search for the query, which may still be going on. Null for a query that is not valid or was given up. */
  get search(): TextSearch | null {
    return this.current;
  }

  /** Sets the notes to look in, in the order of the results. The next search starts anew. */
  lookIn(paths: readonly string[]): void {
    this.paths = paths;
    this.current = null;
    // The note where the regular expression took too long may be left out now
    this.givenUp = null;
  }

  /** Stops searching, as when the dialog closes. The worker of the guard lets go of its copy of the texts. */
  stop(): void {
    this.current = null;
    this.checking = null;
    this.channel.port1.close();
    // What waits finds that there is nothing to do any more
    for (const task of this.nextTasks.splice(0)) {
      task();
    }
    this.guard.stop();
  }

  /**
   * The results for a query. The first time a query is asked for, its search
   * starts, and it goes on by itself: the list is filled again when it finds
   * more, and asks for the results then.
   */
  resultsFor(query: TextQuery): Results {
    if (this.givenUp !== null && !sameQuery(this.givenUp.query, query)) {
      this.givenUp = null;
    }
    if (this.givenUp !== null) {
      return { problem: this.givenUp.problem };
    }
    let search = this.current;
    if (search === null || !sameQuery(search.query, query)) {
      let matcher: Matcher;
      try {
        matcher = new Matcher(query);
      } catch (error: unknown) {
        this.current = null;
        return { problem: { kind: "invalid", reason: reasonOf(error) } };
      }
      // A search is dropped when the notes or the paths to look in change, so what it found still holds
      search = this.index.searchOn(search, matcher, this.paths, this.limit);
      this.start(search);
      if (this.current !== search) {
        // The regular expression failed at once
        return this.resultsFor(query);
      }
    }
    this.listed = search.matches.length;
    this.listedAt = performance.now();
    return { search };
  }

  /**
   * Runs the search to its end. A regular expression is tried by the guard
   * first on every note as the note is now: a note can have changed since, as
   * when a replacement is undone from its notice.
   *
   * @param isCancelled asked whenever the guard is done, as it can take a while
   * @returns the search, or null if it was given up, cancelled, or another took its place
   */
  async searchToTheEnd(isCancelled: () => boolean): Promise<TextSearch | null> {
    let search = this.current;
    let hasRun = false;
    while (search !== null) {
      if (!(await this.checked) || this.current !== search || isCancelled()) {
        return null;
      }
      const mayLookAt = this.mayLookAt(search);
      if (search.done && mayLookAt !== undefined && !search.paths.every(mayLookAt)) {
        // What the search found may not hold any more
        this.start(this.index.searchOn(null, search.matcher, this.paths, this.limit));
        search = this.current;
      } else if (search.done) {
        if (hasRun) {
          this.list.listAgain();
        }
        return search;
      } else if (this.runSearch(search)) {
        hasRun = true;
        if (search.isWaiting) {
          // A note changed since the guard tried the regular expression on it
          this.startCheck(search);
        }
      } else {
        search = null;
      }
    }
    // Given up: the list says why
    this.list.listAgain();
    return null;
  }

  /**
   * Counts the matches in the notes that a search found, as replacing all
   * would replace them. Many matches take a while, so it counts a part at a
   * time, and the dialog takes keys meanwhile.
   *
   * @param search a search as searchToTheEnd just gave it: at its end, and for
   *   a regular expression, tried by the guard on every note as it is now.
   *   A note that changed after that could take too long here.
   * @returns the matches, or null if the search is not the current one any
   *   more, as when another took its place or the dialog closed
   */
  async count(search: TextSearch): Promise<Counted | null> {
    const texts = new Map(search.found.map((path) => [path, this.index.get(path) ?? ""]));
    let count = 0;
    let end = performance.now() + SEARCH_PART_MS;
    for (const text of texts.values()) {
      count += countMatches(text, search.matcher);
      if (performance.now() >= end) {
        await new Promise<void>((resolve) => this.later(resolve));
        if (this.current !== search) {
          return null;
        }
        end = performance.now() + SEARCH_PART_MS;
      }
    }
    return { texts, count };
  }

  /**
   * Searches anew for the same query, now that notes were changed. The search
   * of before stays while the guard tries a regular expression on the changed
   * notes, so that the list can stay as it is meanwhile.
   *
   * @param within a search whose notes are the only ones that can have the
   *   query, or null to look at all of them
   * @param enough how many matches the new search is to find at once, asked
   *   once the guard is done. It goes on in parts after that.
   * @returns true if the new search is there, for the caller to list its
   *   results. Otherwise it was given up, and the list says why, or another
   *   search took its place.
   */
  async searchAgain(within: TextSearch | null, enough: () => number): Promise<boolean> {
    const before = this.current;
    if (!before) {
      this.list.listAgain();
      return false;
    }
    const search = this.index.searchOn(within, before.matcher, this.paths, this.limit);
    if (!(await this.check(search)) || this.current !== before) {
      return false;
    }
    this.current = search;
    this.checked = Promise.resolve(true);
    const atLeast = enough();
    if (!this.runSearch(search, () => search.matches.length >= atLeast) || !this.searchPart(search)) {
      this.list.listAgain();
      return false;
    }
    return true;
  }

  /** Makes a search the current one, and starts it. */
  private start(search: TextSearch): void {
    this.current = search;
    // The list has none of its results yet
    this.listed = 0;
    this.startCheck(search);
    this.searchPart(search);
  }

  /** Goes on with the search, and lists what it found. */
  private continueSearch(): void {
    const search = this.current;
    if (!search || search.done) {
      return;
    }
    if (!this.searchPart(search)) {
      this.list.listAgain();
      return;
    }
    const hasMore = search.matches.length > this.listed;
    const isTimeToList =
      search.done ||
      search.matches.length >= this.limit ||
      performance.now() - this.listedAt >= LIST_AGAIN_MS;
    if ((hasMore && isTimeToList) || (search.done && this.listed === 0)) {
      this.list.listAgain();
    } else if (search.done) {
      // The list has all it gets. Now the lines are counted as well.
      this.list.showTotal(this.listed, search.total);
    }
  }

  /**
   * Does a part of a search: it stops after a moment, and the next part comes
   * after whatever came up in the meantime.
   *
   * @returns false if the search was given up. The caller lists again.
   */
  private searchPart(search: TextSearch): boolean {
    const end = performance.now() + SEARCH_PART_MS;
    let notes = 0;
    if (!this.runSearch(search, () => ++notes % NOTES_PER_LOOK_AT_CLOCK === 0 && performance.now() >= end)) {
      return false;
    }
    if (search.isWaiting && this.checking !== search && this.current === search) {
      // A note changed since the guard tried the regular expression on it,
      // as when a replacement is undone from its notice
      this.startCheck(search);
    }
    // A search that waits for the guard goes on when the guard is done with more notes
    if (!search.done && !search.isWaiting && !this.isNextPartCalled) {
      this.isNextPartCalled = true;
      this.later(() => {
        this.isNextPartCalled = false;
        this.continueSearch();
      });
    }
    return true;
  }

  /** Does a task after whatever else is waiting, as a keystroke and painting the dialog. */
  private later(task: () => void): void {
    this.nextTasks.push(task);
    this.channel.port2.postMessage(null);
  }

  /**
   * Runs a search, until it is time for a pause if that is told. A regular
   * expression can fail on a line that is too long for it, which the guard
   * finds out first unless it has no worker. Then the search is given up.
   *
   * @returns false if the search was given up. The caller lists again.
   */
  private runSearch(search: TextSearch, isTimeForPause?: () => boolean): boolean {
    try {
      search.run(isTimeForPause, this.mayLookAt(search));
      return true;
    } catch (error: unknown) {
      this.giveUp(search.query, { kind: "failed", path: null, reason: reasonOf(error) });
      return false;
    }
  }

  /** Stops searching for a query, for the list to say why instead of showing results. The caller lists again. */
  private giveUp(query: TextQuery, problem: Problem): void {
    this.givenUp = { query, problem };
    this.current = null;
    this.checking = null;
  }

  /** Which notes a search may look at: for a regular expression, the ones the guard tried it on. Undefined for all. */
  private mayLookAt(search: TextSearch): ((path: string) => boolean) | undefined {
    return search.query.regex ? this.guard.checkedFor(search.query) : undefined;
  }

  /** Has the guard try the regular expression of a search on its notes, and goes on with the search as it does. */
  private startCheck(search: TextSearch): void {
    const onProgress = (): void => {
      if (this.current === search) {
        this.continueSearch();
      }
    };
    this.checking = search;
    this.checked = this.check(search, onProgress).then((isChecked) => {
      if (this.checking === search) {
        this.checking = null;
      }
      if (isChecked) {
        onProgress();
      }
      return isChecked;
    });
  }

  /**
   * Has the guard try the regular expression of a search on its notes, where
   * it was not tried yet. When it takes too long or fails, the search of the
   * query is given up, and the list says why.
   *
   * @param onProgress called when the guard is done with more of the notes
   * @returns true once the guard is done with all of the notes, and false if
   *   the search is to be given up: the regular expression takes too long or
   *   fails, or another search took its place
   */
  private async check(search: TextSearch, onProgress = (): void => undefined): Promise<boolean> {
    const { query } = search;
    if (!query.regex || search.done) {
      return true;
    }
    const result = await this.guard.check(query, search.paths, onProgress);
    const isCurrent = this.current !== null && sameQuery(this.current.query, query);
    if (isCurrent && (result.kind === "slow" || result.kind === "failed")) {
      this.giveUp(query, result);
      this.list.listAgain();
    }
    return result.kind === "fast";
  }
}
