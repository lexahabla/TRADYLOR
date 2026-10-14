/**
 * ==============================================================================
 * TRADYLOR — COMPARTIR DESDE MI RADAR (marketing indirecto)
 * ==============================================================================
 * Plantillas de texto + envío a cada red. Todo lo que sale de aquí apunta a la
 * ficha individual del producto: https://tradylor.com/producto/<slug>.
 *
 * Tono: recomendación de persona a persona, jamás "compra en mi enlace".
 *
 * IDIOMAS: el texto se traduce según el idioma elegido en el panel. El
 * catalán, euskera y gallego se detectan automáticamente si aparecen en la
 * lista de idiomas del navegador (aunque no sean el primero) o si el servidor
 * ubica al visitante en su región por IP (/api/share/region, lib/shareGeo.ts):
 * cubre a usuarios de Catalunya, Euskadi o Galicia con el navegador en
 * castellano. La elección se recuerda en LocalStorage.
 * ==============================================================================
 */

import { escapeHtml, SHARE_EMAIL_LABELS } from './shareEmail';

export type ShareChannel =
  | 'whatsapp'
  | 'telegram'
  | 'x'
  | 'facebook'
  | 'reddit'
  | 'pinterest'
  | 'email'
  | 'copy'
  | 'native';

/** Idiomas con plantilla propia. */
export type ShareLangCode = 'es' | 'ca' | 'eu' | 'gl' | 'en' | 'fr' | 'de' | 'pt' | 'it';

/** Todos los códigos de idioma válidos (para validar query params en SSR). */
export const SHARE_LANG_CODES: ShareLangCode[] = ['es', 'ca', 'eu', 'gl', 'en', 'fr', 'de', 'pt', 'it'];

export interface ShareInput {
  productId: string;
  title: string;
  category?: string;
}

/** Datos públicos de la ficha que pinta la tarjeta copiada (ver buildShareCardHtml). */
export interface ShareCardInfo {
  title: string;
  category?: string;
  /** URL absoluta de la imagen del producto. */
  image: string;
  /** Enlace a la ficha individual (https://tradylor.com/producto/<slug>). */
  url: string;
  /** Ventajas del producto (máx. 3). */
  pros: string[];
}

export interface ShareResult {
  ok: boolean;
  /** opened = app/web abierta; copied = texto copiado; native = share nativo. */
  mode: 'opened' | 'copied' | 'native';
  message?: string;
}

const ORIGIN = 'https://tradylor.com';
const LANG_STORAGE_KEY = 'tradylor_share_lang';

interface LangPack {
  /** Nombre del idioma en el propio idioma (etiqueta del selector). */
  label: string;
  panelTitle: string;
  dm: string[];
  threads: string[];
  /** Plantilla específica para X (fallback: threads). */
  x?: string[];
  /** Plantilla específica para Reddit (fallback: threads). */
  reddit?: string[];
  /** Título del post de Reddit (fallback: título del producto). */
  redditTitle?: string;
  /** Plantilla específica para Facebook (fallback: threads). */
  facebook?: string[];
  visual: string[];
  copy: string;
  native: string;
  copiedLink: string;
  copiedText: (channel: string) => string;
  noClipboard: string;
  nativeFallback: string;
  openFailed: (channel: string) => string;
  unsupported: string;
}

/** Etiquetas de canal traducidas (las marcas se quedan igual). */
const CHANNEL_LABELS: Record<ShareLangCode, Partial<Record<ShareChannel, string>>> = {
  es: { email: 'A mi correo' },
  ca: { copy: "Copia l'enllaç", native: 'Comparteix…', email: 'Al meu correu' },
  eu: { copy: 'Kopiatu esteka', native: 'Partekatu…', email: 'Nire postara' },
  gl: { copy: 'Copiar ligazón', native: 'Compartir…', email: 'Ao meu correo' },
  en: { copy: 'Copy link', native: 'Share…', email: 'To my email' },
  fr: { copy: 'Copier le lien', native: 'Partager…', email: 'À mon e-mail' },
  de: { copy: 'Link kopieren', native: 'Teilen…', email: 'An meine E-Mail' },
  pt: { copy: 'Copiar link', native: 'Compartilhar…', email: 'Para o meu email' },
  it: { copy: 'Copia link', native: 'Condividi…', email: 'Alla mia email' },
};

const LANG_PACKS: Record<ShareLangCode, LangPack> = {
  es: {
    label: 'Español',
    panelTitle: 'Compartir producto',
    dm: [
      'Por si te sirve, estuve usando esta web para buscar y comparar precios de esto y me ha parecido un hallazgo. Calidad-precio está de lujo! {url}',
    ],
    threads: [
      'Si alguien anda buscando {categoria}, en Tradylor.com lo han puesto como la opción top tras comparar especificaciones y precio. Aquí tenéis la ficha con el seguimiento de precio activo: {url}',
    ],
    x: [
      'Descubrí esta web para comparar precios y la verdad que te saca muy bien las opciones calidad-precio reales.\n\nDejo por aquí el análisis de este modelo por si a alguien le sirve 👇\n{url}\n\n#Chollos #Ofertas #Tecnologia',
    ],
    reddit: [
      'Buenas! Estuve un buen rato buscando y comparando precios para renovar/comprar {titulo}. Usé un buscador nuevo que encontré (Tradylor) para ver gráficas e historial y por especificaciones/precio parece de lo mejorcito en este rango.\n\nOs dejo la ficha por si queréis echarle un ojo o si alguien lo tiene y me confirma qué tal sale: {url}',
    ],
    redditTitle: '¿Qué opináis de esta opción calidad-precio para {categoria}?',
    facebook: [
      'Os comparto esto por si a alguien le viene bien. Estuve usando esta web para buscar y comparar precios de {categoria} y me ha parecido un hallazgo para no volverse loco entre tantas opciones.\n\nTe analiza las mejores opciones calidad-precio con gráficas de evolución. Esta en concreto me ha parecido que está genial de precio ahora mismo:\n\n{url}',
    ],
    visual: [
      'La mejor opción calidad-precio en {categoria}, con el histórico de precio verificado. Ficha completa → {url}',
      'Comparé specs y precio de todo lo que hay en {categoria} y esto se quedó solo. Ficha en Tradylor → {url}',
      '{categoria}: análisis, pros/contras y gráfica de precio al día. Todo aquí → {url}',
    ],
    copy: 'Copiar enlace',
    native: 'Compartir…',
    copiedLink: 'Enlace copiado. Pégalo en un correo o editor y se verá la ficha del producto.',
    copiedText: (ch) => `Texto copiado. Pégalo en ${ch}.`,
    noClipboard: 'No se pudo copiar el enlace.',
    nativeFallback: 'Tu navegador no permite compartir: texto copiado.',
    openFailed: (ch) => `No se pudo abrir ${ch}.`,
    unsupported: 'Canal no soportado.',
  },
  ca: {
    label: 'Català',
    panelTitle: 'Compartir producte',
    dm: [
      "Per si et serveix, estava fent servir aquesta web per buscar i comparar preus d'això i m'ha semblat un bon troballa. Qualitat-preu està de luxe! {url}",
    ],
    threads: [
      "Si algú busca {categoria}, a Tradylor.com l'han posat com a opció top després de comparar especificacions i preu. Aquí teniu la fitxa amb el seguiment de preu actiu: {url}",
    ],
    visual: [
      "La millor opció qualitat-preu en {categoria}, amb l'historial de preu verificat. Fitxa completa → {url}",
      'Vaig comparar specs i preu de tot el que hi ha a {categoria}, i això es va quedar sol. Fitxa a Tradylor → {url}',
      '{categoria}: anàlisi, pros/contres i gràfic de preu al dia. Tot aquí → {url}',
    ],
    copy: "Copia l'enllaç",
    native: 'Comparteix…',
    copiedLink: "Enllaç copiat. Enganxa'l en un correu o editor i es veurà la fitxa del producte.",
    copiedText: (ch) => `Text copiat. Enganxa'l a ${ch}.`,
    noClipboard: "No s'ha pogut copiar l'enllaç.",
    nativeFallback: 'El teu navegador no permet compartir: text copiat.',
    openFailed: (ch) => `No s'ha pogut obrir ${ch}.`,
    unsupported: 'Canal no compatible.',
  },
  eu: {
    label: 'Euskera',
    panelTitle: 'Produktua partekatu',
    dm: [
      'Bali bada, web hau erabiltzen ari nintzen hau bilatzeko eta prezioak konparatzeko, eta aurkikuntza ona iruditu zait. Kalitate-prezioa primerakoa da! {url}',
    ],
    threads: [
      'Norbait {categoria} bilatzen ari bada, Tradylor.com-en ipini dute aukera onena, zehaztapenak eta prezioa konparatu ondoren. Hemen duzu prezio-jarraipen aktiboarekin: {url}',
    ],
    visual: [
      '{categoria}-ren kalitate-preziorik onena, egiaztatutako prezio-historialarekin. Fitxa osoa → {url}',
      '{categoria}-ko zehaztapen eta prezioak konparatu nituen, eta hau bakarrik geratu zen. Tradylor-en fitxa → {url}',
      '{categoria}: azterketa, ondo/txarto eta eguneratutako prezio-grafikoa. Hemen dago → {url}',
    ],
    copy: 'Kopiatu esteka',
    native: 'Partekatu…',
    copiedLink: 'Esteka kopiatu. Itsatsi posta-edizaile batean eta produktuaren fitxa ikusiko da.',
    copiedText: (ch) => `Testua kopiatu da. Itsatsi ${ch}-n.`,
    noClipboard: 'Ezin izan da esteka kopiatu.',
    nativeFallback: 'Zure arakatzaileak ez du partekatzera baimentzen: testua kopiatu da.',
    openFailed: (ch) => `Ezin izan da ${ch} ireki.`,
    unsupported: 'Kanal ez onartua.',
  },
  gl: {
    label: 'Galego',
    panelTitle: 'Compartir produto',
    dm: [
      'Por se che sirva, estaba a usar esta web para buscar e comparar prezos disto e pareceume un achado. Calidade-prezo está de luxo! {url}',
    ],
    threads: [
      'Se alguén busca {categoria}, en Tradylor.com puxérona como a opción top despois de comparar especificacións e prezo. Aquí tedes a ficha co seguimento de prezo activo: {url}',
    ],
    visual: [
      'A mellor opción calidade-prezo en {categoria}, co historial de prezo verificado. Ficha completa → {url}',
      'Comparei especificacións e prezos de todo o que hai en {categoria} e isto quedou só. Ficha en Tradylor → {url}',
      '{categoria}: análise, pros/contras e gráfico de prezo ao día. Todo aquí → {url}',
    ],
    copy: 'Copiar ligazón',
    native: 'Compartir…',
    copiedLink: 'Ligazón copiada. Pégaa nun correo ou editor e verase a ficha do produto.',
    copiedText: (ch) => `Texto copiado. Pégalo en ${ch}.`,
    noClipboard: 'Non se puido copiar a ligazón.',
    nativeFallback: 'O teu navegador non permite compartir: texto copiado.',
    openFailed: (ch) => `Non se puido abrir ${ch}.`,
    unsupported: 'Canal non compatible.',
  },
  en: {
    label: 'English',
    panelTitle: 'Share product',
    dm: [
      "In case it's useful, I was using this website to search and compare prices for this and I think it's a great find. Value for money is great! {url}",
    ],
    threads: [
      "If anyone is looking for {categoria}, Tradylor.com has it as the top pick after comparing specs and price. Here's the sheet with price tracking live: {url}",
    ],
    visual: [
      'Best value for money in {categoria}, with verified price history. Full sheet → {url}',
      "I compared specs and prices across {categoria} and this one stood alone. Tradylor sheet → {url}",
      '{categoria}: analysis, pros/cons and an up-to-date price chart. All here → {url}',
    ],
    copy: 'Copy link',
    native: 'Share…',
    copiedLink: 'Link copied. Paste it into an email or editor and the product card appears.',
    copiedText: (ch) => `Text copied. Paste it into ${ch}.`,
    noClipboard: "Couldn't copy the link.",
    nativeFallback: 'Your browser blocks sharing: text copied.',
    openFailed: (ch) => `Couldn't open ${ch}.`,
    unsupported: 'Unsupported channel.',
  },
  fr: {
    label: 'Français',
    panelTitle: 'Partager le produit',
    dm: [
      "Au cas où ça pourrait t'être utile, j'utilisais ce site pour chercher et comparer les prix de ça et j'ai trouvé ça une bonne affaire. Rapport qualité-prix excellent ! {url}",
    ],
    threads: [
      "Si quelqu'un cherche {categoria}, Tradylor.com le place en tête après avoir comparé specs et prix. Voici la fiche avec le suivi de prix actif : {url}",
    ],
    visual: [
      'Le meilleur rapport qualité-prix en {categoria}, avec l’historique des prix vérifié. Fiche complète → {url}',
      "J'ai comparé specs et prix dans {categoria} et celui-ci est sorti du lot. Fiche Tradylor → {url}",
      "{categoria} : analyse, points forts/faibles et graphique des prix à jour. Tout ici → {url}",
    ],
    copy: 'Copier le lien',
    native: 'Partager…',
    copiedLink: 'Lien copié. Collez-le dans un e-mail ou un éditeur : la fiche du produit s’affiche.',
    copiedText: (ch) => `Texte copié. Collez-le dans ${ch}.`,
    noClipboard: 'Impossible de copier le lien.',
    nativeFallback: 'Votre navigateur bloque le partage : texte copié.',
    openFailed: (ch) => `Impossible d’ouvrir ${ch}.`,
    unsupported: 'Canal non pris en charge.',
  },
  de: {
    label: 'Deutsch',
    panelTitle: 'Produkt teilen',
    dm: [
      'Falls es dir nützt: Ich habe diese Website genutzt, um die Preise dafür zu suchen und zu vergleichen, und fand es einen tollen Fund. Preis-Leistung ist top! {url}',
    ],
    threads: [
      'Falls jemand {categoria} sucht: Auf Tradylor.com ist es nach Vergleich von Specs und Preis die Top-Empfehlung. Hier das Blatt mit aktivem Preis-Tracking: {url}',
    ],
    visual: [
      'Bestes Preis-Leistungs-Verhältnis bei {categoria}, mit geprüftem Preisverlauf. Vollständiges Datenblatt → {url}',
      'Ich habe Specs und Preise bei {categoria} verglichen – das hier war die eindeutige Wahl. Tradylor-Datenblatt → {url}',
      '{categoria}: Analyse, Vor-/Nachteile und aktueller Preischart. Alles hier → {url}',
    ],
    copy: 'Link kopieren',
    native: 'Teilen…',
    copiedLink: 'Link kopiert. Füge ihn in eine E-Mail oder einen Editor ein – die Produktkarte erscheint.',
    copiedText: (ch) => `Text kopiert. Füge ihn in ${ch} ein.`,
    noClipboard: 'Link konnte nicht kopiert werden.',
    nativeFallback: 'Dein Browser blockiert Teilen: Text kopiert.',
    openFailed: (ch) => `${ch} konnte nicht geöffnet werden.`,
    unsupported: 'Kanal wird nicht unterstützt.',
  },
  pt: {
    label: 'Português',
    panelTitle: 'Partilhar produto',
    dm: [
      'Por acaso te sirva, estava a usar este site para procurar e comparar preços disto e pareceu-me um achado. A relação qualidade-preço está ótima! {url}',
    ],
    threads: [
      'Se alguém procura {categoria}, no Tradylor.com ficou como a melhor opção depois de comparar especificações e preço. Aqui fica a ficha com o acompanhamento de preço ativo: {url}',
    ],
    visual: [
      'A melhor relação qualidade-preço em {categoria}, com histórico de preços verificado. Ficha completa → {url}',
      'Comparei especificações e preços em {categoria} e este destacou-se. Ficha no Tradylor → {url}',
      '{categoria}: análise, prós/contras e gráfico de preços atualizado. Tudo aqui → {url}',
    ],
    copy: 'Copiar link',
    native: 'Partilhar…',
    copiedLink: 'Link copiado. Cola-o num email ou editor e aparece o cartão do produto.',
    copiedText: (ch) => `Texto copiado. Cola-o no ${ch}.`,
    noClipboard: 'Não foi possível copiar o link.',
    nativeFallback: 'O teu navegador bloqueia a partilha: texto copiado.',
    openFailed: (ch) => `Não foi possível abrir ${ch}.`,
    unsupported: 'Canal não suportado.',
  },
  it: {
    label: 'Italiano',
    panelTitle: 'Condividi il prodotto',
    dm: [
      "Nel caso ti serva, stavo usando questo sito per cercare e confrontare i prezzi di questo e mi è sembrato una bella scoperta. Il rapporto qualità-prezzo è perfetto! {url}",
    ],
    threads: [
      'Se qualcuno sta cercando {categoria}, su Tradylor.com è la scelta top dopo aver confrontato specifiche e prezzo. Ecco la scheda con il tracking del prezzo attivo: {url}',
    ],
    visual: [
      'Il miglior rapporto qualità-prezzo in {categoria}, con storico prezzi verificato. Scheda completa → {url}',
      "Ho confrontato specifiche e prezzi in {categoria} e questo è emerso da solo. Scheda Tradylor → {url}",
      '{categoria}: analisi, pro/contro e grafico prezzi aggiornato. Tutto qui → {url}',
    ],
    copy: 'Copia link',
    native: 'Condividi…',
    copiedLink: 'Link copiato. Incollalo in una email o un editor e appare la scheda del prodotto.',
    copiedText: (ch) => `Testo copiato. Incollalo in ${ch}.`,
    noClipboard: 'Impossibile copiare il link.',
    nativeFallback: 'Il browser blocca la condivisione: testo copiato.',
    openFailed: (ch) => `Impossibile aprire ${ch}.`,
    unsupported: 'Canale non supportato.',
  },
};

/** Canal → nombre visible en español (fallback). */
const BASE_LABELS: Record<ShareChannel, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  x: 'X',
  facebook: 'Facebook',
  reddit: 'Reddit',
  pinterest: 'Pinterest',
  email: 'A mi correo',
  copy: 'Copiar enlace',
  native: 'Compartir…',
};

/** Idioma actual (LocalStorage → detección de región → español). */
export function getShareLang(): ShareLangCode {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved && saved in LANG_PACKS) return saved as ShareLangCode;
  } catch {
    /* sin LocalStorage */
  }
  return detectShareLang();
}

export function setShareLang(code: ShareLangCode): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, code);
  } catch {
    /* sin LocalStorage */
  }
}

/** Detecta la región del navegador y la mapea a un idioma con plantilla. */
export function detectShareLang(): ShareLangCode {
  // En el servidor (SSR) no hay navegador: Node 21+ expone un `navigator` con el
  // idioma del sistema, que no tiene nada que ver con el del visitante.
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'es';

  const candidates: string[] = [];
  try {
    if (navigator.languages?.length) candidates.push(...navigator.languages);
    if (navigator.language) candidates.push(navigator.language);
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale) candidates.push(locale);
  } catch {
    /* navegadores raros */
  }

  // Priorizar idiomas colectivos de España (ca, eu, gl): un usuario de
  // Catalunya/Euskadi/Galicia con el navegador en castellano suele tener
  // "ca-ES", "eu-ES" o "gl-ES" en navigator.languages aunque no sea el primero.
  const SPAIN_COLLECTIVE = new Set(['ca', 'eu', 'gl']);
  for (const raw of candidates) {
    const code = raw.toLowerCase().split(/[-_]/)[0];
    if (code && SPAIN_COLLECTIVE.has(code) && code in LANG_PACKS) {
      return code as ShareLangCode;
    }
  }

  // Luego el primer idioma que coincida con alguna plantilla.
  for (const raw of candidates) {
    const code = raw.toLowerCase().split(/[-_]/)[0];
    if (code && code in LANG_PACKS) return code as ShareLangCode;
  }
  return 'es';
}

// ---------------------------------------------------------------------------
// Idiomas cooficiales por región (catalán, euskera, gallego)
// ---------------------------------------------------------------------------

/** Idiomas cooficiales con plantilla propia que se ofrecen según la región. */
const REGIONAL_LANGS: ShareLangCode[] = ['ca', 'eu', 'gl'];
const REGION_STORAGE_KEY = 'tradylor_share_region';
/** Región ya resuelta por el servidor: se reutiliza 7 días. */
const REGION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Si el servidor no pudo resolverla, se reintenta pasados 30 min. */
const REGION_RETRY_MS = 30 * 60 * 1000;

function isRegionalLang(code: unknown): code is ShareLangCode {
  return typeof code === 'string' && (REGIONAL_LANGS as string[]).includes(code);
}

interface RegionCache {
  langs: ShareLangCode[];
  resolved: boolean;
  ts: number;
}

function readRegionCache(): RegionCache | null {
  try {
    const raw = localStorage.getItem(REGION_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<RegionCache> | null;
    if (!data || !Array.isArray(data.langs)) return null;
    return {
      langs: data.langs.filter(isRegionalLang),
      resolved: data.resolved === true,
      ts: Number(data.ts) || 0,
    };
  } catch {
    return null; // sin LocalStorage (SSR / modo privado)
  }
}

function writeRegionCache(cache: RegionCache): void {
  try {
    localStorage.setItem(REGION_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* sin LocalStorage */
  }
}

/** Idiomas cooficiales que declara el navegador (ca / eu / gl en cualquier posición). */
function browserRegionalLangs(): ShareLangCode[] {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return [];
  try {
    return [...(navigator.languages ?? []), navigator.language]
      .filter(Boolean)
      .map((raw) => raw.toLowerCase().split(/[-_]/)[0])
      .filter(isRegionalLang);
  } catch {
    return [];
  }
}

/**
 * Pide al servidor los idiomas cooficiales de la región del visitante (IP +
 * cabecera Accept-Language) y los recuerda en LocalStorage. Gracias a esto un
 * usuario de Catalunya con el navegador en castellano también ve "Català".
 * Devuelve los idiomas regionales conocidos (vacío si no hay ninguno).
 */
export async function refreshRegionLangs(): Promise<ShareLangCode[]> {
  if (typeof window === 'undefined') return [];
  const cached = readRegionCache();
  const ttl = cached?.resolved ? REGION_TTL_MS : REGION_RETRY_MS;
  if (cached && Date.now() - cached.ts < ttl) return cached.langs;
  try {
    const res = await fetch('/api/share/region', { headers: { Accept: 'application/json' } });
    if (!res.ok) return cached?.langs ?? [];
    const data = (await res.json()) as { langs?: unknown; resolved?: unknown };
    const langs = (Array.isArray(data.langs) ? data.langs : []).filter(isRegionalLang);
    writeRegionCache({ langs, resolved: data.resolved === true, ts: Date.now() });
    return langs;
  } catch {
    return cached?.langs ?? [];
  }
}

export interface ShareLangOption {
  code: ShareLangCode;
  label: string;
}

/**
 * Opciones del selector, sin duplicados y en este orden: idiomas cooficiales de
 * la región (catalán, euskera, gallego), idioma detectado, español, inglés y,
 * al final, los que se pasen en `extra` (p. ej. el idioma activo de la página).
 *
 * `extra` también admite idiomas regionales ya conocidos (el servidor los
 * deduce de Accept-Language en SSR, donde no existe `navigator`).
 */
export function getShareLangOptions(extra: ShareLangCode[] = []): ShareLangOption[] {
  const detected = detectShareLang();
  const known = new Set<ShareLangCode>([
    ...extra,
    ...(readRegionCache()?.langs ?? []),
    ...browserRegionalLangs(),
  ]);
  const regional = REGIONAL_LANGS.filter((code) => known.has(code));
  const order: ShareLangCode[] = [...regional, detected, 'es', 'en', ...extra];

  const seen = new Set<ShareLangCode>();
  const options: ShareLangOption[] = [];
  for (const code of order) {
    if (!(code in LANG_PACKS) || seen.has(code)) continue;
    seen.add(code);
    options.push({ code, label: LANG_PACKS[code].label });
  }
  return options;
}

export function shareLabel(channel: ShareChannel, lang?: ShareLangCode): string {
  const code = lang ?? getShareLang();
  return CHANNEL_LABELS[code]?.[channel] ?? BASE_LABELS[channel];
}

export function sharePanelTitle(lang?: ShareLangCode): string {
  return LANG_PACKS[lang ?? getShareLang()].panelTitle;
}

/** Texto de la plantilla para un canal en el idioma indicado. */
export function buildShareText(
  channel: ShareChannel,
  input: ShareInput,
  url?: string,
  lang?: ShareLangCode,
): string {
  const link = url ?? buildShareUrl(input.productId, channel);
  const categoria =
    (input.category ?? '').trim() ||
    ({ ca: 'aquest producte', eu: 'produktu hau', gl: 'este produto' } as Partial<
      Record<ShareLangCode, string>
    >)[lang ?? getShareLang()] ||
    'este producto';
  const titulo = (input.title ?? '').trim() || categoria;
  const pack = LANG_PACKS[lang ?? getShareLang()];
  const group =
    channel === 'whatsapp' || channel === 'telegram' || channel === 'email'
      ? pack.dm
      : channel === 'x'
        ? (pack.x ?? pack.threads)
        : channel === 'reddit'
          ? (pack.reddit ?? pack.threads)
          : channel === 'facebook'
            ? (pack.facebook ?? pack.threads)
            : pack.visual;
  const template = group[Math.floor(Math.random() * group.length)] ?? group[0] ?? '';
  return template
    .replace(/\{categoria\}/g, categoria)
    .replace(/\{titulo\}/g, titulo)
    .replace(/\{url\}/g, link);
}

/**
 * Abre una URL SIEMPRE en pestaña/ventana nueva (target=_blank). Se hace con
 * un <a> efímero: window.open se bloquea con más frecuencia desde un handler
 * asíncrono y el fallback por location.href navegaría fuera de la web.
 */
function openBlank(href: string): boolean {
  try {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Datos públicos de la ficha para la tarjeta que se copia en "Copiar enlace". */
async function fetchShareCard(productId: string): Promise<ShareCardInfo | null> {
  try {
    const res = await fetch(`/api/share/card?productId=${encodeURIComponent(productId)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<ShareCardInfo> | null;
    if (!data || typeof data.url !== 'string' || typeof data.title !== 'string') return null;
    return {
      title: data.title,
      category: typeof data.category === 'string' ? data.category : undefined,
      image: typeof data.image === 'string' ? data.image : '',
      url: data.url,
      pros: Array.isArray(data.pros)
        ? data.pros.filter((pros): pros is string => typeof pros === 'string' && pros.trim() !== '').slice(0, 3)
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Ficha visual del producto en HTML con estilos inline: imagen, categoría,
 * título, algunas ventajas y botón a la ficha. Al pegarla en un correo o en
 * cualquier editor que admita HTML se ve como una tarjeta de producto.
 */
export function buildShareCardHtml(card: ShareCardInfo, ctaLabel: string): string {
  const title = escapeHtml(card.title);
  const category = escapeHtml((card.category ?? '').trim() || 'Tradylor');
  const image = escapeHtml(card.image);
  const url = escapeHtml(card.url);
  const cta = escapeHtml(ctaLabel);
  const pros = card.pros
    .map((pros) => `<li style="margin:0 0 4px;">${escapeHtml(pros)}</li>`)
    .join('');

  return [
    `<a href="${url}" style="display:block;max-width:420px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;text-decoration:none;color:#111827;font-family:Inter,Arial,Helvetica,sans-serif;">`,
    card.image
      ? `<img src="${image}" alt="${title}" width="420" style="display:block;width:100%;height:200px;object-fit:contain;background:#f8fafc;padding:8px;box-sizing:border-box;" />`
      : '',
    `<div style="padding:14px 18px 18px;">`,
    `<p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#2563eb;">${category}</p>`,
    `<p style="margin:0 0 10px;font-size:16px;font-weight:800;line-height:1.35;color:#111827;">${title}</p>`,
    pros ? `<ul style="margin:0 0 14px;padding:0 0 0 18px;font-size:14px;line-height:1.55;color:#374151;">${pros}</ul>` : '',
    `<span style="display:inline-block;background:#2563eb;color:#ffffff;font-size:14px;font-weight:700;padding:10px 18px;border-radius:10px;">${cta}</span>`,
    `</div></a>`,
  ].join('');
}

/**
 * Copia la ficha como HTML (tarjeta visible al pegarla en Gmail, WordPress,
 * un editor…) y, como texto plano, sólo el enlace (para pegados sin formato).
 * Devuelve false si el navegador no soporta portapapeles enriquecido.
 */
async function copyRichCard(html: string, plain: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return true;
    }
  } catch {
    /* fallback: sólo el enlace */
  }
  return false;
}

/**
 * Ejecuta el compartir en el canal indicado (siempre en target=_blank).
 * Devuelve cómo terminó para que la UI muestre el toast adecuado.
 */
export async function shareTo(channel: ShareChannel, input: ShareInput): Promise<ShareResult> {
  const lang = getShareLang();
  const pack = LANG_PACKS[lang];
  const link = buildShareUrl(input.productId, channel);
  const text = buildShareText(channel, input, link, lang);
  const title =
    input.title ||
    ({ ca: 'Un producte a Tradylor', eu: 'Produktu bat Tradylor-en', gl: 'Un produto en Tradylor' } as Partial<
      Record<ShareLangCode, string>
    >)[lang] ||
    'Un producto en Tradylor';
  const name = shareLabel(channel, lang);

  switch (channel) {
    case 'whatsapp':
      return openBlank(`https://wa.me/?text=${encodeURIComponent(text)}`)
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: pack.openFailed(name) };

    case 'telegram':
      return openBlank(
        `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
          text.replace(link, '').trim(),
        )}`,
      )
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: pack.openFailed(name) };

    case 'x':
      return openBlank(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`)
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: pack.openFailed(name) };

    case 'facebook':
      return openBlank(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`)
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: pack.openFailed(name) };

    case 'reddit': {
      // Reddit: el campo "title" va en la URL; el cuerpo se copia al
      // portapapeles para que el usuario lo pegue en el formulario.
      const categoria =
        (input.category ?? '').trim() ||
        ({ ca: 'aquest producte', eu: 'produktu hau', gl: 'este produto' } as Partial<
          Record<ShareLangCode, string>
        >)[lang] ||
        'este producto';
      const redditTitleRaw =
        (pack.redditTitle ?? '¿Qué opináis de esta opción calidad-precio para {categoria}?')
          .replace(/\{categoria\}/g, categoria)
          .replace(/\{titulo\}/g, input.title || title);
      const bodyCopied = await copyText(text);
      return openBlank(
        `https://www.reddit.com/submit?url=${encodeURIComponent(link)}&title=${encodeURIComponent(
          redditTitleRaw,
        )}`,
      )
        ? {
            ok: true,
            mode: 'opened',
            message: bodyCopied ? pack.copiedText(name) : pack.noClipboard,
          }
        : { ok: false, mode: 'opened', message: pack.openFailed(name) };
    }

    case 'pinterest':
      return openBlank(
        `https://www.pinterest.com/pin/create/button/?url=${encodeURIComponent(link)}&description=${encodeURIComponent(
          text,
        )}`,
      )
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: pack.openFailed(name) };

    case 'email': {
      // "A mi correo": abrimos la tarjeta del producto (/share/<id>: mensaje + título +
      // imagen + botón a la ficha) EN LA MISMA PESTAÑA (sin target=_blank). Allí un solo
      // botón envía la tarjeta al correo de la cuenta del usuario, y desde su bandeja la
      // reenvía a quien quiera. El lang va como query param porque la página es SSR y no
      // puede leer localStorage en el servidor.
      try {
        window.location.assign(`/share/${encodeURIComponent(input.productId)}?lang=${lang}`);
        return { ok: true, mode: 'opened' };
      } catch {
        // Sin navegación posible: al menos abrimos el correo con el texto plano.
        return openBlank(`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`)
          ? { ok: true, mode: 'opened' }
          : { ok: false, mode: 'opened', message: pack.openFailed(name) };
      }
    }

    case 'copy': {
      // Copia una ficha visual del producto en HTML (imagen, categoría, ventajas
      // y botón a la ficha): al pegarla en un correo o editor que admita HTML se
      // ve como tarjeta. El texto plano del portapapeles sólo lleva el enlace
      // (para los pegados sin formato). Si el navegador no soporta el portapapeles
      // enriquecido o falla la ficha, se copia sólo el enlace.
      const card = await fetchShareCard(input.productId);
      if (card) {
        const ctaLabel = (SHARE_EMAIL_LABELS[lang] ?? SHARE_EMAIL_LABELS.es).cta;
        const html = buildShareCardHtml(card, ctaLabel);
        if (await copyRichCard(html, link)) {
          return { ok: true, mode: 'copied', message: pack.copiedLink };
        }
      }
      const copied = await copyText(link);
      return copied
        ? { ok: true, mode: 'copied', message: pack.copiedLink }
        : { ok: false, mode: 'copied', message: pack.noClipboard };
    }

    case 'native': {
      const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
      if (nav.share) {
        try {
          await nav.share({ title, text: text.replace(link, '').trim(), url: link });
          return { ok: true, mode: 'native' };
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return { ok: true, mode: 'native' };
          }
        }
      }
      const copied = await copyText(text);
      return copied
        ? { ok: true, mode: 'copied', message: pack.nativeFallback }
        : { ok: false, mode: 'copied', message: pack.noClipboard };
    }

    default:
      return { ok: false, mode: 'copied', message: pack.unsupported };
  }
}

/**
 * URL de la ficha individual del producto en tradylor.com: https://tradylor.com/producto/<slug>.
 * Es el enlace que llevan todos los canales de compartir (copiar enlace, WhatsApp, la tarjeta
 * del correo…): directo a la ficha, sin el salto por /p/<id> y sin parámetros UTM (nada en la
 * web los lee). `productKey` es la clave de ruta canónica del producto (slug, o id si no hay).
 */
export function buildProductPageUrl(productKey: string): string {
  return `${ORIGIN}/producto/${encodeURIComponent(String(productKey ?? '').trim())}`;
}

/** Enlace que se comparte en el canal indicado: siempre la ficha del producto (el canal ya no cambia la URL). */
export function buildShareUrl(productId: string, _channel?: ShareChannel): string {
  return buildProductPageUrl(productId);
}

/** Etiqueta de canal en español (compat con la UI existente). */
export const SHARE_LABELS: Record<ShareChannel, string> = BASE_LABELS;
