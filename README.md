# Canton Lending Protocol

Submitted to HackCanton S3 as **Canborsa Lending**: Financial Applications track and the BitSafe
Contribution Pool. Live on Canton DevNet: https://lending.canborsa.com

A USDCx lending market on Canton Network. Holders of CC or CBTC post it as collateral and borrow
USDCx without selling it. USDCx holders supply the pool and earn the interest that borrowers pay.
The first users it is built for are small node operators and app teams whose treasury is in CC and
whose costs are in dollars.

The mechanics follow Compound V3. Each account has one USDCx balance (positive: a deposit,
negative: a debt) backed by all of its collateral. An undercollateralized account is absorbed by
the protocol, which then sells the collateral at a discount. Every money check (borrow capacity,
liquidation point, caps, price validity) is enforced by Daml contracts; off-chain services prepare
and initiate operations. One exception: Loop accounts are custodial. The backend verifies the Loop
signature and submits as the custody party, because the contract cannot check that signature itself
(see "Loop only for users" below).

All code in this repository was written during the hackathon, from the first commit on 29.09.2026.
The team built it with AI coding agents (Claude Code, OpenAI Codex): they wrote most of the code,
tests and docs to the team's specs, and the team reviewed the changes and ran the checks below.

## Try it on DevNet

1. Open https://lending.canborsa.com. Without a wallet the Markets page shows the rates, the
   liquidity, the collateral parameters and the interest rate model.
2. Press **Connect wallet**. Loop opens in a popup, or shows a QR code for the phone app. On DevNet
   it is https://devnet.cantonloop.com; if you have no wallet, sign up there, for example with
   Google.
3. Take test tokens with the **Get test CC**, **Get test CBTC** and **Get test USDCx** links on the
   dashboard. Each link gives a fixed portion, a few times a day. The tokens come from this app's own
   test registries: the same ticker inside Loop is a different asset.
4. To borrow, press **+** next to CC or CBTC to post collateral, then **Borrow USDCx**. The minimum
   loan is 250 USDCx. Position Summary shows the borrow capacity, the liquidation point and the
   liquidation risk.
5. To earn, press **Supply USDCx**. The deposit earns the supply APR until **Withdraw USDCx**.
6. Close the loan with **Repay USDCx**, then press **−** to take the collateral back.

Every operation is a text you read and sign in Loop. The History page lists what happened to the
account.

## Economics and incentives

Borrowers pay interest on USDCx. Lenders receive 80% of it and 20% stays in the protocol's reserves.

| Rule          | Value                                                               |
| ------------- | ------------------------------------------------------------------- |
| Borrow rate   | 2% a year at zero utilization, 10% at 65%, 35.7% at the 80% ceiling |
| Supply rate   | Borrow rate × utilization × 80%: 5.2% at 65% utilization            |
| Launch limits | 50,000 USDCx of total debt, 5,000 per account, 250 minimum loan     |

| Collateral | Borrow up to     | Liquidated when debt passes | Penalty | Buyer's discount | Collateral cap |
| ---------- | ---------------- | --------------------------- | ------- | ---------------- | -------------- |
| CC         | 30% of its value | 45% of its value            | 7%      | 5.6%             | 400,000 CC     |
| CBTC       | 50% of its value | 65% of its value            | 5%      | 4%               | 0.58 CBTC      |

| Who          | What they get and what they risk                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Borrowers    | Keep their CC or CBTC and see the rate before they borrow; it floats with utilization. A loan at the 30% limit is liquidated if CC falls by a third                               |
| Lenders      | Earn what borrowers pay. There are no token rewards                                                                                                                               |
| Buyers       | Take liquidated collateral below the oracle price while reserves are under the 50,000 USDCx target                                                                                |
| The protocol | Keeps 20% of the interest and a fifth of each penalty in reserves. Bad debt comes out of reserves first. If they go negative, new loans and deposit withdrawals wait for a top-up |

These are the DevNet values. The council changes them by vote.

## Network activity

- Each user action (supply, withdraw, borrow, repay, post or take back collateral) is one Canton
  transaction: one choice on `Pool` that settles the Token Standard transfer and the accounting
  together. A loan from start to finish is at least four transactions.
- A liquidation adds two: the absorb and the purchase of the collateral.
- The oracle publishes a price feed per asset with quotes from at least two sources, at least every
  4 minutes: about 1,000 updates a day for three assets. The contract rejects a quote older than
  5 minutes.
- Measured on LocalNet (Splice 0.6.12), a pool operation costs 5.3 to 6.8 KB of sequencer traffic,
  about $0.09 to $0.11 at the MainNet extra-traffic price. The numbers per operation are in
  [deploy/BITSAFE-LOCALNET.md](deploy/BITSAFE-LOCALNET.md).
- User operations and collateral purchases record a Featured App activity marker when the operator
  holds the right. On DevNet this is a test right from `lending-mocks`.

## Status and limits

- DevNet only, with test tokens from the app's own registries. There has been no external security
  audit.
- Loop accounts are custodial: see "Loop only for users" below.
- Prices come from the operator's oracle, which reads CoinGecko, KuCoin, Binance and Bybit. MainNet
  needs a feed that can be verified on the ledger.
- Absorbs are started by the operator's bot, because on Canton only the operator sees positions.
- On DevNet the council is three ordinary parties. The BitSafe Decentralized Party runs on
  LocalNet: see "BitSafe Decentralization Manager demo" below.

## Layout

| Path                         | What                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `daml/lending-core-v2`       | Protocol contracts: pool, accounts, prices, absorb and sale, pauses, Loop accounts    |
| `daml/lending-governance-v2` | k-of-n council: parameters, roles, asset listing, reserves                            |
| `daml/lending-decman`        | Council run by a BitSafe Decentralized Party (Decentralization Manager actions)       |
| `daml/lending-mocks`         | Test Featured App right for sandbox and DevNet; no daml-script, so it can be uploaded |
| `daml/lending-deploy`        | Deploy script for real assets (TestNet, MainNet); run by dpm script, never uploaded   |
| `daml/lending-tests`         | Daml Script tests and the DevNet deploy script (never uploaded)                       |
| `backend`                    | Fastify + TypeScript: read API, command builder, oracle, absorb and buyer bots        |
| `frontend`                   | Vite + React + Tailwind + shadcn/ui; Loop wallet, Canton node login for service roles |
| `packages/shared`            | Types and the Loop signing message shared by backend and frontend                     |
| `scripts`                    | Toolchain, DevNet deploy and login                                                    |

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[Web app] -- signMessage --> W[Loop wallet]
    UI -- OIDC, service roles --> N[Canton node wallet]
  end
  subgraph Backend
    API[Read API + command builder]
    BOT[Bots: oracle, absorber, buyers]
  end
  subgraph Canton DevNet
    POOL[Pool: USDCx pool, CC/CBTC collateral]
    PS[PauseState: five flags]
    ACC[Account: signed balance, collateral]
    LW[LoopWallet: party, key, nonce, balances]
    PF[PriceFeed x2 sources]
    GOV[Governance council k-of-n]
    TOK[Token Standard v1 holdings]
  end
  UI -- prepare --> API
  API -- Loop: verify Ed25519, submit as custody --> POOL
  N -- sign and submit --> POOL
  POOL -- nonce, expiry, signed text, key fingerprint --> LW
  BOT -- publish --> PF
  POOL -- atomic transfer + accept --> TOK
  GOV -- co-signs, lists assets --> POOL
  POOL -- reads --> PS
```

- **Loop only for users: a custodial model.** Loop does not run third-party DARs, so a Loop user
  gets a sub-account of the protocol's custody party, and the custody party holds the tokens. Every
  operation is a Loop `signMessage` text. The backend verifies the Ed25519 signature (Daml has no
  Ed25519 check) and submits as custody; the contract checks the nonce, the expiry, that the text
  matches the operation and that the key is the party's namespace key. So for Loop accounts the
  custody operator is trusted not to submit operations the user did not sign; the frontend
  protects against a tampered response by signing only text that matches the user's input. Service
  roles (guardian, treasury, council) sign in with their Canton node account on `/operator`. The
  trust model is in the team's ADR-006 (Loop wallet), kept outside this repository.
- The operator party holds pooled tokens. Each user action is one choice on `Pool`; the choice
  body carries the user's (or custody's) and the operator's authority, so a Token Standard
  transfer and its acceptance settle in the same transaction as the accounting update.
- For Canton-party wallets (node accounts) the backend authorizes nothing: it returns the command
  and the disclosed contracts, the user's wallet signs and submits, and the contract decides. For
  Loop accounts it returns the exact text to sign, the frontend signs only if it matches what the
  user entered, and the backend's signature check is the custodial step above.
- New collateral markets are listed by the council (`MarketListing_Execute`, threshold plus
  operator). The config and the pool get the market in one transaction. The council removes a
  market the same way (`Delisting_Execute`) once users have withdrawn all its collateral
  (`Pool_RemoveMarket` checks `totalCollateral = 0`). A delisting writes nothing off, the council
  never sees accounts or wallets, and the instrument keeps its transfer factory.
- **BitSafe Decentralization Manager.** The council can have one member: a BitSafe Decentralized
  Party hosted on the nodes of independent organizations. Its `GovernanceRules`
  (`governance-core-v1`) collect the k-of-n confirmations and execute the `lending-decman` actions
  (`GovernableAction`): parameters, roles, factories, market listing, protocol income, council
  rotation. A change that needs the operator is only proposed by the vote; the operator executes it,
  as with the regular council. The party sees the config and the proposals, not accounts or the pool.
- Prices: the oracle takes CoinGecko, KuCoin, Binance and Bybit, publishes the median of agreeing
  sources and holds large jumps until they are confirmed.

### What differs from Compound V3

| Difference            | Compound V3                                      | Here                                                                                                            | Why                                                          |
| --------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Who absorbs           | Anyone                                           | The operator                                                                                                    | Positions on Canton are private: only the operator sees them |
| Who buys collateral   | Anyone                                           | Approved buyers (liquidators, backstop)                                                                         | The buyer never learns whose position it was                 |
| Withdraw and borrow   | One action: withdrawing past the deposit borrows | Two different signed texts: Withdraw and Borrow                                                                 | A Loop user signs text and must see they take a debt         |
| Pauses                | Five flags; a supply pause also blocks repayment | Five flags in their own contract; supply and repayment never pause                                              | A user can always add funds and repay                        |
| Minimum collateral    | None                                             | A collateral deposit or partial withdrawal moves at least `minCollateralAmount`; withdraw-all is always allowed | Tiny operations contend for the one pool contract            |
| Prices                | One feed per asset                               | Two sources, deviation and freshness checks                                                                     | Stricter than Compound                                       |
| Launch limits         | None                                             | Total borrow cap, per-user cap, 80% utilization ceiling                                                         | Careful launch; lifted by a parameter                        |
| Negative reserves     | The protocol carries on                          | New loans and deposit withdrawals wait for recapitalization                                                     | Losses are not spread onto suppliers automatically           |
| CBTC proof of reserve | None                                             | Without a fresh attestation CBTC adds no borrow capacity                                                        | Borrowing against CBTC needs proof that it is backed         |
| Governance delay      | A 2-day timelock on every change                 | 2 days only for a lower liquidation factor; the rest applies at once                                            | Absorb takes all collateral: borrowers get time to react     |
| Service features      | COMP rewards, transfers, managers, bulk actions  | None                                                                                                            | Not needed for launch; every Loop operation is signed alone  |

### Design records

Code comments cite the team's architecture decision records (ADR-001…009) and `docs/`. These are
internal working notes in Russian and are not published; the decisions they cite are:

| Record  | Decision                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------- |
| ADR-001 | MVP scope: the operator party holds pooled tokens, Token Standard instruments, values for spec gaps |
| ADR-002 | After the 29.09 audit: trusted transfer factories only, every received holding checked              |
| ADR-004 | A wallet without its own Canton party gets a sub-account of one custody party                       |
| ADR-005 | Real CC, USDCx and CBTC behind `ASSET_PROFILE=real`, off by default                                 |
| ADR-006 | Loop wallet: a custodial `LoopWallet` account, operations signed as Loop `signMessage` text         |
| ADR-009 | Compound V3 mechanics: signed balance, absorb and collateral sale; new `-v2` packages               |

`docs/requirements/compound-v3-migration` is the task statement behind ADR-009.

## Requirements

- Node.js 24+, pnpm 10
- JDK 17+ and [dpm](https://docs.digitalasset.com) (Daml SDK 3.5)

```bash
brew install openjdk@17
curl https://get.digitalasset.com/install/install.sh | sh
pnpm doctor   # checks the toolchain
```

## Run it yourself

To check the code without DevNet access:

```bash
pnpm install
pnpm daml:test        # every Daml Script test: limits at the boundary, the 11 control examples, stress test
pnpm test             # backend and frontend unit tests (vitest)
pnpm demo:bitsafe     # council and BitSafe party lower the CBTC factor 50% → 45%, on an in-memory ledger
```

The stress test (`Test.Lending.StressTest:test_stress`) runs 20 accounts through CC −50% and
BTC −30%: 9 absorbed, all collateral sold, net reserves 0 → +315 USDCx. With DevNet credentials,
`pnpm --filter @lending/backend devnet:scenario` runs the absorb end to end on the live stack: Bob
borrows 90% of his capacity against CC, the oracle party publishes a CC price that puts his
liquidation point at 80% of the debt, the absorber takes the account and the buyer bots buy the
stock.

## BitSafe Decentralization Manager demo

The lending council can be a single BitSafe **Decentralized Party**: hosted on several participant
nodes, its namespace owned by several keys, its `GovernanceRules` (governance-core-v1) asking 2 of 3
member confirmations. `lending-decman` implements the DecMan `GovernableAction` interface for
parameter, market, income, rotation and delisting changes.

- **Where it runs.** On LocalNet with a real Decentralized Party created by DecMan's own onboarding:
  `pnpm demo:bitsafe:localnet`, runbook with commands from a clean clone, resource needs and the
  log of a full run in [deploy/BITSAFE-LOCALNET.md](deploy/BITSAFE-LOCALNET.md) (about 13 minutes,
  Docker with 7–8 GB). The vote lowers the CBTC Collateral Factor 0.5 → 0.45, a 50% borrow is then
  rejected and a 45% borrow accepted; a second change is voted through the DecMan HTTP API.
- **Without LocalNet.** `pnpm demo:bitsafe` runs the same flows on an in-memory Daml ledger.
- **On DevNet (lending.canborsa.com)** the council is three ordinary parties (`CouncilMember1–3`)
  signed by our deploy script; `lending-decman` is uploaded there but not used, because a
  Decentralized Party needs several participant nodes we do not have on the shared DevNet node.
- **Council page.** With a DecMan council the web page shows the BitSafe party, its threshold
  (2 of 3), its members and the pending DecMan actions with their confirmations; the members open
  the page read-only. They vote in DecMan on their own nodes, not on the page (runbook, section 7).

## Quick start (DevNet)

```bash
pnpm install
pnpm daml:test                       # build all Daml packages, run Daml Script tests
sh scripts/devnet-login.sh           # node account login (NODERS hackcanton-01)
python3 scripts/devnet.py env        # backend/.env.devnet from the example
cd backend && node --env-file=.env.devnet --import tsx src/server.ts
cd frontend && pnpm dev              # :5173, /api → backend :3001
```

Open http://localhost:5173, press **Connect wallet**, sign in with Loop, and take
test tokens from the faucet. **Canton node** signs in with the node account (protocol roles).

DevNet operations: `python3 scripts/devnet.py status|retire|deploy`,
`node scripts/devnet-upload.mjs <dar>…` (DARs through the node console, account in `.local/devnet/node.env`),
`pnpm --filter @lending/backend devnet:setup -- loop <custody>`. `retire` archives the contracts of
the deployment before the Compound V3 model and burns the old ETH and SOL test tokens; it is a dry
run unless `DEVNET_CONFIRM=1`.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm format:check
pnpm daml:test && sh scripts/daml.sh upgrade-check
pnpm --filter @lending/frontend exec playwright test e2e/loop.spec.ts  # against vite dev, mocked SDK and API
```

On the build of 08.10.2026: 142 Daml Script scenarios, 400 backend tests, 134 frontend tests and
9 browser tests pass.

`e2e/loop.spec.ts` replaces the Loop SDK and the API with mocks, so it needs no secrets.
`e2e/devnet.spec.ts` needs `E2E_NODE_USER` and `E2E_NODE_PASSWORD`. CI runs lint, types, unit and
Daml tests on every pull request (`.github/workflows/ci.yml`); e2e against DevNet runs on demand.

## License

[Apache-2.0](LICENSE)
