// A worker that tries a regular expression on every line of the notes before
// the dialog does. A pattern that takes too long holds up the worker, and not
// Obsidian. esbuild.config.mjs builds it by itself, and the guard starts it
// from the text of its code.
import { forEachLine } from "./search/lines.ts";
import { Matcher, type TextQuery } from "./search/matcher.ts";

/** The texts of notes, for the worker to keep */
export interface TextsMessage {
  kind: "texts";
  texts: [string, string][];
}

/** A query to try on every line of the given notes, in their order */
export interface CheckMessage {
  kind: "check";
  id: number;
  query: TextQuery;
  paths: string[];
  /** True to tell of every note as it is started, to find out which one holds the worker up */
  everyNote: boolean;
}

/** What the worker tells of a check */
export type WorkerMessage =
  /**
   * How many of the notes, from the first on, are done. It is told several
   * times a second, to show that the worker is not held up.
   */
  | { kind: "beat"; id: number; checked: number }
  /** Every note is done */
  | { kind: "done"; id: number }
  /** The lines of the note after the ones that are done took too long */
  | { kind: "slow"; id: number; checked: number }
  /**
   * Matching a line of the note after the ones that are done failed, as it
   * can for a line that is too long for the pattern
   */
  | { kind: "failed"; id: number; checked: number; reason: string };

/** How long the worker tries notes before it reads the messages that came meanwhile */
const SLICE_MS = 25;
/** How often the worker tells how far it got, also in the middle of a note */
const BEAT_MS = 100;
/**
 * How long the lines of a note may take. The dialog tries all of them at
 * once, and in that time Obsidian takes no keystroke.
 */
const SLOW_NOTE_MS = 1_000;

const texts = new Map<string, string>();
/** The check that was asked for last. One of before stops. */
let latest = 0;

/** Calls for the checks that pause, in turn, once the messages that came before are read */
const pauses = new MessageChannel();
const paused: (() => void)[] = [];
pauses.port1.onmessage = () => paused.shift()?.();

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tell(message: WorkerMessage): void {
  self.postMessage(message);
}

/** Lets the messages that came meanwhile be read, such as a newer check. */
function pause(): Promise<void> {
  return new Promise((resolve) => {
    paused.push(resolve);
    pauses.port2.postMessage(null);
  });
}

async function check({ id, query, paths, everyNote }: CheckMessage): Promise<void> {
  const matcher = new Matcher(query);
  let beatAt = performance.now();
  let sliceEnd = beatAt + SLICE_MS;
  tell({ kind: "beat", id, checked: 0 });
  for (let i = 0; i < paths.length; i++) {
    if (everyNote && i > 0) {
      tell({ kind: "beat", id, checked: i });
      beatAt = performance.now();
    }
    const text = texts.get(paths[i]);
    if (text !== undefined) {
      const start = performance.now();
      let isSlow = false;
      try {
        forEachLine(text, (_start, line) => {
          // All the matches, as the list, the preview and a replacement look for them
          matcher.execAll(line);
          const now = performance.now();
          isSlow = now - start > SLOW_NOTE_MS;
          if (now - beatAt >= BEAT_MS) {
            tell({ kind: "beat", id, checked: i });
            beatAt = now;
          }
          return !isSlow;
        });
      } catch (error: unknown) {
        tell({ kind: "failed", id, checked: i, reason: reasonOf(error) });
        return;
      }
      if (isSlow) {
        tell({ kind: "slow", id, checked: i });
        return;
      }
    }
    if (performance.now() >= sliceEnd) {
      tell({ kind: "beat", id, checked: i + 1 });
      await pause();
      if (latest !== id) {
        return;
      }
      beatAt = performance.now();
      sliceEnd = beatAt + SLICE_MS;
    }
  }
  tell({ kind: "done", id });
}

self.onmessage = (event: MessageEvent<TextsMessage | CheckMessage>) => {
  const message = event.data;
  if (message.kind === "texts") {
    for (const [path, text] of message.texts) {
      texts.set(path, text);
    }
    return;
  }
  latest = message.id;
  check(message).catch((error: unknown) => {
    tell({ kind: "failed", id: message.id, checked: 0, reason: reasonOf(error) });
  });
};
