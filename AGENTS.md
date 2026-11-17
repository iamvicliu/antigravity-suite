# Development and installation

## Source changes

- Edit renderer code in `src/renderer/`, then run `npm run build:renderer`.
  `meter-renderer.js` is the generated bundle; include it with renderer changes.
- Run `npm run test:suite` after source changes. Tests use isolated temporary directories for settings and usage data.
- Keep local transcripts, installation manifests, backups and capture output outside the repository.
- The runtime uses Node.js built-ins and the bundled ASAR engine. No `npm install` is needed.

## Zero-Patch Installation & Runtime Control

Use Node.js 22.4 or later. Python is optional for attachment analysis.
This suite uses **100% zero-patch CDP hot-injection** on macOS and never modifies `app.asar`, Apple code signatures, or application binaries during normal installation/usage.

```sh
./scripts/setup-macos-cdp.sh          # or --no-auto to skip LaunchAgent
ag-context-meter live                 # hot-inject into running Antigravity (use --no-remote to disable mobile server)
ag-context-meter status               # verify live components and intact official signature
```

- `node cli.js live` (default command of `cli.js`, optional `--no-remote` or `AG_DISABLE_MOBILE_REMOTE=1`): inject into the running window without touching `app.asar`.
- `ag-context-meter stop` / `ag-context-meter auto-off`: cleanly dispose injected UI and stop background bridge.
- Note: Legacy `install` / `unlock` / `restore` commands in `cli.js` are gated off in normal runs to preserve client integrity (`--allow-asar-patch` / test mode only).

Keep Antigravity running when using CDP hot injection. Do not terminate the host from an agent session inside Antigravity.

## UI translation

Translate visible text in `src/renderer/template.html` and the renderer JavaScript
modules. Keep DOM IDs, selectors, event handlers and data structures intact.
Build the renderer and run tests before reloading via `ag-context-meter live`.
