import { describe, expect, it } from "vitest";
import { findQueueIndex, pickBestResult, playEach } from "./manager.js";

describe("playEach", () => {
  it("keeps going after a failure and plays the next song when the first fails", async () => {
    const calls: string[] = [];
    const play = async (q: string) => {
      calls.push(`play ${q}`);
      if (q === "a") throw new Error("500");
    };
    const enqueue = async (q: string) => void calls.push(`queue ${q}`);
    expect(await playEach(["a", "b", "c"], true, play, enqueue)).toEqual(["a"]);
    expect(calls).toEqual(["play a", "play b", "queue c"]);
  });

  it("only queues when playFirst is false", async () => {
    const calls: string[] = [];
    const play = async (q: string) => void calls.push(`play ${q}`);
    const enqueue = async (q: string) => void calls.push(`queue ${q}`);
    expect(await playEach(["a", "b"], false, play, enqueue)).toEqual([]);
    expect(calls).toEqual(["queue a", "queue b"]);
  });
});

describe("findQueueIndex", () => {
  // played: a, b | current: c (index 2) | upcoming: d (1), e (2)
  const titles = ["a", "b", "c", "Daft Punk", "e"];

  it("maps the list_queue position to the Manager index", () => {
    expect(findQueueIndex(titles, 2, 1)).toBe(3);
    expect(findQueueIndex(titles, 2, 2)).toBe(4);
  });

  it("rejects out-of-range positions", () => {
    expect(findQueueIndex(titles, 2, 0)).toBe(-1);
    expect(findQueueIndex(titles, 2, 3)).toBe(-1);
    expect(findQueueIndex(titles, 2, 1.5)).toBe(-1);
  });

  it("matches by title only among upcoming songs", () => {
    expect(findQueueIndex(titles, 2, "daft")).toBe(3);
    expect(findQueueIndex(titles, 2, "a")).toBe(3); // "Daft Punk" contains "a"; played "a" is skipped
    expect(findQueueIndex(titles, 2, "zzz")).toBe(-1);
  });
});

describe("pickBestResult", () => {
  const r = (id: string, title: string, artist = "x", duration = 200) => ({
    id: id.padEnd(11, "0"),
    title,
    artist,
    duration,
  });

  it("skips reactions/covers and prefers the official upload", () => {
    const best = pickBestResult("Queen - Bohemian Rhapsody", [
      r("a", "REACTING to Queen Bohemian Rhapsody", "Some Guy", 900),
      r("b", "Bohemian Rhapsody (cover)", "Singer"),
      r("c", "Bohemian Rhapsody", "Queen - Topic", 355),
    ]);
    expect(best?.id).toBe("c0000000000");
  });

  it("drops non-song lengths and unrelated videos", () => {
    const best = pickBestResult("Daft Punk - One More Time", [
      r("a", "One More Time", "Daft Punk", 20),
      r("b", "Funny cats compilation", "Cats", 240),
      r("c", "Daft Punk - One More Time (Official Video)", "Daft Punk", 320),
    ]);
    expect(best?.id).toBe("c0000000000");
  });

  it("skips medleys and cover channels for the artist's own upload", () => {
    expect(
      pickBestResult("Deixa Acontecer Grupo Revelação", [
        r("a", "Grupo Revelação - Deixa Acontecer / Coração Radiante", "Grupo Revelação"),
        r("b", "Deixa Acontecer", "Grupo Revelação"),
      ])?.id,
    ).toBe("b0000000000");
    expect(
      pickBestResult("Te Assumi pro Brasil Matheus & Kauan", [
        r("a", "Te Assumi Pro Brasil - Matheus e Kauan - JHON LIRA", "BlahTera"),
        r("b", "Matheus & Kauan - Te Assumi Pro Brasil", "Matheus & Kauan"),
      ])?.id,
    ).toBe("b0000000000");
  });

  it("allows the junk word when the user asked for it", () => {
    const best = pickBestResult("Anitta ao vivo", [r("a", "Anitta - Envolver"), r("b", "Anitta Ao Vivo - Envolver")]);
    expect(best?.id).toBe("b0000000000");
  });

  it("keeps YouTube's order when nothing distinguishes them, and ignores non-videos", () => {
    expect(
      pickBestResult("song", [
        { id: "UCchannel", title: "song", artist: "x", duration: 0 },
        r("a", "song"),
        r("b", "song"),
      ])?.id,
    ).toBe("a0000000000");
    expect(pickBestResult("song", [])).toBeUndefined();
  });
});
