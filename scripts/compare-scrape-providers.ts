/**
 * Prueba el scraping de competidores vía Crawl4AI.
 *
 * Uso:
 *   npm run test:scrapers
 *   npx ts-node scripts/compare-scrape-providers.ts --url=https://www.dimesa.com/
 */
import dotenv from "dotenv";
import path from "node:path";
import {
  crawl4aiRateScrape,
  RATE_EXTRACTION_PROMPT,
  verifyCrawl4aiHealth,
  crawl4aiBaseUrl,
} from "../src/utils/rate-scrape.providers";

dotenv.config({ path: path.join(__dirname, "..", ".env.local") });

const DEFAULT_URLS = [
  "https://www.dimesa.com/",
];

function parseArgs() {
  const urlArgs = process.argv.filter((arg) => arg.startsWith("--url=")).map((arg) => arg.slice("--url=".length).trim());
  return { urls: urlArgs.length ? urlArgs : DEFAULT_URLS };
}

function isPlausible(buyRate: number, sellRate: number): boolean {
  if (!Number.isFinite(buyRate) || !Number.isFinite(sellRate)) return false;
  if (buyRate <= 10 || buyRate >= 30 || sellRate <= 10 || sellRate >= 30) return false;
  return sellRate >= buyRate;
}

function formatJson(json: unknown): string {
  if (!json) return "(sin datos)";
  const obj = json as Record<string, unknown>;
  const buy = Number(obj.compra);
  const sell = Number(obj.venta);
  const title = typeof obj.title === "string" ? obj.title : "?";
  const valid = isPlausible(buy, sell) ? "OK" : "INVÁLIDO";
  return `${title} | compra=${buy} venta=${sell} [${valid}]`;
}

async function main() {
  const { urls } = parseArgs();

  console.log("=== Test Crawl4AI (competidores regionales) ===");
  console.log(`Base URL: ${crawl4aiBaseUrl()}`);
  console.log(`Prompt: ${RATE_EXTRACTION_PROMPT.slice(0, 90)}...`);
  console.log(`URLs: ${urls.join(", ")}\n`);

  const health = await verifyCrawl4aiHealth();
  if (!health.ok) {
    console.error(`Crawl4AI no disponible: ${health.error}`);
    console.error("Levanta el servicio: docker compose up -d crawl4ai");
    process.exit(1);
  }
  console.log("Crawl4AI /health OK\n");

  for (const url of urls) {
    console.log(`--- ${url} ---`);
    const started = Date.now();
    const { json, error } = await crawl4aiRateScrape(url);
    const elapsedMs = Date.now() - started;
    if (error) {
      console.log(`  ERROR (${elapsedMs}ms): ${error}`);
    } else {
      console.log(`  OK (${elapsedMs}ms): ${formatJson(json)}`);
    }
  }

  console.log("\n=== Fin ===");
}

main().catch((error) => {
  console.error("Falló el test:", error);
  process.exit(1);
});
