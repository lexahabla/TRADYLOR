# Actualización de precios: guía de activación por plataforma

Servicio único: `src/lib/offerRefresh.ts` (+ `offerRefreshExtra.ts` para AliExpress, eBay y Temu). Una fuente por plataforma, una consulta por anuncio,
prioridad a las fichas con alerta, cadencia adaptativa, espera tras fallos, lote y tope diario por fuente, registro de ejecuciones
(`offer-refresh-runs.json`) y parada automática de una fuente si falla la autenticación o se agota la cuota.

> **«Implementado» no es «verificado con la API real».** Estado a 09/11/2026: eBay verificado en producción (lectura y escritura de 2 fichas);
> AliExpress, Amazon (vía ScraperAPI) y Temu están implementados y probados con respuestas simuladas, **no** contrastados con su API real en este servicio.

## Reglas comunes

1. **Programador global:** sólo actúa con `OFFER_REFRESH_ENABLED=true`. Mientras no se ponga, nada se consulta solo (el botón manual sí funciona).
2. **Aislar una plataforma:** `OFFER_REFRESH_SOURCES=ebay` (lista separada por comas) hace que el programador consulte SÓLO esas fuentes, aunque otras estén
   habilitadas en el panel. Sin la variable manda la configuración del panel.
3. **Por plataforma (panel › Productos › Precios):** frecuencia (desactivada, 12, 24, 48, 72 h o semanal) y tope diario de consultas (0 = pausa; vacío = sin tope).
   Se guarda en `offer-refresh.json` del volumen y sobrevive a reinicios y redeploys.
4. **Fuentes adicionales:** `OFFER_REFRESH_EXTRA_SOURCES=ebay,aliexpress,temu` (sólo las que se quieran cargar; hace falta redeploy). Su programación nace desactivada.
5. **Parada automática:** un error de autenticación o de cuota detiene esa fuente (no se insiste ficha a ficha); el programador la deja desactivada con el
   motivo visible en el panel («Detenida: …»). Se reanuda volviendo a elegir una frecuencia en el panel.
6. **Prueba controlada antes de automatizar** (cualquier plataforma): copia de las fichas, comprobar que ninguna alerta las vigila y ejecutar
   `POST /api/admin/offers/refresh` con `{"ids":["<ficha>"],"evaluateAlerts":false}`. Con `evaluateAlerts:false` el endpoint responde 409 si alguna alerta del centro
   o de Mi Radar vigila esas fichas (los vigilantes notificarían después). Comprobar precio, moneda, envío, stock, fecha, observaciones e historial.
7. **Detener todo:** quitar `OFFER_REFRESH_ENABLED` (o ponerla en `false`) y redeploy; o poner la frecuencia de la plataforma en «Desactivada».

## eBay — verificada en producción

- **Credenciales:** eBay Partner Network (Client ID/Secret) ya conectadas (OAuth de aplicación, API Browse; gratis dentro de su cuota).
- **Activar:** `OFFER_REFRESH_EXTRA_SOURCES=ebay` (ya puesta) → panel: frecuencia 24 h, tope diario opcional → para aislarla, `OFFER_REFRESH_SOURCES=ebay` y,
  al final, `OFFER_REFRESH_ENABLED=true`.
- **Qué lee:** precio (EUR), disponibilidad, coste de envío (separado del precio), vendedor/condición sólo para contraste. 12 fichas con id `v1|…|0`.
- **Coste:** 0 €. **Limitaciones:** la API no devuelve el vendedor en el adaptador (un cambio de vendedor no se detecta); un salto > 50 % va a revisión.

## AliExpress — preparada, bloqueada por la cuenta

- **Estado conocido:** la API responde `401 This publisher is not registered` (y 404 `System Error` en productos). La firma y la clave se aceptan; el
  catálogo se sincronizó con éxito el 05/11/2026. El bloqueo es de cuenta/permisos, no de código.
- **Qué hay que hacer fuera del código:** en portals.aliexpress.com comprobar que la cuenta de afiliado está activa y tiene tracking ID; en
  open.aliexpress.com que la aplicación está «Online» con la API de afiliados autorizada y sin caducar; si se recrea, actualizar App Key/Secret en las credenciales de AliExpress.
- **Activar (cuando funcione):** 1) «Validar conexión» en el panel debe dar «verificada» (ya no da falsos positivos); 2) `OFFER_REFRESH_EXTRA_SOURCES=ebay,aliexpress`
  y redeploy; 3) prueba con 3 fichas (precio, moneda EUR, variante); 4) frecuencia 24–48 h y tope diario; 5) las 87 fichas tienen identificador.
- **Coste:** 0 € (API de afiliados). **Limitaciones:** el precio es el de promoción de afiliados (`target_sale_price`); no trae stock ni envío (quedan «no indicado»).

## Amazon — ScraperAPI (de pago)

- **Credenciales:** `SCRAPER_API_KEY` (ya configurada). Plan actual 1.000 créditos/mes, sin pago por uso; renovación el 29 del mes.
- **Coste:** 5 créditos por consulta (tabla genérica de ScraperAPI; **sin medir** con este endpoint). 35 fichas a 24 h ≈ 5.250 créditos/mes; a 48 h ≈ 2.625; a 72 h ≈ 1.750.
  El plan actual no da ni para 72 h: hace falta Hobby (49 USD/mes, 100.000 créditos) o limitar con `maxPerDay` (Amazon nace con 10).
- **Activar:** decidir plan → medir el consumo real con UNA consulta (contador de `https://api.scraperapi.com/account`, gratis) → panel: frecuencia 48–72 h y tope diario →
  `OFFER_REFRESH_SOURCES=amazon` (o la lista deseada) → `OFFER_REFRESH_ENABLED=true`.
- **Alternativa oficial:** Amazon PA-API (no configurada: faltan Access Key, Secret Key y Tracking ID de Associates). Se incorporaría como otro adaptador de la red `amazon`
  sin tocar el catálogo. **Limitaciones:** ScraperAPI no entrega el envío; el nombre exacto del campo de disponibilidad no está confirmado (se leen `availability` y `availability_status`).

## Temu — Apify (de pago)

- **Credenciales:** `APIFY_TOKEN` (sólo servidor). Opcionales: `APIFY_MAX_RUNS_PER_DAY` (20), `APIFY_MAX_COST_USD` (2 por ejecución).
- **Activar:** `APIFY_TOKEN` en Easy Panel + `OFFER_REFRESH_EXTRA_SOURCES=ebay,temu` → prueba con UNA ficha (≈ 0,05 USD) → frecuencia y tope diario (nace con 2) →
  `OFFER_REFRESH_SOURCES=temu` si se quiere aislar.
- **Qué hace:** una ejecución de Apify por ficha (`/es/-g-<id>.html`, límite 1). Un precio dudoso (desde, variante, relámpago, cupón, moneda ≠ EUR, otro goodsId) **no se aplica**; ningún fallo se reintenta.
- **Coste:** ≈ 0,03 USD de arranque + 0,016 USD por producto (medido). 2 fichas a 24 h ≈ 2,8 USD/mes. **Limitaciones:** sin prueba real de actualización; variantes sin ficha propia.

## Alertas e historial

Las lecturas verificadas alimentan `priceHistory` (un punto por día, sin duplicados), `extra.observations`, la señal de bajada (sólo con lectura previa comparable) y el
indicador «Ha bajado de precio». Tras un refresco real se evalúan las alertas (Mi Radar y centro «Alertas de precio») salvo `evaluateAlerts:false`. Los avisos de productos
visitados siguen desactivados (`PRICE_DROP_VISITS_ENABLED`).
