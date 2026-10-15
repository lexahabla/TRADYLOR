/**
 * ==============================================================================
 * TRADYLOR - TIPOS DEL MÓDULO MULTI-CATÁLOGO DE AFILIACIÓN
 * ==============================================================================
 */

/** Campos de credencial que admite una red */
export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
}

/** Definición estática de una red de afiliación */
export interface NetworkDefinition {
  id: string;
  name: string;
  region: string;
  color: string;
  description: string;
  docUrl: string;
  fields: CredentialField[];
}

/** Estado de conexión de una red */
export type NetworkStatus = 'connected' | 'pending' | 'error';

/** Vista pública de una red (sin secretos) */
export interface NetworkView {
  id: string;
  name: string;
  region: string;
  color: string;
  description: string;
  docUrl: string;
  fields: Array<CredentialField & { hasValue: boolean }>;
  status: NetworkStatus;
  statusDetail?: string;
  validatedAt?: string;
}

/** Producto normalizado devuelto por cualquier conector */
export interface UnifiedProduct {
  network: string;
  externalId: string;
  title: string;
  description: string;
  price: number;
  originalPrice?: number;
  currency: string;
  image: string;
  /** Galería completa de imágenes del producto (todas las fotos disponibles de la red). */
  gallery?: string[];
  category: string;
  productUrl: string;
  commissionRate?: number;
  commissionAmount?: number;
  rating?: number;
  reviewsCount?: number;
  popularity?: number;
  /** Visitas del producto cuando la red las facilita (AliExpress no las da). */
  visits?: number;
  inStock: boolean;
  shippingInfo?: string;
  estimated: boolean;
  /** Datos extra de la red (tienda, ventas, alcance, descuento, enlace de afiliado…). */
  extra?: Record<string, string | number | boolean | null>;
}

/** Parámetros de búsqueda unificada */
export interface UnifiedSearchParams {
  query?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  minCommission?: number;
  minRating?: number;
  inStockOnly?: boolean;
  networks?: string[];
  sortBy?: 'commission' | 'price_asc' | 'price_desc' | 'rating' | 'popularity';
  limit?: number;
  /** Página de resultados (AliExpress TOP admite page_no; las demás redes lo ignoran). */
  page?: number;
}

/** Resultado por red (incluye errores parciales) */
export interface NetworkSearchResult {
  network: string;
  ok: boolean;
  message?: string;
  products: UnifiedProduct[];
}

/** Respuesta agregada del buscador global */
export interface UnifiedSearchResponse {
  success: boolean;
  query: UnifiedSearchParams;
  total: number;
  results: UnifiedProduct[];
  byNetwork: NetworkSearchResult[];
  searchedAt: string;
}
