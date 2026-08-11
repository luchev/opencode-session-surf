# OpenCode session surf

Session list sidebar plugin for [opencode](https://opencode.ai) TUI. Shows all
sessions from the local opencode database, with live status (busy/waiting)
synced across opencode instances, plus quick session switching.

## Features

- **Sidebar session list** — all sessions, grouped by recency, with project
  directory and relative update time
- **Cross-instance status sync** — each opencode process broadcasts session
  statuses (busy/waiting) to a temp-dir status file; other instances pick them
  up so you can see when a session is active elsewhere
- **Ctrl+O fuzzy picker** — fuzzy-search sessions by title and switch instantly
- **Next/previous session** commands for quick navigation

## Install

From npm (published version):

```json
{
  "plugin": [
    "opencode-session-surf"
  ]
}
```

From the GitHub repo:

```json
{
  "plugin": [
    "https://github.com/luchev/opencode-session-surf"
  ]
}
```

From a local checkout:

```json
{
  "plugin": [
    "file:///path/to/opencode-session-surf/index.tsx"
  ]
}
```

Requires opencode with TUI plugin support and `bun`.

## Configuration

Plugin options are set through the `plugin` array in `tui.json` (tuple form):

```json
{
  "plugin": [
    ["opencode-session-surf", { "spinner": "dots" }]
  ]
}
```

### Options

| Option | Values | Default | Description |
|---|---|---|---|
| `spinner` | `dots`, `arc`, `sweep`, `fill`, `bounce`, `sparkle`, `block`, `battery`, `""` | `dots` | Working spinner style; `""` hides it |
| `waiting` | `emoji`, `ellipsis`, `question`, `pulse`, `block`, `dots`, `eyeblink`, `bell`, `""` | `pulse` | Waiting-for-input indicator; `""` hides it |
| `marker` | `dot`, `square`, `arrow`, `star`, `none`, `caret`, `ping` | `dot` | Active-session marker glyph |
| `pollMs` | number (ms) | `3000` | Sidebar refresh interval; values below 1000 are ignored |
| `openElsewhere` | boolean | `false` | Show a `•` dot on sessions open in another opencode instance |
| `debug` | boolean | `false` | Append diagnostics to `$TMPDIR/opencode-session-surf-status/debug.log` |

With `openElsewhere` enabled, sessions running in another opencode instance show a `•` marker;
the active-session glyph stays visible even while its spinner is running. The sidebar is split into two
sections, each collapsible on click via the `▼`/`▶` toggle:

- **Active** — the session you're in, plus anything busy, waiting, or updated
  in the last 15 minutes. Idle rows in Active are green; no Active session
  renders white.
- **Recent** — the last 24 hours of work, plus the previous block of work
  before it (so a quiet gap, like a weekend, doesn't hide the last real batch
  of sessions). Rows are white, as usual.

Keybinds are configured through `tui.json`'s `keybinds` map, keyed by command
name (custom keybinds are additive to the defaults):

### Keybinds

| Action | Default | Command |
|---|---|---|
| Open session picker | `ctrl+o` | `session_surf.picker.open` |
| Next session | `ctrl+x j` | `session_surf.next` |
| Previous session | `ctrl+x k` | `session_surf.previous` |

```json
{
  "keybinds": {
    "session_surf.next": "ctrl+]",
    "session_surf.previous": "ctrl+["
  }
}
```

Set a command to `"none"` to disable its keybind.

### Rebind the leader key

The leader is opencode's own setting, not this plugin's. Change it in
`tui.json`:

```json
{
  "keybinds": {
    "leader": "ctrl+space"
  }
}
```

## Development

```bash
bun install
bun run dev     # build watch → dist/index.js
bun run build   # one-shot build
bun test        # unit + render tests
```

To test the plugin locally, point tui.json's `plugin` array at the local
checkout and restart opencode.

The plugin reads session data from
`~/.local/share/opencode/opencode.db` (via `bun:sqlite`).

## License

MIT
