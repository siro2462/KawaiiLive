export function createInitialStreamState() {
  return {
    summary: "",
    mood: "casual",
    tension: 50,
    currentTopic: null,
    recentHooks: [],
    usedMemoryIds: new Set(),
    memoryBlockCounts: new Map(),
    usedMemoryHooks: new Map(),
    usedMemoryAngleSlots: new Map(),
    recentBridgeHooks: [],
    recentTransitionTypes: [],
    liveResearch: null,
    usedFlowIds: [],
    blockCount: 0,
  };
}

export function updateStreamState(state, { decision, memory, blockText, hooks }) {
  const next = {
    ...state,
    mood: decision.emotion || state.mood,
    tension: typeof decision.tension === "number" ? decision.tension : state.tension,
    currentTopic: memory ? {
      memoryId: memory.id,
      keyword: hooks?.[0] || "",
      summary: memory.episode.slice(0, 120),
    } : (decision.prompt_type || "").startsWith("KAIDAN_") ? null : state.currentTopic,
    recentHooks: hooks || state.recentHooks,
    blockCount: state.blockCount + 1,
    usedMemoryIds: new Set(state.usedMemoryIds),
    memoryBlockCounts: new Map(state.memoryBlockCounts),
    usedMemoryHooks: new Map(state.usedMemoryHooks || []),
    usedMemoryAngleSlots: new Map(state.usedMemoryAngleSlots || []),
    recentBridgeHooks: [...(state.recentBridgeHooks || [])],
    recentTransitionTypes: [...(state.recentTransitionTypes || [])],
    usedFlowIds: [...state.usedFlowIds],
  };

  if (memory?.id) {
    next.usedMemoryIds.add(memory.id);
    const key = String(memory.id);
    next.memoryBlockCounts.set(key, (next.memoryBlockCounts.get(key) || 0) + 1);

    const usedHooks = new Set(next.usedMemoryHooks.get(key) || []);
    for (const hook of [
      decision.entry_hook,
      decision.from_hook,
      decision.to_hook,
      decision.from_event,
      decision.to_event,
      ...(hooks || []),
    ].filter(Boolean)) {
      usedHooks.add(String(hook).trim());
    }
    next.usedMemoryHooks.set(key, [...usedHooks].slice(-24));

    const usedAngles = new Set(next.usedMemoryAngleSlots.get(key) || []);
    if (decision.angle_slot) usedAngles.add(decision.angle_slot);
    next.usedMemoryAngleSlots.set(key, [...usedAngles].slice(-8));

    const bridgeHooks = [
      decision.from_hook,
      decision.to_hook,
      decision.from_event,
      decision.to_event,
    ].filter(Boolean).map(normalizeBridgeHook).filter(Boolean);
    next.recentBridgeHooks = [
      ...next.recentBridgeHooks,
      ...bridgeHooks,
    ].slice(-12);
  }

  next.recentTransitionTypes = [
    ...next.recentTransitionTypes,
    decision.transition_type || decision.prompt_type || "NONE",
  ].slice(-4);

  next.summary = updateRollingSummary(next.summary, decision, memory, blockText);
  return next;
}

function normalizeBridgeHook(value) {
  const text = String(value || "").trim();
  if (!text || text === "none") return "";
  for (const hook of ["冷蔵庫", "スマホ", "部屋", "コンビニ", "レジ", "画面", "ドア", "机", "台所", "キッチン", "棚", "店内", "袋", "箱", "冷気", "光"]) {
    if (text.includes(hook)) return hook;
  }
  return text.slice(0, 16);
}

function updateRollingSummary(prev, decision, memory, blockText) {
  const snippet = (blockText || "").slice(0, 100);
  const topic = memory?.episode?.slice(0, 60) || "";
  return `${prev} / ${decision.prompt_type}: ${topic} ${snippet}`.slice(-500);
}
