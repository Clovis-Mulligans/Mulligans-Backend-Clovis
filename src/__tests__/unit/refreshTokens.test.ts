/**
 * Refresh Token Tests (AUTH-01)
 *
 * Covers:
 *   - Token helper functions (hashToken, signAccessToken, wantsRefresh, buildTokenResponse)
 *   - Capability gating (X-Client-Refresh header)
 *   - Refresh endpoint (rotation, expiry, reuse detection)
 *   - Logout endpoint (idempotent revocation)
 *   - Middleware error codes
 *   - Raw token never stored
 *
 * Run: npx jest --selectProjects unit --testPathPattern refreshTokens
 */

/* ------------------------------------------------------------------ */
/*  Environment                                                        */
/* ------------------------------------------------------------------ */
process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests';
process.env.COGNITO_CLIENT_ID = 'test-cognito-client-id';
process.env.COGNITO_USER_POOL_ID = 'test-user-pool-id';
process.env.AWS_REGION = 'eu-west-2';
process.env.RESEND_API_KEY = 're_test_key';

/* ------------------------------------------------------------------ */
/*  Mocks — must precede module imports                                */
/* ------------------------------------------------------------------ */
const mockCognitoSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  SignUpCommand: jest.fn((input: any) => ({ _cmd: 'SignUp', input })),
  InitiateAuthCommand: jest.fn((input: any) => ({ _cmd: 'Auth', input })),
  AuthFlowType: { USER_PASSWORD_AUTH: 'USER_PASSWORD_AUTH' },
  AdminConfirmSignUpCommand: jest.fn(),
  ConfirmSignUpCommand: jest.fn(),
  ForgotPasswordCommand: jest.fn(),
  ConfirmForgotPasswordCommand: jest.fn(),
  ChangePasswordCommand: jest.fn(),
}));

const mockRefreshTokens = {
  create: jest.fn(),
  findUnique: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};
const mockUsers = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};
const mockTransaction = jest.fn(async (cb: any) => {
  return cb({
    refresh_tokens: mockRefreshTokens,
  });
});
jest.mock('../../lib/prisma', () => ({
  prisma: {
    users: mockUsers,
    refresh_tokens: mockRefreshTokens,
    $transaction: mockTransaction,
  },
}));

jest.mock('../../services/emailService', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));

const mockRateLimitFactory = jest.fn(
  () => (_req: any, _res: any, next: any) => next(),
);
jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: mockRateLimitFactory,
}));

jest.mock('../../lib/sellerAddress', () => ({
  validateSendingAddress: jest.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Imports (after mocks)                                              */
/* ------------------------------------------------------------------ */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import express from 'express';
import request from 'supertest';
import { hashToken, signAccessToken, wantsRefresh } from '../../lib/tokens';
import authRouter from '../../routes/authRoutes';
import { authenticateToken } from '../../middleware/auth';

/* ------------------------------------------------------------------ */
/*  Test app                                                           */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

// Protected route for middleware tests
app.get('/api/protected', authenticateToken, (_req: any, res: any) => {
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function makeUser(overrides = {}) {
  return {
    id: 'user_test_001',
    email: 'test@mulligans.uk.com',
    display_name: 'Test User',
    is_banned: false,
    ...overrides,
  };
}

function makeCognitoSuccess() {
  mockCognitoSend.mockResolvedValueOnce({
    AuthenticationResult: { AccessToken: 'cognito_access', IdToken: 'cognito_id' },
  });
}

/* ------------------------------------------------------------------ */
/*  1. Token helper unit tests                                         */
/* ------------------------------------------------------------------ */
describe('Token helpers', () => {
  test('hashToken produces a SHA-256 hex digest', () => {
    const raw = 'abc123';
    const hash = hashToken(raw);
    const expected = crypto.createHash('sha256').update(raw).digest('hex');
    expect(hash).toBe(expected);
    expect(hash).toHaveLength(64);
  });

  test('hashToken output differs from raw input', () => {
    const raw = crypto.randomBytes(32).toString('hex');
    expect(hashToken(raw)).not.toBe(raw);
  });

  test('signAccessToken produces a valid JWT with type:access', () => {
    const user = makeUser();
    const token = signAccessToken(user, '1h');
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    expect(decoded.type).toBe('access');
    expect(decoded.userId).toBe(user.id);
    expect(decoded.email).toBe(user.email);
  });

  test('wantsRefresh returns true for X-Client-Refresh: v1', () => {
    expect(wantsRefresh({ headers: { 'x-client-refresh': 'v1' } })).toBe(true);
    expect(wantsRefresh({ headers: { 'x-client-refresh': 'V1' } })).toBe(true);
  });

  test('wantsRefresh returns false when header absent or wrong value', () => {
    expect(wantsRefresh({ headers: {} })).toBe(false);
    expect(wantsRefresh({ headers: { 'x-client-refresh': 'v2' } })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  2. Capability gating — login                                       */
/* ------------------------------------------------------------------ */
describe('Login capability gating', () => {
  beforeEach(() => jest.clearAllMocks());

  test('login WITHOUT X-Client-Refresh → legacy 60-day token, no refresh_tokens row', async () => {
    const user = makeUser();
    mockUsers.findFirst.mockResolvedValueOnce(user);
    makeCognitoSuccess();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'Test1234!' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBe(res.body.accessToken);
    expect(res.body.refreshExpiresAt).toBeUndefined();

    // Verify token is 60-day
    const decoded = jwt.decode(res.body.accessToken) as any;
    const ttlSeconds = decoded.exp - decoded.iat;
    expect(ttlSeconds).toBe(60 * 24 * 60 * 60); // 60 days

    // No refresh_tokens.create call
    expect(mockRefreshTokens.create).not.toHaveBeenCalled();
  });

  test('login WITH X-Client-Refresh: v1 → short access token + real refresh token + row created', async () => {
    const user = makeUser();
    mockUsers.findFirst.mockResolvedValueOnce(user);
    makeCognitoSuccess();

    const createdRow = { id: 'rt_001', token_hash: 'hash', expires_at: new Date(), user_id: user.id };
    mockRefreshTokens.create.mockResolvedValueOnce(createdRow);

    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Client-Refresh', 'v1')
      .send({ email: user.email, password: 'Test1234!' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.refreshToken).not.toBe(res.body.accessToken);
    expect(res.body.refreshExpiresAt).toBeDefined();

    // Verify access token is 1-hour
    const decoded = jwt.decode(res.body.accessToken) as any;
    const ttlSeconds = decoded.exp - decoded.iat;
    expect(ttlSeconds).toBe(3600); // 1 hour
    expect(decoded.type).toBe('access');

    // refresh_tokens.create was called
    expect(mockRefreshTokens.create).toHaveBeenCalledTimes(1);
    const createArg = mockRefreshTokens.create.mock.calls[0][0];
    expect(createArg.data.user_id).toBe(user.id);
    expect(createArg.data.token_hash).toHaveLength(64);

    // Stored hash ≠ raw token
    expect(createArg.data.token_hash).not.toBe(res.body.refreshToken);
    // Stored hash = SHA-256 of raw token
    expect(createArg.data.token_hash).toBe(hashToken(res.body.refreshToken));
  });
});

/* ------------------------------------------------------------------ */
/*  3. Refresh endpoint                                                */
/* ------------------------------------------------------------------ */
describe('POST /api/auth/refresh', () => {
  beforeEach(() => jest.clearAllMocks());

  test('missing/malformed refreshToken → 400', async () => {
    const res1 = await request(app).post('/api/auth/refresh').send({});
    expect(res1.status).toBe(400);
    expect(res1.body.code).toBe('REFRESH_MISSING');

    const res2 = await request(app).post('/api/auth/refresh').send({ refreshToken: 'short' });
    expect(res2.status).toBe(400);
  });

  test('unknown token → 401 REFRESH_INVALID', async () => {
    mockRefreshTokens.findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: crypto.randomBytes(32).toString('hex') });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REFRESH_INVALID');
  });

  test('expired token → 401 REFRESH_INVALID', async () => {
    const user = makeUser();
    mockRefreshTokens.findUnique.mockResolvedValueOnce({
      id: 'rt_expired',
      user_id: user.id,
      token_hash: 'hash',
      expires_at: new Date(Date.now() - 1000), // expired
      revoked_at: null,
      replaced_by: null,
      users: user,
    });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: crypto.randomBytes(32).toString('hex') });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REFRESH_INVALID');
  });

  test('already-revoked token → 401 REFRESH_REUSE + all user tokens revoked', async () => {
    const user = makeUser();
    mockRefreshTokens.findUnique.mockResolvedValueOnce({
      id: 'rt_revoked',
      user_id: user.id,
      token_hash: 'hash',
      expires_at: new Date(Date.now() + 86400000),
      revoked_at: new Date(), // already revoked
      replaced_by: 'rt_replacement',
      users: user,
    });
    mockRefreshTokens.updateMany.mockResolvedValueOnce({ count: 3 });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: crypto.randomBytes(32).toString('hex') });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REFRESH_REUSE');

    // All active tokens for this user revoked
    expect(mockRefreshTokens.updateMany).toHaveBeenCalledWith({
      where: { user_id: user.id, revoked_at: null },
      data: { revoked_at: expect.any(Date) },
    });
  });

  test('valid token → rotates: new access + new refresh, old row revoked with replaced_by', async () => {
    const user = makeUser();
    const rawToken = crypto.randomBytes(32).toString('hex');

    mockRefreshTokens.findUnique.mockResolvedValueOnce({
      id: 'rt_current',
      user_id: user.id,
      token_hash: hashToken(rawToken),
      expires_at: new Date(Date.now() + 86400000),
      revoked_at: null,
      replaced_by: null,
      users: user,
    });

    // Atomic claim succeeds (count=1)
    mockRefreshTokens.updateMany.mockResolvedValueOnce({ count: 1 });

    const newRow = { id: 'rt_new', token_hash: 'newhash', expires_at: new Date(Date.now() + 86400000 * 90), user_id: user.id };
    mockRefreshTokens.create.mockResolvedValueOnce(newRow);
    mockRefreshTokens.update.mockResolvedValueOnce({});

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: rawToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.idToken).toBe(res.body.accessToken);
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.refreshExpiresAt).toBeDefined();

    // New access token is valid
    const decoded = jwt.verify(res.body.accessToken, process.env.JWT_SECRET!) as any;
    expect(decoded.userId).toBe(user.id);
    expect(decoded.type).toBe('access');

    // replaced_by set on old row
    expect(mockRefreshTokens.update).toHaveBeenCalledWith({
      where: { id: 'rt_current' },
      data: { replaced_by: newRow.id },
    });

    // New refresh token created inside transaction
    expect(mockRefreshTokens.create).toHaveBeenCalledTimes(1);
  });

  test('atomic claim uses revoked_at: null guard (prevents concurrent rotation race)', async () => {
    const user = makeUser();
    const rawToken = crypto.randomBytes(32).toString('hex');

    mockRefreshTokens.findUnique.mockResolvedValueOnce({
      id: 'rt_race',
      user_id: user.id,
      token_hash: hashToken(rawToken),
      expires_at: new Date(Date.now() + 86400000),
      revoked_at: null,
      replaced_by: null,
      users: user,
    });

    // Claim succeeds
    mockRefreshTokens.updateMany.mockResolvedValueOnce({ count: 1 });
    mockRefreshTokens.create.mockResolvedValueOnce({ id: 'rt_new2', token_hash: 'h', expires_at: new Date(), user_id: user.id });
    mockRefreshTokens.update.mockResolvedValueOnce({});

    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: rawToken });

    // The claim updateMany must include revoked_at: null in the where clause
    const claimCall = mockRefreshTokens.updateMany.mock.calls[0][0];
    expect(claimCall.where).toEqual({ id: 'rt_race', revoked_at: null });
    expect(claimCall.data).toEqual({ revoked_at: expect.any(Date) });
  });

  test('concurrent rotation (claim count=0) → 401 REFRESH_REUSE + all user tokens revoked', async () => {
    const user = makeUser();
    const rawToken = crypto.randomBytes(32).toString('hex');

    mockRefreshTokens.findUnique.mockResolvedValueOnce({
      id: 'rt_lost_race',
      user_id: user.id,
      token_hash: hashToken(rawToken),
      expires_at: new Date(Date.now() + 86400000),
      revoked_at: null,
      replaced_by: null,
      users: user,
    });

    // Claim fails — another request got there first
    mockRefreshTokens.updateMany
      .mockResolvedValueOnce({ count: 0 })   // claim fails
      .mockResolvedValueOnce({ count: 2 });  // bulk revoke all user tokens

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: rawToken });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REFRESH_REUSE');

    // Second updateMany call revokes all active tokens for the user
    const bulkRevokeCall = mockRefreshTokens.updateMany.mock.calls[1][0];
    expect(bulkRevokeCall.where).toEqual({ user_id: user.id, revoked_at: null });
  });

  test('banned user → 403 ACCOUNT_BANNED', async () => {
    const user = makeUser({ is_banned: true });
    mockRefreshTokens.findUnique.mockResolvedValueOnce({
      id: 'rt_banned',
      user_id: user.id,
      token_hash: 'hash',
      expires_at: new Date(Date.now() + 86400000),
      revoked_at: null,
      users: user,
    });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: crypto.randomBytes(32).toString('hex') });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_BANNED');
  });
});

/* ------------------------------------------------------------------ */
/*  4. Logout endpoint                                                 */
/* ------------------------------------------------------------------ */
describe('POST /api/auth/logout', () => {
  beforeEach(() => jest.clearAllMocks());

  test('valid token → revoked, returns 200', async () => {
    mockRefreshTokens.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: crypto.randomBytes(32).toString('hex') });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRefreshTokens.updateMany).toHaveBeenCalledTimes(1);
  });

  test('idempotent — second call still returns 200', async () => {
    mockRefreshTokens.updateMany.mockResolvedValue({ count: 0 });

    const token = crypto.randomBytes(32).toString('hex');

    const res1 = await request(app).post('/api/auth/logout').send({ refreshToken: token });
    const res2 = await request(app).post('/api/auth/logout').send({ refreshToken: token });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  test('missing/empty refreshToken → still returns 200 (does not leak info)', async () => {
    const res = await request(app).post('/api/auth/logout').send({});
    expect(res.status).toBe(200);
    expect(mockRefreshTokens.updateMany).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  5. Middleware error codes                                          */
/* ------------------------------------------------------------------ */
describe('Auth middleware error codes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('no token → 401 TOKEN_MISSING', async () => {
    const res = await request(app).get('/api/protected');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_MISSING');
  });

  test('expired token → 403 TOKEN_EXPIRED', async () => {
    const token = jwt.sign({ userId: 'u1', id: 'u1', email: 'a@b.com' }, process.env.JWT_SECRET!, { expiresIn: '0s' });
    // Small delay to ensure expiry
    await new Promise(r => setTimeout(r, 50));

    const res = await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  test('malformed token → 403 TOKEN_INVALID', async () => {
    const res = await request(app)
      .get('/api/protected')
      .set('Authorization', 'Bearer not.a.valid.jwt');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  test('wrong-secret token → 403 TOKEN_INVALID', async () => {
    const token = jwt.sign({ userId: 'u1' }, 'wrong-secret', { expiresIn: '1h' });
    const res = await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  test('banned user → 403 ACCOUNT_BANNED', async () => {
    const token = jwt.sign(
      { userId: 'user_banned', id: 'user_banned', email: 'b@b.com' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    mockUsers.findUnique.mockResolvedValueOnce({ is_banned: true });

    const res = await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_BANNED');
  });
});

/* ------------------------------------------------------------------ */
/*  6. Raw token never persisted                                       */
/* ------------------------------------------------------------------ */
describe('Token security', () => {
  beforeEach(() => jest.clearAllMocks());

  test('stored token_hash ≠ raw token AND equals SHA-256(raw)', async () => {
    const user = makeUser();
    mockUsers.findFirst.mockResolvedValueOnce(user);
    makeCognitoSuccess();

    let storedHash = '';
    mockRefreshTokens.create.mockImplementationOnce((args: any) => {
      storedHash = args.data.token_hash;
      return Promise.resolve({ id: 'rt_sec', ...args.data });
    });

    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Client-Refresh', 'v1')
      .send({ email: user.email, password: 'Test1234!' });

    const rawRefresh = res.body.refreshToken;
    expect(storedHash).not.toBe(rawRefresh);
    expect(storedHash).toBe(hashToken(rawRefresh));
  });
});
