// ============================================================================
// sync-engine.js — Incremental JSON Store Ingestion, _SharedQueue & _Ledger I/O
// ============================================================================
(() => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  async function ensureSubDir(parentHandle, name, create = false) {
    try {
      return await parentHandle.getDirectoryHandle(name, { create });
    } catch (_) {
      return null;
    }
  }

  async function loadOrCreateLedgerManifest(rootHandle, actorIdentity) {
    const cfgDir = await ensureSubDir(rootHandle, '_Config', true);
    if (!cfgDir) throw new Error('Could not access _Config/ inside Team Root.');

    try {
      const fh = await cfgDir.getFileHandle('ledger-manifest.json', { create: false });
      const parsed = JSON.parse(await (await fh.getFile()).text());
      if (parsed && UUID_RE.test(String(parsed.ledgerId || '').trim())) {
        return parsed;
      }
    } catch (_) { /* missing — create below */ }

    const nowIso = new Date().toISOString();
    const manifest = {
      schemaVersion: 'trackerui.ledger.v1',
      ledgerId: generateUuid(),
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

  async function syncFromTeamRoot(rootHandle, actorIdentity, { forceFullRebuild = false } = {}) {
    if (!rootHandle) throw new Error('No Team Root folder connected.');
    if (forceFullRebuild) {
      await window.LedgerDB.clearCacheStores();
    }

    const manifest = await loadOrCreateLedgerManifest(rootHandle, actorIdentity);
    const activeLedgerId = String(manifest.ledgerId || '').trim().toLowerCase();

    // 1. Incremental sync of _ViewOnly_JSON/mirror_*.json
    const mirrorsDir = await ensureSubDir(rootHandle, '_ViewOnly_JSON', true);
    const prevMetaList = await window.LedgerDB.getAllSyncMeta();
    const prevMetaMap = new Map(prevMetaList.map((m) => [m.fileName, m]));
    const seenMirrorFiles = new Set();

    let mirrorsParsed = 0;
    let mirrorsSkippedUnchanged = 0;
    let foreignLedgerSkipped = 0;

    if (mirrorsDir) {
      for await (const entry of mirrorsDir.values()) {
        if (entry.kind !== 'file' || !/^mirror_.*\.json$/i.test(entry.name)) continue;
        seenMirrorFiles.add(entry.name);

        const file = await entry.getFile();
        const prev = prevMetaMap.get(entry.name);
        if (
          !forceFullRebuild &&
          prev &&
          prev.lastModified === file.lastModified &&
          prev.size === file.size &&
          prev.ledgerId === activeLedgerId
        ) {
          mirrorsSkippedUnchanged++;
          continue;
        }

        try {
          const payload = JSON.parse(await file.text());
          if (!payload || payload.schemaVersion !== 'trackerui.mirror.v1') continue;
          const payloadLedgerId = String(payload.ledgerId || '').trim().toLowerCase();
          if (activeLedgerId && payloadLedgerId && payloadLedgerId !== activeLedgerId) {
            foreignLedgerSkipped++;
            continue;
          }

          await window.LedgerDB.deleteRecordsBySourceFile(entry.name);
          const agentObj = payload.agent || {};
          const wbObj = payload.workbook || {};
          const agentUuid = String(agentObj.agentUuid || '').toLowerCase();
          const wbSlug = wbObj.workbookSlug || 'workbook';

          const docs = (Array.isArray(payload.records) ? payload.records : [])
            .filter((r) => r && r.trackingUuid)
            .map((r) => {
              const tid = String(r.trackingUuid).trim().toLowerCase();
              return {
                ...r,
                trackingUuid: tid,
                compositeId: `${tid}::${agentUuid || 'unknown'}::${wbSlug}`,
                sourceFile: entry.name,
                ledgerId: payloadLedgerId || activeLedgerId,
                agentUuid,
                agentName: agentObj.agentName || 'Unnamed Agent',
                agentRole: agentObj.role || 'agent',
                workbookSlug: wbSlug,
                workbookFileName: wbObj.fileName || '',
                profileName: wbObj.profileName || 'Daily Tracker',
                exportedAt: payload.exportedAt || ''
              };
            });

          await window.LedgerDB.putRecordsBatch(docs);
          await window.LedgerDB.putSyncMeta({
            fileName: entry.name,
            lastModified: file.lastModified,
            size: file.size,
            ledgerId: activeLedgerId,
            recordCount: docs.length,
            agentName: agentObj.agentName || '',
            syncedAt: new Date().toISOString()
          });
          mirrorsParsed++;
        } catch (err) {
          console.warn(`Skipped invalid mirror ${entry.name}:`, err);
        }
      }
    }

    // Prune deleted mirror files from IndexedDB
    for (const oldMeta of prevMetaList) {
      if (!seenMirrorFiles.has(oldMeta.fileName)) {
        await window.LedgerDB.deleteRecordsBySourceFile(oldMeta.fileName);
        await window.LedgerDB.deleteSyncMeta(oldMeta.fileName);
      }
    }

    // 2. Sync _Ledger/overlays_*.json
    const ledgerDir = await ensureSubDir(rootHandle, '_Ledger', true);
    const mergedOverlayByUuid = new Map();
    if (ledgerDir) {
      for await (const entry of ledgerDir.values()) {
        if (entry.kind !== 'file' || !/^overlays_.*\.json$/i.test(entry.name)) continue;
        try {
          const parsed = JSON.parse(await (await entry.getFile()).text());
          if (!parsed || parsed.schemaVersion !== 'ledgerui.overlay.v1') continue;
          const ovLedger = String(parsed.ledgerId || '').trim().toLowerCase();
          if (activeLedgerId && ovLedger && ovLedger !== activeLedgerId) continue;

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

    // 3. Sync _SharedQueue/items & claims
    const sqDir = await ensureSubDir(rootHandle, '_SharedQueue', true);
    const itemsDir = sqDir ? await ensureSubDir(sqDir, 'items', true) : null;
    const claimsDir = sqDir ? await ensureSubDir(sqDir, 'claims', true) : null;

    const claimsByTracking = new Map();
    if (claimsDir) {
      for await (const entry of claimsDir.values()) {
        if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(await (await entry.getFile()).text());
          if (!parsed || parsed.schemaVersion !== 'trackerui.queue.claim.v1') continue;
          const clLedger = String(parsed.ledgerId || '').trim().toLowerCase();
          if (activeLedgerId && clLedger && clLedger !== activeLedgerId) continue;
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
          if (activeLedgerId && qLedger && qLedger !== activeLedgerId) continue;
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
      mirrorsTotal: seenMirrorFiles.size,
      mirrorsParsed,
      mirrorsSkippedUnchanged,
      foreignLedgerSkipped,
      queueCount: queueDocs.length
    };
  }

  async function saveActorOverlay(rootHandle, manifest, actorIdentity, trackingUuid, { tags, flagged, ledgerNote }) {
    if (!rootHandle) throw new Error('Connect a Team Root folder first.');
    const ledgerDir = await ensureSubDir(rootHandle, '_Ledger', true);
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
    const itemsDir = await ensureSubDir(sqDir, 'items', true);
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
    loadOrCreateLedgerManifest,
    syncFromTeamRoot,
    saveActorOverlay,
    publishSharedQueueItem
  };
})();
