# TestNet launch: runbook

What people do and what the code does. The code prepares the `testnet` profile (backend host behind HTTPS, DARs without mocks,
`deployProd`, separate role accounts, backups, monitor). Network access, keys and money for traffic
cannot be obtained by code: they are done by the steps below. Audit: `docs/reports/audit-2026-09-30-testnet/infra.md`
(I-6, I-7, I-8, I-9, I-10, I-11, I-16, I-17, I-21).

Order: 1 → 2 take weeks, start right away. 3-8 the day before launch.

## 1. Network access (I-7)

TestNet admits only approved validators.

1. A decision recorded in an ADR: **own validator** or **NaaS node**. With NaaS the keys of the protocol parties
   are held by the node operator (I-6), so the pool operator role needs its own validator.
2. Application to the Tokenomics Committee: <https://sync.global/validator-request/>. TestNet approval
   comes together with the right to MainNet.
3. SV sponsor. They receive the validator **egress IP**: one static IP per network, not the one
   used for DevNet or MainNet. SVs add the IP to the allowlist within 2-7 days. Check from the validator host:
   `global-synchronizer/deployment/onboarding-process.mdx` (polls Scan of all SVs).
4. **Onboarding secret** from the sponsor: single-use, valid for 48 hours. Ask for it when the host is ready.

## 2. Validator (I-7, I-17, I-21)

Sizes (`prerequisites.mdx`) and what runs where:

| Host                                     | CPU | RAM                                | Disk          | What runs                               |
| ---------------------------------------- | --- | ---------------------------------- | ------------- | --------------------------------------- |
| Validator (participant + validator app)  | 2   | 8 GB (16 GB under noticeable load) | —             | Splice validator, Docker Compose or k8s |
| Validator Postgres                       | 2   | 4 GB                               | 10-100 GB SSD | managed, same zone                      |
| Backend and frontend (`PROFILE=testnet`) | 2   | 4 GB                               | 20 GB         | nginx, two Node slots, indexer SQLite   |

The hackathon server (2 GB + swap) is not suitable for TestNet: an own validator would not have enough memory there.

Node requirements:

- Ledger API (JSON and gRPC): TLS and JWT only. Admin API: only from the admin network, not from the backend
  host. Participant ports are not published externally.
- Validator egress traffic to SVs goes through the allowlisted IP (NAT/static IP).
- The node identity lives in Postgres: back up Postgres per `production-operations/` (validator backups),
  test restore once per release. Losing the database means losing the parties.
- Network upgrades: Type 1 weekly on Mondays, Type 2 every few months
  (per CIP), Type 3 a hard migration with downtime every 3-4 months. Keep the validator version current,
  subscribe to SV announcements. TestNet is reset every 3-6 months: after a reset steps 5-7 are repeated.

## 3. Traffic and Canton Coin

Every transaction spends validator traffic; traffic is bought with CC.

- CC on TestNet comes from the faucet (test coins).
- Enable **auto-top-up** in the validator config: traffic is topped up from the validator wallet CC
  when the budget drops below the threshold. Keep at least a week's reserve of CC in the wallet.
- Alert on the wallet CC balance and remaining traffic in the validator monitoring (Splice dashboards).
  The backend does not see traffic itself: on an insufficient-traffic error the bot fails and `/healthz/ready` turns red.
- On insufficient traffic do not retry commands; top up the traffic.

## 4. Parties and keys (I-6)

| Role                     | Who holds the key                                     | Ledger account                                     |
| ------------------------ | ----------------------------------------------------- | -------------------------------------------------- |
| operator                 | team validator                                        | `lending-operator`: CanActAs operator              |
| oracle                   | team validator                                        | `lending-oracle`: CanActAs oracle                  |
| liquidator, backstop     | team validator                                        | own users, CanActAs their own party                |
| reader                   | —                                                     | CanReadAs operator (reads for the API and indexer) |
| guardian, treasury       | different people, external parties (external signing) | none: they sign with their own wallet              |
| council members (k of n) | different people, external parties                    | none                                               |

- Each backend role has its own OIDC client (client credentials) at the validator identity provider,
  not a personal password grant. Template: [testnet.credentials.env.example](testnet.credentials.env.example).
  The backend does not start if two roles share a user.
- Client secrets are files `/etc/lending/credentials/<role>.secret` (root:lending, 0640) on the backend
  host, not in GitHub. Rotation: new secret at the provider → file → slot restart.
- Revocation if the backend host is compromised: disable the clients at the provider, remove the ledger user
  rights, the guardian pauses with its key.
- Who holds which key and how it is revoked: record in an ADR.

## 5. Releasing a package: DAR, upgrade-check, vetting (I-8, I-9)

On a persistent ledger a package cannot be deleted, only unvetted. Therefore:

1. The package version is bumped (`daml.yaml`), CI is green: the step `sh scripts/daml.sh upgrade-check`
   checks SCU compatibility with the deployed version from `daml/released/`.
2. On the operator machine: `cp deploy/testnet.env.example deploy/testnet.env`, fill in the addresses and paths
   to the tokens (0600 files; the admin token is issued for the duration of the operation).
3. `bash scripts/deploy-testnet.sh check`: build, upgrade-check, package-id, DAR check on the
   participant (`/v2/dars/validate`). Record the package-id in the release notes.
4. `bash scripts/deploy-testnet.sh upload`: **only** `lending-core-v2`, `lending-governance-v2` and `lending-decman` are uploaded.
   `lending-mocks`, `lending-tests` and `splice-test-token` never go to TestNet.
   The Splice interfaces (`splice-api-*`) already exist on the network: their package-ids must match the network ones,
   check `GET /v2/packages` before uploading. By default packages are uploaded with vetting.
   For a staged switch-over: `VET=false`, then vetting on the switch-over date in the participant console:
   `participant.dars.vetting.enable("<main package-id>")`.
5. After the release: the new version's DAR goes into `daml/released/` (the base for the next upgrade-check).
6. Counterparties (registries, wallets) that execute our templates receive the DAR and upload it on their side
   before the switch-over date.

## 6. Protocol deployment (once per ledger)

1. `cp deploy/testnet.deploy-input.example.json deploy/testnet.deploy-input.json`, fill in:
   role parties, `InstrumentId` (admin + id) of USDCx, CC, CBTC, factories from the registry API of each
   registry, the DSO party, the council. The script refuses while the file has `__FILL` or demo parties.
2. Token `DEPLOYER_TOKEN_FILE`: CanActAs operator and oracle (and the council members when `councilHostedHere`).
3. `bash scripts/deploy-testnet.sh deploy`: `Lending.Deploy.Prod:deployProd`, no minting and no mocks.
   The script refuses if the operator's `ProtocolConfig` already exists. Output: `deploy/testnet.deployment.json`.
4. The council signs `Rotation_Join` with its keys, then `executeCouncilFormation`.
5. Featured App right from the DSO: the operator sets `Config_SetFeaturedAppRight` once the DSO has granted it.
6. Revoke the deployment token.
7. Fund the protocol before users arrive (`deployProd` mints nothing):
   - starting reserves: the treasury adds 15,000 USDCx on `/admin` ("Add reserves", `Pool_AddReserves`).
     Until then `/healthz/ready` reports `net reserves … below RESERVES_ALERT_USD 15000`;
     Absorbed collateral is sold only while reserves are below `targetReserves` (50,000);
   - buyers: the liquidator and the backstop hold USDCx for the absorbed stock. At the launch caps the
     stock can cost up to about 68,000 USDCx; the backstop keeps at least `BACKSTOP_MIN_BALANCE`
     (25,000), otherwise `/healthz/ready` reports it;
   - CBTC: `deployProd` creates the reserve attestation with coverage 0, so CBTC adds no borrow capacity
     until the attestation bot (`BOTS=…,attestation`, `RESERVE_ATTESTATION_URL`) publishes a fresh one.

## 7. Backend host

```sh
rsync -aR deploy scripts/install-dpm.sh daml/multi-package.yaml admin@HOST:/tmp/lending-deploy/
ssh admin@HOST 'sudo PROFILE=testnet TLS_DOMAIN=lend.example.com CERTBOT_EMAIL=ops@example.com \
  REPO_DIR=/tmp/lending-deploy bash /tmp/lending-deploy/deploy/server/setup.sh'
```

- The domain DNS points to the host before launch: certbot issues the certificate via `/.well-known/acme-challenge/`.
  Renewal: `certbot.timer`; nginx is reloaded by a hook.
- `deployment.json` from step 6 → `/opt/lending/shared/deployment.json` (`lending:lending`, 0640).
- Role accounts → `/etc/lending/ledger-credentials.env` (root, 0600) and `/etc/lending/credentials/*.secret`.
- Offsite backup: in `/etc/lending/backup.env` set `BACKUP_AGE_RECIPIENT=age1…` (the decryption key
  is not on this host) and `BACKUP_RCLONE_REMOTE`, `RCLONE_CONFIG=/etc/lending/rclone.conf`. Without them the backup
  is local only. Restore check: decrypt the archive, `sqlite3 lending.db 'PRAGMA integrity_check'`.
- GitHub runner as `deploy` with label `lending-testnet`, in the "Selected workflows" runner group (README).
- GitHub environment `testnet`: per [testnet.env.example](testnet.env.example), section 2, with required reviewers.

## 8. Launch and verification

1. Deploy from Actions (approval by a `testnet` environment reviewer).
2. `https://<domain>/healthz` returns `ok`, `/healthz/ready` with `MONITOR_TOKEN` returns `ready: true`
   (prices fresh, bots not in `error`, accounts working).
3. Headers: `curl -sI https://<domain>/` shows `Strict-Transport-Security`, CSP, `X-Frame-Options: DENY`.
   For the first week `CSP_MODE=report-only`, check violations in the browser console, then `enforce`.
4. Manual run with Loop: connect → login → supply → borrow → repay → withdraw.
5. An external uptime checker (UptimeRobot, Better Stack) on `/healthz` in addition to Monitor:
   GitHub cron runs late and is disabled after 60 days without commits.

## Alerts

| Signal                              | Where it shows                                          | What to do                                                                                               |
| ----------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/healthz` does not respond         | Monitor, issue `outage`                                 | `cat /opt/lending/run/active-slot`, `sudo journalctl -u lending-backend@<slot> -n 100`; rollback (below) |
| `price of … is …s old`              | `/healthz/ready`                                        | oracle bot: price sources, oracle account, validator traffic                                             |
| `bot … is failing`                  | `/healthz/ready`, `/metrics` `bot_consecutive_failures` | slot journal; on insufficient traffic top up, do not retry                                               |
| `ledger credential …`               | `/healthz/ready`                                        | client secret, expiry, ledger user rights                                                                |
| `indexer is … behind`               | `/healthz/ready`                                        | node load, participant prune                                                                             |
| `CBTC reserve attestation`          | `/healthz/ready`                                        | Proof of Reserve source                                                                                  |
| `… not absorbed in time`            | `/healthz/ready`                                        | absorber bot and operator credential, prices of every collateral asset                                   |
| `… collateral unsold for too long`  | `/healthz/ready`                                        | buyer bots, liquidator and backstop USDCx                                                                |
| `… above COLLATERAL_ALERT_USD`      | `/healthz/ready`, `/metrics` `lending_collateral_usd`   | supplyCap is in units: the council reviews it                                                            |
| `net reserves are …`                | `/healthz/ready`, `/metrics` `lending_net_reserves`     | treasury adds reserves on `/admin`; below zero loans and deposit withdrawals are closed                  |
| disk > 85 %, low memory, old backup | `/healthz/host`                                         | `df -h`, `ls /var/backups/lending`, `systemctl status lending-backup`                                    |
| traffic and CC                      | validator monitoring                                    | faucet → validator wallet, check auto-top-up                                                             |
| compromise                          | —                                                       | guardian pause, revoke clients (step 4), rotate `AUTH_SECRET` (all sessions are reset)                   |

## Rollback

- **Backend and frontend**: Actions → Deploy → Run workflow, `rollback_sha` is one of the last five
  releases on the server. Slot switch without a build, within a minute.
- **DAR**: a package cannot be deleted from the ledger. If the new version did not change types and there are no contracts of this version,
  unvet it: `participant.dars.vetting.disable("<package-id v2>")`. Then v1 executes while
  it is vetted. If v2 contracts already exist, you need the next upgrade (v3) that fixes the bug.
- **Indexer data**: stop the slots, unpack the archive from `/var/backups/lending`, put
  `lending.db` back into `/opt/lending/shared/data` (owner `lending`), start the slot. The indexer re-reads history after the backup
  from the ledger, back to the participant prune horizon.
