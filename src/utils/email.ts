// src/utils/email.ts
// Generic email utility using Resend
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

interface SendEmailParams {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
}

/**
 * Send email via Resend
 */
export async function sendEmail(params: SendEmailParams): Promise<void> {
  const { to, subject, text, html, from } = params;
  
  // Default sender - Mulligans
  const fromAddress = from || 'Mulligans <noreply@mail.mulligans.uk.com>';
  
  // Convert 'to' to array if it's a single email
  const recipients = Array.isArray(to) ? to : [to];
  
  console.log('📧 Sending email to:', recipients);
  console.log('📬 Subject:', subject);
  
  try {
    const result = await resend.emails.send({
      from: fromAddress,
      to: recipients,
      subject: subject,
      text: text,
      ...(html && { html: html }),
    });
    
    console.log('✅ Email sent successfully:', result);
  } catch (error: any) {
    console.error('❌ Error sending email:', error);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

/**
 * Send email to multiple recipients individually
 */
export async function sendEmailToMultiple(
  recipients: string[],
  subject: string,
  text: string,
  html?: string
): Promise<void> {
  for (const recipient of recipients) {
    await sendEmail({ to: recipient, subject, text, html });
  }
}