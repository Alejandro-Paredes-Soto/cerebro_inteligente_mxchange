import express from "express"; 
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import prisma from "@prisma/client"
import { SmartPricingEngine } from "./utils/smart.pricing";
import { ExchangeConfig, ExternalRate, MarketSnapshot } from "./interfaces/Pricing.type";

dotenv.config({path: ".env.prod"})

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({extended: false}));

// ─── CONFIGURACIÓN DE TU CASA DE CAMBIO ────────────────────────────────────
const config: ExchangeConfig = {
  currentBuyRate: 17.10,       // Tu precio de compra actual
  currentSellRate: 17.50,      // Tu precio de venta actual
  baseCurrency: "USD",
  quoteCurrency: "MXN",
  defaultMarginPercent: 2.0,   // Margen base: 2%
  minMarginPercent: 1.0,       // Jamás bajas de 1%
  maxMarginPercent: 3.5,       // Jamás subes de 3.5%
  volatilityThreshold: 0.4,    // Score ≥ 0.4 = mercado volátil
  pressureThreshold: 0.2,      // Presión ≥ 20% = actuar
  significantChangePercent: 0.5, // Cambio ≥ 0.5% = alerta
};

// ─── INICIALIZAR EL MOTOR ───────────────────────────────────────────────────

const engine = new SmartPricingEngine(config, process.env.OPENAI_API_KEY!);

// ─── MOCK DE TUS 3 APIs ─────────────────────────────────────────────────────
// Reemplaza esto con las llamadas reales a tus APIs

async function fetchExternalRates(): Promise<ExternalRate[]> {
  // Aquí van tus llamadas reales. Ejemplo:
  // const [api1, api2, api3] = await Promise.all([
  //   fetch('https://api1.example.com/usd-mxn').then(r => r.json()),
  //   fetch('https://api2.example.com/rates').then(r => r.json()),
  //   fetch('https://api3.example.com/exchange').then(r => r.json()),
  // ]);

  return [
    {
      source: "api1",
      buyRate: 17.08,
      sellRate: 17.45,
      fetchedAt: new Date(),
    },
    {
      source: "api2",
      buyRate: 17.12,
      sellRate: 17.52,
      fetchedAt: new Date(),
    },
    {
      source: "api3",
      buyRate: 17.09,
      sellRate: 17.48,
      fetchedAt: new Date(),
    },
  ];
}

// ─── LOOP PRINCIPAL ─────────────────────────────────────────────────────────

let previousSnapshot: MarketSnapshot;

async function runPricingCycle() {
  console.log("\n═══════════════════════════════════════");
  console.log(`🔄 Ciclo: ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════");

  try {
    // 1. Obtener tipos de cambio de tus 3 APIs
    const externalRates = await fetchExternalRates();

    // 2. Construir snapshot con histórico para calcular volatilidad temporal
    const snapshot: MarketSnapshot = {
      externalRates,
      previousSnapshot,
      timestamp: new Date(),
    };

    // 3. Procesar con el motor inteligente
    const result = await engine.process(snapshot);

    // 4. Mostrar resultado
    console.log("\n📊 ANÁLISIS:");
    console.log(`  Condición: ${result.analysis.marketCondition.toUpperCase()}`);
    console.log(`  Volatilidad: ${(result.analysis.volatilityScore * 100).toFixed(1)}%`);
    console.log(`  Presión: ${(result.analysis.buyPressure * 100).toFixed(1)}% (+ = compradora)`);

    console.log("\n💱 PRECIOS AJUSTADOS:");
    console.log(`  Compra:  ${result.adjustment.adjustedBuyRate.toFixed(4)}  (${result.adjustment.buyDelta >= 0 ? "+" : ""}${result.adjustment.buyDelta.toFixed(4)})`);
    console.log(`  Venta:   ${result.adjustment.adjustedSellRate.toFixed(4)}  (${result.adjustment.sellDelta >= 0 ? "+" : ""}${result.adjustment.sellDelta.toFixed(4)})`);
    console.log(`  Margen:  ${result.adjustment.margin.toFixed(2)}%`);
    console.log(`  Razón:   ${result.adjustment.adjustmentReason}`);

    if (result.alerts.length > 0) {
      console.log("\n🚨 ALERTAS:");
      result.alerts.forEach((a) => {
        const icon = a.severity === "critical" ? "🔴" : a.severity === "warning" ? "🟡" : "🔵";
        console.log(`  ${icon} [${a.type}] ${a.message}`);
      });
    }

    console.log("\n🤖 GPT EXPLICACIÓN:");
    console.log(`  ${result.explanation}`);
    console.log("\n💡 SUGERENCIA DE MARGEN:");
    console.log(`  ${result.marginSuggestion}`);

    // 5. Guardar snapshot para el próximo ciclo
    previousSnapshot = snapshot;

    // 6. Aquí aplicarías los precios en tu sistema real:
    // await yourExchangeService.updateRates({
    //   buyRate: result.adjustment.adjustedBuyRate,
    //   sellRate: result.adjustment.adjustedSellRate,
    // });

  } catch (error) {
    console.error("❌ Error en ciclo de pricing:", error);
  }
}

// Ejecutar cada 5 minutos
runPricingCycle();
setInterval(runPricingCycle, 5 * 60 * 1000);

app.listen(process.env.PORT, () => {
    console.log("Server running in the port " + process.env.PORT)
})