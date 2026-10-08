#!/bin/bash
# The whole demo from a clean machine state. LENDING_DAML: the lending repo's daml/ (built).
set -eu
cd "$(dirname "$0")"
step() { echo; echo "######## $1 ($(date +%H:%M:%S))"; }
step "LocalNet up";               ./00-localnet.sh up
step "DecMan nodes";              ./nodes.sh > nodes.log 2>&1 && tail -3 nodes.log
step "Decentralized Party";       ./01-decparty.sh
step "DARs";                      ./02-dars.sh
step "GovernanceRules";           ./03-rules.sh
step "Lending demo (script)";     ./04-demo.sh "${RUN_PREFIX:-run1-}"
step "Vote through DecMan API";   ./05-decman-vote.sh "${RUN_PREFIX:-run1-}" 0.4
step "Hosting nodes offline";     ./06-node-offline.sh "${RUN_PREFIX:-run1-}"
step "Guardian and traffic";      ./07-traffic-guardian.sh "${RUN_PREFIX:-run1-}probe-"
step "done"
