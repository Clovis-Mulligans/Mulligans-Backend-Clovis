// Integration tests — hit a real running backend (local or staging).
// Set TEST_API_URL (default http://localhost:3000) and optionally TEST_AUTH_TOKEN.
// All tests here are READ-ONLY. No mutations, no Stripe, no DB writes.

const API_URL = process.env.TEST_API_URL || 'http://localhost:3000';
const AUTH_TOKEN = process.env.TEST_AUTH_TOKEN;

const AUTH_HEADERS: Record<string, string> = AUTH_TOKEN
  ? { Authorization: `Bearer ${AUTH_TOKEN}` }
  : {};

const describeAuth = AUTH_TOKEN ? describe : describe.skip;

jest.setTimeout(30_000);

async function getJson(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe('health & infrastructure', () => {
  test('GET /health returns 200', async () => {
    const { status } = await getJson('/health');
    expect(status).toBe(200);
  });
});

describe('public endpoints (no auth required)', () => {
  test('GET /api/search?q=driver returns 200 with listings array', async () => {
    const { status, body } = await getJson('/api/search?q=driver');
    expect(status).toBe(200);
    expect(Array.isArray(body?.listings)).toBe(true);
  });

  test('search listings include required card fields', async () => {
    const { body } = await getJson('/api/search?q=driver');
    if (Array.isArray(body?.listings) && body.listings.length > 0) {
      const listing = body.listings[0];
      expect(listing).toHaveProperty('id');
      expect(listing).toHaveProperty('title');
      expect(listing).toHaveProperty('price');
      expect(listing).toHaveProperty('seller_id');
      expect(listing).toHaveProperty('category');
      expect(listing).toHaveProperty('created_at');
      expect(Number.isFinite(parseFloat(String(listing.price)))).toBe(true);
    }
  });

  test('empty search returns 200 with an empty array, not an error', async () => {
    const { status, body } = await getJson('/api/search?q=zzzzzzzzzzzzzz_unlikely_query');
    expect(status).toBe(200);
    expect(Array.isArray(body?.listings)).toBe(true);
  });

  test('GET /api/listings/:nonexistent returns 404 (not 500)', async () => {
    const { status } = await getJson('/api/listings/00000000-0000-0000-0000-000000000000');
    expect(status).toBe(404);
  });

  test('GET /api/shipping/parcel-sizes returns array with name + cost', async () => {
    const { status, body } = await getJson('/api/shipping/parcel-sizes');
    expect(status).toBe(200);
    const arr = Array.isArray(body) ? body : body?.sizes;
    expect(Array.isArray(arr)).toBe(true);
    if (arr.length > 0) {
      expect(arr[0]).toHaveProperty('name');
      expect(arr[0]).toHaveProperty('cost');
    }
  });

  test('GET /api/search/suggestions?q=tay returns array', async () => {
    const { status, body } = await getJson('/api/search/suggestions?q=tay');
    expect(status).toBe(200);
    const arr = Array.isArray(body) ? body : body?.suggestions;
    expect(Array.isArray(arr)).toBe(true);
  });
});

describe('auth protection — must return 401 without token', () => {
  const protectedRoutes: Array<[string, RequestInit]> = [
    ['/api/cart', {}],
    ['/api/notifications', {}],
    ['/api/orders/my-purchases', {}],
    ['/api/offers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
  ];

  test.each(protectedRoutes)('%s without token → 401', async (path, init) => {
    const { status } = await getJson(path, init);
    expect(status).toBe(401);
  });
});

describeAuth('authenticated endpoints (requires TEST_AUTH_TOKEN)', () => {
  test('GET /api/cart returns { items: [...] }', async () => {
    const { status, body } = await getJson('/api/cart', { headers: AUTH_HEADERS });
    expect(status).toBe(200);
    expect(Array.isArray(body?.items)).toBe(true);
  });

  test('GET /api/cart/count returns { count: number }', async () => {
    const { status, body } = await getJson('/api/cart/count', { headers: AUTH_HEADERS });
    expect(status).toBe(200);
    expect(typeof body?.count).toBe('number');
  });

  test('GET /api/notifications returns array with expected fields', async () => {
    const { status, body } = await getJson('/api/notifications', { headers: AUTH_HEADERS });
    expect(status).toBe(200);
    const arr = Array.isArray(body) ? body : body?.notifications;
    expect(Array.isArray(arr)).toBe(true);
    if (arr.length > 0) {
      const n = arr[0];
      expect(n).toHaveProperty('id');
      expect(n).toHaveProperty('type');
      expect(n).toHaveProperty('title');
      expect(n).toHaveProperty('message');
      expect(n).toHaveProperty('is_read');
    }
  });

  test('GET /api/auth/profile returns id, email, display_name', async () => {
    const { status, body } = await getJson('/api/auth/profile', { headers: AUTH_HEADERS });
    expect(status).toBe(200);
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('email');
    expect(body).toHaveProperty('display_name');
  });

  test('GET /api/offers/counts returns object with total number', async () => {
    const { status, body } = await getJson('/api/offers/counts', { headers: AUTH_HEADERS });
    expect(status).toBe(200);
    expect(typeof body?.total).toBe('number');
  });
});

describe('error response contract', () => {
  test('error responses use consistent { error } shape, not raw crash', async () => {
    const { status, body } = await getJson('/api/listings/not-a-real-id');
    expect([400, 404]).toContain(status);
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
  });
});
