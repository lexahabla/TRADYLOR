/**
 * ==============================================================================
 * TRADYLOR - AUTENTICACIÓN DE LA API PÚBLICA v1 (n8n / automatizaciones)
 * ==============================================================================
 * Token estático configurado en .env:  TRADYLOR_API_TOKEN="tu-token-largo"
 * Uso desde el cliente:                 Authorization: Bearer <token>
 * ==============================================================================
 */

export function isValidApiToken(request: Request): boolean {
  const expected = process.env.TRADYLOR_API_TOKEN ?? import.meta.env.TRADYLOR_API_TOKEN;
  if (!expected) return false; // Sin token configurado, la API pública permanece cerrada.

  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() === expected.trim() : false;
}

export function unauthorizedApiResponse(): Response {
  return new Response(
    JSON.stringify({ success: false, message: 'Token de API ausente o inválido. Usa: Authorization: Bearer <TRADYLOR_API_TOKEN>.' }),
    { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="tradylor-api"' } },
  );
}
