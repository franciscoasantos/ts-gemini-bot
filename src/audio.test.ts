import { test, expect } from "vitest";
import OpusScript from "opusscript";
import { beep, down48to16, parseVoice, Player, up24to48stereo } from "./audio.js";

const FRAME = 960; // 20 ms @ 48 kHz
const FRAME_BYTES = FRAME * 2 * 2; // stereo, 16-bit

test("parseVoice extracts clientId, codec and opus; rejects a short packet", () => {
  const pkt = Buffer.from([0, 7, 0, 42, 5, 0xaa, 0xbb]);
  expect(parseVoice(pkt)).toEqual({ clientId: 42, codec: 5, opus: Buffer.from([0xaa, 0xbb]) });
  expect(parseVoice(Buffer.from([1, 2, 3]))).toBeNull();
});

test("down48to16 averages groups of 3 samples", () => {
  const pcm48 = Buffer.alloc(12);
  [3, 6, 9, -3, -6, -9].forEach((v, i) => pcm48.writeInt16LE(v, i * 2));
  expect([...down48to16(pcm48)]).toEqual([6, -6]);
});

test("up24to48stereo duplicates each sample into 2 time steps × L/R", () => {
  const pcm24 = Buffer.alloc(4);
  pcm24.writeInt16LE(100, 0);
  pcm24.writeInt16LE(-5, 2);
  const up = up24to48stereo(pcm24);
  expect([...new Int16Array(up.buffer, up.byteOffset, up.length / 2)]).toEqual([100, 100, 100, 100, -5, -5, -5, -5]);
});

test("Player sends 1 Opus frame per 20 ms and calls stop when empty; frame decodes to 960 samples", async () => {
  const sent: Buffer[] = [];
  let stopped = false;
  const p = new Player(
    (b) => sent.push(b),
    () => (stopped = true),
  );
  p.push(Buffer.alloc(FRAME_BYTES * 2));
  await new Promise((r) => setTimeout(r, 100));
  expect(sent.length).toBe(2);
  expect(stopped).toBe(true);
  const dec = new OpusScript(48000, 1);
  expect(dec.decode(sent[0]).length).toBe(FRAME * 2);
});

test("beep produces non-empty 16-bit stereo PCM", () => {
  const b = beep();
  expect(b.length).toBeGreaterThan(0);
  expect(b.length % 4).toBe(0); // 16-bit stereo
});
