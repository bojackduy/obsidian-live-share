import { Compartment, EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Notice } from "obsidian";
import { yCollab } from "y-codemirror.next";
import type * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";

import type { SyncManager } from "../sync/sync";
import type { Permission, SessionRole } from "../types";
import { applyMinimalYTextUpdate, normalizeLineEndings } from "../utils";
import { conflictExtension } from "./conflict-decoration";
import { debugLog } from "../debug-logger";

export interface CursorUser {
  name: string;
  color: string;
  colorLight: string;
}

export class CollabManager {
  private compartment = new Compartment();
  private currentPath: string | null = null;
  private currentView: EditorView | null = null;
  private currentAwareness: awarenessProtocol.Awareness | null = null;
  private activationGen = 0;

  getBaseExtension(): Extension {
    return this.compartment.of([]);
  }

  async activateForFile(
    view: EditorView,
    filePath: string | null,
    syncManager: SyncManager,
    role?: SessionRole,
    permission?: Permission,
    cursorUser?: CursorUser,
  ) {
    const gen = ++this.activationGen;
    debugLog("collab", `activateForFile start path=${filePath} role=${role} permission=${permission} gen=${gen}`);

    const oldAwareness = this.currentAwareness;
    const oldView = this.currentView;
    const oldPath = this.currentPath;
    this.currentPath = filePath;
    this.currentView = view;

    if (!filePath) {
      debugLog("collab", "no file path, clearing collab");
      if (oldAwareness) oldAwareness.setLocalState(null);
      this.currentAwareness = null;
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }

    const docHandle = syncManager.getDoc(filePath);
    if (!docHandle) {
      debugLog("collab", `getDoc returned null for ${filePath}`);
      this.currentPath = oldPath;
      this.currentView = oldView;
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }

    debugLog("collab", `waiting for sync on ${filePath}`);
    try {
      await syncManager.waitForSync(filePath);
      debugLog("collab", `sync completed for ${filePath}`);
    } catch {
      if (this.activationGen !== gen) return;
      debugLog("collab", `sync timed out for ${filePath}`);
      new Notice("Live Share: sync timed out");
      this.currentPath = oldPath;
      this.currentView = oldView;
      try {
        view.dispatch({ effects: this.compartment.reconfigure([]) });
      } catch {
        // View may have been destroyed during sync
      }
      return;
    }

    if (this.activationGen !== gen) return;
    if ((view as unknown as { destroyed: boolean }).destroyed) return;

    if (role !== "host" && docHandle.text.length === 0) {
      debugLog("collab", `waiting for host to seed Y.Text on ${filePath}`);
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (this.activationGen !== gen) return;
        if ((view as unknown as { destroyed: boolean }).destroyed) return;
        if (docHandle.text.length > 0) break;
      }
      debugLog("collab", `after wait Y.Text length=${docHandle.text.length} for ${filePath}`);
    }

    if (role === "host") {
      const localContent = normalizeLineEndings(view.state.doc.toString());
      debugLog("collab", `seeding Y.Text from local content len=${localContent.length}`);
      applyMinimalYTextUpdate(docHandle.doc, docHandle.text, localContent);
    }

    // Set up NEW awareness first, then clear old
    this.currentAwareness = docHandle.awareness;
    if (cursorUser) {
      debugLog("collab", `setting awareness user: ${JSON.stringify(cursorUser)}`);
      docHandle.awareness.setLocalStateField("user", cursorUser);
    }
    debugLog("collab", `activating yCollab for ${filePath}`);
    const collabExt = yCollab(docHandle.text, docHandle.awareness, {
      undoManager: false,
    });
    const extensions: Extension[] = Array.isArray(collabExt) ? [...collabExt] : [collabExt];
    extensions.push(conflictExtension());
    if (permission === "read-only") {
      debugLog("collab", "setting editor to read-only");
      extensions.push(EditorState.readOnly.of(true));
    }
    view.dispatch({
      effects: this.compartment.reconfigure(extensions),
    });

    const selection = view.state.selection.main;
    const anchor = Y.createRelativePositionFromTypeIndex(docHandle.text, selection.anchor);
    const head = Y.createRelativePositionFromTypeIndex(docHandle.text, selection.head);
    debugLog("collab", `setting initial cursor selection.anchor=${selection.anchor} selection.head=${selection.head}`);
    docHandle.awareness.setLocalStateField("cursor", { anchor, head });

    // NOW clear old awareness (after new one is live)
    if (oldAwareness && oldAwareness !== docHandle.awareness) {
      oldAwareness.setLocalState(null);
    }
    if (oldView && oldView !== view) {
      try {
        oldView.dispatch({
          effects: this.compartment.reconfigure([]),
        });
      } catch {
        // Previous view may have been destroyed
      }
    }

    debugLog("collab", `activateForFile complete for ${filePath}`);
  }

  deactivateAll(view: EditorView) {
    debugLog("collab", "deactivateAll");
    this.activationGen++;
    if (this.currentAwareness) {
      this.currentAwareness.setLocalState(null);
      this.currentAwareness = null;
    }
    this.currentPath = null;
    this.currentView = null;
    view.dispatch({ effects: this.compartment.reconfigure([]) });
  }
}
