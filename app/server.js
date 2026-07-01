import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync, crc32 } from "node:zlib";
import { RadioRuntime } from "./onair/radio.js";
import { ObsClient } from "./onair/obs.js";
import { BroadcastState } from "./onair/broadcast.js";
import { loadTalkMemories } from "./daihon/memory.js";
import { loadBroadcastScript, loadDbPlanById } from "./onair/script.js";
import { search as vectorSearch } from "./daihon/vector.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(APP_DIR, "..");
const DASHBOARD_DIR = path.join(APP_DIR, "ui", "dist");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const SCRIPT_PLAN_PATH = path.join(LOGS_DIR, "script-plan.json");
const PORT = Number(process.env.RADIO_CONTROL_PORT || 14520);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_EXE = process.env.OLLAMA_EXE || "C:\\Users\\User\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
const SQLITE_DATABASES = {
  talkItems: { label: "talk-items.sqlite", path: path.join(DATA_DIR, "talk-items.sqlite") },
};
const BACKGROUND_VIDEO_DIR = path.join(PROJECT_ROOT, "assets", "background", "onair");
const BACKGROUND_VIDEOS = [
  {
    id: "sv-82-title",
    label: "ShortVideo 82 title",
    file: "sv-82-title.mp4",
  },
  {
    id: "sv-82-prologue",
    label: "ShortVideo 82 prologue",
    file: "sv-82-prologue.mp4",
  },
  {
    id: "sv-68-archive",
    label: "ShortVideo 68 archive",
    file: "sv-68-archive.mp4",
  },
  {
    id: "sv-65-title",
    label: "ShortVideo 65 title",
    file: "sv-65-title.mp4",
  },
  {
    id: "sv-73-title",
    label: "ShortVideo 73 title",
    file: "sv-73-title.mp4",
  },
];
const SCRIPT_MODEL_PROFILES = {
  "gemma4-12b-coder-gguf": {
    label: "First: Gemma4-12B-Coder GGUF",
    candidates: [
      "hf.co/yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF:Q4_K_M",
      "hf.co/yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF:Q6_K",
      "gemma4-12b-coder",
      "gemma4:12b-coder",
      "gemma4:12b",
      "gemma4",
    ],
  },
  "qwen3.6-14b-a3b-fablevibes-gguf": {
    label: "Rival: Qwen3.6-14B-A3B-FableVibes GGUF",
    candidates: [
      "hf.co/tvall43/Qwen3.6-14B-A3B-FableVibes-GGUF:Q4_K_M",
      "hf.co/tvall43/Qwen3.6-14B-A3B-FableVibes-GGUF:Q5_K_M",
      "qwen3.6-14b-a3b-fablevibes",
      "qwen3.6:14b-a3b-fablevibes",
      "fablevibes",
      "qwen3.6:14b",
    ],
  },
  "qwable-9b": {
    label: "Light: Qwable-9B",
    candidates: ["qwable-9b", "qwable:9b", "qwable"],
  },
  "qwen3.6-27b": {
    label: "Heavy: Qwen3.6-27B",
    candidates: ["qwen3.6-27b", "qwen3.6:27b", "qwen3.6"],
  },
};
const runtime = new RadioRuntime();
const obsClient = new ObsClient();
const broadcastState = new BroadcastState();

await mkdir(LOGS_DIR, { recursive: true });
if (process.env.AUTO_START_OLLAMA === "1") await startOllamaServer();
if (process.env.AUTO_START_LLAMA_SERVER === "1") startLlamaServer();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/avatar/background.mp4") {
      return sendFile(response, path.join(PROJECT_ROOT, "assets", "background", "background.mp4"), "video/mp4", request);
    }
    if (request.method === "GET" && url.pathname === "/avatar/opening.mp4") {
      return sendFile(response, path.join(PROJECT_ROOT, "assets", "background", "opening.mp4"), "video/mp4", request);
    }
    if (request.method === "GET" && url.pathname === "/avatar/clips.json") {
      return sendFile(response, path.join(PROJECT_ROOT, "assets", "zipchan", "metadata", "avatar_clips.json"), "application/json");
    }
    if (request.method === "GET" && url.pathname.startsWith("/avatar/clips/") && url.pathname.endsWith(".png")) {
      const parts = url.pathname.split("/");
      const clipName = parts[3];
      const frameName = parts[4];
      if (/^[a-z_]+$/.test(clipName) && /^frame_\d{3}\.png$/.test(frameName)) {
        return sendFile(response, path.join(PROJECT_ROOT, "assets", "zipchan", "clips", clipName, frameName), "image/png");
      }
    }
    if (request.method === "GET" && url.pathname.startsWith("/avatar/parts/") && url.pathname.endsWith(".png")) {
      const partName = path.basename(url.pathname, ".png");
      if (/^[a-z_]+$/.test(partName)) {
        return sendFile(response, path.join(PROJECT_ROOT, "assets", "zipchan", "parts", `${partName}.png`), "image/png");
      }
    }
    if (request.method === "GET" && url.pathname === "/api/background-videos") {
      return sendJson(response, readBackgroundVideos());
    }
    if (request.method === "GET" && url.pathname.startsWith("/background-videos/") && url.pathname.endsWith(".mp4")) {
      const id = path.basename(url.pathname, ".mp4");
      const video = backgroundVideoById(id);
      if (video) return sendFile(response, video.filePath, "video/mp4", request);
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return sendJson(response, await getStatus());
    }
    if (request.method === "GET" && url.pathname === "/api/lives") {
      return sendJson(response, readLiveList());
    }
    if (request.method === "GET" && url.pathname === "/api/script") {
      const liveId = Number(url.searchParams.get("liveId") || 0);
      return sendJson(response, await readScriptPlan(liveId));
    }
    if (request.method === "GET" && url.pathname === "/api/memories") {
      return sendJson(response, await readMemories());
    }
    if (request.method === "GET" && url.pathname === "/api/sqlite") {
      return sendJson(response, readSqliteCatalog());
    }
    if (request.method === "GET" && url.pathname === "/api/sqlite/table") {
      return sendJson(response, readSqliteTable({
        databaseId: url.searchParams.get("db") || "",
        tableName: url.searchParams.get("table") || "",
        limit: Number(url.searchParams.get("limit") || 100),
        offset: Number(url.searchParams.get("offset") || 0),
      }));
    }
    if (request.method === "GET" && url.pathname === "/api/live/lines") {
      return sendJson(response, readLiveSpeechLines({
        liveId: Number(url.searchParams.get("liveId") || 0),
      }));
    }
    if (request.method === "GET" && url.pathname === "/api/live/audio") {
      const audio = readSpeechLineAudio({
        lineId: Number(url.searchParams.get("lineId") || 0),
        chunk: Number(url.searchParams.get("chunk") || 0),
      });
      return sendFile(response, audio.filePath, "audio/wav", request);
    }
    if (request.method === "GET" && url.pathname === "/api/live/csv") {
      const liveId = Number(url.searchParams.get("liveId") || 0);
      const { csv, filename } = exportLiveCsv({ liveId });
      response.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
      response.end("﻿" + csv);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/live/csv-all") {
      const zip = exportAllLiveCsvZip();
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zip.filename}"`,
        "Content-Length": zip.buffer.byteLength,
      });
      response.end(zip.buffer);
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/api/live") {
      return sendJson(response, deleteLiveWithSpeechLines({
        liveId: Number(url.searchParams.get("liveId") || 0),
      }));
    }
    if (request.method === "POST" && url.pathname === "/api/live/delete") {
      const body = await readJson(request);
      return sendJson(response, deleteLivesWithSpeechLines({
        liveIds: Array.isArray(body.liveIds) ? body.liveIds : [],
      }));
    }
    if (request.method === "POST" && url.pathname === "/api/live/eval") {
      const body = await readJson(request);
      return sendJson(response, updateLiveEval(body));
    }
    if (request.method === "POST" && url.pathname === "/api/script/prepare") {
      const body = await readJson(request);
      const count = Math.max(1, Math.min(20, Number(body.count || 1)));
      const modelSelection = await resolveScriptModel(body.modelProfile || body.model || "");
      const backend = process.env.RADIO_SCRIPT_LLM_BACKEND || "llama-server";
      if (backend === "ollama") {
        await ensureOllamaServer();
      } else {
        await ensureLlamaServer();
      }
      const options = {
        minutes: body.minutes || 30,
        mode: body.mode || "create",
        topicTitles: body.topicTitles || [],
        model: modelSelection.model || undefined,
        modelProfile: modelSelection.profile || "",
        modelLabel: modelSelection.label || "",
      };
      const cleanupAfterGeneration = async () => {
        if (process.env.UNLOAD_MODEL_AFTER_GENERATION === "0") return;
        if (backend === "ollama") {
          await unloadOllamaModel(modelSelection.model || "").catch(() => {});
        } else {
          stopLlamaServer();
        }
      };
      if (count > 1) {
        runtime.prepareScriptBatch({ ...options, count })
          .catch((error) => console.error("script batch error:", error.message))
          .finally(cleanupAfterGeneration);
        return sendJson(response, { ok: true, message: `配信台本のバッチ生成を開始しました (${count}本)。`, radio: runtime.snapshot() });
      }
      try {
        const radio = await runtime.prepareScript(options);
        return sendJson(response, { ok: true, message: radio.scriptPreparing ? "配信台本の準備を開始しました。" : "配信台本を準備しました。", radio });
      } finally {
        await cleanupAfterGeneration();
      }
    }
    if (request.method === "POST" && url.pathname === "/api/script/cancel") {
      const cancelled = runtime.cancelScript();
      return sendJson(response, { ok: true, cancelled });
    }
    if (request.method === "POST" && url.pathname === "/api/live/synthesize") {
      const body = await readJson(request);
      const liveId = Number(body.liveId || 0);
      if (!liveId) return sendJson(response, { ok: false, error: "liveId required" });
      runtime.synthesizeAudio({ liveId }).catch((e) => console.error("synthesize error:", e.message));
      return sendJson(response, { ok: true, message: "Synthesis started" });
    }
    if (request.method === "POST" && url.pathname === "/api/radio/start") {
      const body = await readJson(request);
      return sendJson(response, { ok: true, radio: await runtime.start(body.topicTitles || [], body.sourceMode || "chatter", { liveId: Number(body.liveId || 0) }) });
    }
    if (request.method === "POST" && url.pathname === "/api/radio/stop") {
      return sendJson(response, { ok: true, radio: await runtime.requestSafeStop() });
    }
    if (request.method === "POST" && url.pathname === "/api/radio/emergency-stop") {
      return sendJson(response, { ok: true, radio: await runtime.emergencyStop() });
    }
    // ---- Broadcast state ----
    if (request.method === "POST" && url.pathname === "/api/broadcast/transition") {
      const body = await readJson(request);
      try {
        const result = broadcastState.transition(body.next);
        return sendJson(response, { ok: true, broadcast: result });
      } catch (error) {
        return sendJson(response, { error: error.message }, 400);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/broadcast/speaking") {
      const body = await readJson(request);
      broadcastState.setSpeaking(body.speaking);
      return sendJson(response, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/broadcast/motion") {
      const body = await readJson(request);
      if (!body.clip) return sendJson(response, { error: "clip is required" }, 400);
      const result = broadcastState.setMotion(body.clip);
      return sendJson(response, { ok: true, motion: result });
    }
    // ---- OBS WebSocket ----
    if (request.method === "POST" && url.pathname === "/api/obs/connect") {
      const body = await readJson(request);
      const url2 = body.url || "ws://127.0.0.1:4455";
      const password = body.password || "";
      obsClient.url = url2;
      obsClient.password = password;
      try {
        await obsClient.connect();
        return sendJson(response, { ok: true, obs: obsClient.snapshot() });
      } catch (error) {
        return sendJson(response, { error: error.message }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/obs/disconnect") {
      obsClient.disconnect();
      return sendJson(response, { ok: true, obs: obsClient.snapshot() });
    }
    if (request.method === "POST" && url.pathname === "/api/obs/start-stream") {
      try {
        await obsClient.startStream();
        return sendJson(response, { ok: true, obs: obsClient.snapshot() });
      } catch (error) {
        return sendJson(response, { error: error.message }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/obs/stop-stream") {
      try {
        await obsClient.stopStream();
        return sendJson(response, { ok: true, obs: obsClient.snapshot() });
      } catch (error) {
        return sendJson(response, { error: error.message }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/obs/scene") {
      const body = await readJson(request);
      try {
        await obsClient.setScene(body.sceneName);
        return sendJson(response, { ok: true, obs: obsClient.snapshot() });
      } catch (error) {
        return sendJson(response, { error: error.message }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/vector/search") {
      const dbName = url.searchParams.get("db") || "style";
      const query = url.searchParams.get("q") || "";
      const topK = Math.min(Math.max(Number(url.searchParams.get("topK") || 10), 1), 50);
      if (!["style", "topic", "flow"].includes(dbName)) return sendJson(response, { error: "Invalid db: style, topic, flow" }, 400);
      if (!query.trim()) return sendJson(response, { error: "Query (q) is required" }, 400);
      const results = await vectorSearch(dbName, query, topK);
      return sendJson(response, {
        db: dbName,
        query,
        topK,
        results: results.map(r => ({ id: r.id, score: Math.round(r.score * 10000) / 10000, data: r.data })),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/vector/table") {
      const dbName = url.searchParams.get("db") || "style";
      if (!["style", "topic", "flow"].includes(dbName)) return sendJson(response, { error: "Invalid db" }, 400);
      const dbPath = path.join(DATA_DIR, "vector-db", `${dbName}.sqlite`);
      return sendJson(response, withDatabase(dbPath, (db) => {
        const rows = db.prepare("SELECT id, data FROM vectors").all();
        return {
          db: dbName,
          results: rows.map(r => ({ id: r.id, data: JSON.parse(r.data) })),
        };
      }));
    }
    if (request.method === "GET" && url.pathname === "/api/vector/catalog") {
      const catalog = ["style", "topic", "flow"].map(name => {
        try {
          const dbPath = path.join(DATA_DIR, "vector-db", `${name}.sqlite`);
          const db = new DatabaseSync(dbPath, { readOnly: true });
          try {
            const count = db.prepare("SELECT count(*) as c FROM vectors").get().c;
            return { name, count };
          } finally { db.close(); }
        } catch { return { name, count: 0 }; }
      });
      return sendJson(response, { databases: catalog });
    }
    if (request.method === "POST" && url.pathname === "/api/server/restart") {
      scheduleServerRestart();
      return sendJson(response, { ok: true, message: "Restarting control server" });
    }
    if (request.method === "POST" && url.pathname === "/api/server/stop") {
      sendJson(response, { ok: true, message: "Stopping all processes" });
      scheduleFullStop();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/logs/clear") {
      await writeFile(path.join(LOGS_DIR, "script-llm.jsonl"), "", "utf8").catch(() => {});
      return sendJson(response, { ok: true, message: "発話ログを削除しました。", radio: await runtime.clearTalkLog() });
    }
    // Dashboard static files & SPA fallback
    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      const safePath = path.normalize(url.pathname).replace(/^(\.\.[\/\\])+/, "");
      const filePath = path.join(DASHBOARD_DIR, safePath === "/" || safePath === "\\" ? "index.html" : safePath);
      if (filePath.startsWith(DASHBOARD_DIR) && existsSync(filePath)) {
        return sendFile(response, filePath, MIME_TYPES[path.extname(filePath)] || "application/octet-stream");
      }
      // SPA fallback — serve index.html for client-side routing
      const indexPath = path.join(DASHBOARD_DIR, "index.html");
      if (existsSync(indexPath)) {
        return sendFile(response, indexPath, "text/html; charset=utf-8");
      }
    }
    return sendJson(response, { error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    return sendJson(response, { error: error.message }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`KawaiiLive control panel: http://127.0.0.1:${PORT}`);
});

function scheduleServerRestart() {
  const helper = path.join(PROJECT_ROOT, "scripts", "restart-control-server.js");
  const child = spawn(process.execPath, [helper, String(PORT)], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONUTF8: "1", RADIO_LOG_LLM: process.env.RADIO_LOG_LLM || "1" },
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  console.log("[control] restart requested");
  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200).unref();
  }, 250);
}

function scheduleFullStop() {
  console.log("[control] full stop requested — killing ollama and local servers");
  setTimeout(() => {
    try { execSync("taskkill /F /IM ollama.exe /T", { stdio: "ignore" }); } catch {}
    try { execSync("taskkill /F /IM llama-server.exe /T", { stdio: "ignore" }); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }, 300);
}

async function getStatus() {
  const [ollama] = await Promise.all([
    checkUrl(`${OLLAMA_URL}/api/tags`),
  ]);
  return {
    ollama,
    radio: runtime.snapshot(),
    broadcast: broadcastState.snapshot(),
    obs: obsClient.snapshot(),
    chatLog: [],
    scriptLlmLog: await readScriptLlmLog(),
  };
}

async function readScriptLlmLog() {
  const files = ["script-llm.jsonl", "script-llm-v3.jsonl"];
  const entries = [];
  for (const file of files) {
    try {
      const raw = await readFile(path.join(LOGS_DIR, file), "utf8");
      raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-80)
        .forEach((line, index) => {
          try {
            const entry = JSON.parse(line);
            entries.push({ id: `${file}:${entry.at || ""}:${entry.type || ""}:${entry.memoryId || ""}:${index}`, source: file, ...entry });
          } catch {}
        });
    } catch {}
  }
  return entries
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
    .slice(-120);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function checkUrl(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForUrl(url, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await checkUrl(url)) {
      console.log(`${label}: ready`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`${label} did not become ready: ${url}`);
}

async function readScriptPlan(liveId = 0) {
  try {
    const plan = liveId ? loadDbPlanById(liveId) : await loadBroadcastScript();
    const items = Array.isArray(plan.items) ? plan.items : [];
    return {
      ok: true,
      liveId: plan.liveId || 0,
      title: plan.title || "",
      status: plan.status || "",
      createdAt: plan.createdAt || "",
      updatedAt: plan.updatedAt || "",
      model: plan.model || "",
      minutes: plan.minutes || 0,
      index: Number(plan.index || 0),
      total: items.length,
      items: items.map((item, index) => ({
        number: index + 1,
        topic: item.topic || "",
        anchor: item.anchor || "",
        memoryId: item.memoryId || "",
        text: item.text || "",
        current: index === Number(plan.index || 0),
        spoken: index < Number(plan.index || 0),
      })),
    };
  } catch {
    return { ok: true, createdAt: "", model: "", minutes: 0, index: 0, total: 0, items: [] };
  }
}

function readLiveList() {
  const db = new DatabaseSync(SQLITE_DATABASES.talkItems.path, { readOnly: true });
  try {
    const lives = db.prepare(`
      select l.id, l.title, l.status, l.created_at,
        count(sl.id) as total_lines,
        count(case when sl.audio_path is not null and sl.audio_path != '' then 1 end) as audio_lines
      from live l
      left join speech_lines sl on sl.live_id = l.id
      group by l.id
      order by l.id desc
    `).all();
    return {
      ok: true,
      lives: lives.map((row) => ({
        id: row.id,
        title: row.title || "",
        status: row.status || "",
        createdAt: row.created_at || "",
        totalLines: row.total_lines,
        audioLines: row.audio_lines,
        audioReady: row.total_lines > 0 && row.audio_lines === row.total_lines,
      })),
    };
  } finally {
    db.close();
  }
}

async function readMemories() {
  const memories = (await loadTalkMemories()).map((memory) => ({ dbSource: "sqlite", ...memory }));
  return {
    total: memories.length,
    counts: { sqlite: memories.length },
    memories,
  };
}

function readSqliteCatalog() {
  return {
    databases: Object.entries(SQLITE_DATABASES).map(([id, database]) => {
      const tables = withDatabase(database.path, (db) => db.prepare(`
        select name
        from sqlite_master
        where type = 'table' and name not like 'sqlite_%'
        order by name
      `).all().map((row) => ({
        name: row.name,
        rowCount: tableRowCount(db, row.name),
        columns: tableColumns(db, row.name),
      })));
      return {
        id,
        label: database.label,
        path: database.path,
        tables,
      };
    }),
  };
}

function readSqliteTable({ databaseId, tableName, limit, offset }) {
  const database = SQLITE_DATABASES[databaseId];
  if (!database) throw new Error("Unknown database");
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 1), 500);
  const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);

  return withDatabase(database.path, (db) => {
    const tables = db.prepare(`
      select name
      from sqlite_master
      where type = 'table' and name not like 'sqlite_%'
    `).all().map((row) => row.name);
    if (!tables.includes(tableName)) throw new Error("Unknown table");

    const columns = tableColumns(db, tableName);
    const quotedTable = quoteIdentifier(tableName);
    const total = tableRowCount(db, tableName);
    const rows = db.prepare(`select * from ${quotedTable} limit ? offset ?`).all(safeLimit, safeOffset);
    return {
      database: { id: databaseId, label: database.label, path: database.path },
      table: tableName,
      columns,
      rows,
      total,
      limit: safeLimit,
      offset: safeOffset,
    };
  });
}

function readLiveSpeechLines({ liveId }) {
  if (!Number.isInteger(liveId) || liveId <= 0) throw new Error("Invalid live id");
  const database = SQLITE_DATABASES.talkItems;
  return withDatabase(database.path, (db) => {
    const live = db.prepare("select * from live where id = ?").get(liveId);
    if (!live) throw new Error("Live not found");
    const hasAnchor = tableHasColumn(db, "speech_lines", "anchor");
    const rows = db.prepare(`
      select
        speech_lines.id,
        speech_lines.live_id,
        speech_lines.sequence_no,
        speech_lines.text,
        speech_lines.memory_id,
        ${hasAnchor ? "speech_lines.anchor" : "''"} as speech_anchor,
        memory.keywords as source_memory_keywords,
        memory.episode as memory_episode,
        speech_lines.audio_path,
        speech_lines.status,
        speech_lines.spoken_at,
        speech_lines.created_at,
        speech_lines.updated_at
      from speech_lines
      left join memory on memory.id = speech_lines.memory_id
      where speech_lines.live_id = ?
      order by speech_lines.sequence_no asc, speech_lines.id asc
    `).all(liveId);
    return {
      ok: true,
      live,
      rows: rows.map((row) => ({
        ...row,
        memory_keywords: anchorKeywordForSpeech(row),
        audio_url: row.audio_path ? `/api/live/audio?lineId=${row.id}&chunk=0` : "",
        audio_urls: row.audio_path
          ? parseAudioPaths(row.audio_path).map((_, index) => `/api/live/audio?lineId=${row.id}&chunk=${index}`)
          : [],
      })),
      total: rows.length,
    };
  });
}

function readSpeechLineAudio({ lineId, chunk = 0 }) {
  if (!Number.isInteger(lineId) || lineId <= 0) throw new Error("Invalid speech line id");
  const safeChunk = Number.isInteger(chunk) && chunk >= 0 ? chunk : 0;
  const database = SQLITE_DATABASES.talkItems;
  return withDatabase(database.path, (db) => {
    const row = db.prepare("select id, audio_path from speech_lines where id = ?").get(lineId);
    if (!row?.audio_path) throw new Error("Audio is not synthesized");
    const paths = parseAudioPaths(row.audio_path);
    const selectedPath = paths[safeChunk] || paths[0] || "";
    const audioRoot = path.resolve(DATA_DIR, "audio");
    const filePath = path.resolve(selectedPath);
    if (!filePath.startsWith(audioRoot + path.sep)) throw new Error("Invalid audio path");
    if (!existsSync(filePath)) throw new Error("Audio file not found");
    return { filePath };
  });
}

function exportLiveCsv({ liveId }) {
  if (!Number.isInteger(liveId) || liveId <= 0) throw new Error("Invalid live id");
  const database = SQLITE_DATABASES.talkItems;
  return withDatabase(database.path, (db) => {
    const live = db.prepare("select * from live where id = ?").get(liveId);
    if (!live) throw new Error("Live not found");
    const hasGen = tableHasColumn(db, "speech_lines", "generator_req");
    const hasDir = tableHasColumn(db, "speech_lines", "director_req");
    const hasTr = tableHasColumn(db, "speech_lines", "transition_type");
    const hasV3 = tableHasColumn(db, "speech_lines", "prompt_type");
    const rows = db.prepare(`
      select sequence_no, text, memory_id, anchor, ${hasGen ? "generator_req, generator_res," : ""} ${hasDir ? "director_req, director_res," : ""} ${hasTr ? "transition_type, transition_keyword, transition_reason, prev_hooks, next_hooks," : ""} ${hasV3 ? "prompt_type, source_type, research_id, research_title, research_part, handoff_mode, handoff_action, handoff_feeling, actual_transition_type, planner_transition_type, director_parse_ok, selected_plan_block," : ""} status, spoken_at
      from speech_lines where live_id = ? order by sequence_no asc
    `).all(liveId);
    const header = ["sequence_no", "text", "memory_id", "anchor", ...(hasGen ? ["generator_req", "generator_res"] : []), ...(hasDir ? ["director_req", "director_res"] : []), ...(hasTr ? ["transition_type", "transition_keyword", "transition_reason", "prev_hooks", "next_hooks"] : []), ...(hasV3 ? ["prompt_type", "source_type", "research_id", "research_title", "research_part", "handoff_mode", "handoff_action", "handoff_feeling", "actual_transition_type", "planner_transition_type", "director_parse_ok", "selected_plan_block"] : []), "status", "spoken_at"];
    const csvRows = [header.join(",")];
    for (const row of rows) {
      csvRows.push(header.map(col => {
        const val = row[col] == null ? "" : String(row[col]);
        return `"${val.replace(/"/g, '""')}"`;
      }).join(","));
    }
    const safeTitle = (live.title || `live_${liveId}`).replace(/[\/\\:*?"<>|]/g, "_");
    return { csv: csvRows.join("\r\n"), filename: `${safeTitle}.csv` };
  });
}

function exportAllLiveCsvZip() {
  const files = [];
  const bom = "﻿";

  withDatabase(SQLITE_DATABASES.talkItems.path, (db) => {
    const lives = db.prepare("select * from live order by id asc").all();
    const hasGen = tableHasColumn(db, "speech_lines", "generator_req");
    const hasDir = tableHasColumn(db, "speech_lines", "director_req");
    const hasTr = tableHasColumn(db, "speech_lines", "transition_type");
    const hasV3 = tableHasColumn(db, "speech_lines", "prompt_type");
    const slHeader = ["live_id", "live_title", "sequence_no", "text", "memory_id", "anchor", ...(hasGen ? ["generator_req", "generator_res"] : []), ...(hasDir ? ["director_req", "director_res"] : []), ...(hasTr ? ["transition_type", "transition_keyword", "transition_reason", "prev_hooks", "next_hooks"] : []), ...(hasV3 ? ["prompt_type", "source_type", "research_id", "research_title", "research_part", "handoff_mode", "handoff_action", "handoff_feeling", "actual_transition_type", "planner_transition_type", "director_parse_ok", "selected_plan_block"] : []), "status", "spoken_at"];
    const slSelect = `select sequence_no, text, memory_id, anchor, ${hasGen ? "generator_req, generator_res," : ""} ${hasDir ? "director_req, director_res," : ""} ${hasTr ? "transition_type, transition_keyword, transition_reason, prev_hooks, next_hooks," : ""} ${hasV3 ? "prompt_type, source_type, research_id, research_title, research_part, handoff_mode, handoff_action, handoff_feeling, actual_transition_type, planner_transition_type, director_parse_ok, selected_plan_block," : ""} status, spoken_at from speech_lines where live_id = ? order by sequence_no asc`;
    const stmt = db.prepare(slSelect);
    for (const live of lives) {
      const rows = stmt.all(live.id);
      const csvRows = [slHeader.join(",")];
      for (const row of rows) {
        csvRows.push(slHeader.map(col => {
          let val;
          if (col === "live_id") val = live.id;
          else if (col === "live_title") val = live.title || "";
          else val = row[col] == null ? "" : String(row[col]);
          return `"${String(val).replace(/"/g, '""')}"`;
        }).join(","));
      }
      const safeTitle = (live.title || `live_${live.id}`).replace(/[\/\\:*?"<>|]/g, "_");
      files.push({ name: `live/${safeTitle}.csv`, data: Buffer.from(bom + csvRows.join("\r\n"), "utf8") });
    }

    const memRows = db.prepare("select id, keywords, episode, created_at, updated_at from memory order by id asc").all();
    const memHeader = ["id", "keywords", "episode", "created_at", "updated_at"];
    files.push({ name: "memory.csv", data: Buffer.from(bom + toCsv(memHeader, memRows), "utf8") });
  });

  const vectorDbDir = path.join(DATA_DIR, "vector-db");
  for (const dbName of ["style", "topic", "flow"]) {
    const dbPath = path.join(vectorDbDir, `${dbName}.sqlite`);
    if (!existsSync(dbPath)) continue;
    withDatabase(dbPath, (db) => {
      const rows = db.prepare("select id, data from vectors order by id asc").all();
      if (!rows.length) return;
      const parsed = rows.map(r => {
        try { return { id: r.id, ...JSON.parse(r.data) }; } catch { return { id: r.id }; }
      });
      const keySet = new Set();
      for (const p of parsed) for (const k of Object.keys(p)) if (k !== "embedding" && k !== "search_text") keySet.add(k);
      const header = [...keySet];
      files.push({ name: `${dbName}.csv`, data: Buffer.from(bom + toCsv(header, parsed), "utf8") });
    });
  }

  if (!files.length) throw new Error("No data found");
  return { buffer: buildZip(files), filename: "kawaiilive_all_csv.zip" };
}

function toCsv(header, rows) {
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map(col => {
      let val = row[col];
      if (val == null) val = "";
      else if (typeof val === "object") val = JSON.stringify(val);
      else val = String(val);
      return `"${val.replace(/"/g, '""')}"`;
    }).join(","));
  }
  return lines.join("\r\n");
}

function buildZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.data);
    const checksum = crc32(file.data);
    const local = Buffer.alloc(30 + nameBuffer.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    compressed.copy(local, 30 + nameBuffer.length);
    localHeaders.push(local);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum >>> 0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centralHeaders.push(central);
    offset += local.length;
  }
  const centralOffset = offset;
  const centralSize = centralHeaders.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

function anchorKeywordForSpeech(row) {
  const source = parseKeywords(row.source_memory_keywords);
  const anchor = cleanText(row.speech_anchor);
  if (anchor) return anchor;
  const hit = source
    .filter((keyword) => row.text?.includes(keyword))
    .sort((a, b) => b.length - a.length)[0];
  return hit || "";
}

function parseKeywords(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(cleanText).filter(Boolean) : [];
  } catch {
    return String(value || "").split(",").map(cleanText).filter(Boolean);
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function deleteLiveWithSpeechLines({ liveId }) {
  return deleteLivesWithSpeechLines({ liveIds: [liveId] });
}

function deleteLivesWithSpeechLines({ liveIds }) {
  const ids = [...new Set(liveIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw new Error("No live ids selected");
  const database = SQLITE_DATABASES.talkItems;
  return withWritableDatabase(database.path, (db) => {
    const placeholders = ids.map(() => "?").join(", ");
    const lives = db.prepare(`select id, title from live where id in (${placeholders})`).all(...ids);
    if (!lives.length) throw new Error("Live not found");
    const foundIds = lives.map((live) => Number(live.id));
    const foundPlaceholders = foundIds.map(() => "?").join(", ");
    const speechCount = db.prepare(`select count(*) as count from speech_lines where live_id in (${foundPlaceholders})`).get(...foundIds).count;
    db.exec("begin immediate");
    try {
      db.prepare(`delete from speech_lines where live_id in (${foundPlaceholders})`).run(...foundIds);
      db.prepare(`delete from live where id in (${foundPlaceholders})`).run(...foundIds);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
    for (const id of foundIds) {
      RadioRuntime.deleteAudioForLive(id).catch(() => {});
    }
    return {
      ok: true,
      liveIds: foundIds,
      deleted: { live: foundIds.length, speechLines: speechCount },
      missingIds: ids.filter((id) => !foundIds.includes(id)),
      message: `Deleted ${foundIds.length} live(s) and ${speechCount} speech lines.`,
    };
  });
}

const EVAL_FIELDS = ["eval_depth", "eval_flow", "eval_naturalness", "eval_grounding", "eval_repetition"];
const EVAL_WEIGHTS = { eval_depth: 0.30, eval_flow: 0.25, eval_naturalness: 0.20, eval_grounding: 0.15, eval_repetition: 0.10 };

function updateLiveEval(body) {
  const liveId = Number(body.liveId);
  if (!Number.isInteger(liveId) || liveId <= 0) throw new Error("Invalid live id");
  const database = SQLITE_DATABASES.talkItems;
  return withWritableDatabase(database.path, (db) => {
    const live = db.prepare("select id from live where id = ?").get(liveId);
    if (!live) throw new Error("Live not found");
    const liveCols = db.prepare("pragma table_info(live)").all().map((c) => c.name);
    if (!liveCols.includes("eval_depth")) {
      for (const f of EVAL_FIELDS) db.exec(`alter table live add column ${f} integer`);
      db.exec("alter table live add column eval_memo text");
    }
    const sets = [];
    const params = [];
    for (const f of EVAL_FIELDS) {
      if (body[f] !== undefined) {
        const v = body[f] === null ? null : Math.max(0, Math.min(100, Math.round(Number(body[f]))));
        sets.push(`${f} = ?`);
        params.push(Number.isNaN(v) ? null : v);
      }
    }
    if (body.eval_memo !== undefined) {
      sets.push("eval_memo = ?");
      params.push(body.eval_memo === null ? null : String(body.eval_memo));
    }
    if (!sets.length) throw new Error("No eval fields to update");
    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(liveId);
    db.prepare(`update live set ${sets.join(", ")} where id = ?`).run(...params);
    const updated = db.prepare("select * from live where id = ?").get(liveId);
    const scores = EVAL_FIELDS.map(f => updated[f]).filter(v => v != null);
    const weighted = scores.length === EVAL_FIELDS.length
      ? EVAL_FIELDS.reduce((sum, f) => sum + (updated[f] || 0) * EVAL_WEIGHTS[f], 0)
      : null;
    return { ok: true, live: updated, weighted_total: weighted != null ? Math.round(weighted * 10) / 10 : null };
  });
}

function tableColumns(db, tableName) {
  return db.prepare(`pragma table_info(${quoteIdentifier(tableName)})`).all().map((column) => ({
    name: column.name,
    type: column.type || "",
    nullable: column.notnull !== 1,
    primaryKey: column.pk === 1,
  }));
}

function tableRowCount(db, tableName) {
  return db.prepare(`select count(*) as count from ${quoteIdentifier(tableName)}`).get().count;
}

function tableHasColumn(db, tableName, columnName) {
  return tableColumns(db, tableName).some((column) => column.name === columnName);
}

function withDatabase(databasePath, read) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function withWritableDatabase(databasePath, write) {
  const db = new DatabaseSync(databasePath);
  try {
    return write(db);
  } finally {
    db.close();
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function parseAudioPaths(audioPath) {
  const text = String(audioPath || "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [text];
}

function readBackgroundVideos() {
  return {
    ok: true,
    videos: BACKGROUND_VIDEOS
      .map((video) => {
        const filePath = path.join(BACKGROUND_VIDEO_DIR, video.file);
        return existsSync(filePath)
          ? { id: video.id, label: video.label, url: `/background-videos/${video.id}.mp4` }
          : null;
      })
      .filter(Boolean),
  };
}

function backgroundVideoById(id) {
  const video = BACKGROUND_VIDEOS.find((item) => item.id === id);
  if (!video) return null;
  const filePath = path.resolve(BACKGROUND_VIDEO_DIR, video.file);
  const root = path.resolve(BACKGROUND_VIDEO_DIR);
  if (!filePath.startsWith(root + path.sep)) return null;
  if (!existsSync(filePath)) return null;
  return { ...video, filePath };
}

function run(command, args, { cwd = PROJECT_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
}

async function sendFile(response, filePath, contentType, request = null) {
  const range = request?.headers?.range || "";
  if (range) {
    const fileStat = await stat(filePath);
    const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), fileStat.size - 1) : fileStat.size - 1;
      if (Number.isInteger(start) && Number.isInteger(end) && start <= end && start < fileStat.size) {
        const file = await readFile(filePath);
        response.writeHead(206, {
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
          "Content-Length": end - start + 1,
        });
        response.end(file.subarray(start, end + 1));
        return;
      }
    }
  }
  const file = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
    "Content-Length": file.length,
  });
  response.end(file);
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function resolveScriptModel(profileOrModel) {
  const requested = String(profileOrModel || "").trim();
  if (!requested) return { profile: "", label: "", model: "" };
  const profile = SCRIPT_MODEL_PROFILES[requested];
  if (!profile) return { profile: "", label: requested, model: requested };

  const installed = await listOllamaModelNames().catch(() => []);
  const candidates = profile.candidates || [];
  const normalizedInstalled = installed.map((name) => ({ name, normalized: normalizeModelName(name) }));
  for (const candidate of candidates) {
    const needle = normalizeModelName(candidate);
    const exact = normalizedInstalled.find((entry) => entry.normalized === needle);
    if (exact) return { profile: requested, label: profile.label, model: exact.name };
  }
  for (const candidate of candidates) {
    const needle = normalizeModelName(candidate);
    const partial = normalizedInstalled.find((entry) => entry.normalized.includes(needle) || needle.includes(entry.normalized));
    if (partial) return { profile: requested, label: profile.label, model: partial.name };
  }
  return { profile: requested, label: profile.label, model: candidates[0] || requested };
}

async function listOllamaModelNames() {
  const base = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) return [];
  const payload = await response.json();
  return Array.isArray(payload.models) ? payload.models.map((model) => model.name).filter(Boolean) : [];
}

function normalizeModelName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function startOllamaServer() {
  if (!existsSync(OLLAMA_EXE)) {
    console.error(`Ollama: exe not found, skipping (${OLLAMA_EXE})`);
    return;
  }
  if (await checkUrl(`${OLLAMA_URL}/api/tags`)) {
    console.log("Ollama: already running");
    return;
  }
  const child = spawn(OLLAMA_EXE, ["serve"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONUTF8: "1" },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) console.log(`Ollama: ${line}`);
  });
  child.on("error", (err) => console.error("Ollama: spawn failed:", err.message));
  child.on("exit", (code) => { if (code) console.error(`Ollama: exited with code ${code}`); });
  process.on("exit", () => { try { child.kill(); } catch {} });
  console.log(`Ollama: starting (${OLLAMA_EXE}, pid ${child.pid})`);
  await waitForUrl(`${OLLAMA_URL}/api/tags`, 45_000, "Ollama");
}

let llamaServerChild = null;

function startLlamaServer() {
  const llamaDir = path.join(DATA_DIR, "llama-hip");
  const modelPath = path.join(llamaDir, "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf");
  const exe = path.join(llamaDir, "llama-server.exe");
  if (!existsSync(exe) || !existsSync(modelPath)) {
    console.error("llama-server: model or exe not found, skipping");
    return null;
  }
  const port = new URL(process.env.LLAMA_SERVER_URL || "http://127.0.0.1:11435").port || "11435";
  const child = spawn(exe, ["-m", modelPath, "--no-mmap", "--reasoning", "off", "-c", "4096", "--port", port], {
    cwd: llamaDir,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line.includes("model loaded") || line.includes("listening on")) console.log(`llama-server: ${line.split(" I ").pop()}`);
  });
  child.on("error", (err) => console.error("llama-server: spawn failed:", err.message));
  child.on("exit", (code) => {
    if (code) console.error(`llama-server: exited with code ${code}`);
    if (llamaServerChild === child) llamaServerChild = null;
  });
  process.on("exit", () => { try { child.kill(); } catch {} });
  console.log(`llama-server: starting on port ${port} (pid ${child.pid})`);
  return child;
}

async function ensureLlamaServer() {
  const port = new URL(process.env.LLAMA_SERVER_URL || "http://127.0.0.1:11435").port || "11435";
  if (await checkUrl(`http://127.0.0.1:${port}/health`)) return;
  if (llamaServerChild && !llamaServerChild.killed) return;
  llamaServerChild = startLlamaServer();
  if (llamaServerChild) await waitForUrl(`http://127.0.0.1:${port}/health`, 120_000, "llama-server");
}

function stopLlamaServer() {
  if (!llamaServerChild) return;
  try {
    llamaServerChild.kill();
    console.log("[llama-server] stopped");
  } catch (err) {
    console.warn("[llama-server] stop failed:", err.message);
  } finally {
    llamaServerChild = null;
  }
}

async function ensureOllamaServer() {
  if (await checkUrl(`${OLLAMA_URL}/api/tags`)) return;
  await startOllamaServer();
}

async function unloadOllamaModel(model) {
  if (!model) return;
  try {
    await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [], keep_alive: 0 }),
      signal: AbortSignal.timeout(5000),
    });
    console.log(`[ollama] unloaded ${model}`);
  } catch (err) {
    console.warn(`[ollama] unload failed: ${model}: ${err.message}`);
  }
}
