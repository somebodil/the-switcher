import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CheckResult } from "../regex-guard.ts";
import type { TextQuery } from "./matcher.ts";
import { type Guard, type Results, SearchRunner } from "./search-runner.ts";
import { TextIndex, TextSearch } from "./text-index.ts";

interface PendingCheck {
  query: TextQuery;
  paths: readonly string[];
  /** The version of the text of each note when the check started */
  versions: Map<string, number | undefined>;
  onProgress: () => void;
  resolve: (result: CheckResult) => void;
}

/**
 * A guard that tries nothing by itself: the test tells it which notes are
 * tried, and how a check comes out. As the real one, it knows a note as tried
 * for the text the note had when its check started, and drops a check when
 * another starts.
 */
class FakeGuard implements Guard {
  /** The check that is going on */
  pending: PendingCheck | null = null;
  /** How many checks were asked for */
  checks = 0;
  stopped = 0;
  private readonly index: TextIndex;
  private key = "";
  private readonly checkedVersions = new Map<string, number | undefined>();

  constructor(index: TextIndex) {
    this.index = index;
  }

  checkedFor(query: TextQuery): (path: string) => boolean {
    const key = `${String(query.matchCase)}/${query.text}`;
    return (path) => this.key === key && this.checkedVersions.get(path) === this.index.versionOf(path);
  }

  check(query: TextQuery, paths: readonly string[], onProgress: () => void): Promise<CheckResult> {
    this.pending?.resolve({ kind: "dropped" });
    this.pending = null;
    this.checks++;
    const key = `${String(query.matchCase)}/${query.text}`;
    if (key !== this.key) {
      this.key = key;
      this.checkedVersions.clear();
    }
    const isChecked = this.checkedFor(query);
    const todo = paths.filter((path) => !isChecked(path));
    if (todo.length === 0) {
      return Promise.resolve({ kind: "fast" });
    }
    const versions = new Map(todo.map((path) => [path, this.index.versionOf(path)]));
    return new Promise((resolve) => {
      this.pending = { query, paths: todo, versions, onProgress, resolve };
    });
  }

  stop(): void {
    this.stopped++;
    this.pending?.resolve({ kind: "dropped" });
    this.pending = null;
  }

  /** Has the check try some of its notes, and tell of it. */
  progress(paths: readonly string[]): void {
    const pending = this.current();
    for (const path of paths) {
      this.checkedVersions.set(path, pending.versions.get(path));
    }
    pending.onProgress();
  }

  /** Ends the check. One that is done in time tried all of its notes. */
  finish(result: CheckResult): void {
    const pending = this.current();
    if (result.kind === "fast") {
      for (const [path, version] of pending.versions) {
        this.checkedVersions.set(path, version);
      }
    }
    this.pending = null;
    pending.resolve(result);
  }

  private current(): PendingCheck {
    assert.ok(this.pending, "a check is going on");
    return this.pending;
  }
}

interface Setup {
  index: TextIndex;
  guard: FakeGuard;
  runner: SearchRunner;
  /** What the list got each time it was filled again */
  listings: Results[];
  /** What the list was told when the search ended without new results to list */
  totals: [listed: number, total: number][];
  /** Types a query, as the dialog does, and returns what it lists. */
  type: (text: string, regex?: boolean) => Results;
}

/** Runs a test with a runner of the given notes, and stops the runner after it. */
async function withRunner(
  notes: Record<string, string>,
  test: (setup: Setup) => Promise<void> | void,
  index = new TextIndex(),
): Promise<void> {
  for (const [path, text] of Object.entries(notes)) {
    index.set(path, text);
  }
  const guard = new FakeGuard(index);
  const listings: Results[] = [];
  const totals: [number, number][] = [];
  let query: TextQuery = { text: "", regex: false, matchCase: false };
  // The list asks for the results again, as the dialog does
  const runner: SearchRunner = new SearchRunner(
    index,
    guard,
    {
      listAgain: () => listings.push(runner.resultsFor(query)),
      showTotal: (listed, total) => totals.push([listed, total]),
    },
    50,
  );
  runner.lookIn(Object.keys(notes));
  const type = (text: string, regex = false): Results => {
    query = { text, regex, matchCase: false };
    return runner.resultsFor(query);
  };
  try {
    await test({ index, guard, runner, listings, totals, type });
  } finally {
    runner.stop();
  }
}

function searchOf(results: Results | undefined): TextSearch {
  assert.ok(results && "search" in results, `a search, not ${JSON.stringify(results)}`);
  return results.search;
}

/** The matching lines of a search, as "path:line" */
function linesOf(search: TextSearch | null): string[] {
  assert.ok(search);
  return search.matches.map((match) => `${match.path}:${match.line}`);
}

/** Lets the promises that were resolved, and the messages that were posted, be handled. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await settle();
  }
}

describe("SearchRunner with a plain query", () => {
  it("searches every note, and fills the list again once it has all", () =>
    withRunner(
      Object.fromEntries(
        Array.from({ length: 3_000 }, (_, i) => [`note${i}.md`, `${"filler\n".repeat(200)}fox ${i}\n`]),
      ),
      async ({ type, listings, totals, runner }) => {
        const search = searchOf(type("fox"));
        assert.equal(runner.search, search);
        await until(() => search.done, "the search to end");
        await settle();
        assert.equal(search.total, 3_000);
        assert.equal(search.matches.length, 50);
        if (listings.length > 0) {
          assert.equal(searchOf(listings.at(-1)), search);
        } else {
          // It was done before the list was filled for the first time, or it
          // told the list of the total, which the list did not have
          assert.ok(search.matches.length === 50 && (totals.length > 0 || search.done));
        }
      },
    ));

  it("keeps the search while the query is the same, and starts another for a new one", () =>
    withRunner({ "a.md": "fox\nfoxes", "b.md": "dog" }, ({ type }) => {
      const search = searchOf(type("fox"));
      assert.equal(searchOf(type("fox")), search);
      assert.deepEqual(linesOf(search), ["a.md:0", "a.md:1"]);
      const narrower = searchOf(type("foxes"));
      assert.notEqual(narrower, search);
      // Typed on from a query whose search is done, it looks only at the notes that one found
      assert.deepEqual(narrower.paths, ["a.md"]);
      assert.deepEqual(linesOf(narrower), ["a.md:1"]);
    }));

  it("does not ask the guard to try a plain query", () =>
    withRunner({ "a.md": "(a+)+$" }, ({ type, guard }) => {
      assert.deepEqual(linesOf(searchOf(type("(a+)+$"))), ["a.md:0"]);
      assert.equal(guard.checks, 0);
    }));
});

describe("SearchRunner with a regular expression", () => {
  it("looks only at the notes that the guard tried it on, and goes on as the guard does", () =>
    withRunner({ "a.md": "x1", "b.md": "x2", "c.md": "y\nx3" }, async ({ type, guard, listings }) => {
      const search = searchOf(type("x\\d", true));
      assert.equal(guard.checks, 1);
      assert.deepEqual(linesOf(search), []);
      assert.equal(search.isWaiting, true);

      guard.progress(["a.md"]);
      assert.deepEqual(linesOf(search), ["a.md:0"]);
      assert.equal(search.done, false);

      guard.finish({ kind: "fast" });
      await until(() => search.done, "the search to end");
      assert.deepEqual(linesOf(search), ["a.md:0", "b.md:0", "c.md:1"]);
      assert.deepEqual(linesOf(searchOf(listings.at(-1))), ["a.md:0", "b.md:0", "c.md:1"]);
    }));

  it("tells why a regular expression is not valid, and asks the guard nothing", () =>
    withRunner({ "a.md": "x" }, ({ type, guard, runner }) => {
      assert.deepEqual(type("(", true), { problem: { kind: "invalid", reason: "Unterminated group" } });
      assert.equal(runner.search, null);
      assert.equal(guard.checks, 0);
    }));

  it("gives up on one that takes too long in a note, until the query or the notes change", () =>
    withRunner({ "a.md": "aaa", "folder/b.md": "aaaa!" }, async ({ type, guard, listings, runner }) => {
      type("(a+)+$", true);
      guard.finish({ kind: "slow", path: "folder/b.md" });
      await settle();
      const problem = { problem: { kind: "slow", path: "folder/b.md" } };
      assert.deepEqual(listings.at(-1), problem);
      assert.equal(runner.search, null);

      // Asked again, as when the list is filled again, it is not tried again
      assert.deepEqual(type("(a+)+$", true), problem);
      assert.equal(guard.checks, 1);

      // Without the note where it took too long, it is tried again
      runner.lookIn(["a.md"]);
      const search = searchOf(type("(a+)+$", true));
      assert.equal(guard.checks, 2);
      assert.deepEqual(guard.pending?.paths, ["a.md"]);
      guard.finish({ kind: "fast" });
      await until(() => search.done, "the search to end");
      assert.deepEqual(linesOf(search), ["a.md:0"]);

      // So is another query
      searchOf(type("a+", true));
      assert.equal(guard.checks, 3);
    }));

  it("gives up on one that fails in a note", () =>
    withRunner({ "a.md": "x", "b.md": "y" }, async ({ type, guard, listings }) => {
      type("y", true);
      guard.finish({ kind: "failed", path: "b.md", reason: "Maximum call stack size exceeded" });
      await settle();
      assert.deepEqual(listings.at(-1), {
        problem: { kind: "failed", path: "b.md", reason: "Maximum call stack size exceeded" },
      });
    }));

  it("gives up on one that fails in the search, as without a worker to try it first", async () => {
    // A search whose regular expression fails on the first note it looks at
    class FailingSearch extends TextSearch {
      override run(): void {
        throw new RangeError("Maximum call stack size exceeded");
      }
    }
    class FailingIndex extends TextIndex {
      override searchOn(_before: TextSearch | null, ...rest: [TextSearch["matcher"], readonly string[], number]): TextSearch {
        return new FailingSearch(new Map(), ...rest);
      }
    }
    await withRunner(
      { "a.md": "x" },
      ({ type, runner }) => {
        assert.deepEqual(type("x", true), {
          problem: { kind: "failed", path: null, reason: "Maximum call stack size exceeded" },
        });
        assert.equal(runner.search, null);
      },
      new FailingIndex(),
    );
  });

  it("does not give up on a query that the guard tried after it was changed", () =>
    withRunner({ "a.md": "aaaa!" }, async ({ runner, type, guard, listings }) => {
      type("(a+)+$", true);
      const { resolve } = guard.pending ?? assert.fail("a check");
      // A plain query asks the guard nothing, so the check of the first one goes on
      const search = searchOf(type("a", false));
      // and comes out late
      resolve({ kind: "slow", path: "a.md" });
      await settle();
      assert.ok(!listings.some((results) => "problem" in results));
      assert.equal(runner.search, search);
      assert.deepEqual(linesOf(search), ["a.md:0"]);
    }));

  it("has the guard try again a note that changed since it was tried, before it looks at it", () =>
    withRunner({ "a.md": "x1", "b.md": "x2", "c.md": "x3" }, async ({ index, type, guard }) => {
      const search = searchOf(type("x\\d", true));
      // As when a replacement is undone from its notice while the guard tries the notes
      index.set("b.md", "x2 again\nx4");
      guard.finish({ kind: "fast" });
      await until(() => guard.checks === 2, "another check");
      assert.deepEqual(guard.pending?.paths, ["b.md"]);
      assert.deepEqual(linesOf(search), ["a.md:0"]);
      assert.equal(search.done, false);

      guard.finish({ kind: "fast" });
      await until(() => search.done, "the search to end");
      assert.deepEqual(linesOf(search), ["a.md:0", "b.md:0", "b.md:1", "c.md:0"]);
    }));
});

describe("SearchRunner.searchToTheEnd", () => {
  it("waits for the guard, and returns the search once it looked at every note", () =>
    withRunner({ "a.md": "x1", "b.md": "x2" }, async ({ runner, type, guard }) => {
      const search = searchOf(type("x\\d", true));
      let ended: TextSearch | null | undefined;
      const ending = runner.searchToTheEnd(() => false).then((value) => (ended = value));
      guard.progress(["a.md"]);
      await settle();
      assert.equal(ended, undefined);
      guard.finish({ kind: "fast" });
      assert.equal(await ending, search);
      assert.deepEqual(linesOf(search), ["a.md:0", "b.md:0"]);
    }));

  it("returns null when cancelled, given up, or replaced by another search", async () => {
    await withRunner({ "a.md": "x1" }, async ({ runner, type, guard }) => {
      type("x\\d", true);
      const ended = runner.searchToTheEnd(() => true);
      guard.finish({ kind: "fast" });
      assert.equal(await ended, null);
    });
    await withRunner({ "a.md": "x1" }, async ({ runner, type, guard, listings }) => {
      type("x\\d", true);
      const ended = runner.searchToTheEnd(() => false);
      guard.finish({ kind: "slow", path: "a.md" });
      assert.equal(await ended, null);
      assert.deepEqual(listings.at(-1), { problem: { kind: "slow", path: "a.md" } });
    });
    await withRunner({ "a.md": "x1" }, async ({ runner, type }) => {
      type("x\\d", true);
      const ended = runner.searchToTheEnd(() => false);
      // The check of the first search is dropped
      type("x", true);
      assert.equal(await ended, null);
    });
  });

  it("starts anew when a note changed since the guard tried it, as what was found may not hold", () =>
    withRunner({ "a.md": "x1", "b.md": "y" }, async ({ index, runner, type, guard, listings }) => {
      const search = searchOf(type("x\\d", true));
      guard.finish({ kind: "fast" });
      await until(() => search.done, "the search to end");
      index.set("b.md", "x2");

      const ended = runner.searchToTheEnd(() => false);
      await until(() => guard.pending !== null, "another check");
      assert.deepEqual(guard.pending?.paths, ["b.md"]);
      guard.finish({ kind: "fast" });
      const again = await ended;
      assert.notEqual(again, search);
      assert.deepEqual(linesOf(again), ["a.md:0", "b.md:0"]);
      assert.equal(searchOf(listings.at(-1)), again);
    }));

  it("lists the search that it starts anew, also when that finds less than was listed", () =>
    withRunner({ "a.md": "x1\nx2", "b.md": "x3" }, async ({ index, runner, type, guard, listings }) => {
      const search = searchOf(type("x\\d", true));
      guard.finish({ kind: "fast" });
      await until(() => search.done, "the search to end");
      index.set("a.md", "y");

      const ended = runner.searchToTheEnd(() => false);
      await until(() => guard.pending !== null, "another check");
      guard.finish({ kind: "fast" });
      const again = await ended;
      assert.deepEqual(linesOf(again), ["b.md:0"]);
      assert.equal(searchOf(listings.at(-1)), again);
    }));
});

describe("SearchRunner.searchAgain", () => {
  it("looks only at the notes of the given search, which the list keeps until the new one is there", () =>
    withRunner({ "a.md": "fox", "b.md": "dog", "c.md": "fox fox" }, async ({ index, runner, type }) => {
      const search = searchOf(type("fox"));
      // As a replacement in the notes that the search found
      index.set("a.md", "cat");
      assert.equal(await runner.searchAgain(search, () => 50), true);
      assert.notEqual(runner.search, search);
      assert.deepEqual(runner.search?.paths, ["a.md", "c.md"]);
      assert.deepEqual(linesOf(runner.search), ["c.md:0"]);

      // What is put back can be in any note
      index.set("b.md", "fox");
      assert.equal(await runner.searchAgain(null, () => 50), true);
      assert.deepEqual(linesOf(runner.search), ["b.md:0", "c.md:0"]);
    }));

  it("finds as many matches at once as it is asked for, and the rest in parts", () =>
    withRunner(
      Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`note${i}.md`, `fox ${i}`])),
      async ({ runner, type }) => {
        const search = searchOf(type("fox"));
        await until(() => search.done, "the search to end");
        assert.equal(await runner.searchAgain(null, () => 7), true);
        assert.ok((runner.search?.matches.length ?? 0) >= 7);
        await until(() => runner.search?.done === true, "the new search to end");
        assert.equal(runner.search?.total, 200);
      },
    ));

  it("waits for the guard to try a regular expression on the changed notes", () =>
    withRunner({ "a.md": "x1", "b.md": "y" }, async ({ index, runner, type, guard }) => {
      const search = searchOf(type("x\\d", true));
      guard.finish({ kind: "fast" });
      await until(() => search.done, "the search to end");
      index.set("b.md", "x2");

      const again = runner.searchAgain(null, () => 50);
      await settle();
      assert.equal(runner.search, search);
      assert.deepEqual(guard.pending?.paths, ["b.md"]);
      guard.finish({ kind: "fast" });
      assert.equal(await again, true);
      assert.deepEqual(linesOf(runner.search), ["a.md:0", "b.md:0"]);
    }));

  it("gives way to a search that took its place while the guard tried the notes", () =>
    withRunner({ "a.md": "x1", "b.md": "y" }, async ({ index, runner, type, guard }) => {
      const search = searchOf(type("x\\d", true));
      guard.finish({ kind: "fast" });
      await until(() => search.done, "the search to end");
      index.set("b.md", "x2");

      const again = runner.searchAgain(null, () => 50);
      const other = searchOf(type("y", true));
      assert.equal(await again, false);
      assert.equal(runner.search, other);
    }));

  it("fills the list again, and finds nothing, when there is no search", () =>
    withRunner({ "a.md": "x" }, async ({ runner, type, listings }) => {
      type("(", true);
      assert.equal(await runner.searchAgain(null, () => 50), false);
      assert.deepEqual(listings.at(-1), { problem: { kind: "invalid", reason: "Unterminated group" } });
    }));
});

describe("SearchRunner.stop", () => {
  it("drops the search and the check of the guard, and fills the list no more", () =>
    withRunner({ "a.md": "x1" }, async ({ runner, type, guard, listings }) => {
      type("x\\d", true);
      runner.stop();
      assert.equal(runner.search, null);
      assert.equal(guard.stopped, 1);
      await settle();
      assert.deepEqual(listings, []);
    }));
});

describe("SearchRunner.count", () => {
  it("counts every match of the notes that the search found, as replacing all would replace them", () =>
    withRunner({ "a.md": "fox fox\nFox", "b.md": "dog", "c.md": "a fox" }, async ({ runner, type }) => {
      const search = searchOf(type("fox"));
      const counted = await runner.count(search);
      assert.deepEqual(counted && [...counted.texts.keys()], ["a.md", "c.md"]);
      assert.equal(counted?.count, 4);
      assert.equal(counted?.texts.get("a.md"), "fox fox\nFox");
    }));

  it("counts a part at a time, and stops when another search takes the place of this one", () =>
    withRunner(
      Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`note${i}.md`, "fox ".repeat(5_000)])),
      async ({ runner, type }) => {
        const search = searchOf(type("fox"));
        await until(() => search.done, "the search to end");
        const counting = runner.count(search);
        // Two million matches take longer than one part
        searchOf(type("dog"));
        assert.equal(await counting, null);
      },
    ));

  it("stops when the runner stops", () =>
    withRunner(
      Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`note${i}.md`, "fox ".repeat(5_000)])),
      async ({ runner, type }) => {
        const search = searchOf(type("fox"));
        await until(() => search.done, "the search to end");
        const counting = runner.count(search);
        runner.stop();
        assert.equal(await counting, null);
      },
    ));
});
