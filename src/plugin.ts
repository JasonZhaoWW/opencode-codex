import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { AccountManager } from "./accounts.js";
import { promptAccountLabel, promptLoginMenu } from "./cli.js";
import { loadConfig } from "./config.js";
import { OAUTH_DUMMY_KEY } from "./constants.js";
import { createCodexFetch } from "./fetch.js";
import { buildCodexModels } from "./models.js";
import {
  buildAuthorizeUrl,
  generatePKCE,
  generateState,
  pollDeviceToken,
  startDeviceFlow,
} from "./oauth.js";
import {
  startOAuthServer,
  stopOAuthServer,
  waitForOAuthCallback,
} from "./server.js";

const ID = "openai";

function catalog() {
  return Object.fromEntries(
    Object.entries(buildCodexModels()).map(([id, model]) => [
      id,
      {
        id,
        providerID: ID,
        api: {
          id,
          url: model.provider.api,
          npm: model.provider.npm,
        },
        name: model.name,
        family: model.family,
        capabilities: {
          temperature: model.temperature,
          reasoning: model.reasoning,
          attachment: model.attachment,
          toolcall: model.tool_call,
          input: {
            text: model.modalities.input.includes("text"),
            audio: model.modalities.input.includes("audio"),
            image: model.modalities.input.includes("image"),
            video: model.modalities.input.includes("video"),
            pdf: model.modalities.input.includes("pdf"),
          },
          output: {
            text: model.modalities.output.includes("text"),
            audio: model.modalities.output.includes("audio"),
            image: model.modalities.output.includes("image"),
            video: model.modalities.output.includes("video"),
            pdf: model.modalities.output.includes("pdf"),
          },
          interleaved: false,
        },
        cost: {
          input: model.cost.input,
          output: model.cost.output,
          cache: {
            read: model.cost.cache_read,
            write: model.cost.cache_write,
          },
        },
        limit: model.limit,
        status: "active",
        options: model.options,
        headers: {},
        release_date: model.release_date ?? "",
        variants: model.variants,
      },
    ]),
  );
}

async function sentinel(mgr: AccountManager) {
  const acc = mgr.list()[0];
  if (!acc) return { type: "failed" as const };
  return {
    type: "success" as const,
    refresh: acc.refreshToken,
    access: acc.accessToken,
    expires: acc.tokenExpires,
    ...(acc.accountId ? { accountId: acc.accountId } : {}),
  };
}

export async function CodexMultiAuthPlugin(input: PluginInput): Promise<Hooks> {
  const cfg = await loadConfig(input.worktree);
  let mgr: AccountManager | undefined;
  const getMgr = async () => {
    mgr ??= await AccountManager.load(input.client);
    return mgr;
  };

  const browser = async (tag?: string) => {
    const { redirectUri } = await startOAuthServer();
    const pkce = await generatePKCE();
    const state = generateState();
    const url = buildAuthorizeUrl(redirectUri, pkce, state);
    const wait = waitForOAuthCallback(pkce, state);
    return {
      url,
      instructions: "Complete authorization in your browser.",
      method: "auto" as const,
      callback: async () => {
        const tokens = await wait;
        stopOAuthServer();
        const m = await getMgr();
        const acc = await m.add(tokens, tag || (await promptAccountLabel()));
        return {
          type: "success" as const,
          refresh: acc.refreshToken,
          access: acc.accessToken,
          expires: acc.tokenExpires,
          ...(acc.accountId ? { accountId: acc.accountId } : {}),
        };
      },
    };
  };

  const headless = async (tag?: string) => {
    const dev = await startDeviceFlow();
    return {
      url: dev.url,
      instructions: `Enter code: ${dev.userCode}`,
      method: "auto" as const,
      callback: async () => {
        const tokens = await pollDeviceToken(dev);
        const m = await getMgr();
        const acc = await m.add(tokens, tag || (await promptAccountLabel()));
        return {
          type: "success" as const,
          refresh: acc.refreshToken,
          access: acc.accessToken,
          expires: acc.tokenExpires,
          ...(acc.accountId ? { accountId: acc.accountId } : {}),
        };
      },
    };
  };

  const manage = async () => {
    const m = await getMgr();
    let message = "Account manager closed.";
    while (true) {
      const act = await promptLoginMenu(m.list(), m.currentIndex());
      if (act.type === "done") break;
      if (act.type === "add-browser") return browser(await promptAccountLabel());
      if (act.type === "add-headless") return headless(await promptAccountLabel());
      if (act.type === "rename") {
        await m.rename(act.index, act.label);
        message = "Accounts updated.";
        continue;
      }
      if (act.type === "remove") {
        await m.remove(act.index);
        message = "Accounts updated.";
        continue;
      }
      if (act.type === "toggle") {
        await m.toggle(act.index);
        message = "Accounts updated.";
        continue;
      }
      if (act.type === "quota") {
        await m.quota(act.index);
        message = "Accounts updated.";
      }
    }
    return {
      url: "",
      instructions: message,
      method: "auto" as const,
      callback: async () => sentinel(m),
    };
  };

  return {
    provider: {
      id: ID,
      async models(provider: { models: Record<string, unknown> }, ctx: { auth?: { type: string } }) {
        if (ctx.auth?.type !== "oauth") return provider.models;
        return catalog();
      },
    },
    auth: {
      provider: ID,
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth.type !== "oauth") return {};
        const m = await getMgr();
        await m.ensureFromAuth(auth);
        return {
          apiKey: OAUTH_DUMMY_KEY,
          fetch: createCodexFetch(m),
          ...(cfg.rateLimitMs ? { rateLimitMs: cfg.rateLimitMs } : {}),
        };
      },
      methods: [
        {
          label: "Codex",
          type: "oauth",
          authorize: manage,
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    "chat.headers": async (ctx, out) => {
      if (ctx.model.providerID !== ID) return;
      out.headers.originator = "opencode";
      if (!out.headers["User-Agent"])
        out.headers["User-Agent"] = "opencode-codex";
      out.headers.session_id = ctx.sessionID;
    },
  } as Hooks;
}
