# LedgerUI — Team Ledger & Shared-Queue Appliance

**LedgerUI** is a zero-build, local-first Progressive Web App (PWA) designed as a standalone **team ledger and shared-queue appliance** paired with **TrackerUI** via [`CONTRACT.md`](CONTRACT.md).

## Architecture Highlights
- **Multi-Folder Aggregation & `.xlsx` Fallback**: Works whether you connect the top-level Team Root (`Trackers/`), `Agents/`, or a `View Only/` / `_ViewOnly_JSON/` folder directly. Ingests `_ViewOnly_JSON/mirror_*.json` first and automatically falls back to parsing agent `.xlsx` and `(VIEW ONLY).xlsx` workbooks client-side via ExcelJS (with automatic deduplication and rollover aggregation across daily sheets).
- **IndexedDB NoSQL Store + JSON Store**: Uses the shared OneDrive/SharePoint Team Root folder (`_Config/`, `_ViewOnly_JSON/`, `_SharedQueue/`, `_Ledger/`) as the durable lock-free JSON store and caches normalized records in `IndexedDB` (`LedgerUI_NoSQL_v1`) for instant cross-team filtering, sorting, and reporting.
- **Explicit `ledgerId` Binding**: Validates `_Config/ledger-manifest.json` (`trackerui.ledger.v1`) and automatically adopts existing mirror `ledgerId` values when initializing a manifest so mirrors from foreign ledgers are never mixed accidentally.
- **Incremental Sync**: Tracks `file.lastModified`, `file.size`, and `parserVersion` per mirror and workbook source so unchanged files skip re-parsing.
- **Shared Request Queue (`_SharedQueue/`)**: Publish unassigned tickets (`_SharedQueue/items/<trackingUuid>.json`) and monitor deterministic agent claims (`_SharedQueue/claims/<trackingUuid>__<agentUuid>.json`).
- **Removable & Editable Ledger Overlays (`_Ledger/`)**: Flag requests, add/delete lightweight tags freely (zero tag-lock), and record ledger notes in `_Ledger/overlays_<actorUuid>.json` without ever touching agent workbooks or agent mirrors.
- **CSV & Styled Multi-Tab XLSX Exports**: Export either the **Current Filtered View** or **Full Ledger** to RFC-4180 UTF-8 BOM `.csv` or multi-tab `.xlsx` (`Master Ledger`, `KPI & Category Summary`, `Agent Breakdown`) with an optional metadata/overlays toggle.

## Quick Start
1. Serve this folder directly with VS Code Live Server (`localhost`) or host via GitHub Pages (`https://`).
2. Click **📂 Connect Team Root** and select your shared Team Root folder (e.g., `Trackers/`), or select `Agents/` or `View Only/` directly for read-only aggregation.
3. Enter your **Actor Name** when prompted (stored locally alongside your immutable `actorUuid`).
4. Use **Team Ledger** to query/tag/export across all synced agents, or switch to **Shared Request Queue** to post and monitor team tickets.
