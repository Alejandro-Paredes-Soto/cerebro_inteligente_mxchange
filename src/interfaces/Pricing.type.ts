export interface ExternalRate {
  source: string; // nombre de la API: "api1", "api2", "api3"
  buyRate: number; // tipo de cambio compra
  sellRate: number; // tipo de cambio venta
  fetchedAt: Date;
}

export interface MarketSnapshot {
  externalRates: ExternalRate[];
  previousSnapshot?: MarketSnapshot;
  timestamp: Date;
}

export interface MarketAnalysis {
  averageExternalBuy: number;
  averageExternalSell: number;
  volatilityScore: number; // 0 a 1 (0 = estable, 1 = muy volátil)
  buyPressure: number; // -1 a 1 (negativo = presión vendedora, positivo = compradora)
  spreadDispersion: number; // qué tan dispersos están los valores entre APIs
  isVolatile: boolean;
  marketCondition: "stable" | "moderate" | "volatile";
}

export interface PriceAdjustment {
  baseBuyRate: number;
  baseSellRate: number;
  adjustedBuyRate: number;
  adjustedSellRate: number;
  margin: number; // margen aplicado en porcentaje
  buyDelta: number; // diferencia vs precio anterior
  sellDelta: number;
  adjustmentReason: AdjustmentReason;
}

export type AdjustmentReason =
  | "high_buy_pressure" // mucha gente queriendo comprar
  | "high_sell_pressure" // mucha gente queriendo vender
  | "volatile_market" // mercado volátil, ampliar margen
  | "stable_market" // mercado estable, reducir margen
  | "no_change"; // sin cambios significativos

export interface Alert {
  type: AlertType;
  severity: "info" | "warning" | "critical";
  message: string;
  triggeredAt: Date;
  data: Record<string, unknown>;
}

export type AlertType =
  | "significant_rate_change"
  | "high_volatility"
  | "market_stabilized"
  | "spread_anomaly";

export interface SmartPricingResult {
  analysis: MarketAnalysis;
  adjustment: PriceAdjustment;
  alerts: Alert[];
  explanation: string; // generada por GPT
  marginSuggestion: string; // sugerencia de estrategia por GPT
  processedAt: Date;
}

// Config de tu casa de cambio
export interface ExchangeConfig {
  currentBuyRate: number;
  currentSellRate: number;
  baseCurrency: string; // ej: "USD"
  quoteCurrency: string; // ej: "MXN"
  minMarginPercent: number; // margen mínimo permitido
  maxMarginPercent: number; // margen máximo permitido
  defaultMarginPercent: number;
  volatilityThreshold: number; // 0-1, a partir de qué score se considera volátil
  pressureThreshold: number; // 0-1, a partir de qué score hay "mucha" presión
  significantChangePercent: number; // % mínimo para disparar alerta
}