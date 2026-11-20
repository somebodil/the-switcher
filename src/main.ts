import { Plugin } from "obsidian";
import { NoteTexts } from "./note-texts.ts";
import { FileModal } from "./ui/file-modal.ts";
import { TextModal } from "./ui/text-modal.ts";

/** Everything the plugin keeps between sessions: what was typed into the exclude inputs. */
interface PluginData {
  /** Exclude input of the dialog that finds files */
  fileExclude: string;
  /** Exclude input of the dialog that finds text */
  textExclude: string;
}

export default class TheSwitcherPlugin extends Plugin {
  private data: PluginData = { fileExclude: "", textExclude: "" };
  private readonly noteTexts = new NoteTexts();

  override async onload(): Promise<void> {
    await this.readData();

    this.addCommand({
      id: "go-to-file",
      name: "Go to file",
      callback: () => {
        new FileModal(this.app, this.excludeOptions("fileExclude")).open();
      },
    });
    this.addCommand({
      id: "find-in-files",
      name: "Find in files",
      callback: () => {
        new TextModal(
          this.app,
          this.noteTexts,
          this.excludeOptions("textExclude"),
        ).open();
      },
    });
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
    const saved = (await this.loadData()) as Partial<PluginData> | null;
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
