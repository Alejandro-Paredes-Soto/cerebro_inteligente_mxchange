import {
  Alert,
  ExchangeConfig,
  MarketAnalysis,
  MarketSnapshot,
  PriceAdjustment,
} from "./../interfaces/Pricing.type";

export class AlertService {
  constructor(private config: ExchangeConfig) {}

  evaluate(
    analysis: MarketAnalysis,
    adjustment: PriceAdjustment,
    snapshot: MarketSnapshot
  ): Alert[] {
    const alerts: Alert[] = [];
    const now = new Date();

    // Alerta 1: Cambio significativo en el tipo de cambio respecto al snapshot anterior
    if (snapshot.previousSnapshot) {
      const prevRates = snapshot.previousSnapshot.externalRates;
      const currRates = snapshot.externalRates;

      if (prevRates.length > 0 && currRates.length > 0) {
        const prevAvgSell =
          prevRates.reduce((s, r) => s + r.sellRate, 0) / prevRates.length;
        const currAvgSell =
          currRates.reduce((s, r) => s + r.sellRate, 0) / currRates.length;
        const changePercent =
          Math.abs((currAvgSell - prevAvgSell) / prevAvgSell) * 100;

        if (changePercent >= this.config.significantChangePercent) {
          alerts.push({
            type: "significant_rate_change",
            severity: changePercent >= 2 ? "critical" : "warning",
            message: `El tipo de cambio cambió ${changePercent.toFixed(2)}% respecto al período anterior.`,
            triggeredAt: now,
            data: {
              previousAvgSell: prevAvgSell,
              currentAvgSell: currAvgSell,
              changePercent,
            },
          });
        }
      }
    }

    // Alerta 2: Alta volatilidad detectada
    if (analysis.isVolatile) {
      alerts.push({
        type: "high_volatility",
        severity: analysis.volatilityScore >= 0.8 ? "critical" : "warning",
        message: `Volatilidad elevada detectada (score: ${(analysis.volatilityScore * 100).toFixed(1)}%). Margen ampliado a ${adjustment.margin.toFixed(2)}%.`,
        triggeredAt: now,
        data: {
          volatilityScore: analysis.volatilityScore,
          spreadDispersion: analysis.spreadDispersion,
          appliedMargin: adjustment.margin,
        },
      });
    }

    // Alerta 3: Mercado se estabilizó (condición estable + venía de volatilidad)
    if (
      analysis.marketCondition === "stable" &&
      adjustment.adjustmentReason === "stable_market"
    ) {
      alerts.push({
        type: "market_stabilized",
        severity: "info",
        message: `Mercado estable. Margen reducido a ${adjustment.margin.toFixed(2)}% para mayor competitividad.`,
        triggeredAt: now,
        data: {
          volatilityScore: analysis.volatilityScore,
          appliedMargin: adjustment.margin,
        },
      });
    }

    // Alerta 4: Anomalía de spread entre APIs (una API muy desviada del resto)
    const sellRates = snapshot.externalRates.map((r) => r.sellRate);
    const anomaly = this.detectOutlier(sellRates);
    if (anomaly) {
      alerts.push({
        type: "spread_anomaly",
        severity: "warning",
        message: `Una fuente externa tiene un tipo de cambio muy distinto al resto (${anomaly.source}: ${anomaly.value.toFixed(4)} vs promedio ${anomaly.average.toFixed(4)}).`,
        triggeredAt: now,
        data: anomaly,
      });
    }

    return alerts;
  }

  private detectOutlier(
    values: number[]
  ): { source: string; value: number; average: number; deviationPercent: number } | null {
    if (values.length < 3) return null;

    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const threshold = 0.015; // 1.5% de desviación = anomalía

    for (let i = 0; i < values.length; i++) {
      const deviation = Math.abs((values[i]! - avg) / avg);
      if (deviation > threshold) {
        return {
          source: `api${i + 1}`,
          value: values[i]!,
          average: avg,
          deviationPercent: deviation * 100,
        };
      }
    }

    return null;
  }
}