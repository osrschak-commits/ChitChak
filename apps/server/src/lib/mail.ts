import { createTransport, type Transporter } from 'nodemailer';
import { config, isProduction } from '../config.js';

/**
 * Outgoing mail.
 *
 * There is exactly one thing this sends today - a password reset link - and the
 * design follows from that being the only way back into an account. Two
 * consequences:
 *
 *   - Not configuring SMTP must not break the server. A deployment without mail
 *     still runs; it just logs the link instead of sending it, so the operator
 *     can paste it to whoever asked. That is also what makes this developable
 *     locally without standing up a mail server.
 *   - Sending must not throw into a request handler. A failure to deliver is
 *     logged and swallowed, because the alternative leaks: an error on
 *     /password/forgot for a real address and a success for an unknown one
 *     tells an attacker which addresses have accounts.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Built once, lazily. nodemailer pools connections, so the transport is worth
 * keeping; building it at import time would mean a bad SMTP_URL crashes the
 * process on boot rather than failing the one feature that needs it.
 */
let transport: Transporter | null = null;
let transportFailed = false;

function getTransport(): Transporter | null {
  if (!config.SMTP_URL || transportFailed) return null;
  if (transport) return transport;
  try {
    transport = createTransport(config.SMTP_URL);
    return transport;
  } catch {
    transportFailed = true;
    return null;
  }
}

export function mailIsConfigured(): boolean {
  return Boolean(config.SMTP_URL);
}

/**
 * @returns whether it was actually handed to a mail server. Callers use this
 * for logging only - never to shape a response, for the enumeration reason
 * above.
 */
export async function sendMail(mail: Mail, log: MailLogger): Promise<boolean> {
  const mailer = getTransport();

  if (!mailer) {
    // The whole body, not a summary: this is the fallback path where a human
    // has to read the link out of the log and pass it on.
    log.warn(
      { to: mail.to, subject: mail.subject, body: mail.text },
      isProduction
        ? 'SMTP_URL is not set - logging this mail instead of sending it'
        : 'no SMTP_URL in development - mail logged, not sent',
    );
    return false;
  }

  try {
    await mailer.sendMail({ from: config.MAIL_FROM, ...mail });
    log.info({ to: mail.to, subject: mail.subject }, 'mail sent');
    return true;
  } catch (error) {
    // Worth a full error: undeliverable mail means people cannot get back into
    // their accounts, and nothing else in the system will notice.
    log.error({ err: error, to: mail.to, subject: mail.subject }, 'failed to send mail');
    return false;
  }
}

/** The slice of Fastify's logger this needs, so tests can pass anything. */
interface MailLogger {
  info(context: unknown, message: string): void;
  warn(context: unknown, message: string): void;
  error(context: unknown, message: string): void;
}
