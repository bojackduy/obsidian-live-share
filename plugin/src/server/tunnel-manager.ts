import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TunnelProvider = "none" | "serveo.net" | "localhost.run" | "nokey@localhost.run";

export interface TunnelStatus {
  state: "idle" | "connecting" | "connected" | "failed";
  url?: string;
  error?: string;
}

const PROVIDER_CONFIG: Record<
  Exclude<TunnelProvider, "none">,
  { service: string; pattern: RegExp }
> = {
  "serveo.net": {
    service: "serveo.net",
    pattern: /https:\/\/[a-zA-Z0-9_.-]+\.(?:serveo\.net|serveousercontent\.com)/,
  },
  "localhost.run": {
    service: "localhost.run",
    pattern: /https:\/\/[a-zA-Z0-9_.-]+\.lhr\.life/,
  },
  "nokey@localhost.run": {
    service: "nokey@localhost.run",
    pattern: /https:\/\/[a-zA-Z0-9_.-]+\.lhr\.life/,
  },
};

export class TunnelManager {
  private process: ChildProcess | null = null;
  private status: TunnelStatus = { state: "idle" };
  private onChange: ((status: TunnelStatus) => void) | null = null;
  private urlFile = "";
  private logFile = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private settled = false;

  getStatus(): TunnelStatus {
    return { ...this.status };
  }

  onStatusChange(cb: (status: TunnelStatus) => void): void {
    this.onChange = cb;
  }

  private emitStatus() {
    this.onChange?.({ ...this.status });
  }

  isRunning(): boolean {
    return this.process !== null && this.status.state !== "idle" && this.status.state !== "failed";
  }

  async start(port: number, provider: TunnelProvider): Promise<string> {
    if (this.isRunning()) throw new Error("Tunnel is already running");
    if (provider === "none") throw new Error("No tunnel provider selected");

    this.settled = false;
    this.status = { state: "connecting" };
    this.emitStatus();

    const config = PROVIDER_CONFIG[provider];
    const id = randomUUID();
    this.urlFile = join(tmpdir(), `live-share-tunnel-${id}.url`);
    this.logFile = join(tmpdir(), `live-share-tunnel-${id}.log`);

    return new Promise((resolve, reject) => {
      const command = `ssh -o StrictHostKeyChecking=no -R 80:localhost:${port} ${config.service} > ${this.urlFile} 2>${this.logFile}`;

      const proc = spawn("sh", ["-c", command]);
      this.process = proc;

      let attempts = 0;
      const maxAttempts = 240;

      this.pollTimer = setInterval(() => {
        if (this.settled) return;
        attempts++;

        if (!existsSync(this.urlFile)) {
          if (attempts >= maxAttempts) {
            this.fail(reject, "Tunnel connection timed out after 60s");
          }
          return;
        }

        try {
          const content = readFileSync(this.urlFile, "utf-8");
          const match = content.match(config.pattern);
          if (match) {
            this.settled = true;
            this.cleanupPollTimer();
            const url = match[0];
            this.status = { state: "connected", url };
            this.emitStatus();
            resolve(url);
          } else if (attempts >= maxAttempts) {
            this.fail(reject, "Tunnel connection timed out after 60s");
          }
        } catch {
          if (attempts >= maxAttempts) {
            this.fail(reject, "Tunnel connection timed out after 60s");
          }
        }
      }, 250);

      proc.on("error", (err) => {
        if (this.settled) return;
        this.settled = true;
        this.cleanupPollTimer();
        this.cleanupProc();
        const msg = `SSH error: ${err.message}`;
        this.status = { state: "failed", error: msg };
        this.emitStatus();
        reject(new Error(msg));
      });

      proc.on("close", (code, signal) => {
        if (this.settled) return;
        this.settled = true;
        this.cleanupPollTimer();
        this.cleanupProc();
        let msg: string;
        if (signal) {
          msg = `SSH process killed by signal ${signal}`;
        } else if (code === 127) {
          msg = "SSH not found. Install OpenSSH Client.";
        } else if (code !== null) {
          msg = `SSH process exited with code ${code}`;
        } else {
          msg = "SSH process exited unexpectedly";
        }
        const log = this.readLog();
        if (log) msg += `\nLog: ${log.slice(0, 800)}`;
        this.status = { state: "failed", error: msg };
        this.emitStatus();
        reject(new Error(msg));
      });
    });
  }

  stop(): void {
    this.settled = true;
    this.cleanup();
    this.status = { state: "idle", url: undefined, error: undefined };
    this.emitStatus();
  }

  private fail(reject: (reason: unknown) => void, error: string) {
    this.settled = true;
    this.cleanupPollTimer();
    this.cleanupProc();
    const log = this.readLog();
    const msg = log ? `${error}\nLog: ${log.slice(0, 800)}` : error;
    this.status = { state: "failed", error: msg };
    this.emitStatus();
    reject(new Error(msg));
  }

  private readLog(): string {
    try {
      return existsSync(this.logFile) ? readFileSync(this.logFile, "utf-8").trim() : "";
    } catch {
      return "";
    }
  }

  private cleanupPollTimer() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private cleanupProc() {
    if (this.process) {
      this.process.kill("SIGTERM");
      setTimeout(() => {
        if (this.process && !this.process.killed) this.process.kill("SIGKILL");
      }, 2000);
      this.process = null;
    }
  }

  private cleanup() {
    this.cleanupPollTimer();
    this.cleanupProc();
    if (this.urlFile && existsSync(this.urlFile)) {
      try { unlinkSync(this.urlFile); } catch { /* ignore */ }
    }
    if (this.logFile && existsSync(this.logFile)) {
      try { unlinkSync(this.logFile); } catch { /* ignore */ }
    }
    this.urlFile = "";
    this.logFile = "";
  }
}
