import { effectiveKey, maskKey, hasKeyFor, type AiProviderId } from './aiKeysStore';

/**
 * ==============================================================================
 * TRADYLOR - REGISTRO DE PROVEEDORES DE IA
 * ==============================================================================
 * Catálogo único de proveedores soportados por el panel (Transparencia ›
 * Conectividad de IA y la consola de chat): opencode (CLI local), OpenAI,
 * NVIDIA (NIM), OpenRouter, Anthropic y Groq.
 *
 * Para cada proveedor se declara:
 *   - endpoint compatible con OpenAI (o nativo, en el caso de Anthropic)
 *   - modelos GRATUITOS (sin coste económico) documentados
 *   - test de conexión real (lista mínima de modelos) para el indicador de
 *     estado del panel.
 *
 * Las listas de modelos gratuitos son orientativas y están pensadas como
 * punto de partida: la mayoría de proveedores publican su catálogo completo
 * en `GET /models` (el test de conexión lo deja como detalle).
 * ==============================================================================
 */

export interface AiProviderInfo {
  id: AiProviderId | 'opencode';
  name: string;
  /** Endpoint de chat/completions compatible con OpenAI (vacío para opencode). */
  chatUrl?: string;
  /** Endpoint para listar modelos y validar la clave. */
  modelsUrl?: string;
  /** Clave de entorno asociada (informativa; el valor sale de aiKeysStore). */
  envKey?: string;
  /** Modelos por defecto sugeridos para el chat del panel. */
  defaultModel: string;
  /** Modelos gratuitos (0 €) documentados por el proveedor. */
  freeModels: string[];
  /** Nota sobre el coste / cuota. */
  pricingNote: string;
  docsUrl: string;
}

export const AI_PROVIDERS: AiProviderInfo[] = [
  {
    id: 'opencode',
    name: 'OpenCode (CLI local)',
    envKey: '— (usa la instalación del servidor)',
    defaultModel: 'local',
    freeModels: [
      'Modelos gratuitos de la instalación local (p. ej. variants ":free" y planes free del proveedor configurado en opencode)',
    ],
    pricingNote: 'Gratuito según la configuración local de opencode (modelos free/planes free).',
    docsUrl: 'https://opencode.ai/docs/',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    modelsUrl: 'https://api.openai.com/v1/models',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    freeModels: [],
    pricingNote: 'Sin modelos gratuitos: todas las llamadas consumen saldo de la cuenta (prepago o suscripción).',
    docsUrl: 'https://platform.openai.com/docs',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA (NIM)',
    chatUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    modelsUrl: 'https://integrate.api.nvidia.com/v1/models',
    envKey: 'NVIDIA_API_KEY',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    freeModels: [
      'meta/llama-3.1-8b-instruct',
      'meta/llama-3.3-70b-instruct',
      'mistralai/mistral-7b-instruct-v0.3',
      'mistralai/mistral-large-2-instruct',
      'qwen/qwen2.5-72b-instruct',
      'qwen/qwen2.5-coder-32b-instruct',
      'google/gemma-2-9b-it',
      'deepseek-ai/deepseek-r1',
    ],
    pricingNote: 'API NIM gratuita para los modelos listados (créditos de cortesía de NVIDIA).',
    docsUrl: 'https://docs.api.nvidia.com/nim/',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'deepseek/deepseek-chat-v3-0324:free',
    freeModels: [
      'deepseek/deepseek-chat-v3-0324:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'qwen/qwen3-coder:free',
      'google/gemma-3-27b-it:free',
      'moonshotai/kimi-k2:free',
      'z-ai/glm-4.5-air:free',
    ],
    pricingNote: 'Modelos con sufijo ":free" no tienen coste (límite de peticiones por día).',
    docsUrl: 'https://openrouter.ai/docs',
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    chatUrl: 'https://api.anthropic.com/v1/messages',
    modelsUrl: 'https://api.anthropic.com/v1/models',
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-3-5-sonnet-latest',
    freeModels: [],
    pricingNote: 'Sin modelos gratuitos: consumo por token (pago por uso).',
    docsUrl: 'https://docs.anthropic.com/',
  },
  {
    id: 'groq',
    name: 'Groq',
    chatUrl: 'https://api.groq.com/openai/v1/chat/completions',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'openai/gpt-oss-120b',
    freeModels: [
      'openai/gpt-oss-120b',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'qwen/qwen3-32b',
    ],
    pricingNote: 'Plan gratuito con límite diario de tokens por modelo (TPD).',
    docsUrl: 'https://console.groq.com/docs',
  },
];

export function getProviderInfo(id: string): AiProviderInfo | undefined {
  return AI_PROVIDERS.find((p) => p.id === id);
}

export type ConnectionStatus = 'connected' | 'no-key' | 'error' | 'unavailable' | 'unknown';

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  /** Clave enmascarada (nunca la clave real). */
  keyMasked: string;
  /** Origen de la clave: entorno o almacén del panel. */
  keySource: 'env' | 'store' | 'none';
  status: ConnectionStatus;
  detail: string;
  defaultModel: string;
  freeModels: string[];
  pricingNote: string;
  docsUrl: string;
  /** Modelos devueltos por el proveedor en el último test (si los hay). */
  modelsAvailable?: number;
  /** Uso/cuota cuando el proveedor la expone en las cabeceras (OpenRouter…). */
  usage?: Record<string, string>;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** ¿La clave viene del entorno o del almacén del panel? */
function keySource(provider: AiProviderId): ProviderStatus['keySource'] {
  const envName = getProviderInfo(provider)?.envKey || '';
  if (envName && process.env[envName]?.trim()) return 'env';
  if (hasKeyFor(provider)) return 'store';
  return 'none';
}

/**
 * Test REAL de conexión contra el `modelsUrl` del proveedor (cabeceras
 * mínimas, sin consumir tokens de chat). Para OpenRouter se capturan además
 * las cabeceras de uso/cuota que devuelve la API.
 */
export async function testProvider(provider: AiProviderId): Promise<ProviderStatus> {
  const info = getProviderInfo(provider);
  const base: ProviderStatus = {
    id: provider,
    name: info?.name || provider,
    configured: false,
    keyMasked: '',
    keySource: 'none',
    status: 'no-key',
    detail: 'Sin clave configurada.',
    defaultModel: info?.defaultModel || '',
    freeModels: info?.freeModels || [],
    pricingNote: info?.pricingNote || '',
    docsUrl: info?.docsUrl || '',
  };

  const key = effectiveKey(provider);
  if (!key) return base;
  base.configured = true;
  base.keyMasked = maskKey(key);
  base.keySource = keySource(provider);

  if (!info?.modelsUrl) {
    base.status = 'unavailable';
    base.detail = 'El proveedor no expone endpoint de conexión.';
    return base;
  }

  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (provider === 'anthropic') {
      // Anthropic no usa Bearer: valida con su propio header y versión.
      headers.Authorization = '';
      delete headers.Authorization;
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
    }
    if (provider === 'openrouter') {
      headers['HTTP-Title'] = 'Tradylor Admin';
    }
    const res = await fetchWithTimeout(info.modelsUrl, { method: 'GET', headers });
    if (!res.ok) {
      base.status = 'error';
      base.detail = `El proveedor respondió ${res.status}.`;
      return base;
    }
    const payload = await res.json().catch(() => null);
    const count = Array.isArray(payload?.data) ? payload.data.length : Array.isArray(payload?.models) ? payload.models.length : 0;
    base.status = 'connected';
    base.detail = `Conectado · ${count} modelo(s) disponibles.`;
    base.modelsAvailable = count;
    const usage: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      if (/limit|usage|quota|credit/i.test(name)) usage[name] = value;
    });
    if (Object.keys(usage).length) base.usage = usage;
  } catch (error) {
    base.status = 'error';
    base.detail = `Sin conexión: ${error instanceof Error ? error.message : 'error de red'}.`;
  }
  return base;
}

/** Estado de opencode: depende del CLI instalado en el contenedor. */
export async function testOpencodeCli(): Promise<ProviderStatus> {
  const info = getProviderInfo('opencode');
  const base: ProviderStatus = {
    id: 'opencode',
    name: info?.name || 'OpenCode',
    configured: true,
    keyMasked: '',
    keySource: 'none',
    status: 'unavailable',
    detail: 'Comprobando CLI local…',
    defaultModel: info?.defaultModel || 'local',
    freeModels: info?.freeModels || [],
    pricingNote: info?.pricingNote || '',
    docsUrl: info?.docsUrl || '',
  };
  try {
    const { spawn } = await import('node:child_process');
    const version = await new Promise<string>((resolve, reject) => {
      const child = spawn('opencode', ['--version'], { shell: process.platform === 'win32' });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 10_000);
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { err += String(d); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 || out.trim()) resolve((out || err).trim());
        else reject(new Error(err.trim() || `código ${code}`));
      });
    });
    base.status = 'connected';
    base.detail = `CLI detectado (${version.split('\n')[0].slice(0, 60)}).`;
  } catch (error) {
    base.status = 'unavailable';
    base.detail = `CLI no disponible en el servidor: ${error instanceof Error ? error.message : 'error'}.`;
  }
  return base;
}
