const WEAK_HOOKS = new Set([
  "瞬間", "不安", "安心", "気持ち", "時間", "夜", "夜中", "深夜",
  "生活", "生活感", "達成感", "現実", "普通", "最近", "結局",
  "店員", "母親", "友達", "自分", "一人", "散歩", "帰宅",
  "画面", "レジ", "店内", "スマホ", "コンビニ", "部屋", "確認",
]);

const OBJECT_HINTS = /スマホ|画面|通知|布団|ベッド|枕|枕カバー|コップ|袋|レジ袋|紙袋|箱|カード|財布|鍵|靴|靴下|傘|リップ|ポーチ|鏡|前髪|ランドセル|筆箱|ノート|教科書|プリント|給食|ビスケット|シロップ|チキン|骨|皿|カップ|コーヒー|洗剤|洗濯機|ボタン|ATM|レシート|おにぎり|ケーキ|スイーツ|ロールケーキ|プリン|アイス|駄菓子|アイマスク|フィルム|香水|カバン|タオル|メモ|ペン|ベンチ|椅子|机|冷蔵庫/;
const PLACE_HINTS = /玄関|部屋|店内|売り場|レジ|レジ前|コンビニ|セブン|ニトリ|ケンタッキー|くら寿司|ビックカメラ|ZARA|布団|ベッド|湯船|風呂|台所|キッチン|帰り道|散歩|駅|車内|机|公園|校門|学校|教室|廊下|下校|登校|駄菓子屋|ホテル|ロビー|箱根|旅先/;
const ACTION_HINTS = /開け|閉め|押|触|探|置|入れ|出し|飲|食べ|買|迷|戻|歩|見|隠|伏せ|剥が|かけ|捨て|傾け|塗|漁|拭|待|確認|充電|閉じ|スワイプ|スクロール|洗濯|回し|寝落ち/;
const SOUND_HINTS = /音|カサカサ|カチッ|パチッ|チリン|通知音|水音|足音|クリック|振動|声|雨音|擦れ|ゴロゴロ|パリッ|シュッ/;
const TIME_HINTS = /瞬間|夜|夜中|深夜|朝|昼|時間|最近|昔|今日|明日|昨日/;
const EMOTION_HINTS = /不安|安心|焦|怖|恥|緊張|反省|罪悪感|達成感|悔|嫌|許可|負け|重圧/;

export function classifyHook(hook = "") {
  const text = String(hook || "");
  if (!text) return "unknown";
  if (WEAK_HOOKS.has(text)) return "weak";
  if (OBJECT_HINTS.test(text)) return "object";
  if (PLACE_HINTS.test(text)) return "place";
  if (ACTION_HINTS.test(text)) return "action";
  if (SOUND_HINTS.test(text)) return "sound";
  if (TIME_HINTS.test(text)) return "time";
  if (EMOTION_HINTS.test(text)) return "emotion";
  if (WEAK_HOOKS.has(text)) return "abstract";
  return text.length <= 3 ? "weak" : "topic";
}

export function isWeakTransitionHook(hook = "") {
  const text = String(hook || "");
  const type = classifyHook(text);
  return WEAK_HOOKS.has(text) || ["time", "emotion", "abstract", "weak"].includes(type);
}

export function isStrongTransitionHook(hook = "") {
  return ["object", "place", "action", "sound"].includes(classifyHook(hook));
}

export function filterStrongHooks(hooks = [], limit = 6) {
  return unique(hooks).filter(isStrongTransitionHook).slice(0, limit);
}

export function filterWeakHooks(hooks = [], limit = 6) {
  return unique(hooks).filter(isWeakTransitionHook).slice(0, limit);
}

export function hookTypeScore(hook = "") {
  switch (classifyHook(hook)) {
    case "object": return 5;
    case "place": return 4;
    case "action": return 4;
    case "sound": return 3;
    case "topic": return 2;
    case "time": return 0.5;
    case "emotion": return 0.5;
    default: return 0;
  }
}

export function buildHookGroups(hooks = []) {
  const groups = { objects: [], places: [], actions: [], sounds: [], weak: [] };
  for (const hook of unique(hooks)) {
    const type = classifyHook(hook);
    if (type === "object") groups.objects.push(hook);
    else if (type === "place") groups.places.push(hook);
    else if (type === "action") groups.actions.push(hook);
    else if (type === "sound") groups.sounds.push(hook);
    else if (isWeakTransitionHook(hook)) groups.weak.push(hook);
  }
  return groups;
}

function unique(values) {
  return [...new Set((values || []).map(v => String(v || "").trim()).filter(Boolean))];
}
