#!/usr/bin/env python3
"""Protocol on the shared HackCanton DevNet node (NODERS hackcanton-01).

Steps (token from scripts/devnet-login.sh in .local/devnet/tokens.json):
  python3 scripts/devnet.py status    user, parties, uploaded DARs
  python3 scripts/devnet.py parties   create missing parties (if the node allows)
  python3 scripts/devnet.py upload    upload missing DARs (if the node allows)
  python3 scripts/devnet.py deploy    deploy the protocol: Deploy.daml:deployDevnet over gRPC
  python3 scripts/devnet.py env       backend/.env.devnet for running the backend against DevNet
  python3 scripts/devnet.py retire    archive the deployment before the Compound V3 model, burn the ETH/SOL test tokens

Parties are named lending-<Role>. The ledger user may not upload DARs: `node scripts/devnet-upload.mjs <dar>…`
uploads them through the node console (account in .local/devnet/node.env). Tokens are not printed.

DevNet only: the script uploads mocks (lending-mocks, test token) and creates demo parties
Alice/Bob/Tester. For TestNet: scripts/deploy-testnet.sh and deploy/TESTNET.md (audit I-8, I-19).
The node is set by the environment: DEVNET_NODE, DEVNET_TOKEN_URL, DEVNET_CLIENT_ID (default NODERS hackcanton-01).
"""
import base64
import json
import os
import secrets
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKENS = ROOT / ".local/devnet/tokens.json"
NODE = os.environ.get("DEVNET_NODE", "hackcanton-01.devnet.naas.noders.services")
if ".devnet." not in NODE and not os.environ.get("DEVNET_ALLOW_ANY_NODE"):
    sys.exit("devnet.py is DevNet-only (it uploads mocks); use scripts/deploy-testnet.sh for TestNet")
JSON_API = os.environ.get("DEVNET_JSON_API", f"https://ledger-api-json.participant.{NODE}")
GRPC_HOST = os.environ.get("DEVNET_GRPC_HOST", f"ledger-api-grpc.participant.{NODE}")
TOKEN_URL = os.environ.get(
    "DEVNET_TOKEN_URL",
    "https://keycloak.naas.noders.services/realms/noders-appsfactory/protocol/openid-connect/token",
)
CLIENT_ID = os.environ.get("DEVNET_CLIENT_ID", "web-app-ui-hackcanton-01-devnet")
PREFIX = os.environ.get("DEVNET_PARTY_PREFIX", "lending-")

# Deploy.daml roles (setupWith + deployWith)
ROLES = [
    "Operator", "Oracle", "Guardian", "Treasury", "Backstop", "Liquidator",
    "Alice", "Bob", "Carol", "UsdcxRegistry", "CcRegistry", "CbtcRegistry",
    "DemoDSO", "CouncilMember1", "CouncilMember2", "CouncilMember3",
] + [f"Tester{i}" for i in range(1, 4)]
# Node limit is 20 parties per account; one is already taken by the primary party from onboarding
# in Wallet: 16 roles + 3 testers = 19. Deploy.daml:deployDevnet takes the testers from the list.

# DARs that must be on the node: protocol templates, test tokens, the right mock.
# Protocol package versions come from their daml.yaml, not hardcoded.
def _dar(pkg):
    text = (ROOT / "daml" / pkg / "daml.yaml").read_text()
    version = next(l.split(":", 1)[1].strip() for l in text.splitlines() if l.startswith("version:"))
    return f"{pkg}/.daml/dist/{pkg}-{version}.dar"


DARS = [
    "vendor/splice-api-token-metadata-v1-1.0.0.dar",
    "vendor/splice-api-token-holding-v1-1.0.0.dar",
    "vendor/splice-api-token-transfer-instruction-v1-1.0.0.dar",
    "vendor/splice-api-featured-app-v1-1.0.0.dar",
    "vendor/splice-test-token-v1-1.0.1.dar",
    # BitSafe Decentralization Manager interface: lending-decman implements it
    "vendor/governance-action-v1-0.1.0.dar",
    _dar("lending-core-v2"),
    _dar("lending-governance-v2"),
    _dar("lending-decman"),
    _dar("lending-mocks"),
]


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def access_token():
    if not TOKENS.exists():
        die("no token: run `sh scripts/devnet-login.sh` first")
    stored = json.loads(TOKENS.read_text())
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": CLIENT_ID,
        "refresh_token": stored["refresh_token"],
    }).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, body), timeout=20) as r:
            t = json.load(r)
    except urllib.error.HTTPError as e:
        die(f"token refresh failed: HTTP {e.code}; run scripts/devnet-login.sh again")
    if t.get("refresh_token") and t["refresh_token"] != stored["refresh_token"]:
        stored["refresh_token"] = t["refresh_token"]
        TOKENS.write_text(json.dumps(stored))
        os.chmod(TOKENS, 0o600)
    return t["access_token"]


def subject(token):
    part = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))["sub"]


def api(token, method, path, body=None):
    req = urllib.request.Request(
        JSON_API + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read()
            return r.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(text)
        except ValueError:
            return e.code, {"cause": text[:300]}


def act_as_parties(token, user):
    status, r = api(token, "GET", f"/v2/users/{urllib.parse.quote(user)}/rights")
    if status != 200:
        die(f"cannot read rights of {user}: HTTP {status} {r}")
    out = []
    for right in r.get("rights", []):
        kind = right.get("kind", {})
        if "CanActAs" in kind:
            out.append(kind["CanActAs"]["value"]["party"])
    return out


def role_map(parties):
    """lending-Operator::1220… → {'Operator': party}."""
    found = {}
    for p in parties:
        hint = p.split("::")[0]
        for role in ROLES:
            if hint == PREFIX + role or hint.endswith("-" + PREFIX + role):
                found[role] = p
    return found


def package_ids():
    ids = {}
    for dar in DARS:
        path = ROOT / "daml" / dar
        if not path.exists():
            die(f"{dar} is not built: run `pnpm daml:build`")
        out = subprocess.run(
            ["dpm", "damlc", "inspect-dar", "--json", str(path)],
            capture_output=True, text=True, check=True,
        ).stdout
        ids[dar] = json.loads(out)["main_package_id"]
    return ids


def cmd_status():
    token = access_token()
    user = subject(token)
    print(f"ledger user: {user}")
    status, v = api(token, "GET", "/v2/version")
    print(f"node: {JSON_API} (API {v.get('version') if status == 200 else status})")
    roles = role_map(act_as_parties(token, user))
    missing = [r for r in ROLES if r not in roles]
    print(f"parties: {len(roles)}/{len(ROLES)}" + (f", missing: {', '.join(PREFIX + r for r in missing)}" if missing else ""))
    status, pk = api(token, "GET", "/v2/packages")
    have = set(pk.get("packageIds", [])) if status == 200 else set()
    for dar, pid in package_ids().items():
        mark = "ok" if pid in have else "MISSING" if status == 200 else f"unknown (HTTP {status})"
        print(f"  {mark:8} {Path(dar).name}")
    return roles, missing


def cmd_parties():
    token = access_token()
    user = subject(token)
    roles = role_map(act_as_parties(token, user))
    for role in [r for r in ROLES if r not in roles]:
        status, r = api(token, "POST", "/v2/parties", {"partyIdHint": PREFIX + role, "identityProviderId": ""})
        if status != 200:
            die(
                f"the node does not let this user allocate parties (HTTP {status}). "
                f"Create them in the node console: {', '.join(PREFIX + x for x in ROLES if x not in roles)}"
            )
        party = r["partyDetails"]["party"]
        status, g = api(token, "POST", f"/v2/users/{urllib.parse.quote(user)}/rights", {
            "userId": user,
            "identityProviderId": "",
            "rights": [{"kind": {"CanActAs": {"value": {"party": party}}}}],
        })
        if status != 200:
            die(f"allocated {party} but could not grant CanActAs: HTTP {status} {g}")
        print(f"created {PREFIX + role}")


def cmd_upload():
    token = access_token()
    status, pk = api(token, "GET", "/v2/packages")
    have = set(pk.get("packageIds", [])) if status == 200 else set()
    for dar, pid in package_ids().items():
        if pid in have:
            continue
        data = (ROOT / "daml" / dar).read_bytes()
        req = urllib.request.Request(
            JSON_API + "/v2/packages", data=data, method="POST",
            headers={"authorization": f"Bearer {token}", "content-type": "application/octet-stream"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120):
                print(f"uploaded {Path(dar).name}")
        except urllib.error.HTTPError as e:
            die(
                f"upload of {Path(dar).name} refused (HTTP {e.code}). "
                "Upload the DARs listed by `status` with `node scripts/devnet-upload.mjs <dar>…` (node console)."
            )


def cmd_deploy():
    roles, missing = cmd_status()
    if missing:
        die("create the missing parties first (`parties` or the node console)")
    token = access_token()
    with tempfile.TemporaryDirectory() as tmp:
        tok = Path(tmp) / "token"
        tok.write_text(token)
        os.chmod(tok, 0o600)
        inp = Path(tmp) / "parties.json"
        inp.write_text(json.dumps([[role, roles[role]] for role in ROLES]))
        tests = sorted((ROOT / "daml/lending-tests/.daml/dist").glob("lending-tests-*.dar"), key=os.path.getmtime)[-1]
        out = ROOT / "backend/deployment.devnet.json"
        r = subprocess.run([
            "dpm", "script",
            "--ledger-host", GRPC_HOST, "--ledger-port", "443", "--tls",
            "--access-token-file", str(tok),
            "--dar", str(tests),
            "--script-name", "Test.Lending.Deploy:deployDevnet",
            "--input-file", str(inp),
            "--output-file", str(out),
        ], cwd=ROOT / "daml", capture_output=True, text=True)
        if r.returncode != 0:
            lines = [l for l in (r.stdout + r.stderr).splitlines() if "FAILURE" in l or "Exception" in l or "error" in l.lower()]
            die("deploy failed:\n" + "\n".join(lines[:8]))
    print(f"deployment written to {out.relative_to(ROOT)}")


# Contracts of the deployment before the Compound V3 model (packages lending-core and
# lending-governance): `retire` archives them so the new packages start clean (risk 11). The test
# token registries, their holdings and the Featured App mock stay: the new deployment reuses them.
OLD_TEMPLATES = [
    f"#lending-core:Lending.{t}" for t in [
        "Pool:Pool", "Config:ProtocolConfig", "Account:Account", "Account:AccountRequest",
        "Account:AccountDirectory", "Account:EvmDirectory", "Evm:EvmWallet", "Loop:LoopWallet",
        "Loop:LoopDirectory", "Oracle:PriceFeed", "Oracle:ReserveAttestation", "Auth:Login",
        "Liquidation:LiquidationRequest", "Liquidation:LiquidationBid", "Liquidation:DeficitRecord",
        "EvmDeposit:DepositRegistry", "EvmDeposit:DepositClaim", "EvmRedeem:RedeemRequest",
    ]
] + [
    f"#lending-governance:Lending.Governance:{t}"
    for t in ["GovernanceCouncil", "ParameterChangeProposal", "CouncilRotation", "MarketListingProposal",
              "IncomeProposal", "MarketDelistingProposal"]
]
TOKEN = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:Token"
OFFER = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:TokenTransferOffer"
# Retired markets: their test tokens are burned (they were never in the new deployment)
BURN_IDS = {"ETH", "SOL"}


def active(token, parties, template, end):
    """Active contracts of a template visible to any of the parties, by contract id: one request."""
    flt = {party: {"cumulative": [{"identifierFilter": {"TemplateFilter": {"value": {
        "templateId": template, "includeCreatedEventBlob": False}}}}]} for party in parties}
    s, r = api(token, "POST", "/v2/state/active-contracts",
               {"activeAtOffset": end, "eventFormat": {"filtersByParty": flt, "verbose": True}})
    if s in (400, 404) and "package" in json.dumps(r).lower():
        return {}  # the package is not on the node
    if s != 200:
        die(f"{template}: HTTP {s} {json.dumps(r)[:300]}")
    found = {}
    for e in r:
        ev = e.get("contractEntry", {}).get("JsActiveContract", {}).get("createdEvent")
        if ev:
            found[ev["contractId"]] = ev
    return found


def archive_all(token, user, events, label):
    """Archive by the Archive choice, acting as every signatory (all on this node).
    Without DEVNET_CONFIRM=1 only counts what would be archived."""
    if os.environ.get("DEVNET_CONFIRM") != "1":
        print(f"{label}: would archive {len(events)} (dry run; DEVNET_CONFIRM=1 archives)")
        return
    done = failed = 0
    for cid, ev in events.items():
        body = {
            "commands": [{"ExerciseCommand": {"templateId": ev["templateId"], "contractId": cid,
                                               "choice": "Archive", "choiceArgument": {}}}],
            "commandId": f"retire-{cid[:40]}", "userId": user, "actAs": ev["signatories"], "readAs": []}
        s, r = api(token, "POST", "/v2/commands/submit-and-wait", body)
        if s == 200:
            done += 1
        else:
            failed += 1
            print(f"  could not archive {label} {cid[:16]}…: HTTP {s} {json.dumps(r)[:160]}")
    print(f"{label}: archived {done}" + (f", failed {failed}" if failed else ""))


def cmd_retire():
    roles, missing = cmd_status()
    if missing:
        die("parties are missing")
    token = access_token()
    user = subject(token)
    parties = list(roles.values())
    s, le = api(token, "GET", "/v2/state/ledger-end")
    if s != 200:
        die(f"ledger end: HTTP {s}")
    end = le["offset"]
    for template in OLD_TEMPLATES:
        events = active(token, parties, template, end)
        if events:
            archive_all(token, user, events, template.split(":", 1)[1])
    for template in (TOKEN, OFFER):
        events = active(token, parties, template, end)
        def instrument(ev):
            a = ev["createArgument"]
            return (a.get("holding") or a.get("transfer") or {}).get("instrumentId", {}).get("id")
        burn = {cid: ev for cid, ev in events.items() if instrument(ev) in BURN_IDS}
        if burn:
            archive_all(token, user, burn, "ETH/SOL " + template.rsplit(":", 1)[1])


def cmd_env():
    token = access_token()
    env = ROOT / "backend/.env.devnet"
    example = (ROOT / "backend/.env.devnet.example").read_text()
    # Keep the secret of an existing file: a new one would sign out every session
    secret = next((l.split("=", 1)[1].strip() for l in env.read_text().splitlines()
                   if l.startswith("AUTH_SECRET=")), "") if env.exists() else ""
    if len(secret) < 32:
        secret = secrets.token_hex(32)
    env.write_text(example.replace("__LEDGER_USER_ID__", subject(token)).replace("__AUTH_SECRET__", secret))
    os.chmod(env, 0o600)
    print(f"wrote {env.relative_to(ROOT)}")


COMMANDS = {
    "status": cmd_status, "parties": cmd_parties, "upload": cmd_upload, "deploy": cmd_deploy,
    "retire": cmd_retire, "env": cmd_env,
}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(2)
    COMMANDS[sys.argv[1]]()
