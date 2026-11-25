// ============================================================================
// sync-engine.js — Multi-Folder JSON & .xlsx Ingestion, _SharedQueue & _Ledger I/O
// ============================================================================
(() => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const PARSER_VERSION = 3;

  const KNOWN_STATUS_RE = /^(new|pending|in\s*progress|waiting(?:\s+on\s+[a-z0-9\s/_-]+)?|on\s*hold|overdue|escalated|complete|completed|closed|done|resolved|open|active|cancelled|canceled)$/i;
  const DATE_PREFIX_STRIP_RE = /^\[\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?\]\s*/i;
  const TIMESTAMPED_PROSE_RE = /^\[\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\s+\d{1,2}:\d{2}/i;

  const SKIP_DIR_RE = /^(_backups|backups|_state|_config|_ledger|_sharedqueue|_templates|templates|_inbox|_archive|archive|node_modules|\..+)$/i;
  const VIEW_ONLY_DIR_RE = /^_?view[\s_-]*only(?:[\s_-]*json)?$/i;
  const AGENTS_DIR_RE = /^agents?$/i;
  const SYSTEM_JSON_RE = /^(ledger-manifest|trackerui-config|state_.*|overlays_.*)\.json$/i;
  const TEAM_ROOT_MARKER_DIRS = new Set(['_config', '_viewonly_json', '_sharedqueue', '_ledger', 'agents']);

  function generateUuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().toLowerCase();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function slugifyFallback(str, maxLen = 64) {
    return String(str || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLen)
      .replace(/-+$/g, '');
  }

  function stableHashFallback(input) {
    const str = String(input || '');
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 ^= ch;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= ch + (i & 0xff);
      h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return `rec-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
  }

  function normalizeAgentSlug(name) {
    if (window.LedgerXlsxParser && typeof window.LedgerXlsxParser.normalizeAgentSlug === 'function') {
      return window.LedgerXlsxParser.normalizeAgentSlug(name);
    }
    return slugifyFallback(name, 48) || 'unnamed-agent';
  }

  function normalizeWorkbookSlug(nameOrSlug) {
    if (window.LedgerXlsxParser && typeof window.LedgerXlsxParser.normalizeWorkbookSlug === 'function') {
      return window.LedgerXlsxParser.normalizeWorkbookSlug(nameOrSlug);
    }
    return slugifyFallback(String(nameOrSlug || '').replace(/\.xlsx?$/i, ''), 64) || 'workbook';
  }

  function stripAgentPrefixFromSlug(workbookSlug, agentSlug) {
    if (window.LedgerXlsxParser && typeof window.LedgerXlsxParser.stripAgentPrefixFromSlug === 'function') {
      return window.LedgerXlsxParser.stripAgentPrefixFromSlug(workbookSlug, agentSlug);
    }
    const wb = String(workbookSlug || '');
    const ag = String(agentSlug || '');
    if (!ag || ag === 'unnamed-agent') return wb;
    if (wb === ag) return 'workbook';
    if (wb.startsWith(`${ag}-`)) return wb.slice(ag.length + 1) || 'workbook';
    return wb;
  }

  function makeDedupKey(agentName, workbookSlugOrFileName) {
    const agentSlug = normalizeAgentSlug(agentName);
    const wbSlug = normalizeWorkbookSlug(workbookSlugOrFileName);
    return {
      agentSlug,
      workbookSlug: wbSlug,
      dedupKey: `${agentSlug}::${stripAgentPrefixFromSlug(wbSlug, agentSlug)}`
    };
  }

  async function ensureSubDir(parentHandle, name, create = false) {
    try {
      return await parentHandle.getDirectoryHandle(name, { create });
    } catch (_) {
      return null;
    }
  }

  async function detectConnectionMode(rootHandle) {
    const rootName = String(rootHandle && rootHandle.name ? rootHandle.name : '').trim();
    if (VIEW_ONLY_DIR_RE.test(rootName)) {
      return 'view-only-folder';
    }

    let hasAgentsSubdir = false;
    let hasTeamRootMarker = false;
    let hasDirectWorkbookOrMirror = false;

    try {
      for await (const entry of rootHandle.values()) {
        if (entry.kind === 'directory') {
          const lower = entry.name.toLowerCase();
          if (AGENTS_DIR_RE.test(entry.name)) hasAgentsSubdir = true;
          if (TEAM_ROOT_MARKER_DIRS.has(lower) || VIEW_ONLY_DIR_RE.test(entry.name)) {
            hasTeamRootMarker = true;
          }
        } else if (entry.kind === 'file') {
          if (
            (/\.xlsx$/i.test(entry.name) && !/^~\$/.test(entry.name) && !/^\./.test(entry.name)) ||
            /^mirror_.*\.json$/i.test(entry.name)
          ) {
            hasDirectWorkbookOrMirror = true;
          }
        }
      }
    } catch (_) { /* fallback safely */ }

    if (AGENTS_DIR_RE.test(rootName) && !hasAgentsSubdir) {
      return 'agents-folder';
    }
    if (hasTeamRootMarker || !hasDirectWorkbookOrMirror) {
      return 'team-root';
    }
    return 'direct-folder';
  }

  async function discoverSources(rootHandle, connectionMode, maxDepth = 4) {
    const jsonMirrors = [];
    const xlsxFiles = [];

    async function walk(dirHandle, pathSegments, depth) {
      if (depth > maxDepth) return;
      const inViewOnlyDir =
        connectionMode === 'view-only-folder' ||
        pathSegments.some((seg) => VIEW_ONLY_DIR_RE.test(seg));

      let entries;
      try {
        entries = [];
        for await (const entry of dirHandle.values()) {
          entries.push(entry);
        }
      } catch (_) {
        return;
      }

      for (const entry of entries) {
        const name = entry.name || '';
        if (entry.kind === 'directory') {
          if (SKIP_DIR_RE.test(name)) continue;
          await walk(entry, [...pathSegments, name], depth + 1);
        } else if (entry.kind === 'file') {
          const sourcePath = [...pathSegments, name].join('/');

          if (/\.json$/i.test(name) && !SYSTEM_JSON_RE.test(name)) {
            if (/^mirror_.*\.json$/i.test(name) || inViewOnlyDir) {
              jsonMirrors.push({
                entry,
                fileName: name,
                sourcePath,
                pathSegments: [...pathSegments]
              });
            }
          } else if (
            /\.xlsx$/i.test(name) &&
            !/^~\$/.test(name) &&
            !/^\./.test(name) &&
            !/^LedgerUI_.*\.xlsx$/i.test(name)
          ) {
            const isViewOnlyCopy =
              inViewOnlyDir ||
              (window.LedgerXlsxParser && window.LedgerXlsxParser.isViewOnlyFileName(name)) ||
              /(\(|\[|\b|[-_])view[\s_-]*only(\)|\]|\b|[-_])/i.test(name);

            const inferred =
              window.LedgerXlsxParser && typeof window.LedgerXlsxParser.inferAgentFromPath === 'function'
                ? window.LedgerXlsxParser.inferAgentFromPath(name, pathSegments)
                : {
                    agentName: pathSegments[pathSegments.length - 1] || 'Unnamed Agent',
                    ...makeDedupKey(pathSegments[pathSegments.length - 1] || 'Unnamed Agent', name)
                  };

            xlsxFiles.push({
              entry,
              fileName: name,
              sourcePath,
              pathSegments: [...pathSegments],
              isViewOnlyCopy,
              workbookSlug: inferred.workbookSlug,
              inferredAgentName: inferred.agentName,
              agentSlug: inferred.agentSlug,
              dedupKey: inferred.dedupKey
            });
          }
        }
      }
    }

    await walk(rootHandle, [], 0);
    return { jsonMirrors, xlsxFiles };
  }

  async function readExistingLedgerManifest(rootHandle) {
    const cfgDir = await ensureSubDir(rootHandle, '_Config', false);
    if (!cfgDir) return null;
    try {
      const fh = await cfgDir.getFileHandle('ledger-manifest.json', { create: false });
      const parsed = JSON.parse(await (await fh.getFile()).text());
      if (parsed && UUID_RE.test(String(parsed.ledgerId || '').trim())) {
        return parsed;
      }
    } catch (_) { /* missing or unreadable */ }
    return null;
  }

  async function detectDominantMirrorLedgerId(jsonMirrors) {
    const counts = new Map();
    for (const m of (jsonMirrors || []).slice(0, 25)) {
      try {
        const file = await m.entry.getFile();
        const parsed = JSON.parse(await file.text());
        if (parsed && parsed.schemaVersion === 'trackerui.mirror.v1') {
          const lid = String(parsed.ledgerId || '').trim().toLowerCase();
          if (UUID_RE.test(lid)) {
            counts.set(lid, (counts.get(lid) || 0) + 1);
          }
        }
      } catch (_) { /* ignore malformed */ }
    }
    if (counts.size === 0) return '';
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  }

  async function loadOrCreateLedgerManifest(rootHandle, actorIdentity, preferredLedgerId = '') {
    const existing = await readExistingLedgerManifest(rootHandle);
    if (existing) return existing;

    const nowIso = new Date().toISOString();
    const resolvedLedgerId = UUID_RE.test(String(preferredLedgerId || '').trim())
      ? String(preferredLedgerId).trim().toLowerCase()
      : generateUuid();

    const manifest = {
      schemaVersion: 'trackerui.ledger.v1',
      ledgerId: resolvedLedgerId,
      ledgerName: `${rootHandle.name || 'Team'} Ledger`,
      createdAt: nowIso,
      updatedAt: nowIso,
      createdBy: {
        actorUuid: (actorIdentity && actorIdentity.actorUuid) || generateUuid(),
        actorName: (actorIdentity && actorIdentity.actorName) || 'Coordinator'
      },
      paths: {
        mirrorsDir: '_ViewOnly_JSON',
        sharedQueueDir: '_SharedQueue',
        ledgerDir: '_Ledger',
        templatesDir: '_Templates',
        agentsDir: 'Agents'
      }
    };

    try {
      const cfgDir = await ensureSubDir(rootHandle, '_Config', true);
      if (cfgDir) {
        const fh = await cfgDir.getFileHandle('ledger-manifest.json', { create: true });
        const writable = await fh.createWritable();
        await writable.write(JSON.stringify(manifest, null, 2));
        await writable.close();
      }
    } catch (_) {
      // Read-only Team Root fallback: return in-memory manifest without failing sync
    }
    return manifest;
  }

  async function adoptLedgerId(rootHandle, actorIdentity, newLedgerId) {
    if (!rootHandle) throw new Error('No Team Root folder connected.');
    const cleanId = String(newLedgerId || '').trim().toLowerCase();
    if (!UUID_RE.test(cleanId)) {
      throw new Error('Invalid Ledger ID (expected UUIDv4).');
    }
    const existing = await readExistingLedgerManifest(rootHandle);
    const nowIso = new Date().toISOString();
    const manifest = existing
      ? { ...existing, ledgerId: cleanId, updatedAt: nowIso }
      : {
          schemaVersion: 'trackerui.ledger.v1',
          ledgerId: cleanId,
          ledgerName: `${rootHandle.name || 'Team'} Ledger`,
          createdAt: nowIso,
          updatedAt: nowIso,
          createdBy: {
            actorUuid: (actorIdentity && actorIdentity.actorUuid) || generateUuid(),
            actorName: (actorIdentity && actorIdentity.actorName) || 'Coordinator'
          },
          paths: {
            mirrorsDir: '_ViewOnly_JSON',
            sharedQueueDir: '_SharedQueue',
            ledgerDir: '_Ledger',
            templatesDir: '_Templates',
            agentsDir: 'Agents'
          }
        };

    const cfgDir = await ensureSubDir(rootHandle, '_Config', true);
    if (!cfgDir) throw new Error('Could not access _Config/ inside Team Root.');
    const fh = await cfgDir.getFileHandle('ledger-manifest.json', { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(manifest, null, 2));
    await writable.close();
    return manifest;
  }

  function resolveWinningClaim(claimsList) {
    const active = (Array.isArray(claimsList) ? claimsList : [])
      .filter((c) => c && c.claimState === 'claimed' && c.agentUuid);
    if (active.length === 0) return null;
    active.sort((a, b) => {
      const tA = Date.parse(a.claimedAt || '') || Number.MAX_SAFE_INTEGER;
      const tB = Date.parse(b.claimedAt || '') || Number.MAX_SAFE_INTEGER;
      if (tA !== tB) return tA - tB;
      return String(a.agentUuid).localeCompare(String(b.agentUuid));
    });
    return active[0];
  }

  function appendUniqueNoteLine(out, seen, rawLine, dateLabel) {
    const clean = String(rawLine || '').trim();
    if (!clean) return;
    const formatted = clean.startsWith('[') ? clean : (dateLabel ? `[${dateLabel}] ${clean}` : clean);
    const bodyOnly = clean.replace(DATE_PREFIX_STRIP_RE, '').trim();
    const exists = seen.has(formatted) || seen.has(clean) ||
      out.some((prev) => prev === clean || (bodyOnly && prev.endsWith(`] ${bodyOnly}`)));
    if (!exists) {
      out.push(formatted);
      seen.add(formatted);
    }
  }

  function isSwappedStatusAndNotes(r) {
    const timeline = Array.isArray(r.timeline) ? r.timeline : [];
    if (timeline.length > 0) {
      let notesAreStatuses = 0;
      let statusesAreStatuses = 0;
      for (const t of timeline) {
        const tn = String((t && t.notes) || '').trim();
        const ts = String((t && t.status) || '').trim();
        if (tn && KNOWN_STATUS_RE.test(tn)) notesAreStatuses++;
        if (ts && KNOWN_STATUS_RE.test(ts)) statusesAreStatuses++;
      }
      if (notesAreStatuses > 0 && statusesAreStatuses === 0) return true;
    }

    const rawStatus = String(r.status || '').trim();
    const rawNotes = String(r.notes || '').trim();
    if (rawNotes) {
      const strippedLines = rawNotes
        .split(/\r?\n/)
        .map((l) => l.replace(DATE_PREFIX_STRIP_RE, '').trim())
        .filter(Boolean);
      if (
        strippedLines.length > 0 &&
        strippedLines.every((l) => KNOWN_STATUS_RE.test(l)) &&
        !KNOWN_STATUS_RE.test(rawStatus)
      ) {
        return true;
      }
    }

    if (rawStatus && !KNOWN_STATUS_RE.test(rawStatus) && TIMESTAMPED_PROSE_RE.test(rawStatus)) {
      return true;
    }
    return false;
  }

  function repairMirrorRecordFields(r) {
    const swapped = isSwappedStatusAndNotes(r);
    let finalStatus = String(r.status || '').trim();
    let finalNotes = String(r.notes || '').trim();
    let finalTimeline = Array.isArray(r.timeline) ? r.timeline : [];

    if (swapped) {
      finalTimeline = finalTimeline.map((t) => ({
        ...t,
        status: String((t && t.notes) || '').trim() || 'Pending',
        notes: String((t && t.status) || '').trim()
      }));

      // Derive latest status from timeline or stripped notes lines
      const tlStatuses = finalTimeline.map((t) => String(t.status || '').trim()).filter(Boolean);
      if (tlStatuses.length > 0) {
        finalStatus = tlStatuses[tlStatuses.length - 1];
      } else {
        const noteStatuses = finalNotes
          .split(/\r?\n/)
          .map((l) => l.replace(DATE_PREFIX_STRIP_RE, '').trim())
          .filter(Boolean);
        finalStatus = noteStatuses.length > 0 ? noteStatuses[noteStatuses.length - 1] : 'Pending';
      }

      // Reconstruct chronological notes from timeline entries + original status text
      const outNotes = [];
      const seenNotes = new Set();
      for (const t of finalTimeline) {
        const dateLabel = t.date || t.sheetName || '';
        for (const line of String(t.notes || '').split(/\r?\n/)) {
          appendUniqueNoteLine(outNotes, seenNotes, line, dateLabel);
        }
      }
      for (const line of String(r.status || '').split(/\r?\n/)) {
        appendUniqueNoteLine(outNotes, seenNotes, line, r.lastSeenDate || '');
      }
      finalNotes = outNotes.join('\n');
    }

    if (!finalStatus) finalStatus = 'Pending';

    let ticketNumber = String(r.ticketNumber || '').trim();
    if (!ticketNumber && r.subject && window.LedgerXlsxParser && typeof window.LedgerXlsxParser.extractTicketFromSubject === 'function') {
      ticketNumber = window.LedgerXlsxParser.extractTicketFromSubject(r.subject);
    }

    let actionCategory = String(r.actionCategory || '').trim();
    if ((!actionCategory || actionCategory === 'Uncategorized') && r.requestedAction && window.LedgerXlsxParser && typeof window.LedgerXlsxParser.inferActionCategory === 'function') {
      actionCategory = window.LedgerXlsxParser.inferActionCategory(r.requestedAction);
    }

    const isCompleted = /^(complete|completed|closed|done|resolved)$/i.test(finalStatus);
    const isOverdue = Boolean(r.isOverdue) || (!isCompleted && /overdue/i.test(finalStatus));

    return {
      ...r,
      status: finalStatus,
      notes: finalNotes,
      timeline: finalTimeline,
      ticketNumber,
      actionCategory: actionCategory || 'Uncategorized',
      isOverdue
    };
  }

  function normalizePayloadRecords(payload, sourcePath, sourceType, fallbackLedgerId) {
    const agentObj = payload.agent || {};
    const wbObj = payload.workbook || {};
    const agentUuid = String(agentObj.agentUuid || '').toLowerCase();
    const agentName = agentObj.agentName || 'Unnamed Agent';
    const wbSlug = wbObj.workbookSlug || normalizeWorkbookSlug(wbObj.fileName || sourcePath);
    const payloadLedgerId = String(payload.ledgerId || '').trim().toLowerCase();
    const effectiveLedgerId = payloadLedgerId || fallbackLedgerId || '';

    return (Array.isArray(payload.records) ? payload.records : [])
      .filter((r) => r && (r.trackingUuid || r.subject || r.ticketNumber || r.brokerName || r.lotNumbers || r.notes))
      .map((rawRec, idx) => {
        const r = repairMirrorRecordFields(rawRec);
        const rawTid = String(r.trackingUuid || '').trim().toLowerCase();
        const tid = rawTid || stableHashFallback(`${sourcePath}::${idx}::${r.ticketNumber || r.subject || ''}`);
        const rowAgent = r.rowAgentName || agentName;
        return {
          ...r,
          trackingUuid: tid,
          compositeId: `${tid}::${agentUuid || normalizeAgentSlug(rowAgent)}::${wbSlug}`,
          sourceFile: sourcePath,
          sourceType,
          ledgerId: effectiveLedgerId,
          agentUuid,
          agentName: rowAgent,
          agentRole: agentObj.role || 'agent',
          workbookSlug: wbSlug,
          workbookFileName: wbObj.fileName || '',
          profileName: wbObj.profileName || (sourceType === 'xlsx' ? 'Excel Workbook' : 'Daily Tracker'),
          exportedAt: payload.exportedAt || ''
        };
      });
  }

  function selectCandidateOrder(candidatesWithStats) {
    if (candidatesWithStats.length <= 1) return candidatesWithStats;
    const sorted = [...candidatesWithStats];
    sorted.sort((a, b) => {
      // If one is a view-only copy and one is primary, prefer view-only if it's fresh (within 60s or newer)
      if (a.isViewOnlyCopy !== b.isViewOnlyCopy) {
        const vo = a.isViewOnlyCopy ? a : b;
        const pri = a.isViewOnlyCopy ? b : a;
        if (vo.lastModified >= pri.lastModified - 60000) {
          return a.isViewOnlyCopy ? -1 : 1;
        }
      }
      return b.lastModified - a.lastModified;
    });
    return sorted;
  }

  async function syncFromTeamRoot(rootHandle, actorIdentity, { forceFullRebuild = false } = {}) {
    if (!rootHandle) throw new Error('No Team Root folder connected.');
    if (forceFullRebuild) {
      await window.LedgerDB.clearCacheStores();
    }

    const connectionMode = await detectConnectionMode(rootHandle);
    const isTeamRoot = connectionMode === 'team-root';

    // Discover JSON mirrors & .xlsx workbooks across the connected folder tree
    const { jsonMirrors, xlsxFiles } = await discoverSources(rootHandle, connectionMode);

    let manifest;
    if (isTeamRoot) {
      const existingManifest = await readExistingLedgerManifest(rootHandle);
      if (existingManifest) {
        manifest = existingManifest;
      } else {
        const mirrorLedgerId = await detectDominantMirrorLedgerId(jsonMirrors);
        manifest = await loadOrCreateLedgerManifest(rootHandle, actorIdentity, mirrorLedgerId);
      }
    } else {
      const mirrorLedgerId = await detectDominantMirrorLedgerId(jsonMirrors);
      manifest = {
        schemaVersion: 'trackerui.ledger.v1',
        ledgerId: mirrorLedgerId || '',
        ledgerName: rootHandle.name || 'Direct Scan',
        isTeamRoot: false,
        connectionMode
      };
    }

    const activeLedgerId = isTeamRoot ? String(manifest.ledgerId || '').trim().toLowerCase() : '';

    const prevMetaList = await window.LedgerDB.getAllSyncMeta();
    const prevMetaMap = new Map(prevMetaList.map((m) => [m.fileName, m]));
    const seenSourcePaths = new Set();
    const coveredMirrorKeys = new Set();
    const foreignLedgerIds = new Set();
    const warnings = [];

    let mirrorsTotal = 0;
    let mirrorsParsed = 0;
    let mirrorsSkippedUnchanged = 0;
    let foreignLedgerSkipped = 0;

    // 1. Phase 1: Incremental sync of JSON mirrors
    for (const item of jsonMirrors) {
      let file;
      try {
        file = await item.entry.getFile();
      } catch (err) {
        warnings.push(`Could not read mirror ${item.sourcePath}: ${err.message}`);
        continue;
      }

      const prev = prevMetaMap.get(item.sourcePath);
      if (
        !forceFullRebuild &&
        prev &&
        prev.sourceType === 'json' &&
        prev.lastModified === file.lastModified &&
        prev.size === file.size &&
        prev.ledgerId === activeLedgerId &&
        prev.parserVersion === PARSER_VERSION
      ) {
        seenSourcePaths.add(item.sourcePath);
        mirrorsTotal++;
        mirrorsSkippedUnchanged++;
        if (prev.dedupKey) coveredMirrorKeys.add(prev.dedupKey);
        if (prev.workbookSlug && (!prev.agentName || prev.agentName === 'Unnamed Agent')) {
          coveredMirrorKeys.add(prev.workbookSlug);
        }
        continue;
      }

      try {
        const payload = JSON.parse(await file.text());
        if (!payload || payload.schemaVersion !== 'trackerui.mirror.v1') continue;
        mirrorsTotal++;

        const payloadLedgerId = String(payload.ledgerId || '').trim().toLowerCase();
        if (isTeamRoot && activeLedgerId && payloadLedgerId && payloadLedgerId !== activeLedgerId) {
          foreignLedgerSkipped++;
          foreignLedgerIds.add(payloadLedgerId);
          continue;
        }

        await window.LedgerDB.deleteRecordsBySourceFile(item.sourcePath);
        const docs = normalizePayloadRecords(payload, item.sourcePath, 'json', activeLedgerId);
        await window.LedgerDB.putRecordsBatch(docs);

        const agentName = (payload.agent && payload.agent.agentName) || '';
        const wbRef = (payload.workbook && (payload.workbook.workbookSlug || payload.workbook.fileName)) || item.fileName;
        const { workbookSlug, dedupKey } = makeDedupKey(agentName, wbRef);

        coveredMirrorKeys.add(dedupKey);
        if (!agentName || agentName === 'Unnamed Agent') {
          coveredMirrorKeys.add(workbookSlug);
        }

        await window.LedgerDB.putSyncMeta({
          fileName: item.sourcePath,
          sourceType: 'json',
          lastModified: file.lastModified,
          size: file.size,
          ledgerId: activeLedgerId,
          parserVersion: PARSER_VERSION,
          recordCount: docs.length,
          agentName,
          workbookSlug,
          dedupKey,
          syncedAt: new Date().toISOString()
        });
        seenSourcePaths.add(item.sourcePath);
        mirrorsParsed++;
      } catch (err) {
        warnings.push(`Skipped invalid mirror ${item.sourcePath}: ${err.message}`);
        console.warn(`Skipped invalid mirror ${item.sourcePath}:`, err);
      }
    }

    // 2. Phase 2: Incremental sync of .xlsx workbooks (deduplicated against JSON mirrors and primary/VIEW ONLY pairs)
    const xlsxGroups = new Map();
    for (const xf of xlsxFiles) {
      if (!xlsxGroups.has(xf.dedupKey)) {
        xlsxGroups.set(xf.dedupKey, []);
      }
      xlsxGroups.get(xf.dedupKey).push(xf);
    }

    let workbooksTotal = 0;
    let workbooksParsed = 0;
    let workbooksSkippedUnchanged = 0;
    let workbooksSkippedCoveredByMirror = 0;
    let workbooksFailed = 0;

    for (const [groupKey, candidates] of xlsxGroups.entries()) {
      const groupWbSlug = candidates[0].workbookSlug;
      if (coveredMirrorKeys.has(groupKey) || coveredMirrorKeys.has(groupWbSlug)) {
        workbooksSkippedCoveredByMirror += candidates.length;
        continue;
      }

      workbooksTotal++;

      const readableCandidates = [];
      const readErrors = [];
      for (const cand of candidates) {
        try {
          const file = await cand.entry.getFile();
          readableCandidates.push({
            ...cand,
            file,
            lastModified: file.lastModified || 0,
            size: file.size || 0
          });
        } catch (err) {
          readErrors.push(`${cand.sourcePath}: ${err.message}`);
        }
      }

      if (readableCandidates.length === 0) {
        workbooksFailed++;
        if (readErrors.length > 0) warnings.push(readErrors[0]);
        continue;
      }

      const orderedCandidates = selectCandidateOrder(readableCandidates);
      let groupHandled = false;
      let lastGroupErr = '';

      for (const cand of orderedCandidates) {
        const prev = prevMetaMap.get(cand.sourcePath);
        if (
          !forceFullRebuild &&
          prev &&
          prev.sourceType === 'xlsx' &&
          prev.lastModified === cand.lastModified &&
          prev.size === cand.size &&
          prev.ledgerId === activeLedgerId &&
          prev.parserVersion === PARSER_VERSION
        ) {
          seenSourcePaths.add(cand.sourcePath);
          workbooksSkippedUnchanged++;
          groupHandled = true;
          break;
        }

        try {
          if (!window.LedgerXlsxParser || typeof window.LedgerXlsxParser.parseWorkbookBuffer !== 'function') {
            throw new Error('xlsx-parser.js is not loaded.');
          }
          const arrayBuffer = await cand.file.arrayBuffer();
          const parsed = await window.LedgerXlsxParser.parseWorkbookBuffer(arrayBuffer, {
            fileName: cand.fileName,
            pathSegments: cand.pathSegments
          });

          const payloadLedgerId = String(parsed.ledgerId || '').trim().toLowerCase();
          if (isTeamRoot && activeLedgerId && payloadLedgerId && payloadLedgerId !== activeLedgerId) {
            foreignLedgerSkipped++;
            foreignLedgerIds.add(payloadLedgerId);
            groupHandled = true;
            break;
          }

          await window.LedgerDB.deleteRecordsBySourceFile(cand.sourcePath);
          const docs = normalizePayloadRecords(parsed, cand.sourcePath, 'xlsx', activeLedgerId);
          await window.LedgerDB.putRecordsBatch(docs);

          const resolvedAgentName = (parsed.agent && parsed.agent.agentName) || cand.inferredAgentName;
          await window.LedgerDB.putSyncMeta({
            fileName: cand.sourcePath,
            sourceType: 'xlsx',
            lastModified: cand.lastModified,
            size: cand.size,
            ledgerId: activeLedgerId,
            parserVersion: PARSER_VERSION,
            recordCount: docs.length,
            agentName: resolvedAgentName,
            workbookSlug: parsed.workbook.workbookSlug || cand.workbookSlug,
            dedupKey: groupKey,
            syncedAt: new Date().toISOString()
          });

          seenSourcePaths.add(cand.sourcePath);
          workbooksParsed++;
          groupHandled = true;
          break;
        } catch (err) {
          lastGroupErr = `Could not parse ${cand.sourcePath}: ${err.message}`;
          console.warn(lastGroupErr, err);
        }
      }

      if (!groupHandled) {
        workbooksFailed++;
        if (lastGroupErr) warnings.push(lastGroupErr);
      }
    }

    // 3. Prune deleted or superseded source files from IndexedDB
    for (const oldMeta of prevMetaList) {
      if (!seenSourcePaths.has(oldMeta.fileName)) {
        await window.LedgerDB.deleteRecordsBySourceFile(oldMeta.fileName);
        await window.LedgerDB.deleteSyncMeta(oldMeta.fileName);
      }
    }

    // 4. Sync _Ledger/overlays_*.json (only create directory in Team Root mode)
    const ledgerDir = await ensureSubDir(rootHandle, '_Ledger', isTeamRoot);
    const mergedOverlayByUuid = new Map();
    if (ledgerDir) {
      for await (const entry of ledgerDir.values()) {
        if (entry.kind !== 'file' || !/^overlays_.*\.json$/i.test(entry.name)) continue;
        try {
          const parsed = JSON.parse(await (await entry.getFile()).text());
          if (!parsed || parsed.schemaVersion !== 'ledgerui.overlay.v1') continue;
          const ovLedger = String(parsed.ledgerId || '').trim().toLowerCase();
          if (isTeamRoot && activeLedgerId && ovLedger && ovLedger !== activeLedgerId) continue;

          const actorUuid = String(parsed.actorUuid || '').toLowerCase();
          const overlaysObj = parsed.overlays && typeof parsed.overlays === 'object' ? parsed.overlays : {};
          Object.entries(overlaysObj).forEach(([rawUuid, ov]) => {
            const tid = String(rawUuid || '').trim().toLowerCase();
            if (!tid || !ov) return;
            const existing = mergedOverlayByUuid.get(tid) || {
              trackingUuid: tid,
              tags: [],
              flagged: false,
              ledgerNote: '',
              updatedAt: '',
              byActor: {}
            };
            if (actorUuid) {
              existing.byActor[actorUuid] = {
                actorName: parsed.actorName || '',
                tags: Array.isArray(ov.tags) ? [...ov.tags] : [],
                flagged: Boolean(ov.flagged),
                ledgerNote: String(ov.ledgerNote || ''),
                updatedAt: ov.updatedAt || parsed.updatedAt || ''
              };
            }
            mergedOverlayByUuid.set(tid, existing);
          });
        } catch (err) {
          console.warn(`Skipped invalid overlay file ${entry.name}:`, err);
        }
      }
    }

    const overlayDocs = Array.from(mergedOverlayByUuid.values()).map((entry) => {
      const actors = Object.values(entry.byActor || {});
      actors.sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0));
      const tagSet = new Set();
      actors.forEach((a) => (a.tags || []).forEach((t) => tagSet.add(t)));
      const latest = actors[0] || {};
      return {
        trackingUuid: entry.trackingUuid,
        tags: Array.from(tagSet),
        flagged: actors.some((a) => a.flagged),
        ledgerNote: latest.ledgerNote || '',
        updatedAt: latest.updatedAt || '',
        byActor: entry.byActor
      };
    });
    await window.LedgerDB.putOverlaysBatch(overlayDocs);

    // 5. Sync _SharedQueue/items & claims (only create directories in Team Root mode)
    const sqDir = await ensureSubDir(rootHandle, '_SharedQueue', isTeamRoot);
    const itemsDir = sqDir ? await ensureSubDir(sqDir, 'items', isTeamRoot) : null;
    const claimsDir = sqDir ? await ensureSubDir(sqDir, 'claims', isTeamRoot) : null;

    const claimsByTracking = new Map();
    if (claimsDir) {
      for await (const entry of claimsDir.values()) {
        if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(await (await entry.getFile()).text());
          if (!parsed || parsed.schemaVersion !== 'trackerui.queue.claim.v1') continue;
          const clLedger = String(parsed.ledgerId || '').trim().toLowerCase();
          if (isTeamRoot && activeLedgerId && clLedger && clLedger !== activeLedgerId) continue;
          const tid = String(parsed.trackingUuid || '').trim().toLowerCase();
          if (!tid) continue;
          if (!claimsByTracking.has(tid)) claimsByTracking.set(tid, []);
          claimsByTracking.get(tid).push(parsed);
        } catch (_) { /* ignore malformed claim */ }
      }
    }

    const queueDocs = [];
    if (itemsDir) {
      for await (const entry of itemsDir.values()) {
        if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(await (await entry.getFile()).text());
          if (!parsed || parsed.schemaVersion !== 'trackerui.queue.item.v1') continue;
          const qLedger = String(parsed.ledgerId || '').trim().toLowerCase();
          if (isTeamRoot && activeLedgerId && qLedger && qLedger !== activeLedgerId) continue;
          const tid = String(parsed.trackingUuid || '').trim().toLowerCase();
          if (!tid) continue;
          const winningClaim = resolveWinningClaim(claimsByTracking.get(tid) || []);
          queueDocs.push({
            ...parsed,
            trackingUuid: tid,
            winningClaim
          });
        } catch (_) { /* ignore malformed queue item */ }
      }
    }
    await window.LedgerDB.replaceAllQueueItems(queueDocs);

    return {
      manifest,
      connectionMode,
      isTeamRoot,
      mirrorsTotal,
      mirrorsParsed,
      mirrorsSkippedUnchanged,
      workbooksTotal,
      workbooksParsed,
      workbooksSkippedUnchanged,
      workbooksSkippedCoveredByMirror,
      workbooksFailed,
      foreignLedgerSkipped,
      foreignLedgerIds: Array.from(foreignLedgerIds),
      warnings,
      queueCount: queueDocs.length
    };
  }

  async function saveActorOverlay(rootHandle, manifest, actorIdentity, trackingUuid, { tags, flagged, ledgerNote }) {
    if (!rootHandle) throw new Error('Connect a Team Root folder first.');
    const ledgerDir = await ensureSubDir(rootHandle, '_Ledger', true);
    if (!ledgerDir) throw new Error('Could not access _Ledger/ inside Team Root.');
    const actorUuid = String(actorIdentity.actorUuid || generateUuid()).toLowerCase();
    const actorName = actorIdentity.actorName || 'Coordinator';
    const fileName = `overlays_${actorUuid}.json`;

    let doc = {
      schemaVersion: 'ledgerui.overlay.v1',
      ledgerId: (manifest && manifest.ledgerId) || '',
      actorUuid,
      actorName,
      updatedAt: new Date().toISOString(),
      overlays: {}
    };

    try {
      const existingFh = await ledgerDir.getFileHandle(fileName, { create: false });
      const parsed = JSON.parse(await (await existingFh.getFile()).text());
      if (parsed && typeof parsed.overlays === 'object') {
        doc.overlays = parsed.overlays;
      }
    } catch (_) { /* first write for actor */ }

    const cleanTags = Array.from(new Set((tags || []).map((t) => String(t).trim()).filter(Boolean)));
    const cleanNote = String(ledgerNote || '').trim();
    const tid = String(trackingUuid).trim().toLowerCase();
    const nowIso = new Date().toISOString();

    if (cleanTags.length === 0 && !flagged && !cleanNote) {
      delete doc.overlays[tid];
    } else {
      doc.overlays[tid] = {
        tags: cleanTags,
        flagged: Boolean(flagged),
        ledgerNote: cleanNote,
        updatedAt: nowIso
      };
    }
    doc.updatedAt = nowIso;
    doc.actorName = actorName;

    const fh = await ledgerDir.getFileHandle(fileName, { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(doc, null, 2));
    await writable.close();

    // Recompute merged overlay in IndexedDB
    const allOverlays = await window.LedgerDB.getAllOverlays();
    const current = allOverlays.find((o) => o.trackingUuid === tid) || { trackingUuid: tid, byActor: {} };
    current.byActor = current.byActor || {};
    if (cleanTags.length === 0 && !flagged && !cleanNote) {
      delete current.byActor[actorUuid];
    } else {
      current.byActor[actorUuid] = {
        actorName,
        tags: cleanTags,
        flagged: Boolean(flagged),
        ledgerNote: cleanNote,
        updatedAt: nowIso
      };
    }
    const actors = Object.values(current.byActor);
    actors.sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0));
    const tagSet = new Set();
    actors.forEach((a) => (a.tags || []).forEach((t) => tagSet.add(t)));
    const latest = actors[0] || {};
    await window.LedgerDB.putOverlay({
      trackingUuid: tid,
      tags: Array.from(tagSet),
      flagged: actors.some((a) => a.flagged),
      ledgerNote: latest.ledgerNote || '',
      updatedAt: latest.updatedAt || '',
      byActor: current.byActor
    });
  }

  async function publishSharedQueueItem(rootHandle, manifest, actorIdentity, formPayload) {
    if (!rootHandle) throw new Error('Connect a Team Root folder first.');
    const sqDir = await ensureSubDir(rootHandle, '_SharedQueue', true);
    if (!sqDir) throw new Error('Could not access _SharedQueue/ inside Team Root.');
    const itemsDir = await ensureSubDir(sqDir, 'items', true);
    if (!itemsDir) throw new Error('Could not access _SharedQueue/items/ inside Team Root.');
    const trackingUuid = generateUuid();
    const itemDoc = {
      schemaVersion: 'trackerui.queue.item.v1',
      ledgerId: (manifest && manifest.ledgerId) || '',
      trackingUuid,
      createdAt: new Date().toISOString(),
      createdBy: {
        actorUuid: (actorIdentity && actorIdentity.actorUuid) || generateUuid(),
        actorName: (actorIdentity && actorIdentity.actorName) || 'Coordinator',
        sourceApp: 'LedgerUI'
      },
      priority: formPayload.priority || 'Normal',
      queueStatus: 'Open',
      payload: {
        parentTrackingUuid: null,
        subject: String(formPayload.subject || '').trim(),
        ticketNumber: String(formPayload.ticketNumber || '').trim().toUpperCase(),
        masterTicketNumber: '',
        subTicketNumbers: [],
        brokerName: String(formPayload.brokerName || '').trim(),
        masterNumber: String(formPayload.masterNumber || '').trim().toUpperCase(),
        bidderNumber: String(formPayload.bidderNumber || '').trim().toUpperCase(),
        requestedAction: String(formPayload.requestedAction || '').trim(),
        yardNumber: String(formPayload.yardNumber || '').trim().toUpperCase(),
        lotNumbers: String(formPayload.lotNumbers || '').trim(),
        notes: String(formPayload.notes || '').trim(),
        status: 'New',
        customValues: {}
      }
    };

    const fh = await itemsDir.getFileHandle(`${trackingUuid}.json`, { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(itemDoc, null, 2));
    await writable.close();
    return itemDoc;
  }

  window.LedgerSync = {
    generateUuid,
    detectConnectionMode,
    loadOrCreateLedgerManifest,
    adoptLedgerId,
    syncFromTeamRoot,
    saveActorOverlay,
    publishSharedQueueItem
  };
})();
