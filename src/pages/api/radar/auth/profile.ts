import type { APIRoute } from 'astro';
import {
  applyRadarProfileDetails,
  RadarAuthError,
  findRadarUserById,
  getRadarSessionUser,
  normalizeRadarName,
  normalizeRadarProfileDetails,
  requestRadarEmailChange,
  toPublicRadarUser,
  updateRadarName,
} from '../../../../lib/radarAuth';
import { radarPasswordAttempts } from '../../../../lib/rateLimit';

export const prerender = false;

/** Campos extras del perfil que acepta este endpoint (apellido, nacimiento, etc.). */
const PROFILE_DETAIL_KEYS = ['lastName', 'birthDate', 'city', 'country', 'hobbies', 'hobbiesOther', 'profileType'];

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

/** En producción los enlaces de los correos salen siempre con el dominio canónico (https). */
function publicOrigin(request: Request, site: URL | undefined): string {
  const isProd = (process.env.NODE_ENV ?? '') === 'production';
  return isProd && site ? site.origin : new URL(request.url).origin;
}

/**
 * PATCH /api/radar/auth/profile
 * Datos personales de la cuenta del usuario autenticado:
 *  - name: se guarda al momento.
 *  - email: NO cambia directamente; exige currentPassword y envía un enlace de
 *    confirmación al email nuevo (el actual sigue valiendo hasta confirmarlo).
 *  - lastName, birthDate, city, country, hobbies, hobbiesOther, profileType:
 *    datos adicionales del perfil (validados todos antes de escribir nada).
 * La foto se gestiona en /api/radar/auth/avatar.
 */
export const PATCH: APIRoute = async ({ request, site }) => {
  const session = getRadarSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticación requerida.' }, 401);

  try {
    const body = await request.json();
    let user = session;
    let emailChange: { pendingEmail: string; devConfirmUrl?: string } | undefined;

    // Se valida todo antes de guardar nada: si falla el email, el nombre no queda a medias.
    const name = body.name === undefined ? undefined : normalizeRadarName(String(body.name));
    const detailsInput: Record<string, unknown> = {};
    for (const key of PROFILE_DETAIL_KEYS) if (key in body) detailsInput[key] = body[key];
    const details = Object.keys(detailsInput).length ? normalizeRadarProfileDetails(detailsInput) : null;

    const wantedEmail = body.email === undefined ? '' : String(body.email).trim().toLowerCase();
    if (wantedEmail && wantedEmail !== session.email) {
      // Freno a la fuerza bruta de la contraseña actual (el tope de correos enviados va en el lib).
      if (!radarPasswordAttempts.hit(session.id)) {
        return json({ success: false, message: 'Demasiados intentos. Inténtalo de nuevo en una hora.' }, 429);
      }
      const result = await requestRadarEmailChange(
        session.id,
        wantedEmail,
        String(body.currentPassword ?? ''),
        publicOrigin(request, site),
      );
      radarPasswordAttempts.reset(session.id);
      emailChange = { pendingEmail: result.pendingEmail, devConfirmUrl: result.devConfirmUrl };
    }

    if (name !== undefined) user = updateRadarName(session.id, name);
    if (details) user = applyRadarProfileDetails(session.id, details);
    const fresh = findRadarUserById(session.id);
    if (fresh) user = toPublicRadarUser(fresh);

    return json({ success: true, user, emailChange }, 200);
  } catch (error) {
    if (error instanceof RadarAuthError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};
