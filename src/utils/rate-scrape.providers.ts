export type RateScrapeResult = { json: unknown | null; error: string | null };

export const RATE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Nombre del sitio o de la casa de cambio / banco." },
    moneda: { type: "string", description: "Código de la divisa de la tasa devuelta. Debe ser 'USD'." },
    compra: {
      type: "number",
      description:
        "Tipo de cambio COMPRA USD/MXN: pesos por dólar a los que el negocio COMPRA dólares al cliente (el menor de los dos).",
    },
    venta: {
      type: "number",
      description:
        "Tipo de cambio VENTA USD/MXN: pesos por dólar a los que el negocio VENDE dólares al cliente (el mayor de los dos).",
    },
  },
  required: ["compra", "venta"],
} as const;

export const RATE_EXTRACTION_PROMPT = [
  "Extract ONLY the US dollar (USD / Dólar americano / Dólar estadounidense) cash exchange rate vs the Mexican peso (MXN).",
  "The page may list several currencies (EUR, CAD/Canadian dollar, GBP, JPY, CHF). Return the USD row ONLY — never CAD, EUR or any other. CAD is around 12-13 and USD is around 16-18; do NOT confuse them.",
  "compra = pesos per dollar at which the business BUYS dollars (the lower number). venta = the higher number. moneda must be 'USD'. title = the business or site name.",
  "Ignore FIX, the Banxico reference rate, bank averages, percentages and historical values.",
].join(" ");

const PROVIDER_LABEL = "Crawl4AI";

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function scrapeProviderLabel(): string {
  return PROVIDER_LABEL;
}

function scrapeTimeoutMs(): number {
  return Math.max(15_000, Number(process.env.CRAWL4AI_TIMEOUT_MS || process.env.SCRAPER_TIMEOUT_MS || 45_000));
}

function scrapeWaitMs(): number {
  const v = Number(process.env.CRAWL4AI_WAIT_MS ?? process.env.SCRAPER_WAIT_MS ?? 6_000);
  return Number.isFinite(v) && v >= 0 ? v : 6_000;
}

export function crawl4aiBaseUrl(): string {
  return (process.env.CRAWL4AI_BASE_URL || "http://localhost:11235").replace(/\/$/, "");
}

function openAiModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

// Crawl4AI lee OPENAI_API_KEY dentro del contenedor (.llm.env), no en el proceso Node.
export function scraperConfigured(): boolean {
  return true;
}

function crawl4aiDockerHint(): string {
  return `Levanta Crawl4AI con: docker compose up -d crawl4ai (en cerebro_inteligente/)`;
}

export async function verifyCrawl4aiHealth(): Promise<{ ok: boolean; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${crawl4aiBaseUrl()}/health`, { signal: controller.signal });
    if (response.ok) return { ok: true, error: null };
    return { ok: false, error: `Crawl4AI /health respondió HTTP ${response.status}` };
  } catch (error) {
    const message = sanitizeError(error);
    return {
      ok: false,
      error: `${message}. ${crawl4aiDockerHint()}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function crawl4aiRateScrape(url: string): Promise<RateScrapeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), scrapeTimeoutMs());
  const waitSeconds = scrapeWaitMs() / 1000;

  try {
    const response = await fetch(`${crawl4aiBaseUrl()}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urls: [url],
        browser_config: {
          type: "BrowserConfig",
          params: { headless: true },
        },
        crawler_config: {
          type: "CrawlerRunConfig",
          params: {
            cache_mode: "bypass",
            delay_before_return_html: waitSeconds,
            page_timeout: scrapeTimeoutMs(),
            extraction_strategy: {
              type: "LLMExtractionStrategy",
              params: {
                llm_config: {
                  type: "LLMConfig",
                  params: {
                    provider: `openai/${openAiModel()}`,
                    api_token: "env:OPENAI_API_KEY",
                  },
                },
                schema: {
                  type: "dict",
                  value: RATE_JSON_SCHEMA,
                },
                extraction_type: "schema",
                instruction: RATE_EXTRACTION_PROMPT,
                apply_chunking: false,
              },
            },
          },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { json: null, error: `Crawl4AI HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }

    const data = (await response.json()) as {
      success?: boolean;
      error?: string;
      results?: Array<{ success?: boolean; extracted_content?: string; error_message?: string }>;
    };

    const result = data?.results?.[0];
    if (!result?.success) {
      return { json: null, error: `Crawl4AI: ${result?.error_message || data?.error || "respuesta sin éxito"}` };
    }

    const raw = result.extracted_content?.trim();
    if (!raw) return { json: null, error: "Crawl4AI no devolvió extracted_content" };

    try {
      const parsed = JSON.parse(raw) as unknown;
      const json = Array.isArray(parsed) ? parsed[0] ?? null : parsed;
      return { json, error: null };
    } catch {
      return { json: null, error: "Crawl4AI devolvió JSON inválido en extracted_content" };
    }
  } catch (error) {
    const aborted = (error as { name?: string })?.name === "AbortError";
    const message = aborted ? "Crawl4AI tardó demasiado (timeout)" : sanitizeError(error);
    if (/fetch failed|ECONNREFUSED|Failed to fetch|abort/i.test(message)) {
      return {
        json: null,
        error: `${message}. ${crawl4aiDockerHint()}`,
      };
    }
    return { json: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function rateScrape(url: string): Promise<RateScrapeResult> {
  return crawl4aiRateScrape(url);
}
