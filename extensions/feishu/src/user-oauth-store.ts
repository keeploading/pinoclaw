import fs from "node:fs/promises";
import path from "node:path";

const USER_AUTH_SUBDIR = "feishu-user-auth";

export type FeishuUserOAuthToken = {
  openId: string;
  expiresAt: number; // unix ms — binding expiry (set by tokenExpiryDays, not OAuth expiry)
  userId?: string;
  unionId?: string;
  name?: string;
  enName?: string;
  email?: string;
  mobile?: string;
  avatarUrl?: string;
  tenantKey?: string;
  authenticatedAt: number;
};

export function resolveUserAuthDir(credentialsDir: string): string {
  return path.join(credentialsDir, USER_AUTH_SUBDIR);
}

function tokenFilePath(credentialsDir: string, openId: string): string {
  return path.join(resolveUserAuthDir(credentialsDir), `${openId}.json`);
}

export async function loadUserOAuthToken(
  credentialsDir: string,
  openId: string,
): Promise<FeishuUserOAuthToken | undefined> {
  try {
    const data = await fs.readFile(tokenFilePath(credentialsDir, openId), "utf-8");
    return JSON.parse(data) as FeishuUserOAuthToken;
  } catch {
    return undefined;
  }
}

export async function saveUserOAuthToken(
  credentialsDir: string,
  token: FeishuUserOAuthToken,
): Promise<void> {
  const dir = resolveUserAuthDir(credentialsDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tokenFilePath(credentialsDir, token.openId), JSON.stringify(token, null, 2));
}

export async function deleteUserOAuthToken(credentialsDir: string, openId: string): Promise<void> {
  try {
    await fs.unlink(tokenFilePath(credentialsDir, openId));
  } catch {
    // Ignore if file doesn't exist.
  }
}

/** Returns true if the token exists and the device binding has not expired. */
export function isUserOAuthTokenValid(token: FeishuUserOAuthToken): boolean {
  return Date.now() < token.expiresAt;
}
