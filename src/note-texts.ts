import { type App, MarkdownView } from "obsidian";
import { RegexGuard } from "./regex-guard.ts";
import { TextIndex } from "./search/text-index.ts";

/** How many notes are read or written at the same time */
const BATCH_SIZE = 64;
/**
 * The byte order mark that a note can start with, as one written by Notepad on
 * Windows does. Obsidian reads a note without it, but writes what it is given.
 */
const BYTE_ORDER_MARK = "\uFEFF";

/** Splits the byte order mark off the start of a text, if it has one. */
function splitMark(text: string): [mark: string, rest: string] {
  return text.startsWith(BYTE_ORDER_MARK)
    ? [BYTE_ORDER_MARK, text.slice(BYTE_ORDER_MARK.length)]
    : ["", text];
}

/** What a change did to a note: its text before and after. */
export interface NoteChange {
  path: string;
  before: string;
  after: string;
}

/** What a change of several notes did. */
export interface ChangeResult {
  changes: NoteChange[];
  /** The notes that could not be changed. The console tells why. */
  failed: string[];
  /** The notes that are not in the vault any more: deleted or renamed since they were read */
  missing: string[];
}

/**
 * Runs an action on every item, a batch at a time.
 *
 * @param onBatch called after each batch, with how many items are done
 */
async function inBatches<T>(
  items: readonly T[],
  action: (item: T) => Promise<void>,
  onBatch?: (done: number) => void,
): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    await Promise.all(items.slice(i, i + BATCH_SIZE).map(action));
    onBatch?.(Math.min(i + BATCH_SIZE, items.length));
  }
}

/** Tells how many of the notes of a change are done. Writing a note takes Obsidian a few milliseconds. */
export type OnChangeProgress = (done: number, total: number) => void;

/** The notes that are open in an editor, with their paths. */
function openNotes(app: App): { path: string; view: MarkdownView }[] {
  const open: { path: string; view: MarkdownView }[] = [];
  for (const { view } of app.workspace.getLeavesOfType("markdown")) {
    if (view instanceof MarkdownView && view.file) {
      open.push({ path: view.file.path, view });
    }
  }
  return open;
}

/**
 * The texts of the Markdown notes of a vault.
 * They are kept between searches, and only the notes that changed are read again.
 */
export class NoteTexts {
  readonly index = new TextIndex();
  /** Tries a regular expression on the texts before a search does */
  readonly guard = new RegexGuard(this.index);
  private readonly app: App;
  /** When each note was last modified at the time it was read */
  private readonly readAt = new Map<string, number>();
  /** The change that was asked for last. Changes are made one after another. */
  private lastChange: Promise<unknown> = Promise.resolve();

  constructor(app: App) {
    this.app = app;
  }

  /** Brings the texts up to date with the vault, and with what is typed into open notes. */
  async refresh(): Promise<void> {
    const { vault } = this.app;
    const notes = vault.getMarkdownFiles();
    const paths = new Set(notes.map((note) => note.path));
    this.index.retain(paths);
    for (const path of this.readAt.keys()) {
      if (!paths.has(path)) {
        this.readAt.delete(path);
      }
    }

    const changed = notes.filter(
      (note) => this.readAt.get(note.path) !== note.stat.mtime,
    );
    await inBatches(changed, async (note) => {
      const { mtime } = note.stat;
      this.index.set(note.path, await vault.cachedRead(note));
      this.readAt.set(note.path, mtime);
    });

    // An editor saves a moment after the last key. Until then the note has
    // more than the file, and the search goes by what the note has.
    for (const { path, view } of openNotes(this.app)) {
      if (paths.has(path)) {
        this.index.set(path, view.getViewData());
        // The file is read again the next time, for what was not saved in the end
        this.readAt.delete(path);
      }
    }
  }

  /**
   * Changes notes, and their texts here with them. Each note is changed from
   * the text it has at that moment, which may be newer than the one here.
   * A change that is asked for while another is going on waits for it.
   * It does not fail: what could not be done is in the result.
   *
   * @param change given the text of a note and its path, returns the new
   *   text, or null to leave the note as it is
   */
  change(
    paths: readonly string[],
    change: (text: string, path: string) => string | null,
    onProgress?: OnChangeProgress,
  ): Promise<ChangeResult> {
    const result = this.lastChange.then(() => this.changeNow(paths, change, onProgress));
    // A change that fails does not keep the ones after it from being made
    this.lastChange = result.catch(() => undefined);
    return result;
  }

  /**
   * Puts back the texts that changes replaced, in the notes that still have
   * the texts the changes left. A note that was changed again since is left
   * as it is.
   */
  undo(changes: readonly NoteChange[], onProgress?: OnChangeProgress): Promise<ChangeResult> {
    const byPath = new Map(changes.map((change) => [change.path, change]));
    return this.change(
      [...byPath.keys()],
      (text, path) => {
        const change = byPath.get(path);
        return change !== undefined && text === change.after ? change.before : null;
      },
      onProgress,
    );
  }

  private async changeNow(
    paths: readonly string[],
    change: (text: string, path: string) => string | null,
    onProgress?: OnChangeProgress,
  ): Promise<ChangeResult> {
    const { vault } = this.app;
    const result: ChangeResult = { changes: [], failed: [], missing: [] };
    const unsaved = await this.saveOpenNotes(new Set(paths));
    await inBatches(paths, async (path) => {
      const file = vault.getFileByPath(path);
      if (!file) {
        this.index.delete(path);
        result.missing.push(path);
        return;
      }
      if (unsaved.has(path)) {
        // Changing the file would leave out what was typed into the note
        result.failed.push(path);
        return;
      }
      try {
        // What the change makes, once the note is written
        const made: NoteChange[] = [];
        const text = await vault.process(file, (stored) => {
          // The change gets the text as it was read, and the mark stays at the start
          const [mark, before] = splitMark(stored);
          const after = change(before, path);
          if (after === null || after === before) {
            return stored;
          }
          made.push({ path, before, after });
          return mark + after;
        });
        result.changes.push(...made);
        this.index.set(path, splitMark(text)[1]);
      } catch (error: unknown) {
        console.error(`the-switcher: failed to change ${path}`, error);
        result.failed.push(path);
      }
    }, (done) => onProgress?.(done, paths.length));
    return result;
  }

  /**
   * Saves what was typed into the given notes, where they are open. An editor
   * saves a moment after the last key, and would write over a change that
   * was made before that.
   *
   * @returns the notes that could not be saved
   */
  private async saveOpenNotes(paths: Set<string>): Promise<Set<string>> {
    const failed = new Set<string>();
    await Promise.all(
      openNotes(this.app).map(async ({ path, view }) => {
        if (!paths.has(path)) {
          return;
        }
        try {
          await view.save();
        } catch (error: unknown) {
          console.error(`the-switcher: failed to save ${path}`, error);
          failed.add(path);
        }
      }),
    );
    return failed;
  }
}
