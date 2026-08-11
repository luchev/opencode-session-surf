/// <reference path="./bun-sqlite.d.ts" />
/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup, For, Show } from "solid-js";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { SessionStatus } from "@opencode-ai/sdk";
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, watch as fsWatch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POLL_MS = 10_000;
const RECENT_MS = 24 * 60 * 60 * 1000;
const SPINNER_FRAMES = ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"];
const SPINNER_MS = 150;
const ACTIVE_MS = 2 * 60 * 1000;
const DB_PATH = `${process.env.HOME ?? ""}/.local/share/opencode/opencode.db`;

// Cross-instance busy-status broadcast: each opencode process writes its own
// locally-known session statuses to a pid-named file in the OS temp dir, so
// other instances can see when a session is busy elsewhere. Temp dir means
// no manual cleanup is needed; stale entries are ignored by age.
const STATUS_DIR = join(tmpdir(), "opencode-session-surf-status");
const STALE_MS = POLL_MS * 3;

function ensureStatusDir(): void {
  try {
    mkdirSync(STATUS_DIR, { recursive: true });
  } catch {}
}

function writeOwnStatuses(map: Map<string, SessionStatus>, waiting: string[]): void {
  try {
    ensureStatusDir();
    const file = join(STATUS_DIR, `${process.pid}.json`);
    writeFileSync(
      file,
      JSON.stringify({ updated: Date.now(), statuses: Object.fromEntries(map), waiting }),
    );
  } catch {}
}

type RemoteBroadcast = { statuses: Map<string, SessionStatus>; waiting: string[] };

function readCrossInstance(): RemoteBroadcast[] {
  try {
    ensureStatusDir();
    const ownFile = `${process.pid}.json`;
    const files = readdirSync(STATUS_DIR).filter((f: string) => f.endsWith(".json") && f !== ownFile);
    const out: RemoteBroadcast[] = [];
    for (const f of files) {
      try {
        const raw = JSON.parse(readFileSync(join(STATUS_DIR, f), "utf8")) as {
          updated?: number;
          statuses?: Record<string, SessionStatus>;
          waiting?: string[];
        };
        if (!raw.updated || Date.now() - raw.updated > STALE_MS) continue;
        out.push({ statuses: new Map(Object.entries(raw.statuses ?? {})), waiting: raw.waiting ?? [] });
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

// Union of busy signals: a session shows busy if ANY live instance reports it
// busy, without letting other instances' idle knowledge override local truth.
function mergeBusy(local: Map<string, SessionStatus>, remotes: RemoteBroadcast[]): Map<string, SessionStatus> {
  const merged = new Map(local);
  for (const remote of remotes) {
    for (const [id, status] of remote.statuses) {
      if (isBusy(status)) merged.set(id, status);
    }
  }
  return merged;
}

// The SDK's SessionStatus has no "waiting" type - a session blocked on a
// question/permission answer only ever reports as "busy" to other processes.
// So waiting ids must be broadcast and unioned separately, or a session
// waiting for input in one terminal shows as merely "working" everywhere else.
function mergeWaiting(local: string[], remotes: RemoteBroadcast[]): Set<string> {
  const merged = new Set(local);
  for (const remote of remotes) for (const id of remote.waiting) merged.add(id);
  return merged;
}

type DbRow = {
  id: string;
  project_id: string;
  directory: string;
  parent_id: string | null;
  title: string;
  time_created: number;
  time_updated: number;
};

type SidebarSession = {
  id: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  time: { created: number; updated: number };
};

let db: Database | undefined;
function getDb(): Database {
  if (!db) db = new Database(DB_PATH, { readonly: true });
  return db;
}

function dbSessions(): SidebarSession[] {
  const rows = getDb()
    .query(
      `SELECT id, project_id, directory, parent_id, title, time_created, time_updated
       FROM session
       WHERE parent_id IS NULL AND time_archived IS NULL
       ORDER BY time_updated DESC
       LIMIT 100`,
    )
    .all() as DbRow[];
  return rows.map((r) => ({
    id: r.id,
    projectID: r.project_id,
    directory: r.directory,
    parentID: r.parent_id ?? undefined,
    title: r.title,
    time: { created: r.time_created, updated: r.time_updated },
  }));
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function dayGroup(ts: number): string {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const start = startOfDay.getTime();
  if (ts >= start) return "Today";
  if (ts >= start - 86_400_000) return "Yesterday";
  const week = start - 7 * 86_400_000;
  if (ts >= week) return "This Week";
  const month = start - 30 * 86_400_000;
  if (ts >= month) return "This Month";
  return "Older";
}

function sessionTitle(s: SidebarSession): string {
  const t = s.title?.trim();
  if (t && t !== "New Session") return t;
  const parts = s.directory.split("/").filter(Boolean);
  return parts[parts.length - 1] || s.id.slice(0, 8);
}

function shortDir(dir: string): string {
  const home = process.env.HOME ?? "";
  return dir.startsWith(home) ? "~" + dir.slice(home.length) : dir;
}

type Grouped = { label: string; sessions: SidebarSession[] };

function groupSessions(sessions: SidebarSession[]): Grouped[] {
  const groups = new Map<string, SidebarSession[]>();
  for (const s of sessions) {
    const label = dayGroup(s.time.updated);
    const arr = groups.get(label);
    if (arr) arr.push(s);
    else groups.set(label, [s]);
  }
  const order = ["Today", "Yesterday", "This Week", "This Month", "Older"];
  const out: Grouped[] = [];
  for (const label of order) {
    const arr = groups.get(label);
    if (arr) {
      arr.sort((a, b) => b.time.updated - a.time.updated);
      out.push({ label, sessions: arr });
    }
  }
  return out;
}

function isBusy(status: SessionStatus | undefined): boolean {
  return status?.type === "busy" || status?.type === "retry";
}

function SidebarSessions(props: { api: TuiPluginApi; session_id: string }) {
  const theme = props.api.theme.current;
  const [sessions, setSessions] = createSignal<SidebarSession[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [statuses, setStatuses] = createSignal<Map<string, SessionStatus>>(new Map());
  const [waitingIds, setWaitingIds] = createSignal<Set<string>>(new Set());
  const [tick, setTick] = createSignal(0);

  async function refresh() {
    try {
      setSessions(dbSessions());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    props.api.renderer.requestRender();
  }

  // `state.session.status` is the host TUI's own synchronous, always-fresh
  // per-session status (same family as state.session.question/permission),
  // unlike the async bulk client.session.status() RPC which was found to
  // miss/lag the process's own foreground session.
  function localStatusesFromState(): Map<string, SessionStatus> {
    const m = new Map<string, SessionStatus>();
    for (const s of sessions()) {
      const st = props.api.state.session.status(s.id);
      if (st) m.set(s.id, st);
    }
    return m;
  }

  function localWaitingIds(): string[] {
    return sessions()
      .filter(
        (s) =>
          props.api.state.session.question(s.id).length > 0 ||
          props.api.state.session.permission(s.id).length > 0,
      )
      .map((s) => s.id);
  }

  function commitStatuses() {
    const local = localStatusesFromState();
    const localWaiting = localWaitingIds();
    writeOwnStatuses(local, localWaiting);
    const remotes = readCrossInstance();
    setStatuses(mergeBusy(local, remotes));
    setWaitingIds(mergeWaiting(localWaiting, remotes));
    props.api.renderer.requestRender();
  }

  refresh();
  commitStatuses();
  const onEvent = () => {
    refresh();
    commitStatuses();
  };
  const unsub = props.api.event.on("session.updated", onEvent);
  const timer = setInterval(() => {
    refresh();
    commitStatuses();
  }, POLL_MS);

  const unsubStatus = props.api.event.on("session.status", () => commitStatuses());

  let watcher: { close(): void } | undefined;
  try {
    ensureStatusDir();
    watcher = fsWatch(STATUS_DIR, () => {
      const remotes = readCrossInstance();
      setStatuses(mergeBusy(localStatusesFromState(), remotes));
      setWaitingIds(mergeWaiting(localWaitingIds(), remotes));
      props.api.renderer.requestRender();
    });
  } catch {
    // fs.watch unsupported here; POLL_MS interval still reconciles
  }

  const isWaiting = (id: string) => waitingIds().has(id);

  const anyAnimated = createMemo(() =>
    sessions().some((s) => {
      const st = statuses().get(s.id);
      return isBusy(st) || isWaiting(s.id);
    }),
  );
  createEffect(() => {
    if (!anyAnimated()) return;
    const spin = setInterval(() => {
      setTick((t) => t + 1);
      props.api.renderer.requestRender();
    }, SPINNER_MS);
    onCleanup(() => clearInterval(spin));
  });

  onCleanup(() => {
    unsub();
    unsubStatus();
    clearInterval(timer);
    watcher?.close();
  });

  const active = createMemo(() =>
    sessions().filter((s) => {
      const st = statuses().get(s.id);
      const fresh = s.time.updated >= Date.now() - ACTIVE_MS;
      return isBusy(st) || isWaiting(s.id) || fresh;
    }),
  );
  const activeIds = createMemo(() => new Set(active().map((s) => s.id)));

  const recent = createMemo(() => {
    const cutoff = Date.now() - RECENT_MS;
    return sessions().filter((s) => !activeIds().has(s.id) && s.time.updated >= cutoff);
  });
  const recentGrouped = createMemo(() => groupSessions(recent()));

  const renderRow = (s: SidebarSession) => {
    const isCurrent = s.id === props.session_id;
    // fg/marker MUST stay as getters (not pre-computed values) so the JSX
    // compiler keeps them reactive to tick()/statuses() - <For> only
    // recreates a row when the session object identity changes, so a plain
    // computed value here would freeze at whatever it was on first mount.
    const waiting = () => isWaiting(s.id);
    const working = () => !waiting() && isBusy(statuses().get(s.id));
    const status = () => statuses().get(s.id);
    const fg = () =>
      waiting()
        ? theme.accent
        : working()
          ? theme.info
          : isCurrent
            ? theme.primary
            : status()
              ? theme.success
              : theme.text;
    const marker = () =>
      waiting()
        ? Math.floor(tick() / 3) % 2 === 0
          ? "❓"
          : "  "
        : working()
          ? SPINNER_FRAMES[tick() % SPINNER_FRAMES.length]
          : isCurrent
            ? "●"
            : " ";
    return (
      <box
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={(_e) => props.api.route.navigate("session", { sessionID: s.id })}
      >
        <text fg={fg()} wrapMode="none">
          {marker()} {sessionTitle(s)}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {" "}
          {relTime(s.time.updated)} · {shortDir(s.directory)}
        </text>
      </box>
    );
  };

  return (
    <box flexDirection="column" flexGrow={1} minHeight={1}>
      <box paddingLeft={1} paddingTop={1}>
        <text fg={theme.text}>
          <b>Sessions</b>
        </text>
      </box>
      <Show when={loading()}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>Loading sessions…</text>
        </box>
      </Show>
      <Show when={!loading() && error()}>
        <box paddingLeft={1}>
          <text fg={theme.error}>{error()}</text>
        </box>
      </Show>
      <Show when={!loading() && !error() && active().length === 0 && recent().length === 0}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>No sessions found</text>
        </box>
      </Show>
      <Show when={!loading() && !error() && active().length > 0}>
        <box flexDirection="column">
          <box paddingLeft={1} paddingTop={1}>
            <text fg={theme.textMuted}>Active</text>
          </box>
          <For each={active()}>{(s) => renderRow(s)}</For>
        </box>
      </Show>
      <Show when={!loading() && !error() && recentGrouped().length > 0}>
        <box flexDirection="column">
          <box paddingLeft={1} paddingTop={1}>
            <text fg={theme.textMuted}>Recent</text>
          </box>
          <For each={recentGrouped()}>
            {(g) => (
              <box flexDirection="column">
                <box paddingLeft={1} paddingTop={1}>
                  <text fg={theme.textMuted}>{g.label}</text>
                </box>
                <For each={g.sessions}>{(s) => renderRow(s)}</For>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  );
}

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current;
  if (route.name !== "session") return undefined;
  const sessionID = (route.params as { sessionID?: unknown } | undefined)?.sessionID;
  return typeof sessionID === "string" ? sessionID : undefined;
}

function navigateRelative(api: TuiPluginApi, delta: 1 | -1): void {
  const list = dbSessions();
  if (list.length === 0) return;
  const currentID = currentSessionID(api);
  const idx = list.findIndex((s) => s.id === currentID);
  const next = list[((idx === -1 ? 0 : idx) + delta + list.length) % list.length];
  if (next) api.route.navigate("session", { sessionID: next.id });
}

// DialogSelect already does substring/fuzzy filtering over option titles, so
// no custom fuzzy-match algorithm is needed here.
function openPicker(api: TuiPluginApi): void {
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Switch Session"
      placeholder="Search sessions..."
      current={currentSessionID(api)}
      options={dbSessions().map((s) => ({
        title: sessionTitle(s),
        value: s.id,
        description: `${relTime(s.time.updated)} · ${shortDir(s.directory)}`,
      }))}
      onSelect={(opt) => {
        api.ui.dialog.clear();
        api.route.navigate("session", { sessionID: opt.value });
      }}
    />
  ));
}

const plugin: TuiPluginModule = {
  id: "opencode-session-surf",
  tui: async (api) => {
    api.slots.register({
      order: 300,
      slots: {
        sidebar_content(_ctx, props) {
          return <SidebarSessions api={api} session_id={props.session_id} />;
        },
      },
    });

    // Keybinds are configurable via tui.json's "keybinds" map, keyed by
    // command name (e.g. {"session_surf.next": "ctrl+]"}); ctrl+o and
    // ctrl+x j/k are the hardcoded defaults (vim-style), overridable per user.
    api.keymap.registerLayer({
      commands: [
        {
          name: "session_surf.picker.open",
          title: "Switch session",
          category: "Session",
          namespace: "palette",
          run() {
            openPicker(api);
          },
        },
        {
          name: "session_surf.next",
          title: "Next session",
          category: "Session",
          namespace: "palette",
          run() {
            navigateRelative(api, 1);
          },
        },
        {
          name: "session_surf.previous",
          title: "Previous session",
          category: "Session",
          namespace: "palette",
          run() {
            navigateRelative(api, -1);
          },
        },
      ],
      bindings: [
        { key: "ctrl+o", cmd: "session_surf.picker.open", desc: "Open session picker" },
        { key: "ctrl+xj", cmd: "session_surf.next", desc: "Next session" },
        { key: "ctrl+xk", cmd: "session_surf.previous", desc: "Previous session" },
        ...api.tuiConfig.keybinds.gather("session_surf", [
          "session_surf.picker.open",
          "session_surf.next",
          "session_surf.previous",
        ]),
      ],
    });
  },
};

export default plugin;
