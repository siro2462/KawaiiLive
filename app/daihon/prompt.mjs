import { TALK_MOVE_INSTRUCTIONS, SPONTANEOUS_MOVES } from "./constants.mjs";
import { buildMemoryCard } from "./planner.mjs";

const TYPE_INSTRUCTIONS = {
  OPENING: "最初は軽く。配信の空気を少し触ってから、手元の小さい話に流れていく。",
  DEEP_DIVE: "同じ話の近くにいて、さっき見てなかった細部や反応を拾う。",
  SOFT_TRANSITION: "前の話の小さい物や音を少し拾って、気づいたら次の話に入る。",
  RESET_TRANSITION: "無理につなげず、ふと思い出した感じで話を変える。",
  TOPIC_ENTRY: "物、動き、音、小さい失敗のどれかから入る。",
  ENDING: "大きい新話題は出さず、少しゆるく畳む。",
};

const DEFAULT_STYLE_FRAGMENTS = [
  "なんか、そこだけ妙に覚えてる",
  "いや、そうじゃなくて",
  "まあ、別に大事件じゃないんだけど",
];

const STYLE_FOREIGN_RE = /[烟收纳]|毫米|捞|特别|那种|那種|啊/;
const STYLE_GENRE_NOISE_RE = /墓|近づかない|今後一切|恐怖|死亡|告別|呪い|怪談/;
const STYLE_PARTIAL_TAIL_RE = /(数ヶ|願いたいはいやり|していた|だった|[「『])$/;
const STYLE_PROPER_NOUN_RE = /ラミィ|フブキ|おかゆ|ぺこら|椎名|戌亥|あやめ|アンジュ|える|トワ/;

export function buildPromptByType({
  decision,
  memory,
  recentHooksStr,
  lastSentence,
  styleTexts,
  section,
}) {
  const targetChars = decision.target_chars || 550;
  const typeInstruction = TYPE_INSTRUCTIONS[decision.prompt_type] || TYPE_INSTRUCTIONS.TOPIC_ENTRY;
  const moveInstruction = TALK_MOVE_INSTRUCTIONS[decision.move] || "";
  const memoryCard = buildMemoryCard(memory, { maxTerms: 8 });
  const styleFragments = toStyleFragments(styleTexts).slice(0, 3);
  const rhythmFragments = styleFragments.length ? styleFragments : DEFAULT_STYLE_FRAGMENTS;
  const styleOperations = buildStyleOperations(rhythmFragments);
  const styleTurnCues = buildStyleTurnCues(rhythmFragments, decision);
  const angle = sanitizePlanningHint(decision.angle || "");
  const bridgeHint = sanitizePlanningHint(decision.bridge_hint || "");

  const basePrompt = [
    "/no_think",
    "日本語VTuberの雑談台本を書く。",
    "返すのは発話本文だけ。JSON、箇条書き、見出し、解説、メモは出さない。",
    "",
    `type=${decision.prompt_type}`,
    `section=${section || "body"}`,
    `transition_type=${decision.transition_type || "none"}`,
    `target_chars=${targetChars}`,
    `move=${decision.move || "ASSOCIATE"}`,
    `move_instruction=${moveInstruction || "none"}`,
    `angle=${angle || "none"}`,
    `angle_slot=${decision.angle_slot || "object"}`,
    `depolish=${decision.depolish || "none"}`,
    `handoff_hook=${decision.handoff_hook || "none"}`,
    `handoff_action=${sanitizePlanningHint(decision.handoff_action || "") || "none"}`,
    `handoff_feeling=${sanitizePlanningHint(decision.handoff_feeling || "") || "none"}`,
    `next_entry_hint=${sanitizePlanningHint(decision.next_entry_hint || "") || "none"}`,
    `handoff_mode=${decision.handoff_mode || "continue"}`,
    decision.previous_hooks?.length ? `previous_hooks=${decision.previous_hooks.join(", ")}` : "",
    decision.spontaneous_move ? `spontaneous_move=${decision.spontaneous_move}` : "",
    `entry_hook=${decision.entry_hook || "none"}`,
    `from_hook=${decision.from_hook || "none"}`,
    `to_hook=${decision.to_hook || "none"}`,
    `from_event=${decision.from_event || "none"}`,
    `to_event=${decision.to_event || "none"}`,
    `bridge_hint=${bridgeHint || "none"}`,
    `used_hooks=${(decision.used_hooks || []).slice(-10).join(", ") || "none"}`,
    lastSentence ? `直前の発話(末尾):\n${lastSentence}` : "",
    `思い出:\n${memoryCard}`,
    "style_fragments=hidden",
    `style_operations=${styleOperations.join(" / ")}`,
    `style_turn_cues=${styleTurnCues.join(" / ")}`,
    "",
    "書き方のメモ:",
    "- 雑談は話題ごとに区切らない。前の話の途中から自然に次の話に滑り込む。",
    "- 「直前の発話(末尾)」があれば、その続きとして話し始める。前の話を途中まで引きずりながら、新しい思い出に入る。",
    "- 冒頭で話題をリセットしない。前の話の具体物や動作を1つ拾って、そこから連想で滑る。",
    "- きれいに説明しなくていい。しゃべりながら思い出してる感じで。",
    "- オチを急がない。少し迷ったり、言い直したりしていい。",
    "- 思い出をきれいに語り切らない。話しながら気づいたこととして、少し途中で崩してよい。",
    "- 五感描写の後は、余韻よりも小さい失敗、ツッコミ、今の手元に寄せる。",
    "- 最後を「覚えている」「残っている」「感じがする」でまとめすぎない。",
    "",
    "【感覚→行動 変換ルール】(禁止ではなく変換)",
    "この台本では抽象的な感覚語で話をつながない。",
    "「感覚」「感触」「違和感」「安心感」「気配」「余韻」「現実感」「距離感」「生活感」「空気感」「妙に残る」「引っかかる」で説明したくなったら、その言葉を使わず話し手の小さい行動に変換する。",
    "直接使ってよいのは短い身体反応だけ: 冷たい、重い、硬い、ぬるい、痛い、まぶしい、うるさい、くさい、眠い、だるい。",
    "必ず入れる要素: 何を触ったか / 何を見たか / 手や目線がどう動いたか / そのあと何を確認したか / 自分でどうツッコんだか。",
    "悪い例: 「レシートの感触が妙に指先に残った」→ 良い例: 「レシート持ったあと、なんか親指こすっちゃってさ。いや、何もついてないんだけど。何してんの私」",
    "悪い例: 「冷蔵庫の冷たさに少し安心感があった」→ 良い例: 「冷蔵庫開けて、冷たっ、ってなって。一回閉めたのに、また開けた。いや何を確認してんの」",
    "悪い例: 「袋の重さに現実感があった」→ 良い例: 「袋の取っ手が指に食い込んで、あ、買いすぎたなって分かった。持ち直したら、さらに重く感じて、もう一回負けた」",
    "悪い例: 「店員さんの視線が妙に気になった」→ 良い例: 「店員さんの顔、見なきゃいいのに一瞬見ちゃって。で、目が合った気がして、すぐレシート見た。レシートに逃げるな」",
    "1ブロック内の条件: 抽象感覚語は最大1回 / 小さい行動を3回以上 / 自己ツッコミを1回以上 / 文末を抽象まとめにしない。",
    "文末ルール: 「〜の感覚がある」「〜が残る」「〜が気になる」「〜という感じがする」で終わらせない。最後は小さい行動、言い直し、自己ツッコミ、または次の脱線の入口で終える。",
    "「妙に」は1ブロック1回以下。代わりに「なんか」「ちょっと」「地味に」「やたら」「なんでか」「思ったより」「変に」を使う。",
    "",
    "- depolish が none 以外なら、本文のどこかに小さい崩れを1つだけ入れる。説明ではなく、配信中に今ちょっと気づいた感じで入れる。",
    "- depolish=live_reaction は、音、喉、画面、手元、今しゃべっていて気づいたことを一瞬だけ挟む。",
    "- depolish=self_repair は、言いかけて少し戻る。『いや違うな』『待って』『それでいうと』くらいの小さい戻りでいい。",
    "- depolish=unfinished_edge は、最後をきれいな結論にしすぎない。少し言いさしや次の連想を残す。",
    "- depolish=comment_ping は、コメントに突っ込まれそう、今コメントで言われたら困る、くらいの薄い反応を挟む。",
    "- transition_type=RESET の時でも、前の話の具体物を1つだけ拾ってから別の話に入る。完全に切り離さない。",
    "- RESET の入り方例: 「で、それ見ながら思ったんだけど」「ていうか、手元見てたらさ」「まあそれはいいんだけど、そういえばさ」",
    "- angle_slot に従って、同じmemoryでも見る場所を変える。",
    "- OBJECT_DETAIL: 物の形、音、手触り、置き場所を見る。",
    "- PERSON_REACTION: 友達、店員、家族、先生などの反応を見る。",
    "- PLACE_SHIFT: 場所、座る位置、帰り道、部屋の位置関係を見る。",
    "- BODY_FEEL: 手元、姿勢、歩き方、息、服、荷物の重さを見る。",
    "- AFTER_SCENE: その後、片付け、帰宅後、カバンの中、翌日のことを見る。",
    "- CURRENT_SELF: 今話している自分の感覚へ少し戻す。",
    "- MICRO_CONFLICT: 小さい矛盾や違和感を掘る。買ったのに食べない、レシートいらないのに見ちゃう、冷蔵庫開けたのに閉める。",
    "- UNNECESSARY_DETAIL: どうでもいい細部に妙にこだわる。袋の折り方、ドアの閉まる音、ラベルの向き。",
    "- SELF_TSUKKOMI: 自分の行動にツッコむ。「いや、なんでそうなる」「それやる意味ある？」",
    "- CURRENT_COMPARISON: 今の自分と当時の自分を小さい具体で比べる。「今ならやらないけど、あの時は」。",
    "- used_hooks にある物や場面を、そのblockの主役として繰り返さない。",
    "- DEEP_DIVE は同じ説明の言い換えではなく、人物の反応、場所の変化、手元の動き、その後の場面のどれかへずらす。",
    "- まずは物、音、匂い、重さ、手の動きみたいな見える細部に寄る。感覚を名詞で語らず、その感覚で何をしたか・どんな変な行動をしたかを書く。",
    "- 感情を言う前に、その感情が出た場面の行動を置く。「安心した」→「なぜか一回落ち着いた。冷気に頼るな」、「違和感がある」→「二度見する、置き場所を確認する」。",
    "- entry_hook は短い出来事として使う。理想は「具体物 + 人 + 行動」。紙袋だけで伸ばさず、店員さんに聞かれた、友達が笑った、先生が黙った、みたいなところまで置く。",
    "- entry_hook に 判断力、感覚、空気感、吸引力、現実感、印象、役割、構造 みたいな硬い語が混じっていたら、その語は捨てて、memory内の人と行動だけ拾う。",
    "- 登場人物を一回で捨てない。友達、店員さん、先生、お兄さん、おじさんなどを出したら、同じブロックの中でもう一度その人の一言、表情、手の動き、立ち位置のどれかに戻る。",
    "- その人を戻す時は大げさにしない。「まだ見てた」「ちょっと笑った」「小声で言った」「首かしげてた」くらいでいい。",
    "- きれいな比喩や詩っぽい質感描写に寄せすぎない。音や硬さを長く飾らず、誰が何をしてどう気まずかったかを優先する。",
    "- 「顧客としての役割」「持ち去るみたい」「演じている」「人工的な印象」みたいな解説っぽい表現は使わない。もっと雑に、店員さんの前で急に背筋伸びた、くらいで言う。",
    "- 友達、店員さん、コメント、同僚、家族、昔の自分みたいな誰かを、自然なら一人だけ入れる。その人の小さい反応も足す。",
    "- 実在の誰かがいない話なら、コメントで突っ込まれそう、店員さんの目線が気になる、昔の自分が見てる感じ、くらいの薄い反応でいい。",
    "- 報酬系、科学的、メカニズム、物理的、構造、側面、認知、心理的、抽象的、客観的、みたいな分析語には逃げない。",
    "- 分析より、匂い、温度、姿勢、目線、待ち時間、気まずい間、誰かの一言。",
    "- memory、prompt、style、focus、role、seed、instruction みたいな制御用語は出さない。",
    "- 日本語だけ。素材に外国語っぽいものがあっても拾わない。",
    "- style_fragments は本文に出さない。style_operations の動きだけ借りる。",
    "- style_operations は話し方の動きとして使う。名前そのものは言わない。",
    "- style_turn_cues は淀みや話題転換の候補。文脈に合うものを最大1つだけ短く使ってよい。合わなければ使わない。",
    "- 「あ、」「あ、全然関係ないんだけどさ」「あ、急に思い出した」で始めるのは禁止。前の話から自然に続ける。冒頭のフィラーは「で、」「それでさ、」「ていうかさ、」「まあ」「いや」「えーと」「そういえば」など毎回変える。",
    "- move_instruction はゆるい進行方向くらいに見る。",
    "- angle は結論じゃなくて、見る角度として使う。",
    "- handoff_action と handoff_feeling があれば、冒頭で action/feeling を拾って入る。単語ではなく動作や感覚でつなぐ。",
    "- 悪い冒頭: 「さっき冷蔵庫の話してたから」。良い冒頭: 「中身あるか確認して安心する感じで思い出したんだけど」",
    "- next_entry_hint があれば、その感覚から自然に入る参考にする。",
    "- handoff_mode による冒頭の入り方:",
    "  continue: 直前の動作を拾って、そのまま続ける。「で、」「それで、」くらいで入る。",
    "  detail_shift: 同じ話題だが見る場所を変える。「あ、それでいうとさ」「で、そこの」",
    "  soft_drift: 前のblockの動作・感覚を1つ拾って、別の話に滑る。",
    "  callback: 少し前の話題に戻る。「さっきの○○の話に戻るんだけど」",
    "  research_turn: 調べ物コーナーに入る。前の雑談を1文だけ受ける。",
    "  reset: 前の話の具体物を1つだけ拾ってから、別の話に滑る。「まあそれはいいんだけどさ」「ていうかそれ見てて思い出したんだけど」",
    "- blockの終わりをきれいに閉じすぎない。次に何か言いそうな余韻、途中の連想、小さい疑問を残す。",
    "- 「覚えている」「残っている」「感じがする」で締めくくらない。言いかけや次の連想で終わる方がいい。",
    "- spontaneous_move があれば、block内のどこかに1回だけ使う:",
    "  self_question: ふと自分に問いかける。「いや、なんでだろ」「これいつからやってたっけ」",
    "  self_correction: 言いかけてから修正する。「いや違うな、そうじゃなくて」「待って、あれは」",
    "  sudden_memory: 唐突に別の記憶が差し込まれる。「あ、急に思い出した」「それで思い出したんだけど」",
    "  tiny_complaint: 小さいグチや不満を一言だけ。「いやマジでめんどいんだけど」",
    "  listener_shadow: コメントや聞いてる人を薄く意識する。「いやこれ伝わるかな」「笑わないでよ」",
    "  lost_thread: 話の筋を一瞬見失う。「あれ、なんの話してたっけ」「えーと、どこまで話した」",
    "- entry_hook は自然なら早めに触る。無理に一語目へ置かなくていい。",
    "- from_hook と to_hook がある時は、その具体物どうしを連想で滑らせる。理由は説明しない。",
    "- from_event と to_event がある時は、単語ではなく出来事どうしを滑らせる。",
    "- 関連して、同じカテゴリ、話題を変える、つながりで、連想すると、みたいな橋の説明は言わない。",
    "- bridge_hint は裏メモ。本文で説明しない。",
    "",
    `type_instruction=${typeInstruction}`,
  ].join("\n");

  return basePrompt;
}

function toStyleFragments(texts) {
  return (texts || [])
    .flatMap(text => String(text || "").split(/[。！？!?、,\n]/))
    .map(fragment => fragment.trim())
    .filter(isUsableStyleFragment)
    .slice(0, 6);
}

function isUsableStyleFragment(fragment) {
  const text = String(fragment || "").trim();
  if (text.length < 4 || text.length > 24) return false;
  if (!/[ぁ-んァ-ヶ一-龥]/.test(text)) return false;
  if (/[A-Za-z0-9]/.test(text)) return false;
  if (/[�]|縺|繧|郢|邵|譁|鬩|驍|隴|髫/.test(text)) return false;
  if (/[头这么吗吧发现实过对说时间别]/.test(text)) return false;
  if (STYLE_FOREIGN_RE.test(text)) return false;
  if (STYLE_GENRE_NOISE_RE.test(text)) return false;
  if (STYLE_PROPER_NOUN_RE.test(text)) return false;
  if (/負け|敗北|終わってる|詰ん/.test(text)) return false;
  if (STYLE_PARTIAL_TAIL_RE.test(text)) return false;
  if (/配$|言っ$|思っ$|話し$|毎日あ$|です$|ます$/.test(text)) return false;
  if (/^[「『]|[」』]$/.test(text)) return false;
  if ((text.match(/[ぁ-ん]/g) || []).length < 2) return false;
  if (/^(そう|うん|はい|えー|あー|いや|まあ|でも)$/.test(text)) return false;
  if (!/(なんか|いや|まあ|ちょっと|ていうか|そっか|あ、|えーと|まじ|待って|そういう|別に|なんだよ|だよね|じゃん|かも|けど|けどさ)/.test(text)) return false;
  if (!hasEarlyStyleCue(text)) return false;
  return true;
}

function hasEarlyStyleCue(text) {
  const match = String(text || "").match(/なんか|いや|まあ|ちょっと|ていうか|そっか|あ、|えーと|まじ|待って|そういう|別に|なんだよ|だよね|じゃん|かも|けど|けどさ/);
  return !!match && match.index <= 6;
}

function buildStyleOperations(fragments = []) {
  const operations = [];
  for (const fragment of fragments) {
    const text = String(fragment || "");
    if (/いや|そうじゃなくて|違う|待って/.test(text)) {
      operations.push("言いかけてから一度戻り、別の具体物で言い直す");
    }
    if (/なんか|妙に覚えてる|そこだけ/.test(text)) {
      operations.push("大きな結論にせず、小さい記憶の引っかかりとして話す");
    }
    if (/まあ|別に|大事件じゃない/.test(text)) {
      operations.push("出来事を大げさにせず、生活の小さい違和感として落とす");
    }
    if (/だよね|じゃん|かも|かな|けど/.test(text)) {
      operations.push("言い切らず、相手に話しかけるように少し余白を残す");
    }
    if (/ちょっと|えーと|あ、|そっか/.test(text)) {
      operations.push("途中で気づいたように短く止まり、次の細部へ滑る");
    }
  }
  const unique = [...new Set(operations)];
  return unique.length ? unique.slice(0, 4) : [
    "小さい具体物から入り、言い直しながら話す",
    "大事件にせず、生活の違和感として落とす",
  ];
}

function buildStyleTurnCues(fragments = [], decision = {}) {
  const cues = [];
  for (const fragment of fragments) {
    const text = String(fragment || "");
    const cue = extractTurnCue(text);
    if (cue) cues.push(cue);
  }

  if (/RESET/.test(String(decision.transition_type || decision.prompt_type || ""))) {
    cues.push("まあそれはいいんだけどさ", "ていうかさ");
  } else if (/SOFT|DIRECT/.test(String(decision.transition_type || ""))) {
    cues.push("それで思ったんだけど", "ていうか、そこからなんだけど");
  } else if (decision.prompt_type === "DEEP_DIVE") {
    cues.push("いや、そこじゃなくて", "待って、もう一個あって");
  }

  const filtered = cues
    .map(cue => cue.trim())
    .filter(cue => cue.length >= 3 && cue.length <= 18)
    .filter(cue => cue !== "あ、")
    .filter(cue => !/[A-Za-z0-9]/.test(cue));
  const unique = [...new Set(filtered)];
  return unique.length ? unique.slice(0, 3) : ["えーと", "いや、待って", "まあ、でも"];
}

function extractTurnCue(text) {
  const value = String(text || "").trim();
  const match = value.match(/^(あ、|えーと|いや|まあ|でも|ていうか|そっか|待って|なんか|それで|急に|話変わるけど)([^。！？!?、,\n]{0,10})/);
  if (!match) return "";
  const cue = `${match[1]}${match[2] || ""}`.trim();
  if (/覚えてる|大事件|じゃないんだけど/.test(cue)) return "";
  return cue;
}

function sanitizePlanningHint(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/報酬系|科学的|メカニズム|物理的|構造|側面|認知|心理的|抽象的|客観的/.test(text)) {
    return "手元の具体物と、その場の小さい反応で話す";
  }
  return text;
}

