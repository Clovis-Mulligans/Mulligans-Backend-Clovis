import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import fs from 'fs';
import path from 'path';

const sesClient = new SESClient({ region: process.env.AWS_REGION || 'eu-west-2' });

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
  
  const command = new SendEmailCommand({
    Source: 'Mulligans <noreply@mulligans.uk.com>',
    Destination: { ToAddresses: [userEmail] },
    Message: {
      Subject: { Data: 'Welcome to Mulligans!' },
      Body: { Html: { Data: html } }
    }
  });
  
  await sesClient.send(command);
  console.log(`Welcome email sent to ${userEmail}`);
}

export async function sendOrderConfirmation(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('order-confirmation', data);
  
  const command = new SendEmailCommand({
    Source: 'Mulligans <noreply@mulligans.uk.com>',
    Destination: { ToAddresses: [buyerEmail] },
    Message: {
      Subject: { Data: `Order Confirmed - #${data.orderNumber}` },
      Body: { Html: { Data: html } }
    }
  });
  
  await sesClient.send(command);
  console.log(`Order confirmation sent to ${buyerEmail}`);
}

export async function sendShippingNotification(buyerEmail: string, data: Record<string, string>): Promise<void> {
  const html = loadTemplate('shipping-notification', data);
  
  const command = new SendEmailCommand({
    Source: 'Mulligans <noreply@mulligans.uk.com>',
    Destination: { ToAddresses: [buyerEmail] },
    Message: {
      Subject: { Data: `Your Order Has Shipped - #${data.orderNumber}` },
      Body: { Html: { Data: html } }
    }
  });
  
  await sesClient.send(command);
  console.log(`Shipping notification sent to ${buyerEmail}`);
}
