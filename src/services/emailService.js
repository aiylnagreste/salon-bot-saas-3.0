"use strict";
const nodemailer = require('nodemailer');

function esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function safeUrl(url) {
    return (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) ? url : '#';
}// Add this at the top of emailService.js
console.log("📧 Email Service Initialized");
console.log("   Host:", process.env.SMTP_HOST);
console.log("   Port:", process.env.SMTP_PORT);
console.log("   User:", process.env.SMTP_USER);
console.log("   Has Password:", !!process.env.SMTP_PASS);
console.log("   From:", process.env.SMTP_FROM);

function createTransport() {
  const config = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  };

  console.log("📧 Creating transport with:", {
    host: config.host,
    port: config.port,
    secure: config.secure,
    authUser: config.auth.user
  });

  const transporter = nodemailer.createTransport(config);

  // Verify on startup
  transporter.verify((error, success) => {
    if (error) {
      console.error("❌ SMTP Verification Failed:", error.message);
    } else {
      console.log("✅ SMTP Ready to send emails");
    }
  });

  return transporter;
}

/**
 * Send welcome email to new salon admin after successful payment.
 */
async function sendWelcomeEmail({ to, ownerName, salonName, email, password, loginUrl }) {
    const transport = createTransport();
    await transport.sendMail({
        from: process.env.SMTP_FROM || '"Salon" <noreply@salon.com>',
        to,
        subject: `Welcome to Salon — Your account is ready`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#b5484b 0%,#6b3057 100%);padding:36px 40px;text-align:center;">
            <div style="width:56px;height:56px;background:rgba(255,255,255,0.15);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
              <span style="font-size:28px;">✨</span>
            </div>
            <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">Welcome to Salon!</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">Your salon management platform is ready</p>
           </td>
         </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="color:#1A1D23;font-size:15px;margin:0 0 24px;font-weight:500;">Hi ${esc(ownerName)},</p>
            <p style="color:#5F6577;font-size:15px;margin:0 0 24px;line-height:1.6;">
              Your <strong style="color:#b5484b;">${esc(salonName)}</strong> account has been successfully created.
              Here are your login credentials:
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F9FC;border-radius:8px;padding:20px;margin-bottom:28px;border-left:3px solid #b5484b;">
              <tr><td>
                <p style="margin:0 0 8px;font-size:11px;color:#5F6577;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Login Email</p>
                <p style="margin:0 0 20px;font-size:16px;color:#1A1D23;font-weight:500;">${esc(email)}</p>
                <p style="margin:0 0 8px;font-size:11px;color:#5F6577;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Temporary Password</p>
                <p style="margin:0;font-size:16px;color:#b5484b;font-weight:600;font-family:'SF Mono',monospace;letter-spacing:0.5px;background:#fff;display:inline-block;padding:6px 12px;border-radius:6px;">${esc(password)}</p>
               </td>
             </tr>
            </table>
            <p style="color:#5F6577;font-size:13px;margin:0 0 28px;line-height:1.5;">
              ⚠️ Please change your password after your first login for security.
            </p>
            <a href="${safeUrl(loginUrl)}" style="display:inline-block;background:linear-gradient(135deg,#b5484b 0%,#6b3057 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;font-weight:600;box-shadow:0 2px 8px rgba(181,72,75,0.3);">
              Login to Dashboard
            </a>
            <p style="color:#9CA3B4;font-size:12px;margin:28px 0 0;text-align:center;">
              Link expires in <strong>24 hours</strong> for security
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 28px;border-top:1px solid #F1F5F9;">
            <p style="margin:0;font-size:12px;color:#9CA3AF;text-align:center;">
              This email was sent by Salon. If you didn't sign up, please ignore this email.
            </p>
            <p style="margin:12px 0 0;font-size:11px;color:#CBD5E1;text-align:center;">
              &copy; Salon — Secure salon management
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
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
        from: process.env.SMTP_FROM || '"Salon" <noreply@salon.com>',
        to,
        subject: `Reset your Salon password`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#b5484b 0%,#6b3057 100%);padding:36px 40px;text-align:center;">
            <div style="width:56px;height:56px;background:rgba(255,255,255,0.15);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
              <span style="font-size:28px;">🔒</span>
            </div>
            <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">Password Reset</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">This link expires in 5 minutes</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="color:#1A1D23;font-size:15px;margin:0 0 20px;font-weight:500;">Hi ${esc(ownerName)},</p>
            <p style="color:#5F6577;font-size:15px;margin:0 0 28px;line-height:1.6;">
              We received a request to reset your Salon password. Click the button below to set a new password.
              This link will expire in <strong style="color:#b5484b;">5 minutes</strong> for security.
            </p>
            <a href="${safeUrl(resetUrl)}" style="display:inline-block;background:linear-gradient(135deg,#b5484b 0%,#6b3057 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;font-weight:600;box-shadow:0 2px 8px rgba(181,72,75,0.3);">
              Reset Password
            </a>
            <div style="margin:32px 0 0;padding:16px;background:#F8F9FC;border-left:3px solid #b5484b;border-radius:6px;">
              <p style="color:#5F6577;font-size:12px;margin:0 0 6px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">⚠️ Security Notice</p>
              <p style="color:#5F6577;font-size:13px;margin:0;line-height:1.5;">
                If you didn't request a password reset, you can safely ignore this email. 
                Your password won't be changed.
              </p>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 28px;border-top:1px solid #F1F5F9;">
            <p style="margin:0 0 8px;font-size:12px;color:#9CA3AF;text-align:center;">
              Salon · Secure Salon Management
            </p>
            <p style="margin:0;font-size:11px;color:#CBD5E1;text-align:center;">
              <a href="${safeUrl(process.env.FRONTEND_URL || '')}" style="color:#b5484b;text-decoration:none;">${esc(process.env.FRONTEND_URL || '')}</a>
            </p>
          </td>
        </tr>
      </table>
    </table>
  </table>
</body>
</html>`,
    });
}

/**
 * Send plan upgrade confirmation email
 */
async function sendPlanUpgradeEmail({ to, ownerName, salonName, oldPlanName, newPlanName, amount, billingCycle, nextBillingDate }) {
    const transport = createTransport();
    await transport.sendMail({
        from: process.env.SMTP_FROM || '"Salon" <noreply@salon.com>',
        to,
        subject: `Plan Upgrade Confirmed — ${salonName}`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#b5484b 0%,#6b3057 100%);padding:36px 40px;text-align:center;">
            <div style="width:56px;height:56px;background:rgba(255,255,255,0.15);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
              <span style="font-size:28px;">🚀</span>
            </div>
            <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Plan Upgraded!</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">Your salon now has more power</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="color:#1A1D23;font-size:15px;margin:0 0 20px;font-weight:500;">Hi ${esc(ownerName)},</p>
            <p style="color:#5F6577;font-size:15px;margin:0 0 24px;line-height:1.6;">
              Great news! Your <strong style="color:#b5484b;">${esc(salonName)}</strong> salon has been upgraded from 
              <strong>${esc(oldPlanName)}</strong> to <strong>${esc(newPlanName)}</strong>.
            </p>
            
            <div style="background:#F8F9FC;border-radius:12px;padding:20px;margin-bottom:24px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
                <span style="color:#5F6577;">New Plan:</span>
                <strong style="color:#1A1D23;">${esc(newPlanName)}</strong>
              </div>
              <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
                <span style="color:#5F6577;">Amount:</span>
                <strong style="color:#1A1D23;">${amount}/${billingCycle}</strong>
              </div>
              <div style="display:flex;justify-content:space-between;">
                <span style="color:#5F6577;">Next Billing Date:</span>
                <strong style="color:#1A1D23;">${nextBillingDate}</strong>
              </div>
            </div>
            
            <div style="background:#EFF6FF;border-left:3px solid #b5484b;border-radius:6px;padding:16px;margin-bottom:28px;">
              <p style="color:#1E40AF;font-size:13px;margin:0;line-height:1.5;">
                ✨ <strong>What's new?</strong> You now have access to additional features including 
                more services, advanced integrations, and priority support.
              </p>
            </div>
            
            <a href="${safeUrl(process.env.FRONTEND_URL || '')}/dashboard/settings?tab=plan" style="display:inline-block;background:linear-gradient(135deg,#b5484b 0%,#6b3057 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;font-weight:600;">
              View Your New Plan
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 28px;border-top:1px solid #F1F5F9;">
            <p style="margin:0;font-size:12px;color:#9CA3AF;text-align:center;">
              Need help? Contact our support team anytime.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </table>
</body>
</html>`,
    });
}

/**
 * Send plan downgrade confirmation email
 */
async function sendPlanDowngradeEmail({ to, ownerName, salonName, oldPlanName, newPlanName, effectiveDate }) {
    const transport = createTransport();
    await transport.sendMail({
        from: process.env.SMTP_FROM || '"Salon" <noreply@salon.com>',
        to,
        subject: `Plan Downgrade Confirmed — ${salonName}`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#f59e0b 0%,#d97706 100%);padding:36px 40px;text-align:center;">
            <div style="width:56px;height:56px;background:rgba(255,255,255,0.15);border-radius:16px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
              <span style="font-size:28px;">📉</span>
            </div>
            <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Plan Downgraded</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px;">Changes will take effect soon</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="color:#1A1D23;font-size:15px;margin:0 0 20px;font-weight:500;">Hi ${esc(ownerName)},</p>
            <p style="color:#5F6577;font-size:15px;margin:0 0 24px;line-height:1.6;">
              Your <strong>${esc(salonName)}</strong> salon plan has been downgraded from 
              <strong>${esc(oldPlanName)}</strong> to <strong>${esc(newPlanName)}</strong>.
            </p>
            
            <div style="background:#FEF2F2;border-left:3px solid #EF4444;border-radius:6px;padding:16px;margin-bottom:28px;">
              <p style="color:#DC2626;font-size:13px;margin:0;line-height:1.5;">
                ⚠️ <strong>Important:</strong> This change will take effect on <strong>${effectiveDate}</strong>. 
                Some features may be limited after this date.
              </p>
            </div>
            
            <div style="background:#FFFBEB;border-radius:8px;padding:16px;margin-bottom:24px;">
              <p style="color:#D97706;font-size:13px;margin:0 0 8px;font-weight:600;">📋 What this means for you:</p>
              <ul style="margin:0;padding-left:20px;color:#D97706;font-size:13px;">
                <li>Your service limit will be reduced</li>
                <li>Some premium integrations may be disabled</li>
                <li>Your billing amount will be adjusted</li>
              </ul>
            </div>
            
            <a href="${safeUrl(process.env.FRONTEND_URL || '')}/dashboard/settings?tab=plan" style="display:inline-block;background:linear-gradient(135deg,#b5484b 0%,#6b3057 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:14px;font-weight:600;">
              View Details
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 28px;border-top:1px solid #F1F5F9;">
            <p style="margin:0;font-size:12px;color:#9CA3AF;text-align:center;">
              You can upgrade again anytime from your dashboard settings.
            </p>
          </td>
        </tr>
      </table>
    </table>
  </table>
</body>
</html>`,
    });
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail ,sendPlanUpgradeEmail, 
    sendPlanDowngradeEmail };
