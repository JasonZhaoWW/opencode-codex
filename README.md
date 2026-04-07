# opencode-codex

Multi-account ChatGPT Codex auth plugin for OpenCode.

`opencode-codex` lets OpenCode treat the built-in `openai` OAuth flow as a Codex subscription path with managed multi-account rotation.

## Install

Add the published npm package to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-codex"]
}
```

OpenCode installs npm plugins automatically with Bun at startup.

For local development, place this project in `.opencode/plugins/` or point OpenCode at a local plugin file.

## Login

Run:

```bash
opencode auth login --provider openai
```

Methods exposed by the plugin:

- `Codex`
- `Manually enter API Key`

Selecting `Codex` opens the plugin-managed account screen:

```bash
opencode auth login --provider openai
```

In a normal TTY terminal it opens a navigable account-management menu. In non-TTY environments it falls back to a readline flow.

From the management flow you can:

- Inspect which account is currently active for routing
- See account identity using email when available, plus the saved label
- Review enabled, disabled, and rate-limited state with quota summaries
- Edit an account label
- Enable or disable an account
- Refresh an account's quota snapshot without rotating tokens
- Remove an account with confirmation

The plugin stores the full account pool in `~/.config/opencode/codex-accounts.json` and keeps one sentinel OAuth record under the `openai` provider in opencode's `auth.json` so OpenCode uses its built-in Codex-compatible request path.

The plugin reuses opencode's built-in `openai` provider instead of creating a standalone `codex` provider.

While the plugin is active, `openai` OAuth is treated as the Codex subscription path.

## Requirements

- OpenCode with npm plugin loading enabled
- A Codex-compatible OpenAI account
- Bun for local development and test runs

## Behavior

- Sticky account selection
- Switches immediately on `429`
- Tracks per-account Codex usage windows from response headers and `GET /backend-api/wham/usage`
- Respects 5-hour, weekly, and alternate metered-bucket exhaustion during account rotation
- Fails fast when all accounts are rate-limited

## Config

Optional config file: `.opencode/opencode-codex.json`

```json
{
  "rateLimitMs": 3600000
}
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

The published package ships compiled output from `dist/`.
