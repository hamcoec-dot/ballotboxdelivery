'use strict';
// Outgoing mail. The SMTP connection string lives in Secret Manager (secret SMTP_URL), never in the repo, e.g.
// smtps://elections%40govotehamiltontn.gov:APP-PASSWORD@smtp.gmail.com:465 . Set it to "none" to turn mail off.
const nodemailer = require('nodemailer');
const { defineSecret } = require('firebase-functions/params');

const SMTP_URL = defineSecret('SMTP_URL');
const FROM = 'Hamilton County Election Commission <noreply@govotehamiltontn.gov>';
let transport = null;

function mailConfigured() {
  const v = (process.env.SMTP_URL || '').trim();
  return v.startsWith('smtp://') || v.startsWith('smtps://');
}

async function sendMail(to, subject, text) {
  if (!mailConfigured()) return false;
  if (!transport) transport = nodemailer.createTransport(process.env.SMTP_URL.trim());
  await transport.sendMail({ from: FROM, to, subject, text });
  return true;
}

module.exports = { SMTP_URL, mailConfigured, sendMail };
