import { TALK_MOVES, MAX_BLOCKS_PER_MEMORY, PLAN_SIZE, ANGLE_SLOTS, SPONTANEOUS_MOVES } from "./constants.mjs";
import { buildCandidateHookSummary, buildEventAnchors, buildMemoryTopicWords } from "./planner.mjs";

export async function planNextBlocks({
  callLlm,
  streamState,
  recentBlocks,
  recentHooks,
  memoryCandidates,
  remainingBlocks,
}) {
  const prompt = buildPlannerPrompt({
    streamState,
    recentBlocks,
    memoryCandidates,
    remainingBlocks,
  });

  const raw = await callLlm({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.35,
    topP: 0.8,
    repeatPenalty: 1.05,
    maxTokens: 900,
    timeoutMs: 90000,
  });

  let parseOk = false;
  let parseError = "";
  try {
    const testMatch = String(raw).match(/\{[\s\S]*\}/);
    const testParsed = JSON.parse(testMatch?.[0] || "{}");
    parseOk = Array.isArray(testParsed.blocks) && testParsed.blocks.length > 0;
    if (!parseOk) parseError = "no blocks array in parsed JSON";
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e);
  }

  return {
    plan: normalizePlan(raw, { memoryCandidates, remainingBlocks, recentTransitionTypes: streamState.recentTransitionTypes }),
    prompt,
    raw,
    parseOk,
    parseError,
  };
}

function buildPlannerPrompt({
  streamState,
  recentBlocks,
  memoryCandidates,
  remainingBlocks,
}) {
  const usedIds = [...streamState.usedMemoryIds].join(", ") || "none";
  const candidateLines = memoryCandidates.slice(0, 10).map(c => {
    const topicWords = buildMemoryTopicWords(c.memory, { maxTerms: 4 }).join(", ");
    const hooks = buildCandidateHookSummary(c.memory, { maxHooks: 5 });
    const eventAnchors = buildEventAnchors(c.memory, { maxAnchors: 3 }).join(" / ");
    const type = c.transition?.type || "NONE";
    const keyword = c.transition?.keyword || "";
    const prevStrong = c.transition?.previousStrongHooks?.slice(0, 4).join(", ") || "";
    const nextStrong = c.transition?.nextStrongHooks?.slice(0, 4).join(", ") || hooks.strongHooks.slice(0, 4).join(", ");
    const usedHooks = (c.usedHooks || []).slice(-10).join(", ") || "none";
    const usedAngles = (c.usedAngleSlots || []).join(", ") || "none";
    const stay = c.candidateKind === "CURRENT_DEEP_DIVE" ? ` current_blocks=${c.currentMemoryBlocks || 0}` : "";
    return [
      `id=${c.memory.id} type=${type} keyword=${keyword}${stay}`,
      `topic_words=[${topicWords}]`,
      `entry_hooks=[${hooks.entryHooks.join(", ")}]`,
      `event_anchors=[${eventAnchors}]`,
      `prev_strong=[${prevStrong}]`,
      `next_strong=[${nextStrong}]`,
      `used_hooks=[${usedHooks}]`,
      `used_angle_slots=[${usedAngles}]`,
      `weak_hooks=[${hooks.weakHooks.join(", ")}]`,
    ].join(" ");
  });

  const recentBlocksStr = (recentBlocks || []).length
    ? recentBlocks.map((block, i) => `block${i + 1}: ${String(block).slice(-200)}`).join("\n")
    : "none";
  const currentCandidate = memoryCandidates.find(c => c.candidateKind === "CURRENT_DEEP_DIVE");

  const moveList = Object.keys(TALK_MOVES).join(" / ");

  return [
    "/no_think",
    "You are the flow planner for a Japanese AI VTuber monologue.",
    "Do not write the actual script. Output only compact JSON.",
    "",
    "Goal:",
    "Decide what to talk about, which move to use, and from which angle.",
    "",
    "Rules:",
    "- type is one of: DEEP_DIVE, SOFT_TRANSITION, RESET_TRANSITION, TOPIC_ENTRY, ENDING.",
    `- move is one of: ${moveList}.`,
    "- can_stay=true means staying is allowed, not required.",
    "- If a SCENE, CONTRAST, or RESET candidate has a better concrete bridge than the current memory, choose the transition instead of staying.",
    "- If staying on the same memory, use a different angle than before.",
    "- If staying on the same memory, choose an unused angle_slot.",
    "- angle_slot is one of: OBJECT_DETAIL, PERSON_REACTION, PLACE_SHIFT, BODY_FEEL, AFTER_SCENE, CURRENT_SELF, MICRO_CONFLICT, UNNECESSARY_DETAIL, SELF_TSUKKOMI, CURRENT_COMPARISON.",
    "- MICRO_CONFLICT: small contradiction or discomfort. 買ったのに食べない, レシートいらないのに見ちゃう.",
    "- UNNECESSARY_DETAIL: pointless detail worth lingering on. 袋の折り方, 冷蔵庫のドアの音.",
    "- SELF_TSUKKOMI: self-roast or self-doubt about one's own behavior.",
    "- CURRENT_COMPARISON: compare then-self vs now-self in a small concrete way.",
    "- Deep dive does not mean explaining the same object again. It means moving the camera to a different angle.",
    "- If used_hooks exists, do not make those hooks the main object again.",
    "- For the second block of the same memory, prefer PERSON_REACTION, PLACE_SHIFT, AFTER_SCENE, BODY_FEEL, or CURRENT_SELF.",
    "- Avoid OBJECT_DETAIL for the second block of the same memory unless there is no other usable angle.",
    "- depolish is one of: none, live_reaction, self_repair, unfinished_edge, comment_ping.",
    "- Use depolish when the block may land too neatly. Prefer one small interruption, not a big joke.",
    "- handoff_hook is one concrete word from the previous topic. Leave empty if not needed.",
    "- handoff_action is a short action phrase from the previous block end. e.g. 中身を確認して安心する, 袋をぶら下げて歩く. Not a noun.",
    "- handoff_feeling is a short feeling from the previous block end. e.g. ひやっとして意識が向く, 少し気まずくなる. Not a noun.",
    "- next_entry_hint is a short Japanese phrase (under 30 chars) hinting how this block starts from the action/feeling. Not from a noun.",
    "- Good next_entry_hint: 中身あるか確認して安心する感じで思い出した / 荷物持って歩きづらい感じから.",
    "- Bad next_entry_hint: 冷蔵庫の話から / コンビニの話から / 部屋の話から.",
    "- handoff_mode is one of: continue, detail_shift, soft_drift, callback, research_turn, reset.",
    "  continue=same flow, keep talking. detail_shift=same topic, shift camera. soft_drift=slow slide to next. callback=return to earlier topic. research_turn=enter research segment. reset=clean break.",
    "- Pick exactly one entry_hook for each non-ending block. Prefer a short event anchor: concrete object + person + action. Avoid a single bare noun.",
    "- entry_hook must be short, usually under 24 Japanese chars. Do not copy long event_anchors verbatim.",
    "- Never put abstract words in entry_hook: 判断力, 感覚, 空気感, 吸引力, 現実感, 印象, 役割, 構造.",
    "- Good entry_hook examples: レジ袋を店員さんに渡された, 鹿せんべいを友達が動画に撮った, 部屋着で音声会議に出た.",
    "- If a person appears in the chosen event, keep that person around for more than one beat instead of dropping them after one sentence.",
    "- For DIRECT, SCENE, CONTRAST, or SOFT_TRANSITION candidates, output from_hook, to_hook, and bridge_hint.",
    "- For SOFT_TRANSITION, SCENE, or CONTRAST candidates, output from_event and to_event.",
    "- from_event and to_event must be small visible events, not categories.",
    "- Bad bridge: 懐かしい話から外出の話へ. Good bridge: 公園のベンチに座った -> 旅先のロビーの椅子に座った.",
    "- from_hook and to_hook must be concrete objects, places, actions, or sounds, not broad words like 瞬間, 不安, 夜, 時間, 気持ち, 画面, レジ, 店内, スマホ, コンビニ.",
    "- bridge_hint is private planning context. Keep it short. The script writer must not explain it directly.",
    "- Do not write prose in angle. Keep it short and specific.",
    "- SOFT_TRANSITION を積極的に使う。前の話の具体物や動作から次の話へ自然に滑る。",
    "- RESET_TRANSITION は最終手段。前の話との接点が本当にゼロの時だけ使う。3ブロックに1回以下に抑える。",
    "- 話題が変わっても、前の話の物・場所・動作を1つ拾ってから次に入る。完全な切り替えはしない。",
    "- Broad keywords like 夜の時間, 食べ物, 買い物 are never strong enough to bridge. Use concrete objects or actions.",
    `- Same memory can be used up to ${MAX_BLOCKS_PER_MEMORY} blocks.`,
    "- If the current memory has only 1 block so far and unused angle_slots remain, the NEXT block should usually be DEEP_DIVE on the same memory.",
    "- Target: 40-55% of body blocks should be DEEP_DIVE. Do not plan 3 consecutive new-topic blocks.",
    `- spontaneous_move is one of: ${SPONTANEOUS_MOVES.join(", ")}. Pick one for DEEP_DIVE blocks ~60% of the time, other blocks ~30%.`,
    "- Output angle and handoff fields in Japanese only. Never output English words in these fields.",
    "",
    `state: section=body remaining_blocks=${remainingBlocks} used_memory_ids=[${usedIds}]`,
    `recent_blocks:\n${recentBlocksStr}`,
    currentCandidate ? `current_topic_state: memory_id=${currentCandidate.memory.id} blocks=${currentCandidate.currentMemoryBlocks || 0} can_stay=true stay_only_if_unused_angle_exists=true` : "current_topic_state: none",
    "",
    "memory candidates:",
    ...candidateLines,
    "",
    "Output JSON only:",
    '{"blocks":[{"i":1,"type":"SOFT_TRANSITION","move":"SOFT_DRIFT","memory_id":"123","chars":650,"entry_hook":"旅先のロビーの椅子","angle_slot":"PLACE_SHIFT","depolish":"self_repair","angle":"座る場所の記憶へずらす","handoff_hook":"ベンチ","handoff_action":"座って荷物を横に置く","handoff_feeling":"座った瞬間ほっとする","next_entry_hint":"座って一息つく感じから旅先を思い出す","handoff_mode":"soft_drift","spontaneous_move":"sudden_memory","from_hook":"公園のベンチ","to_hook":"ロビーの椅子","from_event":"公園のベンチに座った","to_event":"旅先のロビーの椅子に座った","bridge_hint":"座る場所の記憶から移る"}]}',
  ].join("\n");
}

function normalizePlan(raw, { memoryCandidates, remainingBlocks, recentTransitionTypes = [] }) {
  let parsed;
  try {
    const match = String(raw).match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match?.[0] || "{}");
  } catch {
    parsed = {};
  }

  const candidateMap = new Map(memoryCandidates.map(c => [String(c.memory.id), c]));
  const validTypes = ["DEEP_DIVE", "SOFT_TRANSITION", "RESET_TRANSITION", "TOPIC_ENTRY", "ENDING"];
  const rawBlocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
  const maxBlocks = Math.min(PLAN_SIZE, remainingBlocks);

  const blocks = [];
  for (let idx = 0; idx < Math.min(rawBlocks.length, maxBlocks); idx++) {
    const b = rawBlocks[idx];
    let promptType = b?.type || b?.prompt_type || "DEEP_DIVE";
    if (!validTypes.includes(promptType)) promptType = "DEEP_DIVE";

    let memoryId = b?.memory_id ? String(b.memory_id) : null;
    if (memoryId && !candidateMap.has(memoryId)) memoryId = null;
    if (!memoryId && promptType !== "ENDING") {
      memoryId = memoryCandidates[idx]?.memory?.id
        ? String(memoryCandidates[idx].memory.id)
        : memoryCandidates[0]?.memory?.id
          ? String(memoryCandidates[0].memory.id)
          : null;
    }

    let move = validMove(b?.move);
    const bridge = fallbackBridgeParts(memoryId, promptType, candidateMap);
    let fromEvent = sanitizeJapaneseField(b?.from_event || b?.fromEvent || "", 40);
    let toEvent = sanitizeJapaneseField(b?.to_event || b?.toEvent || "", 40);

    if (promptType === "SOFT_TRANSITION" && (!fromEvent || !toEvent)) {
      if (bridge.fromHook && bridge.toHook) {
        fromEvent = fromEvent || sanitizeJapaneseField(`${bridge.fromHook}に触れた`, 40);
        toEvent = toEvent || sanitizeJapaneseField(`${bridge.toHook}が目に入った`, 40);
      } else {
        promptType = "TOPIC_ENTRY";
        move = "SOFT_DRIFT";
      }
    }

    // RESET連続防止: plan内 or plan境界で直前もRESETなら降格
    const prevType = blocks.length
      ? blocks[blocks.length - 1].prompt_type
      : (recentTransitionTypes || []).slice(-1)[0] || "";
    if (promptType === "RESET_TRANSITION" && (prevType === "RESET_TRANSITION" || prevType === "RESET")) {
      promptType = "TOPIC_ENTRY";
      move = "SOFT_DRIFT";
    }

    blocks.push({
      index: b?.i || idx + 1,
      prompt_type: promptType,
      move,
      memory_id: memoryId,
      target_chars: clamp(Number(b?.chars ?? 500), 400, 600),
      entry_hook: sanitizeJapaneseField(b?.entry_hook || b?.entryHook || fallbackEntryHook(memoryId, candidateMap), 28),
      angle_slot: freshAngleSlot(memoryId, b?.angle_slot || b?.angleSlot, candidateMap),
      depolish: validDepolish(b?.depolish || b?.depolish_mode || b?.depolishMode),
      angle: sanitizeJapaneseField(b?.angle || "", 60),
      handoff_hook: sanitizeJapaneseField(b?.handoff_hook || b?.handoffHook || b?.handoff || "", 12),
      handoff_action: sanitizeJapaneseField(b?.handoff_action || b?.handoffAction || "", 40),
      handoff_feeling: sanitizeJapaneseField(b?.handoff_feeling || b?.handoffFeeling || "", 40),
      next_entry_hint: sanitizeJapaneseField(b?.next_entry_hint || b?.nextEntryHint || "", 40),
      handoff_mode: alignHandoffMode(promptType, validHandoffMode(b?.handoff_mode || b?.handoffMode)),
      spontaneous_move: validSpontaneousMove(b?.spontaneous_move || b?.spontaneousMove),
      from_hook: sanitizeJapaneseField(b?.from_hook || b?.fromHook || bridge.fromHook, 24),
      to_hook: sanitizeJapaneseField(b?.to_hook || b?.toHook || bridge.toHook, 24),
      from_event: fromEvent,
      to_event: toEvent,
      bridge_hint: sanitizeJapaneseField(b?.bridge_hint || b?.bridgeHint || bridge.bridgeHint, 50),
    });
  }

  if (!blocks.length) {
    for (let i = 0; i < Math.min(PLAN_SIZE, maxBlocks); i++) {
      const cand = memoryCandidates[i];
      if (!cand) break;
      blocks.push({
        index: i + 1,
        prompt_type: i === 0 && cand.candidateKind === "CURRENT_DEEP_DIVE" ? "DEEP_DIVE" : "TOPIC_ENTRY",
        move: i === 0 ? "ANGLE_SHIFT" : "ASSOCIATE",
        memory_id: String(cand.memory.id),
        target_chars: 500,
        entry_hook: fallbackEntryHook(String(cand.memory.id), candidateMap),
        angle_slot: freshAngleSlot(String(cand.memory.id), "", candidateMap),
        depolish: "none",
        angle: "",
        handoff_hook: "",
        handoff_action: "",
        handoff_feeling: "",
        next_entry_hint: "",
        handoff_mode: i === 0 ? "continue" : "detail_shift",
        spontaneous_move: "",
        from_hook: "",
        to_hook: "",
        from_event: "",
        to_event: "",
        bridge_hint: "",
      });
    }
  }

  return {
    plan_note: String(parsed.plan_note || parsed.plan_reason || "").slice(0, 80),
    blocks,
  };
}

function validMove(value) {
  const move = String(value || "").toUpperCase();
  if (move in TALK_MOVES) return move;
  return "ASSOCIATE";
}

const VALID_ANGLE_SLOTS = Object.values(ANGLE_SLOTS);

const VALID_HANDOFF_MODES = ["continue", "detail_shift", "soft_drift", "callback", "research_turn", "reset"];

function validHandoffMode(value) {
  const mode = String(value || "").toLowerCase();
  if (VALID_HANDOFF_MODES.includes(mode)) return mode;
  return "continue";
}

function validSpontaneousMove(value) {
  const move = String(value || "").toLowerCase();
  if (SPONTANEOUS_MOVES.includes(move)) return move;
  return "";
}

function alignHandoffMode(promptType, handoffMode) {
  switch (promptType) {
    case "DEEP_DIVE":
      return ["continue", "detail_shift"].includes(handoffMode) ? handoffMode : "detail_shift";
    case "SOFT_TRANSITION":
      return "soft_drift";
    case "RESET_TRANSITION":
      return "reset";
    case "TOPIC_ENTRY":
      return ["soft_drift", "continue"].includes(handoffMode) ? handoffMode : "soft_drift";
    default:
      return handoffMode;
  }
}

function validDepolish(value) {
  const mode = String(value || "").toLowerCase();
  if (["none", "live_reaction", "self_repair", "unfinished_edge", "comment_ping"].includes(mode)) return mode;
  return "none";
}

function memoryHasPerson(candidate) {
  const text = String(candidate?.memory?.episode || "");
  return /友達|友人|親|母|父|先生|店員|店員さん|家族|おばあちゃん|おじいちゃん|おじさん|お兄さん|お姉さん|クラスメイト|隣の人|誰か|コメント/.test(text);
}

function freshAngleSlot(memoryId, chosen, candidateMap) {
  const candidate = candidateMap.get(String(memoryId || ""));
  const used = new Set(candidate?.usedAngleSlots || []);
  const normalized = String(chosen || "").toUpperCase();

  if (VALID_ANGLE_SLOTS.includes(normalized) && !used.has(normalized)) {
    return normalized;
  }

  const isContinuation =
    candidate?.candidateKind === "CURRENT_DEEP_DIVE" ||
    used.size > 0;

  if (!isContinuation) {
    return ANGLE_SLOTS.OBJECT_DETAIL;
  }

  const fallbackOrder = [
    ANGLE_SLOTS.MICRO_CONFLICT,
    ANGLE_SLOTS.PLACE_SHIFT,
    ANGLE_SLOTS.SELF_TSUKKOMI,
    ANGLE_SLOTS.AFTER_SCENE,
    ANGLE_SLOTS.BODY_FEEL,
    ANGLE_SLOTS.UNNECESSARY_DETAIL,
    ANGLE_SLOTS.CURRENT_COMPARISON,
    ANGLE_SLOTS.CURRENT_SELF,
    ANGLE_SLOTS.OBJECT_DETAIL,
  ];
  if (memoryHasPerson(candidate)) {
    fallbackOrder.unshift(ANGLE_SLOTS.PERSON_REACTION);
  }

  return fallbackOrder.find(slot => !used.has(slot)) || ANGLE_SLOTS.CURRENT_SELF;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function sanitizeJapaneseField(value, maxLength) {
  const text = String(value || "").trim();
  if (!text || /[A-Za-z]/.test(text)) return "";
  return text.slice(0, maxLength);
}

function fallbackEntryHook(memoryId, candidateMap) {
  if (!memoryId) return "";
  const candidate = candidateMap.get(String(memoryId));
  return buildEventAnchors(candidate?.memory, { maxAnchors: 1 })[0] || buildCandidateHookSummary(candidate?.memory, { maxHooks: 1 }).entryHooks[0] || "";
}

function fallbackBridgeParts(memoryId, promptType, candidateMap) {
  if (!memoryId) return { fromHook: "", toHook: "", bridgeHint: "" };
  if (["DEEP_DIVE", "RESET_TRANSITION", "ENDING"].includes(promptType)) {
    return { fromHook: "", toHook: "", bridgeHint: "" };
  }
  const transition = candidateMap.get(String(memoryId))?.transition;
  if (!["DIRECT", "SCENE", "CONTRAST", "SOFT_TRANSITION"].includes(transition?.type)) {
    return { fromHook: "", toHook: "", bridgeHint: "" };
  }
  const fromHook = transition.previousStrongHooks?.[0] || "";
  const toHook = transition.nextStrongHooks?.[0] || "";
  const keyword = transition.keyword || "";
  return {
    fromHook,
    toHook,
    bridgeHint: fromHook && toHook
      ? `${fromHook}から${toHook}へ軽く滑る`
      : keyword
        ? `${keyword}を説明せずに軽く拾う`
        : "",
  };
}
