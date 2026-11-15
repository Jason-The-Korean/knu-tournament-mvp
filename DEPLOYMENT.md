# FESTA free deployment

Base: deploy/festa-https (47d6261), originally festa-submission (335314b).
Deployment branch: deploy/festa-free. Frontend and API share one Node.js service.

## Render setup

1. Create a separate Blueprint from the existing GitHub repository. Select deploy/festa-free as the Blueprint source branch and render.yaml as its path. Do not change the existing paid Blueprint.
2. The service in render.yaml explicitly uses branch deploy/festa-free and plan free, with no disk. Confirm both the Blueprint source branch and the web service deployment branch show deploy/festa-free. The YAML service branch does not set the dashboard Blueprint source branch.
3. Do not register a payment method or approve a paid resource. Keep repository visibility unchanged.
4. DB_PATH=/tmp/knu-arena-festa-free/tournament.sqlite is writable ephemeral storage. A missing DB initializes empty. Never upload production databases, backups, browser sessions or private demo records.
5. Render supplies RENDER_EXTERNAL_HOSTNAME for host validation. For custom domains set ALLOWED_HOSTS to exact comma-separated hostnames without schemes or wildcards.

Production cookies use Secure, HttpOnly and SameSite=Strict behind HTTPS termination. The server binds 0.0.0.0, reads PORT, and exposes /healthz.

## Data lifetime and verification

Accounts and tournament records may reset after spin-down/restart or redeployment. Ephemeral files surviving a process restart do not imply durable storage. Register synthetic test accounts again after a reset.

Local tests cover home, host validation, signup/login, HTTPS Origin handling, cookie flags and DB reopening. After actual deployment, separately open the HTTPS URL from an external device, check home/assets, register and log in with a synthetic account, inspect cookies, and record the live commit. Local tests do not verify a live Render service. Dashboard branch settings require account access and must be checked during Blueprint creation.
