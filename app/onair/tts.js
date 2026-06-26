import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const IRODORI_DIR = path.join(PROJECT_ROOT, "library", "irodori");
const UV_CACHE_DIR = process.env.UV_CACHE_DIR || path.join(PROJECT_ROOT, ".uv-cache");
const UV_COMMAND = process.env.UV_COMMAND || (process.platform === "win32" ? "uv.exe" : "uv");

export class IrodoriWorkerClient {
  constructor({
    backend = process.env.IRODORI_BACKEND || "cu128",
    refWav = process.env.IRODORI_REF_WAV || path.join(IRODORI_DIR, "inputs", "raw", "irodori_ref_v2.mp3"),
    refLatent = process.env.IRODORI_REF_LATENT || "",
    outputDir = process.env.IRODORI_OUTPUT_DIR || path.join(IRODORI_DIR, "outputs"),
    durationScale = process.env.IRODORI_DURATION_SCALE || "1.05",
    numSteps = process.env.IRODORI_NUM_STEPS || "24",
  } = {}) {
    this.backend = backend;
    this.refWav = refWav;
    this.refLatent = refLatent;
    this.outputDir = outputDir;
    this.durationScale = durationScale;
    this.numSteps = numSteps;
    this.child = null;
    this.ready = null;
    this.pending = [];
    this.nextId = 1;
  }

  async start() {
    if (this.ready) return this.ready;
    await mkdir(UV_CACHE_DIR, { recursive: true });
    await mkdir(this.outputDir, { recursive: true });
    this.ready = new Promise((resolve, reject) => {
      this.child = spawn(UV_COMMAND, ["run", "--extra", this.backend, "python", "tts_worker.py"], {
        cwd: IRODORI_DIR,
        env: { ...process.env, UV_CACHE_DIR, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = readline.createInterface({ input: this.child.stdout });
      lines.on("line", (line) => this.handleLine(line, resolve, reject));
      this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
      this.child.on("error", reject);
      this.child.on("close", (code) => {
        const error = new Error(`Irodori worker exited with code ${code}`);
        while (this.pending.length) this.pending.shift().reject(error);
        this.child = null;
        this.ready = null;
      });
    });
    return this.ready;
  }

  async synthesize(text, { outputWav } = {}) {
    await this.start();
    const id = this.nextId++;
    const wav = outputWav || path.join(this.outputDir, `speech-${Date.now()}-${id}.wav`);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(`${JSON.stringify({
        type: "synthesize",
        text: normalizeSpeechText(text),
        output_wav: wav,
        ref_wav: this.refWav,
        ref_latent: this.refLatent,
        duration_scale: this.durationScale,
        num_steps: this.numSteps,
      })}\n`);
    });
  }

  stop() {
    if (this.child) this.child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
  }

  handleLine(line, readyResolve, readyReject) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      console.log(line);
      return;
    }
    if (payload.type === "status") console.log(`[irodori] ${payload.message}`);
    else if (payload.type === "ready") {
      console.log(`[irodori] ready on ${payload.device}`);
      readyResolve(payload);
    } else if (payload.type === "done") this.pending.shift()?.resolve(payload.output_wav);
    else if (payload.type === "error") this.pending.shift()?.reject(new Error(payload.message));
    else if (payload.type !== "bye") readyReject(new Error(`Unknown Irodori worker event: ${line}`));
  }
}

function normalizeSpeechText(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/[_#]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitSpeechText(text, maxChars = 200) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const parts = normalized.match(/[^\u3002\uff01\uff1f!?\u3001\uff0c]+[\u3002\uff01\uff1f!?\u3001\uff0c]?/g) || [normalized];
  const chunks = [];
  let buffer = "";

  for (const part of parts) {
    const sentence = part.trim();
    if (!sentence) continue;
    if ((buffer + sentence).length <= maxChars) {
      buffer += sentence;
      continue;
    }
    if (buffer) chunks.push(buffer);
    if (sentence.length <= maxChars) {
      buffer = sentence;
      continue;
    }
    for (let index = 0; index < sentence.length; index += maxChars) {
      chunks.push(sentence.slice(index, index + maxChars));
    }
    buffer = "";
  }

  if (buffer) chunks.push(buffer);
  return chunks;
}
