# Personal AI Orchestrator MVP

Orchestrator ini adalah control plane awal untuk menghubungkan Obsidian Wiki dengan repository project yang berada di lokasi eksternal.

## Prinsip

- Obsidian `01-Knowledge/` menyimpan knowledge reusable.
- Repository project tetap menjadi source of truth untuk source code.
- `project-registry.md` di Vault menjadi registry project yang dibaca oleh MVP ini.
- Graphify hanya menjadi peta dependency; output Graphify dibaca dari repository project.
- Context, plan, watcher, dan readiness gate bersifat read-only. Perubahan hanya dilakukan oleh run yang sudah di-approve dan di-claim.
- Setiap coding run bekerja di isolated Git worktree; repository utama baru menerima perubahan setelah final `accept`.
- Daemon dapat menjalankan dua project berbeda secara paralel secara default; satu project tetap eksklusif sampai task aktif di-`accept` atau di-`reject`.

## Command Umum

Command yang paling sering digunakan dikumpulkan di sini agar user tidak perlu membuka Wiki atau mencari run ID:

```bash
# Mendaftarkan repository existing; Graphify dibuat/refreshed otomatis sebelum registrasi Wiki.
npm run add-project -- existing /absolute/path/project --by user

# Membuat project Vite + Shadcn baru dari blueprint Wiki dan memasang seluruh komponen Shadcn.
npm run add-project -- new nama-project --path /absolute/path/nama-project --by user

# Menonaktifkan project dari orchestrator dan mengarsipkan metadata/task tanpa menghapus repository atau knowledge.
npm run remove-project -- nama-project --by user

# Mengeluarkan archive project nonaktif dari Obsidian ke quarantine audit yang recoverable.
npm run purge-project-archive -- nama-project --confirm --by user

# Membuat task dari natural language dan langsung memasukkannya ke antrean eksekusi.
npm run request-task -- starter-app "Tambahkan fitur yang diminta" --start --by user

# Melihat status task terbaru dari seluruh project.
npm run status

# Melihat status task tertentu menggunakan task ID.
npm run status -- FE-016

# Melihat hasil perubahan, verification, Graphify, dan proposal knowledge task.
npm run review -- FE-016

# Membuka isolated review workspace di VS Code; jalankan npm run dev secara manual di terminal VS Code.
npm run preview -- FE-016

# Meminta revisi pada workspace yang sama, lalu menjalankan ulang audit dan verification.
npm run request-changes -- FE-016 --reason "Sesuaikan spacing dengan desain" --by user

# Melihat persistent notification inbox dan jumlah yang belum dibaca.
npm run notifications

# Menandai notification tertentu, seluruh notification task, atau semuanya sebagai sudah dibaca.
npm run notification:read -- FE-016 --by user
npm run notification:read -- all --by user

# Mengirim notification test ke desktop dan inbox.
npm run notification:test

# Melihat total token/durasi semua run atau membatasi ke project tertentu.
npm run telemetry
npm run telemetry -- --project starter-app

# Melihat detail telemetry satu task atau run.
npm run telemetry -- FE-016

# Memeriksa kualitas Wiki tanpa mengubah file.
npm run knowledge-health

# Memperbaiki index secara aman dan mencatat lint.
npm run knowledge-health -- --fix-safe --by user

# Menerapkan hasil worktree ke repository utama, menjalankan knowledge routing/Wiki Sync, lalu DONE.
npm run accept -- FE-016 --by user

# Membuang isolated worktree tanpa mengubah repository utama jika hasil belum diterima.
npm run reject -- FE-016 --reason "Acceptance criteria belum terpenuhi" --by user

# Fallback manual jika automatic recovery habis dan penyebab eksternal sudah diperbaiki.
npm run recover -- FE-016 --by user

# Mengulang task dari coding agent; gunakan --force hanya setelah worktree direview.
npm run retry -- FE-016 --by user --force

# Menampilkan seluruh knowledge Candidate yang menunggu keputusan manual.
npm run knowledge-candidates

# Memeriksa provenance dan kemiripan Candidate sebelum dipromosikan.
npm run knowledge-review -- candidate-id

# Mempromosikan Candidate menjadi knowledge global di Wiki.
npm run promote-knowledge -- zustand-feature-state-management --by user

# Menolak dan mengarsipkan Candidate yang tidak layak menjadi knowledge global.
npm run reject-knowledge -- candidate-id --reason "Tidak reusable" --by user

# Memeriksa apakah daemon background terpasang, aktif, dan sehat.
npm run daemon:status

# Menghidupkan daemon background.
npm run daemon:start

# Mematikan daemon background.
npm run daemon:stop

# Menjalankan regression test Personal AI Orchestrator.
npm test
```

## Menjalankan

Flow utama menggunakan command pada section **Command Umum** dan tidak memerlukan user membuka Wiki, repository, atau mengetahui run ID.

`request-task` menggunakan agent read-only dan Graphify untuk menyusun title, tujuan, expected result, acceptance criteria, dependency, verification, `allowed_paths`, dan risk. Task dibuat dan diindeks otomatis di Wiki. Jika informasi aman belum cukup, orchestrator mengembalikan satu pertanyaan klarifikasi dan tidak membuat task setengah jadi.

Flag `--start` mencatat instruksi user sebagai execution approval dan memasukkan task ke persistent background queue. Daemon menjalankan readiness, claim, coding agent, verification, Graphify, dan retrospective. `status` dan `review` menerima task ID atau memilih task terbaru, sehingga run ID hanya menjadi detail audit.

Untuk setiap run, orchestrator membuat detached Git worktree di `runs/workspaces/`. Kondisi working tree saat task dimulai—termasuk perubahan tracked dan untracked—disalin sebagai baseline, sedangkan `node_modules`, output build, dan `graphify-out` dibuat ulang di workspace. Coding agent, dependency reconciliation, verification, dan Graphify hanya bekerja di sana. Karena itu perubahan task belum terlihat di repository utama saat status `REVIEW`.

Saat task menunggu review, `npm run preview -- FE-016` membuka isolated worktree tersebut sebagai window VS Code. User kemudian dapat memeriksa diff dan menjalankan `npm run dev` sendiri dari terminal VS Code untuk visual review. Command preview tidak menjalankan dev server dan tidak mengubah repository utama.

Jika hasilnya perlu diperbaiki tetapi belum ingin dibuang, gunakan `request-changes` dengan feedback yang konkret. Orchestrator mempertahankan worktree dan conversation agent yang sama, mengubah task sementara ke `IN_PROGRESS`, menerapkan revisi, lalu mengulang dependency reconciliation, scope audit, verification, Graphify, dan retrospective sebelum kembali ke review. Iterasi request changes saat ini tidak memiliki hard limit; setiap iterasi tetap wajib berada di `allowed_paths` dan lulus seluruh gate. Sebaliknya, `reject` adalah keputusan final untuk run tersebut: diff diarsipkan dan worktree dibuang tanpa mengubah repository utama.

Jika dependency reconciliation, verification, atau refresh Graphify gagal setelah scope audit aman, orchestrator menjalankan automatic recovery di worktree yang sama. Percobaan pertama adalah deterministic retry tanpa AI. Jika masih gagal, recovery agent menerima error tail, task, knowledge terpilih, Graphify context, dan daftar `allowed_paths`; agent memperbaiki implementasi yang ada tanpa terminal lalu orchestrator mengulang dependency, scope audit, verification, dan Graphify. AI repair dibatasi maksimal dua attempt secara default. Scope violation, empty required diff, coding-agent failure, dan workspace bootstrap failure langsung dihentikan karena belum aman untuk diperbaiki otomatis.

## Project Onboarding

Project onboarding memiliki dua flow dan keduanya dijalankan dari orchestrator:

```bash
# Existing project: ID diambil dari package.json; gunakan --id hanya jika perlu override.
npm run add-project -- existing /Users/me/projects/existing-app --by user
npm run add-project -- existing /Users/me/projects/existing-app --id existing-app --by user

# New project: nama menjadi project ID, sedangkan --path menentukan lokasi repository.
npm run add-project -- new customer-portal --path /Users/me/projects/customer-portal --by user
```

Flow `existing` memastikan path adalah Git repository dengan `package.json`, menjalankan verification yang tersedia, lalu menjalankan `graphify update .`. Jika Graphify belum ada, output dibuat otomatis; jika sudah ada, output di-refresh. Setelah semuanya lulus, orchestrator membuat atau memperbarui project page, task directory, registry, index, Wiki log, dan audit onboarding.

Flow `new` menggunakan blueprint `frontend-vite` dari `01-Knowledge/patterns/frontend/project-skeleton-template.md`. Orchestrator membuat Vite + React + TypeScript dengan Shadcn CLI `4.18.0`, wajib menjalankan `shadcn add --all`, lalu menerapkan deterministic template dari `templates/frontend-vite/`. Normal path tidak memanggil coding agent, sehingga onboarding standar menggunakan `0` token AI. Baseline minimum harus lulus `typecheck`, `lint`, dan `build`; `test` juga dijalankan bila tersedia. Sesudah itu orchestrator membuat initial Git commit, membangun Graphify, dan mendaftarkan project ke Wiki.

Deterministic template version `2` menyediakan starter Login berbasis React Hook Form, Zod, TanStack Query, i18n, toast, route guards, dan encrypted storage tanpa dummy user/token atau API fallback. Project memasang implementasi autentikasinya melalui `configureAuthLoginAdapter`; `VITE_API_URL`, `VITE_LOGIN_ENDPOINT`, dan `VITE_SECRET_KEY` tetap menjadi konfigurasi eksplisit milik project. Generated Shadcn UI tetap typechecked, sementara unused-local enforcement untuk source milik project ditangani ESLint agar `shadcn add --all` tidak memblokir baseline karena generated import.

Jika deterministic template gagal verification, satu coding-agent fallback dapat menerima error tail dan hanya memperbaiki file template yang diizinkan. Prompt fallback tidak memuat seluruh blueprint, perubahan agent diaudit terhadap scope, dan `src/components/ui/` tetap tidak boleh diubah. Dependency serta seluruh verification diulang setelah fallback. Set `ORCHESTRATOR_ONBOARDING_AI_FALLBACK=off` untuk mode strict tanpa token AI; pada mode ini verification failure langsung rollback.

Dependency inti blueprint dikendalikan oleh versioned policy. TypeScript dinormalisasi ke known-good `~5.9.3` sebelum instalasi agar perubahan output Shadcn atau fallback tidak menghidupkan kembali konflik peer dependency seperti kasus `react-i18next@15` sebelumnya. Orchestrator lebih dahulu menjalankan package-lock-only preflight; error dependency resolution mendapat maksimal satu deterministic retry setelah policy diterapkan ulang. Flow ini tidak memakai `--force` atau `--legacy-peer-deps`, sehingga konflik asli tidak disembunyikan.

Selama command berjalan, terminal menampilkan stage aktif dan heartbeat setiap 15 detik untuk proses panjang. Output JSON lengkap mencatat template version/checksum, scaffold mode, apakah fallback digunakan, serta telemetry `null` ketika tidak ada AI. Initial Git commit juga memiliki security gate: `.env` dan `.env.*` diabaikan, `.env.example` diperbolehkan, dan setiap environment file sensitif menggagalkan onboarding sebelum commit.

Project baru dibuat di staging yang terisolasi. Jika initialization, coding agent, dependency preflight/install, security gate, verification, Git, Graphify, atau Wiki registration gagal, target project dan perubahan registrasi di-rollback. Command berhasil mengembalikan `nextAction` yang dapat langsung disalin untuk membuat task pertama.

Project dapat dikeluarkan dari daftar aktif tanpa menghapus source code atau knowledge:

```bash
npm run remove-project -- customer-portal --by user
```

`remove-project` diblokir ketika masih ada task berstatus `READY`, `IN_PROGRESS`, atau `REVIEW`, job `QUEUED/RUNNING/REVIEW`, maupun run lifecycle aktif. Jika aman, project dikeluarkan dari registry dan active index, kemudian project page beserta task history dipindahkan ke immutable `03-Sources/other/removed-projects/<project-id>/<timestamp>/`. Arsip memiliki `removal-manifest.json`, inventory, dan checksum SHA-256.

Operasi ini tidak melakukan cascade delete. `01-Knowledge/`, `05-Knowledge-Candidates/`, immutable run sources, repository external, dan `graphify-out/graph.json` tetap dipertahankan. Wikilink pada halaman Wiki yang mutable diarahkan ke lokasi arsip; legacy link di immutable source tetap dapat diverifikasi melalui alias dari removal manifest. Seluruh perubahan Vault dan audit removal bersifat transaksional; kegagalan setelah proses dimulai mengembalikan project ke keadaan aktif sebelumnya. Output command menyediakan instruksi `add-project existing` untuk mengaktifkan kembali repository tersebut.

Jika archive project yang sudah nonaktif juga tidak ingin terlihat di Obsidian, gunakan operasi eksplisit berikut:

```bash
npm run purge-project-archive -- customer-portal --confirm --by user
```

Command ini hanya menerima project yang sudah di-`remove`, tidak memiliki task/job/run aktif, dan tidak memiliki wikilink tersisa di luar index. Archive dipindahkan secara transaksional dari Vault ke `runs/purged-project-archives/<project-id>/<timestamp>/archive`, bukan dihapus langsung dari disk. Entry archive dibersihkan dari `index.md`, Wiki log dan audit purge ditulis, sedangkan repository, Graphify, global knowledge, Candidates, dan run history tetap dipertahankan. Flag `--confirm` wajib agar purge tidak terjadi karena salah ketik; data quarantine tetap dapat dipulihkan secara manual bila diperlukan.

## Notification

Daemon membuat notification ketika task siap direview, automatic recovery berhasil, task gagal/recovery habis, atau daemon menemukan outcome yang belum diberitahukan setelah restart. Knowledge yang masuk `05-Knowledge-Candidates/` juga membuat notification karena membutuhkan keputusan terpisah. Event disimpan lebih dahulu sebagai JSON terdeduplikasi di `runs/notifications/`, sehingga banner desktop yang terlewat tetap dapat dibaca dari inbox.

Pada macOS, mode default `auto` membangun dan menjalankan helper native `Personal AI Orchestrator.app` di `runs/runtime/`. Percobaan pertama mendaftarkan helper ke macOS dan dapat memunculkan dialog izin; setelah itu `Personal AI Orchestrator` tersedia di System Settings → Notifications. Desktop delivery bersifat best-effort: kegagalan permission atau delivery dicatat tetapi tidak boleh mengubah task yang berhasil menjadi gagal. Status `ACCEPTED_BY_MACOS` berarti Notification Center menerima request, bukan jaminan banner terlihat ketika Focus atau pengaturan preview sedang menyembunyikannya. Pilihan delivery:

```bash
# Default: desktop pada macOS, inbox-only pada platform lain.
ORCHESTRATOR_NOTIFICATION_DELIVERY=auto npm run notification:test

# Selalu simpan ke inbox tanpa desktop banner.
ORCHESTRATOR_NOTIFICATION_DELIVERY=inbox npm run notification:test

# Minta desktop delivery jika platform mendukungnya.
ORCHESTRATOR_NOTIFICATION_DELIVERY=desktop npm run notification:test
```

Gunakan nilai environment yang sama ketika menjalankan `daemon:install` jika setting harus disimpan ke LaunchAgent. Notification hanya memberi tahu dan menyarankan command; tidak pernah menjalankan `accept`, `reject`, atau promosi Candidate secara otomatis.

## Token Telemetry

Setiap panggilan Antigravity untuk conversational intake, implementation, bounded automatic recovery, dan retrospective dicatat sebagai record terpisah. Record menyimpan stage, model, effort, status, conversation ID, durasi provider, serta `input`, `output`, `thinking`, `cache-read`, `total`, dan derived context token. Orchestrator memakai angka `usage` yang dilaporkan Antigravity dan tidak mengestimasi biaya ketika pricing provider tidak tersedia.

Telemetry baru disimpan pada run manifest; intake juga memiliki ledger persisten di `runs/telemetry/intakes/` sebelum run dibuat. Untuk backward compatibility, command telemetry membaca final-result dari event log run dan intake lama tanpa mengubah manifest historis. `status` dan `review` hanya menampilkan summary, sedangkan command berikut menampilkan record lengkap:

```bash
# Agregat seluruh project.
npm run telemetry

# Agregat satu project.
npm run telemetry -- --project starter-app

# Detail satu task atau run.
npm run telemetry -- FE-016
```

Default warning threshold adalah `250000` total token per run. Warning bersifat observability-only: tidak menghentikan coding agent, recovery, Wiki Sync, atau approval. Nilai `0` menonaktifkan warning. Jika override harus berlaku pada daemon, install ulang service dengan environment tersebut:

```bash
ORCHESTRATOR_TOKEN_WARNING_THRESHOLD=400000 npm run daemon:install
```

`totalTokens` mengikuti total provider dan tidak ditambah lagi dengan `thinkingTokens`; `cacheReadTokens` dilaporkan terpisah. `contextTokens` adalah `inputTokens + cacheReadTokens` untuk melihat besarnya context yang diproses atau digunakan ulang.

## Knowledge Quality

`knowledge-health` memberi satu laporan kualitas lintas Vault. Pemeriksaan mencakup frontmatter wajib, format metadata, broken/ambiguous wikilink, halaman knowledge yang belum di-index, orphan Candidate, exact/near duplicate, contradiction candidate, sinkronisasi project registry, repository path, dan Graphify output.

Mode default sepenuhnya read-only. Mode `--fix-safe` hanya menambahkan knowledge/Candidate yang belum terdaftar ke section `Knowledge Health Auto-index` pada `index.md`, kemudian menulis audit `lint` ke `wiki-log.md`:

```bash
npm run knowledge-health
npm run knowledge-health -- --fix-safe --by user
```

Safe-fix tidak pernah membuat frontmatter berdasarkan tebakan, memperbaiki broken link, mengubah isi knowledge, menggabungkan duplicate, menghapus halaman, atau menyelesaikan contradiction candidate. Temuan tersebut tetap terlihat sebagai `ERROR` atau `WARNING` agar keputusan semantik dilakukan secara terarah.

Sebelum promosi manual, `knowledge-review` memverifikasi immutable source dan mencari halaman serupa. Jika hasil review `NEEDS_TARGET`, gunakan halaman existing yang direkomendasikan sebagai target `UPDATE`:

```bash
npm run knowledge-review -- candidate-id
npm run promote-knowledge -- candidate-id --target 01-Knowledge/patterns/existing-topic.md --by user
```

## Parallel Execution

Daemon memakai bounded worker pool dengan default `2` worker. Job dari project berbeda dapat menjalankan intake handoff, isolated worktree, coding agent, verification, automatic recovery, Graphify, dan retrospective secara bersamaan. Setiap worker memiliki manifest, event log, telemetry, notification, dan worktree sendiri, sehingga kegagalan satu job tidak membatalkan job lain.

Project-level reservation tetap serial. Ketika satu job sudah `RUNNING` atau menunggu keputusan dalam `REVIEW`, job berikutnya dari project yang sama tetap `QUEUED` sampai job pertama di-`accept` atau di-`reject`. Batas ini mencegah dua task membangun baseline terhadap repository project yang sama sebelum hasil sebelumnya diputuskan.

`daemon:status` menampilkan `maxWorkers`, worker aktif, slot tersedia, project aktif/reserved, job eligible, dan job yang tertahan oleh project reservation. Jumlah worker dapat diatur dari `1` sampai `8`:

```bash
# Simpan konfigurasi empat worker ke LaunchAgent dan restart daemon.
ORCHESTRATOR_MAX_PARALLEL_JOBS=4 npm run daemon:install

# Kembali ke mode serial jika dibutuhkan.
ORCHESTRATOR_MAX_PARALLEL_JOBS=1 npm run daemon:install
```

Menambah worker tidak membuat task dalam satu project berjalan paralel. Final `accept/reject` dan Wiki Sync tetap merupakan keputusan manusia per task.

`accept` adalah approval akhir: orchestrator lebih dulu memeriksa apakah file target di repository utama berubah sejak task dimulai. Jika aman, hanya diff task yang diterapkan, dependency/verification/Graphify dijalankan ulang di repository utama, lalu knowledge routing, Wiki Sync, completion, dan cleanup dijalankan. Jika terjadi konflik atau post-apply verification gagal, perubahan utama di-rollback dari backup dan task tidak menjadi `DONE`. `request-changes` mempertahankan run dan worktree untuk revisi berikutnya, sedangkan `reject` mengarsipkan audit diff lalu membuang worktree tanpa menerapkan perubahan. Semua command review menerima run ID atau task ID; `accept` dan `reject` juga dapat memilih run review terbaru tanpa selector.

`NEW` knowledge dengan confidence minimal `0.90`, verification lengkap, target valid, konten durable, dan tanpa near-duplicate dipromosikan otomatis ke Wiki; proposal yang belum memenuhi gate masuk Candidate. Duplicate title/target yang lolos gate diperlakukan sebagai `UPDATE`, sedangkan kemiripan fuzzy memerlukan review target. Gunakan `--decision`, `--destination`, atau `--target` hanya untuk mengoreksi routing.

Candidate memerlukan keputusan manual terpisah dan menghasilkan notification `ACTION_REQUIRED`. `knowledge-candidates` menampilkan antrean read-only, `knowledge-review` memeriksa provenance dan similarity, `promote-knowledge` membuat knowledge baru atau memperbarui target existing, dan `reject-knowledge` mengarsipkan candidate sebagai immutable source. Kedua keputusan mencatat approver, waktu, index update, dan audit di `wiki-log.md`.

`recover` adalah fallback manual setelah automatic recovery berstatus `EXHAUSTED`. Command ini melanjutkan run yang gagal pada tahap dependency, verification, atau Graphify tanpa menjalankan ulang coding agent. Jika `package.json` berubah, orchestrator merekonsiliasi dependency memakai package manager project dengan lifecycle script dinonaktifkan, lalu mengulang verification dan Graphify. Gunakan `--force` hanya untuk verification failure yang sudah diperbaiki di luar orchestrator.

`retry` mempertahankan failed run sebagai audit history, mengarsipkan dan membuang worktree lama, mengembalikan task ke `BACKLOG`, lalu membuat job replacement dan mengulang coding agent di worktree baru. Retry otomatis hanya diizinkan untuk infrastructure failure sebelum project berubah, seperti executable `ENOENT`. Failure yang mungkin terjadi setelah edit memerlukan review worktree dan flag `--force`.

`start-task` tetap tersedia untuk menjalankan task existing secara langsung dan sinkron:

```bash
npm run validate-task -- starter-app FE-014
npm run start-task -- starter-app FE-014 --by user
```

Command lifecycle lama tetap tersedia untuk audit, recovery, dan operasi lanjutan:

```bash
npm run projects
npm run context -- starter-app task-011
npm run plan -- starter-app task-011
npm run validate-task -- starter-app FE-BUG-TYPE-INPUT
npm run prepare -- starter-app task-013
npm run runs
npm run approve -- <run-id> --by user
npm run claim -- <run-id>
npm run execute -- <run-id>
npm run reject-review -- <run-id> --reason "acceptance criteria belum terpenuhi" --by user
npm run retrospect -- <run-id>
npm run approve-knowledge -- <run-id> --decision NEW --destination CANDIDATE --by user
npm run sync-wiki -- <run-id>
npm run complete -- <run-id> --by user
npm run watch:once
npm run watch
npm run daemon:install
npm run daemon:status
npm run daemon:stop
npm run daemon:start
npm test
```

Task dapat diberikan sebagai ID frontmatter seperti `FE-011`, nama file seperti `task-011`, atau path relatif terhadap Vault.

## Conversational Intake dan Background Queue

Task intake tersimpan di Wiki sebagai halaman canonical dan langsung memperbarui `index.md` serta `wiki-log.md`. Job execution tersimpan di `runs/jobs/`, sehingga antrean tetap ada ketika terminal ditutup. Worker pool daemon memproses beberapa project berbeda secara paralel dan menautkan setiap job ke run manifest saat execution dimulai; project yang sama tetap serial sampai keputusan review selesai.

Jika project page memiliki `verification_defaults`, intake memakai daftar tersebut sebagai baseline known-good dan tidak memilih semua package script secara otomatis.

Status user-facing merangkum file berubah, scope audit, automatic/manual recovery, verification, Graphify, error, dan proposal knowledge. `daemon:status` juga menampilkan kapasitas parallel worker, project reservation, total/unread notification, dan lima event terbaru:

```bash
npm run status
npm run status -- FE-015
npm run status -- --project starter-app
npm run review -- FE-015
```

## Task Readiness Gate

Sebelum task dipromosikan dari `BACKLOG` menjadi `READY`, jalankan:

```bash
npm run validate-task -- <project-id> <task-id-or-path>
```

Gate memeriksa kelengkapan frontmatter, placeholder template, instruksi, expected behavior, gejala bug, acceptance criteria, verification, dependency, repository, dan target file. Command ini read-only dan tidak mengubah status task.

Task `READY` yang masih memiliki blocker akan ditolak oleh watcher dan `prepare`. Pada flow sederhana, `start-task` menjalankan gate ini dan hanya mempromosikan task setelah report menghasilkan `verdict: PASS`; pemanggilan command oleh user menjadi approval execution yang tercatat.

## Run Manifest dan Approval

Task harus berstatus `READY` sebelum dapat disiapkan:

```bash
npm run prepare -- starter-app task-013
```

Command tersebut membuat manifest di `runs/` dengan state `PENDING_APPROVAL`. Manifest berisi fingerprint task, project, Graphify summary, knowledge retrieval, plan, dan audit history.

Lihat dan setujui run:

```bash
npm run runs
npm run approve -- <run-id> --by user
```

Approval mengubah state manifest menjadi `APPROVED`. Atomic claim kemudian dijalankan secara eksplisit:

```bash
npm run claim -- <run-id>
```

Claim akan memvalidasi ulang fingerprint, membuat lock eksklusif, dan mengubah task dari `READY` menjadi `IN_PROGRESS`.

Jalankan coding agent setelah run berstatus `CLAIMED`:

```bash
npm run execute -- <run-id>
```

Executor melakukan query Graphify terarah dan memasukkan hasilnya ke konteks `agy`, tanpa dangerous permission override. Coding agent hanya melakukan pembacaan dan edit file; terminal, dependency reconciliation, audit perubahan, verification, dan refresh Graphify dimiliki orchestrator. Perubahan lockfile otomatis diizinkan ketika `package.json` termasuk scope. Setiap hasil verification dan recovery disimpan langsung agar keberhasilan parsial tetap terlihat. Executor membandingkan snapshot repository sebelum/sesudah agent, menerapkan `allowed_paths`, serta dapat mewajibkan diff melalui `requires_changes: true`. Setelah verification berhasil—langsung atau melalui bounded automatic recovery—task dipindahkan ke `REVIEW`; failure yang tidak aman atau sudah menghabiskan recovery masuk `FAILED`.

## Antigravity Model Configuration

Default adapter `agy` dipin secara eksplisit untuk coding dan retrospective:

```text
model: gemini-3.7-flash-high
effort: high
```

Konfigurasi tersebut diteruskan sebagai `--model gemini-3.7-flash-high --effort high` dan dicatat pada run audit. Override sementara dapat diberikan tanpa mengubah source:

```bash
ORCHESTRATOR_AGY_MODEL=gemini-3.7-flash-medium \
ORCHESTRATOR_AGY_EFFORT=medium \
npm run execute -- <run-id>
```

Nilai `ORCHESTRATOR_AGY_EFFORT` yang valid adalah `low`, `medium`, atau `high`.

Jumlah maksimal AI repair automatic recovery dapat diatur antara `0` dan `3`; default `2`. Nilai `0` mematikan automatic recovery sepenuhnya:

```bash
ORCHESTRATOR_AUTO_RECOVERY_ATTEMPTS=1 npm run execute -- <run-id>
```

Jika hasil teknis lulus tetapi acceptance criteria belum terpenuhi, human review dapat menolak run:

```bash
npm run reject-review -- <run-id> --reason "alasan penolakan" --by user
```

Jika hasil masih ingin dilanjutkan, mintalah revisi alih-alih menolak:

```bash
npm run preview -- FE-019
# Di terminal VS Code yang terbuka:
npm run dev

npm run request-changes -- FE-019 --reason "Perbaiki tampilan mobile dan jarak antar-card" --by user
```

## Retrospective dan Wiki Sync

Pada flow sederhana, tahap ini diringkas menjadi satu approval akhir:

```bash
npm run accept -- FE-015 --by user
```

Routing default `NEW` menggunakan gate confidence dan validitas. Threshold dapat diubah dengan `ORCHESTRATOR_KNOWLEDGE_AUTO_PROMOTE_CONFIDENCE` antara `0` dan `1`; default `0.90`.

Untuk mengoreksi proposal retrospective:

```bash
npm run accept -- FE-015 --decision PROJECT_ONLY --destination PROJECT --by user
```

Command lanjutan berikut tetap dapat digunakan secara terpisah untuk recovery atau kontrol granular:

```bash
npm run retrospect -- <run-id>
npm run approve-knowledge -- <run-id> --decision NEW --destination CANDIDATE --by user
npm run sync-wiki -- <run-id>
npm run complete -- <run-id> --by user
```

Destination yang tersedia:

- `WIKI`: create/update knowledge di `01-Knowledge/`.
- `CANDIDATE`: simpan temuan baru di `05-Knowledge-Candidates/`.
- `PROJECT`: catat sebagai project-specific pada task.
- `NONE`: tidak membuat knowledge page.

Kelola Candidate tanpa membuka Vault secara manual:

```bash
npm run knowledge-candidates
npm run promote-knowledge -- zustand-feature-state-management --by user
npm run promote-knowledge -- candidate-id --target 01-Knowledge/concepts/topic.md --by user
npm run reject-knowledge -- candidate-id --reason "tidak reusable" --by user
```

Promosi membuat atau memperbarui halaman berdasarkan title duplicate, menghapus candidate hanya setelah sinkronisasi berhasil, dan membuat immutable decision artifact di `03-Sources/other/knowledge-decisions/`. Penolakan mengarsipkan isi candidate di `03-Sources/other/rejected-knowledge-candidates/` sebelum menghapusnya dari antrean.

Wiki sync membuat immutable run source di `03-Sources/other/orchestrator-runs/`, memperbarui `index.md` jika membuat halaman, dan menambahkan catatan ke `wiki-log.md`. Baik `accept` maupun command granular `complete` hanya menutup task setelah state `WIKI_SYNCED`, lalu mengubah task menjadi `DONE` dan memasang watermark wajib.

## Cakupan Saat Ini

Orchestrator saat ini menyediakan transactional onboarding dan safe project removal/archive untuk existing/new project, Vite + Shadcn `add --all` scaffold dari blueprint Wiki, automatic Graphify bootstrap, conversational task intake, task generation, persistent background jobs, bounded cross-project parallel execution, project-level reservation, project discovery, task readiness, context retrieval, planning, approval, atomic claim, isolated Git worktree execution, VS Code review preview, iterative request changes tanpa hard limit, conflict-safe final apply/rollback, token-free deterministic retry, bounded AI repair, manual recovery fallback, dependency reconciliation, Graphify refresh, persistent deduplicated notification inbox, macOS desktop delivery, per-stage token telemetry dan warning, user-facing review tanpa run ID, confidence/similarity-based knowledge routing, Vault health report, safe auto-index, guarded Candidate promotion/rejection, Wiki sync, dan human completion.

## Vault Task Watcher

Perintah `npm run watch` memantau task di `02-Projects/**/tasks/`. Ketika task berstatus `READY`, orchestrator menerbitkan event `TASK_READY` yang berisi project, Graphify summary, knowledge retrieval, dan execution plan.

Command `watch` tetap `observe-only` untuk debugging. Ia tidak mengubah status task dan tidak menjalankan coding agent. Watcher lama sudah dipensiunkan; seluruh ownership eksekusi berikutnya berada pada orchestrator.

Gunakan scan sekali untuk validasi tanpa daemon:

```bash
npm run watch:once
```

Hanya orchestrator yang boleh memiliki transisi `READY → IN_PROGRESS`.

## Managed Watcher Daemon

Pada macOS, instal watcher sebagai LaunchAgent user:

```bash
npm run daemon:install
npm run daemon:status
```

Daemon memiliki dua jalur yang berbeda. Untuk task yang diedit manual menjadi `READY`, watcher hanya melakukan:

```text
TASK_READY → manifest PENDING_APPROVAL
```

Watcher manual tidak melakukan approval, claim, execute, retrospective, atau completion. Untuk job yang dibuat melalui `request-task --start`, instruksi user sudah menjadi execution approval; daemon memproses persistent job secara asynchronous melalui bounded cross-project worker pool sampai hasil dan retrospective siap direview. Daemon tidak pernah menjalankan final `accept` atau completion tanpa keputusan user.

State deduplikasi disimpan pada run manifest, bukan hanya memory watcher. Event dengan fingerprint yang sama menggunakan manifest aktif yang sudah ada. Jika task berubah sebelum approval, manifest `PENDING_APPROVAL` atau `APPROVED` lama menjadi `SUPERSEDED` dan manifest baru dibuat. Setelah daemon atau komputer restart, initial scan merekonsiliasi task `READY` dengan manifest yang tersimpan.

Command operasional:

```bash
npm run daemon:status
npm run daemon:stop
npm run daemon:start
npm run daemon:uninstall
```

Health, PID, dan structured event log tersedia di `runs/daemon/`. Output proses LaunchAgent tersedia di `~/Library/Logs/PersonalAIOrchestrator/daemon-output.log`. `daemon:install` memasang `~/Library/LaunchAgents/com.sagaino.personal-ai-orchestrator.plist` dengan `RunAtLoad` dan `KeepAlive`.
Environment LaunchAgent menyertakan `~/.local/bin`, Homebrew, dan standard system paths agar adapter `agy`, `graphify`, Node, dan npm tersedia pada background execution. Override `ORCHESTRATOR_MAX_PARALLEL_JOBS` ikut dipertahankan ketika service di-install.

Pipeline end-to-end sudah divalidasi pada `starter-app` dan `gallery-fmfu`, termasuk recovery, scope audit, Graphify preflight, human review rejection, retrospective, Wiki sync, dan automatic approval-queue handoff. Regression test memastikan notification terdeduplikasi, telemetry tercatat per stage, safe-fix tidak menyentuh isi knowledge, near-duplicate tidak dipromosikan tanpa target existing, dua project dapat berjalan bersamaan, project yang sama tetap serial, dan failure satu worker terisolasi. Seluruh rangkaian improvement yang direncanakan—dengan Conversational Gateway ditunda—sudah selesai; final human approval tetap tidak berubah.
