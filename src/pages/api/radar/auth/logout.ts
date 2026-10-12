import type { APIRoute } from 'astro';
import { clearRadarSession } from '../../../../lib/radarAuth';

export const prerender = false;

export const POST: APIRoute = () =>
  new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': clearRadarSession(),
    },
  });
