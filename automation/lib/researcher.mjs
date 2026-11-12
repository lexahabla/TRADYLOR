/**
 * Agente INVESTIGADOR COMERCIAL v0 — lógica PURA y determinista (sin IA, sin coste, SOLO LECTURA).
 * Trabaja ÚNICAMENTE con el feed de lectura del catálogo (campos: id, title, description, price, originalPrice, category, merchant, rating,
 * reviewsCount, badge, image…). NO inventa precios, descuentos, valoraciones ni ventas.
 *
 * LIMITACIÓN CONOCIDA de la v0: el feed no incluye observaciones verificadas, stock, subcategoría ni estado del enlace. Por eso
 * un «descuento» aquí es sólo el DECLARADO por la fuente (originalPrice > price) y se marca siempre como NO VERIFICADO.
 */
import { contarPor, euros, mediana, plegar, recortar, precioAnteriorDeclarado } from './common.mjs';
import { leerCatalogo, longitudDescripcion } from './auditor.mjs';

export const VERSION_INVESTIGADOR = '0.2.0';

/** Candidatos a revisar para destacar (no son recomendaciones: son productos que merece la pena mirar). */
export function buscarCandidatos(productos, cfg) {
  const um = cfg.umbrales ?? {};
  const minPct = um.descuentoMinimoCandidato ?? 5;
  const maxPct = um.descuentoMaximoCreible ?? 70;
  const porCat = new Map();
  for (const p of productos) {
    const c = String(p.category ?? '').trim();
    if (c && Number(p.price) > 0) porCat.set(c, [...(porCat.get(c) ?? []), Number(p.price)]);
  }
  const candidatos = [];
  const sospechosos = [];
  for (const p of productos) {
    const precio = Number(p.price);
    const previo = precioAnteriorDeclarado(p);
    if (!(precio > 0) || previo === null || !(previo > precio)) continue;
    if (p.stock === 'out_of_stock') continue; // un producto agotado no es candidato a destacar
    const pct = Math.round(((previo - precio) / previo) * 100);
    if (pct < minPct) continue;
    if (pct > maxPct) {
      sospechosos.push({ id: String(p.id), titulo: recortar(p.title, 100), precio, precioAnteriorDeclarado: previo, descuentoDeclaradoPct: pct, motivo: `Descuento declarado superior al ${maxPct} %: poco creíble` });
      continue;
    }
    const motivos = [`Descuento DECLARADO por la fuente: ${pct} % (${euros(previo)} → ${euros(precio)}); NO verificado`];
    let puntos = Math.min(pct, 50);
    if (longitudDescripcion(p) >= 120) { puntos += 10; motivos.push('Descripción completa'); }
    if (p.image) { puntos += 10; motivos.push('Con imagen'); }
    if (String(p.merchant ?? '').trim()) { puntos += 5; motivos.push(`Comercio: ${p.merchant}`); }
    const med = mediana(porCat.get(String(p.category ?? '').trim()) ?? []);
    if (med && precio < med) motivos.push(`Precio por debajo de la mediana de su categoría (${euros(med)})`);
    candidatos.push({
      id: String(p.id),
      titulo: recortar(p.title, 100),
      categoria: String(p.category ?? ''),
      comercio: String(p.merchant ?? ''),
      precio,
      precioAnteriorDeclarado: previo,
      descuentoDeclaradoPct: pct,
      puntuacion: puntos,
      confianza: 'baja',
      motivos,
      advertencias: ['El descuento es el declarado por la fuente y NO está verificado: no mostrarlo como descuento hasta contrastarlo con una observación verificada.'],
    });
  }
  candidatos.sort((a, b) => b.puntuacion - a.puntuacion || a.id.localeCompare(b.id));
  sospechosos.sort((a, b) => b.descuentoDeclaradoPct - a.descuentoDeclaradoPct || a.id.localeCompare(b.id));
  return { candidatos: candidatos.slice(0, um.maxCandidatos ?? 20), sospechosos: sospechosos.slice(0, 20), totalElegibles: candidatos.length };
}

/** Problemas de calidad accionables, por producto (los más completos primero para arreglar con poco esfuerzo). */
export function problemasCalidad(productos) {
  const lista = [];
  for (const p of productos) {
    const faltan = [];
    if (!p.image) faltan.push('imagen');
    if (longitudDescripcion(p) < 40) faltan.push('descripción');
    if (!String(p.category ?? '').trim()) faltan.push('categoría');
    if (!String(p.merchant ?? '').trim()) faltan.push('comercio');
    if (!(Number(p.price) > 0)) faltan.push('precio');
    if (faltan.length) lista.push({ id: String(p.id), titulo: recortar(p.title, 100), faltan, esfuerzo: faltan.length });
  }
  lista.sort((a, b) => a.esfuerzo - b.esfuerzo || a.id.localeCompare(b.id));
  return { total: lista.length, ejemplos: lista.slice(0, 20) };
}

export function huecosCatalogo(productos, cfg) {
  const minimo = cfg.umbrales?.minProductosPorCategoria ?? 3;
  const cuentas = contarPor(productos.filter((p) => String(p.category ?? '').trim()), (p) => p.category);
  return Object.entries(cuentas).filter(([, n]) => n < minimo).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([categoria, productosEnCategoria]) => ({ categoria, productos: productosEnCategoria }));
}

export function duplicadosProbables(productos) {
  const m = new Map();
  for (const p of productos) {
    const k = plegar(p.title);
    if (k.length >= 12) m.set(k, [...(m.get(k) ?? []), p]);
  }
  return [...m.values()].filter((g) => g.length > 1).map((g) => ({ titulo: recortar(g[0].title, 100), ids: g.map((p) => String(p.id)).sort() })).sort((a, b) => b.ids.length - a.ids.length || a.ids[0].localeCompare(b.ids[0])).slice(0, 20);
}

export function distribucion(productos) {
  const porCategoria = contarPor(productos, (p) => p.category);
  const porComercio = contarPor(productos, (p) => p.merchant);
  const ord = (o) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([nombre, productosN]) => ({ nombre, productos: productosN }));
  return { porCategoria: ord(porCategoria), porComercio: ord(porComercio) };
}

export function informeMarkdownInvestigador(inf) {
  const l = [];
  l.push(`# Investigador comercial — ${inf.entorno} (${inf.generadoEn.slice(0, 16).replace('T', ' ')} UTC)`);
  l.push('');
  l.push(`**Sólo lectura** · versión ${inf.version} · productos analizados: ${inf.resumen.productosAnalizados} de ${inf.resumen.productosTotales ?? '?'}`);
  l.push('');
  l.push(`## Candidatos a revisar (${inf.candidatos.length} de ${inf.resumen.candidatosElegibles})`);
  l.push('> Descuentos **declarados por la fuente, NO verificados**. Son productos que merece la pena mirar, no recomendaciones.');
  for (const c of inf.candidatos) l.push(`- **${c.titulo}** (${c.categoria}) — ${c.descuentoDeclaradoPct} % declarado, ${euros(c.precio)}; puntuación ${c.puntuacion}.`);
  if (!inf.candidatos.length) l.push('- Ninguno con los datos disponibles.');
  l.push('');
  l.push(`## Descuentos poco creíbles (${inf.sospechosos.length})`);
  for (const s of inf.sospechosos.slice(0, 10)) l.push(`- ${s.titulo}: ${s.descuentoDeclaradoPct} % declarado (${euros(s.precioAnteriorDeclarado)} → ${euros(s.precio)}).`);
  l.push('');
  l.push(`## Calidad de fichas: ${inf.calidad.total} con datos que faltan`);
  for (const q of inf.calidad.ejemplos.slice(0, 10)) l.push(`- ${q.titulo}: falta ${q.faltan.join(', ')}.`);
  l.push('');
  l.push(`## Huecos de catálogo (${inf.huecos.length} categorías con pocos productos)`);
  for (const h of inf.huecos.slice(0, 10)) l.push(`- ${h.categoria}: ${h.productos}.`);
  l.push('');
  l.push('## Limitaciones');
  for (const x of inf.limitaciones) l.push(`- ${x}`);
  return l.join('\n');
}

/** Construye el informe del investigador a partir del feed (stateless). */
export function construirInformeInvestigador(entrada) {
  const { cfg, objetivosCatalogo = [], respuestasCatalogo = [], objetivosCatalogoResto = [], respuestasCatalogoResto = [], ahoraIso } = entrada;
  const cat = leerCatalogo([...objetivosCatalogo, ...objetivosCatalogoResto], [...respuestasCatalogo, ...respuestasCatalogoResto]);
  const c = buscarCandidatos(cat.productos, cfg);
  const inf = {
    agente: 'investigador-comercial',
    version: VERSION_INVESTIGADOR,
    entorno: cfg.entorno,
    generadoEn: ahoraIso,
    soloLectura: true,
    resumen: {
      productosAnalizados: cat.productos.length,
      productosTotales: cat.total,
      candidatosElegibles: c.totalElegibles,
      errores: cat.errores,
    },
    candidatos: c.candidatos,
    sospechosos: c.sospechosos,
    calidad: problemasCalidad(cat.productos),
    huecos: huecosCatalogo(cat.productos, cfg),
    duplicados: duplicadosProbables(cat.productos),
    distribucion: distribucion(cat.productos),
    limitaciones: [
      'v0 sin IA ni búsqueda web: sólo reglas deterministas sobre el feed de lectura del catálogo.',
      'El feed no incluye observaciones verificadas, stock, subcategoría ni estado del enlace: los descuentos son DECLARADOS y no verificados.',
      'No se usan valoraciones ni número de reseñas como señal (pueden ser valores por defecto).',
      ...(cat.errores.length ? [`Errores al leer el catálogo: ${cat.errores.join(' · ')}`] : []),
    ],
    markdown: '',
  };
  inf.markdown = informeMarkdownInvestigador(inf);
  return inf;
}
