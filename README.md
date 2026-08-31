# 🤖 Personal AI Orchestrator

Sistem Autonomous AI Software Engineering & Knowledge Layer terintegrasi yang menghubungkan **AI Orchestrator (Backend Daemon)**, **Web Dashboard (React + Vite)**, dan **Obsidian Knowledge Wiki**.

Orchestrator ini juga menjadi control plane untuk **Personal AI OS**, yaitu agentic operating layer local-first yang berjalan di atas macOS. Batas produk, non-goals, safety properties, dan quality gate MVP ditetapkan dalam [AI OS MVP Scope Contract](./docs/AI_OS_MVP_SCOPE.md).

Implementasi durability, exactly-once invocation, dan restart reconciliation dijelaskan dalam [Phase 2 Runtime Durability Contract](./docs/PHASE_2_DURABILITY.md).

Kontrak integrasi dashboard, evidence, browser lifecycle testing, dan sertifikasi pilot dijelaskan dalam [Phase 3 AI OS Shell and Pilot Contract](./docs/PHASE_3_SHELL_PILOT.md).

Roadmap pasca-sertifikasi sampai Personal AI OS v1.0 GA, termasuk paket kerja
yang dapat dieksekusi model economy, tersedia di
[Phase 5 to v1.0 Execution Plan](./docs/PHASE_5_TO_V1_EXECUTION_PLAN.md).

Rencana v2 untuk Fresh Project dari Task Intake, objective decomposition,
dependency-aware multi-agent execution, cross-project incident handling, dan
Skill Router tersedia di
[AI OS v2 Orchestration Implementation Plan](./docs/AI_OS_V2_ORCHESTRATION_IMPLEMENTATION_PLAN.md).
The initial v2 scope and threat model are documented in
[AI OS v2 Scope Contract](./docs/AI_OS_V2_SCOPE.md) and
[AI OS v2 Threat Model](./docs/AI_OS_V2_THREAT_MODEL.md).

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

Backend dan dashboard hanya bind ke `127.0.0.1`. Credential API disimpan di `runs/runtime/api-token.json` dengan permission owner-only dan hanya dibaca oleh proxy lokal dashboard; token tidak dikirim ke JavaScript browser, URL, atau `localStorage`.

---

## 🛑 Perintah Manajemen Layanan

| Perintah | Deskripsi |
| :--- | :--- |
| **`./start.sh`** (atau `npm start`) | Menjalankan Backend + Dashboard UI + Auto-open browser |
| **`./start.sh stop`** (atau `npm run stop`) | Menghentikan semua background server & membebaskan port |
| **`./start.sh status`** | Memeriksa status kesehatan Backend Daemon & Dashboard UI |
| **`npm run security:rotate-token`** | Merotasi credential API runtime; restart layanan setelah rotasi |
| **`npm run operations:readiness`** | Menampilkan satu keputusan readiness/admission dan alasan blocker operasional |
| **`npm run retention:preview -- 30`** | Membuat preview artefak yang berusia minimal 30 hari; belum memindahkan apa pun |
| **`npm run retention:purge -- <plan-id> --confirm`** | Memindahkan kandidat plan ke trash yang dapat dipulihkan (tidak menghapus permanen) |
| **`npm run retention:restore -- <trash-id> --confirm`** | Memulihkan item dari retention trash jika target belum ada |
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

## ⚙️ Variabel Lingkungan & Profil Runtime (`.env`)

File `.env` di direktori root adalah **milik operator lokal (operator-owned)** dan diabaikan oleh Git (`.gitignore`). Nilai environment variable yang diekspor di shell terminal tetap memiliki prioritas tertinggi.

### 🛡️ Status Tata Kelola: Implemented vs Accepted vs Enabled
- **Implemented**: Kemampuan kode sumber AI OS v2 sudah tersedia dan teruji di repositori.
- **Accepted**: Disetujui secara formal oleh operator manusia (`local:sagaino`) untuk *controlled local rollout*.
- **Enabled / Active**: Diaktifkan secara sadar melalui flag di file `.env` lokal operator.

### 📦 Profil Runtime

1. **`LOCAL_SAFE` (Default Fresh Installation)**:
   Salin dari `.env.example`. Seluruh fitur penjadwalan objective v2 dan otomatisasi dinonaktifkan (`0`), mode persetujuan manual (`MANUAL`).
2. **`LOCAL_PILOT` (Opt-in Supervised Pilot)**:
   Salin dari `.env.pilot.example`. Mengaktifkan objective intake, DAG scheduler, dan cross-project diagnostics dengan mode `PLAN_REVIEW_THEN_AUTOPILOT`.

### 📋 Matriks Flag Konfigurasi

| Variabel | Canonical Name | Default (`LOCAL_SAFE`) | Pilot (`LOCAL_PILOT`) | Keterangan |
|---|---|---|---|---|
| Profil Runtime | `ORCHESTRATOR_PROFILE` | `LOCAL_SAFE` | `LOCAL_PILOT` | Nama kontrak profil |
| Mode Persetujuan | `ORCHESTRATOR_APPROVAL_MODE` | `MANUAL` | `PLAN_REVIEW_THEN_AUTOPILOT` | Kebijakan review plan |
| Objective Intake | `ORCHESTRATOR_OBJECTIVES_ENABLED` | `0` | `1` | Penerimaan objective baru |
| Objective Scheduler | `ORCHESTRATOR_OBJECTIVE_SCHEDULER` | `0` | `1` | DAG execution scheduler |
| Parallel Objectives | `ORCHESTRATOR_PARALLEL_OBJECTIVES` | `0` | `0` | Eksekusi objective paralel |
| Same-Project Parallel | `ORCHESTRATOR_SAME_PROJECT_PARALLEL` | `0` | `0` | Subtask paralel 1 repo |
| Cross-Project Mode | `ORCHESTRATOR_CROSS_PROJECT` | `0` | `1` | Diagnostik multi-repo |
| Skill System | `ORCHESTRATOR_SKILLS_ENABLED` | `0` | `0` | Formal skill registry |
| Skill Auto Routing | `ORCHESTRATOR_SKILL_AUTO_ROUTING` | `0` | `0` | Router otomatis skill |
| Telegram Channel | `ORCHESTRATOR_TELEGRAM_ENABLED` | `0` | `0` | Saluran Telegram (deferred) |
| Max Parallel Jobs | `ORCHESTRATOR_MAX_PARALLEL_JOBS` | `2` | `3` | Kapasitas worker pool |

### 🔧 Konfigurasi Path & Port Kanonikal

```env
# Path kustom ke Obsidian Vault (Fallback kompatibilitas: ORCHESTRATOR_VAULT)
ORCHESTRATOR_VAULT_PATH="/path/to/your/Obsidian Vault"

# Path kustom ke folder Runs Runtime
ORCHESTRATOR_RUNS="/path/to/personal-ai-orchestrator/runs"

# Port Backend API (Default: 3721)
ORCHESTRATOR_API_PORT=3721

# Port Dashboard UI Launcher (Default: 5173)
ORCHESTRATOR_DASHBOARD_PORT=5173

# Path kustom ke folder Dashboard UI (Default: auto-detect)
ORCHESTRATOR_DASHBOARD_PATH="/path/to/orchestrator-dashboard"
```

## 🛡️ Operations Center

Halaman **Operations** di dashboard adalah sumber keputusan operasional tunggal:
admission akan diblokir bila ruang disk rendah, backup DR belum/terlalu lama,
ukuran runtime melewati kuota, atau audit/evidence tidak valid. Launcher
produksi mengaktifkan guard ini otomatis. Sebelum pekerjaan baru diterima, buat
backup DR yang terverifikasi (`npm run dr:backup -- <absolute-backup-root>`);
backup yang dibuat oleh command tersebut langsung dicatat sebagai bukti freshness.

Retention selalu dua tahap: buat preview, tinjau kandidat, lalu konfirmasi
pemindahan ke trash. Artefak dapat dipulihkan; data Vault, source, audit, dan
evidence tidak pernah menjadi target cleanup otomatis.

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
