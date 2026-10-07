# FastSites independent status page

This public site is hosted by GitHub Pages, outside the FastSites VPS. GitHub Actions checks public reachability every five minutes and deploys `site/status.json`. The browser treats a report older than 15 minutes as unavailable. Only three public surfaces have real checks; dashboard/editor, domains/billing, and FastBot intentionally remain unverified until safe synthetic checks exist. A green site-wide claim is therefore suppressed.

Incident and maintenance notices are edited in `site/updates.json`, committed and deployed by manually running the workflow. Do not put private account details or secrets in that file. The monitor does not test real transactions or mailbox delivery.

Once the GitHub Pages deployment is live, configure `status.fastsites.app` as a dedicated DNS record and GitHub Pages custom domain. The current wildcard routes that host to the FastSites VPS; do not claim independence until the dedicated record, certificate, page, and a simulated FastSites-origin outage have been verified.
