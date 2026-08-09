/// <reference path="./bun-sqlite.d.ts" />
/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup, For, Show } from "solid-js";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { SessionStatus } from "@opencode-ai/sdk";
import { Database } from "bun:sqlite";

const POLL_MS = 10_000;
const RECENT_MS = 24 * 60 * 60 * 1000;
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
const SPINNER_MS = 150;
const ACTIVE_MS = 2 * 60 * 1000;
const DB_PATH = `${process.env.HOME ?? ""}/.local/share/opencode/opencode.db`;

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
  }

  async function refreshStatuses() {
    try {
      const result = await props.api.client.session.status();
      const map = Array.isArray(result) ? {} : ((result as { data?: Record<string, SessionStatus> }).data ?? result);
      setStatuses(new Map(Object.entries(map ?? {})));
    } catch {
      // keep previous statuses
    }
  }

  refresh();
  refreshStatuses();
  const onEvent = () => refresh();
  const unsub = props.api.event.on("session.updated", onEvent);
  const timer = setInterval(() => {
    refresh();
    refreshStatuses();
  }, POLL_MS);

  const unsubStatus = props.api.event.on("session.status", (event) => {
    const { sessionID, status } = event.properties;
    setStatuses((prev) => {
      const next = new Map(prev);
      next.set(sessionID, status);
      return next;
    });
  });

  const isWaiting = (id: string) =>
    props.api.state.session.question(id).length > 0 ||
    props.api.state.session.permission(id).length > 0;

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
    const active = s.id === props.session_id;
    const waiting = isWaiting(s.id);
    const working = !waiting && isBusy(statuses().get(s.id));
    const status = statuses().get(s.id);
    const fg = active
      ? theme.primary
      : waiting
        ? theme.accent
        : working
          ? theme.info
          : status
            ? theme.success
            : theme.text;
    const marker = waiting
      ? Math.floor(tick() / 3) % 2 === 0
        ? "❓"
        : "  "
      : working
        ? SPINNER_FRAMES[tick() % SPINNER_FRAMES.length]
        : active
          ? "●"
          : " ";
    return (
      <box
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={(_e) => props.api.route.navigate("session", { sessionID: s.id })}
      >
        <text fg={fg} wrapMode="none">
          {marker} {sessionTitle(s)}
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
  },
};

export default plugin;
