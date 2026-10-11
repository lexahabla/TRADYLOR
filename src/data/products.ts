/**
 * ==============================================================================
 * TRADYLOR - ESTRATEGIA DE CONTENIDO Y AFILIACIÓN
 * ==============================================================================
 *
 * 1. PROPÓSITO DEL PORTAL:
 *    Tradylor actúa como un motor de curación y recomendación imparcial de productos
 *    de alta conversión. Filtramos el ruido publicitario del mercado mediante
 *    evaluaciones técnicas, análisis de valor por euro y comparativas directas.
 *    Monetizamos a través de enlaces de afiliación regulados (Amazon Associates,
 *    Awin, CJ Affiliate, etc.) garantizando una experiencia de usuario transparente.
 *
 * 2. DIRECTRICES EDITORIALES Y DE CONVERSIÓN (CRO):
 *    - Fichas estructuradas: Pros, Contras y Veredicto claro antes del pliegue (above-the-fold).
 *    - Intención de búsqueda transaccional: Artículos "Los mejores X de [año]" y comparativas "A vs B".
 *    - Enlaces salientes 100% seguros y transparentes según directrices de Google:
 *      target="_blank" rel="nofollow noopener sponsored"
 *    - Cumplimiento estricto con normativas de la FTC y legislación europea sobre
 *      declaración de afiliación y transparencia publicitaria.
 * ==============================================================================
 */

import type { Product as ProductSchema } from '../content/config';

// ─── Flat Product Interface (backward-compatible with products.json) ──────────
export interface Product {
  id: string;
  slug?: string;
  title: string;
  description: string;
  price: number;
  originalPrice?: number;
  image: string;
  /** Galería de imágenes del producto (la primera suele ser la principal). */
  gallery?: string[];
  category: string;
  merchant: string;
  affiliateUrl: string;
  buyNowUrl?: string;
  /** Código ASIN de Amazon (se autodetecta al pegar el enlace de afiliado). */
  asin?: string;
  pros: string[];
  cons: string[];
  badge?: string;
  rating?: number;
  reviewsCount?: number;
  verdict?: string;
  specs?: Record<string, string>;
  fulfillmentProvider?: string;

  // ─── New structured fields (optional for backward compat) ──────────────────
  awardBadge?: string;
  productType?: 'Laptop' | 'Tablet' | 'Smartphone' | 'Smartwatch' | 'Auriculares' | 'Monitor' | 'Electrodoméstico' | 'Otros';
  brand?: string;
  model?: string;
  pricing?: {
    currentPrice: number;
    originalPrice?: number;
    discountPercentage?: number;
    priceLastChecked: string;
    freeShipping: boolean;
    stockStatus: 'En stock' | 'Pocas unidades' | 'Agotado';
  };
  conversionHooks?: {
    idealFor?: string;
    notRecommendedFor?: string;
    returnPolicyDays: number;
    rating: number;
    totalReviewsCount: number;
    satisfactionScore?: {
      positivePercentage: number;
      negativePercentage: number;
    };
  };
  investigation?: {
    hoursInvestigated: number;
    modelsCompared: number;
    hiddenDrawbacks: string[];
    pros: string[];
    cons: string[];
  };
  affiliate?: {
    primaryStore: string;
    primaryUrl: string;
    buyNowUrl?: string;
    alternativeStore?: string;
    alternativeUrl?: string;
  };
  alternatives?: {
    cheaperOptionId?: string;
    premiumOptionId?: string;
    similarOptionId?: string;
  };
}

// ─── Type guard: checks if a Product has the new structured fields ───────────
export function hasStructuredFields(product: Product): boolean {
  return (
    product.pricing !== undefined &&
    product.conversionHooks !== undefined &&
    product.investigation !== undefined &&
    product.affiliate !== undefined
  );
}

// ─── Migration helper: converts flat Product to structured Product ───────────
export function toStructuredProduct(flat: Product): ProductSchema {
  return {
    id: flat.id,
    slug: flat.slug,
    title: flat.title,
    description: flat.description ?? '',
    specs: flat.specs,
    fulfillmentProvider: flat.fulfillmentProvider,
    category: flat.category ?? 'General',
    productType: (flat.productType as ProductSchema['productType']) ?? 'Otros',
    brand: flat.brand ?? '',
    model: flat.model ?? flat.title,
    awardBadge: flat.awardBadge ?? flat.badge,
    pricing: {
      currentPrice: flat.price,
      originalPrice: flat.originalPrice,
      discountPercentage: flat.originalPrice
        ? Math.round(((flat.originalPrice - flat.price) / flat.originalPrice) * 100)
        : undefined,
      priceLastChecked: new Date().toISOString().split('T')[0],
      freeShipping: false,
      stockStatus: 'En stock',
    },
    conversionHooks: {
      idealFor: flat.conversionHooks?.idealFor,
      notRecommendedFor: flat.conversionHooks?.notRecommendedFor,
      returnPolicyDays: flat.conversionHooks?.returnPolicyDays ?? 30,
      rating: flat.conversionHooks?.rating ?? flat.rating ?? 4.5,
      totalReviewsCount: flat.conversionHooks?.totalReviewsCount ?? flat.reviewsCount ?? 0,
      satisfactionScore: flat.conversionHooks?.satisfactionScore ?? {
        positivePercentage: 85,
        negativePercentage: 15,
      },
    },
    investigation: {
      hoursInvestigated: 10,
      modelsCompared: 5,
      hiddenDrawbacks: [],
      pros: flat.pros ?? [],
      cons: flat.cons ?? [],
    },
    affiliate: {
      primaryStore: flat.merchant ?? 'Amazon',
      primaryUrl: flat.affiliateUrl,
      buyNowUrl: flat.buyNowUrl,
      asin: flat.asin,
      alternativeStore: undefined,
      alternativeUrl: undefined,
    },
    alternatives: flat.alternatives,
    image: flat.image,
    gallery: flat.gallery,
    badge: flat.badge,
    verdict: flat.verdict,
  };
}

// ─── Static product data (curated editorial entries) ─────────────────────────
export const products: Product[] = [
  {
    id: 'sony-wh-1000xm5',
    title: 'Sony WH-1000XM5 - Auriculares Inalámbricos Noise Cancelling Líder',
    description: 'La referencia absoluta en cancelación de ruido activa con procesador dual V1/QN1, 30h de autonomía y llamadas ultra nítidas gracias a sus 8 micrófonos con IA.',
    price: 329.99,
    originalPrice: 419.99,
    image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=800&auto=format&fit=crop',
    category: 'Audio & Sonido',
    merchant: 'Amazon',
    affiliateUrl: 'https://www.amazon.es/dp/B09Y2MYL5C?tag=tradylor-21',
    badge: 'Elección del Editor',
    rating: 4.8,
    reviewsCount: 1420,
    verdict: 'Si buscas el mayor aislamiento acústico para trabajar o viajar con comodidad premium, no tiene rival en su gama de precio.',
    productType: 'Auriculares',
    brand: 'Sony',
    model: 'WH-1000XM5',
    fulfillmentProvider: 'Amazon Logistics',
    specs: {
      'Autonomía': 'Hasta 30 horas',
      'Conectividad': 'Bluetooth 5.3 + cable 3,5 mm',
      'Cancelación de ruido': 'Activa (ANC) adaptativa',
      'Carga': '3 horas de audio en 3 minutos',
      'Peso': '250 g',
    },
    conversionHooks: {
      returnPolicyDays: 30,
      rating: 4.8,
      totalReviewsCount: 1420,
      satisfactionScore: { positivePercentage: 92, negativePercentage: 8 },
    },
    pros: [
      'Cancelación de ruido líder en la industria con calibración automática.',
      'Sonido Hi-Res con codec LDAC y ecualizador multibanda muy detallado.',
      'Comodidad ergonómica excepcional para sesiones de uso prolongado.',
      'Carga ultrarrápida: 3 horas de reproducción en solo 3 minutos de carga.'
    ],
    cons: [
      'El diseño de la diadema ya no es plegable sobre sí mismo.',
      'No cuenta con certificación oficial contra salpicaduras o sudor IPX.'
    ]
  },
  {
    id: 'apple-macbook-air-m3',
    title: 'Apple MacBook Air 13" con Chip M3 (16GB RAM, 256GB SSD)',
    description: 'Portátil ultraligero con pantalla Liquid Retina de 13,6", autonomía récord de hasta 18 horas y rendimiento brutal sin ventiladores gracias a la arquitectura de 3nm de Apple.',
    price: 1199.00,
    originalPrice: 1299.00,
    image: 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?q=80&w=800&auto=format&fit=crop',
    category: 'Informática & Laptops',
    merchant: 'Amazon',
    affiliateUrl: 'https://www.amazon.es/dp/B0CX23R2PY?tag=tradylor-21',
    badge: 'Mejor Portátil Global',
    rating: 4.9,
    reviewsCount: 890,
    verdict: 'El equilibrio definitivo entre autonomía, ligereza y potencia sostenida para el 95% de estudiantes y profesionales.',
    productType: 'Laptop',
    brand: 'Apple',
    model: 'MacBook Air M3',
    fulfillmentProvider: 'Amazon Logistics',
    specs: {
      'Procesador': 'Apple M3 (8 núcleos)',
      'Pantalla': 'Liquid Retina 13,6"',
      'Memoria': '16 GB unificada',
      'Almacenamiento': '256 GB SSD',
      'Autonomía': 'Hasta 18 horas',
    },
    conversionHooks: {
      returnPolicyDays: 30,
      rating: 4.9,
      totalReviewsCount: 890,
      satisfactionScore: { positivePercentage: 95, negativePercentage: 5 },
    },
    pros: [
      'Chip M3 con soporte para dos pantallas externas (con tapa cerrada).',
      'Silencioso al 100%: chasis unibody de aluminio con refrigeración pasiva.',
      'Teclado Magic Keyboard con Touch ID y el mejor trackpad del mercado.',
      'Batería inagotable capaz de superar holgadamente una jornada laboral completa.'
    ],
    cons: [
      'Velocidad de lectura/escritura del modelo base de 256 GB justa para vídeo pesado.',
      'Solo 2 puertos Thunderbolt/USB 4, requiere hub para periféricos múltiples.'
    ]
  },
  {
    id: 'kindle-paperwhite-signature',
    title: 'Kindle Paperwhite Signature Edition (32 GB, Luz autorregulable)',
    description: 'E-reader resistente al agua (IPX8) con pantalla antirreflejos de 6,8" a 300 ppp, luz frontal cálida ajustable, carga inalámbrica Qi y batería para 10 semanas.',
    price: 169.99,
    originalPrice: 189.99,
    image: 'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?q=80&w=800&auto=format&fit=crop',
    category: 'Lectura Digital',
    merchant: 'Amazon',
    affiliateUrl: 'https://www.amazon.es/dp/B08N2RL24X?tag=tradylor-21',
    badge: 'Mejor Calidad-Precio',
    rating: 4.7,
    reviewsCount: 3150,
    verdict: 'La mejor experiencia de lectura digital jamás creada: pantalla nítida como papel impreso, autonomía de meses y cero distracciones.',
    productType: 'Tablet',
    brand: 'Amazon',
    model: 'Kindle Paperwhite Signature',
    fulfillmentProvider: 'Amazon Logistics',
    specs: {
      'Pantalla': '6,8" · 300 ppp antirreflejos',
      'Almacenamiento': '32 GB',
      'Resistencia': 'IPX8 (agua dulce)',
      'Autonomía': 'Hasta 10 semanas',
      'Carga': 'USB-C e inalámbrica Qi',
    },
    conversionHooks: {
      returnPolicyDays: 30,
      rating: 4.7,
      totalReviewsCount: 3150,
      satisfactionScore: { positivePercentage: 88, negativePercentage: 12 },
    },
    pros: [
      'Sensor de luz ambiental automático y tono de pantalla de frío a cálido.',
      'Capacidad masiva de 32 GB ideal para audiolibros Audible y colecciones completas.',
      'Soporte de carga inalámbrica Qi y puerto USB-C moderno.',
      'Resistencia al agua certificada IPX8 ideal para leer en piscina o bañera.'
    ],
    cons: [
      'Ecosistema cerrado orientado principalmente a la tienda oficial de Amazon.',
      'Precio superior a la versión estándar si no requieres carga Qi ni 32 GB.'
    ]
  },
  {
    id: 'roborock-q-revo',
    title: 'Roborock Q Revo - Robot Aspirador y Fregasuelos con Base Multifunción',
    description: 'Robot de limpieza con mopa giratoria elevable a 200 rpm, succión extrema de 5500 Pa, navegación LiDAR precisa y estación de vaciado/autolavado con secado por aire caliente.',
    price: 679.00,
    originalPrice: 849.00,
    image: 'https://images.unsplash.com/photo-1518770660439-4636190af475?q=80&w=800&auto=format&fit=crop',
    category: 'Hogar Inteligente',
    merchant: 'PcComponentes',
    affiliateUrl: 'https://www.pccomponentes.com/buscar/?query=roborock+q+revo&tag=tradylor-21',
    badge: 'Máxima Eficiencia',
    rating: 4.8,
    reviewsCount: 620,
    verdict: 'Automatización total del fregado y aspirado doméstico sin gastar las cifras desorbitadas de modelos de más de 1200 euros.',
    productType: 'Electrodoméstico',
    brand: 'Roborock',
    model: 'Q Revo',
    fulfillmentProvider: 'PcComponentes',
    specs: {
      'Succión': '5.500 Pa',
      'Mopas': 'Giratorias a 200 rpm',
      'Navegación': 'LiDAR multizona',
      'Base': 'Vaciado y autolavado con secado térmico',
      'App': 'Roborock (iOS / Android)',
    },
    conversionHooks: {
      returnPolicyDays: 30,
      rating: 4.8,
      totalReviewsCount: 620,
      satisfactionScore: { positivePercentage: 85, negativePercentage: 15 },
    },
    pros: [
      'Doble mopa giratoria presurizada que elimina manchas resecas con eficacia real.',
      'Base con lavado, secado térmico para evitar olores y vaciado de polvo hasta 7 semanas.',
      'Elevación automática de mopas al detectar alfombras para evitar mojarlas.',
      'App intuitiva con mapeo 3D multizona, zonas restringidas y programación milimétrica.'
    ],
    cons: [
      'La base de carga requiere un espacio generoso en la estancia.',
      'El reconocimiento de cables diminutos es por sensor infrarrojo, no cámara RGB.'
    ]
  }
];
