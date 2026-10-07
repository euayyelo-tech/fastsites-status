# FastSites independent status page

This public site is intended for GitHub Pages, outside the FastSites VPS. GitHub Actions checks public reachability on a five-minute best-effort schedule and deploys `site/status.json`. Scheduling can be delayed by GitHub; this is not a real-time uptime SLA. The browser rejects reports older than 15 minutes or more than one minute into the future. Content validation and one retry supplement HTTP checks; challenges and rate limiting remain unverified rather than falsely offline.

Only three public surfaces have configured checks: the FastSites website, public API health endpoint, and GetInbox webmail front door. Client websites, dashboard/editor, domains/billing, actual business-email delivery, and FastBot intentionally remain unverified until safe synthetic checks exist. A green site-wide claim is suppressed. Cloudflare global status never substitutes for customer-site health.

Incident and maintenance notices are edited in `site/updates.json`, committed and deployed by manually running the workflow. Do not put private account details or secrets in that file. The monitor does not test real transactions or mailbox delivery.

Once the GitHub Pages deployment is live, configure `status.fastsites.app` as a dedicated DNS record and GitHub Pages custom domain. The current wildcard routes that host to the FastSites VPS; do not claim independence until the dedicated record, certificate, page, and a simulated FastSites-origin outage have been verified.

## Customer delivery canaries

Use only an approved owner-controlled test website, not an arbitrary customer. Set Actions secrets `CLIENT_SITE_CHECK_URL` (HTTPS, no credentials/query/hash) and `CLIENT_SITE_CONTENT_MARKER` (an expected published content marker). A successful check covers a sample customer-subdomain publishing path, not every tenant. Optional `CLIENT_CUSTOM_DOMAIN_CHECK_URL` and `CLIENT_CUSTOM_DOMAIN_CONTENT_MARKER` add a real custom-domain delivery path. URLs and markers are not written to the public JSON report or logs. Until these are configured, `client-websites` is unknown.

## Domain handoff

Once the independent Pages URL is confirmed live, create a dedicated Cloudflare **CNAME** record with name `status`, target `euayyelo-tech.github.io`, and **DNS only** (not proxied). Leave all other records and the customer wildcard unchanged. Then set the GitHub Pages custom domain to `status.fastsites.app`, wait for DNS verification/certificate issuance, and enable HTTPS. Do not set the custom domain before DNS is ready: GitHub can redirect the default feed to that domain and break consumers while DNS still points at the VPS.

Verify the custom host over HTTPS, the JSON timestamp, scheduled workflow runs, and independent behavior with an isolated browser test that makes FastSites origin requests fail. No production outage should be induced.

## Checks

`node --test scripts/status.test.mjs` exercises probes and the public state model without network requests. `FASTBOT_PLAYWRIGHT` should point to the existing installed Playwright `index.mjs` for `node scripts/verify-browser.mjs`. `node scripts/verify-live.mjs` checks deployed Pages assets and report freshness. Its expected unconfigured components must be updated when approved synthetic monitoring is connected.
