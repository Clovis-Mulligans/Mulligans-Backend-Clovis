// src/middleware/adminAuth.ts
// Simple password-based admin authentication for dispute panel

import { Request, Response, NextFunction } from 'express';

const ADMIN_PASSWORD = process.env.DISPUTE_ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.error('FATAL: DISPUTE_ADMIN_PASSWORD environment variable is not set. Exiting.');
  process.exit(1);
}

/**
 * Middleware to check admin password from Authorization header
 * Format: Authorization: Admin <password>
 */
export function adminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Admin ')) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  const password = authHeader.slice(6); // Remove 'Admin ' prefix

  if (password !== ADMIN_PASSWORD) {
    console.log('⚠️ Invalid admin password attempt');
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  next();
}

/**
 * Verify password endpoint - returns success if password is correct
 */
export function verifyAdminPassword(req: Request, res: Response) {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  res.json({ success: true, message: 'Authentication successful' });
}