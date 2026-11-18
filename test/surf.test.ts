import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo, SessionStatus } from "@opencode/client";
import {
  applyWaitingEvent,
  createSurfState,
  fetchAllSessions,
  palette,
  readCrossInstance,
  toSidebarData,
  writeOwnStatuses,
} from "../tui.tsx";

const info = (id: string, over: Partial<SessionInfo> & { updated?: number } = {}): SessionInfo => {
  const { updated = 1000, ...rest } = over;
  return {
    id,
    projectID: "p",
    cost: 0,
    tokens: {},
    time: { created: 1, updated },
    title: id,
    location: { directory: `/work/${id}` },
    ...rest,
  } as unknown as SessionInfo;
};

const page = (data: SessionInfo[], next?: string) => ({ data, cursor: { next: next ?? null } });

describe("toSidebarData", () => {
  test("maps location.directory and a missing title", () => {
    const { roots } = toSidebarData([info("a", { title: undefined })]);
    expect(roots).toEqual([
      { id: "a", projectID: "p", directory: "/work/a", title: "", time: { created: 1, updated: 1000 } },
    ]);
  });

  test("drops archived sessions and splits subagent children from roots", () => {
    const { roots, children } = toSidebarData([
      info("root"),
      info("gone", { time: { created: 1, updated: 1, archived: 5 } } as Partial<SessionInfo>),
      info("kid", { parentID: "root", updated: 7 }),
    ]);
    expect(roots.map((s) => s.id)).toEqual(["root"]);
    expect(children).toEqual([{ id: "kid", parentID: "root", title: "kid", created: 1, updated: 7 }]);
  });

  test("sorts roots newest first and slices to maxRoots", () => {
    const { roots } = toSidebarData([info("old", { updated: 1 }), info("new", { updated: 9 }), info("mid", { updated: 5 })], 2);
    expect(roots.map((s) => s.id)).toEqual(["new", "mid"]);
  });
});

describe("fetchAllSessions", () => {
  const clientFor = (pages: ReturnType<typeof page>[], calls: unknown[] = []) =>
    ({
      session: {
        list: async (input: unknown) => {
          calls.push(input);
          return pages[calls.length - 1];
        },
      },
    }) as never;

  test("stops when the cursor ends", async () => {
    const calls: unknown[] = [];
    const out = await fetchAllSessions(clientFor([page([info("a")], "c1"), page([info("b")])], calls));
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
  });

  test("stops once maxRoots roots are collected", async () => {
    const calls: unknown[] = [];
    await fetchAllSessions(clientFor([page([info("a"), info("b")], "c1"), page([info("c")])], calls), 2);
    expect(calls).toHaveLength(1);
  });

  test("stops at maxPages", async () => {
    const calls: unknown[] = [];
    const pages = Array.from({ length: 9 }, (_, i) => page([info(`s${i}`)], `c${i}`));
    await fetchAllSessions(clientFor(pages, calls), 100, 3);
    expect(calls).toHaveLength(3);
  });

  test("sends order only on the first page, never together with a cursor", async () => {
    const calls: Record<string, unknown>[] = [];
    await fetchAllSessions(clientFor([page([info("a")], "c1"), page([info("b")])], calls as unknown[]));
    expect(calls[0]).toMatchObject({ order: "desc", archived: false });
    expect(calls[1]).toMatchObject({ cursor: "c1", archived: false });
    expect(calls[1]).not.toHaveProperty("order");
  });
});

describe("applyWaitingEvent", () => {
  const asked = { type: "permission.asked", data: { id: "p1", sessionID: "s1" } };
  const replied = { type: "permission.replied", data: { requestID: "p1", sessionID: "s1" } };

  test("a permission request waits until it is replied to", () => {
    const waiting = applyWaitingEvent(new Map(), asked);
    expect([...waiting.keys()]).toEqual(["s1"]);
    expect(applyWaitingEvent(waiting, replied).size).toBe(0);
  });

  test("a form waits until it is cancelled or replied to", () => {
    const created = { type: "form.created", data: { form: { id: "f1", sessionID: "s1" } } };
    const waiting = applyWaitingEvent(new Map(), created);
    expect(applyWaitingEvent(waiting, { type: "form.cancelled", data: { id: "f1", sessionID: "s1" } }).size).toBe(0);
    expect(applyWaitingEvent(waiting, { type: "form.replied", data: { id: "f1", sessionID: "s1" } }).size).toBe(0);
  });

  test("two outstanding requests need two replies", () => {
    let waiting = applyWaitingEvent(new Map(), asked);
    waiting = applyWaitingEvent(waiting, { type: "permission.asked", data: { id: "p2", sessionID: "s1" } });
    waiting = applyWaitingEvent(waiting, replied);
    expect(waiting.get("s1")?.size).toBe(1);
  });

  test("a reply for an unknown request is a no-op and the input is not mutated", () => {
    const before = applyWaitingEvent(new Map(), asked);
    const after = applyWaitingEvent(before, { type: "permission.replied", data: { requestID: "nope", sessionID: "s1" } });
    expect(after.get("s1")?.size).toBe(1);
    expect(before.get("s1")?.size).toBe(1);
  });
});

describe("status files", () => {
  const dirs: string[] = [];
  const tmpDir = () => {
    const d = mkdtempSync(join(tmpdir(), "surf-status-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("writeOwnStatuses leaves no temp file behind", () => {
    const dir = tmpDir();
    writeOwnStatuses(new Map([["s1", { type: "busy" } as SessionStatus]]), ["s1"], dir);
    expect(readdirSync(dir)).toEqual([`${process.pid}.json`]);
  });

  test("readCrossInstance reads fresh files and skips own, stale and truncated ones", () => {
    const dir = tmpDir();
    writeOwnStatuses(new Map(), [], dir);
    const body = (updated: number) =>
      JSON.stringify({ updated, statuses: { s9: { type: "busy" } }, waiting: ["s9"] });
    writeFileSync(join(dir, "111.json"), body(Date.now()));
    writeFileSync(join(dir, "222.json"), body(Date.now() - 60_000));
    writeFileSync(join(dir, "333.json"), '{"upd');
    const remotes = readCrossInstance(10_000, dir);
    expect(remotes).toHaveLength(1);
    expect(remotes[0].statuses.get("s9")).toEqual({ type: "busy" });
    expect(remotes[0].waiting).toEqual(["s9"]);
  });
});

describe("palette", () => {
  test("follows a theme object that changes after creation", () => {
    const theme = {
      text: { base: "a", muted: "b", feedback: { info: { base: "i" }, success: { base: "s" }, error: { base: "e" } }, action: { primary: { base: "p", selected: "ps" } } },
      hue: { accent: { 200: "x" } },
      background: { action: { primary: { selected: "bg" } } },
    } as never;
    const p = palette(theme);
    expect(p.text as unknown).toBe("a");
    expect(p.accent as unknown).toBe("x");
    expect(p.selectedBg as unknown).toBe("bg");
    (theme as { text: { base: string } }).text.base = "changed";
    expect(p.text as unknown).toBe("changed");
  });
});

type Handler = (event: { type: string; data: Record<string, unknown> }) => void;

function fakeContext(opts: {
  pages?: ReturnType<typeof page>[];
  running?: Set<string>;
}) {
  const handlers = new Map<string, Handler[]>();
  const listCalls: unknown[] = [];
  const pending: Array<(value: ReturnType<typeof page>) => void> = [];
  const ctx = {
    client: {
      session: {
        list: (input: unknown) => {
          listCalls.push(input);
          if (opts.pages) return Promise.resolve(opts.pages[Math.min(listCalls.length - 1, opts.pages.length - 1)]);
          return new Promise((resolve) => pending.push(resolve as never));
        },
      },
    },
    data: {
      on: (type: string, handler: Handler) => {
        handlers.set(type, [...(handlers.get(type) ?? []), handler]);
        return () => handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler));
      },
      session: {
        status: (id: string) => (opts.running?.has(id) ? "running" : "idle"),
        permission: { list: () => undefined },
        form: { list: () => undefined },
      },
    },
  };
  const emit = (type: string, data: Record<string, unknown>) => {
    for (const h of handlers.get(type) ?? []) h({ type, data });
  };
  return { ctx: ctx as never, emit, handlers, listCalls, pending };
}

describe("createSurfState", () => {
  test("loads sessions and reports busy ones from data.session.status", async () => {
    const { ctx } = fakeContext({ pages: [page([info("a"), info("b")])], running: new Set(["a"]) });
    const state = createSurfState(ctx, { pollMs: 60_000 });
    await state.refresh();
    expect(state.roots().map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(state.statuses().get("a")).toEqual({ type: "busy" });
    expect(state.statuses().has("b")).toBe(false);
    expect(state.loading()).toBe(false);
    state.dispose();
  });

  test("an event status wins over data.session.status, and idle is not invented", async () => {
    const { ctx, emit } = fakeContext({ pages: [page([info("a"), info("b")])], running: new Set(["a"]) });
    const state = createSurfState(ctx, { pollMs: 60_000 });
    await state.refresh();
    emit("session.status", { sessionID: "a", status: { type: "retry", attempt: 1, message: "x", next: 0 } });
    expect(state.statuses().get("a")?.type).toBe("retry");
    expect(state.statuses().get("b")).toBeUndefined();
    state.dispose();
  });

  test("a permission request marks the session as waiting until it is replied to", async () => {
    const { ctx, emit } = fakeContext({ pages: [page([info("a")])] });
    const state = createSurfState(ctx, { pollMs: 60_000 });
    await state.refresh();
    emit("permission.asked", { id: "p1", sessionID: "a" });
    expect(state.waitingIds().has("a")).toBe(true);
    emit("permission.replied", { requestID: "p1", sessionID: "a" });
    expect(state.waitingIds().has("a")).toBe(false);
    state.dispose();
  });

  test("overlapping refreshes make at most one extra request and keep the latest response", async () => {
    const { ctx, listCalls, pending } = fakeContext({});
    const state = createSurfState(ctx, { pollMs: 60_000 });
    const runs = Array.from({ length: 5 }, () => state.refresh());
    expect(listCalls).toHaveLength(1);
    pending.shift()!(page([info("old")]));
    await new Promise((r) => setTimeout(r, 0));
    expect(listCalls).toHaveLength(2);
    pending.shift()!(page([info("new")]));
    await Promise.all(runs);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.roots().map((s) => s.id)).toEqual(["new"]);
    state.dispose();
  });

  test("dispose unsubscribes every event handler and removes the status file", async () => {
    const { ctx, handlers } = fakeContext({ pages: [page([info("a")])] });
    const state = createSurfState(ctx, { pollMs: 60_000 });
    await state.refresh();
    expect(readdirSync(join(tmpdir(), "opencode-session-surf-status"))).toContain(`${process.pid}.json`);
    state.dispose();
    expect([...handlers.values()].flat()).toHaveLength(0);
    expect(readdirSync(join(tmpdir(), "opencode-session-surf-status"))).not.toContain(`${process.pid}.json`);
  });
});
