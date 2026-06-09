import { ExternalRate } from "../interfaces/Pricing.type";
import { rateScrape, scrapeProviderLabel } from "./rate-scrape.providers";

type ScraperLogLevel = "info" | "warn" | "error";

export type ExternalRatesScraperEvent = {
  level: ScraperLogLevel;
  message: string;
  data?: Record<string, unknown>;
};

export type RegionalCompetitorScrapeSource = {
  id: number;
  name: string;
  url: string;
  manualBuyRate: number | null;
  manualSellRate: number | null;
  fetchedAt: Date | null;
};

export type RegionalCompetitorScrapeStatus = {
  id: number;
  source: string;
  configuredName: string;
  scrapedName: string | null;
  url: string | null;
  status: "success" | "failed" | "manual_fallback" | "manual" | "skipped";
  buyRate: number | null;
  sellRate: number | null;
  message: string;
  checkedAt: string | null;
  usedSource: "scrape" | "manual" | "none";
};

export type RegionalCompetitorScrapeResult = {
  rates: ExternalRate[];
  statuses: RegionalCompetitorScrapeStatus[];
};

type ExternalRatesScraperOptions = {
  onEvent?: (event: ExternalRatesScraperEvent) => void;
};

const MIN_RATE = 10;
const MAX_RATE = 30;

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isPlausibleRate(buyRate: number, sellRate: number): boolean {
  if (!Number.isFinite(buyRate) || !Number.isFinite(sellRate)) return false;
  if (buyRate <= MIN_RATE || buyRate >= MAX_RATE || sellRate <= MIN_RATE || sellRate >= MAX_RATE) return false;
  return sellRate >= buyRate;
}

function isPlausibleManualRate(buyRate: number | null, sellRate: number | null): boolean {
  if (buyRate === null || sellRate === null) return false;
  return isPlausibleRate(buyRate, sellRate);
}

function scrapedJsonToRate(
  json: unknown,
  sourceName: string,
  fetchedAt: Date
): { rate: ExternalRate | null; title: string | null } {
  const obj = (json ?? {}) as Record<string, unknown>;
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : null;
  const buyRate = Number(obj.compra);
  const sellRate = Number(obj.venta);
  if (!isPlausibleRate(buyRate, sellRate)) return { rate: null, title };
  return { rate: { source: sourceName, buyRate, sellRate, fetchedAt }, title };
}

export class ExternalRatesScraper {
  private readonly providerLabel: string;
  private readonly onEvent: ((event: ExternalRatesScraperEvent) => void) | undefined;

  constructor(options: ExternalRatesScraperOptions = {}) {
    this.providerLabel = scrapeProviderLabel();
    this.onEvent = options.onEvent;
  }

  async scrapeRegionalCompetitors(sources: RegionalCompetitorScrapeSource[]): Promise<RegionalCompetitorScrapeResult> {
    const fetchedAt = new Date();
    const rates: ExternalRate[] = [];
    const statuses: RegionalCompetitorScrapeStatus[] = [];

    if (!sources.length) return { rates, statuses };

    this.emit("info", `Consultando competencia regional con ${this.providerLabel}`, {
      count: sources.length,
      sources: sources.map((source) => source.name),
    });

    for (const source of sources) {
      const { json, error } = await rateScrape(source.url);
      const extracted = json ? scrapedJsonToRate(json, source.name, fetchedAt) : { rate: null, title: null };

      if (extracted.rate) {
        const rate: ExternalRate = { ...extracted.rate, origin: "regional" };
        rates.push(rate);
        this.emit("info", `Competidor regional extraído con ${this.providerLabel}`, {
          source: source.name,
          url: source.url,
          title: extracted.title,
          buyRate: rate.buyRate,
          sellRate: rate.sellRate,
        });
        statuses.push({
          id: source.id,
          source: source.name,
          configuredName: source.name,
          scrapedName: extracted.title,
          url: source.url,
          status: "success",
          buyRate: rate.buyRate,
          sellRate: rate.sellRate,
          message: `Extraído con ${this.providerLabel} (JSON estructurado).`,
          checkedAt: fetchedAt.toISOString(),
          usedSource: "scrape",
        });
        continue;
      }

      const failureMessage = error || `${this.providerLabel} no devolvió compra/venta USD válidas para esta página.`;
      const fallback = this.buildRegionalFailureStatus(source, fetchedAt, failureMessage);
      statuses.push(fallback.status);
      if (fallback.rate) rates.push(fallback.rate);
    }

    return { rates, statuses };
  }

  async close() {
    // Crawl4AI es HTTP; no hay navegador local que cerrar.
  }

  private buildRegionalFailureStatus(
    source: RegionalCompetitorScrapeSource,
    fetchedAt: Date,
    message: string
  ): { rate: ExternalRate | null; status: RegionalCompetitorScrapeStatus } {
    const hasManualFallback = isPlausibleManualRate(source.manualBuyRate, source.manualSellRate);
    if (hasManualFallback && source.manualBuyRate !== null && source.manualSellRate !== null) {
      this.emit("warn", `Falló ${this.providerLabel}; usando la tasa manual del competidor`, {
        source: source.name,
        url: source.url,
        error: message,
        buyRate: source.manualBuyRate,
        sellRate: source.manualSellRate,
      });

      return {
        rate: {
          source: source.name,
          buyRate: source.manualBuyRate,
          sellRate: source.manualSellRate,
          fetchedAt: source.fetchedAt ?? fetchedAt,
          origin: "regional",
        },
        status: {
          id: source.id,
          source: source.name,
          configuredName: source.name,
          scrapedName: null,
          url: source.url,
          status: "manual_fallback",
          buyRate: source.manualBuyRate,
          sellRate: source.manualSellRate,
          message: `${message} Se usó la tasa manual guardada como respaldo.`,
          checkedAt: fetchedAt.toISOString(),
          usedSource: "manual",
        },
      };
    }

    this.emit("warn", `Competidor regional omitido: ${this.providerLabel} falló y no hay respaldo manual`, {
      source: source.name,
      url: source.url,
      error: message,
    });

    return {
      rate: null,
      status: {
        id: source.id,
        source: source.name,
        configuredName: source.name,
        scrapedName: null,
        url: source.url,
        status: "failed",
        buyRate: null,
        sellRate: null,
        message,
        checkedAt: fetchedAt.toISOString(),
        usedSource: "none",
      },
    };
  }

  private emit(level: ScraperLogLevel, message: string, data?: Record<string, unknown>) {
    const event: ExternalRatesScraperEvent = { level, message };
    if (data) event.data = data;
    this.onEvent?.(event);
  }
}
