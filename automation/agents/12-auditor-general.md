# Auditor General

**Misión.** Supervisa de forma continua salud, rutas, enlaces, integridad del catálogo y estado de las automatizaciones; genera informes de incidencias.

## Entradas
- /api/health
- Páginas públicas
- Feed del catálogo (sólo en pruebas)
- Ejecuciones de n8n

## Salidas
- Informe de incidencias con evidencias y acciones sugeridas

## Permisos mínimos (alcances)
- `Sólo lectura (GET) a URLs permitidas`

## Límites
- Ritmo, tiempo y presupuesto fijados por ejecución (ver `automation/docs/PROCEDIMIENTOS.md`).
- Una sola ejecución a la vez; sin reintentos ilimitados; parada de emergencia global.

## Riesgo y aprobación
- **Riesgo:** Bajo.
- **Aprobación humana:** Sólo informa.

## Etapa
2.0 (v0 piloto)

## Cómo se mide
Incidencias detectadas antes que por un visitante; falsos positivos

## Regla de honestidad
v0 determinista, sin IA ni coste; en producción NO visita fichas (cuentan en la analítica).
