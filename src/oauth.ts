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

export type RefreshTokenResponse = Omit<TokenResponse, "refresh_token"> & {
  refresh_token?: string
}

export class TokenRefreshError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly permanent: boolean,
  ) {
    super(message)
    this.name = "TokenRefreshError"
  }
}

type RefreshFailure = {
  code?: string
  message?: string
}

export type Claims = {
  exp?: number
  email?: string
  sub?: string
  chatgpt_plan_type?: string
  chatgpt_user_id?: string
  chatgpt_account_id?: string
  chatgpt_workspace_id?: string
  user_id?: string
  organization_id?: string
  workspace_id?: string
  organizations?: Array<{ id?: string }>
  "https://api.openai.com/auth"?: {
    chatgpt_plan_type?: string
    chatgpt_user_id?: string
    chatgpt_account_id?: string
    chatgpt_workspace_id?: string
    user_id?: string
    organization_id?: string
    workspace_id?: string
  }
  "https://api.openai.com/profile"?: {
    email?: string
  }
}

export type TokenIdentity = {
  planType?: string
  userId?: string
  accountId?: string
}

export type ImportedAccessToken = {
  accessToken: string
  tokenExpires: number
  email?: string
  planType?: string
  userId?: string
  accountId: string
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

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function parseRefreshFailure(body: string): RefreshFailure {
  if (!body.trim()) return {}
  try {
    const parsed = JSON.parse(body) as unknown
    if (!object(parsed)) return { message: body }
    const error = parsed.error
    const nested = object(error) ? error : undefined
    return {
      code: string(nested?.code) || string(nested?.type) || string(error) || string(parsed.code) || string(parsed.error_code),
      message: string(nested?.message) || string(parsed.error_description) || string(parsed.message),
    }
  } catch {
    return { message: body }
  }
}

function permanentRefreshMessage(code: string | undefined) {
  switch (code) {
    case "refresh_token_expired":
      return "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again."
    case "refresh_token_reused":
      return "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."
    case "refresh_token_invalidated":
      return "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again."
    case "invalid_grant":
    case "invalid_refresh_token":
      return "Your access token could not be refreshed because your refresh token is invalid. Please log out and sign in again."
    default:
      return "Your access token could not be refreshed. Please log out and sign in again."
  }
}

function isPermanentRefreshFailure(status: number, code: string | undefined) {
  return status === 401 || code === "refresh_token_expired" || code === "refresh_token_reused" || code === "refresh_token_invalidated" || code === "invalid_grant" || code === "invalid_refresh_token"
}

export function isPermanentTokenRefreshError(err: unknown) {
  return err instanceof TokenRefreshError && err.permanent
}

export async function refreshAccessToken(refresh: string): Promise<RefreshTokenResponse> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID,
    }).toString(),
  })
  const body = await res.text()
  if (!res.ok) {
    const failure = parseRefreshFailure(body)
    const code = failure.code?.toLowerCase()
    const permanent = isPermanentRefreshFailure(res.status, code)
    const message = permanent
      ? permanentRefreshMessage(code)
      : `Token refresh failed: ${res.status}${failure.message ? `: ${failure.message}` : ""}`
    throw new TokenRefreshError(message, res.status, code, permanent)
  }
  return JSON.parse(body) as RefreshTokenResponse
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
    const parsed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as unknown
    if (!object(parsed)) return
    return parsed as Claims
  } catch {
    return
  }
}

function pickClaim<T>(...values: Array<T | undefined>) {
  return values.find((value) => value !== undefined)
}

export function extractAccountIdentity(tokens: Pick<TokenResponse, "id_token" | "access_token">): TokenIdentity {
  const idClaims = parseJwtClaims(tokens.id_token)
  const accessClaims = parseJwtClaims(tokens.access_token)
  return {
    planType: pickClaim(
      idClaims?.["https://api.openai.com/auth"]?.chatgpt_plan_type,
      idClaims?.chatgpt_plan_type,
      accessClaims?.["https://api.openai.com/auth"]?.chatgpt_plan_type,
      accessClaims?.chatgpt_plan_type,
    ),
    userId: pickClaim(
      idClaims?.["https://api.openai.com/auth"]?.chatgpt_user_id,
      idClaims?.["https://api.openai.com/auth"]?.user_id,
      idClaims?.chatgpt_user_id,
      idClaims?.user_id,
      accessClaims?.["https://api.openai.com/auth"]?.chatgpt_user_id,
      accessClaims?.["https://api.openai.com/auth"]?.user_id,
      accessClaims?.chatgpt_user_id,
      accessClaims?.user_id,
      accessClaims?.sub,
    ),
    accountId: pickClaim(
      idClaims?.["https://api.openai.com/auth"]?.chatgpt_account_id,
      idClaims?.["https://api.openai.com/auth"]?.chatgpt_workspace_id,
      idClaims?.chatgpt_account_id,
      idClaims?.chatgpt_workspace_id,
      accessClaims?.["https://api.openai.com/auth"]?.chatgpt_account_id,
      accessClaims?.["https://api.openai.com/auth"]?.chatgpt_workspace_id,
      accessClaims?.chatgpt_account_id,
      accessClaims?.chatgpt_workspace_id,
      idClaims?.["https://api.openai.com/auth"]?.organization_id,
      idClaims?.["https://api.openai.com/auth"]?.workspace_id,
      idClaims?.organization_id,
      idClaims?.workspace_id,
      idClaims?.organizations?.[0]?.id,
      accessClaims?.["https://api.openai.com/auth"]?.organization_id,
      accessClaims?.["https://api.openai.com/auth"]?.workspace_id,
      accessClaims?.organization_id,
      accessClaims?.workspace_id,
      accessClaims?.organizations?.[0]?.id,
    ),
  }
}

export function extractAccountId(tokens: Pick<TokenResponse, "id_token" | "access_token">) {
  return extractAccountIdentity(tokens).accountId
}

export function extractUserId(tokens: Pick<TokenResponse, "id_token" | "access_token">) {
  return extractAccountIdentity(tokens).userId
}

export function extractPlanType(tokens: Pick<TokenResponse, "id_token" | "access_token">) {
  return extractAccountIdentity(tokens).planType
}

export function extractEmail(tokens: Pick<TokenResponse, "id_token" | "access_token">) {
  const claims = parseJwtClaims(tokens.id_token) ?? parseJwtClaims(tokens.access_token)
  return claims?.email ?? claims?.["https://api.openai.com/profile"]?.email
}

export function parseChatGptAccessToken(value: string): ImportedAccessToken {
  const accessToken = value.trim()
  const claims = parseJwtClaims(accessToken)
  if (!claims) throw new Error("A valid ChatGPT OAuth access token is required.")
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= 0) {
    throw new Error("The ChatGPT OAuth access token must include an expiration claim.")
  }
  const tokenExpires = Math.trunc(claims.exp * 1000)
  if (tokenExpires <= Date.now()) throw new Error("The ChatGPT OAuth access token has expired. Re-import a fresh ChatGPT access token.")
  const identity = extractAccountIdentity({ access_token: accessToken })
  if (!identity.userId || !identity.accountId) {
    throw new Error("The ChatGPT OAuth access token must include a ChatGPT user ID and account or workspace identifier for Codex request routing.")
  }
  return {
    accessToken,
    tokenExpires,
    email: extractEmail({ access_token: accessToken }),
    planType: identity.planType,
    userId: identity.userId,
    accountId: identity.accountId,
  }
}

export function tokenExpires(expires: unknown) {
  const secs = typeof expires === "number" && Number.isFinite(expires) ? expires : 3600
  return Date.now() + secs * 1000
}

export function accessExpired(expires: number | undefined) {
  return !expires || expires <= Date.now() + TOKEN_SKEW_MS
}
