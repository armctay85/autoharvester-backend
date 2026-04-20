// ─────────────────────────────────────────────────────────────────────────────
//  Email provider abstraction
//
//  Three implementations behind a common interface:
//    • LogEmailProvider        — writes to stdout, used in dev + tests
//    • ResendEmailProvider     — Resend.com (recommended for AU, ~$20/mo)
//    • PostmarkEmailProvider   — Postmark (battle-tested transactional)
//
//  Configure via env: EMAIL_PROVIDER=resend|postmark|log
//  Required keys (set the one matching EMAIL_PROVIDER):
//    RESEND_API_KEY=...        |   POSTMARK_SERVER_TOKEN=...
//
//  All providers degrade gracefully — missing creds → falls back to
//  LogEmailProvider so the digest cron can still safely run on a fresh
//  Railway container without secrets and not throw.
// ─────────────────────────────────────────────────────────────────────────────

export interface SendEmailParams {
  to: string;
  from?: string;
  subject: string;
  html: string;
  text?: string;
  /** Optional reply-to override (e.g. concierge@) */
  replyTo?: string;
  /** Provider-side categorisation tag (Postmark "Stream" / Resend "tags") */
  tag?: string;
}

export interface SendEmailResult {
  provider: string;
  id: string | null;
  status: 'sent' | 'logged' | 'failed';
  error?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(p: SendEmailParams): Promise<SendEmailResult>;
}

const DEFAULT_FROM = process.env.EMAIL_FROM || 'Autoharvester <hello@autoharvester.com.au>';

// ─────────────────────────────────────────────────────────────────────────────
//  Log provider — used in dev / tests / when no real key is configured.
//  Writes a single-line summary so production logs stay legible.
// ─────────────────────────────────────────────────────────────────────────────

export class LogEmailProvider implements EmailProvider {
  readonly name = 'log';

  async send(p: SendEmailParams): Promise<SendEmailResult> {
    const id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(
      `[email/log] to=${p.to} subject=${JSON.stringify(p.subject)} html_len=${p.html.length} tag=${p.tag ?? 'n/a'} id=${id}`
    );
    return { provider: this.name, id, status: 'logged' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Resend adapter — recommended for AU (Cloudflare-friendly, generous free).
//  Uses fetch only; no SDK dependency required.
// ─────────────────────────────────────────────────────────────────────────────

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  constructor(private readonly opts: { apiKey: string }) {}

  async send(p: SendEmailParams): Promise<SendEmailResult> {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          from: p.from ?? DEFAULT_FROM,
          to: [p.to],
          subject: p.subject,
          html: p.html,
          text: p.text,
          reply_to: p.replyTo,
          tags: p.tag ? [{ name: 'kind', value: p.tag }] : undefined,
        }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          provider: this.name,
          id: null,
          status: 'failed',
          error: body?.message || `resend_${res.status}`,
        };
      }
      return { provider: this.name, id: body?.id ?? null, status: 'sent' };
    } catch (err: any) {
      return { provider: this.name, id: null, status: 'failed', error: String(err?.message || err) };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Postmark adapter — transactional only (perfect for digests, not for blasts).
// ─────────────────────────────────────────────────────────────────────────────

export class PostmarkEmailProvider implements EmailProvider {
  readonly name = 'postmark';
  constructor(private readonly opts: { serverToken: string; messageStream?: string }) {}

  async send(p: SendEmailParams): Promise<SendEmailResult> {
    try {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Postmark-Server-Token': this.opts.serverToken,
        },
        body: JSON.stringify({
          From: p.from ?? DEFAULT_FROM,
          To: p.to,
          Subject: p.subject,
          HtmlBody: p.html,
          TextBody: p.text,
          ReplyTo: p.replyTo,
          MessageStream: this.opts.messageStream || 'outbound',
          Tag: p.tag,
        }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          provider: this.name,
          id: null,
          status: 'failed',
          error: body?.Message || `postmark_${res.status}`,
        };
      }
      return { provider: this.name, id: body?.MessageID ?? null, status: 'sent' };
    } catch (err: any) {
      return { provider: this.name, id: null, status: 'failed', error: String(err?.message || err) };
    }
  }
}

let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;
  const choice = (process.env.EMAIL_PROVIDER || 'log').toLowerCase();
  if (choice === 'resend' && process.env.RESEND_API_KEY) {
    cached = new ResendEmailProvider({ apiKey: process.env.RESEND_API_KEY });
  } else if (choice === 'postmark' && process.env.POSTMARK_SERVER_TOKEN) {
    cached = new PostmarkEmailProvider({
      serverToken: process.env.POSTMARK_SERVER_TOKEN,
      messageStream: process.env.POSTMARK_MESSAGE_STREAM,
    });
  } else {
    cached = new LogEmailProvider();
  }
  return cached;
}

export function _resetEmailProvider() {
  cached = null;
}
