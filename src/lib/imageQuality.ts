export function toHiResImageUrl(url: string | null | undefined): string | undefined {
  if (!url || typeof url !== 'string') return undefined;

  const u = url.trim();
  if (!u) return undefined;

  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase();
    let pathname = parsed.pathname;
    let search = parsed.search;

    // Amazon CDN
    if (
      host.includes('m.media-amazon.com') ||
      host.includes('images-na.ssl-images-amazon.com') ||
      host.includes('images.amazon.com') ||
      (host === 'images-na.ssl-images-amazon.com' && pathname.startsWith('/images/P/'))
    ) {
      // Quitar sufijos de resize: _AC_SX679_, _SL1600_, _SX466_, _UX250_, _AC_, etc.
      // Patrón: ._AC_SX679_.jpg  ._SL1500_.jpg  ._SX466_.jpg  ._UX250_.jpg  ._AC_.jpg
      pathname = pathname.replace(/\._[A-Z]{1,3}[^_]*(_S[XL]\d+)?[^.]*\.(jpg|jpeg|png|webp)$/i, '.$2');
      // Si quedó sin sufijo pero tiene query params de AWS (_), quitar query
      if (search) {
        search = '';
      }
    }

    // AliExpress CDN
    else if (
      host.includes('alicdn.com') ||
      host.includes('ae01.alicdn.com') ||
      host.includes('ae02.alicdn.com') ||
      host.includes('ae03.alicdn.com') ||
      host.includes('ae04.alicdn.com')
    ) {
      // Quitar tamaños: _400x400.jpg, _640x640q90.jpg, _350x350.jpg, _.webp (si no tiene tamaño)
      // Patrón: _NNNxNNN(qNN)?(.ext)  o  _.webp
      pathname = pathname
        .replace(/_\d{2,4}x\d{2,4}(q\d{2})?\.(jpg|jpeg|png|webp)$/i, '.$2')
        .replace(/_(?:webp|webp)\.webp$/i, '.webp')
        .replace(/\.webp\?.*$/, '.webp');
    }

    // eBay CDN
    else if (host.includes('i.ebayimg.com') || host.includes('ir.ebaystatic.com')) {
      // s-l50, s-l64, s-l100, s-l160, s-l200, s-l300, s-l400, s-l500, s-l600, s-l800, s-l1000, s-l1600
      // Forzar s-l1600 (máx estándar)
      pathname = pathname.replace(/\/s-l\d+\//, '/s-l1600/');
      // También ficheros tipo s-l500.jpg
      pathname = pathname.replace(/s-l\d+(\.(jpg|jpeg|png|webp))$/i, 's-l1600$1');
    }

    // Reconstruir
    return `${parsed.protocol}//${parsed.host}${pathname}${search}${parsed.hash}`;
  } catch {
    // Si falla el parsing, devolver original
    return u;
  }
}

/**
 * Nº máximo de imágenes que se conservan en la galería de un producto. Antes
 * de "Construir Catálogo" tenía un tope de 10 que descartaba fotos reales del
 * comercio cuando el cross-matching encontraba variantes en varias redes;
 * ahora se sube para "capturar todas las imágenes del producto" sin dejar de
 * poner un límite razonable frente a datos corruptos.
 */
export const MAX_PRODUCT_IMAGES = 24;

/**
 * Fusiona TODAS las fuentes de imagen de un producto (principal + extra +
 * galería) en una única galería deduplicada, en alta resolución. Antes
 * `extraImages` se calculaba SOLO del parámetro `extraImages` de entrada: los
 * llamantes que sólo rellenaban `gallery` (p. ej. el conector cuando no usa el
 * contrato canónico) perdían TODAS sus imágenes extra en el resultado.
 */
export function upgradeProductImages(product: {
  mainImage?: string;
  extraImages?: string[];
  gallery?: string[];
}): { mainImage?: string; extraImages: string[]; gallery: string[] } {
  const main = toHiResImageUrl(product.mainImage);
  const combined = [...(product.extraImages ?? []), ...(product.gallery ?? [])]
    .map(toHiResImageUrl)
    .filter((u): u is string => Boolean(u));
  const extra = [...new Set(combined.filter((u) => u !== main))];
  // Asegurar que mainImage está en gallery si no está
  const gallery = main ? [main, ...extra] : extra;
  return {
    mainImage: main,
    extraImages: extra.slice(0, MAX_PRODUCT_IMAGES),
    gallery: gallery.slice(0, MAX_PRODUCT_IMAGES),
  };
}