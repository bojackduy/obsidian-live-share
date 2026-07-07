import { Notice, type TFile, TFolder, type Vault } from "obsidian";
import type * as Y from "yjs";

import type { DocHandle, SyncManager } from "../sync/sync";
import type { LiveShareSettings } from "../types";
import {
  VAULT_EVENT_SETTLE_MS,
  ensureFolder,
  getFileByPath,
  isTextFile,
  normalizeLineEndings,
  normalizePath,
  toCanonicalPath,
  toLocalPath,
} from "../utils";
import type { ExclusionManager } from "./exclusion";
import { debugLog } from "../debug-logger";

export interface FileEntry {
  hash: string;
  size: number;
  mtime: number;
  binary?: boolean;
  directory?: boolean;
}

export async function hashBuffer(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hashContent(content: string): Promise<string> {
  return hashBuffer(new TextEncoder().encode(content).buffer);
}

export class ManifestManager {
  private syncManager: SyncManager | null = null;
  private docHandle: DocHandle | null = null;
  private manifest: Y.Map<FileEntry> | null = null;
  private observer: ((events: Y.YMapEvent<FileEntry>) => void) | null = null;

  private exclusionManager: ExclusionManager | null = null;

  constructor(
    private vault: Vault,
    private settings: LiveShareSettings,
  ) {}

  setExclusionManager(manager: ExclusionManager) {
    this.exclusionManager = manager;
  }

  updateSettings(settings: LiveShareSettings) {
    this.settings = settings;
  }

  async connect(syncManager: SyncManager): Promise<void> {
    debugLog("manifest", "connect: sync start");
    this.syncManager = syncManager;
    this.docHandle = syncManager.getDoc("__manifest__");
    if (!this.docHandle) return;
    this.manifest = this.docHandle.doc.getMap("files");
    await syncManager.waitForSync("__manifest__");
    debugLog("manifest", "connect: sync end");
  }

  async publishManifest(options?: { purge?: boolean }): Promise<void> {
    if (!this.manifest || !this.docHandle) return;

    const files = this.getSharedFiles();
    debugLog("manifest", `publishManifest: ${files.length} files`);

    const entries = new Map<string, FileEntry>();
    for (const file of files) {
      try {
        const binary = !isTextFile(file.path);
        const canonicalPath = toCanonicalPath(normalizePath(file.path));
        if (binary) {
          const binaryContent = await this.vault.readBinary(file);
          entries.set(canonicalPath, {
            hash: await hashBuffer(binaryContent),
            size: file.stat.size,
            mtime: file.stat.mtime,
            binary: true,
          });
        } else {
          const content = normalizeLineEndings(await this.vault.read(file));
          entries.set(canonicalPath, {
            hash: await hashContent(content),
            size: content.length,
            mtime: file.stat.mtime,
          });
        }
      } catch {
        new Notice(`Live Share: failed to read ${file.path}, skipping`);
      }
    }

    for (const item of this.vault.getAllLoadedFiles()) {
      if (!(item instanceof TFolder)) continue;
      if (!item.path || item.path === "/") continue;
      if (!this.isSharedPath(item.path)) continue;
      if (item.children.length > 0) continue;
      entries.set(toCanonicalPath(normalizePath(item.path)), {
        hash: "",
        size: 0,
        mtime: 0,
        directory: true,
      });
    }

    this.docHandle.doc.transact(() => {
      if (options?.purge) {
        for (const filePath of this.manifest?.keys() ?? []) {
          if (!entries.has(filePath)) {
            this.manifest?.delete(filePath);
          }
        }
      }
      for (const [filePath, fileEntry] of entries) {
        const existing = this.manifest?.get(filePath);
        if (existing && existing.hash === fileEntry.hash) continue;
        this.manifest?.set(filePath, fileEntry);
      }
    });
  }

  async syncFromManifest(
    mute?: (path: string) => void,
    unmute?: (path: string) => void,
    requestBinary?: (path: string) => void,
    options?: { skipText?: boolean },
  ): Promise<number> {
    if (!this.manifest || !this.syncManager) return 0;

    let synced = 0;
    const entries = Array.from(this.manifest.entries());

    for (const [path, entry] of entries) {
      if (!path || path.startsWith("/") || path.startsWith("\\")) {
        debugLog("manifest", `syncFromManifest: ${path} skip (invalid path)`);
        continue;
      }
      const segments = path.split(/[\\/]/);
      if (segments.some((segment) => segment === ".." || segment === ".")) {
        debugLog("manifest", `syncFromManifest: ${path} skip (path traversal)`);
        continue;
      }

      const diskPath = toLocalPath(path);
      if (entry.directory) {
        // Only create directories during initial sync, not during live changes
        // (live folder creation is handled by ensureFolder when files are synced)
        if (!options?.skipText) {
          const existing = this.vault.getAbstractFileByPath(diskPath);
          if (!existing) {
            await ensureFolder(this.vault, diskPath);
            synced++;
          }
        }
        continue;
      }

      if (options?.skipText && !entry.binary && isTextFile(path)) {
        debugLog("manifest", `syncFromManifest: ${path} skip (skipText option)`);
        continue;
      }

      const localFile = getFileByPath(this.vault, diskPath);

      let needsSync = false;
      if (!localFile) {
        needsSync = true;
      } else if (entry.binary) {
        const binaryContent = await this.vault.readBinary(localFile);
        if ((await hashBuffer(binaryContent)) !== entry.hash) {
          needsSync = true;
        }
      } else {
        const content = normalizeLineEndings(await this.vault.read(localFile));
        if ((await hashContent(content)) !== entry.hash) {
          needsSync = true;
        }
      }

      if (!needsSync) {
        debugLog("manifest", `syncFromManifest: ${path} skip (hash match)`);
        continue;
      }

      if (entry.binary) {
        debugLog("manifest", `syncFromManifest: ${path} requesting binary`);
        requestBinary?.(path);
        synced++;
        continue;
      }

      debugLog("manifest", `syncFromManifest: syncing ${path}`);
      const tempHandle = this.syncManager.getDoc(path);
      if (!tempHandle) continue;

      try {
        await this.syncManager.waitForSync(path);

        const content = tempHandle.text.toString();

        const parentDir = diskPath.substring(0, diskPath.lastIndexOf("/"));
        if (parentDir) await ensureFolder(this.vault, parentDir);

        mute?.(diskPath);
        try {
          if (localFile) {
            await this.vault.modify(localFile, content);
          } else {
            await this.vault.create(diskPath, content);
          }
        } finally {
          if (unmute) {
            setTimeout(() => unmute(diskPath), VAULT_EVENT_SETTLE_MS);
          }
        }
        synced++;
      } catch {
        // Failed to sync individual file, continue with rest
      }
    }

    return synced;
  }

  setManifestChangeHandler(
    callback: (added: string[], removed: string[], updated: string[]) => void,
  ): void {
    if (!this.manifest) return;

    if (this.observer && this.manifest) {
      this.manifest.unobserve(this.observer);
    }

    this.observer = (event: Y.YMapEvent<FileEntry>) => {
      const added: string[] = [];
      const removed: string[] = [];
      const updated: string[] = [];
      event.changes.keys.forEach((change, key) => {
        if (change.action === "add") added.push(key);
        else if (change.action === "delete") removed.push(key);
        else if (change.action === "update") updated.push(key);
      });
      if (added.length > 0 || removed.length > 0 || updated.length > 0) {
        debugLog("manifest", `manifestChange: +${added.length} -${removed.length} ~${updated.length}`);
        callback(added, removed, updated);
      }
    };
    this.manifest.observe(this.observer);
  }

  async updateFile(file: TFile, content: string | ArrayBuffer): Promise<void> {
    if (!this.manifest || !this.isSharedPath(file.path)) return;
    const canonical = toCanonicalPath(normalizePath(file.path));
    // Remove parent folder entry if it exists - folder is no longer empty
    const parentDir = canonical.substring(0, canonical.lastIndexOf("/"));
    if (parentDir && this.manifest.has(parentDir)) {
      const parentEntry = this.manifest.get(parentDir);
      if (parentEntry?.directory) {
        this.manifest.delete(parentDir);
      }
    }
    if (content instanceof ArrayBuffer) {
      const hash = await hashBuffer(content);
      debugLog("manifest", `updateFile: ${canonical} hash=${hash} binary`);
      this.manifest.set(canonical, {
        hash,
        size: content.byteLength,
        mtime: file.stat.mtime,
        binary: true,
      });
    } else {
      const normalized = normalizeLineEndings(content);
      const hash = await hashContent(normalized);
      debugLog("manifest", `updateFile: ${canonical} hash=${hash}`);
      this.manifest.set(canonical, {
        hash,
        size: normalized.length,
        mtime: file.stat.mtime,
      });
    }
  }

  removeFile(path: string): void {
    if (!this.manifest) return;
    const canonical = toCanonicalPath(normalizePath(path));
    debugLog("manifest", `removeFile: ${canonical}`);
    this.manifest.delete(canonical);
  }

  addFolder(rawPath: string): void {
    if (!this.manifest || !this.isSharedPath(rawPath)) return;
    const path = toCanonicalPath(normalizePath(rawPath));
    if (this.manifest.has(path)) return;
    this.manifest.set(path, { hash: "", size: 0, mtime: 0, directory: true });
  }

  renameFile(oldPath: string, newPath: string, syncManager?: SyncManager): void {
    if (!this.manifest || !this.docHandle) return;
    const normOld = toCanonicalPath(normalizePath(oldPath));
    const normNew = toCanonicalPath(normalizePath(newPath));
    debugLog("manifest", `renameFile: ${normOld} -> ${normNew}`);
    const fileEntry = this.manifest.get(normOld);
    if (fileEntry) {
      this.docHandle.doc.transact(() => {
        this.manifest?.delete(normOld);
        this.manifest?.set(normNew, fileEntry);
      });
    }
    if (syncManager) {
      syncManager.releaseDoc(normOld);
    }
  }

  getEntries(): Map<string, FileEntry> {
    if (!this.manifest) return new Map();
    return new Map(this.manifest.entries());
  }

  isSharedPath(rawPath: string): boolean {
    const path = toCanonicalPath(normalizePath(rawPath));
    if (this.exclusionManager?.isExcluded(path)) return false;
    if (!this.settings.sharedFolder) return true;
    const folder = normalizePath(
      this.settings.sharedFolder.endsWith("/")
        ? this.settings.sharedFolder
        : `${this.settings.sharedFolder}/`,
    );
    return path.startsWith(folder) || path === normalizePath(this.settings.sharedFolder);
  }

  destroy(): void {
    if (this.observer && this.manifest) {
      this.manifest.unobserve(this.observer);
      this.observer = null;
    }
    if (this.syncManager) {
      this.syncManager.releaseDoc("__manifest__");
    }
    this.docHandle = null;
    this.manifest = null;
    this.syncManager = null;
  }

  private getSharedFiles(): TFile[] {
    return this.vault.getFiles().filter((file) => this.isSharedPath(file.path));
  }
}
