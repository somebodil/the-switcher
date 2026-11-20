import {
  type App,
  debounce,
  type Debouncer,
  Keymap,
  type KeymapEventListener,
  MarkdownView,
  Platform,
  setIcon,
  SuggestModal,
  type TFile,
  type WorkspaceLeaf,
} from "obsidian";
import { parseExcludeRules } from "../search/exclude.ts";
import type { Range, Segment } from "../search/highlight.ts";

/** Where a chosen result opens. */
export type Target = "current" | "tab" | "below" | "right" | "window";

/** A place in a note to go to after it opens. */
export interface Place {
  /** Number of the line, starting at 0 */
  line: number;
  /** The part of the line to select */
  range?: Range;
}

export interface SwitcherOptions {
  placeholder: string;
  /** Comma-separated regular expressions of paths to hide */
  excludeInput: string;
  /** Keeps the exclude input for the next time */
  saveExcludeInput: (value: string) => Promise<void>;
}

export const MAX_RESULTS = 50;
/** How long after the last keystroke the exclude input is saved */
const SAVE_DELAY_MS = 1000;

/**
 * What the dialogs of the plugin share: the exclude input, the number of
 * results, the keys, and the places a result can open in.
 */
export abstract class SwitcherModal<T> extends SuggestModal<T> {
  /** The row between the query and the results */
  protected readonly statusEl: HTMLElement;
  private readonly excludeEl: HTMLInputElement;
  private readonly countEl: HTMLElement;
  private readonly saveExcludeInput: (value: string) => Promise<void>;
  private readonly saveSoon: Debouncer<[], void>;
  private savedExcludeInput: string;

  /** The valid patterns of the exclude input */
  protected excludePatterns: RegExp[];
  /** The results on screen, to open one by its number */
  protected shown: T[] = [];
  /** Set by a key that asks for a certain place, right before a result is chosen */
  private target: Target | null = null;

  constructor(app: App, options: SwitcherOptions) {
    super(app);
    this.savedExcludeInput = options.excludeInput;
    this.saveExcludeInput = options.saveExcludeInput;
    this.saveSoon = debounce(() => this.persistExcludeInput(), SAVE_DELAY_MS, true);

    this.modalEl.addClass("the-switcher");
    this.limit = MAX_RESULTS;
    this.setPlaceholder(options.placeholder);

    const rules = parseExcludeRules(options.excludeInput);
    this.excludePatterns = rules.patterns;

    this.statusEl = createDiv({ cls: "the-switcher-status" });
    setIcon(this.statusEl.createSpan({ cls: "the-switcher-icon" }), "ban");
    this.excludeEl = this.statusEl.createEl("input", {
      cls: "the-switcher-exclude",
      type: "text",
      value: options.excludeInput,
      attr: {
        placeholder: "Exclude paths by regex, separated by commas",
        spellcheck: "false",
        autocapitalize: "off",
      },
    });
    this.excludeEl.toggleClass("is-invalid", rules.hasInvalid);
    this.excludeEl.addEventListener("input", () => this.onExcludeInput());
    this.countEl = this.statusEl.createSpan({ cls: "the-switcher-count" });
    this.resultContainerEl.before(this.statusEl);

    this.bindKeys();
  }

  /** Called when the valid patterns of the exclude input change. */
  protected abstract onExcludeChange(): void;

  /** Opens a result in the place that was asked for. */
  protected abstract openResult(result: T, target: Target): Promise<void>;

  override onClose(): void {
    super.onClose();
    this.saveSoon.cancel();
    this.persistExcludeInput();
  }

  onChooseSuggestion(result: T, evt: MouseEvent | KeyboardEvent): void {
    const target = this.target ?? targetOf(evt);
    this.target = null;
    void this.openResult(result, target);
  }

  /** Searches again with the query that is in the input. */
  protected refresh(): void {
    this.inputEl.dispatchEvent(new Event("input"));
  }

  /** Remembers the results that are shown, and tells how many there are of how many. */
  protected show(results: T[], total: number): T[] {
    this.shown = results;
    this.setStatus(`${results.length} / ${total}`);
    return results;
  }

  protected setStatus(text: string): void {
    this.countEl.setText(text);
  }

  /** Adds the number that opens a result with a key, for the first nine results. */
  protected appendNumber(el: HTMLElement, result: T): void {
    const position = this.shown.indexOf(result);
    if (position >= 0 && position < 9) {
      el.createSpan({ cls: "the-switcher-number", text: String(position + 1) });
    }
  }

  /** Opens a file where it was asked for, and goes to a place in it if one is given. */
  protected async openFile(
    path: string,
    target: Target,
    place?: Place,
  ): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      // Deleted or renamed while the dialog was open
      return;
    }
    const leaf = this.leafFor(file, target);
    await leaf.openFile(file, {
      active: true,
      ...(place ? { eState: { line: place.line } } : {}),
    });

    if (place?.range && leaf.view instanceof MarkdownView) {
      const { editor } = leaf.view;
      const from = { line: place.line, ch: place.range.start };
      const to = { line: place.line, ch: place.range.end };
      editor.setSelection(from, to);
      editor.scrollIntoView({ from, to }, true);
    }
  }

  private leafFor(file: TFile, target: Target): WorkspaceLeaf {
    const { workspace } = this.app;
    switch (target) {
      case "current":
        return workspace.getLeaf(false);
      case "tab":
        // A file that already has a tab is shown there instead of in a second tab
        return this.findTabOf(file) ?? workspace.getLeaf("tab");
      case "below":
        return workspace.getLeaf("split", "horizontal");
      case "right":
        return workspace.getLeaf("split", "vertical");
      case "window":
        return workspace.getLeaf("window");
    }
  }

  /** Finds a tab that shows the file, leaving out the sidebars. */
  private findTabOf(file: TFile): WorkspaceLeaf | null {
    const { workspace } = this.app;
    let found: WorkspaceLeaf | null = null;
    workspace.iterateAllLeaves((leaf) => {
      const root = leaf.getRoot();
      if (
        found === null &&
        root !== workspace.leftSplit &&
        root !== workspace.rightSplit &&
        leaf.getViewState().state?.file === file.path
      ) {
        found = leaf;
      }
    });
    return found;
  }

  private onExcludeInput(): void {
    const rules = parseExcludeRules(this.excludeEl.value);
    this.excludeEl.toggleClass("is-invalid", rules.hasInvalid);
    this.saveSoon();
    if (rules.hasInvalid) {
      // A pattern is still being typed. The results stay as they are until it is valid.
      return;
    }
    this.excludePatterns = rules.patterns;
    this.onExcludeChange();
    this.refresh();
  }

  private persistExcludeInput(): void {
    const value = this.excludeEl.value;
    if (value === this.savedExcludeInput) {
      return;
    }
    this.savedExcludeInput = value;
    this.saveExcludeInput(value).catch((error: unknown) => {
      console.error("The Switcher: failed to save the exclude input", error);
    });
  }

  private bindKeys(): void {
    const mod = Platform.isMacOS ? "⌘" : "ctrl";
    this.setInstructions([
      { command: `↑↓ ${mod} P N`, purpose: "navigate" },
      { command: "↵", purpose: "open" },
      { command: `${mod} ↵`, purpose: "new tab" },
      { command: `${mod} -`, purpose: "split below" },
      { command: `${mod} I`, purpose: "split right" },
      { command: `${mod} O`, purpose: "new window" },
      { command: `${mod} 1-9`, purpose: "open by number" },
      { command: `${mod} E`, purpose: "exclude" },
      { command: "esc", purpose: "close" },
    ]);

    // A key pressed to finish composing a character (Korean, Japanese, ...) is not a hotkey
    const unlessComposing =
      (action: (evt: KeyboardEvent) => void): KeymapEventListener =>
      (evt) => {
        if (evt.isComposing) {
          return;
        }
        action(evt);
        return false;
      };
    const pressArrow = (key: "ArrowUp" | "ArrowDown") =>
      unlessComposing(() => {
        this.inputEl.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
      });
    const chooseFor = (target: Target) =>
      unlessComposing((evt) => {
        this.target = target;
        this.selectActiveSuggestion(evt);
      });

    this.scope.register(["Mod"], "P", pressArrow("ArrowUp"));
    this.scope.register(["Mod"], "N", pressArrow("ArrowDown"));
    this.scope.register(["Mod"], "Enter", chooseFor("tab"));
    this.scope.register(["Mod"], "-", chooseFor("below"));
    this.scope.register(["Mod"], "I", chooseFor("right"));
    this.scope.register(["Mod"], "O", chooseFor("window"));
    this.scope.register(
      ["Mod"],
      "E",
      unlessComposing(() => this.toggleExcludeFocus()),
    );
    for (let number = 1; number <= 9; number++) {
      this.scope.register(
        ["Mod"],
        String(number),
        unlessComposing((evt) => {
          const result = this.shown[number - 1];
          if (result !== undefined) {
            this.target = "current";
            this.selectSuggestion(result, evt);
          }
        }),
      );
    }
  }

  private toggleExcludeFocus(): void {
    if (this.excludeEl.ownerDocument.activeElement === this.excludeEl) {
      this.inputEl.focus();
    } else {
      this.excludeEl.focus();
      this.excludeEl.select();
    }
  }
}

/** A click or Enter opens in the current tab, unless the modifier keys ask for another place. */
function targetOf(evt: MouseEvent | KeyboardEvent): Target {
  switch (Keymap.isModEvent(evt)) {
    case false:
      return "current";
    case "split":
      return "right";
    case "window":
      return "window";
    default:
      return "tab";
  }
}

/** Adds a text to an element, with its highlighted parts in their own spans. */
export function appendSegments(el: HTMLElement, segments: Segment[]): void {
  for (const segment of segments) {
    if (segment.highlighted) {
      el.createSpan({ cls: "the-switcher-hit", text: segment.text });
    } else {
      el.appendText(segment.text);
    }
  }
}
