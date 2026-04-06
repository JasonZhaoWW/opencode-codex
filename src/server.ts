import { OAUTH_PORT } from "./constants.js"
import { exchangeCodeForTokens, type Pkce, type TokenResponse } from "./oauth.js"

const HTML_SUCCESS = `<!doctype html><html><body><h1>Authorization Successful</h1><p>You can close this window.</p><script>setTimeout(() => window.close(), 1200)</script></body></html>`

const HTML_ERROR = (msg: string) => `<!doctype html><html><body><h1>Authorization Failed</h1><pre>${msg}</pre></body></html>`

type Pending = {
  pkce: Pkce
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (err: Error) => void
}

let srv: ReturnType<typeof Bun.serve> | undefined
let pending: Pending | undefined

export async function startOAuthServer() {
  if (!srv) {
    srv = Bun.serve({
      port: OAUTH_PORT,
      fetch(req: Request) {
        const url = new URL(req.url)
        if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 })
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const err = url.searchParams.get("error_description") || url.searchParams.get("error")
        if (err) {
          pending?.reject(new Error(err))
          pending = undefined
          return new Response(HTML_ERROR(err), { headers: { "Content-Type": "text/html" } })
        }
        if (!code || !pending) {
          const msg = "Missing authorization code"
          pending?.reject(new Error(msg))
          pending = undefined
          return new Response(HTML_ERROR(msg), { status: 400, headers: { "Content-Type": "text/html" } })
        }
        if (pending.state !== state) {
          const msg = "Invalid state"
          pending.reject(new Error(msg))
          pending = undefined
          return new Response(HTML_ERROR(msg), { status: 400, headers: { "Content-Type": "text/html" } })
        }
        const cur = pending
        pending = undefined
        void exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, cur.pkce)
          .then(cur.resolve)
          .catch(cur.reject)
        return new Response(HTML_SUCCESS, { headers: { "Content-Type": "text/html" } })
      },
    })
  }
  return {
    redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback`,
  }
}

export function stopOAuthServer() {
  srv?.stop()
  srv = undefined
}

export function waitForOAuthCallback(pkce: Pkce, state: string) {
  return new Promise<TokenResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending) return
      pending = undefined
      reject(new Error("OAuth callback timeout"))
    }, 5 * 60 * 1000)
    pending = {
      pkce,
      state,
      resolve(tokens) {
        clearTimeout(timer)
        resolve(tokens)
      },
      reject(err) {
        clearTimeout(timer)
        reject(err)
      },
    }
  })
}
