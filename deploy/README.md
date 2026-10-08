# Deploy

One host profile (`/etc/lending/profile` = `testnet`, set by `setup.sh`): backend and frontend
behind HTTPS, the ledger is an external participant. The hackathon server
(`https://lending.canborsa.com`) runs on Canton DevNet through the shared NODERS node
`hackcanton-01`. The domain is behind the Cloudflare proxy; the `canborsa.com` zone SSL mode is
Flexible and shared with other domains, so `CLOUDFLARE=flexible` serves the app on :80 to Cloudflare
edges only. TestNet preparation: [TESTNET.md](TESTNET.md).

Every push to `main`, including a PR merge, runs CI (`ci.yml`) on GitHub-hosted runners:
typescript, audit and daml (with `upgrade-check`). E2E against DevNet (`e2e`) runs only on manual
trigger: they are run locally before push. After green CI the `Deploy` workflow
(`deploy.yml`) rolls out the release through the self-hosted runner on the host. `ci.yml` has no
self-hosted jobs: for `pull_request` the workflow is taken from the PR branch, and such a job would run the PR author's code.

## How it works

| Part     | Where                                                           | What it does                                                     |
| -------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| Backend  | `lending-backend@blue` (:3001), `lending-backend@green` (:3002) | two slots, traffic goes to the active one; `node dist/server.js` |
| Frontend | `/opt/lending/frontend/current`                                 | static files, a symlink to the release build                     |
| Entry    | nginx :443 + redirect from :80 (TLS)                            | static files, `/api/` → active slot, security headers, limits    |
| Backup   | `lending-backup.timer`                                          | daily: indexer SQLite, `deployment.json`, tokens                 |
| Host     | `lending-hostcheck.timer`                                       | once a minute: disk, memory, backup age → `/healthz/host`        |
| Runner   | `actions.runner.rwa-market-lending.*`                           | user `deploy`                                                    |

Users and permissions (audit I-2, I-14):

| User      | What it can do                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| `deploy`  | runner: writes releases to `/opt/lending/releases`, `sudo` only for the exact `lending-ctl` lines (`sudoers.lending`) |
| `lending` | services: no sudo and no login; reads release code only; writes `shared/data`, `shared/tokens`, `run`                 |
| root      | `/usr/local/sbin/lending-ctl`: slots, nginx switch, installing `backend.env`, basic auth                              |

Backend secrets live in `/etc/lending/backend.env` (root, 0600). `release.sh` builds the file and
passes it to `lending-ctl install-env` via stdin. systemd reads it; the backend process only has
environment variables. Per-role ledger accounts (TestNet) live in `/etc/lending/ledger-credentials.env`;
the operator places them, CI does not see them. The units are isolated: `NoNewPrivileges`, `ProtectSystem=strict`,
`ReadWritePaths`, `PrivateTmp`, `ProtectHome`, empty `CapabilityBoundingSet`,
`RestrictAddressFamilies`, `MemoryMax`, a system call filter.

Zero downtime without Traefik: `release.sh` starts the free slot next to the live one and waits for `/health`
with `ledger: connected`. Then `lending-ctl switch` rewrites the upstream and CSP, checks `nginx -t`
and runs `reload`: old workers finish their connections. If the config fails the check,
the previous files are restored. Then the frontend symlink is swapped atomically and the old slot
stops. If the new slot fails health, the release fails and the old slot keeps running.
Bots run in one process: the lease `/opt/lending/run/bots.lease` passes to the new slot
when the old one releases it.

Server journals are not printed to the Actions log (audit I-18): on failure it shows only the cause and the
`journalctl` command to run on the server.

`release.sh` does not touch the ledger or DARs. Packages are released separately: on DevNet by upload in the node
console (Collections), on TestNet with `scripts/deploy-testnet.sh` (TESTNET.md, "Releasing a package").
A new version must pass `upgrade-check` against `daml/released`.

## GitHub settings

Set by hand in Settings (audit I-1, I-16):

1. **Actions → General → Fork pull request workflows**: "Require approval for all outside collaborators".
2. **Runner**: in an organization runner group with "Selected workflows" access, only
   `rwa-market/lending/.github/workflows/deploy.yml@refs/heads/main`. Register the runner as `deploy`,
   preferably ephemeral (`./config.sh --ephemeral`, re-registration after each job).
3. **Environments `hackathon` and `testnet`**: "Required reviewers" (≥ 1, not the author of the change),
   "Deployment branches": only `main`, "Prevent self-review".
4. **Branch protection `main`**: PR required, ≥ 1 approval, no exceptions for administrators,
   required checks `typescript`, `audit`, `daml`; force-push and deletion forbidden.

Repository variables: `DEPLOY_ENVIRONMENT` (`hackathon` | `testnet`), `DEPLOY_RUNNER_LABEL`
(`lending-hackathon`), `PUBLIC_HOST` and `PUBLIC_URL` (for Monitor), `DPM_INSTALLER_SHA256`,
`VITE_*` for the frontend build (`VITE_NODE_*`: the node wallet of the protocol roles at `/operator`,
`VITE_OPERATOR_PARTY`, `VITE_EXPECTED_NETWORK_ID`). Repository secret `MONITOR_TOKEN` (the same one
as in the environment).

Environment `hackathon` (DevNet). Variables: `LEDGER_NETWORK=devnet`, `LEDGER_API_URL`,
`LEDGER_USER_ID`, `PUBLIC_HOST`, `PUBLIC_URL`, `NETWORK_ID=canton:devnet`, `BOTS`, `ORACLE_MODE=live`,
`CSP_*` (node, Keycloak, Loop API and WebSocket: `https://devnet.cantonloop.com wss://devnet.cantonloop.com`), `BACKEND_ENV`, for example `TEST_FAUCET=true`,
`ATTESTATION_MODE=demo` (the test CBTC has no PoR source), `ORACLE_HEARTBEAT_MS=60000`.
Ledger account: `/etc/lending/ledger-credentials.env` on the server (refresh token of the node account).
Secrets: `AUTH_SECRET`, `MONITOR_TOKEN`, `BACKEND_ENV_SECRETS`, optionally `BASIC_AUTH_PASSWORD`.

Environment `testnet` is described in [testnet.env.example](testnet.env.example), section 2.

## Demo: buying the collateral by hand

The liquidator bot buys absorbed collateral on its next cycle, about 10 seconds after an absorb, so a
person on `/liquidations` finds nothing to buy. The demo video shows the bot's purchase. To record a
purchase by hand instead:

1. Set the `hackathon` variable `BOTS` without `liquidator`:
   `oracle,accounts,absorber,backstop,merge,logins,indexer`.
2. Actions → Deploy → Run workflow from `main`, `rollback_sha` = the running release (`release` in
   `GET /health`). The same release restarts with the new environment, no build.
3. After an absorb, buy within `BACKSTOP_DELAY_MS` (120 s by default): then the backstop buys the
   rest. To get more time, add `BACKSTOP_DELAY_MS=600000` to `BACKEND_ENV` for the recording.
4. Restore the previous `BOTS` value and run step 2 again.

## Rollback

Actions → Deploy → Run workflow from `main`, `rollback_sha` = the full SHA of one of the last five
releases. The slot switches to the already built `/opt/lending/releases/<sha>`, without CI and without a build.
DARs are not rolled back this way, see TESTNET.md, "Rollback".

## Server

Initial setup is idempotent. It installs packages, Node from the NodeSource apt repository with its key,
pnpm, creates the `deploy` and `lending` users, systemd, nginx with TLS (Let's Encrypt) and the firewall.
On a host with the old sandbox profile it removes its units.

```sh
# HOST: the server's ssh address (a sudo user), kept outside the repository
rsync -aR deploy "$HOST":/tmp/lending-deploy/
ssh "$HOST" 'sudo TLS_DOMAIN=lending.canborsa.com CLOUDFLARE=flexible CERTBOT_EMAIL=none REPO_DIR=/tmp/lending-deploy bash /tmp/lending-deploy/deploy/server/setup.sh'
```

Useful on the server:

```sh
cat /opt/lending/run/active-slot                        # blue or green
sudo journalctl -u lending-backend@blue -f              # slot logs
sudo systemctl start lending-backup                     # off-schedule backup
ls -l /var/backups/lending                              # backups (14 days)
curl -s localhost/healthz/host                          # what Monitor sees about the host
```

The ledger is external: a server reboot does not touch it. The indexer resumes from the saved offset;
if the database belongs to a different ledger, `INDEXER_RESET_ON_LEDGER_CHANGE=true` starts the history over.

## Monitoring

The `Monitor` workflow checks `PUBLIC_URL` (repository variable) from outside every 15 minutes:

- `/healthz`: the process is alive, the ledger is connected;
- `/healthz/ready` (with `MONITOR_TOKEN`): price age, bots, role accounts, indexer, attestation;
- `/healthz/host`: disk, free memory, backup age.

Any problem opens an issue labeled `outage`, and GitHub sends a notification. When everything is
fine again, the issue is closed with a comment. Server responses are not inserted into the script text.
`/metrics` (Prometheus) is not exposed, only from the host: `curl -s localhost:3001/metrics`.
