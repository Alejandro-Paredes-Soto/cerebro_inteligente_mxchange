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

    // El precio base ancla (ej. el FIX o promedio de bancos locales)
    const baseRate = analysis.referenceBaseRate;

    // Aplicamos el spread en centavos (Miguel garantiza sus centavos)
    const adjustedBuyRate = baseRate - buySpread;
    let adjustedSellRate = baseRate + sellSpread;
    const minSafeSellRate = analysis.fifoAverageCost != null
      ? analysis.fifoAverageCost + this.config.minSpreadCents
      : null;
    const fifoProtectionApplied = minSafeSellRate != null && adjustedSellRate < minSafeSellRate;

    if (fifoProtectionApplied && minSafeSellRate != null) {
      adjustedSellRate = minSafeSellRate;
    }

    return {
      baseBuyRate: baseRate,
      baseSellRate: baseRate,
      adjustedBuyRate,
      adjustedSellRate,
      buySpread,
      sellSpread: adjustedSellRate - baseRate,
      buyDelta: adjustedBuyRate - this.config.currentBuyRate,
      sellDelta: adjustedSellRate - this.config.currentSellRate,
      adjustmentReason: reason,
      fifoProtectionApplied,
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

    // Punto de partida: spread de arranque del día (ej. 25¢)
    // El piso nunca se cruza: minSpreadCents (ej. 20¢)
    let buySpread  = startingSpreadCents;
    let sellSpread = startingSpreadCents;
    let reason: AdjustmentReason = "stable_market";

    // ── Regla 1: Alta demanda de venta (le compran muchos USD a Miguel)
    // El mercado quiere dólares → Miguel puede subir el precio de venta.
    // Subimos sell spread por escalones desde el precio de arranque.
    // La compra se mantiene en el precio de arranque (no cambia).
    if (analysis.sellDemandLevel > 0 && !analysis.isVolatile) {
      const extraCents = analysis.sellDemandLevel * centsStepUp;
      sellSpread = this.clamp(
        startingSpreadCents + extraCents,
        minSpreadCents,
        maxSpreadCents
      );
      reason = "high_local_demand";
    }

    // ── Regla 2: Exceso de inventario USD en caja
    // Miguel tiene más USD de los que quiere → necesita vender.
    // Bajamos el precio de venta (sell spread) desde el arranque hacia el mínimo,
    // proporcionalmente al exceso. Esto hace la oferta más atractiva.
    // También penalizamos la compra (buy spread sube) para desincentivar que le traigan más USD.
    if (analysis.inventoryPressure > 0.2 && reason === "stable_market") {
      // Cuánto bajamos la venta: proporcional al exceso, hasta llegar al mínimo
      const reductionFactor = Math.min(analysis.inventoryPressure, 1.0); // 0..1
      const reductionRange  = startingSpreadCents - minSpreadCents;      // ej: 25¢ - 20¢ = 5¢
      sellSpread = this.clamp(
        startingSpreadCents - (reductionRange * reductionFactor),
        minSpreadCents,
        startingSpreadCents
      );
      // Penalizamos la compra: mientras más exceso, menos pagamos por USD que nos traigan
      buySpread = this.clamp(
        startingSpreadCents + (centsStepUp * 3 * reductionFactor),
        minSpreadCents,
        maxSpreadCents
      );
      reason = "excess_inventory";
    }

    // ── Regla 3: Mercado altamente volátil
    // Abrimos ambos spreads al máximo para proteger la ganancia ante movimientos bruscos.
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
