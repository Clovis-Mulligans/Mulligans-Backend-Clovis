// src/services/emailService.ts
import sgMail from '@sendgrid/mail';
import fs from 'fs';
import path from 'path';

// Initialize SendGrid with API key
sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

const FROM_ADDRESS = 'Mulligans <noreply@mulligans.uk.com>';

function loadTemplate(templateName: string, variables: Record<string, string>): string {
  const templatePath = path.join(__dirname, '../email-templates', `${templateName}.html`);
  let html = fs.readFileSync(templatePath, 'utf-8');
  
  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    html = html.replace(regex, value || '');
  });
  
  return html;
}

export async function sendWelcomeEmail(userEmail: string, userName: string): Promise<void> {
  const html = loadTemplate('welcome-email', { userName });
  
  const msg = {
    to: userEmail,
    from: FROM_ADDRESS,
    subject: 'Welcome to Mulligans!',
    html: html,
  };
  
  await sgMail.send(msg);
  console.log(`Welcome email sent to ${userEmail}`);
}

export async function sendOrderConfirmation(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('order-confirmation', data);
  
  const msg = {
    to: buyerEmail,
    from: FROM_ADDRESS,
    subject: `Order Confirmed - #${data.orderNumber}`,
    html: html,
  };
  
  await sgMail.send(msg);
  console.log(`Order confirmation sent to ${buyerEmail}`);
}

export async function sendShippingNotification(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('shipping-notification', data);
  
  const msg = {
    to: buyerEmail,
    from: FROM_ADDRESS,
    subject: `Your Order Has Shipped - #${data.orderNumber}`,
    html: html,
  };
  
  await sgMail.send(msg);
  console.log(`Shipping notification sent to ${buyerEmail}`);
}

export async function sendVerificationEmail(userEmail: string, code: string): Promise<void> {
  const html = loadTemplate('verification-email', { code });
  
  const msg = {
    to: userEmail,
    from: FROM_ADDRESS,
    subject: 'Verify Your Email - Mulligans',
    html: html,
  };
  
  await sgMail.send(msg);
  console.log(`Verification email sent to ${userEmail}`);
}

export async function sendPasswordResetEmail(userEmail: string, code: string): Promise<void> {
  const html = loadTemplate('password-reset', { code });
  
  const msg = {
    to: userEmail,
    from: FROM_ADDRESS,
    subject: 'Reset Your Password - Mulligans',
    html: html,
  };
  
  await sgMail.send(msg);
  console.log(`Password reset email sent to ${userEmail}`);
}