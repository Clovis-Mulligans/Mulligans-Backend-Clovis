// src/middleware/adminAuth.ts
// Session-based admin authentication with token management

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const ADMIN_PASSWORD = process.env.DISPUTE_ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.error('FATAL: DISPUTE_ADMIN_PASSWORD environment variable is not set. Exiting.');
  process.exit(1);
}

// ==================== SESSION STORE ====================
interface AdminSession {
  token: string;
  createdAt: Date;
  lastActivity: Date;
  ip: string;
}

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const sessions = new Map<string, AdminSession>();

// Clean up expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
      sessions.delete(token);
    }
  }
}, 5 * 60 * 1000);

// ==================== MIDDLEWARE ====================

/**
 * Middleware to check admin session token from Authorization header
 * Format: Authorization: Bearer <token>
 * Also accepts legacy format: Authorization: Admin <password> (for backwards compatibility during rollout)
 */
export function adminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  // New token-based auth
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const session = sessions.get(token);

    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // Check session timeout
    const now = Date.now();
    if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
      sessions.delete(token);
      return res.status(401).json({ error: 'Session expired' });
    }

    // Update last activity
    session.lastActivity = new Date();

    return next();
  }

  // Legacy password-based auth (backwards compatibility — remove after frontend update)
  if (authHeader.startsWith('Admin ')) {
    const password = authHeader.slice(6);
    if (password !== ADMIN_PASSWORD) {
      console.log('⚠️ Invalid admin password attempt (legacy auth)');
      return res.status(401).json({ error: 'Invalid admin password' });
    }
    return next();
  }

  return res.status(401).json({ error: 'Invalid authorization format' });
}

/**
 * Verify password and create session
 * POST /admin/verify
 */
export function verifyAdminPassword(req: Request, res: Response) {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  // Generate session token
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();

  sessions.set(token, {
    token,
    createdAt: now,
    lastActivity: now,
    ip: req.ip || 'unknown',
  });

  console.log(`✅ Admin session created from ${req.ip}`);

  res.json({
    success: true,
    message: 'Authentication successful',
    token,
    expiresIn: SESSION_TIMEOUT_MS / 1000, // seconds
  });
}

/**
 * Logout and destroy session
 * POST /admin/logout
 */
export function adminLogout(req: Request, res: Response) {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    sessions.delete(token);
    console.log('✅ Admin session destroyed');
  }

  res.json({ success: true, message: 'Logged out' });
}

// Export for testing
export { sessions, SESSION_TIMEOUT_MS };
