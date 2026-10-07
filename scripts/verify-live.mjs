import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateFeed, overall } from '../site/status-model.mjs';
const origin = 'https://euayyelo-tech.github.io/fastsites-status';
const canonical = text => text.replace(/\r\n/g, '\n');
const page = await fetch(`${origin}/?verification=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
assert.equal(page.status, 200); const html = await page.text(); assert.ok(html.includes('independent-client-sites-v2'));
assert.equal(canonical(html), canonical(await readFile(new URL('../site/index.html', import.meta.url), 'utf8')), 'Deployed HTML must match the release');
for (const asset of ['status.css', 'status-model.mjs', 'status-page.mjs']) {
  const response = await fetch(`${origin}/${asset}`, { signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200, asset);
  assert.equal(canonical(await response.text()), canonical(await readFile(new URL(`../site/${asset}`, import.meta.url), 'utf8')), `Deployed ${asset} must match the release`);
}
const response = await fetch(`${origin}/status.json?verification=${Date.now()}`, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
assert.equal(response.status, 200); const report = validateFeed(await response.json());
assert.ok(report, 'Report must be valid and no more than 15 minutes old');
assert.equal(report.services.length, 8);
for (const id of ['website', 'api', 'webmail']) {
  const component = report.services.find(s => s.id === id); assert.ok(component); assert.ok(!component.detail.startsWith('Public website reachability.'), 'Probe evidence must be present');
}
for (const id of ['client-websites', 'dashboard', 'billing', 'email', 'fastbot']) assert.equal(report.services.find(s => s.id === id).state, 'unknown', `${id} cannot claim unconfigured coverage`);
assert.notEqual(overall(report).state, 'operational');
console.log(`INDEPENDENT STATUS LIVE VERIFIED: checked ${report.checkedAt}; ${report.services.map(s => s.id + '=' + s.state).join(', ')}.`);
