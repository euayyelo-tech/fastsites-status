import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, probe } from './monitor.mjs';
import { components, emptyFeed, overall, validateFeed } from '../site/status-model.mjs';

const now = Date.now();
const feed = () => ({ checkedAt: new Date(now).toISOString(), services: components.map(s => ({ ...s, state: 'operational' })), incidents: [], maintenance: [] });
const noPause = async () => {};
const check = { id: 'website', name: 'FastSites website', url: 'https://test.example', marker: 'EXPECTED', detail: 'Synthetic content check' };
const sequence = (...responses) => { let index = 0; return async () => { const value = responses[Math.min(index++, responses.length - 1)]; if (value instanceof Error) throw value; return new Response(value.body ?? '', { status: value.status ?? 200 }); }; };
const healthyFetch = async url => new Response(String(url).endsWith('/health') ? '{"ok":true}' : 'FastSites GetInbox EXPECTED');
const options = { env: {}, fetchImpl: healthyFetch, pause: noPause, now };
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
test('unconfigured client and authenticated services remain unknown', async () => {
  const report = await buildReport(options);
  assert.equal(report.services.length, 8);
  for (const id of ['client-websites', 'dashboard', 'billing', 'email', 'fastbot']) assert.equal(report.services.find(s => s.id === id).state, 'unknown');
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
  assert.equal(report.incidents.length, 3);
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
