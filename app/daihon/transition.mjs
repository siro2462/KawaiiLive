import { filterStrongHooks, filterWeakHooks, hookTypeScore, isStrongTransitionHook } from "./hooks.mjs";

const CONTENT_STOP_WORDS = new Set([
  "こと", "もの", "感じ", "自分", "今日", "本当", "少し", "かなり",
  "なんか", "ところ", "ため", "それ", "これ", "あれ", "独り言",
  "生活", "感情", "具体", "方向", "場面", "文体", "特徴",
]);

const GENERIC_HOOKS = new Set([
  "スマホ", "コンビニ", "部屋", "料理", "アイス",
  "動画", "買い物", "帰宅", "深夜", "夜中", "友達",
  "時間", "最近", "結局", "普通", "一人", "仕事",
  "瞬間", "不安", "安心", "気持ち", "生活感", "達成感", "店員", "母親",
]);

const TOPIC_WORDS = /薬|健康|体調|体重|運動|食べ|飲み物|甘い|冷蔵庫|お菓子|アイス|買い物|レジ|レシート|店|ロフト|商品|コンビニ|文房具|深夜|夜|夜中|スマホ|動画|昔|アニメ|曲|懐かしい|料理|掃除|旅行|電車|駅|病院|学校|友達|天気|雨|散歩|部屋|帰宅|朝|ペット|引っ越し/;

const CATEGORY_MAP = [
  { pattern: /食べ|飲み物|甘い|冷蔵庫|お菓子|アイス|料理|コンビニ/, label: "食べ物" },
  { pattern: /買い物|レジ|レシート|店|ロフト|商品|コンビニ|文房具/, label: "買い物" },
  { pattern: /薬|健康|体調|体重|運動|病院/, label: "健康" },
  { pattern: /深夜|夜|夜中|スマホ|動画|寝/, label: "夜の時間" },
  { pattern: /昔|アニメ|曲|懐かしい|学校|友達/, label: "懐かしい話" },
  { pattern: /旅行|電車|駅|散歩|外出/, label: "外出" },
  { pattern: /部屋|帰宅|掃除|引っ越し/, label: "家の話" },
];

const WEAK_CATEGORY_LABELS = new Set([
  "夜の時間",
  "食べ物",
  "買い物",
  "家の話",
  "懐かしい話",
  "外出",
  "健康",
]);

export function extractContentWords(text = "") {
  return [...new Set(
    String(text).match(/[一-龥ァ-ヶー]{2,}/g) || []
  )].filter(w => !CONTENT_STOP_WORDS.has(w) && w.length <= 10);
}

export function extractTransitionHooks(text = "") {
  const words = extractContentWords(text);
  const important = words.filter(w => TOPIC_WORDS.test(w));
  return [...new Set([...important, ...words])].slice(0, 8);
}

export function parseKeywordsArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value || "").split(",").map(s => s.trim()).filter(Boolean);
  }
}

function detectSharedCategory(prevHooks, nextHooks) {
  const prevText = prevHooks.join(" ");
  const nextText = nextHooks.join(" ");
  for (const { pattern, label } of CATEGORY_MAP) {
    if (pattern.test(prevText) && pattern.test(nextText)) return label;
  }
  return null;
}

export function judgeTransition({ previousText, nextMemory }) {
  const previousHooks = extractTransitionHooks(previousText);
  const kw = parseKeywordsArray(nextMemory.keywords);
  const nextHooks = extractTransitionHooks(
    [...kw, nextMemory.episode || ""].join(" ")
  );

  const sharedHooks = previousHooks.filter(h => nextHooks.includes(h));
  const strongSharedHooks = sharedHooks
    .filter(h => !GENERIC_HOOKS.has(h))
    .filter(isStrongTransitionHook)
    .sort((a, b) => hookTypeScore(b) - hookTypeScore(a));
  const specificHooks = sharedHooks.filter(h => !GENERIC_HOOKS.has(h));
  const genericHooks = sharedHooks.filter(h => GENERIC_HOOKS.has(h));

  if (strongSharedHooks.length >= 1) {
    return {
      verdict: "ACCEPT",
      type: "DIRECT",
      keyword: strongSharedHooks[0],
      previousHooks,
      nextHooks,
      previousStrongHooks: filterStrongHooks(previousHooks),
      nextStrongHooks: filterStrongHooks(nextHooks),
      weakHooks: filterWeakHooks(sharedHooks),
      reason: `前の具体的な取っかかり「${strongSharedHooks[0]}」から次へ移る`,
    };
  }
  if (specificHooks.length >= 2 && filterStrongHooks(specificHooks).length >= 1) {
    const strong = filterStrongHooks(specificHooks)[0];
    return {
      verdict: "ACCEPT",
      type: "SCENE",
      keyword: strong,
      previousHooks,
      nextHooks,
      previousStrongHooks: filterStrongHooks(previousHooks),
      nextStrongHooks: filterStrongHooks(nextHooks),
      weakHooks: filterWeakHooks(sharedHooks),
      reason: `具体物・場所・動作を含む近い場面「${strong}」から移る`,
    };
  }
  if (genericHooks.length >= 2 && filterStrongHooks(sharedHooks).length >= 2) {
    return {
      verdict: "ACCEPT",
      type: "RESET",
      keyword: "",
      previousHooks,
      nextHooks,
      previousStrongHooks: filterStrongHooks(previousHooks),
      nextStrongHooks: filterStrongHooks(nextHooks),
      weakHooks: filterWeakHooks(sharedHooks),
      reason: "共通語が広すぎるので話題変更として扱う",
    };
  }

  const category = detectSharedCategory(previousHooks, nextHooks);
  const previousStrongHooks = filterStrongHooks(previousHooks);
  const nextStrongHooks = filterStrongHooks(nextHooks);
  if (category && previousStrongHooks.length && nextStrongHooks.length) {
    if (WEAK_CATEGORY_LABELS.has(category)) {
      return {
        verdict: "ACCEPT",
        type: "RESET",
        keyword: "",
        previousHooks,
        nextHooks,
        previousStrongHooks,
        nextStrongHooks,
        weakHooks: filterWeakHooks(sharedHooks),
        reason: `${category}だけでは広すぎるので、無理につなげず話題変更として扱う`,
      };
    }
    return {
      verdict: "ACCEPT",
      type: "SCENE",
      keyword: `${previousStrongHooks[0]}→${nextStrongHooks[0]}`,
      previousHooks,
      nextHooks,
      previousStrongHooks,
      nextStrongHooks,
      weakHooks: filterWeakHooks(sharedHooks),
      reason: `具体物「${previousStrongHooks[0]}」から「${nextStrongHooks[0]}」へ場面で移る`,
    };
  }

  const prevText = previousHooks.join(" ");
  const nextText = nextHooks.join(" ") + " " + (nextMemory.episode || "");

  if (/薬|体調|健康|体重|運動|食べ/.test(prevText) && /飲み物|甘い|冷蔵庫|食べ|お菓子|アイス/.test(nextText)) {
    return { verdict: "ACCEPT", type: "CONTRAST", keyword: "健康と食べ物", previousHooks, nextHooks, previousStrongHooks: filterStrongHooks(previousHooks), nextStrongHooks: filterStrongHooks(nextHooks), reason: "健康を気にしている流れから食べ物の話へ" };
  }
  if (/深夜|夜|夜中|スマホ|動画|お菓子/.test(prevText) && /昔|アニメ|曲|動画|懐かしい/.test(nextText)) {
    return { verdict: "ACCEPT", type: "RESET", keyword: "", previousHooks, nextHooks, previousStrongHooks: filterStrongHooks(previousHooks), nextStrongHooks: filterStrongHooks(nextHooks), reason: "夜や動画だけでは広すぎるので話題変更として扱う" };
  }

  const prevWords = new Set(extractContentWords(prevText));
  const nextWords = extractContentWords(nextText);
  const weakOverlap = nextWords.filter(w => prevWords.has(w)).length;
  if (weakOverlap >= 1) {
    return {
      verdict: "ACCEPT",
      type: "RESET",
      keyword: "",
      previousHooks,
      nextHooks,
      reason: "接続が薄いので話題変更を明示して移る",
    };
  }

  if (previousHooks.length <= 2 && nextHooks.length <= 2) {
    return {
      verdict: "ACCEPT",
      type: "RESET",
      keyword: "",
      previousHooks,
      nextHooks,
      reason: "情報が少ないのでRESETで移る",
    };
  }

  return {
    verdict: "REJECT",
    type: "REJECT",
    keyword: "",
    previousHooks,
    nextHooks,
    reason: "脈絡が弱すぎるため候補から外す",
  };
}
