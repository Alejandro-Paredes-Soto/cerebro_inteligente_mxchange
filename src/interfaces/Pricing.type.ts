export interface ExternalRate {
  source: string; // nombre de la API: "api1", "api2", "api3" o "Monex", "Banxico"
  buyRate: number; // tipo de cambio compra
  sellRate: number; // tipo de cambio venta
  fetchedAt: Date;
  // origin: "regional" = competencia local de Sonora (sí jala el precio / ancla)
  //         "national" = scraping Monex/BBVA nacional (solo desviación, alertas y pantalla)
  origin?: "regional" | "national";
}

export interface SystemMetrics {
  buy_avg: number;
  sell_avg: number;
  fix_banxico: number | null;
  fifo_avg_cost: number | null;
  usd_inventory: number; // Cuántos dólares físicos hay en la caja
  total_buy_operations: number; // Cuántas veces el cliente ha VENDIDO USD a la casa
  total_sell_operations: number; // Cuántas veces el cliente ha COMPRADO USD a la casa
  daily_spread?: number;
  daily_profit_mxn?: number;
  // Promedios históricos (últimos ~14 días) para umbral dinámico de escalones
  avg_daily_buy_operations: number;
  avg_daily_sell_operations: number;
  effective_buy_threshold: number;
  effective_sell_threshold: number;
}

export interface MarketSnapshot {
  externalRates: ExternalRate[];
  systemMetrics: SystemMetrics; // Métricas reales del negocio
  previousSnapshot?: MarketSnapshot;
  timestamp: Date;
}

export interface MarketAnalysis {
  averageExternalBuy: number;
  averageExternalSell: number;
  referenceBaseRate: number;   // Ancla de precio: mezcla FIX + competencia regional, o el fallback disponible
  referenceSource: 'blended' | 'fix_banxico' | 'external_avg' | 'weighted_avg' | 'blended_weighted'; // De dónde viene la referencia
  regionalMidpoint: number | null; // Punto medio promedio de la competencia regional (Sonora). null si no hay.
  regionalAnchorWeight: number;    // Peso (0..1) que tuvo la competencia regional en el ancla mezclada
  fixDeviation: number;        // Cuánto se aleja el mercado regional del FIX (+ = regional más caro)
  volatilityScore: number;     // 0 a 1 (0 = estable, 1 = muy volátil)

  // Métricas locales de presión
  inventoryPressure: number;   // > 0 exceso de USD, < 0 escasez de USD
  sellDemandLevel: number;     // Escalones por demanda de venta (clientes compran USD)
  buyDemandLevel: number;      // Escalones por oferta de compra (clientes venden USD a la casa)
  effectiveSellThreshold: number; // Umbral dinámico de ventas (promedio histórico o config)
  effectiveBuyThreshold: number;  // Umbral dinámico de compras
  avgDailySellOperations: number;
  avgDailyBuyOperations: number;
  fifoAverageCost: number | null;

  isVolatile: boolean;
  marketCondition: "stable" | "moderate" | "volatile";
}

export interface PriceAdjustment {
  baseBuyRate: number;
  baseSellRate: number;
  adjustedBuyRate: number;
  adjustedSellRate: number;
  buySpread: number; // Margen en centavos aplicado a la compra (ej. 0.20)
  sellSpread: number; // Margen en centavos aplicado a la venta (efectivo, puede incluir FIFO)
  strategyBuySpread: number;  // Spread de compra decidido por estrategia (antes de candados)
  strategySellSpread: number; // Spread de venta decidido por estrategia (antes de FIFO)
  buyDelta: number; // diferencia vs precio anterior
  sellDelta: number;
  adjustmentReason: AdjustmentReason;
  fifoProtectionApplied: boolean;
  fifoExtraSellSpread: number; // Cuántos centavos subió la venta por protección FIFO (0 si no aplica)
  minSafeSellRate: number | null;
}

export type AdjustmentReason =
  | "high_local_demand" // El negocio está vendiendo muchos USD (subir centavos)
  | "high_usd_offer" // Muchos clientes le venden USD a la casa (bajar compra)
  | "excess_inventory" // El negocio tiene muchos USD (bajar precio de venta para sacar)
  | "volatile_market" // mercado volátil, proteger
  | "stable_market" // mercado estable, mantener base
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
  | "spread_anomaly"
  | "fifo_guardrail"
  | "inventory_warning"; // Alerta si hay demasiados o muy pocos dólares

export interface SmartPricingResult {
  analysis: MarketAnalysis;
  adjustment: PriceAdjustment;
  alerts: Alert[];
  processedAt: Date;
}

// Config de tu casa de cambio
export interface ExchangeConfig {
  currentBuyRate: number;
  currentSellRate: number;
  baseCurrency: string; // ej: "USD"
  quoteCurrency: string; // ej: "MXN"

  // REGLAS DE CENTAVOS
  // Ejemplo visual del día de Miguel:
  //   minSpreadCents     = 0.20  → Piso. NUNCA gana menos de 20¢. Línea roja.
  //   startingSpreadCents = 0.25  → Precio de arranque de la mañana. Tiene 5¢ de colchón.
  //   maxSpreadCents     = 0.30  → Techo. No subir más para no salirse del mercado.
  //
  //   Escenario exceso USD: venta baja de 25¢ → 24 → 23 → 22 → 21 → 20¢ (mínimo garantizado)
  //   Escenario alta demanda: venta sube de 25¢ → 26 → 27 → ... → 30¢ (techo)
  minSpreadCents: number;      // Piso mínimo de ganancia por operación (nunca cruzar)
  startingSpreadCents: number; // Spread de arranque del día (el colchón sobre el mínimo)
  maxSpreadCents: number;      // Techo máximo para no salirse de competencia

  // REGLAS DE DEMANDA LOCAL
  operationsThreshold: number; // Cada cuántas operaciones subimos 1 centavo (ej: 100)
  centsStepUp: number;         // Cuánto subimos por escalón (ej: 0.01)
  targetUsdInventory: number;  // Inventario sano deseado en USD (ej: 50,000)

  volatilityThreshold: number;       // 0-1, a partir de qué score se considera volátil
  significantChangePercent: number;  // % mínimo para disparar alerta

  // REFERENCIA CRUZADA (lo que pidió Miguel): el ancla no es solo el FIX, sino una
  // mezcla ponderada FIX + competencia regional de Sonora.
  //   referenceBaseRate = (1 - regionalAnchorWeight) * FIX + regionalAnchorWeight * regionalMidpoint
  // 0 = solo FIX (comportamiento anterior); 1 = solo competencia regional; 0.5 = mitad y mitad.
  regionalAnchorWeight: number;
}
