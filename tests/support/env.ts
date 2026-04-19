import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function setupTestEnv() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-codex-"))
  const prev = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = dir
  return async () => {
    if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prev
    await rm(dir, { force: true, recursive: true })
  }
}
