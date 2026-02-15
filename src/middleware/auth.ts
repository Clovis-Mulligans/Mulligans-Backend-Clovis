import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    username: string;
    sub?: string;
  };
}

/**
 * Middleware to verify JWT token
 */
export const authenticateToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    console.log('🔐 Auth Header:', authHeader ? 'EXISTS' : 'MISSING');
    
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    console.log('🔑 Token extracted:', token ? 'YES' : 'NO');

    if (!token) {
      console.log('❌ No token provided');
      res.status(401).json({ error: 'Access token required' });
      return;
    }

    // Verify token
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
    console.log('✅ Token verified. User ID:', payload.userId || payload.id);

    // Attach user info to request
    req.user = {
      id: payload.userId || payload.id,
      email: payload.email,
      username: payload.username || payload.display_name,
      sub: payload.userId || payload.id,
    } as any;

    // Check if user is banned
    const { prisma } = require('../lib/prisma');
    const user = await prisma.users.findUnique({
      where: { id: req.user!.id },
      select: { is_banned: true },
    });

    if (user?.is_banned) {
      res.status(403).json({
        error: 'Account suspended',
        message: 'Your account has been suspended. Please contact support.',
        code: 'ACCOUNT_BANNED',
      });
      return;
    }

    next();
  } catch (error) {
    console.error('❌ Token verification error:', error);
    res.status(403).json({ error: 'Invalid or expired token' });
  }
};

/**
 * Middleware to verify user owns the resource
 */
export const authorizeOwner = (userIdParam: string = 'userId') => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const resourceUserId = req.params[userIdParam];
    
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (req.user.id !== resourceUserId) {
      res.status(403).json({ error: 'Not authorized to access this resource' });
      return;
    }

    next();
  };
};