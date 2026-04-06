import { setTimeout as sleep } from "node:timers/promises"
import { CLIENT_ID, ISSUER, OAUTH_POLL_MS, TOKEN_SKEW_MS } from "./constants.js"

export type Pkce = {
  verifier: string
  challenge: string
}

export type Device = {
  deviceAuthId: string
  userCode: string
  interval: number
  url: string
}

export type TokenResponse = {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

export type Claims = {
  email?: string
  chatgpt_account_id?: string
  organizations?: Array<{ id?: string }>
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

function rand(n: number) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  return Array.from(bytes)
    .map((x) => chars[x % chars.length])
    .join("")
}

export function base64UrlEncode(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf)
  const str = String.fromCharCode(...bytes)
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function generatePKCE(): Promise<Pkce> {
  const verifier = rand(43)
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return {
    verifier,
    challenge: base64UrlEncode(hash),
  }
}

export function generateState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export function buildAuthorizeUrl(uri: string, pkce: Pkce, state: string) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: uri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${ISSUER}/oauth/authorize?${q.toString()}`
}

export async function exchangeCodeForTokens(code: string, uri: string, pkce: Pkce): Promise<TokenResponse> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: uri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`)
  return (await res.json()) as TokenResponse
}

export async function refreshAccessToken(refresh: string): Promise<TokenResponse> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`)
  return (await res.json()) as TokenResponse
}

export async function startDeviceFlow() {
  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })
  if (!res.ok) throw new Error("Failed to initiate device authorization")
  const json = (await res.json()) as {
    device_auth_id: string
    user_code: string
    interval: string
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    interval: Math.max(Number.parseInt(json.interval || "5", 10), 1) * 1000,
    url: `${ISSUER}/codex/device`,
  } satisfies Device
}

export async function pollDeviceToken(dev: Device) {
  while (true) {
    const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: dev.deviceAuthId,
        user_code: dev.userCode,
      }),
    })
    if (res.ok) {
      const json = (await res.json()) as { authorization_code: string; code_verifier: string }
      const token = await fetch(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: json.authorization_code,
          redirect_uri: `${ISSUER}/deviceauth/callback`,
          client_id: CLIENT_ID,
          code_verifier: json.code_verifier,
        }).toString(),
      })
      if (!token.ok) throw new Error(`Token exchange failed: ${token.status}`)
      return (await token.json()) as TokenResponse
    }
    if (res.status !== 403 && res.status !== 404) throw new Error(`Device flow failed: ${res.status}`)
    await sleep(dev.interval + OAUTH_POLL_MS)
  }
}

export function parseJwtClaims(token: string | undefined) {
  if (!token) return
  const parts = token.split(".")
  if (parts.length !== 3) return
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Claims
  } catch {
    return
  }
}

export function extractAccountId(tokens: Pick<TokenResponse, "id_token" | "access_token">) {
  const claims = parseJwtClaims(tokens.id_token) ?? parseJwtClaims(tokens.access_token)
  if (!claims) return
  return claims.chatgpt_account_id || claims["https://api.openai.com/auth"]?.chatgpt_account_id || claims.organizations?.[0]?.id
}

export function extractEmail(tokens: Pick<TokenResponse, "id_token" | "access_token">) {
  const claims = parseJwtClaims(tokens.id_token) ?? parseJwtClaims(tokens.access_token)
  return claims?.email
}

export function tokenExpires(expires: unknown) {
  const secs = typeof expires === "number" && Number.isFinite(expires) ? expires : 3600
  return Date.now() + secs * 1000
}

export function accessExpired(expires: number | undefined) {
  return !expires || expires <= Date.now() + TOKEN_SKEW_MS
}
