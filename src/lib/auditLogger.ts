// src/lib/auditLogger.ts
// Admin audit logging helper
// Records admin actions for accountability and debugging

import { Request } from 'express';
import { prisma } from './prisma';

/**
 * Log an admin action to the audit log
 *
 * @param action - What was done (e.g., 'ban_user', 'resolve_dispute', 'approve_claim')
 * @param targetType - Type of entity acted upon (e.g., 'user', 'dispute', 'order', 'report', 'return', 'listing')
 * @param targetId - ID of the entity acted upon
 * @param details - Additional context (reason, amounts, before/after state, etc.)
 * @param req - Express request object (used to extract admin IP)
 */
export async function logAdminAction(
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, any> | null,
  req?: Request
): Promise<void> {
  try {
    // Extract IP from request headers (handles proxied requests)
    const adminIp = req
      ? (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        || req.socket.remoteAddress
        || 'unknown'
      : 'system';

    await prisma.admin_audit_log.create({
      data: {
        action,
        target_type: targetType,
        target_id: targetId,
        details: details || undefined,
        admin_ip: adminIp,
      },
    });

    console.log(`📝 Audit: ${action} on ${targetType}/${targetId || 'n/a'} from ${adminIp}`);
  } catch (error) {
    // Audit logging should never break the main operation
    console.error('⚠️ Audit log write failed:', error);
  }
}

/**
 * Predefined action constants for consistency
 */
export const AUDIT_ACTIONS = {
  // User management
  BAN_USER: 'ban_user',
  UNBAN_USER: 'unban_user',
  VERIFY_SELLER: 'verify_seller',
  UNVERIFY_SELLER: 'unverify_seller',

  // Disputes
  RESOLVE_DISPUTE: 'resolve_dispute',

  // Reports
  UPDATE_REPORT: 'update_report',
  BAN_USER_FROM_REPORT: 'ban_user_from_report',

  // Returns
  UPDATE_RETURN: 'update_return',
  PROCESS_REFUND: 'process_refund',

  // Insurance claims
  FILE_CLAIM: 'file_claim',
  APPROVE_CLAIM: 'approve_claim',
  DENY_CLAIM: 'deny_claim',

  // Listing moderation
  MODERATE_LISTING: 'moderate_listing',
} as const;
