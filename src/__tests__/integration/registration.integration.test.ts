/**
 * Registration Integration Tests
 *
 * Boots a minimal Express app with real authRoutes (real Cognito + real RDS).
 * Rate limiters are bypassed — the test mounts routes without them.
 * Creates persistent test0Y91_-prefixed users — NO teardown/deletion.
 *
 * Run:  npx jest --selectProjects integration --testPathPatterns registration
 *
 * Prerequisites:
 *   - Dev env vars loaded (DATABASE_URL → mulligans-db-dev, COGNITO_*, JWT_SECRET)
 *   - Dev RDS and dev Cognito reachable from the machine running the test
 *
 * Design decisions (see questions.md):
 *   1. Rate limiter: bypassed — mocked to passthrough before importing authRoutes
 *   2. Verification code: read from DB via Prisma after registration
 *   3. Re-run isolation: unique per-run suffix (RUN_ID) in every email/display_name
 */

/* ------------------------------------------------------------------ */
/*  Dev-only guard — abort if env looks like prod                      */
/* ------------------------------------------------------------------ */
const DB_URL = process.env.DATABASE_URL || '';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';

if (!DB_URL.includes('mulligans-db-dev')) {
  throw new Error(
    `SAFETY: DATABASE_URL does not contain "mulligans-db-dev". ` +
    `Refusing to run integration tests against a non-dev database. ` +
    `Actual value prefix: ${DB_URL.slice(0, 30)}…`,
  );
}

if (STRIPE_KEY && !STRIPE_KEY.startsWith('sk_test_')) {
  throw new Error(
    `SAFETY: STRIPE_SECRET_KEY does not start with "sk_test_". ` +
    `Refusing to run integration tests against production Stripe.`,
  );
}

/* ------------------------------------------------------------------ */
/*  Mock rate limiters to passthrough before importing routes          */
/* ------------------------------------------------------------------ */
jest.mock('express-rate-limit', () => {
  return jest.fn(() => (_req: any, _res: any, next: any) => next());
});

import express from 'express';
import type { Server } from 'http';
import authRoutes from '../../routes/authRoutes';
import { prisma } from '../../lib/prisma';

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */
const RUN_ID = Date.now().toString(36);
let server: Server;
let BASE_URL: string;

jest.setTimeout(30_000);

/* ------------------------------------------------------------------ */
/*  Boot a minimal Express app with real auth routes                   */
/* ------------------------------------------------------------------ */
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      BASE_URL = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) server.close();
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function testEmail(slug: string): string {
  return `test0Y91_${RUN_ID}_${slug}@example.com`;
}

function testName(slug: string): string {
  return `test0Y91_${RUN_ID}_${slug}`;
}

async function post(path: string, body: any) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, body: json, headers: res.headers };
}

async function postRaw(path: string, rawBody: string, contentType = 'text/plain') {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: rawBody,
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function getVerificationCode(email: string): Promise<string | null> {
  const user = await prisma.users.findFirst({
    where: { email: email.trim().toLowerCase() },
    select: { verification_code: true },
  });
  return user?.verification_code ?? null;
}

/* ================================================================== */
/*  A — Happy path                                                     */
/* ================================================================== */
describe('A: Registration happy path', () => {
  test('A-01: Register new user with required fields', async () => {
    const email = testEmail('happy');
    const res = await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('Happy User'),
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      requires_verification: true,
    });
    expect(res.body.email).toBe(email.toLowerCase());
    expect(res.body.user_id).toBeDefined();
    expect(res.body.message).toMatch(/verification/i);
  });

  test('A-02: Register with all optional fields', async () => {
    const email = testEmail('full');
    const res = await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('Full User'),
      phone_number: '+447700900001',
      marketing_emails: true,
      sms_marketing_consent: true,
    });

    expect(res.status).toBe(201);

    const dbUser = await prisma.users.findFirst({
      where: { email: email.toLowerCase() },
    });
    expect(dbUser).not.toBeNull();
    expect(dbUser!.phone).toBe('+447700900001');
    expect(dbUser!.marketing_emails).toBe(true);
    expect(dbUser!.sms_marketing_consent).toBe(true);
  });

  test('A-03: Register with no phone number stores null', async () => {
    const email = testEmail('nophone');
    await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('NoPhone'),
    });

    const dbUser = await prisma.users.findFirst({
      where: { email: email.toLowerCase() },
    });
    expect(dbUser!.phone).toBeNull();
  });

  test('A-04: marketing_emails=false explicitly', async () => {
    const email = testEmail('nomarket');
    await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('NoMarket'),
      marketing_emails: false,
    });

    const dbUser = await prisma.users.findFirst({
      where: { email: email.toLowerCase() },
    });
    expect(dbUser!.marketing_emails).toBe(false);
  });

  test('A-05: Email is trimmed and lowercased', async () => {
    const rawEmail = `  ${testEmail('CASETEST').toUpperCase()}  `;
    const expected = testEmail('CASETEST').toLowerCase();

    const res = await post('/api/auth/register', {
      email: rawEmail,
      password: 'Test1234!',
      display_name: testName('Case'),
    });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe(expected);
  });

  test('A-06: Verify email with correct code (read from DB)', async () => {
    const email = testEmail('verify');
    await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('Verify'),
    });

    const code = await getVerificationCode(email);
    expect(code).toMatch(/^\d{6}$/);

    const res = await post('/api/auth/verify-email', { email, code });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user).toMatchObject({
      email: email.toLowerCase(),
      display_name: testName('Verify'),
    });

    const dbUser = await prisma.users.findFirst({
      where: { email: email.toLowerCase() },
    });
    expect(dbUser!.verification_code).toBeNull();
    expect(dbUser!.verification_code_expires).toBeNull();
  });

  test('A-07: Resend verification for existing unverified user', async () => {
    const email = testEmail('resend');
    await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('Resend'),
    });

    const codeBefore = await getVerificationCode(email);

    const res = await post('/api/auth/resend-verification', { email });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/new.*code.*sent/i);

    const codeAfter = await getVerificationCode(email);
    expect(codeAfter).toMatch(/^\d{6}$/);
    expect(codeAfter).not.toBe(codeBefore);
  });
});

/* ================================================================== */
/*  B — Negative / validation failures                                 */
/* ================================================================== */
describe('B: Validation failures — register', () => {
  test('B-01: Missing email field', async () => {
    const res = await post('/api/auth/register', {
      password: 'Test1234!',
      display_name: testName('noemail'),
    });
    expect(res.status).toBe(400);
  });

  test('B-04: Empty string email', async () => {
    const res = await post('/api/auth/register', {
      email: '',
      password: 'Test1234!',
      display_name: testName('empty'),
    });
    expect(res.status).toBe(400);
  });

  test('B-05: Invalid email format', async () => {
    const res = await post('/api/auth/register', {
      email: 'test0Y91_bademail_no_at',
      password: 'Test1234!',
      display_name: testName('bademail'),
    });
    expect(res.status).toBe(400);
  });

  test.each([
    ['B-06', 'Ab1!', 'too short'],
    ['B-07', 'test1234!', 'no uppercase'],
    ['B-08', 'TEST1234!', 'no lowercase'],
    ['B-09', 'TestTest!', 'no numbers'],
  ])('%s: Weak password — %s', async (id, password, _desc) => {
    const res = await post('/api/auth/register', {
      email: testEmail(id.toLowerCase()),
      password,
      display_name: testName(id),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  test('B-17: Empty request body', async () => {
    const res = await post('/api/auth/register', {});
    expect(res.status).toBe(400);
  });

  test('B-18: Non-JSON body', async () => {
    const res = await postRaw('/api/auth/register', 'not json', 'text/plain');
    expect(res.status).toBe(400);
  });
});

describe('B: Validation failures — verify-email', () => {
  test('B-10: Missing email', async () => {
    const res = await post('/api/auth/verify-email', { code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email.*required/i);
  });

  test('B-11: Missing code', async () => {
    const res = await post('/api/auth/verify-email', {
      email: testEmail('nocode'),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/code.*required/i);
  });

  test('B-12: Wrong verification code', async () => {
    const email = testEmail('wrongcode');
    await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('wrongcode'),
    });

    const res = await post('/api/auth/verify-email', {
      email,
      code: '000000',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid verification code/i);
  });

  test('B-13: User not found', async () => {
    const res = await post('/api/auth/verify-email', {
      email: testEmail('ghost_never_registered'),
      code: '123456',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe('B: Validation failures — resend-verification', () => {
  test('B-15: Missing email', async () => {
    const res = await post('/api/auth/resend-verification', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email.*required/i);
  });

  test('B-16: Nonexistent user — no existence leak', async () => {
    const res = await post('/api/auth/resend-verification', {
      email: testEmail('nobody_ever'),
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
  });
});

/* ================================================================== */
/*  C — Boundary / edge cases                                          */
/* ================================================================== */
describe('C: Boundary cases', () => {
  test('C-01: Password exactly 8 chars', async () => {
    const res = await post('/api/auth/register', {
      email: testEmail('minpw'),
      password: 'Aa1!aaaa',
      display_name: testName('minpw'),
    });
    expect(res.status).toBe(201);
  });

  test('C-02: Password 7 chars — under minimum', async () => {
    const res = await post('/api/auth/register', {
      email: testEmail('under8'),
      password: 'Aa1!aaa',
      display_name: testName('under8'),
    });
    expect(res.status).toBe(400);
  });

  test('C-04: Unicode display name', async () => {
    const email = testEmail('unicode');
    const res = await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('Golfer🏌️'),
    });
    expect(res.status).toBe(201);

    const dbUser = await prisma.users.findFirst({
      where: { email: email.toLowerCase() },
    });
    expect(dbUser!.display_name).toContain('🏌️');
  });

  test('C-05: Email with whitespace is trimmed', async () => {
    const baseEmail = testEmail('trimws');
    const res = await post('/api/auth/register', {
      email: `  ${baseEmail}  `,
      password: 'Test1234!',
      display_name: testName('trimws'),
    });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(baseEmail.toLowerCase());
  });

  test('C-07: Empty string phone stores null', async () => {
    const email = testEmail('emptyph');
    await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('emptyph'),
      phone_number: '',
    });
    const dbUser = await prisma.users.findFirst({
      where: { email: email.toLowerCase() },
    });
    expect(dbUser!.phone).toBeNull();
  });

  test('C-11: Verification code with whitespace is trimmed', async () => {
    const email = testEmail('codews');
    await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('codews'),
    });

    const code = await getVerificationCode(email);
    const res = await post('/api/auth/verify-email', {
      email,
      code: ` ${code} `,
    });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });
});

/* ================================================================== */
/*  D — Duplicate / state-based                                        */
/* ================================================================== */
describe('D: Duplicate and state handling', () => {
  test('D-01: Re-register same email → resend verification code', async () => {
    const email = testEmail('dup1');
    await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('dup1'),
    });

    const codeBefore = await getVerificationCode(email);

    const res = await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('dup1_again'),
    });

    expect(res.status).toBe(200);
    expect(res.body.requires_verification).toBe(true);

    const codeAfter = await getVerificationCode(email);
    expect(codeAfter).not.toBe(codeBefore);
  });

  test('D-04: Case-insensitive email collision', async () => {
    const email = testEmail('casedup');
    await post('/api/auth/register', {
      email: email.toLowerCase(),
      password: 'Test1234!',
      display_name: testName('casedup'),
    });

    const res = await post('/api/auth/register', {
      email: email.toUpperCase(),
      password: 'Test1234!',
      display_name: testName('CASEDUP'),
    });

    expect(res.status).toBe(200);
    expect(res.body.requires_verification).toBe(true);
  });

  test('D-07: Verify already-verified user returns error', async () => {
    const email = testEmail('alreadyv');
    await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('alreadyv'),
    });
    const code = await getVerificationCode(email);
    await post('/api/auth/verify-email', { email, code });

    const res = await post('/api/auth/verify-email', {
      email,
      code: '123456',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid verification code/i);
  });
});

/* ================================================================== */
/*  E — Security                                                       */
/* ================================================================== */
describe('E: Security', () => {
  test('E-04: Password not returned in response', async () => {
    const res = await post('/api/auth/register', {
      email: testEmail('nopwleak'),
      password: 'Test1234!',
      display_name: testName('nopwleak'),
    });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('password');
    expect(JSON.stringify(res.body)).not.toContain('Test1234!');
  });

  test('E-05: Password not stored in DB', async () => {
    const email = testEmail('nopwdb');
    await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('nopwdb'),
    });

    const dbUser = await prisma.users.findFirst({
      where: { email: email.toLowerCase() },
    });
    expect(dbUser).not.toHaveProperty('password');
  });

  test('E-06: Verification code not returned in response', async () => {
    const res = await post('/api/auth/register', {
      email: testEmail('nocodeleak'),
      password: 'Test1234!',
      display_name: testName('nocodeleak'),
    });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('verification_code');
    expect(res.body).not.toHaveProperty('verificationCode');
  });

  test('E-08: Resend-verification does not reveal user existence', async () => {
    const res = await post('/api/auth/resend-verification', {
      email: testEmail('nonexist_sec'),
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
  });

  test('E-09: No JWT issued at registration', async () => {
    const res = await post('/api/auth/register', {
      email: testEmail('nojwt'),
      password: 'Test1234!',
      display_name: testName('nojwt'),
    });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('accessToken');
    expect(res.body).not.toHaveProperty('token');
  });

  test('E-10: Extra properties in body are ignored', async () => {
    const email = testEmail('extra');
    const res = await post('/api/auth/register', {
      email,
      password: 'Test1234!',
      display_name: testName('extra'),
      admin: true,
      is_banned: false,
      is_verified_seller: true,
    });
    expect(res.status).toBe(201);

    const dbUser = await prisma.users.findFirst({
      where: { email: email.toLowerCase() },
    });
    expect(dbUser!.is_banned).toBe(false);
    expect(dbUser!.is_verified_seller).toBe(false);
  });
});

/* ================================================================== */
/*  G — Rate limiting (tested in unit suite; integration skips)        */
/* ================================================================== */
describe('G: Rate limiting', () => {
  test.todo('G-02: Fourth signup from same IP → 429 (covered by unit test — rate limiters are mocked here)');
  test.todo('G-03: Signup succeeds after window resets (covered by unit test)');
});
