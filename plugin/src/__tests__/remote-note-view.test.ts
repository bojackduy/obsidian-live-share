import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDispatch = vi.fn();
const mockLineAt = vi.fn();
const mockLine = vi.fn();
let mockDocString = "";

vi.mock("@codemirror/state", () => ({
  EditorState: {
    create: () => ({ doc: "" }),
  },
  Transaction: { remote: { of: (v: boolean) => ({ remote: v }) } },
}));

vi.mock("@codemirror/view", () => {
  const updateListener = { of: vi.fn(() => "mock-update-listener") };
  function MockEditorView(this: any) {
    this.dispatch = mockDispatch;
    this.state = {
      doc: {
        toString: () => mockDocString,
        lineAt: mockLineAt,
        line: mockLine,
        get lines() {
          return mockDocString ? mockDocString.split("\n").length : 1;
        },
        get length() {
          return mockDocString.length;
        },
      },
      selection: { main: { head: 0 } },
    };
    this.scrollDOM = { scrollTop: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    this.destroy = vi.fn();
  }
  MockEditorView.updateListener = updateListener;
  return {
    EditorView: MockEditorView,
    lineNumbers: vi.fn(() => "line-numbers"),
    highlightActiveLine: vi.fn(() => "highlight-active-line"),
  };
});

const mockSend = vi.fn();

vi.mock("../main", () => ({
  default: class MockPlugin {
    controlChannel = { send: mockSend, userId: "guest-1" };
    settings = { githubUserId: "guest-1", clientId: "client-1" };
    presenceManager = {
      debouncedBroadcastPresence: vi.fn(),
    };
    app = {
      workspace: {
        getLeavesOfType: () => [],
      },
    };
  },
}));

import { setRemoteNotePlugin } from "../editor/remote-note-view";
const { RemoteNoteView } = await import("../editor/remote-note-view");
import type { TextPatchMessage } from "../types";

function createMockLeaf(): any {
  return {
    view: null,
  };
}

function createMockEl(): HTMLElement {
  const el = {
    style: {} as Record<string, string>,
    empty: vi.fn(),
    createEl: vi.fn(() => createMockEl()),
    createDiv: vi.fn(() => createMockEl()),
    appendChild: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setText: vi.fn(),
  } as any;
  return el;
}

describe("RemoteNoteView", () => {
  let view: InstanceType<typeof RemoteNoteView>;

  async function createOpenView(): Promise<InstanceType<typeof RemoteNoteView>> {
    const v = new RemoteNoteView(createMockLeaf());
    (v as any).contentEl = createMockEl();
    await v.onOpen();
    return v;
  }

  beforeEach(async () => {
    mockDispatch.mockClear();
    mockSend.mockClear();
    mockLineAt.mockClear();
    mockLine.mockClear();
    mockDocString = "";
    setRemoteNotePlugin({
      controlChannel: { send: mockSend, userId: "guest-1" },
      settings: { githubUserId: "guest-1", clientId: "client-1" },
      presenceManager: { debouncedBroadcastPresence: vi.fn() },
      app: { workspace: { getLeavesOfType: () => [] } },
    } as any);
    view = new RemoteNoteView(createMockLeaf());
    (view as any).contentEl = createMockEl();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getViewType returns REMOTE_NOTE_VIEW_TYPE", () => {
    expect(view.getViewType()).toBe("live-share-remote-note");
  });

  it("getDisplayText shows file name when path is set", () => {
    view.setState({ path: "notes/doc.md" });
    expect(view.getDisplayText()).toBe("doc");
  });

  it("getState returns the current path", () => {
    view.setState({ path: "test.md" });
    expect(view.getState()).toEqual({ path: "test.md" });
  });

  it("setState stores the path", async () => {
    await view.setState({ path: "test.md" });
    expect(view.remotePath).toBe("test.md");
  });

  it("setContent with matching path updates seq and calls dispatch", async () => {
    view = await createOpenView();
    await view.setState({ path: "doc.md" });
    mockDispatch.mockClear();
    view.setContent("doc.md", 42, ["line1", "line2"]);
    expect(mockDispatch).toHaveBeenCalled();
  });

  it("setContent with non-matching path is ignored", async () => {
    view = await createOpenView();
    await view.setState({ path: "doc.md" });
    mockDispatch.mockClear();
    view.setContent("other.md", 42, ["line1"]);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("applyPatch with seq gap triggers snapshot request", async () => {
    view = await createOpenView();
    await view.setState({ path: "doc.md" });
    view.setContent("doc.md", 5, ["a", "b", "c"]);
    mockSend.mockClear();
    mockDispatch.mockClear();

    const patch: TextPatchMessage = {
      type: "text-patch",
      path: "doc.md",
      seq: 10,
      lnum: 0,
      count: 1,
      lines: ["x"],
    };
    view.applyPatch(patch);

    expect(mockSend).toHaveBeenCalledWith({
      type: "text-snapshot-request",
      path: "doc.md",
    });
  });

  it("applyPatch with correct seq does not request snapshot", async () => {
    view = await createOpenView();
    await view.setState({ path: "doc.md" });
    mockDocString = "line1\nline2\nline3";
    mockLine.mockReturnValue({ from: 0 });
    mockLineAt.mockReturnValue({ number: 1 });
    mockDispatch.mockClear();
    mockSend.mockClear();
    view.setContent("doc.md", 5, ["a", "b", "c"]);
    mockSend.mockClear();

    const patch: TextPatchMessage = {
      type: "text-patch",
      path: "doc.md",
      seq: 6,
      lnum: 0,
      count: 1,
      lines: ["x"],
    };
    view.applyPatch(patch);

    expect(mockSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "text-snapshot-request" }),
    );
  });

  it("applyPatch with non-matching path is ignored", async () => {
    view = await createOpenView();
    await view.setState({ path: "doc.md" });
    mockDocString = "line1\nline2";
    mockLine.mockReturnValue({ from: 0 });
    mockLineAt.mockReturnValue({ number: 1 });
    mockDispatch.mockClear();
    view.setContent("doc.md", 0, ["a"]);
    mockDispatch.mockClear();
    const patch: TextPatchMessage = {
      type: "text-patch",
      path: "other.md",
      seq: 1,
      lnum: 0,
      count: 1,
      lines: ["x"],
    };
    view.applyPatch(patch);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
