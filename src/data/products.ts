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

export interface Product {
  id: string;
  title: string;
  description: string;
  price: number;
  originalPrice?: number;
  image: string;
  category: string;
  merchant: 'Amazon' | 'PcComponentes' | 'El Corte Inglés' | 'Awin' | string;
  affiliateUrl: string;
  pros: string[];
  cons: string[];
  badge?: string;
  rating?: number;
  reviewsCount?: number;
  verdict?: string;
}

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
