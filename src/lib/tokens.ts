import crypto from 'crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import { prisma } from './prisma';

const ACCESS_TOKEN_TTL_SHORT = '1h';
const ACCESS_TOKEN_TTL_LEGACY = '60d';
const REFRESH_TOKEN_TTL_DAYS = 90;

interface UserPayload {
  id: string;
  email: string;
  display_name: string | null;
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function signAccessToken(user: UserPayload, ttl: SignOptions['expiresIn']): string {
  return jwt.sign(
    {
      userId: user.id,
      id: user.id,
      email: user.email,
      username: user.display_name,
      display_name: user.display_name,
      type: 'access',
    },
    process.env.JWT_SECRET!,
    { expiresIn: ttl },
  );
}

export async function issueRefreshToken(
  userId: string,
  userAgent: string | null,
): Promise<{ rawToken: string; expiresAt: Date; rowId: string }> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const row = await prisma.refresh_tokens.create({
    data: {
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      user_agent: userAgent,
    },
  });

  return { rawToken, expiresAt, rowId: row.id };
}

export function wantsRefresh(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const header = req.headers['x-client-refresh'];
  if (!header) return false;
  const value = Array.isArray(header) ? header[0] : header;
  return value?.toLowerCase() === 'v1';
}

export async function buildTokenResponse(
  user: UserPayload,
  req: { headers: Record<string, string | string[] | undefined> },
): Promise<{
  accessToken: string;
  idToken: string;
  refreshToken: string;
  refreshExpiresAt?: string;
}> {
  if (wantsRefresh(req)) {
    const accessToken = signAccessToken(user, ACCESS_TOKEN_TTL_SHORT);
    const { rawToken, expiresAt } = await issueRefreshToken(
      user.id,
      (req.headers['user-agent'] as string) || null,
    );
    return {
      accessToken,
      idToken: accessToken,
      refreshToken: rawToken,
      refreshExpiresAt: expiresAt.toISOString(),
    };
  }

  const token = signAccessToken(user, ACCESS_TOKEN_TTL_LEGACY);
  return {
    accessToken: token,
    idToken: token,
    refreshToken: token,
  };
}
