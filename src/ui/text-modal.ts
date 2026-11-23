import { type App, Platform } from "obsidian";
import type { NoteTexts } from "../note-texts.ts";
import { FileIndex } from "../search/file-index.ts";
import { toSegments } from "../search/highlight.ts";
import {
  findAll,
  type LineMatch,
  type TextSearch,
  toSnippet,
} from "../search/text-index.ts";
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

/** The notes are put in order by their names only, so none of them is given aliases */
const NO_ALIASES: string[] = [];

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

  /** The search for the query, which may still be going on */
  private search: TextSearch | null = null;
  /** How many matches of the search the list has, and when it got them */
  private listed = 0;
  private listedAt = 0;
  /** Calls for the next part of a search, after whatever else is waiting */
  private readonly nextPart = new MessageChannel();
  private isNextPartCalled = false;

  constructor(
    app: App,
    texts: NoteTexts,
    options: DialogOptions,
  ) {
    super(app, {
      ...options,
      placeholder: "Find text in notes",
      layoutKey: "the-switcher-find-layout",
    });
    this.modalEl.addClass("the-switcher-text");
    // The size of when the preview was beside the results does not fit under them
    this.app.saveLocalStorage("the-switcher-text-layout", null);
    this.texts = texts;

    const { vault, workspace } = this.app;
    this.notes = new FileIndex(
      vault.getMarkdownFiles().map((note) => ({
        path: note.path,
        basename: note.basename,
        extension: note.extension,
        folder: note.parent?.path ?? "/",
        mtime: note.stat.mtime,
        aliases: NO_ALIASES,
      })),
      workspace.getLastOpenFiles(),
      options.kept,
    );
    this.onExcludeChange();

    // The results, and under them the preview of the selected one
    const bodyEl = createDiv({ cls: "the-switcher-body" });
    this.resultContainerEl.before(bodyEl);
    bodyEl.appendChild(this.resultContainerEl);
    // The line between the two, which the mouse drags to give one of them more room
    const dividerEl = bodyEl.createDiv({ cls: "the-switcher-divider" });
    makeDraggable(dividerEl, {
      start: () => bodyEl.getBoundingClientRect(),
      move: (body, _dx, _dy, evt) => {
        this.layout.split = dragSplit(evt.clientY, body.top, body.height);
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

    this.nextPart.port1.onmessage = () => {
      this.isNextPartCalled = false;
      this.searchOn();
    };

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
    super.onOpen();
    void this.readNotes();
  }

  override onClose(): void {
    super.onClose();
    this.selectionObserver.disconnect();
    this.search = null;
    this.nextPart.port1.close();
  }

  getSuggestions(query: string): LineMatch[] {
    this.query = query;
    if (this.isReading) {
      this.emptyStateText = "Reading the notes...";
      this.setStatus("");
      return [];
    }
    // The search itself asks for its results to be listed again when it finds more
    if (this.search?.query !== query) {
      // A search that is dropped when the notes or the paths to look in change, so what it found still holds
      this.search = this.texts.index.searchOn(this.search, query, this.paths, MAX_RESULTS);
      this.searchPart(this.search);
    }
    const { matches, total, done } = this.search;
    this.listed = matches.length;
    this.listedAt = performance.now();
    if (!done) {
      this.emptyStateText = "Searching...";
    } else if (query.trim() === "") {
      this.emptyStateText = "Type the text to find.";
    } else {
      this.emptyStateText = "No results found.";
    }
    this.setStatus(`${matches.length} / ${done ? total : "..."}`);
    // The search adds to its matches. The list gets the ones there are now.
    return matches.slice();
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
    this.search = null;
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
      console.error("the-switcher: failed to read the notes", error);
    }
    this.isReading = false;
    this.search = null;
    this.refresh();
  }

  /**
   * Does a part of a search. A search of many notes takes longer than a
   * keystroke may wait, so it stops after a moment and goes on after whatever
   * came up in the meantime. A keystroke that changes the query drops it.
   */
  private searchPart(search: TextSearch): void {
    const end = performance.now() + SEARCH_PART_MS;
    let notes = 0;
    search.run(
      () => ++notes % NOTES_PER_LOOK_AT_CLOCK === 0 && performance.now() >= end,
    );
    if (!search.done && !this.isNextPartCalled) {
      this.isNextPartCalled = true;
      this.nextPart.port2.postMessage(null);
    }
  }

  /** Goes on with the search, and shows what it found. */
  private searchOn(): void {
    const { search } = this;
    if (!search || search.done) {
      return;
    }
    this.searchPart(search);

    const hasMore = search.matches.length > this.listed;
    const isTimeToList =
      search.done ||
      search.matches.length >= MAX_RESULTS ||
      performance.now() - this.listedAt >= LIST_AGAIN_MS;
    if ((hasMore && isTimeToList) || (search.done && this.listed === 0)) {
      this.listAgain();
    } else if (search.done) {
      // The list has all it gets. Now the lines are counted as well.
      this.setStatus(`${this.listed} / ${search.total}`);
    }
  }

  /** Lists the results again now that there are more, with the selection where it was. */
  private listAgain(): void {
    const listEl = this.resultContainerEl;
    const selected = Array.from(listEl.children).findIndex((el) =>
      el.hasClass("is-selected"),
    );
    const { scrollTop } = listEl;
    this.refresh();
    // A list that is filled again starts with its first result selected
    for (let i = 0; i < selected; i++) {
      this.moveSelection("ArrowDown");
    }
    listEl.scrollTop = scrollTop;
  }

  private updatePreview(): void {
    if (Platform.isPhone) {
      // A phone has no room for the preview, and no key that moves the selection
      return;
    }
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
