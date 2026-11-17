import { describe, expect, it } from "vitest";
import { localTime } from "./gemini.js";

describe("localTime", () => {
  const now = new Date("2026-11-17T01:30:00Z");

  it("shifts UTC by the offset, crossing the date boundary", () => {
    expect(localTime(-3, now)).toBe("2026-11-16 22:30 (UTC-3)");
    expect(localTime(0, now)).toBe("2026-11-17 01:30 (UTC+0)");
    expect(localTime(5.5, now)).toBe("2026-11-17 07:00 (UTC+5.5)");
  });
});
