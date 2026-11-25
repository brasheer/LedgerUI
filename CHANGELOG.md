# LedgerUI — Changelog & Release History

## Version Release History

### `v1.1.3`
- **🧹 Blank Template Formula Row Fix (`js/xlsx-parser.js`, `js/sync-engine.js`)**:
  - Fixed `extractCellText()` so ExcelJS `formula` / `sharedFormula` cells without a cached `result` (and legacy `"[object Object]"` placeholder strings on blank template rows) resolve to `""` instead of `"[object Object]"`.
  - Prevents blank `.xlsx` template rows from being ingested as phantom `(No Subject)` / `[object Object]` entries and bumps `PARSER_VERSION` to `4` so IndexedDB automatically clears and re-parses cached `.xlsx` workbooks on next sync.

### `v1.1.2`
- **👤 Agent Column First & UUID-Deduplicated Active Totals (`index.html`, `js/app.js`, `sw.js`)**:
  - Moved the **Agent** column to the far left of the Team Ledger table so request ownership is immediately visible.
  - Added `deduplicateRecordsByUuid()` in `reloadFromIndexedDB()` so each unique `trackingUuid` is counted once using its latest chronological state (preventing an open entry from an earlier date/workbook from inflating **Open / Active**, **Overdue**, or **Waiting / Hold** totals once the request is closed at a later date).

### `v1.1.1`
- **🩹 Swapped Status/Notes Mirror Repair & TrackerUI Header Normalization (`js/sync-engine.js`, `js/xlsx-parser.js`, `css/styles.css`)**:
  - Automatically detects and repairs `mirror_*.json` payloads where TrackerUI exported `Action Taken/Notes` into `status` and `Status` into `notes` (updating `status`, `notes`, `timeline[]`, and `isOverdue`), and bumps `PARSER_VERSION` to `3` so IndexedDB re-ingests cached records cleanly.
  - Expanded `.xlsx` header matching for standard TrackerUI 12-column and Dept 2 custom workbooks (`Email/Call Subject`, `Broker Master#`, `Broker Bidder#`, `Action Taken/Notes`), added `inferActionCategory()`, skipped auxiliary sheets (`Master Accounts`, `Validation List`) when date tabs exist, and prevented duplicate `[date]` prefixes on timestamped notes.
  - Scoped `#ledgerTableBody .badge` truncation (`max-width: 180px`) with full-text `title` tooltips on status pills.

### `v1.1.0`
- **📂 Multi-Folder Aggregation (`Trackers/`, `Agents/`, `View Only/`) & `.xlsx` Workbook Fallback (`js/xlsx-parser.js`, `js/sync-engine.js`)**:
  - Added client-side ExcelJS `.xlsx` workbook parser (`window.LedgerXlsxParser`) that reads `TrackerConfig`, detects headers and hidden Column K `trackingUuid` values, and aggregates daily rollover sheets into chronological `timeline[]` records.
  - Upgraded `sync-engine.js` to auto-detect Team Root (`Trackers/`), `Agents/`, `View Only/` / `_ViewOnly_JSON/`, and direct folders without creating stray `_Config/`, `_Ledger/`, or `_SharedQueue/` folders inside subfolders.
  - Added two-phase ingestion prioritizing `_ViewOnly_JSON/mirror_*.json`, deduplicating primary `.xlsx` vs `(VIEW ONLY).xlsx` copies per agent+workbook, and falling back to `(VIEW ONLY).xlsx` when a live `.xlsx` is locked.
  - Added automatic `ledgerId` adoption from existing mirrors on first Team Root setup, plus actionable empty-state diagnostics and a 1-click **Adopt Existing Ledger ID** action when mismatches occur (`js/app.js`, `sw.js`, `index.html`).

### `v1.0.0` (Initial Release)
- **📦 Zero-Build PWA Shell & Shared Data Contract (`index.html`, `css/styles.css`, `manifest.json`, `sw.js`, `CONTRACT.md`)**:
  - Established standalone modular Vanilla HTML/CSS/JS PWA architecture synced with **TrackerUI** via [`CONTRACT.md`](CONTRACT.md) (`v1.0`).
  - Added **Appearance & Display** controls (Light/Auto/Dark + Text Size `85%`–`125%`) at the top of the **⚙️ Setup ▾** menu.
- **🗄️ IndexedDB NoSQL Store & Incremental JSON Mirror Ingestion (`js/db.js`, `js/sync-engine.js`)**:
  - Created `LedgerUI_NoSQL_v1` IndexedDB database with `handles`, `syncMeta`, `records`, `overlays`, and `queueItems` stores and secondary indexes (`trackingUuid`, `ledgerId`, `agentUuid`, `status`, `actionCategory`).
  - Reads/initializes `_Config/ledger-manifest.json` (`ledgerId` validation), incrementally ingests `_ViewOnly_JSON/mirror_*.json` (`trackerui.mirror.v1`), prunes deleted mirrors, and supports configurable Auto-Refresh (`Off`, `1m`, `3m`, `5m`) + 1-click **Rebuild IndexedDB Cache**.
- **📊 Team Ledger, Removable-Tag Overlays & Shared Request Queue (`js/app.js`)**:
  - Built KPI cards, clickable Action Category pills, Agent/Workbook/Status/Tag/Flagged/Hide-Completed filters, sortable columns, and full chronological `timeline[]` inspection modal.
  - Added actor-owned `_Ledger/overlays_<actorUuid>.json` (`ledgerui.overlay.v1`) supporting follow-up flags, ledger notes, and 100% removable/editable tags.
  - Built **📥 Shared Request Queue** view to post new unassigned items (`_SharedQueue/items/<trackingUuid>.json`) and track deterministic agent claims (`_SharedQueue/claims/<trackingUuid>__<agentUuid>.json`).
- **📤 CSV & Multi-Tab XLSX Exports (`js/exporter.js`)**:
  - Added **Filtered** and **Full Ledger** export options for UTF-8 BOM `.csv` and styled 3-sheet `.xlsx` (`Master Ledger`, `KPI & Category Summary`, `Agent Breakdown`), with an `Include Metadata & Overlays` toggle.
