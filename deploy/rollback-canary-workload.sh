#!/bin/sh
set -eu
sudo systemctl disable --now vectra-canary-workload.timer 2>/dev/null || true
sudo systemctl stop vectra-canary-workload.service 2>/dev/null || true
sudo systemctl disable --now vectra-canary-socket-proxy.socket 2>/dev/null || true
sudo systemctl stop vectra-canary-socket-proxy.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/vectra-canary-workload.service /etc/systemd/system/vectra-canary-workload.timer /etc/systemd/system/vectra-canary-socket-proxy.service /etc/systemd/system/vectra-canary-socket-proxy.socket
sudo rm -f /run/vectra-canary-proxy.sock
sudo rm -f /usr/local/lib/vectra-canary/attest-canary-workload.mjs /usr/local/lib/vectra-canary/canary-workload.mjs /etc/vectra-canary/canary.env
sudo rm -f /etc/vectra-canary/attestation-private.pem
sudo systemctl daemon-reload
sudo systemctl reset-failed vectra-canary-workload.service vectra-canary-workload.timer 2>/dev/null || true
sudo rm -f /home/rawdata/.local/share/vectra-canary/current/deploy/canary-workload.mjs
echo 'Canary workload runtime removed; immutable telemetry retained as audit evidence.'
