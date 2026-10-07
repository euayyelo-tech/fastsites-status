import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FASTBOT_PLAYWRIGHT).href);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  // Isolated browser failure injection only; no actual FastSites service is stopped.
  const independent = await browser.newContext();
  await independent.route(/^https:\/\/(?:[^/]+\.)?fastsites\.app(?:\/|$)/, route => route.abort());
  const page = await independent.newPage();
  const response = await page.goto('https://euayyelo-tech.github.io/fastsites-status/', { waitUntil: 'domcontentloaded' });
  assert.equal(response.status(), 200);
  await page.locator('[data-service="api"]').waitFor();
  assert.equal(await page.locator('[data-service]').count(), 8);
  assert.match(await page.locator('#checked').innerText(), /Last checked/);
  assert.equal(await page.locator('[data-service="client-websites"] .state').innerText(), 'Unverified');
  assert.notEqual(await page.locator('#overview').getAttribute('data-state'), 'operational');
  await independent.close();

  const staging = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await staging.addCookies([{ name: 'fs_country', value: 'GB', url: 'https://staging.fastsites.app' }]);
  const app = await staging.newPage();
  await app.addLocatorHandler(app.locator('dialog[open][aria-labelledby="promotion-title"]'), async () => app.keyboard.press('Escape'));
  const errors = []; app.on('pageerror', e => errors.push(e.message));
  const staged = await app.goto('https://staging.fastsites.app/status', { waitUntil: 'domcontentloaded', timeout: 60000 });
  assert.equal(staged.status(), 200);
  const status = app.locator('[data-status-version="client-sites-v2"]'); await status.waitFor();
  assert.equal(await status.locator('[data-service]').count(), 8, 'Staging must consume the independent eight-component feed');
  assert.match(await status.innerText(), /Checked .* UTC/);
  assert.doesNotMatch(await status.innerText(), /No fresh monitoring report/);
  for (const id of ['client-websites', 'dashboard', 'billing', 'email', 'fastbot']) assert.equal(await status.locator(`[data-service="${id}"] [data-state]`).getAttribute('data-state'), 'unknown');
  assert.notEqual(await status.getAttribute('data-overall'), 'operational');
  for (const id of ['api', 'webmail']) assert.equal(await status.locator(`[data-service="${id}"]`).count(), 1);
  await app.setViewportSize({ width: 390, height: 844 });
  assert.ok(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
  await staging.close();
  const heads = execFileSync('git', ['ls-remote', 'https://github.com/euayyelo-tech/fastsites-frontend.git', 'refs/heads/main', 'refs/heads/staging'], { encoding: 'utf8' });
  assert.match(heads, /^351ff6161e22c65c70fadd469aa0a76a8565353b\s+refs\/heads\/main$/m, 'Production main must remain unchanged');
  assert.match(heads, /^acd7c1ff57be6277f118da685b58a8efe0697085\s+refs\/heads\/staging$/m, 'Staging release head');
  console.log('STATUS INTEGRATION VERIFIED: independent host survives isolated FastSites-origin failures; staging consumes fresh eight-component feed; unconfigured customer coverage stays unknown; mobile and production protection pass.');
} finally { await browser.close(); }
