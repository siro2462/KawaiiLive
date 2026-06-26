import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TALK_ITEMS_DB_PATH = path.join(PROJECT_ROOT, "data", "talk-items.sqlite");

export async function ensureTalkItemsTable() {
  await mkdir(path.dirname(TALK_ITEMS_DB_PATH), { recursive: true });
  const db = new DatabaseSync(TALK_ITEMS_DB_PATH);
  db.exec(`
    create table if not exists memory (
      id integer primary key autoincrement,
      keywords text not null,
      episode text not null,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    );
    create table if not exists live (
      id integer primary key autoincrement,
      title text not null,
      live_date text not null,
      status text not null default 'prepared',
      current_sequence_no integer not null default 0,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    );
    create table if not exists speech_lines (
      id integer primary key autoincrement,
      live_id integer not null references live(id) on delete cascade,
      sequence_no integer not null,
      text text not null,
      memory_id integer references memory(id),
      anchor text,
      audio_path text,
      status text not null default 'pending',
      spoken_at text,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp,
      unique(live_id, sequence_no)
    )
  `);
  const columns = db.prepare("pragma table_info(speech_lines)").all().map((column) => column.name);
  if (!columns.includes("anchor")) db.exec("alter table speech_lines add column anchor text");
  if (!columns.includes("llm_req")) db.exec("alter table speech_lines add column llm_req text");
  if (!columns.includes("llm_res")) db.exec("alter table speech_lines add column llm_res text");
  if (!columns.includes("generator_req")) db.exec("alter table speech_lines add column generator_req text");
  if (!columns.includes("generator_res")) db.exec("alter table speech_lines add column generator_res text");
  if (!columns.includes("director_req")) db.exec("alter table speech_lines add column director_req text");
  if (!columns.includes("director_res")) db.exec("alter table speech_lines add column director_res text");

  const liveCols = db.prepare("pragma table_info(live)").all().map((c) => c.name);
  if (!liveCols.includes("eval_depth")) db.exec("alter table live add column eval_depth integer");
  if (!liveCols.includes("eval_flow")) db.exec("alter table live add column eval_flow integer");
  if (!liveCols.includes("eval_naturalness")) db.exec("alter table live add column eval_naturalness integer");
  if (!liveCols.includes("eval_grounding")) db.exec("alter table live add column eval_grounding integer");
  if (!liveCols.includes("eval_repetition")) db.exec("alter table live add column eval_repetition integer");
  if (!liveCols.includes("eval_memo")) db.exec("alter table live add column eval_memo text");
  db.close();
}

export async function loadTalkMemories() {
  await ensureTalkItemsTable();
  const db = new DatabaseSync(TALK_ITEMS_DB_PATH);
  const rows = db.prepare("select id, keywords, episode from memory order by id").all();
  db.close();
  return rows.map(rowToMemory).filter((memory) => memory.keywords.length && memory.episode);
}

export async function replaceTalkMemoriesFromJsonFiles(files) {
  await ensureTalkItemsTable();
  const db = new DatabaseSync(TALK_ITEMS_DB_PATH);
  db.exec("begin");
  try {
    db.exec("delete from memory");
    db.exec("delete from sqlite_sequence where name = 'memory'");
    const insert = db.prepare("insert into memory (keywords, episode) values (?, ?)");
    let count = 0;
    for (const file of files) {
      const items = JSON.parse(await readFile(file.path, "utf8"));
      for (const item of Array.isArray(items) ? items : []) {
        if (!item?.episode) continue;
        const keywords = buildStoredKeywords(item);
        insert.run(JSON.stringify(keywords), cleanText(item.episode));
        count += 1;
      }
    }
    db.exec("commit");
    db.close();
    return count;
  } catch (error) {
    db.exec("rollback");
    db.close();
    throw error;
  }
}

export function rowToMemory(row) {
  const keywords = parseKeywords(row.keywords).filter((keyword) => !keyword.startsWith("__"));
  return {
    id: String(row.id),
    rowId: row.id,
    keywords,
    episode: cleanText(row.episode),
  };
}

function buildStoredKeywords(item) {
  const keywords = Array.isArray(item.keywords) ? item.keywords.map(cleanText).filter(Boolean) : [];
  return [...new Set(keywords)];
}

function parseKeywords(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(cleanText).filter(Boolean) : [];
  } catch {
    return String(value || "").split(",").map(cleanText).filter(Boolean);
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
