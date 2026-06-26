// JSONL → nomic-embed-text embedding → SQLite vector DB
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARDS_DIR = path.join(ROOT, "data", "cards");
const DB_DIR = path.join(ROOT, "data", "vector-db");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const BATCH_SIZE = 20;

async function embedBatch(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Embed HTTP ${res.status}`);
  const data = await res.json();
  return data.embeddings.map(e => Buffer.from(new Float32Array(e).buffer));
}

function buildStyleSearchText(c) {
  return [c.text, c.move, ...(c.tags || []), ...(c.texture_tags || [])].filter(Boolean).join(" ");
}

function buildTopicSearchText(c) {
  return [c.topic, c.handling, ...(c.steps || []), ...(c.tags || []), c.search_text].filter(Boolean).join(" ");
}

function buildMacroSearchText(c) {
  return [c.name, c.entry, c.exit, ...(c.steps || []), ...(c.tags || []), c.search_text].filter(Boolean).join(" ");
}

function styleDataFn(c) {
  return { id: c.id, source: c.speaker, db_type: "style", text: c.text, move: c.move, tags: c.tags, search_text: c.search_text };
}

function topicDataFn(c) {
  return { id: c.id, source: c.speaker, db_type: "topic", topic: c.topic, title: c.title, handling: c.handling, steps: c.steps, entry: c.entry, exit: c.exit, tags: c.tags, search_text: c.search_text };
}

function macroDataFn(c) {
  return { id: c.id, source: c.speaker, type: "flow", db_type: "flow", title: c.name || c.title, summary: c.summary || c.name, entry: c.entry, exit: c.exit, sections: c.sections, tags: c.tags, search_text: c.search_text };
}

async function loadJsonl(filename) {
  const content = await readFile(path.join(CARDS_DIR, filename), "utf8");
  return content.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function writeDb(dbName, cards, searchTextFn, dataFn) {
  const dbPath = path.join(DB_DIR, `${dbName}.sqlite`);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, data TEXT NOT NULL, embedding BLOB NOT NULL)");
  const insert = db.prepare("INSERT OR REPLACE INTO vectors (id, data, embedding) VALUES (?, ?, ?)");

  const searchTexts = cards.map(c => searchTextFn(c).slice(0, 2000));
  const t0 = Date.now();

  db.exec("BEGIN");
  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const batch = cards.slice(i, i + BATCH_SIZE);
    const batchTexts = searchTexts.slice(i, i + BATCH_SIZE);
    const embeddings = await embedBatch(batchTexts);
    for (let j = 0; j < batch.length; j++) {
      insert.run(batch[j].id, JSON.stringify(dataFn(batch[j])), embeddings[j]);
    }
    const done = Math.min(i + BATCH_SIZE, cards.length);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  [${dbName}] ${done}/${cards.length} (${elapsed}s)`);
  }
  db.exec("COMMIT");
  db.close();
  console.log(`  [${dbName}] done → ${dbPath}`);
}

async function main() {
  const speaker = process.argv[2] || "アンジュ";

  console.log("=== Loading JSONL cards ===");
  const styleCards = await loadJsonl(`style_${speaker}.jsonl`);
  const topicCards = await loadJsonl(`topic_${speaker}.jsonl`);
  const macroCards = await loadJsonl(`macro_${speaker}.jsonl`);
  console.log(`  style: ${styleCards.length}, topic: ${topicCards.length}, macro: ${macroCards.length}`);

  console.log("\n=== Embedding + DB write: style ===");
  await writeDb("style", styleCards, buildStyleSearchText, styleDataFn);

  console.log("\n=== Embedding + DB write: topic ===");
  await writeDb("topic", topicCards, buildTopicSearchText, topicDataFn);

  console.log("\n=== Embedding + DB write: flow ===");
  await writeDb("flow", macroCards, buildMacroSearchText, macroDataFn);

  console.log("\n=== Done ===");
  console.log(`  style: ${styleCards.length}, topic: ${topicCards.length}, flow: ${macroCards.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
