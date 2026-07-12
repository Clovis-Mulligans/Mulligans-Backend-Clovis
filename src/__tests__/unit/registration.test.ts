/**
 * Registration Regression Tests
 *
 * Covers every test case from output/code/registration-test-plan.md
 * Categories: A (happy path), B (negative), C (boundary), D (duplicate/state),
 *             E (security), F (failure modes), G (rate limiting)
 *
 * Destination:  Mulligans-Backend/src/__tests__/unit/registration.test.ts
 * Run:          npx jest --selectProjects unit --testPathPattern registration
 *
 * All test users use the test0Y91_ prefix.
 * No deletion or teardown — created users remain in place.
 */

/* ------------------------------------------------------------------ */
/*  Environment (must precede any module that reads process.env)       */
/* ------------------------------------------------------------------ */
process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests';
process.env.COGNITO_CLIENT_ID = 'test-cognito-client-id';
process.env.COGNITO_USER_POOL_ID = 'test-user-pool-id';
process.env.AWS_REGION = 'eu-west-2';
process.env.RESEND_API_KEY = 're_test_key';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */
const mockCognitoSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  SignUpCommand: jest.fn((input: any) => ({ _cmd: 'SignUp', input })),
  InitiateAuthCommand: jest.fn((input: any) => ({ _cmd: 'Auth', input })),
  AuthFlowType: { USER_PASSWORD_AUTH: 'USER_PASSWORD_AUTH' },
  AdminConfirmSignUpCommand: jest.fn((input: any) => ({ _cmd: 'AdminConfirm', input })),
  ConfirmSignUpCommand: jest.fn(),
  ForgotPasswordCommand: jest.fn(),
  ConfirmForgotPasswordCommand: jest.fn(),
  ChangePasswordCommand: jest.fn(),
}));

const mockUsers = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  groupBy: jest.fn(),
};
jest.mock('../../lib/prisma', () => ({ prisma: { users: mockUsers } }));

const mockEmail = {
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../../services/emailService', () => mockEmail);

// Passthrough rate limiter so we can test handler logic without IP throttling.
// G-series tests verify the configuration was passed correctly.
const mockRateLimitFactory = jest.fn(
  () => (_req: any, _res: any, next: any) => next(),
);
jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: mockRateLimitFactory,
}));

/* ------------------------------------------------------------------ */
/*  App bootstrap (after mocks, env vars already set)                  */
/* ------------------------------------------------------------------ */
import express from 'express';
import http from 'http';

const authRouter = require('../../routes/authRoutes').default;

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

let server: http.Server;
let BASE: string;

beforeAll((done) => {
  server = app.listen(0, () => {
    const addr = server.address() as any;
    BASE = `http://127.0.0.1:${addr.port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockEmail.sendVerificationEmail.mockResolvedValue(undefined);
  mockEmail.sendWelcomeEmail.mockResolvedValue(undefined);
});

jest.setTimeout(15_000);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
async function post(path: string, body: any, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, body: json, headers: res.headers };
}

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: { ...headers },
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function postRaw(path: string, rawBody: string, contentType = 'text/plain') {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: rawBody,
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function fakeUser(overrides: Record<string, any> = {}) {
  return {
    id: 'user_1718000000000_abc123def',
    cognito_id: 'cognito-sub-abc123',
    email: 'test0y91_default@example.com',
    display_name: 'test0Y91_Default',
    phone: null,
    verification_code: '654321',
    verification_code_expires: new Date(Date.now() + 86_400_000),
    marketing_emails: false,
    sms_marketing_consent: false,
    is_verified_seller: false,
    is_banned: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Cognito send() resolves with a UserSub. */
function cognitoOk(sub = 'cognito-sub-abc123') {
  mockCognitoSend.mockResolvedValueOnce({ UserSub: sub });
}

/** Cognito send() rejects with a named error. */
function cognitoErr(name: string, message = 'Cognito error') {
  const e: any = new Error(message);
  e.name = name;
  mockCognitoSend.mockRejectedValueOnce(e);
}

/** prisma.users.findFirst resolves null (no existing user). */
function noUser() {
  mockUsers.findFirst.mockResolvedValueOnce(null);
}

/** prisma.users.findFirst resolves with a user row. */
function withUser(o: Record<string, any> = {}) {
  const u = fakeUser(o);
  mockUsers.findFirst.mockResolvedValueOnce(u);
  return u;
}

/** prisma.users.create resolves with a user row. */
function dbCreate(o: Record<string, any> = {}) {
  const u = fakeUser(o);
  mockUsers.create.mockResolvedValueOnce(u);
  return u;
}

/** prisma.users.update resolves with a user row. */
function dbUpdate(o: Record<string, any> = {}) {
  const u = fakeUser(o);
  mockUsers.update.mockResolvedValueOnce(u);
  return u;
}

/* ================================================================== */
/*  A — Happy path                                                     */
/* ================================================================== */
describe('A: Registration happy path', () => {
  test('A-01: Register new user with required fields', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_happy@example.com', display_name: 'test0Y91_Happy User' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_happy@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_Happy User',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      requires_verification: true,
      email: 'test0y91_happy@example.com',
    });
    expect(res.body.user_id).toBeDefined();
    expect(res.body.message).toMatch(/verification/i);
    expect(mockEmail.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  test('A-02: Register with all optional fields', async () => {
    cognitoOk();
    noUser();
    dbCreate({
      email: 'test0y91_full@example.com',
      display_name: 'test0Y91_Full User',
      phone: '+447700900001',
      marketing_emails: true,
      sms_marketing_consent: true,
    });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_full@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_Full User',
      phone_number: '+447700900001',
      marketing_emails: true,
      sms_marketing_consent: true,
    });

    expect(res.status).toBe(201);
    const createData = mockUsers.create.mock.calls[0][0].data;
    expect(createData.phone).toBe('+447700900001');
    expect(createData.marketing_emails).toBe(true);
    expect(createData.sms_marketing_consent).toBe(true);
  });

  test('A-03: Register with no phone number stores null', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_nophone@example.com' });

    await post('/api/auth/register', {
      email: 'test0Y91_nophone@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_NoPhone',
    });

    const createData = mockUsers.create.mock.calls[0][0].data;
    expect(createData.phone).toBeNull();
  });

  test('A-04: Register with marketing_emails=false explicitly', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_nomarket@example.com' });

    await post('/api/auth/register', {
      email: 'test0Y91_nomarket@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_NoMarket',
      marketing_emails: false,
    });

    const createData = mockUsers.create.mock.calls[0][0].data;
    expect(createData.marketing_emails).toBe(false);
  });

  test('A-05: Email is trimmed and lowercased', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_case@example.com' });

    const res = await post('/api/auth/register', {
      email: '  Test0Y91_CASE@Example.COM  ',
      password: 'Test1234!',
      display_name: 'test0Y91_Case',
    });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('test0y91_case@example.com');
    // Cognito was called with the normalised email
    const signUpInput = mockCognitoSend.mock.calls[0][0].input;
    expect(signUpInput.Username).toBe('test0y91_case@example.com');
  });

  test('A-06: Verify email with correct code', async () => {
    const user = withUser({
      email: 'test0y91_verify@example.com',
      display_name: 'test0Y91_Verify',
      verification_code: '123456',
      verification_code_expires: new Date(Date.now() + 86_400_000),
    });
    mockCognitoSend.mockResolvedValueOnce({}); // AdminConfirmSignUp
    dbUpdate();

    const res = await post('/api/auth/verify-email', {
      email: 'test0Y91_verify@example.com',
      code: '123456',
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user).toMatchObject({
      id: user.id,
      email: 'test0y91_verify@example.com',
      display_name: 'test0Y91_Verify',
    });
    expect(mockEmail.sendWelcomeEmail).toHaveBeenCalledWith(
      'test0y91_verify@example.com',
      'test0Y91_Verify',
    );
    // Verification fields cleared
    const updateData = mockUsers.update.mock.calls[0][0].data;
    expect(updateData.verification_code).toBeNull();
    expect(updateData.verification_code_expires).toBeNull();
  });

  test('A-07: Resend verification for existing unverified user', async () => {
    withUser({
      email: 'test0y91_resend@example.com',
      verification_code: '111111',
    });
    dbUpdate();

    const res = await post('/api/auth/resend-verification', {
      email: 'test0Y91_resend@example.com',
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/new.*code.*sent/i);
    expect(mockEmail.sendVerificationEmail).toHaveBeenCalledTimes(1);
    // New code written to DB
    const updateData = mockUsers.update.mock.calls[0][0].data;
    expect(updateData.verification_code).toMatch(/^\d{6}$/);
  });
});

/* ================================================================== */
/*  B — Negative / validation failures                                 */
/* ================================================================== */
describe('B: Validation failures — register', () => {
  test('B-01: Missing email field', async () => {
    cognitoErr('InvalidParameterException', 'Missing email');

    const res = await post('/api/auth/register', {
      password: 'Test1234!',
      display_name: 'test0Y91_noemail',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('B-02: Missing password field', async () => {
    cognitoErr('InvalidParameterException', 'Missing password');

    const res = await post('/api/auth/register', {
      email: 'test0Y91_nopw@example.com',
      display_name: 'test0Y91_nopw',
    });

    expect(res.status).toBe(400);
  });

  test('B-03: Missing display_name — Cognito accepts, user created', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_noname@example.com', display_name: undefined });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_noname@example.com',
      password: 'Test1234!',
    });

    // Backend sends undefined display_name to Cognito; if Cognito accepts, 201
    expect(res.status).toBe(201);
  });

  test('B-04: Empty string email', async () => {
    cognitoErr('InvalidParameterException', 'Empty username');

    const res = await post('/api/auth/register', {
      email: '',
      password: 'Test1234!',
      display_name: 'test0Y91_empty',
    });

    expect(res.status).toBe(400);
  });

  test('B-05: Invalid email format (no @)', async () => {
    cognitoErr('InvalidParameterException', 'Invalid email');

    const res = await post('/api/auth/register', {
      email: 'test0Y91_bademail',
      password: 'Test1234!',
      display_name: 'test0Y91_bad',
    });

    expect(res.status).toBe(400);
  });

  test.each([
    ['B-06', 'Ab1!', 'too short (4 chars)'],
    ['B-07', 'test1234!', 'no uppercase'],
    ['B-08', 'TEST1234!', 'no lowercase'],
    ['B-09', 'TestTest!', 'no numbers'],
  ])('%s: Weak password — %s', async (id, password, _desc) => {
    cognitoErr('InvalidPasswordException');

    const res = await post('/api/auth/register', {
      email: `test0Y91_${id.toLowerCase()}@example.com`,
      password,
      display_name: `test0Y91_${id}`,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password must be at least 8 characters/i);
  });

  test('B-17: Empty request body', async () => {
    const res = await post('/api/auth/register', {});

    // rawEmail is undefined → email is undefined → Cognito or trim() throws
    expect(res.status).toBe(400);
  });

  test('B-18: Request body is not JSON', async () => {
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
      email: 'test0Y91_nocode@example.com',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/code.*required/i);
  });

  test('B-12: Wrong verification code', async () => {
    withUser({
      email: 'test0y91_wrongcode@example.com',
      verification_code: '123456',
    });

    const res = await post('/api/auth/verify-email', {
      email: 'test0Y91_wrongcode@example.com',
      code: '999999',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid verification code/i);
  });

  test('B-13: User not found', async () => {
    noUser();

    const res = await post('/api/auth/verify-email', {
      email: 'test0Y91_ghost@example.com',
      code: '123456',
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('B-14: Expired verification code', async () => {
    withUser({
      email: 'test0y91_expired@example.com',
      verification_code: '123456',
      verification_code_expires: new Date(Date.now() - 1000), // 1 second ago
    });

    const res = await post('/api/auth/verify-email', {
      email: 'test0Y91_expired@example.com',
      code: '123456',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });
});

describe('B: Validation failures — resend-verification', () => {
  test('B-15: Missing email', async () => {
    const res = await post('/api/auth/resend-verification', {});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email.*required/i);
  });

  test('B-16: Nonexistent user — no existence leak', async () => {
    noUser();

    const res = await post('/api/auth/resend-verification', {
      email: 'test0Y91_nobody@example.com',
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
    expect(mockEmail.sendVerificationEmail).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  C — Boundary / edge cases                                          */
/* ================================================================== */
describe('C: Boundary cases', () => {
  test('C-01: Password exactly 8 chars meeting all rules', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_minpw@example.com' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_minpw@example.com',
      password: 'Aa1!aaaa', // exactly 8 chars
      display_name: 'test0Y91_min',
    });

    expect(res.status).toBe(201);
  });

  test('C-02: Password 7 chars — just under minimum', async () => {
    cognitoErr('InvalidPasswordException');

    const res = await post('/api/auth/register', {
      email: 'test0Y91_under8@example.com',
      password: 'Aa1!aaa', // 7 chars
      display_name: 'test0Y91_under8',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  test('C-03: Very long password (256 chars)', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_longpw@example.com' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_longpw@example.com',
      password: 'Aa1!' + 'a'.repeat(252),
      display_name: 'test0Y91_long',
    });

    // Cognito may accept or reject; we mocked acceptance
    expect(res.status).toBe(201);
  });

  test('C-04: Display name with Unicode and emoji', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_unicode@example.com', display_name: 'test0Y91_Golfer🏌️' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_unicode@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_Golfer🏌️',
    });

    expect(res.status).toBe(201);
    const createData = mockUsers.create.mock.calls[0][0].data;
    expect(createData.display_name).toBe('test0Y91_Golfer🏌️');
  });

  test('C-05: Email with leading/trailing whitespace', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_trim@example.com' });

    const res = await post('/api/auth/register', {
      email: '  test0Y91_trim@example.com  ',
      password: 'Test1234!',
      display_name: 'test0Y91_trim',
    });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('test0y91_trim@example.com');
  });

  test('C-06: Email with mixed case', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_mixed@example.com' });

    const res = await post('/api/auth/register', {
      email: 'Test0Y91_MIXED@Example.COM',
      password: 'Test1234!',
      display_name: 'test0Y91_mixed',
    });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('test0y91_mixed@example.com');
  });

  test('C-07: Phone number as empty string stores null', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_emptyph@example.com' });

    await post('/api/auth/register', {
      email: 'test0Y91_emptyph@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_emptyph',
      phone_number: '',
    });

    const createData = mockUsers.create.mock.calls[0][0].data;
    expect(createData.phone).toBeNull();
  });

  test('C-08: Display name is whitespace only — backend accepts it', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_ws@example.com', display_name: '   ' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_ws@example.com',
      password: 'Test1234!',
      display_name: '   ',
    });

    expect(res.status).toBe(201);
    const createData = mockUsers.create.mock.calls[0][0].data;
    expect(createData.display_name).toBe('   ');
  });

  test('C-09: Very long email (255+ chars)', async () => {
    cognitoErr('InvalidParameterException', 'Email too long');

    const longEmail = 'test0Y91_' + 'a'.repeat(240) + '@example.com';
    const res = await post('/api/auth/register', {
      email: longEmail,
      password: 'Test1234!',
      display_name: 'test0Y91_longemail',
    });

    expect(res.status).toBe(400);
  });

  test('C-10: Null values for optional fields', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_nullopt@example.com' });

    await post('/api/auth/register', {
      email: 'test0Y91_nullopt@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_nullopt',
      phone_number: null,
      marketing_emails: null,
    });

    const d = mockUsers.create.mock.calls[0][0].data;
    expect(d.phone).toBeNull();         // null || null => null
    expect(d.marketing_emails).toBe(false); // null || false => false
  });

  test('C-11: Verification code with whitespace is trimmed', async () => {
    withUser({
      email: 'test0y91_codews@example.com',
      verification_code: '123456',
      verification_code_expires: new Date(Date.now() + 86_400_000),
    });
    mockCognitoSend.mockResolvedValueOnce({});
    dbUpdate();

    const res = await post('/api/auth/verify-email', {
      email: 'test0Y91_codews@example.com',
      code: ' 123456 ',
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  test('C-12: Verification code wrong length', async () => {
    withUser({
      email: 'test0y91_shortcode@example.com',
      verification_code: '123456',
    });

    const res = await post('/api/auth/verify-email', {
      email: 'test0Y91_shortcode@example.com',
      code: '12345', // 5 digits
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid verification code/i);
  });

  test('C-13: sms_marketing_consent without phone_number', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_smsnoph@example.com' });

    await post('/api/auth/register', {
      email: 'test0Y91_smsnoph@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_smsnoph',
      sms_marketing_consent: true,
    });

    const d = mockUsers.create.mock.calls[0][0].data;
    expect(d.sms_marketing_consent).toBe(true); // backend doesn't gate on phone
    expect(d.phone).toBeNull();
  });
});

/* ================================================================== */
/*  D — Duplicate / state-based                                        */
/* ================================================================== */
describe('D: Duplicate and state handling', () => {
  test('D-01: UsernameExistsException + unverified DB user → resend code', async () => {
    cognitoErr('UsernameExistsException');
    // Handler queries DB for the email inside catch block
    withUser({
      email: 'test0y91_dup1@example.com',
      is_verified_seller: false,
      verification_code: '111111',
    });
    dbUpdate();

    const res = await post('/api/auth/register', {
      email: 'test0Y91_dup1@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_dup1',
    });

    expect(res.status).toBe(200);
    expect(res.body.requires_verification).toBe(true);
    expect(res.body.message).toMatch(/new verification code/i);
    expect(mockEmail.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  test('D-02: UsernameExistsException + verified DB user → 400', async () => {
    cognitoErr('UsernameExistsException');
    withUser({
      email: 'test0y91_dup2@example.com',
      is_verified_seller: true,
    });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_dup2@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_dup2',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists.*log in/i);
  });

  test('D-03: UsernameExistsException + no DB user → 400', async () => {
    cognitoErr('UsernameExistsException');
    noUser(); // no row in DB

    const res = await post('/api/auth/register', {
      email: 'test0Y91_dup3@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_dup3',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists.*log in/i);
  });

  test('D-04: Case-sensitivity collision → normalised to same email', async () => {
    cognitoErr('UsernameExistsException');
    withUser({
      email: 'test0y91_casedup@example.com',
      is_verified_seller: false,
    });
    dbUpdate();

    const res = await post('/api/auth/register', {
      email: 'TEST0Y91_CASEDUP@EXAMPLE.COM',
      password: 'Test1234!',
      display_name: 'test0Y91_caseDup',
    });

    // Lowercased → duplicate detected
    expect(res.status).toBe(200);
    expect(res.body.requires_verification).toBe(true);
  });

  test('D-05: Re-registration — Cognito ok, DB row exists → UPDATE', async () => {
    cognitoOk('cognito-sub-new');
    withUser({
      email: 'test0y91_reregister@example.com',
      cognito_id: 'cognito-sub-old',
    });
    dbUpdate({ cognito_id: 'cognito-sub-new' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_reregister@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_reregister',
    });

    expect(res.status).toBe(201);
    // Updated existing row rather than creating
    expect(mockUsers.update).toHaveBeenCalledTimes(1);
    expect(mockUsers.create).not.toHaveBeenCalled();
    const updateData = mockUsers.update.mock.calls[0][0].data;
    expect(updateData.cognito_id).toBe('cognito-sub-new');
  });

  test('D-06: Concurrent signup — Prisma unique constraint → 400', async () => {
    cognitoOk();
    noUser();
    // Simulate Prisma P2002 unique constraint violation
    const prismaErr: any = new Error('Unique constraint failed on the fields: (`email`)');
    prismaErr.code = 'P2002';
    mockUsers.create.mockRejectedValueOnce(prismaErr);

    const res = await post('/api/auth/register', {
      email: 'test0Y91_race@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_race',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('D-07: Verify already-verified user (verification_code is null)', async () => {
    withUser({
      email: 'test0y91_alreadyv@example.com',
      verification_code: null, // already verified
    });

    const res = await post('/api/auth/verify-email', {
      email: 'test0Y91_alreadyv@example.com',
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
  test('E-01: SQL injection in email — parameterised by Prisma', async () => {
    cognitoErr('InvalidParameterException', 'Invalid email');

    const res = await post('/api/auth/register', {
      email: "test0Y91_sqli'; DROP TABLE users;--@example.com",
      password: 'Test1234!',
      display_name: 'test0Y91_sqli',
    });

    expect(res.status).toBe(400);
    // If it somehow reached Prisma, it would be parameterised, not executed
  });

  test('E-02: XSS in display_name — stored as-is', async () => {
    cognitoOk();
    noUser();
    dbCreate({
      email: 'test0y91_xss@example.com',
      display_name: 'test0Y91_<script>alert(1)</script>',
    });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_xss@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_<script>alert(1)</script>',
    });

    expect(res.status).toBe(201);
    // Value stored raw — output encoding must happen at render time
    const createData = mockUsers.create.mock.calls[0][0].data;
    expect(createData.display_name).toBe('test0Y91_<script>alert(1)</script>');
  });

  test('E-03: Non-string email (object) — handler throws safely', async () => {
    const res = await post('/api/auth/register', {
      email: { $gt: '' },
      password: 'Test1234!',
      display_name: 'test0Y91_nosql',
    });

    // rawEmail?.trim() throws because objects lack .trim()
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('E-04: Password not returned in register response', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_nopwleak@example.com' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_nopwleak@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_nopwleak',
    });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('password');
  });

  test('E-05: Password not stored in DB — no password field in create call', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_nopwdb@example.com' });

    await post('/api/auth/register', {
      email: 'test0Y91_nopwdb@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_nopwdb',
    });

    const createData = mockUsers.create.mock.calls[0][0].data;
    expect(createData).not.toHaveProperty('password');
  });

  test('E-06: Verification code not returned in register response', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_nocodeleak@example.com' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_nocodeleak@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_nocodeleak',
    });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('verification_code');
    expect(res.body).not.toHaveProperty('verificationCode');
  });

  test('E-07: Error messages do not leak stack traces', async () => {
    cognitoErr('SomeInternalError', 'Something broke internally');

    const res = await post('/api/auth/register', {
      email: 'test0Y91_stackleak@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_stackleak',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error).not.toMatch(/at\s+\w+\s+\(/); // no stack frames
    expect(res.body).not.toHaveProperty('stack');
  });

  test('E-08: Resend-verification does not reveal user existence', async () => {
    noUser();

    const res = await post('/api/auth/resend-verification', {
      email: 'test0Y91_nonexist@example.com',
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
  });

  test('E-09: No JWT issued at registration — only after verification', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_nojwt@example.com' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_nojwt@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_nojwt',
    });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('accessToken');
    expect(res.body).not.toHaveProperty('token');
  });

  test('E-10: Extra/malicious properties in body are ignored', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_extra@example.com' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_extra@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_extra',
      admin: true,
      role: 'superadmin',
      is_banned: false,
      is_verified_seller: true,
    });

    expect(res.status).toBe(201);
    const d = mockUsers.create.mock.calls[0][0].data;
    expect(d).not.toHaveProperty('admin');
    expect(d).not.toHaveProperty('role');
    // is_banned and is_verified_seller should not be settable via registration
    expect(d).not.toHaveProperty('is_banned');
    expect(d).not.toHaveProperty('is_verified_seller');
  });

  test('E-11: Extremely long display_name (10K+ chars)', async () => {
    cognitoOk();
    noUser();
    const longName = 'test0Y91_' + 'A'.repeat(10_000);
    dbCreate({ email: 'test0y91_bomb@example.com', display_name: longName });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_bomb@example.com',
      password: 'Test1234!',
      display_name: longName,
    });

    // Backend has no length validation — accepts it
    expect(res.status).toBe(201);
    const d = mockUsers.create.mock.calls[0][0].data;
    expect(d.display_name.length).toBeGreaterThan(10_000);
  });

  test('E-12: HTML injection in email', async () => {
    cognitoErr('InvalidParameterException', 'Invalid email');

    const res = await post('/api/auth/register', {
      email: 'test0Y91_html<b>bold</b>@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_html',
    });

    expect(res.status).toBe(400);
  });
});

/* ================================================================== */
/*  F — Integration failure modes (mocked)                             */
/* ================================================================== */
describe('F: Failure modes', () => {
  test('F-01: Cognito returns no UserSub → 500', async () => {
    mockCognitoSend.mockResolvedValueOnce({ UserSub: null });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_nosub@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_nosub',
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to get user id/i);
  });

  test('F-02: Email service failure on registration — non-fatal', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_emailfail@example.com' });
    mockEmail.sendVerificationEmail.mockRejectedValueOnce(new Error('Resend down'));

    const res = await post('/api/auth/register', {
      email: 'test0Y91_emailfail@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_emailfail',
    });

    // Registration succeeds despite email failure
    expect(res.status).toBe(201);
    expect(res.body.requires_verification).toBe(true);
  });

  test('F-03: Email service failure on resend-verification → 500', async () => {
    withUser({ email: 'test0y91_resendfail@example.com' });
    dbUpdate();
    mockEmail.sendVerificationEmail.mockRejectedValueOnce(new Error('Resend down'));

    const res = await post('/api/auth/resend-verification', {
      email: 'test0Y91_resendfail@example.com',
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to send/i);
  });

  test('F-04: Welcome email failure on verify — non-fatal', async () => {
    withUser({
      email: 'test0y91_welcomefail@example.com',
      verification_code: '123456',
      verification_code_expires: new Date(Date.now() + 86_400_000),
    });
    mockCognitoSend.mockResolvedValueOnce({});
    dbUpdate();
    mockEmail.sendWelcomeEmail.mockRejectedValueOnce(new Error('Resend down'));

    const res = await post('/api/auth/verify-email', {
      email: 'test0Y91_welcomefail@example.com',
      code: '123456',
    });

    // Verification succeeds despite welcome email failure
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  test('F-05: Database unavailable during registration → 400', async () => {
    cognitoOk();
    mockUsers.findFirst.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await post('/api/auth/register', {
      email: 'test0Y91_dbdown@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_dbdown',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('F-06: Database unavailable during verify-email → 400', async () => {
    mockUsers.findFirst.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await post('/api/auth/verify-email', {
      email: 'test0Y91_dbdownverify@example.com',
      code: '123456',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('F-07: AdminConfirmSignUp fails (non-NotAuthorizedException) — non-fatal', async () => {
    withUser({
      email: 'test0y91_cognitofail@example.com',
      display_name: 'test0Y91_cognitofail',
      verification_code: '123456',
      verification_code_expires: new Date(Date.now() + 86_400_000),
    });
    // AdminConfirm throws InternalErrorException
    const e: any = new Error('Internal');
    e.name = 'InternalErrorException';
    mockCognitoSend.mockRejectedValueOnce(e);
    dbUpdate();

    const res = await post('/api/auth/verify-email', {
      email: 'test0Y91_cognitofail@example.com',
      code: '123456',
    });

    // Verification still succeeds — Cognito failure is non-fatal
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  test('F-08: AdminConfirmSignUp fails (NotAuthorizedException — already confirmed) — silent', async () => {
    withUser({
      email: 'test0y91_alreadyconfirm@example.com',
      display_name: 'test0Y91_alreadyConfirm',
      verification_code: '123456',
      verification_code_expires: new Date(Date.now() + 86_400_000),
    });
    const e: any = new Error('User already confirmed');
    e.name = 'NotAuthorizedException';
    mockCognitoSend.mockRejectedValueOnce(e);
    dbUpdate();

    const res = await post('/api/auth/verify-email', {
      email: 'test0Y91_alreadyconfirm@example.com',
      code: '123456',
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  test('F-09: Prisma unique constraint on email during create → 400', async () => {
    cognitoOk();
    noUser();
    const e: any = new Error('Unique constraint failed on the fields: (`email`)');
    e.code = 'P2002';
    mockUsers.create.mockRejectedValueOnce(e);

    const res = await post('/api/auth/register', {
      email: 'test0Y91_p2002@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_p2002',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('F-10: Prisma unique constraint on cognito_id → 400', async () => {
    cognitoOk('cognito-sub-duplicate');
    noUser();
    const e: any = new Error('Unique constraint failed on the fields: (`cognito_id`)');
    e.code = 'P2002';
    mockUsers.create.mockRejectedValueOnce(e);

    const res = await post('/api/auth/register', {
      email: 'test0Y91_cogdup@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_cogdup',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});

/* ================================================================== */
/*  G — Rate limiting (configuration verification)                     */
/* ================================================================== */
describe('G: Rate limiting', () => {
  test('G-01 / G-04: Signup rate limiter configured with correct params', () => {
    const calls = mockRateLimitFactory.mock.calls as any[][];
    const signupCall = calls.find((args) => args[0]?.max === 3);
    expect(signupCall).toBeDefined();
    expect(signupCall![0]).toMatchObject({
      windowMs: 60 * 60 * 1000,
      max: 3,
      standardHeaders: true,
      legacyHeaders: false,
    });
  });

  test('G-01 (cont): Login rate limiter configured separately', () => {
    const calls = mockRateLimitFactory.mock.calls as any[][];
    const loginCall = calls.find((args) => args[0]?.max === 5);
    expect(loginCall).toBeDefined();
    expect(loginCall![0]).toMatchObject({
      windowMs: 15 * 60 * 1000,
      max: 5,
    });
  });

  // These require a real rate limiter against a running server:
  test.todo('G-02: Fourth signup from same IP within 1 hour → 429');
  test.todo('G-03: Signup succeeds after rate limit window resets');
});

/* ================================================================== */
/*  H — signup_platform capture                                        */
/* ================================================================== */
describe('H: signup_platform capture', () => {
  test('H-01: Registration with signup_platform=ios persists the value', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_plat_ios@example.com', signup_platform: 'ios' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_plat_ios@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_plat_ios',
      signup_platform: 'ios',
    });

    expect(res.status).toBe(201);
    const createCall = mockUsers.create.mock.calls[0][0];
    expect(createCall.data.signup_platform).toBe('ios');
  });

  test('H-02: Registration with signup_platform=android persists the value', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_plat_android@example.com', signup_platform: 'android' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_plat_android@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_plat_android',
      signup_platform: 'android',
    });

    expect(res.status).toBe(201);
    const createCall = mockUsers.create.mock.calls[0][0];
    expect(createCall.data.signup_platform).toBe('android');
  });

  test('H-03: Registration with signup_platform=web persists the value', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_plat_web@example.com', signup_platform: 'web' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_plat_web@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_plat_web',
      signup_platform: 'web',
    });

    expect(res.status).toBe(201);
    const createCall = mockUsers.create.mock.calls[0][0];
    expect(createCall.data.signup_platform).toBe('web');
  });

  test('H-04: Registration without signup_platform stores null', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_plat_none@example.com' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_plat_none@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_plat_none',
    });

    expect(res.status).toBe(201);
    const createCall = mockUsers.create.mock.calls[0][0];
    expect(createCall.data.signup_platform).toBeNull();
  });

  test('H-05: Registration with invalid signup_platform stores null', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_plat_bad@example.com' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_plat_bad@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_plat_bad',
      signup_platform: 'windows',
    });

    expect(res.status).toBe(201);
    const createCall = mockUsers.create.mock.calls[0][0];
    expect(createCall.data.signup_platform).toBeNull();
  });

  test('H-06: signup_platform is case-insensitive (IOS → ios)', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_plat_case@example.com', signup_platform: 'ios' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_plat_case@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_plat_case',
      signup_platform: 'IOS',
    });

    expect(res.status).toBe(201);
    const createCall = mockUsers.create.mock.calls[0][0];
    expect(createCall.data.signup_platform).toBe('ios');
  });

  test('H-07: signup_platform injection attempt stores null', async () => {
    cognitoOk();
    noUser();
    dbCreate({ email: 'test0y91_plat_inject@example.com' });

    const res = await post('/api/auth/register', {
      email: 'test0Y91_plat_inject@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_plat_inject',
      signup_platform: "'; DROP TABLE users; --",
    });

    expect(res.status).toBe(201);
    const createCall = mockUsers.create.mock.calls[0][0];
    expect(createCall.data.signup_platform).toBeNull();
  });

  test('H-08: Re-registration does not overwrite existing signup_platform', async () => {
    cognitoOk();
    withUser({ email: 'test0y91_plat_reregister@example.com', signup_platform: 'ios' });
    dbUpdate({ email: 'test0y91_plat_reregister@example.com', signup_platform: 'ios' });

    await post('/api/auth/register', {
      email: 'test0Y91_plat_reregister@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_plat_reregister',
      signup_platform: 'android',
    });

    const updateCall = mockUsers.update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('signup_platform');
  });

  test('H-09: Re-registration backfills signup_platform if previously null', async () => {
    cognitoOk();
    withUser({ email: 'test0y91_plat_backfill@example.com', signup_platform: null });
    dbUpdate({ email: 'test0y91_plat_backfill@example.com', signup_platform: 'android' });

    await post('/api/auth/register', {
      email: 'test0Y91_plat_backfill@example.com',
      password: 'Test1234!',
      display_name: 'test0Y91_plat_backfill',
      signup_platform: 'android',
    });

    const updateCall = mockUsers.update.mock.calls[0][0];
    expect(updateCall.data.signup_platform).toBe('android');
  });
});
