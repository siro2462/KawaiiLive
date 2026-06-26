import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_KAIDAN_DIR = path.join(process.cwd(), "data", "kaidan");
const MAX_SHORT_TEXT = 3000;

export async function selectRandomKaidanResearch() {
  const dir = process.env.KAIDAN_DIR || DEFAULT_KAIDAN_DIR;
  const files = await collectKaidanFiles(dir);
  if (!files.length) return null;

  const chosen = files[Math.floor(Math.random() * files.length)];
  const rawText = await readFile(chosen, "utf8");
  if (!rawText.trim()) return null;

  const basename = path.basename(chosen, path.extname(chosen));
  const title = inferTitle(basename, rawText);

  return {
    id: sanitizeId(basename),
    title,
    filePath: chosen,
    rawText,
    shortText: cleanKaidanTextForPrompt(rawText).slice(0, MAX_SHORT_TEXT),
    opText: "",
    opHooks: [],
    mainUsed: false,
    mainText: "",
    mainHooks: [],
    edText: "",
    edHooks: [],
  };
}

async function collectKaidanFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter(name => /\.(txt|md)$/i.test(name))
    .map(name => path.join(dir, name));
}

const BAD_TITLES = new Set([
  "タイトル", "サブタイトル", "中心テーマ", "リサーチ結果",
  "本文", "概要", "まとめ", "参考", "備考", "メモ",
]);

function inferTitle(basename, rawText) {
  const text = String(rawText || "");

  const dbTitle = text.match(/DBタイトル[:：]\s*(.+)/);
  if (dbTitle?.[1] && !BAD_TITLES.has(dbTitle[1].trim())) return cleanTitle(dbTitle[1]);

  const headings = [...text.matchAll(/^#{1,3}\s*(?:#?\d+\s*)?(.+)$/gm)];
  for (const match of headings) {
    const candidate = cleanTitle(match[1]);
    if (candidate && !BAD_TITLES.has(candidate)) return candidate;
  }

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const line of lines.slice(0, 5)) {
    const candidate = cleanTitle(line);
    if (candidate && !BAD_TITLES.has(candidate) && !/^(DBタイトル|調査ステータス|source_url|ソースURL|出典|調査日|カテゴリ|タグ)[:：]/.test(line)) {
      return candidate;
    }
  }

  return cleanTitle(basename);
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/^#+\s*/, "")
    .replace(/^#?\d+\s*/, "")
    .trim()
    .slice(0, 80);
}

function cleanKaidanTextForPrompt(rawText) {
  return String(rawText || "")
    .split(/\r?\n/)
    .filter(line => {
      const trimmed = line.trim();
      if (/^(DBタイトル|調査ステータス|source_url|ソースURL|出典|調査日|カテゴリ|タグ)[:：]/.test(trimmed)) return false;
      if (/^https?:\/\//.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function sanitizeId(basename) {
  return basename
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, 60) || "kaidan";
}
