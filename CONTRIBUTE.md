# Contributing

## Publishing a new version

The plugin is published to npm as `opencode-session-surf`.

### Prerequisites

- Node/npm with credentials for the npm account that owns the package
  (`npm whoami` should not error)
- `bun` for tests

### Steps

```bash
# 1. Make sure you're on main with everything committed and pushed
git checkout main
git pull
git status            # should be clean

# 2. Make sure it type-checks and the tests pass
bun run typecheck
bun run test

# 3. Bump the version (patch = bugfix, minor = feature, major = breaking)
npm version patch     # also creates a git tag, e.g. v0.1.2

# 4. Publish
npm publish

# 5. Push the version bump commit and tag
git push origin main
git push origin main --tags

# 6. Verify
npm view opencode-session-surf version   # should show the new version
```

### What gets published

`files: ["tui.tsx", "README.md", "LICENSE"]`. The entrypoint is
`exports["./tui"]` -> `./tui.tsx`, which the OpenCode TUI plugin loader resolves.
There is no build step and no `dist/`. Do **not** add a `main` field or a
server-style `exports["."]`: the package must be detected as TUI-only.

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
  "plugins": [{ "package": "file:///path/to/opencode-session-surf" }]
}
```

Add it to `cli.json`, open `/plugins` to confirm it loaded, and check that the
sidebar renders. Only then publish.
