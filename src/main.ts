import { Platform, Plugin } from "obsidian";
import { NoteTexts } from "./note-texts.ts";
import { KeptIndex } from "./search/file-index.ts";
import { FileModal } from "./ui/file-modal.ts";
import { TextModal } from "./ui/text-modal.ts";

/** Everything the plugin keeps between sessions: what was typed into the exclude inputs. */
interface PluginData {
  /** Exclude input of the dialog that finds files */
  fileExclude: string;
  /** Exclude input of the dialog that finds text */
  textExclude: string;
}

/**
 * The icons of the two commands, by their names in the icon set of Obsidian.
 * The quick switcher of Obsidian has the file with the magnifier, so the one
 * for files is another.
 */
const FILE_ICON = "folder-search";
const TEXT_ICON = "text-search";

export default class TheSwitcherPlugin extends Plugin {
  private data: PluginData = { fileExclude: "", textExclude: "" };
  private readonly noteTexts = new NoteTexts();
  /** What each of the two dialogs worked out for the files the last time it was open, so that it is ready sooner the next time */
  private readonly keptFiles = new KeptIndex();
  private readonly keptNotes = new KeptIndex();

  override async onload(): Promise<void> {
    await this.readData();

    const goToFile = (): void => {
      new FileModal(this.app, { ...this.excludeOptions("fileExclude"), kept: this.keptFiles }).open();
    };
    const findInFiles = (): void => {
      new TextModal(this.app, this.noteTexts, { ...this.excludeOptions("textExclude"), kept: this.keptNotes }).open();
    };

    // The icon is what a command shows on the mobile toolbar. Without one the
    // two would look the same there.
    this.addCommand({
      id: "go-to-file",
      name: "Go to file",
      icon: FILE_ICON,
      callback: goToFile,
    });
    this.addCommand({
      id: "find-in-files",
      name: "Find in files",
      icon: TEXT_ICON,
      callback: findInFiles,
    });

    // A phone or a tablet has no hotkey, so there the dialogs get a place to
    // tap. On a computer the ribbon stays as it is.
    if (Platform.isMobile) {
      this.addRibbonIcon(FILE_ICON, "Go to file", goToFile);
      this.addRibbonIcon(TEXT_ICON, "Find in files", findInFiles);
    }
  }

  /**
   * Called by Obsidian when data.json is changed by something else: a sync, a
   * version control tool, an editor. Without it the old values would stay in
   * use, and the next save would write them over the change.
   */
  override async onExternalSettingsChange(): Promise<void> {
    await this.readData();
  }

  private async readData(): Promise<void> {
    const saved = (await this.loadData()) as
      | Partial<PluginData>
      | null
      | undefined;
    if (saved === undefined) {
      // The file is there but cannot be read, as when it is caught half
      // written. What was read before is better than nothing.
      return;
    }
    const read = (key: keyof PluginData): string => {
      const value = saved?.[key];
      return typeof value === "string" ? value : "";
    };
    this.data = { fileExclude: read("fileExclude"), textExclude: read("textExclude") };
  }

  private excludeOptions(key: keyof PluginData) {
    return {
      excludeInput: this.data[key],
      saveExcludeInput: async (value: string) => {
        this.data[key] = value;
        await this.saveData(this.data);
      },
    };
  }
}
