// server/server.js
// Site + Online (SSE + POST) in one Render Web Service.
// Structure:
// server/
//   server.js
//   package.json
//   public/index.html
//
// Optional protection key:
//   GAME_KEY=1234 (Render env var)

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");

const app = express();
const PORT = process.env.PORT || 8080;
const GAME_KEY = process.env.GAME_KEY || "";

const MAX_INPUT_PER_SEC = 30;
const SESSION_TTL_MS = 35_000;

// Game constants
const FIELD = { w: 40, h: 24 };
const GOAL = { halfH: 4.2 };
const MATCH_DUR = 6 * 60;

const STYLE = { speed: 7.1, kickShoot: 16.0, kickPass: 10.0, control: 1.0 };

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));

// =====================
// ✅ ТВОЙ КОД (фикс Cannot GET /)
// =====================

// раздаём сайт
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// на всякий случай фикс именно для /
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =====================
// Game state
// =====================
const game = {
  t: 0,
  matchLeft: MATCH_DUR,
  score: { p1: 0, p2: 0 },
  players: {
    p1: { name: "P1", x: -10, z: 0, vx: 0, vz: 0, rot: 0, hasBall: false },
    p2: { name: "P2", x:  10, z: 0, vx: 0, vz: 0, rot: Math.PI, hasBall: false },
  },
  ball: { x: 0, z: 0, vx: 0, vz: 0 },
};

// token -> session
// session: { role, name, input, sseRes, lastSeen, rateSec, rateCount }
const sessions = new Map();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function countRoles() {
  let p1 = 0, p2 = 0, spec = 0;
  for (const s of sessions.values()) {
    if (s.role === "p1") p1++;
    else if (s.role === "p2") p2++;
    else spec++;
  }
  return { p1, p2, spec, total: sessions.size };
}

function pickRole() {
  const c = countRoles();
  if (c.p1 === 0) return "p1";
  if (c.p2 === 0) return "p2";
  return "spec";
}

function sseSend(res, event, dataObj) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

function broadcast(event, dataObj) {
  for (const s of sessions.values()) {
    if (s.sseRes && !s.sseRes.writableEnded) sseSend(s.sseRes, event, dataObj);
  }
}

function resetKickoff(kickoff) {
  game.players.p1.x = -10; game.players.p1.z = 0; game.players.p1.vx = 0; game.players.p1.vz = 0; game.players.p1.hasBall = false;
  game.players.p2.x =  10; game.players.p2.z = 0; game.players.p2.vx = 0; game.players.p2.vz = 0; game.players.p2.hasBall = false;
  game.ball.x = 0; game.ball.z = 0; game.ball.vx = 0; game.ball.vz = 0;
  game.ball.vx = kickoff === "p1" ? -0.2 : 0.2;
}

function applyMove(p, inp, dt) {
  const mx = clamp(inp.moveX || 0, -1, 1);
  const mz = clamp(inp.moveZ || 0, -1, 1);
  const l = Math.hypot(mx, mz);
  const nx = l > 1 ? mx / l : mx;
  const nz = l > 1 ? mz / l : mz;

  const sprint = !!inp.sprint && l > 0.05;
  const sp = STYLE.speed * (sprint ? 1.35 : 1.0);

  p.vx = nx * sp;
  p.vz = nz * sp;

  p.x = clamp(p.x + p.vx * dt, -FIELD.w / 2, FIELD.w / 2);
  p.z = clamp(p.z + p.vz * dt, -FIELD.h / 2, FIELD.h / 2);

  if (Math.hypot(p.vx, p.vz) > 0.1) p.rot = Math.atan2(p.vx, p.vz);
}

function updatePossession() {
  const b = game.ball;
  const p1 = game.players.p1;
  const p2 = game.players.p2;

  const d1 = Math.hypot(b.x - p1.x, b.z - p1.z);
  const d2 = Math.hypot(b.x - p2.x, b.z - p2.z);

  const r = 1.05 * STYLE.control;
  p1.hasBall = d1 < r;
  p2.hasBall = d2 < r;

  if (p1.hasBall && p2.hasBall) {
    if (d1 <= d2) p2.hasBall = false;
    else p1.hasBall = false;
  }

  const owner = p1.hasBall ? p1 : (p2.hasBall ? p2 : null);
  if (owner) {
    const fx = Math.sin(owner.rot), fz = Math.cos(owner.rot);
    const tx = owner.x + fx * 0.9;
    const tz = owner.z + fz * 0.9;
    b.vx += (tx - b.x) * 16 * STYLE.control;
    b.vz += (tz - b.z) * 16 * STYLE.control;
  }
}

function kick(p, kind) {
  if (!p.hasBall) return;
  const b = game.ball;
  const fx = Math.sin(p.rot), fz = Math.cos(p.rot);
  const power = (kind === "pass") ? STYLE.kickPass : STYLE.kickShoot;
  p.hasBall = false;
  b.vx += fx * power;
  b.vz += fz * power;
}

function updateBall(dt) {
  const b = game.ball;

  b.vx *= Math.pow(0.22, dt);
  b.vz *= Math.pow(0.22, dt);

  b.x += b.vx * dt;
  b.z += b.vz * dt;

  const lx = -FIELD.w / 2, rx = FIELD.w / 2, tz = -FIELD.h / 2, bz = FIELD.h / 2;

  if (b.z < tz) { b.z = tz; b.vz = Math.abs(b.vz) * 0.8; }
  if (b.z > bz) { b.z = bz; b.vz = -Math.abs(b.vz) * 0.8; }

  if (b.x < lx && Math.abs(b.z) > GOAL.halfH) { b.x = lx; b.vx = Math.abs(b.vx) * 0.8; }
  if (b.x > rx && Math.abs(b.z) > GOAL.halfH) { b.x = rx; b.vx = -Math.abs(b.vx) * 0.8; }

  // goals
  if (b.x < lx && Math.abs(b.z) <= GOAL.halfH) {
    game.score.p2++;
    resetKickoff("p1");
  }
  if (b.x > rx && Math.abs(b.z) <= GOAL.halfH) {
    game.score.p1++;
    resetKickoff("p2");
  }
}

// =====================
// API
// =====================
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/join", (req, res) => {
  const name = String(req.body?.name || "Player").slice(0, 14);
  const key = String(req.body?.key || "");

  if (GAME_KEY && key !== GAME_KEY) return res.status(403).json({ error: "Wrong key" });

  const role = pickRole();
  const token = crypto.randomBytes(24).toString("base64url");

  sessions.set(token, {
    role,
    name,
    input: { moveX: 0, moveZ: 0, sprint: false, shoot: false, pass: false },
    sseRes: null,
    lastSeen: Date.now(),
    rateSec: Math.floor(Date.now() / 1000),
    rateCount: 0,
  });

  if (role === "p1") game.players.p1.name = name;
  if (role === "p2") game.players.p2.name = name;

  res.json({ token, role });
});

app.get("/events", (req, res) => {
  const token = String(req.query.token || "");
  const sess = sessions.get(token);
  if (!sess) return res.status(401).end("bad token");

  sess.lastSeen = Date.now();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  });

  sess.sseRes = res;
  sseSend(res, "welcome", { role: sess.role, players: countRoles(), needKey: !!GAME_KEY });

  const ping = setInterval(() => {
    if (!res.writableEnded) res.write("event: ping\ndata: {}\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(ping);
    const s = sessions.get(token);
    if (s) s.sseRes = null;
  });
});

app.post("/input", (req, res) => {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const sess = sessions.get(token);
  if (!sess) return res.status(401).json({ error: "bad token" });

  sess.lastSeen = Date.now();

  // spectators can't control
  if (sess.role !== "p1" && sess.role !== "p2") return res.json({ ok: true });

  // rate limit
  const sec = Math.floor(Date.now() / 1000);
  if (sess.rateSec !== sec) { sess.rateSec = sec; sess.rateCount = 0; }
  sess.rateCount++;
  if (sess.rateCount > MAX_INPUT_PER_SEC) return res.status(429).json({ error: "too many inputs" });

  const msg = req.body || {};
  sess.input.moveX = clamp(msg.moveX || 0, -1, 1);
  sess.input.moveZ = clamp(msg.moveZ || 0, -1, 1);
  sess.input.sprint = !!msg.sprint;
  sess.input.shoot  = !!msg.shoot;
  sess.input.pass   = !!msg.pass;

  res.json({ ok: true });
});

// =====================
// Start server
// =====================
app.listen(PORT, () => {
  console.log("Server running on port:", PORT);
});

// =====================
// Simulation loop
// =====================
let last = Date.now();
let sendAcc = 0;

setInterval(() => {
  const t = Date.now();
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;

  // cleanup idle sessions
  const now = Date.now();
  let removedPlayer = false;
  for (const [token, s] of sessions.entries()) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      if (s.role === "p1" || s.role === "p2") removedPlayer = true;
      try { s.sseRes?.end?.(); } catch {}
      sessions.delete(token);
    }
  }
  if (removedPlayer) resetKickoff("p1");

  // find p1/p2 sessions
  let p1S = null, p2S = null;
  for (const s of sessions.values()) {
    if (s.role === "p1") p1S = s;
    if (s.role === "p2") p2S = s;
  }

  const hasTwo = !!p1S?.sseRes && !!p2S?.sseRes;
  if (hasTwo) game.matchLeft = Math.max(0, game.matchLeft - dt);

  if (p1S) applyMove(game.players.p1, p1S.input, dt);
  if (p2S) applyMove(game.players.p2, p2S.input, dt);

  updatePossession();

  if (p1S) {
    if (p1S.input.shoot) kick(game.players.p1, "shoot");
    if (p1S.input.pass)  kick(game.players.p1, "pass");
    p1S.input.shoot = false; p1S.input.pass = false;
  }
  if (p2S) {
    if (p2S.input.shoot) kick(game.players.p2, "shoot");
    if (p2S.input.pass)  kick(game.players.p2, "pass");
    p2S.input.shoot = false; p2S.input.pass = false;
  }

  updateBall(dt);
  game.t += dt;

  // send state at 20Hz
  sendAcc += dt;
  if (sendAcc >= 0.05) {
    sendAcc = 0;
    broadcast("state", {
      t: game.t,
      matchLeft: game.matchLeft,
      score: game.score,
      players: {
        p1: { name: game.players.p1.name, x: game.players.p1.x, z: game.players.p1.z, rot: game.players.p1.rot },
        p2: { name: game.players.p2.name, x: game.players.p2.x, z: game.players.p2.z, rot: game.players.p2.rot },
      },
      ball: { x: game.ball.x, z: game.ball.z },
    });
  }
}, 1000 / 60);
