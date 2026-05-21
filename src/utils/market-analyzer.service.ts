import {
  ExchangeConfig,
  MarketAnalysis,
  MarketSnapshot,
} from "./../interfaces/Pricing.type";

export class MarketAnalyzer {
  constructor(private config: ExchangeConfig) {}

  analyze(snapshot: MarketSnapshot): MarketAnalysis {
    const rates = snapshot.externalRates;
    const metrics = snapshot.systemMetrics;

    if (rates.length === 0 && !(metrics.fix_banxico && metrics.fix_banxico > 10)) {
      throw new Error("No external rates available to analyze");
    }

    const avgBuy  = rates.length > 0 ? this.average(rates.map((r) => r.buyRate)) : metrics.fix_banxico!;
    const avgSell = rates.length > 0 ? this.average(rates.map((r) => r.sellRate)) : metrics.fix_banxico!;
    const externalMidpoint = (avgBuy + avgSell) / 2;

    // ── ANCLA DEL PRECIO DE REFERENCIA ─────────────────────────────
    // Prioridad: FIX Banxico (tipo de cambio interbancario oficial)
    // Fallback:  Promedio del mercado externo regional (cuando no hay FIX)
    //
    // El FIX es publicado por Banxico a las ~12pm cada día hábil.
    // Antes de esa hora, el sistema usa el último FIX disponible (cacheado en BD).
    let referenceBaseRate: number;
    let referenceSource: MarketAnalysis['referenceSource'];

    if (metrics.fix_banxico && metrics.fix_banxico > 10) {
      referenceBaseRate = metrics.fix_banxico;
      referenceSource   = 'fix_banxico';
    } else {
      // Sin FIX disponible → usamos el punto medio del mercado externo regional
      referenceBaseRate = externalMidpoint;
      referenceSource   = 'external_avg';
    }

    // Cuánto se aleja el mercado regional del FIX oficial
    // Positivo = el mercado regional es más caro que el FIX
    // Negativo = el mercado regional está por debajo del FIX
    const fixDeviation = metrics.fix_banxico
      ? externalMidpoint - metrics.fix_banxico
      : 0;

    // ── VOLATILIDAD ───────────────────────────────────────
    const spreadDispersion = this.coefficientOfVariation(rates.map((r) => r.sellRate));
    const temporalChange   = this.calcTemporalChange(snapshot);
    const volatilityScore  = Math.min(1, spreadDispersion * 0.5 + temporalChange * 0.5);

    // ── PRESIÓN DE INVENTARIO ──────────────────────────────
    // > 0 = exceso de USD en caja (hay que vender)
    // < 0 = escasez de USD (hay que comprar o ser más agresivo)
    let inventoryPressure = 0;
    if (this.config.targetUsdInventory > 0 && metrics.usd_inventory !== undefined) {
      inventoryPressure = (metrics.usd_inventory - this.config.targetUsdInventory) / this.config.targetUsdInventory;
    }

    // ── NIVEL DE DEMANDA (ESCALONES DE MIGUEL) ──────────────────
    // Por cada N operaciones de venta (la casa vendió USD al cliente), subimos 1 escalón
    let sellDemandLevel = 0;
    if (this.config.operationsThreshold > 0 && metrics.total_sell_operations !== undefined) {
      sellDemandLevel = Math.floor(metrics.total_sell_operations / this.config.operationsThreshold);
    }

    const isVolatile = volatilityScore >= this.config.volatilityThreshold;
    const marketCondition: MarketAnalysis["marketCondition"] =
      volatilityScore < 0.3 ? "stable"
      : volatilityScore < 0.6 ? "moderate"
      : "volatile";

    return {
      averageExternalBuy: avgBuy,
      averageExternalSell: avgSell,
      referenceBaseRate,
      referenceSource,
      fixDeviation,
      volatilityScore,
      inventoryPressure,
      sellDemandLevel,
      fifoAverageCost: typeof metrics.fifo_avg_cost === "number" && metrics.fifo_avg_cost > 0
        ? metrics.fifo_avg_cost
        : null,
      isVolatile,
      marketCondition,
    };
  }

  private calcTemporalChange(snapshot: MarketSnapshot): number {
    if (!snapshot.previousSnapshot) return 0;
    const prev = snapshot.previousSnapshot.externalRates;
    const curr = snapshot.externalRates;
    if (prev.length === 0 || curr.length === 0) return 0;
    const prevAvg = this.average(prev.map((r) => r.sellRate));
    const currAvg = this.average(curr.map((r) => r.sellRate));
    return Math.abs((currAvg - prevAvg) / prevAvg);
  }

  private average(values: number[]): number {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private coefficientOfVariation(values: number[]): number {
    const avg = this.average(values);
    if (avg === 0) return 0;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
    return Math.sqrt(variance) / avg;
  }
}
