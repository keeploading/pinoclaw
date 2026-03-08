import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts, resolveFeishuAccount } from "./accounts.js";
import {
  monitorSingleAccount,
  resolveReactionSyntheticEvent,
  type FeishuReactionCreatedEvent,
} from "./monitor.account.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import {
  clearFeishuWebhookRateLimitStateForTest,
  getFeishuWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  stopFeishuMonitorState,
} from "./monitor.state.js";
import { startOAuthCallbackServer } from "./oauth-callback-server.js";
import { cleanupExpiredOAuthStates } from "./oauth-flow.js";
import { sendMessageFeishu } from "./send.js";
import type { FeishuOAuthConfig } from "./types.js";

export type MonitorFeishuOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

export {
  clearFeishuWebhookRateLimitStateForTest,
  getFeishuWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  resolveReactionSyntheticEvent,
};
export type { FeishuReactionCreatedEvent };

/** Derive the credentials directory from the OpenClaw state dir. */
function resolveCredentialsDirFromEnv(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "credentials");
}

/** Start the OAuth callback HTTP server and register an abort listener for cleanup. */
function maybeStartOAuthServer(params: {
  cfg: ClawdbotConfig;
  oauthCfg: FeishuOAuthConfig;
  accounts: ReturnType<typeof listEnabledFeishuAccounts>;
  abortSignal?: AbortSignal;
  log: (...args: unknown[]) => void;
}): http.Server | undefined {
  const { cfg, oauthCfg, accounts, abortSignal, log } = params;
  if (!oauthCfg.enabled) return undefined;

  const port = oauthCfg.callbackPort ?? 3001;
  const host = oauthCfg.callbackHost ?? "127.0.0.1";
  const callbackPath = oauthCfg.callbackPath ?? "/feishu/oauth/callback";
  const tokenExpiryDays = oauthCfg.tokenExpiryDays ?? 30;
  const credentialsDir = resolveCredentialsDirFromEnv();

  // Build credentials map (accountId → appId/appSecret/domain).
  const accountCredentials = new Map<
    string,
    { appId: string; appSecret: string; domain?: string }
  >();
  for (const account of accounts) {
    if (account.appId && account.appSecret) {
      accountCredentials.set(account.accountId, {
        appId: account.appId,
        appSecret: account.appSecret,
        domain: account.domain,
      });
    }
  }

  if (accountCredentials.size === 0) {
    log("feishu: OAuth enabled but no configured accounts found; skipping callback server");
    return undefined;
  }

  // Periodic cleanup of expired pending states (every 5 minutes).
  const cleanupInterval = setInterval(cleanupExpiredOAuthStates, 5 * 60 * 1000);

  const server = startOAuthCallbackServer({
    port,
    host,
    accountCredentials,
    credentialsDir,
    callbackPath,
    tokenExpiryDays,
    onUserAuthenticated: async ({ openId, chatId, accountId, name }) => {
      const displayName = name ?? "User";
      try {
        await sendMessageFeishu({
          cfg,
          to: `chat:${chatId}`,
          text: `✅ Welcome, ${displayName}! You're now verified and can use this service.`,
          accountId,
        });
      } catch (err) {
        log(`feishu: OAuth: failed to send confirmation DM to open_id=${openId}: ${String(err)}`);
      }
    },
    log,
  });

  // Tear down on abort.
  const onAbort = () => {
    clearInterval(cleanupInterval);
    server.close();
  };
  if (abortSignal?.aborted) {
    onAbort();
  } else {
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  return server;
}

export async function monitorFeishuProvider(opts: MonitorFeishuOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Feishu monitor");
  }

  const log = opts.runtime?.log ?? console.log;

  if (opts.accountId) {
    const account = resolveFeishuAccount({ cfg, accountId: opts.accountId });
    if (!account.enabled || !account.configured) {
      throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
    }
    return monitorSingleAccount({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
    });
  }

  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled Feishu accounts configured");
  }

  log(
    `feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  // Start OAuth callback server if configured.
  const feishuCfg = cfg.channels?.feishu as Record<string, unknown> | undefined;
  const oauthCfg = feishuCfg?.oauth as FeishuOAuthConfig | undefined;
  if (oauthCfg?.enabled) {
    maybeStartOAuthServer({
      cfg,
      oauthCfg,
      accounts,
      abortSignal: opts.abortSignal,
      log,
    });
  }

  const monitorPromises: Promise<void>[] = [];
  for (const account of accounts) {
    if (opts.abortSignal?.aborted) {
      log("feishu: abort signal received during startup preflight; stopping startup");
      break;
    }

    // Probe sequentially so large multi-account startups do not burst Feishu's bot-info endpoint.
    const { botOpenId, botName } = await fetchBotIdentityForMonitor(account, {
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
    });

    if (opts.abortSignal?.aborted) {
      log("feishu: abort signal received during startup preflight; stopping startup");
      break;
    }

    monitorPromises.push(
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
        botOpenIdSource: { kind: "prefetched", botOpenId, botName },
      }),
    );
  }

  await Promise.all(monitorPromises);
}

export function stopFeishuMonitor(accountId?: string): void {
  stopFeishuMonitorState(accountId);
}
