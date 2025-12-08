// src/utils/email.ts
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const sesClient = new SESClient({
  region: process.env.AWS_REGION || 'eu-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

interface SendEmailParams {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  from?: string;
}

/**
 * Send email via AWS SES
 */
export async function sendEmail(params: SendEmailParams): Promise<void> {
  const { to, subject, text, html, from } = params;

  // Default sender - Mulligans
  const fromAddress = from || 'Mulligans <info@mulligans.uk.com>';

  // Convert 'to' to array if it's a single email
  const recipients = Array.isArray(to) ? to : [to];

  console.log('📧 Sending email to:', recipients);
  console.log('📬 Subject:', subject);

  try {
    const command = new SendEmailCommand({
      Source: fromAddress,
      Destination: {
        ToAddresses: recipients,
      },
      Message: {
        Subject: {
          Data: subject,
          Charset: 'UTF-8',
        },
        Body: {
          Text: {
            Data: text,
            Charset: 'UTF-8',
          },
          ...(html && {
            Html: {
              Data: html,
              Charset: 'UTF-8',
            },
          }),
        },
      },
    });

    const result = await sesClient.send(command);
    console.log('✅ Email sent successfully:', result.MessageId);
  } catch (error: any) {
    console.error('❌ Error sending email:', error);
    
    // Provide helpful error messages
    if (error.name === 'MessageRejected') {
      throw new Error('Email was rejected. Check that your AWS SES is verified.');
    }
    if (error.name === 'MailFromDomainNotVerifiedException') {
      throw new Error('Sender email domain is not verified in AWS SES.');
    }
    
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

/**
 * Send email from a template (optional - for future use)
 */
export async function sendTemplateEmail(
  to: string | string[],
  templateName: string,
  templateData: Record<string, any>
): Promise<void> {
  // This is a placeholder for when you want to use SES templates
  // You can implement this later if needed
  console.log('Template email feature coming soon');
}