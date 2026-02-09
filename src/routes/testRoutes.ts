// src/routes/testRoutes.ts
// ⚠️ ONLY FOR TESTING - Remove or protect before production!

import express from 'express';
import { prisma } from '../lib/prisma';
import {
  autoCancelUnshippedOrders,
  autoReleaseEscrow,
  autoProcessReturnRefunds,
  autoExpireReturns,
  checkLostInTransit,
  runEscrowJobs,
} from '../services/escrowService';

const router = express.Router();

// ============================================
// RUN ALL ESCROW JOBS MANUALLY
// GET /api/test/escrow/run-all
// ============================================
router.get('/escrow/run-all', async (req, res) => {
  console.log('🧪 [TEST] Manually triggering all escrow jobs...');
  
  try {
    await runEscrowJobs();
    res.json({ success: true, message: 'All escrow jobs completed' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// RUN INDIVIDUAL ESCROW JOBS
// ============================================
router.get('/escrow/auto-cancel', async (req, res) => {
  try {
    await autoCancelUnshippedOrders();
    res.json({ success: true, message: 'Auto-cancel job completed' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/escrow/release', async (req, res) => {
  try {
    await autoReleaseEscrow();
    res.json({ success: true, message: 'Escrow release job completed' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/escrow/return-refunds', async (req, res) => {
  try {
    await autoProcessReturnRefunds();
    res.json({ success: true, message: 'Return refund job completed' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/escrow/expire-returns', async (req, res) => {
  try {
    await autoExpireReturns();
    res.json({ success: true, message: 'Return expiry job completed' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/escrow/lost-in-transit', async (req, res) => {
  try {
    await checkLostInTransit();
    res.json({ success: true, message: 'Lost in transit job completed' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// HELPER: Set order dates to trigger escrow
// POST /api/test/escrow/setup-test-order
// ============================================
router.post('/escrow/setup-test-order', async (req, res) => {
  const { orderId, scenario } = req.body;

  if (!orderId || !scenario) {
    return res.status(400).json({ 
      error: 'Required: orderId and scenario',
      scenarios: [
        'ready_for_release',      // Set escrow_release_at to past
        'ready_for_cancel',       // Set auto_cancel_at to past
        'ready_for_lost_check',   // Set shipped_at to 14+ days ago
      ]
    });
  }

  try {
    const now = new Date();
    let updateData: any = {};

    switch (scenario) {
      case 'ready_for_release':
        // Set escrow_release_at to 1 hour ago
        updateData = {
          status: 'delivered',
          escrow_release_at: new Date(now.getTime() - 60 * 60 * 1000),
          delivered_at: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000), // 4 days ago
        };
        break;

      case 'ready_for_cancel':
        // Set auto_cancel_at to 1 hour ago
        updateData = {
          status: 'to_ship',
          auto_cancel_at: new Date(now.getTime() - 60 * 60 * 1000),
        };
        break;

      case 'ready_for_lost_check':
        // Set shipped_at to 15 days ago
        updateData = {
          status: 'in_transit',
          shipped_at: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000),
          lost_notification_sent_at: null,
        };
        break;

      default:
        return res.status(400).json({ error: 'Unknown scenario' });
    }

    const order = await prisma.orders.update({
      where: { id: orderId },
      data: {
        ...updateData,
        updated_at: now,
      },
    });

    res.json({ 
      success: true, 
      message: `Order ${orderId} set up for scenario: ${scenario}`,
      order: {
        id: order.id,
        status: order.status,
        escrow_release_at: order.escrow_release_at,
        auto_cancel_at: order.auto_cancel_at,
        shipped_at: order.shipped_at,
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// HELPER: Set return dates to trigger processing
// POST /api/test/escrow/setup-test-return
// ============================================
router.post('/escrow/setup-test-return', async (req, res) => {
  const { returnId, scenario } = req.body;

  if (!returnId || !scenario) {
    return res.status(400).json({ 
      error: 'Required: returnId and scenario',
      scenarios: [
        'ready_for_refund',    // Set escrow_release_at to past
        'ready_for_expiry',    // Set return_ship_deadline to past
      ]
    });
  }

  try {
    const now = new Date();
    let updateData: any = {};

    switch (scenario) {
      case 'ready_for_refund':
        // Set escrow_release_at to 1 hour ago
        updateData = {
          status: 'delivered',
          escrow_release_at: new Date(now.getTime() - 60 * 60 * 1000),
          delivered_at: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000), // 4 days ago
        };
        break;

      case 'ready_for_expiry':
        // Set return_ship_deadline to 1 hour ago
        updateData = {
          status: 'label_created',
          return_ship_deadline: new Date(now.getTime() - 60 * 60 * 1000),
        };
        break;

      default:
        return res.status(400).json({ error: 'Unknown scenario' });
    }

    const returnRequest = await prisma.return_requests.update({
      where: { id: returnId },
      data: {
        ...updateData,
        updated_at: now,
      },
    });

    res.json({ 
      success: true, 
      message: `Return ${returnId} set up for scenario: ${scenario}`,
      returnRequest: {
        id: returnRequest.id,
        status: returnRequest.status,
        escrow_release_at: returnRequest.escrow_release_at,
        return_ship_deadline: returnRequest.return_ship_deadline,
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// VIEW ORDER STATE (for debugging)
// GET /api/test/order/:orderId
// ============================================
router.get('/order/:orderId', async (req, res) => {
  try {
    const order = await prisma.orders.findUnique({
      where: { id: req.params.orderId },
      include: {
        disputes: true,
        return_requests: true,
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      order: {
        id: order.id,
        status: order.status,
        amount: order.amount,
        seller_payout: order.seller_payout,
        escrow_release_at: order.escrow_release_at,
        auto_cancel_at: order.auto_cancel_at,
        stripe_transfer_id: order.stripe_transfer_id,
        stripe_refund_id: order.stripe_refund_id,
        refunded_at: order.refunded_at,
      },
      disputes: order.disputes,
      return_requests: order.return_requests,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;