# Investigador de tendencias y productos

**Misión.** Detecta productos, categorías y nichos con potencial usando datos reales (catálogo, observaciones verificadas y, más adelante, fuentes externas citadas).

## Entradas
- Catálogo (lectura)
- Observaciones de precio verificadas
- Fuentes externas (v1, con presupuesto)

## Salidas
- Informe de candidatos con evidencias y puntuación explicada

## Permisos mínimos (alcances)
- `catalog:read`
- `research:write`
- `proposals:create`

## Límites
- Ritmo, tiempo y presupuesto fijados por ejecución (ver `automation/docs/PROCEDIMIENTOS.md`).
- Una sola ejecución a la vez; sin reintentos ilimitados; parada de emergencia global.

## Riesgo y aprobación
- **Riesgo:** Bajo.
- **Aprobación humana:** Sólo propone; no importa nada.

## Etapa
2.0 (v0 reglas) → 2.5 (web)

## Cómo se mide
Candidatos aceptados / propuestos

## Regla de honestidad
v0: descuentos DECLARADOS, nunca verificados; sin valoraciones ni ventas inventadas.
