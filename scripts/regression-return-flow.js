#!/usr/bin/env node
/* scripts/regression-return-flow.js  (v2)
 * Self-contained regression for the refund-model validation (60% cap) + C1
 * return_request API exposure. Run on the dev EC2 from the app directory:
 *
 *     node scripts/regression-return-flow.js
 *
 * v2: correct dispute route (POST /api/disputes), tightened assertions so
 * "Route not found" can never satisfy an "order not found" expectation.
 */

const fs = require('fs');
const path = require('path');

const envText = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
if (!env.JWT_SECRET) { console.error('JWT_SECRET not found in .env'); process.exit(1); }

const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BASE = process.env.BASE_URL || 'http://localhost:3001/api';
const FAKE_ORDER = '00000000-0000-0000-0000-000000000000';
let pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { console.log(`PASS  ${name}`); pass++; }
  else { console.log(`FAIL  ${name}`); if (detail) console.log(`      ${detail}`); fail++; }
}

async function api(method, route, token, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text };
}

// Correct route: POST /api/disputes (openDispute). Superset of plausible
// body field names so missing-field checks are satisfied regardless of casing.
async function openDispute(token, percent) {
  return api('POST', '/disputes', token, {
    orderId: FAKE_ORDER,
    order_id: FAKE_ORDER,
    reason: 'wrong_item',
    description: 'automated regression test',
    requestedRefundPercent: percent,
    requested_refund_percent: percent,
    willingToReturn: true,
    willing_to_return: true,
  });
}

const RULE_MSG = /Partial refunds can be up to 60/i;
// "order ... not found" but explicitly NOT the router's "Route not found"
function isOrderNotFound(text) {
  return /not found/i.test(text) && !/route not found/i.test(text);
}

(async () => {
  console.log('== Setup: find a buyer with an order in dev DB ==');
  const order = await prisma.orders.findFirst({
    orderBy: { created_at: 'desc' },
    select: { id: true, buyer_id: true, status: true },
  });
  if (!order) { console.error('No orders in dev DB — cannot proceed.'); process.exit(1); }
  const user = await prisma.users.findUnique({ where: { id: order.buyer_id }, select: { id: true, email: true } });
  console.log(`Using buyer ${user.email || user.id}, order ${order.id} (${order.status})`);

  const token = jwt.sign(
    { userId: user.id, sub: user.id, id: user.id, email: user.email || undefined },
    env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  const me = await api('GET', `/orders/${order.id}`, token);
  if (me.status === 401 || me.status === 403) {
    console.error(`Minted token rejected (${me.status}):`); console.error(me.text.slice(0, 300));
    process.exit(1);
  }
  console.log('Token accepted.\n');

  console.log('== Refund-model validation (writes nothing; fake order id) ==');
  let r = await openDispute(token, 70);
  check('70% rejected with rule message', RULE_MSG.test(r.text), `status ${r.status}: ${r.text.slice(0, 250)}`);

  r = await openDispute(token, 65);
  check('65% (off-step) rejected with rule message', RULE_MSG.test(r.text), `status ${r.status}: ${r.text.slice(0, 250)}`);

  r = await openDispute(token, 60);
  check('60% passes validation (dies at ORDER lookup, not percent gate)',
    isOrderNotFound(r.text) && !RULE_MSG.test(r.text),
    `status ${r.status}: ${r.text.slice(0, 250)}`);

  r = await openDispute(token, 100);
  check('100 passes validation (dies at ORDER lookup)',
    isOrderNotFound(r.text) && !RULE_MSG.test(r.text),
    `status ${r.status}: ${r.text.slice(0, 250)}`);

  console.log('\n== C1: return_request exposure on order detail ==');
  check('GET /orders/:id contains return_request key', /"return_request"/.test(me.text), me.text.slice(0, 300));

  const ret = await prisma.return_requests.findFirst({
    orderBy: { created_at: 'desc' },
    select: { id: true, order_id: true, status: true, return_ship_deadline: true },
  });
  if (ret) {
    const retOrder = await prisma.orders.findUnique({ where: { id: ret.order_id }, select: { buyer_id: true } });
    const retToken = jwt.sign({ userId: retOrder.buyer_id, sub: retOrder.buyer_id, id: retOrder.buyer_id }, env.JWT_SECRET, { expiresIn: '1h' });
    const rd = await api('GET', `/orders/${ret.order_id}`, retToken);
    check('order-with-return exposes return_ship_deadline field', /"return_ship_deadline"/.test(rd.text), rd.text.slice(0, 300));
    console.log(`      (return ${ret.id}, status ${ret.status}, deadline ${ret.return_ship_deadline})`);
  } else {
    console.log('SKIP  no return rows in dev DB');
  }

  console.log('\n== Constants check: 5-day deadline (compiled) ==');
  const compiled = fs.readFileSync(path.join(__dirname, '..', 'dist', 'config', 'constants.js'), 'utf8');
  const m = compiled.match(/RETURN_SHIPPING_DEADLINE_DAYS\s*=\s*(\d+)/);
  check('compiled RETURN_SHIPPING_DEADLINE_DAYS === 5', m && m[1] === '5', m ? `found ${m[1]}` : 'constant not found');

  console.log('\n==============================');
  console.log(`Result: ${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? 'GREEN — cleared for prod deploy' : 'Investigate failures before prod deploy');
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('Script error:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});