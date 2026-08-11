# Contributing

## Publishing a new version

The plugin is published to npm as `opencode-session-surf`.

### Prerequisites

- Node/npm with credentials for the npm account that owns the package
  (`npm whoami` should not error)
- `bun` for building

### Steps

```bash
# 1. Make sure you're on main with everything committed and pushed
git checkout main
git pull
git status            # should be clean

# 2. Run the build to make sure it compiles
bun run build         # → dist/index.js (gitignored, not committed)

# 3. Bump the version (patch = bugfix, minor = feature, major = breaking)
npm version patch     # also creates a git tag, e.g. v0.1.2

# 4. Publish (prepublishOnly runs `bun run build` automatically)
npm publish

# 5. Push the version bump commit and tag
git push origin main
git push origin main --tags

# 6. Verify
npm view opencode-session-surf version   # should show the new version
```

### What gets published

`files: ["dist"]` — only `dist/` is published. The entrypoint is
`exports["./tui"]` → `dist/index.js`, which is what the opencode TUI plugin
loader resolves. Do **not** add a `main` field or a server-style `exports["."]`:
TUI plugins fail to load if the package is detected as a server plugin (the TUI
loader only honors `exports["./tui"]`; `main` does not fall back for TUI).

### Version bump conventions

| Change | Command |
|---|---|
| Bugfix / small change | `npm version patch` |
| New feature (backwards compatible) | `npm version minor` |
| Breaking change | `npm version major` |

### Testing before publishing

Test against a live opencode instance using a local checkout first:

```json
{
  "plugin": ["file:///Users/z/opencode-session-surf/index.tsx"]
}
```

Restart opencode and confirm the sidebar renders. Only then publish.
