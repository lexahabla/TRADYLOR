import type { APIRoute } from 'astro';
import { getRadarSessionUser } from '../../../lib/radarAuth';
import { getRadar } from '../../../lib/radarStore';
import { upsertUserProfile } from '../../../lib/userProfiles';
import { upsertMarketingLead } from '../../../lib/marketingLeads';
import { profileSyncPerUser } from '../../../lib/rateLimit';

export const prerender = false;

/**
 * POST /api/user-profile/sync
 * Sincroniza el perfil de comprador del usuario logueado (quiz, categorías,
 * presupuesto y últimas búsquedas guardadas en LocalStorage) hacia las capas
 * de marketing: user_profiles.json + marketing_leads.json.
 * Requiere sesión de Mi Radar (cookie). El cliente throttla a ~1/día.
 */

const MAX_TERMS = 20;
const MAX_CATEGORIES = 20;

const cleanList = (value: unknown, max: number): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((item) => String(item ?? '').trim().toLowerCase()).filter(Boolean)),
  ).slice(0, max);
};

const cleanQuizAnswers = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, val]) => [String(key).slice(0, 40), String(val ?? '').slice(0, 80)] as const)
      .filter(([key, val]) => key && val),
  );
};

export const POST: APIRoute = async ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) {
    return new Response(JSON.stringify({ success: false, message: 'Sesión no válida.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  if (!profileSyncPerUser.hit(user.id)) {
    return new Response(JSON.stringify({ success: false, message: 'Demasiadas sincronizaciones. Inténtalo más tarde.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const preferredCategories = cleanList(body.preferredCategories, MAX_CATEGORIES);
  const preferredSubcategories = cleanList(body.preferredSubcategories, MAX_CATEGORIES);
  const lastSearchTerms = cleanList(body.lastSearchTerms, MAX_TERMS);
  const quizAnswers = cleanQuizAnswers(body.quizAnswers);
  const profileType = typeof body.profileType === 'string' ? body.profileType.trim().slice(0, 40) : undefined;
  const budgetRange = typeof body.budgetRange === 'string' ? body.budgetRange.trim().slice(0, 40) : undefined;
  const buyerProfile = typeof body.buyerProfile === 'string' ? body.buyerProfile.trim().slice(0, 60) : undefined;

  try {
    upsertUserProfile(user.id, {
      email: user.email,
      name: user.name,
      profileType,
      preferredCategories: preferredCategories.length ? preferredCategories : undefined,
      preferredSubcategories: preferredSubcategories.length ? preferredSubcategories : undefined,
      budgetRange: budgetRange ?? quizAnswers.presupuesto,
      buyerProfile: buyerProfile ?? (Object.keys(quizAnswers).length
        ? `${quizAnswers.perfil ?? ''}-${quizAnswers.objetivo ?? ''}-${quizAnswers.presupuesto ?? ''}`.replace(/^-|-$/g, '')
        : undefined),
      quizAnswers: Object.keys(quizAnswers).length ? quizAnswers : undefined,
    });

    // Enrich marketing lead (segmentación + últimas búsquedas + tamaño radar).
    const radar = getRadar(user.id);
    const radarProductCount = radar.projects.reduce(
      (acc, project) => acc + (Array.isArray(project.products) ? project.products.length : 0),
      0,
    );

    upsertMarketingLead({
      userId: user.id,
      email: user.email,
      name: user.name,
      source: 'sync',
      radarProductCount,
      lastSearchTerms,
      profileData: {
        ...(profileType ? { profileType } : {}),
        ...(budgetRange ?? quizAnswers.presupuesto ? { budgetRange: budgetRange ?? quizAnswers.presupuesto } : {}),
        ...(buyerProfile ? { buyerProfile } : {}),
        ...(preferredCategories.length ? { preferredCategories } : {}),
        ...(Object.keys(quizAnswers).length ? { quizAnswers } : {}),
      },
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[API UserProfileSync] Error:', error);
    return new Response(JSON.stringify({ success: false, message: 'No se pudo sincronizar el perfil.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
};
