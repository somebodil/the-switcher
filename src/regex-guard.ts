import workerCode from "virtual:regex-worker";
import type { CheckMessage, TextsMessage, WorkerMessage } from "./regex-worker.ts";
import type { TextQuery } from "./search/matcher.ts";
import type { TextIndex } from "./search/text-index.ts";

/** How a check came out */
export type CheckResult =
  /** Every line was tried in time, or there is no worker to try them */
  | { kind: "fast" }
  /** A newer check took the place of this one */
  | { kind: "dropped" }
  /** The lines of a note took too long */
  | { kind: "slow"; path: string }
  /** Matching a line of a note failed, as it can for a line that is too long for the pattern */
  | { kind: "failed"; path: string; reason: string };

/**
 * How long the worker may be silent while it tries a regular expression. It
 * tells how far it got several times a second, unless a line holds it up. A
 * line that takes this long makes its note take too long as well.
 */
const SILENCE_MS = 1_000;
/** How often the window looks whether the worker is silent */
const TICK_MS = 100;
/**
 * How many characters of the texts it is sent the worker reads in a
 * millisecond, at the least. It is silent until it read them.
 */
const READ_CHARS_PER_MS = 10_000;

interface Pending {
  id: number;
  query: TextQuery;
  /** The notes to check, in their order, and the version of the text of each */
  paths: string[];
  versions: number[];
  /** How many of the notes are done */
  checked: number;
  /** Where the notes that were sent to the worker start. A check that is sent again starts at the first note that is not done. */
  sentFrom: number;
  resolve: (result: CheckResult) => void;
  onProgress: () => void;
  /** True once the check was sent to a new worker, as an older check held up the one before */
  isRestarted: boolean;
  /** True once the check was sent again with the worker telling of every note, to find the one that holds it up */
  isProbing: boolean;
}

function keyOf(query: TextQuery): string {
  return `${String(query.matchCase)}/${query.text}`;
}

/**
 * Keeps a regular expression that takes too long from holding up Obsidian.
 *
 * A pattern can try a vast number of ways to match a line, as (\w+\s?)+$ does
 * on a sentence, and a match cannot be stopped once it started. So a worker
 * tries the pattern on every line first, away from the window, and is stopped
 * when it is held up. The dialog looks only at the notes that the worker is
 * done with.
 */
export class RegexGuard {
  private readonly index: TextIndex;
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  /** True once the worker failed. Regular expressions are not checked from then on. */
  private isUnavailable = false;
  /** The version of the text of each note that the worker has */
  private readonly sent = new Map<string, number>();
  /** The regular expression whose notes are checked, and the version of the text of each note that was checked */
  private key = "";
  private readonly checked = new Map<string, number>();
  private lastId = 0;
  private pending: Pending | null = null;
  /** When the worker was last heard from, and of which check */
  private heardAt = 0;
  private heardId = 0;
  /** How many characters of texts were sent that the worker may not have read yet */
  private unread = 0;
  private timer: number | null = null;
  private tickAt = 0;

  constructor(index: TextIndex) {
    this.index = index;
  }

  /**
   * Tells whether the dialog may look at a note for a query: the worker
   * tried the query on the text of the note, or the note has no text.
   */
  checkedFor(query: TextQuery): (path: string) => boolean {
    const key = keyOf(query);
    return (path) => {
      const version = this.index.versionOf(path);
      return (
        this.isUnavailable ||
        version === undefined ||
        (this.key === key && this.checked.get(path) === version)
      );
    };
  }

  /**
   * Has the worker try a regular expression on the notes where it was not
   * tried yet. A check that is going on is dropped.
   *
   * @param onProgress called whenever the worker is done with more of the notes
   */
  check(query: TextQuery, paths: readonly string[], onProgress: () => void): Promise<CheckResult> {
    const wasBusy = this.pending !== null;
    this.drop();
    const key = keyOf(query);
    if (key !== this.key) {
      this.key = key;
      this.checked.clear();
    }
    const isChecked = this.checkedFor(query);
    const todo = paths.filter((path) => !isChecked(path));
    if (todo.length === 0) {
      if (wasBusy) {
        // Nothing would see it if the check of before held the worker up
        this.stopWorker();
      }
      return Promise.resolve({ kind: "fast" });
    }
    return new Promise((resolve) => {
      const pending: Pending = {
        id: ++this.lastId,
        query,
        paths: todo,
        versions: todo.map((path) => this.index.versionOf(path) ?? 0),
        checked: 0,
        sentFrom: 0,
        resolve,
        onProgress,
        isRestarted: false,
        isProbing: false,
      };
      this.pending = pending;
      if (!wasBusy) {
        this.heardAt = performance.now();
      }
      this.send(pending);
    });
  }

  /** Stops the worker, as when the dialog closes. Which notes are checked is kept. */
  stop(): void {
    this.drop();
    this.stopWorker();
  }

  /** Stops the worker for good, as when the plugin is turned off. */
  dispose(): void {
    this.stop();
    if (this.workerUrl !== null) {
      URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
    }
  }

  /** Sends a check to the worker, with the texts that it does not have yet. */
  private send(pending: Pending): void {
    const worker = this.startWorker();
    if (!worker) {
      this.finish({ kind: "fast" });
      return;
    }
    pending.sentFrom = pending.checked;
    const paths = pending.paths.slice(pending.sentFrom);
    const texts: [string, string][] = [];
    let length = 0;
    paths.forEach((path, i) => {
      const text = this.index.get(path);
      const version = pending.versions[pending.sentFrom + i];
      if (text !== undefined && this.sent.get(path) !== version) {
        texts.push([path, text]);
        this.sent.set(path, version);
        length += text.length;
      }
    });
    try {
      if (texts.length > 0) {
        worker.postMessage({ kind: "texts", texts } satisfies TextsMessage);
      }
      worker.postMessage({
        kind: "check",
        id: pending.id,
        query: pending.query,
        paths,
        everyNote: pending.isProbing,
      } satisfies CheckMessage);
    } catch (error: unknown) {
      this.giveUp(error);
      return;
    }
    this.unread += length;
    this.watch();
  }

  private startWorker(): Worker | null {
    if (this.worker !== null || this.isUnavailable) {
      return this.worker;
    }
    try {
      this.workerUrl ??= URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
      const worker = new Worker(this.workerUrl);
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        if (this.worker === worker) {
          this.onMessage(event.data);
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.worker === worker) {
          this.giveUp(event.message);
        }
      };
      this.worker = worker;
      return worker;
    } catch (error: unknown) {
      this.giveUp(error);
      return null;
    }
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.sent.clear();
    this.unread = 0;
    this.heardId = 0;
  }

  /** Lets the dialog search without the worker from now on, as it failed. */
  private giveUp(reason: unknown): void {
    console.warn("the-switcher: regular expressions are not tried before the search, as the worker failed", reason);
    this.isUnavailable = true;
    this.stopWorker();
    this.finish({ kind: "fast" });
  }

  private onMessage(message: WorkerMessage): void {
    this.heardAt = performance.now();
    this.heardId = message.id;
    const { pending } = this;
    if (!pending || message.id !== pending.id) {
      return;
    }
    // The worker read the texts that were sent before the check
    this.unread = 0;
    const upTo = message.kind === "done" ? pending.paths.length : pending.sentFrom + message.checked;
    const hasProgress = upTo > pending.checked;
    for (let i = pending.checked; i < upTo; i++) {
      this.checked.set(pending.paths[i], pending.versions[i]);
    }
    pending.checked = Math.max(pending.checked, upTo);
    if (message.kind === "done") {
      this.finish({ kind: "fast" });
    } else if (message.kind === "slow") {
      this.finish({ kind: "slow", path: pending.paths[upTo] });
    } else if (message.kind === "failed") {
      this.finish({ kind: "failed", path: pending.paths[upTo], reason: message.reason });
    } else if (hasProgress && !pending.isProbing) {
      // A probe tells of every note. The search goes on once it is done.
      pending.onProgress();
    }
  }

  /** Looks now and then whether the worker is silent, while a check is going on. */
  private watch(): void {
    if (this.timer !== null) {
      return;
    }
    this.tickAt = performance.now();
    this.timer = window.setTimeout(() => this.onTick(), TICK_MS);
  }

  private onTick(): void {
    this.timer = null;
    if (!this.pending) {
      return;
    }
    const now = performance.now();
    // While the window was held up, it could not hear the worker. That time does not count.
    if (now - this.tickAt > 2 * TICK_MS) {
      this.heardAt = Math.max(this.heardAt, now - TICK_MS);
    }
    if (now - this.heardAt > SILENCE_MS + this.unread / READ_CHARS_PER_MS) {
      this.onSilence(this.pending);
    } else {
      this.watch();
    }
  }

  /** Stops the worker that is held up, and finds out which note held it up. */
  private onSilence(pending: Pending): void {
    const isHeard = this.heardId === pending.id;
    this.stopWorker();
    if (!isHeard && !pending.isRestarted) {
      // An older check held the worker up, and it did not get to this one
      pending.isRestarted = true;
    } else if (!pending.isProbing) {
      // A note after the one the worker told of last held it up. The worker
      // tells how far it got only now and then, so to find out which note,
      // the rest are tried again with the worker telling of each.
      pending.isProbing = true;
    } else {
      this.finish({
        kind: "slow",
        path: pending.paths[Math.min(pending.checked, pending.paths.length - 1)],
      });
      return;
    }
    this.heardAt = performance.now();
    this.send(pending);
  }

  /** Ends the check that is going on. */
  private finish(result: CheckResult): void {
    const { pending } = this;
    if (!pending) {
      return;
    }
    this.pending = null;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    pending.resolve(result);
  }

  /** Lets go of the check that is going on, as a newer one takes its place. */
  private drop(): void {
    this.finish({ kind: "dropped" });
  }
}
