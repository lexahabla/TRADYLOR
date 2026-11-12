# Agentes de Treidilor AI

Fichas de especificación (diseño). Cada agente declara su misión, datos, permisos mínimos, límites y aprobación. **Ningún agente usa `TRADYLOR_API_TOKEN`**; todos trabajan con permisos acotados y, hasta la Etapa 2.2, sólo en lectura.

| Agente | Riesgo | Etapa |
|---|---|---|
| [Coordinador (dirección estratégica)](00-coordinador.md) | Medio | 2.6 |
| [Investigador de tendencias y productos](01-investigador-mercado.md) | Bajo | 2.0 (v0 reglas) → 2.5 (web) |
| [Investigador de programas de afiliación](02-investigador-afiliacion.md) | Bajo | 2.5 |
| [Importador (Amazon, Temu, AliExpress, eBay)](03-importador.md) | Medio | 2.5 |
| [Calidad y enriquecimiento del catálogo](04-calidad-catalogo.md) | Medio | 2.4 (detectar) → 2.5 (proponer) |
| [Analista de ofertas, precios y comparaciones](05-analista-precios.md) | Alto | 2.4 → 2.5 |
| [Diseñador de categorías, portada e historias](06-portada-historias.md) | Medio | 2.5 |
| [Marketing multicanal y SEO](07-marketing-seo.md) | Medio | Posterior a 2.6 |
| [Creación de contenido y recursos visuales](08-contenido-visual.md) | Medio | Posterior a 2.6 |
| [Investigación de competencia y expertos](09-competencia-expertos.md) | Bajo | Posterior a 2.5 |
| [Analítica y optimización de conversiones](10-analitica-conversion.md) | Bajo | Posterior a 2.5 |
| [Expansión mediante webs nicho](11-webs-nicho.md) | Bajo | Posterior a 2.5 |
| [Auditor General](12-auditor-general.md) | Bajo | 2.0 (v0 piloto) |
| [Asistente conversacional y futura voz](13-asistente-ia.md) | Medio | 2.6 / 2.7 |

Plantilla común: misión · entradas · salidas · permisos mínimos · límites · riesgo y aprobación · etapa · métrica · regla de honestidad.
