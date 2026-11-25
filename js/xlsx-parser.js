// ============================================================================
// xlsx-parser.js — Client-Side TrackerUI .xlsx Workbook Parser & Aggregator
// ============================================================================
(() => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const VIEW_ONLY_NAME_RE = /(\(|\[|\b|[-_])view[\s_-]*only(\)|\]|\b|[-_])/i;
  const VIEW_ONLY_STRIP_RE = /(?:\s*[\(\[]\s*view[\s_-]*only\s*[\)\]]|\s*[-_]\s*view[\s_-]*only|\bview[\s_-]*only\b)/gi;

  const GENERIC_DIR_RE = /^(_?view[\s_-]*only(?:[\s_-]*json)?|agents?|trackers?|active|current|workbooks?|monthly|spreadsheets?|excel|files|\d{4})$/i;
  const GENERIC_TRACKER_PREFIX_RE = /^(agent\s+)?(bidder\s+support\s+)?(daily\s+|monthly\s+)?tracker/i;
  const MONTH_YEAR_RE = /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(\s+\d{2,4})?$/i;

  const SKIP_SHEET_RE = /^(trackerconfig|scratch|scratchpad|scratch\s*sheet|notes|summary|dashboard|kpi|overview|template|instructions|config|settings|meta|lookup|lookups|lists|dropdowns|validation(\s*lists?)?|master\s*accounts?|reference(\s*data)?|agent\s*breakdown|kpi\s*&\s*category\s*summary)$/i;

  const MONTH_MAP = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12
  };

  const HEADER_PATTERNS = {
    subject: /^(?:email(?:\/call)?\s*subject(?:\s*sent)?|inbound\s*subject|lkq\s*email\s*subject|call\s*subject|subject|title|request(?:\s*subject)?|summary|description)$/i,
    ticketNumber: /^(?:ticket|case)(?:\s*(?:#|number|no\.?|num|id))?$/i,
    brokerName: /^(?:broker|client|customer)(?:\s*name)?$/i,
    masterNumber: /^(?:broker\s*)?master(?:\s*(?:#|number|no\.?|num|id))?$/i,
    bidderNumber: /^(?:(?:broker\s*)?bidder|member|buyer)(?:\s*(?:#|number|no\.?|num|id))?$/i,
    requestedAction: /^(?:requested\s*action|action\s*requested|action|request\s*type|task)$/i,
    actionCategory: /^(?:action\s*)?category$|^type$/i,
    yardNumber: /^(?:yard(?:\s*(?:#|number|no\.?|num|location))?|location)$/i,
    lotNumbers: /^(?:lot(?:\s*(?:#|s|#s|number|numbers|no\.?|num))?|item\s*(?:#|number|numbers|s)?)$/i,
    notes: /^(?:action\s*(?:taken\s*[\/&-]\s*)?notes?|action\s*taken|notes?(?:\s*[\/&-]\s*comments?)?|comments?|updates?|remarks?)$/i,
    status: /^(?:status|current\s*status|request\s*status|state)$/i,
    trackingUuid: /^(?:tracking(?:\s*(?:id|uuid|#))?|uuid|record\s*(?:id|uuid))$/i,
    parentTrackingUuid: /^parent(?:\s*tracking)?(?:\s*(?:id|uuid))?$/i,
    agentName: /^(?:agent(?:\s*name)?|assignee|owner)$/i,
    firstSeenDate: /^first\s*seen|^created(?:\s*date)?$/i,
    lastSeenDate: /^last\s*seen|^updated(?:\s*date)?$/i,
    overdue: /^overdue$/i
  };

  function slugify(str, maxLen = 64) {
    return String(str || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLen)
      .replace(/-+$/g, '');
  }

  function isViewOnlyFileName(fileName) {
    return VIEW_ONLY_NAME_RE.test(String(fileName || ''));
  }

  function stripExtension(fileName) {
    return String(fileName || '').replace(/\.xlsx?$/i, '');
  }

  function normalizeWorkbookSlug(fileName) {
    const stem = stripExtension(fileName).replace(VIEW_ONLY_STRIP_RE, ' ').trim();
    return slugify(stem || stripExtension(fileName) || 'workbook', 64) || 'workbook';
  }

  function normalizeAgentSlug(agentName) {
    return slugify(agentName || '', 48) || 'unnamed-agent';
  }

  function stripAgentPrefixFromSlug(workbookSlug, agentSlug) {
    const wb = String(workbookSlug || '');
    const ag = String(agentSlug || '');
    if (!ag || ag === 'unnamed-agent') return wb;
    if (wb === ag) return 'workbook';
    if (wb.startsWith(`${ag}-`)) return wb.slice(ag.length + 1) || 'workbook';
    return wb;
  }

  function extractCellText(val) {
    if (val === null || val === undefined) return '';
    if (val instanceof Date) {
      if (isNaN(val.getTime())) return '';
      const mm = String(val.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(val.getUTCDate()).padStart(2, '0');
      const yyyy = val.getUTCFullYear();
      return `${mm}-${dd}-${yyyy}`;
    }
    if (typeof val === 'object') {
      if (Array.isArray(val.richText)) {
        return val.richText.map((part) => (part && part.text ? String(part.text) : '')).join('').trim();
      }
      if ('formula' in val || 'sharedFormula' in val) {
        return 'result' in val ? extractCellText(val.result) : '';
      }
      if ('text' in val || 'hyperlink' in val) {
        return String(val.text || val.hyperlink || '').trim();
      }
      if ('error' in val) {
        return '';
      }
      return '';
    }
    const str = String(val).trim();
    return str === '[object Object]' ? '' : str;
  }

  function stableHashId(input) {
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
    return `xlsx-rec-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
  }

  function formatMmDdYyyy(month, day, year) {
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const yyyy = String(year);
    return `${mm}-${dd}-${yyyy}`;
  }

  function parseSheetDate(sheetName, fallbackYear = new Date().getFullYear()) {
    const raw = String(sheetName || '').trim();
    if (!raw) return null;

    // YYYY-MM-DD (or / _ .)
    let m = raw.match(/^(\d{4})[-_./](\d{1,2})[-_./](\d{1,2})$/);
    if (m) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const d = parseInt(m[3], 10);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return { dateStr: formatMmDdYyyy(mo, d, y), sortKey: Date.UTC(y, mo - 1, d) };
      }
    }

    // MM-DD-YYYY or MM-DD-YY (supports - _ . /)
    m = raw.match(/^(\d{1,2})[-_./](\d{1,2})[-_./](\d{2}|\d{4})$/);
    if (m) {
      const mo = parseInt(m[1], 10);
      const d = parseInt(m[2], 10);
      let y = parseInt(m[3], 10);
      if (m[3].length === 2) y += y >= 70 ? 1900 : 2000;
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return { dateStr: formatMmDdYyyy(mo, d, y), sortKey: Date.UTC(y, mo - 1, d) };
      }
    }

    // MM-DD (no year)
    m = raw.match(/^(\d{1,2})[-_./](\d{1,2})$/);
    if (m) {
      const mo = parseInt(m[1], 10);
      const d = parseInt(m[2], 10);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return { dateStr: formatMmDdYyyy(mo, d, fallbackYear), sortKey: Date.UTC(fallbackYear, mo - 1, d) };
      }
    }

    // MMM DD[, YYYY]
    m = raw.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{2,4}))?$/);
    if (m) {
      const mo = MONTH_MAP[m[1].toLowerCase()];
      const d = parseInt(m[2], 10);
      let y = m[3] ? parseInt(m[3], 10) : fallbackYear;
      if (m[3] && m[3].length === 2) y += y >= 70 ? 1900 : 2000;
      if (mo && d >= 1 && d <= 31) {
        return { dateStr: formatMmDdYyyy(mo, d, y), sortKey: Date.UTC(y, mo - 1, d) };
      }
    }

    return null;
  }

  function inferAgentNameFromPath(fileName, pathSegments = [], configAgentName = '') {
    const cfgName = String(configAgentName || '').trim();
    if (cfgName) return cfgName;

    const segs = Array.isArray(pathSegments) ? pathSegments : [];
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = String(segs[i] || '').trim();
      if (!seg || GENERIC_DIR_RE.test(seg)) continue;
      return seg;
    }

    const cleanedStem = stripExtension(fileName).replace(VIEW_ONLY_STRIP_RE, ' ').trim();
    const parts = cleanedStem.split(/\s+[-–]\s+/);
    if (parts.length > 1) {
      const prefix = parts[0].trim();
      if (prefix && !GENERIC_TRACKER_PREFIX_RE.test(prefix) && !MONTH_YEAR_RE.test(prefix)) {
        return prefix;
      }
    }

    if (cleanedStem && !GENERIC_TRACKER_PREFIX_RE.test(cleanedStem) && !MONTH_YEAR_RE.test(cleanedStem)) {
      return cleanedStem;
    }
    return 'Unnamed Agent';
  }

  function inferAgentFromPath(fileName, pathSegments = [], configAgentName = '') {
    const agentName = inferAgentNameFromPath(fileName, pathSegments, configAgentName);
    const agentSlug = normalizeAgentSlug(agentName);
    const workbookSlug = normalizeWorkbookSlug(fileName);
    const dedupKey = `${agentSlug}::${stripAgentPrefixFromSlug(workbookSlug, agentSlug)}`;
    return { agentName, agentSlug, workbookSlug, dedupKey };
  }

  function readTrackerConfig(workbook) {
    const result = {
      ledgerId: '',
      agentUuid: '',
      agentName: '',
      role: '',
      profileName: '',
      schemaMode: '',
      columns: []
    };
    if (!workbook || !Array.isArray(workbook.worksheets)) return result;

    const cfgSheet = workbook.worksheets.find((ws) => ws && /^trackerconfig$/i.test(String(ws.name || '').trim()));
    if (!cfgSheet) return result;

    const assignKeyVal = (keyRaw, valRaw) => {
      const key = String(keyRaw || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      const val = String(valRaw || '').trim();
      if (!key) return;
      if (key === 'ledgerid' && UUID_RE.test(val)) result.ledgerId = val.toLowerCase();
      else if (key === 'agentuuid' && UUID_RE.test(val)) result.agentUuid = val.toLowerCase();
      else if (key === 'agentname' && val) result.agentName = val;
      else if ((key === 'role' || key === 'agentrole') && val) result.role = val;
      else if (key === 'profilename' && val) result.profileName = val;
      else if (key === 'schemamode' && val) result.schemaMode = val;
      else if (key === 'columns' && val) {
        try {
          const parsedCols = JSON.parse(val);
          if (Array.isArray(parsedCols)) result.columns = parsedCols;
        } catch (_) { /* ignore malformed columns JSON */ }
      }
    };

    const maxRows = Math.min(cfgSheet.rowCount || 50, 100);
    for (let r = 1; r <= maxRows; r++) {
      const row = cfgSheet.getRow(r);
      if (!row) continue;
      const c1 = extractCellText(row.getCell(1).value);
      const c2 = extractCellText(row.getCell(2).value);

      if (c1.startsWith('{') && c1.endsWith('}')) {
        try {
          const blob = JSON.parse(c1);
          if (blob && typeof blob === 'object') {
            Object.entries(blob).forEach(([k, v]) => {
              assignKeyVal(k, typeof v === 'object' ? JSON.stringify(v) : v);
            });
          }
        } catch (_) { /* ignore malformed JSON cell */ }
      } else if (c2.startsWith('{') && c2.endsWith('}') && !c1) {
        try {
          const blob = JSON.parse(c2);
          if (blob && typeof blob === 'object') {
            Object.entries(blob).forEach(([k, v]) => {
              assignKeyVal(k, typeof v === 'object' ? JSON.stringify(v) : v);
            });
          }
        } catch (_) { /* ignore malformed JSON cell */ }
      } else if (c1) {
        assignKeyVal(c1, c2);
      }
    }

    return result;
  }

  function detectHeaderRow(ws, configColumns = []) {
    const maxScanRows = Math.min(ws.rowCount || 10, 10);
    const maxCols = Math.max(ws.columnCount || 0, 15);
    let best = null;

    for (let r = 1; r <= maxScanRows; r++) {
      const row = ws.getRow(r);
      if (!row) continue;
      const colMap = {};
      const headerNames = {};
      let recognizedCount = 0;
      let nonEmptyCount = 0;

      for (let c = 1; c <= maxCols; c++) {
        const text = extractCellText(row.getCell(c).value);
        if (!text) continue;
        nonEmptyCount++;
        headerNames[c] = text;

        for (const [field, pattern] of Object.entries(HEADER_PATTERNS)) {
          if (colMap[field] === undefined && pattern.test(text)) {
            colMap[field] = c;
            recognizedCount++;
            break;
          }
        }
      }

      if (recognizedCount >= 2 || (colMap.subject !== undefined && nonEmptyCount >= 2)) {
        const score = recognizedCount * 10 + nonEmptyCount;
        if (!best || score > best.score) {
          best = { headerRowNumber: r, colMap, headerNames, maxCols, score };
        }
      }
    }

    if (!best) return null;

    // Merge tracking role column from TrackerConfig if specified
    if (Array.isArray(configColumns) && best.colMap.trackingUuid === undefined) {
      for (const colDef of configColumns) {
        if (!colDef) continue;
        const role = String(colDef.role || '').toLowerCase();
        const hdr = String(colDef.header || colDef.label || '').trim().toLowerCase();
        if (role === 'tracking' || role === 'trackinguuid' || role === 'uuid') {
          if (Number(colDef.col) > 0) {
            best.colMap.trackingUuid = Number(colDef.col);
            break;
          }
          if (hdr) {
            const matchedCol = Object.entries(best.headerNames).find(([, name]) => name.toLowerCase() === hdr);
            if (matchedCol) {
              best.colMap.trackingUuid = Number(matchedCol[0]);
              break;
            }
          }
        }
      }
    }

    // Fallback scan for hidden Column K (11) or any unmapped column carrying UUIDv4s
    if (best.colMap.trackingUuid === undefined) {
      const dataStart = best.headerRowNumber + 1;
      const dataEnd = Math.min(ws.rowCount || dataStart + 25, best.headerRowNumber + 30);
      const mappedCols = new Set(Object.values(best.colMap));
      const scanCols = Math.max(best.maxCols, 15);
      const candidateCounts = new Map();

      for (let r = dataStart; r <= dataEnd; r++) {
        const row = ws.getRow(r);
        if (!row) continue;
        for (let c = 1; c <= scanCols; c++) {
          if (mappedCols.has(c)) continue;
          const txt = extractCellText(row.getCell(c).value);
          if (UUID_RE.test(txt)) {
            candidateCounts.set(c, (candidateCounts.get(c) || 0) + 1);
          }
        }
      }

      if (candidateCounts.has(11)) {
        best.colMap.trackingUuid = 11;
      } else if (candidateCounts.size > 0) {
        const topCol = Array.from(candidateCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
        best.colMap.trackingUuid = topCol;
      }
    }

    return best;
  }

  function inferActionCategory(requestedAction) {
    const act = String(requestedAction || '').trim();
    if (!act) return 'Uncategorized';
    if (/title|bill\s*of\s*sale|lien|notary|salvage\s*cert|doc\s*correction|poa|power\s*of\s*attorney|odometer/i.test(act)) {
      return 'Titles & Ownership';
    }
    if (/fee|credit|wire|payment|epay|refund|invoice|relist|sales\s*tax/i.test(act)) {
      return 'Billing, Fees & Payments';
    }
    if (/key|pickup|delivery|gate\s*pass|yard|release|tow|transporter/i.test(act)) {
      return 'Yard & Release Ops';
    }
    if (/bid\s*limit|bid\s*history|eligib|can't\s*bid|cant\s*bid/i.test(act)) {
      return 'Bidding & Eligibility';
    }
    if (/activation|cardholder|onboarding|bidder\s*seat|remove\s*bidder|account\s*status/i.test(act)) {
      return 'Account & Access';
    }
    if (/complaint|damage|lot\s*question|condition\s*report|arbitration|dispute/i.test(act)) {
      return 'Lot & Dispute Review';
    }
    return 'General Support';
  }

  function extractTicketFromSubject(subject) {
    const s = String(subject || '');
    const ticketPattern = s.match(/\[([A-Za-z]{2,8}-\d{2,4}-\d{3,6})\]/);
    if (ticketPattern) return ticketPattern[1].toUpperCase();
    const bracketMatches = s.matchAll(/\[([A-Za-z0-9_-]{4,24})\]/g);
    for (const m of bracketMatches) {
      if (!/^(external|ext|urgent|fw|fwd|re)$/i.test(m[1])) {
        return m[1].toUpperCase();
      }
    }
    const bare = s.match(/\b([A-Z]{2,6}-\d{2,4}-\d{3,6}|20\d{2}-\d{2}-\d{3,6})\b/);
    if (bare) return bare[1].toUpperCase();
    return '';
  }

  function appendChronologicalNote(existingNotes, dateLabel, newNote) {
    const rawLines = String(newNote || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (rawLines.length === 0) return existingNotes || '';

    const out = existingNotes
      ? String(existingNotes).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [];
    const seen = new Set(out);

    for (const rawLine of rawLines) {
      const formatted = rawLine.startsWith('[') ? rawLine : (dateLabel ? `[${dateLabel}] ${rawLine}` : rawLine);
      const bodyOnly = rawLine.replace(/^\[\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?\]\s*/i, '').trim();
      const alreadyExists = seen.has(formatted) || seen.has(rawLine) ||
        out.some((prev) => prev === rawLine || (bodyOnly && prev.endsWith(`] ${bodyOnly}`)));
      if (!alreadyExists) {
        out.push(formatted);
        seen.add(formatted);
      }
    }
    return out.join('\n');
  }

  function parseWorkbookObject(wb, meta = {}) {
    const fileName = String(meta.fileName || 'Workbook.xlsx');
    const pathSegments = Array.isArray(meta.pathSegments) ? meta.pathSegments : [];
    const cfg = readTrackerConfig(wb);

    const inferred = inferAgentFromPath(fileName, pathSegments, cfg.agentName);
    const workbookAgentName = inferred.agentName;
    const workbookAgentUuid = cfg.agentUuid || stableHashId(`agent::${inferred.agentSlug}`).replace('xlsx-rec-', 'xlsx-agent-');
    const workbookSlug = inferred.workbookSlug;

    const fallbackYearMatch = fileName.match(/\b(20\d{2})\b/);
    const fallbackYear = fallbackYearMatch ? parseInt(fallbackYearMatch[1], 10) : new Date().getFullYear();

    const dateSheets = [];
    const otherSheets = [];

    (wb.worksheets || []).forEach((ws, idx) => {
      if (!ws) return;
      if (ws.state === 'hidden' || ws.state === 'veryHidden') return;
      const sName = String(ws.name || '').trim();
      if (!sName || SKIP_SHEET_RE.test(sName)) return;

      const parsedDate = parseSheetDate(sName, fallbackYear);
      if (parsedDate) {
        dateSheets.push({ ws, sheetName: sName, dateStr: parsedDate.dateStr, sortKey: parsedDate.sortKey, idx });
      } else {
        otherSheets.push({ ws, sheetName: sName, dateStr: '', sortKey: idx, idx });
      }
    });

    dateSheets.sort((a, b) => (a.sortKey !== b.sortKey ? a.sortKey - b.sortKey : a.idx - b.idx));
    const orderedSheets = dateSheets.length > 0 ? dateSheets : otherSheets;

    const recordsMap = new Map();
    let sheetsScanned = 0;
    let latestSheetName = '';

    for (const sheetMeta of orderedSheets) {
      const { ws, sheetName, dateStr } = sheetMeta;
      const headerInfo = detectHeaderRow(ws, cfg.columns);
      if (!headerInfo) continue;

      sheetsScanned++;
      latestSheetName = sheetName;
      const { headerRowNumber, colMap, headerNames, maxCols } = headerInfo;
      const rowCount = ws.rowCount || 0;
      const seenSheetFallbackKeys = new Map();

      for (let r = headerRowNumber + 1; r <= rowCount; r++) {
        const row = ws.getRow(r);
        if (!row) continue;

        const getField = (field) => {
          const colIdx = colMap[field];
          return colIdx ? extractCellText(row.getCell(colIdx).value) : '';
        };

        const subject = getField('subject');
        let ticketNumber = getField('ticketNumber').toUpperCase();
        const brokerName = getField('brokerName');
        const masterNumber = getField('masterNumber').toUpperCase();
        const bidderNumber = getField('bidderNumber').toUpperCase();
        const requestedAction = getField('requestedAction');
        const actionCategory = getField('actionCategory');
        const yardNumber = getField('yardNumber').toUpperCase();
        const lotNumbers = getField('lotNumbers');
        const notes = getField('notes');
        const status = getField('status');
        const rawTrackingUuid = getField('trackingUuid');
        const parentTrackingUuid = getField('parentTrackingUuid');
        const rowAgentName = getField('agentName') || workbookAgentName;
        const firstSeenCell = getField('firstSeenDate');
        const lastSeenCell = getField('lastSeenDate');
        const overdueCell = getField('overdue');

        // Skip completely blank data rows
        if (!subject && !ticketNumber && !brokerName && !masterNumber && !requestedAction && !lotNumbers && !notes) {
          continue;
        }

        if (!ticketNumber && subject) {
          ticketNumber = extractTicketFromSubject(subject);
        }

        const effectiveDate = dateStr || lastSeenCell || firstSeenCell || sheetName;
        const rowAgentSlug = normalizeAgentSlug(rowAgentName);

        let trackingUuid = '';
        if (UUID_RE.test(rawTrackingUuid)) {
          trackingUuid = rawTrackingUuid.toLowerCase();
        } else {
          const baseIdentity = ticketNumber
            ? `ticket:${ticketNumber}`
            : `subj:${subject.toLowerCase()}|mast:${masterNumber}|lots:${lotNumbers.toLowerCase()}`;
          const baseKey = `${rowAgentSlug}::${workbookSlug}::${baseIdentity}`;
          const occ = (seenSheetFallbackKeys.get(baseKey) || 0) + 1;
          seenSheetFallbackKeys.set(baseKey, occ);
          const uniqueKey = occ > 1 ? `${baseKey}#${occ}` : baseKey;
          trackingUuid = stableHashId(uniqueKey);
        }

        // Capture any unmapped non-empty columns into customValues
        const mappedCols = new Set(Object.values(colMap));
        const customValues = {};
        for (let c = 1; c <= maxCols; c++) {
          if (mappedCols.has(c) || !headerNames[c]) continue;
          const v = extractCellText(row.getCell(c).value);
          if (v) customValues[headerNames[c]] = v;
        }

        const isOverdueFlag = /overdue/i.test(status) || /^(yes|true|1|overdue)$/i.test(overdueCell);
        const timelineEntry = {
          date: effectiveDate,
          sheetName,
          rowNumber: r,
          status: status || 'Pending',
          notes
        };

        const existing = recordsMap.get(trackingUuid);
        if (!existing) {
          recordsMap.set(trackingUuid, {
            trackingUuid,
            parentTrackingUuid: UUID_RE.test(parentTrackingUuid) ? parentTrackingUuid.toLowerCase() : null,
            subject,
            ticketNumber,
            masterTicketNumber: '',
            subTicketNumbers: [],
            brokerName,
            masterNumber,
            bidderNumber,
            requestedAction,
            actionCategory: actionCategory || inferActionCategory(requestedAction),
            yardNumber,
            lotNumbers,
            notes: appendChronologicalNote('', effectiveDate, notes),
            status: status || 'Pending',
            customValues,
            firstSeenDate: firstSeenCell || effectiveDate,
            lastSeenDate: lastSeenCell || effectiveDate,
            latestSheetName: sheetName,
            latestRowNumber: r,
            carryCount: 1,
            isOverdue: isOverdueFlag,
            overdueReason: isOverdueFlag ? (overdueCell || 'Overdue') : '',
            lastAccessedAt: '',
            timeline: [timelineEntry],
            _rowAgentName: rowAgentName,
            _seenSheets: new Set([sheetName])
          });
        } else {
          if (subject) existing.subject = subject;
          if (ticketNumber) existing.ticketNumber = ticketNumber;
          if (brokerName) existing.brokerName = brokerName;
          if (masterNumber) existing.masterNumber = masterNumber;
          if (bidderNumber) existing.bidderNumber = bidderNumber;
          if (requestedAction) existing.requestedAction = requestedAction;
          if (actionCategory) existing.actionCategory = actionCategory;
          else if (requestedAction && (!existing.actionCategory || existing.actionCategory === 'Uncategorized')) {
            existing.actionCategory = inferActionCategory(requestedAction);
          }
          if (yardNumber) existing.yardNumber = yardNumber;
          if (lotNumbers) existing.lotNumbers = lotNumbers;
          if (status) existing.status = status;
          if (rowAgentName) existing._rowAgentName = rowAgentName;
          if (Object.keys(customValues).length > 0) {
            existing.customValues = { ...existing.customValues, ...customValues };
          }
          existing.notes = appendChronologicalNote(existing.notes, effectiveDate, notes);
          existing.lastSeenDate = lastSeenCell || effectiveDate;
          existing.latestSheetName = sheetName;
          existing.latestRowNumber = r;
          existing._seenSheets.add(sheetName);
          existing.carryCount = existing._seenSheets.size;
          existing.isOverdue = isOverdueFlag;
          if (isOverdueFlag && !existing.overdueReason) existing.overdueReason = overdueCell || 'Overdue';
          existing.timeline.push(timelineEntry);
        }
      }
    }

    const records = Array.from(recordsMap.values()).map((rec) => {
      const { _seenSheets, _rowAgentName, ...clean } = rec;
      if (_rowAgentName && _rowAgentName !== workbookAgentName) {
        clean.rowAgentName = _rowAgentName;
      }
      return clean;
    });

    return {
      schemaVersion: 'trackerui.mirror.v1',
      ledgerId: cfg.ledgerId || '',
      agent: {
        agentUuid: workbookAgentUuid,
        agentName: workbookAgentName,
        role: cfg.role || 'Agent'
      },
      workbook: {
        workbookSlug,
        fileName,
        profileName: cfg.profileName || 'Excel Workbook',
        schemaMode: cfg.schemaMode || 'xlsx',
        sheetCount: (wb.worksheets || []).length,
        latestSheetName
      },
      records,
      sheetsScanned
    };
  }

  async function parseWorkbookBuffer(arrayBuffer, meta = {}) {
    if (typeof ExcelJS === 'undefined') {
      throw new Error('ExcelJS is unavailable. Connect online once so the PWA cache can store ExcelJS.');
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(arrayBuffer);
    return parseWorkbookObject(wb, meta);
  }

  window.LedgerXlsxParser = {
    UUID_RE,
    slugify,
    isViewOnlyFileName,
    normalizeWorkbookSlug,
    normalizeAgentSlug,
    stripAgentPrefixFromSlug,
    extractCellText,
    stableHashId,
    parseSheetDate,
    inferAgentNameFromPath,
    inferAgentFromPath,
    inferActionCategory,
    extractTicketFromSubject,
    readTrackerConfig,
    detectHeaderRow,
    parseWorkbookObject,
    parseWorkbookBuffer
  };
})();
