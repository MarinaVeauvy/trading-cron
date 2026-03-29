/**
 * Scraper CLOUD — roda no GitHub Actions (sem precisar do PC)
 * Usa Playwright com anti-detection pra burlar proteção do site
 */

const { chromium } = require('playwright');

const AGUIA_EMAIL = process.env.AGUIA_EMAIL;
const AGUIA_PASSWORD = process.env.AGUIA_PASSWORD;
const API_KEY = process.env.CRON_SECRET;
const AGUIA_API = 'https://aguia-trader.vercel.app';

const ALERT_PAGES = [
  { url: 'https://app.aguiaspread.com.br/aguia/fast-alertas', type: 'fast', label: 'Fast Alertas' },
  { url: 'https://app.aguiaspread.com.br/aguia/pre-alertas', type: 'pre', label: 'Pré-Alertas' },
  { url: 'https://app.aguiaspread.com.br/aguia/alertas', type: 'alert', label: 'Alertas' },
  { url: 'https://app.aguiaspread.com.br/sinais/sinais-milionarios', type: 'signal', label: 'Sinais Milionários' },
];

async function scrapeAlerts() {
  console.log('🦅 Scraper CLOUD — Águia Spread');
  console.log('⏰ ' + new Date().toISOString());

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    // Setar localStorage e cookies pra burlar deteccao
    storageState: undefined,
    javaScriptEnabled: true,
  });

  // Anti-detection: sobrescrever navigator.webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    // === LOGIN ===
    console.log('🔑 Fazendo login...');
    await page.goto('https://app.aguiaspread.com.br/Identity/Account/Login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    await page.fill('#Input_Email', AGUIA_EMAIL);
    await page.waitForTimeout(300);
    await page.fill('#Input_Password', AGUIA_PASSWORD);
    await page.waitForTimeout(300);

    // Marcar "lembrar"
    const rememberMe = await page.$('#Input_RememberMe');
    if (rememberMe) await rememberMe.check();

    // Submit via JavaScript (mais confiavel que click em headless)
    await page.evaluate(() => {
      // Setar localStorage antes do submit
      localStorage.setItem('theme-mode', 'dark');
      localStorage.setItem('accepted-cookies', 'true');
      localStorage.setItem('device-id', 'scraper-' + Date.now());
    });
    await page.waitForTimeout(500);

    // Tentar click primeiro
    await page.click('button[type="submit"]');
    await page.waitForTimeout(5000);

    let url = page.url();
    console.log('📍 URL apos click:', url);

    // Se ainda na pagina de login, tentar submit via JS
    if (url.includes('Login')) {
      console.log('⚠️ Click nao funcionou, tentando submit via JS...');
      await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) form.submit();
      });
      await page.waitForTimeout(5000);
      url = page.url();
      console.log('📍 URL apos JS submit:', url);
    }

    // Se ainda na login, tentar via fetch direto
    if (url.includes('Login')) {
      console.log('⚠️ Form submit falhou, tentando via fetch...');
      const token = await page.evaluate(() => {
        const input = document.querySelector('input[name="__RequestVerificationToken"]');
        return input ? input.value : '';
      });

      if (token) {
        const loginResult = await page.evaluate(async (args) => {
          const body = new URLSearchParams({
            'Input.Email': args.email,
            'Input.Password': args.pass,
            'Input.RememberMe': 'true',
            '__RequestVerificationToken': args.tkn,
          });
          const res = await fetch('/Identity/Account/Login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            redirect: 'follow',
          });
          return { ok: res.ok, status: res.status, url: res.url };
        }, { tkn: token, email: AGUIA_EMAIL, pass: AGUIA_PASSWORD });

        console.log('📍 Fetch result:', JSON.stringify(loginResult));

        // Navegar para home com cookies da sessao
        await page.goto('https://app.aguiaspread.com.br/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);
        url = page.url();
        console.log('📍 URL apos fetch login:', url);
      }
    }

    // Tentar navegar direto se bloqueado
    if (url.includes('bloqueado')) {
      console.log('⚠️ Bloqueado. Navegando direto para alertas...');
      await page.goto(ALERT_PAGES[0].url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      url = page.url();
      console.log('📍 URL tentativa direta:', url);
    }

    if (url.includes('Login') && !url.includes('aguia/')) {
      await page.screenshot({ path: '/tmp/aguia-login-fail.png', fullPage: true });
      throw new Error('Login nao completou apos 3 tentativas: ' + url);
    }

    console.log('✅ Logado!');

    // === EXTRAIR ALERTAS ===
    const allAlerts = [];

    for (const ap of ALERT_PAGES) {
      console.log('📄 ' + ap.label + '...');
      await page.goto(ap.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);

      const pageAlerts = await page.evaluate((alertType) => {
        const alerts = [];
        const tables = document.querySelectorAll('table');

        for (const table of tables) {
          const rows = table.querySelectorAll('tr');
          for (const tr of rows) {
            const cells = Array.from(tr.querySelectorAll('td')).map(c => c.textContent.trim());
            if (cells.length < 3) continue;

            // Buscar ativo
            let asset = null;
            for (const cell of cells) {
              if (/^[A-Z0-9]{2,}USDT$/i.test(cell.trim())) {
                asset = cell.trim().toUpperCase();
                break;
              }
            }
            if (!asset) continue;

            // Direcao pela cor
            const style = window.getComputedStyle(tr);
            const bg = style.backgroundColor;
            const cls = tr.className;
            const isGreen = bg.includes('0, 128') || bg.includes('0, 255') || bg.includes('34, 197') ||
              bg.includes('25, 135') || bg.includes('40, 167') ||
              cls.includes('success') || cls.includes('green') ||
              tr.querySelector('.text-success, .bg-success') !== null;
            const isRed = bg.includes('255, 0') || bg.includes('220, 53') || bg.includes('239, 68') ||
              bg.includes('214, 57') || bg.includes('231, 76') ||
              cls.includes('danger') || cls.includes('red') ||
              tr.querySelector('.text-danger, .bg-danger') !== null;

            const direction = isGreen ? 'LONG' : isRed ? 'SHORT' : 'UNKNOWN';

            // Preco (formato BR: virgula decimal, ponto milhar)
            const assetIdx = cells.findIndex(c => c.trim().toUpperCase() === asset);
            const priceIdx = assetIdx + 2;
            let price = 0;
            if (priceIdx < cells.length) {
              const parsed = cells[priceIdx].trim().replace(/\./g, '').replace(',', '.');
              price = parseFloat(parsed);
              if (isNaN(price)) price = 0;
            }

            // Volume
            const volIdx = assetIdx + 3;
            let volume = 0;
            if (volIdx < cells.length) {
              const parsed = cells[volIdx].trim().replace(/\./g, '').replace(',', '.');
              volume = parseFloat(parsed) || 0;
            }

            // Timestamp
            let timestamp = '';
            for (const cell of cells) {
              if (/\d{2}\/\d{2}\/\d{4}/.test(cell)) { timestamp = cell; break; }
            }

            if (price > 0) {
              alerts.push({ asset, direction, price, volume, timestamp: timestamp || new Date().toISOString(), type: alertType });
            }
          }
        }
        return alerts;
      }, ap.type);

      console.log('  Extraidos: ' + pageAlerts.length);
      if (pageAlerts.length > 0) {
        pageAlerts.slice(0, 3).forEach(a =>
          console.log('    ' + a.direction.padEnd(7) + ' ' + a.asset.padEnd(14) + ' $' + a.price)
        );
      }
      allAlerts.push(...pageAlerts);
    }

    // Deduplicar
    const seen = new Set();
    const uniqueAlerts = allAlerts.filter(a => {
      const key = a.asset + '_' + a.price + '_' + a.type;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log('\n🎯 Total: ' + uniqueAlerts.length + ' alertas unicos');

    if (uniqueAlerts.length > 0) {
      // Enviar para OKX
      console.log('📡 Enviando para OKX...');
      const okxRes = await fetch(AGUIA_API + '/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alerts: uniqueAlerts, secret: API_KEY }),
      });
      console.log('  OKX:', await okxRes.json());

      // Sync para Bitget
      console.log('📡 Sync Bitget...');
      const syncRes = await fetch(AGUIA_API + '/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ direction: 'to-bitget' }),
      });
      console.log('  Bitget:', await syncRes.json());
    }

    return uniqueAlerts;
  } catch (error) {
    console.error('❌ Erro:', error.message);
    try { await page.screenshot({ path: '/tmp/aguia-error.png', fullPage: true }); } catch {}
    throw error;
  } finally {
    await browser.close();
  }
}

scrapeAlerts()
  .then(alerts => { console.log('✅ Concluido: ' + alerts.length + ' alertas'); process.exit(0); })
  .catch(err => { console.error('💀 Falhou:', err.message); process.exit(1); });
