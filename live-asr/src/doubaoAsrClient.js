import { gzipSync, gunzipSync } from "node:zlib";
import { randomBytes, randomUUID } from "node:crypto";
import tls from "node:tls";

const DEFAULT_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration";

const MESSAGE_TYPE = {
  FULL_CLIENT_REQUEST: 0x1,
  AUDIO_ONLY_REQUEST: 0x2,
  FULL_SERVER_RESPONSE: 0x9,
  SERVER_ACK: 0xb,
  ERROR_RESPONSE: 0xf
};

const FLAGS = {
  NO_SEQUENCE: 0x0,
  POS_SEQUENCE: 0x1,
  NEG_SEQUENCE: 0x3
};

const SERIALIZATION = {
  NONE: 0x0,
  JSON: 0x1
};

const COMPRESSION = {
  NONE: 0x0,
  GZIP: 0x1
};

export async function transcribePcmWithDoubao({
  pcmBytes,
  language = "zh-CN",
  sampleRate = 16000,
  appKey = process.env.DOUBAO_ASR_APP_KEY || process.env.VOLCENGINE_ASR_APP_KEY,
  accessKey = process.env.DOUBAO_ASR_ACCESS_KEY || process.env.VOLCENGINE_ASR_ACCESS_KEY,
  apiKey = process.env.DOUBAO_ASR_API_KEY || process.env.DOUBAO_API_KEY || process.env.VOLCENGINE_API_KEY,
  resourceId = process.env.DOUBAO_ASR_RESOURCE_ID || DEFAULT_RESOURCE_ID,
  endpoint = process.env.DOUBAO_ASR_ENDPOINT || DEFAULT_ENDPOINT,
  chunkMs = 200,
  enableSpeakerInfo = true,
  requestId = randomUUID()
}) {
  if (!pcmBytes?.byteLength) throw new Error("pcmBytes is required.");
  const headers = buildAuthHeaders({ appKey, accessKey, apiKey, resourceId });
  const ws = await connectWebSocketWithHeaders(endpoint, headers);

  const results = [];
  try {
    ws.send(encodeFullClientRequest({
      user: { uid: "live-observer" },
      audio: {
        format: "pcm",
        codec: "raw",
        rate: sampleRate,
        bits: 16,
        channel: 1,
        language
      },
      request: {
        model_name: "bigmodel",
        result_type: "full",
        enable_itn: true,
        enable_punc: true,
        enable_ddc: false,
        show_utterances: true,
        enable_speaker_info: Boolean(enableSpeakerInfo),
        ssd_version: enableSpeakerInfo ? "200" : undefined,
        reqid: requestId
      }
    }));

    const bytesPerChunk = Math.max(1, Math.floor(sampleRate * 2 * (chunkMs / 1000)));
    let sequence = 2;
    for (let offset = 0; offset < pcmBytes.byteLength; offset += bytesPerChunk) {
      const chunk = pcmBytes.slice(offset, Math.min(offset + bytesPerChunk, pcmBytes.byteLength));
      const isLast = offset + bytesPerChunk >= pcmBytes.byteLength;
      ws.send(encodeAudioOnlyRequest(chunk, {
        sequence,
        isLast
      }));
      sequence += 1;
      if (!isLast) await delay(chunkMs);
    }

    for await (const message of ws) {
      const parsed = decodeServerMessage(message);
      if (parsed.payload) results.push(parsed.payload);
      if (parsed.isFinal || hasFinalText(parsed.payload)) break;
    }
  } finally {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  return normalizeAsrResults(results, { language });
}

export function buildAuthHeaders({ appKey, accessKey, apiKey, resourceId = DEFAULT_RESOURCE_ID }) {
  const requestId = randomUUID();
  if (appKey && accessKey) {
    return {
      "X-Api-App-Key": appKey,
      "X-Api-Access-Key": accessKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": requestId,
      "X-Api-Connect-Id": randomUUID(),
      "X-Api-Sequence": "-1"
    };
  }

  if (apiKey) {
    return {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": requestId,
      "X-Api-Connect-Id": randomUUID(),
      "X-Api-Sequence": "-1"
    };
  }

  throw new Error("Doubao ASR credentials required: set DOUBAO_ASR_APP_KEY + DOUBAO_ASR_ACCESS_KEY, or DOUBAO_ASR_API_KEY.");
}

function encodeFullClientRequest(payload) {
  const json = JSON.stringify(stripUndefined(payload));
  const compressed = gzipSync(Buffer.from(json));
  return frame({
    messageType: MESSAGE_TYPE.FULL_CLIENT_REQUEST,
    flags: FLAGS.NO_SEQUENCE,
    serialization: SERIALIZATION.JSON,
    compression: COMPRESSION.GZIP,
    payload: compressed
  });
}

function encodeAudioOnlyRequest(payload, { sequence, isLast }) {
  return frame({
    messageType: MESSAGE_TYPE.AUDIO_ONLY_REQUEST,
    flags: isLast ? FLAGS.NEG_SEQUENCE : FLAGS.POS_SEQUENCE,
    serialization: SERIALIZATION.NONE,
    compression: COMPRESSION.GZIP,
    sequence: isLast ? -Math.abs(sequence) : sequence,
    payload: gzipSync(Buffer.from(payload))
  });
}

function frame({ messageType, flags, serialization, compression, sequence, payload }) {
  const hasSequence = flags === FLAGS.POS_SEQUENCE || flags === FLAGS.NEG_SEQUENCE;
  const header = Buffer.from([
    (0x1 << 4) | 0x1,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.byteLength, 0);

  if (!hasSequence) return Buffer.concat([header, size, payload]);

  const seq = Buffer.alloc(4);
  seq.writeInt32BE(sequence, 0);
  return Buffer.concat([header, seq, size, payload]);
}

function decodeServerMessage(data) {
  const buffer = Buffer.from(data);
  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;
  let offset = headerSize;
  let sequence = null;

  if (flags === FLAGS.POS_SEQUENCE || flags === FLAGS.NEG_SEQUENCE) {
    sequence = buffer.readInt32BE(offset);
    offset += 4;
  }

  const payloadSize = buffer.readUInt32BE(offset);
  offset += 4;
  let payloadBytes = buffer.slice(offset, offset + payloadSize);
  if (compression === COMPRESSION.GZIP && payloadBytes.length) {
    payloadBytes = gunzipSync(payloadBytes);
  }

  if (messageType === MESSAGE_TYPE.ERROR_RESPONSE) {
    throw new Error(payloadBytes.toString("utf8") || "Doubao ASR error response.");
  }

  let payload = null;
  if (serialization === SERIALIZATION.JSON && payloadBytes.length) {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  }

  return {
    messageType,
    sequence,
    payload,
    isFinal: flags === FLAGS.NEG_SEQUENCE || sequence < 0
  };
}

function normalizeAsrResults(results, { language }) {
  const resultItems = results.flatMap((item) => {
    if (Array.isArray(item?.result)) return item.result;
    if (item?.result) return [item.result];
    return [];
  });
  const text = resultItems.map((item) => item.text).filter(Boolean).at(-1) || "";
  const utterances = resultItems
    .flatMap((item) => item.utterances || [])
    .map((utterance) => {
      const additions = utterance.additions || null;
      return {
        speaker: utterance.speaker || utterance.speaker_id || utterance.spk || additions?.speaker_id || null,
        text: utterance.text || "",
        startTimeMs: utterance.start_time ?? utterance.startTimeMs ?? null,
        endTimeMs: utterance.end_time ?? utterance.endTimeMs ?? null,
        definite: utterance.definite ?? null,
        additions
      };
    })
    .filter((utterance) => utterance.text);

  return {
    provider: "doubao",
    language,
    text,
    utterances,
    raw: results
  };
}

function hasFinalText(payload) {
  const result = Array.isArray(payload?.result) ? payload.result : payload?.result ? [payload.result] : [];
  return result.some((item) => item.text && (item.utterances || []).some((utterance) => utterance.definite));
}

async function connectWebSocketWithHeaders(endpoint, headers) {
  const url = new URL(endpoint);
  if (url.protocol !== "wss:") throw new Error("Only wss:// ASR endpoints are supported.");

  const socket = tls.connect({
    host: url.hostname,
    port: Number(url.port || 443),
    servername: url.hostname
  });
  await once(socket, "secureConnect", 10000);

  const key = randomBytes(16).toString("base64");
  const requestHeaders = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${key}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    ""
  ].join("\r\n");
  socket.write(requestHeaders);

  const { statusLine, headersText, bodyText, remaining } = await readHandshake(socket);
  if (!/^HTTP\/1\.1 101\b/.test(statusLine)) {
    socket.destroy();
    throw new Error(`Doubao ASR WebSocket handshake failed: ${statusLine}\n${headersText}${bodyText ? `\n${bodyText}` : ""}`);
  }

  return new RawWebSocket(socket, remaining);
}

class RawWebSocket {
  constructor(socket, initialBytes = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.from(initialBytes);
    this.items = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.closeQueue());
  }

  send(payload) {
    this.socket.write(encodeWebSocketFrame(Buffer.from(payload), 0x2));
  }

  close() {
    if (!this.socket.destroyed) {
      try {
        this.socket.write(encodeWebSocketFrame(Buffer.alloc(0), 0x8));
      } catch {
        // ignore
      }
      this.socket.destroy();
    }
    this.closeQueue();
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = tryDecodeWebSocketFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.slice(frame.frameLength);

      if (frame.opcode === 0x8) {
        this.closeQueue();
        return;
      }
      if (frame.opcode === 0x9) {
        this.socket.write(encodeWebSocketFrame(frame.payload, 0xa));
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(frame.payload);
        else this.items.push(frame.payload);
      }
    }
  }

  fail(error) {
    this.error = error;
    while (this.waiters.length) this.waiters.shift().reject(error);
  }

  closeQueue() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift().resolve(null);
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve: (value) => {
      if (value == null) resolve({ value: undefined, done: true });
      else resolve({ value, done: false });
    }, reject }));
  }
}

function encodeWebSocketFrame(payload, opcode = 0x2) {
  const length = payload.byteLength;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const maskKey = randomBytes(4);
  const frame = Buffer.alloc(headerLength + 4 + length);
  frame[0] = 0x80 | opcode;

  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }

  const maskOffset = headerLength;
  maskKey.copy(frame, maskOffset);
  for (let i = 0; i < length; i += 1) {
    frame[maskOffset + 4 + i] = payload[i] ^ maskKey[i % 4];
  }
  return frame;
}

function tryDecodeWebSocketFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = Boolean(buffer[1] & 0x80);
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }

  return {
    opcode,
    payload,
    frameLength: offset + length
  };
}

async function readHandshake(socket) {
  let buffer = Buffer.alloc(0);
  while (true) {
    const chunk = await once(socket, "data", 10000);
    buffer = Buffer.concat([buffer, chunk]);
    const index = buffer.indexOf("\r\n\r\n");
    if (index >= 0) {
      const head = buffer.slice(0, index).toString("utf8");
      const contentLengthMatch = head.match(/^Content-Length:\s*(\d+)/im);
      const contentLength = contentLengthMatch ? Number(contentLengthMatch[1]) : 0;
      while (contentLength && buffer.length < index + 4 + contentLength) {
        const bodyChunk = await once(socket, "data", 10000);
        buffer = Buffer.concat([buffer, bodyChunk]);
      }
      const body = contentLength
        ? buffer.slice(index + 4, index + 4 + contentLength).toString("utf8")
        : "";
      return {
        statusLine: head.split(/\r?\n/)[0],
        headersText: head,
        bodyText: body,
        remaining: buffer.slice(index + 4)
      };
    }
  }
}

function once(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (...args) => {
      cleanup();
      resolve(args.length > 1 ? args : args[0]);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
      emitter.off("error", onError);
    };
    emitter.on(event, onEvent);
    emitter.on("error", onError);
  });
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)])
    );
  }
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
