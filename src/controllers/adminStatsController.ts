// src/controllers/adminStatsController.ts
// Admin dashboard statistics with REAL database data
// No placeholders, no demo data - production ready

import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { BUYER_PROTECTION_RATE, SERVICE_FEE_PER_ITEM } from '../lib/feeCalculations';

// Per-metric status sets — different metrics count different order states.
// Verified against prod order statuses: cancelled, completed, delivered,
// disputed, in_transit, refunded, returned, to_ship.
// 'shipped' and 'paid' do NOT exist in prod data.
export const GMV_STATUSES = ['completed', 'delivered', 'in_transit', 'to_ship', 'disputed'] as const;
export const REALISED_STATUSES = ['completed'] as const;
export const PENDING_ESCROW_STATUSES = ['to_ship', 'in_transit', 'delivered'] as const;

// Legacy pre-dev test orders — excluded from dashboard metrics only, NOT deleted.
// Future test data lives in the dev environment.
export const EXCLUDED_ORDER_IDS = [
  'order_cdc05c80-4f33-400a-9092-a2e62db38d93',
  'order_bbb24b5c-6bd0-4d4b-b942-fcb6849e5521',
  'order_36a36a6a-8835-47ab-8147-9262774ef7bb',
  'order_a90e1276-b7ee-4b50-bed8-31c944f7ed35',
  'order_85c8a91b-05d8-4bb3-a1e3-4658710118db',
  'order_655d42f6-9031-4d83-9ee5-52bf5994d241',
  'order_27c481f5-97aa-43ad-b5f6-bcf27a8e813a',
  'order_9e8747b5-65f4-4976-8b2c-ee5914562403',
  'order_3910a004-1eb2-44f0-9b73-9aec98cae497',
  'order_59a35224-e6f9-418b-a071-0456b1ae67c8',
  'order_c52adae2-1b9d-4e9c-bc00-af977c515c96',
  'order_1768581703117_m8xcdh5tr',
  'order_1768581703109_m1ripph1g',
  'order_1768581703083_97rwrmu9u',
  'order_1767461939807_qwuvkesmo',
  'order_1767446213681_2xdm0wywz',
  'order_1767441821097_t7dgbndl9',
  'order_1764523612193_isgwb6iee',
] as const;

// UK domestic card estimate (1.5% + 20p) — not actual Stripe data
export const EST_STRIPE_RATE = 0.015;
export const EST_STRIPE_FIXED = 0.20;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const excludeTestOrders = { id: { notIn: [...EXCLUDED_ORDER_IDS] } };

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
      const totalOrders = await prisma.orders.count({ where: { ...excludeTestOrders } });
      const ordersThisWeek = await prisma.orders.count({
        where: { ...excludeTestOrders, created_at: { gte: weekStart } }
      });
      const ordersLastWeek = await prisma.orders.count({
        where: {
          ...excludeTestOrders,
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
          ...excludeTestOrders,
          status: { in: [...GMV_STATUSES] }
        }
      });
      const totalGMV = Number(gmvResult._sum.amount || 0);

      const gmvThisWeekResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: {
          ...excludeTestOrders,
          status: { in: [...GMV_STATUSES] },
          created_at: { gte: weekStart }
        }
      });
      const gmvThisWeek = Number(gmvThisWeekResult._sum.amount || 0);

      const gmvLastWeekResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: {
          ...excludeTestOrders,
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
        where: { ...excludeTestOrders, created_at: { gte: todayStart } }
      });

      // Today's GMV — uses GMV definition (all genuine sales)
      const todayRevenueResult = await prisma.orders.aggregate({
        _sum: { amount: true },
        where: {
          ...excludeTestOrders,
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
          ...excludeTestOrders,
          status: { in: [...REALISED_STATUSES] }
        }
      });
      const realisedRevenue = Number(realisedResult._sum.amount || 0);
      const realisedOrderCount = realisedResult._count || 0;

      // ===== FEE REVENUE — gross (GMV set) and realised (completed only) =====
      const gmvOrderCount = await prisma.orders.count({
        where: { ...excludeTestOrders, status: { in: [...GMV_STATUSES] } }
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
          ...excludeTestOrders,
          status: { in: [...PENDING_ESCROW_STATUSES] }
        }
      });
      const pendingEscrow = Number(pendingEscrowResult._sum.amount || 0);

      // ===== AVERAGE ORDER VALUE — across GMV set =====
      const avgOrderResult = await prisma.orders.aggregate({
        _avg: { amount: true },
        where: {
          ...excludeTestOrders,
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
          AND id NOT IN (${Prisma.join(EXCLUDED_ORDER_IDS)})
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
          AND id NOT IN (${Prisma.join(EXCLUDED_ORDER_IDS)})
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
          ...excludeTestOrders,
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
            ...excludeTestOrders,
            status: { in: validOrderStatuses },
            created_at: { gte: periodStart, lt: tomorrow },
          },
        }),
        prisma.orders.count({
          where: {
            ...excludeTestOrders,
            status: { in: validOrderStatuses },
            created_at: { gte: periodStart, lt: tomorrow },
          },
        }),
        prisma.orders.aggregate({
          _sum: { shipping_cost: true, label_cost: true },
          where: {
            ...excludeTestOrders,
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
            ...excludeTestOrders,
            status: { in: [...REALISED_STATUSES] },
            created_at: { gte: periodStart, lt: tomorrow },
          },
        }),
        prisma.orders.count({
          where: {
            ...excludeTestOrders,
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
        AND o.id NOT IN (${Prisma.join(EXCLUDED_ORDER_IDS)})
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
          AND id NOT IN (${Prisma.join(EXCLUDED_ORDER_IDS)})
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
          ...excludeTestOrders,
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
          ...excludeTestOrders,
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

  static async getSales(req: Request, res: Response): Promise<void> {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const pageSize = 50;
      const skip = (page - 1) * pageSize;
      const statusFilter = (req.query.status as string) || 'gmv';

      let statusWhere: { in: string[] } | undefined;
      if (statusFilter === 'all') {
        statusWhere = undefined;
      } else if (statusFilter === 'cancelled') {
        statusWhere = { in: ['cancelled'] };
      } else if (statusFilter === 'refunded') {
        statusWhere = { in: ['refunded'] };
      } else if (statusFilter === 'returned') {
        statusWhere = { in: ['returned'] };
      } else {
        statusWhere = { in: [...GMV_STATUSES] };
      }

      const where = statusWhere ? { ...excludeTestOrders, status: statusWhere } : { ...excludeTestOrders };

      const [orders, totalCount, totalsResult] = await Promise.all([
        prisma.orders.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip,
          take: pageSize,
          include: {
            users_orders_buyer_idTousers: {
              select: { id: true, display_name: true, email: true },
            },
            users_orders_seller_idTousers: {
              select: { id: true, display_name: true, email: true, is_verified_seller: true },
            },
          },
        }),
        prisma.orders.count({ where }),
        prisma.orders.aggregate({
          _sum: { buyer_total: true, seller_payout: true, shipping_cost: true, label_cost: true },
          _count: true,
          where,
        }),
      ]);

      const totalBuyerTotal = Number(totalsResult._sum.buyer_total || 0);
      const totalSellerPayout = Number(totalsResult._sum.seller_payout || 0);
      const totalShippingCost = Number(totalsResult._sum.shipping_cost || 0);
      const totalLabelCost = Number(totalsResult._sum.label_cost || 0);
      const totalGross = totalBuyerTotal - totalSellerPayout - totalLabelCost;
      const totalEstStripe = (totalBuyerTotal * EST_STRIPE_RATE) + (totalsResult._count * EST_STRIPE_FIXED);
      const totalEstNet = totalGross - totalEstStripe;

      const salesRows = orders.map(order => {
        const buyerTotal = Number(order.buyer_total || 0);
        const sellerPayout = Number(order.seller_payout || 0);
        const shippingCost = Number(order.shipping_cost || 0);
        const labelCost = Number(order.label_cost || 0);
        const listingPrice = Number(order.listing_price || 0);

        const mulligansGross = buyerTotal - sellerPayout - labelCost;
        const formulaFee = (listingPrice * BUYER_PROTECTION_RATE) + SERVICE_FEE_PER_ITEM;
        const estStripeFee = (buyerTotal * EST_STRIPE_RATE) + EST_STRIPE_FIXED;
        const estNet = mulligansGross - estStripeFee;

        const buyer = order.users_orders_buyer_idTousers;
        const seller = order.users_orders_seller_idTousers;

        let timeToSell: string | null = null;
        if (order.paid_at && order.created_at) {
          const diffMs = new Date(order.paid_at).getTime() - new Date(order.created_at).getTime();
          const diffHours = Math.floor(diffMs / 3600000);
          const diffDays = Math.floor(diffMs / 86400000);
          if (diffDays > 0) {
            timeToSell = `${diffDays}d ${diffHours % 24}h`;
          } else {
            timeToSell = `${diffHours}h`;
          }
        }

        return {
          id: order.id,
          listing_title: order.listing_title,
          listing_image: order.listing_image,
          buyer: buyer ? { id: buyer.id, name: buyer.display_name || buyer.email || 'Unknown' } : null,
          seller: seller ? {
            id: seller.id,
            name: seller.display_name || seller.email || 'Unknown',
            is_pro: seller.is_verified_seller || false,
          } : null,
          shipping_address: order.shipping_address,
          original_list_price: Number(order.original_list_price || 0),
          listing_price: listingPrice,
          discount_amount: Number(order.discount_amount || 0),
          offer_id: order.offer_id,
          buyer_total: buyerTotal,
          seller_payout: sellerPayout,
          shipping_cost: shippingCost,
          label_cost: labelCost,
          label_pending: order.label_cost === null,
          mulligans_gross: round2(mulligansGross),
          formula_fee: round2(formulaFee),
          est_stripe_fee: round2(estStripeFee),
          est_net: round2(estNet),
          time_to_sell: timeToSell,
          source: order.source || 'unknown',
          status: order.status,
          created_at: order.created_at,
          quantity: order.quantity,
        };
      });

      res.json({
        sales: salesRows,
        pagination: {
          page,
          pageSize,
          totalCount,
          totalPages: Math.ceil(totalCount / pageSize),
        },
        totals: {
          count: totalsResult._count,
          mulligans_gross: round2(totalGross),
          est_stripe_fee: round2(totalEstStripe),
          est_net: round2(totalEstNet),
        },
        statusFilter,
      });
    } catch (error) {
      console.error('Get sales error:', error);
      res.status(500).json({ error: 'Failed to fetch sales data' });
    }
  }
}