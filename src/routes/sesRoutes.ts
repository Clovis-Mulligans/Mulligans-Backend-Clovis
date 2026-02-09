// src/routes/sesRoutes.ts
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

const router = Router();

// Helper to process SNS messages
const processSnsMessage = async (req: Request, res: Response, type: 'bounce' | 'complaint') => {
  try {
    const body = req.body;
    
    console.log(`[SES ${type}] Received notification:`, JSON.stringify(body, null, 2));

    // Handle SNS Subscription Confirmation
    if (body.Type === 'SubscriptionConfirmation') {
      console.log(`[SES ${type}] Subscription confirmation received`);
      console.log(`[SES ${type}] SubscribeURL:`, body.SubscribeURL);
      
      // Auto-confirm by fetching the SubscribeURL
      if (body.SubscribeURL) {
        try {
          const response = await fetch(body.SubscribeURL);
          console.log(`[SES ${type}] Subscription confirmed:`, response.status);
        } catch (err) {
          console.error(`[SES ${type}] Failed to confirm subscription:`, err);
        }
      }
      
      return res.status(200).json({ message: 'Subscription confirmation received' });
    }

    // Handle actual notifications
    if (body.Type === 'Notification') {
      let message;
      
      // Parse the Message field (it's a JSON string)
      try {
        message = typeof body.Message === 'string' ? JSON.parse(body.Message) : body.Message;
      } catch (e) {
        console.error(`[SES ${type}] Failed to parse message:`, e);
        return res.status(400).json({ error: 'Invalid message format' });
      }

      console.log(`[SES ${type}] Notification type:`, message.notificationType);

      if (type === 'bounce' && message.notificationType === 'Bounce') {
        const bounce = message.bounce;
        const bouncedRecipients = bounce.bouncedRecipients || [];

        for (const recipient of bouncedRecipients) {
          const email = recipient.emailAddress.toLowerCase();
          
          console.log(`[SES bounce] Processing bounced email: ${email}, Type: ${bounce.bounceType}`);

          // Add to suppression list
          try {
            await prisma.email_suppressions.upsert({
              where: { email },
              update: {
                reason: 'bounce',
                bounce_type: bounce.bounceType,
                bounce_subtype: bounce.bounceSubType,
                source: body.MessageId,
              },
              create: {
                email,
                reason: 'bounce',
                bounce_type: bounce.bounceType,
                bounce_subtype: bounce.bounceSubType,
                source: body.MessageId,
              },
            });
            console.log(`[SES bounce] Added ${email} to suppression list`);
          } catch (dbError) {
            console.error(`[SES bounce] Failed to add ${email} to suppression:`, dbError);
          }
        }
      }

      if (type === 'complaint' && message.notificationType === 'Complaint') {
        const complaint = message.complaint;
        const complainedRecipients = complaint.complainedRecipients || [];

        for (const recipient of complainedRecipients) {
          const email = recipient.emailAddress.toLowerCase();
          
          console.log(`[SES complaint] Processing complaint for: ${email}`);

          // Add to suppression list
          try {
            await prisma.email_suppressions.upsert({
              where: { email },
              update: {
                reason: 'complaint',
                source: body.MessageId,
              },
              create: {
                email,
                reason: 'complaint',
                source: body.MessageId,
              },
            });
            console.log(`[SES complaint] Added ${email} to suppression list`);
          } catch (dbError) {
            console.error(`[SES complaint] Failed to add ${email} to suppression:`, dbError);
          }
        }
      }
    }

    res.status(200).json({ message: 'Notification processed' });
  } catch (error) {
    console.error(`[SES ${type}] Error processing notification:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// POST /api/ses/bounces - Handle bounce notifications from SNS
router.post('/bounces', (req, res) => processSnsMessage(req, res, 'bounce'));

// POST /api/ses/complaints - Handle complaint notifications from SNS
router.post('/complaints', (req, res) => processSnsMessage(req, res, 'complaint'));

// GET /api/ses/suppression-list - View suppressed emails (admin use)
router.get('/suppression-list', async (req, res) => {
  try {
    const suppressions = await prisma.email_suppressions.findMany({
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    res.json(suppressions);
  } catch (error) {
    console.error('[SES] Error fetching suppression list:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/ses/check/:email - Check if email is suppressed
router.get('/check/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const suppression = await prisma.email_suppressions.findUnique({
      where: { email },
    });
    res.json({ suppressed: !!suppression, details: suppression });
  } catch (error) {
    console.error('[SES] Error checking suppression:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
