// Scraper LOCAL — roda no PC, envia alertas para OKX + Bybit
const { chromium } = require('playwright');
const fs = require('fs');

const API_KEY = '57ae177908be2d04ff979ac1c4a2e1bfe2fd778660e69cc38ada77d505c3570f';
const TARGETS = [
  { name: 'OKX', url: 'https://aguia-trader.vercel.app/api/cron' },
  { name: 'Bybit', url: 'https://bybit-trader-three.vercel.app/api/cron' },
];

(async () => {
  let email, pass;
  for (const p of ['.env', '../aguia-trader/.env.local']) {
    try {
      const env = fs.readFileSync(p, 'utf8');
      if (!email) email = env.match(/AGUIA_EMAIL=(.*)/)?.[1]?.trim();
      if (!pass) pass = env.match(/AGUIA_PASSWORD=(.*)/)?.[1]?.trim();
    } catch {}
  }
  if (!email || !pass) { console.log('Sem credenciais'); return; }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Login
    console.log('🔑 Login...');
    await page.goto('https://app.aguiaspread.com.br/Identity/Account/Login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);
    await page.fill('#Input_Email', email);
    await page.fill('#Input_Password', pass);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(5000);

    if (page.url().includes('Login')) { console.log('❌ Login falhou'); await browser.close(); return; }
    console.log('✅ Login OK');

    // Scrape fast alerts
    console.log('\n🦅 Fast Alertas...');
    await page.goto('https://app.aguiaspread.com.br/aguia/fast-alertas', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(3000);

    const alerts = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      return Array.from(rows).map(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 5) return null;

        // Direção: ícone na 1a célula (verde=up/LONG, vermelho=down/SHORT)
        const icon = tds[0].querySelector('i, svg, span');
        let direction = 'UNKNOWN';
        if (icon) {
          const cls = icon.className || '';
          const style = icon.getAttribute('style') || '';
          const color = getComputedStyle(icon).color || '';
          if (cls.includes('up') || cls.includes('green') || cls.includes('success') ||
              style.includes('green') || color.includes('0, 128') || color.includes('40, 167')) {
            direction = 'LONG';
          } else if (cls.includes('down') || cls.includes('red') || cls.includes('danger') ||
              style.includes('red') || color.includes('255, 0') || color.includes('220, 53')) {
            direction = 'SHORT';
          }
        }
        // Fallback: cor do texto da row
        if (direction === 'UNKNOWN') {
          const rowColor = getComputedStyle(tr).color;
          const rowBg = tr.getAttribute('class') || '';
          if (rowBg.includes('success') || rowBg.includes('green')) direction = 'LONG';
          else if (rowBg.includes('danger') || rowBg.includes('red')) direction = 'SHORT';
        }

        const cells = Array.from(tds).map(td => td.textContent.trim());
        const dateStr = cells[1] || '';
        const asset = cells[2] || '';
        const breakoutType = cells[3] || '';
        const priceStr = cells[4] || '0';
        const volumeStr = cells[5] || '0';

        const price = parseFloat(priceStr.replace(/\./g, '').replace(',', '.'));
        const volume = parseFloat(volumeStr.replace(/\./g, '').replace(',', '.'));

        return {
          asset: asset.trim(),
          direction,
          price: isNaN(price) ? 0 : price,
          volume: isNaN(volume) ? 0 : volume,
          timestamp: Date.now(),
          type: 'fast',
          breakoutType: breakoutType.trim(),
          dateAlert: dateStr,
        };
      }).filter(a => a && a.asset && a.price > 0);
    });

    console.log(`📊 ${alerts.length} alertas extraídos`);
    alerts.slice(0, 5).forEach(a => console.log(`  ${a.asset} ${a.direction} $${a.price} vol:${a.volume} ${a.breakoutType}`));

    if (alerts.length === 0) { console.log('Nenhum alerta'); await browser.close(); return; }

    // Enviar para cada target
    for (const target of TARGETS) {
      try {
        console.log(`\n📡 Enviando para ${target.name}...`);
        const res = await fetch(target.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alerts, secret: API_KEY }),
        });
        const json = await res.json();
        console.log(`  ${target.name}:`, JSON.stringify(json));
      } catch (e) {
        console.log(`  ${target.name} ERRO:`, e.message);
      }
    }

    // Agora disparar GET /api/cron para processar os alertas
    console.log('\n🏛️ Disparando processamento Grécia...');
    for (const target of TARGETS) {
      try {
        const res = await fetch(target.url + `?secret=${API_KEY}`);
        const json = await res.json();
        console.log(`  ${target.name}:`, JSON.stringify({
          status: json.status,
          checked: json.checked,
          pullbacks: json.pullbacks,
          traded: json.traded,
          errors: json.errors?.length,
        }));
        if (json.errors?.length) {
          json.errors.slice(0, 5).forEach(e => console.log(`    ${e.instId || e.symbol}: ${e.error}`));
        }
      } catch (e) {
        console.log(`  ${target.name} ERRO:`, e.message);
      }
    }

  } catch (e) {
    console.error('❌', e.message);
  }

  await browser.close();
  console.log('\n✅ Done');
})();
