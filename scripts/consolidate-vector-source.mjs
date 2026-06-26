// assets/vtuber台本/*/話し方.json, 話の流れ.json|txt, 大局.json
// → data/vector-source/{style,topic,flow}.jsonl
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "assets", "vtuber台本");
const DST = path.join(ROOT, "data", "vector-source");

const buckets = { style: [], topic: [], flow: [] };

function inferType(filename, item) {
  if (item.db_type === "style") return "style";
  if (item.db_type === "topic") return "topic";
  if (item.db_type === "flow") return "flow";
  if (filename.startsWith("話し方")) return "style";
  if (filename.startsWith("話の流れ")) return "topic";
  if (filename.startsWith("大局")) return "flow";
  return null;
}

const folders = await readdir(SRC, { withFileTypes: true });
for (const d of folders) {
  if (!d.isDirectory()) continue;
  const dir = path.join(SRC, d.name);
  const files = await readdir(dir);
  for (const f of files) {
    if (!f.endsWith(".json") && !f.endsWith(".txt")) continue;
    if (!f.startsWith("話し方") && !f.startsWith("話の流れ") && !f.startsWith("大局")) continue;
    const raw = await readFile(path.join(dir, f), "utf8");
    let data;
    try { data = JSON.parse(raw); } catch { console.error(`  SKIP (parse error): ${d.name}/${f}`); continue; }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      const t = inferType(f, item);
      if (!t) { console.error(`  UNKNOWN type in ${d.name}/${f} id=${item.id}`); continue; }
      item.db_type = t;
      buckets[t].push(item);
    }
  }
}

for (const [key, items] of Object.entries(buckets)) {
  const out = path.join(DST, `${key}.jsonl`);
  await writeFile(out, items.map(i => JSON.stringify(i)).join("\n") + "\n", "utf8");
  console.log(`${key}.jsonl: ${items.length} records`);
}

for (const [key, items] of Object.entries(buckets)) {
  const ids = items.map(i => i.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) console.error(`DUPLICATE IDs in ${key}: ${[...new Set(dupes)].join(", ")}`);
}
