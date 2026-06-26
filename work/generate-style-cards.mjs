// styleカードをキーワードマッチングで生成（LLM不要）
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRANSCRIPT_DIR = path.join(ROOT, "assets", "vtuber台本");
const CARDS_DIR = path.join(ROOT, "data", "cards");

const MOVE_PATTERNS = [
  [/^(よいしょ|えー|はい|こんばん|こんにちは)/, "挨拶・導入"],
  [/(ありがとう|おめでとう|マジでめでたい)/, "祝い・感謝"],
  [/(悔しい|ダメだった|反省|後悔)/, "悔しさの表出"],
  [/(可愛い|かわいい|カワイイ)/, "可愛さへの反応"],
  [/(面白(い|かった)|おもろ|おもしろ)/, "面白さの共有"],
  [/(美味し|うまい|うめえ|おいし)/, "食の感想"],
  [/(怖い|やばい|ヤバ|えぐい)/, "驚き・恐れ"],
  [/(思った|気がする|かもしれない|かもな)/, "感想・推測"],
  [/(大変|無理|きつい|難しい|むずい)/, "困難の報告"],
  [/(行った|行って|行きました|帰った)/, "外出・移動"],
  [/(買った|買って|購入)/, "購入報告"],
  [/(いいね|良かった|良い|いいな|いいよ)/, "肯定・評価"],
  [/(知らない|分からない|わかんない)/, "無知の表明"],
  [/(マジで|ガチで|本当に)/, "強調"],
  [/(って(言って|話して)|聞いた)/, "伝聞・引用"],
  [/(じゃん|だよね|でしょ)/, "同意求め"],
  [/(ごめん|すまん|申し訳)/, "謝罪"],
  [/(待って|ちょっと).*ね/, "間つなぎ"],
  [/(そう|うん){2,}/, "相槌・確認"],
];

const TOPIC_TAG_MAP = {
  "配信開始": ["挨拶", "体調", "配信", "導入"],
  "実家帰省": ["犬", "実家", "帰省", "生活", "散歩"],
  "同期100万人": ["同期", "100万人", "達成", "祝い"],
  "神戸旅行": ["旅行", "神戸", "グルメ", "街"],
  "外出近況": ["外出", "シール", "趣味", "ライバー"],
  "エアライダー": ["大会", "ゲーム", "エアライダー"],
  "ポケモン": ["ポケモン", "御三家", "進化", "ゲーム"],
  "コラボ": ["コラボ", "悔しさ", "感情"],
  "ディズニー": ["ディズニー", "アトラクション", "相談"],
  "社会人": ["アドバイス", "時短", "社会人", "美容"],
  "鼻": ["体調", "鼻", "違和感"],
  "虹橋": ["コラボ", "虹橋", "ボドゲ"],
  "流行": ["作品", "ドラマ", "流行"],
  "友達": ["友達", "嫉妬", "関係性", "成長"],
  "赤福": ["和菓子", "赤福", "お土産", "食"],
  "切り抜き": ["切り抜き", "ショート", "運用"],
  "花粉": ["花粉", "ゲーム", "一番くじ"],
  "韓国": ["韓国", "ドラマ", "Netflix"],
  "蜂蜜": ["蜂蜜", "奮発", "ガジェット"],
  "体調": ["締め", "体調", "予定"],
};

const TEXTURE_PATTERNS = [
  [/[。、].*[。、].*[。、]/, "言いさし"],
  [/(でも|けど|だけど)/, "逆接多用"],
  [/[ねよな]。$/, "語尾柔らか"],
  [/(マジで|ガチで|本当に)/, "強調グセ"],
  [/(思う|気がする|かな)/, "ためらい"],
  [/(笑|おもろ|面白|ウケ)/, "自分ツッコミ"],
  [/(いや|ちょ|え).*[、。]/, "驚き導入"],
  [/っていう/, "引用口調"],
  [/(うん|そう|ね)[。、]/, "相槌口調"],
  [/(だから|なので|から)/, "因果説明"],
  [/[！？!?]/, "テンション高"],
  [/(分かんない|知らない|忘れた)/, "素直な無知"],
  [/.{100,}/, "長文一息"],
  [/(でさ|てさ|けどさ)/, "生活感"],
];

function detectMove(text) {
  for (const [pat, label] of MOVE_PATTERNS) {
    if (pat.test(text)) return label;
  }
  if (text.length < 30) return "短い反応";
  return "語り";
}

function detectTopicTags(topicTitle) {
  for (const [key, tags] of Object.entries(TOPIC_TAG_MAP)) {
    if (topicTitle.includes(key)) return tags;
  }
  return ["雑談"];
}

function detectTextureTags(text) {
  const tags = new Set();
  for (const [pat, label] of TEXTURE_PATTERNS) {
    if (pat.test(text)) tags.add(label);
  }
  if (!tags.size) tags.add("落ち着き");
  return [...tags].slice(0, 4);
}

function extractSearchWords(text, topicTitle) {
  const cjk = text.match(/[぀-鿿＀-￯]{2,8}/g) || [];
  const unique = [...new Set(cjk)].slice(0, 6);
  const topicWords = topicTitle.match(/[぀-鿿＀-￯]{2,6}/g) || [];
  return [...new Set([...unique, ...topicWords.slice(0, 3)])].join(" ");
}

function parseMd(content, sourceFile, speaker) {
  const lines = content.split(/\r?\n/);
  const topics = [];
  let currentTopic = null;
  let moveIndex = 0;
  for (const line of lines) {
    const topicMatch = line.match(/^# (.+)/);
    if (topicMatch) {
      currentTopic = { topic_title: topicMatch[1].trim(), moves: [] };
      topics.push(currentTopic);
      continue;
    }
    if (line.match(/^## /)) continue;
    const text = line.trim();
    if (!text || !currentTopic || text.length < 15) continue;
    moveIndex++;
    currentTopic.moves.push({
      id: `src_move_${String(moveIndex).padStart(5, "0")}`,
      text, topic_title: currentTopic.topic_title,
    });
  }
  return { topics, totalMoves: moveIndex };
}

async function main() {
  await mkdir(CARDS_DIR, { recursive: true });
  const fileArg = process.argv[2] || "アンジュ.md";
  const speaker = fileArg.replace(/\.md$/, "");
  const content = await readFile(path.join(TRANSCRIPT_DIR, fileArg), "utf8");
  const { topics, totalMoves } = parseMd(content, fileArg, speaker);
  console.log(`${topics.length} topics, ${totalMoves} moves`);

  const cards = [];
  for (const topic of topics) {
    const topicTags = detectTopicTags(topic.topic_title);
    for (const move of topic.moves) {
      cards.push({
        id: `style_${speaker.slice(0, 3)}_${String(cards.length + 1).padStart(5, "0")}`,
        source_move_id: move.id,
        speaker,
        text: move.text,
        move: detectMove(move.text),
        tags: topicTags,
        texture_tags: detectTextureTags(move.text),
        search_text: extractSearchWords(move.text, move.topic_title),
      });
    }
  }

  const outPath = path.join(CARDS_DIR, `style_${speaker}.jsonl`);
  await writeFile(outPath, cards.map(c => JSON.stringify(c)).join("\n") + "\n", "utf8");
  console.log(`${cards.length} style cards → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
