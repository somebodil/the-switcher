import type { Vault } from "obsidian";
import { TextIndex } from "./search/text-index.ts";

/** How many notes are read at the same time */
const BATCH_SIZE = 64;

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
    for (let i = 0; i < changed.length; i += BATCH_SIZE) {
      await Promise.all(
        changed.slice(i, i + BATCH_SIZE).map(async (note) => {
          const { mtime } = note.stat;
          this.index.set(note.path, await vault.cachedRead(note));
          this.readAt.set(note.path, mtime);
        }),
      );
    }
  }
}
