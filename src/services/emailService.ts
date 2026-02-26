import { Resend } from "resend";
import { RESEND_API_KEY } from "../config/envVariables.js";

const resend = new Resend(RESEND_API_KEY);

const FROM_EMAIL = "noreply@aryantechie.in";
const APP_NAME = "Finzz";

export const sendOTPEmail = async (
  to: string,
  otp: string,
  purpose: "verification" | "reset" = "verification",
): Promise<void> => {
  const isReset = purpose === "reset";
  const subject = isReset
    ? `${APP_NAME} — Password Reset OTP`
    : `${APP_NAME} — Email Verification OTP`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 0; }
        .container { max-width: 480px; margin: 40px auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.07); }
        .header { background: linear-gradient(135deg, #6C63FF, #4A90E2); padding: 32px 24px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 24px; letter-spacing: -0.5px; }
        .body { padding: 32px 24px; }
        .otp-box { background: #f0eeff; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0; }
        .otp { font-size: 40px; font-weight: 800; letter-spacing: 12px; color: #6C63FF; }
        .note { color: #888; font-size: 13px; margin-top: 8px; }
        .footer { text-align: center; padding: 16px; color: #bbb; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header"><h1>${APP_NAME}</h1></div>
        <div class="body">
          <p style="color:#333; font-size:16px; margin:0 0 8px;">Hi there 👋</p>
          <p style="color:#555; font-size:14px; line-height:1.6;">
            ${
              isReset
                ? "Use the OTP below to reset your password. It expires in <strong>10 minutes</strong>."
                : "Use the OTP below to verify your email address. It expires in <strong>10 minutes</strong>."
            }
          </p>
          <div class="otp-box">
            <div class="otp">${otp}</div>
            <div class="note">Do not share this OTP with anyone.</div>
          </div>
          <p style="color:#555; font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
        </div>
        <div class="footer">&copy; ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</div>
      </div>
    </body>
    </html>
  `;

  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject,
    html,
  });

  if (error) {
    throw new Error(`Failed to send OTP email: ${error.message}`);
  }
};
