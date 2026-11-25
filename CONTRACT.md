# TrackerUI ↔ LedgerUI Shared Data Contract (`v1`)

This document is the canonical, versioned interface contract shared between:
- **TrackerUI** — Personal/agent daily workbook client (`.xlsx` authoring, daily rollover, scratch sheets, JSON mirror publishing, `_State/` wipe recovery, and `_SharedQueue/` participation).
- **LedgerUI** — Standalone local-first **team ledger & shared-queue appliance** (IndexedDB NoSQL cache + JSON store aggregator, shared queue coordinator, ledger overlays/annotations, cross-team query/reporting, and `.csv` / `.xlsx` exports).

Both repositories must stay compatible with this contract without needing to import or read each other's source code.

---

## 1. Core Architectural Principles

1. **Zero-Lock File-Per-Writer Layout**: No two clients ever write to the same `.json` file concurrently. Every writable path is partitioned by `agentUuid`, `actorUuid`, or `<trackingUuid>__<agentUuid>` to avoid OneDrive/SharePoint sync conflicts and Desktop Excel locks.
2. **Explicit Ledger Binding (`ledgerId`)**: Neither app relies solely on folder paths to know which workbook belongs to which ledger. Every Team Root ledger has an immutable `ledgerId` (UUIDv4) stamped into `_Config/ledger-manifest.json`, TrackerUI profile configs, each workbook's hidden `TrackerConfig` sheet, and every emitted JSON mirror. LedgerUI **must** verify `payload.ledgerId === activeLedgerId` before ingesting.
3. **Immutable Row Identity (`trackingUuid`)**: Every request is keyed globally by its lowercase 36-character UUIDv4 (`trackingUuid`, stored in TrackerUI's hidden Column K / `trackingCol`).
4. **Strict Ownership Boundaries**: Each folder has a single clear write owner. LedgerUI never mutates agent `.xlsx` files or agent JSON mirrors.
5. **Local-First IndexedDB + JSON Store**: The shared OneDrive/SharePoint directory is the durable JSON document store; LedgerUI maintains an `IndexedDB` database as its fast queryable/indexable local cache, incrementally syncing changed files via `lastModified` / `size` / `contentHash`.

---

## 2. Canonical Team Root Directory Tree & Ownership

```text
<TeamRoot>/
├── _Config/
│   ├── ledger-manifest.json                 # Ledger identity (ledgerId, ledgerName, schema)
│   └── trackerui-config.json                # Team-level TrackerUI defaults & folder descriptors
├── _Templates/                              # Shared .xlsx templates for new monthly workbooks
├── _ViewOnly_JSON/
│   └── mirror_<agentUuid>__<workbookSlug>.json   # Per-agent, per-workbook lock-free JSON mirrors
├── _SharedQueue/
│   ├── items/
│   │   └── <trackingUuid>.json              # Shared unassigned/queued ticket records
│   └── claims/
│       └── <trackingUuid>__<agentUuid>.json # Per-agent claim receipts (conflict-free)
├── _Ledger/
│   └── overlays_<actorUuid>.json            # Ledger-level annotations, tags & audit flags
├── _Inbox/                                  # [RESERVED — PARKED FOR FUTURE BIDIRECTIONAL SYNC]
│   └── <agentUuid>/
└── Agents/
    └── <SafeAgentName>/
        ├── <Monthly Workbook>.xlsx          # Agent working Excel file (TrackerUI primary)
        ├── <Monthly Workbook> (VIEW ONLY).xlsx   # Optional legacy Excel mirror (migration toggle)
        ├── _Backups/                        # Rolling daily / pre-version / pre-action .xlsx backups
        └── _State/
            └── state_<agentUuid>.json       # Full IndexedDB metadata + localStorage wipe-recovery snapshot
```

### Ownership Matrix

| Path | Schema ID | Write Owner | Readers |
|---|---|---|---|
| `_Config/ledger-manifest.json` | `trackerui.ledger.v1` | Team Root Setup / LedgerUI | TrackerUI, LedgerUI |
| `_ViewOnly_JSON/mirror_<agentUuid>__<workbookSlug>.json` | `trackerui.mirror.v1` | **TrackerUI** | **LedgerUI** |
| `_SharedQueue/items/<trackingUuid>.json` | `trackerui.queue.item.v1` | **TrackerUI & LedgerUI** | **TrackerUI & LedgerUI** |
| `_SharedQueue/claims/<trackingUuid>__<agentUuid>.json` | `trackerui.queue.claim.v1` | **TrackerUI** | **TrackerUI & LedgerUI** |
| `_Ledger/overlays_<actorUuid>.json` | `ledgerui.overlay.v1` | **LedgerUI** | **LedgerUI** |
| `Agents/<AgentName>/_State/state_<agentUuid>.json` | `trackerui.state.v1` | **TrackerUI** | **TrackerUI** |
| `_Inbox/<agentUuid>/` *(Reserved)* | `ledgerui.directive.v1` | *Parked (Future)* | *Parked (Future)* |

---

## 3. JSON Payload Schemas

### 3.1 Ledger Manifest (`_Config/ledger-manifest.json`) — `trackerui.ledger.v1`
Establishes the immutable identity of the team ledger so TrackerUI profiles and LedgerUI instances bind explicitly by `ledgerId`.

```json
{
  "schemaVersion": "trackerui.ledger.v1",
  "ledgerId": "550e8400-e29b-41d4-a716-446655440000",
  "ledgerName": "Bidder Support Team Ledger",
  "createdAt": "2026-11-25T10:00:00.000Z",
  "updatedAt": "2026-11-25T10:00:00.000Z",
  "createdBy": {
    "actorUuid": "11111111-2222-4333-8444-555555555555",
    "actorName": "Jane Doe"
  },
  "paths": {
    "mirrorsDir": "_ViewOnly_JSON",
    "sharedQueueDir": "_SharedQueue",
    "ledgerDir": "_Ledger",
    "templatesDir": "_Templates",
    "agentsDir": "Agents"
  }
}
```

---

### 3.2 Agent View-Only Mirror (`_ViewOnly_JSON/mirror_<agentUuid>__<workbookSlug>.json`) — `trackerui.mirror.v1`
Written by TrackerUI on every workbook save whenever the active profile is bound to a `ledgerId`.
- **`<workbookSlug>`**: Deterministic URL/filename-safe slug derived from the workbook filename without `.xlsx` (lowercase alphanumeric + hyphens, max 64 chars) so multiple monthly workbooks and department profiles coexist without overwriting each other.
- **Hybrid Payload**: Contains pre-normalized, deduplicated `records[]` (latest state + aggregated chronological notes + overdue metrics) **plus** a compact per-record `timeline[]` so LedgerUI can ingest directly into IndexedDB without duplicating TrackerUI's rollover/dedup logic while preserving full day-by-day history.

```json
{
  "schemaVersion": "trackerui.mirror.v1",
  "ledgerId": "550e8400-e29b-41d4-a716-446655440000",
  "ledgerName": "Bidder Support Team Ledger",
  "exportedAt": "2026-11-25T15:30:00.000Z",
  "appVersion": "v1.21.0",
  "agent": {
    "agentUuid": "11111111-2222-4333-8444-555555555555",
    "agentName": "Jane Doe",
    "role": "Agent"
  },
  "workbook": {
    "workbookSlug": "agent-bidder-support-tracker-november-2026",
    "fileName": "Agent Bidder Support Tracker - November 2026.xlsx",
    "profileId": "default",
    "profileName": "Daily Tracker",
    "schemaMode": "standard",
    "sheetCount": 18,
    "latestSheetName": "11-25-2026",
    "columns": [
      { "col": 1, "header": "Subject", "label": "Subject", "role": "primary" }
    ]
  },
  "records": [
    {
      "trackingUuid": "8f4a92c1-3d12-4b9a-9c7e-1a2b3c4d5e6f",
      "parentTrackingUuid": null,
      "subject": "[2026-11-0412] Title release request",
      "ticketNumber": "2026-11-0412",
      "masterTicketNumber": "",
      "subTicketNumbers": [],
      "brokerName": "Acme Auto Brokers",
      "masterNumber": "M12345",
      "bidderNumber": "B67890",
      "requestedAction": "Title Release",
      "actionCategory": "Titles",
      "yardNumber": "340",
      "lotNumbers": "12345678, 87654321",
      "notes": "[11-24-2026] Requested docs\n[11-25-2026] Sent to yard",
      "status": "In Progress",
      "customValues": {},
      "firstSeenDate": "11-24-2026",
      "lastSeenDate": "11-25-2026",
      "latestSheetName": "11-25-2026",
      "latestRowNumber": 14,
      "carryCount": 2,
      "isOverdue": false,
      "overdueReason": "",
      "lastAccessedAt": "2026-11-25T15:25:00.000Z",
      "timeline": [
        {
          "date": "11-24-2026",
          "sheetName": "11-24-2026",
          "rowNumber": 9,
          "status": "New",
          "notes": "Requested docs"
        },
        {
          "date": "11-25-2026",
          "sheetName": "11-25-2026",
          "rowNumber": 14,
          "status": "In Progress",
          "notes": "Sent to yard"
        }
      ]
    }
  ]
}
```

---

### 3.3 Shared Request Queue Item (`_SharedQueue/items/<trackingUuid>.json`) — `trackerui.queue.item.v1`
Written by either **LedgerUI** or **TrackerUI** to publish an unassigned request into the team queue.

```json
{
  "schemaVersion": "trackerui.queue.item.v1",
  "ledgerId": "550e8400-e29b-41d4-a716-446655440000",
  "trackingUuid": "9a8b7c6d-5e4f-4321-8765-abcdef012345",
  "createdAt": "2026-11-25T14:00:00.000Z",
  "createdBy": {
    "actorUuid": "22222222-3333-4444-8555-666666666666",
    "actorName": "Alex Rivera",
    "sourceApp": "LedgerUI"
  },
  "priority": "Normal",
  "queueStatus": "Open",
  "payload": {
    "parentTrackingUuid": null,
    "subject": "[2026-11-0999] Expedite release",
    "ticketNumber": "2026-11-0999",
    "masterTicketNumber": "",
    "subTicketNumbers": [],
    "brokerName": "Metro Motors",
    "masterNumber": "M54321",
    "bidderNumber": "B11223",
    "requestedAction": "Title Release",
    "yardNumber": "112",
    "lotNumbers": "44556677",
    "notes": "Escalated from buyer inbox.",
    "status": "New",
    "customValues": {}
  }
}
```

---

### 3.4 Shared Request Queue Claim (`_SharedQueue/claims/<trackingUuid>__<agentUuid>.json`) — `trackerui.queue.claim.v1`
Written by **TrackerUI** when an agent claims a queued item and imports it into their active daily tab.
- **Deterministic Conflict Resolution**: If two agents claim the same `trackingUuid` inside the same OneDrive sync window, both TrackerUI and LedgerUI resolve the winner deterministically by:
  1. Active claims (`claimState === "claimed"`) only (ignoring `"released"` claims).
  2. Earliest ISO-8601 `claimedAt` timestamp.
  3. Lexicographically smallest `agentUuid` tiebreaker.
- If an agent loses a race on the next sync check, TrackerUI surfaces a clear notice so they can remove/reconcile the duplicate row.

```json
{
  "schemaVersion": "trackerui.queue.claim.v1",
  "ledgerId": "550e8400-e29b-41d4-a716-446655440000",
  "trackingUuid": "9a8b7c6d-5e4f-4321-8765-abcdef012345",
  "agentUuid": "11111111-2222-4333-8444-555555555555",
  "agentName": "Jane Doe",
  "claimedAt": "2026-11-25T14:05:12.340Z",
  "claimState": "claimed",
  "targetWorkbook": "Agent Bidder Support Tracker - November 2026.xlsx",
  "targetSheet": "11-25-2026"
}
```

---

### 3.5 Ledger Overlays (`_Ledger/overlays_<actorUuid>.json`) — `ledgerui.overlay.v1`
Written by **LedgerUI** to store ledger-level annotations, tags, and audit flags keyed by `trackingUuid` without touching agent workbooks or agent mirrors.

```json
{
  "schemaVersion": "ledgerui.overlay.v1",
  "ledgerId": "550e8400-e29b-41d4-a716-446655440000",
  "actorUuid": "22222222-3333-4444-8555-666666666666",
  "actorName": "Alex Rivera",
  "updatedAt": "2026-11-25T16:00:00.000Z",
  "overlays": {
    "8f4a92c1-3d12-4b9a-9c7e-1a2b3c4d5e6f": {
      "tags": ["Audit-OK", "Priority"],
      "flagged": false,
      "ledgerNote": "Verified with yard manager.",
      "updatedAt": "2026-11-25T16:00:00.000Z"
    }
  }
}
```

---

### 3.6 Agent Private State Snapshot (`Agents/<AgentName>/_State/state_<agentUuid>.json`) — `trackerui.state.v1`
Written by **TrackerUI** (auto-snapshotted on config/save changes + manual backup/restore) for complete Chrome-wipe recovery of `localStorage` and `IndexedDB` metadata.
- **Automated Wipe-Recovery Check**: Whenever an agent connects an Agent Folder or Team Root Folder in a fresh/cleared browser (no saved local `agentName` or profiles), TrackerUI automatically checks `<AgentFolder>/_State/` for the newest `state_*.json` file and prompts the user in plain English (no technical jargon) to restore their settings in one click while keeping their Excel workbooks and newly connected folder handle intact.

```json
{
  "schemaVersion": "trackerui.state.v1",
  "ledgerId": "550e8400-e29b-41d4-a716-446655440000",
  "exportedAt": "2026-11-25T15:30:00.000Z",
  "appVersion": "v1.21.0",
  "agentIdentity": {
    "agentUuid": "11111111-2222-4333-8444-555555555555",
    "agentName": "Jane Doe",
    "role": "Agent",
    "defaultView": "daily"
  },
  "localStorageSnapshot": {},
  "directoryDescriptors": {
    "teamRootName": "BidderSupportTeam",
    "agentDirName": "Jane Doe",
    "lastActiveWorkbookName": "Agent Bidder Support Tracker - November 2026.xlsx"
  }
}
```

---

## 4. Export Interoperability Standards

- **CSV (`.csv`)**: UTF-8 with BOM (`\uFEFF` for clean Desktop Excel opening), RFC-4180 quoting/escaping, supporting both **Current Filtered View** and **Full Ledger** scopes.
- **Excel (`.xlsx`)**: Generated via ExcelJS in **LedgerUI** with styled multi-tab output (`Master Ledger`, `KPI & Category Summary`, `Agent Breakdown`) and an optional metadata toggle (`trackingUuid`, `agentName`, `carryCount`, ledger overlays).

---

## 5. Contract Change Log

| Version | Date | Summary |
|---|---|---|
| `v1.0` | `2026-11-25` | Initial contract: `ledgerId` explicit binding (`trackerui.ledger.v1`), per-agent/workbook JSON mirrors (`trackerui.mirror.v1`), conflict-free `_SharedQueue/` items & claims (`trackerui.queue.item.v1` / `trackerui.queue.claim.v1`), ledger overlays (`ledgerui.overlay.v1`), Chrome-wipe `_State/` snapshots (`trackerui.state.v1`), reserved `_Inbox/` namespace, and CSV/XLSX export standards. |
