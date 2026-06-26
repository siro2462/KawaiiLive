import { DatabaseSync } from "node:sqlite";

const DB_PATH = "C:/NodeJS/KawaiiLive/data/talk-items.sqlite";
process.env.RADIO_SCRIPT_LLM_BACKEND = "ollama";
process.env.RADIO_SCRIPT_POLISH = process.env.RADIO_SCRIPT_POLISH || "0";
process.env.RADIO_V3_LENIENT_ACCEPT = process.env.RADIO_V3_LENIENT_ACCEPT || "1";

const { prepareBroadcastScript } = await import("../app/onair/script.js");

const jobs = [
  {
    title: "gemma1",
    model: "hf.co/yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF:Q4_K_M",
  },
  {
    title: "gemma2",
    model: "hf.co/yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF:Q4_K_M",
  },
  {
    title: "QwebFable1",
    model: "hf.co/tvall43/Qwen3.6-14B-A3B-FableVibes-GGUF:Q4_K_M",
  },
  {
    title: "QwebFable2",
    model: "hf.co/tvall43/Qwen3.6-14B-A3B-FableVibes-GGUF:Q4_K_M",
  },
];

for (const job of jobs) {
  const existing = findLiveByTitle(job.title);
  if (existing?.lines > 0) {
    console.log(`[skip] ${job.title} liveId=${existing.id} lines=${existing.lines}`);
    continue;
  }
  console.log(`[start] ${job.title} ${job.model}`);
  const plan = await prepareBroadcastScript({
    minutes: 30,
    mode: "create",
    version: "v3",
    model: job.model,
    modelLabel: job.title,
    onProgress: ({ progress, label }) => {
      const pct = String(Math.round(Number(progress || 0))).padStart(3, " ");
      console.log(`[${job.title}] ${pct}% ${label || ""}`);
    },
  });

  if (!plan.liveId) throw new Error(`${job.title}: liveId was not returned`);
  renameLive(plan.liveId, job.title);
  console.log(`[done] ${job.title} liveId=${plan.liveId} lines=${plan.items.length}`);
}

function findLiveByTitle(title) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return db.prepare(`
      select
        id,
        title,
        (select count(*) from speech_lines where live_id = live.id) as lines
      from live
      where title = ?
      order by id desc
      limit 1
    `).get(title);
  } finally {
    db.close();
  }
}

function renameLive(liveId, title) {
  const db = new DatabaseSync(DB_PATH);
  try {
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    db.prepare("update live set title = ?, updated_at = ? where id = ?").run(title, now, liveId);
  } finally {
    db.close();
  }
}
