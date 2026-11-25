# LedgerUI — Changelog & Release History

## Version Release History

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
