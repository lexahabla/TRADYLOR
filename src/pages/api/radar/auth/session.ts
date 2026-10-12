import type { APIRoute } from 'astro';
import { getGoogleOAuthConfig, getRadarSessionUser } from '../../../../lib/radarAuth';

export const prerender = false;

/** Estado de sesión del usuario final (público: authenticated + user|null). */
export const GET: APIRoute = ({ request }) => {
  const user = getRadarSessionUser(request);
  return new Response(
    JSON.stringify({
      authenticated: Boolean(user),
      user,
      googleEnabled: Boolean(getGoogleOAuthConfig()),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
};
