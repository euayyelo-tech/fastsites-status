import { emptyFeed, overall, validateFeed } from './status-model.mjs';
const labels = { operational: 'Operational', degraded: 'Degraded', outage: 'Outage', unknown: 'Unverified' };
const overview = document.getElementById('overview');
const serviceBox = document.getElementById('services');

function renderNotices(id, notices, empty) {
  const parent = document.getElementById(id);
  parent.replaceChildren();
  if (!notices.length) {
    const p = document.createElement('p'); p.className = 'empty'; p.textContent = empty; parent.append(p); return;
  }
  for (const entry of notices) {
    const article = document.createElement('article'); article.className = 'notice';
    const stamp = document.createElement('small'); stamp.textContent = `${entry.state} · ${new Date(entry.date).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC`;
    const title = document.createElement('strong'); title.textContent = entry.title;
    const body = document.createElement('p'); body.textContent = entry.body;
    article.append(stamp, title, body); parent.append(article);
  }
}

export function render(raw) {
  const data = validateFeed(raw);
  const feed = data ?? emptyFeed();
  const status = overall(feed);
  overview.dataset.state = status.state;
  document.getElementById('status-title').textContent = status.title;
  document.getElementById('status-description').textContent = status.description;
  document.getElementById('status-label').textContent = { operational: 'Online', outage: 'Offline', 'partial-outage': 'Partial outage', degraded: 'Service disruption', unknown: 'Not fully verified' }[status.state];
  document.getElementById('checked').textContent = data ? `Last checked ${new Date(data.checkedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC` : 'The report is missing, invalid or older than 15 minutes. No live operational claim is being made.';
  serviceBox.replaceChildren();
  for (const service of feed.services) {
    const row = document.createElement('div'); row.className = 'row'; row.dataset.service = service.id;
    const left = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = service.name;
    const detail = document.createElement('small'); detail.textContent = service.detail;
    left.append(strong, detail);
    const state = document.createElement('span'); state.className = `state ${service.state}`; state.textContent = labels[service.state];
    row.append(left, state); serviceBox.append(row);
  }
  renderNotices('incidents', feed.incidents, data ? 'No incidents in the current report. Unverified services may still have issues.' : 'A current incident report is unavailable.');
  renderNotices('maintenance', feed.maintenance, data ? 'No maintenance in the current report.' : 'A current maintenance report is unavailable.');
}

async function refresh() {
  try {
    const response = await fetch(`./status.json?checked=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Report unavailable');
    render(await response.json());
  } catch { render(null); }
}
await refresh();
setInterval(refresh, 60000);
