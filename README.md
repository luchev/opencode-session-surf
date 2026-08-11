# opencode-session-surf

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

Add to your `~/.config/opencode/tui.json` `plugin` array:

```json
{
  "plugin": [
    "https://github.com/luchev/opencode-session-surf"
  ]
}
```

Requires opencode with TUI plugin support and `bun`.

## Keybinds

| Action | Default | Command |
|---|---|---|
| Open session picker | `ctrl+o` | `session_surf.picker.open` |
| Next session | `ctrl+x j` | `session_surf.next` |
| Previous session | `ctrl+x k` | `session_surf.previous` |

Keybinds are configurable in `tui.json` under `keybinds`, keyed by command
name (custom keybinds are additive to the defaults):

```json
{
  "keybinds": {
    "session_surf.next": "ctrl+]",
    "session_surf.previous": "ctrl+["
  }
}
```

## Development

```bash
bun install
bun run dev
```

The plugin reads session data from
`~/.local/share/opencode/opencode.db` (via `bun:sqlite`).

## License

MIT
