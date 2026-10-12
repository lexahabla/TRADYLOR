import nodemailer from 'nodemailer';

export interface EmailPayload {
  to: string;
  name: string;
  verifyUrl: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export function getSmtpConfig(): SmtpConfig | null {
  const host = (process.env.SMTP_HOST ?? import.meta.env.SMTP_HOST ?? '').trim();
  const user = (process.env.SMTP_USER ?? import.meta.env.SMTP_USER ?? '').trim();
  const pass = (process.env.SMTP_PASS ?? import.meta.env.SMTP_PASS ?? '').trim();
  const from = (process.env.SMTP_FROM ?? import.meta.env.SMTP_FROM ?? 'Tradylor <no-reply@tradylor.com>').trim();
  const port = Number(process.env.SMTP_PORT ?? import.meta.env.SMTP_PORT ?? 587);
  if (!host || !user || !pass) return null;
  return { host, port, user, pass, from };
}

export async function sendVerificationEmailSmtp(payload: EmailPayload): Promise<boolean> {
  const config = getSmtpConfig();
  if (!config) return false;

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });

  const html = `
    <div style="max-width:560px;margin:0 auto;font-family:Inter,Arial,sans-serif;background:#0d1422;color:#f3f4f6;padding:2rem;border-radius:16px">
      <h1 style="font-size:1.4rem;margin:0 0 .5rem">Bienvenido a Tradylor, ${payload.name}</h1>
      <p style="color:#9ca3af;font-size:.9rem;line-height:1.6;margin:0 0 1.25rem">
        Gracias por crear tu cuenta de <strong>Mi Radar</strong>. Con ella puedes guardar productos,
        organizar listas de compra y retomar salidas desde cualquier dispositivo.
      </p>
      <p style="color:#9ca3af;font-size:.9rem;line-height:1.6;margin:0 0 1.5rem">
        Para activar tu cuenta y empezar a usarla, pulsa el botón siguiente:
      </p>
      <a href="${payload.verifyUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font-weight:700;padding:.85rem 1.5rem;border-radius:11px;font-size:.9rem">
        Activar mi cuenta
      </a>
      <p style="color:#6b7280;font-size:.75rem;margin-top:1.5rem">
        Si no te registraste en Tradylor, ignora este email.
      </p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: config.from,
      to: payload.to,
      subject: 'Activa tu cuenta de Mi Radar en Tradylor',
      html,
    });
    return true;
  } catch (error) {
    console.error('[SMTP] Error enviando email de verificación:', error);
    return false;
  }
}
