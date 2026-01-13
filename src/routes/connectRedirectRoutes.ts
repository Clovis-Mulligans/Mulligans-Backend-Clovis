// src/routes/connectRedirectRoutes.ts
import { Router, Request, Response } from 'express';

const router = Router();

/**
 * Redirect page after Stripe Connect onboarding
 * GET /connect/return
 */
router.get('/return', (req: Request, res: Response) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Returning to Mulligans...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #F9FAFB;
      padding: 20px;
      box-sizing: border-box;
    }
    .container {
      text-align: center;
      max-width: 400px;
    }
    .checkmark {
      width: 80px;
      height: 80px;
      background: #1DC690;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }
    .checkmark svg {
      width: 40px;
      height: 40px;
      fill: white;
    }
    h1 {
      color: #111827;
      font-size: 24px;
      margin: 0 0 12px;
    }
    p {
      color: #6B7280;
      font-size: 16px;
      line-height: 1.5;
      margin: 0 0 24px;
    }
    .button {
      display: inline-block;
      background: #1DC690;
      color: white;
      font-size: 16px;
      font-weight: 600;
      padding: 14px 32px;
      border-radius: 12px;
      text-decoration: none;
      transition: background 0.2s;
    }
    .button:hover {
      background: #18A879;
    }
    .note {
      margin-top: 16px;
      font-size: 14px;
      color: #9CA3AF;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">
      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
    </div>
    <h1>You're all set!</h1>
    <p>Your bank details have been saved. Tap the button below to return to Mulligans.</p>
    <a href="mulligans://connect-complete" class="button">Return to Mulligans</a>
    <p class="note">If the app doesn't open, please return manually.</p>
  </div>
  <script>
    // Try to open the app automatically
    setTimeout(function() {
      window.location.href = 'mulligans://connect-complete';
    }, 500);
  </script>
</body>
</html>
  `;
  
  res.send(html);
});

/**
 * Refresh page (if user needs to restart onboarding)
 * GET /connect/refresh
 */
router.get('/refresh', (req: Request, res: Response) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Returning to Mulligans...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #F9FAFB;
      padding: 20px;
      box-sizing: border-box;
    }
    .container {
      text-align: center;
      max-width: 400px;
    }
    h1 {
      color: #111827;
      font-size: 24px;
      margin: 0 0 12px;
    }
    p {
      color: #6B7280;
      font-size: 16px;
      line-height: 1.5;
      margin: 0 0 24px;
    }
    .button {
      display: inline-block;
      background: #1DC690;
      color: white;
      font-size: 16px;
      font-weight: 600;
      padding: 14px 32px;
      border-radius: 12px;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Session Expired</h1>
    <p>Please return to the app and try setting up your bank details again.</p>
    <a href="mulligans://profile" class="button">Return to Mulligans</a>
  </div>
  <script>
    setTimeout(function() {
      window.location.href = 'mulligans://profile';
    }, 500);
  </script>
</body>
</html>
  `;
  
  res.send(html);
});

export default router;