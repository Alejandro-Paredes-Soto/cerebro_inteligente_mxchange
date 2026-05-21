import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { SmartPricingEngine } from "./utils/smart.pricing";
import { ExchangeConfig, ExternalRate, MarketSnapshot, SmartPricingResult, SystemMetrics } from "./interfaces/Pricing.type";
import { ExternalRatesScraper, type ExternalRateSourceStatus } from "./utils/external-rates-scraper.service";

dotenv.config({ path: ".env.local" });

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: false }));

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";
const BRAIN_API_KEY = process.env.BRAIN_API_KEY || "mxchange-brain-secret-key-2026";
const BRAIN_BRANCH_ID = process.env.BRAIN_BRANCH_ID || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SCRAPER_CACHE_MINUTES = Number(process.env.SCRAPER_CACHE_MINUTES || 30);
const SCRAPER_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 15000);
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

type BrainMonitorState = {
  service: {
    name: string;
    startedAt: string;
    status: "idle" | "running" | "error";
    backendUrl: string;
    branchFilter: string | null;
    intervalMs: number;
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
  latestExternalRateStatus: ExternalRateSourceStatus[];
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
};

const engine = new SmartPricingEngine(baseConfig);
const externalRatesScraper = new ExternalRatesScraper({
  cacheMinutes: Number.isFinite(SCRAPER_CACHE_MINUTES) ? SCRAPER_CACHE_MINUTES : 30,
  timeoutMs: Number.isFinite(SCRAPER_TIMEOUT_MS) ? SCRAPER_TIMEOUT_MS : 15000,
  model: OPENAI_MODEL,
  onEvent: (event) => pushBrainEvent(event.level, "fetch_external_rates", event.message, event.data),
});
const previousSnapshots = new Map<number, MarketSnapshot>();
let brainEventId = 0;

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

async function fetchExternalRates(branch: BranchSummary): Promise<ExternalRate[]> {
  const rates = await externalRatesScraper.getExternalRates();
  monitorState.latestExternalRateStatus = externalRatesScraper.getSourceStatuses();
  pushBrainEvent(rates.length ? "info" : "warn", "fetch_external_rates", "Referencias externas disponibles para sucursal", {
    branchId: branch.id,
    branchName: branch.name,
    sources: rates.map((rate) => rate.source),
    cache: externalRatesScraper.getCacheStatus(),
    sourceStatus: monitorState.latestExternalRateStatus,
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
  const src = result.analysis.referenceSource === "fix_banxico" ? "🏦 FIX Banxico" : "📊 Promedio Externo";
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

runPricingCycle();
setInterval(runPricingCycle, CYCLE_INTERVAL_MS);

const port = process.env.PORT || 4001;
app.listen(port, () => {
  console.log("Server running on port " + port);
});
