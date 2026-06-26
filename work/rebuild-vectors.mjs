// 文字起こしMDからvector DB (style/topic/flow) を再構築する
// Usage: node work/rebuild-vectors.mjs [--file アンジュ.md] [--phase 1|2|3|4|5|all] [--dry-run]
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRANSCRIPT_DIR = path.join(ROOT, "assets", "vtuber台本");
const VECTOR_DB_DIR = path.join(ROOT, "data", "vector-db");
const CARDS_DIR = path.join(ROOT, "data", "cards");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const args = process.argv.slice(2);
const fileArg = args.find((_, i, a) => a[i - 1] === "--file") || "アンジュ.md";
const phaseArg = args.find((_, i, a) => a[i - 1] === "--phase") || "all";
const dryRun = args.includes("--dry-run");

// ============================================================
// Phase 1: MDパース → source構造
// ============================================================

function parseMd(content, sourceFile, speaker) {
  const lines = content.split(/\r?\n/);
  const topics = [];
  let currentTopic = null;
  let moveIndex = 0;

  for (const line of lines) {
    const topicMatch = line.match(/^# (.+)/);
    if (topicMatch) {
      currentTopic = {
        id: `src_topic_${String(topics.length + 1).padStart(4, "0")}`,
        source_file: sourceFile,
        speaker,
        topic_title: topicMatch[1].trim(),
        macro_desc: "",
        order_index: topics.length + 1,
        moves: [],
      };
      topics.push(currentTopic);
      continue;
    }

    const descMatch = line.match(/^## (.+)/);
    if (descMatch && currentTopic) {
      currentTopic.macro_desc = descMatch[1].trim();
      continue;
    }

    const text = line.trim();
    if (!text || !currentTopic) continue;
    if (text.length < 15) continue;

    moveIndex++;
    currentTopic.moves.push({
      id: `src_move_${String(moveIndex).padStart(5, "0")}`,
      source_topic_id: currentTopic.id,
      source_file: sourceFile,
      speaker,
      text,
      order_index: moveIndex,
      char_count: text.length,
    });
  }

  return topics;
}

// ============================================================
// LLM呼び出し
// ============================================================

async function callLlm(systemPrompt, userPrompt, { temperature = 0.4, maxTokens = 1200 } = {}) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen3.6:35b-a3b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      think: false,
      options: { temperature, top_p: 0.9, num_predict: maxTokens },
    }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  return data.message?.content || "";
}

function extractJson(raw) {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```json\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  return JSON.parse(cleaned);
}

// ============================================================
// Phase 2: speaking_style カード生成
// ============================================================

async function buildStyleCards(topics, speaker, outPath) {
  const system = [
    "あなたは日本語VTuber配信の話し方を分析するアシスタント。",
    "ユーザーが渡す発話テキストに対して、以下のフィールドをJSON配列で返す。",
    "テキスト本文(text)は絶対に書き換えない。原文のまま返す。",
    "JSON以外は出力しない。",
  ].join("\n");

  const cards = [];
  const allMoves = topics.flatMap(t => t.moves);
  const batchSize = 8;
  await writeFile(outPath, "", "utf8");

  for (let i = 0; i < allMoves.length; i += batchSize) {
    const batch = allMoves.slice(i, i + batchSize);
    const user = [
      `話者: ${speaker}`,
      "",
      "以下の発話それぞれについて、JSONの配列で返して。",
      "各要素のスキーマ:",
      '{ "source_move_id": "元のid", "text": "原文そのまま", "move": "何をしている発話か(10字以内)", "tags": ["話題タグ3-5個"], "texture_tags": ["口調特徴2-4個(例:生活感,言いさし,自分ツッコミ,落ち着き,テンション高)"], "search_text": "検索用キーワード6-10個をスペース区切り" }',
      "",
      ...batch.map((m, j) => `[${j + 1}] id=${m.id}\n${m.text}`),
    ].join("\n");

    if (dryRun) {
      console.log(`  [style] would process batch ${i / batchSize + 1} (${batch.length} moves)`);
      continue;
    }

    const batchNum = i / batchSize + 1;
    const totalBatches = Math.ceil(allMoves.length / batchSize);
    console.log(`  [style] batch ${batchNum}/${totalBatches} (${batch.length} moves)...`);
    const batchCards = [];
    try {
      const raw = await callLlm(system, user, { maxTokens: 3000 });
      const parsed = extractJson(raw);
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        const move = batch.find(m => m.id === item.source_move_id) || batch[0];
        batchCards.push({
          id: `style_${speaker.slice(0, 3)}_${String(cards.length + batchCards.length + 1).padStart(5, "0")}`,
          source_move_id: item.source_move_id || move.id,
          speaker,
          text: move.text,
          move: String(item.move || "").slice(0, 30),
          tags: Array.isArray(item.tags) ? item.tags : [],
          texture_tags: Array.isArray(item.texture_tags) ? item.texture_tags : [],
          search_text: String(item.search_text || ""),
        });
      }
      console.log(`    → ${batchCards.length} cards OK`);
    } catch (e) {
      console.error(`  [style] batch ${batchNum} error:`, e.message);
      for (const m of batch) {
        batchCards.push({
          id: `style_${speaker.slice(0, 3)}_${String(cards.length + batchCards.length + 1).padStart(5, "0")}`,
          source_move_id: m.id, speaker, text: m.text,
          move: "", tags: [], texture_tags: [], search_text: "",
        });
      }
    }
    cards.push(...batchCards);
    await appendFile(outPath, batchCards.map(c => JSON.stringify(c)).join("\n") + "\n", "utf8");
  }

  return cards;
}

// ============================================================
// Phase 3: topic_flow カード生成
// ============================================================

async function buildTopicFlowCards(topics, speaker) {
  const system = [
    "あなたは日本語VTuber配信の話題展開パターンを分析するアシスタント。",
    "ユーザーが渡すtopic(タイトル+説明+発話例)から、その話題の「料理法」をJSON配列で1〜3件返す。",
    "handlingは「何を話すか」ではなく「どう展開するか」を書く。",
    "JSON以外は出力しない。",
  ].join("\n");

  const cards = [];

  for (const topic of topics) {
    if (!topic.moves.length) continue;
    const moveSamples = topic.moves.slice(0, 20).map(m => m.text).join("\n");

    const user = [

      `話者: ${speaker}`,
      `話題: ${topic.topic_title}`,
      `概要: ${topic.macro_desc}`,
      "",
      "発話例:",
      moveSamples,
      "",
      "この話題の展開パターンを1〜3件、以下のスキーマで返して:",
      '{ "topic": "話題名(短く)", "handling": "どう展開するか(具体物→感情/生活感/ツッコミなど、30-60字)", "steps": ["展開ステップ4-6個"], "tags": ["タグ3-6個"], "search_text": "検索用キーワード6-10個スペース区切り" }',
    ].join("\n");

    if (dryRun) {
      console.log(`  [topic] would process: ${topic.topic_title}`);
      continue;
    }

    console.log(`  [topic] ${topic.topic_title} (${topic.moves.length} moves)...`);
    try {
      const raw = await callLlm(system, user, { maxTokens: 2000 });
      const parsed = extractJson(raw);
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        cards.push({
          id: `topic_${speaker.slice(0, 3)}_${String(cards.length + 1).padStart(5, "0")}`,
          source_topic_id: topic.id,
          speaker,
          topic: String(item.topic || topic.topic_title).slice(0, 40),
          title: topic.topic_title,
          handling: String(item.handling || ""),
          steps: Array.isArray(item.steps) ? item.steps : [],
          entry: String(item.steps?.[0] || ""),
          exit: String(item.steps?.[item.steps?.length - 1] || ""),
          tags: Array.isArray(item.tags) ? item.tags : [],
          search_text: String(item.search_text || ""),
          db_type: "topic",
        });
      }
    } catch (e) {
      console.error(`  [topic] ${topic.topic_title} error:`, e.message);
    }
  }

  return cards;
}

// ============================================================
// Phase 4: macro_flow カード生成
// ============================================================

async function buildMacroFlowCards(topics, speaker, sourceFile) {
  const system = [
    "あなたは日本語VTuber配信の構成を分析するアシスタント。",
    "ユーザーが渡す配信全体の話題リストから、配信の大骨格パターンをJSONで返す。",
    "JSON以外は出力しない。",
  ].join("\n");

  const cards = [];

  // A. 配信全体macro (1枚)
  const topicList = topics.map((t, i) => `${i + 1}. ${t.topic_title}`).join("\n");
  const userWhole = [
    "/no_think",
    `話者: ${speaker}`,
    `ソース: ${sourceFile}`,
    "",
    "配信の話題一覧(順番通り):",
    topicList,
    "",
    "配信全体の骨格を1件、以下のスキーマで返して:",
    '{ "name": "配信全体の特徴を表す名前(20-40字)", "steps": ["配信の大まかな流れ5-8ステップ(具体的話題名ではなく抽象的な段階で)"], "entry": "配信の入り方", "exit": "配信の終わり方", "tags": ["タグ4-6個"], "search_text": "検索用キーワード6-10個スペース区切り" }',
  ].join("\n");

  if (dryRun) {
    console.log(`  [macro] would process: whole stream + ${Math.max(0, topics.length - 3)} windows`);
    return cards;
  }

  console.log(`  [macro] whole stream pattern...`);
  try {
    const raw = await callLlm(system, userWhole, { maxTokens: 1500 });
    const parsed = extractJson(raw);
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    cards.push({
      id: `macro_${speaker.slice(0, 3)}_stream_0001`,
      source_file_id: sourceFile,
      speaker,
      type: "flow",
      name: String(item.name || ""),
      summary: String(item.name || ""),
      title: String(item.name || ""),
      entry: String(item.entry || ""),
      exit: String(item.exit || ""),
      sections: (item.steps || []).map((s, i) => ({
        name: s,
        role: s,
        tags: [],
      })),
      steps: Array.isArray(item.steps) ? item.steps : [],
      tags: Array.isArray(item.tags) ? item.tags : [],
      search_text: String(item.search_text || ""),
      db_type: "flow",
    });
  } catch (e) {
    console.error(`  [macro] whole stream error:`, e.message);
  }

  // B. topic連続窓macro (3-5 topicスライド)
  const windowSize = Math.min(4, Math.max(3, Math.floor(topics.length / 3)));
  for (let i = 0; i <= topics.length - windowSize; i += Math.max(1, windowSize - 1)) {
    const window = topics.slice(i, i + windowSize);
    const windowList = window.map((t, j) => `${j + 1}. ${t.topic_title}: ${t.macro_desc.slice(0, 60)}`).join("\n");

    const userWindow = [

      `話者: ${speaker}`,
      "",
      "連続する話題群:",
      windowList,
      "",
      "この話題の連なりから、話題遷移パターンを1件、以下のスキーマで返して:",
      '{ "name": "遷移パターン名(20-40字)", "steps": ["話題の流れ3-5ステップ(抽象的に)"], "entry": "最初の話題の入り方", "exit": "最後の話題の終わり方", "tags": ["タグ3-5個"], "search_text": "検索用キーワード6-10個スペース区切り" }',
    ].join("\n");

    console.log(`  [macro] window ${i + 1}-${i + windowSize}...`);
    try {
      const raw = await callLlm(system, userWindow, { maxTokens: 1200 });
      const parsed = extractJson(raw);
      const item = Array.isArray(parsed) ? parsed[0] : parsed;
      cards.push({
        id: `macro_${speaker.slice(0, 3)}_window_${String(cards.length).padStart(4, "0")}`,
        source_file_id: sourceFile,
        speaker,
        type: "flow",
        name: String(item.name || ""),
        summary: String(item.name || ""),
        title: String(item.name || ""),
        entry: String(item.entry || ""),
        exit: String(item.exit || ""),
        sections: (item.steps || []).map((s) => ({
          name: s,
          role: s,
          tags: [],
        })),
        steps: Array.isArray(item.steps) ? item.steps : [],
        tags: Array.isArray(item.tags) ? item.tags : [],
        search_text: String(item.search_text || ""),
        db_type: "flow",
      });
    } catch (e) {
      console.error(`  [macro] window error:`, e.message);
    }
  }

  return cards;
}

// ============================================================
// Phase 5: embedding生成 + DB書き込み
// ============================================================

async function embedText(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: [text] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Embed HTTP ${res.status}`);
  const data = await res.json();
  return Buffer.from(new Float32Array(data.embeddings[0]).buffer);
}

function buildSearchTextForStyle(card) {
  return [card.text, card.move, ...(card.tags || []), ...(card.texture_tags || []), card.search_text].filter(Boolean).join(" ");
}

function buildSearchTextForTopic(card) {
  return [card.topic, card.handling, ...(card.steps || []), ...(card.tags || []), card.search_text].filter(Boolean).join(" ");
}

function buildSearchTextForMacro(card) {
  return [card.name, card.entry, card.exit, ...(card.steps || []), ...(card.tags || []), card.search_text].filter(Boolean).join(" ");
}

async function writeVectorDb(dbName, cards, searchTextFn, dataFn) {
  const dbPath = path.join(VECTOR_DB_DIR, `${dbName}.sqlite`);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, data TEXT NOT NULL, embedding BLOB NOT NULL)");
  const insert = db.prepare("INSERT OR REPLACE INTO vectors (id, data, embedding) VALUES (?, ?, ?)");

  db.exec("BEGIN");
  let count = 0;
  for (const card of cards) {
    const searchText = searchTextFn(card);
    if (!searchText.trim()) {
      console.warn(`  [embed] skip ${card.id}: empty search text`);
      continue;
    }
    console.log(`  [embed:${dbName}] ${count + 1}/${cards.length} ${card.id}...`);
    const embedding = await embedText(searchText.slice(0, 2000));
    const data = JSON.stringify(dataFn(card));
    insert.run(card.id, data, embedding);
    count++;
  }
  db.exec("COMMIT");
  db.close();
  console.log(`  [embed:${dbName}] wrote ${count} vectors to ${dbPath}`);
}

// ============================================================
// main
// ============================================================

async function main() {
  await mkdir(CARDS_DIR, { recursive: true });

  const mdPath = path.join(TRANSCRIPT_DIR, fileArg);
  console.log(`Source: ${mdPath}`);
  const content = await readFile(mdPath, "utf8");
  const speaker = fileArg.replace(/\.md$/, "");

  // Phase 1
  console.log("\n=== Phase 1: MD parse ===");
  const topics = parseMd(content, fileArg, speaker);
  const totalMoves = topics.reduce((s, t) => s + t.moves.length, 0);
  console.log(`  ${topics.length} topics, ${totalMoves} moves`);
  await writeFile(path.join(CARDS_DIR, `source_${speaker}.json`), JSON.stringify(topics, null, 2), "utf8");

  if (phaseArg !== "all" && phaseArg !== "2" && phaseArg !== "3" && phaseArg !== "4" && phaseArg !== "5") {
    console.log("Phase 1 done. Use --phase 2/3/4/5/all to continue.");
    return;
  }

  // Phase 2
  console.log("\n=== Phase 2: speaking_style cards ===");
  const styleOutPath = path.join(CARDS_DIR, `style_${speaker}.jsonl`);
  const styleCards = await buildStyleCards(topics, speaker, styleOutPath);
  console.log(`  ${styleCards.length} style cards generated (saved to ${styleOutPath})`);

  if (phaseArg !== "all" && phaseArg !== "3" && phaseArg !== "4" && phaseArg !== "5") {
    console.log("Phase 2 done.");
    return;
  }

  // Phase 3
  console.log("\n=== Phase 3: topic_flow cards ===");
  const topicCards = await buildTopicFlowCards(topics, speaker);
  console.log(`  ${topicCards.length} topic_flow cards generated`);
  await writeFile(path.join(CARDS_DIR, `topic_${speaker}.jsonl`), topicCards.map(c => JSON.stringify(c)).join("\n") + "\n", "utf8");

  if (phaseArg !== "all" && phaseArg !== "4" && phaseArg !== "5") {
    console.log("Phase 3 done.");
    return;
  }

  // Phase 4
  console.log("\n=== Phase 4: macro_flow cards ===");
  const macroCards = await buildMacroFlowCards(topics, speaker, fileArg);
  console.log(`  ${macroCards.length} macro_flow cards generated`);
  await writeFile(path.join(CARDS_DIR, `macro_${speaker}.jsonl`), macroCards.map(c => JSON.stringify(c)).join("\n") + "\n", "utf8");

  if (phaseArg !== "all" && phaseArg !== "5") {
    console.log("Phase 4 done.");
    return;
  }

  if (dryRun) {
    console.log("\n=== Dry run complete ===");
    return;
  }

  // Phase 5
  console.log("\n=== Phase 5: embedding + DB write ===");
  await writeVectorDb("style", styleCards, buildSearchTextForStyle, (c) => ({
    id: c.id, source: c.speaker, db_type: "style",
    text: c.text, move: c.move,
    tags: c.tags, search_text: c.search_text,
  }));

  await writeVectorDb("topic", topicCards, buildSearchTextForTopic, (c) => ({
    id: c.id, source: c.speaker, db_type: "topic",
    topic: c.topic, title: c.title, handling: c.handling,
    steps: c.steps, entry: c.entry, exit: c.exit,
    tags: c.tags, search_text: c.search_text,
  }));

  await writeVectorDb("flow", macroCards, buildSearchTextForMacro, (c) => ({
    id: c.id, source: c.speaker, type: "flow", db_type: "flow",
    title: c.name, summary: c.name,
    entry: c.entry, exit: c.exit,
    sections: c.sections,
    tags: c.tags, search_text: c.search_text,
  }));

  console.log("\n=== Done ===");
  console.log(`style: ${styleCards.length} cards`);
  console.log(`topic: ${topicCards.length} cards`);
  console.log(`macro: ${macroCards.length} cards`);
}

main().catch(e => { console.error(e); process.exit(1); });
