import { expect, test } from "bun:test"

import { buildCodexModels } from "./src/models.js"

function keys(input?: Record<string, unknown>) {
  return Object.keys(input ?? {}).sort()
}

function get<T>(input: Record<string, T>, key: string) {
  const value = input[key]
  expect(value).toBeDefined()
  return value as T
}

function final(id: string, model: ReturnType<typeof buildCodexModels>[string]) {
  const list = (() => {
    if (id.includes("codex")) {
      if (id.includes("5.2") || id.includes("5.3")) return ["low", "medium", "high", "xhigh"]
      return ["low", "medium", "high"]
    }
    const out = ["low", "medium", "high"]
    if (model.release_date && model.release_date >= "2025-11-13") out.unshift("none")
    if (model.release_date && model.release_date >= "2025-12-04") out.push("xhigh")
    return out
  })()
  const merged = { ...Object.fromEntries(list.map((item) => [item, {}])), ...model.variants }
  return Object.entries(merged).flatMap(([key, value]) => {
    if (value && typeof value === "object" && "disabled" in value && value.disabled) return []
    return [key]
  })
}

test("buildCodexModels exposes the seven maintained models", () => {
  const models = buildCodexModels()

  expect(keys(models)).toEqual([
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
  ])
})

test("buildCodexModels encodes scoped variant menus", () => {
  const models = buildCodexModels()

  expect(keys(get(models, "gpt-5.1-codex-max").variants)).toEqual(["high", "low", "medium", "xhigh"])
  expect(keys(get(models, "gpt-5.1-codex-mini").variants)).toEqual(["high", "low", "medium"])
  expect(get(get(models, "gpt-5.1-codex-mini").variants, "low")).toEqual({ disabled: true })

  expect(keys(get(models, "gpt-5.2").variants)).toEqual(["high", "low", "medium", "none", "xhigh"])
  expect(keys(get(models, "gpt-5.2-codex").variants)).toEqual(["high", "low", "medium", "xhigh"])
  expect(keys(get(models, "gpt-5.3-codex").variants)).toEqual(["high", "low", "medium", "xhigh"])
  expect(keys(get(models, "gpt-5.4").variants)).toEqual(["high", "low", "medium", "none", "xhigh"])
  expect(keys(get(models, "gpt-5.4-mini").variants)).toEqual(["high", "low", "medium", "none", "xhigh"])
})

test("buildCodexModels carries the release dates needed for final OpenCode ordering", () => {
  const models = buildCodexModels()

  expect(get(models, "gpt-5.2").release_date).toBe("2025-12-11")
  expect(get(models, "gpt-5.4").release_date).toBe("2026-03-05")
  expect(get(models, "gpt-5.4-mini").release_date).toBe("2026-03-17")
})

test("buildCodexModels leaves the unselected default path untouched", () => {
  const models = buildCodexModels()

  for (const model of Object.values(models)) {
    expect(model.options).toEqual({})
    expect(get(model.variants, "medium").reasoningEffort).toBe("medium")
  }
})

test("final visible variants put none before low where supported", () => {
  const models = buildCodexModels()

  expect(final("gpt-5.2", get(models, "gpt-5.2"))).toEqual(["none", "low", "medium", "high", "xhigh"])
  expect(final("gpt-5.4", get(models, "gpt-5.4"))).toEqual(["none", "low", "medium", "high", "xhigh"])
  expect(final("gpt-5.4-mini", get(models, "gpt-5.4-mini"))).toEqual([
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
  ])
})

test("final visible variants keep non-none models semantically ordered", () => {
  const models = buildCodexModels()

  expect(final("gpt-5.1-codex-max", get(models, "gpt-5.1-codex-max"))).toEqual(["low", "medium", "high", "xhigh"])
  expect(final("gpt-5.1-codex-mini", get(models, "gpt-5.1-codex-mini"))).toEqual(["medium", "high"])
  expect(final("gpt-5.2-codex", get(models, "gpt-5.2-codex"))).toEqual(["low", "medium", "high", "xhigh"])
  expect(final("gpt-5.3-codex", get(models, "gpt-5.3-codex"))).toEqual(["low", "medium", "high", "xhigh"])
})
