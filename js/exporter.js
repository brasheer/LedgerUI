// ============================================================================
// exporter.js — RFC-4180 UTF-8 BOM CSV & Styled Multi-Tab ExcelJS XLSX Exports
// ============================================================================
(() => {
  function escapeCsvCell(val) {
    const str = String(val === null || val === undefined ? '' : val);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function todayStamp() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}-${dd}-${d.getFullYear()}`;
  }

  function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function isCompletedStatus(status) {
    return /^(complete|completed|closed|done|resolved)$/i.test(String(status || '').trim());
  }

  function buildExportHeaders(includeMeta) {
    const base = [
      'Subject',
      'Ticket Number',
      'Broker Name',
      'Master #',
      'Bidder #',
      'Requested Action',
      'Action Category',
      'Yard #',
      'Lot Numbers',
      'Action Notes',
      'Status',
      'First Seen',
      'Last Seen',
      'Overdue'
    ];
    if (includeMeta) {
      base.push(
        'Agent Name',
        'Workbook',
        'Carries',
        'Flagged',
        'Ledger Tags',
        'Ledger Note',
        'Tracking ID (UUIDv4)'
      );
    }
    return base;
  }

  function buildExportRowValues(rec, overlaysMap, includeMeta) {
    const ov = overlaysMap.get(rec.trackingUuid) || {};
    const base = [
      rec.subject || '',
      rec.ticketNumber || '',
      rec.brokerName || '',
      rec.masterNumber || '',
      rec.bidderNumber || '',
      rec.requestedAction || '',
      rec.actionCategory || '',
      rec.yardNumber || '',
      rec.lotNumbers || '',
      rec.notes || '',
      rec.status || '',
      rec.firstSeenDate || '',
      rec.lastSeenDate || '',
      rec.isOverdue ? 'Yes' : 'No'
    ];
    if (includeMeta) {
      base.push(
        rec.agentName || '',
        rec.workbookFileName || '',
        Number(rec.carryCount || 1),
        ov.flagged ? 'Yes' : 'No',
        Array.isArray(ov.tags) ? ov.tags.join(', ') : '',
        ov.ledgerNote || '',
        rec.trackingUuid || ''
      );
    }
    return base;
  }

  function exportCsv(rows, overlaysMap, { scopeSlug = 'filtered', includeMeta = true } = {}) {
    if (!rows || rows.length === 0) return false;
    const headers = buildExportHeaders(includeMeta);
    const lines = [
      headers.map(escapeCsvCell).join(','),
      ...rows.map((r) => buildExportRowValues(r, overlaysMap, includeMeta).map(escapeCsvCell).join(','))
    ];
    const csvContent = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    triggerDownload(blob, `LedgerUI_${scopeSlug}_${todayStamp()}.csv`);
    return true;
  }

  function styleHeaderRow(ws, headers, widths) {
    const r1 = ws.getRow(1);
    r1.height = 22;
    headers.forEach((h, idx) => {
      ws.getColumn(idx + 1).width = widths[idx] || 18;
      const cell = r1.getCell(idx + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFF8FAFC' }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    });
    r1.commit();
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  async function exportXlsx(rows, overlaysMap, { scopeSlug = 'filtered', includeMeta = true } = {}) {
    if (!rows || rows.length === 0) return false;
    if (typeof ExcelJS === 'undefined') {
      throw new Error('ExcelJS is unavailable. Connect online once so the PWA cache can store ExcelJS.');
    }

    const wb = new ExcelJS.Workbook();

    // Sheet 1: Master Ledger
    const wsMaster = wb.addWorksheet('Master Ledger');
    const headers = buildExportHeaders(includeMeta);
    const widths = includeMeta
      ? [36, 18, 24, 14, 14, 22, 20, 10, 22, 42, 15, 13, 13, 10, 20, 32, 10, 10, 24, 30, 38]
      : [36, 18, 24, 14, 14, 22, 20, 10, 22, 42, 15, 13, 13, 10];
    styleHeaderRow(wsMaster, headers, widths);
    rows.forEach((rec, i) => {
      const r = wsMaster.getRow(i + 2);
      buildExportRowValues(rec, overlaysMap, includeMeta).forEach((val, colIdx) => {
        r.getCell(colIdx + 1).value = val;
      });
      r.commit();
    });

    // Sheet 2: KPI & Category Summary
    const wsCat = wb.addWorksheet('KPI & Category Summary');
    styleHeaderRow(wsCat, ['Action Category', 'Total Requests', 'Open / Active', 'Overdue', 'Completed'], [28, 16, 16, 14, 16]);
    const catMap = new Map();
    rows.forEach((rec) => {
      const cat = rec.actionCategory || 'Uncategorized';
      const entry = catMap.get(cat) || { total: 0, open: 0, overdue: 0, done: 0 };
      entry.total++;
      if (isCompletedStatus(rec.status)) entry.done++;
      else entry.open++;
      if (rec.isOverdue && !isCompletedStatus(rec.status)) entry.overdue++;
      catMap.set(cat, entry);
    });
    Array.from(catMap.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .forEach(([cat, st], idx) => {
        const r = wsCat.getRow(idx + 2);
        r.getCell(1).value = cat;
        r.getCell(2).value = st.total;
        r.getCell(3).value = st.open;
        r.getCell(4).value = st.overdue;
        r.getCell(5).value = st.done;
        r.commit();
      });

    // Sheet 3: Agent Breakdown
    const wsAgent = wb.addWorksheet('Agent Breakdown');
    styleHeaderRow(wsAgent, ['Agent Name', 'Total Requests', 'Open / Active', 'Overdue', 'Completed', 'Completion %'], [26, 16, 16, 14, 16, 15]);
    const agentMap = new Map();
    rows.forEach((rec) => {
      const ag = rec.agentName || 'Unnamed Agent';
      const entry = agentMap.get(ag) || { total: 0, open: 0, overdue: 0, done: 0 };
      entry.total++;
      if (isCompletedStatus(rec.status)) entry.done++;
      else entry.open++;
      if (rec.isOverdue && !isCompletedStatus(rec.status)) entry.overdue++;
      agentMap.set(ag, entry);
    });
    Array.from(agentMap.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .forEach(([ag, st], idx) => {
        const pct = st.total > 0 ? Math.round((st.done / st.total) * 100) : 0;
        const r = wsAgent.getRow(idx + 2);
        r.getCell(1).value = ag;
        r.getCell(2).value = st.total;
        r.getCell(3).value = st.open;
        r.getCell(4).value = st.overdue;
        r.getCell(5).value = st.done;
        r.getCell(6).value = `${pct}%`;
        r.commit();
      });

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    triggerDownload(blob, `LedgerUI_${scopeSlug}_${todayStamp()}.xlsx`);
    return true;
  }

  window.LedgerExport = {
    exportCsv,
    exportXlsx
  };
})();
