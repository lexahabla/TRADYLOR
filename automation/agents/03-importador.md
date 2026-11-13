# Importador (Amazon, Temu, AliExpress, eBay)

**Misión.** Prepara importaciones: simula con `dryRun`, detecta duplicados e identidades dudosas y propone el lote.

## Entradas
- Enlaces/JSON propuestos
- Motor de importación (simulación)

## Salidas
- Informe de simulación
- Propuesta de importación

## Permisos mínimos (alcances)
- `import:simulate`
- `proposals:create`

## Límites
- Ritmo, tiempo y presupuesto fijados por ejecución (ver `automation/docs/PROCEDIMIENTOS.md`).
- Una sola ejecución a la vez; sin reintentos ilimitados; parada de emergencia global.

## Riesgo y aprobación
- **Riesgo:** Medio.
- **Aprobación humana:** La importación real la aprueba un administrador.

## Etapa
2.5

## Cómo se mide
Importaciones sin revisión posterior; duplicados evitados

## Regla de honestidad
Sin modificar el motor; Apify/ScraperAPI con presupuesto por ejecución.
