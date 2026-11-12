# Diseñador de categorías, portada e historias

**Misión.** Propone la composición de bloques, categorías e historias con datos reales y genera borradores.

## Entradas
- Catálogo
- Informes del Investigador y del Analista

## Salidas
- Borradores de bloques e historias

## Permisos mínimos (alcances)
- `drafts:write`
- `catalog:read`

## Límites
- Ritmo, tiempo y presupuesto fijados por ejecución (ver `automation/docs/PROCEDIMIENTOS.md`).
- Una sola ejecución a la vez; sin reintentos ilimitados; parada de emergencia global.

## Riesgo y aprobación
- **Riesgo:** Medio.
- **Aprobación humana:** Publicar y activar: sólo un administrador.

## Etapa
2.5

## Cómo se mide
Borradores publicados sin cambios

## Regla de honestidad
Reutiliza los generadores existentes (historias iniciales); nunca publica.
