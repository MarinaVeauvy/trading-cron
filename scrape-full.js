// Scraper COMPLETO — pega TODOS os alertas de TODAS as categorias
const { chromium } = require('playwright');
const fs = require('fs');

const API_KEY = '57ae177908be2d04ff979ac1c4a2e1bfe2fd778660e69cc38ada77d505c3570f';
const TARGETS = [
  { name: 'OKX', url: 'https://aguia-trader.vercel.app/api/cron' },
  { name: 'OKX2', url: 'https://aguia-trader-2.vercel.app/api/cron' },
  { name: 'Bybit', url: 'https://bybit-trader-three.vercel.app/api/cron' },
];

const PAGES = [
  { url: 'https://app.aguiaspread.com.br/aguia/fast-alertas', type: 'fast', label: 'Fast Alertas' },
  { url: 'https://app.aguiaspread.com.br/aguia/pre-alertas', type: 'pre', label: 'Pré-Alertas' },
  { url: 'https://app.aguiaspread.com.br/aguia/alertas', type: 'alert', label: 'Alertas' },
  { url: 'https://app.aguiaspread.com.br/sinais/sinais-milionarios', type: 'signal', label: 'Sinais' },
];

async function extractTable(page) {
  return await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    return Array.from(rows).map(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 5) return null;

      // Direção via ícone/cor
      let direction = 'UNKNOWN';
      const icon = tds[0].querySelector('i, svg, span, div');
      if (icon) {
        const cls = (icon.className || '').toLowerCase();
        const style = (icon.getAttribute('style') || '').toLowerCase();
        const parentCls = (icon.parentElement?.className || '').toLowerCase();
        // Verde/up = LONG
        if (cls.includes('up') || cls.includes('green') || cls.includes('success') ||
            style.includes('green') || style.includes('#28a745') || style.includes('#22c55e') ||
            parentCls.includes('success') || parentCls.includes('green')) {
          direction = 'LONG';
        }
        // Vermelho/down = SHORT
        else if (cls.includes('down') || cls.includes('red') || cls.includes('danger') ||
            style.includes('red') || style.includes('#dc3545') || style.includes('#ef4444') ||
            parentCls.includes('danger') || parentCls.includes('red')) {
          direction = 'SHORT';
        }
      }
      // Fallback: cor computada do ícone
      if (direction === 'UNKNOWN' && icon) {
        const color = getComputedStyle(icon).color;
        if (color) {
          const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
          if (match) {
            const [, r, g, b] = match.map(Number);
            if (g > 150 && r < 100) direction = 'LONG';  // Verde
            else if (r > 150 && g < 100) direction = 'SHORT';  // Vermelho
          }
        }
      }

      const cells = Array.from(tds).map(td => td.textContent.trim());
      const price = parseFloat((cells[4] || '0').replace(/\./g, '').replace(',', '.'));
      const volume = parseFloat((cells[5] || '0').replace(/\./g, '').replace(',', '.'));

      return {
        asset: (cells[2] || '').trim(),
        direction,
        price: isNaN(price) ? 0 : price,
        volume: isNaN(volume) ? 0 : volume,
        timestamp: Date.now(),
        breakoutType: (cells[3] || '').trim(),
        dateAlert: (cells[1] || '').trim(),
      };
    }).filter(a => a && a.asset && a.price > 0);
  });
}

async function scrapeAllPages(page, baseUrl) {
  let allAlerts = [];
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);

  // Pegar dados da primeira página
  let pageAlerts = await extractTable(page);
  allAlerts = allAlerts.concat(pageAlerts);
  console.log(`    Página 1: ${pageAlerts.length} alertas`);

  // Verificar se tem paginação
  let pageNum = 1;
  while (pageNum < 10) { // Max 10 páginas
    const nextBtn = await page.$('a[aria-label="Next"], .pagination .next a, li.next a, a:has-text("Próximo"), a:has-text("›")');
    if (!nextBtn) break;

    const isDisabled = await nextBtn.evaluate(el => {
      return el.parentElement?.classList.contains('disabled') || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true';
    });
    if (isDisabled) break;

    await nextBtn.click();
    await page.waitForTimeout(2000);
    pageNum++;

    pageAlerts = await extractTable(page);
    if (pageAlerts.length === 0) break;
    allAlerts = allAlerts.concat(pageAlerts);
    console.log(`    Página ${pageNum}: ${pageAlerts.length} alertas`);
  }

  return allAlerts;
}

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
    console.log('✅ Login OK\n');

    let allAlerts = [];

    // Scrape todas as categorias
    for (const pg of PAGES) {
      console.log(`🦅 ${pg.label}...`);
      try {
        const alerts = await scrapeAllPages(page, pg.url);
        alerts.forEach(a => a.type = pg.type);
        allAlerts = allAlerts.concat(alerts);
        console.log(`  ✅ ${alerts.length} alertas\n`);
      } catch (e) {
        console.log(`  ❌ Erro: ${e.message}\n`);
      }
    }

    // Deduplicar
    const seen = new Set();
    const unique = allAlerts.filter(a => {
      const key = `${a.asset}_${a.type}_${a.dateAlert}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`📊 Total: ${unique.length} alertas únicos (de ${allAlerts.length} brutos)`);

    // Stats por tipo
    const byType = {};
    unique.forEach(a => { byType[a.type] = (byType[a.type] || 0) + 1; });
    Object.entries(byType).forEach(([t, c]) => console.log(`  ${t}: ${c}`));

    // Stats por direção
    const byDir = {};
    unique.forEach(a => { byDir[a.direction] = (byDir[a.direction] || 0) + 1; });
    console.log('  Direções:', JSON.stringify(byDir));

    // Amostra
    console.log('\nAmostra fast (5 primeiros):');
    unique.filter(a => a.type === 'fast').slice(0, 5).forEach(a =>
      console.log(`  ${a.asset} ${a.direction} $${a.price} vol:${Math.round(a.volume)} ${a.breakoutType}`)
    );

    if (unique.length === 0) { console.log('Nenhum alerta'); await browser.close(); return; }

    // Enviar para targets
    for (const target of TARGETS) {
      try {
        console.log(`\n📡 Enviando ${unique.length} alertas para ${target.name}...`);
        const res = await fetch(target.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alerts: unique, secret: API_KEY }),
        });
        console.log(`  ${target.name}:`, await res.json());
      } catch (e) {
        console.log(`  ${target.name} ERRO:`, e.message);
      }
    }

    // Disparar cron
    console.log('\n🏛️ Processamento Grécia...');
    for (const target of TARGETS) {
      try {
        const res = await fetch(target.url + `?secret=${API_KEY}`);
        const j = await res.json();
        console.log(`  ${target.name}: status=${j.status} checked=${j.checked} pullbacks=${j.pullbacks} traded=${j.traded} errors=${j.errors?.length || 0}`);
        if (j.trades?.length) j.trades.forEach(t => console.log(`    🎯 TRADE: ${t.instId} ${t.direction} @ $${t.actualPrice}`));
        if (j.errors?.length) j.errors.slice(0, 5).forEach(e => console.log(`    ⚠️ ${e.instId || e.symbol}: ${e.error}`));
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
