import { DurableObject } from "cloudflare:workers";

const DEFAULT_TEAMS = [
  { id: "t1", name: "第 1 組", score: 0 },
  { id: "t2", name: "第 2 組", score: 0 },
  { id: "t3", name: "第 3 組", score: 0 },
];

function clip(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function emptyRoom() {
  return {
    submittedBoards: [],
    teams: DEFAULT_TEAMS.map((team) => ({ ...team })),
    activePuzzle: null,
  };
}

function sanitizeCard(card) {
  if (!card || !Array.isArray(card.words) || card.words.length !== 4) return null;
  const words = card.words.map((word) => clip(word, 16));
  if (words.some((word) => !word)) return null;
  const rot = Number(card.rot) || 0;
  return { words, rot: ((rot % 4) + 4) % 4 };
}

function sanitizeBoard(board) {
  if (!board || typeof board !== "object") return null;
  const clues = board.clues || {};
  const clean = {
    N: clip(clues.N, 24),
    E: clip(clues.E, 24),
    S: clip(clues.S, 24),
    W: clip(clues.W, 24),
  };
  if (!clean.N || !clean.E || !clean.S || !clean.W) return null;
  if (!Array.isArray(board.solutionCards) || board.solutionCards.length !== 4) return null;
  const solutionCards = board.solutionCards.map(sanitizeCard);
  if (solutionCards.some((card) => !card)) return null;
  return {
    id: clip(board.id, 64) || `b_${Date.now()}`,
    author: clip(board.author, 24) || "團友",
    clues: clean,
    solutionCards,
    solved: !!board.solved,
  };
}

function redactBoard(board) {
  return {
    id: board.id,
    author: board.author,
    clues: board.clues,
    solved: !!board.solved,
    solutionCards: [],
  };
}

function sanitizeTeams(teams) {
  if (!Array.isArray(teams) || teams.length === 0) return null;
  return teams.slice(0, 12).map((team, index) => ({
    id: clip(team && team.id, 40) || `t${index + 1}`,
    name: clip(team && team.name, 24) || `第 ${index + 1} 組`,
    score: Math.max(-999, Math.min(9999, Number(team && team.score) || 0)),
  }));
}

function sanitizePuzzle(puzzle) {
  if (!puzzle || typeof puzzle !== "object") return null;
  let raw;
  try {
    raw = JSON.stringify(puzzle);
  } catch {
    return null;
  }
  if (!raw || raw.length > 80000) return null;
  const copy = JSON.parse(raw);
  if (!copy.clues || typeof copy.clues !== "object") return null;
  copy.boardId = clip(copy.boardId, 64);
  copy.author = clip(copy.author, 24) || "團友";
  copy.attempt = copy.attempt === 2 ? 2 : 1;
  copy.finished = !!copy.finished;
  copy.clues = {
    N: clip(copy.clues.N, 24),
    E: clip(copy.clues.E, 24),
    S: clip(copy.clues.S, 24),
    W: clip(copy.clues.W, 24),
  };
  if (!Array.isArray(copy.slots) || copy.slots.length !== 4) copy.slots = [null, null, null, null];
  copy.slots = copy.slots.slice(0, 4).map((slot) => (slot ? sanitizeCard(slot) : null));
  if (!Array.isArray(copy.lockedSlots) || copy.lockedSlots.length !== 4) {
    copy.lockedSlots = [false, false, false, false];
  }
  copy.lockedSlots = copy.lockedSlots.slice(0, 4).map(Boolean);
  copy.pool = Array.isArray(copy.pool) ? copy.pool.slice(0, 12).map(sanitizeCard).filter(Boolean) : [];
  if (Array.isArray(copy.solutionCards)) {
    copy.solutionCards = copy.solutionCards.slice(0, 4).map(sanitizeCard).filter(Boolean);
  }
  return copy;
}

export class SoCloverRoom extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      playerId: crypto.randomUUID(),
      name: clip(url.searchParams.get("name"), 24) || "團友",
      role: url.searchParams.get("role") === "host" ? "host" : "player",
      submitted: false,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      data = JSON.parse(text);
    } catch {
      return;
    }
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;

    if (data.type === "JOIN") {
      const attachment = ws.deserializeAttachment() || {};
      attachment.name = clip(data.name, 24) || attachment.name || "團友";
      attachment.role = data.role === "host" ? "host" : "player";
      ws.serializeAttachment(attachment);
      await this.broadcastRoom();
      if (attachment.role === "host") {
        const room = await this.loadRoom();
        if (room.activePuzzle) {
          this.safeSend(ws, { type: "ACTIVE_PUZZLE_SYNC", activePuzzle: room.activePuzzle });
        }
      }
      return;
    }

    const host = this.isHost(ws);

    if (data.type === "DISPATCH_BOARDS") {
      if (!host) return;
      this.broadcastExcept(ws, { type: "DISPATCH_BOARDS" });
      return;
    }

    if (data.type === "SUBMIT_BOARD") {
      const board = sanitizeBoard(data.board);
      if (!board) return;
      const room = await this.loadRoom();
      if (!room.submittedBoards.some((item) => item.id === board.id)) {
        room.submittedBoards.push(board);
        if (room.submittedBoards.length > 40) {
          room.submittedBoards = room.submittedBoards.slice(-40);
        }
        await this.ctx.storage.put("room", room);
      }
      const attachment = ws.deserializeAttachment() || {};
      attachment.submitted = true;
      ws.serializeAttachment(attachment);
      for (const sock of this.ctx.getWebSockets()) {
        const role = (sock.deserializeAttachment() || {}).role;
        this.safeSend(sock, {
          type: "NEW_BOARD_SUBMITTED",
          board: role === "host" ? board : redactBoard(board),
        });
      }
      await this.broadcastRoom();
      return;
    }

    if (data.type === "ACTIVE_PUZZLE_SYNC") {
      if (!host) return;
      const puzzle = sanitizePuzzle(data.activePuzzle);
      if (!puzzle) return;
      const room = await this.loadRoom();
      room.activePuzzle = puzzle;
      if (puzzle.finished && puzzle.boardId) {
        const found = room.submittedBoards.find((item) => item.id === puzzle.boardId);
        if (found) found.solved = true;
      }
      await this.ctx.storage.put("room", room);
      this.broadcastToRole("host", { type: "ACTIVE_PUZZLE_SYNC", activePuzzle: puzzle });
      if (puzzle.finished) await this.broadcastRoom();
      return;
    }

    if (data.type === "SYNC_TEAMS") {
      if (!host) return;
      const teams = sanitizeTeams(data.teams);
      if (!teams) return;
      const room = await this.loadRoom();
      room.teams = teams;
      await this.ctx.storage.put("room", room);
      await this.broadcastRoom();
      return;
    }

    if (data.type === "RESET") {
      if (!host) return;
      await this.ctx.storage.put("room", emptyRoom());
      for (const sock of this.ctx.getWebSockets()) {
        const attachment = sock.deserializeAttachment() || {};
        attachment.submitted = false;
        sock.serializeAttachment(attachment);
      }
      await this.broadcastRoom();
      this.broadcastToRole("host", { type: "ACTIVE_PUZZLE_SYNC", activePuzzle: null });
    }
  }

  async webSocketClose(ws) {
    await this.broadcastRoom(ws);
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, "error");
    } catch {
      // The socket is already gone.
    }
  }

  isHost(ws) {
    return (ws.deserializeAttachment() || {}).role === "host";
  }

  async loadRoom() {
    const stored = await this.ctx.storage.get("room");
    if (!stored || typeof stored !== "object") return emptyRoom();
    const teams = sanitizeTeams(stored.teams) || emptyRoom().teams;
    return {
      submittedBoards: Array.isArray(stored.submittedBoards) ? stored.submittedBoards : [],
      teams,
      activePuzzle: stored.activePuzzle || null,
    };
  }

  safeSend(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Drop a socket that already closed.
    }
  }

  liveSockets(skip) {
    return this.ctx.getWebSockets().filter((sock) => sock !== skip);
  }

  async broadcastRoom(skip) {
    const room = await this.loadRoom();
    const sockets = this.liveSockets(skip);
    const players = sockets.map((sock) => {
      const attachment = sock.deserializeAttachment() || {};
      return {
        id: attachment.playerId || "",
        name: attachment.name || "團友",
        role: attachment.role === "host" ? "host" : "player",
        submitted: !!attachment.submitted,
      };
    });
    for (const sock of sockets) {
      const role = (sock.deserializeAttachment() || {}).role;
      this.safeSend(sock, {
        type: "ROOM_STATE",
        players,
        submittedBoards: role === "host" ? room.submittedBoards : room.submittedBoards.map(redactBoard),
        teams: room.teams,
      });
    }
  }

  broadcastExcept(skip, payload) {
    for (const sock of this.liveSockets(skip)) this.safeSend(sock, payload);
  }

  broadcastToRole(role, payload) {
    for (const sock of this.ctx.getWebSockets()) {
      if ((sock.deserializeAttachment() || {}).role === role) this.safeSend(sock, payload);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const room = clip(url.searchParams.get("room"), 12).replace(/[^A-Za-z0-9]/g, "") || "8888";
      return env.SO_CLOVER_ROOM.getByName(room).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
