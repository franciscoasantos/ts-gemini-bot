import { describe, expect, it } from "vitest";
import { findRemoveIndex } from "./manager.js";

describe("findRemoveIndex", () => {
  // played: a, b | current: c (index 2) | upcoming: d (1), e (2)
  const titles = ["a", "b", "c", "Daft Punk", "e"];

  it("maps the list_queue position to the Manager index", () => {
    expect(findRemoveIndex(titles, 2, 1)).toBe(3);
    expect(findRemoveIndex(titles, 2, 2)).toBe(4);
  });

  it("rejects out-of-range positions", () => {
    expect(findRemoveIndex(titles, 2, 0)).toBe(-1);
    expect(findRemoveIndex(titles, 2, 3)).toBe(-1);
    expect(findRemoveIndex(titles, 2, 1.5)).toBe(-1);
  });

  it("matches by title only among upcoming songs", () => {
    expect(findRemoveIndex(titles, 2, "daft")).toBe(3);
    expect(findRemoveIndex(titles, 2, "a")).toBe(3); // "Daft Punk" contains "a"; played "a" is skipped
    expect(findRemoveIndex(titles, 2, "zzz")).toBe(-1);
  });
});
