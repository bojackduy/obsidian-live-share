type SyncState = "idle" | "syncing" | "queued" | "error";

interface FileSyncState {
  state: SyncState;
  error?: string;
  errorTime?: number;
}

type SyncStatusListener = (status: SyncStatus) => void;

export class SyncStatus {
  private fileStates = new Map<string, FileSyncState>();
  private failures: { path: string; error: string; time: number }[] = [];
  private listeners = new Set<SyncStatusListener>();

  setState(path: string, state: SyncState, error?: string): void {
    const entry: FileSyncState = { state };
    if (error) {
      entry.error = error;
      entry.errorTime = Date.now();
      this.failures.push({ path, error, time: Date.now() });
      if (this.failures.length > 50) {
        this.failures = this.failures.slice(-50);
      }
    }
    this.fileStates.set(path, entry);
    this.notify();
  }

  removeFile(path: string): void {
    this.fileStates.delete(path);
    this.notify();
  }

  getState(path: string): SyncState {
    return this.fileStates.get(path)?.state ?? "idle";
  }

  getPendingCount(): number {
    let count = 0;
    for (const { state } of this.fileStates.values()) {
      if (state === "syncing" || state === "queued") count++;
    }
    return count;
  }

  getErrorCount(): number {
    let count = 0;
    for (const { state } of this.fileStates.values()) {
      if (state === "error") count++;
    }
    return count;
  }

  getFailures(): { path: string; error: string; time: number }[] {
    return [...this.failures];
  }

  clearFailures(): void {
    this.failures = [];
  }

  onChange(cb: SyncStatusListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  destroy(): void {
    this.fileStates.clear();
    this.failures = [];
    this.listeners.clear();
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb(this);
      } catch {
        // Listener error — ignore
      }
    }
  }
}
