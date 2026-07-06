'use strict';
/**
 * lib/services/notification_email.js — CPD-1231
 *
 * Optional email companion to in-app notifications when SMTP is configured.
 */

const { resolveEmailForUser } = require('./user_email');
const { logError } = require('../error_logger');

function _smtpConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function _transporter() {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const EMAIL_TEMPLATES = {
  job_ready: {
    subject: 'Your video is ready to review',
    heading: 'Your video is ready',
    body:    'Head to the Review Queue to approve or request changes.',
  },
  job_revision_ready: {
    subject: 'Your revised video is ready',
    heading: 'Revision complete',
    body:    'We applied your feedback — review the updated video when you\'re ready.',
  },
};

/**
 * Send job-ready email if user has an email and SMTP is configured.
 * @param {string} userId
 * @param {{ type: string, title?: string, body?: string, actionUrl?: string }} notification
 */
async function sendJobNotificationEmail(userId, notification) {
  if (!_smtpConfigured()) return false;
  const template = EMAIL_TEMPLATES[notification.type];
  if (!template) return false;

  try {
    const email = await resolveEmailForUser(userId, null);
    if (!email) return false;

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://app.auraflux.co').replace(/\/$/, '');
    const actionPath = notification.actionUrl || '/review';
    const actionHref = actionPath.startsWith('http') ? actionPath : `${appUrl}${actionPath}`;

    await _transporter().sendMail({
      from:    `AuraFlux <${process.env.SMTP_USER || 'support@auraflux.co'}>`,
      to:      email,
      subject: template.subject,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
          <h2 style="margin-bottom:4px">${template.heading}</h2>
          <p style="color:#64748b;margin-top:0">${notification.title || template.body}</p>
          ${notification.body ? `<p>${notification.body}</p>` : ''}
          <a href="${actionHref}"
             style="display:inline-block;margin:16px 0;padding:12px 24px;background:#6366f1;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
            Open Review Queue
          </a>
        </div>
      `,
    });
    console.log(`[notification_email] ${notification.type} sent to ${email}`);
    return true;
  } catch (err) {
    logError('[notification_email] send failed', err, { userId, type: notification.type });
    return false;
  }
}

module.exports = { sendJobNotificationEmail };
