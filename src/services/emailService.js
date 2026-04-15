"use strict";
const nodemailer = require('nodemailer');

function createTransport() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_PORT === '465',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
}

/**
 * Send welcome email to new salon admin after successful payment.
 */
async function sendWelcomeEmail({ to, ownerName, salonName, email, password, loginUrl }) {
    const transport = createTransport();
    await transport.sendMail({
        from: process.env.SMTP_FROM || '"SalonBot" <noreply@salonbot.com>',
        to,
        subject: `Welcome to SalonBot — Your account is ready`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:36px 40px;text-align:center;">
            <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Welcome to SalonBot!</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">Your salon management platform is ready</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="color:#374151;font-size:15px;margin:0 0 24px;">Hi ${ownerName},</p>
            <p style="color:#374151;font-size:15px;margin:0 0 24px;">
              Your <strong>${salonName}</strong> account has been successfully created.
              Here are your login credentials:
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:8px;padding:20px;margin-bottom:28px;">
              <tr><td>
                <p style="margin:0 0 8px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Login Email</p>
                <p style="margin:0 0 16px;font-size:16px;color:#1e293b;font-weight:500;">${email}</p>
                <p style="margin:0 0 8px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Temporary Password</p>
                <p style="margin:0;font-size:16px;color:#1e293b;font-weight:500;font-family:monospace;letter-spacing:0.1em;">${password}</p>
              </td></tr>
            </table>
            <p style="color:#6b7280;font-size:13px;margin:0 0 24px;">
              Please change your password after your first login for security.
            </p>
            <a href="${loginUrl}" style="display:inline-block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
              Login to Dashboard
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 28px;border-top:1px solid #f1f5f9;">
            <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
              This email was sent by SalonBot. If you didn't sign up, please ignore this email.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
}

/**
 * Send password reset email with a secure link.
 */
async function sendPasswordResetEmail({ to, ownerName, resetUrl }) {
    const transport = createTransport();
    await transport.sendMail({
        from: process.env.SMTP_FROM || '"SalonBot" <noreply@salonbot.com>',
        to,
        subject: `Reset your SalonBot password`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:36px 40px;text-align:center;">
            <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Password Reset</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">This link expires in 5 minutes</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi ${ownerName},</p>
            <p style="color:#374151;font-size:15px;margin:0 0 28px;">
              We received a request to reset your SalonBot password. Click the button below to set a new password.
              This link will expire in <strong>5 minutes</strong>.
            </p>
            <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
              Reset Password
            </a>
            <p style="color:#6b7280;font-size:13px;margin:24px 0 0;">
              If you didn't request a password reset, you can safely ignore this email. Your password won't be changed.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 28px;border-top:1px solid #f1f5f9;">
            <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
              SalonBot · <a href="${process.env.FRONTEND_URL}" style="color:#9ca3af;">${process.env.FRONTEND_URL}</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail };
