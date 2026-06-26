// data/vector-source/{style,topic,flow}.jsonl → data/vector-db/{style,topic,flow}.sqlite
// Ollamaでembeddingを生成し、SQLiteに格納する
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "data", "vector-source");
const DST = path.join(ROOT, "data", "vector-db");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const TABLES = ["style", "topic", "flow"];

async function embed(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Ollama embed HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embeddings;
}

function embeddingText(item, type) {
  if (type === "style") return item.search_text || item.text;
  if (type === "topic") return item.search_text || item.handling || item.title;
  return item.search_text || item.summary || item.title;
}

for (const name of TABLES) {
  const srcPath = path.join(SRC, `${name}.jsonl`);
  const raw = await readFile(srcPath, "utf8");
  const items = raw.split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
  console.log(`${name}: ${items.length} records to embed`);

  const dbPath = path.join(DST, `${name}.sqlite`);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      embedding BLOB NOT NULL
    )
  `);
  db.exec("DELETE FROM vectors");

  const insert = db.prepare("INSERT INTO vectors (id, data, embedding) VALUES (?, ?, ?)");

  const BATCH = 32;
  let done = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const texts = batch.map(item => embeddingText(item, name));
    const embeddings = await embed(texts);
    for (let j = 0; j < batch.length; j++) {
      const vec = new Float32Array(embeddings[j]);
      insert.run(batch[j].id, JSON.stringify(batch[j]), new Uint8Array(vec.buffer));
    }
    done += batch.length;
    process.stderr.write(`  ${name}: ${done}/${items.length}\n`);
  }

  db.close();
  console.log(`${name}.sqlite: done (${done} vectors)`);
}

console.log("\nAll vector DBs built.");
