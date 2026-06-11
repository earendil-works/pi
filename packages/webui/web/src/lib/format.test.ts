import { describe, it, expect } from "vitest";
import { formatToken, formatRelativeTime } from "./format";

describe("formatToken", () => {
  // S29: n < 1000 → "${n}"
  it("returns plain number for values less than 1000", () => {
    expect(formatToken(0)).toBe("0");
    expect(formatToken(500)).toBe("500");
    expect(formatToken(999)).toBe("999");
  });

  // S30: n < 1_000_000 → "${(n / 1000).toFixed(1)}K"
  it("formats thousands with K suffix", () => {
    expect(formatToken(1000)).toBe("1.0K");
    expect(formatToken(1500)).toBe("1.5K");
    expect(formatToken(100_000)).toBe("100.0K");
    expect(formatToken(999_999)).toBe("1000.0K");
  });

  // S31: n < 1_000_000_000 → "${(n / 1_000_000).toFixed(1)}M"
  it("formats millions with M suffix", () => {
    expect(formatToken(1_000_000)).toBe("1.0M");
    expect(formatToken(1_500_000)).toBe("1.5M");
    expect(formatToken(3_100_000)).toBe("3.1M");
    expect(formatToken(999_999_999)).toBe("1000.0M");
  });

  // S32: n >= 1_000_000_000 → "${(n / 1_000_000_000).toFixed(1)}B"
  it("formats billions with B suffix", () => {
    expect(formatToken(1_000_000_000)).toBe("1.0B");
    expect(formatToken(3_100_000_000)).toBe("3.1B");
    expect(formatToken(1_000_000_000_000)).toBe("1000.0B");
  });

  // S33-S34: edge cases - NaN / Infinity / negative → "0"
  it("returns '0' for NaN", () => {
    expect(formatToken(NaN)).toBe("0");
  });

  it("returns '0' for Infinity", () => {
    expect(formatToken(Infinity)).toBe("0");
    expect(formatToken(-Infinity)).toBe("0");
  });

  it("returns '0' for negative numbers", () => {
    expect(formatToken(-1)).toBe("0");
    expect(formatToken(-500)).toBe("0");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.now();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  // S35: < 1 minute ago → "just now"
  it('returns "just now" for times less than 1 minute ago', () => {
    const recent = new Date(now - 30 * 1000).toISOString();
    expect(formatRelativeTime(recent)).toBe("just now");
  });

  it('returns "just now" for time at 59 seconds ago', () => {
    const almostMinute = new Date(now - 59 * 1000).toISOString();
    expect(formatRelativeTime(almostMinute)).toBe("just now");
  });

  // S36: < 1 hour → "${minutes}m ago"
  it('returns minutes ago for times less than 1 hour', () => {
    const fiveMinAgo = new Date(now - 5 * minute).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe("5m ago");
  });

  it('returns correct minutes for 59 minutes ago', () => {
    const mins59Ago = new Date(now - 59 * minute).toISOString();
    expect(formatRelativeTime(mins59Ago)).toBe("59m ago");
  });

  // S37: < 24 hours → "${hours}h ago"
  it('returns hours ago for times less than 24 hours', () => {
    const threeHoursAgo = new Date(now - 3 * hour).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe("3h ago");
  });

  it('returns correct hours for 23 hours ago', () => {
    const hours23Ago = new Date(now - 23 * hour).toISOString();
    expect(formatRelativeTime(hours23Ago)).toBe("23h ago");
  });

  // S38: < 7 days → "${days}d ago"
  it('returns days ago for times less than 7 days', () => {
    const twoDaysAgo = new Date(now - 2 * day).toISOString();
    expect(formatRelativeTime(twoDaysAgo)).toBe("2d ago");
  });

  it('returns correct days for 6 days ago', () => {
    const sixDaysAgo = new Date(now - 6 * day).toISOString();
    expect(formatRelativeTime(sixDaysAgo)).toBe("6d ago");
  });

  // S38: >= 7 days → short month/day format
  it("returns short date format for times 7 or more days ago", () => {
    const tenDaysAgo = new Date(now - 10 * day).toISOString();
    const result = formatRelativeTime(tenDaysAgo);
    // Should be formatted as "Mon DD" e.g. "May 20"
    expect(result).toMatch(/^[A-Z][a-z]{2}\s+\d{1,2}$/);
  });
});
