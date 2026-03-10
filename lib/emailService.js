'use strict';

const nodemailer = require('nodemailer');
const { createCanvas, loadImage } = require('canvas');

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

// JPEG quality for email attachments: 85% keeps file size reasonable while staying sharp
const EMAIL_JPEG_QUALITY = 0.85;

/**
 * Resize an image buffer to a given scale factor.
 * Returns a JPEG buffer for smaller file size.
 * @param {Buffer} buffer - Input image buffer
 * @param {number} scale  - Scale factor (0 < scale <= 1)
 */
async function resizeImage(buffer, scale) {
  const img = await loadImage(buffer);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toBuffer('image/jpeg', { quality: EMAIL_JPEG_QUALITY });
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
    <div style="background:#1A1A1E;color:#DCDCDF;font-family:'rodin',Helvetica,sans-serif;padding:40px;border-radius:8px;max-width:480px;margin:auto;">
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
 * Plain-text body + JPEG attachment (50% scale) for maximum compatibility (including Wii via WiiLink).
 * @param {string} recipientEmail   - Destination address
 * @param {string} senderName       - Who the card is from
 * @param {string} message          - Optional short message in the email body
 * @param {Buffer} cardImageBuffer  - PNG image buffer (full size)
 * @param {string} [senderEmail]    - Sender's email address for Reply-To header
 */
async function sendCard(recipientEmail, senderName, message, cardImageBuffer, senderEmail) {
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
    '---',
    `Sent via PictoCard (${config.domain}).`
  );
  const text = bodyLines.join('\n');

  // Shrink the image to 50% for email delivery
  const attachmentBuffer = await resizeImage(cardImageBuffer, 0.5);

  const mailOptions = {
    from: `"${config.fromName}" <${config.fromEmail}>`,
    to: recipientEmail,
    subject: `${displaySender} sent you a PictoCard!`,
    text,
    attachments: [
      {
        filename: 'pictocard.jpg',
        content: attachmentBuffer
      }
    ]
  };

  // Set Reply-To to the sender's email so replies go to them, not the service address
  if (senderEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail.trim())) {
    mailOptions.replyTo = senderEmail.trim();
  }

  await getTransporter().sendMail(mailOptions);
}

/**
 * Send a delivery confirmation to the card sender.
 * @param {string} senderEmail      - Sender's email address
 * @param {string} senderName       - Sender's display name
 * @param {string} recipientEmail   - Recipient address (shown in confirmation)
 */
async function sendCardConfirmation(senderEmail, senderName, recipientEmail) {
  const displaySender = (senderName || '').replace(/[\r\n\t]/g, ' ').trim() || 'there';
  const safeRecipient = (recipientEmail || '').replace(/[\r\n\t]/g, ' ').trim();

  const text = [
    `Hi ${displaySender},`,
    '',
    `Your PictoCard has been delivered to ${safeRecipient}.`,
    '',
    `Sent via PictoCard (${config.domain}).`
  ].join('\n');

  await getTransporter().sendMail({
    from: `"${config.fromName}" <${config.fromEmail}>`,
    to: senderEmail,
    subject: 'Your PictoCard has been sent!',
    text
  });
}

/**
 * Send an opt-out confirmation to the address that was just opted out.
 * @param {string} email - The address that opted out
 */
async function sendOptoutConfirmation(email) {
  const safeEmail = (email || '').replace(/[\r\n\t]/g, ' ').trim();

  const text = [
    `You have been opted out of PictoCard.`,
    '',
    `The address ${safeEmail} will no longer receive PictoCards.`,
    '',
    `If you believe this was a mistake, please contact us at ${config.domain}.`,
    '',
    `---`,
    `PictoCard (${config.domain})`
  ].join('\n');

  await getTransporter().sendMail({
    from: `"${config.fromName}" <${config.fromEmail}>`,
    to: safeEmail,
    subject: 'You have been opted out of PictoCard',
    text
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

module.exports = { sendVerificationCode, sendCard, sendCardConfirmation, sendOptoutConfirmation };
