import { AlertService } from "./alert.service";
import { MarketAnalyzer } from "./market-analyzer.service";
import { PriceAdjuster } from "./price-adjuster.service";
import {
  ExchangeConfig,
  MarketSnapshot,
  SmartPricingResult,
} from "./../interfaces/Pricing.type";

export class SmartPricingEngine {
  private analyzer: MarketAnalyzer;
  private adjuster: PriceAdjuster;
  private alertService: AlertService;

  constructor(private config: ExchangeConfig) {
    this.analyzer = new MarketAnalyzer(config);
    this.adjuster = new PriceAdjuster(config);
    this.alertService = new AlertService(config);
  }

  async process(snapshot: MarketSnapshot): Promise<SmartPricingResult> {
    // 1. Analizar condición del mercado (pura lógica)
    const analysis = this.analyzer.analyze(snapshot);

    // 2. Calcular ajuste de precios (reglas deterministas)
    const adjustment = this.adjuster.adjust(analysis);

    // 3. Evaluar alertas
    const alerts = this.alertService.evaluate(analysis, adjustment, snapshot);


    return {
      analysis,
      adjustment,
      alerts,
      processedAt: new Date(),
    };
  }

  /**
   * Actualiza la config en runtime (ej: si el operador cambia los márgenes)
   */
  updateConfig(partial: Partial<ExchangeConfig>): void {
    this.config = { ...this.config, ...partial };
    this.analyzer = new MarketAnalyzer(this.config);
    this.adjuster = new PriceAdjuster(this.config);
    this.alertService = new AlertService(this.config);
  }
}