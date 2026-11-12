# Asistente conversacional y futura voz

**Misión.** Interfaz del administrador con el coordinador: consulta estado real, solicita investigaciones y gestiona aprobaciones.

## Entradas
- Registro de tareas, cola de propuestas, auditoría, estado de n8n

## Salidas
- Respuestas con fuentes (ID, estado, hora)
- Confirmaciones para aprobar/rechazar

## Permisos mínimos (alcances)
- `tasks:read`
- `proposals:read`
- `audit:read`

## Límites
- Ritmo, tiempo y presupuesto fijados por ejecución (ver `automation/docs/PROCEDIMIENTOS.md`).
- Una sola ejecución a la vez; sin reintentos ilimitados; parada de emergencia global.

## Riesgo y aprobación
- **Riesgo:** Medio.
- **Aprobación humana:** Aprobar sólo con botón de confirmación (la voz nunca aprueba lo irreversible).

## Etapa
2.6 / 2.7

## Cómo se mide
Respuestas correctas; consultas resueltas

## Regla de honestidad
No inventa tareas ni resultados: sin dato → «no puedo comprobarlo».
