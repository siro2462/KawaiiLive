// vector DBからコサイン類似度で検索する
// 起動時にSQLiteから全embeddingをメモリにロードし、Ollamaでクエリをembedしてtop-k検索
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_DIR = path.join(PROJECT_ROOT, "data", "vector-db");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const cache = new Map();

function loadVectors(name) {
  if (cache.has(name)) return cache.get(name);
  const dbPath = path.join(DB_DIR, `${name}.sqlite`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, data, embedding FROM vectors").all();
    const entries = rows.map(row => ({
      id: row.id,
      data: JSON.parse(row.data),
      vec: new Float32Array(new Uint8Array(row.embedding).buffer),
    }));
    cache.set(name, entries);
    return entries;
  } finally {
    db.close();
  }
}

async function embedQuery(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: [text] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Embed HTTP ${res.status}`);
  const data = await res.json();
  return new Float32Array(data.embeddings[0]);
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export async function search(dbName, query, topK = 5) {
  const entries = loadVectors(dbName);
  const queryVec = await embedQuery(query);
  const scored = entries.map(e => ({ ...e, score: cosineSimilarity(queryVec, e.vec) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export async function retrieveSpeakingStyle(query, topK = 4) {
  const results = await search("style", query, topK);
  return results.map(r => ({
    id: r.id,
    source_id: r.data.source_id || "",
    flow_id: r.data.flow_id || "",
    topic_id: r.data.topic_id || "",
    text: r.data.text,
  }));
}

export async function retrieveTopicFlow(query, topK = 3) {
  const results = await search("topic", query, topK);
  return results.map(r => ({ id: r.id, ...r.data }));
}

export async function retrieveFlow(query, topK = 6) {
  const results = await search("flow", query, topK);
  return results.map(r => ({ id: r.id, ...r.data }));
}
