# 🤖 Personal AI Orchestrator

Sistem Autonomous AI Software Engineering & Knowledge Layer terintegrasi yang menghubungkan **AI Orchestrator (Backend Daemon)**, **Web Dashboard (React + Vite)**, dan **Obsidian Knowledge Wiki**.

---

## ⚡ Quick Start (1-Command Launcher)

Hanya perlu satu baris perintah untuk menyalakan seluruh ekosistem:

```bash
# Masuk ke direktori orchestrator
cd personal-ai-orchestrator

# Jalankan backend + dashboard sekaligus & buka browser otomatis
./start.sh
# ATAU
npm start
```

### 🎯 Apa yang Dilakukan oleh `./start.sh` Secara Otomatis?
1. **Pre-flight Check**: Memverifikasi Node.js, Git, dan Antigravity CLI (`agy`).
2. **Auto-Bootstrap Vault**: Jika folder `Obsidian Vault` belum ada (misal di mesin baru), script otomatis membuat struktur Wiki, `project-registry.md`, `index.md`, dan `wiki-log.md` siap pakai.
3. **Auto-Install Dependencies**: Otomatis menjalankan `npm install` jika `node_modules` belum terpasang di Backend maupun Web Dashboard.
4. **Dual Process Launcher**: Menjalankan Backend Daemon (Port 3721) dan Web Dashboard (Port 5173) secara bersamaan.
5. **Auto-Open Browser**: Membuka browser ke `http://localhost:5173`.
6. **Graceful Cleanup**: Menekan `Ctrl + C` otomatis mematikan kedua server secara bersih tanpa meninggalkan port nyangkut.

---

## 🛑 Perintah Manajemen Layanan

| Perintah | Deskripsi |
| :--- | :--- |
| **`./start.sh`** (atau `npm start`) | Menjalankan Backend + Dashboard UI + Auto-open browser |
| **`./start.sh stop`** (atau `npm run stop`) | Menghentikan semua background server & membebaskan port |
| **`./start.sh status`** | Memeriksa status kesehatan Backend Daemon & Dashboard UI |
| **`npm test`** | Menjalankan seluruh test suite (Unit Tests & Smoke Tests) |

---

## 🏗️ Struktur Arsitektur Sistem

```text
┌─────────────────────────────────────────────────────────────┐
│                 WEB DASHBOARD (React + Vite)                │
│   • Visual QA & Area Box Feedback  • Task Intake Form       │
│   • Dev Server Live Inspector      • Telemetry & Analytics  │
│   • Knowledge Candidate Center     • Notification Center    │
└──────────────────────────────┬──────────────────────────────┘
                               │ (REST API & SSE / Port 3721)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             BACKEND ORCHESTRATOR & DAEMON CORE              │
│   • Smart Token Routing Engine     • Task Readiness Gate    │
│   • Git Worktree Isolation Manager • Multi-Worker Queue     │
│   • Antigravity Agent Connector    • Telemetry & Retrospect │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 PERSISTENT OBSIDIAN VAULT                   │
│   • project-registry.md            • 01-Knowledge/          │
│   • index.md & wiki-log.md         • 02-Projects/ (Tasks)   │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Variabel Lingkungan Opsional (`.env`)

Script `./start.sh` sudah memiliki nilai default yang optimal, namun Anda dapat mengaturnya via `.env` atau environment variable jika diperlukan:

```env
# Path kustom ke Obsidian Vault (Default: ~/Documents/Obsidian Vault)
ORCHESTRATOR_VAULT_PATH="/path/to/your/Obsidian Vault"

# Path kustom ke folder Dashboard UI (Default: auto-detect)
ORCHESTRATOR_DASHBOARD_PATH="/path/to/orchestrator-dashboard"

# Port Backend API (Default: 3721)
PORT=3721

# Default Model Antigravity (Default: gemini-3.7-flash-high)
ORCHESTRATOR_AGY_MODEL=gemini-3.7-flash-high
```

---

## 🧪 Menjalankan Pengujian

```bash
# Jalankan unit tests + smoke tests
npm test

# Jalankan unit tests saja
npm run test:unit

# Jalankan smoke tests saja
npm run test:smoke
```

---

## 📄 Lisensi
Private & Internal Use.
