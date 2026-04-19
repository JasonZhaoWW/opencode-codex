export function installFetch(value: typeof fetch) {
  const prev = globalThis.fetch
  globalThis.fetch = value
  return () => {
    globalThis.fetch = prev
  }
}
