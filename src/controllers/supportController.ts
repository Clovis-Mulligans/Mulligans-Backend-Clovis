// src/controllers/supportController.ts
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { S3Service } from '../services/s3Service';
import { v4 as uuidv4 } from 'uuid';
import { sendEmail } from '../utils/email';


export class SupportController {
  /**
   * Submit a support ticket
   * POST /api/support/contact
   */
  static async submitTicket(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const { type, subject, message, order_id } = req.body;
      const files = req.files as Express.Multer.File[];

      console.log('📩 New support ticket from user:', userId);

      // Validate required fields
      if (!type || !subject || !message) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      if (type !== 'purchase' && type !== 'general') {
        return res.status(400).json({ error: 'Invalid support type' });
      }

      // Get user details
      const user = await prisma.users.findUnique({
        where: { id: userId },
        select: {
          email: true,
          display_name: true,
        },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Create support ticket
      const ticketId = uuidv4();
      const ticket = await prisma.support_tickets.create({
        data: {
          id: ticketId,
          user_id: userId,
          type,
          order_id: order_id || null,
          subject,
          message,
          status: 'open',
          updated_at: new Date(),
        },
      });

      console.log('✅ Ticket created:', ticket.id);

      // Upload images to S3
      const imageUrls: string[] = [];
      if (files && files.length > 0) {
        console.log(`📸 Uploading ${files.length} images...`);
        
        for (const file of files) {
          const result = await S3Service.uploadSupportImage(
            file.buffer,
            file.mimetype,
            file.originalname,
            ticketId
          );

          imageUrls.push(result.url);

          // Save to database
          await prisma.support_ticket_images.create({
            data: {
              id: uuidv4(),
              ticket_id: ticketId,
              image_url: result.url,
              s3_key: result.key,
            },
          });
        }
        
        console.log(`✅ ${files.length} images uploaded`);
      }

      // Get order details if it's a purchase report
      let orderDetails = null;
      if (order_id) {
        orderDetails = await prisma.orders.findUnique({
          where: { id: order_id },
          include: {
            listings: {
              select: {
                title: true,
                price: true,
              },
            },
            users_orders_seller_idTousers: {
              select: {
                display_name: true,
                email: true,
              },
            },
          },
        });
      }

      // Send email to support team
      const supportEmailText = `
New Support Ticket Received

Ticket ID: ${ticket.id}
Type: ${type === 'purchase' ? 'Purchase Report' : 'General Inquiry'}
User: ${user.display_name || 'Unknown'} (${user.email})
User ID: ${userId}
Subject: ${subject}

Message:
${message}

${orderDetails ? `
Order Details:
- Order ID: ${order_id}
- Listing: ${orderDetails.listings?.title || 'N/A'}
- Amount: £${orderDetails.amount}
- Seller: ${orderDetails.users_orders_seller_idTousers?.display_name} (${orderDetails.users_orders_seller_idTousers?.email})
` : ''}

${imageUrls.length > 0 ? `\nAttached Images:\n${imageUrls.join('\n')}` : ''}

---
Submitted at: ${new Date().toISOString()}
      `.trim();

      try {
        await sendEmail({
          to: 'info@mulligans.uk.com',
          subject: `[Support Ticket] ${subject}`,
          text: supportEmailText,
        });
        console.log('📧 Support email sent');
      } catch (emailError) {
        console.error('❌ Failed to send support email:', emailError);
        // Don't fail the request if email fails
      }

      // Send confirmation email to user
      const userEmailText = `
Hi ${user.display_name || 'there'},

Thank you for contacting Mulligans Support. We've received your message and will respond within 24 hours.

Your ticket details:
- Ticket Reference: ${ticket.id}
- Subject: ${subject}
- Type: ${type === 'purchase' ? 'Purchase Report' : 'General Inquiry'}

Our support team will review your inquiry and get back to you at ${user.email}.

If you need to add more information, please reply to this email with your ticket reference.

Best regards,
The Mulligans Team
      `.trim();

      try {
        await sendEmail({
          to: user.email,
          subject: 'We received your message - Mulligans Support',
          text: userEmailText,
        });
        console.log('📧 Confirmation email sent to user');
      } catch (emailError) {
        console.error('❌ Failed to send confirmation email:', emailError);
        // Don't fail the request if email fails
      }

      res.json({
        success: true,
        ticket: {
          id: ticket.id,
          subject: ticket.subject,
          created_at: ticket.created_at,
        },
      });
    } catch (error: any) {
      console.error('❌ Support ticket error:', error);
      res.status(500).json({ 
        error: 'Failed to submit support ticket',
        details: error.message 
      });
    }
  }

  /**
   * Get user's support tickets
   * GET /api/support/tickets
   */
  static async getUserTickets(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;

      const tickets = await prisma.support_tickets.findMany({
        where: { user_id: userId },
        include: {
          images: true,
          orders: {
            include: {
              listings: {
                select: {
                  title: true,
                  price: true,
                },
              },
            },
          },
        },
        orderBy: { created_at: 'desc' },
      });

      res.json({ tickets });
    } catch (error: any) {
      console.error('❌ Get tickets error:', error);
      res.status(500).json({ error: 'Failed to get support tickets' });
    }
  }
}