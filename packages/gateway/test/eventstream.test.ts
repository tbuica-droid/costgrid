import { describe, expect, it } from "vitest";
import { crc32, encodeEventStreamMessage, EventStreamDecoder } from "../src/providers/eventstream.js";

const frame = (type: string, body: unknown) =>
  encodeEventStreamMessage(type, Buffer.from(JSON.stringify(body), "utf8"));

describe("AWS event-stream framing", () => {
  it("computes CRC-32 as the spec's algorithm does", () => {
    // The canonical check value for "123456789" under IEEE 802.3.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("reads back a frame it wrote", () => {
    const decoder = new EventStreamDecoder();
    const [message] = decoder.push(frame("chunk", { bytes: "aGk=" }));

    expect(message?.eventType).toBe("chunk");
    expect(JSON.parse(message!.payload.toString("utf8"))).toEqual({ bytes: "aGk=" });
    expect(decoder.errors).toBe(0);
  });

  it("reassembles a frame split across chunk boundaries", () => {
    // The realistic case: TCP does not respect message edges.
    const whole = frame("chunk", { n: 1 });
    const decoder = new EventStreamDecoder();

    expect(decoder.push(whole.subarray(0, 5))).toHaveLength(0);
    expect(decoder.push(whole.subarray(5, 9))).toHaveLength(0);
    const out = decoder.push(whole.subarray(9));
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!.payload.toString())).toEqual({ n: 1 });
  });

  it("takes several frames out of one chunk", () => {
    const decoder = new EventStreamDecoder();
    const out = decoder.push(Buffer.concat([frame("a", { i: 1 }), frame("b", { i: 2 }), frame("c", { i: 3 })]));
    expect(out.map((m) => m.eventType)).toEqual(["a", "b", "c"]);
  });

  it("fails loudly on a corrupted prelude rather than metering zero", () => {
    // A stream that is not what it claims must surface as an error, so the
    // call records as unpriced instead of free.
    const bad = frame("chunk", { n: 1 });
    bad.writeUInt32BE(0xdeadbeef, 8); // wrong prelude CRC

    const decoder = new EventStreamDecoder();
    expect(decoder.push(bad)).toHaveLength(0);
    expect(decoder.errors).toBe(1);
  });

  it("refuses to allocate against an implausible length", () => {
    const hostile = Buffer.alloc(16);
    hostile.writeUInt32BE(0xfffffff0, 0); // claims 4GB
    hostile.writeUInt32BE(0, 4);

    const decoder = new EventStreamDecoder();
    expect(decoder.push(hostile)).toHaveLength(0);
    expect(decoder.errors).toBe(1);
  });

  it("skips header types it does not read without losing the payload", () => {
    // Bedrock sends :message-type and :content-type alongside :event-type.
    const name = (n: string) => Buffer.concat([Buffer.from([n.length]), Buffer.from(n)]);
    const str = (v: string) => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(v.length);
      return Buffer.concat([Buffer.from([7]), len, Buffer.from(v)]);
    };
    const headers = Buffer.concat([
      name(":message-type"), str("event"),
      name(":event-type"), str("chunk"),
      name(":content-type"), str("application/json"),
    ]);
    const payload = Buffer.from('{"ok":true}');
    const total = 12 + headers.length + payload.length + 4;
    const message = Buffer.alloc(total);
    message.writeUInt32BE(total, 0);
    message.writeUInt32BE(headers.length, 4);
    message.writeUInt32BE(crc32(message.subarray(0, 8)), 8);
    headers.copy(message, 12);
    payload.copy(message, 12 + headers.length);
    message.writeUInt32BE(crc32(message.subarray(0, total - 4)), total - 4);

    const [decoded] = new EventStreamDecoder().push(message);
    expect(decoded?.eventType).toBe("chunk");
    expect(JSON.parse(decoded!.payload.toString())).toEqual({ ok: true });
  });

  it("keeps a trailing partial frame for the next chunk", () => {
    const decoder = new EventStreamDecoder();
    const out = decoder.push(Buffer.concat([frame("a", { i: 1 }), frame("b", { i: 2 }).subarray(0, 6)]));
    expect(out).toHaveLength(1);
    expect(decoder.errors).toBe(0);
  });
});
