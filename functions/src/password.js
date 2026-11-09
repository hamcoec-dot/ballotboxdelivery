'use strict';
// Pure helpers for the "set your password" email. Firebase won't let this project change its own email
// text, so we take the one-time code out of the Admin SDK's reset link and send our own link instead.

const APP_URL = 'https://govotehamiltontn.gov/ballotboxdelivery/';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_MS = 2 * 60 * 1000;   // one email per account every two minutes

const normEmail = (v) => String(v || '').trim().toLowerCase();
const isEmail = (v) => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);

/** Our own link to the app's Set your password screen, from a Firebase reset link. */
function appResetUrl(firebaseLink, appUrl = APP_URL) {
  const code = new URL(firebaseLink).searchParams.get('oobCode');
  if (!code) throw new Error('Reset link has no oobCode');
  const u = new URL(appUrl);
  u.searchParams.set('mode', 'resetPassword');
  u.searchParams.set('oobCode', code);
  return u.toString();
}

function passwordEmailText(email, url) {
  return {
    subject: 'Set your Ballot Box Delivery password',
    text: `Hello,\n\nFollow this link to set a new password for your Ballot Box Delivery account (${email}):\n\n${url}\n\n`
      + 'The link works once and expires in about an hour. If it has expired, open Ballot Box Delivery, type your email and tap Forgot password? for a new one.\n\n'
      + "If you didn't ask to reset your password, you can ignore this email.\n\n"
      + 'Hamilton County Election Commission\nBallot Box Delivery',
  };
}

const tooSoon = (lastAt, now = Date.now()) => typeof lastAt === 'number' && now - lastAt < RESEND_MS;

module.exports = { APP_URL, RESEND_MS, normEmail, isEmail, appResetUrl, passwordEmailText, tooSoon };
