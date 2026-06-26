import { buildPromptByType } from "./prompt.mjs";
import { cleanBlockText, parseBlockToParagraphs } from "./parser.mjs";
import { inspectAndAcceptBlockLines } from "./inspector.mjs";
import { BLOCK_CHAR_RANGES } from "./constants.mjs";

export async function generateLongBlock({
  callLlm,
  decision,
  memory,
  recentSummary = "",
  recentHooksStr = "",
  lastSentence = "",
  topicFlow,
  styleTexts,
  section,
  existingItems = [],
  planContext,
}) {
  const prompt = buildPromptByType({
    decision,
    memory,
    recentSummary,
    recentHooksStr,
    lastSentence,
    topicFlow,
    styleTexts,
    section,
    planContext,
  });

  const [defaultMin] = BLOCK_CHAR_RANGES[decision.prompt_type] || [400, 700];
  const targetChars = decision.target_chars || defaultMin;
  const maxTokens = Math.ceil(targetChars * 1.2);

  const raw = await callLlm({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.65,
    topP: 0.85,
    repeatPenalty: 1.12,
    maxTokens,
    timeoutMs: 180000,
  });

  const blockText = cleanBlockText(raw);
  const paragraphs = parseBlockToParagraphs(raw);

  const { accepted, rejected } = inspectAndAcceptBlockLines({
    lines: paragraphs,
    memory,
    existingItems,
    decision,
  });

  return { prompt, raw, blockText, paragraphs, acceptedLines: accepted, rejectedIssues: rejected };
}
