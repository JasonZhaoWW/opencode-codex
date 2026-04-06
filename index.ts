import type { PluginModule } from "@opencode-ai/plugin"
import { CodexMultiAuthPlugin } from "./src/plugin.js"

export { CodexMultiAuthPlugin }

const mod: PluginModule = {
  id: "opencode-codex",
  server: CodexMultiAuthPlugin,
}

export default mod
