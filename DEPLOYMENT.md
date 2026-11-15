# FESTA deployment

Source: festa-submission commit 335314b. Deployment branch: deploy/festa-https.
Frontend and API run together with `npm start`; no build or dependencies required.

## Render setup (account owner)

1. Install/connect the Render integration, sign in, and authorize the existing GitHub repository. Keep the repository private if currently private.
2. Create a Blueprint from this repository, selecting deploy/festa-https and render.yaml.
3. Review and explicitly approve the paid Starter service and 1 GB persistent disk before creation. This file does not authorize payment.
4. Confirm the disk is mounted at /var/data and DB_PATH=/var/data/tournament.sqlite. Do not upload existing databases, backups, browser sessions or demo records. A new empty DB initializes automatically.
5. Render supplies RENDER_EXTERNAL_HOSTNAME. For a custom domain set ALLOWED_HOSTS to the exact hostname (comma-separated for multiple names; no scheme or wildcard).

Production sets Secure, HttpOnly, SameSite=Strict session cookies even behind the HTTPS proxy. Forwarded headers cannot disable Secure. The service binds 0.0.0.0 and reads PORT. The health check is /healthz. Use a single instance with this SQLite disk.

## Required external acceptance check

After Render reports a successful deploy, record the actual HTTPS URL and deployed full commit SHA. Open it from an external device/browser, confirm home and assets, register a synthetic test account with no personal data, log out and log in, and check /api/auth/session and Secure cookies. Restart the service and confirm that the account and its session/data remain available. Verify a cross-origin write is rejected. Do not submit a URL until these checks pass.

Local deployment tests exercise host allowlisting, HTTPS Origin handling, cookie flags, fresh DB initialization, signup/login, and session/user persistence after reopening the DB. These do not establish that a hosted disk is mounted or that external HTTPS works.
