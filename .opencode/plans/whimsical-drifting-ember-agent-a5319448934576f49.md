# Plan: Observer de la barra de categorías + Pipeline de automatización de productos (backend)

## Decisiones confirmadas por el usuario
1. **Barra**: oculta mientras el 1er section (panel hero `HeroSearchRadar`) esté visible; aparece al entrar en `#catalogo`; en el resto de secciones se mantiene el comportamiento actual.
2. **Duplicados (Etapa 1)**: descartar (no persistir) + devolver `duplicate:true` + contabilizar en métricas.
3. **Rechazados (Etapa 2)**: persistir con `audit_status='rejected'` + motivos (alimenta métricas de transparencia).
4. **Enganche**: `POST /api/v1/products/import` + endpoint NUEVO `/api/admin/pipeline` (reproceso + métricas). No se tocan los endpoints del panel.

---

## PARTE A — Observer de la barra de categorías (frontend)

**Fichero**: `src/components/CategoryMenu.astro` (script, líneas ~881-900). Solo se usa en `src/pages/index.astro`, donde el 1er `<section>` de la página es `[data-hsr]` (HeroSearchRadar) y el 2º es `#catalogo`.

Cambio **aditivo** en el bloque del `IntersectionObserver`:
- Observar además el **primer `<section>`** del documento (`document.querySelector('section')`) con un 2º `IntersectionObserver` → flag `firstSectionVisible`.
- Gate de visibilidad: `show = visible.size > 0 && !firstSectionVisible`.
- Fallback: si no hay primer section → comportamiento actual intacto.

Efecto: mientras se ve el panel hero la barra queda oculta (`transform: translateY(-100%)`); al superar el primer section, la cabecera de `#catalogo` ya está arriba y la barra aparece. Nada más se toca (clases, CSS, resto del script intactos).

---

## PARTE B — Pipeline de automatización en 4 etapas (backend modular, ADITIVO)

### Arquitectura nueva (ficheros nuevos)

```
src/lib/pipeline/
  index.ts          → runProductPipeline(raw, opts) · runProductPipelineBatch(items) · reprocessCatalog(ids?)
  types.ts          → PipelineInput, PipelineResult, StageResult, AuditStatus, AuditResult, IngestResult, PipelineFields
  config.ts         → umbrales auditables (override por env), merchant trust list, mapa keywords→subcategoría
  metrics.ts        → pipeline-metrics.json en DATA_DIR (contadores: duplicados descartados, descartes, ejecuciones) — tmp+rename
  stageIngest.ts    → ETAPA 1
  stageAudit.ts     → ETAPA 2
  stageCategorize.ts→ ETAPA 3
  stagePublish.ts   → ETAPA 4
src/pages/api/admin/pipeline/index.ts   → GET métricas · POST reproceso (requireAdminAuth)
docs/api-v1.md                           → documentación actualizada (obligatorio según AGENTS.md)
```

El orquestador encadena `ingest → audit → categorize → publish` en ese orden, con parada temprana (duplicado ⇒ no sigue) y resultado agregado por producto.

### Etapa 1 — Ingesta, limpieza y duplicados (`stageIngest.ts`)
- Normaliza con `fromN8nContract()` (existente, `catalogStore.ts:78`) y valida `title` + `affiliateUrl`.
- Tombstone con `readDeletedIds()` (existente).
- Detección jerárquica contra `readProductsFromFile()` reutilizando **sin modificar**: `extractSourceId` (`curation.ts:80`), `canonicalProductUrl` (`curation.ts:49`), `cleanTitleKey` (`curation.ts:69`):
  a) `sourceId` idéntico → duplicado, b) URL canónica idéntica → duplicado, c) título limpio exacto en la misma `category`/`category_id` → duplicado.
- Duplicado ⇒ **no se persiste**, se devuelve `{ok:false, duplicate:true, reason}` y se incrementa el contador en `metrics.ts`.
- Devuelve producto interno `PipelineProduct = Product(productStore) & PipelineFields`.

### Etapa 2 — Auditoría "Test & Proof" (`stageAudit.ts`)
Score 0-100 con 3 bloques (umbrales en `config.ts`, overridables por env):
- **Descuento/histórico (0-40)**: `originalPrice > price` con descuento ≥ 5% verificado contra `priceHistory` (`priceHistory.ts` → campo `priceHistory` del producto).
- **Fiabilidad del vendedor (0-30)**: `merchant`/`fulfillmentProvider` en whitelist de marketplaces de confianza (Amazon/eBay/AliExpress Official/Etsy…).
- **Reseñas (0-30)**: `rating ≥ 4.0` y `reviewsCount ≥ 20` (escala log).
- `audit_score ≥ 60` ⇒ `audit_status='approved'`; si no ⇒ `'rejected'` + `audit_reasons[]` (códigos: `rating-insuficiente`, `pocas-resenas`, `sin-descuento-verificado`, `vendedor-no-verificado`, `sin-datos-suficientes`…).

### Etapa 3 — Categorización on-the-fly + enriquecimiento (`stageCategorize.ts`)
- Haystack = título + descripción + specs + brand → `suggestCategory()` (existente, `categories.ts:319`).
- Resuelve `category_id` (raíz) y `subcategory_id` (hija). Si la subcategoría encajante NO existe: `inferSubcategoryName(rootId, haystack)` (mapa de keywords en `config.ts`) → **`getOrCreateSubcategory()` (helper nuevo, idempotente)** que comprueba el slug `${parentId}--${slug}` y llama a `createCategory()` (existente, `categories.ts:203`; respeta 1 solo nivel y padre existente).
- Enriquecimiento: `enrichProductLocally()` (sync, siempre) + overlay opcional `enrichProductText()` si hay claves IA (`hasTextCredentials()`), patrón `pick()` no destructivo.
- `normalized_tags = extractNormalizedTags()` (`curation.ts:340`) · `conversion_score = computeConversionScore()` (`curation.ts:208`).
- Estampa `ia_status`/`link_status` con la semántica existente (`computeEditorialStatus`, `curation.ts:235`).

### Etapa 4 — Publicación "Listo para Catálogo" (`stagePublish.ts`)
- `upsertCatalogProduct(payload)` (existente: tombstones, contrato n8n, buyNowUrl Amazon) y después `upsertProduct({...saved.product, ...pipelineFields})` (existente, `productStore.ts:132`) para persistir los campos nuevos (el primero blanquea campos desconocidos ⇒ doble escritura, documentada).
- Resultado: registro cumple `category` + `subcategory_id` + `ia_status='completed'` + `link_status='active'` ⇒ calza con el preset **"⭐ Listos para Publicar"** del panel (`upayp1b4.astro:5300`) sin tocar el panel.

### Tipos nuevos (`pipeline/types.ts`) y adiciones a tipos existentes (SOLO campos opcionales)
```ts
export type AuditStatus = 'approved' | 'rejected' | 'pending';
export interface PipelineFields {
  audit_status?: AuditStatus; audit_score?: number; audit_reasons?: string[];
  pipeline_version?: number; pipeline_run_at?: string;
}
```
`TradeProduct` no existe en el repo: el registro canónico es `Product` (`src/lib/productStore.ts:6`). Adiciones puntuales (1-5 líneas por fichero, **nada se elimina ni se cambia de firma**):
1. `src/lib/productStore.ts` → +5 campos opcionales en el interfaz `Product`.
2. `src/data/products.ts` → +5 campos opcionales en el interfaz flat (+ paso en `toStructuredProduct` si aplica).
3. `src/content/config.ts` → +5 campos opcionales en `productSchema` (zod los striparía si no; opcional ⇒ productos antiguos siguen validando).
4. `src/lib/validateProducts.ts` → +5 líneas en `normalizeToProduct` (mapeo de vuelta a flat).
5. `src/pages/api/admin/add-product.ts:368` → añadir los campos al array `CURATION_FIELDS` (preservación en re-altas; aditivo).
6. `src/pages/api/products/add.ts` → añadir los campos al merge de preservación para que una edición manual no los borre (aditivo, 1-2 líneas).

### Integración en el endpoint existente (edición mínima, contrato intacto)
`src/pages/api/v1/products/import.ts` (líneas 44-48): sustituir `upsertCatalogProduct(item)` por `await runProductPipeline(item)` en bucle secuencial. Se conservan `success/imported/failed/results[].ok/message/product/updated`; solo se **añaden** claves (`stage`, `duplicate`, `duplicate_reason`, `audit_status`, `audit_score`, `pipeline`).

### Endpoint nuevo `/api/admin/pipeline`
- `GET` → métricas de transparencia: `{approved, rejected, pending, avg_audit_score, by_reason, duplicates_discarded, last_run}` (derivado de `products.json` + `pipeline-metrics.json`).
- `POST` `{mode:'reprocess', ids?:[], dryRun?}` → re-ejecuta las 4 etapas sobre productos existentes (etapa 1 con `ignoreId` para no auto-detectarse como duplicado).
- Auth: `requireAdminAuth` (igual que el resto de admin).

### Fichero de datos nuevo
- `DATA_DIR/pipeline-metrics.json` (contadores de descartes/duplicados). Va en el volumen de prod; no se sube a git si contiene datos (se crea bajo demanda).

---

## Orden de ejecución
1. Parte A (observer) — verificación manual en `npm run dev`.
2. Parte B: `pipeline/types.ts` + `config.ts` → etapas 1→4 → `index.ts` → `metrics.ts`.
3. Adiciones opcionales en los 6 tipos/existentes listados.
4. Enganche en `api/v1/products/import.ts` + endpoint nuevo `api/admin/pipeline`.
5. Documentación `docs/api-v1.md`.
6. Verificación: `npm run build` (typecheck) + pruebas curl del pipeline (nuevo / duplicado / rechazado) + revisión de que la web y el panel no cambian.
7. Commit + push + comprobar deploy (`curl https://tradylor.com/api/health` con `commit` igual al hash) — regla AGENTS.md.

## Reglas de blindaje respetadas
- Todo el código nuevo vive en `src/lib/pipeline/` + `api/admin/pipeline/` (módulos independientes).
- Ninguna función existente se modifica/elimina; solo se **añaden campos opcionales** a tipos y entradas a arrays de preservación.
- Contrato de `/api/v1/products/import` retrocompatible (claves nuevas, ninguna eliminada).
- Cero cambios en componentes web, CSS, panel admin y sus endpoints.
