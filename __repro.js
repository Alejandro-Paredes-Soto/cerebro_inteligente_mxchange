const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const s = StealthPlugin(); s.enabledEvasions.delete('navigator.languages'); chromium.use(s);

const STEALTH = {
  locale: 'es-MX', timezoneId: 'America/Hermosillo', viewport: { width: 1366, height: 768 },
  extraHTTPHeaders: { 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8', 'Upgrade-Insecure-Requests': '1' },
};

async function run(label, withInit) {
  const opts = { headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] };
  const browser = await chromium.launch({ ...opts, channel: 'chrome' }).catch(() => chromium.launch(opts));
  const page = await browser.newPage(STEALTH);
  if (withInit) await page.addInitScript(() => { Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es'], configurable: true }); });
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);

  let ajaxFired = false, ajaxBody = '';
  page.on('response', async (r) => {
    if (/ajax\/values/i.test(r.url())) { ajaxFired = true; try { ajaxBody = (await r.text()).slice(0, 70); } catch {} }
  });

  await page.goto('https://www.dimesa.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const hasVal = /COMPRA[\s\S]{0,15}\$?\s*\d{1,2}[.,]\d{2}/i.test(await page.evaluate(() => document.body?.innerText ?? ''));
  console.log(`${label}: ajax/values pedido=${ajaxFired} | valor en texto=${hasVal} | body=${ajaxBody}`);
  await browser.close();
}

(async () => {
  await run('CON init navigator.languages', true);
  await run('SIN init navigator.languages', false);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
