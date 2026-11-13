# Treidilor AI — automatización y agentes

Aquí vive todo lo necesario para desarrollar, probar y desplegar los agentes de Treidilor en **n8n** de forma segura y versionada.

> **Estado (Fase 2.0):** construido y probado en local. **Nada se ha arrancado, instalado ni desplegado.** Los workflows están desactivados (`active: false`) y son de **sólo lectura**.

## Contenido
| Ruta | Qué es |
|---|---|
| [`PLAN-MAESTRO.md`](PLAN-MAESTRO.md) | Estrategia, principios, agentes, hoja de ruta, riesgos |
| `agents/` | Ficha de cada agente (misión, datos, permisos mínimos, límites, aprobación) |
| `lib/` | **Código de los agentes**: módulos puros y probados (`auditor`, `researcher`, `urlPolicy`, `common`) |
| `config/` | Configuración por entorno (`local.json`, `produccion.json`) |
| `workflows/` | JSON de n8n **generados** desde `lib` (no se editan a mano) |
| `schemas/` | Esquemas de los informes (`informe-auditor`, `informe-investigador`) |
| `dev/` | `docker-compose.n8n.yml` del n8n de pruebas (no arrancado) y `.env.n8n.example` |
| `docs/` | Procedimientos, qué falta para ejecutar y diseño de la API de automatización |
| `reports/` | (ignorado por git) salidas locales de pruebas |

Herramientas en `scripts/automation/`: `build-workflows.mjs`, `lint-workflows.mjs`, `normalize-workflow.mjs`, `simulate-workflow.mjs`, `make-test-data.mjs`, `validate-schema.mjs`. Pruebas: `scripts/tests/automation-*.test.mjs` (se ejecutan con `npm test`).

## Ciclo de trabajo (sin n8n)
```bash
# 1) editar la lógica en automation/lib/*.mjs (y su prueba)
# 2) regenerar los workflows
node scripts/automation/build-workflows.mjs --write
# 3) comprobar seguridad y sincronía
node scripts/automation/lint-workflows.mjs
node scripts/automation/build-workflows.mjs --check
# 4) pruebas
npm test
```

## Reglas
1. **Sólo lectura** en esta fase: los workflows sólo hacen peticiones GET a URLs que fija el código con la política de `lib/urlPolicy.mjs`.
2. **Nunca** salida de afiliado, API con efectos, panel, Mi Radar ni fichas de producto en producción (cada visita cuenta en la analítica).
3. **Ningún secreto** en el repositorio. Las credenciales se crean a mano en n8n y se referencian por **nombre**.
4. **Ningún agente usa `TRADYLOR_API_TOKEN`.**
5. Un cambio en `lib/` exige regenerar los JSON (la prueba de sincronía lo comprueba).
6. Activar, programar o importar a producción: sólo con autorización expresa (`docs/PROCEDIMIENTOS.md`).
