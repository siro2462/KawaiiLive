import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = path.resolve(APP_DIR, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "talk-items.sqlite");
export const SCRIPT_PLAN_PATH = path.join(DATA_DIR, "logs", "script-plan.json");

const V3_SECONDS_PER_BLOCK = 120;
const V3_MIN_BLOCKS = 5;

function formatJST(date) {
  const d = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function prepareBroadcastScript({
  minutes = 30,
  turns,
  mode = "create",
  model: requestedModel = "",
  modelProfile = "",
  modelLabel: requestedModelLabel = "",
  signal,
  onProgress = () => {},
} = {}) {
  const effectiveTurns = turns ?? Math.max(V3_MIN_BLOCKS, Math.round((minutes * 60) / V3_SECONDS_PER_BLOCK));
  const v3 = await import("../daihon/generate.mjs");
  const model = requestedModel || v3.defaultModel();
  const modelLabel = `script-v3+${requestedModelLabel ? `${requestedModelLabel}:` : ""}${model}`;

  onProgress({ progress: 5, label: `v3: Generating ${effectiveTurns} blocks (~${minutes}min) with ${model}` });
  const items = await v3.generateScriptV3({ turns: effectiveTurns, model, signal, onProgress });

  validatePreparedItems(items);
  const plan = {
    version: 10,
    createdAt: new Date().toISOString(),
    minutes,
    model: modelLabel,
    modelProfile,
    index: 0,
    items,
  };
  await saveBroadcastScript(plan, { mode });
  onProgress({ progress: 100, label: `Script prepared: ${items.length} lines` });
  return plan;
}

export async function loadBroadcastScript() {
  try {
    const plan = loadLatestDbPlan();
    if (plan.items?.length) return plan;
  } catch {
    // Fall back to the legacy JSON mirror.
  }
  try {
    const plan = JSON.parse(await readFile(SCRIPT_PLAN_PATH, "utf8"));
    return plan.items?.length ? plan : emptyPlan();
  } catch {
    return emptyPlan();
  }
}

export async function saveBroadcastScript(plan, { mode = "update" } = {}) {
  if (mode === "create" || mode === "append") {
    Object.assign(plan, savePlanToDb(plan, { mode }));
  } else if (plan.liveId) {
    updateLiveProgress(plan);
  }
  await mkdir(path.dirname(SCRIPT_PLAN_PATH), { recursive: true });
  await writeFile(SCRIPT_PLAN_PATH, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

export async function generateCommentInsert({ comment, recentHistory = [] }) {
  const cleaned = cleanText(comment).slice(0, 60);
  const bridge = recentHistory.length ? "さっきの話とも少しつながるけど、" : "";
  return `あ、${cleaned}って言われると急に現実に戻るね。${bridge}今それを考えながら話してた。`;
}

function validatePreparedItems(items) {
  if (!Array.isArray(items) || !items.length) throw new Error("Prepared script is empty");
  const invalid = items.find((item) => !item.text || (item.source_type !== "kaidan" && !normalizeMemoryId(item.memoryId)));
  if (invalid) throw new Error("Prepared script has an invalid line");
}

function savePlanToDb(plan, { mode }) {
  const db = new DatabaseSync(DB_PATH);
  db.exec("pragma foreign_keys = on");
  ensureSpeechLineColumns(db);
  db.exec("begin");
  try {
    const now = formatJST(new Date());
    let liveId = null;
    let startSequence = 0;

    if (mode === "append") {
      const latest = db.prepare("select id from live where status != 'finished' order by id desc limit 1").get();
      liveId = latest?.id || null;
    }

    if (liveId) {
      const row = db.prepare("select coalesce(max(sequence_no), 0) as max_sequence from speech_lines where live_id = ?").get(liveId);
      startSequence = Number(row?.max_sequence || 0);
      db.prepare("update live set updated_at = ? where id = ?").run(now, liveId);
    } else {
      const title = `Live ${new Date().toLocaleString("ja-JP", { hour12: false })}`;
      const liveDate = now.slice(0, 10);
      const result = db
        .prepare("insert into live (title, live_date, status, created_at, updated_at) values (?, ?, 'prepared', ?, ?)")
        .run(title, liveDate, now, now);
      liveId = Number(result.lastInsertRowid);
    }

    const insertLine = db.prepare(`
      insert into speech_lines (
        live_id, sequence_no, text, memory_id, anchor,
        generator_req, generator_res, director_req, director_res,
        transition_type, transition_keyword, transition_reason, prev_hooks, next_hooks,
        prompt_type, source_type, research_id, research_title, research_part,
        handoff_mode, handoff_action, handoff_feeling,
        actual_transition_type, planner_transition_type, director_parse_ok, selected_plan_block,
        status, created_at, updated_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);

    const items = plan.items.map((item, index) => ({
      ...item,
      number: startSequence + index + 1,
      scriptNumber: startSequence + index + 1,
    }));

    for (const item of items) {
      insertLine.run(
        liveId,
        item.number,
        item.text || "",
        normalizeMemoryId(item.memoryId),
        cleanText(item.anchor || ""),
        item.generator_req || item.llm_req || "",
        item.generator_res || item.llm_res || "",
        item.director_req || "",
        item.director_res || "",
        item.transition_type || "",
        item.transition_keyword || "",
        item.transition_reason || "",
        item.prev_hooks || "",
        item.next_hooks || "",
        item.prompt_type || "",
        item.source_type || "",
        item.research_id || "",
        item.research_title || "",
        item.research_part || "",
        item.handoff_mode || "",
        item.handoff_action || "",
        item.handoff_feeling || "",
        item.actual_transition_type || "",
        item.planner_transition_type || "",
        item.director_parse_ok || "",
        item.selected_plan_block || "",
        now,
        now,
      );
    }

    db.prepare("update live set updated_at = ? where id = ?").run(now, liveId);
    db.exec("commit");
    db.close();
    return {
      liveId,
      title: dbTitleForPlan(liveId),
      status: "prepared",
      updatedAt: now,
      total: startSequence + items.length,
      items,
      mode,
    };
  } catch (error) {
    db.exec("rollback");
    db.close();
    throw error;
  }
}

function dbTitleForPlan(liveId) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return db.prepare("select title from live where id = ?").get(liveId)?.title || "";
  } finally {
    db.close();
  }
}

export function loadDbPlanById(liveId) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const live = db.prepare("select * from live where id = ?").get(liveId);
    if (!live) return emptyPlan();
    return buildDbPlan(db, live);
  } finally {
    db.close();
  }
}

function loadLatestDbPlan() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const live = db.prepare("select * from live order by id desc limit 1").get();
    if (!live) return emptyPlan();
    return buildDbPlan(db, live);
  } finally {
    db.close();
  }
}

function buildDbPlan(db, live) {
  const rows = db.prepare(`
    select sl.sequence_no, sl.text, sl.memory_id, sl.anchor, sl.audio_path, sl.status, m.keywords
    from speech_lines sl
    left join memory m on m.id = sl.memory_id
    where sl.live_id = ?
    order by sl.sequence_no
  `).all(live.id);
  const items = rows.map((row) => ({
    number: row.sequence_no,
    scriptNumber: row.sequence_no,
    topic: live.title,
    anchor: row.anchor || firstKeyword(row.keywords),
    memoryId: row.memory_id ? String(row.memory_id) : "",
    text: row.text || "",
    audioPath: row.audio_path || "",
    attempt: "db_speech_line",
    status: row.status || "pending",
  }));
  return {
    version: 7,
    liveId: live.id,
    createdAt: live.created_at || "",
    updatedAt: live.updated_at || "",
    minutes: 0,
    model: "db-live-script",
    index: Number(live.current_sequence_no || 0),
    total: items.length,
    status: live.status || "prepared",
    title: live.title || "",
    items,
  };
}

function ensureSpeechLineColumns(db) {
  for (const [table, column, type] of [
    ["speech_lines", "anchor", "text"],
    ["speech_lines", "llm_req", "text"],
    ["speech_lines", "llm_res", "text"],
    ["speech_lines", "generator_req", "text"],
    ["speech_lines", "generator_res", "text"],
    ["speech_lines", "director_req", "text"],
    ["speech_lines", "director_res", "text"],
    ["speech_lines", "transition_type", "text"],
    ["speech_lines", "transition_keyword", "text"],
    ["speech_lines", "transition_reason", "text"],
    ["speech_lines", "prev_hooks", "text"],
    ["speech_lines", "next_hooks", "text"],
    ["speech_lines", "prompt_type", "text"],
    ["speech_lines", "source_type", "text"],
    ["speech_lines", "research_id", "text"],
    ["speech_lines", "research_title", "text"],
    ["speech_lines", "research_part", "text"],
    ["speech_lines", "handoff_mode", "text"],
    ["speech_lines", "handoff_action", "text"],
    ["speech_lines", "handoff_feeling", "text"],
    ["speech_lines", "actual_transition_type", "text"],
    ["speech_lines", "planner_transition_type", "text"],
    ["speech_lines", "director_parse_ok", "text"],
    ["speech_lines", "selected_plan_block", "text"],
  ]) {
    if (!tableHasColumn(db, table, column)) db.exec(`alter table ${table} add column ${column} ${type}`);
  }
}

function tableHasColumn(db, table, column) {
  return db.prepare(`pragma table_info(${table})`).all().some((row) => row.name === column);
}

function updateLiveProgress(plan) {
  const db = new DatabaseSync(DB_PATH);
  try {
    const now = new Date().toISOString();
    const index = Number(plan.index || 0);
    db.prepare("update live set current_sequence_no = ?, updated_at = ? where id = ?").run(index, now, plan.liveId);
    if (index > 0) {
      db.prepare("update speech_lines set status = 'spoken', spoken_at = coalesce(spoken_at, ?), updated_at = ? where live_id = ? and sequence_no <= ?")
        .run(now, now, plan.liveId, index);
    }
  } finally {
    db.close();
  }
}

function normalizeMemoryId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function firstKeyword(value) {
  try {
    const keywords = JSON.parse(value || "[]");
    return Array.isArray(keywords) ? keywords[0] || "" : "";
  } catch {
    return "";
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function emptyPlan() {
  return { version: 6, createdAt: "", minutes: 0, model: "", index: 0, items: [] };
}
