/// <reference path="./bun-sqlite.d.ts" />
/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, onCleanup, For, Show } from "solid-js";
import type { TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import type { SessionStatus } from "@opencode-ai/sdk";
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, appendFileSync, watch as fsWatch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POLL_MS = 3_000;
// A "work block" window: Recent shows the last BLOCK_MS of work plus the
// block of work immediately before it, so a quiet gap (e.g. a weekend)
// doesn't hide the previous batch of sessions.
const BLOCK_MS = 24 * 60 * 60 * 1000;
const SPINNER_MS = 150;
// Named styles, selectable via plugin options ({"spinner": "dots", "waiting": "emoji", "marker": "dot"}).
type SpinnerName = "dots" | "arc" | "sweep" | "fill" | "bounce" | "sparkle" | "block" | "battery" | "gauge" | "speed" | "none";
export const SPINNERS: Record<SpinnerName, string[]> = {
  dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  arc: ["◜", "◝", "◞", "◟"],
  sweep: ["◐", "◓", "◑", "◒"],
  fill: ["░", "▒", "▓", "█", "▓", "▒"],
  bounce: ["⠁", "⠂", "⠄", "⠂"],
  sparkle: ["✶", "✸", "✹", "✺", "✹", "✸"],
  block: ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"],
  battery: ["󰁺", "󰁻", "󰁼", "󰁽", "󰁾", "󰁿", "󰂀", "󰂁", "󰂂", "󰁹", "󰂂", "󰂁", "󰂀", "󰁿", "󰁾", "󰁽", "󰁼", "󰁻"],
  gauge: ["󰡳", "󰡵", "󰊚", "󰡴", "󰊚", "󰡵"],
  speed: ["󰾆", "󰓅", "󰾅", "󰓅"],
  none: [" "],
};
type WaitingName = "emoji" | "ellipsis" | "question" | "pulse" | "block" | "bounce" | "eyeblink" | "bell" | "help" | "bulb" | "ghost" | "none";
export const WAITERS: Record<WaitingName, string[]> = {
  emoji: ["❓", "  "],
  ellipsis: ["…", "  "],
  question: ["?", " "],
  pulse: ["⣾", "⣿"],
  block: ["█", " "],
  bounce: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈", "⠐", "⠠", "⢀", "⡀", "⠄", "⠂"],
  eyeblink: ["󰈈", "󰛐"],
  bell: ["󰂞", "󰂚"],
  help: ["󰠗", "󰆆"],
  bulb: ["󰛨", "󰛩"],
  ghost: ["󰊠", "󱙝"],
  none: [" "],
};
type MarkerName = "dot" | "square" | "arrow" | "star" | "none" | "caret" | "ping" | "creation" | "sprout";
export const MARKERS: Record<MarkerName, string> = {
  dot: "●",
  square: "▣",
  arrow: "►",
  star: "✦",
  none: "",
  caret: "▸",
  ping: "◉",
  creation: "󰙴",
  sprout: "󰹦",
};
// Empty string hides the indicator; unknown names fall back to the default.
export function framesFor(map: Record<string, string[]>, value: unknown, fallback: string[]): string[] {
  if (value === "") return [];
  return typeof value === "string" && value in map ? map[value] : fallback;
}
export function markerGlyph(value: unknown): string {
  if (value === "") return MARKERS.none;
  return typeof value === "string" && value in MARKERS ? MARKERS[value as MarkerName] : MARKERS.dot;
}
// Presets define a whole look and override the individual style options.
// "combined" makes the marker and spinner share one cell: the current session
// shows its marker glyph (no spinner), non-current sessions show the spinner.
type Preset = { marker: string; waiting: string[]; spinner: string[]; combined: boolean };
export const PRESETS: Record<string, Preset> = {
  ping: { marker: "◉", waiting: WAITERS.bell, spinner: SPINNERS.arc, combined: true },
  term: { marker: ">", waiting: ["...", "   "], spinner: ["-", "\\", "|", "/"], combined: true },
  braille: { marker: "●", waiting: WAITERS.pulse, spinner: SPINNERS.dots, combined: false },
};
const WAIT_MS = 450;
// Anything updated in the last 15 minutes is Active.
const ACTIVE_MS = 15 * 60 * 1000;
const DB_PATH = `${process.env.HOME ?? ""}/.local/share/opencode/opencode.db`;

// Cross-instance busy-status broadcast: each opencode process writes its own
// locally-known session statuses to a pid-named file in the OS temp dir, so
// other instances can see when a session is busy elsewhere. Temp dir means
// no manual cleanup is needed; stale entries are ignored by age.
const STATUS_DIR = join(tmpdir(), "opencode-session-surf-status");
const STALE_MS = POLL_MS * 3;

// Opt-in diagnostics: {"debug": true} appends STATUS_DIR/debug.log (OS temp dir, no cleanup needed).
let debugEnabled = false;
function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}
function debugLog(line: string): void {
  if (!debugEnabled) return;
  try {
    mkdirSync(STATUS_DIR, { recursive: true });
    appendFileSync(join(STATUS_DIR, "debug.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

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

function readCrossInstance(staleMs = STALE_MS): RemoteBroadcast[] {
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
        if (!raw.updated || Date.now() - raw.updated > staleMs) continue;
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

export function relTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function sessionTitle(s: SidebarSession): string {
  const t = s.title?.trim();
  if (t && t !== "New Session") return t;
  const parts = s.directory.split("/").filter(Boolean);
  return parts[parts.length - 1] || s.id.slice(0, 8);
}

export function shortDir(dir: string): string {
  const home = process.env.HOME ?? "";
  return dir.startsWith(home) ? "~" + dir.slice(home.length) : dir;
}

// Fuzzy subsequence score of `query` against `target` (case-insensitive).
// Returns -1 when the query is not a subsequence; higher is better. A match
// at the start of the target, at a word boundary, or in a consecutive run
// all score extra, so "srf" outranks "srfx" and "sf" for "surfer".
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  if (q === "") return 0;
  if (q.length > t.length) return -1;
  if (t === q) return 1_000_000;
  if (t.startsWith(q)) return 100_000 + t.length;
  let score = 0;
  let qi = 0;
  let prev = -2;
  let run = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    qi++;
    let s = 1;
    if (ti === 0) s += 10;
    else {
      const before = t[ti - 1];
      if (before === " " || before === "-" || before === "_" || before === "/" || before === ".") s += 8;
    }
    if (prev === ti - 1) {
      run++;
      s += 5 * run;
    } else {
      run = 0;
    }
    prev = ti;
    score += s;
  }
  return qi < q.length ? -1 : score;
}

// Sessions matching `query`, best fuzzy match first. Ties — sessions with
// the same name, for example — fall back to most recently updated on top.
// An empty query returns everything, most recent first.
export function fuzzyRank(query: string, sessions: SidebarSession[]): SidebarSession[] {
  const q = query.trim();
  if (q === "") return [...sessions].sort((a, b) => b.time.updated - a.time.updated);
  const scored: { s: SidebarSession; score: number }[] = [];
  for (const s of sessions) {
    const score = Math.max(fuzzyScore(q, sessionTitle(s)), fuzzyScore(q, shortDir(s.directory)));
    if (score >= 0) scored.push({ s, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.s.time.updated - a.s.time.updated)
    .map((x) => x.s);
}

// Recent = the last BLOCK_MS of work plus the block of work right before it
// (at most two 24h windows). Each window is anchored at the newest session in
// that period, so the list stops once a second window has been collected.
export function recentSessions(sessions: SidebarSession[], now = Date.now()): SidebarSession[] {
  const sorted = [...sessions].sort((a, b) => b.time.updated - a.time.updated);
  if (sorted.length === 0) return [];
  const out: SidebarSession[] = [];
  let upper = Math.min(sorted[0].time.updated, now);
  for (let w = 0; w < 2; w++) {
    const lower = upper - BLOCK_MS;
    for (const s of sorted) {
      if (s.time.updated >= lower && s.time.updated <= upper) out.push(s);
      else if (s.time.updated < lower) break;
    }
    const next = sorted.find((s) => s.time.updated < lower);
    if (!next) break;
    upper = next.time.updated;
  }
  return out;
}

export function isBusy(status: SessionStatus | undefined): boolean {
  return status?.type === "busy" || status?.type === "retry";
}

type RowTheme = Pick<TuiThemeCurrent, "text" | "textMuted" | "accent" | "info" | "primary" | "success">;

// One sidebar row. Marker/spinner getters stay reactive to signal changes;
// exported for direct testing.
export function SessionRow(props: {
  s: SidebarSession;
  isCurrent: boolean;
  inActive: boolean;
  marker: string;
  waitingFrames: string[];
  spinnerFrames: string[];
  waiting: () => boolean;
  working: () => boolean;
  status: () => SessionStatus | undefined;
  theme: RowTheme;
  onNavigate: () => void;
  openElsewhere: boolean;
  combined: boolean;
}) {
  const fg = () =>
    props.waiting()
      ? props.theme.accent
      : props.working()
        ? props.theme.info
        : props.isCurrent
          ? props.theme.primary
          : props.status()
            ? props.theme.success
            // Idle sessions are green while in the Active section; nothing
            // in Active is white. Recent rows use the default text color.
            : props.inActive
              ? props.theme.success
              : props.theme.text;
  // Non-combined mode: the marker cell stays reserved so titles keep a
  // fixed column whether or not a spinner shows. The has-status dot is
  // opt-in via the "openElsewhere" option (off by default).
  const marker = () =>
    props.isCurrent
      ? props.marker
      : props.openElsewhere && props.status() && !isBusy(props.status())
        ? "•"
        : " ";
  // Combined mode (presets): the marker and spinner share one cell. The
  // current session shows its glyph (never a spinner); non-current sessions
  // show their waiting/working spinner; idle Active sessions get the dot.
  const combinedDot = () =>
    !props.isCurrent &&
    !props.waiting() &&
    !props.working() &&
    ((props.combined && props.inActive) ||
      (props.openElsewhere && props.status() && !isBusy(props.status())));
  return (
    <box paddingLeft={1} paddingRight={1} onMouseDown={(_e) => props.onNavigate()}>
      <box flexDirection="row">
        <Show when={props.combined}>
          <box width={1}>
            <Show when={props.isCurrent}>
              <text fg={props.theme.primary} wrapMode="none">
                {props.marker}
              </text>
            </Show>
            <Show when={!props.isCurrent && props.waiting() && props.waitingFrames.length > 0}>
              <spinner frames={props.waitingFrames} interval={WAIT_MS} color={props.theme.accent} />
            </Show>
            <Show when={!props.isCurrent && !props.waiting() && props.working() && props.spinnerFrames.length > 0}>
              <spinner frames={props.spinnerFrames} interval={SPINNER_MS} color={props.theme.info} />
            </Show>
            <Show when={combinedDot()}>
              <text fg={props.theme.success} wrapMode="none">
                •
              </text>
            </Show>
          </box>
        </Show>
        <Show when={!props.combined}>
          <text fg={props.isCurrent ? props.theme.primary : fg()} wrapMode="none">
            {marker()}
          </text>
          <box width={1}>
            <Show when={props.waiting() && props.waitingFrames.length > 0}>
              <spinner frames={props.waitingFrames} interval={WAIT_MS} color={props.theme.accent} />
            </Show>
            <Show when={props.working() && props.spinnerFrames.length > 0}>
              <spinner frames={props.spinnerFrames} interval={SPINNER_MS} color={props.theme.info} />
            </Show>
          </box>
        </Show>
        <text fg={fg()} wrapMode="none">
          {" "}
          {sessionTitle(props.s)}
        </text>
      </box>
      <text fg={props.theme.textMuted} wrapMode="none">
        {" "}
        {relTime(props.s.time.updated)} · {shortDir(props.s.directory)}
      </text>
    </box>
  );
}

function SidebarSessions(props: {
  api: TuiPluginApi;
  session_id: string;
  spinner: string[];
  waiting: string[];
  marker: string;
  pollMs: number;
  openElsewhere: boolean;
  combined: boolean;
}) {
  const theme = props.api.theme.current;
  const [sessions, setSessions] = createSignal<SidebarSession[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [statuses, setStatuses] = createSignal<Map<string, SessionStatus>>(new Map());
  const [waitingIds, setWaitingIds] = createSignal<Set<string>>(new Set());
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());

  async function refresh() {
    try {
      setSessions(dbSessions());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      debugLog(`refresh error: ${String(e)}`);
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
    const remotes = readCrossInstance(props.pollMs * 3);
    const merged = mergeBusy(local, remotes);
    setStatuses(merged);
    setWaitingIds(mergeWaiting(localWaiting, remotes));
    debugLog(`statuses busy=${[...merged.values()].filter(isBusy).length} waiting=${waitingIds().size}`);
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
  }, props.pollMs);

  const unsubStatus = props.api.event.on("session.status", () => commitStatuses());

  let watcher: { close(): void } | undefined;
  try {
    ensureStatusDir();
    watcher = fsWatch(STATUS_DIR, () => {
    const remotes = readCrossInstance(props.pollMs * 3);
      setStatuses(mergeBusy(localStatusesFromState(), remotes));
      setWaitingIds(mergeWaiting(localWaitingIds(), remotes));
      props.api.renderer.requestRender();
    });
  } catch {
    // fs.watch unsupported here; POLL_MS interval still reconciles
  }

  const isWaiting = (id: string) => waitingIds().has(id);

  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const header = (key: string, label: string) => (
    <box paddingLeft={1} paddingTop={1} onMouseDown={() => toggleCollapsed(key)}>
      <text fg={theme.textMuted}>
        {collapsed().has(key) ? "▶" : "▼"} {label}
      </text>
    </box>
  );

  onCleanup(() => {
    unsub();
    unsubStatus();
    clearInterval(timer);
    watcher?.close();
  });

  const active = createMemo(() =>
    sessions().filter((s) => {
      // the session you're in is always Active, regardless of status/freshness
      if (s.id === props.session_id) return true;
      const st = statuses().get(s.id);
      const fresh = s.time.updated >= Date.now() - ACTIVE_MS;
      return isBusy(st) || isWaiting(s.id) || fresh;
    }),
  );
  const activeIds = createMemo(() => new Set(active().map((s) => s.id)));

  const recent = createMemo(() => {
    const ids = new Set(recentSessions(sessions(), Date.now()).map((s) => s.id));
    return sessions().filter((s) => !activeIds().has(s.id) && ids.has(s.id));
  });

  const renderRow = (s: SidebarSession, inActive: boolean) => (
    <SessionRow
      s={s}
      isCurrent={s.id === props.session_id}
      inActive={inActive}
      marker={props.marker}
      waitingFrames={props.waiting}
      spinnerFrames={props.spinner}
      waiting={() => isWaiting(s.id)}
      working={() => !isWaiting(s.id) && isBusy(statuses().get(s.id))}
      status={() => statuses().get(s.id)}
      theme={theme}
      onNavigate={() => props.api.route.navigate("session", { sessionID: s.id })}
      openElsewhere={props.openElsewhere}
      combined={props.combined}
    />
  );

  return (
    <box flexDirection="column" flexGrow={1} minHeight={1}>
      <box paddingTop={1}>
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
          {header("active", "Active")}
          <Show when={!collapsed().has("active")}>
            <For each={active()}>{(s) => renderRow(s, true)}</For>
          </Show>
        </box>
      </Show>
      <Show when={!loading() && !error() && recent().length > 0}>
        <box flexDirection="column">
          {header("recent", "Recent")}
          <Show when={!collapsed().has("recent")}>
            <For each={recent()}>{(s) => renderRow(s, false)}</For>
          </Show>
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

// The host's DialogSelect only substring-matches option titles. We render it
// with skipFilter so it shows exactly the options we hand it, and re-rank
// them with our own fuzzy matcher (score desc, most recent on top) whenever
// the query changes via onFilter.
function openPicker(api: TuiPluginApi): void {
  const [query, setQuery] = createSignal("");
  const options = createMemo(() =>
    fuzzyRank(query(), dbSessions()).map((s) => ({
      title: sessionTitle(s),
      value: s.id,
      description: `${relTime(s.time.updated)} · ${shortDir(s.directory)}`,
    })),
  );
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Switch Session"
      placeholder="Search sessions..."
      current={currentSessionID(api)}
      options={options()}
      skipFilter
      onFilter={(q) => setQuery(q)}
      onSelect={(opt) => {
        api.ui.dialog.clear();
        api.route.navigate("session", { sessionID: opt.value });
      }}
    />
  ));
}

const plugin: TuiPluginModule = {
  id: "opencode-session-surf",
  tui: async (api, options) => {
    setDebug(options?.debug === true);
    debugLog(`module-loaded url=${import.meta.url}`);
    const spinner = framesFor(SPINNERS, options?.spinner, SPINNERS.dots);
    const waiting = framesFor(WAITERS, options?.waiting, WAITERS.pulse);
    const marker = markerGlyph(options?.marker);
    const openElsewhere = options?.openElsewhere === true;
    // Presets define the whole look and override the individual style
    // options; unknown preset names fall back to the individual options.
    const preset = typeof options?.preset === "string" ? PRESETS[options.preset] : undefined;
    const spinnerFrames = preset?.spinner ?? spinner;
    const waitingFrames = preset?.waiting ?? waiting;
    const markerGlyphName = preset?.marker ?? marker;
    const combined = preset?.combined ?? false;
    const pollMs = typeof options?.pollMs === "number" && options.pollMs >= 1000 ? options.pollMs : POLL_MS;
    api.slots.register({
      order: 300,
      slots: {
        sidebar_content(_ctx, props) {
          return (
            <SidebarSessions
              api={api}
              session_id={props.session_id}
              spinner={spinnerFrames}
              waiting={waitingFrames}
              marker={markerGlyphName}
              pollMs={pollMs}
              openElsewhere={openElsewhere}
              combined={combined}
            />
          );
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
