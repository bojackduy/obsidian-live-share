import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../types";
import type {
  ControlMessage,
  FileOp,
  TextPatchMessage,
  TextSnapshotRequestMessage,
  TextSnapshotResponseMessage,
  WorkspaceRequestMessage,
  WorkspaceResponseMessage,
} from "../types";

describe("types", () => {
  it("DEFAULT_SETTINGS has expected shape", () => {
    expect(DEFAULT_SETTINGS.serverUrl).toBe("http://localhost:3000");
    expect(DEFAULT_SETTINGS.roomId).toBe("");
    expect(DEFAULT_SETTINGS.token).toBe("");
    expect(DEFAULT_SETTINGS.displayName).toBe("Anonymous");
    expect(DEFAULT_SETTINGS.cursorColor).toMatch(/^#/);
    expect(DEFAULT_SETTINGS.serverPassword).toBe("");
    expect(DEFAULT_SETTINGS.notificationsEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.debugLogging).toBe(false);
    expect(DEFAULT_SETTINGS.debugLogPath).toBe("live-share-debug.md");
    expect(DEFAULT_SETTINGS.autoReconnect).toBe(true);
    expect(DEFAULT_SETTINGS.readOnlyPatterns).toEqual([]);
  });

  it("FileOp union types are assignable", () => {
    const create: FileOp = { type: "create", path: "a.md", content: "" };
    const del: FileOp = { type: "delete", path: "b.md" };
    const rename: FileOp = { type: "rename", oldPath: "c.md", newPath: "d.md" };
    expect(create.type).toBe("create");
    expect(del.type).toBe("delete");
    expect(rename.type).toBe("rename");
  });

  it("WorkspaceRequestMessage is valid ControlMessage", () => {
    const msg: ControlMessage = { type: "workspace-request" };
    expect(msg.type).toBe("workspace-request");
  });

  it("WorkspaceResponseMessage is valid ControlMessage", () => {
    const msg: ControlMessage = {
      type: "workspace-response",
      rootName: "vault",
      files: ["doc.md", "notes/ideas.md"],
    };
    expect(msg.type).toBe("workspace-response");
    expect(msg.files).toHaveLength(2);
  });

  it("TextPatchMessage is valid ControlMessage", () => {
    const msg: TextPatchMessage = {
      type: "text-patch",
      path: "doc.md",
      lnum: 5,
      count: 1,
      lines: ["replacement line"],
    };
    expect(msg.type).toBe("text-patch");
    expect(msg.lnum).toBe(5);
  });

  it("TextPatchMessage with optional fields is valid ControlMessage", () => {
    const msg: TextPatchMessage = {
      type: "text-patch",
      path: "doc.md",
      seq: 42,
      peer: "user-abc",
      lnum: 0,
      count: 2,
      lines: ["line1", "line2"],
    };
    expect(msg.seq).toBe(42);
    expect(msg.peer).toBe("user-abc");
  });

  it("TextSnapshotRequestMessage is valid ControlMessage", () => {
    const msg: ControlMessage = {
      type: "text-snapshot-request",
      path: "doc.md",
    };
    expect(msg.type).toBe("text-snapshot-request");
  });

  it("TextSnapshotResponseMessage is valid ControlMessage", () => {
    const msg: ControlMessage = {
      type: "text-snapshot-response",
      path: "doc.md",
      seq: 10,
      lines: ["line one", "line two"],
    };
    expect(msg.type).toBe("text-snapshot-response");
    expect(msg.lines).toHaveLength(2);
  });
});
