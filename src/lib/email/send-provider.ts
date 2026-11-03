import nodemailer from "nodemailer";
import { decryptSecret } from "@/lib/auth/crypto";
import type { EmailAccountRecord } from "./accounts";

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    public readonly definitive: boolean,
    public readonly code: string = "smtp_error",
  ) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

export interface EmailAttachmentInput {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  headers: Record<string, string>;
  attachments?: EmailAttachmentInput[];
}

export interface DeliveryResult {
  mode: "sandbox" | "live";
  transportMessageId: string;
  response: string;
}

function cleanHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 900);
}

export async function deliverEmail(
  account: EmailAccountRecord,
  email: OutboundEmail,
): Promise<DeliveryResult> {
  const mode = (process.env.EMAIL_DELIVERY_MODE || "sandbox").toLowerCase();
  if (account.provider === "sandbox" || mode !== "live") {
    return {
      mode: "sandbox",
      transportMessageId: email.messageId,
      response:
        account.provider === "sandbox"
          ? "Recorded in the test mailbox. No message left Growth."
          : "EMAIL_DELIVERY_MODE=sandbox. The email was recorded but not transmitted.",
    };
  }

  const password = decryptSecret(account.passwordEncrypted);
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    requireTLS: !account.smtpSecure,
    auth: { user: account.username, pass: password },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
    tls: { minVersion: "TLSv1.2" },
  });

  try {
    const info = await transporter.sendMail({
      from: { name: account.fromName, address: account.emailAddress },
      replyTo: account.replyTo || undefined,
      to: email.to,
      subject: cleanHeader(email.subject),
      text: email.text,
      html: email.html,
      messageId: email.messageId,
      headers: Object.fromEntries(
        Object.entries(email.headers).map(([key, value]) => [
          key,
          cleanHeader(value),
        ]),
      ),
      attachments: email.attachments?.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: attachment.content,
      })),
    });
    return {
      mode: "live",
      transportMessageId: info.messageId || email.messageId,
      response: `${info.response || "SMTP accepted"} (accepted by the sending server; inbox delivery is not guaranteed)`,
    };
  } catch (error) {
    const candidate = error as {
      code?: string;
      responseCode?: number;
      response?: string;
      message?: string;
      command?: string;
    };
    const code = candidate.code || "smtp_error";
    const definitive =
      ["EAUTH", "EENVELOPE", "EMESSAGE", "EINPUT"].includes(code) ||
      (typeof candidate.responseCode === "number" &&
        candidate.responseCode >= 500 &&
        candidate.responseCode < 600);
    let message = candidate.message || "The SMTP server rejected the message.";
    if (code === "EAUTH") {
      message =
        "SMTP authentication failed. Check the IONOS mailbox address and password in Settings.";
    } else if (code === "EENVELOPE") {
      message = `The SMTP server rejected the recipient or sender: ${candidate.response || message}`;
    } else if (code === "ETIMEDOUT" || code === "ESOCKET") {
      message =
        "The SMTP connection failed during sending. Delivery is uncertain. Do not retry until you verify the Sent folder.";
    }
    throw new EmailDeliveryError(message.slice(0, 600), definitive, code);
  } finally {
    transporter.close();
  }
}
