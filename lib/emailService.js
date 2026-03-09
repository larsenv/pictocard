'use strict';

const nodemailer = require('nodemailer');

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.auth.user,
        pass: config.smtp.auth.pass
      }
    });
  }
  return transporter;
}

/**
 * Send a 6-digit verification code to the sender's email address.
 * @param {string} email - Recipient address
 * @param {string} code  - 6-digit code
 * @param {string} senderName - Display name used in greeting
 */
async function sendVerificationCode(email, code, senderName) {
  const displayName = senderName || 'there';
  const html = `
    <div style="background:#1A1A1E;color:#DCDCDF;font-family:'Whitney',Helvetica,sans-serif;padding:40px;border-radius:8px;max-width:480px;margin:auto;">
      <h2 style="color:#5865f2;margin-top:0;">PictoCard Verification</h2>
      <p>Hi ${escapeHtml(displayName)},</p>
      <p>Use the code below to verify your email and send your card. It expires in <strong>10 minutes</strong>.</p>
      <div style="background:#222327;border-radius:6px;padding:20px;text-align:center;font-size:36px;letter-spacing:12px;font-weight:bold;color:#5865f2;margin:24px 0;">
        ${escapeHtml(code)}
      </div>
      <p style="color:#6C6D76;font-size:13px;">If you did not request this, you can safely ignore this email.</p>
    </div>
  `;

  await getTransporter().sendMail({
    from: `"${config.fromName}" <${config.fromEmail}>`,
    to: email,
    subject: `${code} is your PictoCard verification code`,
    html
  });
}

/**
 * Send the finished greeting card to a recipient.
 * Plain-text body + PNG attachment for maximum compatibility (including Wii via WiiLink).
 * @param {string} recipientEmail   - Destination address
 * @param {string} senderName       - Who the card is from
 * @param {string} message          - Optional short message in the email body
 * @param {Buffer} cardImageBuffer  - PNG image buffer
 */
async function sendCard(recipientEmail, senderName, message, cardImageBuffer) {
  // Strip header injection chars (CR, LF, tab) from senderName used in subject
  const displaySender = (senderName || '').replace(/[\r\n\t]/g, ' ').trim() || 'Someone';

  const bodyLines = [
    `${displaySender} sent you a PictoCard!`,
    ''
  ];
  if (message && message.trim()) {
    bodyLines.push(message.trim(), '');
  }
  bodyLines.push(
    `Sent via PictoCard (${config.domain}).`,
    `You can also receive cards on a Wii via WiiLink - add mail@pictocard.net as a contact on your Wii.`
  );
  const text = bodyLines.join('\n');

  await getTransporter().sendMail({
    from: `"${config.fromName}" <${config.fromEmail}>`,
    to: recipientEmail,
    subject: `${displaySender} sent you a PictoCard!`,
    text,
    attachments: [
      {
        filename: 'pictocard.png',
        content: cardImageBuffer
      }
    ]
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { sendVerificationCode, sendCard };
