/**
 * Platform Stats Admin Endpoint Tests
 *
 * Verifies GET /admin/platform-stats is guarded by adminAuth
 * and returns correct aggregate counts.
 *
 * Run: npx jest --selectProjects unit platformStats
 */

process.env.DISPUTE_ADMIN_PASSWORD = 'test-admin-password';
process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests';
process.env.COGNITO_CLIENT_ID = 'test-cognito-client-id';
process.env.COGNITO_USER_POOL_ID = 'test-user-pool-id';
process.env.AWS_REGION = 'eu-west-2';
process.env.RESEND_API_KEY = 're_test_key';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

const mockGroupBy = jest.fn();
const mockUsers = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  groupBy: mockGroupBy,
};
jest.mock('../../lib/prisma', () => ({ prisma: { users: mockUsers } }));

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: jest.fn() })),
  SignUpCommand: jest.fn(),
  InitiateAuthCommand: jest.fn(),
  AuthFlowType: { USER_PASSWORD_AUTH: 'USER_PASSWORD_AUTH' },
  AdminConfirmSignUpCommand: jest.fn(),
  ConfirmSignUpCommand: jest.fn(),
  ForgotPasswordCommand: jest.fn(),
  ConfirmForgotPasswordCommand: jest.fn(),
  ChangePasswordCommand: jest.fn(),
}));

jest.mock('../../services/emailService', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendInsuranceClaimApprovedToBuyer: jest.fn(),
  sendInsuranceClaimApprovedToSeller: jest.fn(),
  sendInsuranceClaimDeniedToBuyer: jest.fn(),
  sendInsuranceClaimDeniedToSeller: jest.fn(),
}));

jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({}));
});

jest.mock('../../controllers/pushNotificationController', () => ({
  sendPushNotification: jest.fn(),
}));

jest.mock('../../lib/auditLogger', () => ({
  logAdminAction: jest.fn(),
  AUDIT_ACTIONS: {},
}));

jest.mock('../../lib/stockUtils', () => ({
  restoreListingStock: jest.fn(),
}));

jest.mock('../../constants/inspection', () => ({
  INSPECTION_WINDOW_MS: 72 * 60 * 60 * 1000,
}));

jest.mock('../../controllers/disputeController', () => ({
  DisputeController: {
    getAdminDisputes: jest.fn(),
    getAdminDisputeDetail: jest.fn(),
    adminResolveDispute: jest.fn(),
  },
}));

jest.mock('../../controllers/adminReportsController', () => ({
  AdminReportsController: {
    getReports: jest.fn(),
    getReport: jest.fn(),
    updateReport: jest.fn(),
    banUser: jest.fn(),
  },
}));

jest.mock('../../controllers/adminStatsController', () => ({
  AdminStatsController: {
    getStats: jest.fn(),
    getChartData: jest.fn(),
    getDetailedStats: jest.fn(),
  },
}));

import express from 'express';
import http from 'http';

const adminRouter = require('../../routes/adminRoutes').default;

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);

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
});

jest.setTimeout(15_000);

async function getAdminToken(): Promise<string> {
  const res = await fetch(`${BASE}/admin/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-admin-password' }),
  });
  const data: any = await res.json();
  return data.token;
}

describe('GET /admin/platform-stats', () => {
  test('returns 401 with no auth header', async () => {
    const res = await fetch(`${BASE}/admin/platform-stats`);
    expect(res.status).toBe(401);
  });

  test('returns 401 with a regular user JWT (not admin session)', async () => {
    const jwt = require('jsonwebtoken');
    const userToken = jwt.sign(
      { userId: 'user_123', email: 'test0Y91_nonadmin@example.com' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );

    const res = await fetch(`${BASE}/admin/platform-stats`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.error).toMatch(/invalid|expired/i);
  });

  test('returns 200 with valid admin session token', async () => {
    const adminToken = await getAdminToken();

    mockGroupBy.mockResolvedValueOnce([
      { signup_platform: 'ios', _count: { _all: 5 } },
      { signup_platform: 'android', _count: { _all: 3 } },
      { signup_platform: 'web', _count: { _all: 2 } },
      { signup_platform: null, _count: { _all: 10 } },
    ]);

    const res = await fetch(`${BASE}/admin/platform-stats`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({ ios: 5, android: 3, web: 2, unknown: 10 });
  });

  test('returns 401 with wrong admin password (legacy auth)', async () => {
    const res = await fetch(`${BASE}/admin/platform-stats`, {
      headers: { Authorization: 'Admin wrong-password' },
    });
    expect(res.status).toBe(401);
  });

  test('returns 200 with correct admin password (legacy auth)', async () => {
    mockGroupBy.mockResolvedValueOnce([]);

    const res = await fetch(`${BASE}/admin/platform-stats`, {
      headers: { Authorization: 'Admin test-admin-password' },
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({ ios: 0, android: 0, web: 0, unknown: 0 });
  });
});
