/**
 * ==============================================================================
 * TRADYLOR — IDIOMAS DEL TRADUCTOR DE GOOGLE
 * ==============================================================================
 * Listado de idiomas del traductor de Google (códigos gtx aceptados por
 * https://translate.googleapis.com/translate_a/single?client=gtx). Se usa en
 * el desplegable de la vista previa de /share/<id> para traducir el mensaje
 * de la tarjeta antes de enviarla.
 *
 * Etiquetas en el propio idioma (autónimos), como en el selector de Google.
 * ==============================================================================
 */

export interface TranslateLang {
  /** Código gtx (p. ej. 'es', 'pt-BR', 'zh-CN'). */
  code: string;
  /** Nombre del idioma en el propio idioma. */
  label: string;
}

/**
 * Traduce un texto con el traductor de Google (endpoint público gtx).
 * Se llama desde el navegador (CORS abierto: Access-Control-Allow-Origin: *),
 * así que la petición sale con la IP del usuario y no con la del servidor.
 */
export async function googleTranslateText(text: string, target: string): Promise<string> {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', target);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('translate_unavailable');

  const translated = parseGtxResponse(await res.json().catch(() => null));
  if (!translated) throw new Error('translate_empty');
  return translated;
}

/** Extrae el texto traducido de la respuesta del endpoint gtx (por segmentos). */
export function parseGtxResponse(data: unknown): string {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return '';
  return (data[0] as unknown[])
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
    .join('')
    .trim();
}

export const GOOGLE_TRANSLATE_LANGS: TranslateLang[] = [
  { code: 'af', label: 'Afrikaans' },
  { code: 'sq', label: 'Shqip' },
  { code: 'am', label: 'አማርኛ' },
  { code: 'hy', label: 'Հայերեն' },
  { code: 'ar', label: 'العربية' },
  { code: 'as', label: 'অসমীয়া' },
  { code: 'az', label: 'Azərbaycan' },
  { code: 'eu', label: 'Euskara' },
  { code: 'be', label: 'Беларуская' },
  { code: 'bn', label: 'বাংলা' },
  { code: 'bs', label: 'Bosanski' },
  { code: 'bg', label: 'Български' },
  { code: 'ca', label: 'Català' },
  { code: 'ceb', label: 'Cebuano' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'co', label: 'Corsu' },
  { code: 'hr', label: 'Hrvatski' },
  { code: 'cs', label: 'Čeština' },
  { code: 'da', label: 'Dansk' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'en', label: 'English' },
  { code: 'eo', label: 'Esperanto' },
  { code: 'et', label: 'Eesti' },
  { code: 'fi', label: 'Suomi' },
  { code: 'fr', label: 'Français' },
  { code: 'fy', label: 'Frysk' },
  { code: 'gl', label: 'Galego' },
  { code: 'ka', label: 'ქართული' },
  { code: 'de', label: 'Deutsch' },
  { code: 'el', label: 'Ελληνικά' },
  { code: 'gu', label: 'ગુજરાતી' },
  { code: 'ht', label: 'Kreyòl ayisyen' },
  { code: 'ha', label: 'Hausa' },
  { code: 'haw', label: 'Hawaiʻi' },
  { code: 'he', label: 'עברית' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'hmn', label: 'Hmoob' },
  { code: 'hu', label: 'Magyar' },
  { code: 'is', label: 'Íslenska' },
  { code: 'ig', label: 'Igbo' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'ga', label: 'Gaeilge' },
  { code: 'it', label: 'Italiano' },
  { code: 'ja', label: '日本語' },
  { code: 'jw', label: 'Jawa' },
  { code: 'kn', label: 'ಕನ್ನಡ' },
  { code: 'kk', label: 'Қазақ' },
  { code: 'km', label: 'ភាសាខ្មែរ' },
  { code: 'ko', label: '한국어' },
  { code: 'ku', label: 'Kurdî' },
  { code: 'ky', label: 'Кыргызча' },
  { code: 'lo', label: 'ລາວ' },
  { code: 'la', label: 'Latina' },
  { code: 'lv', label: 'Latviešu' },
  { code: 'lt', label: 'Lietuvių' },
  { code: 'lb', label: 'Lëtzebuergesch' },
  { code: 'mk', label: 'Македонски' },
  { code: 'mg', label: 'Malagasy' },
  { code: 'ml', label: 'മലയാളം' },
  { code: 'mt', label: 'Malti' },
  { code: 'mi', label: 'Māori' },
  { code: 'mr', label: 'मराठी' },
  { code: 'mn', label: 'Монгол' },
  { code: 'my', label: 'မြန်မာ' },
  { code: 'ne', label: 'नेपाली' },
  { code: 'no', label: 'Norsk' },
  { code: 'ny', label: 'Chichewa' },
  { code: 'ps', label: 'پښتو' },
  { code: 'fa', label: 'فارسی' },
  { code: 'pl', label: 'Polski' },
  { code: 'pt', label: 'Português' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ' },
  { code: 'ro', label: 'Română' },
  { code: 'ru', label: 'Русский' },
  { code: 'sm', label: 'Gagana Sāmoa' },
  { code: 'gd', label: 'Gàidhlig' },
  { code: 'sr', label: 'Српски' },
  { code: 'sn', label: 'ChiShona' },
  { code: 'sd', label: 'سنڌی' },
  { code: 'si', label: 'සිංහල' },
  { code: 'sk', label: 'Slovenčina' },
  { code: 'sl', label: 'Slovenščina' },
  { code: 'so', label: 'Soomaali' },
  { code: 'es', label: 'Español' },
  { code: 'su', label: 'Basa Sunda' },
  { code: 'sw', label: 'Kiswahili' },
  { code: 'sv', label: 'Svenska' },
  { code: 'tl', label: 'Wikang Filipino' },
  { code: 'tg', label: 'Тоҷикӣ' },
  { code: 'ta', label: 'தமிழ்' },
  { code: 'te', label: 'తెలుగు' },
  { code: 'th', label: 'ไทย' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'tk', label: 'Türkmen' },
  { code: 'uk', label: 'Українська' },
  { code: 'ur', label: 'اردو' },
  { code: 'ug', label: 'ئۇيغۇرچە' },
  { code: 'uz', label: 'Oʻzbekcha' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'cy', label: 'Cymraeg' },
  { code: 'xh', label: 'isiXhosa' },
  { code: 'yi', label: 'ייִדיש' },
  { code: 'yo', label: 'Yorùbá' },
  { code: 'zu', label: 'isiZulu' },
];
