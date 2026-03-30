import {
  AdjustmentReason,
  ExchangeConfig,
  MarketAnalysis,
  PriceAdjustment,
} from "./../interfaces/Pricing.type"
export class PriceAdjuster {
  constructor(private config: ExchangeConfig) {}

  /**
   * Aplica las 4 reglas del negocio de forma determinista.
   * GPT no participa aquí — solo explica el resultado después.
   */
  adjust(analysis: MarketAnalysis): PriceAdjustment {
    const { reason, marginPercent } = this.selectStrategy(analysis);

    // El precio base lo tomamos del promedio externo (referencia de mercado)
    const baseBuyRate = analysis.averageExternalBuy;
    const baseSellRate = analysis.averageExternalSell;

    // Aplicamos el margen: compramos más barato, vendemos más caro
    const halfMargin = marginPercent / 2;
    const adjustedBuyRate = baseBuyRate * (1 - halfMargin / 100);
    const adjustedSellRate = baseSellRate * (1 + halfMargin / 100);

    return {
      baseBuyRate,
      baseSellRate,
      adjustedBuyRate,
      adjustedSellRate,
      margin: marginPercent,
      buyDelta: adjustedBuyRate - this.config.currentBuyRate,
      sellDelta: adjustedSellRate - this.config.currentSellRate,
      adjustmentReason: reason,
    };
  }

  private selectStrategy(analysis: MarketAnalysis): {
    reason: AdjustmentReason;
    marginPercent: number;
  } {
    const {
      defaultMarginPercent,
      minMarginPercent,
      maxMarginPercent,
      volatilityThreshold,
      pressureThreshold,
    } = this.config;

    const { buyPressure, volatilityScore, isVolatile } = analysis;
    const hasBuyPressure = buyPressure > pressureThreshold;
    const hasSellPressure = buyPressure < -pressureThreshold;

    // Regla 1: Mucha gente queriendo COMPRAR → sube precio de venta
    if (hasBuyPressure && !isVolatile) {
      const boost = this.scale(buyPressure, pressureThreshold, 1, 0, 0.5);
      return {
        reason: "high_buy_pressure",
        marginPercent: this.clamp(
          defaultMarginPercent + boost,
          minMarginPercent,
          maxMarginPercent
        ),
      };
    }

    // Regla 2: Mucha gente queriendo VENDER → baja precio de compra
    if (hasSellPressure && !isVolatile) {
      const reduction = this.scale(
        Math.abs(buyPressure),
        pressureThreshold,
        1,
        0,
        0.5
      );
      return {
        reason: "high_sell_pressure",
        marginPercent: this.clamp(
          defaultMarginPercent - reduction,
          minMarginPercent,
          maxMarginPercent
        ),
      };
    }

    // Regla 3: Mercado volátil → ampliar margen para proteger ganancia
    if (isVolatile) {
      const extra = this.scale(
        volatilityScore,
        volatilityThreshold,
        1,
        0,
        0.8
      );
      return {
        reason: "volatile_market",
        marginPercent: this.clamp(
          defaultMarginPercent + extra,
          minMarginPercent,
          maxMarginPercent
        ),
      };
    }

    // Regla 4: Mercado estable → reducir margen para ser más competitivo
    if (analysis.marketCondition === "stable") {
      const reduction = this.scale(
        1 - volatilityScore,
        0,
        1 - volatilityThreshold,
        0,
        0.3
      );
      return {
        reason: "stable_market",
        marginPercent: this.clamp(
          defaultMarginPercent - reduction,
          minMarginPercent,
          maxMarginPercent
        ),
      };
    }

    return { reason: "no_change", marginPercent: defaultMarginPercent };
  }

  /**
   * Escala un valor de [inMin, inMax] a [outMin, outMax]
   */
  private scale(
    value: number,
    inMin: number,
    inMax: number,
    outMin: number,
    outMax: number
  ): number {
    const ratio = Math.min(1, Math.max(0, (value - inMin) / (inMax - inMin)));
    return outMin + ratio * (outMax - outMin);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}