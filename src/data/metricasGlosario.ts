/**
 * ==============================================================================
 * TRADYLOR — GLOSARIO DE MÉTRICAS (MÓDULO TRÁFICO Y VENTAS)
 * ==============================================================================
 * Fuente única de verdad para la Guía del módulo y para los tooltips (`?`)
 * del dashboard. Cada métrica define:
 *   - definicionCorta: texto de tooltip (máx. 140 caracteres).
 *   - definicionLarga: explicación completa para la Guía.
 *   - consejoIa: recomendación rápida de técnica/ventas/IA.
 * ==============================================================================
 */

export type CategoriaMetrica = 'trafico' | 'seo' | 'ventas' | 'producto' | 'herramientas' | 'ia';

export interface MetricaDefinicion {
  id: string;
  nombre: string;
  categoria: CategoriaMetrica;
  definicionCorta: string;
  definicionLarga: string;
  consejoIa: string;
}

export interface CategoriaGlosario {
  id: CategoriaMetrica;
  label: string;
  descripcion: string;
}

export const categoriasGlosario: CategoriaGlosario[] = [
  { id: 'trafico', label: 'Tráfico', descripcion: 'Quién visita Tradylor, cuánto se queda y de dónde llega.' },
  { id: 'seo', label: 'SEO', descripcion: 'Visibilidad en buscadores: impresiones, clics y posiciones.' },
  { id: 'ventas', label: 'Ventas & Monetización', descripcion: 'Conversión, ingresos y valor de cada visitante.' },
  { id: 'producto', label: 'Métricas de Producto', descripcion: 'Rendimiento de cada ficha y detección de fricción de venta.' },
  { id: 'herramientas', label: 'Herramientas', descripcion: 'Fuentes e integraciones que alimentan estas métricas.' },
  { id: 'ia', label: 'IA', descripcion: 'Diagnósticos automáticos y recomendaciones de crecimiento.' },
];

export const glosarioMetricas: MetricaDefinicion[] = [
  // ── Tráfico global ────────────────────────────────────────────────────────
  {
    id: 'sesiones',
    nombre: 'Sesiones / Visitas totales',
    categoria: 'trafico',
    definicionCorta: 'Número total de visitas a la web en un periodo. Cada sesión agrupa toda la navegación de un mismo usuario seguido.',
    definicionLarga: 'Una sesión agrupa todas las páginas que una persona visita seguidas hasta que se queda inactivo (30 min por defecto) o cierra el navegador. Es el indicador bruto de cuánta gente llega a Tradylor: sirve para medir el impacto de campañas, publicaciones y cambios de posicionamiento. Compara siempre periodos equivalentes (mes a mes) para no confundir estacionalidad con crecimiento real.',
    consejoIa: 'Si las sesiones suben pero las ventas no, el problema no es de tráfico: revisa la ficha del producto o el precio frente a la competencia.',
  },
  {
    id: 'usuarios-unicos',
    nombre: 'Usuarios únicos',
    categoria: 'trafico',
    definicionCorta: 'Personas distintas que han visitado la web en el periodo, deduplicadas por dispositivo o identificador.',
    definicionLarga: 'Mide audiencia real frente a sesiones: una misma persona que entra tres veces cuenta como una sesión pero como un único usuario. La relación entre ambos números indica la fidelidad (un ratio cercano a 1 significa que casi nadie repite visita). Es la métrica base para calcular alcance, coste por visitante y valor de vida del usuario.',
    consejoIa: 'Compara sesiones y usuarios: si el ratio supera 2, tu contenido funciona pero el retorno es bajo — crea email o listas de favoritos para fidelizar.',
  },
  {
    id: 'paginas-por-sesion',
    nombre: 'Páginas por Sesión',
    categoria: 'trafico',
    definicionCorta: 'Promedio de páginas que se abre cada visitante durante una sola visita (valor entre 1 y ∞).',
    definicionLarga: 'Indica la profundidad de navegación. Un valor bajo (1-1,5) señala que la gente entra y se va sin explorar: la portada o el producto visitado no engancha. Un valor alto (3+) muestra interés y da más oportunidades de conversión porque el visitante ve varios productos y comparativas. Se mejora con enlaces internos, menús claros y bloques "también te puede interesar".',
    consejoIa: 'Añade a cada ficha un bloque de 3 productos relacionados de la misma categoría: es la vía más rápida para subir páginas por sesión.',
  },
  {
    id: 'permanencia',
    nombre: 'Tiempo Medio de Permanencia',
    categoria: 'trafico',
    definicionCorta: 'Segundos promedio que dura cada visita antes de salir, o de cerrar la pestaña.',
    definicionLarga: 'Mide cuánto tiempo real dedica el visitante a leer y comparar. En un portal de recomendación es directamente proporcional a la confianza: más tiempo suele significar que se leen verdictos, pros y contras antes de salir hacia la tienda. El tiempo en página de la ficha de producto es especialmente valioso porque precede a la salida de compra.',
    consejoIa: 'Si la permanencia es baja en fichas, acorta el texto inicial: pon el veredicto y los 3 pros clave en los primeros 100 píxeles.',
  },
  {
    id: 'tasa-rebote',
    nombre: 'Tasa de Rebote',
    categoria: 'trafico',
    definicionCorta: 'Porcentaje de visitas que se van tras ver una sola página, sin interactuar con el sitio.',
    definicionLarga: 'El rebote mide la primera impresión: si el visitante llega y no hace clic en nada más, la página no cumplió su promesa (o su intención de búsqueda no coincide con el contenido). Tasa alta no es siempre mala — en una página de respuesta directa puede ser normal — pero en la portada o en listados de categoría indica problemas de relevancia, velocidad o diseño.',
    consejoIa: 'Rebote alto + poco tiempo = la promesa del título no coincide con la página. Revisa títulos y meta descripciones del contenido que trae ese tráfico.',
  },
  {
    id: 'fuentes-trafico',
    nombre: 'Fuentes de Tráfico (Directo, Orgánico, Referido, Social)',
    categoria: 'trafico',
    definicionCorta: 'Reparto de visitas por origen: directo (URL escrita), orgánico (buscadores), referido (enlaces) y redes sociales.',
    definicionLarga: 'Directo: quien escribe la URL o la tiene marcada — marca consolidada. Orgánico: llega de Google/Bing sin pagar — el activo más valioso a medio plazo. Referido: enlaces desde otros sitios (prensa, blogs, directorios). Social: tráfico de Instagram, TikTok, X o Pinterest. Un perfil sano combina los cuatro: depender en exceso de una sola fuente expone el negocio a cambios de algoritmo o penalizaciones.',
    consejoIa: 'Si el social domina pero el orgánico es residual, invierte en fichas optimizadas para long-tail: el tráfico de buscador es gratis y acumulativo.',
  },

  // ── SEO ───────────────────────────────────────────────────────────────────
  {
    id: 'impresiones-seo',
    nombre: 'Impresiones SEO',
    categoria: 'seo',
    definicionCorta: 'Veces que una página aparece en los resultados de Google, aunque el usuario no haga clic.',
    definicionLarga: 'Las impresiones indican cuántas veces tu página se muestra para una búsqueda. Es el termómetro de la visibilidad: puedes tener miles de impresiones y pocos clics si apareces en posiciones bajas (página 2) o si el título no convence. Permite detectar oportunidades: términos con muchas impresiones y poco CTR son el mejor punto de partida para optimizar títulos y meta descripciones.',
    consejoIa: 'Busca en Search Console las consultas con >1.000 impresiones y CTR <1%: ahí tienes tráfico gratis esperando un mejor título.',
  },
  {
    id: 'ctr-organico',
    nombre: 'CTR Orgánico',
    categoria: 'seo',
    definicionCorta: 'Porcentaje de clics respecto a las impresiones en buscadores: clics ÷ impresiones × 100.',
    definicionLarga: 'Mide cuánta gente elige tu resultado cuando lo ve. Depende de la posición (arriba se hace clic más) y de lo atractivo del título y la meta descripción. Comparar el CTR real con el esperado para tu posición media revela si tus títulos son competitivos. Un CTR bajo corregible en un día: reescribir títulos es la optimización SEO con mejor relación esfuerzo/resultado.',
    consejoIa: 'Regla práctica: si estás en posiciones 3-8 con CTR bajo, añade número + beneficio al título (ej: "7 trucos…"). Suele subir un 20-40%.',
  },
  {
    id: 'posicion-media',
    nombre: 'Posición Media',
    categoria: 'seo',
    definicionCorta: 'Promedio de la posición en la que aparece tu página para las búsquedas que le traen visitas.',
    definicionLarga: 'Es la posición ponderada por clics de todas tus consultas. Una posición media baja (1-3) significa liderazgo; estar entre 4 y 10 es la zona de máximo crecimiento potencial porque pequeñas mejoras multiplican los clics. Ojo: la posición media sube (peor) cuando empiezas a rankear para términos nuevos y difíciles; no siempre es una regresión.',
    consejoIa: 'Prioriza las páginas en posiciones 4-10: con enlaces internos y contenido actualizado suelen entrar al top 3 más rápido que las de página 2.',
  },
  {
    id: 'indexabilidad',
    nombre: 'Indexabilidad',
    categoria: 'seo',
    definicionCorta: 'Porcentaje de páginas del sitio que Google ha podido indexar y puede mostrar en los resultados.',
    definicionLarga: 'Si una página no está indexada, simplemente no existe para Google. La indexabilidad se ve afectada por errores 404, redirecciones en cadena, contenido duplicado, etiquetas noindex o un sitemap desactualizado. En un catálogo de productos que crece con importaciones, es habitual que aparezcan páginas huérfanas o duplicadas: vigilarla evita perder tráfico silenciosamente.',
    consejoIa: 'Tras cada importación masiva de productos, revisa el sitemap: las fichas nuevas deben indexarse en menos de 7 días.',
  },
  {
    id: 'core-web-vitals',
    nombre: 'Core Web Vitals',
    categoria: 'seo',
    definicionCorta: 'Métricas de Google que miden la experiencia: LCP (carga), INP (interactividad) y CLS (estabilidad visual).',
    definicionLarga: 'LCP mide cuánto tarda en pintarse el contenido principal (<2,5 s ideal). INP mide la respuesta a la primera interacción (<200 ms). CLS mide los saltos de diseño (<0,1). Son factores de ranking y afectan directamente a la conversión: cada segundo extra de carga puede costar hasta un 7% de conversión. En móvil pesan el doble porque la mayoría del tráfico llega desde ahí.',
    consejoIa: 'Optimiza primero las imágenes de las 10 fichas con más visitas: comprimelas a WebP y sirve tamaños adecuados; es el LCP más rentable.',
  },

  // ── Ventas & Monetización ─────────────────────────────────────────────────
  {
    id: 'tasa-conversion',
    nombre: 'Tasa de Conversión (CR)',
    categoria: 'ventas',
    definicionCorta: 'Porcentaje de visitantes que completan una acción objetivo (clic de salida, compra…) sobre el total.',
    definicionLarga: 'Es la métrica reina: transforma tráfico en resultados. En un portal de afiliación la conversión suele medirse como clic de salida a la tienda (CTR de salida) y, si hay API de la red, como compra confirmada. Permite comparar productos y fuentes de tráfico con criterio: un producto con pocas visitas y alta CR merece más promoción que uno popular que no convierte.',
    consejoIa: 'Ordena los productos por CR y pinta arriba los de mayor conversión: el tráfico se asigna a lo que ya demuestra vender.',
  },
  {
    id: 'ecpm-rpm',
    nombre: 'eCPM / RPM',
    categoria: 'ventas',
    definicionCorta: 'Ingreso por cada mil impresiones: eCPM por mil impresiones de anuncio, RPM por mil visitas a la página.',
    definicionLarga: 'Ambos miden monetización normalizada, lo que permite comparar canales con tamaños distintos. RPM (revenue per mille) se calcula sobre las páginas vistas: ingresos ÷ páginas vistas × 1000. Es la mejor forma de saber qué secciones o plantillas generan más dinero por visitante, independientemente de cuánto tráfico reciban.',
    consejoIa: 'Compara el RPM por categoría: lleva tráfico a las secciones con mayor RPM, no a las que más visitas tienen.',
  },
  {
    id: 'aov',
    nombre: 'Valor Medio del Pedido (AOV)',
    categoria: 'ventas',
    definicionCorta: 'Importe promedio de cada pedido: ingresos totales ÷ número de pedidos en el periodo.',
    definicionLarga: 'El AOV determina cuánto vale cada conversión. Subir el AOV es más barato que conseguir clientes nuevos: basta con recomendar complementos, kits o versiones superiores en la misma ficha. En afiliación, un AOV alto compensa comisiones bajas porcentuales y hace más rentable cada clic de salida.',
    consejoIa: 'En cada ficha añade un "kit recomendado" con 1-2 complementos: es la palanca más directa para subir el AOV.',
  },
  {
    id: 'ltv',
    nombre: 'LTV (Valor de Vida del Cliente)',
    categoria: 'ventas',
    definicionCorta: 'Ingreso total que genera un usuario durante toda su relación con el sitio, no solo en su primera visita.',
    definicionLarga: 'El LTV mide el valor a largo plazo: un usuario que vuelve 10 veces vale mucho más que uno que compra una vez y desaparece. Se calcula multiplicando frecuencia de compra, AOV y margen por el tiempo medio de vida. Permite decidir cuánto invertir en captación y en qué canales merece la pena retener usuarios (email, favoritos, cuentas).',
    consejoIa: 'Prioriza el retorno sobre la captación: fidelizar a un usuario que ya compra suele ser 5× más barato que ganar uno nuevo.',
  },

  // ── Métricas de producto ──────────────────────────────────────────────────
  {
    id: 'visualizaciones-producto',
    nombre: 'Visualizaciones por Producto',
    categoria: 'producto',
    definicionCorta: 'Número de veces que se abre la ficha de un producto concreto en un periodo.',
    definicionLarga: 'Es el interés real por cada producto, con independencia del canal que lo traiga. Compara visualizaciones con posición en portada, categoría y destacados internos para saber qué promoción funciona. Un producto con muchas visualizaciones y pocas salidas de compra tiene un problema en su ficha (precio, fotos, verdicto); uno con pocas visualizaciones merece más exposición.',
    consejoIa: 'Cruza visualizaciones con clics de salida: la ficha con más visitas y peor CR es tu primera candidata a reescribir.',
  },
  {
    id: 'ratio-ficha-venta',
    nombre: 'Ratio Ficha-a-Contacto/Venta',
    categoria: 'producto',
    definicionCorta: 'Porcentaje de visitas a la ficha que terminan en clic de salida o compra: el embudo corto de cada producto.',
    definicionLarga: 'Resume en un solo número la eficacia de cada ficha: cuánta gente que llega da el paso hacia la tienda. Permite comparar productos con tamaños de audiencia distintos y detectar combinaciones ganadoras (producto + fuente de tráfico). Si el ratio es desigual entre fichas similares, la diferencia está en la calidad del contenido, no del producto.',
    consejoIa: 'Fichas con ratio bajo: prueba a mover el precio y los pros justo debajo del título y vuelve a medir durante una semana.',
  },
  {
    id: 'tiempo-ficha',
    nombre: 'Tiempo de Atención en Ficha',
    categoria: 'producto',
    definicionCorta: 'Segundos que dedica el visitante a leer una ficha antes de salir hacia la tienda o abandonar.',
    definicionLarga: 'El tiempo de atención indica cuánto se "consume" el contenido de la ficha antes de decidir. Demasiado poco (<10 s) suele significar que el visitante no encuentra lo que buscaba (fotos, precio o specs visibles). Demasiado largo con pocas salidas puede indicar dudas no resueltas: falta información clave o comparativa.',
    consejoIa: 'Menos de 10 segundos de atención + baja salida = el visitante abandona antes de entender la propuesta. Revisa el primer pantallazo de la ficha.',
  },
  {
    id: 'internal-rank',
    nombre: 'Puntuación de Posicionamiento Interno (Internal Rank Score)',
    categoria: 'producto',
    definicionCorta: 'Nota 0-100 que combina visitas, conversión y frescura para ordenar los productos dentro de la web.',
    definicionLarga: 'El algoritmo interno decide qué producto aparece primero en portada, categorías y buscador. Esta puntuación pondera métricas de rendimiento (visualizaciones, ratio de conversión) con señales editoriales (frescura de la reseña, completitud de la ficha). Hace explícito lo que antes era intuición: por qué un producto está arriba y cuánto debe mejorar el de abajo para escalar.',
    consejoIa: 'Sube el Internal Rank con acciones baratas: actualiza precio, añade 2 pros/contras nuevos y refresca la fecha del veredicto.',
  },
  {
    id: 'friccion-venta',
    nombre: 'Detección de Fricción de Venta',
    categoria: 'producto',
    definicionCorta: 'Alerta automática cuando una ficha recibe visitas pero pierde conversiones frente a su media o a su categoría.',
    definicionLarga: 'La fricción señala el punto exacto donde se rompe el embudo: precio percibido alto, envío dudoso, fotos poco claras, stock incierto o competencia más barata. El sistema la calcula comparando el ratio ficha-venta de cada producto con la media de su categoría y con su propio histórico. Detectarla a tiempo evita seguir enviando tráfico a una ficha que no convierte.',
    consejoIa: 'Fricción detectada = prueba una hipótesis cada vez (precio, fotos o pros) y mide 7 días antes de tocar otra cosa.',
  },

  // ── Herramientas ──────────────────────────────────────────────────────────
  {
    id: 'ga4',
    nombre: 'Google Analytics 4',
    categoria: 'herramientas',
    definicionCorta: 'Plataforma gratuita de Google que mide tráfico, comportamiento y eventos de la web con modelo por eventos.',
    definicionLarga: 'GA4 es la fuente canónica de sesiones, usuarios, páginas vistas y eventos personalizados (como los del tracker propio de Tradylor). trabaja con un modelo de eventos en lugar de sesiones clásicas, lo que permite medir interacciones concretas: clic en producto, añadido al carrito o salida a comercio. Se configura con una ID de medición y, para envíos personalizados, con la API secreta.',
    consejoIa: 'Configura eventos personalizados de salida a comercio: sin ellos sólo mides clics, no ingresos.',
  },
  {
    id: 'search-console',
    nombre: 'Google Search Console',
    categoria: 'herramientas',
    definicionCorta: 'Herramienta gratuita de Google para supervisar impresiones, consultas, posiciones e indexación de tu sitio.',
    definicionLarga: 'La Search Console es la fuente directa de datos SEO: impresiones, clics, CTR y posición media por consulta y página, además del estado de indexación y errores de rastreo. Es imprescindible para detectar oportunidades de palabras clave: las consultas con muchas impresiones y poco CTR son la mina de oro de cualquier portal de recomendación.',
    consejoIa: 'Revisa cada mes el informe de "Rendimiento" filtrando posiciones 4-10: ahí están las victorias SEO más rápidas.',
  },
  {
    id: 'adsense',
    nombre: 'Redes de Anuncios / AdSense',
    categoria: 'herramientas',
    definicionCorta: 'Redes que pagan por mostrar anuncios (AdSense, Ezoic…) mididas con eCPM, ingresos e impresiones.',
    definicionLarga: 'Las redes de display monetizan el tráfico que no convierte en ventas de afiliación: se paga por impresión o por clic, y su rendimiento se mide con eCPM/RPM. Complementan la afiliación, pero compiten por la atención del visitante: colocaciones intrusivas suben ingresos inmediatos pero bajan el ratio ficha-venta y la confianza.',
    consejoIa: 'Nunca pongas anuncios encima del bloque de pros/contras: canibalizan la salida de compra, que es tu ingreso principal.',
  },
  {
    id: 'pixeles',
    nombre: 'Píxeles de Seguimiento',
    categoria: 'herramientas',
    definicionCorta: 'Fragmentos de código de terceros (Meta, TikTok, GA4) que registran visitas y conversiones desde el navegador.',
    definicionLarga: 'Un píxel notifica a la red cuando un usuario realiza una acción, permitiendo atribución de conversiones y campañas de retargeting. Cada píxel añade código al navegador: demasiados ralentizan la página (Core Web Vitals) y activan avisos de cookies (RGPD). Deben cargarse de forma asíncrona y con consentimiento.',
    consejoIa: 'Audita los píxeles cargados en el homepage: si superan 3-4, estás pagando en velocidad por métricas que quizá no usas.',
  },
  {
    id: 'algoritmo-destacados',
    nombre: 'Algoritmo de Destacados Internos',
    categoria: 'herramientas',
    definicionCorta: 'Sistema propio que decide qué productos se muestran en portada, categorías y buscador según su rendimiento.',
    definicionLarga: 'Combina el Internal Rank Score con reglas editoriales (frescura, categorías equilibradas, productos sin agotar) para ordenar las secciones comerciales de la web. Evita el sesgo de "lo primero que se importó" y da a cada producto una oportunidad justa: los que mejor convierten escalan, los estancados pierden posición de forma gradual y explicable.',
    consejoIa: 'No fuerces posiciones a mano de forma continuada: deja trabajar el algoritmo y sólo destaca productos puntuales por campaña.',
  },

  // ── IA ────────────────────────────────────────────────────────────────────
  {
    id: 'salud-web',
    nombre: 'Diagnóstico de Salud Web',
    categoria: 'ia',
    definicionCorta: 'Informe automático que puntúa la salud global del sitio cruzando tráfico, SEO, velocidad y conversión.',
    definicionLarga: 'La IA sintetiza las métricas del periodo en una nota general con los 3 problemas más graves y su impacto estimado. En lugar de revisar decenas de gráficos, el diagnóstico prioriza: qué está rompiendo el embudo ahora mismo y qué orden de acciones reduce más pérdidas. Se recalcula con cada cierre de periodo para mostrar la evolución de la salud.',
    consejoIa: 'Actúa siempre sobre el primer hallazgo del diagnóstico hasta que desaparezca; los siguientes suelen ser síntomas del mismo problema.',
  },
  {
    id: 'growth-opportunities',
    nombre: 'Oportunidades de Crecimiento (Growth Opportunities)',
    categoria: 'ia',
    definicionCorta: 'Lista priorizada de mejoras con impacto estimado en tráfico o ventas, generada automáticamente con IA.',
    definicionLarga: 'Cruza métricas de producto, SEO y fuentes de tráfico para detectar huecos: categorías con demanda pero sin contenido, fichas con tráfico y baja conversión, o consultas de Search Console sin página propia. Cada oportunidad incluye el esfuerzo estimado y el beneficio esperado para decidir por ROI, no por intuición.',
    consejoIa: 'Filtra por "alto impacto + bajo esfuerzo" y ejecuta dos acciones por semana: la constancia vence a los grandes proyectos abandonados.',
  },
  {
    id: 'tips-optimizacion',
    nombre: 'Tips de Optimización por Producto',
    categoria: 'ia',
    definicionCorta: 'Recomendaciones concretas y accionables que la IA genera para cada ficha según sus métricas.',
    definicionLarga: 'A partir del ratio de conversión, el tiempo de atención y las señales de fricción, la IA propone cambios puntuales: acortar el veredicto, añadir comparativa, subir el precio si está por debajo del mercado, o reforzar los pros. Son sugerencias de una sola acción, medibles individualmente, pensadas para aplicarse sin reescribir la ficha entera.',
    consejoIa: 'Aplica un tip por ficha y anota la fecha: sin control de cambios no podrás saber qué consejo funcionó.',
  },
];

/** Busca una métrica del glosario por su id. */
export function getMetrica(id: string | undefined): MetricaDefinicion | undefined {
  if (!id) return undefined;
  return glosarioMetricas.find((metrica) => metrica.id === id);
}

/** Devuelve todas las métricas de una categoría, en orden de aparición. */
export function metricasPorCategoria(categoria: CategoriaMetrica): MetricaDefinicion[] {
  return glosarioMetricas.filter((metrica) => metrica.categoria === categoria);
}
