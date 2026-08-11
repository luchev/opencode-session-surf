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

The plugin takes no options; everything is configured through `tui.json`
keybinds, keyed by command name (custom keybinds are additive to the
defaults):

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
```

To test the plugin locally, point tui.json's `plugin` array at the local
checkout and restart opencode.

The plugin reads session data from
`~/.local/share/opencode/opencode.db` (via `bun:sqlite`).

## License

MIT
