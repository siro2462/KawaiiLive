import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { IrodoriWorkerClient, splitSpeechText } from "./tts.js";
import { loadBroadcastScript, loadDbPlanById, prepareBroadcastScript, saveBroadcastScript } from "./script.js";
import { initializeUtteranceStore, loadRuntimeState, recordUtterance, saveRuntimeState, saveSessionSummary } from "./utterance.js";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = path.resolve(APP_DIR, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const LOG_PATH = path.join(DATA_DIR, "logs", "generated-talk.jsonl");
const STATE_PATH = path.join(DATA_DIR, "logs", "radio-state.json");
const TARGET_QUEUE = 10;
const SESSION_MS = 10 * 60 * 1000;
const RADIO_STATE_VERSION = 3;

export class RadioRuntime {
  constructor() {
    this.state = "stopped";
    this.queue = [];
    this.currentTopic = null;
    this.currentText = "";
    this.currentItem = null;
    this.history = [];
    this.spokenHistory = [];
    this.player = null;
    this.safeStopRequested = false;
    this.producerRunning = false;
    this.playerRunning = false;
    this.error = "";
    this.progress = 0;
    this.progressLabel = "Stopped";
    this.startedAt = null;
    this.sessionTimer = null;
    this.sourceMode = "chatter";
    this.scriptPlan = null;
    this.scriptPreparing = false;
    this.scriptProgress = 0;
    this.scriptProgressLabel = "Script idle";
    this.lastSpokenScriptNumber = 0;
    this.companionState = { current_mood: "flat", current_thread: "" };
    this.speaking = false;
  }

  snapshot() {
    return {
      state: this.state,
      queueLength: this.queue.length,
      currentTopic: this.currentTopic?.title || "",
      currentText: this.currentText,
      speaking: this.speaking,
      error: this.error,
      audioReady: this._isAudioReady(),
      progress: this.progress,
      progressLabel: this.progressLabel,
      currentTalk: this.currentItem ? talkSnapshot(this.currentItem) : null,
      recentTalk: this.spokenHistory.slice(-40).map((item) => ({
        createdAt: item.createdAt || "",
        topic: item.topic || "",
        text: item.text,
        memoryId: item.memoryId || "",
        tangentSeed: item.tangentSeed || "",
        flowId: item.flowId || "",
        move: item.move || "",
        scriptNumber: item.scriptNumber || 0,
      })),
      remainingSeconds: this.startedAt ? Math.max(0, Math.ceil((SESSION_MS - (Date.now() - this.startedAt)) / 1000)) : Math.ceil(SESSION_MS / 1000),
      sourceMode: this.sourceMode,
      pendingComments: 0,
      script: {
        liveId: this.scriptPlan?.liveId || 0,
        title: this.scriptPlan?.title || "",
        createdAt: this.scriptPlan?.createdAt || "",
        model: this.scriptPlan?.model || "",
        index: this.scriptPlan?.index || 0,
        queuedUntil: this.scriptPlan?.index || 0,
        currentNumber: this.currentItem?.result?.scriptNumber || 0,
        spokenNumber: this.lastSpokenScriptNumber,
        total: this.scriptPlan?.items?.length || 0,
        preparing: this.scriptPreparing,
        synthesizing: !!this._synthWorker,
        progress: this.scriptProgress,
        label: this.scriptProgressLabel,
      },
      scriptPreparing: this.scriptPreparing,
    };
  }

  _isAudioReady() {
    const items = this.scriptPlan?.items;
    if (!items?.length) return false;
    return items.every((item) => !!item.audioPath);
  }

  async start(_topicTitles = [], _sourceMode = "chatter", { liveId = 0 } = {}) {
    console.log(`[radio] start() called; state=${this.state}, liveId=${liveId || "latest"}`);
    if (this.state === "stopping" && !this.playerRunning && !this.producerRunning && !this.player) {
      this.finishStop();
    }
    if (this.state !== "stopped" && this.state !== "error") {
      return this.snapshot();
    }

    this.state = "starting";
    this.progress = 5;
    this.progressLabel = "Loading script";
    this.error = "";
    this.safeStopRequested = false;
    this.queue = [];
    this.history = [];
    this.spokenHistory = [];
    this.lastSpokenScriptNumber = 0;
    this.currentText = "";
    this.currentItem = null;
    this.sourceMode = "chatter";

    await initializeUtteranceStore();
    this.companionState = await loadRuntimeState();
    this.scriptPlan = liveId ? loadDbPlanById(liveId) : await loadBroadcastScript();

    if (!this.scriptPlan?.items?.length) throw new Error("No prepared script is available.");
    const missing = this.scriptPlan.items.filter((item) => !item.audioPath);
    if (missing.length) throw new Error(`Audio not ready: ${missing.length} lines missing; run Synthesize first`);

    const savedState = await loadRadioState();
    this.history = savedState.history || [];
    this.currentTopic = { title: this.scriptPlan.title || "Live script" };
    await this.fillQueue();

    this.state = "running";
    this.startedAt = Date.now();
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => void this.requestSafeStop(), SESSION_MS);
    this.progress = 100;
    this.progressLabel = "Running";
    void this.produceLoop();
    void this.playLoop();
    return this.snapshot();
  }

  async requestSafeStop() {
    if (this.state === "stopped") return this.snapshot();
    this.safeStopRequested = true;
    this.state = "stopping";
    if (!this.playerRunning && !this.producerRunning && !this.player) this.finishStop();
    return this.snapshot();
  }

  async emergencyStop() {
    this.safeStopRequested = true;
    this.queue = [];
    this.player?.kill();
    this.player = null;
    this.finishStop();
    return this.snapshot();
  }

  async produceLoop() {
    if (this.producerRunning) return;
    this.producerRunning = true;
    try {
      while (!this.safeStopRequested) {
        if (this.queue.length < TARGET_QUEUE) {
          const prevLen = this.queue.length;
          await this.enqueueTalk();
          if (this.queue.length === prevLen) {
            this.safeStopRequested = true;
            break;
          }
        } else {
          await sleep(150);
        }
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.producerRunning = false;
    }
  }

  async playLoop() {
    if (this.playerRunning) return;
    this.playerRunning = true;
    try {
      while (true) {
        const item = this.queue.shift();
        if (item) {
          this.currentTopic = item.topic;
          this.currentItem = item;
          await this.playWavWithSubtitles(item.wavPath, item.text);
          if (item.chunkIndex === item.chunkCount - 1) this.rememberSpoken(item);
          this.currentText = "";
          this.currentItem = null;
          continue;
        }
        if (this.safeStopRequested) break;
        await sleep(100);
      }
      this.finishStop();
    } catch (error) {
      this.fail(error);
    } finally {
      this.playerRunning = false;
    }
  }

  async fillQueue() {
    while (this.queue.length < TARGET_QUEUE) {
      const prevLen = this.queue.length;
      await this.enqueueTalk();
      if (this.queue.length === prevLen) break;
      this.progress = this.queue.length === 1 ? 68 : 92;
      this.progressLabel = `Queueing audio ${this.queue.length}/${TARGET_QUEUE}`;
    }
  }

  async enqueueTalk() {
    const scripted = await this.nextScriptedTalk();
    if (scripted) return this.enqueueGeneratedText(scripted);
  }

  async enqueueGeneratedText({ topic, result }) {
    if (!result.audioPath) return;
    const wavPaths = parseAudioPaths(result.audioPath);
    const chunkTexts = splitSpeechText(result.text);
    for (let i = 0; i < wavPaths.length; i++) {
      this.queue.push({
        topic,
        text: chunkTexts[i] ?? result.text,
        fullText: result.text,
        wavPath: wavPaths[i],
        result,
        chunkIndex: i,
        chunkCount: wavPaths.length,
      });
    }
    this.history.push({
      topic: topic.title,
      text: result.text,
      createdAt: new Date().toISOString(),
      memoryId: result.memoryId || "",
      tangentSeed: result.tangentSeed || "",
      flowId: result.flowId || "",
      move: result.move || "",
      scriptNumber: result.scriptNumber || 0,
    });
    await recordUtterance({
      topic: topic.title,
      text: result.text,
      createdAt: new Date().toISOString(),
      memoryId: result.memoryId || "",
      tangentSeed: result.tangentSeed || "",
      move: result.move || "",
      sourceMode: this.sourceMode,
    });
    this.companionState = updateCompanionState(this.companionState, { topic: topic.title, result });
    await saveRuntimeState(this.companionState);
    this.history = this.history.slice(-48);
    await saveRadioState({ history: this.history });
  }

  async nextScriptedTalk() {
    const index = this.scriptPlan?.index || 0;
    if (!this.scriptPlan?.items?.length || index >= this.scriptPlan.items.length) return null;
    const item = this.scriptPlan.items[index];
    this.scriptPlan.index = index + 1;
    await saveBroadcastScript(this.scriptPlan);
    return {
      topic: { title: item.topic || this.scriptPlan.title || "Live script" },
      result: {
        text: item.text,
        audioPath: item.audioPath || "",
        attempt: item.attempt || "db_speech_line",
        move: "SCRIPT",
        memoryId: item.memoryId || "",
        tangentSeed: item.tangentSeed || item.anchor || "",
        flowId: item.flowId || "script_plan",
        scriptNumber: index + 1,
      },
    };
  }

  rememberSpoken(item) {
    const scriptNumber = item.result?.scriptNumber || 0;
    if (scriptNumber) this.lastSpokenScriptNumber = Math.max(this.lastSpokenScriptNumber, scriptNumber);
    this.spokenHistory.push({
      topic: item.topic?.title || item.topic || "",
      text: item.fullText || item.text,
      createdAt: new Date().toISOString(),
      memoryId: item.result?.memoryId || "",
      tangentSeed: item.result?.tangentSeed || "",
      flowId: item.result?.flowId || "",
      move: item.result?.move || "",
      scriptNumber,
    });
    this.spokenHistory = this.spokenHistory.slice(-48);
  }

  async clearTalkLog() {
    this.history = [];
    this.spokenHistory = [];
    this.lastSpokenScriptNumber = 0;
    this.currentText = "";
    this.currentItem = null;
    await saveRadioState({ history: [] });
    await writeFile(LOG_PATH, "", "utf8");
    return this.snapshot();
  }

  async prepareScript(options = {}) {
    if (this.state !== "stopped") throw new Error("Prepare the script while playback is stopped.");
    if (this.scriptPreparing) return this.snapshot();
    this.scriptPreparing = true;
    this.scriptProgress = 10;
    this.scriptProgressLabel = "Preparing script";
    this._scriptAbort = new AbortController();
    try {
      const plan = await prepareBroadcastScript({
        ...options,
        signal: this._scriptAbort.signal,
        onProgress: ({ progress, label }) => {
          this.scriptProgress = progress;
          this.scriptProgressLabel = label;
        },
      });
      this.scriptPlan = plan;
      this.scriptProgress = 100;
      this.scriptProgressLabel = `Script ready: ${plan.items.length} lines`;
    } catch (error) {
      if (error.name === "AbortError") {
        this.scriptProgress = 0;
        this.scriptProgressLabel = "Script generation cancelled";
        return this.snapshot();
      }
      this.error = error.message;
      this.scriptProgress = 0;
      this.scriptProgressLabel = `Script failed: ${error.message}`;
      throw error;
    } finally {
      this.scriptPreparing = false;
      this._scriptAbort = null;
    }
    return this.snapshot();
  }

  async prepareScriptBatch(options = {}) {
    const count = Math.max(1, Math.min(20, Number(options.count || 1)));
    if (count <= 1) return this.prepareScript(options);
    if (this.state !== "stopped") throw new Error("Prepare the script while playback is stopped.");
    if (this.scriptPreparing) return this.snapshot();

    this.scriptPreparing = true;
    this.scriptProgress = 1;
    this.scriptProgressLabel = `Batch 0/${count}`;
    this._scriptAbort = new AbortController();
    try {
      for (let index = 0; index < count; index++) {
        const batchIndex = index + 1;
        const plan = await prepareBroadcastScript({
          ...options,
          count: undefined,
          signal: this._scriptAbort.signal,
          onProgress: ({ progress, label }) => {
            const itemProgress = Math.max(0, Math.min(100, Number(progress || 0)));
            this.scriptProgress = Math.round(((index + itemProgress / 100) / count) * 100);
            this.scriptProgressLabel = `Batch ${batchIndex}/${count}: ${label || "Preparing script"}`;
          },
        });
        this.scriptPlan = plan;
      }
      this.scriptProgress = 100;
      this.scriptProgressLabel = `Batch ready: ${count} scripts`;
    } catch (error) {
      if (error.name === "AbortError") {
        this.scriptProgress = 0;
        this.scriptProgressLabel = "Script batch cancelled";
        return this.snapshot();
      }
      this.error = error.message;
      this.scriptProgress = 0;
      this.scriptProgressLabel = `Script batch failed: ${error.message}`;
      throw error;
    } finally {
      this.scriptPreparing = false;
      this._scriptAbort = null;
    }
    return this.snapshot();
  }

  cancelScript() {
    if (this._scriptAbort) {
      this._scriptAbort.abort();
      return true;
    }
    if (this._synthAbort) {
      this._synthAbort.abort();
      return true;
    }
    return false;
  }

  async synthesizeAudio({ liveId } = {}) {
    if (this.scriptPreparing) throw new Error("Script preparation in progress");
    if (this._synthWorker) throw new Error("Synthesis already running");
    const dbPath = path.join(DATA_DIR, "talk-items.sqlite");
    const db = new DatabaseSync(dbPath);
    const live = db.prepare("select id, title from live where id = ?").get(liveId);
    if (!live) { db.close(); throw new Error(`Live ${liveId} not found`); }
    const rows = db.prepare(
      "select id, sequence_no, text from speech_lines where live_id = ? and (audio_path is null or audio_path = '') order by sequence_no"
    ).all(liveId);
    if (!rows.length) { db.close(); return { ok: true, synthesized: 0, message: "All lines already synthesized" }; }

    const audioDir = path.join(DATA_DIR, "audio", `live-${liveId}`);
    await mkdir(audioDir, { recursive: true });

    this._synthAbort = new AbortController();
    this._synthWorker = new IrodoriWorkerClient();
    this.scriptProgress = 5;
    this.scriptProgressLabel = `Synthesizing 0/${rows.length}`;
    try {
      await this._synthWorker.start();
      const updateStmt = db.prepare("update speech_lines set audio_path = ?, updated_at = datetime('now') where id = ?");
      let done = 0;
      for (const row of rows) {
        if (this._synthAbort.signal.aborted) throw new DOMException("Synthesis cancelled", "AbortError");
        const chunks = splitSpeechText(row.text);
        if (!chunks.length) chunks.push(row.text);
        const wavPaths = [];
        for (let ci = 0; ci < chunks.length; ci++) {
          if (this._synthAbort.signal.aborted) throw new DOMException("Synthesis cancelled", "AbortError");
          const wavName = chunks.length === 1 ? `${row.sequence_no}.wav` : `${row.sequence_no}_${ci}.wav`;
          const wavPath = path.join(audioDir, wavName);
          await this._synthWorker.synthesize(chunks[ci], { outputWav: wavPath });
          wavPaths.push(wavPath);
        }
        updateStmt.run(JSON.stringify(wavPaths), row.id);
        done++;
        this.scriptProgress = Math.round(5 + (done / rows.length) * 90);
        this.scriptProgressLabel = `Synthesizing ${done}/${rows.length}`;
      }
      this.scriptProgress = 100;
      this.scriptProgressLabel = `Audio ready: ${done} files`;
      db.close();
      return { ok: true, synthesized: done };
    } catch (error) {
      if (error.name === "AbortError") {
        this.scriptProgress = 0;
        this.scriptProgressLabel = "Synthesis cancelled";
        db.close();
        return { ok: true, synthesized: 0, message: "Cancelled" };
      }
      this.scriptProgress = 0;
      this.scriptProgressLabel = `Synthesis failed: ${error.message}`;
      db.close();
      throw error;
    } finally {
      this._synthWorker?.stop();
      this._synthWorker = null;
      this._synthAbort = null;
    }
  }

  static async deleteAudioForLive(liveId) {
    const audioDir = path.join(DATA_DIR, "audio", `live-${liveId}`);
    try { await rm(audioDir, { recursive: true, force: true }); } catch {}
  }

  playWav(wavPath) {
    const filePath = path.resolve(String(wavPath || ""));
    if (!existsSync(filePath)) return Promise.reject(new Error(`Audio file not found: ${filePath}`));
    const escaped = filePath.replace(/'/g, "''");
    const command = `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`;
    return new Promise((resolve, reject) => {
      this.player = spawn("powershell.exe", ["-NoProfile", "-Command", command], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      this.player.stderr.on("data", (chunk) => { stderr += chunk; });
      this.player.on("error", reject);
      this.player.on("close", (code) => {
        this.player = null;
        if (code !== 0 && !this.safeStopRequested) reject(new Error(stderr || `Audio player exited with code ${code}`));
        else resolve();
      });
    });
  }

  async playWavWithSubtitles(wavPath, text) {
    const sentences = splitDisplaySentences(text);
    const timers = [];
    if (sentences.length <= 1) {
      this.currentText = sentences[0] || text || "";
    } else {
      const duration = await wavDurationSec(wavPath).catch(() => 0);
      const totalChars = sentences.reduce((sum, s) => sum + s.length, 0) || 1;
      this.currentText = sentences[0];
      if (duration > 0.3) {
        let acc = 0;
        for (let i = 1; i < sentences.length; i++) {
          acc += sentences[i - 1].length / totalChars;
          const sentence = sentences[i];
          timers.push(setTimeout(() => { this.currentText = sentence; }, acc * duration * 1000));
        }
      } else {
        this.currentText = text;
      }
    }
    this.speaking = true;
    try {
      await this.playWav(wavPath);
    } finally {
      this.speaking = false;
      for (const t of timers) clearTimeout(t);
    }
  }

  finishStop() {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    this.startedAt = null;
    this.queue = [];
    this.currentText = "";
    this.speaking = false;
    this.currentItem = null;
    this.state = "stopped";
    this.progress = 0;
    this.progressLabel = "Stopped";
    void saveRadioState({ history: this.history });
    void saveSessionSummary(this.history);
  }

  fail(error) {
    console.error(error);
    this.error = error.message;
    this.state = "error";
    this.safeStopRequested = true;
    this.queue = [];
    this.currentItem = null;
    this.speaking = false;
  }
}

function parseAudioPaths(audioPath) {
  if (!audioPath) return [];
  const s = String(audioPath).trim();
  if (s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch {}
  }
  return [s];
}

function splitDisplaySentences(text) {
  const norm = String(text || "").replace(/\s+/g, " ").trim();
  if (!norm) return [];
  const parts = norm.match(/[^。！？!?]+[。！？!?]?/g) || [norm];
  return parts.map((s) => s.trim()).filter(Boolean);
}

async function wavDurationSec(filePath) {
  const buf = await readFile(path.resolve(String(filePath)));
  if (buf.length < 44) return 0;
  const byteRate = buf.readUInt32LE(28);
  let dataSize = buf.length - 44;
  for (let i = 12; i + 8 <= buf.length;) {
    const id = buf.toString("ascii", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === "data") { dataSize = size; break; }
    i += 8 + size + (size % 2);
  }
  return byteRate ? dataSize / byteRate : 0;
}

function talkSnapshot(item) {
  return {
    createdAt: item.createdAt || "",
    topic: item.topic?.title || item.topic || "",
    text: item.text || "",
    currentChunk: item.text || "",
    fullText: item.fullText || item.text || "",
    memoryId: item.result?.memoryId || item.memoryId || "",
    tangentSeed: item.result?.tangentSeed || item.tangentSeed || "",
    flowId: item.result?.flowId || item.flowId || "",
    move: item.result?.move || item.move || "",
    scriptNumber: item.result?.scriptNumber || item.scriptNumber || 0,
  };
}

function updateCompanionState(previous, { topic, result }) {
  const current_thread = [topic, result?.tangentSeed, result?.memoryId].filter(Boolean).join(" / ").slice(0, 120);
  return { current_mood: previous?.current_mood || "flat", current_thread };
}

async function loadRadioState() {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (state.version !== RADIO_STATE_VERSION) return { history: [] };
    return state;
  } catch {
    return { history: [] };
  }
}

async function saveRadioState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify({ version: RADIO_STATE_VERSION, ...state }, null, 2)}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
