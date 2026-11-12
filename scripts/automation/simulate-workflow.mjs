// SIMULADOR de workflows de n8n para las pruebas automáticas (no sustituye a n8n). Ejecuta, en orden, los nodos que usa el piloto:
// disparador manual, Code (en un contexto aislado de `node:vm`), HTTP Request (con un `fetch` simulado que inyecta el test) y notas.
// Sirve para probar el JSON GENERADO de punta a punta con respuestas de ejemplo, sin red y sin n8n.
// Comportamientos de n8n que reproduce: los nodos que no reciben elementos no se ejecutan; `$()` falla si el nodo no se ejecutó;
// el HTTP Request con `onError: continueRegularOutput` devuelve `{ error }`; sólo se admite la URL `={{ $json.url }}`.
// Entrega 2c: simula las operaciones «Data table» que usa el Auditor (listar tablas, leer filas, insertar filas, crear tabla) sobre un almacén en memoria (`almacen`), con
// `onError`/`alwaysOutputData` y `$execution.mode`/`$execution.id` (opción `ejecucion`). NO sustituye a la prueba con las Data Tables reales de n8n.
// Comportamientos REALES de n8n 2.38.6 que reproduce (medidos en `tai-prueba-dt`): List y Get se ejecutan UNA VEZ POR CADA elemento de entrada (con N elementos devuelven N copias);
// un Insert con `continueErrorOutput` manda a la 2ª salida los errores de n8n (p. ej. tabla inexistente), pero una validación fallida (columna desconocida) NO da error: devuelve el
// elemento de entrada envuelto (`{json:{json,pairedItem},pairedItem}`) sin guardar nada (`almacen.falloInsert = true`; `'tabla'` simula la tabla inexistente). Los nodos con varias salidas
// (`onError: continueErrorOutput`) entregan cada salida por separado a los nodos conectados a ella.
import vm from 'node:vm';

/** Almacén en memoria para los nodos «Data table» simulados. `tablas`: nombres de tablas que ya existen. Las banderas simulan fallos de la tabla. */
export function crearAlmacenSimulado(tablas = []) {
  const almacen = { tablas: {}, operaciones: [], falloInsert: false, falloLectura: false, seq: 0 };
  for (const nombre of tablas) almacen.tablas[nombre] = { id: `tabla-${Object.keys(almacen.tablas).length + 1}`, nombre, filas: [] };
  return almacen;
}

function simularDataTable(nodo, entrada, almacen) {
  const p = nodo.parameters;
  const alm = almacen;
  alm.operaciones.push({ nodo: nodo.name, recurso: p.resource, operacion: p.operation });
  const evaluar = (valor, json) => { const m = String(valor).match(/^=\{\{\s*\$json\.(\w+)\s*\}\}$/); return m ? json[m[1]] : valor; };
  const buscar = (valor) => Object.values(alm.tablas).find((x) => x.nombre.toLowerCase().includes(String(valor).toLowerCase()));
  if (p.resource === 'table') {
    if (p.operation === 'list') {
      if (alm.falloLectura) throw new Error('Could not list data tables');
      const filtro = String(p.options?.filterName ?? '').toLowerCase();
      const una = Object.values(alm.tablas).filter((x) => x.nombre.toLowerCase().includes(filtro)).map((x) => ({ json: { id: x.id, name: x.nombre } }));
      return entrada.flatMap(() => una.map((i) => ({ json: { ...i.json } }))); // una copia por cada elemento de entrada (comportamiento real de n8n)
    }
    if (p.operation === 'create') {
      const existente = alm.tablas[p.tableName];
      if (!existente) alm.tablas[p.tableName] = { id: `tabla-${Object.keys(alm.tablas).length + 1}`, nombre: p.tableName, filas: [], columnas: (p.columns?.column ?? []).map((c) => c.name) };
      return [{ json: { id: alm.tablas[p.tableName].id, name: p.tableName } }];
    }
    throw new Error(`operación de tabla no simulada: ${p.operation}`);
  }
  if (p.resource !== 'row') throw new Error(`recurso no simulado: ${p.resource}`);
  const ref = p.dataTableId;
  if (!ref || ref.__rl !== true || ref.mode !== 'name') throw new Error('el simulador sólo admite la referencia por nombre');
  const tabla = buscar(ref.value);
  if (p.operation === 'get') {
    if (alm.falloLectura) throw new Error('Could not read data table');
    if (!tabla) throw new Error(`Data table with name "${ref.value}" not found`);
    let filas = tabla.filas.filter((fila) => (p.filters?.conditions ?? []).every((c) => c.condition === 'eq' && fila[c.keyName] === c.keyValue));
    const col = p.orderBy ? p.orderByColumn : 'id';
    const dir = p.orderBy ? p.orderByDirection : 'ASC';
    filas = [...filas].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : a.id - b.id) * (dir === 'DESC' ? -1 : 1));
    if (!p.returnAll) filas = filas.slice(0, p.limit);
    return entrada.flatMap(() => filas.map((fila) => ({ json: { ...fila } }))); // una lectura por cada elemento de entrada
  }
  if (p.operation === 'insert') {
    if (alm.falloInsert === 'tabla' || !tabla) throw new Error(`Data table with name "${ref.value}" not found`);
    // Validación fallida (columna desconocida): n8n NO da error; devuelve el elemento de entrada envuelto y no guarda nada.
    if (alm.falloInsert) return entrada.map((it, i) => ({ json: { json: it.json, pairedItem: { item: i } }, pairedItem: { item: i } }));
    const salida = [];
    for (const it of entrada) {
      const valores = Object.fromEntries(Object.entries(p.columns.value).map(([k, v]) => [k, evaluar(v, it.json)]));
      const fila = { id: ++alm.seq, ...valores, createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z' };
      tabla.filas.push(fila);
      salida.push({ json: { ...fila } });
    }
    return salida;
  }
  throw new Error(`operación de fila no simulada: ${p.operation}`);
}

export function simularWorkflow(wf, { fetchSimulado, ahora = '2026-11-12T10:00:00.000Z', hostsPermitidos, almacen = null, ejecucion = {} } = {}) {
  const salidas = new Map(); // nombre → items
  const peticiones = [];
  const porNombre = new Map(wf.nodes.map((n) => [n.name, n]));
  const entradas = new Map(wf.nodes.map((n) => [n.name, []])); // nombre → [{ de, idx }]: nodo de origen y nº de salida
  const porSalida = new Map(); // nombre → [items de la salida 0, items de la salida 1…] (sólo nodos con varias salidas)
  for (const [de, ramas] of Object.entries(wf.connections ?? {})) (ramas.main ?? []).forEach((grupo, idx) => { for (const c of grupo ?? []) entradas.get(c.node)?.push({ de, idx }); });
  // orden topológico simple (los workflows del piloto son cadenas)
  const orden = [];
  const hechos = new Set();
  const visitar = (n) => {
    if (hechos.has(n)) return;
    hechos.add(n);
    for (const d of entradas.get(n) ?? []) visitar(d.de);
    orden.push(n);
  };
  for (const n of wf.nodes) visitar(n.name);

  const RealDate = Date;
  for (const nombre of orden) {
    const nodo = porNombre.get(nombre);
    if (nodo.disabled || nodo.type === 'n8n-nodes-base.stickyNote') continue;
    const previos = entradas.get(nombre) ?? [];
    let entrada = [];
    if (nodo.type === 'n8n-nodes-base.manualTrigger') entrada = [{ json: {} }];
    else for (const { de, idx } of previos) entrada.push(...(porSalida.has(de) ? porSalida.get(de)[idx] ?? [] : idx === 0 ? salidas.get(de) ?? [] : []));
    if (!entrada.length && nodo.type !== 'n8n-nodes-base.manualTrigger') { salidas.set(nombre, []); continue; } // sin elementos → no se ejecuta
    if (nodo.type === 'n8n-nodes-base.manualTrigger') { salidas.set(nombre, entrada); continue; }

    if (nodo.type === 'n8n-nodes-base.code') {
      const todo = (n) => {
        if (!salidas.has(n) || !(salidas.get(n) !== undefined)) throw new Error(`Node '${n}' hasn't been executed`);
        return salidas.get(n);
      };
      const contexto = {
        $: (n) => ({ all: () => todo(n), first: () => todo(n)[0] }),
        $input: { all: () => entrada, first: () => entrada[0] },
        $execution: { mode: ejecucion.mode ?? 'test', id: String(ejecucion.id ?? '1') },
        Date: class extends RealDate {
          constructor(...a) { super(...(a.length ? a : [ahora])); }
          static now() { return new RealDate(ahora).getTime(); }
        },
        JSON, Math, Number, String, Array, Object, Map, Set, RegExp, Error, Intl,
      };
      vm.createContext(contexto);
      const envuelto = `(function () {\n${nodo.parameters.jsCode}\n})()`;
      const resultado = vm.runInContext(envuelto, contexto, { timeout: 5000 });
      if (!Array.isArray(resultado) || resultado.some((x) => !x || typeof x.json !== 'object')) throw new Error(`El nodo Code «${nombre}» debe devolver [{ json }]`);
      salidas.set(nombre, resultado);
      continue;
    }

    if (nodo.type === 'n8n-nodes-base.httpRequest') {
      const p = nodo.parameters;
      if (p.url !== '={{ $json.url }}') throw new Error(`URL no soportada por el simulador en «${nombre}»`);
      const metodo = String(p.method ?? 'GET').toUpperCase();
      const out = [];
      for (const it of entrada) {
        const url = it.json.url;
        peticiones.push({ nodo: nombre, metodo, url, credencial: Object.keys(nodo.credentials ?? {}).length > 0 });
        if (metodo !== 'GET') throw new Error(`El simulador rechaza ${metodo} (sólo lectura)`);
        if (hostsPermitidos && !hostsPermitidos.includes(new URL(url).host)) throw new Error(`Host no permitido en la simulación: ${new URL(url).host}`);
        try {
          const r = fetchSimulado({ url, metodo, nodo: nombre, credencial: Object.keys(nodo.credentials ?? {}).length > 0 });
          out.push({ json: { statusCode: r.statusCode ?? 200, headers: r.headers ?? { 'content-type': 'text/html' }, data: typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? ''), ...(r.error ? { error: r.error } : {}) } });
        } catch (e) {
          out.push({ json: { error: e.message } });
        }
      }
      salidas.set(nombre, out);
      continue;
    }
    if (nodo.type === 'n8n-nodes-base.dataTable') {
      let ok = [];
      let errores = [];
      try {
        ok = simularDataTable(nodo, entrada, almacen ?? crearAlmacenSimulado());
      } catch (e) {
        if (nodo.onError === 'continueErrorOutput') errores = [{ json: { error: e.message }, error: { message: e.message } }]; // forma real
        else if (nodo.onError === 'continueRegularOutput') ok = [{ json: { error: e.message } }];
        else throw e;
      }
      if (!ok.length && !errores.length && nodo.alwaysOutputData) ok = [{ json: {} }];
      salidas.set(nombre, ok);
      if (nodo.onError === 'continueErrorOutput') porSalida.set(nombre, [ok, errores]);
      continue;
    }
    throw new Error(`Tipo de nodo no soportado por el simulador: ${nodo.type}`);
  }
  // El resultado es la salida del nodo «Informe» si existe (en 2c el último nodo es el que guarda la instantánea); si no, la del último nodo.
  const ultimo = porNombre.has('Informe') ? 'Informe' : orden.filter((n) => porNombre.get(n).type !== 'n8n-nodes-base.stickyNote' && !porNombre.get(n).disabled).pop();
  return { salida: salidas.get(ultimo) ?? [], salidas, peticiones };
}
