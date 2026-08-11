import { afterAll, describe, expect, test } from "bun:test";
import type { SessionStatus } from "@opencode-ai/sdk";
import {
  MARKERS,
  SPINNERS,
  WAITERS,
  framesFor,
  isBusy,
  markerGlyph,
  recentSessions,
  relTime,
  sessionTitle,
  shortDir,
} from "../index.tsx";

describe("framesFor", () => {
  test("returns frames for a known name", () => {
    expect(framesFor(SPINNERS, "arc", SPINNERS.dots)).toEqual(SPINNERS.arc);
    expect(framesFor(WAITERS, "ellipsis", WAITERS.flash)).toEqual(WAITERS.ellipsis);
  });
  test("falls back to the default for unknown names and non-strings", () => {
    expect(framesFor(SPINNERS, "nope", SPINNERS.dots)).toEqual(SPINNERS.dots);
    expect(framesFor(SPINNERS, 42, SPINNERS.dots)).toEqual(SPINNERS.dots);
    expect(framesFor(SPINNERS, undefined, SPINNERS.dots)).toEqual(SPINNERS.dots);
  });
  test("empty string disables the indicator", () => {
    expect(framesFor(SPINNERS, "", SPINNERS.dots)).toEqual([]);
  });
});

describe("markerGlyph", () => {
  test("maps named markers to glyphs", () => {
    expect(markerGlyph("star")).toBe(MARKERS.star);
    expect(markerGlyph("square")).toBe(MARKERS.square);
    expect(markerGlyph("none")).toBe("");
  });
  test("unknown names and undefined fall back to dot", () => {
    expect(markerGlyph("bogus")).toBe(MARKERS.dot);
    expect(markerGlyph(undefined)).toBe(MARKERS.dot);
  });
  test("empty string disables the marker", () => {
    expect(markerGlyph("")).toBe("");
  });
});

describe("isBusy", () => {
  const status = (type: string) => ({ type }) as unknown as SessionStatus;
  test("busy and retry count as busy", () => {
    expect(isBusy(status("busy"))).toBe(true);
    expect(isBusy(status("retry"))).toBe(true);
  });
  test("idle/failed/undefined do not", () => {
    expect(isBusy(status("idle"))).toBe(false);
    expect(isBusy(status("failed"))).toBe(false);
    expect(isBusy(undefined)).toBe(false);
  });
});

describe("relTime", () => {
  const now = 1_700_000_000_000;
  test("formats relative time", () => {
    expect(relTime(now - 30_000, now)).toBe("now");
    expect(relTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relTime(now - 2 * 86_400_000, now)).toBe("2d");
  });
});

describe("recentSessions", () => {
  // 2023-11-13 is a Monday; the previous Friday is 2023-11-10, Thursday 2023-11-09.
  const mon1600 = Date.UTC(2023, 10, 13, 16, 0, 0);
  const mk = (id: string, updated: number) => ({
    id,
    projectID: "p",
    directory: "/x",
    title: id,
    time: { created: 0, updated },
  });
  test("shows the last 24h of work plus the previous work block", () => {
    const recent = recentSessions(
      [
        mk("mon-early", Date.UTC(2023, 10, 13, 9, 0, 0)),
        mk("mon-late", Date.UTC(2023, 10, 13, 14, 0, 0)),
        mk("fri-early", Date.UTC(2023, 10, 10, 10, 0, 0)),
        mk("fri-late", Date.UTC(2023, 10, 10, 15, 0, 0)),
      ],
      mon1600,
    );
    expect(recent.map((s) => s.id)).toEqual(["mon-late", "mon-early", "fri-late", "fri-early"]);
  });
  test("drops sessions older than the previous work block (e.g. thursday)", () => {
    const recent = recentSessions(
      [
        mk("mon", Date.UTC(2023, 10, 13, 9, 0, 0)),
        mk("fri", Date.UTC(2023, 10, 10, 15, 0, 0)),
        mk("thu", Date.UTC(2023, 10, 9, 12, 0, 0)),
        mk("ancient", Date.UTC(2023, 9, 1, 0, 0, 0)),
      ],
      mon1600,
    );
    expect(recent.map((s) => s.id)).toEqual(["mon", "fri"]);
  });
  test("single contiguous block is fully included", () => {
    const recent = recentSessions(
      [mk("a", Date.UTC(2023, 10, 13, 9, 0, 0)), mk("b", Date.UTC(2023, 10, 13, 14, 0, 0))],
      mon1600,
    );
    expect(recent.map((s) => s.id)).toEqual(["b", "a"]);
  });
  test("a lone old session is still shown (it is the previous work block)", () => {
    const old = Date.UTC(2023, 6, 15, 12, 0, 0);
    const recent = recentSessions([mk("old", old)], mon1600);
    expect(recent.map((s) => s.id)).toEqual(["old"]);
  });
  test("returns [] for empty input", () => {
    expect(recentSessions([], mon1600)).toEqual([]);
  });
});

describe("sessionTitle", () => {
  const mk = (over: Partial<{ title: string; directory: string; id: string }>) => ({
    id: "abcdef123456",
    projectID: "p",
    directory: "/a/b",
    title: "New Session",
    time: { created: 0, updated: 0 },
    ...over,
  });
  test("trims custom titles", () => {
    expect(sessionTitle(mk({ title: "  My Work  " }))).toBe("My Work");
  });
  test("falls back to directory basename for New Session", () => {
    expect(sessionTitle(mk({ directory: "/a/b/c" }))).toBe("c");
  });
  test("falls back to id slice when directory is empty", () => {
    expect(sessionTitle(mk({ directory: "", title: "" }))).toBe("abcdef12");
  });
});

describe("shortDir", () => {
  const orig = process.env.HOME;
  afterAll(() => {
    process.env.HOME = orig;
  });
  test("shortens home prefix to ~ and leaves other paths", () => {
    process.env.HOME = "/Users/z";
    expect(shortDir("/Users/z/opencode-session-surf")).toBe("~/opencode-session-surf");
    expect(shortDir("/tmp/other")).toBe("/tmp/other");
  });
});
