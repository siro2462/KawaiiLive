import { spawn } from "node:child_process";

const port = Number(process.argv[2] || process.env.RADIO_CONTROL_PORT || 14520);
const timeoutMs = 10000;
const started = Date.now();

await waitForPortToClose();

const child = spawn(process.execPath, ["app/server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RADIO_CONTROL_PORT: String(port),
    PYTHONUTF8: "1",
    RADIO_LOG_LLM: process.env.RADIO_LOG_LLM || "1",
  },
  detached: true,
  windowsHide: true,
  stdio: "ignore",
});
child.unref();

async function waitForPortToClose() {
  while (Date.now() - started < timeoutMs) {
    if (!(await isReady())) return;
    await sleep(350);
  }
}

async function isReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
