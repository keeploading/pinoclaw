import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/feishu";
import type { FeishuDomain } from "./types.js";

/** Feishu tenant access token API response. */
type FeishuTokenResponse = {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
};

/** Feishu bot info API response. */
type FeishuBotInfoResponse = {
  code: number;
  msg: string;
  bot?: {
    app_name?: string;
    open_id?: string;
  };
};

const FEISHU_OPEN_API = "https://open.feishu.cn/open-apis";
const LARK_OPEN_API = "https://open.larksuite.com/open-apis";
const REQUEST_TIMEOUT_MS = 10_000;

function resolveOpenApiBase(domain?: FeishuDomain): string {
  if (domain === "lark") {
    return LARK_OPEN_API;
  }
  if (domain && domain !== "feishu" && domain.startsWith("https://")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return FEISHU_OPEN_API;
}

function resolveUserPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Derive a filesystem-safe account ID from a Feishu appId.
 * e.g. "cli_A1b2C3d4" → "user-cli-a1b2c3d4"
 */
function deriveAccountId(appId: string): string {
  return `user-${appId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

export type ValidateBotCredentialsResult = {
  tenantAccessToken: string;
  appName?: string;
  botOpenId?: string;
};

/**
 * Validate Feishu bot credentials by obtaining a tenant access token.
 * Returns token + bot identity on success; throws on invalid credentials.
 */
export async function validateFeishuBotCredentials(params: {
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
}): Promise<ValidateBotCredentialsResult> {
  const { appId, appSecret, domain } = params;
  const base = resolveOpenApiBase(domain);

  const tokenController = new AbortController();
  const tokenTimeout = setTimeout(() => tokenController.abort(), REQUEST_TIMEOUT_MS);

  let tokenResp: FeishuTokenResponse;
  try {
    const res = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: tokenController.signal,
    });
    tokenResp = (await res.json()) as FeishuTokenResponse;
  } finally {
    clearTimeout(tokenTimeout);
  }

  if (tokenResp.code !== 0 || !tokenResp.tenant_access_token) {
    throw new Error(
      `Feishu credentials invalid: ${tokenResp.msg ?? "unknown"} (code ${tokenResp.code})`,
    );
  }

  const tenantAccessToken = tokenResp.tenant_access_token;

  // Fetch bot info (best-effort — validation still succeeds if this fails).
  let appName: string | undefined;
  let botOpenId: string | undefined;
  try {
    const botController = new AbortController();
    const botTimeout = setTimeout(() => botController.abort(), REQUEST_TIMEOUT_MS);
    const botRes = await fetch(`${base}/bot/v3/info`, {
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
      signal: botController.signal,
    });
    clearTimeout(botTimeout);
    const botInfo = (await botRes.json()) as FeishuBotInfoResponse;
    if (botInfo.code === 0 && botInfo.bot) {
      appName = botInfo.bot.app_name?.trim() || undefined;
      botOpenId = botInfo.bot.open_id?.trim() || undefined;
    }
  } catch {
    // Ignore — bot info is non-critical.
  }

  return { tenantAccessToken, appName, botOpenId };
}

export type RegisterUserBotResult = {
  accountId: string;
  appName?: string;
  botOpenId?: string;
  agentCreated: boolean;
};

export type RegisterUserBotParams = {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  appId: string;
  appSecret: string;
  domain?: FeishuDomain;
  /** Override derived account ID. Defaults to "user-<normalised-appId>". */
  accountId?: string;
  /** Create a dedicated agent + binding for the new bot. Default: true. */
  autoCreateAgent?: boolean;
  workspaceTemplate?: string;
  agentDirTemplate?: string;
};

/**
 * Register a user-provided Feishu bot:
 * 1. Validates credentials against the Feishu API.
 * 2. Adds a new account under channels.feishu.accounts.
 * 3. Optionally creates a dedicated agent + binding for the bot.
 * 4. Writes the updated config to disk.
 */
export async function registerUserBot(
  params: RegisterUserBotParams,
): Promise<RegisterUserBotResult> {
  const {
    cfg,
    runtime,
    appId,
    appSecret,
    domain,
    autoCreateAgent = true,
    workspaceTemplate = "~/.openclaw/workspace-{accountId}",
    agentDirTemplate = "~/.openclaw/agents/{accountId}/agent",
  } = params;

  // Throws if credentials are invalid.
  const { appName, botOpenId } = await validateFeishuBotCredentials({ appId, appSecret, domain });

  const accountId = params.accountId?.trim() || deriveAccountId(appId);

  // Build updated channels.feishu.accounts entry.
  const existingFeishu = (cfg.channels?.feishu ?? {}) as Record<string, unknown>;
  const existingAccounts = (existingFeishu.accounts ?? {}) as Record<string, unknown>;

  let updatedCfg: OpenClawConfig = {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...existingFeishu,
        accounts: {
          ...existingAccounts,
          [accountId]: {
            appId,
            appSecret,
            ...(domain && domain !== "feishu" ? { domain } : {}),
            ...(appName ? { name: appName } : {}),
          },
        },
      },
    },
  };

  let agentCreated = false;

  if (autoCreateAgent) {
    const agentId = `feishu-bot-${accountId}`;
    const existingAgents: Array<{ id: string; workspace?: string; agentDir?: string }> =
      updatedCfg.agents?.list ?? [];
    const alreadyExists = existingAgents.some((a) => a.id === agentId);

    if (!alreadyExists) {
      const workspace = resolveUserPath(workspaceTemplate.replace("{accountId}", accountId));
      const agentDir = resolveUserPath(agentDirTemplate.replace("{accountId}", accountId));
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(agentDir, { recursive: true });

      updatedCfg = {
        ...updatedCfg,
        agents: {
          ...updatedCfg.agents,
          list: [...existingAgents, { id: agentId, workspace, agentDir }],
        },
        bindings: [
          ...(updatedCfg.bindings ?? []),
          { agentId, match: { channel: "feishu", accountId } },
        ],
      };

      agentCreated = true;
    }
  }

  await runtime.config.writeConfigFile(updatedCfg);
  return { accountId, appName, botOpenId, agentCreated };
}
