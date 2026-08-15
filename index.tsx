/// <reference path="./bun-sqlite.d.ts" />
/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup, For, Show } from "solid-js";
import type { TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import type { BoxRenderable } from "@opentui/core";
import type { SessionStatus } from "@opencode-ai/sdk";
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, appendFileSync, realpathSync, statSync, watch as fsWatch, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  hex: {
    marker: "󰋘",
    waiting: ["󰋘", "󰋙"],
    spinner: ["󰫃", "󰫄", "󰫅", "󰫆", "󰫇", "󰫈", "󰫇", "󰫆", "󰫅", "󰫄"],
    combined: true,
  },
  moon: {
    marker: "",
    waiting: ["", ""],
    spinner: [
      "", "", "", "", "", "", "", "", "", "", "", "", "", "",
      "", "", "", "", "", "", "", "", "", "", "", "", "", "",
    ],
    combined: true,
  },
  pie: {
    marker: "󰪥",
    waiting: ["󰪞", "󰪥"],
    spinner: ["󰪞", "󰪟", "󰪠", "󰪡", "󰪢", "󰪣", "󰪤", "󰪥", "󰪤", "󰪣", "󰪢", "󰪡", "󰪠", "󰪟"],
    combined: true,
  },
};
const WAIT_MS = 450;
// Anything updated in the last 15 minutes is Active.
const ACTIVE_MS = 15 * 60 * 1000;
// How long a completed subagent row stays visible after going idle (freshness
// window for children; tunable via childTtlMs).
const CHILD_TTL_MS = 10 * 1000;
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

// A subagent (child) session: tracked for status but not a list row in
// "collapsed" mode. Kids have no directory/time display — only a title.
// `created` distinguishes retry duplicates (the fallback retry is always
// created after the failed attempt); `updated` is unreliable for that because
// the failure event bumps it after the retry already exists.
type SidebarChild = {
  id: string;
  parentID: string;
  title: string;
  created: number;
  updated: number;
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

// All subagent (child) sessions — children of the rows above, plus deeper
// generations (a subagent's own subagents), so status can fold up the tree.
function dbChildren(): SidebarChild[] {
  const rows = getDb()
    .query(
      `SELECT id, parent_id, title, time_created, time_updated FROM session
       WHERE parent_id IS NOT NULL AND time_archived IS NULL`,
    )
    .all() as {
    id: string;
    parent_id: string;
    title: string | null;
    time_created: number;
    time_updated: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    parentID: r.parent_id,
    title: r.title ?? "",
    created: r.time_created,
    updated: r.time_updated,
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

// Title for a forked session. The first fork keeps the session's name; the
// second fork and later get a numbered suffix ("name (fork 2)", "name (fork 3)")
// so the picker can tell them apart. The number counts every session in the
// family (the original plus any earlier forks, suffixed or not).
export function forkTitle(base: string, sessions: SidebarSession[]): string {
  const family = sessions.filter(
    (s) => sessionTitle(s) === base || sessionTitle(s).startsWith(`${base} (fork `),
  );
  const ordinal = family.length;
  return ordinal === 1 ? base : `${base} (fork ${ordinal})`;
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

// Stable ordering for the Active section: by displayed name, so a session
// updating doesn't reshuffle the list. Ties (same name) fall back to id.
export function bySessionTitle(a: SidebarSession, b: SidebarSession): number {
  return (
    sessionTitle(a).localeCompare(sessionTitle(b), undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id)
  );
}

// True when a session belongs in the sidebar's Active section: the focused
// session always, anything busy/waiting, or updated within the freshness
// window. Shared by the sidebar split and ctrl+x j/k navigation so both walk
// the same ordering.
export function isActiveSession(
  s: SidebarSession,
  statuses: Map<string, SessionStatus>,
  waitingIds: Set<string>,
  currentID: string | undefined,
  now = Date.now(),
): boolean {
  if (s.id === currentID) return true;
  const st = statuses.get(s.id);
  return isBusy(st) || waitingIds.has(s.id) || s.time.updated >= now - ACTIVE_MS;
}

// The sidebar's full display order: Active sessions sorted by name, then
// Recent sessions in recency order. ctrl+x j/k navigate this same sequence so
// the highlight follows what's on screen.
export function sidebarOrder(
  sessions: SidebarSession[],
  statuses: Map<string, SessionStatus>,
  waitingIds: Set<string>,
  currentID: string | undefined,
  now = Date.now(),
): SidebarSession[] {
  const active = sessions.filter((s) => isActiveSession(s, statuses, waitingIds, currentID, now)).sort(bySessionTitle);
  const activeIds = new Set(active.map((s) => s.id));
  const recentIds = new Set(recentSessions(sessions, now).map((s) => s.id));
  const recent = sessions.filter((s) => !activeIds.has(s.id) && recentIds.has(s.id));
  return [...active, ...recent];
}

export function isBusy(status: SessionStatus | undefined): boolean {
  return status?.type === "busy" || status?.type === "retry";
}

// A session is shown busy while any of its subagent descendants is busy: the
// parent's own status flips to idle the moment its message finishes, even
// though a spawned subagent is still running. Children aren't list rows (in
// "collapsed" mode), so busy must fold up through the parent links.
export function foldChildBusy(
  statuses: Map<string, SessionStatus>,
  children: SidebarChild[],
): Map<string, SessionStatus> {
  const folded = new Map(statuses);
  const byParent = new Map<string, string[]>();
  for (const c of children) {
    const list = byParent.get(c.parentID);
    if (list) list.push(c.id);
    else byParent.set(c.parentID, [c.id]);
  }
  const isBusyId = (id: string) => isBusy(folded.get(id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [parentId, kidIds] of byParent) {
      if (!isBusyId(parentId) && kidIds.some(isBusyId)) {
        folded.set(parentId, { type: "busy" });
        changed = true;
      }
    }
  }
  return folded;
}

type RowTheme = Pick<TuiThemeCurrent, "text" | "textMuted" | "accent" | "info" | "primary" | "success">;

// Foreground color for a sidebar row's title. The focused session is always
// the primary (orange) color, whatever its state — busy/asking colors are for
// other sessions only. Otherwise: asking → accent, working → info, idle rows
// in the Active section → success (green), everything else (Recent) → text.
export function rowForeground<T>(
  s: { waiting: boolean; working: boolean; isCurrent: boolean; inActive: boolean },
  theme: { primary: T; accent: T; info: T; success: T; text: T; textMuted: T },
): T {
  if (s.isCurrent) return theme.primary;
  if (s.waiting) return theme.accent;
  if (s.working) return theme.info;
  // Idle sessions are green while in the Active section; Recent rows use the
  // default text color. Status presence does not matter — the statuses map
  // covers every session in a running instance, so it can't distinguish
  // Active from Recent.
  return s.inActive ? theme.success : theme.text;
}

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
    rowForeground(
      {
        waiting: props.waiting(),
        working: props.working(),
        isCurrent: props.isCurrent,
        inActive: props.inActive,
      },
      props.theme,
    );
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
            <Show when={!props.isCurrent && props.waiting() && props.waitingFrames.length > 0}>
              <spinner frames={props.waitingFrames} interval={WAIT_MS} color={props.theme.accent} />
            </Show>
            <Show when={!props.isCurrent && props.working() && props.spinnerFrames.length > 0}>
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

// A subagent row in "tree" mode: indented under its parent, status spinner in
// its own cell, muted title, no time/directory. Clicking navigates to the
// subagent session.
export function ChildRow(props: {
  child: SidebarChild;
  waitingFrames: string[];
  spinnerFrames: string[];
  waiting: () => boolean;
  working: () => boolean;
  theme: RowTheme;
  onNavigate: () => void;
}) {
  return (
    <box paddingLeft={2} paddingRight={1} onMouseDown={(_e) => props.onNavigate()}>
      <box flexDirection="row">
        <box width={1}>
          {props.waiting() && props.waitingFrames.length > 0 ? (
            <spinner frames={props.waitingFrames} interval={WAIT_MS} color={props.theme.accent} />
          ) : null}
          {!props.waiting() && props.working() && props.spinnerFrames.length > 0 ? (
            <spinner frames={props.spinnerFrames} interval={SPINNER_MS} color={props.theme.info} />
          ) : null}
        </box>
        <text fg={props.theme.textMuted} wrapMode="none">
          {" "}
          {props.child.title}
        </text>
      </box>
    </box>
  );
}

// A child row is shown while it's busy, waiting, or was active recently;
// completed subagents that have been idle past the freshness window are
// hidden — opencode never archives them, so the tree would fill up with
// finished children otherwise. Status folding (foldChildBusy) still covers
// hidden children. ttlMs is the freshness window (defaults to the parent-row
// window; the sidebar passes the user-tunable childTtlMs).
export function isChildVisible(
  c: SidebarChild,
  statuses: Map<string, SessionStatus>,
  waitingIds: Set<string>,
  now: number,
  ttlMs: number = ACTIVE_MS,
): boolean {
  return (
    waitingIds.has(c.id) ||
    isBusy(statuses.get(c.id)) ||
    c.updated >= now - ttlMs
  );
}

// Model-retry dedupe: when opencode retries a failed model call it spawns a
// new session with the same title and parent, leaving the failed attempt
// (e.g. an exhausted model) as a duplicate. The failed attempt can keep a
// retry status (still "busy") for a while, so status can't distinguish it —
// but the fallback retry is always created AFTER the failure. Within a
// (parent, title) group, every member but the newest-created one is hidden.
export function dedupeHiddenIds(children: SidebarChild[]): Set<string> {
  const hidden = new Set<string>();
  const groups = new Map<string, SidebarChild[]>();
  for (const c of children) {
    const key = `${c.parentID}\u0000${c.title}`;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    let newest = list[0];
    for (const c of list) {
      if (c.created > newest.created || (c.created === newest.created && c.id > newest.id)) {
        newest = c;
      }
    }
    for (const c of list) {
      if (c !== newest) hidden.add(c.id);
    }
  }
  return hidden;
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
  subagents: "collapsed" | "tree";
  childTtl: number;
}) {
  const theme = props.api.theme.current;
  const [sessions, setSessions] = createSignal<SidebarSession[]>([]);
  // Subagent sessions: hidden rows in "collapsed" mode (still folded into
  // parent status), shown as indented rows in "tree" mode.
  let children: SidebarChild[] = [];
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [statuses, setStatuses] = createSignal<Map<string, SessionStatus>>(new Map());
  const [waitingIds, setWaitingIds] = createSignal<Set<string>>(new Set());
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());

  const sessionIds = () => [...sessions().map((s) => s.id), ...children.map((c) => c.id)];

  async function refresh() {
    try {
      setSessions(dbSessions());
      children = dbChildren();
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
    for (const id of sessionIds()) {
      const st = props.api.state.session.status(id);
      if (st) m.set(id, st);
    }
    return m;
  }

  function localWaitingIds(): string[] {
    return sessionIds()
      .filter(
        (id) =>
          props.api.state.session.question(id).length > 0 ||
          props.api.state.session.permission(id).length > 0,
      );
  }

  function commitStatuses() {
    const local = foldChildBusy(localStatusesFromState(), children);
    const localWaiting = localWaitingIds();
    writeOwnStatuses(local, localWaiting);
    const remotes = readCrossInstance(props.pollMs * 3);
    const merged = foldChildBusy(mergeBusy(local, remotes), children);
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
      setStatuses(foldChildBusy(mergeBusy(localStatusesFromState(), remotes), children));
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

  // Display order: Active (name-sorted) then Recent (recency) — the same
  // sequence ctrl+x j/k navigates, so the highlight follows the sidebar.
  const ordered = createMemo(() =>
    sidebarOrder(sessions(), statuses(), waitingIds(), props.session_id),
  );
  const active = createMemo(() =>
    ordered().filter((s) => isActiveSession(s, statuses(), waitingIds(), props.session_id)),
  );
  const activeIds = createMemo(() => new Set(active().map((s) => s.id)));

  const recent = createMemo(() => ordered().filter((s) => !activeIds().has(s.id)));

  // Recomputed on refresh changes (children is refilled in refresh() alongside
  // setSessions, so depending on sessions is enough).
  const hiddenDupes = createMemo(() => dedupeHiddenIds(children));

  const renderKids = (s: SidebarSession) =>
    props.subagents === "tree" ? (
      <For
        each={children.filter(
          (c) =>
            c.parentID === s.id &&
            !hiddenDupes().has(c.id) &&
            isChildVisible(c, statuses(), waitingIds(), Date.now(), props.childTtl),
        )}
      >
        {(c) => (
          <ChildRow
            child={c}
            waitingFrames={props.waiting}
            spinnerFrames={props.spinner}
            waiting={() => waitingIds().has(c.id)}
            working={() => !waitingIds().has(c.id) && isBusy(statuses().get(c.id))}
            theme={theme}
            onNavigate={() => props.api.route.navigate("session", { sessionID: c.id })}
          />
        )}
      </For>
    ) : null;

  const renderRow = (s: SidebarSession, inActive: boolean) => (
    <>
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
      {renderKids(s)}
    </>
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
  const sessions = dbSessions();
  if (sessions.length === 0) return;
  const currentID = currentSessionID(api);
  // Same ordering the sidebar shows (Active name-sorted, then Recent), so
  // ctrl+x j/k follow what's on screen instead of raw recency.
  const statuses = new Map<string, SessionStatus>();
  const waitingIds = new Set<string>();
  for (const s of sessions) {
    const st = api.state.session.status(s.id);
    if (st) statuses.set(s.id, st);
    if (
      api.state.session.question(s.id).length > 0 ||
      api.state.session.permission(s.id).length > 0
    ) {
      waitingIds.add(s.id);
    }
  }
  const order = sidebarOrder(sessions, statuses, waitingIds, currentID);
  const idx = order.findIndex((s) => s.id === currentID);
  const next = order[((idx === -1 ? 0 : idx) + delta + order.length) % order.length];
  if (next) api.route.navigate("session", { sessionID: next.id });
}

// Normalize a user-typed path: expand a leading ~ to the home directory and
// resolve to an absolute path. Exported for testing.
export function expandPath(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (t === "~") return homedir();
  if (t.startsWith("~/")) return resolve(join(homedir(), t.slice(1)));
  return resolve(t);
}

type DirResult = { ok: true } | { ok: false; reason: "db" | "schema" };

let dbw: Database | undefined;
function getWriteDb(): Database | undefined {
  if (dbw) return dbw;
  try {
    dbw = new Database(DB_PATH, { readwrite: true });
    dbw.exec("PRAGMA busy_timeout = 10000");
    return dbw;
  } catch {
    return undefined;
  }
}

// Point an existing session's row at a new working directory. The server's
// fork API copies the conversation but has no way to set the fork's directory
// (fork/update/import all ignore it), so the directory is written straight
// into opencode.db — a single row update, which the server re-reads per
// request. Guarded against a missing `directory` column (schema drift).
export function setSessionDirectory(sessionId: string, directory: string, db?: Database): DirResult {
  const d = db ?? getWriteDb();
  if (!d) return { ok: false, reason: "db" };
  try {
    const cols = d.query("PRAGMA table_info(session)").all() as unknown[];
    if (!cols.some((c) => (c as { name: string }).name === "directory")) {
      return { ok: false, reason: "schema" };
    }
    d.query("UPDATE session SET directory = ? WHERE id = ?").run(directory, sessionId);
    return { ok: true };
  } catch {
    return { ok: false, reason: "db" };
  }
}

// Leader-chord global action (ctrl+x w): prompt for a new working directory and
// move the current session into it (see moveSessionDialog). No active session
// falls back to the dialog id-less guard.
function changeDirectory(api: TuiPluginApi): void {
  const id = currentSessionID(api);
  if (!id) {
    api.ui.toast({ variant: "warning", message: "No active session" });
    return;
  }
  moveSessionDialog(api, id);
}

// Move a session into a chosen directory: fork it through the server API (which
// copies the full conversation), retarget the new row's directory in the DB,
// restore the original title, delete the original, and land in the moved
// session. A custom dialog (like the picker) so Tab can shell-complete paths;
// enter confirms, esc cancels. Shared by the ctrl+x w command (current session)
// and the picker's move action (highlighted session).
function moveSessionDialog(api: TuiPluginApi, id: string): void {
  const theme = api.theme.current;
  const me = dbSessions().find((s) => s.id === id);
  const [path, setPath] = createSignal(me?.directory ?? "");
  const [candidates, setCandidates] = createSignal<string[]>([]);
  let unregisterLayer: (() => void) | undefined;
  const unregister = () => {
    unregisterLayer?.();
    unregisterLayer = undefined;
  };
  const close = () => {
    unregister();
    api.ui.dialog.clear();
  };
  const complete = () => {
    const c = completePath(path());
    setPath(c.value);
    setCandidates(c.candidates);
  };
  const confirm = () => {
    const dir = expandPath(path());
    if (!dir) return;
    void (async () => {
      try {
        if (!statSync(dir).isDirectory()) {
          api.ui.toast({ variant: "error", message: "Not a directory" });
          return;
        }
        // Canonicalize symlinks (e.g. /tmp → /private/tmp on macOS) so the stored
        // directory matches opencode's own realpath form; a symlink path like
        // "/tmp" doesn't match the server's project dir and the switch silently
        // fails to land.
        const canonical = realpathSync(dir);
        const base = me ? sessionTitle(me) : "Session";
        const forked = await api.client.session.fork({ sessionID: id });
        if (!forked.data) {
          api.ui.toast({ variant: "error", message: "Move failed" });
          return;
        }
        const moved = setSessionDirectory(forked.data.id, canonical);
        if (!moved.ok) {
          // Undo the fork so the failed move leaves no stray session behind.
          void api.client.session.delete({ sessionID: forked.data.id });
          api.ui.toast({
            variant: "error",
            message: moved.reason === "schema" ? "Move failed: unsupported database" : "Move failed",
          });
          return;
        }
        await api.client.session.update({ sessionID: forked.data.id, title: base });
        await api.client.session.delete({ sessionID: id });
        close();
        api.ui.toast({ variant: "info", message: `Moved to ${shortDir(canonical)}` });
        api.route.navigate("session", { sessionID: forked.data.id });
      } catch {
        api.ui.toast({ variant: "error", message: "Move failed" });
      }
    })();
  };
  const hint = (key: string, label: string) => (
    <box flexDirection="row">
      <text fg={theme.accent}><b>{key}</b></text>
      <box width={1} />
      <text fg={theme.textMuted}>{label}</text>
      <box width={3} />
    </box>
  );
  unregister();
  api.ui.dialog.setSize("medium");
  api.ui.dialog.replace(
    () => (
      <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <text fg={theme.text}><b>Move session to directory</b></text>
        <box height={1} />
        <input
          value={path()}
          onInput={(v) => {
            setPath(v);
            setCandidates([]);
          }}
          placeholder="/absolute/path"
          focused
        />
        <Show when={candidates().length > 0}>
          <box flexDirection="column" paddingTop={1}>
            <For each={candidates().slice(0, 8)}>
              {(c) => <text fg={theme.textMuted} wrapMode="none">{c}</text>}
            </For>
          </box>
        </Show>
        <box flexDirection="row" paddingTop={1}>
          {hint("tab", "complete")}
          {hint("enter", "confirm")}
          {hint("esc", "cancel")}
        </box>
      </box>
    ),
    unregister,
  );
  unregisterLayer = api.keymap.registerLayer({
    commands: [
      { name: "session_surf.chdir.complete", title: "Complete path", run: complete },
      { name: "session_surf.chdir.confirm", title: "Confirm directory", run: confirm },
      { name: "session_surf.chdir.close", title: "Cancel", run: close },
    ],
    bindings: [
      { key: "tab", cmd: "session_surf.chdir.complete", desc: "Complete" },
      { key: "enter", cmd: "session_surf.chdir.confirm", desc: "Confirm" },
      { key: "esc", cmd: "session_surf.chdir.close", desc: "Cancel" },
    ],
  });
}

// Shell-style tab completion for a path fragment: expand a leading ~, list the
// directory containing the last segment, and return the longest common prefix
// of the matches (a trailing / marks a directory) plus the full match list for
// display. Returns the input unchanged when nothing matches. Exported for
// testing.
export function completePath(input: string): { value: string; candidates: string[] } {
  const t = input.trim();
  if (!t) return { value: "", candidates: [] };
  const expanded = t === "~" ? homedir() : t.startsWith("~/") ? join(homedir(), t.slice(1)) : t;
  const slash = expanded.lastIndexOf("/");
  const base = slash <= 0 ? (expanded.startsWith("/") ? "/" : "") : expanded.slice(0, slash + 1);
  const partial = slash <= 0 && !expanded.startsWith("/") ? expanded : expanded.slice(slash + 1);
  let entries: string[];
  try {
    entries = readdirSync(base || ".");
  } catch {
    return { value: input, candidates: [] };
  }
  const matches = entries.filter((e) => e.startsWith(partial)).sort();
  if (matches.length === 0) return { value: input, candidates: [] };
  const withSlash = (m: string) => {
    try {
      return base + m + (statSync((base || ".") + "/" + m).isDirectory() ? "/" : "");
    } catch {
      return base + m;
    }
  };
  if (matches.length === 1) {
    const value = withSlash(matches[0]);
    return { value, candidates: [value] };
  }
  let prefix = matches[0];
  for (let i = 1; i < matches.length; i++) {
    let j = 0;
    while (j < prefix.length && prefix[j] === matches[i][j]) j++;
    prefix = prefix.slice(0, j);
  }
  return { value: base + prefix, candidates: matches.map(withSlash) };
}

// Split a keybind for the picker hint bar: when the key's letter (the char
// after the last "+") starts the label, return the label remainder so the hint
// can render key + remainder merged ("ctrl+n" + "ew" → "ctrl+new"); null means
// the spaced form (key, gap, label) is used. Only a leading match merges, so
// multi-word labels like "switch workdir" stay spaced ("ctrl+w switch workdir").
// Exported for testing.
export function splitKeybind(key: string, label: string): { key: string; suffix: string | null } {
  if (!key.includes("+")) return { key, suffix: null };
  const letter = key[key.length - 1];
  if (label[0] !== letter) return { key, suffix: null };
  return { key, suffix: label.slice(1) };
}

// Scroll offset (in rows) that keeps the selected row centered: it stays put
// while in the top or bottom half of the window, otherwise the window scrolls
// one row per move so the selection sits mid-window. Mirrors the host command
// palette. Exported for testing.
export function centerScrollTop(index: number, visible: number, total: number): number {
  const half = Math.floor(visible / 2);
  return Math.max(0, Math.min(index - half, Math.max(0, total - visible)));
}

// Truncate to `max` columns, adding an ellipsis when it doesn't fit. Exported
// for testing. Char-length based (session titles/dirs are effectively ASCII).
export function trimEllipsis(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  return text.slice(0, max - 1) + "…";
}

// Move the selection by `delta`, wrapping around both ends (down past the last
// item lands on the first, up past the first lands on the last). Exported for
// testing.
export function wrapIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return (((current + delta) % total) + total) % total;
}

// Optimistic rename: return the list with `id`'s title replaced, so the picker
// reflects the new name instantly without waiting for the DB round-trip.
// Exported for testing.
export function applyRename(sessions: SidebarSession[], id: string, title: string): SidebarSession[] {
  return sessions.map((s) => (s.id === id ? { ...s, title } : s));
}

type PickerDensity = "compact" | "comfortable";

type PickerTheme = Pick<
  TuiThemeCurrent,
  "text" | "textMuted" | "info" | "primary" | "success" | "error" | "selectedListItemText"
>;

// The session list inside the picker. Renders only the visible window of rows,
// positioned by centerScrollTop so the selection stays centered (mirrors the
// host command palette). Virtualized rather than a scrolling scrollbox so the
// window is deterministic and doesn't depend on post-layout scroll clamping.
// Two densities: "compact" (one line: name + age + dir) and "comfortable"
// (two lines: name, then age left / dir right). Exported for direct testing.
export function PickerList(props: {
  sessions: () => SidebarSession[];
  index: () => number;
  statuses: Map<string, SessionStatus>;
  height: () => number;
  width: number;
  density: PickerDensity;
  theme: PickerTheme;
  onSelect: (s: SidebarSession) => void;
}) {
  const rowLines = props.density === "comfortable" ? 2 : 1;
  const visible = () => Math.max(1, Math.floor(props.height() / rowLines));
  const window = createMemo(() => {
    const all = props.sessions();
    const top = centerScrollTop(props.index(), visible(), all.length);
    return all.slice(top, top + visible()).map((s, k) => ({ s, i: top + k }));
  });
  // Truncation needs the real inner width. The rows fill their parent
  // (width "100%") so they never overflow the dialog regardless; we measure the
  // laid-out width and use it for the ellipsis math, falling back to the passed
  // estimate until the first layout/resize lands.
  const [measured, setMeasured] = createSignal(0);
  const w = () => (measured() > 0 ? measured() : props.width);
  const attachMeasure = (el: BoxRenderable) => {
    const ev = el as unknown as {
      on(e: string, cb: () => void): void;
      off(e: string, cb: () => void): void;
    };
    // Defer the signal update out of opentui's native "resized" callback:
    // setting a signal synchronously there re-renders mid-layout and can crash
    // the native renderer. queueMicrotask lets the layout pass finish first.
    const update = () => {
      const width = el.width;
      queueMicrotask(() => setMeasured((prev) => (prev === width ? prev : width)));
    };
    update();
    ev.on("resized", update);
    onCleanup(() => ev.off("resized", update));
  };
  const rowColor = (s: SidebarSession) => {
    const st = props.statuses.get(s.id);
    return st === undefined
      ? props.theme.text
      : isBusy(st)
        ? props.theme.info
        : st.type === "idle"
          ? props.theme.success
          : props.theme.error;
  };
  return (
    <box ref={attachMeasure} flexDirection="column" width="100%" height={props.height()}>
      <For each={window()}>
        {(row) => {
          const sel = row.i === props.index();
          const nameFg = sel ? props.theme.selectedListItemText : rowColor(row.s);
          const metaFg = sel ? props.theme.selectedListItemText : props.theme.textMuted;
          const age = relTime(row.s.time.updated);
          const dir = shortDir(row.s.directory);
          if (props.density === "comfortable") {
            const name = trimEllipsis(sessionTitle(row.s), w());
            const dirText = trimEllipsis(dir, Math.max(0, w() - age.length - 1));
            return (
              <box flexDirection="column" width="100%" height={2} backgroundColor={sel ? props.theme.primary : undefined} onMouseDown={() => props.onSelect(row.s)}>
                <text fg={nameFg} wrapMode="none">{name}</text>
                <box flexDirection="row" width="100%" justifyContent="space-between">
                  <text fg={metaFg} wrapMode="none">{age}</text>
                  <text fg={metaFg} wrapMode="none">{dirText}</text>
                </box>
              </box>
            );
          }
          const right = `${age} ${dir}`;
          const name = trimEllipsis(sessionTitle(row.s), Math.max(0, w() - right.length - 2));
          return (
            <box flexDirection="row" width="100%" justifyContent="space-between" height={1} backgroundColor={sel ? props.theme.primary : undefined} onMouseDown={() => props.onSelect(row.s)}>
              <text fg={nameFg} wrapMode="none">{name}</text>
              <text fg={metaFg} wrapMode="none">{right}</text>
            </box>
          );
        }}
      </For>
    </box>
  );
}

// The host's DialogSelect only substring-matches option titles, so the picker
// is a custom dialog instead: a fuzzy-filtered session list with a search
// input, plus a temporary keymap layer whose bindings (configurable through
// tui.json's "keybinds" map, defaulting to ctrl+r/d/f, enter, esc, arrows) run
// the session actions shown in the hint bar at the bottom. Bare keystrokes
// fall through the layer to the search input, so typing filters the list at
// all times.
function openPicker(api: TuiPluginApi, density: PickerDensity = "comfortable"): void {
  const theme = api.theme.current;
  const [query, setQuery] = createSignal("");
  const [sessions, setSessions] = createSignal<SidebarSession[]>(dbSessions());
  const filtered = createMemo(() => fuzzyRank(query(), sessions()));
  // Open with the current session highlighted; falls back to the top when it
  // isn't in the list (e.g. no active session).
  const [index, setIndex] = createSignal((() => {
    const id = currentSessionID(api);
    if (!id) return 0;
    const i = filtered().findIndex((s) => s.id === id);
    return i >= 0 ? i : 0;
  })());
  const selected = () => filtered()[Math.min(index(), filtered().length - 1)];
  // Starting a search (empty → non-empty query) jumps the highlight to the top
  // of the results; afterwards only up/down move it. Clearing or changing the
  // query never re-anchors to the current session.
  let searchStarted = false;
  createEffect(() => {
    if (query() !== "") {
      if (!searchStarted) setIndex(0);
      searchStarted = true;
    } else {
      searchStarted = false;
    }
  });
  let unregisterLayer: (() => void) | undefined;
  const unregister = () => {
    unregisterLayer?.();
    unregisterLayer = undefined;
  };
  // Full dismissal (esc / switch). The host's dialog.replace() fires the prior
  // entry's onClose on every swap, so the picker registers `unregister` (not
  // `close`) as its onClose — otherwise opening the rename/delete dialog would
  // trip a full close mid-transition and wedge the dialog stack.
  const close = () => {
    unregister();
    api.ui.dialog.clear();
  };
  const switchTo = (s: SidebarSession) => {
    close();
    api.route.navigate("session", { sessionID: s.id });
  };
  // Re-open the picker (used after rename/delete so the window stays open and
  // the list reflects the change). Guards against double-registering the layer.
  const show = () => {
    unregister();
    const layer = {
      commands: [
        { name: "session_surf.picker.switch", title: "Session Manager", run: () => { const s = selected(); if (s) switchTo(s); } },
        { name: "session_surf.picker.rename", title: "Rename session", run: doRename },
        { name: "session_surf.picker.delete", title: "Delete session", run: doDelete },
        { name: "session_surf.picker.fork", title: "Fork session", run: doFork },
        { name: "session_surf.picker.move", title: "Move session", run: doMove },
        { name: "session_surf.picker.new", title: "New session", run: doNew },
        { name: "session_surf.picker.up", title: "Move up", run: () => setIndex((i) => wrapIndex(i, -1, filtered().length)) },
        { name: "session_surf.picker.down", title: "Move down", run: () => setIndex((i) => wrapIndex(i, 1, filtered().length)) },
        { name: "session_surf.picker.close", title: "Close picker", run: close },
      ],
      bindings: [
        { key: "enter", cmd: "session_surf.picker.switch", desc: "Switch" },
        { key: "ctrl+r", cmd: "session_surf.picker.rename", desc: "Rename" },
        { key: "ctrl+d", cmd: "session_surf.picker.delete", desc: "Delete" },
        { key: "ctrl+f", cmd: "session_surf.picker.fork", desc: "Fork" },
        { key: "ctrl+w", cmd: "session_surf.picker.move", desc: "Move" },
        { key: "ctrl+n", cmd: "session_surf.picker.new", desc: "New" },
        { key: "up", cmd: "session_surf.picker.up", desc: "Up" },
        { key: "ctrl+k", cmd: "session_surf.picker.up", desc: "Up" },
        { key: "down", cmd: "session_surf.picker.down", desc: "Down" },
        { key: "ctrl+j", cmd: "session_surf.picker.down", desc: "Down" },
        { key: "esc", cmd: "session_surf.picker.close", desc: "Close" },
        ...api.tuiConfig.keybinds.gather("session_surf", [
          "session_surf.picker.switch",
          "session_surf.picker.rename",
          "session_surf.picker.delete",
          "session_surf.picker.fork",
          "session_surf.picker.move",
          "session_surf.picker.new",
          "session_surf.picker.up",
          "session_surf.picker.down",
          "session_surf.picker.close",
        ]),
      ],
    };
    unregisterLayer = api.keymap.registerLayer(layer);
    const defaultKeys: Record<string, string> = {
      "session_surf.picker.switch": "enter",
      "session_surf.picker.rename": "ctrl+r",
      "session_surf.picker.delete": "ctrl+d",
      "session_surf.picker.fork": "ctrl+f",
      "session_surf.picker.move": "ctrl+w",
      "session_surf.picker.new": "ctrl+n",
      "session_surf.picker.close": "esc",
    };
    const overrides = api.tuiConfig.keybinds.gather("session_surf", [
      "session_surf.picker.switch",
      "session_surf.picker.rename",
      "session_surf.picker.delete",
      "session_surf.picker.fork",
      "session_surf.picker.move",
      "session_surf.picker.new",
      "session_surf.picker.close",
    ]);
    const hintKey = (cmd: string) => {
      const b = overrides.find((x) => x.cmd === cmd);
      return b && typeof b.key === "string" ? b.key : defaultKeys[cmd] ?? cmd;
    };
    const hint = (cmd: string, label: string) => {
      const { suffix } = splitKeybind(hintKey(cmd), label);
      return (
        <box flexDirection="row" flexShrink={0} paddingRight={3}>
          <text fg={theme.accent} wrapMode="none"><b>{hintKey(cmd)}</b></text>
          {suffix === null ? (
            <>
              <box width={1} />
              <text fg={theme.textMuted} wrapMode="none">{label}</text>
            </>
          ) : (
            <text fg={theme.textMuted} wrapMode="none">{suffix}</text>
          )}
        </box>
      );
    };
    // Status per session (local state first, then other instances' broadcasts)
    // so each row is colored by what that session is doing: idle green, busy
    // purple, error orange, unknown white.
    const statuses = new Map<string, SessionStatus>();
    for (const s of sessions()) {
      const local = api.state.session.status(s.id);
      if (local) statuses.set(s.id, local);
    }
    for (const r of readCrossInstance()) {
      for (const [id, st] of Object.entries(r.statuses)) {
        if (!statuses.has(id)) statuses.set(id, st);
      }
    }
    api.ui.dialog.setSize("xlarge");
    const rowLines = density === "comfortable" ? 2 : 1;
    const contentWidth = Math.max(20, Math.min((api.renderer.width || 130) - 10, 114));
    // Hint bar: merged key+label hints ("ctrl+new") when the key letter is in
    // the word, spaced otherwise. flexWrap keeps each hint atomic (flexShrink=0)
    // and spills a whole item to the next row when it doesn't fit.
    const pickerHints = [
      { cmd: "session_surf.picker.rename", label: "rename" },
      { cmd: "session_surf.picker.delete", label: "delete" },
      { cmd: "session_surf.picker.fork", label: "fork" },
      { cmd: "session_surf.picker.new", label: "new" },
      { cmd: "session_surf.picker.move", label: "switch workdir" },
    ];
    const maxListHeight = Math.max(3, Math.min(20, (api.renderer.height > 20 ? api.renderer.height : 30) - 10));
    const listHeight = createMemo(() => Math.min(filtered().length * rowLines, maxListHeight));
    api.ui.dialog.replace(() => (
      <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text}><b>Session Manager</b></text>
          <text fg={theme.textMuted}>esc</text>
        </box>
        <box height={1} />
        <input
          value={query()}
          onInput={setQuery}
          placeholder="Search"
          focused
        />
        <box height={1} />
        <Show when={filtered().length > 0} fallback={<text fg={theme.textMuted}>No sessions match</text>}>
          <PickerList
            sessions={filtered}
            index={index}
            statuses={statuses}
            height={listHeight}
            width={contentWidth}
            density={density}
            theme={theme}
            onSelect={switchTo}
          />
        </Show>
        <box flexDirection="row" flexWrap="wrap" width="100%" paddingTop={1}>
          <For each={pickerHints}>{(h) => hint(h.cmd, h.label)}</For>
        </box>
      </box>
    ), unregister);
  };

  function doRename(): void {
    const s = selected();
    if (!s) return;
    unregister();
    api.ui.dialog.replace(() => (
      <api.ui.DialogPrompt
        title="Rename session"
        value={sessionTitle(s)}
        placeholder="New title"
        onConfirm={(v) => {
          const t = v.trim();
          if (t) {
            // Optimistic: update the in-memory list right away so the reopened
            // picker shows the new title instantly; the server call syncs in the
            // background (the next dbSessions() read reconciles it).
            setSessions((prev) => applyRename(prev, s.id, t));
            void api.client.session.update({ sessionID: s.id, title: t });
          }
          // Reopen after the host finishes closing its own dialog, otherwise
          // our replace() is clobbered by the host's post-confirm close.
          queueMicrotask(show);
        }}
        onCancel={() => queueMicrotask(show)}
      />
    ));
  }

  function doDelete(): void {
    const s = selected();
    if (!s) return;
    unregister();
    api.ui.dialog.replace(() => (
      <api.ui.DialogConfirm
        title="Delete session"
        message={`Delete "${sessionTitle(s)}"? This removes the session and all of its messages.`}
        onConfirm={() => {
          void (async () => {
            await api.client.session.delete({ sessionID: s.id });
            const remaining = dbSessions();
            setSessions(remaining);
            if (currentSessionID(api) === s.id && remaining.length > 0) {
              api.route.navigate("session", { sessionID: remaining[0].id });
            }
          })();
          // Reopen after the host finishes closing its own dialog.
          queueMicrotask(show);
        }}
        onCancel={() => queueMicrotask(show)}
      />
    ));
  }

  function doNew(): void {
    close();
    void (async () => {
      try {
        const created = await api.client.session.create({});
        if (!created.data) {
          api.ui.toast({ variant: "error", message: "Session create failed" });
          return;
        }
        api.route.navigate("session", { sessionID: created.data.id });
      } catch {
        api.ui.toast({ variant: "error", message: "Session create failed" });
      }
    })();
  }

  function doFork(): void {
    const s = selected();
    if (!s) return;
    close();
    void (async () => {
      try {
        const msgs = await api.client.session.messages({ sessionID: s.id, limit: 1 });
        const last = msgs.data?.[0];
        if (!last) {
          api.ui.toast({ variant: "warning", message: "This session has no messages to fork" });
          return;
        }
        const forked = await api.client.session.fork({ sessionID: s.id, messageID: last.info.id });
        if (!forked.data) {
          api.ui.toast({ variant: "error", message: "Fork failed" });
          return;
        }
        await api.client.session.update({
          sessionID: forked.data.id,
          title: forkTitle(sessionTitle(s), dbSessions()),
        });
        api.route.navigate("session", { sessionID: forked.data.id });
      } catch {
        api.ui.toast({ variant: "error", message: "Fork failed" });
      }
    })();
  }

  function doMove(): void {
    const s = selected();
    if (!s) return;
    // unregister (not close): close() clears the whole dialog stack, which drops
    // focus back to the main chat input. moveSessionDialog does its own in-place
    // dialog.replace, so the workdir input keeps focus (mirrors doRename).
    unregister();
    moveSessionDialog(api, s.id);
  }

  show();
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
    // Picker row layout: "compact" (one line) or "comfortable" (two lines).
    const density: PickerDensity = options?.density === "compact" ? "compact" : "comfortable";
    // Subagent display: "collapsed" hides children but folds their busy state
    // into the parent; "tree" (default) also renders an indented row per child
    // with its own status.
    const subagents: "collapsed" | "tree" = options?.subagents === "collapsed" ? "collapsed" : "tree";
    // How long a completed subagent row stays visible after going idle before
    // it is hidden (freshness window); values below 1000 are ignored.
    const childTtl = typeof options?.childTtlMs === "number" && options.childTtlMs >= 1000 ? options.childTtlMs : CHILD_TTL_MS;
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
              subagents={subagents}
              childTtl={childTtl}
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
          title: "Session Manager",
          category: "Session",
          namespace: "palette",
          run() {
            openPicker(api, density);
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
        {
          name: "session_surf.chdir",
          title: "Move session to directory",
          category: "Session",
          namespace: "palette",
          run() {
            changeDirectory(api);
          },
        },
      ],
      bindings: [
        { key: "ctrl+o", cmd: "session_surf.picker.open", desc: "Open session picker" },
        { key: "ctrl+xj", cmd: "session_surf.next", desc: "Next session" },
        { key: "ctrl+xk", cmd: "session_surf.previous", desc: "Previous session" },
        { key: "ctrl+xw", cmd: "session_surf.chdir", desc: "Move to directory" },
        ...api.tuiConfig.keybinds.gather("session_surf", [
          "session_surf.picker.open",
          "session_surf.next",
          "session_surf.previous",
          "session_surf.chdir",
        ]),
      ],
    });
  },
};

export default plugin;
