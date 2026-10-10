import type { APIRoute } from 'astro';
import { addCategory, getAffiliateProviders, getAnalyticsSummary, getCategories, getMarketingTools, removeCategory } from '../../../lib/adminDashboard';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { getNetworksOverview } from '../../../lib/networks';
import { getRemovedNetworks } from '../../../lib/networks/registry';

export const prerender = false;

export const GET: APIRoute = ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  return new Response(JSON.stringify({
    success: true,
    providers: getAffiliateProviders(),
    networks: getNetworksOverview(),
    removed: getRemovedNetworks(),
    categories: getCategories(),
    analytics: getAnalyticsSummary(),
    marketing: getMarketingTools(),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json();
    if (body.action === 'add-category') {
      const categories = addCategory(String(body.name ?? ''));
      return new Response(JSON.stringify({ success: true, categories }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (body.action === 'remove-category') {
      const categories = removeCategory(String(body.name ?? ''));
      return new Response(JSON.stringify({ success: true, categories }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: false, message: 'Acción de administración no reconocida.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response(JSON.stringify({ success: false, message: 'Petición JSON inválida.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
};
