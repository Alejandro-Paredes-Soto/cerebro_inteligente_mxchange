import {
  ExchangeConfig,
  MarketAnalysis,
  MarketSnapshot,
} from "./../interfaces/Pricing.type";

export class MarketAnalyzer {
  constructor(private config: ExchangeConfig) {}

  analyze(snapshot: MarketSnapshot): MarketAnalysis {
    const rates = snapshot.externalRates;

    if (rates.length === 0) {
      throw new Error("No external rates available to analyze");
    }

    const avgBuy = this.average(rates.map((r) => r.buyRate));
    const avgSell = this.average(rates.map((r) => r.sellRate));

    // Dispersión entre APIs: qué tan distintos son los valores (0 = todos iguales)
    const spreadDispersion = this.coefficientOfVariation(
      rates.map((r) => r.sellRate)
    );

    // Volatilidad: combina dispersión actual + cambio vs snapshot anterior
    const temporalChange = this.calcTemporalChange(snapshot);
    const volatilityScore = Math.min(
      1,
      spreadDispersion * 0.5 + temporalChange * 0.5
    );

    // Presión compradora: si nuestro precio de venta está por debajo del mercado,
    // la gente querrá comprar más (presión positiva).
    // Si nuestro precio de compra está muy por encima del mercado, presión vendedora (negativo).
    const sellGap = (avgSell - this.config.currentSellRate) / avgSell;
    const buyGap = (this.config.currentBuyRate - avgBuy) / avgBuy;
    const buyPressure = this.clamp((sellGap - buyGap) / 2, -1, 1);

    const isVolatile = volatilityScore >= this.config.volatilityThreshold;
    const marketCondition: MarketAnalysis["marketCondition"] =
      volatilityScore < 0.3
        ? "stable"
        : volatilityScore < 0.6
        ? "moderate"
        : "volatile";

    return {
      averageExternalBuy: avgBuy,
      averageExternalSell: avgSell,
      volatilityScore,
      buyPressure,
      spreadDispersion,
      isVolatile,
      marketCondition,
    };
  }

  private calcTemporalChange(snapshot: MarketSnapshot): number {
    if (!snapshot.previousSnapshot) return 0;

    const prev = snapshot.previousSnapshot.externalRates;
    const curr = snapshot.externalRates;

    if (prev.length === 0) return 0;

    const prevAvg = this.average(prev.map((r) => r.sellRate));
    const currAvg = this.average(curr.map((r) => r.sellRate));

    return Math.abs((currAvg - prevAvg) / prevAvg);
  }

  private average(values: number[]): number {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  // Coeficiente de variación: std / media → mide dispersión relativa
  private coefficientOfVariation(values: number[]): number {
    const avg = this.average(values);
    if (avg === 0) return 0;
    const variance =
      values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
    return Math.sqrt(variance) / avg;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}