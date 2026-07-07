import { randomUUID } from "node:crypto";
import { type Server, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { nanoid } from "nanoid";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import {
  MUX_AWARENESS,
  MUX_AWARENESS_ENCRYPTED,
  MUX_SUBSCRIBE,
  MUX_SUBSCRIBED,
  MUX_SYNC,
  MUX_SYNC_ENCRYPTED,
  MUX_SYNC_REQUEST,
  MUX_UNSUBSCRIBE,
  decodeMuxMessage,
  encodeMuxMessage,
} from "../sync/mux-protocol";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Permission = "read-write" | "read-only";

interface Room {
  id: string;
  token: string;
  name: string;
  createdAt: number;
  lastActivityAt: number;
  hostUserId?: string;
  requireApproval?: boolean;
  readOnlyPatterns?: string[];
  defaultPermission?: Permission;
}

interface ControlClient {
  ws: WebSocket;
  userId: string;
  displayName: string;
  isHost: boolean;
  isApproved: boolean;
  permission: Permission;
  joinOrder: number;
}

interface ControlRoom {
  clients: Map<WebSocket, ControlClient>;
  pendingApprovals: Map<string, WebSocket>;
  pendingTransferTarget: string | null;
  kickedUserIds: Set<string>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  nextJoinOrder: number;
}

interface MuxClient {
  ws: WebSocket;
  subscribedRooms: Set<string>;
  userId: string | null;
  baseRoomId: string;
}

interface MuxRoomState {
  clients: Set<MuxClient>;
  readOnlyClients: Set<MuxClient>;
  clientAwarenessIds: Map<MuxClient, Set<number>>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/* ------------------------------------------------------------------ */
/*  EmbeddedServer                                                     */
/* ------------------------------------------------------------------ */

export interface EmbeddedServerConfig {
  port: number;
  serverPassword?: string;
  requireApproval?: boolean;
}

export interface EmbeddedServerStatus {
  running: boolean;
  port: number;
  activeRooms: number;
  activeClients: number;
}

export class EmbeddedServer {
  private config: EmbeddedServerConfig;
  private server: Server | null = null;
  private controlWss!: WebSocketServer;
  private muxWss!: WebSocketServer;
  private listenPort = 0;

  /* -- room storage --------------------------------------------------- */

  private rooms = new Map<string, Room>();
  private touchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /* -- control state -------------------------------------------------- */

  private controlRooms = new Map<string, ControlRoom>();

  /* -- mux state ------------------------------------------------------ */

  private muxRoomStates = new Map<string, MuxRoomState>();

  constructor(config: EmbeddedServerConfig) {
    this.config = config;
  }

  get status(): EmbeddedServerStatus {
    let clients = 0;
    for (const state of this.muxRoomStates.values()) clients += state.clients.size;
    return {
      running: this.server !== null,
      port: this.listenPort,
      activeRooms: this.rooms.size,
      activeClients: clients,
    };
  }

  async start(): Promise<number> {
    if (this.server) return this.listenPort;

    const app = createServer(this.handleRequest.bind(this));
    this.controlWss = this.createControlWSS();
    this.muxWss = this.createMuxWSS();

    app.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "", `http://${req.headers.host}`);

      if (this.config.serverPassword) {
        const provided = url.searchParams.get("password");
        if (!provided || provided !== this.config.serverPassword) {
          socket.write(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nInvalid server password",
          );
          socket.destroy();
          return;
        }
      }

      const muxMatch = url.pathname.match(/^\/ws-mux\/(.+)$/);
      if (muxMatch) {
        const baseRoomId = muxMatch[1];
        const auth = this.authenticateUpgrade(url, baseRoomId);
        if (!auth.ok) {
          this.rejectUpgrade(socket, auth.code, auth.reason);
          return;
        }
        this.muxWss.handleUpgrade(req, socket, head, (ws) => {
          this.muxWss!.emit("connection", ws, req, baseRoomId);
        });
        return;
      }

      const ctrlMatch = url.pathname.match(/^\/control\/(.+)$/);
      if (ctrlMatch) {
        const roomId = ctrlMatch[1];
        const auth = this.authenticateUpgrade(url, roomId);
        if (!auth.ok) {
          this.rejectUpgrade(socket, auth.code, auth.reason);
          return;
        }
        this.controlWss.handleUpgrade(req, socket, head, (ws) => {
          this.controlWss!.emit("connection", ws, req, roomId);
        });
        return;
      }

      socket.destroy();
    });

    this.server = app;

    return new Promise((resolve, reject) => {
      app.on("error", reject);
      app.listen(this.config.port, "127.0.0.1", () => {
        this.listenPort = (app.address() as import("net").AddressInfo).port;
        resolve(this.listenPort);
      });
    });
  }

  async stop(): Promise<void> {
    this.controlWss?.close();
    this.muxWss?.close();
    this.closeAllControlRooms();
    this.closeAllMuxRooms();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.listenPort = 0;
  }

  /* -- HTTP request handler ------------------------------------------- */

  private handleRequest = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/healthz" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        uptime: process.uptime(),
        sessions: this.rooms.size,
        documents: this.muxRoomStates.size,
        clients: this.countMuxClients(),
      }));
      return;
    }

    if (url.pathname === "/rooms" && method === "POST") {
      this.handleCreateRoom(req, res);
      return;
    }

    const joinMatch = url.pathname.match(/^\/rooms\/([^/]+)\/join$/);
    if (joinMatch && method === "POST") {
      this.handleJoinRoom(req, res, joinMatch[1]);
      return;
    }

    const roomMatch = url.pathname.match(/^\/rooms\/([^/]+)$/);
    if (roomMatch && method === "GET") {
      const room = this.rooms.get(roomMatch[1]);
      if (room) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: room.name, createdAt: room.createdAt }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "room not found" }));
      }
      return;
    }

    if (roomMatch && method === "DELETE") {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing token" }));
        return;
      }
      const token = auth.slice(7);
      const room = this.rooms.get(roomMatch[1]);
      if (!room || !safeEqual(token, room.token)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid token" }));
        return;
      }
      this.deleteRoom(roomMatch[1]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  };

  private handleCreateRoom(req: IncomingMessage, res: ServerResponse) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const name = typeof data.name === "string" && data.name.length > 0
          ? data.name.slice(0, 100)
          : `session-${nanoid(6)}`;
        const hostUserId = typeof data.hostUserId === "string" ? data.hostUserId.slice(0, 128) : undefined;
        const requireApproval = data.requireApproval === true;
        const readOnlyPatterns = Array.isArray(data.readOnlyPatterns)
          ? data.readOnlyPatterns.filter((p: unknown): p is string => typeof p === "string")
          : [];

        const now = Date.now();
        const room: Room = {
          id: randomUUID(),
          token: nanoid(24),
          name,
          createdAt: now,
          lastActivityAt: now,
          hostUserId,
          requireApproval,
          readOnlyPatterns: readOnlyPatterns.length > 0 ? readOnlyPatterns : undefined,
        };
        this.rooms.set(room.id, room);

        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: room.id, token: room.token, name: room.name }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid body" }));
      }
    });
  }

  private handleJoinRoom(req: IncomingMessage, res: ServerResponse, roomId: string) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const room = this.rooms.get(roomId);
        if (!room || !data.token || !safeEqual(data.token, room.token)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid room or token" }));
          return;
        }
        this.touchRoom(roomId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: room.id, name: room.name }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid body" }));
      }
    });
  }

  /* -- room helpers --------------------------------------------------- */

  private touchRoom(id: string) {
    const room = this.rooms.get(id);
    if (!room) return;
    room.lastActivityAt = Date.now();
    if (!this.touchTimers.has(id)) {
      this.touchTimers.set(
        id,
        setTimeout(() => this.touchTimers.delete(id), 5_000),
      );
    }
  }

  private deleteRoom(id: string) {
    this.rooms.delete(id);
    const timer = this.touchTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.touchTimers.delete(id);
    }
  }

  private authenticateUpgrade(
    url: URL,
    roomId: string,
  ): { ok: true } | { ok: false; code: number; reason: string } {
    const room = this.rooms.get(roomId);
    const token = url.searchParams.get("token");
    if (!room || !token || !safeEqual(token, room.token))
      return { ok: false, code: 403, reason: "Invalid room or token" };
    return { ok: true };
  }

  private rejectUpgrade(
    socket: import("stream").Duplex,
    code: number,
    reason: string,
  ) {
    socket.write(
      `HTTP/1.1 ${code} ${reason}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}`,
    );
    socket.destroy();
  }

  /* -- control WebSocket ---------------------------------------------- */

  private createControlWSS(): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

    const HOST_ONLY_TYPES = new Set([
      "kick", "summon", "present-start", "present-stop",
      "session-end", "set-permission", "host-transfer-offer",
    ]);

    wss.on("connection", (ws: WebSocket, req: IncomingMessage, roomId: string) => {
      const room = this.getOrCreateControlRoom(roomId);
      const serverRoom = this.rooms.get(roomId);

      const client: ControlClient = {
        ws,
        userId: "",
        displayName: "",
        isHost: false,
        isApproved: !serverRoom?.requireApproval,
        permission: serverRoom?.defaultPermission || "read-write",
        joinOrder: room.nextJoinOrder++,
      };
      room.clients.set(ws, client);

      ws.on("error", () => ws.close());
      ws.on("message", (raw) => {
        const data = raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw instanceof Buffer
            ? raw
            : Buffer.concat(raw as Buffer[]);
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (typeof msg.type !== "string") return;

        this.touchRoom(roomId);

        if (msg.type === "ping") {
          this.sendJson(ws, { type: "pong", timestamp: msg.timestamp });
          return;
        }

        if (msg.type === "join-request") this.handleControlJoinRequest(ws, room, client, serverRoom, msg, roomId);
        else if (msg.type === "join-response" && client.isHost) this.handleControlJoinResponse(room, msg);
        else if (msg.type === "kick" && client.isHost) this.handleControlKick(room, client, msg, roomId);
        else if (msg.type === "set-permission" && client.isHost) this.handleControlSetPermission(room, msg, roomId);
        else if (msg.type === "host-transfer-offer" && client.isHost) this.handleControlTransferOffer(room, client, msg);
        else if (msg.type === "host-transfer-accept") this.handleControlTransferAccept(room, client, msg, serverRoom, roomId);
        else if (msg.type === "host-transfer-decline") this.handleControlTransferDecline(room, client, msg);
        else if (msg.type === "presence-update") this.handleControlPresenceUpdate(room, client, msg, data.toString(), ws);
        else {
          if (!client.isApproved) return;
          if (HOST_ONLY_TYPES.has(msg.type) && !client.isHost) return;
          if (msg.type === "summon" && typeof msg.targetUserId === "string" && msg.targetUserId !== "__all__") {
            this.sendToUser(room, msg.targetUserId, data.toString());
            return;
          }
          this.broadcastControl(room, data.toString(), ws);
        }
      });

      ws.on("close", () => this.handleControlDisconnect(ws, room, roomId));
    });

    return wss;
  }

  private getOrCreateControlRoom(roomId: string): ControlRoom {
    let room = this.controlRooms.get(roomId);
    if (!room) {
      room = {
        clients: new Map(),
        pendingApprovals: new Map(),
        pendingTransferTarget: null,
        kickedUserIds: new Set(),
        nextJoinOrder: 0,
      };
      this.controlRooms.set(roomId, room);
    }
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = undefined;
    }
    return room;
  }

  private sendJson(ws: WebSocket, obj: Record<string, unknown>) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }

  private broadcastControl(room: ControlRoom, msg: string, exclude?: WebSocket) {
    for (const [ws, client] of room.clients) {
      if (ws !== exclude && client.isApproved) {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch { /* ignore */ }
      }
    }
  }

  private sendToUser(room: ControlRoom, userId: string, msg: string) {
    for (const [ws, client] of room.clients) {
      if (client.userId === userId) {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch { /* ignore */ }
      }
    }
  }

  private getHostClient(room: ControlRoom): ControlClient | undefined {
    for (const client of room.clients.values()) {
      if (client.isHost) return client;
    }
    return undefined;
  }

  private determineHost(client: ControlClient, room: ControlRoom, serverRoom: Room | undefined) {
    if (serverRoom?.hostUserId && client.userId === serverRoom.hostUserId) {
      client.isHost = true;
    } else {
      client.isHost = !this.getHostClient(room);
    }
  }

  /* control message handlers */

  private handleControlJoinRequest(
    ws: WebSocket,
    room: ControlRoom,
    client: ControlClient,
    serverRoom: Room | undefined,
    msg: Record<string, unknown>,
    roomId: string,
  ) {
    if (!client.userId) {
      client.userId = typeof msg.userId === "string" ? msg.userId.slice(0, 128) : "";
      this.determineHost(client, room, serverRoom);
    }
    client.displayName = typeof msg.displayName === "string" ? msg.displayName.slice(0, 100) : "";

    if (client.isHost) {
      client.isApproved = true;
      this.sendJson(ws, {
        type: "join-response", approved: true,
        permission: client.permission,
        readOnlyPatterns: serverRoom?.readOnlyPatterns,
        isHost: true,
      });
    } else if (room.kickedUserIds.has(client.userId)) {
      room.kickedUserIds.delete(client.userId);
      client.isApproved = false;
      room.pendingApprovals.set(client.userId, ws);
      const host = this.getHostClient(room);
      if (host) this.sendJson(host.ws, {
        type: "join-request", userId: client.userId,
        displayName: client.displayName, avatarUrl: (msg.avatarUrl as string) || "",
        verified: false,
      });
    } else if (serverRoom?.requireApproval) {
      client.isApproved = false;
      room.pendingApprovals.set(client.userId, ws);
      const host = this.getHostClient(room);
      if (host) this.sendJson(host.ws, {
        type: "join-request", userId: client.userId,
        displayName: client.displayName, avatarUrl: (msg.avatarUrl as string) || "",
        verified: false,
      });
    } else {
      client.isApproved = true;
      this.sendJson(ws, {
        type: "join-response", approved: true,
        permission: client.permission,
        readOnlyPatterns: serverRoom?.readOnlyPatterns,
        isHost: client.isHost,
      });
    }
  }

  private handleControlJoinResponse(room: ControlRoom, msg: Record<string, unknown>) {
    const targetUserId = msg.userId;
    if (typeof targetUserId !== "string" || typeof msg.approved !== "boolean") return;
    const targetWs = room.pendingApprovals.get(targetUserId);
    if (!targetWs) return;
    room.pendingApprovals.delete(targetUserId);
    const targetClient = room.clients.get(targetWs);
    if (!targetClient) return;
    targetClient.isApproved = msg.approved;
    if (msg.permission === "read-write" || msg.permission === "read-only") {
      targetClient.permission = msg.permission;
    }
    this.sendJson(targetWs, {
      type: "join-response", approved: targetClient.isApproved,
      permission: targetClient.permission, isHost: targetClient.isHost,
    });
  }

  private handleControlKick(room: ControlRoom, client: ControlClient, msg: Record<string, unknown>, roomId: string) {
    const targetUserId = msg.userId;
    if (typeof targetUserId !== "string") return;
    room.kickedUserIds.add(targetUserId);
    for (const [ws, target] of room.clients) {
      if (target.userId === targetUserId) {
        this.sendJson(ws, { type: "kicked" });
        ws.close();
      }
    }
  }

  private handleControlSetPermission(room: ControlRoom, msg: Record<string, unknown>, _roomId: string) {
    const targetUserId = msg.userId;
    if (typeof targetUserId !== "string") return;
    const permission = msg.permission;
    if (permission !== "read-write" && permission !== "read-only") return;
    for (const [ws, target] of room.clients) {
      if (target.userId === targetUserId) {
        target.permission = permission;
        this.sendJson(ws, { type: "permission-update", permission });
      }
    }
  }

  private handleControlTransferOffer(room: ControlRoom, client: ControlClient, msg: Record<string, unknown>) {
    const targetUserId = msg.userId;
    if (typeof targetUserId !== "string") return;
    const target = this.findControlClient(room, targetUserId);
    if (!target?.isApproved) return;
    room.pendingTransferTarget = targetUserId;
    this.sendJson(target.ws, {
      type: "host-transfer-offer", userId: client.userId, displayName: client.displayName,
    });
  }

  private handleControlTransferAccept(
    room: ControlRoom, client: ControlClient, msg: Record<string, unknown>,
    serverRoom: Room | undefined, roomId: string,
  ) {
    if (room.pendingTransferTarget !== client.userId) return;
    room.pendingTransferTarget = null;
    const targetUserId = msg.userId;
    if (typeof targetUserId !== "string") return;
    const oldHost = this.findControlClient(room, targetUserId);
    if (!oldHost?.isHost) return;
    oldHost.isHost = false;
    client.isHost = true;
    if (serverRoom) {
      serverRoom.hostUserId = client.userId;
      this.touchRoom(roomId);
    }
    this.sendJson(client.ws, { type: "host-transfer-complete", userId: client.userId, displayName: client.displayName });
    this.broadcastControl(room, JSON.stringify({ type: "host-changed", userId: client.userId, displayName: client.displayName }), client.ws);
  }

  private handleControlTransferDecline(room: ControlRoom, client: ControlClient, msg: Record<string, unknown>) {
    room.pendingTransferTarget = null;
    const targetUserId = msg.userId;
    if (typeof targetUserId !== "string") return;
    const oldHost = this.findControlClient(room, targetUserId);
    if (oldHost) this.sendJson(oldHost.ws, { type: "host-transfer-decline", userId: client.userId, displayName: client.displayName });
  }

  private handleControlPresenceUpdate(room: ControlRoom, client: ControlClient, msg: Record<string, unknown>, rawData: string, senderWs: WebSocket) {
    if (typeof msg.userId === "string" && msg.userId && !client.userId) {
      client.userId = msg.userId.slice(0, 128);
    }
    if (typeof msg.displayName === "string") client.displayName = msg.displayName.slice(0, 100);
    this.broadcastControl(room, rawData, senderWs);
  }

  private handleControlDisconnect(ws: WebSocket, room: ControlRoom, roomId: string) {
    const closingClient = room.clients.get(ws);
    const wasHost = closingClient?.isHost ?? false;
    if (closingClient?.userId) {
      const leaveMsg = JSON.stringify({ type: "presence-leave", userId: closingClient.userId });
      this.broadcastControl(room, leaveMsg, ws);
    }
    room.clients.delete(ws);
    if (closingClient) room.pendingApprovals.delete(closingClient.userId);

    if (wasHost && room.clients.size > 0) {
      for (const [, pendingWs] of room.pendingApprovals) {
        this.sendJson(pendingWs, { type: "join-response", approved: false, isHost: false });
      }
      room.pendingApprovals.clear();
      let newHost: ControlClient | undefined;
      for (const c of room.clients.values()) {
        if (c.isApproved && (!newHost || c.joinOrder < newHost.joinOrder)) newHost = c;
      }
      if (newHost) {
        newHost.isHost = true;
        const serverRoom = this.rooms.get(roomId);
        if (serverRoom) serverRoom.hostUserId = newHost.userId;
        this.sendJson(newHost.ws, { type: "host-transfer-complete", userId: newHost.userId, displayName: newHost.displayName });
        this.broadcastControl(room, JSON.stringify({ type: "host-changed", userId: newHost.userId, displayName: newHost.displayName }), newHost.ws);
      } else {
        this.broadcastControl(room, JSON.stringify({ type: "host-disconnected" }));
      }
    }

    if (room.clients.size === 0) {
      room.cleanupTimer = setTimeout(() => {
        if (room.clients.size === 0) {
          this.controlRooms.delete(roomId);
        }
      }, 35_000);
    }
  }

  private findControlClient(room: ControlRoom, userId: string): ControlClient | undefined {
    for (const client of room.clients.values()) {
      if (client.userId === userId) return client;
    }
    return undefined;
  }

  private closeAllControlRooms() {
    for (const room of this.controlRooms.values()) {
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      for (const ws of room.clients.keys()) ws.close(1000, "server shutting down");
    }
    this.controlRooms.clear();
  }

  /* -- mux WebSocket -------------------------------------------------- */

  private createMuxWSS(): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });

    wss.on("connection", (ws: WebSocket, req: IncomingMessage, baseRoomId: string) => {
      const reqUrl = new URL(req.url || "", `http://${req.headers.host}`);
      const userId = reqUrl.searchParams.get("userId");

      const client: MuxClient = {
        ws,
        subscribedRooms: new Set(),
        userId,
        baseRoomId,
      };

      ws.on("error", () => ws.close());
      ws.on("message", (raw) => {
        const data = raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : raw instanceof Buffer
            ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
            : new Uint8Array(Buffer.concat(raw as Buffer[]));
        try {
          const { docId, msgType, payload } = decodeMuxMessage(data);
          switch (msgType) {
            case MUX_SUBSCRIBE:
              this.handleMuxSubscribe(client, baseRoomId, docId, payload);
              break;
            case MUX_UNSUBSCRIBE:
              this.handleMuxUnsubscribe(client, docId);
              break;
            case MUX_SYNC:
              this.handleMuxSync(client, docId, payload, false);
              break;
            case MUX_SYNC_ENCRYPTED:
              this.handleMuxSync(client, docId, payload, true);
              break;
            case MUX_AWARENESS:
              this.handleMuxAwareness(client, docId, payload, false);
              break;
            case MUX_AWARENESS_ENCRYPTED:
              this.handleMuxAwareness(client, docId, payload, true);
              break;
          }
        } catch (err) {
          console.error("[embedded-mux] failed to handle message:", err);
        }
      });

      ws.on("close", () => this.removeMuxClientFromAll(client));
    });

    return wss;
  }

  private getOrCreateMuxRoom(roomId: string): MuxRoomState {
    let state = this.muxRoomStates.get(roomId);
    if (!state) {
      state = { clients: new Set(), readOnlyClients: new Set(), clientAwarenessIds: new Map() };
      this.muxRoomStates.set(roomId, state);
    }
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = undefined;
    }
    return state;
  }

  private scheduleMuxCleanup(roomId: string, state: MuxRoomState) {
    if (state.clients.size === 0) {
      state.cleanupTimer = setTimeout(() => {
        if (state.clients.size === 0) this.muxRoomStates.delete(roomId);
      }, 30_000);
    }
  }

  private safeMuxSend(ws: WebSocket, data: Uint8Array | string) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch { /* ignore */ }
  }

  private handleMuxSubscribe(client: MuxClient, baseRoomId: string, docId: string, payload: Uint8Array) {
    const roomId = `${baseRoomId}:${docId}`;
    const state = this.getOrCreateMuxRoom(roomId);
    const peerCount = state.clients.size;
    state.clients.add(client);
    client.subscribedRooms.add(roomId);

    if (payload.length > 0) {
      try {
        const decoder = decoding.createDecoder(payload);
        const clientId = decoding.readVarUint(decoder);
        let ids = state.clientAwarenessIds.get(client);
        if (!ids) { ids = new Set(); state.clientAwarenessIds.set(client, ids); }
        ids.add(clientId);
      } catch { /* ignore */ }
    }

    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, peerCount);
    this.safeMuxSend(client.ws, encodeMuxMessage(docId, MUX_SUBSCRIBED, encoding.toUint8Array(enc)));

    if (peerCount > 0) {
      const syncReq = encodeMuxMessage(docId, MUX_SYNC_REQUEST);
      for (const peer of state.clients) {
        if (peer !== client) this.safeMuxSend(peer.ws, syncReq);
      }
    }
  }

  private handleMuxUnsubscribe(client: MuxClient, docId: string) {
    this.removeMuxClientFromRoom(client, `${client.baseRoomId}:${docId}`);
  }

  private handleMuxSync(client: MuxClient, docId: string, payload: Uint8Array, encrypted: boolean) {
    const roomId = `${client.baseRoomId}:${docId}`;
    const state = this.muxRoomStates.get(roomId);
    if (!state || !state.clients.has(client)) return;
    const msgType = encrypted ? MUX_SYNC_ENCRYPTED : MUX_SYNC;
    const msg = encodeMuxMessage(docId, msgType, payload);
    for (const peer of state.clients) {
      if (peer !== client) this.safeMuxSend(peer.ws, msg);
    }
  }

  private handleMuxAwareness(client: MuxClient, docId: string, payload: Uint8Array, encrypted: boolean) {
    const roomId = `${client.baseRoomId}:${docId}`;
    const state = this.muxRoomStates.get(roomId);
    if (!state || !state.clients.has(client)) return;

    if (!encrypted) {
      try {
        const decoder = decoding.createDecoder(payload);
        const len = decoding.readVarUint(decoder);
        let ids = state.clientAwarenessIds.get(client);
        if (!ids) { ids = new Set(); state.clientAwarenessIds.set(client, ids); }
        for (let i = 0; i < len; i++) {
          ids.add(decoding.readVarUint(decoder));
        }
      } catch { /* ignore */ }
    }

    const msgType = encrypted ? MUX_AWARENESS_ENCRYPTED : MUX_AWARENESS;
    const msg = encodeMuxMessage(docId, msgType, payload);
    for (const peer of state.clients) {
      if (peer !== client) this.safeMuxSend(peer.ws, msg);
    }
  }

  private removeMuxClientFromRoom(client: MuxClient, roomId: string) {
    const state = this.muxRoomStates.get(roomId);
    if (!state) return;
    state.clients.delete(client);
    state.readOnlyClients.delete(client);
    client.subscribedRooms.delete(roomId);

    const clientIds = state.clientAwarenessIds.get(client);
    if (clientIds && clientIds.size > 0 && state.clients.size > 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, clientIds.size);
      for (const id of clientIds) {
        encoding.writeVarUint(enc, id);
        encoding.writeVarUint(enc, 0);
        encoding.writeVarString(enc, "null");
      }
      const docId = roomId.includes(":") ? roomId.slice(roomId.indexOf(":") + 1) : roomId;
      this.safeMuxSend(client.ws, encodeMuxMessage(docId, MUX_AWARENESS, encoding.toUint8Array(enc)));
    }
    state.clientAwarenessIds.delete(client);
    this.scheduleMuxCleanup(roomId, state);
  }

  private removeMuxClientFromAll(client: MuxClient) {
    for (const roomId of [...client.subscribedRooms]) {
      this.removeMuxClientFromRoom(client, roomId);
    }
  }

  private closeAllMuxRooms() {
    for (const state of this.muxRoomStates.values()) {
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
      for (const client of state.clients) client.ws.close(1000, "server shutting down");
    }
    this.muxRoomStates.clear();
  }

  private countMuxClients(): number {
    const unique = new Set<WebSocket>();
    for (const state of this.muxRoomStates.values()) {
      for (const client of state.clients) unique.add(client.ws);
    }
    return unique.size;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

import { createHmac, timingSafeEqual } from "node:crypto";

const COMPARE_KEY = "live-share-token-compare";

function safeEqual(actual: string, expected: string): boolean {
  const hmacActual = createHmac("sha256", COMPARE_KEY).update(actual).digest();
  const hmacExpected = createHmac("sha256", COMPARE_KEY).update(expected).digest();
  return timingSafeEqual(hmacActual, hmacExpected);
}
