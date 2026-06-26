import { spawn } from "node:child_process";

const CONTROL_URL = process.env.RADIO_CONTROL_URL || "http://127.0.0.1:14520/api/status";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_EXE = process.env.OLLAMA_EXE || "C:\\Users\\User\\AppData\\Local\\Programs\\Ollama\\ollama.exe";

const children = [];
let shuttingDown = false;

process.env.PYTHONUTF8 ||= "1";
process.env.RADIO_LOG_LLM ||= "1";

main().catch((error) => {
  console.error(`[dev] ${error.stack || error.message}`);
  void shutdown(1);
});

async function main() {
  console.log("[dev] KawaiiLive dev launcher");

  if (await isHttpReady(`${OLLAMA_URL}/api/tags`)) {
    console.log("[dev] Ollama: already running");
  } else {
    startProcess("ollama", OLLAMA_EXE, ["serve"]);
    await waitForHttp(`${OLLAMA_URL}/api/tags`, 45_000, "Ollama");
  }

  if (await isHttpReady(CONTROL_URL)) {
    console.log("[dev] Control UI: already running");
  } else {
    startProcess("control", "node", ["app/server.js"]);
  }

  await waitForHttp(CONTROL_URL, 45_000, "Control UI");
  console.log("[dev] Control UI: http://127.0.0.1:14520/");
  console.log("[dev] Ctrl+Cでまとめて停止します。");
}

function startProcess(name, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONUTF8: "1", RADIO_LOG_LLM: process.env.RADIO_LOG_LLM || "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.devName = name;
  children.push(child);
  child.stdout.on("data", (chunk) => writePrefixed(name, chunk));
  child.stderr.on("data", (chunk) => writePrefixed(name, chunk));
  child.on("exit", (code, signal) => {
    if (!shuttingDown) console.log(`[${name}] exited code=${code ?? "-"} signal=${signal ?? "-"}`);
  });
  console.log(`[dev] started ${name} pid=${child.pid}`);
  return child;
}

function writePrefixed(name, chunk) {
  for (const line of chunk.toString("utf8").split(/\r?\n/)) {
    if (line.trim()) console.log(`[${name}] ${line}`);
  }
}

async function isHttpReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHttp(url, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHttpReady(url)) {
      console.log(`[dev] ${label}: ready`);
      return;
    }
    await sleep(750);
  }
  throw new Error(`${label} did not become ready: ${url}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[dev] stopping...");
  for (const child of [...children].reverse()) {
    if (!child.pid || child.exitCode !== null) continue;
    await killTree(child.pid, child.devName);
  }
  process.exit(exitCode);
}

function killTree(pid, name) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    killer.on("exit", () => {
      console.log(`[dev] stopped ${name}`);
      resolve();
    });
    killer.on("error", () => resolve());
  });
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
