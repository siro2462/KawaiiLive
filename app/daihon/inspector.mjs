export function inspectAndAcceptBlockLines({
  lines,
  memory,
  existingItems,
  decision = null,
  maxLines = Infinity,
}) {
  const accepted = [];
  const rejected = [];

  for (const line of lines) {
    if (accepted.length >= maxLines) break;

    const issues = inspectLine({
      line,
      memory,
      accepted,
      existingItems,
      decision,
    });

    if (issues.length) {
      rejected.push({ snippet: line.slice(0, 80), issues });
      continue;
    }
    accepted.push(line);
  }

  return { accepted, rejected };
}

const FOREIGN_TEXT_RE = /[烟收纳轻]|毫米|捞|特别|那种|那種|轻声|确声|水分太重くて|啊/;
const GENRE_CONTAMINATION_RE = /墓|近づかない|今後一切|恐怖|死亡|告別|呪い|怪談/;
const POETIC_ANALYSIS_RE = /顧客としての役割|役割を演じ|演じている|人工的な印象|持ち去るみたい|ただ匂いだけ|質感と音|よく分かって|シミュレーション|オーバーヒート|エネルギー食う|選ぶという行為|判断力|吸引力|空気感|無重力状態|免疫|細胞|防御|証拠みたい/;
const PERSONA_BREAK_RE = /おっす|俺|僕|僕ら|確かに/;
const POLISHED_LANDING_RE = /なんだよね|思っちゃうんだよね|感じがする|だったんだよね|忘れられない|特別だった|鮮明に覚えてる|重みがある|正式な許可/;

export function inspectLine({ line, memory, accepted = [], existingItems = [], decision = null }) {
  const issues = [];

  if (line.length < 12 && !isShortReaction(line)) issues.push("too_short");
  if (line.length > 2000) issues.push("too_long");

  if (/[�]|縺|繧|郢|邵|譁|鬩|驍|隴|髫/.test(line)) issues.push("mojibake");
  if (/<think>|As an AI|Context:|Draft:|\/no_think/i.test(line)) issues.push("reasoning_leak");
  if (/[头这么吗吧发现实过对说时间捞别轻确]|那种|那種|特别|轻声|确声|水分太重くて|啊/.test(line)) issues.push("chinese");
  if (FOREIGN_TEXT_RE.test(line)) issues.push("foreign_text");
  if (GENRE_CONTAMINATION_RE.test(line)) issues.push("style_genre_contamination");
  if (POETIC_ANALYSIS_RE.test(line)) issues.push("poetic_analysis");
  // depolish/noise側で扱う。ここではblock全拒否しない。
  // if (PERSONA_BREAK_RE.test(line)) issues.push("persona_break");
  const ALLOWED_ENGLISH = /^(OK|PC|BGM|CD|DVD|USB|SNS|LINE|VTuber|YouTube|Twitter|TikTok|iPhone|Android|Mac|Windows|Bluetooth|WiFi|Instagram|LED|AI|DJ|TV|CM|PV|MV|HP|SP|NG|ID|QR|IC|AB|BC|XL|LL|ML|SS|Netflix|ZARA|COINS|IKEA|UNIQLO|GU|Amazon|Spotify|Google|MUJI|DAISO|LOFT|PS|Xbox|Switch|Steam|Discord|Zoom|Slack|Chrome|Safari|GitHub|GPT|LLM|API|URL|PDF|GIF|GPS|ATM|NFC|UberEats|Uber|PayPay|Suica)$/i;
  const englishWords = line.match(/[A-Za-z]{2,}/g) || [];
  if (englishWords.some(w => !ALLOWED_ENGLISH.test(w))) issues.push("english");

  if (/元ネタ|料理法|制御情報|プロンプト|文体サンプル|場面役割|文体特徴/.test(line)) {
    issues.push("control_leak");
  }
  if (/思い出:|source:|topic_words:|entry_hooks:|event_anchors:|recurring_people:|strong_hooks:|weak_hooks:|avoid_abstract:/i.test(line)) {
    issues.push("control_leak");
  }

  const myouni = (line.match(/妙に/g) || []).length;
  if (myouni >= 3) issues.push("myouni_overuse");

  if (hasExactDuplicate(line, existingItems)) issues.push("global_duplicate");
  if (accepted.some(prev => similarity(prev, line) > 0.42)) issues.push("block_near_duplicate");
  if (hasRepeatedSelfDeprecation(line, accepted, existingItems)) issues.push("self_deprecation_cooldown");
  if (hasBadResetContinuity(line, decision)) issues.push("reset_continuity_leak");
  // depolish/noise側で扱う。ここではblock全拒否しない。
  // if (hasOverPolishedLanding(line, accepted, existingItems)) issues.push("over_polished_landing");

  return issues;
}

function hasBadResetContinuity(line, decision) {
  const isReset =
    decision?.transition_type === "RESET" ||
    decision?.prompt_type === "RESET_TRANSITION";
  if (!isReset) return false;
  return /さっきも言った|さっきの続き|続きだけど|それでいうと|さっき話した|さっきも思った|さっきも/.test(String(line || ""));
}

function hasOverPolishedLanding(line, accepted, existingItems) {
  const matches = String(line || "").match(new RegExp(POLISHED_LANDING_RE.source, "g")) || [];
  if (matches.length >= 3) return true;

  const end = landingKey(line);
  if (!end) return false;
  const previous = [
    ...accepted,
    ...existingItems.slice(-4).map(item => item.text || item),
  ];
  return previous.some(prev => landingKey(prev) === end);
}

function landingKey(text) {
  const normalized = normalize(text);
  const match = normalized.match(/(なんだよね|思っちゃうんだよね|感じがする|だったんだよね)$/);
  return match?.[1] || "";
}

function hasExactDuplicate(line, items) {
  const normalized = normalize(line);
  return items.some(i => normalize(i.text || i) === normalized);
}

function isShortReaction(line) {
  return /^(え、待って|いや、待って|マジか|それは無理|うわ|いや、分かる|そうなんだ|えぇ|はぁ|なるほど)[。！!]*$/.test(line.trim());
}

function hasRepeatedSelfDeprecation(line, accepted, existingItems) {
  if (!/負けてる|負けている|敗北|詰んでる|終わってる/.test(line)) return false;
  const previous = [
    ...accepted,
    ...existingItems.map(item => item.text || item),
  ].join("\n");
  return /負けてる|負けている|敗北|詰んでる|終わってる/.test(previous);
}

export function similarity(a, b) {
  const left = grams(normalize(a));
  const right = grams(normalize(b));
  let overlap = 0;
  for (const gram of left) if (right.has(gram)) overlap += 1;
  return overlap / Math.max(left.size, right.size, 1);
}

function normalize(text) {
  return String(text || "").replace(/\s+/g, "").replace(/[、。！？!?]/g, "");
}

function grams(text) {
  const result = new Set();
  for (let i = 0; i < text.length - 2; i++) result.add(text.slice(i, i + 3));
  return result;
}
