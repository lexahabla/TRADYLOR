import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../../lib/adminAuth';
import {
  emailPlatformStatus,
  getMarketingEmailConfig,
  hasEmailChannel,
  saveMarketingEmailConfig,
  type EmailPlatform,
} from '../../../../../lib/marketingEmail';
import { getSmtpConfig } from '../../../../../lib/mailer';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const PLATFORMS: EmailPlatform[] = ['mailchimp', 'brevo', 'resend'];

/**
 * GET /api/admin/marketing/usuarios/integrations
 * Config del panel (plataforma + triggers) y estado de canales/keys del entorno.
 */
export const GET: APIRoute = ({ request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  if (session.role !== 'admin') return json({ success: false, message: 'Requiere rol de administrador.' }, 403);

  const config = getMarketingEmailConfig();
  return json({
    success: true,
    config,
    platformStatus: emailPlatformStatus(),
    channels: {
      smtp: Boolean(getSmtpConfig()),
      cartWebhook: hasEmailChannel() && !getSmtpConfig(),
    },
  }, 200);
};

/**
 * POST /api/admin/marketing/usuarios/integrations
 * Guarda la plataforma elegida y el estado de los triggers.
 */
export const POST: APIRoute = async ({ request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  if (session.role !== 'admin') return json({ success: false, message: 'Requiere rol de administrador.' }, 403);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, message: 'Peticion invalida.' }, 400);
  }

  const rawPlatform = body.platform;
  let platform: EmailPlatform | null = null;
  if (rawPlatform !== null && rawPlatform !== undefined && rawPlatform !== '') {
    const value = String(rawPlatform).trim().toLowerCase();
    if (!PLATFORMS.includes(value as EmailPlatform)) {
      return json({ success: false, message: 'Plataforma no soportada: usa mailchimp, brevo o resend.' }, 400);
    }
    platform = value as EmailPlatform;
  }

  const rawTriggers = (body.triggers ?? {}) as Record<string, unknown>;
  const triggers = {
    welcome: rawTriggers.welcome === undefined ? undefined : Boolean(rawTriggers.welcome),
    cartRecovery: rawTriggers.cartRecovery === undefined ? undefined : Boolean(rawTriggers.cartRecovery),
    birthday: rawTriggers.birthday === undefined ? undefined : Boolean(rawTriggers.birthday),
  };

  const config = saveMarketingEmailConfig({ platform, triggers });
  return json({ success: true, config, platformStatus: emailPlatformStatus(config.platform) }, 200);
};
