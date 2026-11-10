/**
 * Signalling for the room-code path. A Signaller only carries the WebRTC handshake (hello, offers, answers, roster);
 * game traffic always goes over direct WebRTC data channels. Interface:
 *
 *   join(room, selfId) -> Promise<void>      connect and announce ourselves
 *   send(toId|null, msg)                     small JSON message to one peer (or everybody when null)
 *   onMessage(cb(fromId, msg))               messages from peers
 *   onPeer(cb(id, 'join'|'leave'))           presence: a peer is (still) in the room / has left
 *   close()                                  say goodbye and release the transport
 *
 * Implementations: BroadcastSignaller (BroadcastChannel; tabs of one browser, tests, same-device demos) and MqttSignaller
 * (public MQTT brokers over WebSocket, no dependencies, see Mqtt.js). The manual copy/paste code swap in NetworkManager is
 * the fully offline fallback.
 * @module network/Signal
 */
import { MqttClient } from './Mqtt.js';

/** Public MQTT-over-WebSocket brokers tried in order. */
export const DEFAULT_BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081',
];

/** Topic prefix of every room: `roadrash/v1/<room>/<to>`, `<to>` being a peer id or `all`. */
export const TOPIC_ROOT = 'roadrash/v1';

/**
 * Shared presence/envelope logic. Envelope kinds: 'j' hello (broadcast; peers answer with 'h' to the sender only),
 * 'h' here, 'b' bye, 'm' message. Subclasses implement `_open(room, selfId)`, `_post(toId|null, env)`, `_shut()`.
 */
class BaseSignaller {
  constructor() {
    this.room = null;
    this.selfId = null;
    this._msgCbs = [];
    this._peerCbs = [];
    this._known = new Set();
    this._closed = false;
    /** @type {string|null} which endpoint is connected (MQTT broker URL, or 'broadcast') */
    this.endpoint = null;
  }

  /** @returns {Promise<void>} resolves once connected and announced */
  async join(room, selfId) {
    this.room = room;
    this.selfId = selfId;
    this._closed = false;
    await this._open(room, selfId);
    this._post(null, { f: selfId, k: 'j' });
  }

  /** @param {string|null} toId @param {any} msg JSON-safe @returns {void} */
  send(toId, msg) {
    if (this._closed) return;
    this._post(toId, { f: this.selfId, k: 'm', m: msg });
  }

  /** @param {(fromId:string, msg:any)=>void} cb @returns {void} */
  onMessage(cb) { this._msgCbs.push(cb); }
  /** @param {(id:string, kind:'join'|'leave')=>void} cb @returns {void} */
  onPeer(cb) { this._peerCbs.push(cb); }

  /** Announce departure and release the transport. @returns {void} */
  close() {
    if (this._closed) return;
    try { this._post(null, { f: this.selfId, k: 'b' }); } catch { /* ignore */ }
    this._closed = true;
    this._known.clear();
    this._shut();
  }

  _peer(id, kind) { for (const cb of this._peerCbs.slice()) { try { cb(id, kind); } catch { /* listener errors must not kill the transport */ } } }

  /** Feed an incoming envelope. */
  _deliver(env) {
    if (this._closed || !env || typeof env.f !== 'string' || env.f === this.selfId) return;
    if (env.to != null && env.to !== this.selfId) return;
    const f = env.f;
    if (env.k === 'b') {
      if (this._known.delete(f)) this._peer(f, 'leave');
      return;
    }
    if (!this._known.has(f)) { this._known.add(f); this._peer(f, 'join'); }
    if (env.k === 'j') this._post(f, { f: this.selfId, k: 'h' });
    else if (env.k === 'm') for (const cb of this._msgCbs.slice()) { try { cb(f, env.m); } catch { /* ignore */ } }
  }
}

/** Signaller over BroadcastChannel: peers are other tabs/frames of the same browser profile. */
export class BroadcastSignaller extends BaseSignaller {
  /** @param {{BroadcastChannel?:Function}} [opts] inject a BroadcastChannel constructor for tests */
  constructor(opts = {}) {
    super();
    this._BC = opts.BroadcastChannel || globalThis.BroadcastChannel;
    this._bc = null;
  }

  /** @returns {boolean} true when BroadcastChannel exists here */
  static available() { return typeof globalThis.BroadcastChannel === 'function'; }

  async _open(room) {
    if (typeof this._BC !== 'function') throw new Error('BroadcastChannel is not available');
    this._bc = new this._BC('roadrash-v1-' + room);
    this._bc.onmessage = (ev) => this._deliver(ev.data);
    this.endpoint = 'broadcast';
  }

  _post(to, env) { if (this._bc) { if (to != null) env = { ...env, to }; this._bc.postMessage(env); } }

  _shut() { if (this._bc) { try { this._bc.close(); } catch { /* ignore */ } this._bc = null; } }
}

/**
 * Signaller over a public MQTT broker (MQTT 3.1.1 over WebSocket, implemented in Mqtt.js). Endpoints are tried in order,
 * each with a timeout; `endpoint` tells which one connected. Topics: `roadrash/v1/<room>/<peerId>` and `.../all`.
 * A last-will 'bye' on `all` announces crashed peers. Anyone who knows the room code can read the room's handshake
 * traffic; it carries SDP only, and the code is the shared secret.
 */
export class MqttSignaller extends BaseSignaller {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.endpoints] broker URLs in order (default DEFAULT_BROKERS)
   * @param {number} [opts.timeoutMs=4000] per-endpoint timeout (connect + subscribe)
   * @param {Function} [opts.WebSocket] injected WebSocket constructor (tests)
   * @param {()=>void} [opts.onDisconnect] called when an established connection drops
   * @param {number} [opts.keepAliveS=30]
   */
  constructor(opts = {}) {
    super();
    this.endpoints = opts.endpoints || DEFAULT_BROKERS;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this._WS = opts.WebSocket;
    this._onDisconnect = opts.onDisconnect || null;
    this.keepAliveS = opts.keepAliveS ?? 30;
    this._client = null;
    /** @type {{url:string, error:string}[]} failures of the endpoints that were tried before the working one */
    this.failures = [];
  }

  /** @returns {boolean} true when a WebSocket constructor is available */
  static available() { return typeof globalThis.WebSocket === 'function'; }

  _topic(to) { return `${TOPIC_ROOT}/${this.room}/${to}`; }

  async _open(room, selfId) {
    this.failures = [];
    const dec = new TextDecoder();
    for (const url of this.endpoints) {
      const client = new MqttClient({
        url, WebSocket: this._WS, keepAliveS: this.keepAliveS,
        clientId: 'rr' + selfId + Math.floor(Math.random() * 0xffff).toString(16),
        will: { topic: this._topic('all'), payload: JSON.stringify({ f: selfId, k: 'b' }) },
        onMessage: (topic, payload) => {
          let env;
          try { env = JSON.parse(dec.decode(payload)); } catch { return; }
          this._deliver(env);
        },
        onClose: () => { if (!this._closed && this._onDisconnect) this._onDisconnect(); },
      });
      try {
        await client.connect(this.timeoutMs);
        await client.subscribe([this._topic(selfId), this._topic('all')], this.timeoutMs);
        this._client = client;
        this.endpoint = url;
        return;
      } catch (e) {
        this.failures.push({ url, error: (e && e.message) || String(e) });
        client.close();
      }
    }
    const err = new Error('Could not reach any signalling relay (' + this.failures.map((f) => f.url + ': ' + f.error).join('; ') + ')');
    err.code = 'RELAY_UNREACHABLE';
    err.failures = this.failures;
    throw err;
  }

  _post(to, env) {
    if (!this._client) return;
    if (to != null) env = { ...env, to };
    this._client.publish(this._topic(to == null ? 'all' : to), JSON.stringify(env));
  }

  _shut() { if (this._client) { this._client.close(); this._client = null; } }
}

/**
 * Pick a signaller for the room-code path: MQTT relay when WebSocket exists, else BroadcastChannel, else null.
 * @param {object} [opts] passed to MqttSignaller
 * @returns {BaseSignaller|null}
 */
export function defaultSignaller(opts = {}) {
  if (MqttSignaller.available() || opts.WebSocket) return new MqttSignaller(opts);
  if (BroadcastSignaller.available()) return new BroadcastSignaller();
  return null;
}
