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

    // Solo la competencia REGIONAL (Sonora) alimenta el ancla. El scraping nacional
    // (origin "national") queda para desviación, alertas y pantalla, pero NO mueve el precio.
    const regionalRates = rates.filter((r) => r.origin === "regional");
    const regionalMidpoint = regionalRates.length > 0
      ? this.average(regionalRates.map((r) => (r.buyRate + r.sellRate) / 2))
      : null;

    // ── ANCLA DEL PRECIO DE REFERENCIA (referencia cruzada — Opción B) ──────
    // En lugar de usar solo el FIX, mezclamos FIX + competencia regional de Sonora:
    //   referenceBaseRate = (1 - w) * FIX + w * regionalMidpoint
    // donde w = regionalAnchorWeight. Esto es lo que pidió Miguel: que el precio
    // reaccione al mercado de su zona, no solo al interbancario nacional.
    //
    // Cadena de respaldo (nunca truena):
    //   1. FIX + regional → mezcla ponderada               (referenceSource "blended")
    //   2. Solo FIX                                          (referenceSource "fix_banxico")
    //   3. Solo regional / externo                           (referenceSource "external_avg")
    const hasFix = !!(metrics.fix_banxico && metrics.fix_banxico > 10);
    const w = this.clamp01(this.config.regionalAnchorWeight ?? 0);

    let referenceBaseRate: number;
    let referenceSource: MarketAnalysis['referenceSource'];
    let appliedRegionalWeight = 0;

    if (hasFix && regionalMidpoint != null && w > 0) {
      referenceBaseRate = (1 - w) * metrics.fix_banxico! + w * regionalMidpoint;
      referenceSource = 'blended';
      appliedRegionalWeight = w;
    } else if (hasFix) {
      referenceBaseRate = metrics.fix_banxico!;
      referenceSource = 'fix_banxico';
    } else {
      // Sin FIX → usamos el mercado disponible (regional si existe, si no el externo)
      referenceBaseRate = regionalMidpoint ?? externalMidpoint;
      referenceSource = 'external_avg';
      appliedRegionalWeight = regionalMidpoint != null ? 1 : 0;
    }

    // Cuánto se aleja el mercado regional del FIX oficial
    // Positivo = el mercado regional es más caro que el FIX
    // Negativo = el mercado regional está por debajo del FIX
    const marketMidpointForDeviation = regionalMidpoint ?? externalMidpoint;
    const fixDeviation = hasFix
      ? marketMidpointForDeviation - metrics.fix_banxico!
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
      regionalMidpoint,
      regionalAnchorWeight: appliedRegionalWeight,
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

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  private coefficientOfVariation(values: number[]): number {
    const avg = this.average(values);
    if (avg === 0) return 0;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
    return Math.sqrt(variance) / avg;
  }
}
