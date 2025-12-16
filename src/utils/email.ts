// src/utils/email.ts
import sgMail from '@sendgrid/mail';

// Initialize SendGrid with API key
sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

interface SendEmailParams {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
}

/**
 * Send email via SendGrid
 */
export async function sendEmail(params: SendEmailParams): Promise<void> {
  const { to, subject, text, html, from } = params;

  // Default sender - Mulligans
  const fromAddress = from || 'Mulligans <noreply@mulligans.uk.com>';

  // Convert 'to' to array if it's a single email
  const recipients = Array.isArray(to) ? to : [to];

  console.log('📧 Sending email to:', recipients);
  console.log('📬 Subject:', subject);

  try {
    const msg = {
      to: recipients,
      from: fromAddress,
      subject: subject,
      text: text,
      ...(html && { html: html }),
    };

    const result = await sgMail.send(msg);
    console.log('✅ Email sent successfully:', result[0].statusCode);
  } catch (error: any) {
    console.error('❌ Error sending email:', error);

    // Provide helpful error messages
    if (error.response) {
      console.error('SendGrid error body:', error.response.body);
    }

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