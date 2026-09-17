/**
 * Decoder for the AWS `vnd.amazon.eventstream` framing Bedrock streams in.
 *
 * Not SSE. Each message is a binary frame:
 *
 *   4  total byte length
 *   4  headers byte length
 *   4  CRC32 of the twelve-byte prelude's first eight bytes
 *   n  headers
 *   m  payload
 *   4  CRC32 of everything before it
 *
 * Every header is a name-length byte, the name, a type byte, and a value whose
 * encoding depends on the type. Only string headers matter here — the event
 * type — so the rest are skipped by length rather than parsed.
 *
 * Written to the published spec and exercised against frames this module's own
 * encoder builds. That proves it is self-consistent, not that it matches what
 * Bedrock emits; the prelude CRC is checked precisely so a real stream that
 * disagrees fails loudly at the first frame instead of quietly metering zero.
 */

const PRELUDE_BYTES = 12;
const MESSAGE_CRC_BYTES = 4;

/** CRC-32 (IEEE 802.3), which is what the framing specifies. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

export interface EventStreamMessage {
  /** The `:event-type` header, when the frame carried one. */
  readonly eventType: string | undefined;
  readonly payload: Buffer;
}

function readHeaders(buffer: Buffer): Map<string, string> {
  const headers = new Map<string, string>();
  let at = 0;

  while (at < buffer.length) {
    const nameLength = buffer.readUInt8(at);
    at += 1;
    const name = buffer.subarray(at, at + nameLength).toString("utf8");
    at += nameLength;
    const type = buffer.readUInt8(at);
    at += 1;

    switch (type) {
      case 0: // true
      case 1: // false
        break;
      case 2: // byte
        at += 1;
        break;
      case 3: // short
        at += 2;
        break;
      case 4: // integer
        at += 4;
        break;
      case 5: // long
      case 8: // timestamp
        at += 8;
        break;
      case 6: {
        // byte array
        const length = buffer.readUInt16BE(at);
        at += 2 + length;
        break;
      }
      case 7: {
        // string — the only type this decoder reads
        const length = buffer.readUInt16BE(at);
        at += 2;
        headers.set(name, buffer.subarray(at, at + length).toString("utf8"));
        at += length;
        break;
      }
      case 9: // uuid
        at += 16;
        break;
      default:
        // An unknown header type means the rest of this block cannot be walked
        // safely; stop rather than guess at an offset.
        return headers;
    }
  }

  return headers;
}

/**
 * Incremental decoder. Feed bytes as they arrive; take whole messages out.
 *
 * Never throws: the caller's stream is already being forwarded, and a framing
 * problem must degrade to unmetered rather than break the response. Problems
 * are counted so the call can be recorded as unpriced instead of free.
 */
export class EventStreamDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  #errors = 0;

  get errors(): number {
    return this.#errors;
  }

  push(chunk: Buffer): EventStreamMessage[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const out: EventStreamMessage[] = [];

    for (;;) {
      if (this.#buffer.length < PRELUDE_BYTES) break;

      const totalLength = this.#buffer.readUInt32BE(0);
      const headersLength = this.#buffer.readUInt32BE(4);

      // A frame that claims an implausible size means the stream is not what
      // it says it is. Discard rather than allocate against it.
      if (totalLength < PRELUDE_BYTES + MESSAGE_CRC_BYTES || totalLength > 16 * 1024 * 1024) {
        this.#errors += 1;
        this.#buffer = Buffer.alloc(0);
        break;
      }
      if (this.#buffer.length < totalLength) break;

      const preludeCrc = this.#buffer.readUInt32BE(8);
      if (crc32(this.#buffer.subarray(0, 8)) !== preludeCrc) {
        // Loudly wrong beats quietly metering zero.
        this.#errors += 1;
        this.#buffer = Buffer.alloc(0);
        break;
      }

      const headerStart = PRELUDE_BYTES;
      const payloadStart = headerStart + headersLength;
      const payloadEnd = totalLength - MESSAGE_CRC_BYTES;

      if (payloadStart > payloadEnd) {
        this.#errors += 1;
        this.#buffer = this.#buffer.subarray(totalLength);
        continue;
      }

      let eventType: string | undefined;
      try {
        eventType = readHeaders(this.#buffer.subarray(headerStart, payloadStart)).get(":event-type");
      } catch {
        this.#errors += 1;
      }

      out.push({ eventType, payload: this.#buffer.subarray(payloadStart, payloadEnd) });
      this.#buffer = this.#buffer.subarray(totalLength);
    }

    return out;
  }
}

/**
 * Build a frame. Used by the tests, and by anyone stubbing Bedrock locally —
 * including the preflight check, which is the only way to confirm this decoder
 * against the real service.
 */
export function encodeEventStreamMessage(eventType: string, payload: Buffer): Buffer {
  const name = ":event-type";
  const headers = Buffer.concat([
    Buffer.from([name.length]),
    Buffer.from(name, "utf8"),
    Buffer.from([7]),
    (() => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(eventType.length);
      return length;
    })(),
    Buffer.from(eventType, "utf8"),
  ]);

  const totalLength = PRELUDE_BYTES + headers.length + payload.length + MESSAGE_CRC_BYTES;
  const message = Buffer.alloc(totalLength);
  message.writeUInt32BE(totalLength, 0);
  message.writeUInt32BE(headers.length, 4);
  message.writeUInt32BE(crc32(message.subarray(0, 8)), 8);
  headers.copy(message, PRELUDE_BYTES);
  payload.copy(message, PRELUDE_BYTES + headers.length);
  message.writeUInt32BE(crc32(message.subarray(0, totalLength - MESSAGE_CRC_BYTES)), totalLength - MESSAGE_CRC_BYTES);
  return message;
}
