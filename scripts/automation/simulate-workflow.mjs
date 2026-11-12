// SIMULADOR de workflows de n8n para las pruebas automáticas (no sustituye a n8n). Ejecuta, en orden, los nodos que usa el piloto:
// disparador manual, Code (en un contexto aislado de `node:vm`), HTTP Request (con un `fetch` simulado que inyecta el test) y notas.
// Sirve para probar el JSON GENERADO de punta a punta con respuestas de ejemplo, sin red y sin n8n.
// Comportamientos de n8n que reproduce: los nodos que no reciben elementos no se ejecutan; `$()` falla si el nodo no se ejecutó;
// el HTTP Request con `onError: continueRegularOutput` devuelve `{ error }`; sólo se admite la URL `={{ $json.url }}`.
import vm from 'node:vm';

export function simularWorkflow(wf, { fetchSimulado, ahora = '2026-11-12T10:00:00.000Z', hostsPermitidos } = {}) {
  const salidas = new Map(); // nombre → items
  const peticiones = [];
  const porNombre = new Map(wf.nodes.map((n) => [n.name, n]));
  const entradas = new Map(wf.nodes.map((n) => [n.name, []]));
  for (const [de, ramas] of Object.entries(wf.connections ?? {})) for (const grupo of ramas.main ?? []) for (const c of grupo ?? []) entradas.get(c.node)?.push(de);
  // orden topológico simple (los workflows del piloto son cadenas)
  const orden = [];
  const hechos = new Set();
  const visitar = (n) => {
    if (hechos.has(n)) return;
    hechos.add(n);
    for (const d of entradas.get(n) ?? []) visitar(d);
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
    else for (const p of previos) entrada.push(...(salidas.get(p) ?? []));
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
    throw new Error(`Tipo de nodo no soportado por el simulador: ${nodo.type}`);
  }
  const ultimo = orden.filter((n) => porNombre.get(n).type !== 'n8n-nodes-base.stickyNote').pop();
  return { salida: salidas.get(ultimo) ?? [], salidas, peticiones };
}
