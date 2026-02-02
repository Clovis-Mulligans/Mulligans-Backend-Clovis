// src/controllers/adminStatsController.ts
// Admin dashboard statistics with REAL database data
// No placeholders, no demo data - production ready

import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
        where: { is_verified: true }
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
      
      // ===== ORDERS - Last 7 days =====
      const ordersData: number[] = [];
      const ordersLabels: string[] = [];
      for (let i = 6; i >= 0; i--) {
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        
        const count = await prisma.orders.count({
          where: {
            created_at: { gte: dayStart, lt: dayEnd }
          }
        });
        
        ordersData.push(count);
        ordersLabels.push(dayStart.toLocaleDateString('en-GB', { weekday: 'short' }));
      }

      // ===== REVENUE - Last 7 days =====
      const revenueData: number[] = [];
      const revenueLabels: string[] = [];
      for (let i = 6; i >= 0; i--) {
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        
        const result = await prisma.orders.aggregate({
          _sum: { amount: true },
          where: {
            created_at: { gte: dayStart, lt: dayEnd },
            status: { in: ['completed', 'delivered', 'shipped', 'paid'] }
          }
        });
        
        revenueData.push(Number(result._sum.amount || 0));
        revenueLabels.push(dayStart.toLocaleDateString('en-GB', { weekday: 'short' }));
      }

      // ===== SIGNUPS - Last 30 days =====
      const signupsData: number[] = [];
      const signupsLabels: string[] = [];
      for (let i = 29; i >= 0; i--) {
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        
        const count = await prisma.users.count({
          where: {
            created_at: { gte: dayStart, lt: dayEnd }
          }
        });
        
        signupsData.push(count);
        signupsLabels.push(dayStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
      }

      // ===== GMV - Last 30 days =====
      const gmvData: number[] = [];
      const gmvLabels: string[] = [];
      for (let i = 29; i >= 0; i--) {
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        
        const result = await prisma.orders.aggregate({
          _sum: { amount: true },
          where: {
            created_at: { gte: dayStart, lt: dayEnd },
            status: { in: ['completed', 'delivered', 'shipped', 'paid'] }
          }
        });
        
        gmvData.push(Number(result._sum.amount || 0));
        gmvLabels.push(dayStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
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