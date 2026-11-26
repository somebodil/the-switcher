import { type App, MarkdownView, type Vault } from "obsidian";
import { TextIndex } from "./search/text-index.ts";

/** How many notes are read or written at the same time */
const BATCH_SIZE = 64;

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
}

/** Runs an action on every item, a batch at a time. */
async function inBatches<T>(items: readonly T[], action: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    await Promise.all(items.slice(i, i + BATCH_SIZE).map(action));
  }
}

/**
 * The texts of the Markdown notes of a vault.
 * They are kept between searches, and only the notes that changed are read again.
 */
export class NoteTexts {
  readonly index = new TextIndex();
  /** When each note was last modified at the time it was read */
  private readonly readAt = new Map<string, number>();

  /** Brings the texts up to date with the vault. */
  async refresh(vault: Vault): Promise<void> {
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
  }

  /**
   * Changes notes, and their texts here with them. Each note is changed
   * from the text it has at that moment, which may be newer than the one here.
   *
   * @param change given the text of a note and its path, returns the new
   *   text, or null to leave the note as it is
   */
  async change(
    app: App,
    paths: readonly string[],
    change: (text: string, path: string) => string | null,
  ): Promise<ChangeResult> {
    await this.saveOpenNotes(app, new Set(paths));
    const result: ChangeResult = { changes: [], failed: [] };
    await inBatches(paths, async (path) => {
      const file = app.vault.getFileByPath(path);
      if (!file) {
        // Deleted or renamed since it was read
        return;
      }
      try {
        const text = await app.vault.process(file, (before) => {
          const after = change(before, path);
          if (after === null || after === before) {
            return before;
          }
          result.changes.push({ path, before, after });
          return after;
        });
        this.index.set(path, text);
      } catch (error: unknown) {
        console.error(`the-switcher: failed to change ${path}`, error);
        result.failed.push(path);
      }
    });
    return result;
  }

  /**
   * Puts back the texts that changes replaced, in the notes that still have
   * the texts the changes left. A note that was changed again since is left
   * as it is.
   */
  undo(app: App, changes: readonly NoteChange[]): Promise<ChangeResult> {
    const byPath = new Map(changes.map((change) => [change.path, change]));
    return this.change(app, [...byPath.keys()], (text, path) => {
      const change = byPath.get(path);
      return change !== undefined && text === change.after ? change.before : null;
    });
  }

  /**
   * Saves what was typed into the given notes, where they are open. An editor
   * saves a moment after the last key, and a change made before that would be
   * written over by it.
   */
  private async saveOpenNotes(app: App, paths: Set<string>): Promise<void> {
    await Promise.all(
      app.workspace.getLeavesOfType("markdown").map(async ({ view }) => {
        if (view instanceof MarkdownView && view.file && paths.has(view.file.path)) {
          await view.save();
        }
      }),
    );
  }
}
