import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { SessionStatus } from "@opencode-ai/sdk";
import stringWidth from "string-width";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MARKERS,
  PRESETS,
  SPINNERS,
  WAITERS,
  centerScrollTop,
  trimEllipsis,
  wrapIndex,
  applyRename,
  framesFor,
  fuzzyRank,
  fuzzyScore,
  isBusy,
  markerGlyph,
  recentSessions,
  relTime,
  sessionTitle,
  shortDir,
  forkTitle,
  expandPath,
  completePath,
  setSessionDirectory,
  splitKeybind,
  bySessionTitle,
  rowForeground,
  foldChildBusy,
  isChildVisible,
  dedupeHiddenIds,
} from "../index.tsx";

describe("centerScrollTop", () => {
  const visible = 10;
  const total = 100;
  test("stays at the top while the selection is in the top half", () => {
    expect(centerScrollTop(0, visible, total)).toBe(0);
    expect(centerScrollTop(4, visible, total)).toBe(0);
    expect(centerScrollTop(5, visible, total)).toBe(0);
  });
  test("centers the selection in the middle", () => {
    // half = 5, so scrollTop tracks index - 5
    expect(centerScrollTop(50, visible, total)).toBe(45);
    expect(centerScrollTop(51, visible, total)).toBe(46);
    // one move -> one row of scroll
    expect(centerScrollTop(51, visible, total) - centerScrollTop(50, visible, total)).toBe(1);
  });
  test("clamps to the bottom while the selection is in the bottom half", () => {
    const maxTop = total - visible; // 90
    expect(centerScrollTop(95, visible, total)).toBe(maxTop);
    expect(centerScrollTop(99, visible, total)).toBe(maxTop);
  });
  test("never scrolls when everything fits", () => {
    expect(centerScrollTop(3, 10, 5)).toBe(0);
    expect(centerScrollTop(9, 10, 10)).toBe(0);
  });
});

describe("trimEllipsis", () => {
  test("returns the text unchanged when it fits", () => {
    expect(trimEllipsis("hello", 5)).toBe("hello");
    expect(trimEllipsis("hi", 10)).toBe("hi");
  });
  test("truncates with an ellipsis when too long", () => {
    expect(trimEllipsis("OpenCode side panel", 10)).toBe("OpenCode …");
    expect(trimEllipsis("abcdef", 4)).toBe("abc…");
  });
  test("degenerate widths", () => {
    expect(trimEllipsis("abc", 0)).toBe("");
    expect(trimEllipsis("abc", 1)).toBe("…");
  });
});

describe("wrapIndex", () => {
  test("moves within bounds", () => {
    expect(wrapIndex(0, 1, 5)).toBe(1);
    expect(wrapIndex(3, -1, 5)).toBe(2);
  });
  test("wraps past the bottom to the top", () => {
    expect(wrapIndex(4, 1, 5)).toBe(0);
  });
  test("wraps past the top to the bottom", () => {
    expect(wrapIndex(0, -1, 5)).toBe(4);
  });
  test("empty list stays at 0", () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
    expect(wrapIndex(0, -1, 0)).toBe(0);
  });
});

describe("applyRename", () => {
  const sessions = [
    { id: "a", projectID: "p", directory: "/x", title: "one", time: { created: 0, updated: 0 } },
    { id: "b", projectID: "p", directory: "/y", title: "two", time: { created: 0, updated: 0 } },
  ];
  test("replaces only the matching session's title", () => {
    const out = applyRename(sessions, "b", "renamed");
    expect(out.map((s) => s.title)).toEqual(["one", "renamed"]);
  });
  test("leaves the list unchanged when the id is absent", () => {
    expect(applyRename(sessions, "zzz", "x").map((s) => s.title)).toEqual(["one", "two"]);
  });
  test("does not mutate the input", () => {
    const before = sessions.map((s) => s.title);
    applyRename(sessions, "a", "changed");
    expect(sessions.map((s) => s.title)).toEqual(before);
  });
});

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
  test("hex uses hexagon marker, hexagon/outline waiting, slice spinner, combined", () => {
    const p = PRESETS.hex;
    expect(p.marker).toBe("󰋘");
    expect(p.waiting).toEqual(["󰋘", "󰋙"]);
    expect(p.spinner).toEqual(["󰫃", "󰫄", "󰫅", "󰫆", "󰫇", "󰫈", "󰫇", "󰫆", "󰫅", "󰫄"]);
    expect(p.combined).toBe(true);
  });
  test("moon uses new-moon marker, full/new waiting, 28-phase cycle, combined", () => {
    const p = PRESETS.moon;
    expect(p.marker).toBe("");
    expect(p.waiting).toEqual(["", ""]);
    expect(p.spinner).toHaveLength(28);
    expect(p.spinner[0]).toBe("");
    expect(p.spinner[14]).toBe("");
    expect(p.combined).toBe(true);
  });
  test("pie uses full-slice marker, slice1/full waiting, fill/drain cycle, combined", () => {
    const p = PRESETS.pie;
    expect(p.marker).toBe("󰪥");
    expect(p.waiting).toEqual(["󰪞", "󰪥"]);
    expect(p.spinner[0]).toBe("󰪞");
    expect(p.spinner[7]).toBe("󰪥");
    expect(p.spinner).toHaveLength(14);
    expect(p.combined).toBe(true);
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

describe("foldChildBusy", () => {
  const status = (type: string) => ({ type }) as unknown as SessionStatus;
  const child = (id: string, parentID: string) => ({ id, parentID, title: id, created: 0, updated: 0 });
  test("parent is busy while a direct child is busy", () => {
    const folded = foldChildBusy(
      new Map([["p", status("idle")], ["c", status("busy")]]),
      [child("c", "p")],
    );
    expect(isBusy(folded.get("p"))).toBe(true);
  });
  test("busy folds up multiple generations", () => {
    const folded = foldChildBusy(
      new Map([
        ["p", status("idle")],
        ["c", status("idle")],
        ["gc", status("retry")],
      ]),
      [child("c", "p"), child("gc", "c")],
    );
    expect(isBusy(folded.get("c"))).toBe(true);
    expect(isBusy(folded.get("p"))).toBe(true);
  });
  test("idle children leave the parent idle", () => {
    const folded = foldChildBusy(
      new Map([["p", status("idle")], ["c", status("idle")]]),
      [child("c", "p")],
    );
    expect(isBusy(folded.get("p"))).toBe(false);
  });
  test("already-busy parent stays busy", () => {
    const folded = foldChildBusy(
      new Map([["p", status("busy")], ["c", status("idle")]]),
      [child("c", "p")],
    );
    expect(folded.get("p")?.type).toBe("busy");
  });
  test("child whose parent is not listed keeps its own status", () => {
    const folded = foldChildBusy(
      new Map([["c", status("busy")]]),
      [child("c", "ghost")],
    );
    expect(folded.get("c")?.type).toBe("busy");
    // The unknown parent is marked busy too; it is never rendered, so this is
    // harmless — the point is the child's status survives folding.
    expect(folded.get("ghost")?.type).toBe("busy");
  });
});

describe("isChildVisible", () => {
  const status = (type: string) => ({ type }) as unknown as SessionStatus;
  const NOW = 1_700_000_000_000;
  const child = (id: string, updatedAgo: number) => ({ id, parentID: "p", title: id, created: 0, updated: NOW - updatedAgo });

  test("busy child is visible regardless of age", () => {
    expect(
      isChildVisible(child("c", 999_999_999), new Map([["c", status("busy")]]), new Set(), NOW),
    ).toBe(true);
  });
  test("waiting child is visible regardless of age", () => {
    expect(
      isChildVisible(child("c", 999_999_999), new Map(), new Set(["c"]), NOW),
    ).toBe(true);
  });
  test("recently-active idle child is visible", () => {
    expect(
      isChildVisible(child("c", 1_000), new Map([["c", status("idle")]]), new Set(), NOW),
    ).toBe(true);
  });
  test("idle child idle past the freshness window is hidden", () => {
    expect(
      isChildVisible(child("c", 999_999_999), new Map([["c", status("idle")]]), new Set(), NOW),
    ).toBe(false);
  });
  test("child without a status falls back to freshness", () => {
    expect(isChildVisible(child("c", 999_999_999), new Map(), new Set(), NOW)).toBe(false);
    expect(isChildVisible(child("c", 1_000), new Map(), new Set(), NOW)).toBe(true);
  });
  test("custom ttl shortens the freshness window", () => {
    const c = child("c", 11_000); // fresh under the 15min default…
    expect(isChildVisible(c, new Map(), new Set(), NOW)).toBe(true);
    expect(isChildVisible(c, new Map(), new Set(), NOW, 10_000)).toBe(false); // …stale under 10s
  });
});

describe("dedupeHiddenIds", () => {
  const NOW = 1_700_000_000_000;
  // Defaults: same parent+title so tests read as a retry pair; createdAgo and
  // updatedAgo are relative to NOW.
  const kid = (
    id: string,
    opts: { parent?: string; title?: string; createdAgo?: number; updatedAgo?: number } = {},
  ) => ({
    id,
    parentID: opts.parent ?? "p",
    title: opts.title ?? "t",
    created: NOW - (opts.createdAgo ?? 0),
    updated: NOW - (opts.updatedAgo ?? 0),
  });

  test("failed attempt is hidden while the newer fallback retry runs", () => {
    const a = kid("a", { createdAgo: 10_000, updatedAgo: 1_000 });
    const b = kid("b", { createdAgo: 5_000, updatedAgo: 5_000 });
    const hidden = dedupeHiddenIds([a, b]);
    expect(hidden.has(a.id)).toBe(true);
    expect(hidden.has(b.id)).toBe(false);
  });

  test("newer fallback retry is kept even when it is the idle one", () => {
    const a = kid("a", { createdAgo: 10_000 });
    const b = kid("b", { createdAgo: 5_000 });
    const hidden = dedupeHiddenIds([a, b]);
    expect(hidden.has(a.id)).toBe(true);
    expect(hidden.has(b.id)).toBe(false);
  });

  test("both freshly idle: the newer-created one wins", () => {
    const a = kid("a", { createdAgo: 5_000 });
    const b = kid("b", { createdAgo: 1_000 });
    const hidden = dedupeHiddenIds([a, b]);
    expect(hidden.has(a.id)).toBe(true);
    expect(hidden.has(b.id)).toBe(false);
  });

  test("older busy attempt is hidden while a newer sibling exists", () => {
    const a = kid("a", { createdAgo: 10_000 });
    const b = kid("b", { createdAgo: 5_000 });
    const hidden = dedupeHiddenIds([a, b]);
    expect(hidden.has(a.id)).toBe(true);
  });

  test("cascade of retries keeps only the newest-created member", () => {
    const a = kid("a", { createdAgo: 30_000 });
    const b = kid("b", { createdAgo: 20_000 });
    const c = kid("c", { createdAgo: 10_000 });
    const hidden = dedupeHiddenIds([a, b, c]);
    expect(hidden.has(a.id)).toBe(true);
    expect(hidden.has(b.id)).toBe(true);
    expect(hidden.has(c.id)).toBe(false);
  });

  test("same title under different parents is not deduped", () => {
    const a = kid("a", { parent: "p1", createdAgo: 10_000 });
    const b = kid("b", { parent: "p2", createdAgo: 5_000 });
    const hidden = dedupeHiddenIds([a, b]);
    expect(hidden.size).toBe(0);
  });

  test("different titles under the same parent are not deduped", () => {
    const a = kid("a", { title: "t1", createdAgo: 10_000 });
    const b = kid("b", { title: "t2", createdAgo: 5_000 });
    const hidden = dedupeHiddenIds([a, b]);
    expect(hidden.size).toBe(0);
  });

  test("single member group is never deduped", () => {
    const a = kid("a");
    expect(dedupeHiddenIds([a]).size).toBe(0);
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

describe("forkTitle", () => {
  const t = (id: string, title: string) => ({
    id,
    projectID: "p",
    directory: "/x",
    title,
    time: { created: 0, updated: 1 },
  });
  test("first fork keeps the original name", () => {
    const s = [t("orig", "surfer")];
    expect(forkTitle("surfer", s)).toBe("surfer");
  });
  test("second fork gets the (fork 2) suffix", () => {
    const s = [t("orig", "surfer"), t("f1", "surfer")];
    expect(forkTitle("surfer", s)).toBe("surfer (fork 2)");
  });
  test("third fork counts suffixed forks", () => {
    const s = [t("orig", "surfer"), t("f1", "surfer"), t("f2", "surfer (fork 2)")];
    expect(forkTitle("surfer", s)).toBe("surfer (fork 3)");
  });
  test("the ordinal counts every fork in the family", () => {
    // an early fork was deleted; the count is family size, not max number
    const s = [t("orig", "surfer"), t("f2", "surfer (fork 2)")];
    expect(forkTitle("surfer", s)).toBe("surfer (fork 2)");
  });
  test("ignores unrelated sessions with a similar prefix", () => {
    const s = [t("orig", "surfer"), t("other", "surfboard")];
    expect(forkTitle("surfer", s)).toBe("surfer");
  });
});

describe("expandPath", () => {
  test("empty and whitespace-only input return an empty string", () => {
    expect(expandPath("")).toBe("");
    expect(expandPath("   ")).toBe("");
  });
  test("relative paths resolve against the cwd", () => {
    expect(expandPath("src/ui")).toBe(resolve("src/ui"));
  });
  test("absolute paths pass through", () => {
    expect(expandPath("/tmp/x")).toBe("/tmp/x");
  });
  test("a leading ~ expands to the home directory", () => {
    expect(expandPath("~/code")).toBe(join(homedir(), "code"));
  });
  test("~user paths are not windowed to the current user", () => {
    expect(expandPath("~other/code")).toBe(resolve("~other/code"));
  });
});

describe("completePath", () => {
  const dir = mkdtempSync(join(tmpdir(), "surf-complete-"));
  const src = join(dir, "src");
  mkdirSync(src);
  writeFileSync(join(src, "main.ts"), "");
  writeFileSync(join(src, "lib.ts"), "");
  writeFileSync(join(src, "common-a.ts"), "");
  writeFileSync(join(src, "common-b.ts"), "");
  writeFileSync(join(dir, "app.ts"), "");
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  test("empty input stays empty", () => {
    expect(completePath("")).toEqual({ value: "", candidates: [] });
  });
  test("no match returns the input unchanged", () => {
    const input = join(dir, "zzz");
    expect(completePath(input)).toEqual({ value: input, candidates: [] });
  });
  test("a unique directory match completes with a trailing slash", () => {
    expect(completePath(join(dir, "sr"))).toEqual({ value: join(dir, "src") + "/", candidates: [join(dir, "src") + "/"] });
  });
  test("a unique file match completes without a slash", () => {
    expect(completePath(join(src, "ma"))).toEqual({ value: join(src, "main.ts"), candidates: [join(src, "main.ts")] });
  });
  test("a trailing slash lists the directory", () => {
    const c = completePath(join(src, "/"));
    expect(c.candidates.sort()).toEqual(
      [join(src, "lib.ts"), join(src, "main.ts"), join(src, "common-a.ts"), join(src, "common-b.ts")].sort(),
    );
    expect(c.value).toBe(join(src, "/"));
  });
  test("ambiguous matches return the longest common prefix", () => {
    const c = completePath(join(src, "com"));
    expect(c.value).toBe(join(src, "common-"));
    expect(c.candidates.sort()).toEqual([join(src, "common-a.ts"), join(src, "common-b.ts")].sort());
  });
});

describe("splitKeybind", () => {
  test("letter at word start merges the rest as suffix", () => {
    expect(splitKeybind("ctrl+n", "new")).toEqual({ key: "ctrl+n", suffix: "ew" });
    expect(splitKeybind("ctrl+r", "rename")).toEqual({ key: "ctrl+r", suffix: "ename" });
    expect(splitKeybind("ctrl+f", "fork")).toEqual({ key: "ctrl+f", suffix: "ork" });
    expect(splitKeybind("ctrl+d", "delete")).toEqual({ key: "ctrl+d", suffix: "elete" });
  });
  test("a mid-word letter keeps the spaced form", () => {
    expect(splitKeybind("ctrl+e", "delete")).toEqual({ key: "ctrl+e", suffix: null });
  });
  test("a multi-word label keeps the spaced form even if the letter is inside a later word", () => {
    expect(splitKeybind("ctrl+w", "switch workdir")).toEqual({ key: "ctrl+w", suffix: null });
  });
  test("keys without a plus keep the spaced form", () => {
    expect(splitKeybind("enter", "switch")).toEqual({ key: "enter", suffix: null });
    expect(splitKeybind("esc", "close")).toEqual({ key: "esc", suffix: null });
  });
  test("chord keys keep the spaced form", () => {
    expect(splitKeybind("ctrl+xj", "next")).toEqual({ key: "ctrl+xj", suffix: null });
  });
  test("a letter absent from the label keeps the spaced form", () => {
    expect(splitKeybind("ctrl+k", "up")).toEqual({ key: "ctrl+k", suffix: null });
    expect(splitKeybind("ctrl+j", "down")).toEqual({ key: "ctrl+j", suffix: null });
  });
  test("a bare plus at the end keeps the spaced form", () => {
    expect(splitKeybind("ctrl+", "new")).toEqual({ key: "ctrl+", suffix: null });
  });
});

describe("bySessionTitle", () => {
  const s = (id: string, title: string, dir: string) => ({
    id,
    projectID: "p",
    directory: dir,
    title,
    time: { created: 0, updated: 0 },
  });
  test("orders by displayed name, ignoring case", () => {
    const list = [s("c", "zeta", "/x"), s("a", "Alpha", "/x"), s("b", "beta", "/x")];
    expect([...list].sort(bySessionTitle).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
  test("names are stable when recency changes", () => {
    const fresh = (id: string, title: string, updated: number) => ({
      id,
      projectID: "p",
      directory: "/x",
      title,
      time: { created: 0, updated },
    });
    const older = [fresh("a", "Alpha", 100), fresh("b", "Beta", 200)];
    const newer = [fresh("a", "Alpha", 300), fresh("b", "Beta", 200)];
    expect([...older].sort(bySessionTitle).map((x) => x.id)).toEqual([...newer].sort(bySessionTitle).map((x) => x.id));
  });
  test("same name falls back to id order", () => {
    const list = [s("zz", "Same", "/x"), s("aa", "same", "/x")];
    expect([...list].sort(bySessionTitle).map((x) => x.id)).toEqual(["aa", "zz"]);
  });
  test("empty display names fall back to the directory basename", () => {
    const list = [s("a", "", "/work/zzz"), s("b", "", "/work/aaa")];
    expect([...list].sort(bySessionTitle).map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("rowForeground", () => {
  const theme = {
    text: "text",
    textMuted: "muted",
    accent: "purple",
    info: "cyan",
    primary: "orange",
    success: "green",
  };
  test("focused session is always orange, even when working or asking", () => {
    expect(rowForeground({ waiting: false, working: true, isCurrent: true, hasStatus: false, inActive: true }, theme)).toBe("orange");
    expect(rowForeground({ waiting: true, working: false, isCurrent: true, hasStatus: false, inActive: true }, theme)).toBe("orange");
    expect(rowForeground({ waiting: false, working: false, isCurrent: true, hasStatus: false, inActive: true }, theme)).toBe("orange");
  });
  test("other sessions keep their state colors", () => {
    expect(rowForeground({ waiting: true, working: false, isCurrent: false, hasStatus: false, inActive: true }, theme)).toBe("purple");
    expect(rowForeground({ waiting: false, working: true, isCurrent: false, hasStatus: false, inActive: true }, theme)).toBe("cyan");
    expect(rowForeground({ waiting: false, working: false, isCurrent: false, hasStatus: true, inActive: true }, theme)).toBe("green");
    expect(rowForeground({ waiting: false, working: false, isCurrent: false, hasStatus: false, inActive: true }, theme)).toBe("green");
    expect(rowForeground({ waiting: false, working: false, isCurrent: false, hasStatus: false, inActive: false }, theme)).toBe("text");
  });
});

describe("setSessionDirectory", () => {
  const sessionTable = (db: Database) => {
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)");
    db.exec("INSERT INTO session (id, directory) VALUES ('ses_a', '/old/dir')");
  };
  test("updates the directory of an existing session row", () => {
    const db = new Database(":memory:");
    sessionTable(db);
    const res = setSessionDirectory("ses_a", "/new/dir", db);
    expect(res).toEqual({ ok: true });
    const row = db.query("SELECT directory FROM session WHERE id = ?").get("ses_a") as { directory: string };
    expect(row.directory).toBe("/new/dir");
    db.close();
  });
  test("returns schema when the session table has no directory column", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    db.exec("INSERT INTO session (id) VALUES ('ses_a')");
    expect(setSessionDirectory("ses_a", "/new/dir", db)).toEqual({ ok: false, reason: "schema" });
    db.close();
  });
  test("returns db when the update throws", () => {
    const db = new Database(":memory:");
    sessionTable(db);
    db.close();
    expect(setSessionDirectory("ses_a", "/new/dir", db)).toEqual({ ok: false, reason: "db" });
  });
});
