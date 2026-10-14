/**
 * ==============================================================================
 * TRADYLOR — TIPOS DEL MÓDULO DE MARKETING (/admin/marketing)
 * ==============================================================================
 * Contratos compartidos entre las páginas SSR de marketing, los endpoints mock
 * de /api/admin/marketing/* y el cliente. Todo el backend del módulo consume
 * estos tipos para que la futura conexión con la base de datos real sólo exija
 * sustituir la fuente de datos, sin tocar la interfaz.
 * ==============================================================================
 */

/** Identificador de módulo (navegación lateral del layout de marketing). */
export type MarketingModuleId =
  | 'overview'
  | 'users'
  | 'map'
  | 'calendar'
  | 'agency-ai'
  | 'actions'
  | 'trends';

/** Envoltorio estándar de respuesta de la API de marketing. */
export interface MarketingApiResponse<T> {
  ok: boolean;
  /** `mock` mientras el endpoint no esté conectado a la BD de la tienda. */
  source: 'mock' | 'database';
  generatedAt: string;
  data: T;
}

/** Perfil comercial declarado en el alta de Mi Radar. */
export type ProfileType = 'particular' | 'autonomo' | 'empresa';

/* ---------------------------------------------------------------- 1. /users */

/** Producto favorito / recurrente del usuario. */
export interface FavoriteProductRef {
  id: string;
  title: string;
  category: string;
  timesSaved: number;
}

/** Estado del carrito delegado del usuario. */
export interface UserCartState {
  items: number;
  total: number;
  currency: string;
  updatedAt: string | null;
}

/** Lead Score dinámico 0–100 con desglose de factores. */
export interface LeadScore {
  value: number;
  band: 'frio' | 'tibio' | 'caliente';
  factors: { key: string; label: string; points: number }[];
}

/** Perfil 360°: datos declarados (encuesta) + comportamiento (tienda). */
export interface AudienceProfile360 {
  id: string;
  email: string;
  name: string;
  declared: {
    hobbies: string[];
    profileType: ProfileType;
    city?: string;
    country?: string;
  };
  behavior: {
    ltv: number;
    currency: string;
    lastPurchaseAt: string | null;
    favoriteProducts: FavoriteProductRef[];
    cart: UserCartState;
    sessions: number;
  };
  leadScore: LeadScore;
}

/** Conector de sincronización con plataformas de email marketing. */
export type EmailPlatform = 'brevo' | 'mailchimp' | 'resend';

export interface AudienceSync {
  platform: EmailPlatform;
  status: 'disconnected' | 'pending' | 'synced' | 'error';
  lastSyncAt: string | null;
  audienceSize: number;
}

/** Segmento guardado de la audiencia. */
export interface AudienceSegment {
  id: string;
  name: string;
  filters: string[];
  size: number;
  avgLeadScore: number;
}

/* ----------------------------------------------------------------- 2. /map */

export type MapLayerId = 'traffic' | 'sales' | 'emerging';

/** Métrica agregada por país (tráfico + ventas + conversión). */
export interface CountryMetric {
  iso: string;
  country: string;
  sessions: number;
  sales: number;
  revenue: number;
  conversionRate: number;
  /** Variación de tráfico vs. periodo anterior (para mercados emergentes). */
  trafficChangePct: number;
  emerging: boolean;
}

/** Señal de mercado emergente: pico de tráfico con conversión todavía baja. */
export interface EmergingMarketSignal {
  iso: string;
  country: string;
  trafficChangePct: number;
  conversionRate: number;
  severity: 'alta' | 'media' | 'baja';
  recommendation: string;
}

/** Snapshot completo del Market Map. */
export interface MarketMapSnapshot {
  activeLayer: MapLayerId;
  countries: CountryMetric[];
  emergingMarkets: EmergingMarketSignal[];
}

/* ------------------------------------------------------------- 3. /calendar */

export type CampaignChannel = 'seo' | 'paid_ads' | 'email' | 'social';

export type CampaignScope = 'local' | 'internacional' | 'nicho';

/** Peso relativo de un canal dentro de la campaña (1 = apoyo, 3 = principal). */
export interface ChannelWeight {
  channel: CampaignChannel;
  weight: 1 | 2 | 3;
  role: string;
}

/** Hitos del calendario comercial con antelación y mix de canales. */
export interface CommercialCampaign {
  id: string;
  name: string;
  /** Fecha de la efeméride (ISO yyyy-mm-dd). */
  date: string;
  scope: CampaignScope;
  category?: string;
  /** Semanas de antelación sugeridas para empezar a preparar la campaña. */
  leadTimeWeeks: number;
  /** Fecha en la que salta la alerta de preparación (ISO yyyy-mm-dd). */
  alertAt: string;
  channelMix: ChannelWeight[];
  copySuggestions: { angle: string; cta: string }[];
}

/* ----------------------------------------------------------- 4. /agency-ai */

export type AgentSkillId =
  | 'paid_media'
  | 'copywriter'
  | 'social_media'
  | 'growth_consultant';

/** Definición pública de una skill del agente. */
export interface AgentSkillDefinition {
  id: AgentSkillId;
  name: string;
  role: string;
  description: string;
  capabilities: string[];
}

export interface AgentRunRequest {
  skillId: AgentSkillId;
  brief: string;
  niche?: string;
  objective?: string;
  languages?: string[];
}

/** Output de la skill Paid Media Specialist (Meta Ads / Google Ads). */
export interface PaidMediaDraft {
  kind: 'paid_media';
  campaigns: {
    channel: 'meta_ads' | 'google_ads';
    campaignName: string;
    audiences: string[];
    ads: { headline: string; primaryText: string; cta: string }[];
    dailyBudgetHint: string;
  }[];
}

/** Output de la skill E-commerce Copywriter (secuencias de email). */
export interface EmailSequenceDraft {
  kind: 'email_sequence';
  sequenceName: string;
  emails: { step: number; delayDays: number; subject: string; body: string }[];
}

/** Output de la skill Social Media Strategist (calendario semanal). */
export interface SocialCalendarDraft {
  kind: 'social_calendar';
  days: {
    day: string;
    channel: 'tiktok' | 'instagram' | 'youtube';
    format: string;
    hook: string;
    script: string;
    cta: string;
  }[];
}

/** Output de la skill Business Growth Consultant (insights cruzados). */
export interface GrowthInsightDraft {
  kind: 'growth_insights';
  insights: {
    title: string;
    analysis: string;
    recommendation: string;
    impact: 'alto' | 'medio' | 'bajo';
  }[];
}

export type AgentSkillOutput =
  | PaidMediaDraft
  | EmailSequenceDraft
  | SocialCalendarDraft
  | GrowthInsightDraft;

/** Resultado de una ejecución del agente (mock mientras no hay LLM real). */
export interface AgentRunResult {
  skillId: AgentSkillId;
  request: AgentRunRequest;
  output: AgentSkillOutput;
  generatedAt: string;
  model: 'mock';
}

/* -------------------------------------------------------------- 5. /actions */

export type PlaybookStrategy = 'upselling' | 'cross-selling' | 'fidelizacion';

/** Playbook: manual operativo de conversión paso a paso. */
export interface Playbook {
  id: string;
  title: string;
  strategy: PlaybookStrategy;
  goal: string;
  steps: string[];
  kpis: string[];
  estimatedLiftPct: number;
}

export interface RoiSimulationInput {
  spend: number;
  traffic: number;
  conversionRatePct: number;
  averageOrderValue: number;
  marginPct: number;
}

export interface RoiSimulationResult {
  roas: number;
  roiPct: number;
  breakEvenRoas: number;
  profit: number;
  verdict: 'rentable' | 'punto de equilibrio' | 'pérdidas';
}

/* -------------------------------------------------------------- 6. /trends */

export type TrendSource = 'google_trends' | 'social_listening';

/** Punto de tendencia vinculado a una categoría del catálogo. */
export interface CategoryTrend {
  id: string;
  category: string;
  keyword: string;
  source: TrendSource;
  /** Índice 0–100 de interés (normalizado). */
  volumeIndex: number;
  changePct: number;
  window: string;
}

export type SocialChannel = 'tiktok' | 'instagram' | 'youtube' | 'pinterest' | 'linkedin' | 'x';

/** Recomendación de canal por tipo de categoría/producto. */
export interface SocialChannelRecommendation {
  categoryType: string;
  channels: {
    channel: SocialChannel;
    fit: 'alto' | 'medio' | 'bajo';
    reason: string;
    bestFormat: string;
  }[];
}

export interface TrendsSnapshot {
  trends: CategoryTrend[];
  channelMatrix: SocialChannelRecommendation[];
}
