'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');

const createTransport = nodemailer.createTransport;
let messages = [];
nodemailer.createTransport = () => {
  const capture = createTransport({ streamTransport: true, buffer: true });
  return {
    sendMail: async (options) => {
      const mail = await capture.sendMail(options);
      messages.push(await simpleParser(mail.message));
      return mail;
    }
  };
};
const { generateCard } = require('../lib/cardGenerator');
const { prepareCardAttachment, sendCard, sendCardConfirmation } = require('../lib/emailService');

test('captured email and confirmation attachments exactly match the delivery preview', async () => {
  messages = [];
  const card = await generateCard({
    imageBuffer: fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'logo.png')),
    text: 'This is a test', font: 'splatfont2', textColor: '#d14500'
  });
  const preview = await prepareCardAttachment(card);
  await sendCard('friend@example.com', 'Alex', 'This is a test', card, 'alex@example.com');
  await sendCardConfirmation('alex@example.com', 'Alex', 'friend@example.com', card);
  assert.equal(messages.length, 2);
  for (const mail of messages) {
    assert.equal(mail.attachments.length, 1);
    assert.equal(mail.attachments[0].contentType, 'image/jpeg');
    assert.deepEqual(mail.attachments[0].content, preview);
  }
  const original = await sharp(card).metadata();
  const attachment = await sharp(preview).metadata();
  assert.equal(attachment.width, Math.round(original.width * 0.5));
  assert.equal(attachment.height, Math.round(original.height * 0.5));
});
