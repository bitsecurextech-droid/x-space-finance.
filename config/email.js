// config/email.js – Brevo API with fallback
const nodemailer = require('nodemailer');
require('dotenv').config();

let apiInstance = null;
let transporter = null;

// Try Brevo API first
try {
  const brevo = require('@getbrevo/brevo');
  const apiKey = process.env.BREVO_API_KEY;
  if (apiKey && apiKey.length > 10) {
    const defaultClient = brevo.ApiClient.instance;
    const auth = defaultClient.authentications['api-key'];
    auth.apiKey = apiKey;
    apiInstance = new brevo.TransactionalEmailsApi();
    console.log('📧 Brevo API configured');
  } else {
    console.warn('⚠️ BREVO_API_KEY missing – trying SMTP fallback');
  }
} catch (e) {
  console.warn('⚠️ Brevo SDK not installed – trying SMTP fallback');
}

// SMTP fallback (in case API fails)
if (!apiInstance) {
  try {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER || 'aed6e3001@smtp-brevo.com',
        pass: process.env.SMTP_PASS || ''
      },
      tls: { rejectUnauthorized: false }
    });
    console.log('📧 SMTP transporter configured (fallback)');
  } catch (e) {
    console.log('📧 Email disabled – no transport available');
  }
}

async function sendVerificationEmail(to, token) {
  const verifyUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/verify-email?token=${token}`;
  
  // Try API first
  if (apiInstance) {
    try {
      const brevo = require('@getbrevo/brevo');
      const sendSmtpEmail = new brevo.SendSmtpEmail();
      sendSmtpEmail.subject = 'Verify your XSpaceFinance account';
      sendSmtpEmail.htmlContent = `
        <h1>Welcome to XSpaceFinance</h1>
        <p>Click the link below to verify your email:</p>
        <a href="${verifyUrl}">${verifyUrl}</a>
        <p>This link expires in 24 hours.</p>
      `;
      sendSmtpEmail.sender = { name: 'XSpaceFinance', email: process.env.SMTP_FROM || 'noreply@xspacefinance.com' };
      sendSmtpEmail.to = [{ email: to }];
      await apiInstance.sendTransacEmail(sendSmtpEmail);
      console.log('📧 Verification email sent to', to);
      return;
    } catch (error) {
      console.error('❌ API send failed:', error.message);
      // Fall through to SMTP
    }
  }

  // SMTP fallback
  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || '"XSpaceFinance" <noreply@xspacefinance.com>',
        to,
        subject: 'Verify your XSpaceFinance account',
        html: `
          <h1>Welcome to XSpaceFinance</h1>
          <p>Click the link below to verify your email:</p>
          <a href="${verifyUrl}">${verifyUrl}</a>
          <p>This link expires in 24 hours.</p>
        `
      });
      console.log('📧 Verification email sent via SMTP to', to);
      return;
    } catch (error) {
      console.error('❌ SMTP send failed:', error.message);
    }
  }

  console.log('📧 Email disabled – would send to', to);
}

async function sendResetPasswordEmail(to, token) {
  const resetUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/reset-password?token=${token}`;
  
  if (apiInstance) {
    try {
      const brevo = require('@getbrevo/brevo');
      const sendSmtpEmail = new brevo.SendSmtpEmail();
      sendSmtpEmail.subject = 'Reset your XSpaceFinance password';
      sendSmtpEmail.htmlContent = `
        <h1>Password Reset</h1>
        <p>Click the link below to reset your password:</p>
        <a href="${resetUrl}">${resetUrl}</a>
        <p>This link expires in 1 hour.</p>
      `;
      sendSmtpEmail.sender = { name: 'XSpaceFinance', email: process.env.SMTP_FROM || 'noreply@xspacefinance.com' };
      sendSmtpEmail.to = [{ email: to }];
      await apiInstance.sendTransacEmail(sendSmtpEmail);
      console.log('📧 Reset email sent to', to);
      return;
    } catch (error) {
      console.error('❌ API reset failed:', error.message);
    }
  }

  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || '"XSpaceFinance" <noreply@xspacefinance.com>',
        to,
        subject: 'Reset your XSpaceFinance password',
        html: `
          <h1>Password Reset</h1>
          <p>Click the link below to reset your password:</p>
          <a href="${resetUrl}">${resetUrl}</a>
          <p>This link expires in 1 hour.</p>
        `
      });
      console.log('📧 Reset email sent via SMTP to', to);
      return;
    } catch (error) {
      console.error('❌ SMTP reset failed:', error.message);
    }
  }

  console.log('📧 Email disabled – would send reset to', to);
}

module.exports = { sendVerificationEmail, sendResetPasswordEmail };