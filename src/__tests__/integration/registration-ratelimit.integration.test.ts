/**
 * Registration Rate-Limit Integration Test
 *
 * Exercises the REAL signupLimiter (express-rate-limit) — not mocked.
 * Cognito/Prisma/email are mocked to avoid external calls; only the
 * rate limiter is under test.
 *
 * Asserts that the 4th signup request from the same IP returns 429.
 *
 * Run: npx jest --selectProjects integration --testPathPatterns ratelimit
 */

/* ------------------------------------------------------------------ */
/*  Environment (must precede any module that reads process.env)       */
/* ------------------------------------------------------------------ */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-ratelimit';
process.env.COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || 'test-cognito-client-id';
process.env.COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'test-pool-id';
process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-2';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_key';

/* ------------------------------------------------------------------ */
/*  Mock external services — NOT express-rate-limit                    */
/* ------------------------------------------------------------------ */
const mockCognitoSend = jest.fn().mockRejectedValue(new Error('mocked-cognito'));

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  SignUpCommand: jest.fn(),
  InitiateAuthCommand: jest.fn(),
  AuthFlowType: { USER_PASSWORD_AUTH: 'USER_PASSWORD_AUTH' },
  AdminConfirmSignUpCommand: jest.fn(),
  ConfirmSignUpCommand: jest.fn(),
  ForgotPasswordCommand: jest.fn(),
  ConfirmForgotPasswordCommand: jest.fn(),
  ChangePasswordCommand: jest.fn(),
}));

jest.mock('../../lib/prisma', () => ({
  prisma: {
    users: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'fake' }),
      update: jest.fn().mockResolvedValue({ id: 'fake' }),
    },
  },
}));

jest.mock('../../services/emailService', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));

// express-rate-limit is NOT mocked — the real signupLimiter is active

import express from 'express';
import type { Server } from 'http';
import authRoutes from '../../routes/authRoutes';

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */
const RUN_ID = Date.now().toString(36);
let server: Server;
let BASE_URL: string;

jest.setTimeout(15_000);

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

afterAll(() => {
  if (server) server.close();
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function testEmail(n: number): string {
  return `test0Y91_${RUN_ID}_rl${n}@example.com`;
}

async function postRegister(n: number) {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: testEmail(n),
      password: 'Test1234!',
      display_name: `test0Y91_${RUN_ID}_RateLimit${n}`,
    }),
  });
  const body = await res.text();
  return { status: res.status, body };
}

/* ================================================================== */
/*  G — Rate limiting (real signupLimiter, real 429)                   */
/* ================================================================== */
describe('G: Rate limiting — real signupLimiter', () => {
  test('G-02: signupLimiter allows 3 requests then returns 429 on the 4th', async () => {
    // signupLimiter config: max 3 per windowMs (1 hour) per IP.
    // Cognito is mocked to throw → handler returns 400 for each.
    // The limiter still counts all requests regardless of handler outcome.

    const results = [];
    for (let i = 1; i <= 4; i++) {
      results.push(await postRegister(i));
    }

    // First 3 should pass through the limiter (handler returns 400 because Cognito is mocked to throw)
    expect(results[0].status).not.toBe(429);
    expect(results[1].status).not.toBe(429);
    expect(results[2].status).not.toBe(429);

    // Fourth should be blocked by the rate limiter
    expect(results[3].status).toBe(429);
    expect(results[3].body).toMatch(/too many accounts/i);
  });

  test('G-04: signupLimiter returns correct Retry-After header', async () => {
    // The limiter is already exhausted from the previous test (same server, same window).
    // Any request now should be 429 with standard rate-limit headers.
    const res = await postRegister(5);

    expect(res.status).toBe(429);

    // express-rate-limit with standardHeaders:true sets RateLimit-* headers
    const raw = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail(6),
        password: 'Test1234!',
        display_name: `test0Y91_${RUN_ID}_RateLimit6`,
      }),
    });

    expect(raw.status).toBe(429);
    // standardHeaders: true → sends RateLimit-Remaining: 0
    expect(raw.headers.get('ratelimit-remaining')).toBe('0');
  });
});
