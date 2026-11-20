#!/usr/bin/env bash
# READ-ONLY capacity and safety check before installing the Shakhira dashboard + send-only worker
# on a Linux server you have chosen for it. It changes nothing.
#
#   bash deploy/vm/preflight.sh            # report
#   bash deploy/vm/preflight.sh --strict   # exit 1 if the server does not have room
#
# Needs: ~300 MB RAM free (both services are capped at 200 MB + 150 MB), ~1 GB disk, Python 3.10+,
# and a free localhost port for the dashboard (default 8090).
set -u
STRICT=0; [ "${1:-}" = "--strict" ] && STRICT=1
PORT="${DASHBOARD_PORT:-8090}"
MIN_FREE_MB=300
MIN_DISK_MB=1024
problems=()

section() { printf '\n== %s ==\n' "$1"; }

section "Machine"
echo "Host: $(hostname)   OS: $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}")   Kernel: $(uname -r)"
echo "CPUs: $(nproc)   Load (1/5/15 min): $(cut -d' ' -f1-3 /proc/loadavg)"
if command -v curl >/dev/null; then
  meta() { curl -s -m 2 -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/$1" 2>/dev/null; }
  mt=$(meta machine-type); [ -n "$mt" ] && echo "GCP machine type: ${mt##*/}   Zone: $(meta zone | sed 's#.*/##')   Preemptible: $(meta scheduling/preemptible)"
fi

section "Memory"
free -m
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
echo "Available: ${avail} MB (need ${MIN_FREE_MB} MB)"
[ "${avail:-0}" -lt "$MIN_FREE_MB" ] && problems+=("only ${avail} MB RAM available; need ${MIN_FREE_MB} MB")

section "Disk"
df -hP / /opt 2>/dev/null | awk 'NR==1 || !seen[$0]++'
disk=$(df -Pm /opt 2>/dev/null | awk 'NR==2 {print $4}')
echo "Free on /opt: ${disk:-?} MB (need ${MIN_DISK_MB} MB)"
[ "${disk:-0}" -lt "$MIN_DISK_MB" ] && problems+=("only ${disk:-0} MB free disk; need ${MIN_DISK_MB} MB")

section "Top processes by memory"
ps -eo pid,user,%cpu,%mem,rss,etime,comm --sort=-rss | head -15

section "Other heavy workloads (ollama, vllm, llama, comfy, jupyter, python)"
ps -eo pid,user,%cpu,rss,args --sort=-rss | grep -iE 'ollama|vllm|llama|comfy|jupyter|python' | grep -v grep | cut -c1-160 | head -20 || true
command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv 2>/dev/null

section "Running services"
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -40
command -v docker >/dev/null && { echo "-- docker containers --"; docker ps --format '{{.Names}}  {{.Image}}  {{.Status}}' 2>/dev/null || echo "(no permission to list docker containers)"; }

section "Listening ports"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | head -30
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE "[:.]${PORT}\b"; then
  problems+=("port ${PORT} is already in use; set DASHBOARD_PORT to a free port")
fi

section "Existing Shakhira / Telegram bot processes (must not start a second receiving bot)"
ps -eo pid,user,args | grep -iE 'shakhira|telegram|aiogram|telebot|python-telegram|pyrogram|telethon' | grep -v -E 'grep|preflight' | cut -c1-160 || true
for d in /opt /srv /home/*; do ls -d "$d"/*shakhira* "$d"/*bot* 2>/dev/null; done | head -20

section "Python"
py=$(command -v python3 || true)
if [ -n "$py" ]; then
  v=$($py -c 'import sys; print("%d.%d" % sys.version_info[:2])'); echo "python3 $v at $py"
  $py -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' || problems+=("python3 $v is older than 3.10")
  $py -c 'import venv, ensurepip' 2>/dev/null || problems+=("python3-venv is not installed (sudo apt-get install -y python3-venv)")
else
  problems+=("python3 is not installed")
fi

section "Result"
if [ ${#problems[@]} -eq 0 ]; then
  echo "OK: this server has room for the dashboard and send-only worker."
  exit 0
fi
printf 'NOT READY:\n'; printf ' - %s\n' "${problems[@]}"
[ $STRICT -eq 1 ] && exit 1 || exit 0
