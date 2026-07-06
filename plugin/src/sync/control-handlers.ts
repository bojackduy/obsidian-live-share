import { minimatch } from "minimatch";
import { MarkdownView, Notice, TFile, TFolder } from "obsidian";

import { debugLog } from "../debug-logger";

import type LiveSharePlugin from "../main";
import type { ControlMessage, FileOp } from "../types";
import { ApprovalModal } from "../ui/approval-modal";
import { showFocusNotification } from "../ui/focus-notification";
import { ConfirmModal } from "../ui/modals";
import { isTextFile, normalizePath, toCanonicalPath, toLocalPath } from "../utils";

const CHUNK_TO_CONTROL = {
  "chunk-start": "file-chunk-start",
  "chunk-data": "file-chunk-data",
  "chunk-end": "file-chunk-end",
  "chunk-resume": "file-chunk-resume",
} as const;

const CONTROL_TO_CHUNK = Object.fromEntries(
  Object.entries(CHUNK_TO_CONTROL).map(([chunkType, controlType]) => [controlType, chunkType]),
) as Record<
  (typeof CHUNK_TO_CONTROL)[keyof typeof CHUNK_TO_CONTROL],
  keyof typeof CHUNK_TO_CONTROL
>;

export function registerControlHandlers(plugin: LiveSharePlugin): void {
  const channel = plugin.controlChannel;
  if (!channel) return;

  plugin.fileOpsManager.setSender((op) => {
    if (op.type === "chunk-start" || op.type === "chunk-data" || op.type === "chunk-end") {
      channel.send({
        ...op,
        type: CHUNK_TO_CONTROL[op.type],
      } as ControlMessage);
    } else {
      channel.send({ type: "file-op", op });
    }
  });

  channel.on("file-op", (msg) => {
    const op = msg.op;
    debugLog("ctrl-handler", `file-op type=${op.type} path=${"path" in op ? op.path : ""} oldPath=${"oldPath" in op ? op.oldPath : ""} newPath=${"newPath" in op ? op.newPath : ""}`);
    const paths = [
      "path" in op ? op.path : null,
      "oldPath" in op ? op.oldPath : null,
      "newPath" in op ? op.newPath : null,
    ].filter(Boolean) as string[];
    if (paths.length === 0) return;
    const isRename = op.type === "rename";
    if (isRename) {
      if (!paths.some((path) => plugin.manifestManager.isSharedPath(path))) return;
    } else {
      if (paths.some((path) => !plugin.manifestManager.isSharedPath(path))) return;
    }

    if (plugin.settings.role !== "host") {
      return;
    }

    plugin.fileOpsManager
      .applyRemoteOp(op, async () => {
        if (plugin.settings.role !== "host") return;
        if (op.type === "create" && "path" in op) {
          const file = plugin.app.vault.getAbstractFileByPath(toLocalPath(op.path));
          if (file instanceof TFile) {
            const content = isTextFile(file.path)
              ? await plugin.app.vault.read(file)
              : await plugin.app.vault.readBinary(file);
            await plugin.manifestManager.updateFile(file, content);
            if (isTextFile(file.path)) {
              await plugin.backgroundSync.onFileAdded(file.path);
            }
          }
        } else if (op.type === "modify" && "path" in op && !isTextFile(op.path)) {
          const file = plugin.app.vault.getAbstractFileByPath(toLocalPath(op.path));
          if (file instanceof TFile) {
            const content = await plugin.app.vault.readBinary(file);
            await plugin.manifestManager.updateFile(file, content);
          }
        } else if (op.type === "delete" && "path" in op) {
          plugin.manifestManager.removeFile(op.path);
          plugin.backgroundSync.onFileRemoved(op.path);
        } else if (op.type === "rename" && "oldPath" in op && "newPath" in op) {
          const renameOp = op as {
            oldPath: string;
            newPath: string;
          };
          if (isTextFile(renameOp.newPath)) {
            await plugin.backgroundSync.onFileRenamed(renameOp.oldPath, renameOp.newPath);
          }
          plugin.manifestManager.renameFile(renameOp.oldPath, renameOp.newPath, plugin.syncManager);
        } else if (op.type === "folder-create" && "path" in op) {
          plugin.manifestManager.addFolder(op.path);
        }
      })
      .catch((err) => {
        plugin.logger.error("file-op", "failed to apply remote file-op", err);
      });
  });

  for (const chunkType of [
    "file-chunk-start",
    "file-chunk-data",
    "file-chunk-end",
    "file-chunk-resume",
  ] as const) {
    channel.on(chunkType, (msg) => {
      debugLog("ctrl-handler", `${chunkType} path=${msg.path}`);
      if (plugin.settings.role !== "host") return;
      if (!msg.path || !plugin.manifestManager.isSharedPath(msg.path)) return;
      plugin.fileOpsManager
        .applyRemoteOp({
          ...msg,
          type: CONTROL_TO_CHUNK[chunkType],
        } as FileOp)
        .catch((err) => {
          plugin.logger.error("file-op", `failed to apply remote ${chunkType}`, err);
        });
    });
  }

  channel.on("presence-update", (msg) => {
    debugLog("ctrl-handler", `presence-update userId=${msg.userId} displayName=${msg.displayName} currentFile=${msg.currentFile} line=${msg.line}`);
    plugin.presenceManager?.handlePresenceUpdate(msg);
  });

  channel.on("presence-leave", (msg) => {
    debugLog("ctrl-handler", `presence-leave userId=${msg.userId}`);
    if (msg.userId) plugin.presenceManager?.handlePresenceLeave(msg.userId);
  });

  channel.on("join-request", (msg) => {
    debugLog("ctrl-handler", `join-request userId=${msg.userId} displayName=${msg.displayName}`);
    if (plugin.settings.role !== "host") return;
    new ApprovalModal(
      plugin.app,
      msg,
      (approved, permission) => {
        plugin.controlChannel?.send({
          type: "join-response",
          userId: msg.userId,
          approved,
          permission,
        });
        if (approved) {
          const existing = plugin.remoteUsers.get(msg.userId);
          if (existing) existing.permission = permission;
        }
      },
      plugin.settings.approvalTimeoutSeconds,
    ).open();
  });

  channel.on("join-response", (msg) => {
    debugLog("ctrl-handler", `join-response userId=${msg.userId} approved=${msg.approved} permission=${msg.permission} isHost=${msg.isHost}`);
    if (msg.isHost === false && plugin.settings.role === "host") {
      void plugin.demoteToGuest();
      return;
    }
    if (plugin.settings.role !== "guest") return;
    if (msg.approved === false) {
      new Notice("Live Share: join request denied by host");
      void plugin.endSession();
      return;
    }
    if (msg.permission) {
      plugin.settings.permission = msg.permission;
    }
    if (msg.readOnlyPatterns) {
      plugin.remoteReadOnlyPatterns = msg.readOnlyPatterns;
      const readOnlyPaths = plugin.app.vault
        .getFiles()
        .map((f) => toCanonicalPath(normalizePath(f.path)))
        .filter((p) => msg.readOnlyPatterns?.some((pat) => minimatch(p, pat)));
      plugin.explorerIndicators?.update(readOnlyPaths);
    }
    plugin.controlConnected = true;
    plugin.updateOnlineState();
    plugin.presenceManager?.broadcastPresence();
    plugin.controlChannel?.send({ type: "workspace-request" });
  });

  channel.on("permission-update", (msg) => {
    debugLog("ctrl-handler", `permission-update permission=${msg.permission}`);
    plugin.settings.permission = msg.permission;
    plugin.onActiveFileChange();
    plugin.notify(`Live Share: your permission was changed to ${msg.permission}`);
  });

  channel.on("focus-request", (msg) => {
    debugLog("ctrl-handler", `focus-request fromUserId=${msg.fromUserId} filePath=${msg.filePath}`);
    showFocusNotification(plugin, msg);
  });

  channel.on("summon", (msg) => {
    debugLog("ctrl-handler", `summon targetUserId=${msg.targetUserId} filePath=${msg.filePath} line=${msg.line} ch=${msg.ch} fromDisplayName=${msg.fromDisplayName}`);
    const file = plugin.app.vault.getAbstractFileByPath(toLocalPath(msg.filePath));
    if (file instanceof TFile) {
      void plugin.app.workspace
        .getLeaf()
        .openFile(file)
        .then(() => {
          const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
          if (view) {
            view.editor.setCursor({ line: msg.line, ch: msg.ch });
            view.editor.scrollIntoView(
              {
                from: { line: msg.line, ch: 0 },
                to: { line: msg.line, ch: 0 },
              },
              true,
            );
          }
        });
    }
    new Notice(
      `Live Share: ${msg.fromDisplayName} summoned you to ${msg.filePath}:${msg.line + 1}`,
    );
  });

  channel.on("present-start", (msg) => {
    debugLog("ctrl-handler", `present-start userId=${msg.userId}`);
    if (msg.userId) plugin.presenceManager?.handlePresentStart(msg.userId);
  });

  channel.on("present-stop", (msg) => {
    debugLog("ctrl-handler", `present-stop userId=${msg.userId}`);
    if (msg.userId) plugin.presenceManager?.handlePresentStop(msg.userId);
  });

  channel.on("sync-request", (msg) => {
    debugLog("ctrl-handler", `sync-request path=${msg.path}`);
    if (plugin.settings.role !== "host") return;
    if (msg.path && plugin.manifestManager.isSharedPath(msg.path)) {
      const file = plugin.app.vault.getAbstractFileByPath(toLocalPath(msg.path));
      if (file instanceof TFile) {
        void plugin.fileOpsManager.onFileCreate(file);
      }
    }
  });

  channel.on("kicked", () => {
    debugLog("ctrl-handler", "kicked");
    new Notice("Live Share: you have been removed from the session");
    void plugin.endSession();
  });

  channel.on("session-end", () => {
    debugLog("ctrl-handler", "session-end");
    new Notice("Live Share: the host ended the session");
    void plugin.endSession();
  });

  channel.on("host-transfer-offer", (msg) => {
    debugLog("ctrl-handler", `host-transfer-offer userId=${msg.userId} displayName=${msg.displayName}`);
    new ConfirmModal(
      plugin.app,
      `${msg.displayName ?? msg.userId} wants to make you the host. Accept?`,
      (accepted) => {
        if (accepted) {
          plugin.controlChannel?.send({
            type: "host-transfer-accept",
            userId: msg.userId,
          });
        } else {
          plugin.controlChannel?.send({
            type: "host-transfer-decline",
            userId: msg.userId,
          });
        }
      },
    ).open();
  });

  channel.on("host-transfer-complete", () => {
    debugLog("ctrl-handler", "host-transfer-complete");
    plugin.settings.role = "host";
    plugin.settings.permission = "read-write";
    void plugin
      .saveSettings()
      .then(() => plugin.backgroundSync.startAll("host"))
      .then(() => plugin.manifestManager.publishManifest({ purge: true }))
      .then(() => {
        plugin.presenceManager?.broadcastPresence();
        plugin.updateStatusBar();
        plugin.refreshPresenceView();
        new Notice("Live Share: you are now the host");
        plugin.logger.log("session", "became host via transfer");
      });
  });

  channel.on("host-transfer-decline", (msg) => {
    debugLog("ctrl-handler", `host-transfer-decline userId=${msg.userId} displayName=${msg.displayName}`);
    plugin.notify(`Live Share: ${msg.displayName ?? msg.userId} declined host transfer`);
  });

  channel.on("host-disconnected", () => {
    debugLog("ctrl-handler", "host-disconnected");
    new Notice("Live Share: the host has disconnected");
    plugin.logger.log("session", "host disconnected");
  });

  channel.on("host-changed", (msg) => {
    debugLog("ctrl-handler", `host-changed userId=${msg.userId} displayName=${msg.displayName}`);
    const finish = () => {
      for (const [userId, user] of plugin.remoteUsers) {
        user.isHost = userId === msg.userId;
      }
      plugin.presenceManager?.broadcastPresence();
      plugin.onActiveFileChange();
      plugin.updateStatusBar();
      plugin.refreshPresenceView();
      plugin.notify(`Live Share: ${msg.displayName} is now the host`);
      plugin.logger.log("session", `host changed to ${msg.userId}`);
    };
    if (plugin.settings.role === "host") {
      plugin.settings.role = "guest";
      if (plugin.presenceManager?.getIsPresenting()) {
        plugin.presenceManager.togglePresent();
      }
      void plugin
        .saveSettings()
        .then(() => plugin.backgroundSync.startAll("guest"))
        .then(finish);
    } else {
      finish();
    }
  });

  channel.on("workspace-request", () => {
    debugLog("ctrl-handler", "workspace-request");
    if (plugin.settings.role !== "host") return;
    const files = plugin.app.vault
      .getFiles()
      .filter((f) => plugin.manifestManager.isSharedPath(f.path))
      .map((f) => toCanonicalPath(normalizePath(f.path)));
    const rootName = plugin.settings.sharedFolder
      ? (plugin.settings.sharedFolder.split("/").pop() ?? "vault")
      : "vault";
    plugin.controlChannel?.send({
      type: "workspace-response",
      rootName,
      files,
    });
  });

  channel.on("workspace-response", (msg) => {
    debugLog("ctrl-handler", `workspace-response files=${msg.files.length} rootName=${msg.rootName}`);
    if (plugin.settings.role !== "guest") return;
    plugin.remoteWorkspaceFiles = msg.files;
    plugin.remoteWorkspaceRootName = msg.rootName;
    plugin.logger.log("workspace", `received ${msg.files.length} files`);
    plugin.refreshPresenceView();
  });

  channel.on("text-patch", (msg) => {
    debugLog("ctrl-handler", `text-patch path=${msg.path} peer=${msg.peer} lnum=${msg.lnum} count=${msg.count} seq=${msg.seq}`);
    if (plugin.settings.role === "host") {
      const file = plugin.app.vault.getAbstractFileByPath(toLocalPath(msg.path));
      if (!(file instanceof TFile)) return;
      const peerPerm = msg.peer ? plugin.remoteUsers.get(msg.peer)?.permission : undefined;
      if (peerPerm === "read-only") return;
      const prev = plugin.remoteEditQueues.get(msg.path) ?? Promise.resolve();
      const next = prev.then(async () => {
        const content = await plugin.app.vault.read(file);
        const lines = content.split("\n");
        const fromLine = Math.max(0, msg.lnum);
        const toLine = Math.min(fromLine + msg.count, lines.length);
        lines.splice(fromLine, msg.count, ...msg.lines);
        const seq = (plugin.remoteEditSeqMap.get(msg.path) ?? 0) + 1;
        plugin.remoteEditSeqMap.set(msg.path, seq);
        await plugin.app.vault.modify(file, lines.join("\n"));
        plugin.controlChannel?.send({
          type: "text-patch",
          path: msg.path,
          seq,
          lnum: msg.lnum,
          count: msg.count,
          lines: msg.lines,
        });
      });
      plugin.remoteEditQueues.set(msg.path, next);
    } else {
      plugin.applyRemoteTextPatch(msg);
    }
  });

  channel.on("text-snapshot-request", (msg) => {
    debugLog("ctrl-handler", `text-snapshot-request path=${msg.path}`);
    if (plugin.settings.role !== "host") return;
    const file = plugin.app.vault.getAbstractFileByPath(toLocalPath(msg.path));
    if (!(file instanceof TFile)) return;
    void plugin.app.vault.read(file).then((content) => {
      const seq = plugin.remoteEditSeqMap.get(msg.path) ?? 0;
      plugin.controlChannel?.send({
        type: "text-snapshot-response",
        path: msg.path,
        seq,
        lines: content.split("\n"),
      });
    });
  });

  channel.on("text-snapshot-response", (msg) => {
    debugLog("ctrl-handler", `text-snapshot-response path=${msg.path} seq=${msg.seq} lines=${msg.lines?.length}`);
    if (plugin.settings.role !== "guest") return;
    plugin.setRemoteNoteContent(msg.path, msg.seq, msg.lines);
  });
}
