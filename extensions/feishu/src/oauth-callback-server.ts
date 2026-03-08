import * as http from "http";
import { consumeOAuthPendingState, exchangeOAuthCode } from "./oauth-flow.js";
import type { FeishuDomain } from "./types.js";
import { saveUserOAuthToken } from "./user-oauth-store.js";
import type { FeishuUserOAuthToken } from "./user-oauth-store.js";

export type OAuthCallbackServerParams = {
  port: number;
  host?: string;
  /** Resolved account credentials, keyed by accountId. */
  accountCredentials: Map<string, { appId: string; appSecret: string; domain?: FeishuDomain }>;
  credentialsDir: string;
  callbackPath?: string;
  /** Days before the stored device binding expires. Default: 30. */
  tokenExpiryDays?: number;
  /** Called after a user is successfully authenticated. */
  onUserAuthenticated?: (params: {
    openId: string;
    chatId: string;
    accountId: string;
    name?: string;
  }) => Promise<void>;
  log?: (...args: unknown[]) => void;
};

const SUCCESS_HTML =
  "<!DOCTYPE html><html><head><meta charset=utf-8>" +
  "<title>Authenticated</title></head><body>" +
  "<h2>Authentication successful!</h2>" +
  "<p>You can close this window and return to the chat.</p>" +
  "</body></html>";

const ERROR_HTML = (msg: string) =>
  `<!DOCTYPE html><html><head><meta charset=utf-8>` +
  `<title>Auth Error</title></head><body>` +
  `<h2>Authentication failed</h2><p>${msg}</p></body></html>`;

/**
 * Start a lightweight HTTP server to handle the Feishu OAuth redirect callback.
 *
 * Flow:
 *   1. User clicks the OAuth link sent by the bot.
 *   2. Feishu redirects to `callbackPath?code=...&state=...`.
 *   3. We exchange the code for user identity and store a local device binding token.
 *   4. `onUserAuthenticated` is called so the bot can send a DM to confirm.
 */
export function startOAuthCallbackServer(params: OAuthCallbackServerParams): http.Server {
  const {
    port,
    host = "127.0.0.1",
    accountCredentials,
    credentialsDir,
    callbackPath = "/feishu/oauth/callback",
    tokenExpiryDays = 30,
    onUserAuthenticated,
    log = console.log,
  } = params;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname !== callbackPath) {
      res.writeHead(404).end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      res
        .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        .end(ERROR_HTML("Missing code or state parameter."));
      return;
    }

    const pending = consumeOAuthPendingState(state);
    if (!pending) {
      res
        .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        .end(ERROR_HTML("Invalid or expired auth session. Please try again."));
      return;
    }

    const creds = accountCredentials.get(pending.accountId);
    if (!creds) {
      res
        .writeHead(500, { "Content-Type": "text/html; charset=utf-8" })
        .end(ERROR_HTML("Internal error: account credentials not found."));
      return;
    }

    // Respond immediately; exchange happens asynchronously.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(SUCCESS_HTML);

    (async () => {
      try {
        const userInfo = await exchangeOAuthCode({
          code,
          appId: creds.appId,
          appSecret: creds.appSecret,
          domain: creds.domain,
        });

        const now = Date.now();
        const token: FeishuUserOAuthToken = {
          openId: userInfo.openId,
          expiresAt: now + tokenExpiryDays * 24 * 60 * 60 * 1000,
          userId: userInfo.userId,
          unionId: userInfo.unionId,
          name: userInfo.name,
          enName: userInfo.enName,
          email: userInfo.email,
          mobile: userInfo.mobile,
          avatarUrl: userInfo.avatarUrl,
          tenantKey: userInfo.tenantKey,
          authenticatedAt: now,
        };

        await saveUserOAuthToken(credentialsDir, token);

        log(
          `feishu: OAuth: authenticated open_id=${userInfo.openId}`,
          `name="${userInfo.name ?? ""}" tenant=${userInfo.tenantKey ?? ""}`,
        );

        await onUserAuthenticated?.({
          openId: userInfo.openId,
          chatId: pending.chatId,
          accountId: pending.accountId,
          name: userInfo.name,
        });
      } catch (err) {
        log(`feishu: OAuth callback error for state=${state}: ${String(err)}`);
      }
    })();
  });

  server.listen(port, host, () => {
    log(`feishu: OAuth callback server listening on http://${host}:${port}${callbackPath}`);
  });

  return server;
}
