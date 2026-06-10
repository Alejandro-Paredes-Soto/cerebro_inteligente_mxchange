import {
  AdjustmentReason,
  ExchangeConfig,
  MarketAnalysis,
  PriceAdjustment,
} from "./../interfaces/Pricing.type";

export class PriceAdjuster {
  constructor(private config: ExchangeConfig) {}

  adjust(analysis: MarketAnalysis): PriceAdjustment {
    const { reason, buySpread, sellSpread } = this.selectStrategy(analysis);
    const strategyBuySpread = buySpread;
    const strategySellSpread = sellSpread;

    const baseRate = analysis.referenceBaseRate;
    const adjustedBuyRate = baseRate - buySpread;
    let adjustedSellRate = baseRate + sellSpread;
    const minSafeSellRate = analysis.fifoAverageCost != null
      ? analysis.fifoAverageCost + this.config.minSpreadCents
      : null;
    const fifoProtectionApplied = minSafeSellRate != null && adjustedSellRate < minSafeSellRate;

    let fifoExtraSellSpread = 0;
    if (fifoProtectionApplied && minSafeSellRate != null) {
      fifoExtraSellSpread = minSafeSellRate - adjustedSellRate;
      adjustedSellRate = minSafeSellRate;
    }

    return {
      baseBuyRate: baseRate,
      baseSellRate: baseRate,
      adjustedBuyRate,
      adjustedSellRate,
      buySpread,
      sellSpread: adjustedSellRate - baseRate,
      strategyBuySpread,
      strategySellSpread,
      buyDelta: adjustedBuyRate - this.config.currentBuyRate,
      sellDelta: adjustedSellRate - this.config.currentSellRate,
      adjustmentReason: reason,
      fifoProtectionApplied,
      fifoExtraSellSpread,
      minSafeSellRate,
    };
  }

  private selectStrategy(analysis: MarketAnalysis): {
    reason: AdjustmentReason;
    buySpread: number;
    sellSpread: number;
  } {
    const {
      minSpreadCents,
      startingSpreadCents,
      maxSpreadCents,
      centsStepUp,
    } = this.config;

    let buySpread  = startingSpreadCents;
    let sellSpread = startingSpreadCents;
    let reason: AdjustmentReason = "stable_market";

    // ── Regla 1: Alta demanda de venta (clientes compran USD → subir venta)
    if (analysis.sellDemandLevel > 0 && !analysis.isVolatile) {
      const extraCents = analysis.sellDemandLevel * centsStepUp;
      sellSpread = this.clamp(
        startingSpreadCents + extraCents,
        minSpreadCents,
        maxSpreadCents
      );
      reason = "high_local_demand";
    }

    // ── Regla 1b: Alta oferta de USD (clientes le venden USD a Miguel → bajar compra)
    if (
      analysis.buyDemandLevel > 0
      && !analysis.isVolatile
      && analysis.inventoryPressure <= 0.2
    ) {
      const extraCents = analysis.buyDemandLevel * centsStepUp;
      buySpread = this.clamp(
        startingSpreadCents - extraCents,
        minSpreadCents,
        startingSpreadCents
      );
      if (reason === "stable_market") {
        reason = "high_usd_offer";
      }
    }

    // ── Regla 2: Exceso de inventario USD en caja
    if (analysis.inventoryPressure > 0.2 && reason === "stable_market") {
      const reductionFactor = Math.min(analysis.inventoryPressure, 1.0);
      const reductionRange  = startingSpreadCents - minSpreadCents;
      sellSpread = this.clamp(
        startingSpreadCents - (reductionRange * reductionFactor),
        minSpreadCents,
        startingSpreadCents
      );
      buySpread = this.clamp(
        startingSpreadCents + (centsStepUp * 3 * reductionFactor),
        minSpreadCents,
        maxSpreadCents
      );
      reason = "excess_inventory";
    }

    // ── Regla 3: Mercado altamente volátil
    if (analysis.isVolatile) {
      buySpread  = maxSpreadCents;
      sellSpread = maxSpreadCents;
      reason = "volatile_market";
    }

    return { reason, buySpread, sellSpread };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
