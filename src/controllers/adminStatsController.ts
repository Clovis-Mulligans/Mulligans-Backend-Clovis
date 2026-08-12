// src/controllers/adminStatsController.ts
// Admin dashboard statistics with REAL database data
// No placeholders, no demo data - production ready

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { BUYER_PROTECTION_RATE, SERVICE_FEE_PER_ITEM } from '../lib/feeCalculations';

// Per-metric status sets — different metrics count different order states.
// Verified against prod order statuses: cancelled, completed, delivered,
// disputed, in_transit, refunded, returned, to_ship.
// 'shipped' and 'paid' do NOT exist in prod data.
export const GMV_STATUSES = ['completed', 'delivered', 'in_transit', 'to_ship', 'disputed'] as const;
export const REALISED_STATUSES = ['completed'] as const;
export const PENDING_ESCROW_STATUSES = ['to_ship', 'in_transit', 'delivered'] as const;

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

      // ===== GMV (Gross Merchandise Value) — all genuine sales =====
      const gmvResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: {
          status: { in: [...GMV_STATUSES] }
        }
      });
      const totalGMV = Number(gmvResult._sum.amount || 0);

      const gmvThisWeekResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: {
          status: { in: [...GMV_STATUSES] },
          created_at: { gte: weekStart }
        }
      });
      const gmvThisWeek = Number(gmvThisWeekResult._sum.amount || 0);

      const gmvLastWeekResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: {
          status: { in: [...GMV_STATUSES] },
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

      // Today's GMV — uses GMV definition (all genuine sales)
      const todayRevenueResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: {
          created_at: { gte: todayStart },
          status: { in: [...GMV_STATUSES] }
        }
      });
      const todayRevenue = Number(todayRevenueResult._sum.amount || 0);

      // ===== REALISED REVENUE — completed only =====
      const realisedResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        _count: true,
        where: {
          status: { in: [...REALISED_STATUSES] }
        }
      });
      const realisedRevenue = Number(realisedResult._sum.amount || 0);
      const realisedOrderCount = realisedResult._count || 0;

      // ===== FEE REVENUE — gross (GMV set) and realised (completed only) =====
      const gmvOrderCount = await prisma.orders.count({
        where: { status: { in: [...GMV_STATUSES] } }
      });
      const grossFees = (totalGMV * BUYER_PROTECTION_RATE) + (gmvOrderCount * SERVICE_FEE_PER_ITEM);
      const realisedFees = (realisedRevenue * BUYER_PROTECTION_RATE) + (realisedOrderCount * SERVICE_FEE_PER_ITEM);

      // ===== VERIFIED SELLERS =====
      const verifiedSellers = await prisma.users.count({
        where: { is_verified_seller: true }
      });

      // ===== PENDING ESCROW — paid but not yet released to sellers =====
      const pendingEscrowResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: {
          status: { in: [...PENDING_ESCROW_STATUSES] }
        }
      });
      const pendingEscrow = Number(pendingEscrowResult._sum.amount || 0);

      // ===== AVERAGE ORDER VALUE — across GMV set =====
      const avgOrderResult = await prisma.orders.aggregate({
        _avg: { amount: true },
        where: {
          status: { in: [...GMV_STATUSES] }
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
        realisedRevenue,
        grossFees: Math.round(grossFees * 100) / 100,
        realisedFees: Math.round(realisedFees * 100) / 100,
        
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
          SUM(CASE WHEN status IN ('completed', 'delivered', 'in_transit', 'to_ship', 'disputed') THEN amount ELSE 0 END) as revenue
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
          SUM(CASE WHEN status IN ('completed', 'delivered', 'in_transit', 'to_ship', 'disputed') THEN amount ELSE 0 END) as gmv
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
          status: { in: [...GMV_STATUSES] },
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

  /**
   * Get detailed analytics data for the analytics page
   * GET /admin/stats/detailed?period=30d
   */
  static async getDetailedStats(req: Request, res: Response): Promise<void> {
    try {
      const { period = '30d' } = req.query as { period?: string };

      const now = new Date();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

      // Calculate period start date
      let periodStart: Date;
      switch (period) {
        case '7d':
          periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
          break;
        case '90d':
          periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89);
          break;
        case 'all':
          periodStart = new Date(2020, 0, 1); // far enough back
          break;
        case '30d':
        default:
          periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
          break;
      }

      const validOrderStatuses = [...GMV_STATUSES];

      // ===== REVENUE METRICS =====
      const [gmvResult, orderCountResult, shippingResult] = await Promise.all([
        prisma.orders.aggregate({
          _sum: { amount: true },
          where: {
            status: { in: validOrderStatuses },
            created_at: { gte: periodStart, lt: tomorrow },
          },
        }),
        prisma.orders.count({
          where: {
            status: { in: validOrderStatuses },
            created_at: { gte: periodStart, lt: tomorrow },
          },
        }),
        prisma.orders.aggregate({
          _sum: { shipping_cost: true, label_cost: true },
          where: {
            status: { in: validOrderStatuses },
            created_at: { gte: periodStart, lt: tomorrow },
          },
        }),
      ]);

      const totalGMV = Number(gmvResult._sum.amount || 0);
      const orderCount = orderCountResult;
      const avgOrderValue = orderCount > 0 ? totalGMV / orderCount : 0;

      // Gross fees across all genuine sales (GMV set)
      const grossFees = (totalGMV * BUYER_PROTECTION_RATE) + (orderCount * SERVICE_FEE_PER_ITEM);

      // Realised fees — completed orders only
      const [realisedGmvResult, realisedCountResult] = await Promise.all([
        prisma.orders.aggregate({
          _sum: { amount: true },
          where: {
            status: { in: [...REALISED_STATUSES] },
            created_at: { gte: periodStart, lt: tomorrow },
          },
        }),
        prisma.orders.count({
          where: {
            status: { in: [...REALISED_STATUSES] },
            created_at: { gte: periodStart, lt: tomorrow },
          },
        }),
      ]);
      const realisedGMV = Number(realisedGmvResult._sum.amount || 0);
      const realisedCount = realisedCountResult;
      const realisedFees = (realisedGMV * BUYER_PROTECTION_RATE) + (realisedCount * SERVICE_FEE_PER_ITEM);

      // Shipping margin estimate: charged shipping - label cost
      const totalShippingCharged = Number(shippingResult._sum.shipping_cost || 0);
      const totalLabelCost = Number(shippingResult._sum.label_cost || 0);
      const estimatedShippingMargin = totalShippingCharged - totalLabelCost;

      // ===== USER METRICS =====
      const [totalUsers, newUsers, activeUsers] = await Promise.all([
        prisma.users.count(),
        prisma.users.count({
          where: { created_at: { gte: periodStart, lt: tomorrow } },
        }),
        prisma.users.count({
          where: { total_purchases: { gt: 0 } },
        }),
      ]);

      // ===== LISTING METRICS =====
      const [activeListings, newListings, soldListings] = await Promise.all([
        prisma.listings.count({
          where: { status: 'active' },
        }),
        prisma.listings.count({
          where: { created_at: { gte: periodStart, lt: tomorrow } },
        }),
        prisma.listings.count({
          where: {
            status: 'sold',
            updated_at: { gte: periodStart, lt: tomorrow },
          },
        }),
      ]);

      // Average days to sell (for items sold in this period)
      const soldOrders = await prisma.$queryRaw<Array<{ avg_days: number | null }>>`
        SELECT AVG(
          EXTRACT(EPOCH FROM (o.created_at - l.created_at)) / 86400
        ) as avg_days
        FROM orders o
        JOIN listings l ON o.listing_id = l.id
        WHERE o.status IN ('completed', 'delivered')
        AND o.created_at >= ${periodStart}
        AND o.created_at < ${tomorrow}
        AND l.created_at IS NOT NULL
      `;
      const avgDaysToSell = soldOrders[0]?.avg_days ? Number(soldOrders[0].avg_days) : null;

      // ===== TIME SERIES DATA =====
      const dayCount = period === 'all'
        ? Math.ceil((tomorrow.getTime() - periodStart.getTime()) / 86400000)
        : period === '7d' ? 7 : period === '90d' ? 90 : 30;

      // Efficient batch query for time series
      const ordersByDay = await prisma.$queryRaw<Array<{ day: Date; count: bigint; gmv: any }>>`
        SELECT
          DATE(created_at) as day,
          COUNT(*)::bigint as count,
          SUM(CASE WHEN status IN ('completed', 'delivered', 'in_transit', 'to_ship', 'disputed') THEN amount ELSE 0 END) as gmv
        FROM orders
        WHERE created_at >= ${periodStart} AND created_at < ${tomorrow}
        GROUP BY DATE(created_at)
        ORDER BY day
      `;

      const ordersMap = new Map<string, { count: number; gmv: number }>();
      for (const row of ordersByDay) {
        const key = new Date(row.day).toISOString().split('T')[0];
        ordersMap.set(key, {
          count: Number(row.count),
          gmv: Number(row.gmv || 0),
        });
      }

      const labels: string[] = [];
      const ordersData: number[] = [];
      const gmvData: number[] = [];

      // For 'all' period with many days, aggregate by week or month
      const useMonthly = dayCount > 180;
      const useWeekly = dayCount > 60 && !useMonthly;

      if (useMonthly) {
        // Group by month
        const monthMap = new Map<string, { orders: number; gmv: number }>();
        for (let i = dayCount - 1; i >= 0; i--) {
          const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
          const key = day.toISOString().split('T')[0];
          const monthKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}`;
          const entry = ordersMap.get(key);
          if (!monthMap.has(monthKey)) {
            monthMap.set(monthKey, { orders: 0, gmv: 0 });
          }
          const m = monthMap.get(monthKey)!;
          m.orders += entry?.count || 0;
          m.gmv += entry?.gmv || 0;
        }
        for (const [monthKey, vals] of monthMap) {
          const [year, month] = monthKey.split('-');
          const d = new Date(parseInt(year), parseInt(month) - 1, 1);
          labels.push(d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
          ordersData.push(vals.orders);
          gmvData.push(vals.gmv);
        }
      } else if (useWeekly) {
        // Group by week
        const weekMap = new Map<number, { label: string; orders: number; gmv: number }>();
        for (let i = dayCount - 1; i >= 0; i--) {
          const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
          const key = day.toISOString().split('T')[0];
          const weekNum = Math.floor(i / 7);
          const weekKey = dayCount - 1 - weekNum * 7;
          if (!weekMap.has(weekNum)) {
            weekMap.set(weekNum, {
              label: day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
              orders: 0,
              gmv: 0,
            });
          }
          const w = weekMap.get(weekNum)!;
          const entry = ordersMap.get(key);
          w.orders += entry?.count || 0;
          w.gmv += entry?.gmv || 0;
        }
        // Sort by week number descending (most recent first), then reverse for chart
        const weeks = Array.from(weekMap.entries()).sort((a, b) => b[0] - a[0]).reverse();
        for (const [, vals] of weeks) {
          labels.push(vals.label);
          ordersData.push(vals.orders);
          gmvData.push(vals.gmv);
        }
      } else {
        // Daily
        for (let i = dayCount - 1; i >= 0; i--) {
          const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
          const key = day.toISOString().split('T')[0];
          const entry = ordersMap.get(key);
          labels.push(day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
          ordersData.push(entry?.count || 0);
          gmvData.push(entry?.gmv || 0);
        }
      }

      // ===== CATEGORY BREAKDOWN =====
      const categoryBreakdown = await prisma.orders.groupBy({
        by: ['listing_id'],
        _sum: { amount: true },
        where: {
          status: { in: [...GMV_STATUSES] },
          listing_id: { not: null },
          created_at: { gte: periodStart, lt: tomorrow },
        },
      });

      const listingIds = categoryBreakdown
        .map(o => o.listing_id)
        .filter((id): id is string => id !== null);

      const listingsForCategories = listingIds.length > 0
        ? await prisma.listings.findMany({
            where: { id: { in: listingIds } },
            select: { id: true, category: true },
          })
        : [];

      const categoryMapLookup = new Map(listingsForCategories.map(l => [l.id, l.category]));
      const categoryTotals: Record<string, number> = {};

      categoryBreakdown.forEach(o => {
        if (o.listing_id) {
          const category = categoryMapLookup.get(o.listing_id) || 'Other';
          categoryTotals[category] = (categoryTotals[category] || 0) + Number(o._sum.amount || 0);
        }
      });

      // ===== ORDER STATUS BREAKDOWN =====
      const orderStatusBreakdown = await prisma.orders.groupBy({
        by: ['status'],
        _count: true,
        where: {
          created_at: { gte: periodStart, lt: tomorrow },
        },
      });

      const orderStatuses: Record<string, number> = {};
      orderStatusBreakdown.forEach(o => {
        orderStatuses[o.status] = o._count;
      });

      // ===== RESPONSE =====
      res.json({
        period,
        revenue: {
          totalGMV,
          realisedGMV,
          estimatedFees: Math.round(grossFees * 100) / 100,
          grossFees: Math.round(grossFees * 100) / 100,
          realisedFees: Math.round(realisedFees * 100) / 100,
          estimatedShippingMargin: Math.round(estimatedShippingMargin * 100) / 100,
          avgOrderValue: Math.round(avgOrderValue * 100) / 100,
          orderCount,
        },
        users: {
          total: totalUsers,
          newThisPeriod: newUsers,
          activeWithPurchases: activeUsers,
        },
        listings: {
          active: activeListings,
          newThisPeriod: newListings,
          soldThisPeriod: soldListings,
          avgDaysToSell: avgDaysToSell !== null ? Math.round(avgDaysToSell * 10) / 10 : null,
        },
        timeSeries: {
          labels,
          ordersData,
          gmvData,
        },
        categories: {
          labels: Object.keys(categoryTotals),
          data: Object.values(categoryTotals),
        },
        orderStatuses: {
          labels: Object.keys(orderStatuses),
          data: Object.values(orderStatuses),
        },
      });
    } catch (error) {
      console.error('Get detailed stats error:', error);
      res.status(500).json({ error: 'Failed to fetch detailed stats' });
    }
  }
}