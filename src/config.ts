import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import z from "zod"

const Schema = z.object({
  rateLimitMs: z.number().int().positive().optional(),
})

export type Config = z.infer<typeof Schema>

export async function loadConfig(root: string) {
  const file = join(root, ".opencode", "opencode-codex.json")
  try {
    await access(file)
    const text = await readFile(file, "utf8")
    return Schema.parse(JSON.parse(text))
  } catch {
    return {}
  }
}
