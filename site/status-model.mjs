export const components = [
  { id: 'website', name: 'FastSites website', detail: 'Public website reachability.' },
  { id: 'client-websites', name: 'Client websites', detail: 'Independent customer delivery monitoring is not connected yet.' },
  { id: 'dashboard', name: 'Dashboard & editor', detail: 'An authenticated editing and publishing check is not configured.' },
  { id: 'billing', name: 'Domains & billing', detail: 'A safe domain and checkout check is not configured.' },
  { id: 'email', name: 'Business email', detail: 'Mail delivery is not independently verified by a webmail page check.' },
  { id: 'fastbot', name: 'FastBot assistance', detail: 'A dedicated assistance check is not configured.' },
  { id: 'api', name: 'FastSites API', detail: 'Public API health endpoint.' },
  { id: 'webmail', name: 'GetInbox web access', detail: 'Public webmail front door, not mailbox delivery.' },
];
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const validService = x => object(x) && text(x.id, 60) && text(x.name, 100)
  && typeof x.state === 'string' && ['operational', 'degraded', 'outage', 'unknown'].includes(x.state)
  && text(x.detail, 1000);
export const validNotice = x => object(x) && text(x.title, 200) && text(x.body, 3000)
  && typeof x.date === 'string' && Number.isFinite(Date.parse(x.date))
  && typeof x.state === 'string' && ['investigating', 'identified', 'monitoring', 'resolved', 'scheduled'].includes(x.state);
export const emptyFeed = () => ({ checkedAt: '', services: components.map(s => ({ ...s, state: 'unknown' })), incidents: [], maintenance: [] });

export function validateFeed(value, now = Date.now()) {
  if (!object(value) || typeof value.checkedAt !== 'string') return null;
  const checked = Date.parse(value.checkedAt);
  if (!Number.isFinite(checked) || now - checked > 900000 || checked - now > 60000) return null;
  if (!Array.isArray(value.services) || !value.services.length || value.services.length > 50 || !value.services.every(validService)) return null;
  if (new Set(value.services.map(s => s.id)).size !== value.services.length
    || new Set(value.services.map(s => s.name.toLowerCase())).size !== value.services.length) return null;
  if (![value.incidents, value.maintenance].every(xs => Array.isArray(xs) && xs.length <= 100 && xs.every(validNotice))) return null;
  const supplied = new Map(value.services.map(s => [s.id, s]));
  const services = components.map(s => ({ ...s, ...(supplied.get(s.id) ?? { state: 'unknown' }), id: s.id, name: s.name }));
  services.push(...value.services.filter(s => !components.some(expected => expected.id === s.id)));
  return { checkedAt: value.checkedAt, services, incidents: value.incidents, maintenance: value.maintenance };
}

export function overall(feed) {
  const states = feed.services.map(s => s.state);
  if (states.length && states.every(s => s === 'outage')) return { state: 'outage', title: 'Major service outage.', description: 'All listed services are reporting an interruption. Follow the updates below.' };
  if (states.includes('outage')) return { state: 'partial-outage', title: 'Partial service outage.', description: 'A service is reporting an interruption. Other services may still be available; check each component below.' };
  if (states.includes('degraded') || feed.incidents.some(i => !['resolved', 'scheduled'].includes(i.state))) return { state: 'degraded', title: 'Some services are disrupted.', description: 'Degraded performance or an active incident is being reported. See the affected services below.' };
  if (!feed.checkedAt || !states.length || states.includes('unknown')) return { state: 'unknown', title: 'Live status is not fully verified.', description: 'Some checks are not connected or their results are unavailable. This does not mean those services are offline.' };
  return { state: 'operational', title: 'All monitored services online.', description: 'The latest independent checks report normal operation. Individual website issues can still occur.' };
}
