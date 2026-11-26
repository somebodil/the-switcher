import { type App, type Instruction, Notice, Platform, setIcon } from "obsidian";
import type { ChangeResult, NoteChange, NoteTexts, OnChangeProgress } from "../note-texts.ts";
import { FileIndex } from "../search/file-index.ts";
import { toSegments } from "../search/highlight.ts";
import type { Matcher, TextQuery } from "../search/matcher.ts";
import {
  type Piece,
  replaceAll,
  Replacement,
  replaceInLine,
  swapsOf,
  toPieces,
} from "../search/replace.ts";
import { type Counted, type Problem, SearchRunner } from "../search/search-runner.ts";
import { type LineMatch, type TextSearch, toSnippet } from "../search/text-index.ts";
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
/** How many characters of a line the preview shows. A longer line is cut around its first match. */
const PREVIEW_LINE_LENGTH = 1000;
/** How many characters of the query and of the replacement the question before replacing all shows */
const QUESTION_TEXT_LENGTH = 80;
/** How many names of notes a notice gives before it only counts the rest */
const NAMES_IN_NOTICE = 3;
/** How long the notice that tells of a replacement, and can undo it, stays */
const UNDO_NOTICE_MS = 10_000;

/** The notes are put in order by their names only, so none of them is given aliases */
const NO_ALIASES: string[] = [];

/** How the query is taken. The plugin keeps the switches as they were left until Obsidian is closed. */
export type SearchSwitches = Pick<TextQuery, "regex" | "matchCase">;

export interface TextDialogOptions extends DialogOptions {
  /** True to open the dialog with the input for the replacement */
  replacing: boolean;
  switches: SearchSwitches;
}

/**
 * A dialog that finds a text in the notes and opens a note at the line that
 * has it. It can replace the text as well, in one line or in all notes.
 */
export class TextModal extends SwitcherModal<LineMatch> {
  private readonly texts: NoteTexts;
  /** The notes, for the order of the results and for the exclude patterns */
  private readonly notes: FileIndex;
  private readonly switches: SearchSwitches;
  private readonly regexEl: HTMLElement;
  private readonly matchCaseEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  /** The input for the replacement, in a row under the query */
  private readonly replaceInputEl: HTMLInputElement;
  private readonly replaceButtonEls: HTMLButtonElement[] = [];
  /** Which result each element of the list shows, to preview the selected one */
  private readonly resultOf = new WeakMap<Element, LineMatch>();
  private readonly selectionObserver: MutationObserver;
  /** The search for the query */
  private readonly runner: SearchRunner;

  /** True while the row with the replacement is shown */
  private replacing: boolean;
  /** The replacement as it was read last */
  private replacementRead: Replacement | null = null;
  /** How many changes of notes are going on. Another replacement waits until none is. */
  private changing = 0;
  /** The result that the preview shows, or undefined when the preview is to be drawn anew */
  private previewed: LineMatch | null | undefined = null;
  private isReading = true;
  /**
   * True while the dialog gets ready to ask whether to replace all: the
   * search goes on to its end, and the matches are counted
   */
  private isAsking = false;

  constructor(app: App, texts: NoteTexts, options: TextDialogOptions) {
    super(app, {
      ...options,
      placeholder: "Find text in notes",
      layoutKey: "the-switcher-find-layout",
    });
    this.modalEl.addClass("the-switcher-text");
    this.texts = texts;
    this.switches = options.switches;
    this.replacing = options.replacing;
    this.modalEl.toggleClass("mod-replace", this.replacing);
    this.runner = new SearchRunner(
      texts.index,
      texts.guard,
      {
        listAgain: () => this.listAgain(),
        showTotal: (listed, total) => this.setStatus(`${listed} / ${total}`),
      },
      MAX_RESULTS,
    );

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

    // The switches, in the input of the query
    const switchesEl = (this.inputEl.parentElement ?? this.modalEl).createDiv({
      cls: "the-switcher-switches",
    });
    this.matchCaseEl = this.addSwitch(switchesEl, "case-sensitive", `Match case (${ALT_KEY} C)`, () => {
      this.flip("matchCase");
    });
    this.regexEl = this.addSwitch(switchesEl, "regex", `Regular expression (${ALT_KEY} R)`, () => {
      this.flip("regex");
    });

    // The replacement, between the query and the exclude input
    const replaceEl = createDiv({ cls: "the-switcher-replace" });
    this.statusEl.before(replaceEl);
    setIcon(replaceEl.createSpan({ cls: "the-switcher-icon" }), "replace");
    this.replaceInputEl = replaceEl.createEl("input", {
      cls: "the-switcher-replace-input",
      type: "text",
      attr: { spellcheck: "false", autocapitalize: "off" },
    });
    this.replaceInputEl.addEventListener("input", () => this.redrawLines());
    this.addReplaceButton(replaceEl, "Replace", `Replace in the selected line (${ALT_KEY} ↵)`, () => {
      void this.replaceSelected();
    });
    this.addReplaceButton(replaceEl, "Replace all", `Replace in all notes (${MOD_KEY} ${ALT_KEY} ↵)`, () => {
      void this.askToReplaceAll();
    });
    this.showSwitches();

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
    this.registerKey(["Alt"], "R", () => this.flip("regex"));
    this.registerKey(["Alt"], "C", () => this.flip("matchCase"));
    this.registerKey(["Alt"], "Enter", () => {
      void this.replaceSelected();
    });
    this.registerKey(["Mod", "Alt"], "Enter", () => {
      void this.askToReplaceAll();
    });
  }

  override onOpen(): void {
    super.onOpen();
    void this.readNotes();
  }

  override onClose(): void {
    super.onClose();
    this.selectionObserver.disconnect();
    this.runner.stop();
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
    // The keys of the switches are in their tooltips. With them, this row would not fit in one line.
    return instructions;
  }

  /** Enter in the replacement replaces in the selected line, and elsewhere opens the selected result. */
  protected override onEnter(evt: KeyboardEvent): void {
    // Neither an Enter that is held down nor one that is meant for the question of
    // Replace all, or comes during a replacement, opens a result by mistake
    if (evt.repeat || this.isChanging() || this.isAsking) {
      return;
    }
    if (this.replacing && activeDocument.activeElement === this.replaceInputEl) {
      void this.replaceSelected();
      return;
    }
    super.onEnter(evt);
  }

  getSuggestions(text: string): LineMatch[] {
    if (this.isReading) {
      return this.showNothing("Reading the notes...");
    }
    // The search goes on by itself, and lists again when it found more
    const results = this.runner.resultsFor({ text, ...this.switches });
    if ("problem" in results) {
      this.inputEl.addClass("is-invalid");
      return this.showNothing(describe(results.problem));
    }
    this.inputEl.removeClass("is-invalid");
    const { matches, total, done, matcher } = results.search;
    if (!done) {
      this.emptyStateText = "Searching...";
    } else if (matcher.isEmpty) {
      this.emptyStateText = "Type the text to find.";
    } else {
      this.emptyStateText = "No results found.";
    }
    this.setStatus(`${matches.length} / ${done ? total : "..."}`);
    this.updateReplaceButtons(matches.length);
    // The search adds to its matches. The list gets the ones there are now.
    return matches.slice();
  }

  /** Shows a text instead of results, as what is wrong with the query. */
  private showNothing(text: string): LineMatch[] {
    this.emptyStateText = text;
    this.setStatus("");
    this.updateReplaceButtons(0);
    return [];
  }

  renderSuggestion(match: LineMatch, el: HTMLElement): void {
    this.resultOf.set(el, match);
    el.addClass("mod-complex");

    const contentEl = el.createDiv({ cls: "suggestion-content" });
    this.appendLine(
      contentEl.createDiv({ cls: "suggestion-title the-switcher-line" }),
      match.text,
      false,
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
    this.runner.lookIn(this.notes.search([]).map((hit) => hit.entry.file.path));
  }

  protected openResult(match: LineMatch, target: Target): Promise<void> {
    return this.openFile(match.path, target, {
      line: match.line,
      range: match.first,
    });
  }

  private async readNotes(): Promise<void> {
    try {
      await this.texts.refresh();
    } catch (error: unknown) {
      console.error("the-switcher: failed to read the notes", error);
    }
    this.isReading = false;
    // A dialog that was closed meanwhile starts no search, which would leave the texts with the worker
    if (this.containerEl.isConnected) {
      this.refresh();
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

  /** Shows the results and the preview again, as when a switch changes. */
  private redraw(): void {
    this.previewed = undefined;
    this.listAgain();
  }

  /**
   * Draws the lines of the results and of the preview again, for the results
   * that are listed, as when the replacement or the mode changes. The list and
   * the selection stay as they are.
   */
  private redrawLines(): void {
    for (const el of Array.from(this.resultContainerEl.children)) {
      const match = this.resultOf.get(el);
      const lineEl = el.querySelector<HTMLElement>(".the-switcher-line");
      if (match && lineEl) {
        lineEl.empty();
        this.appendLine(lineEl, match.text, false);
      }
    }
    this.previewed = undefined;
    this.updatePreview();
  }

  /** The place of the selected result in the list, or -1 if none is */
  private selectedIndex(): number {
    return Array.from(this.resultContainerEl.children).findIndex((el) =>
      el.hasClass("is-selected"),
    );
  }

  /** The result at a place in the list, or null if there is none */
  private matchAt(index: number): LineMatch | null {
    const el = this.resultContainerEl.children.item(index);
    return (el && this.resultOf.get(el)) ?? null;
  }

  private updatePreview(): void {
    if (Platform.isPhone) {
      // A phone has no room for the preview, and no key that moves the selection
      return;
    }
    const match = this.matchAt(this.selectedIndex());
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
      this.appendLine(lineEl.createSpan({ cls: "the-switcher-preview-text" }), text, true);
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

  /**
   * Adds a line with its matches highlighted, or while replacing, with each
   * match and what takes its place. A long line is cut around its first match.
   *
   * @param isPreview true for a line of the preview, which keeps the
   *   indentation and more of a long line than a result does
   */
  private appendLine(el: HTMLElement, line: string, isPreview: boolean): void {
    const matcher = this.runner.search?.matcher;
    const length = isPreview ? PREVIEW_LINE_LENGTH : SNIPPET_LENGTH;
    // The matches past the part of a long line that is shown are not looked
    // for: a line of an image pasted into a note can have tens of thousands
    const span = 2 * length;
    if (!matcher) {
      el.appendText(toSnippet(line, [], length, isPreview).text);
    } else if (this.replacing) {
      // How a line break looks does not depend on its kind
      const swaps = swapsOf(line, matcher, this.replacement(), "\n", span);
      const snippet = toSnippet(line, swaps, length, isPreview);
      appendPieces(el, toPieces(snippet.text, snippet.ranges));
    } else {
      const snippet = toSnippet(line, matcher.findAll(line, span), length, isPreview);
      appendSegments(el, toSegments(snippet.text, snippet.ranges));
    }
  }

  /** The replacement as it is typed, read for the way the query is taken. */
  private replacement(): Replacement {
    const typed = this.replaceInputEl.value;
    const { regex } = this.switches;
    if (this.replacementRead?.typed !== typed || this.replacementRead.isTemplate !== regex) {
      this.replacementRead = new Replacement(typed, regex);
    }
    return this.replacementRead;
  }

  private addSwitch(
    parentEl: HTMLElement,
    icon: string,
    tooltip: string,
    action: () => void,
  ): HTMLElement {
    const switchEl = parentEl.createDiv({
      cls: "clickable-icon the-switcher-switch",
      attr: { "aria-label": tooltip, role: "button" },
    });
    setIcon(switchEl, icon);
    onClickKeepingFocus(switchEl, action);
    return switchEl;
  }

  /** Turns a switch on or off, and searches again. */
  private flip(name: keyof SearchSwitches): void {
    this.switches[name] = !this.switches[name];
    this.showSwitches();
    this.redraw();
  }

  private showSwitches(): void {
    const { regex, matchCase } = this.switches;
    for (const [switchEl, on] of [
      [this.regexEl, regex],
      [this.matchCaseEl, matchCase],
    ] as const) {
      switchEl.toggleClass("is-active", on);
      switchEl.setAttribute("aria-pressed", String(on));
    }
    this.replaceInputEl.placeholder = regex
      ? "Replace with: \\1 or $1 for a group, & for the match"
      : "Replace with";
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
    onClickKeepingFocus(buttonEl, action);
    this.replaceButtonEls.push(buttonEl);
  }

  private updateReplaceButtons(listed: number): void {
    for (const buttonEl of this.replaceButtonEls) {
      buttonEl.disabled = listed === 0 || this.isChanging();
    }
  }

  private isChanging(): boolean {
    return this.changing > 0;
  }

  /** Shows or hides the row with the replacement, and goes to the input that is left. */
  private toggleReplacing(): void {
    this.replacing = !this.replacing;
    this.modalEl.toggleClass("mod-replace", this.replacing);
    this.showInstructions();
    (this.replacing ? this.replaceInputEl : this.inputEl).focus();
    this.redrawLines();
  }

  /** Replaces the matches in the selected line. */
  private async replaceSelected(): Promise<void> {
    const match = this.matchAt(this.selectedIndex());
    const { search } = this.runner;
    // Not while Replace all gets ready to ask: what it counted would not hold
    if (!this.replacing || this.isChanging() || this.isAsking || !match || !search) {
      return;
    }
    const { matcher } = search;
    const replacement = this.replacement();
    const counts = new Map<string, number>();
    let isStale = false;
    const result = await this.changeNotes(
      "Replacing",
      () =>
        this.texts.change([match.path], (text, path) => {
          const replaced = replaceInLine(text, match.line, match.text, matcher, replacement);
          if (replaced === null) {
            isStale = true;
            return null;
          }
          counts.set(path, replaced.count);
          return replaced.text;
        }),
      search,
      match,
    );
    if (isStale) {
      new Notice(`${toBasename(match.path)} was changed since it was read, and nothing was replaced. The results show it as it is now.`);
    }
    // A replacement that leaves the line as it was changes nothing, and the selection goes on to the next result
    this.announce(result, counts);
  }

  /** Asks whether to replace the matches in all notes that have them, and does so if told to. */
  private async askToReplaceAll(): Promise<void> {
    const searched = this.runner.search;
    if (!this.replacing || this.isChanging() || this.isAsking || !searched || searched.matcher.isEmpty) {
      return;
    }
    // Every note has to be looked at, and every match counted, to know what will be replaced
    this.isAsking = true;
    let search: TextSearch | null;
    let counted: Counted | null = null;
    try {
      search = await this.runner.searchToTheEnd(() => this.isChanging());
      if (search) {
        this.setStatus("Counting...");
        counted = await this.runner.count(search);
      }
    } finally {
      this.isAsking = false;
    }
    // A change that started meanwhile, as an Undo from a notice, makes what was counted not hold
    if (!search || !counted || this.isChanging()) {
      return;
    }
    this.setStatus(`${search.matches.length} / ${search.total}`);
    const { texts, count } = counted;
    if (count === 0) {
      return;
    }
    const { matcher } = search;
    const paths = [...texts.keys()];
    const replacement = this.replacement();
    const matches = plural(count, "match", "matches");
    const { text, regex } = matcher.query;
    const what = regex ? `/${shorten(text)}/` : `“${shorten(text)}”`;
    const where = plural(paths.length, "note");
    new ConfirmModal(this.app, {
      title: "Replace all",
      message:
        replacement.typed === ""
          ? `Remove ${matches} of ${what} from ${where}?`
          : `Replace ${matches} of ${what} with “${shorten(replacement.typed)}” in ${where}?`,
      action: "Replace all",
      onConfirm: () => {
        void this.replaceInNotes(paths, matcher, replacement, regex ? texts : null);
      },
    }).open();
  }

  /**
   * Replaces the matches in all of the given notes.
   *
   * @param checked for a regular expression, the texts that the guard tried it
   *   on. A note that has another text now, as after a sync, is left as it is:
   *   on a new line the regular expression could take too long.
   */
  private async replaceInNotes(
    paths: string[],
    matcher: Matcher,
    replacement: Replacement,
    checked: ReadonlyMap<string, string> | null,
  ): Promise<void> {
    const counts = new Map<string, number>();
    const changed: string[] = [];
    const result = await this.changeNotes(
      "Replacing",
      (onProgress) =>
        this.texts.change(
          paths,
          (text, path) => {
            if (checked !== null && text !== checked.get(path)) {
              changed.push(path);
              return null;
            }
            const replaced = replaceAll(text, matcher, replacement);
            counts.set(path, replaced.count);
            return replaced.count === 0 ? null : replaced.text;
          },
          onProgress,
        ),
      this.runner.search,
    );
    if (changed.length > 0) {
      const one = changed.length === 1;
      new Notice(
        `Nothing was replaced in ${names(changed)}: ${one ? "it was" : "they were"} changed since the search. ` +
          `The results show ${one ? "it as it is" : "them as they are"} now.`,
      );
    }
    this.announce(result, counts);
  }

  /**
   * Changes notes, and lists the results again for what the notes have now.
   *
   * @param action what the row under the query tells meanwhile, with how many
   *   of the notes are done. In a large vault it takes a while.
   * @param within the search whose notes are the only ones that can have its
   *   query afterwards, or null. That holds for a replacement, which changes
   *   only those, as long as the search is still the one of the dialog.
   * @param replaced the result that is replaced, if it is one result
   */
  private async changeNotes(
    action: string,
    change: (onProgress: OnChangeProgress) => Promise<ChangeResult>,
    within: TextSearch | null,
    replaced?: LineMatch,
  ): Promise<ChangeResult> {
    this.changing++;
    this.updateReplaceButtons(0);
    this.setStatus(`${action}...`);
    try {
      return await change((done, total) => {
        if (total > 1 && this.isChanging()) {
          this.setStatus(`${action}: ${done} of ${total} notes`);
        }
      });
    } finally {
      try {
        await this.searchAgain(this.runner.search === within ? within : null, replaced);
      } finally {
        this.changing--;
        this.updateReplaceButtons(this.runner.search?.matches.length ?? 0);
      }
    }
  }

  /**
   * Searches anew, now that notes were changed, and lists the results with
   * the selection where it was.
   *
   * @param within a search whose notes are the only ones that can have the query, or null to look at all of them
   * @param replaced the result that was replaced, if it was one result
   */
  private async searchAgain(within: TextSearch | null, replaced?: LineMatch): Promise<void> {
    if (!this.containerEl.isConnected) {
      // Closed: the next dialog reads the notes as they are now
      return;
    }
    // Far enough for the selection to stay where it was, and for the result
    // after it, which is selected when the replaced one is still there
    const enough = (): number => Math.min(this.selectedIndex() + 2, MAX_RESULTS);
    if (await this.runner.searchAgain(within, enough)) {
      this.previewed = undefined;
      this.listAgain(replaced);
    }
  }

  /** Tells what was replaced, with a button that puts it back. */
  private announce(result: ChangeResult, counts: ReadonlyMap<string, number>): void {
    this.reportProblems(result, "replace in");
    const { changes } = result;
    if (changes.length === 0) {
      return;
    }
    // A note that the replacement left as it was is not counted
    let count = 0;
    for (const { path } of changes) {
      count += counts.get(path) ?? 0;
    }
    const where = changes.length === 1 ? toBasename(changes[0].path) : plural(changes.length, "note");
    const notice = new Notice("", UNDO_NOTICE_MS);
    let isUndone = false;
    notice.setMessage(
      createFragment((el) => {
        el.appendText(`Replaced ${plural(count, "match", "matches")} in ${where}.`);
        el.createEl("button", { cls: "the-switcher-undo", text: "Undo" }).addEventListener("click", () => {
          notice.hide();
          if (!isUndone) {
            isUndone = true;
            void this.undo(changes);
          }
        });
      }),
    );
  }

  private async undo(changes: NoteChange[]): Promise<void> {
    // What is put back can have the query in any of the notes
    const result = await this.changeNotes(
      "Putting back",
      (onProgress) => this.texts.undo(changes, onProgress),
      null,
    );
    this.reportProblems(result, "put back");
    const kept = changes.length - result.changes.length - result.failed.length - result.missing.length;
    new Notice(
      `Put back ${plural(result.changes.length, "note")}.` +
        (kept === 0 ? "" : kept === 1
          ? " 1 note was changed again since, and is left as it is."
          : ` ${kept} notes were changed again since, and are left as they are.`),
    );
  }

  /** Tells of the notes that could not be changed. */
  private reportProblems({ failed, missing }: ChangeResult, action: string): void {
    if (missing.length > 0) {
      new Notice(`Could not ${action} ${names(missing)}: ${missing.length === 1 ? "it is" : "they are"} not in the vault any more.`);
    }
    if (failed.length > 0) {
      new Notice(`Could not ${action} ${names(failed)}. The console tells why.`);
    }
  }
}

/** Tells why a query has no results. */
function describe(problem: Problem): string {
  switch (problem.kind) {
    case "invalid":
      return `Not a valid regular expression: ${problem.reason}`;
    case "slow":
      return (
        `The regular expression takes too long in “${toBasename(problem.path)}”. ` +
        "A repeat inside a repeat, as in (\\w+\\s?)+, can try a vast number of ways to match."
      );
    case "failed":
      return problem.path === null
        ? `The regular expression cannot be matched: ${problem.reason}`
        : `The regular expression cannot be matched in “${toBasename(problem.path)}”: ${problem.reason}`;
  }
}

/**
 * Calls an action when an element is clicked, and leaves the focus where it
 * is: in the input that is typed in, and on a touch screen with the keyboard up.
 */
function onClickKeepingFocus(el: HTMLElement, action: () => void): void {
  el.addEventListener("mousedown", (evt) => evt.preventDefault());
  el.addEventListener("click", action);
}

/** Adds a line as it is replaced: each match struck out, and the replacement after it. */
function appendPieces(el: HTMLElement, pieces: Piece[]): void {
  for (const piece of pieces) {
    if (piece.kind === "same") {
      el.appendText(piece.text);
    } else {
      el.createSpan({
        cls: `the-switcher-${piece.kind}`,
        // A line break that the replacement puts in is shown as a sign
        text: piece.kind === "new" ? piece.text.replace(/\r?\n/g, "↵") : piece.text,
      });
    }
  }
}

/** A text cut short for a question, with an ellipsis where it was cut. */
function shorten(text: string): string {
  const characters = Array.from(text);
  return characters.length <= QUESTION_TEXT_LENGTH
    ? text
    : `${characters.slice(0, QUESTION_TEXT_LENGTH - 1).join("")}…`;
}

/** The names of notes for a notice. Of many notes, the first ones are named and the rest counted. */
function names(paths: readonly string[]): string {
  const named = paths.slice(0, NAMES_IN_NOTICE).map(toBasename).join(", ");
  return paths.length > NAMES_IN_NOTICE ? `${named} and ${paths.length - NAMES_IN_NOTICE} more` : named;
}

/** "1 note", "2 notes" */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function toBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}
