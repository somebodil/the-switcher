import type { App } from "obsidian";
import type { NoteTexts } from "../note-texts.ts";
import { FileIndex } from "../search/file-index.ts";
import { toSegments } from "../search/highlight.ts";
import { findAll, type LineMatch, toSnippet } from "../search/text-index.ts";
import { makeDraggable } from "./drag.ts";
import { dragSplit } from "./layout.ts";
import {
  appendSegments,
  type DialogOptions,
  MAX_RESULTS,
  SwitcherModal,
  type Target,
} from "./switcher-modal.ts";

/** How many lines the preview shows before and after the line of a result */
const PREVIEW_RADIUS = 60;
/** How many characters of a line a result shows */
const SNIPPET_LENGTH = 160;

/** A dialog that finds a text in the notes and opens a note at the line that has it. */
export class TextModal extends SwitcherModal<LineMatch> {
  private readonly texts: NoteTexts;
  /** The notes, for the order of the results and for the exclude patterns */
  private readonly notes: FileIndex;
  private readonly previewEl: HTMLElement;
  /** Which result each element of the list shows, to preview the selected one */
  private readonly resultOf = new WeakMap<Element, LineMatch>();
  private readonly selectionObserver: MutationObserver;

  /** The paths to look in, in the order of the results */
  private paths: string[] = [];
  private query = "";
  /** The result that the preview shows */
  private previewed: LineMatch | null = null;
  private isReading = true;

  constructor(
    app: App,
    texts: NoteTexts,
    options: DialogOptions,
  ) {
    super(app, {
      ...options,
      placeholder: "Find text in notes",
      layoutKey: "the-switcher-text-layout",
    });
    this.modalEl.addClass("the-switcher-text");
    this.texts = texts;

    const { vault, workspace } = this.app;
    this.notes = new FileIndex(
      vault.getMarkdownFiles().map((note) => ({
        path: note.path,
        basename: note.basename,
        extension: note.extension,
        folder: note.parent?.path ?? "/",
        mtime: note.stat.mtime,
        aliases: [],
      })),
      workspace.getLastOpenFiles(),
    );
    this.onExcludeChange();

    // The results on the left, the preview of the selected one on the right
    const bodyEl = createDiv({ cls: "the-switcher-body" });
    this.resultContainerEl.before(bodyEl);
    bodyEl.appendChild(this.resultContainerEl);
    // The line between the two, which the mouse drags to give one of them more room
    const dividerEl = bodyEl.createDiv({ cls: "the-switcher-divider" });
    makeDraggable(dividerEl, {
      start: () => bodyEl.getBoundingClientRect(),
      move: (body, _dx, _dy, evt) => {
        this.layout.split = dragSplit(evt.clientX, body.left, body.width);
        this.applyLayout();
      },
      end: () => this.saveLayout(),
      reset: () => {
        this.layout.split = undefined;
        this.applyLayout();
        this.saveLayout();
      },
    });
    this.previewEl = bodyEl.createDiv({ cls: "the-switcher-preview" });

    // The selection moves with the arrow keys and the mouse. The list marks it
    // with a class, so watching the classes tells when to change the preview.
    this.selectionObserver = new MutationObserver(() => this.updatePreview());
    this.selectionObserver.observe(this.resultContainerEl, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  override onOpen(): void {
    void super.onOpen();
    void this.readNotes();
  }

  override onClose(): void {
    super.onClose();
    this.selectionObserver.disconnect();
  }

  getSuggestions(query: string): LineMatch[] {
    this.query = query;
    if (this.isReading) {
      this.emptyStateText = "Reading the notes...";
      this.setStatus("");
      return [];
    }
    this.emptyStateText =
      query.trim() === "" ? "Type the text to find." : "No results found.";
    const { matches, total } = this.texts.index.search(
      query,
      this.paths,
      MAX_RESULTS,
    );
    return this.show(matches, total);
  }

  renderSuggestion(match: LineMatch, el: HTMLElement): void {
    this.resultOf.set(el, match);
    el.addClass("mod-complex");

    const snippet = toSnippet(match, SNIPPET_LENGTH);
    const contentEl = el.createDiv({ cls: "suggestion-content" });
    appendSegments(
      contentEl.createDiv({ cls: "suggestion-title the-switcher-line" }),
      toSegments(snippet.text, snippet.ranges),
    );

    const auxEl = el.createDiv({ cls: "suggestion-aux" });
    // The name gives way when there is little room. The number of the line does not.
    const locationEl = auxEl.createSpan({ cls: "the-switcher-location" });
    locationEl.createSpan({
      cls: "the-switcher-location-name",
      text: toBasename(match.path),
    });
    locationEl.createSpan({
      cls: "the-switcher-location-line",
      text: `:${match.line + 1}`,
    });
  }

  protected onExcludeChange(): void {
    this.notes.exclude(this.excludePatterns);
    this.paths = this.notes.search([]).map((hit) => hit.entry.file.path);
  }

  protected openResult(match: LineMatch, target: Target): Promise<void> {
    return this.openFile(match.path, target, {
      line: match.line,
      range: match.ranges[0],
    });
  }

  private async readNotes(): Promise<void> {
    try {
      await this.texts.refresh(this.app.vault);
    } catch (error: unknown) {
      console.error("The Switcher: failed to read the notes", error);
    }
    this.isReading = false;
    this.refresh();
  }

  private updatePreview(): void {
    const selectedEl = this.resultContainerEl.querySelector(
      ".suggestion-item.is-selected",
    );
    const match = (selectedEl && this.resultOf.get(selectedEl)) ?? null;
    if (match === this.previewed) {
      return;
    }
    this.previewed = match;
    this.previewEl.empty();
    if (!match) {
      return;
    }

    const excerpt = this.texts.index.excerpt(
      match.path,
      match.line,
      PREVIEW_RADIUS,
    );
    if (!excerpt) {
      return;
    }
    this.previewEl.createDiv({
      cls: "the-switcher-preview-path",
      text: match.path,
    });
    const linesEl = this.previewEl.createDiv({ cls: "the-switcher-preview-lines" });
    for (const [i, text] of excerpt.lines.entries()) {
      const line = excerpt.first + i;
      const lineEl = linesEl.createDiv({ cls: "the-switcher-preview-line" });
      lineEl.createSpan({
        cls: "the-switcher-preview-number",
        text: String(line + 1),
      });
      appendSegments(
        lineEl.createSpan({ cls: "the-switcher-preview-text" }),
        toSegments(text, findAll(text, this.query)),
      );
      if (line === match.line) {
        lineEl.addClass("is-match");
        // Put the line of the result in the middle of the preview, once all
        // lines are there. The list of lines is the offset parent of a line.
        window.requestAnimationFrame(() => {
          linesEl.scrollTop =
            lineEl.offsetTop - (linesEl.clientHeight - lineEl.clientHeight) / 2;
        });
      }
    }
  }
}

function toBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}
