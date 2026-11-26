import { type App, Modal } from "obsidian";

export interface ConfirmOptions {
  title: string;
  /** What will be done, as a question */
  message: string;
  /** The text of the button that does it */
  action: string;
  onConfirm: () => void;
}

/**
 * A dialog that asks before something is done. Enter does it, and Esc goes
 * back to where the question was asked.
 */
export class ConfirmModal extends Modal {
  private readonly options: ConfirmOptions;

  constructor(app: App, options: ConfirmOptions) {
    super(app);
    this.options = options;
  }

  override onOpen(): void {
    const { title, message, action, onConfirm } = this.options;
    this.setTitle(title);
    this.contentEl.createEl("p", { text: message });
    const buttonsEl = this.contentEl.createDiv({ cls: "modal-button-container" });
    const confirmEl = buttonsEl.createEl("button", { cls: "mod-cta", text: action });
    confirmEl.addEventListener("click", () => {
      this.close();
      onConfirm();
    });
    buttonsEl
      .createEl("button", { text: "Cancel" })
      .addEventListener("click", () => this.close());
    confirmEl.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
