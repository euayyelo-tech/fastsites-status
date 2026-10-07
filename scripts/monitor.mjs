import { readFile, writeFile } from 'node:fs/promises';

const checks = [
  { name: 'FastSites website', url: 'https://fastsites.app', good: status => status >= 200 && status < 400, detail: 'Public website reachability' },
  { name: 'FastSites API', url: 'https://api.fastsites.app/health', good: status => status === 200, detail: 'API health endpoint' },
  { name: 'GetInbox web access', url: 'https://app.getinbox.co.uk/mail/demo', good: status => status >= 200 && status < 400, detail: 'Webmail front door reachability' },
];

async function check({ name, url, good, detail }) {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'FastSites-independent-status/1.0' } });
    return { name, state: good(response.status) ? 'operational' : 'outage', detail: `${detail} · HTTP ${response.status}` };
  } catch { return { name, state: 'outage', detail: `${detail} · check failed` }; }
}

const services = await Promise.all(checks.map(check));
for (const name of ['Dashboard & editor', 'Domains & billing', 'FastBot assistance']) services.push({ name, state: 'unknown', detail: 'Dedicated synthetic check not yet configured' });
const updates = JSON.parse(await readFile(new URL('../site/updates.json', import.meta.url), 'utf8'));
const probeIncident = services.filter(service => service.state === 'outage').map(service => ({
  title: `${service.name} reachability check failed`,
  date: new Date().toISOString(),
  body: 'The independent public check could not confirm reachability. We are investigating; this does not by itself confirm that all customer functions are unavailable.',
  state: 'investigating',
}));
const report = { checkedAt: new Date().toISOString(), services, incidents: [...probeIncident, ...(updates.incidents ?? [])], maintenance: updates.maintenance ?? [] };
await writeFile(new URL('../site/status.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(services.map(service => `${service.name}: ${service.state}`).join('\n'));
