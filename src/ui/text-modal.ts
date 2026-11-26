import { type App, type Instruction, Notice, Platform, setIcon } from "obsidian";
import type { ChangeResult, NoteChange, NoteTexts, OnChangeProgress } from "../note-texts.ts";
import { FileIndex } from "../search/file-index.ts";
import { type Range, toSegments } from "../search/highlight.ts";
import { Matcher, sameQuery, type TextQuery } from "../search/matcher.ts";
import {
  countMatches,
  type Piece,
  replaceAll,
  Replacement,
  replaceInLine,
  swapsOf,
  toPieces,
} from "../search/replace.ts";
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

/** How the query is taken. The plugin keeps the switches as they were left until Obsidian is closed. */
export interface SearchSwitches {
  regex: boolean;
  matchCase: boolean;
}

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

  /** The paths to look in, in the order of the results */
  private paths: string[] = [];
  /** True while the row with the replacement is shown */
  private replacing: boolean;
  /** The replacement as it was read last */
  private replacementRead: Replacement | null = null;
  /** How many changes of notes are going on. Another replacement waits until none is. */
  private changing = 0;
  /** The result that the preview shows, or undefined when the preview is to be drawn anew */
  private previewed: LineMatch | null | undefined = null;
  private isReading = true;

  /** The search for the query, which may still be going on. Null for a query that is not valid or takes too long. */
  private search: TextSearch | null = null;
  /**
   * Resolves once the guard tried the regular expression of the search on all
   * of its notes: true if the search can go on to its end
   */
  private searchChecked: Promise<boolean> = Promise.resolve(true);
  /** The search whose regular expression the guard is trying on the notes */
  private checking: TextSearch | null = null;
  /** A query that the dialog gave up on, and why. It is not tried again until it changes. */
  private givenUp: { query: TextQuery; problem: string } | null = null;
  /** True while the dialog waits for the search to end, to ask whether to replace all */
  private isAsking = false;
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
    this.switches = options.switches;
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
    this.replaceInputEl.addEventListener("input", () => this.redraw());
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
    this.search = null;
    this.nextPart.port1.close();
    // The worker lets go of its copy of the texts
    this.texts.guard.stop();
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
    // Neither an Enter that is held down nor one during a replacement, as after the
    // one that said to replace all, opens a result by mistake
    if (evt.repeat || this.isChanging()) {
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
      this.emptyStateText = "Reading the notes...";
      this.setStatus("");
      this.updateReplaceButtons(0);
      return [];
    }
    const query: TextQuery = { text, ...this.switches };
    if (this.givenUp !== null && !sameQuery(this.givenUp.query, query)) {
      this.givenUp = null;
    }
    if (this.givenUp !== null) {
      return this.showProblem(this.givenUp.problem);
    }
    // The search itself asks for its results to be listed again when it finds more
    let { search } = this;
    if (search === null || !sameQuery(search.query, query)) {
      let matcher: Matcher;
      try {
        matcher = new Matcher(query);
      } catch (error: unknown) {
        this.search = null;
        return this.showProblem(`Not a valid regular expression: ${reasonOf(error)}`);
      }
      this.inputEl.removeClass("is-invalid");
      // A search that is dropped when the notes or the paths to look in change, so what it found still holds
      search = this.texts.index.searchOn(search, matcher, this.paths, MAX_RESULTS);
      this.startSearch(search);
      if (this.search !== search) {
        // The regular expression failed at once
        return this.getSuggestions(text);
      }
    }
    const { matches, total, done, matcher } = search;
    this.listed = matches.length;
    this.listedAt = performance.now();
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

  /** Shows what is wrong with the query, instead of results. */
  private showProblem(problem: string): LineMatch[] {
    this.inputEl.addClass("is-invalid");
    this.emptyStateText = problem;
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
      match.ranges,
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
    // The note where the regular expression took too long may be left out now
    this.givenUp = null;
  }

  protected openResult(match: LineMatch, target: Target): Promise<void> {
    return this.openFile(match.path, target, {
      line: match.line,
      range: match.ranges[0],
    });
  }

  private async readNotes(): Promise<void> {
    try {
      await this.texts.refresh(this.app);
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
   *
   * @returns false if the search was given up. The caller lists again.
   */
  private searchPart(search: TextSearch): boolean {
    const end = performance.now() + SEARCH_PART_MS;
    let notes = 0;
    if (!this.runSearch(search, () => ++notes % NOTES_PER_LOOK_AT_CLOCK === 0 && performance.now() >= end)) {
      return false;
    }
    if (search.isWaiting && this.checking !== search && this.search === search) {
      // A note changed since the guard tried the regular expression on it,
      // as when a replacement is undone from its notice
      this.startCheck(search);
    }
    // A search that waits for the guard goes on when the guard is done with more notes
    if (!search.done && !search.isWaiting && !this.isNextPartCalled) {
      this.isNextPartCalled = true;
      this.nextPart.port2.postMessage(null);
    }
    return true;
  }

  /**
   * Runs a search, until it is time for a pause if that is told. A regular
   * expression can fail on a line that is too long for it, which the guard
   * finds out first unless there is no worker. Then the dialog gives up on it.
   *
   * @returns false if the search was given up. The caller lists again.
   */
  private runSearch(search: TextSearch, isTimeForPause?: () => boolean): boolean {
    try {
      search.run(isTimeForPause, this.isReady(search));
      return true;
    } catch (error: unknown) {
      this.giveUp(search.query, `The regular expression cannot be matched: ${reasonOf(error)}`);
      return false;
    }
  }

  /** Stops searching for a query, to say why instead of showing results. The caller lists again. */
  private giveUp(query: TextQuery, problem: string): void {
    this.givenUp = { query, problem };
    this.search = null;
    this.checking = null;
  }

  /** Which notes a search may look at: for a regular expression, the ones the guard tried it on. Undefined for all. */
  private isReady(search: TextSearch): ((path: string) => boolean) | undefined {
    return search.query.regex ? this.texts.guard.checkedFor(search.query) : undefined;
  }

  /**
   * Makes a search the one of the dialog, and starts it. A regular expression
   * is tried by the guard first, and the search looks only at the notes that
   * the guard is done with.
   */
  private startSearch(search: TextSearch): void {
    this.search = search;
    this.startCheck(search);
    this.searchPart(search);
  }

  /** Has the guard try the regular expression of a search on its notes, and goes on with the search as it does. */
  private startCheck(search: TextSearch): void {
    const onProgress = (): void => {
      if (this.search === search) {
        this.searchOn();
      }
    };
    this.checking = search;
    this.searchChecked = this.check(search, onProgress).then((isChecked) => {
      if (this.checking === search) {
        this.checking = null;
      }
      if (isChecked) {
        onProgress();
      }
      return isChecked;
    });
  }

  /**
   * Has the guard try the regular expression of a search on its notes, where
   * it was not tried yet. When it takes too long or fails, the dialog says so.
   *
   * @param onProgress called when the guard is done with more of the notes
   * @returns true once the guard is done with all of the notes, and false if
   *   the search is to be given up: the regular expression takes too long or
   *   fails, or another search took its place
   */
  private async check(search: TextSearch, onProgress: () => void): Promise<boolean> {
    const { query } = search;
    if (!query.regex || search.done) {
      return true;
    }
    const result = await this.texts.guard.check(query, search.paths, onProgress);
    const isCurrent = this.search !== null && sameQuery(this.search.query, query);
    if (isCurrent && result.kind === "slow") {
      this.giveUp(
        query,
        `The regular expression takes too long in “${toBasename(result.path)}”. ` +
          "A repeat inside a repeat, as in (\\w+\\s?)+, can try a vast number of ways to match.",
      );
      this.listAgain();
    } else if (isCurrent && result.kind === "failed") {
      this.giveUp(query, `The regular expression cannot be matched in “${toBasename(result.path)}”: ${result.reason}`);
      this.listAgain();
    }
    return result.kind === "fast";
  }

  /** Goes on with the search, and shows what it found. */
  private searchOn(): void {
    const { search } = this;
    if (!search || search.done) {
      return;
    }
    if (!this.searchPart(search)) {
      this.listAgain();
      return;
    }

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

  /** Shows the results and the preview again, as when the replacement, the mode or a switch changes. */
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
   * @param ranges where the matches are, if that is known
   */
  private appendLine(el: HTMLElement, line: string, isPreview: boolean, ranges?: Range[]): void {
    const matcher = this.search?.matcher;
    const length = isPreview ? PREVIEW_LINE_LENGTH : SNIPPET_LENGTH;
    if (!matcher) {
      el.appendText(toSnippet(line, [], length, isPreview).text);
    } else if (this.replacing) {
      // How a line break looks does not depend on its kind
      const swaps = swapsOf(line, matcher, this.replacement(), "\n");
      const snippet = toSnippet(line, swaps, length, isPreview);
      appendPieces(el, toPieces(snippet.text, snippet.ranges));
    } else {
      const snippet = toSnippet(line, ranges ?? matcher.findAll(line), length, isPreview);
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
    // The input that is typed in keeps the focus, and on a touch screen the keyboard stays
    switchEl.addEventListener("mousedown", (evt) => evt.preventDefault());
    switchEl.addEventListener("click", action);
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
    // The input that is typed in keeps the focus, and on a touch screen the keyboard stays
    buttonEl.addEventListener("mousedown", (evt) => evt.preventDefault());
    buttonEl.addEventListener("click", action);
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
    this.redraw();
  }

  /** Replaces the matches in the selected line. */
  private async replaceSelected(): Promise<void> {
    const match = this.selectedMatch();
    const matcher = this.search?.matcher;
    if (!this.replacing || this.isChanging() || !match || !matcher) {
      return;
    }
    const replacement = this.replacement();
    const counts = new Map<string, number>();
    const stale = new Set<string>();
    const result = await this.changeNotes(
      "Replacing",
      () =>
        this.texts.change(this.app, [match.path], (text, path) => {
          const replaced = replaceInLine(text, match.line, match.text, matcher, replacement);
          if (replaced === null) {
            stale.add(path);
            return null;
          }
          counts.set(path, replaced.count);
          return replaced.text;
        }),
      true,
      match,
    );
    if (stale.size > 0) {
      new Notice(`${toBasename(match.path)} was changed since it was read, and nothing was replaced. The results show it as it is now.`);
    }
    // A replacement that leaves the line as it was changes nothing, and the selection goes on to the next result
    this.announce(result, counts);
  }

  /** Asks whether to replace the matches in all notes that have them, and does so if told to. */
  private async askToReplaceAll(): Promise<void> {
    if (!this.replacing || this.isChanging() || this.isAsking || !this.search || this.search.matcher.isEmpty) {
      return;
    }
    // Every note has to be looked at to know what will be replaced
    this.isAsking = true;
    let search: TextSearch | null;
    try {
      search = await this.searchToTheEnd();
    } finally {
      this.isAsking = false;
    }
    if (!search) {
      return;
    }
    const { matcher } = search;
    const paths = search.found.slice();
    // The texts that the guard tried a regular expression on, and that are counted
    const texts = new Map(paths.map((path) => [path, this.texts.index.get(path) ?? ""]));
    let count = 0;
    for (const text of texts.values()) {
      count += countMatches(text, matcher);
    }
    if (count === 0) {
      return;
    }
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
        void this.replaceAll(paths, matcher, replacement, matcher.query.regex ? texts : null);
      },
    }).open();
  }

  /**
   * Runs the search of the dialog to its end. A regular expression is tried by
   * the guard first on every note as the note is now: a note can have changed
   * since, as when a replacement is undone from its notice.
   *
   * @returns the search, or null if it was given up or another took its place
   */
  private async searchToTheEnd(): Promise<TextSearch | null> {
    let { search } = this;
    let hasRun = false;
    while (search !== null) {
      if (!(await this.searchChecked) || this.search !== search || this.isChanging()) {
        return null;
      }
      const isReady = this.isReady(search);
      if (search.done && isReady !== undefined && !search.paths.every(isReady)) {
        // What the search found may not hold any more
        this.startSearch(this.texts.index.searchOn(null, search.matcher, this.paths, MAX_RESULTS));
        search = this.search;
      } else if (search.done) {
        if (hasRun) {
          this.listAgain();
        }
        return search;
      } else if (this.runSearch(search)) {
        hasRun = true;
        if (search.isWaiting) {
          // A note changed since the guard tried the regular expression on it
          this.startCheck(search);
        }
      } else {
        search = null;
      }
    }
    // Given up: the list says why
    this.listAgain();
    return null;
  }

  /**
   * Replaces the matches in all of the given notes.
   *
   * @param checked for a regular expression, the texts that the guard tried it
   *   on. A note that has another text now, as after a sync, is left as it is:
   *   on a new line the regular expression could take too long.
   */
  private async replaceAll(
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
          this.app,
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
      true,
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
   * @param narrow true if only the notes that the search found can have its query
   *   afterwards. That holds for a replacement, which changes only those, while the query is the same.
   * @param replaced the result that is replaced, if it is one result
   */
  private async changeNotes(
    action: string,
    change: (onProgress: OnChangeProgress) => Promise<ChangeResult>,
    narrow: boolean,
    replaced?: LineMatch,
  ): Promise<ChangeResult> {
    const before = this.search;
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
        await this.searchAgain(narrow && this.search === before ? before : null, replaced);
      } finally {
        this.changing--;
        this.updateReplaceButtons(this.search?.matches.length ?? 0);
      }
    }
  }

  /**
   * Searches anew, now that notes were changed.
   *
   * @param within a search whose notes are the only ones that can have the query, or null to look at all of them
   */
  private async searchAgain(within: TextSearch | null, replaced?: LineMatch): Promise<void> {
    const current = this.search;
    if (!this.containerEl.isConnected) {
      // Closed: the next dialog reads the notes as they are now
      return;
    }
    if (!current) {
      this.listAgain();
      return;
    }
    const search = this.texts.index.searchOn(within, current.matcher, this.paths, MAX_RESULTS);
    // The list stays as it is while the guard tries a regular expression on
    // the changed notes, so that the selection can stay where it was
    if (!(await this.check(search, () => undefined)) || this.search !== current) {
      return;
    }
    this.search = search;
    this.searchChecked = Promise.resolve(true);
    // Far enough for the selection to stay where it was, and for the result
    // after it, which is selected when the replaced one is still there
    const enough = Math.min(this.selectedIndex() + 2, MAX_RESULTS);
    if (!this.runSearch(search, () => search.matches.length >= enough) || !this.searchPart(search)) {
      this.listAgain();
      return;
    }
    this.previewed = undefined;
    this.listAgain(replaced);
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
      (onProgress) => this.texts.undo(this.app, changes, onProgress),
      false,
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

/** What is wrong with a regular expression, as the error that the pattern gave tells it. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // "Invalid regular expression: /(/giu: Unterminated group"
  return message.slice(message.lastIndexOf(": ") + 1).trim();
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
