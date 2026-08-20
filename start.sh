#!/usr/bin/env bash

# ==============================================================================
# ✨ Personal AI Orchestrator - All-in-One Smart Launcher & Lifecycle Manager
# ==============================================================================
# Usage:
#   ./start.sh          # Start Backend & Frontend, open browser (Foreground)
#   ./start.sh stop     # Stop all running services cleanly
#   ./start.sh status   # Check status of Backend & Frontend
# ==============================================================================

set -e

# --- Configuration & Paths ---
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$DIR"
DASHBOARD_DIR="${ORCHESTRATOR_DASHBOARD_PATH:-$(cd "$DIR/../ciniru/orchestrator-dashboard" 2>/dev/null && pwd || cd "$DIR/../orchestrator-dashboard" 2>/dev/null && pwd || echo "")}"
DEFAULT_VAULT_PATH="$HOME/Documents/Obsidian Vault"
VAULT_PATH="${ORCHESTRATOR_VAULT_PATH:-$DEFAULT_VAULT_PATH}"
BACKEND_PORT=3721
FRONTEND_PORT=5173
PID_FILE="$BACKEND_DIR/runs/.orchestrator.pids"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/com.sagaino.personal-ai-orchestrator.plist"

# --- Text Formatting & Colors ---
C_RESET='\033[0m'
C_BOLD='\033[1m'
C_GREEN='\033[32m'
C_BLUE='\033[34m'
C_CYAN='\033[36m'
C_YELLOW='\033[33m'
C_RED='\033[31m'
C_PURPLE='\033[35m'

print_banner() {
  echo -e "${C_PURPLE}${C_BOLD}"
  echo "  ██████╗ ███████╗██████╗ ███████╗ ██████╗ ███╗   ██╗ █████╗ ██╗     "
  echo "  ██╔══██╗██╔════╝██╔══██╗██╔════╝██╔═══██╗████╗  ██║██╔══██╗██║     "
  echo "  ██████╔╝█████╗  ██████╔╝███████╗██║   ██║██╔██╗ ██║███████║██║     "
  echo "  ██╔═══╝ ██╔══╝  ██╔══██╗╚════██║██║   ██║██║╚██╗██║██╔══██║██║     "
  echo "  ██║     ███████╗██║  ██║███████║╚██████╔╝██║ ╚████║██║  ██║███████╗"
  echo "  ╚═╝     ╚══════╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝"
  echo -e "         ${C_CYAN}🤖 Personal AI Software Engineering System${C_RESET}\n"
}

# --- Helper Functions ---
log_info() {
  echo -e "  ${C_CYAN}[INFO]${C_RESET} $1"
}

log_success() {
  echo -e "  ${C_GREEN}[✓]${C_RESET} $1"
}

log_warn() {
  echo -e "  ${C_YELLOW}[!]${C_RESET} $1"
}

log_error() {
  echo -e "  ${C_RED}[✗]${C_RESET} $1"
}

# --- Action: Stop Services ---
stop_services() {
  echo -e "\n${C_YELLOW}${C_BOLD}🛑 Stopping Personal AI Orchestrator...${C_RESET}"
  
  # 1. Unload launchctl daemon service if active (macOS LaunchAgent auto-restart)
  if [ -f "$LAUNCHD_PLIST" ]; then
    launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
  fi
  launchctl remove "com.sagaino.personal-ai-orchestrator" 2>/dev/null || true

  # 2. Kill via saved PID file
  if [ -f "$PID_FILE" ]; then
    while IFS= read -r pid; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi

  # 3. Kill any background daemon worker or server processes
  pkill -9 -f "orchestrator.mjs (daemon-worker|daemon|server)" 2>/dev/null || true

  # 4. Kill any lingering process holding the ports
  local backend_pids=$(lsof -ti :$BACKEND_PORT 2>/dev/null || true)
  if [ -n "$backend_pids" ]; then
    echo "$backend_pids" | xargs kill -9 2>/dev/null || true
  fi
  log_success "Backend Daemon stopped (Port $BACKEND_PORT freed)"

  local frontend_pids=$(lsof -ti :$FRONTEND_PORT 2>/dev/null || true)
  if [ -n "$frontend_pids" ]; then
    echo "$frontend_pids" | xargs kill -9 2>/dev/null || true
  fi
  log_success "Dashboard UI stopped (Port $FRONTEND_PORT freed)"

  log_success "✨ All services stopped cleanly.\n"
}

# --- Action: Check Status ---
check_status() {
  echo -e "${C_CYAN}${C_BOLD}🔍 Checking Personal AI Orchestrator Status...${C_RESET}\n"
  
  local backend_running=false
  local frontend_running=false

  if curl -s --connect-timeout 1 "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
    backend_running=true
  elif lsof -ti :$BACKEND_PORT >/dev/null 2>&1; then
    backend_running=true
  fi

  if lsof -ti :$FRONTEND_PORT >/dev/null 2>&1; then
    frontend_running=true
  fi

  if [ "$backend_running" = true ]; then
    echo -e "  Backend Daemon : ${C_GREEN}${C_BOLD}RUNNING${C_RESET} (http://127.0.0.1:$BACKEND_PORT)"
  else
    echo -e "  Backend Daemon : ${C_RED}STOPPED${C_RESET}"
  fi

  if [ "$frontend_running" = true ]; then
    echo -e "  Dashboard UI   : ${C_GREEN}${C_BOLD}RUNNING${C_RESET} (http://localhost:$FRONTEND_PORT)"
  else
    echo -e "  Dashboard UI   : ${C_RED}STOPPED${C_RESET}"
  fi
  echo ""
}

# Handle command line arguments
case "$1" in
  stop)
    stop_services
    exit 0
    ;;
  status)
    check_status
    exit 0
    ;;
esac

# ==============================================================================
# STARTUP SEQUENCE
# ==============================================================================

print_banner

# 1. Pre-flight Environment Checks
log_info "Memeriksa dependensi sistem..."

if ! command -v node >/dev/null 2>&1; then
  log_error "Node.js tidak ditemukan! Silakan install Node.js (v18+) terlebih dahulu."
  exit 1
fi

NODE_VERSION=$(node -v)
log_success "Node.js terdeteksi: $NODE_VERSION"

if ! command -v git >/dev/null 2>&1; then
  log_error "Git tidak ditemukan! Silakan install git terlebih dahulu."
  exit 1
fi

if ! command -v agy >/dev/null 2>&1; then
  log_warn "Antigravity CLI ('agy') belum terdeteksi di PATH. Task coding agent mungkin membutuhkan agy."
else
  log_success "Antigravity CLI ('agy') terdeteksi."
fi

# 2. Auto-Bootstrap Vault (If not present)
if [ ! -d "$VAULT_PATH" ]; then
  log_info "Obsidian Vault belum ditemukan di '$VAULT_PATH'."
  log_info "Membuat struktur Vault baru (Auto-Bootstrap)..."
  
  mkdir -p "$VAULT_PATH/01-Knowledge/concepts" \
           "$VAULT_PATH/01-Knowledge/patterns" \
           "$VAULT_PATH/01-Knowledge/snippets" \
           "$VAULT_PATH/01-Knowledge/decisions" \
           "$VAULT_PATH/01-Knowledge/debugging" \
           "$VAULT_PATH/02-Projects" \
           "$VAULT_PATH/03-Sources/assets/ui-mockups" \
           "$VAULT_PATH/03-Sources/other" \
           "$VAULT_PATH/04-Inbox" \
           "$VAULT_PATH/05-Knowledge-Candidates"

  # Create initial project-registry.md
  cat << 'REGISTRY_EOF' > "$VAULT_PATH/project-registry.md"
---
title: Project Registry
type: registry
tags: [registry, projects, control-center]
created: 2026-08-14
updated: 2026-08-14
sources: []
---

# Project Registry

The registry resolves an Obsidian task's `project` value to the real repository.

| project_id | project page | repository | agent | graphify | graphify output |
|---|---|---|---|---|---|

REGISTRY_EOF

  # Create initial wiki-log.md
  cat << 'WIKILOG_EOF' > "$VAULT_PATH/wiki-log.md"
# Wiki Log

| timestamp | event | title | path | details |
|---|---|---|---|---|
WIKILOG_EOF

  # Create initial index.md
  cat << 'INDEX_EOF' > "$VAULT_PATH/index.md"
---
title: Wiki Index
type: index
tags: [index, wiki]
---

# Wiki Index

## Knowledge
(Belum ada knowledge yang terdaftar)

## Projects
(Belum ada project yang terdaftar)
INDEX_EOF

  log_success "Obsidian Vault berhasil dibuat & diinisialisasi!"
else
  log_success "Obsidian Vault terdeteksi di: $VAULT_PATH"
fi

# 3. Locate Dashboard UI
if [ -z "$DASHBOARD_DIR" ] || [ ! -d "$DASHBOARD_DIR" ]; then
  log_warn "Direktori dashboard frontend tidak ditemukan otomatis."
  read -p "  Masukkan path folder orchestrator-dashboard: " USER_DASHBOARD_PATH
  DASHBOARD_DIR=$(eval echo "$USER_DASHBOARD_PATH")
  if [ ! -d "$DASHBOARD_DIR" ]; then
    log_error "Direktori dashboard '$DASHBOARD_DIR' tidak valid! Melanjutkan hanya dengan Backend API."
    DASHBOARD_DIR=""
  fi
fi

if [ -n "$DASHBOARD_DIR" ]; then
  log_success "Dashboard UI terdeteksi di: $DASHBOARD_DIR"
fi

# 4. Auto-Install Dependencies
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  log_info "Menginstall dependensi Backend Orchestrator..."
  (cd "$BACKEND_DIR" && npm install --silent)
  log_success "Dependensi Backend terinstall."
fi

if [ -n "$DASHBOARD_DIR" ] && [ ! -d "$DASHBOARD_DIR/node_modules" ]; then
  log_info "Menginstall dependensi Dashboard UI..."
  (cd "$DASHBOARD_DIR" && npm install --silent)
  log_success "Dependensi Dashboard UI terinstall."
fi

# 5. Clean Previous Lingering Ports & Workers
mkdir -p "$BACKEND_DIR/runs"
if [ -f "$LAUNCHD_PLIST" ]; then
  launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
fi
launchctl remove "com.sagaino.personal-ai-orchestrator" 2>/dev/null || true
pkill -9 -f "orchestrator.mjs (daemon-worker|daemon|server)" 2>/dev/null || true
lsof -ti :$BACKEND_PORT | xargs kill -9 2>/dev/null || true
lsof -ti :$FRONTEND_PORT | xargs kill -9 2>/dev/null || true

# 6. Trap SIGINT and SIGTERM for Graceful Shutdown
trap 'stop_services; exit 0' SIGINT SIGTERM EXIT

# 7. Launch Services
echo ""
log_info "Menjalankan Backend Daemon & Server API..."
(cd "$BACKEND_DIR" && node src/orchestrator.mjs server --vault "$VAULT_PATH" --port $BACKEND_PORT) &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$PID_FILE"

# Wait for backend to be ready
echo -n "  Menunggu Backend API aktif"
for i in {1..30}; do
  if curl -s --connect-timeout 1 "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
    echo -e " ${C_GREEN}[READY]${C_RESET}"
    break
  fi
  echo -n "."
  sleep 0.5
done

if [ -n "$DASHBOARD_DIR" ]; then
  log_info "Menjalankan Web Dashboard..."
  (cd "$DASHBOARD_DIR" && npm run dev -- --port $FRONTEND_PORT --host) &
  FRONTEND_PID=$!
  echo "$FRONTEND_PID" >> "$PID_FILE"

  # Wait for dashboard to be ready
  for i in {1..20}; do
    if lsof -ti :$FRONTEND_PORT >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

echo ""
echo -e "${C_GREEN}${C_BOLD}══════════════════════════════════════════════════════════════${C_RESET}"
echo -e "  ${C_GREEN}${C_BOLD}🚀 PERSONAL AI ORCHESTRATOR IS RUNNING!${C_RESET}"
echo -e "  ${C_CYAN}• Backend API :${C_RESET} http://127.0.0.1:$BACKEND_PORT"
if [ -n "$DASHBOARD_DIR" ]; then
  echo -e "  ${C_PURPLE}• Dashboard UI:${C_RESET} http://localhost:$FRONTEND_PORT"
fi
echo -e "  ${C_YELLOW}• Obsidian    :${C_RESET} $VAULT_PATH"
echo -e "${C_GREEN}${C_BOLD}══════════════════════════════════════════════════════════════${C_RESET}"
echo -e "  Tekan ${C_BOLD}Ctrl + C${C_RESET} untuk menghentikan semua layanan.\n"

# 8. Auto-Open Browser (Mac / Linux)
if [ -n "$DASHBOARD_DIR" ]; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:$FRONTEND_PORT" 2>/dev/null || true
  elif [[ "$OSTYPE" == "linux-gnu"* ]] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:$FRONTEND_PORT" 2>/dev/null || true
  fi
fi

# Wait for background child processes
wait
