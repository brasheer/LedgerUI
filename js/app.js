// ============================================================================
// app.js — LedgerUI UI Controller, Filters, Overlays, Shared Queue & PWA
// ============================================================================
(() => {
  const ACTOR_IDENTITY_KEY = 'ledgerui_actor_identity_v1';
  const THEME_KEY = 'ledgerui_theme_v1';
  const FONT_SCALE_KEY = 'ledgerui_font_scale_v1';
  const AUTO_REFRESH_KEY = 'ledgerui_auto_refresh_v1';

  let rootDirHandle = null;
  let cachedRootHandle = null;
  let activeManifest = null;
  let lastSyncResult = null;
  let activeConnectionMode = 'team-root';
  let allRecords = [];
  let overlaysMap = new Map();
  let queueItems = [];
  let activeCategoryFilter = '__ALL__';
  let sortState = { field: 'lastSeenDate', dir: 'desc' };
  let activeDetailTrackingUuid = null;
  let draftOverlayTags = [];
  let autoRefreshTimer = null;

  function loadActorIdentity() {
    try {
      const raw = localStorage.getItem(ACTOR_IDENTITY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.actorUuid) return parsed;
      }
    } catch (_) { /* ignore */ }
    const fresh = { actorUuid: window.LedgerSync.generateUuid(), actorName: '' };
    localStorage.setItem(ACTOR_IDENTITY_KEY, JSON.stringify(fresh));
    return fresh;
  }

  let actorIdentity = loadActorIdentity();

  function saveActorIdentity(updates) {
    actorIdentity = {
      actorUuid: updates.actorUuid || actorIdentity.actorUuid || window.LedgerSync.generateUuid(),
      actorName: String(updates.actorName !== undefined ? updates.actorName : actorIdentity.actorName || '').trim()
    };
    localStorage.setItem(ACTOR_IDENTITY_KEY, JSON.stringify(actorIdentity));
    const lbl = document.getElementById('menuActorIdentityLabel');
    if (lbl) {
      lbl.textContent = actorIdentity.actorName
        ? `${actorIdentity.actorName} (${actorIdentity.actorUuid.slice(0, 8)}...)`
        : `Set Actor Name & UUID (${actorIdentity.actorUuid.slice(0, 8)}...)`;
    }
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(msg, variant = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `toast ${variant}`;
    div.textContent = msg;
    container.appendChild(div);
    setTimeout(() => div.remove(), 4200);
  }

  function setSyncStatus(text, tone = '') {
    const pill = document.getElementById('statusPill');
    if (!pill) return;
    pill.textContent = text;
    pill.className = `status-pill ${tone}`.trim();
  }

  // --- Theme & Font Scale ---
  const sysLightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  let themePref = localStorage.getItem(THEME_KEY) || 'auto';

  function applyTheme() {
    const eff = themePref === 'auto' ? (sysLightQuery && sysLightQuery.matches ? 'light' : 'dark') : themePref;
    document.documentElement.setAttribute('data-theme', eff);
    const hint = document.getElementById('menuThemeHint');
    if (hint) hint.textContent = themePref === 'auto' ? `Auto (${eff})` : themePref;
    document.querySelectorAll('#menuThemeGroup .theme-seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.themeChoice === themePref);
    });
  }

  function applyFontScale(pct) {
    const clamped = Math.max(85, Math.min(125, Math.round(pct / 5) * 5));
    localStorage.setItem(FONT_SCALE_KEY, String(clamped));
    document.documentElement.style.setProperty('--font-scale', String(clamped / 100));
    const slider = document.getElementById('fontSizeSlider');
    const valEl = document.getElementById('fontSizeValue');
    if (slider) slider.value = String(clamped);
    if (valEl) valEl.textContent = `${clamped}%`;
  }

  applyTheme();
  applyFontScale(parseInt(localStorage.getItem(FONT_SCALE_KEY) || '100', 10));
  if (sysLightQuery && typeof sysLightQuery.addEventListener === 'function') {
    sysLightQuery.addEventListener('change', () => {
      if (themePref === 'auto') applyTheme();
    });
  }

  // --- Popover Menus ---
  const exportMenuWrap = document.getElementById('exportMenuWrap');
  const exportMenuDropdown = document.getElementById('exportMenuDropdown');
  const setupMenuWrap = document.getElementById('setupMenuWrap');
  const setupMenuDropdown = document.getElementById('setupMenuDropdown');

  function closeMenus() {
    if (exportMenuDropdown) exportMenuDropdown.classList.remove('open');
    if (setupMenuDropdown) setupMenuDropdown.classList.remove('open');
  }

  document.getElementById('btnExportMenu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setupMenuDropdown?.classList.remove('open');
    exportMenuDropdown?.classList.toggle('open');
  });
  document.getElementById('btnSetupMenu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenuDropdown?.classList.remove('open');
    setupMenuDropdown?.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!exportMenuWrap?.contains(e.target) && !setupMenuWrap?.contains(e.target)) {
      closeMenus();
    }
  });

  document.getElementById('menuThemeGroup')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-seg-btn');
    if (!btn) return;
    themePref = btn.dataset.themeChoice || 'auto';
    localStorage.setItem(THEME_KEY, themePref);
    applyTheme();
  });
  document.getElementById('fontSizeSlider')?.addEventListener('input', (e) => applyFontScale(Number(e.target.value)));
  document.getElementById('btnFontDecrease')?.addEventListener('click', () => {
    applyFontScale((parseInt(localStorage.getItem(FONT_SCALE_KEY) || '100', 10)) - 5);
  });
  document.getElementById('btnFontIncrease')?.addEventListener('click', () => {
    applyFontScale((parseInt(localStorage.getItem(FONT_SCALE_KEY) || '100', 10)) + 5);
  });

  // --- Data Refresh from IndexedDB ---
  function isCompletedStatus(st) {
    return /^(complete|completed|closed|done|resolved)$/i.test(String(st || '').trim());
  }

  function parseRecordDateMs(dateStr) {
    const raw = String(dateStr || '').trim();
    if (!raw) return 0;
    // MM-DD-YYYY or MM/DD/YYYY
    let m = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (m) {
      let y = parseInt(m[3], 10);
      if (m[3].length === 2) y += y >= 70 ? 1900 : 2000;
      return Date.UTC(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    }
    // YYYY-MM-DD
    m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) {
      return Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    }
    const parsed = Date.parse(raw);
    return isNaN(parsed) ? 0 : parsed;
  }

  function compareRecordRecency(a, b) {
    const dA = parseRecordDateMs(a.lastSeenDate || a.latestSheetName);
    const dB = parseRecordDateMs(b.lastSeenDate || b.latestSheetName);
    if (dA !== dB) return dA - dB;
    const compA = isCompletedStatus(a.status) ? 1 : 0;
    const compB = isCompletedStatus(b.status) ? 1 : 0;
    if (compA !== compB) return compA - compB;
    const expA = Date.parse(a.exportedAt || '') || 0;
    const expB = Date.parse(b.exportedAt || '') || 0;
    if (expA !== expB) return expA - expB;
    return Number(a.carryCount || 0) - Number(b.carryCount || 0);
  }

  function deduplicateRecordsByUuid(records) {
    const byUuid = new Map();
    for (const rec of (Array.isArray(records) ? records : [])) {
      if (!rec) continue;
      const key = String(rec.trackingUuid || '').trim().toLowerCase() || rec.compositeId;
      if (!key) continue;
      if (!byUuid.has(key)) {
        byUuid.set(key, [rec]);
      } else {
        byUuid.get(key).push(rec);
      }
    }

    const deduped = [];
    for (const group of byUuid.values()) {
      if (group.length === 1) {
        const single = group[0];
        deduped.push(
          isCompletedStatus(single.status) && single.isOverdue
            ? { ...single, isOverdue: false }
            : single
        );
        continue;
      }

      const sorted = [...group].sort(compareRecordRecency);
      const winner = sorted[sorted.length - 1];

      // Earliest firstSeenDate across all appearances of this UUID
      let earliestFirstSeen = winner.firstSeenDate || '';
      let earliestFirstMs = parseRecordDateMs(earliestFirstSeen) || Number.MAX_SAFE_INTEGER;
      const timelineMap = new Map();
      const distinctDates = new Set();

      for (const item of sorted) {
        const fMs = parseRecordDateMs(item.firstSeenDate);
        if (fMs > 0 && fMs < earliestFirstMs) {
          earliestFirstMs = fMs;
          earliestFirstSeen = item.firstSeenDate;
        }
        for (const t of (Array.isArray(item.timeline) ? item.timeline : [])) {
          const tKey = `${t.date || t.sheetName || ''}::${t.sheetName || ''}::${t.rowNumber || ''}`;
          timelineMap.set(tKey, t);
          if (t.date || t.sheetName) distinctDates.add(t.date || t.sheetName);
        }
      }

      const mergedTimeline = Array.from(timelineMap.values()).sort(
        (a, b) => parseRecordDateMs(a.date || a.sheetName) - parseRecordDateMs(b.date || b.sheetName)
      );
      const maxCarry = Math.max(
        Number(winner.carryCount || 1),
        distinctDates.size || 0
      );

      deduped.push({
        ...winner,
        firstSeenDate: earliestFirstSeen || winner.firstSeenDate || '',
        carryCount: maxCarry,
        timeline: mergedTimeline.length > 0 ? mergedTimeline : (winner.timeline || []),
        isOverdue: isCompletedStatus(winner.status) ? false : Boolean(winner.isOverdue)
      });
    }
    return deduped;
  }

  async function reloadFromIndexedDB() {
    const [recs, ovs, qItems] = await Promise.all([
      window.LedgerDB.getAllRecords(),
      window.LedgerDB.getAllOverlays(),
      window.LedgerDB.getAllQueueItems()
    ]);
    allRecords = deduplicateRecordsByUuid(recs);
    overlaysMap = new Map(ovs.map((o) => [o.trackingUuid, o]));
    queueItems = qItems;
    populateFilterOptions();
    renderAll();
  }

  function populateFilterOptions() {
    const setOpts = (id, values, allLabel) => {
      const el = document.getElementById(id);
      if (!el) return;
      const prev = el.value;
      const sorted = Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
      el.innerHTML = `<option value="__ALL__">${allLabel}</option>` +
        sorted.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
      if (sorted.includes(prev)) el.value = prev;
    };
    setOpts('filterAgentSelect', allRecords.map((r) => r.agentName), 'All Agents');
    setOpts('filterWorkbookSelect', allRecords.map((r) => r.workbookFileName), 'All Workbooks');
    setOpts('filterStatusSelect', allRecords.map((r) => r.status), 'All Statuses');

    const allTags = [];
    overlaysMap.forEach((ov) => (ov.tags || []).forEach((t) => allTags.push(t)));
    setOpts('filterTagSelect', allTags, 'All Tags');
    const knownList = document.getElementById('knownTagsList');
    if (knownList) {
      knownList.innerHTML = Array.from(new Set(allTags))
        .sort()
        .map((t) => `<option value="${escapeHtml(t)}">`)
        .join('');
    }
  }

  function getFilteredRecords() {
    const ag = document.getElementById('filterAgentSelect')?.value || '__ALL__';
    const wb = document.getElementById('filterWorkbookSelect')?.value || '__ALL__';
    const st = document.getElementById('filterStatusSelect')?.value || '__ALL__';
    const tg = document.getElementById('filterTagSelect')?.value || '__ALL__';
    const flaggedOnly = Boolean(document.getElementById('chkFlaggedOnly')?.checked);
    const hideCompleted = Boolean(document.getElementById('chkHideCompleted')?.checked);
    const q = (document.getElementById('ledgerSearchInput')?.value || '').trim().toLowerCase();

    const filtered = allRecords.filter((r) => {
      if (activeCategoryFilter !== '__ALL__' && (r.actionCategory || 'Uncategorized') !== activeCategoryFilter) return false;
      if (ag !== '__ALL__' && r.agentName !== ag) return false;
      if (wb !== '__ALL__' && r.workbookFileName !== wb) return false;
      if (st !== '__ALL__' && r.status !== st) return false;
      if (hideCompleted && isCompletedStatus(r.status)) return false;

      const ov = overlaysMap.get(r.trackingUuid) || {};
      if (flaggedOnly && !ov.flagged) return false;
      if (tg !== '__ALL__' && !(ov.tags || []).includes(tg)) return false;

      if (q) {
        const hay = [
          r.subject, r.ticketNumber, r.brokerName, r.masterNumber, r.bidderNumber,
          r.requestedAction, r.actionCategory, r.yardNumber, r.lotNumbers, r.notes,
          r.status, r.agentName, r.workbookFileName, r.trackingUuid,
          (ov.tags || []).join(' '), ov.ledgerNote || ''
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const dirMult = sortState.dir === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      const va = String(a[sortState.field] || '').toLowerCase();
      const vb = String(b[sortState.field] || '').toLowerCase();
      return va.localeCompare(vb) * dirMult;
    });
    return filtered;
  }

  function renderKpisAndCategories() {
    const total = allRecords.length;
    const done = allRecords.filter((r) => isCompletedStatus(r.status)).length;
    const overdue = allRecords.filter((r) => (r.isOverdue || /overdue/i.test(r.status || '')) && !isCompletedStatus(r.status)).length;
    const waiting = allRecords.filter((r) => /waiting|on hold/i.test(r.status || '') && !isCompletedStatus(r.status)).length;
    const open = total - done;
    const flagged = allRecords.filter((r) => (overlaysMap.get(r.trackingUuid) || {}).flagged).length;
    const agentCount = new Set(allRecords.map((r) => r.agentUuid).filter(Boolean)).size;

    const kpiGrid = document.getElementById('kpiGrid');
    if (kpiGrid) {
      kpiGrid.innerHTML = `
        <div class="kpi-card"><span class="kpi-label">Total Records</span><span class="kpi-val">${total}</span></div>
        <div class="kpi-card"><span class="kpi-label">Open / Active</span><span class="kpi-val warn">${open}</span></div>
        <div class="kpi-card"><span class="kpi-label">Waiting / Hold</span><span class="kpi-val wait">${waiting}</span></div>
        <div class="kpi-card"><span class="kpi-label">Overdue</span><span class="kpi-val danger">${overdue}</span></div>
        <div class="kpi-card"><span class="kpi-label">Completed</span><span class="kpi-val good">${done}</span></div>
        <div class="kpi-card"><span class="kpi-label">Flagged</span><span class="kpi-val">${flagged}</span></div>
        <div class="kpi-card"><span class="kpi-label">Agents Synced</span><span class="kpi-val">${agentCount}</span></div>
      `;
    }

    const catBar = document.getElementById('categoryPillsBar');
    if (catBar) {
      if (total === 0) {
        catBar.style.display = 'none';
      } else {
        const counts = new Map();
        allRecords.forEach((r) => {
          const cat = r.actionCategory || 'Uncategorized';
          counts.set(cat, (counts.get(cat) || 0) + 1);
        });
        catBar.style.display = 'flex';
        catBar.innerHTML = [
          `<button type="button" class="cat-pill ${activeCategoryFilter === '__ALL__' ? 'active' : ''}" data-cat="__ALL__">All (${total})</button>`,
          ...Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([cat, cnt]) => `<button type="button" class="cat-pill ${activeCategoryFilter === cat ? 'active' : ''}" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)} (${cnt})</button>`)
        ].join('');
      }
    }
  }

  function getStatusBadgeClass(rec) {
    const st = String(rec.status || '');
    if (isCompletedStatus(st)) return 'badge-complete';
    if (rec.isOverdue || /overdue/i.test(st)) return 'badge-overdue';
    if (/waiting|on hold/i.test(st)) return 'badge-waiting';
    if (/progress/i.test(st)) return 'badge-progress';
    return 'badge-pending';
  }

  function renderLedgerTable() {
    const tbody = document.getElementById('ledgerTableBody');
    const pill = document.getElementById('ledgerCountPill');
    const clearBtn = document.getElementById('btnClearFilters');
    const filtered = getFilteredRecords();

    if (pill) pill.textContent = String(filtered.length);
    const hasFilter =
      activeCategoryFilter !== '__ALL__' ||
      document.getElementById('filterAgentSelect')?.value !== '__ALL__' ||
      document.getElementById('filterWorkbookSelect')?.value !== '__ALL__' ||
      document.getElementById('filterStatusSelect')?.value !== '__ALL__' ||
      document.getElementById('filterTagSelect')?.value !== '__ALL__' ||
      document.getElementById('chkFlaggedOnly')?.checked ||
      document.getElementById('chkHideCompleted')?.checked ||
      (document.getElementById('ledgerSearchInput')?.value || '').trim() !== '';
    if (clearBtn) clearBtn.style.display = hasFilter ? 'inline-block' : 'none';

    if (!tbody) return;
    if (filtered.length === 0) {
      if (!rootDirHandle && allRecords.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-cell">Click <strong>📂 Connect Team Root</strong> to index your <code>Trackers/</code>, <code>Agents/</code>, or <code>View Only/</code> worksheets into IndexedDB.</td></tr>';
      } else if (allRecords.length > 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-cell">No records match the current filters.</td></tr>';
      } else {
        const res = lastSyncResult || {};
        const diagParts = [
          `Scanned <strong>${escapeHtml(rootDirHandle?.name || 'folder')}</strong> (${escapeHtml(res.connectionMode || activeConnectionMode)})`,
          `${res.mirrorsTotal || 0} JSON mirror(s)`,
          `${res.workbooksTotal || 0} Excel workbook(s)`
        ];
        if (res.workbooksFailed) diagParts.push(`${res.workbooksFailed} workbook(s) could not be read`);
        if (res.foreignLedgerSkipped) diagParts.push(`${res.foreignLedgerSkipped} skipped due to Ledger ID mismatch`);

        let adoptBtnHtml = '';
        if (res.isTeamRoot && res.foreignLedgerSkipped > 0 && Array.isArray(res.foreignLedgerIds) && res.foreignLedgerIds.length > 0) {
          const targetId = res.foreignLedgerIds[0];
          adoptBtnHtml = `<div style="margin-top:0.65rem;"><button type="button" id="btnAdoptForeignLedger" class="btn-primary btn-sm" data-ledger-id="${escapeHtml(targetId)}">Adopt Existing Ledger ID (${escapeHtml(targetId.slice(0, 8))}...)</button></div>`;
        }
        const warnHtml = Array.isArray(res.warnings) && res.warnings.length > 0
          ? `<div class="subtitle" style="margin-top:0.4rem;">${escapeHtml(res.warnings[0])}</div>`
          : '';
        tbody.innerHTML = `<tr><td colspan="10" class="empty-cell">No worksheet records found. ${diagParts.join(' • ')}.${warnHtml}${adoptBtnHtml}</td></tr>`;
      }
      return;
    }

    tbody.innerHTML = filtered.slice(0, 600).map((r) => {
      const ov = overlaysMap.get(r.trackingUuid) || {};
      const rowClass = isCompletedStatus(r.status)
        ? 'row-completed'
        : (r.isOverdue || /overdue/i.test(r.status || '') ? 'row-overdue' : (/waiting|on hold/i.test(r.status || '') ? 'row-waiting' : ''));
      const tagsHtml = [
        ov.flagged ? '<span class="badge badge-overdue">🚩 Flagged</span>' : '',
        ...(ov.tags || []).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`)
      ].filter(Boolean).join(' ');
      const showCategorySub = r.actionCategory && r.actionCategory.toLowerCase() !== (r.requestedAction || '').toLowerCase();

      return `
        <tr class="${rowClass}">
          <td><strong>${escapeHtml(r.agentName || '—')}</strong></td>
          <td><span class="badge ${getStatusBadgeClass(r)}" title="${escapeHtml(r.status || 'Pending')}">${escapeHtml(r.status || 'Pending')}</span></td>
          <td>${tagsHtml || '<span class="subtitle">—</span>'}</td>
          <td><strong>${escapeHtml(r.subject || '(No Subject)')}</strong></td>
          <td><code>${escapeHtml(r.ticketNumber || '—')}</code></td>
          <td>${escapeHtml(r.brokerName || '—')}${r.masterNumber ? `<br><span class="subtitle">${escapeHtml(r.masterNumber)}</span>` : ''}</td>
          <td>${escapeHtml(r.requestedAction || '—')}${showCategorySub ? `<br><span class="subtitle">${escapeHtml(r.actionCategory)}</span>` : ''}</td>
          <td>${escapeHtml(r.yardNumber || '—')}${r.lotNumbers ? `<br><span class="subtitle">${escapeHtml(r.lotNumbers)}</span>` : ''}</td>
          <td>${Number(r.carryCount || 1)}d<br><span class="subtitle">${escapeHtml(r.lastSeenDate || '')}</span></td>
          <td><button type="button" class="btn-secondary btn-sm btn-inspect-rec" data-uuid="${escapeHtml(r.trackingUuid)}">Inspect / Tag</button></td>
        </tr>
      `;
    }).join('');
  }

  function renderQueueView() {
    const openCount = queueItems.filter((i) => !i.winningClaim).length;
    const badge = document.getElementById('queueOpenBadge');
    if (badge) {
      badge.textContent = String(openCount);
      badge.style.display = openCount > 0 ? 'inline-block' : 'none';
    }
    const statsLabel = document.getElementById('queueStatsLabel');
    if (statsLabel) {
      statsLabel.textContent = `${openCount} open • ${queueItems.length - openCount} claimed`;
    }

    const filterVal = document.getElementById('queueFilterSelect')?.value || 'open';
    const q = (document.getElementById('queueSearchInput')?.value || '').trim().toLowerCase();
    const list = queueItems.filter((item) => {
      if (filterVal === 'open' && item.winningClaim) return false;
      if (filterVal === 'claimed' && !item.winningClaim) return false;
      if (q) {
        const p = item.payload || {};
        const hay = [
          p.subject, p.ticketNumber, p.brokerName, p.masterNumber, p.lotNumbers, p.notes,
          item.winningClaim ? item.winningClaim.agentName : ''
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const container = document.getElementById('queueListContainer');
    if (!container) return;
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-cell">No shared queue items match this filter.</div>';
      return;
    }

    container.innerHTML = list.map((item) => {
      const p = item.payload || {};
      const claim = item.winningClaim;
      const claimPill = claim
        ? `<span class="badge badge-complete">Claimed by ${escapeHtml(claim.agentName || claim.agentUuid.slice(0, 8))}</span>`
        : '<span class="badge badge-pending">Open (Unclaimed)</span>';
      return `
        <div class="queue-card">
          <div class="queue-card-top">
            <div>
              <span class="badge">${escapeHtml(item.priority || 'Normal')}</span>
              ${claimPill}
              <strong>${escapeHtml(p.subject || '(No Subject)')}</strong>
            </div>
            <span class="subtitle">${escapeHtml(item.trackingUuid.slice(0, 8))}...</span>
          </div>
          <div class="subtitle">
            ${p.ticketNumber ? `Ticket: <strong>${escapeHtml(p.ticketNumber)}</strong> • ` : ''}
            ${p.brokerName ? `Broker: <strong>${escapeHtml(p.brokerName)}</strong> • ` : ''}
            ${p.yardNumber ? `Yard: <strong>${escapeHtml(p.yardNumber)}</strong> • ` : ''}
            ${p.lotNumbers ? `Lot(s): <strong>${escapeHtml(p.lotNumbers)}</strong>` : ''}
          </div>
          ${p.notes ? `<div>${escapeHtml(p.notes)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  function renderAll() {
    renderKpisAndCategories();
    renderLedgerTable();
    renderQueueView();
  }

  // --- Record Detail & Removable-Tag Overlays Modal ---
  function renderDraftOverlayTags() {
    const wrap = document.getElementById('overlayTagsChips');
    if (!wrap) return;
    if (draftOverlayTags.length === 0) {
      wrap.innerHTML = '<span class="subtitle">No tags yet. Add one below (all tags are 100% removable).</span>';
      return;
    }
    wrap.innerHTML = draftOverlayTags.map((t, idx) => `
      <span class="tag-chip">
        ${escapeHtml(t)}
        <button type="button" class="tag-remove-btn" data-remove-tag-idx="${idx}" title="Delete tag">✕</button>
      </span>
    `).join('');
  }

  function openRecordDetailModal(trackingUuid) {
    const rec = allRecords.find((r) => r.trackingUuid === trackingUuid);
    if (!rec) return;
    activeDetailTrackingUuid = trackingUuid;
    const ov = overlaysMap.get(trackingUuid) || { tags: [], flagged: false, ledgerNote: '' };
    draftOverlayTags = Array.isArray(ov.tags) ? [...ov.tags] : [];

    document.getElementById('detailSubjectTitle').textContent = rec.subject || '(No Subject)';
    document.getElementById('detailSubtitle').textContent =
      `Agent: ${rec.agentName} • Workbook: ${rec.workbookFileName} • ID: ${rec.trackingUuid}`;
    const stBadge = document.getElementById('detailStatusBadge');
    stBadge.textContent = rec.status || 'Pending';
    stBadge.className = `badge ${getStatusBadgeClass(rec)}`;

    const sourceLabel = rec.sourceType === 'xlsx'
      ? `Excel Workbook (${rec.sourceFile || rec.workbookFileName || 'xlsx'})`
      : `JSON Mirror (${rec.sourceFile || 'mirror'})`;
    document.getElementById('detailMetaList').innerHTML = `
      <dt>Ticket #</dt><dd>${escapeHtml(rec.ticketNumber || '—')}</dd>
      <dt>Broker / Master</dt><dd>${escapeHtml(rec.brokerName || '—')} (${escapeHtml(rec.masterNumber || '—')})</dd>
      <dt>Action / Category</dt><dd>${escapeHtml(rec.requestedAction || '—')} → ${escapeHtml(rec.actionCategory || '—')}</dd>
      <dt>Yard / Lot(s)</dt><dd>${escapeHtml(rec.yardNumber || '—')} / ${escapeHtml(rec.lotNumbers || '—')}</dd>
      <dt>First → Last Seen</dt><dd>${escapeHtml(rec.firstSeenDate || '—')} → ${escapeHtml(rec.lastSeenDate || '—')} (${Number(rec.carryCount || 1)}d)</dd>
      <dt>Source</dt><dd>${escapeHtml(sourceLabel)}</dd>
    `;

    const timelineEl = document.getElementById('detailTimelineList');
    const timeline = Array.isArray(rec.timeline) ? rec.timeline : [];
    timelineEl.innerHTML = timeline.length === 0
      ? '<div class="subtitle">No daily timeline entries recorded.</div>'
      : timeline.map((t) => `
          <div class="timeline-item">
            <strong>${escapeHtml(t.date || t.sheetName)}</strong> • <em>${escapeHtml(t.status || '')}</em> (Row ${t.rowNumber || '?'})<br>
            <span>${escapeHtml(t.notes || '—')}</span>
          </div>
        `).join('');

    document.getElementById('overlayFlaggedCheck').checked = Boolean(ov.flagged);
    document.getElementById('overlayNoteInput').value = ov.ledgerNote || '';
    document.getElementById('overlayNewTagInput').value = '';
    renderDraftOverlayTags();
    document.getElementById('recordDetailModal').classList.add('open');
  }

  document.getElementById('ledgerTableBody')?.addEventListener('click', async (e) => {
    const adoptBtn = e.target.closest('#btnAdoptForeignLedger');
    if (adoptBtn && adoptBtn.dataset.ledgerId && rootDirHandle) {
      try {
        await window.LedgerSync.adoptLedgerId(rootDirHandle, actorIdentity, adoptBtn.dataset.ledgerId);
        await runSync({ forceFullRebuild: true });
      } catch (err) {
        showToast('Could not adopt Ledger ID: ' + err.message, 'danger');
      }
      return;
    }
    const btn = e.target.closest('.btn-inspect-rec');
    if (btn && btn.dataset.uuid) openRecordDetailModal(btn.dataset.uuid);
  });

  document.getElementById('overlayTagsChips')?.addEventListener('click', (e) => {
    const rm = e.target.closest('.tag-remove-btn');
    if (!rm) return;
    const idx = parseInt(rm.dataset.removeTagIdx, 10);
    if (!isNaN(idx)) {
      draftOverlayTags.splice(idx, 1);
      renderDraftOverlayTags();
    }
  });

  function addDraftTagFromInput() {
    const input = document.getElementById('overlayNewTagInput');
    const val = (input?.value || '').trim();
    if (!val) return;
    if (!draftOverlayTags.some((t) => t.toLowerCase() === val.toLowerCase())) {
      draftOverlayTags.push(val);
      renderDraftOverlayTags();
    }
    input.value = '';
  }

  document.getElementById('btnAddOverlayTag')?.addEventListener('click', addDraftTagFromInput);
  document.getElementById('overlayNewTagInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addDraftTagFromInput();
    }
  });

  document.getElementById('btnSaveOverlay')?.addEventListener('click', async () => {
    if (!rootDirHandle || !activeDetailTrackingUuid) return;
    if (activeConnectionMode !== 'team-root') {
      showToast('Connect the parent Team Root folder (e.g., Trackers/) to save _Ledger/ overlays.', 'warning');
      return;
    }
    try {
      await window.LedgerSync.saveActorOverlay(rootDirHandle, activeManifest, actorIdentity, activeDetailTrackingUuid, {
        tags: draftOverlayTags,
        flagged: Boolean(document.getElementById('overlayFlaggedCheck').checked),
        ledgerNote: document.getElementById('overlayNoteInput').value
      });
      await reloadFromIndexedDB();
      document.getElementById('recordDetailModal').classList.remove('open');
      showToast('Saved ledger overlay to _Ledger/.', 'success');
    } catch (err) {
      showToast('Could not save overlay: ' + err.message, 'danger');
    }
  });

  document.getElementById('btnCloseRecordDetail')?.addEventListener('click', () => {
    document.getElementById('recordDetailModal').classList.remove('open');
  });

  // --- Sync & Connection Lifecycle ---
  async function runSync({ forceFullRebuild = false, silent = false } = {}) {
    if (!rootDirHandle) return;
    setSyncStatus('Syncing...', 'warning');
    try {
      const res = await window.LedgerSync.syncFromTeamRoot(rootDirHandle, actorIdentity, { forceFullRebuild });
      lastSyncResult = res;
      activeConnectionMode = res.connectionMode || 'team-root';
      activeManifest = res.manifest;

      const chip = document.getElementById('ledgerBindingChip');
      if (chip) {
        if (res.isTeamRoot) {
          const lid = activeManifest.ledgerId ? `${activeManifest.ledgerId.slice(0, 8)}...` : 'unbound';
          chip.textContent = `${activeManifest.ledgerName || 'Ledger'} (${lid})`;
          chip.title = 'Explicit Ledger Binding ID';
          chip.classList.add('bound');
        } else {
          chip.textContent = `Direct Scan: ${rootDirHandle.name}`;
          chip.title = 'Subfolder direct scan (read-only). Connect the parent Team Root folder (e.g., Trackers/) for _Ledger/ overlays and _SharedQueue/.';
          chip.classList.remove('bound');
        }
      }

      await reloadFromIndexedDB();
      document.getElementById('btnSyncNow').disabled = false;
      document.getElementById('btnExportMenu').disabled = false;
      document.getElementById('btnRebuildIdb').disabled = false;

      const telemetryParts = [];
      if (res.mirrorsTotal > 0) telemetryParts.push(`${res.mirrorsTotal} mirror(s)`);
      if (res.workbooksTotal > 0) telemetryParts.push(`${res.workbooksTotal} workbook(s)`);
      if (telemetryParts.length === 0) telemetryParts.push('0 sources');
      telemetryParts.push(`${allRecords.length} records`);
      document.getElementById('statusTelemetry').textContent = telemetryParts.join(' • ');

      document.getElementById('statusLastSync').textContent =
        `Synced at ${new Date().toLocaleTimeString()}`;
      setSyncStatus(res.isTeamRoot ? `Synced: ${rootDirHandle.name}` : `Synced (Direct): ${rootDirHandle.name}`, 'ready');

      if (!silent) {
        const updatedCount = (res.mirrorsParsed || 0) + (res.workbooksParsed || 0);
        const cachedCount = (res.mirrorsSkippedUnchanged || 0) + (res.workbooksSkippedUnchanged || 0);
        let msg = `Synced ${allRecords.length} record(s) from ${res.mirrorsTotal || 0} mirror(s) & ${res.workbooksTotal || 0} workbook(s) (${updatedCount} updated, ${cachedCount} cached).`;
        if (res.foreignLedgerSkipped > 0) {
          msg += ` ${res.foreignLedgerSkipped} skipped (Ledger ID mismatch).`;
        }
        if (res.workbooksFailed > 0) {
          msg += ` ${res.workbooksFailed} workbook(s) could not be read.`;
        }
        const hasIssues = res.foreignLedgerSkipped > 0 || res.workbooksFailed > 0;
        showToast(msg, hasIssues ? 'warning' : 'success');
      }
    } catch (err) {
      setSyncStatus('Sync Error', 'warning');
      showToast('Sync failed: ' + err.message, 'danger');
    }
  }

  function scheduleAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    const sec = parseInt(document.getElementById('autoRefreshSelect')?.value || '180', 10);
    localStorage.setItem(AUTO_REFRESH_KEY, String(sec));
    if (sec > 0 && rootDirHandle) {
      autoRefreshTimer = setInterval(() => runSync({ silent: true }), sec * 1000);
    }
  }

  async function ensureActorNameOnFirstConnect() {
    if (actorIdentity.actorName) return;
    document.getElementById('actorNameInput').value = '';
    document.getElementById('actorUuidInput').value = actorIdentity.actorUuid;
    document.getElementById('actorIdentityModal').classList.add('open');
  }

  async function connectTeamRootHandle(handle) {
    rootDirHandle = handle;
    cachedRootHandle = handle;
    await window.LedgerDB.setHandle('teamRootHandle', handle);
    document.getElementById('btnReconnectRoot').style.display = 'none';
    await runSync();
    scheduleAutoRefresh();
    await ensureActorNameOnFirstConnect();
  }

  document.getElementById('btnConnectRoot')?.addEventListener('click', async () => {
    try {
      let handle;
      try {
        handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (rwErr) {
        if (rwErr && rwErr.name === 'AbortError') throw rwErr;
        handle = await window.showDirectoryPicker({ mode: 'read' });
      }
      await connectTeamRootHandle(handle);
    } catch (err) {
      if (err.name !== 'AbortError') showToast(err.message, 'danger');
    }
  });

  document.getElementById('btnReconnectRoot')?.addEventListener('click', async () => {
    if (!cachedRootHandle) return;
    try {
      let perm = await cachedRootHandle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
      if (perm !== 'granted') {
        perm = await cachedRootHandle.requestPermission({ mode: 'read' });
      }
      if (perm === 'granted') {
        await connectTeamRootHandle(cachedRootHandle);
      }
    } catch (err) {
      showToast(err.message, 'danger');
    }
  });

  document.getElementById('btnSyncNow')?.addEventListener('click', () => runSync());
  document.getElementById('btnRebuildIdb')?.addEventListener('click', () => {
    closeMenus();
    runSync({ forceFullRebuild: true });
  });
  document.getElementById('autoRefreshSelect')?.addEventListener('change', scheduleAutoRefresh);

  // --- Shared Request Queue Events ---
  document.getElementById('tabLedgerView')?.addEventListener('click', () => {
    document.getElementById('tabLedgerView').classList.add('active');
    document.getElementById('tabQueueView').classList.remove('active');
    document.getElementById('ledgerViewSection').style.display = 'flex';
    document.getElementById('queueViewSection').style.display = 'none';
  });
  document.getElementById('tabQueueView')?.addEventListener('click', () => {
    document.getElementById('tabQueueView').classList.add('active');
    document.getElementById('tabLedgerView').classList.remove('active');
    document.getElementById('ledgerViewSection').style.display = 'none';
    document.getElementById('queueViewSection').style.display = 'flex';
  });

  const qPostForm = document.getElementById('queuePostForm');
  document.getElementById('btnToggleQueuePostForm')?.addEventListener('click', () => {
    if (!rootDirHandle) return showToast('Connect Team Root first.', 'warning');
    if (activeConnectionMode !== 'team-root') {
      return showToast('Connect the parent Team Root folder (e.g., Trackers/) to post tickets to _SharedQueue/.', 'warning');
    }
    qPostForm.style.display = qPostForm.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btnCancelQueuePost')?.addEventListener('click', () => {
    qPostForm.reset();
    qPostForm.style.display = 'none';
  });
  qPostForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!rootDirHandle) return;
    if (activeConnectionMode !== 'team-root') {
      showToast('Connect the parent Team Root folder (e.g., Trackers/) to post tickets to _SharedQueue/.', 'warning');
      return;
    }
    try {
      await window.LedgerSync.publishSharedQueueItem(rootDirHandle, activeManifest, actorIdentity, {
        subject: document.getElementById('qSubject').value,
        ticketNumber: document.getElementById('qTicket').value,
        priority: document.getElementById('qPriority').value,
        brokerName: document.getElementById('qBroker').value,
        masterNumber: document.getElementById('qMaster').value,
        bidderNumber: document.getElementById('qBidder').value,
        requestedAction: document.getElementById('qAction').value,
        yardNumber: document.getElementById('qYard').value,
        lotNumbers: document.getElementById('qLots').value,
        notes: document.getElementById('qNotes').value
      });
      qPostForm.reset();
      qPostForm.style.display = 'none';
      await runSync({ silent: true });
      showToast('Published ticket to _SharedQueue/.', 'success');
    } catch (err) {
      showToast('Failed to publish ticket: ' + err.message, 'danger');
    }
  });

  document.getElementById('queueFilterSelect')?.addEventListener('change', renderQueueView);
  document.getElementById('queueSearchInput')?.addEventListener('input', renderQueueView);

  // --- Filters, Sorting & Exports ---
  ['filterAgentSelect', 'filterWorkbookSelect', 'filterStatusSelect', 'filterTagSelect', 'chkFlaggedOnly', 'chkHideCompleted']
    .forEach((id) => document.getElementById(id)?.addEventListener('change', renderLedgerTable));
  document.getElementById('ledgerSearchInput')?.addEventListener('input', renderLedgerTable);
  document.getElementById('categoryPillsBar')?.addEventListener('click', (e) => {
    const pill = e.target.closest('.cat-pill');
    if (!pill) return;
    activeCategoryFilter = pill.dataset.cat || '__ALL__';
    renderKpisAndCategories();
    renderLedgerTable();
  });
  document.getElementById('btnClearFilters')?.addEventListener('click', () => {
    activeCategoryFilter = '__ALL__';
    ['filterAgentSelect', 'filterWorkbookSelect', 'filterStatusSelect', 'filterTagSelect']
      .forEach((id) => { const el = document.getElementById(id); if (el) el.value = '__ALL__'; });
    document.getElementById('chkFlaggedOnly').checked = false;
    document.getElementById('chkHideCompleted').checked = false;
    document.getElementById('ledgerSearchInput').value = '';
    renderAll();
  });
  document.getElementById('ledgerTableHead')?.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th || !th.dataset.sort) return;
    if (sortState.field === th.dataset.sort) {
      sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      sortState = { field: th.dataset.sort, dir: 'asc' };
    }
    renderLedgerTable();
  });

  const exportIncludeMeta = () => Boolean(document.getElementById('chkExportIncludeMeta')?.checked);
  document.getElementById('btnExportFilteredCsv')?.addEventListener('click', () => {
    closeMenus();
    if (!window.LedgerExport.exportCsv(getFilteredRecords(), overlaysMap, { scopeSlug: 'filtered', includeMeta: exportIncludeMeta() })) {
      showToast('No filtered rows to export.', 'warning');
    }
  });
  document.getElementById('btnExportFullCsv')?.addEventListener('click', () => {
    closeMenus();
    if (!window.LedgerExport.exportCsv(allRecords, overlaysMap, { scopeSlug: 'full-ledger', includeMeta: exportIncludeMeta() })) {
      showToast('No records to export.', 'warning');
    }
  });
  document.getElementById('btnExportFilteredXlsx')?.addEventListener('click', async () => {
    closeMenus();
    try {
      await window.LedgerExport.exportXlsx(getFilteredRecords(), overlaysMap, { scopeSlug: 'filtered', includeMeta: exportIncludeMeta() });
    } catch (err) {
      showToast(err.message, 'danger');
    }
  });
  document.getElementById('btnExportFullXlsx')?.addEventListener('click', async () => {
    closeMenus();
    try {
      await window.LedgerExport.exportXlsx(allRecords, overlaysMap, { scopeSlug: 'full-ledger', includeMeta: exportIncludeMeta() });
    } catch (err) {
      showToast(err.message, 'danger');
    }
  });

  // --- Actor Identity Modal ---
  document.getElementById('btnActorIdentity')?.addEventListener('click', () => {
    closeMenus();
    document.getElementById('actorNameInput').value = actorIdentity.actorName || '';
    document.getElementById('actorUuidInput').value = actorIdentity.actorUuid || '';
    document.getElementById('actorIdentityModal').classList.add('open');
  });
  document.getElementById('btnCloseActorIdentity')?.addEventListener('click', () => {
    document.getElementById('actorIdentityModal').classList.remove('open');
  });
  document.getElementById('actorIdentityForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    saveActorIdentity({ actorName: document.getElementById('actorNameInput').value });
    document.getElementById('actorIdentityModal').classList.remove('open');
    showToast(`Saved Actor Identity: ${actorIdentity.actorName}`, 'success');
  });

  // --- Startup Boot ---
  (async () => {
    saveActorIdentity({});
    const savedRefresh = localStorage.getItem(AUTO_REFRESH_KEY);
    if (savedRefresh && document.getElementById('autoRefreshSelect')) {
      document.getElementById('autoRefreshSelect').value = savedRefresh;
    }

    // Hydrate cached records from IndexedDB immediately even before reconnecting folder
    await reloadFromIndexedDB();

    const savedRoot = await window.LedgerDB.getHandle('teamRootHandle').catch(() => null);
    if (savedRoot) {
      cachedRootHandle = savedRoot;
      const perm = await savedRoot.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
      if (perm === 'granted') {
        await connectTeamRootHandle(savedRoot);
      } else {
        const btnRec = document.getElementById('btnReconnectRoot');
        if (btnRec) {
          btnRec.textContent = `🔄 Reconnect (${savedRoot.name})`;
          btnRec.style.display = 'inline-block';
        }
      }
    }

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  })();
})();
