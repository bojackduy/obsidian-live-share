# Architecture Design

## Q: How does Google Docs collaborative editing work?

I'll explain it at two levels: what you see as a user, and the main technology
idea that keeps everyone's edits from colliding.

Google Docs collaboration works by sending tiny edit operations, not whole
document copies.

When you type, your browser does roughly this:

- **Local edit happens immediately** — you press a key, and your screen updates
  right away so it feels instant.
- **Google sends an operation to the server** — e.g. "Insert A at position 25"
  or "delete 3 characters starting at position 40."
- **Other people's edits arrive at the same time** — suppose you insert text at
  position 25 while someone else deletes text before that position. The system
  has to adjust your edit so it still lands in the right logical place.
- **The server/client transforms edits so everyone converges** — Google Docs
  has historically been associated with **Operational Transformation (OT)**,
  a technique for real-time collaborative editing. OT changes the
  coordinates of edits based on other edits that happened concurrently,
  so everyone ends up with the same document state. Google's Wave OT
  whitepaper explains this general model for concurrent edits, and OT is
  widely described as a core technique behind Google Docs-style
  collaboration.

### Simple example

```
Document: Hello world
```

- You insert `beautiful` before `world`.
- Friend deletes `Hello`.

Without coordination, positions get confusing. OT transforms the edits so the
final result becomes something consistent, like:

```
beautiful world
```

Google Docs also tracks:

- **Presence** — who is online, where their cursor is
- **Permissions** — viewer, commenter, editor
- **Revision history** — snapshots and edit logs
- **Comments/suggestions** — separate layers from the main text
- **Autosave** — changes are continuously synced to Google's servers

**Mental model:** Google Docs is not "multiple people editing one file
directly." It is more like everyone has a live copy, and Google continuously
merges small editing commands in the right order.

### OT vs CRDT — the two main approaches to real-time collaboration

- **OT (Operational Transformation)** — edits are operations ("insert at
  position N", "delete range [A..B]") and the system transforms operations
  against each other to keep positions consistent. Requires a central server
  to sequence and transform operations in order. Google Docs historically
  uses OT.
- **CRDT (Conflict-free Replicated Data Type)** — the document is represented
  by a data structure that mathematically guarantees convergence: every edit
  is assigned a unique ID, and concurrent edits are merged deterministically
  without a central authority deciding the order. CRDTs work peer-to-peer,
  support offline editing, and never need conflict resolution — the data
  structure itself ensures all replicas converge to the same state.
  [Yjs](https://github.com/yjs/yjs) and [Automerge](https://github.com/automerge/automerge)
  are popular CRDT libraries.

**Key tradeoff:** OT is simpler to reason about but needs a server as
authority. CRDT is more complex internally but enables true local-first and
offline collaboration with no single point of coordination.

---

## Q: What about `live-share.nvim`?

`live-share.nvim` is closer to **VS Code Live Share** than Google Docs.

The big difference: Google Docs-style collaboration tries to merge concurrent
edits intelligently using OT/CRDT-like ideas. `live-share.nvim` intentionally
does **not** do that. Its protocol says the host is the "central authority,"
assigns a monotonic seq number to every edit, and syncs edits as line-range
replacement patches. It explicitly says it does **not** use CRDTs.

### How it works conceptually

1. One Neovim instance becomes the **host**.
2. Guests connect through a shared URL.
3. The host sends workspace info and open file snapshots.
4. When someone edits, the client sends a patch, like: "replace 2 lines
   starting at line 10 with these new lines."
5. The host applies the patch, assigns the authoritative sequence number,
   and broadcasts it to everyone.

### Merge model

> "The host decides the order. Everyone follows that order."

That means it converges, but it does **not** preserve everyone's intent
during simultaneous same-line edits. If two people edit the same line at the
same time, whichever patch reaches the host later can overwrite the earlier
one. The protocol calls this **last-write-wins** and says concurrent same-line
edits are unreliable.

The repo's own design notes say this was a deliberate tradeoff: it is meant
for "one active author with observers" or light turn-based pair programming,
not heavy simultaneous editing of the same lines. CRDT or OT would handle
concurrent same-line edits better but would add significant complexity.

**Security:** Uses AES-256-GCM end-to-end encryption, with the key in the URL
fragment so the tunnel server should not receive it.

**Other features:** workspace sharing, remote cursors/selections, follow
mode, and shared terminal messages.

**Take:** Good for pair programming, code walkthroughs, and "you drive / I
watch" collaboration. Not suited for Google Docs-style multiple people freely
typing into the same file at once. For Neovim users, that tradeoff may be
totally fine because pair programming usually has one driver at a time.

---

## Q: Which architecture should I follow to build an Obsidian collaboration plugin?

Obsidian is a GUI application for viewing and editing local Markdown files on
disk. The key design choice is whether you want "pair-programming style
sharing" or true Google-Docs-like simultaneous editing.

The architecture I'd pick is **not** "sync files" first. It's "collaborate on
an in-memory Markdown text model," then carefully mirror that model back to
Obsidian's local files.

### Recommended architecture: Local-first CRDT + thin relay server

Not a raw "sync Markdown files" architecture. Not a simple "host sends patches"
architecture (unless you only want one driver at a time).

```
Friend A Obsidian plugin
  ├─ CodeMirror editor extension
  ├─ CRDT document for current Markdown note
  └─ encrypted WebSocket/WebRTC messages
                    │
              Relay server
        (routes updates + presence only)
                    │
Friend B Obsidian plugin
  ├─ CodeMirror editor extension
  ├─ same CRDT document
  └─ writes final state back to local .md file
```

Obsidian plugins can register **CodeMirror 6 editor extensions**, which is the
right place to observe editor transactions and apply remote edits to the
active Markdown editor. Obsidian also exposes the **Vault API** for reading
and writing files; the docs describe a vault as a folder of files/subfolders
and recommend `read()` when you intend to modify content, while
`Vault.modify()` / `Vault.process()` handle writing changes back.

### Core idea

Use the Markdown file on disk as the **persistent storage format**, but use a
**CRDT document** as the **live collaboration format**.

- Note path: `Projects/Idea.md`
- CRDT room id: `hash(vaultShareId + normalizedPath)`
- CRDT shared text: `ydoc.getText("markdown")`

When **I type** in Obsidian:

```
CodeMirror transaction
  → convert to CRDT operation
  → send CRDT update to friend
  → eventually save merged CRDT text to disk
```

When **my friend types**:

```
remote CRDT update
  → merge into local CRDT document
  → compute text diff
  → dispatch CodeMirror change into my editor
  → save to my local Markdown file
```

A CRDT is the better fit here because Obsidian is inherently **local-first**:
both people have their own local app and local files. [Yjs](https://github.com/yjs/yjs)
describes itself as a CRDT framework with shared types whose changes are
distributed and merged without merge conflicts, with support for offline
editing, shared cursors, and editor integrations. [Automerge](https://github.com/automerge/automerge)
is another good option; its text docs say strings are collaborative text
objects that can merge concurrent changes.

### Recommended stack (practical first version)

| Component         | Choice                 |
|-------------------|------------------------|
| Obsidian plugin   | TypeScript             |
| Editor layer      | CodeMirror 6 extension |
| Collaboration     | Yjs `Y.Text`           |
| Transport         | WebSocket relay        |
| Presence          | Yjs awareness          |
| Storage           | local `.md` + optional CRDT update log |

Yjs already has a WebSocket provider using a classic client/server model where
clients connect to one endpoint and the server distributes document updates
and awareness information (like cursors). That is almost exactly what you want
for an Obsidian collaboration MVP.

### Important: do not make the server the document owner

The server should be a **relay**, not the canonical document database.

**Bad model:**
```
Obsidian → server owns file → everyone downloads server copy
```

**Better model:**
```
Each Obsidian client owns its local file.
CRDT updates are exchanged.
Everyone converges to the same text.
```

The server can optionally store encrypted CRDT updates for
reconnect/backfill, but it should not need to understand Markdown or resolve
conflicts.

### Plugin-side components

```
CollabPlugin
  ├─ SessionManager
  │   ├─ create room
  │   ├─ join room
  │   ├─ invite link
  │   └─ auth/encryption keys
  ├─ EditorBinding
  │   ├─ listens to CodeMirror local edits
  │   ├─ applies remote edits to CodeMirror
  │   ├─ prevents echo loops
  │   └─ draws remote cursors/selections
  ├─ CRDTDocumentManager
  │   ├─ one CRDT doc per Markdown file
  │   ├─ maps vault paths to room IDs
  │   ├─ handles snapshots
  │   └─ handles undo/redo boundaries
  ├─ Transport
  │   ├─ WebSocket connection
  │   ├─ reconnect
  │   ├─ update broadcasting
  │   └─ awareness/presence
  ├─ VaultBridge
  │   ├─ reads initial .md content
  │   ├─ saves merged content back to disk
  │   ├─ watches external file changes
  │   └─ handles rename/delete/create
  └─ UI
      ├─ share button
      ├─ participants list
      ├─ remote cursor colors
      └─ conflict/recovery notices
```

### Active editor vs disk writes

This part matters a lot in Obsidian.

When the note is actively open, apply remote edits **through the editor**,
not by blindly overwriting the file on disk. Obsidian's plugin guidelines say
that for an active note, plugins should prefer the `Editor` interface instead
of `Vault.modify()`, while background edits should use `Vault.process()`.

The rule:

| Scenario               | Action                                                 |
|------------------------|--------------------------------------------------------|
| File open in editor    | Apply remote changes through **CodeMirror dispatch**   |
| File not open          | Update CRDT state, use **`Vault.process`** (safe bg write) |
| File changed externally| Diff external text vs last known saved text, convert diff into CRDT operations |

**Do not do this:**

```
remote update arrived
  → write entire Markdown file with Vault.modify()
  → hope Obsidian editor reloads cleanly
```

That will cause cursor jumps, stale writes, and possible overwrite bugs.

### Transport choices

**Best default: WebSocket relay** (use this first)

```
Client A ←→ WebSocket relay ←→ Client B
```

Pros:
- Works behind NAT/firewalls
- Easy to debug
- Easier authentication
- Good for invite links
- Can support offline backfill if the relay stores encrypted updates

The relay only needs rooms: `roomId -> connected clients`

Message types:

```typescript
type Message =
  | { type: "sync-update"; roomId: string; bytes: Uint8Array }
  | { type: "awareness"; roomId: string; bytes: Uint8Array }
  | { type: "snapshot-request"; roomId: string }
  | { type: "snapshot-response"; roomId: string; bytes: Uint8Array };
```

**Later: WebRTC peer-to-peer** — good for privacy and lower server cost, but
harder:

```
Client A ←→ signaling server ←→ Client B (then direct peer connection)
```

Don't start here unless P2P is your main product requirement.

### How to map files to collaboration rooms

Avoid using only the raw path forever, because renames will break the room.

**Simple MVP:**
```
roomId = sha256(vaultShareId + normalizedFilePath)
```

**Better later:**
```json
{
  "fileId": "stable UUID",
  "currentPath": "Notes/Foo.md",
  "roomId": "sha256(vaultShareId + fileId)"
}
```

Store that metadata in plugin data or a hidden plugin folder. Obsidian's
Vault API only exposes files visible inside the app; hidden folders require
the Adapter API.

### MVP architecture (start with one shared note, not a whole vault)

1. User opens a Markdown note.
2. User clicks "Start Live Collaboration."
3. Plugin reads the current editor text.
4. Plugin creates a Yjs document.
5. Plugin connects to WebSocket room.
6. Friend joins with invite link/code.
7. Local CodeMirror edits become `Y.Text` operations.
8. Remote `Y.Text` updates become CodeMirror transactions.
9. Presence shows friend's cursor.
10. Debounced saver writes merged Markdown to disk.

Only after that works should you add:

- Multiple files
- Vault-wide sharing
- File rename/delete
- Folders
- Attachments
- Offline update persistence
- Access control
- End-to-end encryption

### Conflict behavior

**With CRDT model:**

```
You type:   Hello [my] world
Friend types: Hello [your] world
```

The system does not overwrite the whole file. It merges character-level or
range-level text operations. The final result may still need human cleanup
if both people edit the same sentence, but the system should not lose either
person's edits.

**With simple host-authoritative line-patch model:**

```
last patch wins
```

That is easier to build, but worse for Obsidian notes because Markdown files
are often prose, and two people may naturally edit the same paragraph.

### Final recommendation

Build it like this:

- **CRDT-first live editing**
- CodeMirror editor binding
- WebSocket relay
- Local Markdown persistence
- Optional end-to-end encryption

**Stack choice:** Use **Yjs** if you want the fastest path to a working
TypeScript/CodeMirror-style collaboration plugin. Use **Automerge** if you
care more about long-term local-first document history and flexible
sync/storage semantics (Automerge explicitly supports syncing over many
backends, including peer-to-peer, client-server, files on disk, and even
email attachments).

For your specific case:

```
Obsidian + CodeMirror 6 + Yjs + y-websocket + encrypted rooms
```

That gives you the closest architecture to Google Docs-style collaboration
while still respecting Obsidian's local Markdown-file design.