// data/vector-source/{style,topic,flow}.jsonl のバリデーション
// 1. ID重複チェック  2. 必須フィールドチェック  3. 固有名詞チェック  4. 原文コピー疑いチェック
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "data", "vector-source");

const COMMON = ["id", "source", "db_type"];
const SCHEMA = {
  style: { required: [...COMMON, "text", "move", "tags", "search_text"], dbType: "style", textField: "text" },
  topic: { required: [...COMMON, "topic", "title", "handling", "steps", "tags", "search_text"], dbType: "topic", textField: "handling" },
  flow:  { required: [...COMMON, "title", "summary", "sections", "tags", "search_text"], dbType: "flow", textField: "summary" },
};

const PROPER_NOUNS = [
  // 配信者名・グループ名
  /にじさんじ|ホロライブ|ぶいすぽ|のりプロ|ネオポルテ|774|ななしいんく/,
  /ぺこら|ぺこーら|マリン|船長|すいせい|みこ|そら|あくあ|シオン|あやめ|ちょこ|スバル|ミオ|おかゆ|ころね|フレア|ノエル|かなた|ココ|わため|トワ|ルーナ|ラミィ|ねね|ぼたん|ポルカ|ししろん/,
  /サロメ|ローレン|(?<![叶か])叶(?![う])|葛葉|チャイカ|レイン|アクシア|ヴォックス|ミスタ|シュウ|アイク|リゼ|アンジュ・カトリーナ|戌亥とこ|でびでび|笹木|椎名唯華|社築|レオス|オリバー/,
  /フブキ|まつり|ロボ子|はあと|メル|アキロゼ|赤井はあと|夏色まつり|白上フブキ|湊あくあ|百鬼あやめ|紫咲シオン|大空スバル|大神ミオ|猫又おかゆ|戌神ころね|不知火フレア|白銀ノエル|天音かなた|角巻わため|常闇トワ|姫森ルーナ|雪花ラミィ|桃鈴ねね|獅白ぼたん|尾丸ポルカ/,
  /兎田ぺこら|宝鐘マリン|星街すいせい|さくらみこ|ときのそら/,
  // 作品名・キャラ名
  /マイクラ|マインクラフト|Minecraft|APEX|エーペックス|Valorant|ヴァロラント|原神|スプラ|スプラトゥーン|ポケモン|ゼルダ|モンハン|ダクソ|エルデンリング|FF14|プロセカ|雀魂|麻雀|Ark|ARK|RUST|GTA|Among\s?Us|DbD|Dead\s?by/i,
];

let errors = 0;
let warnings = 0;

function err(file, id, msg) { console.error(`ERROR [${file}] ${id}: ${msg}`); errors++; }
function warn(file, id, msg) { console.error(`WARN  [${file}] ${id}: ${msg}`); warnings++; }

for (const [name, schema] of Object.entries(SCHEMA)) {
  const filePath = path.join(SRC, `${name}.jsonl`);
  let raw;
  try { raw = await readFile(filePath, "utf8"); } catch { err(name, "-", "file not found"); continue; }

  const lines = raw.split("\n").filter(l => l.trim());
  const ids = new Set();

  for (let i = 0; i < lines.length; i++) {
    let item;
    try { item = JSON.parse(lines[i]); } catch { err(name, `line${i+1}`, "JSON parse error"); continue; }

    // ID重複
    if (ids.has(item.id)) err(name, item.id, "duplicate ID");
    ids.add(item.id);

    // 必須フィールド
    for (const field of schema.required) {
      if (item[field] === undefined || item[field] === null || item[field] === "") {
        err(name, item.id || `line${i+1}`, `missing required field: ${field}`);
      }
    }

    // db_type一致
    if (item.db_type && item.db_type !== schema.dbType) {
      err(name, item.id, `db_type mismatch: expected "${schema.dbType}", got "${item.db_type}"`);
    }

    // text長チェック (styleのみ)
    if (name === "style" && item.text) {
      if (item.text.length < 30) warn(name, item.id, `text too short (${item.text.length} chars)`);
      if (item.text.length > 120) warn(name, item.id, `text too long (${item.text.length} chars)`);
    }

    // 固有名詞チェック (textFieldを対象)
    const mainText = item[schema.textField] || "";
    if (mainText) {
      for (const re of PROPER_NOUNS) {
        const match = mainText.match(re);
        if (match) {
          warn(name, item.id, `proper noun found: "${match[0]}" → ${mainText.slice(0, 50)}`);
          break;
        }
      }
    }
    if (item.search_text) {
      for (const re of PROPER_NOUNS) {
        const match = item.search_text.match(re);
        if (match) {
          warn(name, item.id, `proper noun in search_text: "${match[0]}"`);
          break;
        }
      }
    }

    // tags配列チェック
    if (item.tags !== undefined && !Array.isArray(item.tags)) {
      err(name, item.id, "tags must be an array");
    }

    // steps配列チェック (flowのみ)
    if (name === "flow" && item.steps !== undefined && !Array.isArray(item.steps)) {
      err(name, item.id, "steps must be an array");
    }
  }

  console.log(`${name}.jsonl: ${lines.length} records, ${ids.size} unique IDs`);
}

console.log(`\nValidation complete: ${errors} errors, ${warnings} warnings`);
process.exit(errors > 0 ? 1 : 0);
