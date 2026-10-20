import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { readProductsFromFile, writeProductsToFile, type Product } from '../../../../lib/productStore';
import { getCategories, suggestCategory } from '../../../../lib/categories';
import { enrichProductText, hasTextCredentials, textProvider } from '../../../../lib/ai';
import { buildRealisticPricing } from '../../../../lib/ai';

export const prerender = false;

interface OpenCodeCommandRequest {
  prompt: string;
  productIds: string[];
  context: 'selected' | 'all' | 'full';
}

interface OpenCodeAction {
  type: 'reorganize_categories' | 'review_prices' | 'filter_anomalies' | 'enrich_products' | 'normalize_tags' | 'assign_categories' | 'bulk_delete' | 'recalculate_scores' | 'custom';
  params: Record<string, any>;
  description: string;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function parseOpenCodeResponse(raw: string): { actions: OpenCodeAction[]; summary: string } {
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.actions && Array.isArray(parsed.actions)) {
      return { actions: parsed.actions, summary: parsed.summary || 'Acciones generadas por OpenCode' };
    }
    if (parsed.type && parsed.params) {
      return { actions: [parsed], summary: parsed.description || 'Acción generada por OpenCode' };
    }
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        if (parsed.actions && Array.isArray(parsed.actions)) {
          return { actions: parsed.actions, summary: parsed.summary || 'Acciones generadas por OpenCode' };
        }
      } catch {}
    }
  }
  return { actions: [], summary: 'No se pudieron interpretar las acciones de OpenCode' };
}

async function callOpenCode(prompt: string, catalogContext: string): Promise<string> {
  const provider = textProvider();
  if (!hasTextCredentials()) {
    throw new Error(
      provider === 'anthropic'
        ? 'Falta ANTHROPIC_API_KEY para invocar OpenCode'
        : provider === 'groq'
          ? 'Falta GROQ_API_KEY para invocar OpenCode'
          : 'Falta OPENAI_API_KEY para invocar OpenCode'
    );
  }

  const systemPrompt = [
    'Eres el motor de curación OpenCode integrado en Tradylor, un portal de afiliación de productos.',
    'Recibes un prompt en lenguaje natural del administrador y el contexto actual del catálogo.',
    'Debes responder ÚNICAMENTE con un JSON válido con esta estructura:',
    '{',
    '  "actions": [',
    '    { "type": "reorganize_categories|review_prices|filter_anomalies|enrich_products|normalize_tags|assign_categories|bulk_delete|recalculate_scores|custom",',
    '      "params": { ... },',
    '      "description": "Descripción legible de la acción" }',
    '  ],',
    '  "summary": "Resumen ejecutivo de lo que se va a hacer"',
    '}',
    '',
    'Tipos de acción soportados:',
    '- reorganize_categories: { "categoryMap": { "productId": "nueva-categoria" } }',
    '- review_prices: { "thresholdPercent": 20, "action": "flag|adjust" }',
    '- filter_anomalies: { "filters": ["missing_ia", "no_category", "duplicate", "price_outlier"], "action": "select|delete|flag" }',
    '- enrich_products: { "productIds": [], "options": { "text": true, "image": false } }',
    '- normalize_tags: { "productIds": [] }',
    '- assign_categories: { "categoryMap": { "productId": "categoria" } }',
    '- bulk_delete: { "productIds": [], "confirm": true }',
    '- recalculate_scores: {}',
    '- custom: { "description": "...", "data": {} } (para acciones no estandarizadas)',
    '',
    'Reglas:',
    '- NUNCA inventes IDs de productos que no estén en el catálogo proporcionado.',
    '- Si el prompt es ambiguo, elige la acción más segura (ej: "select" en lugar de "delete").',
    '- Devuelve SOLO el JSON, sin texto adicional, sin markdown.',
  ].join('\n');

  const userContext = [
    `PROMPT DEL ADMINISTRADOR: ${prompt}`,
    '',
    `CONTEXTO DEL CATÁLOGO (resumen):`,
    catalogContext,
  ].join('\n');

  const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs = 120_000): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  if (provider === 'anthropic') {
    const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
    const response = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          temperature: 0.2,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContext }],
        }),
      },
      120_000
    );
    if (!response.ok) {
      throw new Error(`Anthropic respondió ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const payload = await response.json();
    return (payload?.content ?? []).map((block: any) => block?.text ?? '').join('');
  }

  if (provider === 'groq') {
    const response = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY || ''}`,
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContext },
          ],
        }),
      },
      120_000
    );
    if (!response.ok) {
      throw new Error(`Groq respondió ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const payload = await response.json();
    return payload?.choices?.[0]?.message?.content ?? '';
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContext },
        ],
      }),
    },
    120_000
  );
  if (!response.ok) {
    throw new Error(`OpenAI respondió ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content ?? '';
}

function buildCatalogContext(products: Product[], productIds: string[]): string {
  const targetProducts = products.filter((p) => productIds.includes(p.id));
  const total = products.length;
  const selected = targetProducts.length;

  const categories = getCategories();
  const categoryNames = [...new Set(targetProducts.map((p) => p.category).filter(Boolean))];
  const merchants = [...new Set(targetProducts.map((p) => p.merchant).filter(Boolean))];
  const withIA = targetProducts.filter((p) => p.ia_status === 'completed').length;
  const withoutIA = targetProducts.filter((p) => !p.ia_status || p.ia_status === 'pending').length;
  const withCategory = targetProducts.filter((p) => p.category && p.category.trim()).length;
  const withoutCategory = targetProducts.filter((p) => !p.category || !p.category.trim()).length;
  const withAffiliate = targetProducts.filter((p) => p.affiliateUrl && p.affiliateUrl.trim()).length;
  const withoutAffiliate = targetProducts.filter((p) => !p.affiliateUrl || !p.affiliateUrl.trim()).length;
  const withSourceId = targetProducts.filter((p) => p.sourceId && p.sourceId.trim()).length;

  const priceStats = targetProducts
    .filter((p) => p.price > 0)
    .map((p) => p.price)
    .sort((a, b) => a - b);
  const avgPrice = priceStats.length ? priceStats.reduce((a, b) => a + b, 0) / priceStats.length : 0;
  const minPrice = priceStats[0] ?? 0;
  const maxPrice = priceStats[priceStats.length - 1] ?? 0;

  const sampleProducts = targetProducts.slice(0, 10).map((p) => ({
    id: p.id,
    title: p.title.slice(0, 80),
    category: p.category || '(sin categoría)',
    merchant: p.merchant,
    price: p.price,
    originalPrice: p.originalPrice,
    ia_status: p.ia_status || 'pending',
    sourceId: p.sourceId || '',
    affiliateUrl: p.affiliateUrl ? '✓' : '✗',
  }));

  return [
    `Total catálogo: ${total} productos`,
    `Productos en contexto (${selected}):`,
    `  - Con IA completada: ${withIA} | Sin IA: ${withoutIA}`,
    `  - Con categoría: ${withCategory} | Sin categoría: ${withoutCategory}`,
    `  - Con enlace afiliado: ${withAffiliate} | Sin enlace: ${withoutAffiliate}`,
    `  - Con sourceId externo: ${withSourceId}`,
    `  - Precio medio: ${avgPrice.toFixed(2)} € | Rango: ${minPrice.toFixed(2)} - ${maxPrice.toFixed(2)} €`,
    `  - Categorías presentes: ${categoryNames.join(', ') || '(ninguna)'}`,
    `  - Comercios: ${merchants.join(', ') || '(ninguno)'}`,
    '',
    'Muestra de productos (máx 10):',
    JSON.stringify(sampleProducts, null, 2),
    '',
    'Categorías disponibles en el sistema:',
    categories.filter((c) => !c.parentId).map((c) => `- ${c.name} (${c.slug})`).join('\n'),
  ].join('\n');
}

async function executeActions(actions: OpenCodeAction[], products: Product[], productIds: string[]): Promise<{ applied: number; errors: string[]; warnings: string[]; reload: boolean }> {
  const targetProducts = products.filter((p) => productIds.includes(p.id));
  const errors: string[] = [];
  const warnings: string[] = [];
  let applied = 0;
  let reload = false;

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'reorganize_categories': {
          const { categoryMap } = action.params;
          if (!categoryMap || typeof categoryMap !== 'object') {
            errors.push('reorganize_categories: categoryMap inválido');
            break;
          }
          let changed = 0;
          for (const [pid, newCategory] of Object.entries(categoryMap as Record<string, string>)) {
            const product = targetProducts.find((p) => p.id === pid);
            if (product && newCategory) {
              const suggested = suggestCategory(`${product.title} ${product.description}`);
              const validCategory = suggested?.category.name || newCategory;
              product.category = validCategory;
              changed++;
            }
          }
          if (changed > 0) {
            writeProductsToFile(products);
            applied += changed;
            reload = true;
            warnings.push(`reorganize_categories: ${changed} producto(s) recategorizado(s)`);
          }
          break;
        }

        case 'review_prices': {
          const { thresholdPercent = 20, action: priceAction = 'flag' } = action.params;
          let flagged = 0;
          for (const product of targetProducts) {
            if (product.originalPrice && product.price > 0) {
              const discount = ((product.originalPrice - product.price) / product.originalPrice) * 100;
              if (discount > thresholdPercent || discount < 5) {
                flagged++;
                if (priceAction === 'adjust' && product.originalPrice > product.price) {
                  const pricing = buildRealisticPricing(product.price);
                  product.originalPrice = pricing.originalPrice;
                }
              }
            }
          }
          if (priceAction === 'adjust' && flagged > 0) {
            writeProductsToFile(products);
            reload = true;
          }
          applied += flagged;
          warnings.push(`review_prices: ${flagged} producto(s) con precios anómalos (${priceAction})`);
          break;
        }

        case 'filter_anomalies': {
          const { filters = [], action: filterAction = 'select' } = action.params;
          const anomalies: string[] = [];
          for (const product of targetProducts) {
            let isAnomaly = false;
            if (filters.includes('missing_ia') && (!product.ia_status || product.ia_status === 'pending')) isAnomaly = true;
            if (filters.includes('no_category') && (!product.category || !product.category.trim())) isAnomaly = true;
            if (filters.includes('no_affiliate') && (!product.affiliateUrl || !product.affiliateUrl.trim())) isAnomaly = true;
            if (filters.includes('no_sourceId') && (!product.sourceId || !product.sourceId.trim())) isAnomaly = true;
            if (filters.includes('price_outlier') && product.price > 0) {
              const prices = targetProducts.filter((p) => p.price > 0).map((p) => p.price).sort((a, b) => a - b);
              if (prices.length > 3) {
                const q1 = prices[Math.floor(prices.length * 0.25)];
                const q3 = prices[Math.floor(prices.length * 0.75)];
                const iqr = q3 - q1;
                if (product.price < q1 - 1.5 * iqr || product.price > q3 + 1.5 * iqr) isAnomaly = true;
              }
            }
            if (isAnomaly) anomalies.push(product.id);
          }
          if (filterAction === 'select' && anomalies.length > 0) {
            reload = true;
          }
          applied += anomalies.length;
          warnings.push(`filter_anomalies: ${anomalies.length} anomalía(s) detectada(s) (${filterAction})`);
          break;
        }

        case 'enrich_products': {
          const { productIds: enrichIds = productIds, options = { text: true, image: false } } = action.params;
          let enriched = 0;
          for (const pid of enrichIds) {
            const product = targetProducts.find((p) => p.id === pid);
            if (!product) continue;
            try {
              const enrichment = await enrichProductText({
                title: product.title,
                description: product.description,
                category: product.category,
                url: product.affiliateUrl,
                price: product.price,
                originalPrice: product.originalPrice,
              });
              if (enrichment.description) product.description = enrichment.description;
              if (enrichment.pros.length) product.pros = enrichment.pros;
              if (enrichment.cons.length) product.cons = enrichment.cons;
              if (enrichment.verdict) product.verdict = enrichment.verdict;
              if (enrichment.techSheet) product.techSheet = enrichment.techSheet;
              if (enrichment.specs && Object.keys(enrichment.specs).length) {
                product.specs = { ...(product.specs ?? {}), ...enrichment.specs };
              }
              if (enrichment.category && !product.category) product.category = enrichment.category;
              if (enrichment.pricing) {
                if (!product.price || product.price <= 0) product.price = enrichment.pricing.price;
                if (!product.originalPrice || product.originalPrice <= product.price) product.originalPrice = enrichment.pricing.originalPrice;
              }
              product.ia_status = 'completed';
              enriched++;
            } catch (e: any) {
              errors.push(`enrich_products (${pid}): ${e.message}`);
              product.ia_status = 'error';
            }
          }
          if (enriched > 0) {
            writeProductsToFile(products);
            reload = true;
          }
          applied += enriched;
          warnings.push(`enrich_products: ${enriched} producto(s) enriquecido(s)`);
          break;
        }

        case 'normalize_tags': {
          const { productIds: tagIds = productIds } = action.params;
          let normalized = 0;
          for (const pid of tagIds) {
            const product = targetProducts.find((p) => p.id === pid);
            if (!product || !product.specs) continue;
            const tags: string[] = [];
            for (const [key, value] of Object.entries(product.specs)) {
              const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
              const normalizedValue = value.toLowerCase().replace(/[^a-z0-9]+/g, '_');
              tags.push(`${normalizedKey}:${normalizedValue}`);
            }
            if (tags.length) {
              product.normalized_tags = [...new Set([...(product.normalized_tags ?? []), ...tags])];
              normalized++;
            }
          }
          if (normalized > 0) {
            writeProductsToFile(products);
            reload = true;
          }
          applied += normalized;
          warnings.push(`normalize_tags: ${normalized} producto(s) con tags normalizados`);
          break;
        }

        case 'assign_categories': {
          const { categoryMap } = action.params;
          if (!categoryMap || typeof categoryMap !== 'object') {
            errors.push('assign_categories: categoryMap inválido');
            break;
          }
          let assigned = 0;
          for (const [pid, category] of Object.entries(categoryMap as Record<string, string>)) {
            const product = targetProducts.find((p) => p.id === pid);
            if (product && category) {
              product.category = category;
              assigned++;
            }
          }
          if (assigned > 0) {
            writeProductsToFile(products);
            reload = true;
          }
          applied += assigned;
          warnings.push(`assign_categories: ${assigned} producto(s) asignado(s)`);
          break;
        }

        case 'bulk_delete': {
          const { productIds: deleteIds = [], confirm = false } = action.params;
          if (!confirm) {
            warnings.push('bulk_delete: requiere confirm=true para ejecutarse');
            break;
          }
          const before = products.length;
          const toDelete = new Set(deleteIds.length ? deleteIds : productIds);
          const remaining = products.filter((p) => !toDelete.has(p.id));
          writeProductsToFile(remaining);
          reload = true;
          applied += before - remaining.length;
          warnings.push(`bulk_delete: ${before - remaining.length} producto(s) eliminado(s)`);
          break;
        }

        case 'recalculate_scores': {
          const res = await fetch('/api/products/curation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'recalc' }),
          });
          const data = await res.json();
          if (data.success) {
            reload = true;
            applied += data.updated ?? 0;
            warnings.push(`recalculate_scores: ${data.updated ?? 0} scores recalculados`);
          } else {
            errors.push(`recalculate_scores: ${data.message}`);
          }
          break;
        }

        case 'custom': {
          const { description, data } = action.params;
          warnings.push(`custom: ${description || 'acción personalizada'} - revisar manualmente`);
          break;
        }

        default:
          warnings.push(`Acción desconocida: ${action.type}`);
      }
    } catch (e: any) {
      errors.push(`${action.type}: ${e.message}`);
    }
  }

  return { applied, errors, warnings, reload };
}

export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    let body: OpenCodeCommandRequest;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, message: 'Cuerpo JSON inválido' }, 400);
    }

    const { prompt, productIds = [], context = 'selected' } = body;
    if (!prompt || !prompt.trim()) {
      return jsonResponse({ success: false, message: 'El campo "prompt" es obligatorio' }, 400);
    }

    const allProducts = readProductsFromFile();
    let targetIds = productIds;

    if (context === 'all') {
      targetIds = allProducts.map((p) => p.id);
    } else if (context === 'full') {
      targetIds = allProducts.map((p) => p.id);
    }

    if (targetIds.length === 0) {
      return jsonResponse({ success: false, message: 'No hay productos en el contexto seleccionado' }, 400);
    }

    const catalogContext = buildCatalogContext(allProducts, targetIds);
    const rawResponse = await callOpenCode(prompt.trim(), catalogContext);
    const { actions, summary } = parseOpenCodeResponse(rawResponse);

    if (!actions.length) {
      return jsonResponse(
        {
          success: false,
          message: 'OpenCode no generó acciones válidas para el prompt dado',
          summary,
          rawResponse: rawResponse.slice(0, 500),
        },
        422
      );
    }

    const result = await executeActions(actions, allProducts, targetIds);

    return jsonResponse(
      {
        success: true,
        message: result.errors.length ? 'Ejecutado con errores parciales' : 'Comando ejecutado correctamente',
        summary,
        actions: actions.map((a) => ({ type: a.type, description: a.description })),
        applied: result.applied,
        errors: result.errors,
        warnings: result.warnings,
        reload: result.reload,
      },
      result.errors.length ? 207 : 200
    );
  } catch (error: any) {
    console.error('[API v1/admin/opencode-command] Error:', error);
    return jsonResponse(
      { success: false, message: error?.message || 'Error inesperado al procesar el comando OpenCode' },
      500
    );
  }
};