import OpenAI from "openai";
import {
  Alert,
  ExchangeConfig,
  MarketAnalysis,
  PriceAdjustment,
} from "./../interfaces/Pricing.type";

const REASON_LABELS: Record<string, string> = {
  high_buy_pressure: "alta presión compradora",
  high_sell_pressure: "alta presión vendedora",
  volatile_market: "mercado volátil",
  stable_market: "mercado estable",
  no_change: "sin cambios significativos",
};

export class GptExplainer {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async explain(
    analysis: MarketAnalysis,
    adjustment: PriceAdjustment,
    alerts: Alert[],
    config: ExchangeConfig
  ): Promise<{ explanation: string; marginSuggestion: string }> {
    const context = this.buildContext(analysis, adjustment, alerts, config);

    const response = await this.client.chat.completions.create({
      model: "gpt-4o-mini", // Suficiente para explicaciones, más económico
      temperature: 0.3, // Bajo para respuestas consistentes y precisas
      messages: [
        {
          role: "system",
          content: `Eres el asistente de análisis de una casa de cambio. 
Tu rol es ÚNICAMENTE explicar decisiones de precio que ya fueron tomadas por el sistema, 
y sugerir estrategias de margen. 
Sé conciso, profesional y usa lenguaje que un operador de cambio entienda.
Responde siempre en español. NO inventes datos ni tomes decisiones.`,
        },
        {
          role: "user",
          content: context,
        },
      ],
      functions: [
        {
          name: "provide_pricing_analysis",
          description:
            "Proporciona la explicación del ajuste de precio y una sugerencia de estrategia de margen",
          parameters: {
            type: "object",
            properties: {
              explanation: {
                type: "string",
                description:
                  "Explicación clara de por qué el sistema ajustó los precios de esta manera (máx 3 oraciones)",
              },
              marginSuggestion: {
                type: "string",
                description:
                  "Sugerencia de estrategia de margen para las próximas horas, basada en la condición actual del mercado (máx 2 oraciones)",
              },
            },
            required: ["explanation", "marginSuggestion"],
          },
        },
      ],
      function_call: { name: "provide_pricing_analysis" },
    });

    const fnCall = response.choices[0]?.message?.function_call;
    if (!fnCall?.arguments) {
      return {
        explanation: "No se pudo generar la explicación automática.",
        marginSuggestion: "Revisar manualmente las condiciones del mercado.",
      };
    }

    const parsed = JSON.parse(fnCall.arguments);
    return {
      explanation: parsed.explanation,
      marginSuggestion: parsed.marginSuggestion,
    };
  }

  private buildContext(
    analysis: MarketAnalysis,
    adjustment: PriceAdjustment,
    alerts: Alert[],
    config: ExchangeConfig
  ): string {
    const alertSummary =
      alerts.length > 0
        ? alerts.map((a) => `• [${a.severity.toUpperCase()}] ${a.message}`).join("\n")
        : "• Sin alertas activas";

    return `
## Situación actual del mercado ${config.baseCurrency}/${config.quoteCurrency}

**Análisis de mercado:**
- Promedio externo compra: ${analysis.averageExternalBuy.toFixed(4)}
- Promedio externo venta: ${analysis.averageExternalSell.toFixed(4)}
- Score de volatilidad: ${(analysis.volatilityScore * 100).toFixed(1)}% (${analysis.marketCondition})
- Presión compradora/vendedora: ${(analysis.buyPressure * 100).toFixed(1)}% (positivo = compradora)
- Dispersión entre fuentes: ${(analysis.spreadDispersion * 100).toFixed(2)}%

**Decisión tomada por el sistema:**
- Razón del ajuste: ${REASON_LABELS[adjustment.adjustmentReason]}
- Precio compra ajustado: ${adjustment.adjustedBuyRate.toFixed(4)} (delta: ${adjustment.buyDelta >= 0 ? "+" : ""}${adjustment.buyDelta.toFixed(4)})
- Precio venta ajustado: ${adjustment.adjustedSellRate.toFixed(4)} (delta: ${adjustment.sellDelta >= 0 ? "+" : ""}${adjustment.sellDelta.toFixed(4)})
- Margen aplicado: ${adjustment.margin.toFixed(2)}%

**Alertas generadas:**
${alertSummary}

Por favor explica esta decisión y sugiere una estrategia de margen.
    `.trim();
  }
}