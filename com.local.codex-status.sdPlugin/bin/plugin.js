#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const PLUGIN_UUID = "com.local.codex-status";
const UPDATE_MS = 2500;
const LOG_ACTIVE_MS = 75_000;
const DEFAULT_RECENT_MINUTES = 10;
const DEFAULT_DECK_COLUMNS = 3;
const DEFAULT_VISIBLE_SLOTS = 6;
const MAX_THREADS = 50;

const actions = new Map();
const snapshotCache = new Map();
let websocket;
let updateTimer;

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("-")) {
      continue;
    }
    const key = token.replace(/^-+/, "");
    const next = argv[index + 1];
    if (next && !next.startsWith("-")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function expandHome(value) {
  if (!value || value === "~/.codex") {
    return path.join(os.homedir(), ".codex");
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function sqliteJson(dbPath, sql) {
  return new Promise((resolve) => {
    if (!fs.existsSync(dbPath)) {
      resolve([]);
      return;
    }

    execFile("sqlite3", ["-json", dbPath, sql], { timeout: 2000, maxBuffer: 1024 * 1024 * 4 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve([]);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve([]);
      }
    });
  });
}

function readSessionIndex(codexHome, showArchived) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  if (!fs.existsSync(indexPath)) {
    return [];
  }

  const lines = fs.readFileSync(indexPath, "utf8").trim().split("\n").slice(-MAX_THREADS).reverse();
  return lines.flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      const updated = Date.parse(entry.updated_at || "") || 0;
      return [{
        id: entry.id,
        title: entry.thread_name || "Untitled",
        cwd: "",
        updated_at_ms: updated,
        recency_at_ms: updated,
        archived: showArchived ? 0 : 0,
        tokens_used: 0,
        preview: ""
      }];
    } catch {
      return [];
    }
  });
}

async function readSnapshot(settings = {}) {
  const codexHome = expandHome(settings.codexHome);
  const showArchived = Boolean(settings.showArchived);
  const recentMinutes = Number(settings.recentMinutes) || DEFAULT_RECENT_MINUTES;
  const cacheKey = `${codexHome}:${showArchived}:${recentMinutes}`;
  const cached = snapshotCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.createdAt < 1500) {
    return cached.snapshot;
  }

  const stateDb = path.join(codexHome, "state_5.sqlite");
  const logsDb = path.join(codexHome, "logs_2.sqlite");
  const where = showArchived ? "archived in (0, 1)" : "archived = 0";

  const [threads, logRows] = await Promise.all([
    sqliteJson(
      stateDb,
      `select id,
              coalesce(nullif(title, ''), nullif(first_user_message, ''), 'Untitled') as title,
              cwd,
              updated_at_ms,
              recency_at_ms,
              archived,
              tokens_used,
              substr(replace(replace(preview, char(10), ' '), char(13), ' '), 1, 90) as preview
         from threads
        where ${where}
        order by recency_at_ms desc
        limit ${MAX_THREADS}`
    ),
    sqliteJson(
      logsDb,
      `select thread_id, max(ts) * 1000 as last_log_ms
         from logs
        where thread_id is not null
        group by thread_id
        order by max(ts) desc
        limit 100`
    )
  ]);

  const logByThread = new Map(logRows.map((row) => [row.thread_id, Number(row.last_log_ms) || 0]));
  const sourceThreads = threads.length ? threads : readSessionIndex(codexHome, showArchived);

  const snapshot = sourceThreads.map((thread) => {
    const dbActivityMs = Number(thread.recency_at_ms || thread.updated_at_ms) || 0;
    const lastLogMs = logByThread.get(thread.id) || 0;
    const dbAgeMs = now - dbActivityMs;
    const logAgeMs = now - lastLogMs;
    const hasFreshThread = dbAgeMs <= recentMinutes * 60_000;
    const hasFreshLog = logAgeMs <= LOG_ACTIVE_MS && hasFreshThread;
    const lastActivityMs = hasFreshLog ? Math.max(dbActivityMs, lastLogMs) : dbActivityMs;
    const ageMs = now - lastActivityMs;
    const status = hasFreshLog
      ? "active"
      : hasFreshThread
        ? "recent"
        : "idle";

    return {
      id: thread.id,
      title: truncateText(thread.title || thread.preview || "Untitled", 120),
      cwd: cleanText(thread.cwd || ""),
      updatedAtMs: dbActivityMs,
      lastLogMs,
      lastActivityMs,
      ageMs,
      status,
      archived: Number(thread.archived) === 1,
      tokensUsed: Number(thread.tokens_used) || 0
    };
  });

  snapshotCache.set(cacheKey, { createdAt: now, snapshot });
  return snapshot;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value, maxChars) {
  const chars = [...cleanText(value)];
  if (chars.length <= maxChars) {
    return chars.join("");
  }
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function contextSlot(context, entry) {
  const explicit = Number(entry.settings.slot);
  if (Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }

  if (entry.coordinates) {
    const columns = Number(entry.settings.deckColumns) || DEFAULT_DECK_COLUMNS;
    const column = Number(entry.coordinates.column);
    const row = Number(entry.coordinates.row);
    if (Number.isInteger(column) && Number.isInteger(row) && column >= 0 && row >= 0) {
      return row * columns + column + 1;
    }
  }

  const orderedContexts = [...actions.keys()].sort();
  return Math.max(1, orderedContexts.indexOf(context) + 1);
}

function statusLabel(status) {
  if (status === "active") {
    return "진행중";
  }
  if (status === "recent") {
    return "최근";
  }
  return "대기";
}

function statusColors(status) {
  if (status === "active") {
    return { background: "#071b16", accent: "#10b981", muted: "#a7f3d0", text: "#f8fafc" };
  }
  if (status === "recent") {
    return { background: "#1c1917", accent: "#f59e0b", muted: "#fed7aa", text: "#fff7ed" };
  }
  return { background: "#111827", accent: "#64748b", muted: "#cbd5e1", text: "#f8fafc" };
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return "now";
  }
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function basename(value) {
  if (!value) {
    return "";
  }
  return path.basename(value);
}

function fitLines(value, maxLines, maxChars) {
  const chars = [...cleanText(value)];
  const lines = [];
  let cursor = 0;
  while (cursor < chars.length && lines.length < maxLines) {
    const slice = chars.slice(cursor, cursor + maxChars).join("");
    cursor += maxChars;
    lines.push(cursor < chars.length && lines.length === maxLines - 1 ? `${slice.slice(0, Math.max(0, maxChars - 1))}…` : slice);
  }
  return lines.length ? lines : [""];
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderThreadImage(thread, slot, total) {
  const colors = statusColors(thread ? thread.status : "idle");
  const label = thread ? statusLabel(thread.status) : "대기";
  const titleLines = fitLines(thread ? thread.title : "No session", 3, 9);
  const workspace = thread ? basename(thread.cwd) : "";
  const footer = thread ? `${formatAge(thread.ageMs)} ago` : `slot ${slot}`;
  const tokenText = `#${slot}`;

  const titleSvg = titleLines.map((line, index) => (
    `<text x="12" y="${58 + index * 19}" fill="${colors.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="17" font-weight="700">${escapeXml(line)}</text>`
  )).join("");

  const workspaceText = workspace
    ? `<text x="12" y="120" fill="${colors.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12">${escapeXml(fitLines(workspace, 1, 14)[0])}</text>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="18" fill="${colors.background}"/>
  <rect x="8" y="8" width="128" height="128" rx="14" fill="none" stroke="${colors.accent}" stroke-width="3" opacity="0.9"/>
  <circle cx="22" cy="25" r="6" fill="${colors.accent}"/>
  <text x="35" y="30" fill="${colors.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="15" font-weight="700">${escapeXml(label)}</text>
  <text x="128" y="30" fill="${colors.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12" text-anchor="end">${escapeXml(tokenText)}</text>
  ${titleSvg}
  ${workspaceText}
  <text x="132" y="132" fill="${colors.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11" text-anchor="end">${escapeXml(footer)}</text>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function send(message) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    return;
  }
  websocket.send(JSON.stringify(message));
}

async function updateAction(context, entry) {
  const slot = contextSlot(context, entry);
  const snapshot = await readSnapshot(entry.settings);
  const thread = snapshot[slot - 1];
  const image = renderThreadImage(thread, slot, snapshot.length);

  send({
    event: "setTitle",
    context,
    payload: {
      title: "",
      target: 0
    }
  });
  send({
    event: "setImage",
    context,
    payload: {
      image,
      target: 0
    }
  });
}

async function updateAll() {
  await Promise.all([...actions.entries()].map(([context, entry]) => updateAction(context, entry)));
}

function startTimer() {
  if (updateTimer) {
    clearInterval(updateTimer);
  }
  updateTimer = setInterval(() => {
    updateAll().catch(() => {});
  }, UPDATE_MS);
}

function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.event === "willAppear") {
    actions.set(message.context, {
      settings: message.payload && message.payload.settings ? message.payload.settings : {},
      coordinates: message.payload && message.payload.coordinates ? message.payload.coordinates : undefined
    });
    updateAction(message.context, actions.get(message.context)).catch(() => {});
    return;
  }

  if (message.event === "willDisappear") {
    actions.delete(message.context);
    return;
  }

  if (message.event === "didReceiveSettings" && actions.has(message.context)) {
    actions.get(message.context).settings = message.payload && message.payload.settings ? message.payload.settings : {};
    updateAction(message.context, actions.get(message.context)).catch(() => {});
    return;
  }

  if (message.event === "keyDown" && actions.has(message.context)) {
    snapshotCache.clear();
    updateAction(message.context, actions.get(message.context)).then(() => {
      send({ event: "showOk", context: message.context });
    }).catch(() => {});
  }
}

function connectToStreamDeck(args) {
  const port = args.port;
  const pluginUuid = args.pluginUUID || PLUGIN_UUID;
  const registerEvent = args.registerEvent || "registerPlugin";

  if (!port) {
    throw new Error("Missing Stream Deck -port argument.");
  }
  if (typeof WebSocket === "undefined") {
    throw new Error("This plugin requires Node.js 24 or newer for the built-in WebSocket client.");
  }

  websocket = new WebSocket(`ws://127.0.0.1:${port}`);
  websocket.addEventListener("open", () => {
    send({ event: registerEvent, uuid: pluginUuid });
    startTimer();
  });
  websocket.addEventListener("message", (event) => handleMessage(event.data));
  websocket.addEventListener("close", () => {
    if (updateTimer) {
      clearInterval(updateTimer);
    }
  });
}

async function preview() {
  const snapshot = await readSnapshot({});
  console.log(JSON.stringify(snapshot.slice(0, DEFAULT_VISIBLE_SLOTS).map((thread, index) => ({
    slot: index + 1,
    status: statusLabel(thread.status),
    title: thread.title,
    cwd: thread.cwd,
    lastActivity: new Date(thread.lastActivityMs).toISOString(),
    age: formatAge(thread.ageMs)
  })), null, 2));
}

const args = parseArgs(process.argv);
if (args.preview) {
  preview().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  try {
    connectToStreamDeck(args);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
