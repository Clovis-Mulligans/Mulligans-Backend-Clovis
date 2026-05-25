import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const router = Router();

interface EmailActionPayload {
  orderId: string;
  buyerId: string;
  action: 'confirm-receipt' | 'report-issue';
}

function verifyEmailActionToken(token: string): EmailActionPayload {
  const payload = jwt.verify(token, process.env.JWT_SECRET!) as EmailActionPayload & { exp: number };
  if (!payload.orderId || !payload.buyerId || !payload.action) {
    throw new Error('Invalid token payload');
  }
  return payload;
}

export function generateEmailActionToken(
  orderId: string,
  buyerId: string,
  action: 'confirm-receipt' | 'report-issue',
  expiresAt: Date,
): string {
  const expiresInSeconds = Math.max(
    60,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  );
  return jwt.sign(
    { orderId, buyerId, action },
    process.env.JWT_SECRET!,
    { expiresIn: expiresInSeconds },
  );
}

// GET /api/email-actions/confirm-receipt?token=<JWT>
router.get('/confirm-receipt', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) {
      return res.status(400).send(renderPage('Missing Token', 'This link is invalid. Please open the Mulligans app to confirm your order.'));
    }

    let payload: EmailActionPayload;
    try {
      payload = verifyEmailActionToken(token);
    } catch {
      return res.status(401).send(renderPage('Link Expired', 'This link has expired. Please open the Mulligans app to confirm your order.'));
    }

    if (payload.action !== 'confirm-receipt') {
      return res.status(400).send(renderPage('Invalid Link', 'This link is not valid for this action.'));
    }

    const order = await prisma.orders.findUnique({
      where: { id: payload.orderId },
      select: {
        id: true,
        buyer_id: true,
        status: true,
        escrow_release_at: true,
        listings: { select: { title: true } },
      },
    });

    if (!order) {
      return res.status(404).send(renderPage('Order Not Found', 'This order could not be found.'));
    }

    if (order.buyer_id !== payload.buyerId) {
      return res.status(403).send(renderPage('Unauthorized', 'You are not authorized to confirm this order.'));
    }

    if (order.status !== 'delivered') {
      return res.status(400).send(renderPage('Already Processed', 'This order has already been confirmed or is no longer in the inspection window.'));
    }

    // Try deep link first, fall back to web
    const deepLink = `mulligans://orders/${payload.orderId}/confirm-receipt`;
    const itemTitle = order.listings?.title || 'your item';

    return res.send(renderActionPage(
      'Confirm & Release Payment',
      `Ready to confirm receipt of "${itemTitle}"? This will release payment to the seller.`,
      deepLink,
      `/api/email-actions/confirm-receipt/execute?token=${encodeURIComponent(token)}`,
    ));
  } catch (error) {
    console.error('[EMAIL-ACTION] Confirm receipt error:', error);
    return res.status(500).send(renderPage('Error', 'Something went wrong. Please try again in the Mulligans app.'));
  }
});

// GET /api/email-actions/confirm-receipt/execute?token=<JWT>
// Actually performs the confirmation (web fallback when app not installed)
router.get('/confirm-receipt/execute', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) {
      return res.status(400).send(renderPage('Missing Token', 'This link is invalid.'));
    }

    let payload: EmailActionPayload;
    try {
      payload = verifyEmailActionToken(token);
    } catch {
      return res.status(401).send(renderPage('Link Expired', 'This link has expired. Please open the Mulligans app.'));
    }

    const order = await prisma.orders.findUnique({
      where: { id: payload.orderId },
      select: { id: true, buyer_id: true, status: true },
    });

    if (!order || order.buyer_id !== payload.buyerId || order.status !== 'delivered') {
      return res.status(400).send(renderPage('Cannot Confirm', 'This order cannot be confirmed at this time.'));
    }

    // Mark order as confirmed — the escrow release cron will handle the payout
    await prisma.orders.update({
      where: { id: payload.orderId },
      data: {
        escrow_release_at: new Date(),
        updated_at: new Date(),
      },
    });

    return res.send(renderPage(
      'Receipt Confirmed!',
      'Payment will be released to the seller shortly. Thank you for shopping with Mulligans!',
    ));
  } catch (error) {
    console.error('[EMAIL-ACTION] Execute confirm error:', error);
    return res.status(500).send(renderPage('Error', 'Something went wrong. Please try again in the Mulligans app.'));
  }
});

// GET /api/email-actions/report-issue?token=<JWT>
router.get('/report-issue', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) {
      return res.status(400).send(renderPage('Missing Token', 'This link is invalid. Please open the Mulligans app to report an issue.'));
    }

    let payload: EmailActionPayload;
    try {
      payload = verifyEmailActionToken(token);
    } catch {
      return res.status(401).send(renderPage('Link Expired', 'This link has expired. Please open the Mulligans app to report an issue.'));
    }

    if (payload.action !== 'report-issue') {
      return res.status(400).send(renderPage('Invalid Link', 'This link is not valid for this action.'));
    }

    const order = await prisma.orders.findUnique({
      where: { id: payload.orderId },
      select: {
        id: true,
        buyer_id: true,
        status: true,
        listings: { select: { title: true } },
      },
    });

    if (!order || order.buyer_id !== payload.buyerId) {
      return res.status(404).send(renderPage('Order Not Found', 'This order could not be found.'));
    }

    if (order.status !== 'delivered') {
      return res.status(400).send(renderPage('Window Closed', 'The inspection window for this order has closed.'));
    }

    // Redirect to app for the full dispute flow (requires photos, description, etc.)
    const deepLink = `mulligans://orders/${payload.orderId}/report-issue`;
    const itemTitle = order.listings?.title || 'your item';

    return res.send(renderActionPage(
      'Report an Issue',
      `Need to report an issue with "${itemTitle}"? Open the app to provide details and photos.`,
      deepLink,
      null,
    ));
  } catch (error) {
    console.error('[EMAIL-ACTION] Report issue error:', error);
    return res.status(500).send(renderPage('Error', 'Something went wrong. Please try again in the Mulligans app.'));
  }
});

function renderPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Mulligans</title>
  <style>
    body { margin: 0; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #EAEAE0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: white; border-radius: 12px; padding: 40px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #1C4670; margin: 0 0 16px; font-size: 24px; }
    p { color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 24px; }
    .logo { color: #1DC690; font-weight: 600; font-size: 14px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <div class="logo">Mulligans Golf</div>
  </div>
</body>
</html>`;
}

function renderActionPage(
  title: string,
  message: string,
  deepLink: string,
  webFallbackUrl: string | null,
): string {
  const webButton = webFallbackUrl
    ? `<a href="${escapeHtml(webFallbackUrl)}" style="display:inline-block;padding:14px 32px;background:#1DC690;color:white;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;margin:8px;">Confirm on Web</a>`
    : `<p style="color:#6B7280;font-size:14px;">Please open the Mulligans app to complete this action.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Mulligans</title>
  <style>
    body { margin: 0; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #EAEAE0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: white; border-radius: 12px; padding: 40px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #1C4670; margin: 0 0 16px; font-size: 24px; }
    p { color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 24px; }
    .logo { color: #1DC690; font-weight: 600; font-size: 14px; margin-top: 24px; }
    .btn-app { display:inline-block;padding:14px 32px;background:#1C4670;color:white;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;margin:8px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <div>
      <a href="${escapeHtml(deepLink)}" class="btn-app">Open in App</a>
      ${webButton}
    </div>
    <div class="logo">Mulligans Golf</div>
  </div>
  <script>
    // Attempt deep link automatically on mobile
    if (/iPhone|iPad|Android/i.test(navigator.userAgent)) {
      setTimeout(function() { window.location.href = "${escapeHtml(deepLink)}"; }, 300);
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default router;
