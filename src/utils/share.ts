/**
 * ==============================================================================
 * TRADYLOR — COMPARTIR DESDE MI RADAR (marketing indirecto)
 * ==============================================================================
 * Plantillas de texto + envío a cada red. Todo lo que sale de aquí apunta al
 * enlace corto /p/<id> con UTM para medir el tráfico social indirecto.
 *
 * Tono: recomendación de persona a persona, jamás "compra en mi enlace".
 *
 * IDIOMAS: el texto se traduce según el idioma elegido en el panel. El
 * catalán, euskera y gallego se detectan automáticamente si aparecen en la
 * lista de idiomas del navegador (aunque no sean el primero), lo que cubre a
 * usuarios de Catalunya, Euskadi o Galicia con el navegador en castellano.
 * La elección se recuerda en LocalStorage.
 * ==============================================================================
 */

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
  es: {},
  ca: { copy: "Copia l'enllaç", native: 'Comparteix…' },
  eu: { copy: 'Kopiatu esteka', native: 'Partekatu…' },
  gl: { copy: 'Copiar ligazón', native: 'Compartir…' },
  en: { copy: 'Copy link', native: 'Share…' },
  fr: { copy: 'Copier le lien', native: 'Partager…' },
  de: { copy: 'Link kopieren', native: 'Teilen…' },
  pt: { copy: 'Copiar link', native: 'Compartilhar…' },
  it: { copy: 'Copia link', native: 'Condividi…' },
};

const LANG_PACKS: Record<ShareLangCode, LangPack> = {
  es: {
    label: 'Español',
    panelTitle: 'Compartir producto',
    dm: [
      'Oye por si te sirve, estuve usando esta web para buscar y comparar precios de esto y me ha parecido un hallazgo. Calidad-precio está de lujo! {url}',
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
    copiedLink: 'Enlace copiado al portapapeles.',
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
      "Oi, estava donant un cop d'ull a això i, després de comparar una bona estona a Tradylor.com, és clarament la millor opció qualitat-preu de la categoria. Aquí tens la fitxa amb l'anàlisi i el gràfic de preus: {url}",
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
    copiedLink: 'Enllaç copiat al porta-retalls.',
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
      'Aurkitu dut hau begiratzen ari nintzela eta, Tradylor.com-en denbora ona eman ondoren, kategoriako kalitate-preziorik onena da argi. Hemen duzu fitxa, azterketa eta prezio-grafikoarekin: {url}',
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
    copiedLink: 'Esteka arakatzailera kopiatu da.',
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
      'Ola, estaba a botarlle unha ollada a isto e, despois de comparar un bo rato en Tradylor.com, é claramente a mellor opción calidade-prezo da categoría. Aquí tes a ficha coa análise e o gráfico de prezos: {url}',
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
    copiedLink: 'Ligazón copiada ao portapapeis.',
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
      "Hey, I was having a look at this and after comparing for a good while on Tradylor.com, it's clearly the best value for money in its category. Here's the sheet with the analysis and the price chart: {url}",
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
    copiedLink: 'Link copied to clipboard.',
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
      "Salut, je regardais ça et après avoir bien comparé sur Tradylor.com, c'est clairement le meilleur rapport qualité-prix de la catégorie. Voici la fiche avec l'analyse et le graphique des prix : {url}",
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
    copiedLink: 'Lien copié dans le presse-papiers.',
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
      'Hey, ich habe mir das mal angeschaut und nach dem Vergleich auf Tradylor.com ist es klar das Preis-Leistungs-Top der Kategorie. Hier das Datenblatt mit Analyse und Preisverlauf: {url}',
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
    copiedLink: 'Link in die Zwischenablage kopiert.',
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
      'Olha, estava a dar uma vista de olhos nisto e, depois de comparar bastante no Tradylor.com, é de longe a melhor relação qualidade-preço da categoria. Aqui fica a ficha com a análise e o gráfico de preços: {url}',
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
    copiedLink: 'Link copiado para a área de transferência.',
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
      "Ciao, davo un'occhiata a questo e dopo aver confrontato a lungo su Tradylor.com è chiaramente il miglior rapporto qualità-prezzo della categoria. Ecco la scheda con l'analisi e il grafico dei prezzi: {url}",
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
    copiedLink: 'Link copiato negli appunti.',
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
  email: 'Email',
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

/**
 * Opciones del selector: idioma detectado + español (si no es el detectado) +
 * inglés (siempre), sin duplicados y en ese orden.
 */
export function getShareLangOptions(): { code: ShareLangCode; label: string }[] {
  const detected = detectShareLang();
  const order: ShareLangCode[] = [detected, 'es', 'en'];
  const seen = new Set<ShareLangCode>();
  const options: { code: ShareLangCode; label: string }[] = [];
  for (const code of order) {
    if (seen.has(code)) continue;
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

    case 'email':
      // Email: abrimos la página de preview con tarjeta HTML atractiva
      // (imagen + colores + mensaje) que permite copiar el HTML formateado
      // y pegarlo en Gmail/Outlook/Apple Mail, o enviar directamente con
      // el cliente de correo. El lang va como query param porque la página
      // es SSR y no puede leer localStorage en el servidor.
      return openBlank(`/share/${encodeURIComponent(input.productId)}?lang=${lang}`)
        ? { ok: true, mode: 'opened' }
        : openBlank(
            `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`,
          )
          ? { ok: true, mode: 'opened' }
          : { ok: false, mode: 'opened', message: pack.openFailed(name) };

    case 'copy': {
      const copied = await copyText(text);
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

/** Enlace corto con UTM para el canal indicado. */
export function buildShareUrl(productId: string, channel: ShareChannel): string {
  const id = encodeURIComponent(String(productId ?? '').trim());
  const campaign = channel === 'copy' || channel === 'native' ? 'indirect_link' : `indirect_${channel}`;
  return `${ORIGIN}/p/${id}?utm_source=mi_radar&utm_medium=share&utm_campaign=${encodeURIComponent(campaign)}`;
}

/** Etiqueta de canal en español (compat con la UI existente). */
export const SHARE_LABELS: Record<ShareChannel, string> = BASE_LABELS;
