import { select } from "./select.js"

export async function confirm(message: string, defaultYes = false) {
  const result = await select(
    defaultYes
      ? [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ]
      : [
          { label: "No", value: false },
          { label: "Yes", value: true },
        ],
    { message },
  )
  return result ?? false
}
