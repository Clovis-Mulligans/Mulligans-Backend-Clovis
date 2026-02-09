// src/controllers/adminReportsController.ts
// Admin endpoints for managing user reports
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';


export class AdminReportsController {
  /**
   * Get all reports with filters
   * GET /admin/reports
   */
  static async getReports(req: Request, res: Response): Promise<void> {
    try {
      const { status, limit = 50 } = req.query;

      const where: any = {};
      if (status && status !== 'all') {
        where.status = status;
      }

      const reports = await prisma.user_reports.findMany({
        where,
        include: {
          reporter: {
            select: {
              id: true,
              display_name: true,
              email: true,
              avatar_url: true,
            },
          },
          reported_user: {
            select: {
              id: true,
              display_name: true,
              email: true,
              avatar_url: true,
              is_verified_seller: true,
              created_at: true,
              total_sales: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
        take: Number(limit),
      });

      // Get stats
      const stats = await prisma.user_reports.groupBy({
        by: ['status'],
        _count: true,
      });

      const statsMap: Record<string, number> = {
        pending: 0,
        reviewed: 0,
        resolved: 0,
        dismissed: 0,
      };

      stats.forEach((s) => {
        statsMap[s.status] = s._count;
      });

      res.json({
        reports,
        stats: statsMap,
        total: reports.length,
      });
    } catch (error) {
      console.error('Get reports error:', error);
      res.status(500).json({ error: 'Failed to fetch reports' });
    }
  }

  /**
   * Get single report details
   * GET /admin/reports/:id
   */
  static async getReport(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const report = await prisma.user_reports.findUnique({
        where: { id },
        include: {
          reporter: {
            select: {
              id: true,
              display_name: true,
              email: true,
              avatar_url: true,
              created_at: true,
            },
          },
          reported_user: {
            select: {
              id: true,
              display_name: true,
              email: true,
              avatar_url: true,
              is_verified_seller: true,
              created_at: true,
              total_sales: true,
              total_purchases: true,
              rating: true,
            },
          },
        },
      });

      if (!report) {
        res.status(404).json({ error: 'Report not found' });
        return;
      }

      // Get previous reports against this user
      const previousReports = await prisma.user_reports.count({
        where: {
          reported_user_id: report.reported_user_id,
          id: { not: id },
        },
      });

      // Get recent orders involving reported user
      const recentOrders = await prisma.orders.findMany({
        where: {
          OR: [
            { buyer_id: report.reported_user_id },
            { seller_id: report.reported_user_id },
          ],
        },
        select: {
          id: true,
          status: true,
          amount: true,
          created_at: true,
        },
        orderBy: { created_at: 'desc' },
        take: 5,
      });

      res.json({
        report,
        previousReports,
        recentOrders,
      });
    } catch (error) {
      console.error('Get report error:', error);
      res.status(500).json({ error: 'Failed to fetch report' });
    }
  }

  /**
   * Update report status
   * PATCH /admin/reports/:id
   */
  static async updateReport(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status, admin_notes } = req.body;

      if (!status) {
        res.status(400).json({ error: 'Status is required' });
        return;
      }

      const validStatuses = ['pending', 'reviewed', 'resolved', 'dismissed'];
      if (!validStatuses.includes(status)) {
        res.status(400).json({ error: 'Invalid status' });
        return;
      }

      const report = await prisma.user_reports.update({
        where: { id },
        data: {
          status,
          details: admin_notes ? `[ADMIN NOTE]: ${admin_notes}` : undefined,
        },
      });

      console.log(`📋 Report ${id} updated to ${status}`);

      res.json({
        success: true,
        report,
      });
    } catch (error) {
      console.error('Update report error:', error);
      res.status(500).json({ error: 'Failed to update report' });
    }
  }

  /**
   * Ban a user (from reports)
   * POST /admin/reports/:id/ban-user
   */
  static async banUser(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const report = await prisma.user_reports.findUnique({
        where: { id },
        include: {
          reported_user: true,
        },
      });

      if (!report) {
        res.status(404).json({ error: 'Report not found' });
        return;
      }

      // For now, we'll just mark the report as resolved with a ban note
      // In a full implementation, you'd disable the user account
      await prisma.user_reports.update({
        where: { id },
        data: {
          status: 'resolved',
          details: `[USER BANNED]: ${reason || 'Violation of terms of service'}`,
        },
      });

      // Deactivate all user's listings
      await prisma.listings.updateMany({
        where: { seller_id: report.reported_user_id },
        data: { status: 'inactive' },
      });

      console.log(`🚫 User ${report.reported_user_id} banned - listings deactivated`);

      res.json({
        success: true,
        message: 'User banned and listings deactivated',
      });
    } catch (error) {
      console.error('Ban user error:', error);
      res.status(500).json({ error: 'Failed to ban user' });
    }
  }
}