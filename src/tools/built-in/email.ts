import { z } from 'zod';
import { tool } from 'ai';
import { ToolDescriptor } from '../../types';

/**
 * Email Tool Configuration Options
 */
export interface EmailToolOptions {
  /**
   * Email service provider API key
   * Required for sending emails
   */
  apiKey: string;

  /**
   * Email service provider API URL
   * @default 'https://api.resend.com/emails'
   */
  apiUrl?: string;

  /**
   * Default "from" email address
   * Can be overridden per email
   */
  defaultFrom?: string;
}

/**
 * Send email using Resend API
 */
async function sendEmail({
  from,
  to,
  subject,
  text,
  html,
  apiKey,
  apiUrl = 'https://api.resend.com/emails',
}: {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  apiKey: string;
  apiUrl?: string;
}): Promise<string> {
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        text,
        html,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Email sending failed (${response.status}): ${errorData}`);
    }

    const data = await response.json();
    return JSON.stringify(data);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to send email: ${error.message}`);
    }
    throw new Error('Failed to send email with unknown error');
  }
}

/**
 * Create Email Tool
 * Factory function to create an email tool with custom configuration
 */
export function createEmailTool(options: EmailToolOptions): ToolDescriptor {
  const { apiKey, apiUrl, defaultFrom } = options;

  if (!apiKey) {
    throw new Error('Email tool requires an apiKey in options');
  }

  return {
    displayName: 'Send email',
    tool: tool({
      description: 'Sends an email using the Resend.com API. Provide sender, recipients, subject, and content.',
      parameters: z.object({
        from: z.string().describe('The sender email address (e.g., "Sender Name <sender@example.com>"). Can use default if configured.').optional(),
        to: z.array(z.string()).describe('Array of recipient email addresses (e.g., ["user@example.com"])'),
        subject: z.string().describe('The subject line of the email'),
        text: z.string().describe('Plain text content of the email'),
        html: z.string().describe('HTML content of the email'),
      }),
      execute: async ({ from, to, subject, text, html }) => {
        const senderEmail = from || defaultFrom;
        
        if (!senderEmail) {
          throw new Error('Email "from" address is required. Provide it in the parameters or set defaultFrom in options.');
        }

        return sendEmail({
          from: senderEmail,
          to,
          subject,
          text,
          html,
          apiKey,
          apiUrl,
        });
      },
    }),
  };
}
