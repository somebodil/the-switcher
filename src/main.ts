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
    const saved = (await this.loadData()) as Partial<PluginData> | null;
    for (const key of ["fileExclude", "textExclude"] as const) {
      const value = saved?.[key];
      if (typeof value === "string") {
        this.data[key] = value;
      }
    }

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
