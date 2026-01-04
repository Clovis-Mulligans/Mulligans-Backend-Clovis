// src/services/emailService.ts
import { Resend } from 'resend';
import fs from 'fs';
import path from 'path';

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_ADDRESS = 'Mulligans <noreply@mail.mulligans.uk.com>';

function loadTemplate(templateName: string, variables: Record<string, string>): string {
  // Path goes from dist/services/ up to project root, then into src/email-templates/
  const templatePath = path.join(__dirname, '../../src/email-templates', `${templateName}.html`);
  let html = fs.readFileSync(templatePath, 'utf-8');
  
  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    html = html.replace(regex, value || '');
  });
  
  return html;
}

// ============================================
// AUTHENTICATION EMAILS
// ============================================

export async function sendVerificationEmail(userEmail: string, code: string): Promise<void> {
  const html = loadTemplate('verification-email', { code });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: userEmail,
    subject: 'Verify Your Email - Mulligans',
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send verification email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Verification email sent to ${userEmail}`);
}

export async function sendPasswordResetEmail(userEmail: string, code: string): Promise<void> {
  const html = loadTemplate('password-reset', { code });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: userEmail,
    subject: 'Reset Your Password - Mulligans',
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send password reset email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Password reset email sent to ${userEmail}`);
}

export async function sendWelcomeEmail(userEmail: string, userName: string): Promise<void> {
  const html = loadTemplate('welcome-email', { userName });
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: userEmail,
    subject: 'Welcome to Mulligans!',
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send welcome email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Welcome email sent to ${userEmail}`);
}

// ============================================
// BUYER EMAILS
// ============================================

export async function sendOrderConfirmation(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('order-confirmation', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `Order Confirmed - #${data.orderNumber}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send order confirmation:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Order confirmation sent to ${buyerEmail}`);
}

export async function sendShippingNotification(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('shipping-notification', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `Your Order Has Shipped - #${data.orderNumber}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send shipping notification:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Shipping notification sent to ${buyerEmail}`);
}

export async function sendDeliveryConfirmation(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('delivery-confirmation', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `Your Order Has Been Delivered - #${data.orderNumber}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send delivery confirmation:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Delivery confirmation sent to ${buyerEmail}`);
}

export async function sendReviewReminder(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('review-reminder', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: buyerEmail,
    subject: `How Was Your Purchase? - Mulligans`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send review reminder:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Review reminder sent to ${buyerEmail}`);
}

// ============================================
// SELLER EMAILS
// ============================================

export async function sendSaleNotification(sellerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('sale-notification', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: sellerEmail,
    subject: `🎉 You Made a Sale! - #${data.orderNumber}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send sale notification:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Sale notification sent to ${sellerEmail}`);
}

export async function sendEscrowReleased(sellerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('escrow-released', data);
  
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: sellerEmail,
    subject: `💰 Payment Released - #${data.orderNumber}`,
    html: html,
  });
  
  if (error) {
    console.error('❌ Failed to send escrow released email:', error);
    throw new Error(error.message);
  }
  
  console.log(`✅ Escrow released notification sent to ${sellerEmail}`);
}
// ============================================
// DISPUTE EMAILS
// ============================================

export async function sendDisputeEmail(
  to: string,
  subject: string,
  html: string
): Promise<void> {
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to: to,
    subject: subject,
    html: html,
  });

  if (error) {
    console.error('❌ Failed to send dispute email:', error);
    throw new Error(error.message);
  }

  console.log(`✅ Dispute email sent to ${to}`);
}