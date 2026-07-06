import { ItemView, setIcon } from "obsidian";

import type LiveSharePlugin from "../main";

export const WORKSPACE_VIEW_TYPE = "live-share-workspace";

export class WorkspaceView extends ItemView {
  private plugin: LiveSharePlugin;

  constructor(leaf: import("obsidian").WorkspaceLeaf, plugin: LiveSharePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return WORKSPACE_VIEW_TYPE;
  }

  getDisplayText(): string {
    const root = this.plugin.remoteWorkspaceRootName;
    return root ? `Remote: ${root}` : "Remote Workspace";
  }

  getIcon(): string {
    return "folder-tree";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  refresh(): void {
    this.plugin.controlChannel?.send({ type: "workspace-request" });
    this.render();
  }

  render(): void {
    const el = this.contentEl;
    el.empty();

    const header = el.createDiv({ cls: "live-share-workspace-header" });
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.padding = "8px 12px";
    header.style.fontWeight = "bold";

    header.createSpan({ text: this.getDisplayText() });

    const refreshBtn = header.createSpan({ cls: "clickable-icon" });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refresh());

    const files = this.plugin.remoteWorkspaceFiles;
    if (files.length === 0) {
      el.createDiv({
        cls: "live-share-workspace-empty",
        text: "No files shared yet",
      });
      return;
    }

    const list = el.createEl("ul", { cls: "live-share-workspace-list" });
    list.style.listStyle = "none";
    list.style.padding = "0";
    list.style.margin = "0";

    const sorted = [...files].sort();
    for (const file of sorted) {
      const item = list.createEl("li", { cls: "live-share-workspace-item" });
      item.style.padding = "4px 12px";
      item.style.cursor = "pointer";
      item.style.display = "flex";
      item.style.alignItems = "center";
      item.style.gap = "6px";

      const icon = item.createSpan();
      setIcon(icon, "file-text");

      item.createSpan({ text: file });

      item.addEventListener("click", () => {
        void this.plugin.openRemoteFile(file);
      });
    }
  }
}
