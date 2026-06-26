import { EventEmitter } from "node:events";

const TRANSITIONS = {
  idle:      ["preparing"],
  preparing: ["ready", "idle"],
  ready:     ["starting", "idle"],
  starting:  ["live", "idle"],
  live:      ["pausing", "ending"],
  pausing:   ["paused", "live"],
  paused:    ["live", "ending"],
  ending:    ["ended"],
  ended:     ["idle"],
};

export class BroadcastState extends EventEmitter {
  constructor() {
    super();
    this.state = "idle";
    this.startedAt = null;
  }

  get canTransition() {
    return TRANSITIONS[this.state] || [];
  }

  transition(next) {
    const allowed = TRANSITIONS[this.state];
    if (!allowed?.includes(next)) {
      throw new Error(`Cannot transition from "${this.state}" to "${next}"`);
    }
    const prev = this.state;
    this.state = next;
    if (next === "live" && !this.startedAt) this.startedAt = Date.now();
    if (next === "idle") this.startedAt = null;
    this.emit("transition", { from: prev, to: next });
    return this.snapshot();
  }

  snapshot() {
    return {
      state: this.state,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      canTransition: this.canTransition,
    };
  }
}
