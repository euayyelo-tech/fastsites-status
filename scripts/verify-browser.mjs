import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { components } from '../site/status-model.mjs';

const modulePath = process.env.FASTBOT_PLAYWRIGHT;
if (!modulePath) throw new Error('FASTBOT_PLAYWRIGHT must point to the installed Playwright module.');
const { chromium } = await import(pathToFileURL(modulePath).href);
const allowed = new Set(['index.html', 'status.css', 'status-page.mjs', 'status-model.mjs']);
const server = createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!allowed.has(name)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript');
  res.end(await readFile(new URL(`../site/${name}`, import.meta.url)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const data = () => ({ checkedAt: new Date().toISOString(), services: components.map(s => ({ ...s, state: 'operational' })), incidents: [], maintenance: [] });
const screenshots = new URL('../evidence/', import.meta.url); await mkdir(screenshots, { recursive: true });
try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme });
    const page = await context.newPage(); let fixture = data();
    await page.route('**/status.json?*', route => fixture === 'unavailable' ? route.abort() : route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture) }));
    const verify = async (state, title) => {
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('[data-service="website"]'));
      assert.equal(await page.locator('#overview').getAttribute('data-state'), state);
      assert.match(await page.locator('h1').innerText(), title);
      assert.equal(await page.locator('[data-service]').count(), 8);
      assert.ok((await page.locator('.button').evaluate(el => getComputedStyle(el).boxShadow)) !== 'none');
    };
    await verify('operational', /All monitored services online/);
    fixture = data(); fixture.services[1].state = 'unknown'; await verify('unknown', /not fully verified/);
    await page.screenshot({ path: new URL(`status-${colorScheme}.png`, screenshots).pathname.replace(/^\/(C:)/, '$1'), fullPage: true });
    fixture.services[0].state = 'outage'; await verify('partial-outage', /Partial service outage/);
    fixture = data(); fixture.services.forEach(s => { s.state = 'outage'; }); await verify('outage', /Major service outage/);
    fixture = data(); fixture.incidents = [{ title: '<script>unsafe</script>', body: '<img src=x onerror=alert(1)>', date: new Date().toISOString(), state: 'investigating' }]; await verify('degraded', /Some services are disrupted/);
    assert.equal(await page.locator('#incidents script, #incidents img').count(), 0);
    fixture = { ...data(), checkedAt: new Date(Date.now() - 16 * 60000).toISOString() }; await verify('unknown', /not fully verified/);
    assert.equal(await page.locator('.state.operational').count(), 0);
    fixture = data(); fixture.services[0].state = ['operational']; await verify('unknown', /not fully verified/);
    fixture = 'unavailable'; await verify('unknown', /not fully verified/);
    fixture = data(); fixture.services[1].state = 'unknown';
    await page.setViewportSize({ width: 390, height: 844 }); await verify('unknown', /not fully verified/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile overflow');
    await page.screenshot({ path: new URL(`status-mobile-${colorScheme}.png`, screenshots).pathname.replace(/^\/(C:)/, '$1'), fullPage: true });
    await context.close();
  }
  console.log('STATUS BROWSER VERIFIED: light/dark, online/offline/partial outage, incidents, missing/stale/invalid reports, raised buttons and mobile.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
