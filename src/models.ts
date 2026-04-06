type Mode = "text" | "image" | "audio" | "video" | "pdf"
type Effort = "none" | "low" | "medium" | "high" | "xhigh"

type Variant = {
  disabled?: boolean
  include?: string[]
  reasoningEffort?: Effort
  reasoningSummary?: "auto"
}

type Meta = {
  family: string
  limit: {
    context: number
    input?: number
    output: number
  }
  modalities: {
    input: Mode[]
    output: Mode[]
  }
  name: string
  variants: Record<string, Variant>
}

type Model = {
  attachment: boolean
  cost: {
    cache_read: number
    cache_write: number
    input: number
    output: number
  }
  family: string
  id: string
  limit: Meta["limit"]
  modalities: Meta["modalities"]
  name: string
  options: Record<string, never>
  provider: {
    api: string
    npm: string
  }
  release_date?: string
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  variants: Record<string, Variant>
}

function effort(reasoningEffort: Effort): Variant {
  return {
    include: ["reasoning.encrypted_content"],
    reasoningEffort,
    reasoningSummary: "auto",
  }
}

function variants(...list: Effort[]) {
  return Object.fromEntries(list.map((item) => [item, effort(item)]))
}

function date(id: string) {
  if (id === "gpt-5.2") return "2025-12-11"
  if (id === "gpt-5.4") return "2026-03-05"
  if (id === "gpt-5.4-mini") return "2026-03-17"
}

export const CODEX_MODEL_TABLE = {
  "gpt-5.1-codex-max": {
    family: "gpt-codex",
    limit: { context: 400000, input: 272000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    name: "GPT-5.1 Codex Max",
    variants: {
      ...variants("low", "medium", "high", "xhigh"),
    },
  },
  "gpt-5.1-codex-mini": {
    family: "gpt-codex",
    limit: { context: 400000, input: 272000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    name: "GPT-5.1 Codex mini",
    variants: {
      ...variants("medium", "high"),
      low: { disabled: true },
    },
  },
  "gpt-5.2": {
    family: "gpt",
    limit: { context: 400000, input: 272000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    name: "GPT-5.2",
    variants: {
      ...variants("none", "low", "medium", "high", "xhigh"),
    },
  },
  "gpt-5.2-codex": {
    family: "gpt-codex",
    limit: { context: 400000, input: 272000, output: 128000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    name: "GPT-5.2 Codex",
    variants: {
      ...variants("low", "medium", "high", "xhigh"),
    },
  },
  "gpt-5.3-codex": {
    family: "gpt-codex",
    limit: { context: 400000, input: 272000, output: 128000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    name: "GPT-5.3 Codex",
    variants: {
      ...variants("low", "medium", "high", "xhigh"),
    },
  },
  "gpt-5.4": {
    family: "gpt",
    limit: { context: 1050000, input: 922000, output: 128000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    name: "GPT-5.4",
    variants: {
      ...variants("none", "low", "medium", "high", "xhigh"),
    },
  },
  "gpt-5.4-mini": {
    family: "gpt-mini",
    limit: { context: 400000, input: 272000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    name: "GPT-5.4 mini",
    variants: {
      ...variants("none", "low", "medium", "high", "xhigh"),
    },
  },
} satisfies Record<string, Meta>

export const CODEX_MODELS = new Set(Object.keys(CODEX_MODEL_TABLE))

export function buildCodexModels(): Record<string, Model> {
  return Object.fromEntries(
    Object.entries(CODEX_MODEL_TABLE).map(([id, model]) => [
      id,
      {
        attachment: true,
        cost: {
          cache_read: 0,
          cache_write: 0,
          input: 0,
          output: 0,
        },
        family: model.family,
        id,
        limit: model.limit,
        modalities: model.modalities,
        name: model.name,
        options: {},
        provider: {
          api: "https://api.openai.com/v1",
          npm: "@ai-sdk/openai",
        },
        ...(date(id) ? { release_date: date(id) } : {}),
        reasoning: true,
        temperature: false,
        tool_call: true,
        variants: model.variants,
      },
    ]),
  ) as Record<string, Model>
}
