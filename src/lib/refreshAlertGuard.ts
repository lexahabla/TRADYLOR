/**
 * ==============================================================================
 * TREIDILOR — GUARDA DE ALERTAS DE LA ACTUALIZACIÓN MANUAL (solo lectura)
 * ==============================================================================
 * `evaluateAlerts:false` sólo omite la evaluación que lanza el propio refresco. Los dos vigilantes independientes (Mi Radar y el centro
 * «Alertas de precio») siguen comprobando el catálogo por su cuenta y notificarían después de guardar un precio nuevo. Por eso una ejecución
 * que pide no evaluar alertas sólo se admite si NINGUNA alerta vigilante afecta a las fichas objetivo: aquí se cuenta (sin ids de usuario,
 * correos ni importes) cuántas hay.
 * ==============================================================================
 */

export interface AlertExposure {
  /** Alertas del centro «Alertas de precio» activas y sin cumplir sobre esas fichas. */
  center: number;
  /** Productos de Mi Radar con precio objetivo o aviso de stock sobre esas fichas. */
  radar: number;
  total: number;
}

export async function alertExposure(productIds: string[]): Promise<AlertExposure> {
  const wanted = new Set(productIds.map(String));
  const { vigilantAlertCountFor } = await import('./priceAlertCenter');
  const center = vigilantAlertCountFor(wanted);
  const { collectPriceWatchItems } = await import('./radarStore');
  const radar = collectPriceWatchItems().filter((item) => wanted.has(item.product.id)).length;
  return { center, radar, total: center + radar };
}
