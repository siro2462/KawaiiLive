import { ANGLE_SLOTS } from "./constants.mjs";
import { judgeTransition, extractTransitionHooks } from "./transition.mjs";
import { buildHookGroups, filterStrongHooks, filterWeakHooks } from "./hooks.mjs";

export function pickMemoryCandidates({
  allMemories,
  usedMemoryIds,
  usedMemoryHooks = new Map(),
  usedMemoryAngleSlots = new Map(),
  recentBridgeHooks = [],
  recentTransitionTypes = [],
  recentText,
  currentMemory = null,
  currentMemoryBlocks = 0,
  maxBlocksPerMemory = 2,
  limit = 10,
}) {
  const currentCandidate =
    currentMemory && currentMemoryBlocks < maxBlocksPerMemory
      ? {
          memory: currentMemory,
          transition: {
            verdict: "ACCEPT",
            type: "NONE",
            keyword: "",
            reason: "Continue current memory with concrete detail.",
            previousHooks: extractTransitionHooks(recentText || ""),
            nextHooks: extractTransitionHooks(memoryText(currentMemory)),
          },
          score: deepDiveBoost(currentMemoryBlocks, getUsedAngleSlots(currentMemory, usedMemoryAngleSlots)),
          candidateKind: "CURRENT_DEEP_DIVE",
          currentMemoryBlocks,
          usedHooks: getUsedHooks(currentMemory, usedMemoryHooks),
          usedAngleSlots: getUsedAngleSlots(currentMemory, usedMemoryAngleSlots),
        }
      : null;

  const scored = allMemories
    .filter(memory => !currentCandidate || String(memory.id) !== String(currentCandidate.memory.id))
    .filter(memory => !usedMemoryIds.has(memory.id))
    .map(memory => {
      const transition = recentText
        ? judgeTransition({ previousText: recentText, nextMemory: memory })
        : null;

      let score = Math.random() * 1.5;

      if (!transition) score += 2;
      else if (transition.verdict === "REJECT") score -= 10;
      else if (transition.type === "DIRECT") score += 5;
      else if (transition.type === "CONTRAST") score += 4;
      else if (transition.type === "SCENE") score += 4;
      else if (transition.type === "RESET") score += 2;
      score -= bridgeHookPenalty(transition, recentBridgeHooks);
      score -= resetRunPenalty(transition, recentTransitionTypes);

      return {
        memory,
        transition,
        score,
        candidateKind: "MIXED",
        usedHooks: getUsedHooks(memory, usedMemoryHooks),
        usedAngleSlots: getUsedAngleSlots(memory, usedMemoryAngleSlots),
      };
    })
    .sort((a, b) => b.score - a.score);

  const accepted = scored.filter(c => c.transition?.verdict !== "REJECT");
  const pool = accepted.length ? accepted : scored.map(c => ({
    ...c,
    transition: {
      ...c.transition,
      verdict: "ACCEPT",
      type: "RESET",
      keyword: "",
      reason: "Fallback reset candidate.",
      previousHooks: c.transition?.previousHooks || [],
      nextHooks: c.transition?.nextHooks || [],
    },
  }));

  return pickMixedCandidates(pool, currentCandidate, limit);
}

function deepDiveBoost(currentMemoryBlocks, usedAngleSlots) {
  const allSlots = Object.values(ANGLE_SLOTS);
  const unusedCount = allSlots.filter(s => !usedAngleSlots.includes(s)).length;
  if (currentMemoryBlocks === 1 && unusedCount > 0) return 8 + 5;
  if (currentMemoryBlocks === 0) return 8;
  return 6;
}

function pickMixedCandidates(scored, currentCandidate, limit) {
  const direct = scored.filter(c => c.transition?.type === "DIRECT");
  const scene = scored.filter(c =>
    ["SCENE", "CONTRAST"].includes(c.transition?.type)
  );
  const reset = scored.filter(c => c.transition?.type === "RESET");

  return uniqueByMemoryId([
    currentCandidate,
    ...shuffle(direct).slice(0, 2),
    ...shuffle(scene).slice(0, 3),
    ...shuffle(reset).slice(0, 2),
    ...shuffle(scored).slice(0, 2),
  ]).slice(0, limit);
}

function getUsedHooks(memory, usedMemoryHooks) {
  return usedMemoryHooks.get(String(memory?.id || "")) || [];
}

function getUsedAngleSlots(memory, usedMemoryAngleSlots) {
  return usedMemoryAngleSlots.get(String(memory?.id || "")) || [];
}

const GENERIC_BRIDGE_HOOKS = new Set([
  "冷蔵庫",
  "スマホ",
  "部屋",
  "コンビニ",
  "レジ",
  "画面",
  "ドア",
  "机",
  "台所",
  "キッチン",
  "棚",
  "店内",
  "袋",
  "箱",
  "冷気",
  "光",
]);

function resetRunPenalty(transition, recentTransitionTypes = []) {
  const last2 = recentTransitionTypes.slice(-2);
  const resetRun = last2.length === 2 && last2.every(t => t === "RESET" || t === "RESET_TRANSITION");
  if (!resetRun) return 0;
  if (transition?.type === "RESET") return 4;
  if (["DIRECT", "SCENE", "CONTRAST"].includes(transition?.type)) return -2;
  return 0;
}

function bridgeHookPenalty(transition, recentBridgeHooks = []) {
  if (!transition || transition.verdict === "REJECT") return 0;
  const recent = new Set((recentBridgeHooks || []).map(normalizeBridgeHook).filter(Boolean));
  const hooks = [
    transition.keyword,
    ...(transition.previousStrongHooks || []),
    ...(transition.nextStrongHooks || []),
  ].map(normalizeBridgeHook).filter(Boolean);

  let penalty = 0;
  for (const hook of hooks) {
    if (recent.has(hook)) penalty += 2;
    if (GENERIC_BRIDGE_HOOKS.has(hook)) penalty += 1;
  }
  return penalty;
}

function normalizeBridgeHook(value) {
  const text = String(value || "").trim();
  if (!text || text === "none") return "";
  for (const hook of GENERIC_BRIDGE_HOOKS) {
    if (text.includes(hook)) return hook;
  }
  return text.slice(0, 16);
}

function uniqueByMemoryId(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates.filter(Boolean)) {
    const id = String(candidate.memory?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(candidate);
  }
  return out;
}

function shuffle(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

export function buildMemoryTopicWords(memory, { recentText = "", maxTerms = 6 } = {}) {
  const recent = new Set(extractTransitionHooks(recentText || ""));
  return extractTransitionHooks(memoryText(memory))
    .filter(word => !recent.has(word))
    .filter(word => !/[A-Za-z]/.test(String(word || "")))
    .filter(word => !isAvoidAbstract(word))
    .filter(uniqueFilter())
    .slice(0, maxTerms);
}

export function buildMemoryCard(memory, { recentText = "", maxTerms = 8 } = {}) {
  const topicWords = buildMemoryTopicWords(memory, { recentText, maxTerms });
  const summary = buildCandidateHookSummary(memory, { maxHooks: 6 });
  const eventAnchors = buildEventAnchors(memory, { maxAnchors: 4 });
  const recurringPeople = extractPeople(memoryText(memory)).slice(0, 4);
  return [
    `source: ${memoryText(memory).slice(0, 90)}`,
    `topic_words: ${topicWords.join(", ") || "none"}`,
    `entry_hooks: ${summary.entryHooks.join(", ") || "none"}`,
    `event_anchors: ${eventAnchors.join(" / ") || "none"}`,
    `recurring_people: ${recurringPeople.join(", ") || "none"}`,
    `strong_hooks: ${summary.strongHooks.join(", ") || "none"}`,
    `weak_hooks: ${summary.weakHooks.join(", ") || "none"}`,
    `avoid_abstract: 感覚, 繋がり, リアル, 不思議, 落ち着ける, 許されたい, 挫折感, 罪悪感`,
  ].join("\n");
}

export function buildCandidateHookSummary(memory, { maxHooks = 5 } = {}) {
  const keywordText = parseKeywords(memory).join(" ");
  const hooks = extractTransitionHooks([keywordText, memoryText(memory)].filter(Boolean).join(" "));
  const groups = buildHookGroups(hooks);
  const strongHooks = filterStrongHooks(hooks, maxHooks);
  const entryHooks = [
    ...groups.objects,
    ...groups.places,
    ...groups.actions,
    ...groups.sounds,
    ...strongHooks,
  ].filter(uniqueFilter()).slice(0, maxHooks);
  return {
    entryHooks,
    strongHooks,
    weakHooks: filterWeakHooks(hooks, maxHooks),
    objects: groups.objects.slice(0, maxHooks),
    places: groups.places.slice(0, maxHooks),
    actions: groups.actions.slice(0, maxHooks),
    sounds: groups.sounds.slice(0, maxHooks),
  };
}

export function buildEventAnchors(memory, { maxAnchors = 4 } = {}) {
  const text = memoryText(memory);
  const hooks = buildCandidateHookSummary(memory, { maxHooks: 8 }).entryHooks;
  const sentences = text
    .split(/[。！？!?]/)
    .map(s => s.trim())
    .filter(Boolean);

  const anchors = [];
  for (const hook of hooks) {
    const sentence = sentences.find(s => s.includes(hook));
    if (!sentence) continue;
    const event = compactEvent(sentence, hook);
    if (event) anchors.push(event);
  }

  if (!anchors.length) {
    for (const sentence of sentences.slice(0, 4)) {
      const hook = hooks.find(h => sentence.includes(h)) || extractTransitionHooks(sentence)[0] || "";
      const event = compactEvent(sentence, hook);
      if (event) anchors.push(event);
    }
  }

  return anchors
    .filter(anchor => anchor && !hasBadAnchorWord(anchor))
    .filter(uniqueFilter())
    .slice(0, maxAnchors);
}

function compactEvent(sentence, hook) {
  const full = String(sentence || "")
    .replace(/[「」『』]/g, "")
    .replace(/[\/｜]/g, "、")
    .replace(/\s+/g, "");
  if (hasBadAnchorWord(full)) return "";
  const start = hook && full.includes(hook) ? full.indexOf(hook) : 0;
  const text = full.slice(start, start + 44);
  if (!text) return "";
  const people = extractPeople(text).length ? extractPeople(text) : extractPeople(full);
  const person = people[0] || "";
  const action = extractAction(text);
  const object = normalizeAnchorPart(
    !isPersonWord(hook)
      ? hook
      : extractTransitionHooks(text).find(word => !isPersonWord(word) && !hasBadAnchorWord(word)) || ""
  );
  if (!object) return "";
  if (person && action) return `${object}+${joinPersonAction(person, action)}`;
  if (action) return `${object}+${action}`;
  if (person) return `${object}+${person}が見てた`;
  return "";
}

function extractPeople(text) {
  const found = String(text || "").match(/友達|店員さん|先生|顧問|親|家族|お兄さん|お姉さん|おじさん|同僚|コメント|昔の自分/g) || [];
  return found.filter(uniqueFilter());
}

function joinPersonAction(person, action) {
  const act = String(action || "");
  if (/^(が|に|と)/.test(act)) return `${person}${act}`;
  return `${person}が${act}`;
}

function isPersonWord(value) {
  return /^(友達|店員さん|先生|顧問|親|家族|お兄さん|お姉さん|おじさん|同僚|コメント|昔の自分)$/.test(String(value || ""));
}

function extractAction(text) {
  const value = String(text || "");
  const patterns = [
    /(に聞かれた|に言われた|が笑った|が見てた|が黙った|が撮った|が撮ってた|が渡した|が持ってきた|が呼んだ|が止まった|がうなずいた|が首をかしげた|が困ってた|が小声で言った|と話した|と分けた|を渡した|を買った|を忘れた|を撮った|を撮ってた|を見返した|を触った|を持った|を開けた|を落とした|に並んだ|で迷った|で走った|で爆笑した)/,
    /(聞かれた|言われた|笑った|見てた|黙った|撮った|撮ってた|渡した|持ってきた|呼んだ|止まった|うなずいた|困ってた|小声で言った|話した|分けた|買った|忘れた|見返した|触った|持った|開けた|落とした|並んだ|迷った|走った|爆笑した)/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[0].slice(0, 16);
  }
  return "";
}

function normalizeAnchorPart(value) {
  const text = String(value || "").replace(/[+：:、。]/g, "").trim();
  if (!text || hasBadAnchorWord(text)) return "";
  return text.slice(0, 12);
}

function hasBadAnchorWord(value) {
  return /判断力|感覚|空気感|吸引力|現実感|焦燥感|矛盾感|印象|役割|構造|心理|認知|物理|精神|視覚|不思議|特別な時間|凄まじい|儀式|本気|結局自分|自分|大人|全部特別|危ない|無限/.test(String(value || ""));
}

function uniqueFilter() {
  const seen = new Set();
  return (value) => {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function isAvoidAbstract(word) {
  return /感覚|繋がり|リアル|不思議|落ち着け|許されたい|挫折感?|罪悪感|感じ/.test(String(word || ""));
}

export function getMainKeyword(memory) {
  try {
    const parsed = JSON.parse(memory.keywords || "[]");
    return Array.isArray(parsed) ? parsed[0] || "" : "";
  } catch {
    return String(memory.keywords || "").split(",")[0] || "";
  }
}

function memoryText(memory) {
  return String(memory?.episode || "");
}

function parseKeywords(memory) {
  try {
    const parsed = JSON.parse(memory?.keywords || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(memory?.keywords || "").split(",").map(s => s.trim()).filter(Boolean);
  }
}
