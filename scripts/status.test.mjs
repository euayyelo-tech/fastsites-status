import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, probe, probeMail, probeSites, sitesVerdict } from './monitor.mjs';
import { components, emptyFeed, overall, validateFeed } from '../site/status-model.mjs';

const now = Date.now();
const feed = () => ({ checkedAt: new Date(now).toISOString(), services: components.map(s => ({ ...s, state: 'operational' })), incidents: [], maintenance: [] });
const noPause = async () => {};
const check = { id: 'website', name: 'FastSites website', url: 'https://test.example', marker: 'EXPECTED', detail: 'Synthetic content check' };
const billingBody = (parts = {}) => JSON.stringify({ ok: true, parts: { prices: 'ok', stripe: 'ok', paddle: 'ok', domains: 'ok', ...parts } });
const billingCheck = { id: 'billing', name: 'Domains & billing', url: 'https://test.example/api/status/billing', missingIsUnknown: true,
  parts: { prices: 'Price list', stripe: 'Stripe', paddle: 'Paddle', domains: 'Domain registrar' }, detail: 'Synthetic billing check' };
const sitesBody = (over = {}) => JSON.stringify({ state: 'ready', checkedAt: new Date(now).toISOString(), subdomains: { total: 5, online: 5 }, customDomains: { total: 2, online: 2 }, ...over });
const sequence = (...responses) => { let index = 0; return async () => { const value = responses[Math.min(index++, responses.length - 1)]; if (value instanceof Error) throw value; return new Response(value.body ?? '', { status: value.status ?? 200 }); }; };
const healthyFetch = async url => {
  const u = String(url);
  if (u.endsWith('/health')) return new Response('{"ok":true}');
  if (u.endsWith('/projects')) return new Response('{"error":"Missing or invalid Authorization header"}', { status: 401 });
  if (u.includes('/kb/quick-questions')) return new Response('{"nodes":[]}');
  if (u.endsWith('/api/status/billing')) return new Response(billingBody());
  if (u.endsWith('/status/sites')) return new Response(sitesBody());
  return new Response('FastSites GetInbox EXPECTED');
};
const healthyMail = async ({ port }) => (port === 993 ? '* OK IMAP ready' : '220 smtp.example ESMTP');
const options = { env: {}, fetchImpl: healthyFetch, greetingImpl: healthyMail, pause: noPause, now };
const gated = (body = 'FastSites holding page') => async () => new Response(body, { headers: { 'x-fs-gate': 'coming-soon' } });
const incident = state => ({ title: 'Synthetic incident', body: 'A test fixture, not a live incident.', date: new Date(now).toISOString(), state });

test('healthy probes require expected content, not just HTTP 200', async () => {
  assert.equal((await probe(check, { fetchImpl: sequence({ body: 'EXPECTED' }), pause: noPause })).state, 'operational');
  assert.equal((await probe(check, { fetchImpl: sequence({ body: 'wrong page' }), pause: noPause })).state, 'outage');
});
test('API health must be a boolean true', async () => {
  for (const body of ['{"ok":false}', '{"ok":"true"}', 'invalid']) assert.equal((await probe({ ...check, json: true }, { fetchImpl: sequence({ body }), pause: noPause })).state, 'outage');
  assert.equal((await probe({ ...check, json: true }, { fetchImpl: sequence({ body: '{"ok":true}' }), pause: noPause })).state, 'operational');
});
test('retry recovery is reported as degraded', async () => {
  assert.equal((await probe(check, { fetchImpl: sequence({ status: 503 }, { body: 'EXPECTED' }), pause: noPause })).state, 'degraded');
});
test('two failed network requests are an outage', async () => {
  assert.equal((await probe(check, { fetchImpl: sequence(new Error('test failure')), pause: noPause })).state, 'outage');
});
test('blocked, rate-limited and challenge responses are unknown, not offline', async () => {
  for (const status of [401, 403, 429]) assert.equal((await probe(check, { fetchImpl: sequence({ status }), pause: noPause })).state, 'unknown');
  assert.equal((await probe(check, { fetchImpl: sequence({ body: 'Just a moment... EXPECTED cf-chl-' }), pause: noPause })).state, 'unknown');
});
test('every component is checked; client websites come from the count of every published site', async () => {
  const report = await buildReport(options);
  assert.equal(report.services.length, 8);
  for (const s of report.services) assert.equal(s.state, 'operational', s.id);
  assert.match(report.services.find(s => s.id === 'client-websites').detail, /5 of 5 customer websites answering on their fastsites\.app address; 2 of 2 custom domains answering/);
  assert.equal(overall(validateFeed(report, now)).state, 'operational');
});
test('the site count: offline sites degrade, none answering is an outage, a dark custom domain alone is not held against FastSites', async () => {
  const verdict = over => sitesVerdict(sitesBody(over), now);
  assert.equal(verdict({ subdomains: { total: 5, online: 4 } }).state, 'degraded');
  assert.match(verdict({ subdomains: { total: 5, online: 4 } }).detail, /4 of 5 customer websites/);
  assert.equal(verdict({ subdomains: { total: 5, online: 0 } }).state, 'outage');
  assert.equal(verdict({ customDomains: { total: 2, online: 1 } }).state, 'operational');
  assert.equal(verdict({ customDomains: { total: 2, online: 0 } }).state, 'degraded');
  assert.doesNotMatch(verdict({ customDomains: { total: 0, online: 0 } }).detail, /custom domains/);
});
test('the site count is unverified while pending, stale, empty or not deployed, and an outage when unreadable', async () => {
  const verdict = (body, at = now) => sitesVerdict(body, at);
  assert.equal(verdict('{"state":"pending"}').state, 'unknown');
  assert.equal(verdict('{"state":"unavailable"}').state, 'unknown');
  assert.equal(verdict(sitesBody(), now + 15 * 60_000 + 1).state, 'unknown');
  assert.equal(verdict(sitesBody({ subdomains: { total: 0, online: 0 }, customDomains: { total: 0, online: 0 } })).state, 'unknown');
  for (const body of ['not json', '{"state":"ready"}', sitesBody({ subdomains: { total: 1, online: 2 } }), sitesBody({ checkedAt: 'never' })]) assert.equal(verdict(body).state, 'outage');
  assert.equal((await probeSites({ fetchImpl: sequence({ status: 404 }), pause: noPause, now })).state, 'unknown');
  assert.equal((await probeSites({ fetchImpl: sequence({ status: 502 }, { body: sitesBody() }), pause: noPause, now })).state, 'operational', 'one failed read is retried');
  assert.equal((await probeSites({ fetchImpl: sequence(new Error('down')), pause: noPause, now })).state, 'outage');
});
test('billing is operational only when every part answers', async () => {
  const run = async (...bodies) => probe(billingCheck, { fetchImpl: sequence(...bodies), pause: noPause });
  assert.equal((await run({ body: billingBody() })).state, 'operational');
  const one = await run({ body: billingBody({ stripe: 'down' }) });
  assert.equal(one.state, 'degraded');
  assert.match(one.detail, /Stripe did not answer; Price list, Paddle and Domain registrar answered/);
  assert.equal((await run({ body: billingBody({ prices: 'down', stripe: 'down', paddle: 'down', domains: 'down' }) })).state, 'outage');
  assert.equal((await run({ body: billingBody({ prices: 'off', stripe: 'down', paddle: 'off', domains: 'off' }) })).state, 'outage', 'nothing that is set up works');
});
test('a billing part that is not set up is unverified, never green', async () => {
  const result = await probe(billingCheck, { fetchImpl: sequence({ body: billingBody({ paddle: 'off' }) }), pause: noPause });
  assert.equal(result.state, 'unknown');
  assert.match(result.detail, /Paddle is not set up on the live site/);
});
test('a malformed billing answer is an outage after a retry, and a recovered retry is degraded', async () => {
  for (const body of ['not json', '{"parts":{}}', JSON.stringify({ parts: { prices: 'ok', stripe: 'yes', paddle: 'ok', domains: 'ok' } })]) {
    assert.equal((await probe(billingCheck, { fetchImpl: sequence({ body }), pause: noPause })).state, 'outage');
  }
  assert.equal((await probe(billingCheck, { fetchImpl: sequence({ body: 'not json' }, { body: billingBody() }), pause: noPause })).state, 'degraded');
});
test('a billing endpoint that is not deployed yet is unknown, not offline', async () => {
  const result = await probe(billingCheck, { fetchImpl: sequence({ status: 404 }), pause: noPause });
  assert.equal(result.state, 'unknown');
  assert.match(result.detail, /not deployed on the live site yet/);
  // Only checks that opt in: any other 404 is still an outage.
  assert.equal((await probe(check, { fetchImpl: sequence({ status: 404 }), pause: noPause })).state, 'outage');
});
test('customer delivery checks keep URLs and content markers private', async () => {
  const env = { CLIENT_SITE_CHECK_URL: 'https://private-canary.example', CLIENT_SITE_CONTENT_MARKER: 'EXPECTED' };
  const report = await buildReport({ ...options, env });
  const client = report.services.find(s => s.id === 'client-websites');
  assert.equal(client.state, 'operational');
  assert.match(client.detail, /Test site checked independently: expected content confirmed/);
  assert.match(client.detail, /customer websites answering/);
  assert.ok(!JSON.stringify(report).includes(env.CLIENT_SITE_CHECK_URL));
  assert.ok(!JSON.stringify(report).includes(env.CLIENT_SITE_CONTENT_MARKER));
});
test('a count that is not deployed yet neither blocks a passing test site nor stands in for one', async () => {
  const noCount = async url => String(url).endsWith('/status/sites') ? new Response('', { status: 404 }) : healthyFetch(url);
  const env = { CLIENT_SITE_CHECK_URL: 'https://tenant.example', CLIENT_SITE_CONTENT_MARKER: 'EXPECTED' };
  const withSite = (await buildReport({ ...options, env, fetchImpl: noCount })).services.find(s => s.id === 'client-websites');
  assert.equal(withSite.state, 'operational');
  assert.match(withSite.detail, /not deployed on the live API yet/);
  assert.equal((await buildReport({ ...options, fetchImpl: noCount })).services.find(s => s.id === 'client-websites').state, 'unknown');
});
test('custom-domain canary failures affect the customer delivery component', async () => {
  const env = { CLIENT_SITE_CHECK_URL: 'https://tenant.example', CLIENT_SITE_CONTENT_MARKER: 'EXPECTED', CLIENT_CUSTOM_DOMAIN_CHECK_URL: 'https://custom.example', CLIENT_CUSTOM_DOMAIN_CONTENT_MARKER: 'EXPECTED' };
  const report = await buildReport({ ...options, env, fetchImpl: async url => String(url).includes('custom.example') ? new Response('', { status: 503 }) : healthyFetch(url) });
  assert.equal(report.services.find(s => s.id === 'client-websites').state, 'outage');
  assert.ok(report.incidents.some(i => i.title.startsWith('Client websites')));
});
test('incomplete or invalid canary configuration never claims healthy', async () => {
  for (const env of [
    { CLIENT_SITE_CHECK_URL: 'https://tenant.example' },
    { CLIENT_SITE_CHECK_URL: 'http://tenant.example', CLIENT_SITE_CONTENT_MARKER: 'EXPECTED' },
    { CLIENT_SITE_CHECK_URL: 'https://user:password@tenant.example', CLIENT_SITE_CONTENT_MARKER: 'EXPECTED' },
    { CLIENT_SITE_CHECK_URL: 'https://tenant.example/?token=secret', CLIENT_SITE_CONTENT_MARKER: 'EXPECTED' },
    { CLIENT_CUSTOM_DOMAIN_CHECK_URL: 'https://custom.example', CLIENT_CUSTOM_DOMAIN_CONTENT_MARKER: 'EXPECTED' },
  ]) assert.equal((await buildReport({ ...options, env })).services.find(s => s.id === 'client-websites').state, 'unknown');
});
test('failed public probes create public incidents without sensitive response bodies', async () => {
  const report = await buildReport({ ...options, fetchImpl: sequence({ status: 500, body: 'private fixture details' }) });
  assert.equal(report.incidents.length, 7);
  assert.equal(overall(validateFeed(report, now)).state, 'partial-outage');
  assert.ok(!JSON.stringify(report).includes('private fixture details'));
});
test('invalid incident notices are rejected', async () => {
  await assert.rejects(buildReport({ ...options, updates: { incidents: [{ title: 'bad' }], maintenance: [] } }));
});
test('all fresh components must be operational before an online hero appears', () => {
  assert.equal(overall(validateFeed(feed(), now)).state, 'operational');
  assert.equal(overall(emptyFeed()).state, 'unknown');
  const partial = feed(); partial.services = partial.services.filter(s => s.id !== 'client-websites');
  assert.equal(overall(validateFeed(partial, now)).state, 'unknown');
});
test('partial outage outranks unverified services; all outages report offline', () => {
  const partial = feed(); partial.services[0].state = 'outage'; partial.services[1].state = 'unknown';
  assert.equal(overall(validateFeed(partial, now)).state, 'partial-outage');
  const down = feed(); down.services.forEach(s => { s.state = 'outage'; });
  assert.equal(overall(validateFeed(down, now)).state, 'outage');
});
test('active incidents prevent green, resolved incidents do not', () => {
  const data = feed(); data.incidents = [incident('investigating')];
  assert.equal(overall(validateFeed(data, now)).state, 'degraded');
  data.incidents = [incident('resolved')]; assert.equal(overall(validateFeed(data, now)).state, 'operational');
});
test('stale, future, missing and malformed reports are rejected', () => {
  for (const value of [null, {}, { ...feed(), checkedAt: new Date(now - 900001).toISOString() }, { ...feed(), checkedAt: new Date(now + 60001).toISOString() }]) assert.equal(validateFeed(value, now), null);
  const invalid = feed(); invalid.services[0].state = ['operational']; assert.equal(validateFeed(invalid, now), null);
  invalid.services[0].state = 'made-up'; assert.equal(validateFeed(invalid, now), null);
});
test('duplicate components and malformed notices are rejected', () => {
  const duplicate = feed(); duplicate.services.push({ ...duplicate.services[0] }); assert.equal(validateFeed(duplicate, now), null);
  const bad = feed(); bad.incidents = [{ ...incident('resolved'), date: 'invalid' }]; assert.equal(validateFeed(bad, now), null);
});

test('the pre-launch gate is reachable for the website but never an outage for anything else', async () => {
  const site = await probe({ ...check, allowGate: true }, { fetchImpl: gated(), pause: noPause });
  assert.equal(site.state, 'operational');
  assert.match(site.detail, /pre-launch/);
  const webmail = await probe({ ...check, id: 'webmail', marker: 'GetInbox' }, { fetchImpl: gated(), pause: noPause });
  assert.equal(webmail.state, 'unknown');
  assert.match(webmail.detail, /restricted before launch/);
  const report = await buildReport({ ...options, fetchImpl: gated() });
  assert.equal(report.services.find(s => s.id === 'webmail').state, 'unknown');
  assert.equal(report.incidents.length, 0);
});
test('the dashboard check needs the API to refuse an unauthenticated request in its own words', async () => {
  const dash = { ...check, id: 'dashboard', url: 'https://api.example/projects', expectStatus: 401, marker: 'Authorization' };
  const body = '{"error":"Missing or invalid Authorization header"}';
  assert.equal((await probe(dash, { fetchImpl: sequence({ status: 401, body }), pause: noPause })).state, 'operational');
  assert.equal((await probe(dash, { fetchImpl: sequence({ status: 401, body: 'something else' }), pause: noPause })).state, 'outage');
  assert.equal((await probe(dash, { fetchImpl: sequence({ status: 200, body }), pause: noPause })).state, 'outage');
  assert.equal((await probe(dash, { fetchImpl: sequence({ status: 403 }), pause: noPause })).state, 'unknown');
  assert.equal((await probe(dash, { fetchImpl: sequence({ status: 500 }), pause: noPause })).state, 'outage');
});
test('the FastBot check needs a JSON list of nodes', async () => {
  const bot = { ...check, id: 'fastbot', jsonArray: 'nodes' };
  assert.equal((await probe(bot, { fetchImpl: sequence({ body: '{"nodes":[{"id":"a"}]}' }), pause: noPause })).state, 'operational');
  for (const body of ['{"nodes":"nope"}', '{}', 'not json']) assert.equal((await probe(bot, { fetchImpl: sequence({ body }), pause: noPause })).state, 'outage');
});
test('mail is healthy only when IMAP and SMTP both greet correctly', async () => {
  const mail = { id: 'email', name: 'Business email', host: 'mail.example', detail: 'Mail check',
    ports: [{ port: 993, tls: true, greeting: /^\* OK/, label: 'IMAP' }, { port: 587, tls: false, greeting: /^220[ -]/, label: 'SMTP' }] };
  assert.equal((await probeMail(mail, { greetingImpl: healthyMail, pause: noPause })).state, 'operational');
  const smtpDown = await probeMail(mail, { greetingImpl: async ({ port }) => { if (port === 587) throw new Error('refused'); return '* OK'; }, pause: noPause });
  assert.equal(smtpDown.state, 'degraded');
  assert.match(smtpDown.detail, /SMTP/);
  assert.equal((await probeMail(mail, { greetingImpl: async () => '554 go away', pause: noPause })).state, 'outage');
  assert.equal((await probeMail(mail, { greetingImpl: async () => { throw new Error('timeout'); }, pause: noPause })).state, 'outage');
  // A transient failure that recovers on the retry is reported as healthy, not as an outage.
  let calls = 0;
  const flaky = async ({ port }) => { if (calls++ < 2) throw new Error('blip'); return port === 993 ? '* OK' : '220 hi'; };
  assert.equal((await probeMail(mail, { greetingImpl: flaky, pause: noPause })).state, 'operational');
});