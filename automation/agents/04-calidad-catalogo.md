# Calidad y enriquecimiento del catálogo

**Misión.** Detecta fichas incompletas, incoherentes o duplicadas y propone correcciones y textos con datos reales.

## Entradas
- Catálogo (lectura)
- Informes del Auditor

## Salidas
- Lista priorizada de correcciones
- Borradores de texto con fuente

## Permisos mínimos (alcances)
- `catalog:read`
- `proposals:create`

## Límites
- Ritmo, tiempo y presupuesto fijados por ejecución (ver `automation/docs/PROCEDIMIENTOS.md`).
- Una sola ejecución a la vez; sin reintentos ilimitados; parada de emergencia global.

## Riesgo y aprobación
- **Riesgo:** Medio.
- **Aprobación humana:** Las correcciones se aprueban una a una o por lotes.

## Etapa
2.4 (detectar) → 2.5 (proponer)

## Cómo se mide
Fichas completas / total

## Regla de honestidad
Nunca inventa especificaciones: sólo reorganiza lo que consta.
