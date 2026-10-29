import { GoogleGenAI } from '@google/genai';

/**
 * SKILLS & CONTEXTO DEL PROYECTO TRADYLOR
 * Unifica la arquitectura del backend, la lógica de negocio y las automatizaciones.
 */
const TRADYLOR_SKILLS_INSTRUCTION = `
# SYSTEM INSTRUCTION: TRADYLOR BACKEND EXPERT & THOUGHT PARTNER

## 1. Identidad y Rol
Eres el Arquitecto Backend Senior, Co-Pensador y Asistente Técnico de Tradylor.com (plataforma e-commerce de afiliación con curación automatizada, enriquecimiento vía IA y feeds multirred).
Debes debatir de forma crítica, aportar criterio técnico riguroso y fundamentar tus opiniones en datos contrastados en la web.

## 2. Herramientas y Razonamiento en Tiempo Real
- Dispones de la herramienta de Búsqueda de Google (Google Search) integrada.
- Utilízala autónomamente cuando necesites verificar especificaciones reales de hardware, lanzamientos, precios de mercado o benchmarking para fundamentar tus respuestas.

## 3. Dominio del Ecosistema Tradylor
- **Herramientas:**
  - Radar: Seguimiento de precios, stock y alertas.
  - Perfilador: Clasificador estricto de productos/usuarios en 6 perfiles únicos.
  - Comparador: Análisis técnico diferencial.
  - Asesor IA: Recomendador conversacional.
- **Taxonomía Estricta de los 6 Perfiles del Perfilador:**
  1. Work: Productividad, oficina, monitores ergonómicos, almacenamiento, hubs.
  2. Study / Multimedia: Equipos equilibrados, estudiantes, tablets, pantallas 4K estándar.
  3. Streaming: Webcams, micrófonos XLR/USB, capturadoras, iluminación, brazos.
  4. Gaming: GPUs, monitores de alta frecuencia (Hz), periféricos gaming, placas/chasis.
  5. Audio: Hi-Fi, monitores de estudio, DACs, amplificadores, interfaces dedicadas.
  6. Automation / Domotics: Enchufes inteligentes, sensores, iluminación inteligente, hubs domóticos.

## 4. Pipeline de Datos de Producto (3 Etapas)
1. **Comerciante (Origen):** Datos crudos escaneados/scrapeados (ASIN, EAN, precio oferta/original, tienda, envío, URLs, specs clave/valor).
2. **Catálogo (Base de Datos Central):** Registro persistente etiquetado con perfil_id, categoria_id, score_conversion y estado_editorial.
3. **Extracción & Alta (Enriquecimiento):** Enriquecimiento editorial generado por IA (Título optimizado, Descripción técnica concisa, Veredicto editorial, Pros, Contras, Badges, Ficha técnica consolidada).

## 5. Infraestructura y Diagnóstico
- Entorno: Docker / EasyPanel / Node.js.
- Autenticación: Exclusivamente API Keys de Google AI Studio (formato 'AIzaSy...').
- Modelo objetivo: 'gemini-2.0-flash' (o 'gemini-1.5-flash'). Evitar 'gemini-2.5-flash' (obsoleto).
`;

export class GeminiService {
    private ai: GoogleGenAI;
    private defaultModel = 'gemini-2.0-flash';

    constructor() {
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

        if (!apiKey) {
            throw new Error(
                '[GeminiService] Error: No se ha encontrado la variable de entorno GEMINI_API_KEY.'
            );
        }

        if (apiKey.startsWith('AQ.')) {
            throw new Error(
                "[GeminiService] Error de autenticación: La clave proporcionada empieza por 'AQ.', lo cual corresponde a credenciales GCP/OAuth. Debes usar una API Key de Google AI Studio ('AIzaSy...')."
            );
        }

        this.ai = new GoogleGenAI({ apiKey });
    }

    /**
     * Mantiene una conversación profunda sobre el backend/proyecto
     * haciendo uso de Google Search para fundamentar sus opiniones.
     */
    async chatWithThoughtPartner(prompt: string, history: Array<{ role: string; parts: Array<{ text: string }> }> = []) {
        try {
            const response = await this.ai.models.generateContent({
                model: this.defaultModel,
                contents: [
                    ...history,
                    { role: 'user', parts: [{ text: prompt }] }
                ],
                config: {
                    tools: [{ googleSearch: {} }],
                    systemInstruction: TRADYLOR_SKILLS_INSTRUCTION,
                },
            });

            return {
                success: true,
                text: response.text,
                groundingMetadata: response.candidates?.[0]?.groundingMetadata || null,
            };
        } catch (error: any) {
            console.error('[GeminiService] Error en chatWithThoughtPartner:', error);
            throw error;
        }
    }

    /**
     * Clasifica un producto o input dentro de la taxonomía estricta del Perfilador.
     */
    async classifyProduct(productData: string) {
        const classificationPrompt = `
    Analiza el siguiente producto o texto y clasifícalo estrictamente en uno de los 6 perfiles de Tradylor:
    [Work, Study/Multimedia, Streaming, Gaming, Audio, Automation/Domotics]

    Datos del producto:
    ${productData}

    Responde en formato JSON estricto con la siguiente estructura:
    {
      "profile": "NombreDelPerfil",
      "confidence": 0.95,
      "reasoning": "Explicación breve de la elección basada en sus características técnicas"
    }
    `;

        try {
            const response = await this.ai.models.generateContent({
                model: this.defaultModel,
                contents: [{ role: 'user', parts: [{ text: classificationPrompt }] }],
                config: {
                    responseMimeType: 'application/json',
                    systemInstruction: TRADYLOR_SKILLS_INSTRUCTION,
                },
            });

            return JSON.parse(response.text || '{}');
        } catch (error: any) {
            console.error('[GeminiService] Error en classifyProduct:', error);
            throw error;
        }
    }

    /**
     * Genera el enriquecimiento editorial (Etapa 3 del pipeline)
     * a partir de los datos procesados del comerciante.
     */
    async enrichProductData(rawScrapedData: object) {
        const enrichmentPrompt = `
    Procesa los siguientes datos crudos del comerciante y genera el objeto de enriquecimiento editorial para Tradylor:

    Datos del comerciante:
    ${JSON.stringify(rawScrapedData, null, 2)}

    Devuelve un JSON con:
    - title: Título optimizado y limpio
    - conciseDescription: Descripción técnica concisa
    - editorialVerdict: Veredicto editorial de Tradylor
    - pros: Array de 3 a 5 puntos fuertes
    - contras: Array de 1 a 3 puntos a considerar
    - badge: Etiqueta destacada (ej: Chollo, Mínimo Histórico, Top Elección, etc.)
    `;

        try {
            const response = await this.ai.models.generateContent({
                model: this.defaultModel,
                contents: [{ role: 'user', parts: [{ text: enrichmentPrompt }] }],
                config: {
                    responseMimeType: 'application/json',
                    systemInstruction: TRADYLOR_SKILLS_INSTRUCTION,
                },
            });

            return JSON.parse(response.text || '{}');
        } catch (error: any) {
            console.error('[GeminiService] Error en enrichProductData:', error);
            throw error;
        }
    }
}