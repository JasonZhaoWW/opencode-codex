# opencode-codex

Multi-account ChatGPT Codex auth plugin for OpenCode.

> [!IMPORTANT]
> `opencode-codex` is an unofficial community project. It is not built by the OpenCode team and is not affiliated with OpenCode.

`opencode-codex` lets OpenCode treat the built-in `openai` OAuth flow as a Codex subscription path with managed multi-account rotation.

It preserves OpenCode's own `openai` model list and only replaces the auth and request transport used for the Codex account pool.

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

From this menu you can add accounts in three ways:

- `Add account (browser)` starts the normal browser OAuth flow
- `Add account (headless)` starts the device-code flow for remote or browserless environments
- `Import ChatGPT access token` imports an existing ChatGPT OAuth access token directly

To use an access token directly, select `Import ChatGPT access token`, enter an account label, then paste the ChatGPT OAuth access token when prompted. The token must be a valid, unexpired ChatGPT OAuth JWT that includes both the ChatGPT user ID and account or workspace ID used for Codex routing.

Access-token imports are non-refreshable unless the same account was already added through OAuth. When an imported token expires or receives an authorization failure, the plugin disables that account and you need to import a fresh ChatGPT access token. Re-importing a token for the same ChatGPT identity updates the saved token; if that identity already has an OAuth refresh token, the refresh token is preserved.

From the management flow you can:

- Inspect which account is currently active for routing
- See the saved label, plus account email when available
- Review enabled, disabled, and rate-limited state with quota summaries
- Edit an account label
- Enable or disable an account
- Refresh an account's quota snapshot without rotating tokens
- Remove an account with confirmation

The plugin stores the full account pool in `~/.config/opencode/codex-accounts.sqlite` and keeps one sentinel OAuth record under the `openai` provider in opencode's `auth.json` so OpenCode uses its built-in Codex-compatible request path.

The plugin reuses opencode's built-in `openai` provider instead of creating a standalone `codex` provider.

While the plugin is active, `openai` OAuth is treated as the Codex subscription path.

## Requirements

- OpenCode with npm plugin loading enabled
- A Codex-compatible OpenAI account or a valid ChatGPT OAuth access token
- Bun for local development and test runs

## Behavior

- Supports browser OAuth, headless device-code login, and direct ChatGPT OAuth access-token imports
- Sticky account selection
- Switches immediately on `429`
- Tracks per-account Codex usage windows from response headers and `GET /backend-api/wham/usage`
- Respects 5-hour, weekly, and alternate metered-bucket exhaustion during account rotation
- Disables expired or unauthorized access-token-only accounts instead of trying OAuth refresh
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
