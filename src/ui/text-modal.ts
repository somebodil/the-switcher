import { type App, type Instruction, Notice, Platform, setIcon } from "obsidian";
import type { ChangeResult, NoteChange, NoteTexts } from "../note-texts.ts";
import { FileIndex } from "../search/file-index.ts";
import { type Range, toSegments } from "../search/highlight.ts";
import { type Piece, replaceAll, replaceInLine, toPieces } from "../search/replace.ts";
import {
  findAll,
  type LineMatch,
  type TextSearch,
  toSnippet,
} from "../search/text-index.ts";
import { ConfirmModal } from "./confirm-modal.ts";
import { makeDraggable } from "./drag.ts";
import { dragSplit } from "./layout.ts";
import {
  ALT_KEY,
  appendSegments,
  type DialogOptions,
  MAX_RESULTS,
  MOD_KEY,
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
/** How long the notice that tells of a replacement, and can undo it, stays */
const UNDO_NOTICE_MS = 10_000;

/** The notes are put in order by their names only, so none of them is given aliases */
const NO_ALIASES: string[] = [];

export interface TextDialogOptions extends DialogOptions {
  /** True to open the dialog with the input for the replacement */
  replacing: boolean;
}

/**
 * A dialog that finds a text in the notes and opens a note at the line that
 * has it. It can replace the text as well, in one line or in all notes.
 */
export class TextModal extends SwitcherModal<LineMatch> {
  private readonly texts: NoteTexts;
  /** The notes, for the order of the results and for the exclude patterns */
  private readonly notes: FileIndex;
  private readonly previewEl: HTMLElement;
  /** The input for the replacement, in a row under the query */
  private readonly replaceInputEl: HTMLInputElement;
  private readonly replaceButtonEls: HTMLButtonElement[] = [];
  /** Which result each element of the list shows, to preview the selected one */
  private readonly resultOf = new WeakMap<Element, LineMatch>();
  private readonly selectionObserver: MutationObserver;

  /** The paths to look in, in the order of the results */
  private paths: string[] = [];
  private query = "";
  /** True while the row with the replacement is shown */
  private replacing: boolean;
  /** True while notes are being changed. Another replacement waits until it is over. */
  private isChanging = false;
  /** The result that the preview shows, or undefined when the preview is to be drawn anew */
  private previewed: LineMatch | null | undefined = null;
  private isReading = true;

  /** The search for the query, which may still be going on */
  private search: TextSearch | null = null;
  /** How many matches of the search the list has, and when it got them */
  private listed = 0;
  private listedAt = 0;
  /** Calls for the next part of a search, after whatever else is waiting */
  private readonly nextPart = new MessageChannel();
  private isNextPartCalled = false;

  constructor(app: App, texts: NoteTexts, options: TextDialogOptions) {
    super(app, {
      ...options,
      placeholder: "Find text in notes",
      layoutKey: "the-switcher-find-layout",
    });
    this.modalEl.addClass("the-switcher-text");
    this.texts = texts;
    this.replacing = options.replacing;
    this.modalEl.toggleClass("mod-replace", this.replacing);

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

    // The replacement, between the query and the exclude input
    const replaceEl = createDiv({ cls: "the-switcher-replace" });
    this.statusEl.before(replaceEl);
    setIcon(replaceEl.createSpan({ cls: "the-switcher-icon" }), "replace");
    this.replaceInputEl = replaceEl.createEl("input", {
      cls: "the-switcher-replace-input",
      type: "text",
      attr: { placeholder: "Replace with", spellcheck: "false", autocapitalize: "off" },
    });
    this.replaceInputEl.addEventListener("input", () => this.redraw());
    this.addReplaceButton(replaceEl, "Replace", `Replace in the selected line (${ALT_KEY} ↵)`, () => {
      void this.replaceSelected();
    });
    this.addReplaceButton(replaceEl, "Replace all", `Replace in all notes (${MOD_KEY} ${ALT_KEY} ↵)`, () => this.askToReplaceAll());

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

    this.registerKey(["Mod"], "R", () => this.toggleReplacing());
    this.registerKey(["Alt"], "Enter", () => {
      void this.replaceSelected();
    });
    this.registerKey(["Mod", "Alt"], "Enter", () => this.askToReplaceAll());
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

  protected override instructions(): Instruction[] {
    const instructions = super.instructions();
    // After the keys that open a result
    instructions.splice(
      3,
      0,
      ...(this.replacing
        ? [
            { command: `${ALT_KEY} ↵`, purpose: "replace" },
            { command: `${MOD_KEY} ${ALT_KEY} ↵`, purpose: "replace all" },
            { command: `${MOD_KEY} R`, purpose: "find only" },
          ]
        : [{ command: `${MOD_KEY} R`, purpose: "replace" }]),
    );
    return instructions;
  }

  getSuggestions(query: string): LineMatch[] {
    this.query = query;
    if (this.isReading) {
      this.emptyStateText = "Reading the notes...";
      this.setStatus("");
      this.updateReplaceButtons(0);
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
    this.updateReplaceButtons(matches.length);
    // The search adds to its matches. The list gets the ones there are now.
    return matches.slice();
  }

  renderSuggestion(match: LineMatch, el: HTMLElement): void {
    this.resultOf.set(el, match);
    el.addClass("mod-complex");

    const snippet = toSnippet(match, SNIPPET_LENGTH);
    const contentEl = el.createDiv({ cls: "suggestion-content" });
    this.appendLine(
      contentEl.createDiv({ cls: "suggestion-title the-switcher-line" }),
      snippet.text,
      snippet.ranges,
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

  /**
   * Lists the results again, with the selection where it was.
   *
   * @param replaced the result that was just replaced. When it is still there,
   *   as when the replacement has the query in it, the selection goes on to the next one.
   */
  private listAgain(replaced?: LineMatch): void {
    const listEl = this.resultContainerEl;
    let selected = this.selectedIndex();
    const { scrollTop } = listEl;
    this.refresh();
    const there = this.matchAt(selected);
    if (replaced && there?.path === replaced.path && there.line === replaced.line) {
      selected++;
    }
    // A list that is filled again starts with its first result selected. A
    // list that got shorter keeps the selection on its last result.
    const last = listEl.querySelectorAll(".suggestion-item").length - 1;
    for (let i = 0; i < Math.min(selected, last); i++) {
      this.moveSelection("ArrowDown");
    }
    listEl.scrollTop = scrollTop;
  }

  /** Shows the results and the preview again, as when the replacement or the mode changes. */
  private redraw(): void {
    this.previewed = undefined;
    this.listAgain();
  }

  /** The place of the selected result in the list, or -1 if none is */
  private selectedIndex(): number {
    return Array.from(this.resultContainerEl.children).findIndex((el) =>
      el.hasClass("is-selected"),
    );
  }

  private matchAt(index: number): LineMatch | null {
    const el = this.resultContainerEl.children.item(index);
    return (el && this.resultOf.get(el)) ?? null;
  }

  private selectedMatch(): LineMatch | null {
    const selectedEl = this.resultContainerEl.querySelector(
      ".suggestion-item.is-selected",
    );
    return (selectedEl && this.resultOf.get(selectedEl)) ?? null;
  }

  private updatePreview(): void {
    if (Platform.isPhone) {
      // A phone has no room for the preview, and no key that moves the selection
      return;
    }
    const match = this.selectedMatch();
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
      this.appendLine(
        lineEl.createSpan({ cls: "the-switcher-preview-text" }),
        text,
        findAll(text, this.query),
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

  /** Adds a line with its matches highlighted, or while replacing, with each match and its replacement. */
  private appendLine(el: HTMLElement, text: string, ranges: Range[]): void {
    if (this.replacing) {
      appendPieces(el, toPieces(text, ranges, this.replaceInputEl.value));
    } else {
      appendSegments(el, toSegments(text, ranges));
    }
  }

  private addReplaceButton(
    rowEl: HTMLElement,
    text: string,
    tooltip: string,
    action: () => void,
  ): void {
    const buttonEl = rowEl.createEl("button", {
      cls: "the-switcher-replace-button",
      text,
      attr: { "aria-label": tooltip },
    });
    // The input that is typed in keeps the focus, and on a touch screen the keyboard stays
    buttonEl.addEventListener("mousedown", (evt) => evt.preventDefault());
    buttonEl.addEventListener("click", action);
    this.replaceButtonEls.push(buttonEl);
  }

  private updateReplaceButtons(listed: number): void {
    for (const buttonEl of this.replaceButtonEls) {
      buttonEl.disabled = listed === 0 || this.isChanging;
    }
  }

  /** Shows or hides the row with the replacement, and goes to the input that is left. */
  private toggleReplacing(): void {
    this.replacing = !this.replacing;
    this.modalEl.toggleClass("mod-replace", this.replacing);
    this.showInstructions();
    (this.replacing ? this.replaceInputEl : this.inputEl).focus();
    this.redraw();
  }

  /** Replaces the query in the selected line. */
  private async replaceSelected(): Promise<void> {
    const match = this.selectedMatch();
    if (!this.replacing || this.isChanging || !match) {
      return;
    }
    const { query } = this;
    const replacement = this.replaceInputEl.value;
    let count = 0;
    const result = await this.changeNotes([match.path], (text) => {
      const replaced = replaceInLine(text, match.line, match.text, query, replacement);
      count += replaced?.count ?? 0;
      return replaced?.text ?? null;
    }, match);
    if (result.changes.length === 0 && result.failed.length === 0) {
      new Notice(`${toBasename(match.path)} was changed since it was read, and nothing was replaced. The results show it as it is now.`);
    }
    this.announce(result, count);
  }

  /** Asks whether to replace the query in all notes that have it, and does so if told to. */
  private askToReplaceAll(): void {
    const { search, query } = this;
    if (!this.replacing || this.isChanging || !search || query.trim() === "") {
      return;
    }
    if (!search.done) {
      // Every note has to be looked at to know what will be replaced
      search.run();
      this.listAgain();
    }
    const paths = search.found.slice();
    let count = 0;
    for (const path of paths) {
      count += findAll(this.texts.index.get(path) ?? "", query).length;
    }
    if (count === 0) {
      return;
    }
    const replacement = this.replaceInputEl.value;
    const where = plural(paths.length, "note");
    new ConfirmModal(this.app, {
      title: "Replace all",
      message:
        replacement === ""
          ? `Remove ${plural(count, "match", "matches")} of “${query}” from ${where}?`
          : `Replace ${plural(count, "match", "matches")} of “${query}” with “${replacement}” in ${where}?`,
      action: "Replace all",
      onConfirm: () => {
        void this.replaceAll(paths, query, replacement);
      },
    }).open();
  }

  private async replaceAll(paths: string[], query: string, replacement: string): Promise<void> {
    let count = 0;
    const result = await this.changeNotes(paths, (text) => {
      const replaced = replaceAll(text, query, replacement);
      count += replaced.count;
      return replaced.count === 0 ? null : replaced.text;
    });
    this.announce(result, count);
  }

  /**
   * Replaces in notes that the search found, and lists the results again for
   * what the notes have now.
   *
   * @param replaced the result that is replaced, if it is one result
   */
  private async changeNotes(
    paths: string[],
    change: (text: string) => string | null,
    replaced?: LineMatch,
  ): Promise<ChangeResult> {
    const before = this.search;
    this.isChanging = true;
    this.updateReplaceButtons(0);
    // In a large vault this takes a few seconds
    this.setStatus("Replacing...");
    try {
      return await this.texts.change(this.app, paths, change);
    } finally {
      this.isChanging = false;
      // Only the notes that had the query before can have it now: the
      // changed ones are among them. That holds while the search is the same.
      this.searchAgain(this.search === before ? before : null, replaced);
    }
  }

  /**
   * Searches anew, now that notes were changed.
   *
   * @param within a search whose notes are the only ones that can have the query, or null to look at all of them
   */
  private searchAgain(within: TextSearch | null, replaced?: LineMatch): void {
    if (!this.containerEl.isConnected) {
      // Closed: the next dialog reads the notes as they are now
      return;
    }
    const search = this.texts.index.searchOn(within, this.query, this.paths, MAX_RESULTS);
    this.search = search;
    // Far enough for the selection to stay where it was, and for the result
    // after it, which is selected when the replaced one is still there
    const enough = Math.min(this.selectedIndex() + 2, MAX_RESULTS);
    search.run(() => search.matches.length >= enough);
    this.searchPart(search);
    this.previewed = undefined;
    this.listAgain(replaced);
  }

  /** Tells what was replaced, with a button that puts it back. */
  private announce({ changes, failed }: ChangeResult, count: number): void {
    if (failed.length > 0) {
      new Notice(`Could not replace in ${failed.map(toBasename).join(", ")}. The console tells why.`);
    }
    if (changes.length === 0) {
      return;
    }
    const where = changes.length === 1 ? toBasename(changes[0].path) : plural(changes.length, "note");
    const message = createFragment((el) => {
      el.appendText(`Replaced ${plural(count, "match", "matches")} in ${where}.`);
      el.createEl("button", { cls: "the-switcher-undo", text: "Undo" }).addEventListener("click", () => {
        void this.undo(changes);
      });
    });
    new Notice(message, UNDO_NOTICE_MS);
  }

  private async undo(changes: NoteChange[]): Promise<void> {
    this.setStatus("Putting back...");
    const result = await this.texts.undo(this.app, changes);
    // What is put back can have the query in any note
    this.searchAgain(null);
    const kept = changes.length - result.changes.length - result.failed.length;
    new Notice(
      `Put back ${plural(result.changes.length, "note")}.` +
        (kept === 0 ? "" : kept === 1
          ? " 1 note was changed again since, and is left as it is."
          : ` ${kept} notes were changed again since, and are left as they are.`),
    );
    if (result.failed.length > 0) {
      new Notice(`Could not put back ${result.failed.map(toBasename).join(", ")}. The console tells why.`);
    }
  }
}

/** Adds a line as it is replaced: each match struck out, and the replacement after it. */
function appendPieces(el: HTMLElement, pieces: Piece[]): void {
  for (const piece of pieces) {
    if (piece.kind === "same") {
      el.appendText(piece.text);
    } else {
      el.createSpan({ cls: `the-switcher-${piece.kind}`, text: piece.text });
    }
  }
}

/** "1 note", "2 notes" */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function toBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}
