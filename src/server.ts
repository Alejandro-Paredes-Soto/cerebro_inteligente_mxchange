import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { SmartPricingEngine } from "./utils/smart.pricing";
import { ExchangeConfig, ExternalRate, MarketSnapshot, SmartPricingResult, SystemMetrics } from "./interfaces/Pricing.type";
import {
  ExternalRatesScraper,
  type RegionalCompetitorScrapeSource,
  type RegionalCompetitorScrapeStatus,
} from "./utils/external-rates-scraper.service";
import { crawl4aiBaseUrl, verifyCrawl4aiHealth } from "./utils/rate-scrape.providers";
import fs from "node:fs";
import path from "node:path";

function resolveEnvFile(): string {
  if (process.env.ENV_FILE) return process.env.ENV_FILE;
  const candidates = [
    process.env.APP_ENV === "production" || process.env.NODE_ENV === "production" ? ".env.prod" : ".env.local",
    ".env.local",
    ".env.prod",
    ".env",
  ];
  for (const candidate of candidates) {
    const fullPath = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(fullPath)) return candidate;
  }
  return ".env.local";
}

dotenv.config({ path: resolveEnvFile() });

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: false }));

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";
const BRAIN_API_KEY = process.env.BRAIN_API_KEY || "mxchange-brain-secret-key-2026";
const BRAIN_BRANCH_ID = process.env.BRAIN_BRANCH_ID || "";
// Peso (0..1) de la competencia regional de Sonora en el ancla mezclada FIX + regional.
// 0 = solo FIX (comportamiento anterior); 0.5 = mitad y mitad (default).
const REGIONAL_ANCHOR_WEIGHT = Number(process.env.REGIONAL_ANCHOR_WEIGHT ?? 0.5);

// MODO SIMULACIÓN (dry-run): en develop el cerebro calcula y muestra lo que PROPONDRÍA,
// pero NO modifica ninguna tasa (no llama a /brain/update-rates). Solo en producción publica.
// Se activa por entorno (APP_ENV/NODE_ENV) y se puede forzar con BRAIN_DRY_RUN=true|false.
const APP_ENV = (process.env.APP_ENV || process.env.NODE_ENV || "development").toLowerCase();
const DRY_RUN = process.env.BRAIN_DRY_RUN != null
  ? /^(1|true|yes|on)$/i.test(process.env.BRAIN_DRY_RUN)
  : APP_ENV !== "production";

const CYCLE_INTERVAL_MS = 5 * 60 * 1000;

type BrainLogLevel = "info" | "warn" | "error";
type BrainStage =
  | "idle"
  | "boot"
  | "fetch_metrics"
  | "fetch_external_rates"
  | "analyze"
  | "publish_rates"
  | "completed"
  | "error";

type BrainEvent = {
  id: number;
  timestamp: string;
  level: BrainLogLevel;
  stage: BrainStage;
  message: string;
  data?: Record<string, unknown>;
};

type BranchSummary = {
  id: number;
  name: string;
  is_matriz?: boolean;
};

type PublishedRate = {
  buyRate: number;
  sellRate: number;
  reason: string | null;
  appliedAt: string;
  simulated?: boolean; // true = calculado en modo simulación (NO se publicó al backend)
};

type BranchRunState = {
  branchId: number;
  branchName: string;
  status: "success" | "skipped" | "error";
  error: string | null;
  snapshotAt: string | null;
  metrics: SystemMetrics | null;
  externalRates: ExternalRate[];
  result: SmartPricingResult | null;
  publishedRates: PublishedRate | null;
};

type BrainCompetitorSource = {
  id: number;
  source: string;
  buyRate: number | null;
  sellRate: number | null;
  fetchedAt: string | null;
  scrapeUrl: string | null;
  scrapeEnabled: boolean;
  scrapedToday: boolean; // true = ya se scrapeó hoy (según last_scraped_at en BD); no re-scrapear en auto
};

type RegionalCompetitorFetchResult = {
  rates: ExternalRate[];
  statuses: RegionalCompetitorScrapeStatus[];
};

type BrainMonitorState = {
  service: {
    name: string;
    startedAt: string;
    status: "idle" | "running" | "error";
    backendUrl: string;
    branchFilter: string | null;
    intervalMs: number;
    appEnv: string;
    dryRun: boolean; // true = simulación: calcula pero NO modifica tasas
    spreadConfig?: {
      minSpreadCents: number;
      startingSpreadCents: number;
      maxSpreadCents: number;
    };
  };
  currentCycle: {
    cycleId: number;
    stage: BrainStage;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    status: "idle" | "running" | "success" | "error";
    error: string | null;
    processedBranches: number;
  };
  managedBranches: BranchSummary[];
  /** @deprecated Ya no hay fuentes nacionales (Monex/BBVA). Siempre []. */
  latestExternalRateStatus: [];
  latestRegionalCompetitorStatus: RegionalCompetitorScrapeStatus[];
  latestBranchRuns: Record<string, BranchRunState>;
  eventFeed: BrainEvent[];
};

const monitorState: BrainMonitorState = {
  service: {
    name: "cerebro_inteligente_mxchange",
    startedAt: new Date().toISOString(),
    status: "idle",
    backendUrl: BACKEND_URL,
    branchFilter: BRAIN_BRANCH_ID || null,
    intervalMs: CYCLE_INTERVAL_MS,
    appEnv: APP_ENV,
    dryRun: DRY_RUN,
  },
  currentCycle: {
    cycleId: 0,
    stage: "boot",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    status: "idle",
    error: null,
    processedBranches: 0,
  },
  managedBranches: [],
  latestExternalRateStatus: [],
  latestRegionalCompetitorStatus: [],
  latestBranchRuns: {},
  eventFeed: [],
};

const baseConfig: ExchangeConfig = {
  currentBuyRate: 17.10,
  currentSellRate: 17.50,
  baseCurrency: "USD",
  quoteCurrency: "MXN",
  minSpreadCents: 0.20,
  startingSpreadCents: 0.25,
  maxSpreadCents: 0.30,
  operationsThreshold: 100,
  centsStepUp: 0.01,
  targetUsdInventory: 50000,
  volatilityThreshold: 0.4,
  significantChangePercent: 0.5,
  regionalAnchorWeight: Number.isFinite(REGIONAL_ANCHOR_WEIGHT) ? REGIONAL_ANCHOR_WEIGHT : 0.5,
};

// Exponer la escala de centavos (piso / arranque / techo) en el monitor para que
// la UI muestre si el spread sube o baja respecto al arranque del día (lo del audio de Miguel).
monitorState.service.spreadConfig = {
  minSpreadCents: baseConfig.minSpreadCents,
  startingSpreadCents: baseConfig.startingSpreadCents,
  maxSpreadCents: baseConfig.maxSpreadCents,
};

const engine = new SmartPricingEngine(baseConfig);
const externalRatesScraper = new ExternalRatesScraper({
  onEvent: (event) => pushBrainEvent(event.level, "fetch_external_rates", event.message, event.data),
});
const previousSnapshots = new Map<number, MarketSnapshot>();
let brainEventId = 0;
let regionalCompetitorResultForCycle: RegionalCompetitorFetchResult | null = null;

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function pushBrainEvent(
  level: BrainLogLevel,
  stage: BrainStage,
  message: string,
  data?: Record<string, unknown>
) {
  const event: BrainEvent = {
    id: ++brainEventId,
    timestamp: new Date().toISOString(),
    level,
    stage,
    message,
  };

  if (data) event.data = data;

  monitorState.eventFeed.unshift(event);
  monitorState.eventFeed = monitorState.eventFeed.slice(0, 200);
  monitorState.currentCycle.stage = stage;

  const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : "ℹ️";
  const dataSuffix = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`${prefix} [${stage}] ${message}${dataSuffix}`);
}

function beginCycle() {
  regionalCompetitorResultForCycle = null;
  monitorState.currentCycle = {
    cycleId: monitorState.currentCycle.cycleId + 1,
    stage: "fetch_metrics",
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: null,
    status: "running",
    error: null,
    processedBranches: 0,
  };
  monitorState.service.status = "running";
}

function completeCycle(status: "success" | "error", error?: unknown) {
  const completedAt = new Date().toISOString();
  const startedAt = monitorState.currentCycle.startedAt
    ? new Date(monitorState.currentCycle.startedAt).getTime()
    : null;

  monitorState.currentCycle.completedAt = completedAt;
  monitorState.currentCycle.durationMs = startedAt ? Date.now() - startedAt : null;
  monitorState.currentCycle.status = status;
  monitorState.currentCycle.error = status === "error" ? sanitizeError(error) : null;
  monitorState.currentCycle.stage = status === "error" ? "error" : "completed";
  monitorState.service.status = status === "error" ? "error" : "idle";
}

function hasValidSystemMetrics(metrics: SystemMetrics | null): metrics is SystemMetrics {
  if (!metrics) return false;
  return (
    Number.isFinite(metrics.buy_avg) &&
    metrics.buy_avg > 0 &&
    Number.isFinite(metrics.sell_avg) &&
    metrics.sell_avg > 0
  );
}

function getBranchRun(branch: BranchSummary): BranchRunState {
  return (
    monitorState.latestBranchRuns[String(branch.id)] || {
      branchId: branch.id,
      branchName: branch.name,
      status: "skipped",
      error: null,
      snapshotAt: null,
      metrics: null,
      externalRates: [],
      result: null,
      publishedRates: null,
    }
  );
}

function setBranchRun(branch: BranchSummary, patch: Partial<BranchRunState>) {
  monitorState.latestBranchRuns[String(branch.id)] = {
    ...getBranchRun(branch),
    ...patch,
    branchId: branch.id,
    branchName: branch.name,
  };
}

app.get("/monitor", (_req, res) => {
  res.json(monitorState);
});

function requireBrainActionApiKey(req: Request, res: Response, next: NextFunction) {
  const providedKey = req.headers["x-brain-api-key"];
  if (providedKey !== BRAIN_API_KEY) {
    return res.status(401).json({ message: "invalid brain api key" });
  }

  next();
}

async function fetchManagedBranches(): Promise<BranchSummary[]> {
  try {
    const response = await fetch(`${BACKEND_URL}/brain/branches`, {
      headers: { "x-brain-api-key": BRAIN_API_KEY },
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const data = await response.json();
    const branches: unknown[] = Array.isArray(data?.branches) ? data.branches : [];
    const filtered = branches
      .map((branch: unknown) => {
        const item = branch as Record<string, unknown>;
        return {
          id: Number(item.id),
          name: String(item.name || `Sucursal ${item.id}`),
          is_matriz: Boolean(item.is_matriz),
        };
      })
      .filter((branch: BranchSummary) => Number.isInteger(branch.id) && branch.id > 0)
      .filter((branch: BranchSummary) => !BRAIN_BRANCH_ID || String(branch.id) === BRAIN_BRANCH_ID);

    monitorState.managedBranches = filtered;
    pushBrainEvent("info", "fetch_metrics", "Sucursales detectadas para el ciclo", {
      count: filtered.length,
      branchIds: filtered.map((branch) => branch.id),
    });
    return filtered;
  } catch (error) {
    pushBrainEvent("error", "fetch_metrics", "No se pudo obtener la lista de sucursales", {
      error: sanitizeError(error),
    });
    return [];
  }
}

async function fetchSystemMetrics(branch: BranchSummary) {
  try {
    const params = new URLSearchParams({ branchId: String(branch.id) });
    const metricsUrl = `${BACKEND_URL}/brain/metrics?${params.toString()}`;
    pushBrainEvent("info", "fetch_metrics", "Consultando métricas del backend", {
      branchId: branch.id,
      branchName: branch.name,
      metricsUrl,
    });

    const response = await fetch(metricsUrl, {
      headers: { "x-brain-api-key": BRAIN_API_KEY },
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const data = await response.json();
    pushBrainEvent("info", "fetch_metrics", "Métricas recibidas del backend", {
      branchId: branch.id,
      buy_avg: data?.buy_avg,
      sell_avg: data?.sell_avg,
      fix_banxico: data?.fix_banxico,
      fifo_avg_cost: data?.fifo_avg_cost,
      usd_inventory: data?.usd_inventory,
      total_sell_operations: data?.total_sell_operations,
    });
    return data;
  } catch (error) {
    pushBrainEvent("error", "fetch_metrics", "Error obteniendo métricas del backend", {
      branchId: branch.id,
      error: sanitizeError(error),
    });
    return null;
  }
}

async function updateSystemRates(branch: BranchSummary, buyRate: number, sellRate: number, reason?: string) {
  try {
    pushBrainEvent("info", "publish_rates", "Publicando tasas al backend", {
      branchId: branch.id,
      branchName: branch.name,
      buyRate,
      sellRate,
      reason: reason || null,
    });

    const response = await fetch(`${BACKEND_URL}/brain/update-rates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-brain-api-key": BRAIN_API_KEY,
      },
      body: JSON.stringify({ buyRate, sellRate, reason, branchId: branch.id }),
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const data = await response.json();
    const publishedRates = {
      buyRate: Number(data.buyRate),
      sellRate: Number(data.sellRate),
      reason: data.reason || reason || null,
      appliedAt: data.applied_at || new Date().toISOString(),
    };
    setBranchRun(branch, { publishedRates });
    pushBrainEvent("info", "publish_rates", "Tasas publicadas correctamente", {
      branchId: branch.id,
      buyRate: data.buyRate,
      sellRate: data.sellRate,
      source: data.source || "brain",
    });
  } catch (error) {
    pushBrainEvent("error", "publish_rates", "Falló la publicación de tasas", {
      branchId: branch.id,
      error: sanitizeError(error),
      buyRate,
      sellRate,
    });
    throw error;
  }
}

function isPlausibleRate(buyRate: number | null, sellRate: number | null): boolean {
  if (buyRate === null || sellRate === null) return false;
  if (!Number.isFinite(buyRate) || !Number.isFinite(sellRate)) return false;
  if (buyRate <= 10 || buyRate >= 30 || sellRate <= 10 || sellRate >= 30) return false;
  if (sellRate < buyRate) return false;
  return true;
}

function safeDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeBrainCompetitor(item: unknown): BrainCompetitorSource | null {
  const c = item as Record<string, unknown>;
  const id = Number(c.id);
  if (!Number.isInteger(id) || id <= 0) return null;

  const scrapeUrl = typeof c.scrapeUrl === "string" && c.scrapeUrl.trim()
    ? c.scrapeUrl.trim()
    : null;

  return {
    id,
    source: String(c.source || "Competidor"),
    buyRate: c.buyRate == null ? null : Number(c.buyRate),
    sellRate: c.sellRate == null ? null : Number(c.sellRate),
    fetchedAt: c.fetchedAt ? String(c.fetchedAt) : null,
    scrapeUrl,
    scrapeEnabled: Boolean(c.scrapeEnabled),
    scrapedToday: Boolean(c.scrapedToday),
  };
}

function buildManualCompetitorRate(competitor: BrainCompetitorSource): ExternalRate | null {
  if (!isPlausibleRate(competitor.buyRate, competitor.sellRate)) return null;
  return {
    source: competitor.source,
    buyRate: competitor.buyRate as number,
    sellRate: competitor.sellRate as number,
    fetchedAt: safeDate(competitor.fetchedAt) ?? new Date(),
    origin: "regional",
  };
}

function buildManualCompetitorStatus(
  competitor: BrainCompetitorSource,
  rate: ExternalRate | null
): RegionalCompetitorScrapeStatus {
  return {
    id: competitor.id,
    source: competitor.source,
    configuredName: competitor.source,
    scrapedName: null,
    url: competitor.scrapeUrl,
    status: rate ? "manual" : "skipped",
    buyRate: rate?.buyRate ?? null,
    sellRate: rate?.sellRate ?? null,
    message: rate
      ? "Sin scraping activo; se usa la tasa capturada manualmente."
      : "No tiene scraping activo ni tasas manuales válidas.",
    checkedAt: rate?.fetchedAt.toISOString() ?? null,
    usedSource: rate ? "manual" : "none",
  };
}

// Competidor con scraping activo que YA se consultó hoy: reutilizamos el dato guardado (NO re-scrapeamos).
function buildCachedTodayStatus(
  competitor: BrainCompetitorSource,
  rate: ExternalRate | null
): RegionalCompetitorScrapeStatus {
  return {
    id: competitor.id,
    source: competitor.source,
    configuredName: competitor.source,
    scrapedName: null,
    url: competitor.scrapeUrl,
    status: rate ? "success" : "skipped",
    buyRate: rate?.buyRate ?? null,
    sellRate: rate?.sellRate ?? null,
    message: rate
      ? "Ya se consultó hoy; se reutiliza el tipo de cambio del día. El próximo scraping automático es mañana (usa el botón Scrapear para forzarlo ahora)."
      : "Ya se intentó hoy pero no hay tasa válida guardada; usa el botón Scrapear para reintentar.",
    checkedAt: safeDate(competitor.fetchedAt)?.toISOString() ?? rate?.fetchedAt.toISOString() ?? null,
    usedSource: rate ? "scrape" : "none",
  };
}

function buildRegionalScrapeSource(competitor: BrainCompetitorSource): RegionalCompetitorScrapeSource {
  return {
    id: competitor.id,
    name: competitor.source,
    url: competitor.scrapeUrl as string,
    manualBuyRate: competitor.buyRate,
    manualSellRate: competitor.sellRate,
    fetchedAt: safeDate(competitor.fetchedAt),
  };
}

async function reportCompetitorScrapeStatus(status: RegionalCompetitorScrapeStatus) {
  if (status.status === "manual" || status.status === "skipped") return;

  try {
    const response = await fetch(`${BACKEND_URL}/brain/competitors/${status.id}/scrape-result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-brain-api-key": BRAIN_API_KEY,
      },
      body: JSON.stringify({
        status: status.status,
        buyRate: status.buyRate,
        sellRate: status.sellRate,
        scrapedName: status.scrapedName,
        message: status.message,
        checkedAt: status.checkedAt,
      }),
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  } catch (error) {
    pushBrainEvent("warn", "fetch_external_rates", "No se pudo guardar el resultado de scraping del competidor", {
      competitorId: status.id,
      source: status.source,
      status: status.status,
      error: sanitizeError(error),
    });
  }
}

async function fetchRegionalCompetitors(): Promise<RegionalCompetitorFetchResult> {
  if (regionalCompetitorResultForCycle) return regionalCompetitorResultForCycle;

  try {
    const response = await fetch(`${BACKEND_URL}/brain/competitors`, {
      headers: { "x-brain-api-key": BRAIN_API_KEY },
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const data = await response.json();
    const raw: unknown[] = Array.isArray(data?.competitors) ? data.competitors : [];
    const competitors = raw
      .map(normalizeBrainCompetitor)
      .filter((item): item is BrainCompetitorSource => Boolean(item));

    const manualRates: ExternalRate[] = [];
    const manualStatuses: RegionalCompetitorScrapeStatus[] = [];
    const cachedRates: ExternalRate[] = [];
    const cachedStatuses: RegionalCompetitorScrapeStatus[] = [];
    const scrapeSources: RegionalCompetitorScrapeSource[] = [];

    for (const competitor of competitors) {
      if (competitor.scrapeEnabled && competitor.scrapeUrl) {
        // Gate diario: si ya se scrapeó hoy (last_scraped_at en BD), NO volvemos a scrapear;
        // reutilizamos el dato guardado del día. Esto sobrevive a reinicios del server.
        if (competitor.scrapedToday) {
          const cachedRate = buildManualCompetitorRate(competitor);
          if (cachedRate) cachedRates.push(cachedRate);
          cachedStatuses.push(buildCachedTodayStatus(competitor, cachedRate));
          continue;
        }
        scrapeSources.push(buildRegionalScrapeSource(competitor));
        continue;
      }

      const manualRate = buildManualCompetitorRate(competitor);
      if (manualRate) manualRates.push(manualRate);
      manualStatuses.push(buildManualCompetitorStatus(competitor, manualRate));
    }

    const scraped = await externalRatesScraper.scrapeRegionalCompetitors(scrapeSources);
    await Promise.all(scraped.statuses.map(reportCompetitorScrapeStatus));

    const result: RegionalCompetitorFetchResult = {
      rates: [...manualRates, ...cachedRates, ...scraped.rates],
      statuses: [...manualStatuses, ...cachedStatuses, ...scraped.statuses],
    };

    monitorState.latestRegionalCompetitorStatus = result.statuses;
    regionalCompetitorResultForCycle = result;

    pushBrainEvent(result.rates.length ? "info" : "warn", "fetch_external_rates", "Competencia regional (Sonora) cargada", {
      count: result.rates.length,
      configured: competitors.length,
      scrapedNow: scrapeSources.length,
      reusedToday: cachedRates.length,
      sources: result.rates.map((rate) => rate.source),
      scrapeStatus: result.statuses.map((status) => ({
        source: status.source,
        status: status.status,
        usedSource: status.usedSource,
      })),
    });
    return result;
  } catch (error) {
    pushBrainEvent("warn", "fetch_external_rates", "No se pudo obtener la competencia regional; el motor usará solo FIX", {
      error: sanitizeError(error),
    });
    const result: RegionalCompetitorFetchResult = { rates: [], statuses: [] };
    monitorState.latestRegionalCompetitorStatus = result.statuses;
    regionalCompetitorResultForCycle = result;
    return result;
  }
}

function mergeRegionalCompetitorStatus(status: RegionalCompetitorScrapeStatus) {
  monitorState.latestRegionalCompetitorStatus = [
    status,
    ...monitorState.latestRegionalCompetitorStatus.filter((item) => item.id !== status.id),
  ].sort((a, b) => a.source.localeCompare(b.source, "es-MX"));
}

async function scrapeRegionalCompetitorNow(competitorId: number): Promise<RegionalCompetitorScrapeStatus> {
  const response = await fetch(`${BACKEND_URL}/brain/competitors`, {
    headers: { "x-brain-api-key": BRAIN_API_KEY },
  });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

  const data = await response.json();
  const raw: unknown[] = Array.isArray(data?.competitors) ? data.competitors : [];
  const competitor = raw
    .map(normalizeBrainCompetitor)
    .filter((item): item is BrainCompetitorSource => Boolean(item))
    .find((item) => item.id === competitorId);

  if (!competitor) {
    throw new Error("competitor_not_found_or_inactive");
  }
  if (!competitor.scrapeEnabled || !competitor.scrapeUrl) {
    throw new Error("competitor_scraping_not_enabled");
  }

  pushBrainEvent("info", "fetch_external_rates", "Scraping manual solicitado para competidor regional", {
    competitorId: competitor.id,
    source: competitor.source,
    url: competitor.scrapeUrl,
  });

  const scraped = await externalRatesScraper.scrapeRegionalCompetitors([buildRegionalScrapeSource(competitor)]);
  const status = scraped.statuses[0];
  if (!status) throw new Error("competitor_scrape_returned_no_status");

  await reportCompetitorScrapeStatus(status);
  mergeRegionalCompetitorStatus(status);
  regionalCompetitorResultForCycle = null;

  pushBrainEvent(status.status === "success" ? "info" : "warn", "fetch_external_rates", "Scraping manual de competidor terminado", {
    competitorId: status.id,
    source: status.source,
    status: status.status,
    buyRate: status.buyRate,
    sellRate: status.sellRate,
  });

  return status;
}

app.post("/competitors/:id/scrape-now", requireBrainActionApiKey, async (req, res) => {
  try {
    const competitorId = Number(req.params.id);
    if (!Number.isInteger(competitorId) || competitorId <= 0) {
      return res.status(400).json({ message: "id de competidor inválido" });
    }

    const status = await scrapeRegionalCompetitorNow(competitorId);
    return res.json({ ok: true, status });
  } catch (error) {
    const message = sanitizeError(error);
    pushBrainEvent("warn", "fetch_external_rates", "No se pudo ejecutar scraping manual del competidor", {
      competitorId: req.params.id,
      error: message,
    });

    const statusCode = message === "competitor_not_found_or_inactive" ? 404
      : message === "competitor_scraping_not_enabled" ? 400
      : 500;
    return res.status(statusCode).json({ message });
  }
});

async function fetchExternalRates(branch: BranchSummary): Promise<ExternalRate[]> {
  const regionalResult = await fetchRegionalCompetitors();
  const rates = regionalResult.rates;

  pushBrainEvent(rates.length ? "info" : "warn", "fetch_external_rates", "Competencia regional disponible para sucursal", {
    branchId: branch.id,
    branchName: branch.name,
    regionalSources: rates.map((rate) => rate.source),
    regionalStatus: monitorState.latestRegionalCompetitorStatus,
    scraper: "crawl4ai",
    crawl4aiBaseUrl: crawl4aiBaseUrl(),
  });
  return rates;
}

function buildSystemMetrics(rawMetrics: any): SystemMetrics {
  return {
    buy_avg: rawMetrics?.buy_avg ?? 17.10,
    sell_avg: rawMetrics?.sell_avg ?? 17.50,
    fix_banxico: rawMetrics?.fix_banxico ?? null,
    fifo_avg_cost: rawMetrics?.fifo_avg_cost ?? null,
    usd_inventory: rawMetrics?.usd_inventory ?? 0,
    total_buy_operations: rawMetrics?.total_buy_operations ?? 0,
    total_sell_operations: rawMetrics?.total_sell_operations ?? 0,
    daily_spread: rawMetrics?.daily_spread ?? 0,
    daily_profit_mxn: rawMetrics?.daily_profit_mxn ?? 0,
  };
}

function logBranchResult(branch: BranchSummary, systemMetrics: SystemMetrics, result: SmartPricingResult) {
  const src =
    result.analysis.referenceSource === "fix_banxico" ? "🏦 FIX Banxico"
    : result.analysis.referenceSource === "blended" ? `⚖️ FIX + Regional (w=${result.analysis.regionalAnchorWeight.toFixed(2)})`
    : "📊 Promedio Externo";
  const dev = result.analysis.fixDeviation;
  const devStr = dev !== 0 ? ` (mercado regional ${dev > 0 ? "+" : ""}${(dev * 100).toFixed(1)}¢ vs FIX)` : "";
  const dailySpread = systemMetrics.daily_spread ?? (systemMetrics.sell_avg - systemMetrics.buy_avg);

  console.log(`\n🏢 ${branch.name} (#${branch.id})`);
  console.log(`   💱 Compra prom. hoy: ${systemMetrics.buy_avg.toFixed(4)} | Venta prom. hoy: ${systemMetrics.sell_avg.toFixed(4)}`);
  console.log(`   📊 Spread real capturado hoy: ${dailySpread.toFixed(4)} pesos (${(dailySpread * 100).toFixed(2)}¢)`);
  if (systemMetrics.fix_banxico) console.log(`   🏦 FIX Banxico: ${systemMetrics.fix_banxico}`);
  if (systemMetrics.fifo_avg_cost) console.log(`   🧾 Costo FIFO promedio USD: ${systemMetrics.fifo_avg_cost.toFixed(4)}`);
  console.log(`   📦 Inventario físico USD: ${systemMetrics.usd_inventory.toLocaleString()} USD`);
  console.log(`   🛒 Casa vendió USD hoy: ${systemMetrics.total_sell_operations} ops | Casa compró USD hoy: ${systemMetrics.total_buy_operations} ops`);
  if (systemMetrics.daily_profit_mxn) console.log(`   💰 Ganancia estimada hoy: $${systemMetrics.daily_profit_mxn.toLocaleString("es-MX", { minimumFractionDigits: 2 })} MXN`);
  console.log(`   📈 Condición: ${result.analysis.marketCondition.toUpperCase()} | Volatilidad: ${(result.analysis.volatilityScore * 100).toFixed(1)}%`);
  console.log(`   💵 Ancla: ${src} → ${result.analysis.referenceBaseRate.toFixed(4)}${devStr}`);
  console.log(`   Compra propuesta: ${result.adjustment.adjustedBuyRate.toFixed(4)} | Venta propuesta: ${result.adjustment.adjustedSellRate.toFixed(4)}`);
}

async function processBranch(branch: BranchSummary) {
  const metrics = await fetchSystemMetrics(branch);
  const systemMetrics = buildSystemMetrics(metrics);

  setBranchRun(branch, {
    metrics: hasValidSystemMetrics(metrics) ? systemMetrics : null,
    externalRates: [],
    result: null,
    publishedRates: null,
    snapshotAt: null,
    error: null,
  });

  if (!hasValidSystemMetrics(metrics)) {
    setBranchRun(branch, {
      status: "skipped",
      error: "missing_valid_metrics",
    });
    pushBrainEvent("warn", "fetch_metrics", "Métricas inválidas o backend no disponible; no se publicarán tasas para la sucursal", {
      branchId: branch.id,
      branchName: branch.name,
    });
    return;
  }

  engine.updateConfig({
    ...baseConfig,
    currentBuyRate: systemMetrics.buy_avg,
    currentSellRate: systemMetrics.sell_avg,
  });

  const externalRates = await fetchExternalRates(branch);
  const previousSnapshot = previousSnapshots.get(branch.id);
  const snapshot: MarketSnapshot = {
    externalRates,
    systemMetrics,
    timestamp: new Date(),
  };
  if (previousSnapshot) {
    snapshot.previousSnapshot = previousSnapshot;
  }

  setBranchRun(branch, {
    snapshotAt: snapshot.timestamp.toISOString(),
    externalRates,
  });

  pushBrainEvent("info", "analyze", "Procesando snapshot con el motor inteligente", {
    branchId: branch.id,
    branchName: branch.name,
  });

  const result = await engine.process(snapshot);
  previousSnapshots.set(branch.id, snapshot);

  setBranchRun(branch, {
    status: "success",
    result,
    error: null,
  });

  pushBrainEvent("info", "analyze", "Análisis completado", {
    branchId: branch.id,
    marketCondition: result.analysis.marketCondition,
    referenceSource: result.analysis.referenceSource,
    buySpread: result.adjustment.buySpread,
    sellSpread: result.adjustment.sellSpread,
    adjustmentReason: result.adjustment.adjustmentReason,
    fifoAverageCost: result.analysis.fifoAverageCost,
    fifoProtectionApplied: result.adjustment.fifoProtectionApplied,
    minSafeSellRate: result.adjustment.minSafeSellRate,
    alerts: result.alerts.length,
  });

  logBranchResult(branch, systemMetrics, result);

  if (result.alerts.length > 0) {
    console.log("   🚨 ALERTAS:");
    result.alerts.forEach((a) => {
      const icon = a.severity === "critical" ? "🔴" : a.severity === "warning" ? "🟡" : "🔵";
      console.log(`      ${icon} [${a.type}] ${a.message}`);
    });
  }

  if (DRY_RUN) {
    // Modo simulación: registramos lo que SE PUBLICARÍA para que el monitor lo muestre,
    // pero NO tocamos el backend.
    setBranchRun(branch, {
      publishedRates: {
        buyRate: result.adjustment.adjustedBuyRate,
        sellRate: result.adjustment.adjustedSellRate,
        reason: result.adjustment.adjustmentReason,
        appliedAt: new Date().toISOString(),
        simulated: true,
      },
    });
    pushBrainEvent("info", "publish_rates", "Modo simulación (develop): tasas calculadas pero NO publicadas", {
      branchId: branch.id,
      branchName: branch.name,
      buyRate: result.adjustment.adjustedBuyRate,
      sellRate: result.adjustment.adjustedSellRate,
    });
    return;
  }

  await updateSystemRates(
    branch,
    result.adjustment.adjustedBuyRate,
    result.adjustment.adjustedSellRate,
    result.adjustment.adjustmentReason
  );
}

async function runPricingCycle() {
  console.log("\n═══════════════════════════════════════");
  console.log(`🔄 Ciclo: ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════");
  beginCycle();
  pushBrainEvent("info", "fetch_metrics", "Iniciando ciclo de pricing", {
    cycleId: monitorState.currentCycle.cycleId,
  });

  try {
    const branches = await fetchManagedBranches();
    if (branches.length === 0) {
      completeCycle("error", "no_managed_branches");
      pushBrainEvent("error", "error", "No hay sucursales disponibles para procesar");
      return;
    }

    let processedBranches = 0;
    let successCount = 0;

    for (const branch of branches) {
      try {
        await processBranch(branch);
        const run = getBranchRun(branch);
        if (run.status === "success") successCount += 1;
      } catch (error) {
        setBranchRun(branch, {
          status: "error",
          error: sanitizeError(error),
        });
        pushBrainEvent("error", "error", "La sucursal terminó con error", {
          branchId: branch.id,
          branchName: branch.name,
          error: sanitizeError(error),
        });
      } finally {
        processedBranches += 1;
        monitorState.currentCycle.processedBranches = processedBranches;
      }
    }

    if (successCount === 0) {
      completeCycle("error", "no_successful_branches");
      pushBrainEvent("error", "completed", "Ciclo sin sucursales exitosas", {
        cycleId: monitorState.currentCycle.cycleId,
        processedBranches,
      });
      return;
    }

    completeCycle("success");
    pushBrainEvent("info", "completed", "Ciclo completado", {
      cycleId: monitorState.currentCycle.cycleId,
      durationMs: monitorState.currentCycle.durationMs,
      processedBranches,
      successfulBranches: successCount,
    });
  } catch (error) {
    completeCycle("error", error);
    pushBrainEvent("error", "error", "El ciclo terminó con error", {
      cycleId: monitorState.currentCycle.cycleId,
      error: sanitizeError(error),
    });
  }
}

async function boot() {
  const health = await verifyCrawl4aiHealth();
  if (health.ok) {
    pushBrainEvent("info", "boot", "Crawl4AI disponible para scraping de competidores", {
      baseUrl: crawl4aiBaseUrl(),
    });
  } else {
    pushBrainEvent("error", "boot", "Crawl4AI no está disponible; el scraping de competidores fallará", {
      baseUrl: crawl4aiBaseUrl(),
      error: health.error,
      hint: "docker compose up -d crawl4ai",
    });
    console.error(`[cerebro] Crawl4AI no responde en ${crawl4aiBaseUrl()}: ${health.error}`);
  }

  runPricingCycle();
  setInterval(runPricingCycle, CYCLE_INTERVAL_MS);
}

const port = process.env.PORT || 4001;
app.listen(port, () => {
  console.log("Server running on port " + port);
  console.log(`Scraping: Crawl4AI en ${crawl4aiBaseUrl()}`);
  console.log(
    DRY_RUN
      ? `🧪 MODO SIMULACIÓN (entorno=${APP_ENV}): calcula y muestra, pero NO modifica tasas.`
      : `🚀 MODO PRODUCCIÓN (entorno=${APP_ENV}): publica tasas reales al backend.`
  );
  void boot();
});
