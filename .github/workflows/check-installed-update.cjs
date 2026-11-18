// Управляем кнопками предыдущей публичной сборки, не подменяя события updater.
const { chromium } = require('playwright-core');
const { setTimeout: delay } = require('node:timers/promises');

async function checkUpdate() {
  const endpoint = 'http://127.0.0.1:9222';
  const deadline = Date.now() + 60000;
  while (!(await fetch(`${endpoint}/json/version`).catch(() => null))?.ok) {
    if (Date.now() >= deadline) throw new Error('Installed GoyMusic did not open its debugging port');
    await delay(500);
  }
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent('page');
  // Старая версия ещё без aria-label на иконках. Ищем кнопки только внутри уведомления.
  const banner = page.locator('div').filter({ has: page.getByRole('button', { name: 'Позже', exact: true }) })
    .filter({ has: page.getByText(process.env.EXPECTED, { exact: true }) }).last();
  await banner.getByRole('button').first().click({ timeout: 120000 });
  const downloaded = page.getByText('Обновление загружено — перезапустите', { exact: true });
  await downloaded.waitFor({ timeout: 300000 });
  const install = downloaded.locator('..').getByRole('button');
  await install.click({ noWaitAfter: true }).catch(error => {
    if (browser.isConnected() && !page.isClosed()) throw error;
  });
  // Далее PowerShell проверяет версию запущенного exe в исходном каталоге.
}

checkUpdate().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
