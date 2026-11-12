/**
 * Agente AUDITOR GENERAL v0 — lógica PURA y determinista (sin IA, sin coste, SOLO LECTURA).
 * Se incrusta en los nodos «Code» del workflow de n8n (sin imports reales; los `import` de abajo los resuelve el constructor).
 * Toda la entrada de red llega ya hecha por los nodos HTTP de n8n; aquí sólo se decide qué pedir y cómo interpretar lo recibido.
 */
import { diasEntre, estadoGlobal, fechaValida, ordenarIncidencias, plegar, recortar, resumenIncidencias } from './common.mjs';
import { RUTA_CATALOGO_AUTOMATIZACION, evaluarUrl, normalizarUrl } from './urlPolicy.mjs';

export const VERSION_AUDITOR = '0.2.0';

const incidencia = (area, codigo, gravedad, titulo, detalle, evidencia, accionSugerida, clave = '') => ({
  id: `${area}:${codigo}${clave ? `:${clave}` : ''}`.slice(0, 200),
  gravedad,
  area,
  titulo,
  detalle,
  evidencia: evidencia ?? {},
  accionSugerida,
});

/**
 * CLASIFICACIÓN (v0.2). `clase` = qué tipo de problema es; `ambito` = de quién es:
 *  · «produccion»     incidencia real del sitio/servicio que se audita (cuenta para el estado).
 *  · «datos»          problema del catálogo/datos auditados (cuenta para el estado).
 *  · «entorno_local»  AVISO que sólo describe el entorno de pruebas (build sin huella, SMTP sin configurar, reinicio reciente, muestra pequeña…):
 *                     se lista aparte y NO cuenta como incidencia ni cambia el estado. En entorno de producción estos mismos hallazgos SÍ son incidencias.
 */
const CLASE_POR_CODIGO = {
  'salud:sin_respuesta': 'disponibilidad', 'salud:http': 'disponibilidad', 'salud:no_json': 'disponibilidad', 'salud:estado': 'disponibilidad', 'salud:sin_volumen': 'integridad_datos',
  'salud:sin_huella': 'configuracion', 'salud:sin_smtp': 'configuracion', 'salud:reinicio_reciente': 'operacion', 'salud:sin_datos': 'disponibilidad',
  'catalogo:feed_no_disponible': 'disponibilidad', 'catalogo:feed_parcial': 'disponibilidad', 'catalogo:vacio': 'integridad_datos', 'catalogo:revision_parcial': 'cobertura',
  'catalogo:ids_duplicados': 'integridad_datos', 'catalogo:sin_precio': 'integridad_datos', 'catalogo:precio_extremo': 'integridad_datos', 'catalogo:precio_anterior_menor': 'integridad_datos',
  'catalogo:descuento_sospechoso': 'honestidad_comercial', 'catalogo:valoracion_por_defecto': 'honestidad_comercial', 'catalogo:imagen_no_segura': 'seguridad', 'catalogo:sin_imagen': 'calidad_datos',
  'catalogo:titulos_repetidos': 'calidad_datos', 'catalogo:sin_categoria': 'calidad_datos', 'catalogo:sin_descripcion': 'calidad_datos', 'catalogo:titulo_largo': 'calidad_datos',
  'catalogo:sin_comercio': 'calidad_datos', 'catalogo:categorias_escasas': 'calidad_datos', 'catalogo:concentracion_comercio': 'calidad_datos',
};
/** Hallazgos que, en el entorno local, describen el entorno y no el sitio real. */
const SOLO_AVISO_LOCAL = new Set(['salud:sin_huella', 'salud:sin_smtp', 'salud:reinicio_reciente', 'catalogo:revision_parcial', 'catalogo:categorias_escasas', 'catalogo:concentracion_comercio']);

export function clasificarIncidencia(inc, cfg) {
  const base = inc.id.split(':').slice(0, 2).join(':');
  let clase = CLASE_POR_CODIGO[base];
  if (!clase) clase = inc.area === 'ruta' || inc.area === 'ficha' ? (/^(ruta|ficha):(sin_titulo|h1|contenido_minimo)/.test(inc.id) ? 'seo_contenido' : 'disponibilidad') : inc.area === 'enlace' ? 'enlaces' : 'calidad_datos';
  const aviso = cfg.entorno === 'local' && SOLO_AVISO_LOCAL.has(base);
  return { ...inc, clase, ambito: aviso ? 'entorno_local' : inc.area === 'catalogo' ? 'datos' : 'produccion' };
}

/** Un objetivo «marcador» garantiza que el nodo HTTP siguiente siempre recibe al menos un elemento (no se analiza). */
const marcador = (cfg) => ({ id: 'marcador', tipo: 'marcador', marcador: true, url: `${cfg.baseUrl.replace(/\/$/, '')}/api/health` });

/* ───────────────────────── Objetivos a pedir ───────────────────────── */

/** Salud + rutas configuradas. Las URL que la política rechaza se omiten y se informan. */
export function planificarRutas(cfg) {
  const objetivos = [];
  const omitidos = [];
  const base = cfg.baseUrl.replace(/\/$/, '');
  const salud = evaluarUrl(`${base}/api/health`, 'salud', cfg);
  if (salud.ok) objetivos.push({ id: 'salud', tipo: 'salud', url: salud.url, etiqueta: '/api/health' });
  else omitidos.push({ etiqueta: '/api/health', motivo: salud.motivo });
  for (const r of cfg.rutas) {
    const e = evaluarUrl(`${base}${r}`, 'ruta', cfg);
    if (e.ok) objetivos.push({ id: `ruta:${r}`, tipo: 'ruta', url: e.url, etiqueta: r });
    else omitidos.push({ etiqueta: r, motivo: e.motivo });
  }
  return { objetivos, omitidos };
}
export function crearObjetivosRutas(cfg) {
  const { objetivos } = planificarRutas(cfg);
  return objetivos.length ? objetivos : [marcador(cfg)];
}

/** Respuestas con datos (descarta los elementos vacíos y los marcadores). */
export function emparejar(objetivos, respuestas) {
  const out = [];
  for (let i = 0; i < objetivos.length; i++) {
    const t = objetivos[i];
    const r = respuestas[i] ?? {};
    if (!t || t.marcador) continue;
    if (r.statusCode === undefined && !r.error) continue;
    out.push({ t, r });
  }
  return out;
}

// El nodo HTTP Request de n8n (con «respuesta completa» y formato texto) entrega el cuerpo en `data`; el simulador lo entrega en `body`.
const cuerpoTexto = (r) => (typeof r.data === 'string' ? r.data : typeof r.body === 'string' ? r.body : '');
const errorTexto = (r) => (r.error ? recortar(typeof r.error === 'string' ? r.error : r.error.message ?? JSON.stringify(r.error), 200) : '');
const esHtml = (r) => /html/i.test(String((r.headers ?? {})['content-type'] ?? '')) || /<html|<!doctype/i.test(cuerpoTexto(r).slice(0, 400));

/** Enlaces <a href> de una página, como URL absolutas (sin fragmento). */
export function extraerEnlaces(html, baseUrl) {
  const out = [];
  // Se ignoran <script>, <style> y comentarios: contienen plantillas JS (`${…}`) que no son enlaces reales.
  const limpio = String(html ?? '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  for (const m of limpio.matchAll(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const crudo = (m[1] ?? m[2] ?? '').replace(/&amp;/g, '&').trim();
    if (!crudo || crudo.includes('${') || crudo.includes('{{') || crudo.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(crudo)) continue;
    const u = normalizarUrl(crudo, baseUrl);
    if (u) out.push(u.toString());
  }
  return out;
}

/** Enlaces internos de las páginas revisadas que la política permite pedir (máx. `maxEnlaces`, orden estable). */
export function crearObjetivosEnlaces(objetivos, respuestas, cfg) {
  const yaPedidos = new Set(objetivos.filter((t) => !t.marcador).map((t) => t.url));
  const vistos = new Map();
  for (const { t, r } of emparejar(objetivos, respuestas)) {
    if (t.tipo !== 'ruta' || r.statusCode !== 200 || !esHtml(r)) continue;
    for (const href of extraerEnlaces(cuerpoTexto(r), t.url)) {
      const e = evaluarUrl(href, 'enlace', cfg);
      if (!e.ok || yaPedidos.has(e.url) || vistos.has(e.url)) continue;
      vistos.set(e.url, t.etiqueta);
    }
  }
  const lista = [...vistos.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, cfg.maxEnlaces);
  const objetivosEnlaces = lista.map(([url, origen]) => ({ id: `enlace:${url}`, tipo: 'enlace', url, origen }));
  return objetivosEnlaces.length ? objetivosEnlaces : [marcador(cfg)];
}

const urlCatalogo = (cfg, pagina) => evaluarUrl(`${cfg.baseUrl.replace(/\/$/, '')}${RUTA_CATALOGO_AUTOMATIZACION}?limit=${cfg.limitePorPagina}&page=${pagina}`, 'catalogo', cfg);

/** Primera página del feed del catálogo (sólo modo completo). Las demás sólo se piden si hacen falta: ver `crearObjetivosCatalogoResto`. */
export function crearObjetivosCatalogo(cfg) {
  const out = [];
  if (cfg.modo === 'completo' && cfg.maxPaginasCatalogo >= 1) {
    const e = urlCatalogo(cfg, 1);
    if (e.ok) out.push({ id: 'catalogo:1', tipo: 'catalogo', url: e.url, pagina: 1 });
  }
  return out.length ? out : [marcador(cfg)];
}

/** Páginas 2..N del feed, SÓLO las que existen (según `totalPages` de la primera respuesta) y con el tope `maxPaginasCatalogo`. */
export function crearObjetivosCatalogoResto(objetivos, respuestas, cfg) {
  const primera = leerCatalogo(objetivos, respuestas);
  const out = [];
  if (cfg.modo === 'completo' && Number.isInteger(primera.totalPaginas)) {
    for (let p = 2; p <= Math.min(primera.totalPaginas, cfg.maxPaginasCatalogo); p++) {
      const e = urlCatalogo(cfg, p);
      if (e.ok) out.push({ id: `catalogo:${p}`, tipo: 'catalogo', url: e.url, pagina: p });
    }
  }
  return out.length ? out : [marcador(cfg)];
}

/** Interpreta las páginas del feed. */
export function leerCatalogo(objetivos, respuestas) {
  const productos = [];
  const errores = [];
  let total = null;
  let totalPaginas = null;
  for (const { t, r } of emparejar(objetivos, respuestas)) {
    if (t.tipo !== 'catalogo') continue;
    if (r.error || r.statusCode !== 200) {
      errores.push(`página ${t.pagina}: ${r.error ? errorTexto(r) : `HTTP ${r.statusCode}`}`);
      continue;
    }
    try {
      const j = JSON.parse(cuerpoTexto(r));
      if (!Array.isArray(j.products)) throw new Error('sin lista de productos');
      productos.push(...j.products);
      if (Number.isInteger(j.total)) total = j.total;
      if (Number.isInteger(j.totalPages)) totalPaginas = j.totalPages;
    } catch (e) {
      errores.push(`página ${t.pagina}: respuesta no válida (${recortar(e.message, 80)})`);
    }
  }
  return { productos, total, totalPaginas, errores };
}

/** Fichas de muestra (sólo modo completo, instancia local): orden estable por id. */
export function crearObjetivosFichas(productos, cfg) {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const out = [];
  if (cfg.modo === 'completo') {
    const ids = [...new Set(productos.map((p) => String(p.id ?? '')).filter(Boolean))].sort().slice(0, cfg.maxFichas);
    for (const id of ids) {
      const e = evaluarUrl(`${base}/producto/${id}`, 'ficha', cfg);
      if (e.ok) out.push({ id: `ficha:${id}`, tipo: 'ficha', url: e.url, productoId: id });
    }
  }
  return out.length ? out : [marcador(cfg)];
}

/* ───────────────────────── Análisis ───────────────────────── */

export function analizarSalud(objetivos, respuestas) {
  const inc = [];
  const par = emparejar(objetivos, respuestas).find((x) => x.t.tipo === 'salud');
  let datos = null;
  if (!par) {
    inc.push(incidencia('salud', 'sin_datos', 'critica', 'No se pudo comprobar la salud del servidor', 'No hay respuesta de /api/health.', {}, 'Comprobar que el servidor está en marcha y que el agente llega a él.'));
    return { incidencias: inc, datos };
  }
  const { r } = par;
  if (r.error) inc.push(incidencia('salud', 'sin_respuesta', 'critica', 'El servidor no responde', errorTexto(r), {}, 'Comprobar el contenedor y la red.'));
  else if (r.statusCode !== 200) inc.push(incidencia('salud', 'http', 'critica', `/api/health devuelve HTTP ${r.statusCode}`, 'El healthcheck no es correcto.', { statusCode: r.statusCode }, 'Revisar los registros del servicio.'));
  else {
    try {
      datos = JSON.parse(cuerpoTexto(r));
    } catch {
      inc.push(incidencia('salud', 'no_json', 'alta', '/api/health no devuelve JSON válido', 'La respuesta no se puede interpretar.', {}, 'Revisar el servicio.'));
    }
  }
  if (datos) {
    if (datos.status !== 'ok') inc.push(incidencia('salud', 'estado', 'critica', `Estado de salud: ${datos.status}`, 'El servicio no declara «ok».', { status: datos.status }, 'Revisar registros.'));
    if (datos.dataDirExists === false) inc.push(incidencia('salud', 'sin_volumen', 'critica', 'No existe el directorio de datos', 'El volumen persistente no está disponible.', {}, 'Revisar el volumen del servicio.'));
    if (!datos.sourceHash) inc.push(incidencia('salud', 'sin_huella', 'media', 'El despliegue no declara su huella de código (sourceHash)', 'No se puede comprobar qué código se está ejecutando.', {}, 'Revisar el build.'));
    if (Number.isFinite(datos.uptimeSeconds) && datos.uptimeSeconds < 300) inc.push(incidencia('salud', 'reinicio_reciente', 'info', 'El servicio se reinició hace menos de 5 minutos', `Tiempo de actividad: ${datos.uptimeSeconds} s.`, { uptimeSeconds: datos.uptimeSeconds }, 'Comprobar si fue un despliegue previsto.'));
    if (datos.env && datos.env.smtp === false) inc.push(incidencia('salud', 'sin_smtp', 'baja', 'El correo (SMTP) no está configurado', 'Los correos de la plataforma no se enviarán por SMTP.', {}, 'Revisar la configuración si se esperan correos.'));
  }
  return { incidencias: inc, datos };
}

function analizarPagina(par, area) {
  const { t, r } = par;
  const inc = [];
  const ev = { url: t.url, statusCode: r.statusCode ?? null };
  const clave = t.etiqueta ?? t.productoId ?? t.url;
  if (r.error) {
    inc.push(incidencia(area, 'sin_respuesta', area === 'ruta' ? 'critica' : 'alta', `Sin respuesta: ${clave}`, errorTexto(r), ev, 'Comprobar la ruta y el servidor.', clave));
    return inc;
  }
  if (r.statusCode >= 500) inc.push(incidencia(area, 'error_servidor', 'critica', `Error ${r.statusCode} en ${clave}`, 'El servidor devuelve un error.', ev, 'Revisar registros.', clave));
  else if (r.statusCode === 404 || r.statusCode === 410) inc.push(incidencia(area, 'no_encontrada', 'alta', `No existe: ${clave}`, `HTTP ${r.statusCode}.`, ev, 'Corregir el enlace o restaurar la página.', clave));
  else if (r.statusCode >= 400) inc.push(incidencia(area, 'error_cliente', 'media', `HTTP ${r.statusCode} en ${clave}`, 'La página no es accesible para un visitante anónimo.', ev, 'Revisar si es esperado.', clave));
  else if (r.statusCode === 200) {
    const cuerpo = cuerpoTexto(r);
    if (/internal server error/i.test(cuerpo)) inc.push(incidencia(area, 'error_interno_200', 'critica', `Error interno oculto tras un 200 en ${clave}`, 'La página devuelve 200 pero contiene «Internal server error».', ev, 'Revisar registros y el componente que falla.', clave));
    if (esHtml(r)) {
      if (!/<title>[^<]{2,}<\/title>/i.test(cuerpo)) inc.push(incidencia(area, 'sin_titulo', 'media', `Sin <title> en ${clave}`, 'Falta el título de la página (SEO).', ev, 'Añadir título.', clave));
      const h1 = (cuerpo.match(/<h1[\s>]/gi) ?? []).length;
      if (h1 !== 1) inc.push(incidencia(area, 'h1', 'baja', `${h1 === 0 ? 'Sin' : 'Varios'} <h1> en ${clave}`, `Hay ${h1} elementos h1.`, { ...ev, h1 }, 'Dejar un único h1.', clave));
      if (cuerpo.length < 2000) inc.push(incidencia(area, 'contenido_minimo', 'media', `Contenido muy corto en ${clave}`, `Sólo ${cuerpo.length} caracteres.`, { ...ev, caracteres: cuerpo.length }, 'Comprobar que la página se genera completa.', clave));
    }
  }
  return inc;
}

export function analizarRutas(objetivos, respuestas) {
  const inc = [];
  let revisadas = 0;
  for (const par of emparejar(objetivos, respuestas)) {
    if (par.t.tipo !== 'ruta') continue;
    revisadas++;
    inc.push(...analizarPagina(par, 'ruta'));
  }
  return { incidencias: inc, revisadas };
}

export function analizarEnlaces(objetivos, respuestas) {
  const inc = [];
  let revisados = 0;
  for (const { t, r } of emparejar(objetivos, respuestas)) {
    if (t.tipo !== 'enlace') continue;
    revisados++;
    const ev = { url: t.url, origen: t.origen, statusCode: r.statusCode ?? null };
    if (r.error) inc.push(incidencia('enlace', 'sin_respuesta', 'media', `Enlace sin respuesta: ${t.url}`, errorTexto(r), ev, 'Comprobar el destino.', t.url));
    else if (r.statusCode >= 400) inc.push(incidencia('enlace', 'roto', 'alta', `Enlace interno roto: ${t.url}`, `HTTP ${r.statusCode}; aparece en ${t.origen}.`, ev, 'Corregir o retirar el enlace.', t.url));
  }
  return { incidencias: inc, revisados };
}

export function analizarFichas(objetivos, respuestas) {
  const inc = [];
  let revisadas = 0;
  for (const par of emparejar(objetivos, respuestas)) {
    if (par.t.tipo !== 'ficha') continue;
    revisadas++;
    inc.push(...analizarPagina(par, 'ficha'));
  }
  return { incidencias: inc, revisadas };
}

const imagenAceptable = (u) => typeof u === 'string' && (/^https:\/\//i.test(u) || /^\/[^/]/.test(u));

/** Integridad básica del catálogo a partir del feed de lectura. Agrupa por código (un aviso por problema, con ejemplos). */
export function analizarCatalogo(catalogo, cfg, ahoraIso) {
  const inc = [];
  const { productos, total, errores } = catalogo;
  const um = cfg.umbrales ?? {};
  const grupo = (codigo, gravedad, titulo, detalle, ids, accion) => {
    if (!ids.length) return;
    inc.push(incidencia('catalogo', codigo, gravedad, `${titulo} (${ids.length})`, detalle, { total: ids.length, ejemplos: ids.slice(0, 10) }, accion));
  };
  if (errores.length && !productos.length) {
    inc.push(incidencia('catalogo', 'feed_no_disponible', 'alta', 'No se pudo leer el catálogo', errores.join(' · '), { errores }, 'Comprobar el token de lectura de la instancia y la URL.'));
    return inc;
  }
  if (errores.length) inc.push(incidencia('catalogo', 'feed_parcial', 'media', 'Algunas páginas del catálogo no se pudieron leer', errores.join(' · '), { errores }, 'Repetir la ejecución y revisar el servicio.'));
  if (!productos.length) {
    inc.push(incidencia('catalogo', 'vacio', 'alta', 'El catálogo está vacío', 'El feed no devuelve productos.', { total }, 'Comprobar el volumen de datos.'));
    return inc;
  }
  if (Number.isInteger(total) && total > productos.length) inc.push(incidencia('catalogo', 'revision_parcial', 'info', `Se revisaron ${productos.length} de ${total} productos`, 'El límite de páginas del agente impide revisar todo el catálogo.', { revisados: productos.length, total }, 'Subir maxPaginasCatalogo si se desea una revisión completa.'));

  const porId = new Map();
  const dup = [];
  for (const p of productos) {
    const id = String(p.id ?? '');
    if (porId.has(id)) dup.push(id);
    porId.set(id, p);
  }
  grupo('ids_duplicados', 'alta', 'Identificadores repetidos', 'Dos productos comparten identificador.', [...new Set(dup)], 'Revisar el origen de la importación.');

  const porTitulo = new Map();
  for (const p of productos) {
    const k = plegar(p.title);
    if (k.length >= 12) porTitulo.set(k, [...(porTitulo.get(k) ?? []), String(p.id)]);
  }
  const titulosRepetidos = [...porTitulo.values()].filter((v) => v.length > 1).map((v) => v.slice(0, 3).join(' = '));
  grupo('titulos_repetidos', 'media', 'Títulos idénticos en productos distintos', 'Posibles duplicados (mismo título normalizado).', titulosRepetidos, 'Revisar si es el mismo anuncio con otro vendedor o un duplicado.');

  const idsDe = (fn) => productos.filter(fn).map((p) => String(p.id));
  const precio = (p) => Number(p.price);
  grupo('sin_precio', 'alta', 'Productos sin precio utilizable', 'Precio ausente, cero o negativo.', idsDe((p) => !(precio(p) > 0)), 'Retirar o corregir la ficha.');
  grupo('precio_extremo', 'media', 'Precios extremadamente altos', 'Precio superior a 100.000 €.', idsDe((p) => precio(p) > 100000), 'Comprobar el dato de origen.');
  grupo('precio_anterior_menor', 'media', 'Precio anterior inferior al actual', 'originalPrice < price: el descuento declarado no tiene sentido.', idsDe((p) => p.originalPrice != null && Number(p.originalPrice) > 0 && Number(p.originalPrice) < precio(p)), 'Revisar el precio anterior.');
  grupo('descuento_sospechoso', 'media', 'Descuentos declarados superiores al 80 %', 'Precio anterior más de 5 veces el actual (dato declarado, no verificado).', idsDe((p) => precio(p) > 0 && Number(p.originalPrice) > precio(p) * 5), 'No mostrar como descuento sin verificación.');
  grupo('sin_imagen', 'media', 'Productos sin imagen', 'Falta la imagen principal.', idsDe((p) => !p.image), 'Añadir imagen.');
  grupo('imagen_no_segura', 'media', 'Imágenes con dirección no admisible', 'La imagen no es https ni una ruta propia.', idsDe((p) => p.image && !imagenAceptable(p.image)), 'Corregir la URL de la imagen.');
  grupo('sin_categoria', 'media', 'Productos sin categoría', 'Falta la categoría.', idsDe((p) => !String(p.category ?? '').trim()), 'Asignar categoría.');
  grupo('sin_descripcion', 'baja', 'Descripción ausente o muy corta', 'Menos de 40 caracteres.', idsDe((p) => longitudDescripcion(p) < 40), 'Completar la ficha.');
  grupo('titulo_largo', 'baja', 'Títulos de más de 120 caracteres', 'Títulos difíciles de leer.', idsDe((p) => String(p.title ?? '').length > 120), 'Acortar el título.');
  grupo('sin_comercio', 'baja', 'Productos sin comercio', 'Falta el nombre del comercio.', idsDe((p) => !String(p.merchant ?? '').trim()), 'Completar el comercio.');
  grupo('valoracion_por_defecto', 'info', 'Valoración «4,8 / 100 reseñas» (valor por defecto)', 'No es una valoración real; no debe presentarse como tal.', idsDe((p) => p.ratingFlag === 'por_defecto' || (Number(p.rating) === 4.8 && Number(p.reviewsCount) === 100)), 'Ocultar o sustituir por dato real.');

  const porCat = new Map();
  for (const p of productos) {
    const c = String(p.category ?? '').trim();
    if (c) porCat.set(c, (porCat.get(c) ?? 0) + 1);
  }
  const escasas = [...porCat.entries()].filter(([, n]) => n < (um.minProductosPorCategoria ?? 3)).map(([c, n]) => `${c} (${n})`).sort();
  grupo('categorias_escasas', 'baja', 'Categorías con muy pocos productos', `Menos de ${um.minProductosPorCategoria ?? 3} productos.`, escasas, 'Ampliar o fusionar la categoría.');

  const porComercio = new Map();
  for (const p of productos) porComercio.set(String(p.merchant ?? '—'), (porComercio.get(String(p.merchant ?? '—')) ?? 0) + 1);
  const [topComercio, topN] = [...porComercio.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['—', 0];
  if (productos.length >= 10 && topN / productos.length > (um.maxConcentracionComercio ?? 0.8)) {
    inc.push(incidencia('catalogo', 'concentracion_comercio', 'baja', `El ${Math.round((topN / productos.length) * 100)} % del catálogo es de ${topComercio}`, 'Dependencia de un único comercio.', { comercio: topComercio, productos: topN, total: productos.length }, 'Diversificar fuentes.'));
  }
  void ahoraIso;
  void diasEntre;
  void fechaValida;
  return inc;
}

/* ───────────────────────── Informe ───────────────────────── */

/** El feed de automatización entrega sólo la longitud de la descripción (dato estrictamente necesario); el feed antiguo, el texto. */
export const longitudDescripcion = (p) => (Number.isFinite(Number(p.descriptionLength)) ? Number(p.descriptionLength) : String(p.description ?? '').trim().length);

const ETIQUETA_GRAVEDAD = { critica: 'Crítica', alta: 'Alta', media: 'Media', baja: 'Baja', info: 'Información' };

export function informeMarkdown(informe) {
  const l = [];
  l.push(`# Auditor General — ${informe.entorno} (${informe.generadoEn.slice(0, 16).replace('T', ' ')} UTC)`);
  l.push('');
  l.push(`**Estado:** ${informe.resumen.estado.toUpperCase()} · **Sólo lectura** · versión ${informe.version} · modo ${informe.modo}`);
  const c = informe.resumen.incidencias;
  l.push(`**Incidencias:** crítica ${c.critica} · alta ${c.alta} · media ${c.media} · baja ${c.baja} · info ${c.info}` + (informe.avisosEntorno?.length ? ` · **avisos del entorno local:** ${informe.avisosEntorno.length} (no cuentan)` : ''));
  l.push(`**Peticiones realizadas:** ${informe.resumen.peticiones} (rutas ${informe.resumen.rutasRevisadas}, enlaces ${informe.resumen.enlacesRevisados}, fichas ${informe.resumen.fichasRevisadas}, páginas de catálogo ${informe.resumen.paginasCatalogo})`);
  l.push('');
  for (const g of ['critica', 'alta', 'media', 'baja', 'info']) {
    const lista = informe.incidencias.filter((i) => i.gravedad === g);
    if (!lista.length) continue;
    l.push(`## ${ETIQUETA_GRAVEDAD[g]} (${lista.length})`);
    for (const i of lista.slice(0, 30)) l.push(`- **${i.titulo}** — ${i.detalle} _[${i.clase}] Acción: ${i.accionSugerida}_`);
    if (lista.length > 30) l.push(`- … y ${lista.length - 30} más (ver JSON).`);
    l.push('');
  }
  if (informe.avisosEntorno?.length) {
    l.push(`## Avisos del entorno local (${informe.avisosEntorno.length}) — no son incidencias del sitio real`);
    for (const i of informe.avisosEntorno) l.push(`- ${i.titulo} — ${i.detalle}`);
    l.push('');
  }
  if (!informe.incidencias.length) l.push('Sin incidencias.\n');
  l.push('## Cobertura');
  l.push(`- Revisado: ${informe.cobertura.revisado.join('; ') || '—'}`);
  l.push(`- **No revisado:** ${informe.cobertura.noRevisado.join('; ') || '—'}`);
  return l.join('\n');
}

/** Construye el informe completo. `entrada` agrupa lo que devolvieron los nodos HTTP (stateless: se recalcula todo desde lo bruto). */
export function construirInformeAuditor(entrada) {
  const { cfg, objetivosRutas = [], respuestasRutas = [], objetivosEnlaces = [], respuestasEnlaces = [], objetivosCatalogo: objCat1 = [], respuestasCatalogo: resCat1 = [], objetivosCatalogoResto = [], respuestasCatalogoResto = [], objetivosFichas = [], respuestasFichas = [], ahoraIso } = entrada;
  // Primera página + las siguientes (sólo las que existen); los marcadores se ignoran al emparejar.
  const objetivosCatalogo = [...objCat1, ...objetivosCatalogoResto];
  const respuestasCatalogo = [...resCat1, ...respuestasCatalogoResto];
  const salud = analizarSalud(objetivosRutas, respuestasRutas);
  const rutas = analizarRutas(objetivosRutas, respuestasRutas);
  const enlaces = analizarEnlaces(objetivosEnlaces, respuestasEnlaces);
  const catalogo = leerCatalogo(objetivosCatalogo, respuestasCatalogo);
  const fichas = analizarFichas(objetivosFichas, respuestasFichas);
  const todas = ordenarIncidencias([
    ...salud.incidencias,
    ...rutas.incidencias,
    ...enlaces.incidencias,
    ...(cfg.modo === 'completo' ? analizarCatalogo(catalogo, cfg, ahoraIso) : []),
    ...fichas.incidencias,
  ].map((i) => clasificarIncidencia(i, cfg)));
  // Los avisos del entorno local se listan aparte: no son incidencias del sitio ni cambian el estado.
  const avisosEntorno = todas.filter((i) => i.ambito === 'entorno_local');
  const incidencias = todas.filter((i) => i.ambito !== 'entorno_local');
  const paginasCatalogo = emparejar(objetivosCatalogo, respuestasCatalogo).filter((x) => x.t.tipo === 'catalogo').length;
  const peticiones = [objetivosRutas, objetivosEnlaces, objetivosCatalogo, objetivosFichas].reduce((n, l) => n + l.filter((t) => !t.marcador).length, 0);
  const contador = resumenIncidencias(incidencias);
  const { omitidos } = planificarRutas(cfg);
  const noRevisado = [
    'Programadores internos de Treidilor (precios, alertas, recordatorios): no exponen estado de sólo lectura (se cubrirá con la API de automatización)',
    'Programadores internos y estado de las actualizaciones: pendientes de un endpoint de estado en la API de automatización',
    ...(cfg.modo === 'publico' ? ['Fichas de producto y feed del catálogo: no se piden en producción (cada visita cuenta en la analítica y el feed exige un token)'] : []),
    ...omitidos.map((o) => `${o.etiqueta}: omitida por la política de URLs (${o.motivo})`),
  ];
  const informe = {
    agente: 'auditor-general',
    version: VERSION_AUDITOR,
    entorno: cfg.entorno,
    modo: cfg.modo,
    generadoEn: ahoraIso,
    soloLectura: true,
    resumen: {
      estado: estadoGlobal(contador),
      incidencias: contador,
      avisosEntorno: avisosEntorno.length,
      peticiones,
      rutasRevisadas: rutas.revisadas,
      enlacesRevisados: enlaces.revisados,
      fichasRevisadas: fichas.revisadas,
      paginasCatalogo,
    },
    incidencias,
    avisosEntorno,
    cobertura: {
      revisado: [
        `salud (${salud.datos ? 'datos recibidos' : 'sin datos'})`,
        `${rutas.revisadas} rutas`,
        `${enlaces.revisados} enlaces internos`,
        ...(cfg.modo === 'completo' ? [`${catalogo.productos.length} productos del feed`, `${fichas.revisadas} fichas`] : []),
      ],
      noRevisado,
    },
    markdown: '',
  };
  informe.markdown = informeMarkdown(informe);
  return informe;
}
