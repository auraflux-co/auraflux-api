/**
 * Auth transactional email via SMTP (same vars as API: SMTP_HOST/USER/PASS).
 * No-op when SMTP is not configured — callers still succeed so we don't
 * enumerate users; log a warning for operators.
 */
import nodemailer from 'nodemailer';

export function isSmtpConfigured(): boolean {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendAuthEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<boolean> {
  if (!isSmtpConfigured()) {
    console.warn(
      '[auth-email] SMTP_USER/SMTP_PASS not set — skipped send to',
      opts.to,
      opts.subject,
    );
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const from =
    process.env.SMTP_FROM ||
    `AuraFlux <${process.env.SMTP_USER || 'support@auraflux.co'}>`;

  await transporter.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html || opts.text.replace(/\n/g, '<br/>'),
  });
  return true;
}
