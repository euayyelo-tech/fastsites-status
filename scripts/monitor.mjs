import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { components, validNotice } from '../site/status-model.mjs';

// URLs/markers supplied via Actions secrets never appear in public reports or logs.
const publicChecks = [
  { id: 'website', name: 'FastSites website', url: 'https://fastsites.app', marker: 'FastSites', detail: 'Public website reachability and content' },
  { id: 'api', name: 'FastSites API', url: 'https://api.fastsites.app/health', json: true, detail: 'Public API health endpoint; not every API operation' },
  { id: 'webmail', name: 'GetInbox web access', url: 'https://app.getinbox.co.uk/mail/demo', marker: 'GetInbox', detail: 'Webmail front door content; not mailbox or SMTP delivery' },
];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function boundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('Response too large');
      body += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function probe(check, { fetchImpl = fetch, pause = wait } = {}) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await pause(750);
    try {
      const response = await fetchImpl(check.url, {
        method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'FastSites-independent-status/2.0' },
      });
      if ([401, 403, 429].includes(response.status)) {
        await response.body?.cancel();
        attempts.push({ state: 'unknown', detail: 'Probe blocked or rate-limited; service health cannot be verified' });
      } else if (response.status !== 200) {
        await response.body?.cancel();
        attempts.push({ state: 'outage', detail: `HTTP ${response.status}` });
      } else {
        const body = await boundedBody(response);
        if (/cf-chl-|Just a moment\.\.\.|Attention Required!/.test(body)) {
          attempts.push({ state: 'unknown', detail: 'Challenge page returned; service health cannot be verified' });
          continue;
        }
        let valid = false;
        if (check.json) { try { valid = JSON.parse(body)?.ok === true; } catch {} }
        else valid = typeof check.marker === 'string' && check.marker.length > 0 && body.includes(check.marker);
        if (valid) return { id: check.id, name: check.name, state: attempts.length ? 'degraded' : 'operational', detail: `${check.detail}. ${attempts.length ? 'Initial check failed; retry succeeded.' : 'HTTP 200 and expected content confirmed.'}` };
        attempts.push({ state: 'outage', detail: 'Expected health response or content not found' });
      }
    } catch { attempts.push({ state: 'outage', detail: 'Public reachability check failed' }); }
  }
  const state = attempts.some(a => a.state === 'unknown') ? 'unknown' : 'outage';
  const detail = attempts.find(a => a.state === state)?.detail;
  return { id: check.id, name: check.name, state, detail: `${check.detail}. ${detail}; checked twice.` };
}

function canary(url, marker) {
  if (!url && !marker) return null;
  try {
    const address = new URL(url);
    if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash
      || /^(localhost|127\.|0\.|\[|10\.|192\.168\.)/.test(address.hostname) || !marker || marker.length > 500) return false;
    return { id: 'client-websites', name: 'Client websites', url, marker, detail: 'Owner-controlled customer delivery canary' };
  } catch { return false; }
}

export async function buildReport({ env = process.env, updates = { incidents: [], maintenance: [] }, now = Date.now(), ...deps } = {}) {
  if (![updates?.incidents, updates?.maintenance].every(xs => Array.isArray(xs) && xs.length <= 100 && xs.every(validNotice))) throw new Error('Invalid public incident/maintenance notices');
  const checked = await Promise.all(publicChecks.map(check => probe(check, deps)));
  const client = canary(env.CLIENT_SITE_CHECK_URL, env.CLIENT_SITE_CONTENT_MARKER);
  const custom = canary(env.CLIENT_CUSTOM_DOMAIN_CHECK_URL, env.CLIENT_CUSTOM_DOMAIN_CONTENT_MARKER);
  if (client === false || custom === false || (!client && custom)) {
    checked.push({ id: 'client-websites', name: 'Client websites', state: 'unknown', detail: 'Customer canary configuration is incomplete or invalid; no health claim is made.' });
  } else if (client) {
    const results = await Promise.all([probe(client, deps), ...(custom ? [probe(custom, deps)] : [])]);
    const state = ['outage', 'unknown', 'degraded', 'operational'].find(s => results.some(r => r.state === s));
    checked.push({ id: 'client-websites', name: 'Client websites', state,
      detail: `${custom ? 'Customer subdomain and custom-domain delivery canaries' : 'Customer subdomain delivery canary; custom-domain delivery is not monitored'}. ${state === 'operational' ? 'Expected content confirmed' : 'See delivery-check state'}. This is a sample, not a check of every customer website.` });
  }
  const services = components.map(expected => checked.find(s => s.id === expected.id) ?? { ...expected, state: 'unknown' });
  const previous = new Map((updates.incidents ?? []).map(i => [i.title, i]));
  const automatic = services.filter(s => s.state === 'outage').map(s => {
    const title = `${s.name} independent check failed`;
    return previous.get(title) ?? { title, date: new Date(now).toISOString(), state: 'investigating', body: 'The independent check failed twice. This indicates a monitored delivery problem, but does not by itself confirm that every customer function is unavailable.' };
  });
  return { checkedAt: new Date(now).toISOString(), services, incidents: [...automatic, ...updates.incidents.filter(i => !automatic.some(a => a.title === i.title))], maintenance: updates.maintenance };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const updates = JSON.parse(await readFile(new URL('../site/updates.json', import.meta.url), 'utf8'));
  const report = await buildReport({ updates });
  await writeFile(new URL('../site/status.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(report.services.map(s => `${s.name}: ${s.state}`).join('\n'));
}
