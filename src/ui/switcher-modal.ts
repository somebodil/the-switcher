import {
  type App,
  debounce,
  type Debouncer,
  type Instruction,
  Keymap,
  type KeymapEventHandler,
  MarkdownView,
  type Modifier,
  Platform,
  setIcon,
  SuggestModal,
  type TFile,
  type WorkspaceLeaf,
} from "obsidian";
import { parseExcludeRules } from "../search/exclude.ts";
import type { KeptIndex } from "../search/file-index.ts";
import type { Range, Segment } from "../search/highlight.ts";
import { makeDraggable } from "./drag.ts";
import { dragHeight, dragWidth, type Layout, readLayout } from "./layout.ts";

/** Where a chosen result opens. */
export type Target = "current" | "tab";

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
  /** Name under which the size of the dialog is kept on this device */
  layoutKey: string;
  /**
   * What the dialog worked out for the files the last time it was open. With
   * it a dialog is ready sooner, and it brings it up to date for the next time.
   */
  kept: KeptIndex;
}

/** What a dialog is told by the plugin. The rest is up to the dialog. */
export type DialogOptions = Pick<
  SwitcherOptions,
  "excludeInput" | "saveExcludeInput" | "kept"
>;

export const MAX_RESULTS = 50;
/** How the keys that go with others are written in the instructions */
export const MOD_KEY = Platform.isMacOS ? "⌘" : "ctrl";
export const ALT_KEY = Platform.isMacOS ? "⌥" : "alt";
/** How long after the last keystroke the exclude input is saved */
const SAVE_DELAY_MS = 1000;
/** How much of the window stays free around a dialog that is as large as it gets */
const WINDOW_MARGIN = 16;

/** The handles that change the size of a dialog: which side they move, and if they move the lower side */
const RESIZE_HANDLES: { name: string; side?: "left" | "right"; lower?: boolean }[] =
  [
    { name: "left", side: "left" },
    { name: "right", side: "right" },
    { name: "bottom", lower: true },
    { name: "bottom-left", side: "left", lower: true },
    { name: "bottom-right", side: "right", lower: true },
  ];

/** The size of a dialog and the room it has, when a drag starts. */
interface Measures {
  width: number;
  height: number;
  /** True if the dialog is in the middle of the window, from left to right */
  centered: boolean;
  maxWidth: number;
  maxHeight: number;
}

/**
 * What the dialogs of the plugin share: the exclude input, the number of
 * results, the keys, and the two places a result can open in.
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
  /** The size that the dialog was given with the mouse */
  protected layout: Layout;
  private readonly layoutKey: string;

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
        // The row of a phone has no room for the whole sentence
        placeholder: Platform.isPhone
          ? "Exclude paths: regex, regex"
          : "Exclude paths by regex, separated by commas",
        spellcheck: "false",
        autocapitalize: "off",
      },
    });
    this.excludeEl.toggleClass("is-invalid", rules.hasInvalid);
    this.excludeEl.addEventListener("input", () => this.onExcludeInput());
    this.countEl = this.statusEl.createSpan({ cls: "the-switcher-count" });
    this.resultContainerEl.before(this.statusEl);

    this.bindKeys();

    this.layoutKey = options.layoutKey;
    this.layout = readLayout(app.loadLocalStorage(this.layoutKey));
    this.applyLayout();
    // A dialog of the mobile app is as large as the app makes it
    if (!Platform.isMobile) {
      this.addResizeHandles();
    }
  }

  /** Called when the valid patterns of the exclude input change. */
  protected abstract onExcludeChange(): void;

  /** Opens a result in the place that was asked for. */
  protected abstract openResult(result: T, target: Target): Promise<void>;

  override onOpen(): void {
    void super.onOpen();
    this.showInstructions();
    // On a phone, newer versions of Obsidian have the query under the results,
    // next to the keyboard. The exclude input goes there with it.
    const queryEl = this.inputEl.parentElement;
    this.modalEl.toggleClass(
      "mod-query-below",
      queryEl !== null && getComputedStyle(queryEl).order !== "0",
    );
  }

  override onClose(): void {
    super.onClose();
    this.saveSoon.cancel();
    this.persistExcludeInput();
  }

  onChooseSuggestion(result: T, evt: MouseEvent | KeyboardEvent): void {
    void this.openResult(result, targetOf(evt));
  }

  /** Searches again with the query that is in the input. */
  protected refresh(): void {
    this.inputEl.dispatchEvent(new Event("input"));
  }

  /** Moves the selection to the result before or after it, as the arrow keys do. */
  protected moveSelection(key: "ArrowUp" | "ArrowDown"): void {
    this.inputEl.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  /** Tells how many results are shown of how many there are. */
  protected show(results: T[], total: number): T[] {
    this.setStatus(`${results.length} / ${total}`);
    return results;
  }

  protected setStatus(text: string): void {
    this.countEl.setText(text);
  }

  /** Gives the dialog the size of the layout. The style sheet does the rest. */
  protected applyLayout(): void {
    const { split } = this.layout;
    // The width and the height are those of a window of the desktop app
    const { width, height } = Platform.isMobile ? ({} as Layout) : this.layout;
    this.setLayoutValue("--the-switcher-width", width, "px");
    this.setLayoutValue("--the-switcher-height", height, "px");
    this.setLayoutValue(
      "--the-switcher-split",
      split === undefined ? undefined : split * 100,
      "%",
    );
    this.modalEl.toggleClass("is-tall", height !== undefined);
  }

  /** Keeps the layout on this device. The size of a window is not for other devices. */
  protected saveLayout(): void {
    this.app.saveLocalStorage(this.layoutKey, this.layout);
  }

  private setLayoutValue(
    name: string,
    value: number | undefined,
    unit: string,
  ): void {
    if (value === undefined) {
      this.modalEl.style.removeProperty(name);
    } else {
      this.modalEl.setCssProps({ [name]: `${value}${unit}` });
    }
  }

  /** Adds what the mouse takes hold of to make the dialog wider or higher. */
  private addResizeHandles(): void {
    for (const { name, side, lower } of RESIZE_HANDLES) {
      const handleEl = this.modalEl.createDiv({
        cls: `the-switcher-resize mod-${name}`,
      });
      makeDraggable(handleEl, {
        start: () => this.measure(),
        move: (from, dx, dy) => {
          if (side) {
            this.layout.width = dragWidth(
              from.width,
              dx,
              side,
              from.centered,
              from.maxWidth,
            );
          }
          if (lower) {
            this.layout.height = dragHeight(from.height, dy, from.maxHeight);
          }
          this.applyLayout();
        },
        end: () => this.saveLayout(),
        reset: () => {
          if (side) {
            this.layout.width = undefined;
          }
          if (lower) {
            this.layout.height = undefined;
          }
          this.applyLayout();
          this.saveLayout();
        },
      });
    }
  }

  private measure(): Measures {
    const dialog = this.modalEl.getBoundingClientRect();
    const room = this.containerEl.getBoundingClientRect();
    const middle = (rect: DOMRect): number => rect.left + rect.width / 2;
    return {
      width: dialog.width,
      height: dialog.height,
      centered: Math.abs(middle(dialog) - middle(room)) < 1,
      maxWidth: room.width - 2 * WINDOW_MARGIN,
      maxHeight: room.bottom - dialog.top - WINDOW_MARGIN,
    };
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
    if (target === "current") {
      return workspace.getLeaf(false);
    }
    // A file that already has a tab is shown there instead of in a second tab
    return this.findTabOf(file) ?? workspace.getLeaf("tab");
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
    // A pattern that is not valid is left out and the others still apply, the
    // same as when the dialog opens. Otherwise one such pattern would keep
    // every later change from showing until the dialog is opened again.
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
      console.error("the-switcher: failed to save the exclude input", error);
    });
  }

  /** The keys that the row under the results tells of. */
  protected instructions(): Instruction[] {
    return [
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "open" },
      { command: `${MOD_KEY} ↵`, purpose: "new tab" },
      { command: `${MOD_KEY} E`, purpose: "exclude" },
      { command: `${MOD_KEY} S`, purpose: "search" },
      { command: "esc", purpose: "close" },
    ];
  }

  protected showInstructions(): void {
    this.setInstructions(this.instructions());
  }

  /** Gives a key of the dialog an action. A key pressed to finish composing a character (Korean, Japanese, ...) is not one. */
  protected registerKey(
    modifiers: Modifier[],
    key: string,
    action: (evt: KeyboardEvent) => void,
  ): void {
    this.scope.register(modifiers, key, (evt) => {
      if (evt.isComposing) {
        return;
      }
      action(evt);
      return false;
    });
  }

  private bindKeys(): void {
    this.releaseHomeAndEnd();
    // The key event has the modifier, which is what asks for a new tab
    this.registerKey(["Mod"], "Enter", (evt) => this.selectActiveSuggestion(evt));
    this.registerKey(["Mod"], "E", () => {
      this.excludeEl.focus();
      this.excludeEl.select();
    });
    this.registerKey(["Mod"], "S", () => this.inputEl.focus());
  }

  /**
   * Gives Home and End back to the inputs, where they move the cursor. The
   * list of results takes them to jump to its first and its last result.
   *
   * A scope hands a key to the handler that was registered first, so a handler
   * of this dialog could not get ahead of the ones of the list. They have to
   * be taken out, and the scope does not tell its handlers in the public API.
   */
  private releaseHomeAndEnd(): void {
    const { keys } = this.scope as unknown as { keys?: KeymapEventHandler[] };
    if (!Array.isArray(keys)) {
      return;
    }
    for (const handler of [...keys]) {
      if (
        (handler.key === "Home" || handler.key === "End") &&
        !handler.modifiers
      ) {
        this.scope.unregister(handler);
      }
    }
  }
}

/** A click or Enter opens in the current tab, and with the modifier key in a new tab. */
function targetOf(evt: MouseEvent | KeyboardEvent): Target {
  return Keymap.isModEvent(evt) === false ? "current" : "tab";
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
