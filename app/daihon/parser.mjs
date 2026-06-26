export function parseBlockToParagraphs(raw) {
  const cleaned = cleanBlockText(raw);
  if (cleaned.length < 10) return [];
  return [normalizeGeneratedText(cleaned)];
}

function normalizeGeneratedText(text) {
  return String(text || "")
    .replace(/\r?\n{2,}/g, "。")
    .replace(/\r?\n/g, "、")
    .replace(/、{2,}/g, "、")
    .replace(/。{2,}/g, "。")
    .trim();
}

export function cleanBlockText(raw) {
  return String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```[a-z]*|```$/gim, "")
    .replace(/^\s*[-*・]\s*/gm, "")
    .replace(/^\s*\d+[.)、．]\s*/gm, "")
    .replace(/^出力[:：]?\s*$/gm, "")
    .replace(/^本文[:：]?\s*$/gm, "")
    .replace(/^【.*】\s*$/gm, "")
    .trim();
}
