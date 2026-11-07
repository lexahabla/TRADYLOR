# Temu (hypebridge/temu-scraper) — mercado español en categorías

Actor: `hypebridge/temu-scraper` (id `2CKn7F7pA4eH2mVRm`), build 0.2.13 (2-nov-2026). Comprobado el 7-nov-2026 con ejecuciones reales
desde Treidilor (resultados en `scripts/tests/fixtures/temu-real-sample-*.json`).

## Esquema de entrada actual
`startUrls`, `maxItems`, `getProductDetails`, `extractReviews`. **No hay ningún campo de mercado, país ni moneda.** El README sólo
indica que un prefijo de URL (`/es/`, `/se-en/`…) selecciona el mercado, y menciona una `proxyConfiguration` que no figura en el esquema
y que el propio actor desaconseja.

## Hallazgo (reproducible)
| Entrada (`startUrls`) | Respuesta |
|---|---|
| `https://www.temu.com/es/category-o3-248.html` | EUR, títulos en español, `sourceUrl` conserva `/es/` |
| `https://www.temu.com/es/category-o3-1893.html` (y variantes con slug / parámetros) | **USD, títulos en inglés, `sourceUrl: https://www.temu.com/category-o3-1893.html` (sin `/es/`)**; 3 de 3 intentos |
| `https://www.temu.com/es/-g-601101683713758.html` (producto de la categoría 1893) | EUR, título en español, `sourceUrl` conserva `/es/` |

Es decir, para algunas categorías (1893) el actor ignora el prefijo de mercado y devuelve el mercado de EE. UU., pese a que el producto
existe en el mercado español. Las fichas individuales sí respetan `/es/`.

## Texto para el mantenedor
> Con `startUrls: [{"url": "https://www.temu.com/es/category-o3-1893.html"}]` el actor devuelve productos en USD y `sourceUrl`
> `https://www.temu.com/category-o3-1893.html` (se pierde el prefijo `/es/`). Con `/es/category-o3-248.html` devuelve EUR y conserva el
> prefijo, y con `/es/-g-<goodsId>.html` (un producto de la 1893) también devuelve EUR. ¿Se puede fijar el mercado de forma explícita
> (campo `country`/`market`) o servir la categoría 1893 en el mercado indicado por el prefijo?

## Qué hace Treidilor mientras tanto
No convierte ni reetiqueta monedas: todo registro que no sea EUR queda en revisión (`moneda_no_euro:USD`). El panel muestra la moneda
devuelta antes de importar y avisa si se pidió `/es/` y el actor respondió con otro mercado.

## Método implantado: categorías de Temu en DOS FASES
Validado con una ejecución real el 7-nov-2026 (categoría 1893, 2 productos, presupuesto máximo explícito 0,20 USD):

1. **«Descubriendo productos»**: una ejecución sobre la URL de la categoría, sin detalle (`getProductDetails:false`, `maxItems` = límite).
   Sólo se leen los `goodsId` (`fields=goodsId`); no se guarda ningún precio ni dato comercial de esta fase.
2. **«Obteniendo fichas de España»**: UNA ejecución con una URL `https://www.temu.com/es/-g-<id>.html` por id (`maxItems` = nº de ids,
   `getProductDetails:true`). Sólo se aceptan las fichas de los ids descubiertos; los repetidos se eliminan.

**Importante — alcance del método:** obtiene fichas españolas de productos *descubiertos en otro mercado*. No reproduce
necesariamente la selección ni el orden de la categoría española. Los productos que el actor no devuelve para `/es/` se informan como
«no disponibles para España» con su motivo y **no se sustituyen**; los agotados conservan ese estado; nunca se reutilizan precios
estadounidenses ni se convierte ninguna moneda (todo lo que no sea EUR sigue yendo a revisión).

**Control:** límite aplicado en ambas fases · cancelar aborta el proceso completo (no se lanza la fase 2 si se cancela durante la 1) ·
reintentar tras un fallo de la fase 2 reutiliza los ids (no repite ni cobra la fase 1) · las dos fases cuentan en la cuota diaria
(`APIFY_MAX_RUNS_PER_DAY`; una categoría reserva 2) · `budgetUsd` (opcional en `POST /api/admin/category-extract`) fija un presupuesto
máximo de TODO el trabajo y cada ejecución recibe su `maxTotalChargeUsd` (la fase 2 sólo puede gastar lo que queda).

**Coste MEDIDO** (2 productos, consolidado por Apify): fase 1 = 0,042 USD (0,03 de arranque + 2 × 0,006 por producto listado);
fase 2 = 0,062 USD (0,03 + 2 × 0,016 por ficha); total 0,104 USD. Para n productos, con esos mismos precios por evento, ≈ 0,06 + 0,022 × n
USD (extrapolación del modelo medido, no medida con otros tamaños). Apify puede tardar en cerrar el uso: el servidor lo vuelve a
consultar una vez pasado un margen y marca el coste como consolidado.

**Resultado observado en la validación:** ids descubiertos = ids obtenidos (mismo orden); ambos en EUR con `/es/`; los dos productos
vinieron **agotados** (`inStock:false`) en España y así se conservan.
