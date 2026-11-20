import { type App, parseFrontMatterAliases, setIcon } from "obsidian";
import { describe, FileIndex, type Hit } from "../search/file-index.ts";
import { parseQuery, type Term } from "../search/query.ts";
import {
  appendSegments,
  type DialogOptions,
  MAX_RESULTS,
  SwitcherModal,
  type Target,
} from "./switcher-modal.ts";

/** A dialog that finds a file by its name and opens it. */
export class FileModal extends SwitcherModal<Hit> {
  private readonly index: FileIndex;
  /** The terms of the query that the shown results belong to */
  private terms: Term[] = [];

  constructor(app: App, options: DialogOptions) {
    super(app, {
      ...options,
      placeholder: "Find a file by name",
      layoutKey: "the-switcher-file-layout",
    });
    this.modalEl.addClass("the-switcher-files");
    this.index = this.buildIndex();
    this.index.exclude(this.excludePatterns);
  }

  getSuggestions(query: string): Hit[] {
    this.terms = parseQuery(query);
    const hits = this.index.search(this.terms);
    return this.show(hits.slice(0, MAX_RESULTS), hits.length);
  }

  renderSuggestion(hit: Hit, el: HTMLElement): void {
    const view = describe(hit, this.terms);
    el.addClass("mod-complex");

    const contentEl = el.createDiv({ cls: "suggestion-content" });
    const titleEl = contentEl.createDiv({ cls: "suggestion-title the-switcher-file" });
    appendSegments(titleEl.createSpan({ cls: "the-switcher-name" }), view.name);
    if (view.extension !== null) {
      titleEl.createSpan({ cls: "the-switcher-ext", text: view.extension });
    }
    // The path gives way before the name does, and its first part before its last
    const { outer, inner } = view.folder;
    if (inner !== "") {
      const pathEl = titleEl.createSpan({ cls: "the-switcher-path" });
      if (outer !== "") {
        pathEl.createSpan({ cls: "the-switcher-path-outer", text: outer });
      }
      pathEl.createSpan({ cls: "the-switcher-path-inner", text: inner });
    }
    if (view.aliases.length > 0) {
      const noteEl = contentEl.createDiv({ cls: "suggestion-note" });
      for (const alias of view.aliases) {
        const aliasEl = noteEl.createSpan({ cls: "the-switcher-alias" });
        setIcon(aliasEl.createSpan({ cls: "the-switcher-icon" }), "forward");
        appendSegments(
          aliasEl.createSpan({ cls: "the-switcher-alias-text" }),
          alias,
        );
      }
    }
  }

  protected onExcludeChange(): void {
    this.index.exclude(this.excludePatterns);
  }

  protected openResult(hit: Hit, target: Target): Promise<void> {
    return this.openFile(hit.entry.file.path, target);
  }

  /** Lists every file but the active one, since nobody switches to where they are. */
  private buildIndex(): FileIndex {
    const { vault, workspace, metadataCache } = this.app;
    const activePath = workspace.getActiveFile()?.path;
    return new FileIndex(
      vault
        .getFiles()
        .filter((file) => file.path !== activePath)
        .map((file) => ({
          path: file.path,
          basename: file.basename,
          extension: file.extension,
          folder: file.parent?.path ?? "/",
          mtime: file.stat.mtime,
          aliases:
            parseFrontMatterAliases(
              metadataCache.getFileCache(file)?.frontmatter,
            ) ?? [],
        })),
      workspace.getLastOpenFiles(),
    );
  }
}
