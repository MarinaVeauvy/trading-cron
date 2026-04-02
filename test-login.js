const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  // Buscar credenciais
  let email, pass;
  const envPaths = ['.env', '../aguia-trader/.env.local', '../aguia-trader-2/.env.local'];
  for (const p of envPaths) {
    try {
      const env = fs.readFileSync(p, 'utf8');
      if (!email) email = env.match(/AGUIA_EMAIL=(.*)/)?.[1]?.trim();
      if (!pass) pass = env.match(/AGUIA_PASSWORD=(.*)/)?.[1]?.trim();
    } catch {}
  }

  console.log('Email found:', !!email);
  console.log('Pass found:', !!pass);
  if (!email || !pass) { console.log('Sem credenciais'); return; }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://app.aguiaspread.com.br/Identity/Account/Login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    await page.fill('#Input_Email', email);
    await page.fill('#Input_Password', pass);

    const rememberMe = await page.$('#Input_RememberMe');
    if (rememberMe) await rememberMe.check();

    await page.click('button[type="submit"]');
    await page.waitForTimeout(5000);

    const url = page.url();
    console.log('URL after login:', url);

    if (url.includes('Login')) {
      // Verificar se tem erro na página
      const errorText = await page.$eval('.validation-summary-errors, .text-danger, .alert-danger', el => el.textContent.trim()).catch(() => '');
      console.log('Erro:', errorText || 'Nenhum erro visível');
      console.log('LOGIN FALHOU');
    } else {
      console.log('LOGIN OK!');

      // Fast alertas
      await page.goto('https://app.aguiaspread.com.br/aguia/fast-alertas', { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(3000);
      console.log('Page:', page.url());

      // Extrair dados da tabela
      const tableData = await page.evaluate(() => {
        const rows = document.querySelectorAll('table tbody tr');
        return Array.from(rows).slice(0, 10).map(tr => {
          const tds = tr.querySelectorAll('td');
          const cells = Array.from(tds).map(td => td.textContent.trim());
          // Detectar cor (verde=LONG, vermelho=SHORT)
          const firstTd = tds[0];
          const color = firstTd ? getComputedStyle(firstTd).color : '';
          const bgColor = firstTd ? getComputedStyle(firstTd).backgroundColor : '';
          return { cells, color, bgColor };
        });
      });

      console.log('\nFast Alerts (10 primeiros):');
      tableData.forEach((row, i) => console.log(`  ${i + 1}.`, JSON.stringify(row.cells), 'cor:', row.color));
      console.log('\nTotal rows encontrados:', tableData.length);
    }
  } catch (e) {
    console.error('Erro:', e.message);
  }

  await browser.close();
})();
