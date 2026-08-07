import { vi } from "vitest";

/**
 * In-memory mailbox that replaces the Resend transport for tests.
 *
 * OTPs are stored only as bcrypt hashes, and the plaintext never leaves the
 * server except by email — which is correct, and means a test cannot read the
 * code it needs to submit. Intercepting the mailer is the right seam: it needs
 * no change to production code, keeps the OTP generator and hashing under test
 * exactly as they ship, and mirrors how a real user obtains the code.
 */

export interface SentMail {
  to: string;
  otp: string;
  purpose: "verification" | "reset";
}

export const mailbox: SentMail[] = [];

vi.mock("../src/services/emailService.js", () => ({
  sendOTPEmail: vi.fn(
    async (
      to: string,
      otp: string,
      purpose: "verification" | "reset" = "verification",
    ) => {
      mailbox.push({ to: to.toLowerCase(), otp, purpose });
    },
  ),
}));

export const clearMailbox = () => {
  mailbox.length = 0;
};

/** The most recent OTP sent to an address for a given purpose. */
export const lastOtp = (
  to: string,
  purpose: "verification" | "reset" = "verification",
): string => {
  const match = [...mailbox]
    .reverse()
    .find((m) => m.to === to.toLowerCase() && m.purpose === purpose);
  if (!match) {
    throw new Error(
      `No ${purpose} OTP was sent to ${to}. Mailbox: ${JSON.stringify(mailbox)}`,
    );
  }
  return match.otp;
};

/** How many mails were sent to an address. */
export const mailCount = (to: string) =>
  mailbox.filter((m) => m.to === to.toLowerCase()).length;
