import { EditorState, type Extension, Transaction } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { ItemView } from "obsidian";

import type LiveSharePlugin from "../main";
import type { TextPatchMessage } from "../types";

export const REMOTE_NOTE_VIEW_TYPE = "live-share-remote-note";

let pluginInstance: LiveSharePlugin | null = null;

export function setRemoteNotePlugin(plugin: LiveSharePlugin): void {
  pluginInstance = plugin;
}

export class RemoteNoteView extends ItemView {
  private editor: EditorView | null = null;
  private seq = 0;
  private path = "";
  private contentLines: string[] = [];

  constructor(leaf: import("obsidian").WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return REMOTE_NOTE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.path ? this.path.split("/").pop() ?? "Remote Note" : "Remote Note";
  }

  getIcon(): string {
    return "file-text";
  }

  async onOpen(): Promise<void> {
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
      }),
    ];

    const startState = EditorState.create({
      doc: "",
      extensions,
    });

    this.editor = new EditorView({
      state: startState,
      parent: container,
    });

    if (this.path && pluginInstance?.controlChannel) {
      pluginInstance.controlChannel.send({
        type: "text-snapshot-request",
        path: this.path,
      });
    }
  }

  async onClose(): Promise<void> {
    this.editor?.destroy();
    this.editor = null;
  }

  getState(): Record<string, unknown> {
    return { path: this.path };
  }

  async setState(state: Record<string, unknown>): Promise<void> {
    this.path = (state.path as string) ?? "";
    if (this.editor && this.path && pluginInstance?.controlChannel) {
      pluginInstance.controlChannel.send({
        type: "text-snapshot-request",
        path: this.path,
      });
    }
  }

  setContent(path: string, seq: number, lines: string[]): void {
    if (path !== this.path) return;
    this.seq = seq;
    this.contentLines = lines;
    const doc = lines.join("\n");
    if (this.editor) {
      this.editor.dispatch({
        changes: { from: 0, to: this.editor.state.doc.length, insert: doc },
      });
    }
  }

  applyPatch(msg: TextPatchMessage): void {
    if (msg.path !== this.path) return;

    if (msg.seq !== undefined && msg.seq !== this.seq + 1) {
      this.requestSnapshot();
      return;
    }

    this.seq = msg.seq ?? this.seq + 1;

    const fromLine = Math.max(0, msg.lnum);
    const toLine = Math.min(fromLine + msg.count, this.contentLines.length);

    const oldDoc = this.editor?.state.doc.toString() ?? "";
    const offsetFrom = this.lineToOffset(oldDoc, fromLine);
    const offsetTo = this.lineToOffset(oldDoc, toLine);
    const insert = msg.lines.join("\n") + (msg.lines.length > 0 && fromLine < this.contentLines.length ? "\n" : "");

    if (this.editor) {
      this.editor.dispatch({
        changes: { from: offsetFrom, to: offsetTo, insert },
        annotations: Transaction.remote.of(true),
      });
    }

    this.contentLines.splice(fromLine, msg.count, ...msg.lines);
  }

  private onDocChanged(update: import("@codemirror/view").ViewUpdate): void {
    const isRemote = update.transactions.some((tr) => tr.annotation(Transaction.remote));
    if (isRemote) return;

    for (const tr of update.transactions) {
      if (!tr.changes || tr.changes.empty) continue;

      const changes: { lnum: number; count: number; lines: string[] }[] = [];
      tr.changes.iterChangedRanges(
        (fromA: number, toA: number, _fromB: number, _toB: number) => {
          const fromLine = this.editor?.state.doc.lineAt(fromA)?.number ?? 0;
          const oldContent = this.oldDoc.slice(fromA, toA);
          const count = oldContent ? oldContent.split("\n").length - 1 : 0;
          const newContent = this.editor?.state.doc.sliceString(fromA, toA) ?? "";
          const lines = newContent ? newContent.split("\n") : [];
          changes.push({ lnum: fromLine - 1, count, lines });
        },
      );

      for (const c of changes) {
        pluginInstance?.controlChannel?.send({
          type: "text-patch",
          path: this.path,
          lnum: c.lnum,
          count: c.count,
          lines: c.lines,
        });

        this.contentLines.splice(c.lnum, c.count, ...c.lines);
      }
    }
  }

  private get oldDoc(): string {
    return this.contentLines.join("\n");
  }

  private requestSnapshot(): void {
    pluginInstance?.controlChannel?.send({
      type: "text-snapshot-request",
      path: this.path,
    });
  }

  private lineToOffset(doc: string, line: number): number {
    const lines = doc.split("\n");
    let offset = 0;
    for (let i = 0; i < Math.min(line, lines.length); i++) {
      offset += lines[i].length + 1;
    }
    return offset;
  }
}
