import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

export class ObsClient extends EventEmitter {
  constructor({ url = "ws://127.0.0.1:4455", password = "" } = {}) {
    super();
    this.url = url;
    this.password = password;
    this.ws = null;
    this.connected = false;
    this.identified = false;
    this.streaming = false;
    this.recording = false;
    this.currentScene = "";
    this.scenes = [];
    this._requestId = 0;
    this._pending = new Map();
  }

  connect() {
    if (this.ws) this.disconnect();
    return new Promise((resolve, reject) => {
      let resolved = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this.emit("connected");
      };
      ws.onclose = () => {
        this._handleClose();
        if (!resolved) { resolved = true; reject(new Error("OBS connection closed")); }
      };
      ws.onerror = () => {
        if (!resolved) { resolved = true; reject(new Error("OBS connection failed")); }
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
        this._handleMessage(msg).then(() => {
          if (this.identified && !resolved) {
            resolved = true;
            resolve();
          }
        });
      };
    });
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.identified = false;
    this.streaming = false;
    this.recording = false;
    this.currentScene = "";
    this.scenes = [];
    for (const [, p] of this._pending) p.reject(new Error("Disconnected"));
    this._pending.clear();
    this.emit("disconnected");
  }

  async _handleMessage(msg) {
    switch (msg.op) {
      case 0: // Hello
        this._identify(msg.d);
        break;
      case 2: // Identified
        this.identified = true;
        this.emit("identified");
        await this._syncState();
        break;
      case 5: // Event
        this._handleEvent(msg.d);
        break;
      case 7: { // RequestResponse
        const pending = this._pending.get(msg.d.requestId);
        if (pending) {
          this._pending.delete(msg.d.requestId);
          if (msg.d.requestStatus.result) pending.resolve(msg.d.responseData);
          else pending.reject(new Error(msg.d.requestStatus.comment || "OBS request failed"));
        }
        break;
      }
    }
  }

  _identify(hello) {
    const auth = hello.authentication;
    let authentication;
    if (auth && this.password) {
      const secret = createHash("sha256").update(this.password + auth.salt).digest("base64");
      authentication = createHash("sha256").update(secret + auth.challenge).digest("base64");
    }
    this.ws.send(JSON.stringify({
      op: 1,
      d: { rpcVersion: 1, authentication, eventSubscriptions: 0x01 | 0x40 },
    }));
  }

  _handleEvent(event) {
    switch (event.eventType) {
      case "StreamStateChanged":
        this.streaming = event.eventData.outputActive;
        this.emit("streamStateChanged", this.streaming);
        break;
      case "RecordStateChanged":
        this.recording = event.eventData.outputActive;
        this.emit("recordStateChanged", this.recording);
        break;
      case "CurrentProgramSceneChanged":
        this.currentScene = event.eventData.sceneName;
        this.emit("sceneChanged", this.currentScene);
        break;
    }
  }

  async _syncState() {
    try {
      const [stream, scenes, scene] = await Promise.all([
        this.request("GetStreamStatus").catch(() => null),
        this.request("GetSceneList").catch(() => null),
        this.request("GetCurrentProgramScene").catch(() => null),
      ]);
      if (stream) this.streaming = stream.outputActive;
      if (scenes) this.scenes = (scenes.scenes || []).map(s => s.sceneName).reverse();
      if (scene) this.currentScene = scene.currentProgramSceneName;
      this.emit("synced");
    } catch {}
  }

  _handleClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.identified = false;
    this.ws = null;
    for (const [, p] of this._pending) p.reject(new Error("Connection closed"));
    this._pending.clear();
    if (wasConnected) this.emit("disconnected");
  }

  request(requestType, requestData) {
    if (!this.ws || !this.identified) return Promise.reject(new Error("Not connected to OBS"));
    const requestId = String(++this._requestId);
    return new Promise((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      setTimeout(() => {
        if (this._pending.has(requestId)) {
          this._pending.delete(requestId);
          reject(new Error("OBS request timeout"));
        }
      }, 10000);
    });
  }

  async startStream() { await this.request("StartStream"); }
  async stopStream() { await this.request("StopStream"); }
  async setScene(sceneName) { await this.request("SetCurrentProgramScene", { sceneName }); }

  snapshot() {
    return {
      connected: this.connected,
      identified: this.identified,
      streaming: this.streaming,
      recording: this.recording,
      currentScene: this.currentScene,
      scenes: this.scenes,
    };
  }
}
