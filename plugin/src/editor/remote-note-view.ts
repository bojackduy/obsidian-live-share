import { EditorState, type Extension, Transaction } from "@codemirror/state";
import { EditorView, highlightActiveLine, lineNumbers } from "@codemirror/view";
import { ItemView } from "obsidian";

import { debugLog } from "../debug-logger";
import type LiveSharePlugin from "../main";
import type { TextPatchMessage } from "../types";

export const REMOTE_NOTE_VIEW_TYPE = "live-share-remote-note";

let pluginInstance: LiveSharePlugin | null = null;

export function setRemoteNotePlugin(plugin: LiveSharePlugin): void {
  pluginInstance = plugin;
}

export class RemoteNoteView extends ItemView {
  editor: EditorView | null = null;
  private seq = 0;
  get remotePath(): string {
    return this.path;
  }
  private path = "";
  private pendingSnapshot = false;

  constructor(leaf: import("obsidian").WorkspaceLeaf) {
    super(leaf);
  }

  static getActive(plugin: LiveSharePlugin): RemoteNoteView | null {
    const view = plugin.app.workspace.getActiveViewOfType(RemoteNoteView);
    return view?.path ? view : null;
  }

  getViewType(): string {
    return REMOTE_NOTE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.path ? (this.path.split("/").pop() ?? "Remote Note") : "Remote Note";
  }

  getIcon(): string {
    return "file-text";
  }

  async onOpen(): Promise<void> {
    debugLog("remote-note", `onOpen: path=${this.path}`);
    const container = this.contentEl.createDiv({ cls: "live-share-remote-editor" });
    container.style.height = "100%";
    container.style.overflow = "auto";

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          this.onDocChanged(update);
        }
        if (update.selectionSet) {
          pluginInstance?.presenceManager?.debouncedBroadcastPresence();
        }
      }),
    ];

    const startState = EditorState.create({ doc: "", extensions });
    this.editor = new EditorView({ state: startState, parent: container });

    this.editor.scrollDOM.addEventListener("scroll", () => {
      pluginInstance?.presenceManager?.debouncedBroadcastPresence();
    });

    if (this.path && pluginInstance?.controlChannel) {
      this.requestSnapshot();
    }
  }

  async onClose(): Promise<void> {
    debugLog("remote-note", "onClose");
    this.editor?.destroy();
    this.editor = null;
  }

  getState(): Record<string, unknown> {
    return { path: this.path };
  }

  async setState(state: Record<string, unknown>): Promise<void> {
    debugLog("remote-note", `setState: path=${state.path}`);
    this.path = (state.path as string) ?? "";
    this.seq = 0;
    this.pendingSnapshot = false;
    if (this.editor && this.path && pluginInstance?.controlChannel) {
      this.editor.dispatch({
        changes: { from: 0, to: this.editor.state.doc.length, insert: "" },
      });
      this.requestSnapshot();
    }
  }

  setContent(path: string, seq: number, lines: string[]): void {
    debugLog("remote-note", `setContent: path=${path}, seq=${seq}, lines=${lines.length}`);
    if (path !== this.path) return;
    this.seq = seq;
    this.pendingSnapshot = false;
    const doc = lines.join("\n");
    if (this.editor) {
      this.editor.dispatch({
        changes: { from: 0, to: this.editor.state.doc.length, insert: doc },
        annotations: Transaction.remote.of(true),
      });
    }
  }

  applyPatch(msg: TextPatchMessage): void {
    debugLog("remote-note", `applyPatch: path=${msg.path}, seq=${msg.seq}, lnum=${msg.lnum}, count=${msg.count}, lines=${msg.lines.length}`);
    if (msg.path !== this.path || !this.editor) return;

    if (msg.seq !== undefined && msg.seq !== this.seq + 1) {
      this.requestSnapshot();
      return;
    }
    this.seq = msg.seq ?? this.seq + 1;

    const doc = this.editor.state.doc;
    const maxLine = doc.lines;

    const fromLine = Math.max(1, msg.lnum + 1);
    const toLine = Math.min(fromLine + msg.count, maxLine + 1);

    const offsetFrom = doc.line(fromLine).from;
    const offsetTo = toLine <= maxLine ? doc.line(toLine).from : doc.length;

    const insert = msg.lines.length > 0 ? `${msg.lines.join("\n")}\n` : "";

    this.editor.dispatch({
      changes: { from: offsetFrom, to: offsetTo, insert },
      annotations: Transaction.remote.of(true),
    });
  }

  private onDocChanged(update: import("@codemirror/view").ViewUpdate): void {
    debugLog("remote-note", "onDocChanged: local change detected");
    if (update.transactions.some((tr) => tr.annotation(Transaction.remote))) return;

    for (const tr of update.transactions) {
      if (!tr.changes || tr.changes.empty) continue;

      tr.changes.iterChangedRanges((fromA: number, toA: number, _fromB: number, _toB: number) => {
        const oldLine = update.startState.doc.lineAt(fromA).number;
        const oldContent = update.startState.doc.sliceString(fromA, toA);
        const count = oldContent ? oldContent.split("\n").length - (toA > fromA ? 1 : 0) : 0;
        const newContent = this.editor?.state.doc.sliceString(_fromB, _toB) ?? "";
        const lines = newContent ? newContent.split("\n") : [];
        if (newContent.endsWith("\n") && lines.length > 0) {
          lines.pop();
        }

        this.sendPatch(oldLine - 1, count, lines);
      });
    }
  }

  private sendPatch(lnum: number, count: number, lines: string[]): void {
    debugLog("remote-note", `sendPatch: lnum=${lnum}, count=${count}, lines=${lines.length}`);
    const userId = pluginInstance?.settings.githubUserId || pluginInstance?.settings.clientId || "";
    pluginInstance?.controlChannel?.send({
      type: "text-patch",
      path: this.path,
      peer: userId,
      lnum,
      count,
      lines,
    });
  }

  private requestSnapshot(): void {
    debugLog("remote-note", `requestSnapshot: path=${this.path}`);
    if (this.pendingSnapshot) return;
    this.pendingSnapshot = true;
    pluginInstance?.controlChannel?.send({
      type: "text-snapshot-request",
      path: this.path,
    });
  }
}
