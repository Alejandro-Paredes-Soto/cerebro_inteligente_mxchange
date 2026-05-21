import { openai } from "@ai-sdk/openai";
import type LLMScraper from "llm-scraper";
import { chromium, type Browser } from "playwright";
import { z } from "zod";
import { ExternalRate } from "../interfaces/Pricing.type";

type ScraperLogLevel = "info" | "warn" | "error";

export type ExternalRatesScraperEvent = {
  level: ScraperLogLevel;
  message: string;
  data?: Record<string, unknown>;
};

export type ExternalRateSourceType = "official" | "public_table" | "fallback" | "cache" | "unavailable";

export type ExternalRateSourceStatus = {
  source: string;
  sourceType: ExternalRateSourceType;
  primaryUrl: string;
  fallbackUrl: string | null;
  url: string | null;
  buyRate: number | null;
  sellRate: number | null;
  message: string;
  checkedAt: string | null;
};

type ExternalRatesScraperOptions = {
  cacheMinutes?: number;
  timeoutMs?: number;
  model?: string;
  onEvent?: (event: ExternalRatesScraperEvent) => void;
};

type ScraperSource = {
  source: string;
  targetName: string;
  url: string;
  fallbackUrl?: string;
  strategy: "monex-official" | "llm-table";
};

type CacheEntry = {
  rates: ExternalRate[];
  fetchedAt: Date;
  expiresAt: number;
  lastError: string | null;
};

const DEFAULT_CACHE_MINUTES = 30;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL = "gpt-4o-mini";

const SOURCES: ScraperSource[] = [
  {
    source: "Monex",
    targetName: "Monex",
    url: "https://www.monex.com.mx/portal/inicio",
    fallbackUrl: "https://dolar.info/mexico/hoy/precio/",
    strategy: "monex-official",
  },
  {
    source: "BBVA Bancomer",
    targetName: "BBVA Bancomer",
    url: "https://dolar.info/mexico/hoy/precio/",
    strategy: "llm-table",
  },
];

const rateSchema = z.object({
  buyRate: z
    .number()
    .nullable()
    .describe("USD/MXN compra. The institution buys USD from the customer. Return only the numeric MXN rate."),
  sellRate: z
    .number()
    .nullable()
    .describe("USD/MXN venta. The institution sells USD to the customer. Return only the numeric MXN rate."),
  notes: z.string().nullable().optional().describe("Short explanation if buyRate or sellRate is not found."),
});

const SCRAPER_PROMPT = [
  "You extract public USD/MXN exchange rates from Mexican financial websites.",
  "Return the cash/window USD-MXN buy and sell rates only for the requested institution.",
  "buyRate means Compra: the institution buys USD from the customer.",
  "sellRate means Venta: the institution sells USD to the customer.",
  "Ignore FIX, euro, calculators, percentages, historical values, ads, and non-USD currencies.",
  "If a USD buy or sell value is not present on the page, return null for that field.",
].join(" ");

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeScraperData(data: unknown): unknown {
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

function toExternalRate(source: ScraperSource, data: unknown, fetchedAt: Date): ExternalRate | null {
  const raw = normalizeScraperData(data) as Record<string, unknown> | null;
  const buyRate = Number(raw?.buyRate);
  const sellRate = Number(raw?.sellRate);

  if (!Number.isFinite(buyRate) || !Number.isFinite(sellRate)) return null;
  if (buyRate <= 10 || buyRate >= 30 || sellRate <= 10 || sellRate >= 30) return null;
  if (sellRate < buyRate) return null;

  return {
    source: source.source,
    buyRate,
    sellRate,
    fetchedAt,
  };
}

function parseMonexOfficialHtml(source: ScraperSource, html: string, fetchedAt: Date): ExternalRate | null {
  const divisasMatch = html.match(/<div[^>]+id=["']divisas["'][\s\S]*?<\/div>\s*<\/div>\s*<div/i);
  const divisasHtml = divisasMatch?.[0] ?? html;
  const usdMatch = divisasHtml.match(/<strong>\s*USD\s*<\/strong>[\s\S]*?<span[^>]*>\s*([\d,.]+)\s*<\/span>[\s\S]*?<span[^>]*>\s*\/\s*<\/span>[\s\S]*?<span[^>]*>\s*([\d,.]+)\s*<\/span>/i);

  if (!usdMatch) return null;

  return toExternalRate(
    source,
    {
      buyRate: Number(String(usdMatch[1]).replace(/,/g, "")),
      sellRate: Number(String(usdMatch[2]).replace(/,/g, "")),
    },
    fetchedAt
  );
}

export class ExternalRatesScraper {
  private browser: Browser | null = null;
  private scraper: LLMScraper | null = null;
  private cache: CacheEntry | null = null;
  private refreshPromise: Promise<ExternalRate[]> | null = null;
  private sourceStatuses = new Map<string, ExternalRateSourceStatus>();
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly onEvent: ((event: ExternalRatesScraperEvent) => void) | undefined;

  constructor(options: ExternalRatesScraperOptions = {}) {
    this.cacheMs = Math.max(1, options.cacheMinutes ?? DEFAULT_CACHE_MINUTES) * 60 * 1000;
    this.timeoutMs = Math.max(5_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.model = options.model || DEFAULT_MODEL;
    this.onEvent = options.onEvent;
  }

  async getExternalRates(): Promise<ExternalRate[]> {
    if (this.isCacheFresh()) {
      this.emit("info", "Usando cache vigente de tasas externas", {
        cacheAgeMinutes: this.cache ? Math.round((Date.now() - this.cache.fetchedAt.getTime()) / 60000) : null,
        sources: this.cache?.rates.map((rate) => rate.source) ?? [],
      });
      return this.cache?.rates ?? [];
    }

    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.refreshRates().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  getCacheStatus() {
    return {
      hasCache: Boolean(this.cache),
      fetchedAt: this.cache?.fetchedAt.toISOString() ?? null,
      expiresAt: this.cache ? new Date(this.cache.expiresAt).toISOString() : null,
      sources: this.cache?.rates.map((rate) => rate.source) ?? [],
      lastError: this.cache?.lastError ?? null,
    };
  }

  getSourceStatuses(): ExternalRateSourceStatus[] {
    return SOURCES.map((source) => this.sourceStatuses.get(source.source) ?? {
      source: source.source,
      sourceType: "unavailable",
      primaryUrl: source.url,
      fallbackUrl: source.fallbackUrl ?? null,
      url: null,
      buyRate: null,
      sellRate: null,
      message: "Todavía no se ha consultado esta fuente en el ciclo actual.",
      checkedAt: null,
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private async refreshRates(): Promise<ExternalRate[]> {
    if (!process.env.OPENAI_API_KEY) {
      this.emit("warn", "OPENAI_API_KEY no está configurada; solo se intentarán fuentes que no requieren LLM");
    }

    this.emit("info", "Refrescando tasas externas reales", {
      model: this.model,
      timeoutMs: this.timeoutMs,
      sources: SOURCES.map((source) => source.source),
    });

    const fetchedAt = new Date();
    const results: ExternalRate[] = [];
    let lastError: string | null = null;

    this.sourceStatuses.clear();

    for (const source of SOURCES) {
      try {
        const rate = await this.scrapeSource(source, fetchedAt);
        if (rate) {
          results.push(rate);
          const status = this.sourceStatuses.get(source.source);
          this.emit("info", "Fuente externa scrapeada correctamente", {
            source: source.source,
            url: status?.url ?? source.url,
            sourceType: status?.sourceType ?? null,
            buyRate: rate.buyRate,
            sellRate: rate.sellRate,
          });
        } else {
          if (!this.sourceStatuses.has(source.source)) {
            this.setSourceStatus(source, {
              sourceType: "unavailable",
              url: source.url,
              buyRate: null,
              sellRate: null,
              message: "No se encontraron datos válidos de compra y venta USD/MXN.",
              checkedAt: fetchedAt.toISOString(),
            });
          }
          this.emit("warn", "Fuente externa omitida por datos inválidos o incompletos", {
            source: source.source,
            url: source.url,
          });
        }
      } catch (error) {
        lastError = sanitizeError(error);
        this.setSourceStatus(source, {
          sourceType: "unavailable",
          url: source.url,
          buyRate: null,
          sellRate: null,
          message: `Falló la consulta automática: ${lastError}`,
          checkedAt: fetchedAt.toISOString(),
        });
        this.emit("error", "Falló el scraping de una fuente externa", {
          source: source.source,
          url: source.url,
          error: lastError,
        });
      }
    }

    if (results.length === 0) {
      if (lastError) this.cache = this.cache ? { ...this.cache, lastError } : null;
      return this.fallbackToExpiredCacheOrEmpty();
    }

    this.cache = {
      rates: results,
      fetchedAt,
      expiresAt: Date.now() + this.cacheMs,
      lastError,
    };

    return results;
  }

  private async scrapeSource(source: ScraperSource, fetchedAt: Date): Promise<ExternalRate | null> {
    if (source.strategy === "monex-official") {
      return this.scrapeMonexOfficial(source, fetchedAt);
    }

    return this.scrapeWithLlm(source, source.url, fetchedAt);
  }

  private async scrapeMonexOfficial(source: ScraperSource, fetchedAt: Date): Promise<ExternalRate | null> {
    const browser = await this.getBrowser();
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });

    try {
      page.setDefaultTimeout(this.timeoutMs);
      page.setDefaultNavigationTimeout(this.timeoutMs);

      await page.goto(source.url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });

      await page.waitForLoadState("networkidle", { timeout: Math.min(this.timeoutMs, 8_000) }).catch(() => undefined);
      const html = await page.content();
      const officialRate = parseMonexOfficialHtml(source, html, fetchedAt);

      if (officialRate) {
        this.setSourceStatus(source, {
          sourceType: "official",
          url: source.url,
          buyRate: officialRate.buyRate,
          sellRate: officialRate.sellRate,
          message: "Leído directo del ticker USD en el HTML oficial de Monex.",
          checkedAt: fetchedAt.toISOString(),
        });
        this.emit("info", "Monex oficial leído desde ticker HTML", {
          source: source.source,
          url: source.url,
          buyRate: officialRate.buyRate,
          sellRate: officialRate.sellRate,
        });
        return officialRate;
      }

      let fallbackReason = "Monex oficial no expuso el ticker USD esperado; se usó respaldo público.";
      if (html.includes("Incapsula") || html.includes("Request unsuccessful")) {
        fallbackReason = "Monex oficial bloqueó el navegador automático; se usó respaldo público.";
        this.emit("warn", "Monex oficial bloqueó el acceso headless; usando respaldo público", {
          source: source.source,
          url: source.url,
        });
      } else {
        this.emit("warn", "Monex oficial no expuso el ticker USD esperado; usando respaldo público", {
          source: source.source,
          url: source.url,
        });
      }

      if (!source.fallbackUrl) {
        this.setSourceStatus(source, {
          sourceType: "unavailable",
          url: source.url,
          buyRate: null,
          sellRate: null,
          message: fallbackReason,
          checkedAt: fetchedAt.toISOString(),
        });
        return null;
      }

      const fallbackRate = await this.scrapeWithLlm(source, source.fallbackUrl, fetchedAt, {
        sourceType: "fallback",
        successMessage: fallbackReason,
      });

      if (fallbackRate) {
        this.setSourceStatus(source, {
          sourceType: "fallback",
          url: source.fallbackUrl,
          buyRate: fallbackRate.buyRate,
          sellRate: fallbackRate.sellRate,
          message: fallbackReason,
          checkedAt: fetchedAt.toISOString(),
        });
      } else if (!this.sourceStatuses.has(source.source)) {
        this.setSourceStatus(source, {
          sourceType: "unavailable",
          url: source.fallbackUrl,
          buyRate: null,
          sellRate: null,
          message: `${fallbackReason} El respaldo no devolvió datos válidos.`,
          checkedAt: fetchedAt.toISOString(),
        });
      }

      return fallbackRate;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async scrapeWithLlm(
    source: ScraperSource,
    url: string,
    fetchedAt: Date,
    options?: { sourceType?: ExternalRateSourceType; successMessage?: string }
  ): Promise<ExternalRate | null> {
    if (!process.env.OPENAI_API_KEY) {
      this.setSourceStatus(source, {
        sourceType: "unavailable",
        url,
        buyRate: null,
        sellRate: null,
        message: "No se pudo usar extracción LLM porque OPENAI_API_KEY no está configurada.",
        checkedAt: fetchedAt.toISOString(),
      });
      return null;
    }

    const browser = await this.getBrowser();
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });

    try {
      page.setDefaultTimeout(this.timeoutMs);
      page.setDefaultNavigationTimeout(this.timeoutMs);

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });

      await page.waitForLoadState("networkidle", { timeout: Math.min(this.timeoutMs, 8_000) }).catch(() => undefined);

      const scraper = await this.getScraper();
      const result = await withTimeout(
        scraper.run(page, rateSchema, {
          format: "html",
          prompt: `${SCRAPER_PROMPT} Requested institution: ${source.targetName}. Extract only the row or section for ${source.targetName}.`,
          temperature: 0,
          maxTokens: 500,
        }),
        this.timeoutMs,
        `Timeout extrayendo tasas de ${source.source}`
      );

      const rate = toExternalRate(source, (result as { data?: unknown }).data, fetchedAt);
      if (rate) {
        this.setSourceStatus(source, {
          sourceType: options?.sourceType ?? "public_table",
          url,
          buyRate: rate.buyRate,
          sellRate: rate.sellRate,
          message: options?.successMessage ?? "Leído desde una tabla pública con extracción automática.",
          checkedAt: fetchedAt.toISOString(),
        });
      }
      return rate;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  private async getScraper(): Promise<LLMScraper> {
    if (!this.scraper) {
      const { default: LLMScraper } = await import("llm-scraper");
      this.scraper = new LLMScraper(openai.chat(this.model));
    }
    return this.scraper;
  }

  private isCacheFresh(): boolean {
    return Boolean(this.cache && this.cache.expiresAt > Date.now() && this.cache.rates.length > 0);
  }

  private fallbackToExpiredCacheOrEmpty(): ExternalRate[] {
    if (this.cache?.rates.length) {
      for (const rate of this.cache.rates) {
        const source = SOURCES.find((item) => item.source === rate.source) ?? {
          source: rate.source,
          targetName: rate.source,
          url: "",
          strategy: "llm-table" as const,
        };
        const failedStatus = this.sourceStatuses.get(rate.source);
        this.setSourceStatus(source, {
          sourceType: "cache",
          url: failedStatus?.url ?? source.url,
          buyRate: rate.buyRate,
          sellRate: rate.sellRate,
          message: `La lectura actual falló; se conserva el último dato guardado en cache. ${failedStatus?.message ?? ""}`.trim(),
          checkedAt: rate.fetchedAt.toISOString(),
        });
      }
      this.emit("warn", "Usando cache expirado de tasas externas por fallo de scraping", {
        fetchedAt: this.cache.fetchedAt.toISOString(),
        sources: this.cache.rates.map((rate) => rate.source),
      });
      return this.cache.rates;
    }

    this.emit("warn", "No hay tasas externas reales disponibles; el motor usará FIX si existe");
    return [];
  }

  private emit(level: ScraperLogLevel, message: string, data?: Record<string, unknown>) {
    const event: ExternalRatesScraperEvent = { level, message };
    if (data) event.data = data;
    this.onEvent?.(event);
  }

  private setSourceStatus(
    source: ScraperSource,
    status: Omit<ExternalRateSourceStatus, "source" | "primaryUrl" | "fallbackUrl">
  ) {
    this.sourceStatuses.set(source.source, {
      source: source.source,
      primaryUrl: source.url,
      fallbackUrl: source.fallbackUrl ?? null,
      ...status,
    });
  }
}
