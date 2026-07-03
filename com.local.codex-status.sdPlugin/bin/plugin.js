#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const PLUGIN_UUID = "com.local.codex-status";
const SESSION_ACTION_UUID = "com.local.codex-status.session";
const TOKENS_ACTION_UUID = "com.local.codex-status.tokens";
const CURSOR_REQUESTS_ACTION_UUID = "com.local.codex-status.cursor-requests";
const UPDATE_MS = 700;
const LOG_ACTIVE_MS = 75_000;
const CURSOR_REQUEST_CACHE_MS = 30_000;
const DEFAULT_RECENT_MINUTES = 10;
const DEFAULT_DECK_COLUMNS = 3;
const DEFAULT_VISIBLE_SLOTS = 6;
const DEFAULT_FONT_SCALE = 100;
const DEFAULT_PROJECT_FONT_SIZE = 15;
const DEFAULT_TITLE_FONT_SIZE = 22;
const DEFAULT_ACTIVE_MESSAGE_FONT_SIZE = 18;
const DEFAULT_FOOTER_MESSAGE_FONT_SIZE = 12;
const DEFAULT_LABEL_FONT_SIZE = 11;
const MAX_THREADS = 50;
const OPEN_COMMAND = "/usr/bin/open";
const CURSOR_BUNDLE_ID = "com.todesktop.230313mzl4w4u92";

const actions = new Map();
const snapshotCache = new Map();
const conversationCache = new Map();
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
  if (!value) {
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

function defaultCursorDbPath() {
  return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
}

function sqlString(value) {
  return String(value).replace(/'/g, "''");
}

function sqliteJson(dbPath, sql, timeout = 5000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(dbPath)) {
      resolve([]);
      return;
    }

    execFile("sqlite3", ["-json", dbPath, sql], { timeout, maxBuffer: 1024 * 1024 * 4 }, (error, stdout) => {
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
        rollout_path: "",
        thread_source: "",
        preview: ""
      }];
    } catch {
      return [];
    }
  });
}

async function readSnapshot(settings = {}) {
  const provider = settings.provider === "cursor" ? "cursor" : "codex";
  if (provider === "cursor") {
    return readCursorSnapshot(settings);
  }
  return readCodexSnapshot(settings);
}

async function readCodexSnapshot(settings = {}) {
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
  const visibleWhere = `${where} and coalesce(thread_source, '') != 'subagent'`;

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
              rollout_path,
              substr(replace(replace(preview, char(10), ' '), char(13), ' '), 1, 90) as preview
         from threads
        where ${visibleWhere}
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

  const snapshot = await Promise.all(sourceThreads.map(async (thread) => {
    const dbActivityMs = Number(thread.recency_at_ms || thread.updated_at_ms) || 0;
    const lastLogMs = logByThread.get(thread.id) || 0;
    const taskState = readTaskState(thread.rollout_path);
    const dbAgeMs = now - dbActivityMs;
    const logAgeMs = now - lastLogMs;
    const hasFreshThread = dbAgeMs <= recentMinutes * 60_000;
    const taskIsOpen = taskState.lastEvent === "task_started";
    const hasOpenTaskState = Boolean(taskState.lastEvent);
    const hasFreshLog = hasOpenTaskState
      ? taskIsOpen
      : logAgeMs <= LOG_ACTIVE_MS && hasFreshThread;
    const lastActivityMs = hasFreshLog ? Math.max(dbActivityMs, lastLogMs) : dbActivityMs;
    const ageMs = now - lastActivityMs;
    const status = hasFreshLog
      ? "active"
      : hasFreshThread
        ? "recent"
        : "idle";

    return {
      provider: "codex",
      id: thread.id,
      title: truncateText(thread.title || thread.preview || "Untitled", 120),
      cwd: cleanText(thread.cwd || ""),
      latestMessage: await readLatestConversationText(thread.rollout_path),
      taskOpen: taskIsOpen,
      updatedAtMs: dbActivityMs,
      lastLogMs,
      lastActivityMs,
      ageMs,
      status,
      archived: Number(thread.archived) === 1,
      tokensUsed: Number(thread.tokens_used) || 0
    };
  }));

  snapshotCache.set(cacheKey, { createdAt: now, snapshot });
  return snapshot;
}

async function readTokenSnapshot(settings = {}) {
  const codexHome = expandHome(settings.codexHome);
  const cacheKey = `tokens:${codexHome}`;
  const cached = snapshotCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.createdAt < 1500) {
    return cached.snapshot;
  }

  const stateDb = path.join(codexHome, "state_5.sqlite");
  const rows = await sqliteJson(
    stateDb,
    `select id, rollout_path, recency_at_ms
       from threads
      where archived = 0
        and coalesce(thread_source, '') != 'subagent'
      order by recency_at_ms desc
      limit 20`
  );

  let latest = null;
  for (const row of rows) {
    const tokenEvent = readLatestTokenCount(row.rollout_path);
    if (!tokenEvent) {
      continue;
    }
    if (!latest || tokenEvent.timestampMs > latest.timestampMs) {
      latest = {
        ...tokenEvent,
        threadId: row.id,
        recencyAtMs: Number(row.recency_at_ms) || 0
      };
    }
  }

  const snapshot = latest || {
    timestampMs: 0,
    info: {},
    rateLimits: {}
  };
  snapshotCache.set(cacheKey, { createdAt: now, snapshot });
  return snapshot;
}

async function readCursorRequestSnapshot(settings = {}) {
  const cursorDb = settings.cursorDbPath ? expandHome(settings.cursorDbPath) : defaultCursorDbPath();
  const jsonPath = settings.cursorRequestsJsonPath ? expandHome(settings.cursorRequestsJsonPath) : "";
  const cacheKey = `cursor-requests:${cursorDb}:${jsonPath}`;
  const cached = snapshotCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.createdAt < CURSOR_REQUEST_CACHE_MS) {
    return cached.snapshot;
  }

  const fromJson = readCursorRequestJson(jsonPath);
  if (fromJson) {
    snapshotCache.set(cacheKey, { createdAt: now, snapshot: fromJson });
    return fromJson;
  }

  const rows = await sqliteJson(
    cursorDb,
    "select value from ItemTable where key='src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'",
    10000
  );
  const applicationUser = parseJsonValue(rows[0] && rows[0].value, {});
  const snapshot = extractCursorRequestSnapshot(applicationUser);

  snapshotCache.set(cacheKey, { createdAt: now, snapshot });
  return snapshot;
}

async function readCursorSnapshot(settings = {}) {
  const cursorDb = settings.cursorDbPath ? expandHome(settings.cursorDbPath) : defaultCursorDbPath();
  const showArchived = Boolean(settings.showArchived);
  const recentMinutes = Number(settings.recentMinutes) || DEFAULT_RECENT_MINUTES;
  const cacheKey = `cursor:${cursorDb}:${showArchived}:${recentMinutes}`;
  const cached = snapshotCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.createdAt < 1500) {
    return cached.snapshot;
  }

  const [headersRows, projectsRows, membershipRows] = await Promise.all([
    sqliteJson(
      cursorDb,
      `with raw as (
         select value from ItemTable where key = 'composer.composerHeaders'
       )
       select json_extract(j.value, '$.composerId') as composerId,
              json_extract(j.value, '$.unifiedMode') as unifiedMode,
              json_extract(j.value, '$.forceMode') as forceMode,
              json_extract(j.value, '$.createdAt') as createdAt,
              json_extract(j.value, '$.lastUpdatedAt') as lastUpdatedAt,
              json_extract(j.value, '$.recency') as recency,
              json_extract(j.value, '$.isArchived') as isArchived,
              json_extract(j.value, '$.isDraft') as isDraft,
              json_extract(j.value, '$.name') as name,
              json_extract(j.value, '$.workspaceIdentifier.id') as workspaceId
         from raw, json_each(raw.value, '$.allComposers') j
        where json_extract(j.value, '$.type') = 'head'
        order by coalesce(
          json_extract(j.value, '$.lastUpdatedAt'),
          json_extract(j.value, '$.recency'),
          json_extract(j.value, '$.createdAt')
        ) desc
        limit ${MAX_THREADS}`,
      5000
    ),
    sqliteJson(cursorDb, "select value from ItemTable where key='glass.localAgentProjects.v1'"),
    sqliteJson(cursorDb, "select value from ItemTable where key='glass.localAgentProjectMembership.v1'")
  ]);

  const headers = parseCursorHeaders(headersRows);
  const projects = parseCursorProjects(projectsRows[0] && projectsRows[0].value);
  const membership = parseCursorMembership(membershipRows[0] && membershipRows[0].value);
  const source = headers
    .filter((header) => !header.isArchived || showArchived)
    .filter((header) => header.unifiedMode === "agent")
    .sort((a, b) => cursorHeaderTime(b) - cursorHeaderTime(a))
    .slice(0, MAX_THREADS);

  const snapshotRows = await Promise.all(source.map(async (header) => {
    const data = await readCursorComposerData(cursorDb, header.composerId);
    const project = cursorProjectForHeader(header, projects, membership);
    const updatedAtMs = Math.max(cursorHeaderTime(header), data.updatedAtMs || 0);
    const ageMs = now - updatedAtMs;
    const status = data.status && !["none", "completed", "complete", "idle"].includes(String(data.status).toLowerCase())
      ? "active"
      : ageMs <= recentMinutes * 60_000
        ? "recent"
        : "idle";
    const title = data.title || header.name || project.name || "Cursor Agent";
    const hasVisibleContent = Boolean(data.title || data.latestMessage || project.path || project.name !== "Cursor");
    if (!hasVisibleContent && status !== "active") {
      return null;
    }

    return {
      provider: "cursor",
      id: header.composerId,
      title: truncateText(title, 120),
      cwd: project.path || project.name || "Cursor",
      latestMessage: data.latestMessage,
      taskOpen: status === "active",
      updatedAtMs,
      lastLogMs: updatedAtMs,
      lastActivityMs: updatedAtMs,
      ageMs,
      status,
      archived: Boolean(header.isArchived),
      tokensUsed: 0
    };
  }));
  const snapshot = snapshotRows.filter(Boolean);

  snapshotCache.set(cacheKey, { createdAt: now, snapshot });
  return snapshot;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
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

function readTail(filePath, maxBytes = 180_000) {
  try {
    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    const cached = conversationCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    for (const key of conversationCache.keys()) {
      if (key.startsWith(`${filePath}:`)) {
        conversationCache.delete(key);
      }
    }

    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, size, stat.size - size);
    } finally {
      fs.closeSync(fd);
    }

    const text = buffer.toString("utf8");
    conversationCache.set(cacheKey, text);
    return text;
  } catch {
    return "";
  }
}

function extractMessageContent(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (typeof payload.message === "string") {
    return payload.message;
  }

  if (typeof payload.delta === "string") {
    return payload.delta;
  }

  if (typeof payload.text === "string") {
    return payload.text;
  }

  return "";
}

function normalizeConversationText(value) {
  let text = cleanText(value
    .replace(/<image\b[\s\S]*?<\/image>/gi, " ")
    .replace(/::[a-z-]+\{[^}]*\}/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1"));

  const requestMarker = "## My request for Codex:";
  const requestIndex = text.indexOf(requestMarker);
  if (requestIndex >= 0) {
    text = text.slice(requestIndex + requestMarker.length);
  }

  text = text
    .replace(/^# Files mentioned by the user:\s*/i, "")
    .replace(/## [^:]+:\s*/g, " ")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, " ");

  return truncateText(cleanText(text), 180);
}

function isInternalConversationText(value) {
  const text = cleanText(value);
  return /^\{[\s\S]*\}$/.test(text) || /^\[[\s\S]*\]$/.test(text);
}

function readLatestConversationText(rolloutPath) {
  if (!rolloutPath) {
    return "";
  }

  const lines = readTail(rolloutPath).split("\n").reverse();
  for (const line of lines) {
    if (!line.includes("\"type\":\"event_msg\"")) {
      continue;
    }
    if (!line.includes("\"user_message\"") && !line.includes("\"agent_message\"")) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      const payload = event.payload || {};
      if (!["user_message", "agent_message"].includes(payload.type)) {
        continue;
      }
      const content = normalizeConversationText(extractMessageContent(payload));
      if (content && !isInternalConversationText(content)) {
        return content;
      }
    } catch {
      continue;
    }
  }

  return "";
}

function readLatestTokenCount(rolloutPath) {
  if (!rolloutPath) {
    return null;
  }

  const lines = readTail(rolloutPath).split("\n").reverse();
  for (const line of lines) {
    if (!line.includes("\"type\":\"event_msg\"") || !line.includes("\"token_count\"")) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      const payload = event.payload || {};
      if (payload.type !== "token_count") {
        continue;
      }
      return {
        timestampMs: Date.parse(event.timestamp || "") || 0,
        info: payload.info || {},
        rateLimits: payload.rate_limits || {}
      };
    } catch {
      continue;
    }
  }

  return null;
}

function readCursorRequestJson(jsonPath) {
  if (!jsonPath || !fs.existsSync(jsonPath)) {
    return null;
  }

  const data = parseJsonValue(fs.readFileSync(jsonPath, "utf8"), null);
  if (!data || typeof data !== "object") {
    return null;
  }

  const requestRemaining = numberOrNull(data.requestRemaining ?? data.remainingRequests ?? data.remaining);
  const requestLimit = numberOrNull(data.requestLimit ?? data.totalRequests ?? data.limit);
  const requestUsed = numberOrNull(data.requestUsed ?? data.usedRequests ?? data.used);

  return {
    source: "json",
    timestampMs: Number(data.timestampMs || Date.parse(data.updatedAt || "")) || Date.now(),
    membershipType: cleanText(data.membershipType || data.plan || "Cursor"),
    usagePricingEnabled: data.usagePricingEnabled === undefined ? null : Boolean(data.usagePricingEnabled),
    usageHardLimit: Number(data.usageHardLimit) || 0,
    requestRemaining,
    requestLimit,
    requestUsed,
    resetAtMs: Number(data.resetAtMs || Date.parse(data.resetAt || "")) || 0,
    hasRequestData: requestRemaining !== null || requestLimit !== null || requestUsed !== null
  };
}

function extractCursorRequestSnapshot(applicationUser) {
  const aiSettings = applicationUser && applicationUser.aiSettings && typeof applicationUser.aiSettings === "object"
    ? applicationUser.aiSettings
    : {};
  const fields = flattenPrimitiveFields(applicationUser);
  const requestRemaining = findNumberField(fields, [
    /(?:remaining|left).*requests?/i,
    /requests?.*(?:remaining|left)/i,
    /fast.*requests?.*(?:remaining|left)/i,
    /(?:remaining|left).*fast.*requests?/i,
    /request.*allowance.*remaining/i
  ]);
  const requestLimit = findNumberField(fields, [
    /(?:included|total|max|limit).*requests?/i,
    /requests?.*(?:included|total|max|limit)/i,
    /fast.*requests?.*(?:included|total|max|limit)/i,
    /request.*allowance.*(?:total|limit)/i
  ]);
  const requestUsed = findNumberField(fields, [
    /(?:used|consumed).*requests?/i,
    /requests?.*(?:used|consumed)/i,
    /fast.*requests?.*(?:used|consumed)/i
  ]);
  const resetAtMs = findTimeField(fields, [
    /requests?.*(?:reset|renews?|refresh)/i,
    /(?:reset|renews?|refresh).*requests?/i
  ]);

  return {
    source: "cursor-local",
    timestampMs: Date.now(),
    membershipType: cleanText(applicationUser.membershipType || aiSettings.membershipType || "Cursor"),
    usagePricingEnabled: aiSettings.isUsagePricingEnabled === undefined ? null : Boolean(aiSettings.isUsagePricingEnabled),
    usageHardLimit: Number(aiSettings.usageHardLimit) || 0,
    requestRemaining,
    requestLimit,
    requestUsed,
    resetAtMs,
    hasRequestData: requestRemaining !== null || requestLimit !== null || requestUsed !== null
  };
}

function flattenPrimitiveFields(value, prefix = "", output = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) {
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|credential|jwt|bearer|auth|session|email/i.test(key)) {
      continue;
    }

    const pathName = prefix ? `${prefix}.${key}` : key;
    if (child == null || ["number", "string", "boolean"].includes(typeof child)) {
      output.push({ path: pathName, value: child });
      continue;
    }
    if (Array.isArray(child)) {
      child.slice(0, 20).forEach((entry, index) => flattenPrimitiveFields(entry, `${pathName}.${index}`, output, depth + 1));
      continue;
    }
    flattenPrimitiveFields(child, pathName, output, depth + 1);
  }

  return output;
}

function findNumberField(fields, patterns) {
  const match = fields.find((field) => (
    patterns.some((pattern) => pattern.test(field.path)) &&
    Number.isFinite(Number(field.value))
  ));
  return match ? Number(match.value) : null;
}

function findTimeField(fields, patterns) {
  const match = fields.find((field) => patterns.some((pattern) => pattern.test(field.path)));
  if (!match) {
    return 0;
  }
  const number = Number(match.value);
  if (Number.isFinite(number) && number > 0) {
    return number > 10_000_000_000 ? number : number * 1000;
  }
  const parsed = Date.parse(String(match.value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readTaskState(rolloutPath) {
  const state = {
    lastEvent: "",
    startedAtMs: 0,
    completedAtMs: 0
  };

  if (!rolloutPath) {
    return state;
  }

  const lines = readTail(rolloutPath).split("\n").reverse();
  for (const line of lines) {
    if (!line.includes("\"type\":\"event_msg\"")) {
      continue;
    }
    if (!line.includes("\"task_started\"") && !line.includes("\"task_complete\"")) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      const payload = event.payload || {};
      const timestampMs = Date.parse(event.timestamp || "") || 0;
      if (payload.type === "task_started" && !state.startedAtMs) {
        if (!state.lastEvent) {
          state.lastEvent = "task_started";
        }
        state.startedAtMs = Number(payload.started_at) * 1000 || timestampMs;
      }
      if (payload.type === "task_complete" && !state.completedAtMs) {
        if (!state.lastEvent) {
          state.lastEvent = "task_complete";
        }
        state.completedAtMs = Number(payload.completed_at) * 1000 || timestampMs;
      }
      if (state.startedAtMs && state.completedAtMs) {
        break;
      }
    } catch {
      continue;
    }
  }

  return state;
}

function parseJsonValue(value, fallback) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function parseCursorHeaders(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry && entry.composerId).map((entry) => ({
      ...entry,
      isArchived: Boolean(entry.isArchived),
      workspaceIdentifier: { id: entry.workspaceId }
    }));
  }

  const data = parseJsonValue(value, {});
  return Array.isArray(data.allComposers)
    ? data.allComposers.filter((entry) => entry && entry.type === "head" && entry.composerId)
    : [];
}

function parseCursorProjects(value) {
  const projects = new Map();
  const data = parseJsonValue(value, []);
  if (!Array.isArray(data)) {
    return projects;
  }

  for (const project of data) {
    const workspace = project.workspace || {};
    const workspaceId = workspace.id;
    if (!workspaceId) {
      continue;
    }
    const fsPath = workspace.uri && workspace.uri.fsPath
      ? workspace.uri.fsPath
      : workspace.configPath && workspace.configPath.fsPath
        ? workspace.configPath.fsPath
        : "";
    projects.set(workspaceId, {
      id: project.id,
      name: cleanText(project.name || ""),
      path: cleanText(fsPath)
    });
  }

  return projects;
}

function parseCursorMembership(value) {
  const membership = new Map();
  const data = parseJsonValue(value, {});
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return membership;
  }
  for (const [composerId, projectId] of Object.entries(data)) {
    membership.set(composerId, projectId);
  }
  return membership;
}

function cursorHeaderTime(header) {
  return Number(header.lastUpdatedAt || header.recency || header.createdAt) || 0;
}

function cursorProjectForHeader(header, projects, membership) {
  const workspaceId = header.workspaceIdentifier && header.workspaceIdentifier.id;
  const directProject = workspaceId ? projects.get(workspaceId) : undefined;
  if (directProject) {
    return directProject;
  }

  const projectId = membership.get(header.composerId);
  if (projectId) {
    for (const project of projects.values()) {
      if (project.id === projectId) {
        return project;
      }
    }
  }

  return {
    id: "",
    name: "Cursor",
    path: ""
  };
}

async function readCursorComposerData(cursorDb, composerId) {
  const rows = await sqliteJson(
    cursorDb,
    `select length(value) as size,
            case when length(value) <= 1000000 then value else substr(value, 1, 250000) end as value
       from cursorDiskKV
      where key = 'composerData:${sqlString(composerId)}'`
  );
  const row = rows[0] || {};
  const data = parseJsonValue(row.value, {});
  const latestMessage = latestCursorMessage(data);
  return {
    status: data.status || "",
    title: cursorTitle(data, latestMessage),
    latestMessage,
    updatedAtMs: Number(data.lastUpdatedAt || data.updatedAt || data.recency || 0) || 0
  };
}

function cursorTitle(data, latestMessage) {
  const title = cleanText(data.name || data.title || data.conversationTitle || data.text || "");
  if (title) {
    return title;
  }
  return truncateText(latestMessage, 80);
}

function latestCursorMessage(data) {
  const messages = [];
  collectCursorMessages(data.conversation, messages);
  collectCursorMessages(data.conversationMap, messages);
  collectCursorMessages(data.fullConversationHeadersOnly, messages);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = normalizeConversationText(messages[index]);
    if (text && !isInternalConversationText(text)) {
      return text;
    }
  }
  return "";
}

function collectCursorMessages(value, output) {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectCursorMessages(entry, output));
    return;
  }
  if (typeof value !== "object") {
    return;
  }

  for (const key of ["text", "content", "message", "summary", "name", "title"]) {
    if (typeof value[key] === "string") {
      const text = cleanText(value[key]);
      if (text && text.length > 1) {
        output.push(text);
      }
    }
  }

  for (const key of ["bubble", "data", "header"]) {
    if (value[key] && typeof value[key] === "object") {
      collectCursorMessages(value[key], output);
    }
  }
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
    return { background: "#071712", accent: "#10b981", muted: "#a7f3d0", text: "#f8fafc" };
  }
  if (status === "recent") {
    return { background: "#17120a", accent: "#f59e0b", muted: "#fed7aa", text: "#fff7ed" };
  }
  return { background: "#0f172a", accent: "#64748b", muted: "#cbd5e1", text: "#f8fafc" };
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

function formatCompactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return "0";
  }
  if (number >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`;
  }
  if (number >= 1_000) {
    return `${(number / 1_000).toFixed(number >= 10_000 ? 0 : 1)}k`;
  }
  return String(Math.round(number));
}

function remainingPercent(limit) {
  const used = Number(limit && limit.used_percent);
  if (!Number.isFinite(used)) {
    return null;
  }
  return Math.max(0, Math.min(100, 100 - used));
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `${Math.round(value)}%`;
}

function formatResetTime(limit, now = Date.now()) {
  const resetsAt = Number(limit && limit.resets_at);
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) {
    return "";
  }
  const ms = resetsAt * 1000 - now;
  if (ms <= 0) {
    return "reset now";
  }
  return `reset ${formatAge(ms)}`;
}

function basename(value) {
  if (!value) {
    return "";
  }
  return path.basename(value);
}

function displayUnits(value) {
  return [...value].reduce((total, char) => {
    if (char === " ") {
      return total + 0.35;
    }
    return total + (char.charCodeAt(0) <= 0x7f ? 0.58 : 1);
  }, 0);
}

function fitLines(value, maxLines, maxUnits) {
  const chars = [...cleanText(value)];
  const lines = [];
  let cursor = 0;
  while (cursor < chars.length && lines.length < maxLines) {
    let units = 0;
    let end = cursor;
    let lastSpace = -1;

    while (end < chars.length) {
      const char = chars[end];
      const nextUnits = units + displayUnits(char);
      if (nextUnits > maxUnits) {
        break;
      }
      units = nextUnits;
      if (char === " ") {
        lastSpace = end;
      }
      end += 1;
    }

    if (end === cursor) {
      end += 1;
    }

    const canBreakAtSpace = lastSpace > cursor && end < chars.length && displayUnits(chars.slice(cursor, lastSpace).join("")) >= maxUnits * 0.55;
    let lineEnd = canBreakAtSpace ? lastSpace : end;
    if (!canBreakAtSpace && lineEnd < chars.length && /^[,.;:!?，。！？、)]$/.test(chars[lineEnd])) {
      lineEnd += 1;
    }
    const line = chars.slice(cursor, lineEnd).join("").trim();
    cursor = canBreakAtSpace ? lastSpace + 1 : lineEnd;

    if (cursor < chars.length && lines.length === maxLines - 1) {
      lines.push(`${line.replace(/…$/, "").slice(0, Math.max(0, line.length - 1))}…`);
      break;
    }

    lines.push(line);
  }
  return lines.length ? lines : [""];
}

function fontSettings(settings = {}) {
  const scale = clampNumber(settings.fontScale, DEFAULT_FONT_SCALE, 60, 160) / 100;
  return {
    project: Math.round(clampNumber(settings.projectFontSize, DEFAULT_PROJECT_FONT_SIZE, 8, 28) * scale),
    title: Math.round(clampNumber(settings.titleFontSize, DEFAULT_TITLE_FONT_SIZE, 8, 32) * scale),
    activeMessage: Math.round(clampNumber(settings.activeMessageFontSize, DEFAULT_ACTIVE_MESSAGE_FONT_SIZE, 8, 32) * scale),
    footerMessage: Math.round(clampNumber(settings.footerMessageFontSize, DEFAULT_FOOTER_MESSAGE_FONT_SIZE, 7, 24) * scale),
    label: Math.round(clampNumber(settings.bottomLabelFontSize, DEFAULT_LABEL_FONT_SIZE, 7, 24) * scale)
  };
}

function fitUnits(baseUnits, baseSize, actualSize) {
  return baseUnits * (baseSize / Math.max(1, actualSize));
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderStatusIcon(status, colors) {
  if (status === "active") {
    const rotation = Math.floor((Date.now() / UPDATE_MS) % 8) * 45;
    return `<g transform="rotate(${rotation} 18 18)">
      <circle cx="18" cy="18" r="8" fill="none" stroke="${colors.accent}" stroke-width="4" opacity="0.22"/>
      <path d="M18 10a8 8 0 0 1 8 8" fill="none" stroke="${colors.accent}" stroke-width="4" stroke-linecap="round"/>
    </g>`;
  }

  if (status === "recent") {
    return `<circle cx="18" cy="18" r="7" fill="${colors.accent}"/>`;
  }

  return `<circle cx="18" cy="18" r="7" fill="none" stroke="${colors.accent}" stroke-width="3"/>`;
}

function renderThreadImage(thread, settings = {}) {
  const colors = statusColors(thread ? thread.status : "idle");
  const isActive = thread && thread.status === "active";
  const fonts = fontSettings(settings);
  const project = fitLines(thread ? basename(thread.cwd) || "Codex" : "Codex", 1, fitUnits(7.8, DEFAULT_PROJECT_FONT_SIZE, fonts.project))[0];
  const latestMessage = thread && thread.latestMessage ? thread.latestMessage : "";
  const bottomLabel = cleanText(settings.bottomLabel || "");
  const hasBottomLabel = bottomLabel.length > 0;
  const titleLines = isActive ? [] : fitLines(thread ? thread.title : "No session", 2, fitUnits(7.7, DEFAULT_TITLE_FONT_SIZE, fonts.title));
  const messageMaxLines = isActive
    ? hasBottomLabel ? 3 : 4
    : hasBottomLabel ? 1 : 2;
  const messageLines = fitLines(
    latestMessage || (isActive ? thread.title : ""),
    messageMaxLines,
    isActive
      ? fitUnits(7.9, DEFAULT_ACTIVE_MESSAGE_FONT_SIZE, fonts.activeMessage)
      : fitUnits(10.2, DEFAULT_FOOTER_MESSAGE_FONT_SIZE, fonts.footerMessage)
  );
  const statusIcon = renderStatusIcon(thread ? thread.status : "idle", colors);
  const titleLineHeight = Math.round(fonts.title * 1.1);
  const activeLineHeight = Math.round(fonts.activeMessage * 1.12);
  const footerLineHeight = Math.round(fonts.footerMessage * 1.25);
  const labelLine = hasBottomLabel
    ? fitLines(bottomLabel, 1, fitUnits(12, DEFAULT_LABEL_FONT_SIZE, fonts.label))[0]
    : "";

  const titleSvg = titleLines.map((line, index) => (
    `<text x="10" y="${56 + index * titleLineHeight}" fill="${colors.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="${fonts.title}" font-weight="800">${escapeXml(line)}</text>`
  )).join("");

  const messageStartY = isActive ? 54 : hasBottomLabel ? 107 : 111;
  const messageSize = isActive ? fonts.activeMessage : fonts.footerMessage;
  const messageWeight = isActive ? 800 : 700;
  const messageFill = isActive ? colors.text : colors.muted;
  const messageSvg = messageLines.map((line, index) => (
    `<text x="10" y="${messageStartY + index * (isActive ? activeLineHeight : footerLineHeight)}" fill="${messageFill}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="${messageSize}" font-weight="${messageWeight}">${escapeXml(line)}</text>`
  )).join("");
  const labelSvg = hasBottomLabel
    ? `<text x="10" y="135" fill="${colors.accent}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="${fonts.label}" font-weight="900">${escapeXml(labelLine)}</text>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="18" fill="${colors.background}"/>
  ${statusIcon}
  <text x="34" y="24" fill="${colors.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="${fonts.project}" font-weight="900">${escapeXml(project)}</text>
  ${titleSvg}
  ${messageSvg}
  ${labelSvg}
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function renderTokenImage(snapshot) {
  const primary = snapshot.rateLimits && snapshot.rateLimits.primary ? snapshot.rateLimits.primary : {};
  const secondary = snapshot.rateLimits && snapshot.rateLimits.secondary ? snapshot.rateLimits.secondary : {};
  const primaryLeft = remainingPercent(primary);
  const secondaryLeft = remainingPercent(secondary);
  const lastUsage = snapshot.info && snapshot.info.last_token_usage ? snapshot.info.last_token_usage : {};
  const totalUsage = snapshot.info && snapshot.info.total_token_usage ? snapshot.info.total_token_usage : {};
  const lastTokens = Number(lastUsage.total_tokens) || 0;
  const totalTokens = Number(totalUsage.total_tokens) || 0;
  const updated = snapshot.timestampMs ? formatAge(Date.now() - snapshot.timestampMs) : "no data";
  const primaryReset = formatResetTime(primary);
  const secondaryReset = formatResetTime(secondary);
  const hasData = snapshot.timestampMs > 0;
  const accent = hasData ? "#38bdf8" : "#64748b";
  const background = "#08111f";
  const text = "#f8fafc";
  const muted = "#bae6fd";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="18" fill="${background}"/>
  <circle cx="18" cy="18" r="7" fill="none" stroke="${accent}" stroke-width="3"/>
  <text x="34" y="24" fill="${muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="14" font-weight="900">Codex</text>
  <text x="10" y="51" fill="${text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="21" font-weight="900">Tokens</text>
  <text x="10" y="76" fill="${text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="17" font-weight="800">5h ${escapeXml(formatPercent(primaryLeft))}</text>
  <text x="83" y="76" fill="${muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="10" font-weight="700">${escapeXml(primaryReset)}</text>
  <text x="10" y="98" fill="${text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="17" font-weight="800">7d ${escapeXml(formatPercent(secondaryLeft))}</text>
  <text x="83" y="98" fill="${muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="10" font-weight="700">${escapeXml(secondaryReset)}</text>
  <text x="10" y="119" fill="${muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12" font-weight="800">last ${escapeXml(formatCompactNumber(lastTokens))} / total ${escapeXml(formatCompactNumber(totalTokens))}</text>
  <text x="10" y="136" fill="${accent}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11" font-weight="900">${escapeXml(updated)} ago</text>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function renderCursorRequestImage(snapshot) {
  const hasData = Boolean(snapshot && snapshot.hasRequestData);
  const remaining = hasData && snapshot.requestRemaining !== null ? formatCompactNumber(snapshot.requestRemaining) : "--";
  const limit = hasData && snapshot.requestLimit !== null ? formatCompactNumber(snapshot.requestLimit) : "";
  const used = hasData && snapshot.requestUsed !== null ? formatCompactNumber(snapshot.requestUsed) : "";
  const membership = truncateText(snapshot && snapshot.membershipType ? snapshot.membershipType : "Cursor", 18);
  const pricing = snapshot && snapshot.usagePricingEnabled === true
    ? "usage pricing on"
    : snapshot && snapshot.usagePricingEnabled === false
      ? "usage pricing off"
      : "pricing unknown";
  const reset = snapshot && snapshot.resetAtMs ? `reset ${formatAge(snapshot.resetAtMs - Date.now())}` : "";
  const detail = hasData
    ? [
      limit ? `/ ${limit}` : "",
      used ? `used ${used}` : "",
      reset
    ].filter(Boolean).join(" ")
    : "request counter unavailable";
  const updated = snapshot && snapshot.timestampMs ? formatAge(Date.now() - snapshot.timestampMs) : "no data";
  const accent = hasData ? "#f97316" : "#64748b";
  const background = "#120b04";
  const text = "#fff7ed";
  const muted = "#fed7aa";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="18" fill="${background}"/>
  <circle cx="18" cy="18" r="7" fill="none" stroke="${accent}" stroke-width="3"/>
  <text x="34" y="24" fill="${muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="14" font-weight="900">Cursor</text>
  <text x="10" y="51" fill="${text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="20" font-weight="900">Requests</text>
  <text x="10" y="82" fill="${text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="28" font-weight="950">${escapeXml(remaining)}</text>
  <text x="69" y="82" fill="${muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="13" font-weight="800">left</text>
  <text x="10" y="105" fill="${muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11" font-weight="800">${escapeXml(truncateText(detail, 26))}</text>
  <text x="10" y="122" fill="${muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11" font-weight="800">${escapeXml(truncateText(`${membership} · ${pricing}`, 27))}</text>
  <text x="10" y="137" fill="${accent}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="10" font-weight="900">${escapeXml(updated)} ago</text>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function send(message) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    return;
  }
  websocket.send(JSON.stringify(message));
}

function openThread(thread) {
  return new Promise((resolve, reject) => {
    if (!thread || !thread.id) {
      reject(new Error("No session is available for this key."));
      return;
    }

    if (thread.provider === "cursor") {
      execFile(OPEN_COMMAND, ["-b", CURSOR_BUNDLE_ID], { timeout: 5000 }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      return;
    }

    const url = `codex://threads/${encodeURIComponent(thread.id)}`;
    execFile(OPEN_COMMAND, ["-b", "com.openai.codex", url], { timeout: 5000 }, (bundleError) => {
      if (!bundleError) {
        resolve();
        return;
      }

      execFile(OPEN_COMMAND, [url], { timeout: 5000 }, (urlError) => {
        if (urlError) {
          reject(urlError);
          return;
        }
        resolve();
      });
    });
  });
}

async function updateAction(context, entry) {
  if (entry.action === TOKENS_ACTION_UUID) {
    const snapshot = await readTokenSnapshot(entry.settings);
    const image = renderTokenImage(snapshot);

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
    return;
  }

  if (entry.action === CURSOR_REQUESTS_ACTION_UUID) {
    const snapshot = await readCursorRequestSnapshot(entry.settings);
    const image = renderCursorRequestImage(snapshot);

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
    return;
  }

  const slot = contextSlot(context, entry);
  const snapshot = await readSnapshot(entry.settings);
  const thread = snapshot[slot - 1];
  const image = renderThreadImage(thread, entry.settings);

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
      action: message.action || SESSION_ACTION_UUID,
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
    const entry = actions.get(message.context);
    if (entry.action === TOKENS_ACTION_UUID || entry.action === CURSOR_REQUESTS_ACTION_UUID) {
      updateAction(message.context, entry).catch(() => {});
      return;
    }
    snapshotCache.clear();
    readSnapshot(entry.settings).then((snapshot) => {
      const slot = contextSlot(message.context, entry);
      const thread = snapshot[slot - 1];
      return openThread(thread).then(() => updateAction(message.context, entry));
    }).then(() => {
      send({ event: "showOk", context: message.context });
    }).catch(() => {
      send({ event: "showAlert", context: message.context });
      updateAction(message.context, entry).catch(() => {});
    });
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
  if (args.tokens) {
    const snapshot = await readTokenSnapshot({});
    const primary = snapshot.rateLimits && snapshot.rateLimits.primary ? snapshot.rateLimits.primary : {};
    const secondary = snapshot.rateLimits && snapshot.rateLimits.secondary ? snapshot.rateLimits.secondary : {};
    console.log(JSON.stringify({
      primaryRemaining: formatPercent(remainingPercent(primary)),
      primaryReset: formatResetTime(primary),
      secondaryRemaining: formatPercent(remainingPercent(secondary)),
      secondaryReset: formatResetTime(secondary),
      lastTokens: snapshot.info && snapshot.info.last_token_usage ? snapshot.info.last_token_usage.total_tokens : 0,
      totalTokens: snapshot.info && snapshot.info.total_token_usage ? snapshot.info.total_token_usage.total_tokens : 0,
      updatedAt: snapshot.timestampMs ? new Date(snapshot.timestampMs).toISOString() : null
    }, null, 2));
    return;
  }

  if (args.cursorRequests) {
    const snapshot = await readCursorRequestSnapshot({});
    console.log(JSON.stringify({
      hasRequestData: snapshot.hasRequestData,
      requestRemaining: snapshot.requestRemaining,
      requestLimit: snapshot.requestLimit,
      requestUsed: snapshot.requestUsed,
      resetAt: snapshot.resetAtMs ? new Date(snapshot.resetAtMs).toISOString() : null,
      membershipType: snapshot.membershipType,
      usagePricingEnabled: snapshot.usagePricingEnabled,
      usageHardLimit: snapshot.usageHardLimit,
      source: snapshot.source,
      updatedAt: snapshot.timestampMs ? new Date(snapshot.timestampMs).toISOString() : null
    }, null, 2));
    return;
  }

  const settings = {
    provider: args.provider,
    bottomLabel: args.bottomLabel,
    slot: Number(args.slot) || undefined
  };
  const snapshot = await readSnapshot(settings);
  console.log(JSON.stringify(snapshot.slice(0, DEFAULT_VISIBLE_SLOTS).map((thread, index) => ({
    slot: index + 1,
    provider: thread.provider,
    status: statusLabel(thread.status),
    title: thread.title,
    latestMessage: thread.latestMessage,
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
