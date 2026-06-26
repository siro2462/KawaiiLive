export function buildScriptItemsFromBlock({
  lines,
  memory,
  decision,
  transition,
  blockId,
  prompt,
  raw,
  blockText,
  startIndex,
  directorPrompt = "",
  directorRaw = "",
  directorParseOk = false,
  selectedPlanBlock = "",
  selectedPlanIndex = 0,
}) {
  const keyword = getMainKeyword(memory);

  return lines.map((text, index) => ({
    number: startIndex + index + 1,
    scriptNumber: startIndex + index + 1,
    topic: `memory ${memory.id}`,
    memoryId: memory.id,
    anchor: index === 0 ? keyword : "-",
    role: decision.prompt_type,
    text,
    attempt: `script_v3:${decision.prompt_type}`,
    generator_req: prompt,
    generator_res: raw,
    director_req: index === 0 ? directorPrompt : "",
    director_res: index === 0 ? directorRaw : "",

    block_id: blockId,
    block_text: index === 0 ? (blockText || "") : "",
    block_line_index: index + 1,
    block_line_count: lines.length,
    target_chars: decision.target_chars || 0,

    prompt_type: decision.prompt_type,
    move: decision.move || "",
    angle: decision.angle || "",
    angle_slot: decision.angle_slot || "",
    depolish: decision.depolish || "",
    handoff: decision.handoff || "",
    entry_hook: decision.entry_hook || "",
    from_hook: decision.from_hook || "",
    to_hook: decision.to_hook || "",
    from_event: decision.from_event || "",
    to_event: decision.to_event || "",
    bridge_hint: decision.bridge_hint || "",
    topic_hint: decision.topic_hint || "",
    emotion: decision.emotion,
    tension: decision.tension,

    transition_type: index === 0 ? (decision.transition_type || transition?.type || "") : "",
    planner_transition_type: index === 0 ? (decision.prompt_type || "") : "",
    actual_transition_type: index === 0 ? deriveActualTransitionType(decision) : "",
    transition_keyword: index === 0 ? (transition?.keyword || decision.transition?.keyword || "") : "",
    transition_reason: index === 0 ? (transition?.reason || decision.transition?.reason || "") : "",
    prev_hooks: index === 0 ? (transition?.previousHooks?.join("・") || "") : "",
    next_hooks: index === 0 ? (transition?.nextHooks?.join("・") || "") : "",
    handoff_mode: index === 0 ? (decision.handoff_mode || "") : "",
    handoff_hook: index === 0 ? (decision.handoff_hook || "") : "",
    handoff_action: index === 0 ? (decision.handoff_action || "") : "",
    handoff_feeling: index === 0 ? (decision.handoff_feeling || "") : "",
    next_entry_hint: index === 0 ? (decision.next_entry_hint || "") : "",
    previous_hooks: index === 0 ? formatHooksField(decision.previous_hooks) : "",
    spontaneous_move: index === 0 ? (decision.spontaneous_move || "") : "",
    director_parse_ok: index === 0 ? (directorParseOk ? "1" : "0") : "",
    selected_plan_block: index === 0 ? selectedPlanBlock : "",
    selected_plan_index: index === 0 ? String(selectedPlanIndex) : "",

    source_type: "memory",
    research_id: "",
    research_title: "",
    research_part: "",
    research_hooks: "",

    status: "pending",
  }));
}

export function buildKaidanScriptItems({
  text,
  decision,
  blockId,
  prompt,
  raw,
  startIndex,
  researchId = "",
  researchTitle = "",
  researchPart = "",
  researchHooks = [],
}) {
  return [{
    number: startIndex + 1,
    scriptNumber: startIndex + 1,
    topic: `kaidan ${researchTitle}`,
    memoryId: "",
    anchor: researchTitle.slice(0, 20) || "kaidan",
    role: decision.prompt_type,
    text,
    attempt: `script_v3:${decision.prompt_type}`,
    generator_req: prompt,
    generator_res: raw,
    director_req: "",
    director_res: "",
    block_id: blockId,
    block_text: text,
    block_line_index: 1,
    block_line_count: 1,
    target_chars: decision.target_chars || 0,
    prompt_type: decision.prompt_type,
    move: decision.move || "",
    angle: decision.angle || "",
    angle_slot: "",
    depolish: "",
    handoff: "",
    entry_hook: "",
    from_hook: "",
    to_hook: "",
    from_event: "",
    to_event: "",
    bridge_hint: "",
    topic_hint: "",
    emotion: decision.emotion,
    tension: decision.tension,
    transition_type: decision.transition_type || "",
    planner_transition_type: decision.prompt_type || "",
    actual_transition_type: deriveActualTransitionType(decision),
    transition_keyword: "",
    transition_reason: "",
    prev_hooks: "",
    next_hooks: "",
    handoff_mode: decision.handoff_mode || "",
    handoff_hook: decision.handoff_hook || "",
    handoff_action: decision.handoff_action || "",
    handoff_feeling: decision.handoff_feeling || "",
    next_entry_hint: decision.next_entry_hint || "",
    previous_hooks: formatHooksField(decision.previous_hooks),
    spontaneous_move: decision.spontaneous_move || "",
    source_type: "kaidan",
    research_id: researchId,
    research_title: researchTitle,
    research_part: researchPart,
    research_hooks: researchHooks.join("・"),
    status: "pending",
  }];
}

function deriveActualTransitionType(decision) {
  const pt = decision.prompt_type || "";
  if (pt === "DEEP_DIVE") return "NONE";
  if (pt === "RESET_TRANSITION") return "RESET";
  if (pt === "SOFT_TRANSITION") return "SOFT";
  if (pt === "TOPIC_ENTRY") return "SOFT";
  if (pt.startsWith("KAIDAN_")) return "NONE";
  return decision.transition_type || "SOFT";
}

function formatHooksField(hooks) {
  if (Array.isArray(hooks)) return hooks.join("・");
  return String(hooks || "");
}

function getMainKeyword(memory) {
  try {
    const parsed = JSON.parse(memory.keywords || "[]");
    return Array.isArray(parsed) ? parsed[0] || "" : "";
  } catch {
    return String(memory.keywords || "").split(",")[0] || "";
  }
}
