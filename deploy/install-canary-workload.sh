#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CANARY_ENV_SOURCE=${CANARY_ENV_SOURCE:-/home/rawdata/.config/vectra-canary/canary.env}
if ! id vectra-canary >/dev/null 2>&1; then sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin vectra-canary; fi
sudo install -d -m 0755 /etc/vectra-canary /var/lib/vectra-canary /usr/local/lib/vectra-canary
if [ ! -f /etc/vectra-canary/attestation-private.pem ]; then
  sudo openssl genpkey -algorithm ED25519 -out /etc/vectra-canary/attestation-private.pem
  sudo openssl pkey -in /etc/vectra-canary/attestation-private.pem -pubout -out /etc/vectra-canary/attestation-public.pem
fi
sudo chmod 0600 /etc/vectra-canary/attestation-private.pem
sudo chmod 0644 /etc/vectra-canary/attestation-public.pem
sudo install -m 0755 "$ROOT/deploy/attest-canary-workload.mjs" /usr/local/lib/vectra-canary/attest-canary-workload.mjs
sudo install -m 0755 "$ROOT/deploy/canary-workload.mjs" /usr/local/lib/vectra-canary/canary-workload.mjs
sudo install -o root -g vectra-canary -m 0640 "$CANARY_ENV_SOURCE" /etc/vectra-canary/canary.env
sudo touch /var/lib/vectra-canary/workloads.jsonl
sudo chattr -a /var/lib/vectra-canary/workloads.jsonl 2>/dev/null || true
sudo chown vectra-canary:vectra-canary /var/lib/vectra-canary/workloads.jsonl
sudo chmod 0644 /var/lib/vectra-canary/workloads.jsonl
sudo chattr +a /var/lib/vectra-canary/workloads.jsonl
sudo touch /var/lib/vectra-canary/attestations.jsonl
sudo chattr -a /var/lib/vectra-canary/attestations.jsonl 2>/dev/null || true
sudo chmod 0644 /var/lib/vectra-canary/attestations.jsonl
sudo chattr +a /var/lib/vectra-canary/attestations.jsonl
for unit in vectra-canary-workload.service vectra-canary-workload.timer vectra-canary-socket-proxy.service vectra-canary-socket-proxy.socket; do
  sudo install -m 0644 "$ROOT/deploy/systemd/$unit" "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemctl enable --now vectra-canary-socket-proxy.socket vectra-canary-workload.timer
echo 'Vectra private-network canary workload installed.'
