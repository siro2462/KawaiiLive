// v3 MD → style/topic/flow CSV + SQLite vector DB
// Usage: node work/generate-all-cards.mjs [--skip-embed] [--file xxx.md]
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRANSCRIPT_DIR = path.join(ROOT, "assets", "vtuber台本");
const CARDS_DIR = path.join(ROOT, "data", "cards");
const DB_DIR = path.join(ROOT, "data", "vector-db");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const args = process.argv.slice(2);
const skipEmbed = args.includes("--skip-embed");
const singleFile = args.find((_, i, a) => a[i - 1] === "--file");

const SOURCE_MAP = {
  "おかゆ": "okayu", "たっくー怪談": "takkuu", "ぺこら": "pekora",
  "アンジュ": "anju", "エル": "eru", "トワ": "towa",
  "フブキ": "fubuki", "フブキ2": "fubuki2", "戌亥": "inui",
  "椎名唯華": "shiina", "百鬼あやめ": "ayame", "雪花ラミィ": "lamy",
};

function getSourceId(speaker) {
  const romaji = SOURCE_MAP[speaker] || speaker;
  const m = romaji.match(/^(.+?)(\d+)$/);
  if (m) return `${m[1]}_${m[2].padStart(3, "0")}`;
  return `${romaji}_001`;
}

function parseMd(content) {
  const lines = content.split(/\r?\n/);
  const topics = [];
  let cur = null;
  for (const line of lines) {
    const tm = line.match(/^# (.+)/);
    if (tm) {
      cur = { topic: tm[1].trim(), handling: "", moves: [] };
      topics.push(cur);
      continue;
    }
    const dm = line.match(/^## (.+)/);
    if (dm && cur) { cur.handling = dm[1].trim(); continue; }
    const text = line.trim();
    if (!text || !cur || text.length < 10) continue;
    cur.moves.push(text);
  }
  return topics;
}

function csvQuote(val) {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(fields) { return fields.map(csvQuote).join(","); }

async function embedBatch(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Embed HTTP ${res.status}`);
  return (await res.json()).embeddings.map(e => Buffer.from(new Float32Array(e).buffer));
}

async function writeDb(dbName, allCards, embedTextFn, dataFn) {
  const dbPath = path.join(DB_DIR, `${dbName}.sqlite`);
  const db = new DatabaseSync(dbPath);
  db.exec("DROP TABLE IF EXISTS vectors");
  db.exec("CREATE TABLE vectors (id TEXT PRIMARY KEY, data TEXT NOT NULL, embedding BLOB NOT NULL)");
  const ins = db.prepare("INSERT INTO vectors (id, data, embedding) VALUES (?, ?, ?)");
  const BS = 20;
  const t0 = Date.now();
  db.exec("BEGIN");
  for (let i = 0; i < allCards.length; i += BS) {
    const batch = allCards.slice(i, i + BS);
    const texts = batch.map(c => embedTextFn(c).slice(0, 2000));
    const embs = await embedBatch(texts);
    for (let j = 0; j < batch.length; j++) ins.run(batch[j].id, JSON.stringify(dataFn(batch[j])), embs[j]);
    console.log(`  [${dbName}] ${Math.min(i + BS, allCards.length)}/${allCards.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  db.exec("COMMIT");
  db.close();
  console.log(`  [${dbName}] done → ${dbPath}`);
}

async function main() {
  await mkdir(CARDS_DIR, { recursive: true });
  await mkdir(DB_DIR, { recursive: true });

  const files = singleFile
    ? [singleFile]
    : (await readdir(TRANSCRIPT_DIR)).filter(f => f.endsWith(".md"));

  const allStyle = [], allTopic = [], allFlow = [];

  for (const file of files) {
    const speaker = file.replace(/\.md$/, "");
    const sourceId = getSourceId(speaker);
    console.log(`\n=== ${file} → ${sourceId} ===`);

    const content = await readFile(path.join(TRANSCRIPT_DIR, file), "utf8");
    const topics = parseMd(content);
    console.log(`  ${topics.length} topics`);

    let styleGlobal = 0;
    const styleRows = [], topicRows = [];
    const flowId = `flow_${sourceId}`;

    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      const order = i + 1;
      const topicId = `topic_${sourceId}_${String(order).padStart(4, "0")}`;

      topicRows.push({
        id: topicId, source_id: sourceId, flow_id: flowId,
        topic: t.topic, handling: t.handling || t.topic,
      });

      for (let j = 0; j < t.moves.length; j++) {
        styleGlobal++;
        styleRows.push({
          id: `style_${sourceId}_${String(styleGlobal).padStart(6, "0")}`,
          source_id: sourceId, flow_id: flowId, topic_id: topicId,
          seq_no: j + 1, text: t.moves[j],
        });
      }
    }

    const flowText = topics.map((t, i) =>
      `${i + 1}. ${t.topic} — ${t.handling || t.topic}`
    ).join("\n");
    const flowRow = { id: flowId, source_id: sourceId, flow: flowText };

    console.log(`  style: ${styleRows.length}, topic: ${topicRows.length}, flow: 1`);

    const sH = "id,source_id,flow_id,topic_id,seq_no,text";
    const sCsv = [sH, ...styleRows.map(r => csvRow([r.id, r.source_id, r.flow_id, r.topic_id, r.seq_no, r.text]))].join("\n") + "\n";
    await writeFile(path.join(CARDS_DIR, `style_${sourceId}.csv`), sCsv, "utf8");

    const tH = "id,source_id,flow_id,topic,handling";
    const tCsv = [tH, ...topicRows.map(r => csvRow([r.id, r.source_id, r.flow_id, r.topic, r.handling]))].join("\n") + "\n";
    await writeFile(path.join(CARDS_DIR, `topic_${sourceId}.csv`), tCsv, "utf8");

    const fH = "id,source_id,flow";
    const fCsv = [fH, csvRow([flowRow.id, flowRow.source_id, flowRow.flow])].join("\n") + "\n";
    await writeFile(path.join(CARDS_DIR, `flow_${sourceId}.csv`), fCsv, "utf8");

    allStyle.push(...styleRows);
    allTopic.push(...topicRows);
    allFlow.push(flowRow);
  }

  console.log(`\n=== Total: style=${allStyle.length}, topic=${allTopic.length}, flow=${allFlow.length} ===`);

  if (skipEmbed) { console.log("Skipping embed (--skip-embed)"); return; }

  const topicNameMap = new Map();
  for (const t of allTopic) topicNameMap.set(t.id, t.topic);

  const sEmb = c => `source: ${c.source_id}\ntopic: ${topicNameMap.get(c.topic_id) || ""}\ntext: ${c.text}`;
  const tEmb = c => `topic: ${c.topic}\nhandling: ${c.handling}`;
  const fEmb = c => `source: ${c.source_id}\nflow:\n${c.flow}`;

  const sData = c => ({ id: c.id, source_id: c.source_id, flow_id: c.flow_id, topic_id: c.topic_id, seq_no: c.seq_no, text: c.text });
  const tData = c => ({ id: c.id, source_id: c.source_id, flow_id: c.flow_id, topic: c.topic, handling: c.handling });
  const fData = c => ({ id: c.id, source_id: c.source_id, flow: c.flow });

  console.log("\n=== Embedding + DB write ===");
  await writeDb("style", allStyle, sEmb, sData);
  await writeDb("topic", allTopic, tEmb, tData);
  await writeDb("flow", allFlow, fEmb, fData);

  console.log(`\n=== All done: style=${allStyle.length}, topic=${allTopic.length}, flow=${allFlow.length} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
