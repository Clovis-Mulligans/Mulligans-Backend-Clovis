// src/routes/feedbackRoutes.ts
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken } from '../middleware/auth';
import { sendEmail } from '../utils/email';

const router = Router();

/**
 * Submit feedback
 */
router.post('/submit', authenticateToken, async (req: any, res: Response) => {
  try {
    const { feedbackType, screenFeature, description, severity, deviceInfo } = req.body;
    const userId = req.user.userId || req.user.id;

    console.log('📝 New feedback from user:', userId);

    // Validate required fields
    if (!feedbackType || !screenFeature || !description || !severity) {
      return res.status(400).json({ 
        error: 'Missing required fields: feedbackType, screenFeature, description, severity' 
      });
    }

    // Validate feedback type
    const validTypes = ['bug', 'suggestion', 'confusing', 'general'];
    if (!validTypes.includes(feedbackType)) {
      return res.status(400).json({ 
        error: 'Invalid feedback type. Must be: bug, suggestion, confusing, or general' 
      });
    }

    // Validate severity
    const validSeverities = ['low', 'medium', 'high', 'blocking'];
    if (!validSeverities.includes(severity)) {
      return res.status(400).json({ 
        error: 'Invalid severity. Must be: low, medium, high, or blocking' 
      });
    }

    // Create feedback entry
    const feedback = await prisma.feedback.create({
      data: {
        userId,
        feedbackType,
        screenFeature,
        description,
        severity,
        // deviceInfo: deviceInfo || null, // Field not in schema
        status: 'new'
      },
      include: {
        user: {
          select: {
            id: true,
            display_name: true,
            email: true
          }
        }
      }
    });

    console.log('✅ Feedback saved:', feedback.id);

    // Send email notification
    try {
      await sendFeedbackNotification(feedback);
      console.log('📧 Email notification sent');
    } catch (emailError) {
      console.error('❌ Failed to send feedback email:', emailError);
      // Don't fail the request if email fails
    }

    res.status(201).json({ 
      message: 'Feedback submitted successfully! Thank you for helping us improve Mulligans.',
      feedbackId: feedback.id 
    });

  } catch (error: any) {
    console.error('❌ Error submitting feedback:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

/**
 * Get all feedback (admin only - optional for future)
 */
router.get('/all', authenticateToken, async (req: any, res: Response) => {
  try {
    // You can add admin check here later if needed
    const feedback = await prisma.feedback.findMany({
      include: {
        user: {
          select: {
            id: true,
            display_name: true,
            email: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json({ feedback });
  } catch (error: any) {
    console.error('❌ Error fetching feedback:', error);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

/**
 * Email notification function
 */
async function sendFeedbackNotification(feedback: any) {
  const severityEmoji: Record<string, string> = {
    blocking: '🚨',
    high: '🔴',
    medium: '🟡',
    low: '🟢'
  };

  const typeEmoji: Record<string, string> = {
    bug: '🐛',
    suggestion: '💡',
    confusing: '❓',
    general: '💬'
  };

  const severityLabel: Record<string, string> = {
    blocking: 'BLOCKING',
    high: 'HIGH',
    medium: 'MEDIUM',
    low: 'LOW'
  };

  const subject = `[${severityLabel[feedback.severity] || feedback.severity}] Feedback: ${feedback.screenFeature}`;

  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: 'Montserrat', Arial, sans-serif; line-height: 1.6; color: #111827; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; background: #EAEAE0; }
        .header { background: #1DC690; color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
        .content { background: white; padding: 20px; border: 1px solid #E5E7EB; }
        .field { margin-bottom: 15px; }
        .label { font-weight: bold; color: #374151; font-size: 12px; text-transform: uppercase; }
        .value { margin-top: 5px; padding: 12px; background: #F9FAFB; border-radius: 4px; color: #111827; }
        .severity-blocking { border-left: 4px solid #dc2626; }
        .severity-high { border-left: 4px solid #ef4444; }
        .severity-medium { border-left: 4px solid #f59e0b; }
        .severity-low { border-left: 4px solid #10b981; }
        .footer { margin-top: 20px; padding: 15px; background: #278AB0; color: white; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>📱 New Mulligans Feedback</h2>
        </div>
        <div class="content severity-${feedback.severity}">
          <div class="field">
            <div class="label">From User</div>
            <div class="value">
              <strong>${feedback.user?.display_name || 'Unknown User'}</strong><br>
              ${feedback.user?.email || 'No email'}<br>
              <small>User ID: ${feedback.userId}</small>
            </div>
          </div>

          <div class="field">
            <div class="label">Feedback Type</div>
            <div class="value">${typeEmoji[feedback.feedbackType]} <strong>${feedback.feedbackType.toUpperCase()}</strong></div>
          </div>

          <div class="field">
            <div class="label">Screen/Feature</div>
            <div class="value">${feedback.screenFeature}</div>
          </div>

          <div class="field">
            <div class="label">Severity</div>
            <div class="value">${severityEmoji[feedback.severity]} <strong>${feedback.severity.toUpperCase()}</strong></div>
          </div>

          <div class="field">
            <div class="label">Description</div>
            <div class="value" style="white-space: pre-wrap;">${feedback.description}</div>
          </div>

          ${feedback.deviceInfo ? `
          <div class="field">
            <div class="label">Device Info</div>
            <div class="value">${feedback.deviceInfo}</div>
          </div>
          ` : ''}

          <div class="field">
            <div class="label">Submitted</div>
            <div class="value">${new Date(feedback.createdAt).toLocaleString('en-GB', { 
              dateStyle: 'full', 
              timeStyle: 'short' 
            })}</div>
          </div>

          <div class="field">
            <div class="label">Feedback ID</div>
            <div class="value">#${feedback.id}</div>
          </div>
        </div>
        <div class="footer">
          <p><strong>Mulligans App Feedback System</strong></p>
          <p>To view all feedback in database: <code>SELECT * FROM feedback ORDER BY created_at DESC;</code></p>
        </div>
      </div>
    </body>
    </html>
  `;

  const textBody = `
New Mulligans Feedback Received
================================

Type: ${feedback.feedbackType.toUpperCase()}
Screen/Feature: ${feedback.screenFeature}
Severity: ${feedback.severity.toUpperCase()}

From: ${feedback.user?.display_name || 'Unknown User'} (${feedback.user?.email || 'No email'})
User ID: ${feedback.userId}

Description:
${feedback.description}

${feedback.deviceInfo ? `Device Info: ${feedback.deviceInfo}` : ''}

Submitted: ${new Date(feedback.createdAt).toLocaleString()}
Feedback ID: #${feedback.id}

---
View in database: SELECT * FROM feedback WHERE id = ${feedback.id};
  `;

  await sendEmail({
    to: 'info@mulligans.uk.com',
    subject,
    text: textBody,
    html: htmlBody
  });
}

export default router;
