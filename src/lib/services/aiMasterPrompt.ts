/**
 * ==============================================================================
 * TRADYLOR - PROMPT MAESTRO DE IA PARA ENRIQUECIMIENTO EDITORIAL MASIVO
 * ==============================================================================
 * Prompt estructurado en JSON que genera:
 *  - Título comercial sintetizado (≤70 chars)
 *  - Descripción en Markdown (2-3 frases, redacción técnica)
 *  - Short description (1-2 frases para tarjetas)
 *  - Highlights (bullet points de venta, máx 5)
 *  - Pros/Contras estructurados (con peso y fuente)
 *  - Ficha técnica (specs clave/valor, 4-8 pares)
 *  - TechSheet (párrafo técnico con " · ")
 *  - Veredicto neutro (1-2 frases)
 *  - Categoría + Subcategoría (auto-categorización)
 *  - Tags normalizados (matriz de atributos para filtros)
 *  - Matching Key (clave de agrupación para cross-matching)
 *  - Competitor Terms (términos para búsquedas/matching)
 *  - Pricing (oferta + original con descuento realista 15-35%)
 * ==============================================================================
 */

import type { UnifiedProduct } from '../networks/types';
import type { Category } from '../categories';
import { getCategories } from '../categories';

/**
 * Contexto de entrada para el prompt maestro
 */
export interface MasterPromptInput {
  /** Datos del producto capturado (UnifiedProduct + extras) */
  product: UnifiedProduct & {
    allImages?: string[];
    networkExtra?: Record<string, unknown>;
    sourceUrl?: string;
  };
  /** Categorías disponibles en el catálogo (para auto-categorización) */
  availableCategories: Category[];
  /** Productos existentes en catálogo (para matching_key y detección de alternativas) */
  existingProducts?: Array<{
    id: string;
    title: string;
    category: string;
    subcategory_id?: string;
    price: number;
    brand?: string;
    matching_key?: string;
  }>;
  /** Precio de oferta conocido (scraping/manual) para pricing realista */
  knownOfferPrice?: number;
  /** Precio original conocido */
  knownOriginalPrice?: number;
}

/**
 * Respuesta estructurada esperada de la IA
 */
export interface MasterPromptOutput {
  /** Título comercial sintetizado (tipo + marca + modelo + 1 característica diferencial, ≤70 chars) */
  title: string;
  /** Descripción completa en Markdown (2-3 frases, redacción técnica concisa, orientada a decisión) */
  description: string;
  /** Descripción corta para tarjetas/listados (1-2 frases, ≤280 chars) */
  short_description: string;
  /** Highlights/viñetas de venta para CRO (máx 5, orientadas a conversión) */
  highlights: string[];
  /** Pros/Contras estructurados para UI avanzada */
  pros_cons: {
    pros: Array<{ text: string; weight: number; source: 'scraped' | 'ai' | 'manual' }>;
    cons: Array<{ text: string; weight: number; source: 'scraped' | 'ai' | 'manual' }>;
  };
  /** Ficha técnica: 4-8 pares clave/valor cortos (ej: "Autonomía": "Hasta 30 horas") */
  specs: Record<string, string>;
  /** TechSheet: párrafo técnico 3-6 líneas con " · " (materiales, medidas, peso, conectividad...) */
  techSheet: string;
  /** Veredicto neutro: 1-2 frases indicando para quién encaja */
  verdict: string;
  /** Categoría principal (debe coincidir con una de availableCategories) */
  category: string;
  /** Subcategoría (opcional, debe ser hija de la categoría principal) */
  subcategory?: string;
  /** Tags técnicos normalizados (matriz de atributos para filtros/facetas futuras) */
  normalized_tags: string[];
  /** Clave de agrupación para cross-matching (normalizada: marca+modelo+variante sin sufijos) */
  matching_key: string;
  /** Términos de competidor para búsquedas y matching automático */
  competitor_terms: string[];
  /** Pricing: par oferta/original con descuento realista 15-35% */
  pricing: {
    price: number;
    originalPrice: number;
    discountPercentage: number;
  };
  /** Confianza de la categorización (0-1) */
  categoryConfidence: number;
  /** Advertencias/notas del proceso */
  warnings?: string[];
}

/**
 * Genera el SYSTEM PROMPT maestro (JSON estricto)
 */
export function buildMasterSystemPrompt(): string {
  const categories = getCategories();
  const roots = categories.filter(c => !c.parentId).map(c => c.name);
  const subs = categories.filter(c => c.parentId).map(c => `${c.name} (padre: ${categories.find(p => p.id === c.parentId)?.name || '?'})`);

  return [
    'Eres el MOTOR EDITORIAL DE TRADYLOR, un portal de análisis y recomendación de productos de alta conversión.',
    'Tu trabajo: transformar datos brutos de afiliación en FICHAS EDITORIALES COMPLETAS, HONESTAS y OPTIMIZADAS PARA CONVERSIÓN.',
    '',
    '=== REGLAS ESTRICTAS ===',
    '- NUNCA inventes especificaciones, precios, cifras de ventas, valoraciones o datos que NO estén en la entrada.',
    '- Tono: REDACCIÓN TÉCNICA CONCISA, divulgativa, directa, NEUTRA. Sin superlativos comerciales ("lo mejor", "imbatible", "top ventas"). Sin llamadas a la acción de compra.',
    '- Formato de salida: JSON VÁLIDO EXCLUSIVAMENTE con las claves exactas definidas abajo. Sin markdown, sin comentarios, sin texto extra.',
    '',
    '=== ESQUEMA DE SALIDA (OBLIGATORIO) ===',
    '{',
    '  "title": "string (≤70 chars, sintetizado: tipo + marca + modelo + 1 característica clave)",',
    '  "description": "string (Markdown, 2-3 frases, redacción técnica, decisión de compra)",',
    '  "short_description": "string (1-2 frases, ≤280 chars, para tarjetas)",',
    '  "highlights": "string[] (máx 5, bullet points de venta orientados a CRO)",',
    '  "pros_cons": {',
    '    "pros": [{ "text": "string", "weight": "number 1-10", "source": "scraped|ai|manual" }],',
    '    "cons": [{ "text": "string", "weight": "number 1-10", "source": "scraped|ai|manual" }]',
    '  },',
    '  "specs": "Record<string, string> (4-8 pares clave/valor cortos, ej: {\'Autonomía\': \'30h\'})"', 
    '  "techSheet": "string (párrafo 3-6 líneas, datos objetivos separados por · )",',
    '  "verdict": "string (1-2 frases neutras: para quién encaja)",',
    '  "category": "string (EXACTAMENTE una de las categorías raíz disponibles)",',
    '  "subcategory": "string? (opcional, debe ser hija de la categoría elegida)",',
    '  "normalized_tags": "string[] (tags técnicos estandarizados, máx 20)",',
    '  "matching_key": "string (normalizado: marca-modelo-variante sin sufijos, para cross-matching)",',
    '  "competitor_terms": "string[] (términos significativos para matching/búsqueda, máx 15)",',
    '  "pricing": { "price": "number", "originalPrice": "number", "discountPercentage": "number (15-35)" },',
    '  "categoryConfidence": "number (0-1)",',
    '  "warnings": "string[]?"',
    '}',
    '',
    '=== CATEGORÍAS DISPONIBLES (raíz) ===',
    roots.join(', '),
    '',
    '=== SUBCATEGORÍAS DISPONIBLES ===',
    subs.join(', '),
    '',
    '=== DIRECTRICES POR CAMPO ===',
    '',
    'TITLE (≤70 chars):',
    '  - REGLA OBLIGATORIA: Debe especificar explícitamente la categoría o naturaleza del producto al inicio o de forma clara (ejemplos: transformar "SSD 1TB" en "Disco duro SSD 1TB", "Power bank 10000mAh" en "Batería portátil Power bank 10000mAh", "Crucial P3 Plus 1TB" en "Disco duro SSD Crucial P3 Plus 1TB", "Cecotec Conga" en "Robot aspirador Cecotec Conga", "Air Fryer 5L" en "Freidora de aire Cecotec 5L").',
    '  - Estructura: [Categoría/Naturaleza del producto] + [Marca / Modelo] + [Capacidad o rasgo clave].',
    '  - NO: precios, descuentos, comercio, sufijos ("| Amazon.es", "- PcComponentes"), superlativos.',
    '',
    'DESCRIPTION (Markdown, 2-3 frases):',
    '  - Redacción técnica concisa: qué es, para qué sirve, dato diferencial clave.',
    '  - Si hay descripción previa, MEJORA claridad/precisión/fluidez SIN inventar datos.',
    '  - Orientada a decisión de compra: ayuda al usuario a decidir SÍ/NO.',
    '',
    'SHORT_DESCRIPTION (≤280 chars):',
    '  - 1-2 frases resumiendo lo esencial para una tarjeta de producto.',
    '  - Distinta de description: más compacta, más "gancho".',
    '',
    'HIGHLIGHTS (máx 5):',
    '  - Viñetas de VENTA orientadas a conversión (CRO).',
    '  - Ej: "Cancelación de ruido líder del sector", "30h autonomía con ANC", "Multipoint Bluetooth 5.2".',
    '  - Concretas, verificables, diferenciales. NO relleno.',
    '',
    'PROS_CONS (estructurado):',
    '  - pros: 3-5 puntos concretos, verificables y de alto valor para el comprador.',
    '  - cons: 2-3 contras o matices comerciales constructivos y poco disuasorios (puntos menores como "Disponible en pocas opciones de color", "Cable de carga de longitud estándar", "Requiere configuración inicial sencilla", "Manual en formato digital"), evitando siempre aspectos graves o disuasorios que desinteresen al usuario o perjudiquen la conversión de compra.',
    '  - weight: 10 = crítico, 1 = menor. source: "ai" (generado ahora) | "scraped" (venía en datos) | "manual".',
    '  - NO inventes. Si no hay datos reales, usa menos puntos pero honestos.',
    '',
    'SPECS (4-8 pares):',
    '  - Clave corta (≤30 chars), valor corto (≤80 chars).',
    '  - Prioriza: Conectividad, Pantalla, Batería/Autonomía, Procesador, Memoria, Almacenamiento, Cámara, Resolución, Peso, Dimensiones, Material, Certificación (IP68, etc.).',
    '  - Omite las que NO conozcas con certeza.',
    '',
    'TECHSHEET (párrafo técnico):',
    '  - 3-6 líneas en español con datos OBJETIVOS: materiales, medidas, peso, conectividad, compatibilidades, garantía, contenido de la caja.',
    '  - Separador: " · " (espacio, punto medio, espacio).',
    '  - NO inventes cifras. "Desconocido" mejor que inventar.',
    '',
    'VERDICT (1-2 frases neutras):',
    '  - "Si buscas X con Y, este modelo encaja bien." / "Buena opción para Z, aunque W es mejorable."',
    '  - Neutro, honesto, útil.',
    '',
    'CATEGORY + SUBCATEGORY:',
    '  - category: OBLIGATORIA, debe ser EXACTAMENTE una de las raíces listadas.',
    '  - subcategory: OPCIONAL, solo si encaja claramente y existe en la lista de hijas.',
    '  - categoryConfidence: 0.9+ si muy claro, 0.6-0.8 si dudoso, <0.6 si genérico.',
    '',
    'NORMALIZED_TAGS (máx 20):',
    '  - Tags técnicos ESTANDARIZADOS para filtros/facetas futuras.',
    '  - Ej: ["Bluetooth 5.2", "Cancelación de Ruido", "USB Type-C", "Multipoint", "IPX4", "30h Batería"].',
    '  - Extrae de specs, título, descripción. Normaliza: "Bluetooth 5.2" no "bluetooth5.2" ni "BT 5.2".',
    '',
    'MATCHING_KEY:',
    '  - Clave normalizada para AGRUPAR productos equivalentes (cross-matching).',
    '  - Formato: "marca-modelo-variante" todo minúsculas, sin acentos, guiones.',
    '  - Ej: "sony-wh-1000xm5-negro", "samsung-galaxy-s24-ultra-512gb".',
    '  - SIN: colores genéricos si no son variante funcional, sufijos de tienda, "pro", "max" si no diferencian.',
    '',
    'COMPETITOR_TERMS (máx 15):',
    '  - Tokens significativos del título para búsquedas y matching automático.',
    '  - Quita stopwords, colores, sufijos genéricos. Queda: marca, modelo, tipo, specs clave.',
    '  - Ej para "Sony WH-1000XM5 Negro": ["sony", "wh1000xm5", "auriculares", "cancelacion-ruido", "bluetooth", "30h"].',
    '',
    'PRICING (descuento REALISTA 15-35%):',
    '  - Si hay knownOfferPrice: RESPÉTALO EXACTO como price. Genera originalPrice superior con descuento 15-35%.',
    '  - Si NO hay precio: propone par REALISTA para la categoría (ej: 79.99 / 109.99).',
    '  - Formato: DOS DECIMALES terminando en ,99 o ,95. originalPrice SIEMPRE > price.',
    '  - DESCUENTOS ABSURDOS (>40%) o MÍNIMOS (<10%) PROHIBIDOS.',
    '',
    '=== EJEMPLO DE SALIDA VÁLIDA ===',
    '{',
    '  "title": "Auriculares Sony WH-1000XM5 con cancelación de ruido",',
    '  "description": "Los Sony WH-1000XM5 son auriculares inalámbricos de diadema con cancelación de ruido líder del sector y 30 horas de autonomía. Ofrecen multipoint Bluetooth 5.2 y carga rápida 3 min/1h. Su diseño ligero (250g) y cómodo los hace ideales para viajes y oficina.",',
    '  "short_description": "Auriculares Sony con ANC referente, 30h batería y multipoint. Ideales para viajar y trabajar.",',
    '  "highlights": [',
    '    "Cancelación de ruido referente en el sector",',
    '    "30 horas de autonomía con ANC activado",',
    '    "Bluetooth 5.2 multipoint (2 dispositivos)",',
    '    "Carga rápida: 3 min = 1 hora",',
    '    "Diseño ultraligero 250g"',
    '  ],',
    '  "pros_cons": {',
    '    "pros": [',
    '      { "text": "Mejor cancelación de ruido del mercado actual", "weight": 10, "source": "ai" },',
    '      { "text": "30h autonomía real con ANC", "weight": 9, "source": "scraped" },',
    '      { "text": "Multipoint Bluetooth 5.2 nativo", "weight": 8, "source": "ai" },',
    '      { "text": "Carga rápida USB-C (3 min = 1h)", "weight": 7, "source": "scraped" },',
    '      { "text": "Muy cómodos para uso prolongado (250g)", "weight": 7, "source": "ai" }',
    '    ],',
    '    "cons": [',
    '      { "text": "Sin certificación IP (no resistentes a sudor/lluvia)", "weight": 8, "source": "ai" },',
    '      { "text": "App necesaria para ecualizador y ajustes avanzados", "weight": 5, "source": "scraped" },',
    '      { "text": "Precio premium respecto a alternativas", "weight": 6, "source": "ai" }',
    '    ]',
    '  },',
    '  "specs": {',
    '    "Conectividad": "Bluetooth 5.2 Multipoint",',
    '    "Cancelación": "ANC híbrida 8 micrófonos",',
    '    "Autonomía": "30h (ANC on) / 40h (ANC off)",',
    '    "Carga": "USB-C, 3 min = 1h",',
    '    "Peso": "250 g",',
    '    "Codec": "LDAC, AAC, SBC"',
    '  },',
    '  "techSheet": "Diadema ajustable en piel sintética y aluminio · Drivers 30mm con diafragma de carbono · 8 micrófonos para ANC y llamadas · Bluetooth 5.2 con LDAC/AAC/SBC · Multipoint nativo 2 dispositivos · USB-C carga rápida 3 min/1h · 30h ANC on · 250g · Incluye estuche rigido, cable USB-C, cable jack 1.2m · Garantía 2 años Sony España",',
    '  "verdict": "Si buscas la mejor cancelación de ruido del mercado y autonomía para todo el día, los WH-1000XM5 son la referencia actual. Su precio premium se justifica si los usas a diario en entornos ruidosos.",',
    '  "category": "Audio y Sonido",',
    '  "subcategory": "Auriculares Inalámbricos",',
    '  "normalized_tags": [',
    '    "Bluetooth 5.2", "Cancelación de Ruido", "Multipoint", "USB Type-C",',
    '    "LDAC", "AAC", "30h Batería", "Carga Rápida", "250g", "Diadema"',
    '  ],',
    '  "matching_key": "sony-wh-1000xm5",',
    '  "competitor_terms": [',
    '    "sony", "wh1000xm5", "auriculares", "cancelacion-ruido", "bluetooth", "30h", "diadema", "ldac", "multipoint"',
    '  ],',
    '  "pricing": { "price": 299.99, "originalPrice": 399.99, "discountPercentage": 25 },',
    '  "categoryConfidence": 0.98,',
    '  "warnings": []',
    '}',
  ].join('\n');
}

/**
 * Genera el USER PROMPT con los datos del producto
 */
export function buildMasterUserPrompt(input: MasterPromptInput): string {
  const { product, availableCategories, existingProducts, knownOfferPrice, knownOriginalPrice } = input;

  const lines: string[] = [];

  lines.push('=== PRODUCTO A ENRIQUECER ===');
  lines.push(`Red: ${product.network}`);
  lines.push(`ID externo: ${product.externalId}`);
  lines.push(`Título original: ${product.title}`);
  lines.push(`Descripción original: ${product.description || '(vacía)'}`);
  lines.push(`Precio: ${product.price ?? 'N/A'} ${product.currency || 'EUR'}`);
  if (product.originalPrice) lines.push(`Precio original: ${product.originalPrice} ${product.currency || 'EUR'}`);
  if (product.commissionRate) lines.push(`Comisión: ${product.commissionRate}%`);
  lines.push(`Categoría de la red: ${product.category}`);
  lines.push(`Marca (si conocida): ${product.extra?.['Marca'] || product.extra?.['brand'] || 'N/A'}`);
  lines.push(`Distribuidor: ${product.extra?.['Distribuidor'] || product.extra?.['shop_name'] || 'N/A'}`);
  lines.push(`Valoración: ${product.rating ?? 'N/A'}/5 (${product.reviewsCount ?? 'N/A'} reseñas)`);
  lines.push(`Ventas (30d): ${product.popularity ?? (product.extra?.['Ventas (30 días)'] || 'N/A')}`);
  lines.push(`Envío: ${product.shippingInfo || 'N/A'}`);
  lines.push(`En stock: ${product.inStock ? 'Sí' : 'No'}`);

  if (product.gallery?.length) {
    lines.push(`Imágenes disponibles: ${product.gallery.length} (principal + ${product.gallery.length - 1} galería)`);
  }
  if (product.allImages?.length) {
    lines.push(`TOTAL imágenes capturadas: ${product.allImages.length}`);
  }

  // Specs conocidas
  if (product.extra) {
    const specKeys = Object.keys(product.extra).filter(k =>
      !['Marca', 'Distribuidor', 'Tienda', 'ID tienda', 'URL tienda',
        'Categoría nivel 1', 'Categoría nivel 2', 'ID categoría 1', 'ID categoría 2',
        'Precio de venta', 'Precio original', 'Precio app', 'Descuento',
        'Comisión (%)', 'Comisión hot (%)', 'Comisión mercado (%)', 'Comisión estimada',
        'Ventas (30 días)', 'Valoración (%)', 'Días de envío', 'Plataforma',
        'Imágenes', 'Enlace de afiliado', 'URL del producto', 'Vídeo', 'Imágenes extra'].includes(k)
    );
    if (specKeys.length) {
      lines.push('\n--- ESPECIFICACIONES EXTRA DE LA RED ---');
      for (const key of specKeys.slice(0, 20)) {
        const val = product.extra[key];
        if (val != null && val !== '') lines.push(`${key}: ${val}`);
      }
    }
  }

  // Productos existentes para contexto de matching
  if (existingProducts?.length) {
    lines.push('\n--- PRODUCTOS EXISTENTES EN CATÁLOGO (para matching_key) ---');
    for (const p of existingProducts.slice(0, 10)) {
      lines.push(`- ${p.id}: ${p.title} | ${p.category} | ${p.price}€ | mk: ${p.matching_key || 'N/A'}`);
    }
  }

  // Precios conocidos
  if (knownOfferPrice) lines.push(`\nPRECIO OFERTA CONOCIDO (respetar EXACTO): ${knownOfferPrice.toFixed(2)} EUR`);
  if (knownOriginalPrice) lines.push(`PRECIO ORIGINAL CONOCIDO: ${knownOriginalPrice.toFixed(2)} EUR`);

  lines.push('\n=== INSTRUCCIÓN ===');
  lines.push('Genera la ficha editorial COMPLETA en JSON válido según el esquema obligatorio.');
  lines.push('USA SOLO los datos proporcionados. NO inventes. Si falta algo, omítelo o marca "Desconocido" en techSheet.');

  return lines.join('\n');
}

/**
 * Parsea y valida la respuesta de la IA
 */
export function parseMasterPromptResponse(raw: string): MasterPromptOutput {
  // Limpiar markdown/code fences
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Intentar extraer JSON del texto
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } else {
      throw new Error('La IA no devolvió JSON válido');
    }
  }

  // Validación y saneado
  const output: MasterPromptOutput = {
    title: String(parsed.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    description: String(parsed.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 800),
    short_description: String(parsed.short_description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    highlights: Array.isArray(parsed.highlights)
      ? parsed.highlights.map((h: any) => String(h).replace(/\s+/g, ' ').trim()).filter((h: string) => h.length > 0).slice(0, 5)
      : [],
    pros_cons: {
      pros: Array.isArray(parsed.pros_cons?.pros)
        ? parsed.pros_cons.pros
            .map((p: any) => ({
              text: String(p?.text ?? '').replace(/\s+/g, ' ').trim(),
              weight: Math.max(1, Math.min(10, Number(p?.weight ?? 5))),
              source: ['scraped', 'ai', 'manual'].includes(p?.source) ? p.source : 'ai',
            }))
            .filter((p: any) => p.text.length > 1)
            .slice(0, 5)
        : [],
      cons: Array.isArray(parsed.pros_cons?.cons)
        ? parsed.pros_cons.cons
            .map((c: any) => ({
              text: String(c?.text ?? '').replace(/\s+/g, ' ').trim(),
              weight: Math.max(1, Math.min(10, Number(c?.weight ?? 5))),
              source: ['scraped', 'ai', 'manual'].includes(c?.source) ? c.source : 'ai',
            }))
            .filter((c: any) => c.text.length > 1)
            .slice(0, 4)
        : [],
    },
    specs: {},
    techSheet: String(parsed.techSheet ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000),
    verdict: String(parsed.verdict ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
    category: String(parsed.category ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
    subcategory: parsed.subcategory ? String(parsed.subcategory).replace(/\s+/g, ' ').trim().slice(0, 60) : undefined,
    normalized_tags: Array.isArray(parsed.normalized_tags)
      ? [...new Set<string>(parsed.normalized_tags.map((t: any) => String(t).replace(/\s+/g, ' ').trim()).filter((t: string) => t.length > 1))].slice(0, 20)
      : [],
    matching_key: String(parsed.matching_key ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    competitor_terms: Array.isArray(parsed.competitor_terms)
      ? [...new Set<string>(parsed.competitor_terms.map((t: any) => String(t).replace(/\s+/g, ' ').trim()).filter((t: string) => t.length > 1))].slice(0, 15)
      : [],
    pricing: {
      price: Number(parsed.pricing?.price ?? 0),
      originalPrice: Number(parsed.pricing?.originalPrice ?? 0),
      discountPercentage: Math.max(10, Math.min(40, Math.round(Number(parsed.pricing?.discountPercentage ?? 20)))),
    },
    categoryConfidence: Math.max(0, Math.min(1, Number(parsed.categoryConfidence ?? 0.5))),
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map((w: any) => String(w)).slice(0, 5) : [],
  };

  // Validar specs
  if (parsed.specs && typeof parsed.specs === 'object' && !Array.isArray(parsed.specs)) {
    for (const [key, value] of Object.entries(parsed.specs as Record<string, unknown>)) {
      const label = String(key).replace(/\s+/g, ' ').trim().slice(0, 60);
      const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (label && text) output.specs[label] = text;
      if (Object.keys(output.specs).length >= 8) break;
    }
  }

  // Validar pricing: originalPrice > price
  if (output.pricing.price > 0 && output.pricing.originalPrice <= output.pricing.price) {
    const discount = output.pricing.discountPercentage || 25;
    output.pricing.originalPrice = Math.round(output.pricing.price / (1 - discount / 100) * 100) / 100;
    // Redondear a precio "de tienda"
    output.pricing.originalPrice = Math.round(output.pricing.originalPrice * 100) / 100;
    if (output.pricing.originalPrice <= output.pricing.price) {
      output.pricing.originalPrice = output.pricing.price + 10;
    }
  }

  return output;
}

/**
 * Construye el prompt completo (system + user) listo para enviar a la IA
 */
export function buildFullMasterPrompt(input: MasterPromptInput): { system: string; user: string } {
  return {
    system: buildMasterSystemPrompt(),
    user: buildMasterUserPrompt(input),
  };
}

/**
 * Categorías disponibles para el prompt (se inyectan dinámicamente)
 */
export function getCategoriesForPrompt(): { roots: string[]; subs: string[] } {
  const categories = getCategories();
  return {
    roots: categories.filter(c => !c.parentId).map(c => c.name),
    subs: categories.filter(c => c.parentId).map(c => c.name),
  };
}