# FastSites independent status page

This public site is hosted by GitHub Pages at **https://euayyelo-tech.github.io/fastsites-status/**, outside the FastSites VPS. Publishing was activated and verified on 7 October 2026, including successful workflow deployments and a fresh report consumed by staging. The custom `status.fastsites.app` domain still requires the DNS handoff below.

GitHub Actions checks public reachability and deploys `site/status.json` about every five minutes. GitHub's own timer is best effort and was running only every 4 to 6 hours, so each run waits four minutes and then starts the next one itself (`workflow_dispatch` with the built-in token); the cron line remains as a fallback if the chain is ever broken, and starting the workflow by hand restarts it. This is still not a real-time uptime SLA. The browser rejects reports older than 15 minutes or more than one minute into the future. Content validation and one retry supplement HTTP checks; challenges and rate limiting remain unverified rather than falsely offline.

Checks and what each one covers:

- **FastSites website** - the public site answers 200 with expected content. Before launch the soft-launch holding page counts as reachable, because that is what the public gets.
- **FastSites API** - `/health` answers `ok: true`.
- **Dashboard & editor** - the sign-in API refuses an unauthenticated request in its own words (HTTP 401). Editing and publishing are NOT exercised.
- **FastBot assistance** - the chat knowledge service returns its list of nodes. The quality of an answer is NOT tested.
- **Business email** - the mail server greets on IMAP (993) and SMTP (587). No login, no message sent, delivery NOT tested.
- **GetInbox web access** - the webmail front door content. While the app host is behind its coming-soon gate, a gated response is reported as **unverified**, never as an outage: it is a pre-launch curtain, not a failure.
- **Client websites** - unverified until the owner-controlled canary secrets are set (below).
- **Domains & billing** - unverified. There is no safe public check that exercises checkout or domain lookup, and none is claimed.

A green site-wide claim stays suppressed while any component is unverified. Cloudflare global status never substitutes for customer-site health.

Incident and maintenance notices are edited in `site/updates.json`, committed and deployed by manually running the workflow. Do not put private account details or secrets in that file. The monitor does not test real transactions or mailbox delivery.

Once the GitHub Pages deployment is live, configure `status.fastsites.app` as a dedicated DNS record and GitHub Pages custom domain. The current wildcard routes that host to the FastSites VPS; do not claim independence until the dedicated record, certificate, page, and a simulated FastSites-origin outage have been verified.

## Customer delivery canaries

Use only an approved owner-controlled test website, not an arbitrary customer. Set Actions secrets `CLIENT_SITE_CHECK_URL` (HTTPS, no credentials/query/hash) and `CLIENT_SITE_CONTENT_MARKER` (an expected published content marker). A successful check covers a sample customer-subdomain publishing path, not every tenant. Optional `CLIENT_CUSTOM_DOMAIN_CHECK_URL` and `CLIENT_CUSTOM_DOMAIN_CONTENT_MARKER` add a real custom-domain delivery path. URLs and markers are not written to the public JSON report or logs. Until these are configured, `client-websites` is unknown.

## Domain handoff

Once the independent Pages URL is confirmed live, create a dedicated Cloudflare **CNAME** record with name `status`, target `euayyelo-tech.github.io`, and **DNS only** (not proxied). Leave all other records and the customer wildcard unchanged. Then set the GitHub Pages custom domain to `status.fastsites.app`, wait for DNS verification/certificate issuance, and enable HTTPS. Do not set the custom domain before DNS is ready: GitHub can redirect the default feed to that domain and break consumers while DNS still points at the VPS.

Verify the custom host over HTTPS, the JSON timestamp, scheduled workflow runs, and independent behavior with an isolated browser test that makes FastSites origin requests fail. No production outage should be induced.

## Checks

`node --test scripts/status.test.mjs` exercises probes and the public state model without network requests. `FASTBOT_PLAYWRIGHT` should point to the existing installed Playwright `index.mjs` for `node scripts/verify-browser.mjs`. `node scripts/verify-live.mjs` checks deployed Pages assets and report freshness. `node scripts/verify-integration.mjs` checks staging consumption and independent rendering with isolated FastSites-origin request failures; it also verifies the recorded frontend branch heads without changing them. Expected unconfigured components and release heads in these scripts must be reviewed when approved monitoring or a new frontend release is connected.
