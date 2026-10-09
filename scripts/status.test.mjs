import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, probe, probeMail } from './monitor.mjs';
import { components, emptyFeed, overall, validateFeed } from '../site/status-model.mjs';

const now = Date.now();
const feed = () => ({ checkedAt: new Date(now).toISOString(), services: components.map(s => ({ ...s, state: 'operational' })), incidents: [], maintenance: [] });
const noPause = async () => {};
const check = { id: 'website', name: 'FastSites website', url: 'https://test.example', marker: 'EXPECTED', detail: 'Synthetic content check' };
const sequence = (...responses) => { let index = 0; return async () => { const value = responses[Math.min(index++, responses.length - 1)]; if (value instanceof Error) throw value; return new Response(value.body ?? '', { status: value.status ?? 200 }); }; };
const healthyFetch = async url => {
  const u = String(url);
  if (u.endsWith('/health')) return new Response('{"ok":true}');
  if (u.endsWith('/projects')) return new Response('{"error":"Missing or invalid Authorization header"}', { status: 401 });
  if (u.includes('/kb/quick-questions')) return new Response('{"nodes":[]}');
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
test('client websites and billing stay unknown until a real check exists', async () => {
  const report = await buildReport(options);
  assert.equal(report.services.length, 8);
  for (const id of ['client-websites', 'billing']) assert.equal(report.services.find(s => s.id === id).state, 'unknown');
  for (const id of ['website', 'api', 'webmail', 'dashboard', 'email', 'fastbot']) assert.equal(report.services.find(s => s.id === id).state, 'operational');
  assert.equal(overall(validateFeed(report, now)).state, 'unknown');
});
test('customer delivery checks keep URLs and content markers private', async () => {
  const env = { CLIENT_SITE_CHECK_URL: 'https://private-canary.example', CLIENT_SITE_CONTENT_MARKER: 'EXPECTED' };
  const report = await buildReport({ ...options, env });
  const client = report.services.find(s => s.id === 'client-websites');
  assert.equal(client.state, 'operational');
  assert.match(client.detail, /custom-domain delivery is not monitored/);
  assert.match(client.detail, /not a check of every customer/);
  assert.ok(!JSON.stringify(report).includes(env.CLIENT_SITE_CHECK_URL));
  assert.ok(!JSON.stringify(report).includes(env.CLIENT_SITE_CONTENT_MARKER));
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
  assert.equal(report.incidents.length, 5);
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