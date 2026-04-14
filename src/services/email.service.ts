/**
 * Transactional email via Resend.
 *
 * In development (or when RESEND_API_KEY starts with "re_placeholder"/"re_dev"),
 * we DON'T actually send emails — we log the verification/reset link to
 * stdout so you can click it during local testing. This avoids:
 *   - Needing a real Resend account for local dev.
 *   - Accidentally hitting real inboxes while iterating.
 *
 * vibesec: the email body contains the raw token in a URL. Resend connections
 * are TLS, but if your email provider stores messages in plaintext, that
 * token is readable to anyone with inbox access. Expiries (verify: 24h,
 * reset: 1h) limit the blast radius. `name` is plain-text inserted into
 * HTML — we HTML-escape it here to defeat template injection if a user
 * manages to set a name with `<script>` tags. zod already blocks that at
 * signup but defense-in-depth.
 */
import { Resend } from 'resend';
import { config, isProduction } from '../config.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Initialize Resend lazily so tests don't need a real key.
let _client: Resend | null = null;
function client(): Resend {
  if (!_client) _client = new Resend(config.RESEND_API_KEY);
  return _client;
}

// If the user hasn't set a real Resend key, log-only mode.
function isLogOnly(): boolean {
  if (!isProduction) return true;
  const k = config.RESEND_API_KEY;
  return !k || k.startsWith('re_placeholder') || k.startsWith('re_dev');
}

async function send(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  if (isLogOnly()) {
    // eslint-disable-next-line no-console
    console.log('\n[email:dev] ----------------------------------------');
    console.log(`[email:dev] to:      ${opts.to}`);
    console.log(`[email:dev] subject: ${opts.subject}`);
    console.log(`[email:dev] text:\n${opts.text}`);
    console.log('[email:dev] ----------------------------------------\n');
    return;
  }

  const { error } = await client().emails.send({
    from: config.EMAIL_FROM,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });
  if (error) {
    // Rethrow so the caller (auth service) can decide whether to surface
    // or swallow. For signup/reset we'll swallow — we don't want the HTTP
    // response to hint that the email exists or doesn't.
    throw new Error(`Resend send failed: ${error.message}`);
  }
}

// ---------- Templates ----------

export async function sendVerifyEmail(params: {
  to: string;
  token: string;
  name?: string | null;
}): Promise<void> {
  const link = `${config.APP_URL}/api/auth/verify?token=${encodeURIComponent(params.token)}`;
  const safeName = params.name ? escapeHtml(params.name) : '';
  const greeting = safeName ? `Olá ${safeName},` : 'Olá,';

  const subject = 'Confirme seu email — BusinessCalc';
  const text = `${greeting.replace(/<[^>]+>/g, '')}

Bem-vindo(a) ao BusinessCalc. Clique no link abaixo para confirmar seu email:

${link}

O link expira em 24 horas. Se você não criou uma conta, ignore este email.

— BusinessCalc`;

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1a1a1a;">
  <h1 style="font-size:20px;margin:0 0 16px;">Confirme seu email</h1>
  <p style="font-size:15px;line-height:1.5;">${greeting}</p>
  <p style="font-size:15px;line-height:1.5;">Bem-vindo(a) ao <strong>BusinessCalc</strong>. Clique no botão abaixo para confirmar seu email:</p>
  <p style="margin:24px 0;">
    <a href="${link}" style="display:inline-block;background:#16a34a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Confirmar email</a>
  </p>
  <p style="font-size:13px;color:#6b6560;">Ou copie o link: <br><code style="word-break:break-all;">${link}</code></p>
  <p style="font-size:13px;color:#6b6560;margin-top:32px;">Este link expira em 24 horas. Se você não criou uma conta, ignore este email.</p>
</body></html>`;

  await send({ to: params.to, subject, html, text });
}

export async function sendResetEmail(params: {
  to: string;
  token: string;
  name?: string | null;
}): Promise<void> {
  const link = `${config.APP_URL}/reset.html?token=${encodeURIComponent(params.token)}`;
  const safeName = params.name ? escapeHtml(params.name) : '';
  const greeting = safeName ? `Olá ${safeName},` : 'Olá,';

  const subject = 'Redefinir senha — BusinessCalc';
  const text = `${greeting.replace(/<[^>]+>/g, '')}

Recebemos uma solicitação para redefinir sua senha. Clique no link abaixo:

${link}

O link expira em 1 hora. Se você NÃO solicitou isso, ignore — sua senha continua a mesma.

— BusinessCalc`;

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#1a1a1a;">
  <h1 style="font-size:20px;margin:0 0 16px;">Redefinir senha</h1>
  <p style="font-size:15px;line-height:1.5;">${greeting}</p>
  <p style="font-size:15px;line-height:1.5;">Recebemos uma solicitação para redefinir sua senha no <strong>BusinessCalc</strong>. Clique no botão abaixo:</p>
  <p style="margin:24px 0;">
    <a href="${link}" style="display:inline-block;background:#dc2626;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Redefinir senha</a>
  </p>
  <p style="font-size:13px;color:#6b6560;">Ou copie o link: <br><code style="word-break:break-all;">${link}</code></p>
  <p style="font-size:13px;color:#6b6560;margin-top:32px;">Este link expira em 1 hora. Se você <strong>não</strong> solicitou isso, ignore este email — sua senha continua a mesma.</p>
</body></html>`;

  await send({ to: params.to, subject, html, text });
}
