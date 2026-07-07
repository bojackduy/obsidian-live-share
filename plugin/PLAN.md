# Obsidian Live Share — Development Plan

## Feature Comparison: Relay vs Us

| Area | Relay | Us |
|------|-------|-----|
| **Server** | Cloud relay (y-sweet) + self-host | Embedded in-plugin |
| **Network** | Works over internet via cloud relay | LAN only, needs manual ngrok |
| **Auth** | OAuth (Google/GitHub/Discord/Microsoft) | None / basic |
| **File types** | Both: markdown + images + PDFs + audio + video + canvas | ✅ |
| **Real-time editing** | Both: CRDT-based for text files | ✅ |
| **Canvas sync** | Full embed view + per-node | Basic node/edge sync |
| **Storage** | Cloud S3, content-addressed dedup, quotas | None |
| **Offline sync** | Full background with retry + progress UI, dual queue | Basic queue |
| **Roles** | Owner/Member/Reader + per-action policies | Host/Guest + RW/RO |
| **UI polish** | 62 Svelte components, sync dashboard, modals | Simple presence panel |
| **Merge** | Three-way merge state machine (HSM) | Basic LWW |
| **Admin** | Share keys, invitations, enterprise tenants | Kick + permission toggle |
| **Pricing** | Free tier + $5-$6/user/mo | Free |
| **Architecture** | Cloud platform with users and relays | Session-based P2P |
| **Setup** | Sign up, create relay, share key | Start server, share link |

## What We Have That Relay Doesn't

- Zero-infrastructure — no account, no cloud, no setup
- Fully self-contained — everything runs in the plugin
- Free forever — no tiers, limits, or billing
- Peer-to-peer model — data stays on participants' machines

## Key Learnings from Relay (Prioritized)

### P1 — SSH Tunnel Support (serveo.net / localhost.run)
Auto-spawn an SSH reverse tunnel so guests can connect over the internet without manual ngrok setup. Same approach as live-share.nvim.

### P2 — Feature Flag System
Typed flags with categories (labs, debugging, danger), defaults, and settings UI. Lets us ship incomplete features behind toggles.

### P3 — Sync Status Indicator
Per-file/folder sync status in the UI (synced, syncing, queued, paused, error). Users currently have no feedback on sync state.

### P4 — File Type Registry + Folder Toggles
Replace hardcoded `isTextFile()` with a `TypeRegistry` mapping extension→mime→sync type. Per-folder toggles for images, PDFs, audio, video.

### P5 — Proper Background Sync Retry
Exponential backoff, failure tracking, per-folder progress groups. Our current queue is too basic.

### P6 — Content-Addressed Binary Store
Hash-based dedup for binary files to avoid re-transmitting identical files.

## Architecture Notes

### SSH Tunnel Flow
```
Host starts embedded server  →  plugin spawns `ssh -R ...` tunnel
                                    ↓
                             public URL (e.g. https://abc.serveo.net)
                                    ↓
Guest connects to public URL  →  tunnel forwards to host's embedded server
```

Providers:
- `serveo.net` — SSH, no account
- `localhost.run` — SSH, no account
- `nokey@localhost.run` — SSH, no account
- `ngrok` — requires token (fallback)
