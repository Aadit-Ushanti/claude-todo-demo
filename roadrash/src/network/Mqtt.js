/**
 * Minimal MQTT 3.1.1 over WebSocket (binary frames), QoS 0 only: CONNECT, CONNACK, SUBSCRIBE, SUBACK, PUBLISH,
 * PINGREQ/PINGRESP, DISCONNECT. No dependencies, no DOM. Used by the room-code signalling relay (src/network/Signal.js).
 * The packet encoders/decoders are exported so the framing can be unit-tested (and a fake broker built from them).
 * @module network/Mqtt
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** MQTT control packet types. */
export const PT = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9, UNSUBSCRIBE: 10, UNSUBACK: 11, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };

/**
 * Encode the variable-length "remaining length" field (1-4 bytes, 7 bits each, continuation bit 0x80).
 * @param {number} n 0..268435455
 * @returns {number[]}
 */
export function encodeRemainingLength(n) {
  if (!(n >= 0 && n <= 268435455)) throw new RangeError('remaining length out of range');
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

/**
 * Decode a remaining length starting at `offset`.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {{value:number, bytes:number}|null} null when the field is incomplete; throws when malformed (more than 4 bytes)
 */
export function decodeRemainingLength(bytes, offset) {
  let value = 0;
  let mul = 1;
  for (let i = 0; i < 4; i++) {
    if (offset + i >= bytes.length) return null;
    const b = bytes[offset + i];
    value += (b & 0x7f) * mul;
    if (!(b & 0x80)) return { value, bytes: i + 1 };
    mul *= 128;
  }
  throw new Error('malformed remaining length');
}

const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const str = (s) => { const b = enc.encode(s); return [...u16(b.length), ...b]; };
const asBytes = (p) => (typeof p === 'string' ? enc.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p));

function packet(typeAndFlags, body) {
  const rl = encodeRemainingLength(body.length);
  const out = new Uint8Array(1 + rl.length + body.length);
  out[0] = typeAndFlags;
  out.set(rl, 1);
  out.set(body, 1 + rl.length);
  return out;
}

/**
 * Encode a CONNECT packet (protocol level 4, no credentials).
 * @param {{clientId:string, keepAlive?:number, clean?:boolean, will?:{topic:string, payload:string|Uint8Array}}} o
 * @returns {Uint8Array}
 */
export function encodeConnect(o) {
  let flags = o.clean === false ? 0 : 0x02;
  const payload = [...str(o.clientId)];
  if (o.will) {
    flags |= 0x04; // will flag, QoS 0, no retain
    const wp = asBytes(o.will.payload);
    payload.push(...str(o.will.topic), ...u16(wp.length), ...wp);
  }
  return packet(PT.CONNECT << 4, new Uint8Array([...str('MQTT'), 4, flags, ...u16(o.keepAlive ?? 30), ...payload]));
}

/** @param {number} [code=0] return code @param {boolean} [sessionPresent=false] @returns {Uint8Array} a CONNACK packet */
export function encodeConnack(code = 0, sessionPresent = false) {
  return packet(PT.CONNACK << 4, new Uint8Array([sessionPresent ? 1 : 0, code]));
}

/**
 * Encode a SUBSCRIBE packet (QoS 0 for every filter).
 * @param {number} id packet id (1..65535)
 * @param {string[]} topics topic filters
 * @returns {Uint8Array}
 */
export function encodeSubscribe(id, topics) {
  const b = [...u16(id)];
  for (const t of topics) b.push(...str(t), 0);
  return packet((PT.SUBSCRIBE << 4) | 0x02, new Uint8Array(b));
}

/** @param {number} id @param {number[]} codes granted QoS per filter (0x80 = failure) @returns {Uint8Array} a SUBACK packet */
export function encodeSuback(id, codes) {
  return packet(PT.SUBACK << 4, new Uint8Array([...u16(id), ...codes]));
}

/**
 * Encode a PUBLISH packet (QoS 0, or QoS 1 when opts.qos is 1 and opts.id is given).
 * @param {string} topic
 * @param {string|Uint8Array} payload
 * @param {{retain?:boolean, qos?:0|1, id?:number}} [opts]
 * @returns {Uint8Array}
 */
export function encodePublish(topic, payload, opts = {}) {
  const qos = opts.qos || 0;
  const p = asBytes(payload);
  const head = [...str(topic)];
  if (qos > 0) head.push(...u16(opts.id || 1));
  const body = new Uint8Array(head.length + p.length);
  body.set(head, 0);
  body.set(p, head.length);
  return packet((PT.PUBLISH << 4) | (qos << 1) | (opts.retain ? 1 : 0), body);
}

/** @returns {Uint8Array} PINGREQ */
export const encodePingreq = () => new Uint8Array([PT.PINGREQ << 4, 0]);
/** @returns {Uint8Array} PINGRESP */
export const encodePingresp = () => new Uint8Array([PT.PINGRESP << 4, 0]);
/** @returns {Uint8Array} DISCONNECT */
export const encodeDisconnect = () => new Uint8Array([PT.DISCONNECT << 4, 0]);
/** @param {number} id @returns {Uint8Array} PUBACK */
export const encodePuback = (id) => packet(PT.PUBACK << 4, new Uint8Array(u16(id)));

/**
 * Incremental stream parser: feed arbitrary chunks (frames may be split or concatenated) and get whole packets back.
 */
export class MqttParser {
  constructor() { this.buf = new Uint8Array(0); }

  /**
   * @param {Uint8Array|ArrayBuffer} chunk
   * @returns {{type:number, flags:number, body:Uint8Array}[]} complete packets in this chunk (zero or more)
   */
  push(chunk) {
    const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (this.buf.length) {
      const m = new Uint8Array(this.buf.length + c.length);
      m.set(this.buf, 0);
      m.set(c, this.buf.length);
      this.buf = m;
    } else this.buf = c;
    const out = [];
    let o = 0;
    for (;;) {
      if (this.buf.length - o < 2) break;
      const rl = decodeRemainingLength(this.buf, o + 1);
      if (!rl) break;
      const start = o + 1 + rl.bytes;
      if (this.buf.length - start < rl.value) break;
      out.push({ type: this.buf[o] >> 4, flags: this.buf[o] & 0x0f, body: this.buf.slice(start, start + rl.value) });
      o = start + rl.value;
    }
    this.buf = o ? this.buf.slice(o) : this.buf;
    return out;
  }
}

function readStr(b, o) {
  const n = (b[o] << 8) | b[o + 1];
  return { s: dec.decode(b.subarray(o + 2, o + 2 + n)), next: o + 2 + n };
}

/**
 * Decode a parsed packet into a typed object.
 * @param {{type:number, flags:number, body:Uint8Array}} p
 * @returns {object} {type:'connect'|'connack'|'subscribe'|'suback'|'publish'|'puback'|'pingreq'|'pingresp'|'disconnect'|'unknown', ...fields}
 */
export function decodePacket(p) {
  const b = p.body;
  switch (p.type) {
    case PT.CONNECT: {
      let { s: proto, next } = readStr(b, 0);
      const level = b[next++];
      const flags = b[next++];
      const keepAlive = (b[next] << 8) | b[next + 1];
      next += 2;
      const cid = readStr(b, next);
      next = cid.next;
      const r = { type: 'connect', proto, level, clean: !!(flags & 2), keepAlive, clientId: cid.s, will: null };
      if (flags & 4) {
        const wt = readStr(b, next);
        const wl = (b[wt.next] << 8) | b[wt.next + 1];
        r.will = { topic: wt.s, payload: b.slice(wt.next + 2, wt.next + 2 + wl) };
      }
      return r;
    }
    case PT.CONNACK: return { type: 'connack', sessionPresent: !!(b[0] & 1), code: b[1] };
    case PT.SUBSCRIBE: {
      const id = (b[0] << 8) | b[1];
      const topics = [];
      let o = 2;
      while (o < b.length) { const t = readStr(b, o); topics.push({ filter: t.s, qos: b[t.next] }); o = t.next + 1; }
      return { type: 'subscribe', id, topics };
    }
    case PT.SUBACK: return { type: 'suback', id: (b[0] << 8) | b[1], codes: [...b.subarray(2)] };
    case PT.PUBLISH: {
      const qos = (p.flags >> 1) & 3;
      const t = readStr(b, 0);
      let o = t.next;
      let id = null;
      if (qos > 0) { id = (b[o] << 8) | b[o + 1]; o += 2; }
      return { type: 'publish', topic: t.s, qos, retain: !!(p.flags & 1), id, payload: b.slice(o) };
    }
    case PT.PUBACK: return { type: 'puback', id: (b[0] << 8) | b[1] };
    case PT.PINGREQ: return { type: 'pingreq' };
    case PT.PINGRESP: return { type: 'pingresp' };
    case PT.DISCONNECT: return { type: 'disconnect' };
    default: return { type: 'unknown', code: p.type };
  }
}

/**
 * MQTT client over a WebSocket-like object.
 */
export class MqttClient {
  /**
   * @param {object} o
   * @param {string} o.url ws:// or wss:// endpoint
   * @param {Function} [o.WebSocket] constructor (default globalThis.WebSocket); called as new WebSocket(url, 'mqtt')
   * @param {string} o.clientId
   * @param {number} [o.keepAliveS=30]
   * @param {{topic:string, payload:string}} [o.will] last will published by the broker when the connection drops
   * @param {(topic:string, payload:Uint8Array)=>void} [o.onMessage]
   * @param {()=>void} [o.onClose]
   */
  constructor(o) {
    this.o = o;
    this.ws = null;
    this.parser = new MqttParser();
    this.connected = false;
    this.closed = false;
    this._acks = new Map();
    this._pid = 0;
    this._ping = null;
    this._connect = null;
  }

  /**
   * Open the socket and complete the MQTT handshake.
   * @param {number} [timeoutMs=5000] covers socket open + CONNACK
   * @returns {Promise<void>} rejects on timeout, socket error or a refused CONNACK
   */
  connect(timeoutMs = 5000) {
    const WS = this.o.WebSocket || globalThis.WebSocket;
    if (typeof WS !== 'function') return Promise.reject(new Error('WebSocket is not available'));
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.close();
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      const timer = setTimeout(() => fail(new Error('timeout connecting to ' + this.o.url)), timeoutMs);
      this._connect = { ok: () => { if (!done) { done = true; clearTimeout(timer); resolve(); } }, fail };
      let ws;
      try { ws = new WS(this.o.url, 'mqtt'); } catch (e) { return fail(e); }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this._send(encodeConnect({ clientId: this.o.clientId, keepAlive: this.o.keepAliveS ?? 30, will: this.o.will }));
      };
      ws.onmessage = (ev) => this._onData(ev.data);
      ws.onerror = () => fail(new Error('WebSocket error for ' + this.o.url));
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        this._stopPing();
        if (!done) fail(new Error('connection closed before CONNACK'));
        for (const a of this._acks.values()) a.reject(new Error('connection closed'));
        this._acks.clear();
        if (was && !this.closed && this.o.onClose) this.o.onClose();
        this.closed = true;
      };
    });
  }

  _send(bytes) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(bytes);
  }

  _startPing() {
    const every = Math.max(1, (this.o.keepAliveS ?? 30) / 2) * 1000;
    this._ping = setInterval(() => this._send(encodePingreq()), every);
    if (this._ping && this._ping.unref) this._ping.unref();
  }

  _stopPing() { if (this._ping) clearInterval(this._ping); this._ping = null; }

  _onData(data) {
    if (typeof data === 'string' || !data) return; // MQTT over WebSocket is binary only
    let pkts;
    try { pkts = this.parser.push(ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data); } catch (e) { return this._connect && this._connect.fail(e); }
    for (const raw of pkts) {
      const p = decodePacket(raw);
      if (p.type === 'connack') {
        if (p.code === 0) { this.connected = true; this._startPing(); this._connect.ok(); } else this._connect.fail(new Error('broker refused the connection (code ' + p.code + ')'));
      } else if (p.type === 'suback') {
        const a = this._acks.get(p.id);
        if (a) { this._acks.delete(p.id); if (p.codes.some((c) => c === 0x80)) a.reject(new Error('subscription refused')); else a.resolve(); }
      } else if (p.type === 'publish') {
        if (p.qos === 1) this._send(encodePuback(p.id));
        if (this.o.onMessage) this.o.onMessage(p.topic, p.payload);
      }
    }
  }

  /**
   * Subscribe (QoS 0) and wait for the SUBACK.
   * @param {string[]} topics
   * @param {number} [timeoutMs=4000]
   * @returns {Promise<void>}
   */
  subscribe(topics, timeoutMs = 4000) {
    const id = (this._pid = (this._pid % 65535) + 1);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this._acks.delete(id); reject(new Error('SUBACK timeout')); }, timeoutMs);
      this._acks.set(id, { resolve: () => { clearTimeout(t); resolve(); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this._send(encodeSubscribe(id, topics));
    });
  }

  /** Publish with QoS 0. @param {string} topic @param {string|Uint8Array} payload @returns {void} */
  publish(topic, payload) { if (this.connected) this._send(encodePublish(topic, payload)); }

  /** Say goodbye and close the socket. @returns {void} */
  close() {
    this.closed = true;
    this._stopPing();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try { if (ws.readyState === 1 && this.connected) ws.send(encodeDisconnect()); } catch { /* ignore */ }
    this.connected = false;
    try { ws.close(); } catch { /* ignore */ }
  }
}
