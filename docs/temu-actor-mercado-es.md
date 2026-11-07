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
