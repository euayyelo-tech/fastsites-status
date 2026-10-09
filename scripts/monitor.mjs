import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import { components, validNotice } from '../site/status-model.mjs';

// URLs/markers supplied via Actions secrets never appear in public reports or logs.
//
// Every check says exactly what it covers in `detail`. A green component means
// that specific check passed, never that the whole product works.
const publicChecks = [
  // `allowGate`: before launch the public sees a holding page. Serving it IS what the public gets, so it counts as reachable.
  { id: 'website', name: 'FastSites website', url: 'https://fastsites.app', marker: 'FastSites', allowGate: true, detail: 'Public website reachability and content' },
  { id: 'api', name: 'FastSites API', url: 'https://api.fastsites.app/health', json: true, detail: 'Public API health endpoint; not every API operation' },
  { id: 'webmail', name: 'GetInbox web access', url: 'https://app.getinbox.co.uk/mail/demo', marker: 'GetInbox', detail: 'Webmail front door content; not mailbox or SMTP delivery' },
  // An unauthenticated request must be refused with the API's own JSON error: proof that the sign-in layer is up.
  { id: 'dashboard', name: 'Dashboard & editor', url: 'https://api.fastsites.app/projects', expectStatus: 401, marker: 'Authorization', detail: 'Sign-in API refuses an unauthenticated request correctly; editing and publishing are not exercised' },
  { id: 'fastbot', name: 'FastBot assistance', url: 'https://api.fastsites.app/kb/quick-questions?audience=sales', jsonArray: 'nodes', detail: 'Chat knowledge service responds; the quality of an individual answer is not tested' },
  // The website asks each part one read-only question and answers ok/down/off per part (fastsites-frontend
  // src/app/api/status/billing/route.ts). A 404 means that endpoint is not deployed there yet, not that billing is down.
  { id: 'billing', name: 'Domains & billing', url: 'https://fastsites.app/api/status/billing', missingIsUnknown: true,
    parts: { prices: 'Price list', stripe: 'Stripe', paddle: 'Paddle', domains: 'Domain registrar' },
    detail: 'Price list, card payments (Stripe and Paddle) and the domain registrar each answer a read-only question; no payment or registration is made' },
];
// Mail servers: connect, read the greeting. No login and no message is sent.
const mailCheck = {
  id: 'email', name: 'Business email', host: 'mail.getinbox.co.uk',
  ports: [{ port: 993, tls: true, greeting: /^\* OK/, label: 'IMAP' }, { port: 587, tls: false, greeting: /^220[ -]/, label: 'SMTP' }],
  detail: 'Mail server accepts IMAP and SMTP connections and greets correctly; delivery of an individual message is not tested',
};
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

const listed = names => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];

// A per-part health answer, { parts: { name: 'ok' | 'down' | 'off' } }, read against the parts the check expects.
export function partsVerdict(body, labels) {
  let parts;
  try { parts = JSON.parse(body)?.parts; } catch {}
  const names = Object.keys(labels);
  if (!parts || typeof parts !== 'object' || !names.every(n => ['ok', 'down', 'off'].includes(parts[n]))) {
    return { state: 'outage', detail: 'Expected health response not found' };
  }
  const where = want => names.filter(n => parts[n] === want).map(n => labels[n]);
  const [ok, down, off] = [where('ok'), where('down'), where('off')];
  const answered = ok.length ? `; ${listed(ok)} answered` : '';
  if (down.length && !ok.length) return { state: 'outage', detail: `${listed(down)} did not answer` };
  if (down.length) return { state: 'degraded', detail: `${listed(down)} did not answer${answered}` };
  if (off.length) return { state: 'unknown', detail: `${listed(off)} ${off.length > 1 ? 'are' : 'is'} not set up on the live site, so cannot be checked${answered}` };
  return { state: 'operational', detail: 'Every part answered' };
}

export async function probe(check, { fetchImpl = fetch, pause = wait } = {}) {
  const attempts = [];
  const expected = check.expectStatus ?? 200;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await pause(750);
    try {
      const response = await fetchImpl(check.url, {
        method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'FastSites-independent-status/2.0' },
      });
      // The pre-launch gate (soft launch or coming soon) answers 200 with a holding page for visitors it does not know.
      const gate = response.headers?.get?.('x-fs-gate');
      if (gate && response.status === 200) {
        await response.body?.cancel();
        if (check.allowGate) return { id: check.id, name: check.name, state: 'operational', detail: `${check.detail}. HTTP 200: the public pre-launch page is being served.` };
        return { id: check.id, name: check.name, state: 'unknown', detail: `${check.detail}. Public access is restricted before launch, so health cannot be verified from outside.` };
      }
      if (check.missingIsUnknown && response.status === 404) {
        await response.body?.cancel();
        return { id: check.id, name: check.name, state: 'unknown', detail: `${check.detail}. The check is not deployed on the live site yet, so health cannot be verified.` };
      }
      if (response.status !== expected && [401, 403, 429].includes(response.status)) {
        await response.body?.cancel();
        attempts.push({ state: 'unknown', detail: 'Probe blocked or rate-limited; service health cannot be verified' });
      } else if (response.status !== expected) {
        await response.body?.cancel();
        attempts.push({ state: 'outage', detail: `HTTP ${response.status}` });
      } else {
        const body = await boundedBody(response);
        if (/cf-chl-|Just a moment\.\.\.|Attention Required!/.test(body)) {
          attempts.push({ state: 'unknown', detail: 'Challenge page returned; service health cannot be verified' });
          continue;
        }
        if (check.parts) {
          const verdict = partsVerdict(body, check.parts);
          if (verdict.state === 'operational') return { id: check.id, name: check.name, state: attempts.length ? 'degraded' : 'operational', detail: `${check.detail}. ${attempts.length ? 'Initial check failed; retry succeeded.' : `${verdict.detail}.`}` };
          // Some parts down, or not set up, is the site's own considered answer: report it as is. Nothing working is retried once.
          if (verdict.state !== 'outage') return { id: check.id, name: check.name, state: verdict.state, detail: `${check.detail}. ${verdict.detail}.` };
          attempts.push(verdict);
          continue;
        }
        let valid = false;
        if (check.json) { try { valid = JSON.parse(body)?.ok === true; } catch {} }
        else if (check.jsonArray) { try { valid = Array.isArray(JSON.parse(body)?.[check.jsonArray]); } catch {} }
        else valid = typeof check.marker === 'string' && check.marker.length > 0 && body.includes(check.marker);
        if (valid) return { id: check.id, name: check.name, state: attempts.length ? 'degraded' : 'operational', detail: `${check.detail}. ${attempts.length ? 'Initial check failed; retry succeeded.' : `HTTP ${expected} and expected content confirmed.`}` };
        attempts.push({ state: 'outage', detail: 'Expected health response or content not found' });
      }
    } catch { attempts.push({ state: 'outage', detail: 'Public reachability check failed' }); }
  }
  const state = attempts.some(a => a.state === 'unknown') ? 'unknown' : 'outage';
  const detail = attempts.find(a => a.state === state)?.detail;
  return { id: check.id, name: check.name, state, detail: `${check.detail}. ${detail}; checked twice.` };
}

// Connect to a mail port and read the first line the server sends.
export function readGreeting({ host, port, tls: secure }, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let data = '';
    const done = (fn, value) => { socket.destroy(); fn(value); };
    socket.setTimeout(timeout, () => done(reject, new Error('timeout')));
    socket.on('error', error => done(reject, error));
    socket.on('data', chunk => { data += chunk.toString('utf8'); if (data.includes('\n') || data.length > 512) done(resolve, data); });
  });
}

export async function probeMail(check, { greetingImpl = readGreeting, pause = wait } = {}) {
  const once = async () => Promise.all(check.ports.map(async spec => {
    try { return spec.greeting.test((await greetingImpl({ host: check.host, port: spec.port, tls: spec.tls })).trim()); } catch { return false; }
  }));
  let results = await once();
  let retried = false;
  if (!results.every(Boolean)) { await pause(750); results = await once(); retried = true; }
  const ok = results.filter(Boolean).length;
  if (ok === results.length) return { id: check.id, name: check.name, state: 'operational', detail: `${check.detail}.` };
  const failed = check.ports.filter((_, i) => !results[i]).map(p => p.label).join(' and ');
  if (ok > 0) return { id: check.id, name: check.name, state: 'degraded', detail: `${check.detail}. ${failed} did not answer correctly${retried ? '; checked twice' : ''}.` };
  return { id: check.id, name: check.name, state: 'outage', detail: `${check.detail}. No mail port answered correctly; checked twice.` };
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
  const checked = await Promise.all([...publicChecks.map(check => probe(check, deps)), probeMail(mailCheck, deps)]);
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
