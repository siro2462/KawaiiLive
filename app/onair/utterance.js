import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORE_PATH = process.env.RADIO_MEMORY_JSON || path.join(PROJECT_ROOT, "data", "logs", "radio-memory.json");
const MAX_UTTERANCES = 200;
const MAX_SESSION_SUMMARIES = 50;

let store;

export async function initializeUtteranceStore() {
  if (store) return store;
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  store = await readStore();
  return store;
}

export async function recordUtterance(entry) {
  const nextStore = await initializeUtteranceStore();
  nextStore.utterances.push({
    created_at: entry.createdAt || new Date().toISOString(),
    topic: entry.topic || "",
    text: entry.text || "",
    memory_id: entry.memoryId || "",
    move: entry.move || "",
    tangent_seed: entry.tangentSeed || "",
    source_mode: entry.sourceMode || "",
  });
  nextStore.utterances = nextStore.utterances.slice(-MAX_UTTERANCES);
  await saveStore(nextStore);
}

export async function recentUtteranceTexts(limit = 5) {
  const nextStore = await initializeUtteranceStore();
  return nextStore.utterances.slice(-limit).map((entry) => entry.text);
}

export async function loadRuntimeState() {
  const nextStore = await initializeUtteranceStore();
  return {
    current_mood: nextStore.runtime_state.current_mood || "flat",
    current_thread: nextStore.runtime_state.current_thread || "",
  };
}

export async function saveRuntimeState(nextState) {
  const nextStore = await initializeUtteranceStore();
  nextStore.runtime_state = {
    ...nextStore.runtime_state,
    ...nextState,
    updated_at: new Date().toISOString(),
  };
  await saveStore(nextStore);
}

export async function saveSessionSummary(history) {
  const lines = history.slice(-12).map((item) => item.topic || item.text).filter(Boolean);
  if (!lines.length) return;
  const summary = `recent topics: ${[...new Set(lines)].slice(-8).join(" / ")}`;
  const nextStore = await initializeUtteranceStore();
  nextStore.session_summaries.push({
    created_at: new Date().toISOString(),
    summary,
  });
  nextStore.session_summaries = nextStore.session_summaries.slice(-MAX_SESSION_SUMMARIES);
  await saveStore(nextStore);
}

async function readStore() {
  try {
    return normalizeStore(JSON.parse(await readFile(STORE_PATH, "utf8")));
  } catch {
    return normalizeStore({});
  }
}

async function saveStore(nextStore) {
  await writeFile(STORE_PATH, `${JSON.stringify(normalizeStore(nextStore), null, 2)}\n`, "utf8");
}

function normalizeStore(value) {
  return {
    version: 1,
    runtime_state: {
      current_mood: value?.runtime_state?.current_mood || "flat",
      current_thread: value?.runtime_state?.current_thread || "",
      updated_at: value?.runtime_state?.updated_at || "",
    },
    utterances: Array.isArray(value?.utterances) ? value.utterances : [],
    session_summaries: Array.isArray(value?.session_summaries) ? value.session_summaries : [],
  };
}
