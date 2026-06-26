import { readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { retrieveSpeakingStyle, retrieveTopicFlow } from "./vector.mjs";

import { DEFAULT_TARGET_LINES, PROMPT_TYPES, BLOCK_CHAR_RANGES, MAX_BLOCKS_PER_MEMORY, PLAN_SIZE } from "./constants.mjs";
import { createInitialStreamState, updateStreamState } from "./state.mjs";
import { pickMemoryCandidates } from "./planner.mjs";
import { extractTransitionHooks } from "./transition.mjs";
import { planNextBlocks } from "./director.mjs";
import { generateLongBlock } from "./block.mjs";
import { buildScriptItemsFromBlock, buildKaidanScriptItems } from "./item-builder.mjs";
import { selectRandomKaidanResearch } from "./kaidan.mjs";
import { buildKaidanOpPrompt, buildKaidanMainPrompt, buildKaidanEdPrompt } from "./kaidan-prompts.mjs";
import { inspectLine } from "./inspector.mjs";
import { cleanBlockText } from "./parser.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "talk-items.sqlite");
const SCRIPT_LLM_LOG_PATH = path.join(DATA_DIR, "logs", "script-llm-v3.jsonl");
const LLAMA_SERVER_URL = process.env.LLAMA_SERVER_URL || "http://127.0.0.1:11435";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
let activeScriptModel = "";

const STYLE_FOREIGN_RE = /[\u70df\u6536\u7eb3]|毫米|捞|特别|那种|那種|啊/;
const STYLE_GENRE_NOISE_RE = /\u5893|\u8fd1\u3065\u304b\u306a\u3044|\u4eca\u5f8c\u4e00\u5207|\u6050\u6016|\u6b7b\u4ea1|\u544a\u5225|\u546a\u3044|\u602a\u8ac7/;
const STYLE_PARTIAL_TAIL_RE = /(\u6570\u30f6|\u9858\u3044\u305f\u3044\u306f\u3044\u3084\u308a|\u3057\u3066\u3044\u305f|\u3060\u3063\u305f|[\u300c\u300e])$/;
const STYLE_RHYTHM_RE = /なんか|いや|まあ|ちょっと|ていうか|そっか|あ、|えーと|まじ|待って|そういう|別に|なんだよ|だよね|じゃん|かも|けど|けどさ|はは/;
const STYLE_PROPER_NOUN_RE = /ラミィ|フブキ|おかゆ|ぺこら|椎名|戌亥|あやめ|アンジュ|える|トワ/;

const FALLBACK_FEW_SHOT = [
  "なんか、そこだけ妙に覚えてる",
  "いや、そうじゃなくて",
  "まあ、別に大事件じゃないんだけど",
  "ていうか、ちょっと待って",
  "あ、そっか。そういうことかも",
];

export function defaultModel() {
  return process.env.RADIO_SCRIPT_OLLAMA_MODEL || "qwen3.6:35b-a3b";
}

export async function generateScriptV3({
  turns = DEFAULT_TARGET_LINES,
  model = defaultModel(),
  signal,
  onProgress = () => {},
} = {}) {
  activeScriptModel = model || defaultModel();
  const targetLines = turns;
  const allMemories = loadMemories(120);
  if (!allMemories.length) throw new Error("No usable memories (episodeが空)");

  const items = [];
  let streamState = createInitialStreamState();
  let recentBlock = "";
  let currentMemory = null;

  console.log(`[v3] 台本生成開始 target=${targetLines}blocks memories=${allMemories.length}件`);

  // ─── OP ─────────────────────────────────────────
  onProgress({ progress: 3, label: "Opening" });

  let liveResearch = null;
  try {
    liveResearch = await selectRandomKaidanResearch();
    if (liveResearch) {
      console.log(`[v3] kaidan research: "${liveResearch.title}" (${liveResearch.rawText.length}chars)`);
      logLlm("kaidan_load", { message: `怪談リサーチ読込: "${liveResearch.title}" (${liveResearch.rawText.length}chars)` });
    }
  } catch (e) {
    console.log(`[v3] kaidan読み込みスキップ: ${e instanceof Error ? e.message : e}`);
    logLlm("kaidan_load_skip", { message: `怪談読み込みスキップ: ${e instanceof Error ? e.message : e}` });
  }

  if (liveResearch) {
    console.log(`[v3] ── kaidan OP生成開始: ${liveResearch.title}`);
    logLlm("kaidan_op_start", { message: `怪談OP生成開始: ${liveResearch.title}` });
    const kOpStyle = await resolveStyle("雑談 始まり そういえば 今日の話", null, 2);
    const kOpPrompt = buildKaidanOpPrompt({ liveResearch, styleTexts: maskStyleFragments(kOpStyle.texts) });
    const kOpResult = await generateKaidanBlock({ callLlm, prompt: kOpPrompt, targetChars: 350, existingItems: items });

    if (kOpResult.blockText.length >= 50) {
      const opHooks = extractTransitionHooks(kOpResult.blockText);
      liveResearch.opText = kOpResult.blockText;
      liveResearch.opHooks = opHooks;

      const kOpDecision = {
        prompt_type: PROMPT_TYPES.KAIDAN_OP,
        move: "ASSOCIATE",
        emotion: "casual",
        tension: 55,
        target_chars: 350,
        angle: "配信開始・今日の調べ物を匂わせる",
        handoff: "",
        topic_hint: "",
      };

      items.push(...buildKaidanScriptItems({
        text: kOpResult.blockText,
        decision: kOpDecision,
        blockId: "b000",
        prompt: kOpResult.prompt,
        raw: kOpResult.raw,
        startIndex: 0,
        researchId: liveResearch.id,
        researchTitle: liveResearch.title,
        researchPart: "op",
        researchHooks: opHooks,
      }));

      streamState = updateStreamState(streamState, {
        decision: kOpDecision,
        memory: null,
        blockText: kOpResult.blockText,
        hooks: opHooks,
      });
      recentBlock = kOpResult.blockText;

      console.log(`[v3] kaidan OP完了 ${kOpResult.blockText.length}chars hooks=${opHooks.slice(0, 4).join(",")}`);
      logLlm("kaidan_op", { message: `怪談OP完了 ${kOpResult.blockText.length}chars hooks=${opHooks.slice(0, 4).join(",")}`, title: liveResearch.title, chars: kOpResult.blockText.length });
    } else {
      console.log(`[v3] kaidan OP短すぎ → 通常OPへfallback`);
      logLlm("kaidan_op_fallback", { message: `怪談OP短すぎ(${kOpResult.blockText.length}chars) → 通常OPへfallback`, title: liveResearch.title, chars: kOpResult.blockText.length });
      liveResearch = null;
    }
  }

  if (!liveResearch) {
    console.log(`[v3] ── OP生成開始 memory=#${allMemories[0]?.id}`);
    const opMemory = allMemories[Math.floor(Math.random() * Math.min(allMemories.length, 10))];
    const opStyle = await resolveStyle("配信開始 挨拶 今日あったこと", opMemory, 2);

    const opDecision = {
      prompt_type: PROMPT_TYPES.OPENING,
      move: "ASSOCIATE",
      emotion: "casual",
      tension: 55,
      target_chars: 400,
      angle: "配信開始の挨拶と今日の出来事",
      handoff: "",
      topic_hint: "",
    };

    const opBlock = await generateLongBlock({
      callLlm,
      decision: opDecision,
      memory: opMemory,
      recentSummary: "",
      recentHooksStr: "",
      lastSentence: "",
      topicFlow: null,
      styleTexts: maskStyleFragments(opStyle.texts),
      section: "opening",
      existingItems: items,
    });

    if (opBlock.acceptedLines.length) {
      console.log(`[v3] OP完了 ${opBlock.blockText.length}chars accepted:${opBlock.acceptedLines.length}`);
      items.push(...buildScriptItemsFromBlock({
        lines: opBlock.acceptedLines,
        memory: opMemory,
        decision: opDecision,
        transition: null,
        blockId: "b000",
        prompt: opBlock.prompt,
        raw: opBlock.raw,
        blockText: opBlock.blockText,
        startIndex: 0,
      }));
      streamState = updateStreamState(streamState, {
        decision: opDecision,
        memory: opMemory,
        blockText: opBlock.blockText,
        hooks: extractTransitionHooks(opBlock.blockText),
      });
      recentBlock = opBlock.blockText;
      currentMemory = opMemory;
    }
    if (opBlock.rejectedIssues?.length) {
      console.log(`[v3] OP inspect警告: ${opBlock.rejectedIssues.map(r => r.issues.join(",")).join("; ")}`);
    }
    logLlm("opening", { chars: opBlock.blockText.length, memoryId: opMemory.id });
  }

  if (liveResearch) {
    streamState.liveResearch = liveResearch;
  }

  // ─── Body loop (3-block plan method) ────────────
  console.log(`[v3] ── 本編ループ開始 bodyTarget=${targetLines - 1} (PLAN_SIZE=${PLAN_SIZE})`);
  const bodyTarget = targetLines - 1;
  let plan = null;
  let planIndex = 0;
  let currentPlanPrompt = "";
  let currentPlanRaw = "";
  let currentPlanParseOk = false;
  let currentPlanParseError = "";
  let currentPlanCandidates = [];
  const recentBlockTexts = [];

  while (items.length < bodyTarget) {
    if (signal?.aborted) throw new DOMException("Script generation cancelled", "AbortError");

    // ── 親LLM: 3block plan生成（planを使い切ったら再生成） ──
    if (!plan || planIndex >= plan.blocks.length) {

      // ── kaidan MAIN挿入チェック (plan boundary = 自然な話題遷移タイミング) ──
      if (liveResearch && !liveResearch.mainUsed && shouldInsertKaidanMain(streamState.blockCount, bodyTarget - items.length)) {
        console.log(`[v3] ── kaidan MAIN挿入 (blockCount=${streamState.blockCount})`);
        logLlm("kaidan_main_start", { message: `怪談MAIN挿入開始 (blockCount=${streamState.blockCount})` });
        onProgress({ progress: Math.min(88, 5 + Math.floor((items.length / targetLines) * 87)), label: "Kaidan Main" });

        const kMainStyle = await resolveStyle("雑談 そういえば 調べてた話 ちょっと引っかかる", null, 2);
        const kMainHooks = extractTransitionHooks(recentBlock).slice(0, 6);
        const kMainPreviousTalkHint = buildPreviousTalkHint(recentBlock);
        const kMainPrompt = buildKaidanMainPrompt({
          liveResearch,
          recentHooks: kMainHooks,
          previousTalkHint: kMainPreviousTalkHint,
          styleTexts: maskStyleFragments(kMainStyle.texts),
        });
        const kMainResult = await generateKaidanBlock({ callLlm, prompt: kMainPrompt, targetChars: 650, existingItems: items });

        if (kMainResult.blockText.length >= 100) {
          const recentMemoryHooks = extractTransitionHooks(recentBlock);
          const researchSegment = extractResearchSegment(kMainResult.blockText, liveResearch);
          const mainHooks = extractKaidanHooks({ text: researchSegment, liveResearch, excludeHooks: recentMemoryHooks });
          liveResearch.mainText = kMainResult.blockText;
          liveResearch.mainHooks = mainHooks;
          liveResearch.mainUsed = true;

          const kMainDecision = {
            prompt_type: PROMPT_TYPES.KAIDAN_MAIN,
            move: "ASSOCIATE",
            emotion: "uneasy",
            tension: 60,
            target_chars: 650,
            angle: "今日の調べ物コーナー",
            handoff: "",
            topic_hint: "",
          };

          items.push(...buildKaidanScriptItems({
            text: kMainResult.blockText,
            decision: kMainDecision,
            blockId: `b${String(streamState.blockCount + 1).padStart(3, "0")}`,
            prompt: kMainResult.prompt,
            raw: kMainResult.raw,
            startIndex: items.length,
            researchId: liveResearch.id,
            researchTitle: liveResearch.title,
            researchPart: "main",
            researchHooks: mainHooks,
          }));

          streamState = updateStreamState(streamState, {
            decision: kMainDecision,
            memory: null,
            blockText: kMainResult.blockText,
            hooks: mainHooks,
          });
          recentBlock = kMainResult.blockText;
          recentBlockTexts.push(kMainResult.blockText);
          currentMemory = null;

          console.log(`[v3] kaidan MAIN完了 ${kMainResult.blockText.length}chars hooks=${mainHooks.slice(0, 4).join(",")}`);
          logLlm("kaidan_main", { message: `怪談MAIN完了 ${kMainResult.blockText.length}chars hooks=${mainHooks.slice(0, 4).join(",")}`, title: liveResearch.title, chars: kMainResult.blockText.length });
        } else {
          console.log(`[v3] kaidan MAIN短すぎ → スキップ`);
          liveResearch.mainUsed = true;
          logLlm("kaidan_main_skip", { message: `怪談MAIN短すぎ(${kMainResult.blockText.length}chars) → スキップ`, title: liveResearch.title, chars: kMainResult.blockText.length });
        }

        plan = null;
        planIndex = 0;
        continue;
      }

      const recentText = recentBlock || items.slice(-1).map(i => i.text).join("");
      const recentHooks = extractTransitionHooks(recentText);

      const memoryCandidates = pickMemoryCandidates({
        allMemories,
        usedMemoryIds: streamState.usedMemoryIds,
        usedMemoryHooks: streamState.usedMemoryHooks,
        usedMemoryAngleSlots: streamState.usedMemoryAngleSlots,
        recentBridgeHooks: streamState.recentBridgeHooks,
        recentTransitionTypes: streamState.recentTransitionTypes,
        recentText,
        currentMemory,
        currentMemoryBlocks: currentMemory ? (streamState.memoryBlockCounts.get(String(currentMemory.id)) || 0) : 0,
        maxBlocksPerMemory: MAX_BLOCKS_PER_MEMORY,
        limit: 12,
      });

      if (!memoryCandidates.length) {
        console.log(`[v3] ⚠ memory候補なし → usedSetリセット`);
        logLlm("warn", { message: "No memory candidates left, resetting used set" });
        streamState.usedMemoryIds.clear();
        continue;
      }

      const remainingBlocks = bodyTarget - items.length;
      console.log(`[v3] ── 親LLM plan生成中... remaining=${remainingBlocks}`);

      const result = await planNextBlocks({
        callLlm,
        streamState,
        recentBlocks: recentBlockTexts.slice(-3).map(t => t.slice(-200)),
        recentHooks,
        memoryCandidates,
        remainingBlocks,
      });

      plan = result.plan;
      planIndex = 0;
      currentPlanPrompt = result.prompt;
      currentPlanRaw = result.raw;
      currentPlanParseOk = result.parseOk;
      currentPlanParseError = result.parseError;
      currentPlanCandidates = memoryCandidates;

      console.log(`[v3] plan完了: "${plan.plan_note}" | ${plan.blocks.map(b => `${b.prompt_type}/${b.move}(#${b.memory_id})`).join(" → ")}`);
      logLlm("plan", {
        plan_note: plan.plan_note,
        blocks: plan.blocks.map(b => ({
          prompt_type: b.prompt_type,
          move: b.move,
          memory_id: b.memory_id,
          target_chars: b.target_chars,
          entry_hook: b.entry_hook || "",
          angle_slot: b.angle_slot || "",
          depolish: b.depolish || "",
          from_hook: b.from_hook || "",
          to_hook: b.to_hook || "",
          from_event: b.from_event || "",
          to_event: b.to_event || "",
          bridge_hint: b.bridge_hint || "",
          angle: b.angle || "",
        })),
        remaining: remainingBlocks,
      });
    }

    // ── plan内の次blockを取得 ──
    const planBlock = plan.blocks[planIndex];
    if (!planBlock) break;

    if (planBlock.prompt_type === "ENDING") {
      console.log(`[v3] plan内でENDING → 本編ループ終了`);
      break;
    }

    const memory = allMemories.find(m => String(m.id) === String(planBlock.memory_id));
    if (!memory) {
      console.log(`[v3] ⚠ memory #${planBlock.memory_id} が見つからない → skip`);
      planIndex++;
      continue;
    }

    // 同じmemoryをこね続けすぎない。滞在系typeも同一memoryカウントに含める。
    const memBlocks = streamState.memoryBlockCounts.get(String(memory.id)) || 0;
    if (memBlocks >= MAX_BLOCKS_PER_MEMORY) {
      console.log(`[v3] memory #${memory.id} block limit(${MAX_BLOCKS_PER_MEMORY}) → skip`);
      planIndex++;
      continue;
    }

    const topicFlow = await resolveTopicFlowForMemory(memory);
    const style = await resolveStyle(
      [memory.episode.slice(0, 80), topicFlow?.handling || ""].filter(Boolean).join(" "),
      memory,
      3,
    );

    const candidate = currentPlanCandidates.find(c => String(c.memory.id) === String(memory.id));

    const handoffCue = buildHandoffCue(recentBlock);

    const decision = {
      prompt_type: planBlock.prompt_type,
      move: planBlock.move || "ASSOCIATE",
      target_chars: planBlock.target_chars,
      emotion: streamState.mood || "casual",
      tension: streamState.tension || 50,
      angle: planBlock.angle || "",
      angle_slot: planBlock.angle_slot || "",
      depolish: planBlock.depolish || "none",
      handoff_hook: planBlock.handoff_hook || "",
      handoff_action: planBlock.handoff_action || handoffCue.action,
      handoff_feeling: planBlock.handoff_feeling || handoffCue.feeling,
      next_entry_hint: planBlock.next_entry_hint || "",
      handoff_mode: planBlock.handoff_mode || "continue",
      spontaneous_move: planBlock.spontaneous_move || "",
      previous_hooks: handoffCue.hooks,
      entry_hook: planBlock.entry_hook || "",
      from_hook: planBlock.from_hook || "",
      to_hook: planBlock.to_hook || "",
      from_event: planBlock.from_event || "",
      to_event: planBlock.to_event || "",
      bridge_hint: planBlock.bridge_hint || "",
      transition_type: planBlock.prompt_type === "DEEP_DIVE" ? "NONE"
        : planBlock.prompt_type === "RESET_TRANSITION" ? "RESET"
        : candidate?.transition?.type || "SOFT",
      topic_hint: topicFlow?.handling || "",
      used_hooks: streamState.usedMemoryHooks?.get(String(memory.id)) || [],
    };

    onProgress({
      progress: Math.min(92, 5 + Math.floor((items.length / targetLines) * 87)),
      label: `${planBlock.prompt_type} B${streamState.blockCount + 1} plan[${planBlock.index}/${plan.blocks.length}] ${items.length}/${targetLines}`,
    });

    // ── 子LLM: 長文block生成 ──
    console.log(`[v3] 子LLM生成中... B${streamState.blockCount + 1} ${planBlock.prompt_type} memory=#${memory.id} plan[${planBlock.index}/${plan.blocks.length}]`);
    const prevTail = recentBlock ? recentBlock.slice(-200) : "";
    const block = await generateLongBlock({
      callLlm,
      decision,
      memory,
      recentSummary: "",
      recentHooksStr: "",
      lastSentence: prevTail,
      topicFlow: null,
      styleTexts: maskStyleFragments(style.texts),
      section: "body",
      existingItems: items,
    });

    console.log(`[v3] B${streamState.blockCount + 1} 結果: ${block.blockText.length}chars accepted:${block.acceptedLines.length} target:${planBlock.target_chars}`);
    const angleComplianceIssues = inspectAngleCompliance(block.blockText, decision);
    let essaySignals = inspectEssaySignals(block.blockText);
    const continuityIssues = inspectContinuity(block.blockText, handoffCue);
    const rejectionReasons = (block.rejectedIssues || []).flatMap(r => r.issues || []);
    logLlm("block", {
      blockCount: streamState.blockCount,
      memoryId: memory.id,
      prompt_type: planBlock.prompt_type,
      blockChars: block.blockText.length,
      accepted: block.acceptedLines.length,
      targetChars: planBlock.target_chars,
      planIndex: planBlock.index,
      angleSlot: decision.angle_slot || "",
      angleComplianceIssues,
      essaySignals,
      rejectionReasons,
      abstractSensationCount: countAbstractSensation(block.blockText),
      abstractEnding: hasAbstractEnding(block.blockText),
    });
    if (angleComplianceIssues.length) {
      console.log(`[v3] angle compliance: ${decision.angle_slot || "none"} ${angleComplianceIssues.join(",")}`);
      logLlm("angle_compliance", {
        blockCount: streamState.blockCount,
        memoryId: memory.id,
        angle_slot: decision.angle_slot || "",
        prompt_type: decision.prompt_type,
        issues: angleComplianceIssues,
      });
    }
    if (essaySignals.includes("essay_landing") || essaySignals.includes("meaningful_landing")) {
      console.log(`[v3] essay rewrite: ${essaySignals.join(",")}`);
      logLlm("essay_rewrite_start", { blockCount: streamState.blockCount, signals: essaySignals });
      const rewriteDecision = { ...decision, depolish: "unfinished_edge" };
      const rewriteBlock = await generateLongBlock({
        callLlm, decision: rewriteDecision, memory,
        recentSummary: "", recentHooksStr: "", lastSentence: "",
        topicFlow: null, styleTexts: maskStyleFragments(style.texts),
        section: "body", existingItems: items,
      });
      const rewriteSignals = inspectEssaySignals(rewriteBlock.blockText);
      if (rewriteBlock.acceptedLines.length && rewriteSignals.length < essaySignals.length) {
        console.log(`[v3] essay rewrite accepted: ${rewriteBlock.blockText.length}chars`);
        block.blockText = rewriteBlock.blockText;
        block.acceptedLines = rewriteBlock.acceptedLines;
        block.prompt = rewriteBlock.prompt;
        block.raw = rewriteBlock.raw;
        essaySignals = rewriteSignals;
        logLlm("essay_rewrite_done", { blockCount: streamState.blockCount, newSignals: rewriteSignals });
      } else {
        console.log(`[v3] essay rewrite rejected, keeping original`);
        logLlm("essay_rewrite_skip", { blockCount: streamState.blockCount });
      }
    } else if (essaySignals.length) {
      console.log(`[v3] essay signal: ${essaySignals.join(",")}`);
      logLlm("essay_signal", {
        blockCount: streamState.blockCount,
        memoryId: memory.id,
        prompt_type: decision.prompt_type,
        angle_slot: decision.angle_slot || "",
        signals: essaySignals,
      });
    }
    const abstractCount = countAbstractSensation(block.blockText);
    const abstractEnding = hasAbstractEnding(block.blockText);
    if (shouldRewriteAbstract(block.blockText)) {
      console.log(`[v3] abstract sensation rewrite: ${abstractCount} hits, ending=${abstractEnding}`);
      logLlm("abstract_rewrite_start", { blockCount: streamState.blockCount, abstractCount, abstractEnding });
      const abstractRewriteDecision = { ...decision, depolish: "self_repair" };
      const abstractRewriteBlock = await generateLongBlock({
        callLlm, decision: abstractRewriteDecision, memory,
        recentSummary: "", recentHooksStr: "", lastSentence: prevTail,
        topicFlow: null, styleTexts: maskStyleFragments(style.texts),
        section: "body", existingItems: items,
      });
      if (abstractRewriteBlock.acceptedLines.length && !shouldRewriteAbstract(abstractRewriteBlock.blockText)) {
        console.log(`[v3] abstract rewrite accepted: ${abstractRewriteBlock.blockText.length}chars (${countAbstractSensation(abstractRewriteBlock.blockText)} hits)`);
        block.blockText = abstractRewriteBlock.blockText;
        block.acceptedLines = abstractRewriteBlock.acceptedLines;
        block.prompt = abstractRewriteBlock.prompt;
        block.raw = abstractRewriteBlock.raw;
        logLlm("abstract_rewrite_done", { blockCount: streamState.blockCount, newAbstractCount: countAbstractSensation(abstractRewriteBlock.blockText) });
      } else {
        const newCount = countAbstractSensation(abstractRewriteBlock.blockText);
        console.log(`[v3] abstract rewrite rejected (${newCount} hits), keeping original`);
        logLlm("abstract_rewrite_skip", { blockCount: streamState.blockCount, newAbstractCount: newCount });
      }
    } else if (abstractCount >= 2) {
      logLlm("abstract_signal", { blockCount: streamState.blockCount, abstractCount, memoryId: memory.id });
    }

    if (continuityIssues.length) {
      console.log(`[v3] continuity: ${continuityIssues.join(",")}`);
      logLlm("continuity_check", {
        blockCount: streamState.blockCount,
        memoryId: memory.id,
        handoff_mode: decision.handoff_mode,
        issues: continuityIssues,
        message: `接続チェック: ${continuityIssues.join(", ")}`,
      });
    }

    if (!block.acceptedLines.length) {
      const reasons = block.rejectedIssues?.map(r => r.issues.join(",")).join("; ") || "unknown";
      console.log(`[v3] ⚠ B${streamState.blockCount + 1} 全拒否! reasons: ${reasons}`);
      logLlm("block_rejected", {
        blockCount: streamState.blockCount,
        memoryId: memory.id,
        prompt_type: planBlock.prompt_type,
        blockChars: block.blockText.length,
        reasons: block.rejectedIssues?.flatMap(r => r.issues) || [],
        snippets: block.rejectedIssues?.map(r => r.snippet) || [],
      });
      if (process.env.RADIO_V3_LENIENT_ACCEPT === "1" && isLenientAcceptableBlock(block.blockText, items)) {
        console.log(`[v3] lenient accept: ${block.blockText.length}chars`);
        block.acceptedLines = [block.blockText.trim()];
      } else {
        planIndex++;
        continue;
      }
    }

    const blockId = `b${String(streamState.blockCount + 1).padStart(3, "0")}`;
    items.push(...buildScriptItemsFromBlock({
      lines: block.acceptedLines,
      memory,
      decision,
      transition: candidate?.transition || null,
      blockId,
      prompt: block.prompt,
      raw: block.raw,
      blockText: block.blockText,
      startIndex: items.length,
      directorPrompt: currentPlanPrompt,
      directorRaw: currentPlanRaw,
      directorParseOk: currentPlanParseOk,
      selectedPlanBlock: JSON.stringify(planBlock),
      selectedPlanIndex: planIndex,
    }));

    const hooks = extractTransitionHooks(block.blockText);
    streamState = updateStreamState(streamState, {
      decision,
      memory,
      blockText: block.blockText,
      hooks,
    });
    recentBlock = block.blockText;
    recentBlockTexts.push(block.blockText);
    currentMemory = memory;

    planIndex++;
  }

  // ─── Force kaidan MAIN if not used ──────────────
  if (liveResearch && !liveResearch.mainUsed) {
    console.log(`[v3] ── kaidan MAIN強制挿入 (ED前)`);
    logLlm("kaidan_main_forced_start", { message: "怪談MAIN強制挿入開始 (ED前)" });
    onProgress({ progress: 93, label: "Kaidan Main (forced)" });

    const fMainStyle = await resolveStyle("雑談 そういえば 調べてた話 ちょっと引っかかる", null, 2);
    const fMainRecentHooks = extractTransitionHooks(recentBlock).slice(0, 6);
    const fMainPreviousTalkHint = buildPreviousTalkHint(recentBlock);
    const fMainPrompt = buildKaidanMainPrompt({
      liveResearch,
      recentHooks: fMainRecentHooks,
      previousTalkHint: fMainPreviousTalkHint,
      styleTexts: maskStyleFragments(fMainStyle.texts),
    });
    const fMainResult = await generateKaidanBlock({ callLlm, prompt: fMainPrompt, targetChars: 650, existingItems: items });

    if (fMainResult.blockText.length >= 100) {
      const fRecentMemoryHooks = extractTransitionHooks(recentBlock);
      const fResearchSegment = extractResearchSegment(fMainResult.blockText, liveResearch);
      const fMainHooks = extractKaidanHooks({ text: fResearchSegment, liveResearch, excludeHooks: fRecentMemoryHooks });
      liveResearch.mainText = fMainResult.blockText;
      liveResearch.mainHooks = fMainHooks;
      liveResearch.mainUsed = true;

      const fMainDecision = {
        prompt_type: PROMPT_TYPES.KAIDAN_MAIN,
        move: "ASSOCIATE",
        emotion: "uneasy",
        tension: 60,
        target_chars: 650,
        angle: "今日の調べ物コーナー",
        handoff: "",
        topic_hint: "",
      };

      items.push(...buildKaidanScriptItems({
        text: fMainResult.blockText,
        decision: fMainDecision,
        blockId: `b${String(streamState.blockCount + 1).padStart(3, "0")}`,
        prompt: fMainResult.prompt,
        raw: fMainResult.raw,
        startIndex: items.length,
        researchId: liveResearch.id,
        researchTitle: liveResearch.title,
        researchPart: "main",
        researchHooks: fMainHooks,
      }));

      streamState = updateStreamState(streamState, {
        decision: fMainDecision,
        memory: null,
        blockText: fMainResult.blockText,
        hooks: fMainHooks,
      });
      recentBlock = fMainResult.blockText;
      currentMemory = null;

      console.log(`[v3] kaidan MAIN(強制)完了 ${fMainResult.blockText.length}chars`);
      logLlm("kaidan_main_forced", { message: `怪談MAIN(強制)完了 ${fMainResult.blockText.length}chars`, title: liveResearch.title, chars: fMainResult.blockText.length });
    } else {
      liveResearch.mainUsed = true;
      console.log(`[v3] kaidan MAIN(強制)短すぎ → スキップ`);
      logLlm("kaidan_main_forced_skip", { message: `怪談MAIN(強制)短すぎ(${fMainResult.blockText.length}chars) → スキップ` });
    }
  }

  // ─── ED ─────────────────────────────────────────
  console.log(`[v3] ── ED生成開始 本編${items.length}blocks完了`);
  onProgress({ progress: 95, label: "Ending" });

  if (liveResearch) {
    const kEdStyle = await resolveStyle("雑談 終わり ゆるい 雑に締める", null, 2);
    const todayObjects = pickTopConcreteObjects(items).slice(0, 3);
    const researchOneLine = liveResearch.title ? `${liveResearch.title}の話を少しした` : "";
    const lastMood = inferLastMood(items);
    const kEdPrompt = buildKaidanEdPrompt({
      todayObjects,
      researchOneLine,
      lastMood,
      endingTone: "軽く、眠そうに、雑に終わる",
      styleTexts: maskStyleFragments(kEdStyle.texts),
    });
    const kEdResult = await generateKaidanBlock({ callLlm, prompt: kEdPrompt, targetChars: 280, existingItems: items });

    if (kEdResult.blockText.length >= 50) {
      const edHooks = extractTransitionHooks(kEdResult.blockText);
      liveResearch.edText = kEdResult.blockText;
      liveResearch.edHooks = edHooks;

      const kEdDecision = {
        prompt_type: PROMPT_TYPES.KAIDAN_ED,
        move: "SOFT_DRIFT",
        emotion: "calm",
        tension: 20,
        target_chars: 300,
        angle: "帰り際の雑な締め",
        handoff: "",
        topic_hint: "",
      };

      items.push(...buildKaidanScriptItems({
        text: kEdResult.blockText,
        decision: kEdDecision,
        blockId: `b${String(streamState.blockCount + 1).padStart(3, "0")}`,
        prompt: kEdResult.prompt,
        raw: kEdResult.raw,
        startIndex: items.length,
        researchId: liveResearch.id,
        researchTitle: liveResearch.title,
        researchPart: "ed",
        researchHooks: edHooks,
      }));

      console.log(`[v3] kaidan ED完了 ${kEdResult.blockText.length}chars`);
      logLlm("kaidan_ed", { message: `怪談ED完了 ${kEdResult.blockText.length}chars`, title: liveResearch?.title, chars: kEdResult.blockText.length });
    } else {
      console.log(`[v3] kaidan ED短すぎ → 通常EDへfallback`);
      logLlm("kaidan_ed_fallback", { message: `怪談ED短すぎ(${kEdResult.blockText.length}chars) → 通常EDへfallback`, title: liveResearch?.title, chars: kEdResult.blockText.length });
      liveResearch = null;
    }
  }

  if (!liveResearch) {
    const lastMemory = currentMemory || allMemories[0];
    const edStyle = await resolveStyle("配信終了 締め 振り返り お疲れ", lastMemory, 2);

    const edHandoffCue = buildHandoffCue(recentBlock);
    const edDecision = {
      prompt_type: PROMPT_TYPES.ENDING,
      move: "SOFT_DRIFT",
      emotion: "calm",
      tension: 30,
      target_chars: 500,
      angle: "配信の締め",
      handoff_hook: "",
      handoff_action: edHandoffCue.action,
      handoff_feeling: edHandoffCue.feeling,
      next_entry_hint: "",
      handoff_mode: "soft_drift",
      spontaneous_move: "",
      previous_hooks: edHandoffCue.hooks,
      topic_hint: "",
    };

    const { summary: edSummary, lastSentence: edLast } = extractRecentContext(recentBlock);

    const edBlock = await generateLongBlock({
      callLlm,
      decision: edDecision,
      memory: lastMemory,
      recentSummary: edSummary,
      recentHooksStr: "",
      lastSentence: edLast,
      topicFlow: null,
      styleTexts: maskStyleFragments(edStyle.texts),
      section: "ending",
      existingItems: items,
    });

    console.log(`[v3] ED結果: ${edBlock.blockText.length}chars accepted:${edBlock.acceptedLines.length}`);
    if (edBlock.rejectedIssues?.length) {
      console.log(`[v3] ED inspect警告: ${edBlock.rejectedIssues.map(r => r.issues.join(",")).join("; ")}`);
    }
    if (edBlock.acceptedLines.length) {
      items.push(...buildScriptItemsFromBlock({
        lines: edBlock.acceptedLines,
        memory: lastMemory,
        decision: edDecision,
        transition: null,
        blockId: `b${String(streamState.blockCount + 1).padStart(3, "0")}`,
        prompt: edBlock.prompt,
        raw: edBlock.raw,
        blockText: edBlock.blockText,
        startIndex: items.length,
      }));
    }
    logLlm("ending", { chars: edBlock.blockText.length, memoryId: lastMemory.id });
  }

  console.log(`[v3] ── 生成完了 total=${items.length}blocks memories=${streamState.usedMemoryIds.size}種`);
  logLlm("done", {
    totalLines: items.length,
    totalBlocks: streamState.blockCount + 1,
    usedMemories: streamState.usedMemoryIds.size,
  });

  if (!items.length) throw new Error("Script v3 generated no usable lines");
  for (const item of items) {
    if (item.text) item.text = item.text.replace(/僕|俺/g, "私");
  }
  onProgress({ progress: 100, label: `Done: ${items.length} blocks` });
  return items.slice(0, targetLines);
}

function isLenientAcceptableBlock(text, existingItems = []) {
  const s = String(text || "").replace(/\s+/g, "").trim();
  if (s.length < 80 || s.length > 1600) return false;
  if (/[�]|縺|繧|郢|邵|譁|鬩|驍|隴|髫/.test(s)) return false;
  if (/<think>|AsanAI|Context:|Draft:|\/no_think/i.test(s)) return false;
  if (/[头这么吗吧发现实过对说时间]|那种/.test(s)) return false;
  if (/元ネタ|料理法|制御情報|プロンプト|文体サンプル|場面役割|文体特徴/.test(s)) return false;
  const normalized = s.replace(/[、。！？!?]/g, "");
  return !existingItems.some(item => String(item.text || "").replace(/\s+/g, "").replace(/[、。！？!?]/g, "") === normalized);
}

function inspectEssaySignals(text) {
  const value = String(text || "");
  const compact = value.replace(/\s+/g, "");
  const landing = compact.slice(-120);
  const signals = [];
  const essayPhraseRe = /今でも覚えて|鮮明に残|妙に残|記憶に残|感覚だけが残|そんな気がする|現実味がなかった|一番鮮明|思い出すと/g;
  const essayPhraseLandingRe = /今でも覚えて|鮮明に残|妙に残|記憶に残|感覚だけが残|そんな気がする|現実味がなかった|一番鮮明|思い出すと/;
  const matches = value.match(essayPhraseRe) || [];

  if (essayPhraseLandingRe.test(landing)) {
    signals.push("essay_landing");
  }
  if (matches.length >= 2) {
    signals.push("essay_phrase_repeat");
  }
  if (/意味|証拠|記録してる|現実感|関係性|未完成感|重み|特別/.test(landing)) {
    signals.push("meaningful_landing");
  }
  if (/ということなのかもしれない|という意味で|の背景には|を考えさせられる|と向き合う/.test(landing)) {
    signals.push("essay_landing");
  }
  return [...new Set(signals)];
}

function inspectAngleCompliance(text, decision = {}) {
  const value = String(text || "");
  const slot = String(decision.angle_slot || "").toUpperCase();
  const issues = [];

  if (!slot) return issues;
  if (slot === "PERSON_REACTION") {
    if (!/友達|友人|親|母|父|先生|店員|店員さん|家族|おばあちゃん|おじいちゃん|おじさん|お兄さん|お姉さん|クラスメイト|隣の人|誰か|コメント/.test(value)) {
      issues.push("angle_person_missing");
    }
    if (!/言った|聞いた|笑った|黙った|見てた|見ている|首をかしげ|渡した|受け取った|止まった|困った顔|小声|頷|うなず|突っ込|反応|顔して/.test(value)) {
      issues.push("angle_reaction_missing");
    }
  } else if (slot === "PLACE_SHIFT") {
    if (!/玄関|部屋|店|店内|レジ|コンビニ|公園|校門|学校|教室|廊下|台所|キッチン|帰り道|駅|車内|ホテル|ロビー|旅先|角|奥|手前|隣|横|窓|棚/.test(value)) {
      issues.push("angle_place_missing");
    }
  } else if (slot === "BODY_FEEL") {
    if (!/手|指|喉|肩|足|膝|背筋|姿勢|息|服|荷物|重|冷た|痛|熱|温|歩|持つ|握|触/.test(value)) {
      issues.push("angle_body_missing");
    }
  } else if (slot === "AFTER_SCENE") {
    if (!/帰って|帰宅|その後|あとで|翌日|明日|片付け|しまっ|カバンの中|袋の中|置い|残っ|見返/.test(value)) {
      issues.push("angle_after_missing");
    }
  } else if (slot === "CURRENT_SELF") {
    if (!/今|コメント|画面|配信|手元|喉|水|音|マイク|カメラ|話して|見てる/.test(value)) {
      issues.push("angle_current_missing");
    }
  } else if (slot === "OBJECT_DETAIL") {
    if (!/音|匂|重|硬|冷た|温|手触り|触|置|形|色|袋|箱|容器|パック|棚|レシート|紙|スマホ|冷蔵庫|ポーチ|靴|椅子|机/.test(value)) {
      issues.push("angle_object_missing");
    }
  } else if (slot === "MICRO_CONFLICT") {
    if (!/のに|けど|なのに|くせに|はずなのに|いらない|やめ|でも|矛盾|変|おかしい/.test(value)) {
      issues.push("angle_conflict_missing");
    }
  } else if (slot === "UNNECESSARY_DETAIL") {
    if (!/別に|どうでもいい|意味ない|なぜか|妙に|気になる|こだわ/.test(value)) {
      issues.push("angle_unnecessary_missing");
    }
  } else if (slot === "SELF_TSUKKOMI") {
    if (!/なんで|意味ある|自分でも|いやいや|ツッコ|馬鹿|アホ|やばい/.test(value)) {
      issues.push("angle_tsukkomi_missing");
    }
  } else if (slot === "CURRENT_COMPARISON") {
    if (!/今なら|今は|あの時|当時|昔|前は|今だったら|あの頃/.test(value)) {
      issues.push("angle_comparison_missing");
    }
  }

  return issues;
}

// ─── Helpers ──────────────────────────────────────

async function resolveTopicFlowForMemory(memory) {
  try {
    const query = memory.episode.slice(0, 150);
    const candidates = await retrieveTopicFlow(query, 3);
    return pickTopicFlow(candidates);
  } catch {
    return null;
  }
}

function pickTopicFlow(candidates) {
  if (!candidates?.length) return null;
  const usable = candidates.filter(c => {
    if (typeof c.score === "number" && c.score < 0.32) return false;
    const text = `${c.topic || ""} ${c.handling || ""}`;
    if (/関係性|感謝|企画|節目|コメント欄|サポート/.test(text)) return false;
    return true;
  });
  if (!usable.length) return null;
  return usable[Math.floor(Math.random() * Math.min(usable.length, 2))];
}

async function resolveStyle(query, memory, topK) {
  try {
    const results = await retrieveSpeakingStyle(query, Math.max(topK * 3, topK));
    if (results.length) {
      const texts = results
        .filter(r => !isNoisyStyleSource(r))
        .flatMap(r => extractStyleFragments(r.text))
        .filter(text => !isNoisyStyleFragment(text));
      if (texts.length) {
        logLlm("style_hit", { memoryId: memory?.id, ids: results.map(r => r.id), usable: texts.length });
        return { texts: texts.slice(0, topK), ids: results.map(r => r.id) };
      }
      logLlm("style_filtered", { memoryId: memory?.id, ids: results.map(r => r.id) });
    }
  } catch (error) {
    logLlm("style_fallback", {
      memoryId: memory?.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { texts: FALLBACK_FEW_SHOT, ids: [] };
}

function isNoisyStyleFragment(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  if (value.length < 4 || value.length > 80) return true;
  if (/[A-Za-z0-9]/.test(value)) return true;
  if (STYLE_FOREIGN_RE.test(value)) return true;
  if (STYLE_GENRE_NOISE_RE.test(value)) return true;
  if (STYLE_PARTIAL_TAIL_RE.test(value)) return true;
  if (STYLE_PROPER_NOUN_RE.test(value)) return true;
  if (!STYLE_RHYTHM_RE.test(value)) return true;
  if (!hasEarlyStyleCue(value)) return true;
  if (/負け|敗北|終わってる|詰ん/.test(value)) return true;
  return false;
}

function isNoisyStyleSource(result) {
  return /takkuu|kaidan|horror/i.test(String(result?.source_id || ""));
}

function extractStyleFragments(text) {
  return String(text || "")
    .split(/[。！？!?、,\n]/)
    .map(fragment => fragment.trim())
    .filter(fragment => fragment.length >= 4 && fragment.length <= 36);
}

function hasEarlyStyleCue(text) {
  const match = String(text || "").match(STYLE_RHYTHM_RE);
  return !!match && match.index <= 6;
}

function loadMemories(count) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return db.prepare(`
      select id, keywords, episode from memory
      where episode != ''
      order by random()
      limit ?
    `).all(count).map(row => ({ id: String(row.id), keywords: row.keywords || "[]", episode: String(row.episode) }));
  } finally {
    db.close();
  }
}

async function loadEndingHints() {
  try {
    const profile = JSON.parse(await readFile(path.join(DATA_DIR, "style-profile.json"), "utf8"));
    return (profile.topEndings || [])
      .map(entry => entry.ending)
      .filter(ending => /[ぁ-ん]/.test(ending) && !/（|笑/.test(ending))
      .slice(0, 8);
  } catch {
    return [];
  }
}

async function callLlm(options) {
  if (process.env.RADIO_SCRIPT_LLM_BACKEND === "ollama") {
    return await callOllama(options);
  }
  try {
    return await callLlamaServer(options);
  } catch (error) {
    _llamaReady = false;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[v3] llama-server request failed: ${message}`);
    logLlm("llama_error", { error: message, llamaServerUrl: LLAMA_SERVER_URL, model: activeScriptModel || defaultModel() });
    throw error;
  }
}

async function callLlamaServer({ messages, temperature = 0.7, topP = 0.85, repeatPenalty = 1.2, maxTokens = 200, timeoutMs = 120000 }) {
  await waitForLlamaServer({ attempts: Number(process.env.LLAMA_SERVER_WAIT_ATTEMPTS || 30) });
  const effectiveTimeoutMs = Math.max(
    Number(timeoutMs) || 0,
    Number(process.env.RADIO_SCRIPT_LLAMA_TIMEOUT_MS || 600000),
  );
  const response = await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      temperature,
      top_p: topP,
      repeat_penalty: repeatPenalty,
      max_tokens: maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(effectiveTimeoutMs),
  });
  if (!response.ok) throw new Error(`llama-server HTTP ${response.status}`);
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || "";
}

async function callOllama({ messages, temperature = 0.7, topP = 0.85, repeatPenalty = 1.2, maxTokens = 200, timeoutMs = 120000 }) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: activeScriptModel || defaultModel(),
      messages,
      stream: false,
      options: {
        temperature,
        top_p: topP,
        repeat_penalty: repeatPenalty,
        num_predict: maxTokens,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Ollama HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const payload = await response.json();
  return payload.message?.content || payload.response || "";
}

let _llamaReady = false;
async function waitForLlamaServer({ attempts = 30 } = {}) {
  if (_llamaReady) return;
  const totalAttempts = Math.max(1, Number(attempts) || 3);
  for (let i = 0; i < totalAttempts; i++) {
    try {
      const r = await fetch(`${LLAMA_SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const body = await r.json().catch(() => ({}));
        if (body.status === "ok") { _llamaReady = true; return; }
      }
    } catch {}
    if (i === 0) console.log("llama-server: waiting for model load...");
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`llama-server did not become ready within ${totalAttempts * 2}s`);
}

function logLlm(type, payload) {
  if (process.env.RADIO_LOG_LLM === "0") return;
  const entry = { at: new Date().toISOString(), type, ...payload };
  void appendFile(SCRIPT_LLM_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8").catch(() => {});
}

function extractRecentContext(blockText) {
  if (!blockText) return { summary: "", lastSentence: "" };
  const text = String(blockText);
  const sentences = text.split(/(?<=[。！？])/).filter(s => s.trim());
  const lastSentence = sentences.length ? sentences[sentences.length - 1].trim().slice(0, 80) : "";
  const summary = text.slice(0, 120);
  return { summary, lastSentence };
}

function maskStyleFragments(texts) {
  return (texts || [])
    .flatMap(text => String(text || "").split(/[。！？!?、,\n]/))
    .map(text => text.replace(/[ァ-ヶー]{3,}/g, "").trim())
    .filter(s => s.length >= 4 && s.length <= 36 && !isNoisyStyleFragment(s))
    .slice(0, 3);
}

// ─── Kaidan helpers ──────────────────────────────

async function generateKaidanBlock({ callLlm, prompt, targetChars, existingItems = [] }) {
  const maxTokens = Math.ceil(targetChars * 1.2);
  const raw = await callLlm({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.65,
    topP: 0.85,
    repeatPenalty: 1.12,
    maxTokens,
    timeoutMs: 180000,
  });
  let blockText = cleanBlockText(raw);
  const issues = inspectLine({ line: blockText, memory: null, accepted: [], existingItems });
  if (issues.length) {
    console.log(`[v3] kaidan品質チェック: ${issues.join(", ")} → クリーニング`);
    if (issues.includes("chinese") || issues.includes("foreign_text")) {
      blockText = blockText.replace(/[烟收纳头这么吗吧发现实过对说时间捞别轻确那种那種特别轻声确声啊]/g, "");
    }
  }
  return { prompt, raw, blockText, qualityIssues: issues };
}

function shouldInsertKaidanMain(blockCount, remainingBlocks) {
  return blockCount >= 4 && remainingBlocks >= 3;
}

function buildPreviousTalkHint(recentBlock) {
  const hooks = extractTransitionHooks(recentBlock).slice(0, 5);
  if (!hooks.length) return "";
  return `直前の雑談では「${hooks.join("、")}」あたりの生活話をしていた`;
}

function extractResearchSegment(text, liveResearch) {
  const markers = [
    "今日のお便り",
    "調べてたやつ",
    "調べてた話",
    liveResearch?.title,
  ].filter(Boolean);
  for (const marker of markers) {
    const idx = String(text).indexOf(marker);
    if (idx >= 0) return String(text).slice(idx);
  }
  return String(text);
}

function extractKaidanHooks({ text, liveResearch, excludeHooks = [] }) {
  const exclude = new Set((excludeHooks || []).map(String));
  const hooks = extractTransitionHooks(text);
  const titleHooks = extractTransitionHooks(
    `${liveResearch?.title || ""} ${(liveResearch?.shortText || "").slice(0, 400)}`
  );
  return [...new Set([...hooks, ...titleHooks])]
    .filter(h => h && !exclude.has(h))
    .slice(0, 8);
}

function buildKaidanClosingTheme({ dominantLifeHook = "", researchCore = "" }) {
  const joined = `${dominantLifeHook} ${researchCore}`;
  if (/道|駅|電車|トンネル|地蔵|橋|場所|通/.test(joined)) {
    return "普段通っている場所の見え方が少し変わる";
  }
  if (/コンビニ|レジ|買い物|食べ物|部屋|家|冷蔵庫/.test(joined)) {
    return "いつもの手元の動作に、知らない背景が混ざる";
  }
  if (/夜|怖|冷|暗/.test(joined)) {
    return "理由を知らないまま、なんとなく気になる";
  }
  return "確認したくなる感じが、少し残る";
}

function buildDominantLifeHook(items) {
  const memoryItems = (items || []).filter(i => i.source_type === "memory");
  const recentText = memoryItems.slice(-6).map(i => i.text).join(" ");
  if (/冷蔵庫|プリン|ヨーグルト|アイス|冷凍/.test(recentText)) return "冷蔵庫を開けて中身を確認して安心する";
  if (/レジ袋|レシート|コンビニ|ローソン|セブン/.test(recentText)) return "買ったものを手元で確認してしまう";
  if (/スマホ|収納|無印|ロフト|机/.test(recentText)) return "物の位置や手触りを確かめて落ち着く";
  if (/道|歩|帰|坂|駅/.test(recentText)) return "歩いている時にふと周りが気になる";
  if (/唐揚げ|昼|弁当|食|パック/.test(recentText)) return "食べ物を手に取って匂いを確認する";
  const lastAnchor = memoryItems.slice(-1)[0]?.anchor || "";
  if (lastAnchor && lastAnchor !== "-") return `${lastAnchor}を手元で確認する`;
  return "同じものをつい確認してしまう";
}

function buildResearchCore(liveResearch) {
  if (!liveResearch) return "";
  const title = liveResearch.title || "";
  const mainText = String(liveResearch.mainText || "");
  const shortText = String(liveResearch.promptText || liveResearch.shortText || "").slice(0, 400);
  const sentences = [...mainText.split(/(?<=[。！？])/), ...shortText.split(/(?<=[。！？])/)].filter(s => s.trim().length >= 15);
  const core = sentences.find(s => /伝承|伝わ|語ら|言い伝|霊|亡|呪|祟|七人|冥婚|トンネル/.test(s));
  if (core) return `${title}は、${core.trim().slice(0, 60)}`;
  return title;
}

function pickTopConcreteObjects(items) {
  const allText = (items || []).filter(i => i.source_type === "memory").map(i => i.text).join(" ");
  const nouns = [];
  const patterns = [
    /冷蔵庫/, /ダンベル/, /プリン/, /アイス/, /レシート/, /コンビニ/, /セブン/, /ファミマ/,
    /ローソン/, /スマホ/, /弁当/, /唐揚げ/, /味噌汁/, /カフェラテ/, /バウム/, /ルンバ/,
    /掃除機/, /段ボール/, /ハサミ/, /ラベル/, /収納ケース/, /無印/, /袋/, /玉ねぎ/,
    /布団/, /窓/, /店員/, /レジ/, /紙袋/, /スプーン/, /ヨーグルト/, /缶/,
    /マグカップ/, /コーヒー/, /イヤホン/, /充電器/, /電子レンジ/, /洗濯機/,
  ];
  for (const pat of patterns) {
    const m = allText.match(pat);
    if (m && !nouns.includes(m[0])) nouns.push(m[0]);
    if (nouns.length >= 5) break;
  }
  if (nouns.length < 2) {
    const anchors = (items || []).filter(i => i.anchor && i.anchor !== "-").map(i => i.anchor);
    for (const a of anchors) {
      if (!nouns.includes(a)) nouns.push(a);
      if (nouns.length >= 3) break;
    }
  }
  return nouns;
}

function inferLastMood(items) {
  const lastTexts = (items || []).slice(-3).map(i => i.text).join(" ");
  if (/夜中|深夜|眠/.test(lastTexts)) return "夜中の生活のしょうもなさ";
  if (/疲|だる|めんどい/.test(lastTexts)) return "だるくてゆるい";
  if (/楽し|ワクワク|嬉/.test(lastTexts)) return "ちょっと楽しかった余韻";
  if (/怖|不安|ぞっと/.test(lastTexts)) return "少しだけゾワッとした後の静けさ";
  return "なんとなくぼんやりした雑談の終わり";
}

function buildHandoffCue(recentBlock) {
  const text = String(recentBlock || "");
  const hooks = extractTransitionHooks(text).slice(0, 5);
  const sentences = text.split(/(?<=[。！？])/).filter(Boolean);
  const tailSentences = sentences.slice(-3).join("");
  return {
    hooks,
    action: inferActionPhrase(tailSentences) || "手元を確認する",
    feeling: inferFeelingPhrase(tailSentences),
    openLoop: (sentences.slice(-1)[0] || "").trim().slice(0, 60),
  };
}

function inferActionPhrase(text) {
  const s = String(text || "");
  if (/開け|確認|見る|覗|チェック/.test(s)) return "中身を確認する";
  if (/持つ|ぶら下げ|抱え|握/.test(s)) return "手に持ったまま動く";
  if (/置く|置いた|戻し|しまう|片付/.test(s)) return "手元に置く";
  if (/歩|走|帰|向か|出/.test(s)) return "歩いて移動する";
  if (/食べ|飲|噛|口|味/.test(s)) return "口に入れる";
  if (/触|拭|押|撫|めくる|剥が/.test(s)) return "手で触る";
  if (/座|寝|横にな|立つ|起き/.test(s)) return "体勢を変える";
  if (/見て|眺め|映|写|画面/.test(s)) return "じっと見つめる";
  if (/聞|音|鳴|響/.test(s)) return "音を聞く";
  if (/書|描|打|入力|メモ/.test(s)) return "手を動かして書く";
  if (/買|選|レジ|会計|払/.test(s)) return "店で何か選ぶ";
  if (/着|脱|被|履|袖/.test(s)) return "服を着替える";
  if (/洗|拭|磨|掃除/.test(s)) return "きれいにする";
  if (/待|並|止ま/.test(s)) return "じっと待つ";
  if (/探|捜|見つ/.test(s)) return "何か探す";
  if (/思い出|覚え|忘/.test(s)) return "ふと思い出す";
  if (/笑|泣|驚|怒/.test(s)) return "表情が変わる";
  if (/話|言|喋|呟/.test(s)) return "誰かに話しかける";
  // fallback: extract last verb-like pattern
  const verbMatch = s.match(/([ぁ-ん]{2,6}(?:た|てた|てる|ちゃった|ない))(?:[。、]|$)/);
  if (verbMatch) return verbMatch[1];
  return "";
}

function inferFeelingPhrase(text) {
  const s = String(text || "");
  if (/安心|落ち着|ほっと/.test(s)) return "少し安心する";
  if (/冷た|ひや|涼/.test(s)) return "ひやっとする";
  if (/気まず|焦|慌|ドキ/.test(s)) return "少し気まずくなる";
  if (/重|だる|疲/.test(s)) return "だるさが残る";
  if (/匂|香|臭/.test(s)) return "匂いが残る";
  if (/暖|温|熱/.test(s)) return "じんわり暖かい";
  if (/静|黙|しーん/.test(s)) return "急に静かになる";
  if (/懐かし|昔|あの頃/.test(s)) return "懐かしい気持ちになる";
  if (/面白|笑|ウケ/.test(s)) return "ちょっとおかしくなる";
  if (/怖|ゾッ|ビク/.test(s)) return "少しゾッとする";
  if (/嬉し|やった/.test(s)) return "ちょっと嬉しい";
  if (/悲し|寂し|切な/.test(s)) return "少し切なくなる";
  if (/不思議|謎|なんで/.test(s)) return "不思議な気持ちになる";
  if (/めんどう|面倒|だるい/.test(s)) return "めんどくさくなる";
  if (/恥ずかし|照/.test(s)) return "ちょっと恥ずかしい";
  if (/美味|うま|おいし/.test(s)) return "美味しさが残る";
  return "なんとなく気になる";
}

const ABSTRACT_SENSATION_RE = /感覚|感触|違和感|安心感|気配|余韻|現実感|距離感|生活感|空気感|手触り|妙に/g;
const ABSTRACT_ENDING_RE = /(感覚がある|感触が残る|妙に残る|妙に気になる|気になる|引っかかる|感じがする|残っている)。?$/;

function countAbstractSensation(text) {
  const s = String(text || "");
  const matches = s.match(ABSTRACT_SENSATION_RE);
  return matches ? matches.length : 0;
}

function hasAbstractEnding(text) {
  return ABSTRACT_ENDING_RE.test(String(text || "").trim());
}

function shouldRewriteAbstract(text) {
  return countAbstractSensation(text) >= 3 || hasAbstractEnding(text);
}

function inspectContinuity(blockText, handoffCue) {
  const issues = [];
  if (!handoffCue) return issues;
  const trimmed = String(blockText || "").trim();
  if (/^(さて|では|それでは|皆さん|今日は|本日は)/.test(trimmed)) {
    issues.push("starts_like_new_topic");
  }
  const prevHooks = (handoffCue.hooks || []).slice(0, 4);
  const blockStart = trimmed.slice(0, 100);
  const hasConnection = prevHooks.some(w => blockStart.includes(w));
  if (!hasConnection && !/さっき|前の|続き|それで|あ、|で、|ていうか/.test(blockStart)) {
    issues.push("weak_handoff");
  }
  return issues;
}

function summarizeRecentMemoryItems(items) {
  const memoryItems = (items || []).filter(i => i.source_type === "memory");
  if (!memoryItems.length) return "";
  const lastFew = memoryItems.slice(-4);
  const topics = lastFew.map(i => (i.anchor && i.anchor !== "-") ? i.anchor : "").filter(Boolean);
  return topics.length ? `生活雑談: ${topics.join("、")}` : "普通の雑談";
}

// ─── CLI ──────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : "";
  };
  const SECONDS_PER_LINE = 12;
  const minutes = Number(valueOf("--minutes") || 0);
  const turns = Number(valueOf("--turns") || 0) || (minutes ? Math.max(12, Math.round((minutes * 60) / SECONDS_PER_LINE)) : DEFAULT_TARGET_LINES);
  const model = valueOf("--model") || defaultModel();

  const items = await generateScriptV3({
    turns,
    model,
    onProgress: ({ label }) => process.stderr.write(`${label}\n`),
  });

  const jsonl = items.map(item => JSON.stringify({ number: item.number, memoryId: item.memoryId, prompt_type: item.prompt_type, text: item.text })).join("\n") + "\n";
  process.stdout.write(jsonl);
  console.error(`v3 done: ${items.length} lines`);
}
