import { afterAll, describe, expect, test } from "bun:test";
import type { SessionStatus } from "@opencode-ai/sdk";
import stringWidth from "string-width";
import {
  MARKERS,
  PRESETS,
  SPINNERS,
  WAITERS,
  framesFor,
  fuzzyRank,
  fuzzyScore,
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
    expect(framesFor(WAITERS, "ellipsis", WAITERS.emoji)).toEqual(WAITERS.ellipsis);
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

// The host (opentui 0.5.1) measures marker glyphs with string-width@7.2.0,
// which counts emoji-regex matches as 2 cells. Any marker wider than 1 cell
// shifts the session title right in the sidebar. e.g. U+25B6 "▶" is emoji
// and renders 2 cells wide; U+25BA "►" is not.
describe("MARKERS", () => {
  test("every marker glyph is exactly 1 cell wide", () => {
    for (const [name, glyph] of Object.entries(MARKERS)) {
      if (glyph === "") continue; // none
      expect(stringWidth(glyph), `${name} (${glyph})`).toBe(1);
    }
  });
});

describe("PRESETS", () => {
  test("every preset marker glyph is exactly 1 cell wide", () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      expect(stringWidth(p.marker), `${name} marker (${p.marker})`).toBe(1);
    }
  });
  test("ping uses ping marker, bell waiting, arc spinner, combined", () => {
    const p = PRESETS.ping;
    expect(p.marker).toBe("◉");
    expect(p.waiting).toBe(WAITERS.bell);
    expect(p.spinner).toBe(SPINNERS.arc);
    expect(p.combined).toBe(true);
  });
  test("term is pure ASCII and combined", () => {
    const p = PRESETS.term;
    expect(p.marker).toBe(">");
    expect(p.spinner).toEqual(["-", "\\", "|", "/"]);
    expect(p.combined).toBe(true);
  });
  test("braille uses dot marker, pulse waiting, dots spinner, not combined", () => {
    const p = PRESETS.braille;
    expect(p.marker).toBe(MARKERS.dot);
    expect(p.waiting).toBe(WAITERS.pulse);
    expect(p.spinner).toBe(SPINNERS.dots);
    expect(p.combined).toBe(false);
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

describe("fuzzyScore", () => {
  test("returns -1 for non-subsequences and empty targets", () => {
    expect(fuzzyScore("xyz", "surfer")).toBe(-1);
    expect(fuzzyScore("a", "")).toBe(-1);
  });
  test("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("srf", "surfer")).toBeGreaterThan(0);
    expect(fuzzyScore("SRF", "Surfer")).toBeGreaterThan(0);
  });
  test("prefers exact, then prefix, then word-start matches", () => {
    expect(fuzzyScore("surfer", "surfer")).toBeGreaterThan(fuzzyScore("sur", "surfer"));
    expect(fuzzyScore("sur", "surfer")).toBeGreaterThan(fuzzyScore("srf", "surfer"));
  });
});

describe("fuzzyRank", () => {
  const t = (id: string, title: string, updated: number) => ({
    id,
    projectID: "p",
    directory: "/x",
    title,
    time: { created: 0, updated },
  });
  test("empty query returns all sessions most recent first", () => {
    const s = [t("a", "old", 100), t("b", "new", 200)];
    expect(fuzzyRank("", s).map((x) => x.id)).toEqual(["b", "a"]);
  });
  test("ranks by fuzzy score, then recency for close matches", () => {
    const s = [
      t("oldest", "my project", 100),
      t("newer", "my project", 300),
      t("other", "something else", 200),
    ];
    const r = fuzzyRank("my pro", s);
    expect(r[0].id).toBe("newer");
    expect(r[1].id).toBe("oldest");
  });
  test("drops non-matching sessions", () => {
    const s = [t("a", "alpha", 1), t("b", "beta", 2)];
    expect(fuzzyRank("zzz", s)).toEqual([]);
  });
  test("matches the directory as a fallback target", () => {
    const s = [
      {
        id: "a",
        projectID: "p",
        directory: "/Users/z/opencode-session-surf",
        title: "New Session",
        time: { created: 0, updated: 1 },
      },
    ];
    expect(fuzzyRank("session-surf", s)).toHaveLength(1);
  });
});
