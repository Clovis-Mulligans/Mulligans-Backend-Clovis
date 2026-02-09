// src/controllers/adminStatsController.ts
// Admin dashboard statistics with REAL database data
// No placeholders, no demo data - production ready

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';


export class AdminStatsController {
  /**
   * Get platform overview stats
   * GET /admin/stats
   */
  static async getStats(req: Request, res: Response): Promise<void> {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - 7);
      const lastWeekStart = new Date(weekStart);
      lastWeekStart.setDate(lastWeekStart.getDate() - 7);

      // ===== TOTAL USERS =====
      const totalUsers = await prisma.users.count();
      const usersThisWeek = await prisma.users.count({
        where: { created_at: { gte: weekStart } }
      });
      const usersLastWeek = await prisma.users.count({
        where: { 
          created_at: { 
            gte: lastWeekStart,
            lt: weekStart 
          } 
        }
      });

      // ===== ACTIVE LISTINGS =====
      const totalListings = await prisma.listings.count({
        where: { status: 'active' }
      });
      const listingsThisWeek = await prisma.listings.count({
        where: { 
          status: 'active',
          created_at: { gte: weekStart } 
        }
      });
      const listingsLastWeek = await prisma.listings.count({
        where: { 
          status: 'active',
          created_at: { 
            gte: lastWeekStart,
            lt: weekStart 
          } 
        }
      });

      // ===== TOTAL ORDERS =====
      const totalOrders = await prisma.orders.count();
      const ordersThisWeek = await prisma.orders.count({
        where: { created_at: { gte: weekStart } }
      });
      const ordersLastWeek = await prisma.orders.count({
        where: { 
          created_at: { 
            gte: lastWeekStart,
            lt: weekStart 
          } 
        }
      });

      // ===== GMV (Gross Merchandise Value) =====
      const gmvResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: { 
          status: { in: ['completed', 'delivered', 'shipped', 'paid'] }
        }
      });
      const totalGMV = Number(gmvResult._sum.amount || 0);

      const gmvThisWeekResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: { 
          status: { in: ['completed', 'delivered', 'shipped', 'paid'] },
          created_at: { gte: weekStart }
        }
      });
      const gmvThisWeek = Number(gmvThisWeekResult._sum.amount || 0);

      const gmvLastWeekResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: { 
          status: { in: ['completed', 'delivered', 'shipped', 'paid'] },
          created_at: { 
            gte: lastWeekStart,
            lt: weekStart 
          }
        }
      });
      const gmvLastWeek = Number(gmvLastWeekResult._sum.amount || 0);

      // ===== TODAY'S STATS =====
      const todayOrders = await prisma.orders.count({
        where: { created_at: { gte: todayStart } }
      });

      const todayRevenueResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: { 
          created_at: { gte: todayStart },
          status: { in: ['completed', 'delivered', 'shipped', 'paid'] }
        }
      });
      const todayRevenue = Number(todayRevenueResult._sum.amount || 0);

      // ===== VERIFIED SELLERS =====
      const verifiedSellers = await prisma.users.count({
        where: { is_verified_seller: true }
      });

      // ===== PENDING ESCROW =====
      const pendingEscrowResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: { 
          status: { in: ['paid', 'shipped'] }
        }
      });
      const pendingEscrow = Number(pendingEscrowResult._sum.amount || 0);

      // ===== AVERAGE ORDER VALUE =====
      const avgOrderResult = await prisma.orders.aggregate({
        _avg: { amount: true },
        where: { 
          status: { in: ['completed', 'delivered', 'shipped', 'paid'] }
        }
      });
      const avgOrderValue = Number(avgOrderResult._avg.amount || 0);

      // ===== CONVERSION RATE =====
      const usersWithPurchases = await prisma.users.count({
        where: { total_purchases: { gt: 0 } }
      });
      const conversionRate = totalUsers > 0 ? (usersWithPurchases / totalUsers) * 100 : 0;

      res.json({
        // Main stats
        totalUsers,
        totalListings,
        totalOrders,
        totalGMV,
        
        // Today
        todayOrders,
        todayRevenue,
        
        // Week-over-week changes
        usersChange: usersThisWeek - usersLastWeek,
        listingsChange: listingsThisWeek - listingsLastWeek,
        ordersChange: ordersThisWeek - ordersLastWeek,
        gmvChange: gmvThisWeek - gmvLastWeek,
        
        // Additional metrics
        verifiedSellers,
        pendingEscrow,
        avgOrderValue,
        conversionRate,
        
        // This week totals
        thisWeek: {
          users: usersThisWeek,
          listings: listingsThisWeek,
          orders: ordersThisWeek,
          gmv: gmvThisWeek,
        }
      });
    } catch (error) {
      console.error('Get stats error:', error);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  }

  /**
   * Get chart data for dashboard
   * GET /admin/stats/charts
   */
  static async getChartData(req: Request, res: Response): Promise<void> {
    try {
      const now = new Date();

      // Date boundaries
      const sevenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

      // ===== Batch query: Orders + Revenue (last 7 days) =====
      const ordersByDay = await prisma.$queryRaw<Array<{ day: Date; count: bigint; revenue: any }>>`
        SELECT
          DATE(created_at) as day,
          COUNT(*)::bigint as count,
          SUM(CASE WHEN status IN ('completed', 'delivered', 'shipped', 'paid') THEN amount ELSE 0 END) as revenue
        FROM orders
        WHERE created_at >= ${sevenDaysAgo} AND created_at < ${tomorrow}
        GROUP BY DATE(created_at)
        ORDER BY day
      `;

      // ===== Batch query: Signups (last 30 days) =====
      const signupsByDay = await prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
        SELECT DATE(created_at) as day, COUNT(*)::bigint as count
        FROM users
        WHERE created_at >= ${thirtyDaysAgo} AND created_at < ${tomorrow}
        GROUP BY DATE(created_at)
        ORDER BY day
      `;

      // ===== Batch query: GMV (last 30 days) =====
      const gmvByDay = await prisma.$queryRaw<Array<{ day: Date; gmv: any }>>`
        SELECT DATE(created_at) as day,
          SUM(CASE WHEN status IN ('completed', 'delivered', 'shipped', 'paid') THEN amount ELSE 0 END) as gmv
        FROM orders
        WHERE created_at >= ${thirtyDaysAgo} AND created_at < ${tomorrow}
        GROUP BY DATE(created_at)
        ORDER BY day
      `;

      // Build lookup maps (date string -> value)
      const ordersMap = new Map<string, { count: number; revenue: number }>();
      for (const row of ordersByDay) {
        const key = new Date(row.day).toISOString().split('T')[0];
        ordersMap.set(key, {
          count: Number(row.count),
          revenue: Number(row.revenue || 0),
        });
      }

      const signupsMap = new Map<string, number>();
      for (const row of signupsByDay) {
        const key = new Date(row.day).toISOString().split('T')[0];
        signupsMap.set(key, Number(row.count));
      }

      const gmvMap = new Map<string, number>();
      for (const row of gmvByDay) {
        const key = new Date(row.day).toISOString().split('T')[0];
        gmvMap.set(key, Number(row.gmv || 0));
      }

      // ===== Build arrays for 7-day charts (orders + revenue) =====
      const ordersData: number[] = [];
      const ordersLabels: string[] = [];
      const revenueData: number[] = [];
      const revenueLabels: string[] = [];

      for (let i = 6; i >= 0; i--) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const key = day.toISOString().split('T')[0];
        const entry = ordersMap.get(key);

        ordersData.push(entry?.count || 0);
        ordersLabels.push(day.toLocaleDateString('en-GB', { weekday: 'short' }));

        revenueData.push(entry?.revenue || 0);
        revenueLabels.push(day.toLocaleDateString('en-GB', { weekday: 'short' }));
      }

      // ===== Build arrays for 30-day charts (signups + GMV) =====
      const signupsData: number[] = [];
      const signupsLabels: string[] = [];
      const gmvData: number[] = [];
      const gmvLabels: string[] = [];

      for (let i = 29; i >= 0; i--) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const key = day.toISOString().split('T')[0];

        signupsData.push(signupsMap.get(key) || 0);
        signupsLabels.push(day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));

        gmvData.push(gmvMap.get(key) || 0);
        gmvLabels.push(day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
      }

      // ===== CATEGORY BREAKDOWN =====
      const categoryBreakdown = await prisma.orders.groupBy({
        by: ['listing_id'],
        _sum: { amount: true },
        where: {
          status: { in: ['completed', 'delivered', 'shipped', 'paid'] },
          listing_id: { not: null }
        }
      });

      // Get listing categories for the orders
      const listingIds = categoryBreakdown
        .map(o => o.listing_id)
        .filter((id): id is string => id !== null);
      
      const listings = await prisma.listings.findMany({
        where: { id: { in: listingIds } },
        select: { id: true, category: true }
      });

      const categoryMap = new Map(listings.map(l => [l.id, l.category]));
      const categoryTotals: Record<string, number> = {};
      
      categoryBreakdown.forEach(o => {
        if (o.listing_id) {
          const category = categoryMap.get(o.listing_id) || 'Other';
          categoryTotals[category] = (categoryTotals[category] || 0) + Number(o._sum.amount || 0);
        }
      });

      res.json({
        orders: {
          labels: ordersLabels,
          data: ordersData
        },
        revenue: {
          labels: revenueLabels,
          data: revenueData
        },
        signups: {
          labels: signupsLabels,
          data: signupsData
        },
        gmv: {
          labels: gmvLabels,
          data: gmvData
        },
        categories: {
          labels: Object.keys(categoryTotals),
          data: Object.values(categoryTotals)
        }
      });
    } catch (error) {
      console.error('Get chart data error:', error);
      res.status(500).json({ error: 'Failed to fetch chart data' });
    }
  }
}