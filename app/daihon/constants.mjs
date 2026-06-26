export const PROMPT_TYPES = {
  OPENING: "OPENING",
  ENDING: "ENDING",
  TOPIC_ENTRY: "TOPIC_ENTRY",
  DEEP_DIVE: "DEEP_DIVE",
  SOFT_TRANSITION: "SOFT_TRANSITION",
  RESET_TRANSITION: "RESET_TRANSITION",
  KAIDAN_OP: "KAIDAN_OP",
  KAIDAN_MAIN: "KAIDAN_MAIN",
  KAIDAN_ED: "KAIDAN_ED",
};

export const TALK_MOVES = {
  ASSOCIATE: "ASSOCIATE",
  LATERAL_EXPAND: "LATERAL_EXPAND",
  ANGLE_SHIFT: "ANGLE_SHIFT",
  SOFT_DRIFT: "SOFT_DRIFT",
};

export const TALK_MOVE_INSTRUCTIONS = {
  ASSOCIATE:
    "直前またはmemory内の1語から、近い具体物へ連想して広げる。理由を説明しない。",
  LATERAL_EXPAND:
    "同じカテゴリや場面の別のものへ横に広げる。結論にしない。",
  ANGLE_SHIFT:
    "同じ話題を前と違う視点で話す。既に出た物や反応を中心にしない。",
  SOFT_DRIFT:
    "前の話を説明でつなげず、軽く拾うか、拾わずに次へ入る。",
};

export const EMOTIONS = [
  "casual", "amused", "nostalgic", "uneasy", "excited", "calm", "tired",
];

export const DEFAULT_TARGET_LINES = 15;
export const MAX_BLOCKS_PER_MEMORY = 2;
export const PLAN_SIZE = 3;

export const ANGLE_SLOTS = {
  OBJECT_DETAIL: "OBJECT_DETAIL",
  PERSON_REACTION: "PERSON_REACTION",
  PLACE_SHIFT: "PLACE_SHIFT",
  BODY_FEEL: "BODY_FEEL",
  AFTER_SCENE: "AFTER_SCENE",
  CURRENT_SELF: "CURRENT_SELF",
  MICRO_CONFLICT: "MICRO_CONFLICT",
  UNNECESSARY_DETAIL: "UNNECESSARY_DETAIL",
  SELF_TSUKKOMI: "SELF_TSUKKOMI",
  CURRENT_COMPARISON: "CURRENT_COMPARISON",
};

export const SPONTANEOUS_MOVES = [
  "self_question",
  "self_correction",
  "sudden_memory",
  "tiny_complaint",
  "listener_shadow",
  "lost_thread",
];

export const BLOCK_CHAR_RANGES = {
  OPENING:          [300, 500],
  ENDING:           [350, 600],
  TOPIC_ENTRY:      [400, 700],
  SOFT_TRANSITION:  [400, 700],
  RESET_TRANSITION: [400, 700],
  DEEP_DIVE:        [400, 700],
  KAIDAN_OP:        [250, 450],
  KAIDAN_MAIN:      [500, 800],
  KAIDAN_ED:        [180, 350],
};
