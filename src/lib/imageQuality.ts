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

export function upgradeProductImages(product: {
  mainImage?: string;
  extraImages?: string[];
  gallery?: string[];
}): { mainImage?: string; extraImages: string[]; gallery: string[] } {
  const main = toHiResImageUrl(product.mainImage);
  const extra = (product.extraImages ?? []).map(toHiResImageUrl).filter((u): u is string => Boolean(u));
  const gallery = (product.gallery ?? []).map(toHiResImageUrl).filter((u): u is string => Boolean(u));
  // Asegurar que mainImage está en gallery si no está
  const allGallery = main ? [main, ...gallery.filter((u) => u !== main)] : gallery;
  return {
    mainImage: main,
    extraImages: extra,
    gallery: allGallery.slice(0, 10),
  };
}