// ============================================================================
// ⚡ PEA SMART GRID — HIGH-PRECISION LINE DISTANCE CALCULATOR v3.5 (scada-fault-locator.js)
// พาทที่ 1 / 2 : ระบบอิมพีแดนซ์ 22kV + คิดสาย UG ในสถานี 150 ม. ทุกวงจร + CB/RC ทุกตัวเป็นต้นทางจ่ายไฟ
// ============================================================================
(function () {
    'use strict';

    const FAULT_BRIDGE_CH = 'pea_scada_fault_locator_v1';
    const FAULT_PKT_KEY = 'elec_scada_fault_locator_pkt';
    const HANDLED_PKT_SESSION_KEY = 'elec_scada_handled_fault_pkt_ts';
    const FAULT_PREF_KEY = 'elec_scada_22kv_fault_calc_prefs_v3';
    const FEEDER_CALIB_KEY = 'elec_scada_22kv_feeder_calib_v1';
    const CLOUD_CALIB_PREFIX = '__FAULT_CALIB__';
    const STORAGE_KEY_LABELS = 'elec_labeled_places_list';
    const STORAGE_KEY_DELETED = 'elec_deleted_labeled_places_map';
    const STORAGE_KEY_TECH_LOC = 'elec_tech_locations_map';
    const SHORT_LINK_CACHE_KEY = 'elec_resolved_shortlinks_cache_v2';
    const SHORT_URL_REGEX = /(?:https?:\/\/)?(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/[A-Za-z0-9_-]+(?:\?[^\s"'<>]*)?/i;

    const SWITCHABLE_TYPES = new Set(['RC', 'CB', 'VB', 'VS', 'VSC', 'S', 'DF', 'GEN']);
    const MAIN_TRUNK_ANCHOR_TYPES = new Set(['RC', 'CB', 'VB', 'VS', 'VSC', 'S', 'GEN']);

    const DEFAULT_BUS_KV = 22.6; // แรงดันบัสจ่ายไฟจริงเฉลี่ยหน้าสถานีไฟฟ้า กฟภ. (22.5 - 22.8 kV)
    const DEFAULT_STATION_UG_METERS = 150; // สายเคเบิลใต้ดิน (UG 240 ตร.มม.) ภายในสถานีออกสู่ Riser Pole 150 เมตร ทุกวงจรจ่ายไฟ
    const OVERHEAD_SAG_FACTOR = 1.035; // ชดเชยระยะสายตกท้องช้างและช่วงโค้งเสา (+3.5%)
    const UG_SLACK_FACTOR = 1.025; // ชดเชยสายเคเบิลมุดดินขึ้นเสา Riser (+2.5%)

    const PEA_22KV_CABLES = {
        SAC185: { key: 'SAC185', label: 'สายเมนหุ้มฉนวน 185 ตร.มม.', short: 'SAC 185', r1: 0.164, x1: 0.345, r0: 0.312, x0: 1.560, isUg: false },
        AAC185: { key: 'AAC185', label: 'สายเมนเปลือย 185 ตร.มม.', short: 'AAC 185', r1: 0.159, x1: 0.378, r0: 0.307, x0: 1.620, isUg: false },
        SAC120: { key: 'SAC120', label: 'สายขนาด 120 ตร.มม.', short: 'SAC 120', r1: 0.253, x1: 0.362, r0: 0.401, x0: 1.595, isUg: false },
        SAC95:  { key: 'SAC95',  label: 'สายกิ่งหลัก 95 ตร.มม.', short: 'SAC 95', r1: 0.320, x1: 0.372, r0: 0.468, x0: 1.615, isUg: false },
        SAC50:  { key: 'SAC50',  label: 'สายกิ่งย่อย 50 ตร.มม.', short: 'SAC 50', r1: 0.603, x1: 0.398, r0: 0.751, x0: 1.665, isUg: false },
        UG240:  { key: 'UG240',  label: 'สายเคเบิลใต้ดิน 240 ตร.มม.', short: 'UG 240', r1: 0.125, x1: 0.118, r0: 0.395, x0: 0.360, isUg: true }
    };

    const PEA_SOURCE_BUS_PRESETS = {
        SUB_50MVA:  { label: 'หม้อแปลงสถานี 50 MVA', rs1: 0.05, xs1: 1.48, rs0: 0.06, xs0: 1.42 },
        SUB_25MVA:  { label: 'หม้อแปลงสถานี 25 MVA', rs1: 0.10, xs1: 2.52, rs0: 0.12, xs0: 2.45 },
        SUB_STRONG: { label: 'สถานีขนานหม้อแปลงใหญ่', rs1: 0.03, xs1: 0.96, rs0: 0.04, xs0: 0.95 },
        IDEAL_ZERO: { label: 'ไม่คิดอิมพีแดนซ์สถานี', rs1: 0.01, xs1: 0.15, rs0: 0.02, xs0: 0.25 }
    };

    const DEFAULT_AMP_HINT_TEXT = '💡 กรอกกระแส (A) หรือระยะรีเลย์ (กม.) • คิดรวมสาย UG ในสถานี 150 ม. ให้ทุกวงจรจ่ายไฟอัตโนมัติ';

    const safeSessionGet = (k) => { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } };
    const safeSessionSet = (k, v) => { try { window.sessionStorage.setItem(k, v); } catch (e) {} };
    const escapeRe = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    let faultBc = null;
    try { if ('BroadcastChannel' in window) faultBc = new BroadcastChannel(FAULT_BRIDGE_CH); } catch (e) {}

    let capturedMap = null;
    let faultLayerGroup = null;
    let panelOpen = false;
    let calibDrawerOpen = false;
    let lastFaultResult = null;
    let lastEditedMetric = 'auto'; // 'km' | 'amp' | 'auto'
    let incomingReporterCoords = null;
    const excludedNotPassIds = new Set();
    let lastActiveScopeKey = '';
    let lastKnownLoggedState = false;
    let activePacketApplySeq = 0;
    let lastHandledPktTs = parseInt(safeSessionGet(HANDLED_PKT_SESSION_KEY) || '0', 10) || 0;
    let lastClearedPktTs = 0;

    // ========================================================================
    // 1. ระบบจัดเก็บค่าตั้งต้น, อิมพีแดนซ์สาย UG สถานี 150 ม. & ซิงค์สเกลวงจรข้ามเครื่อง
    // ========================================================================
    function normGrp(raw) {
        if (typeof window.normalizePeaGroupName === 'function') return window.normalizePeaGroupName(raw) || '';
        let g = String(raw || '').trim().replace(/\s+/g, ' ');
        g = g.replace(/^(กฟ[ก-ฮ]{1,2})\.\s+/, '$1.').replace(/^(กฟ[สฟจตอยภผกนฉ])\s+/, '$1.').replace(/^(กฟ[สฟจตอยภผกนฉ])(?![.\s]|[ก-ฮ]\.|$)/, '$1.');
        return g.trim();
    }

    function getCurrentBranchForCalib() {
        let curGrp = '';
        try {
            curGrp = (typeof window.getCurrentUserGroup === 'function' ? window.getCurrentUserGroup() : '') ||
                     localStorage.getItem('elec_app_current_group') || '';
        } catch (e) {}
        return normGrp(curGrp) || 'กฟส.บึง';
    }

    function loadCalcPrefs() {
        const defaults = {
            faultType: 'LL',
            cableKey: 'SAC185',
            sourceKey: 'SUB_50MVA',
            busKv: DEFAULT_BUS_KV,
            rfOhm: 0,
            autoLateral: true,
            stationUg: true
        };
        try {
            const legacy = JSON.parse(localStorage.getItem('elec_scada_22kv_fault_calc_prefs_v1') || '{}') || {};
            const cur = JSON.parse(localStorage.getItem(FAULT_PREF_KEY) || '{}') || {};
            const merged = Object.assign(defaults, legacy, cur);
            merged.rfOhm = 0;
            return merged;
        } catch (e) {
            return defaults;
        }
    }

    function saveCalcPrefs(patch) {
        try {
            const next = Object.assign(loadCalcPrefs(), patch || {});
            delete next.rfOhm;
            localStorage.setItem(FAULT_PREF_KEY, JSON.stringify(next));
        } catch (e) {}
    }

    // คำนวณเวกเตอร์อิมพีแดนซ์ของสายเคเบิลใต้ดิน (UG 240 ตร.มม.) ภายในสถานีไฟฟ้า (ค่ามาตรฐาน 150 เมตร = 0.15 กม.)
    function getStationExitUgVector(ugMeters = DEFAULT_STATION_UG_METERS) {
        const km = Math.max(0, (Number(ugMeters) || 0) / 1000);
        const ug = PEA_22KV_CABLES.UG240;
        return {
            km,
            meters: Math.round(km * 1000),
            r1: ug.r1 * km,
            x1: ug.x1 * km,
            r0: ug.r0 * km,
            x0: ug.x0 * km
        };
    }

    // หากเส้นสายแรกที่ออกจากต้นทางในผังมีการระบุป้าย UG ไว้เองแล้ว จะหักลบให้โดยไม่คิดซ้ำซ้อน แต่ถ้าไม่ได้ระบุจะบวกสาย UG ในสถานีครบ 150 เมตรอัตโนมัติ
    function computeEffectiveStationUgVector(rootPinId, adjGraph, stationUgEnabled = true) {
        if (!stationUgEnabled) return getStationExitUgVector(0);
        const nbs = (adjGraph && rootPinId && adjGraph.get(rootPinId)) ? adjGraph.get(rootPinId) : [];
        let explicitUgMeters = 0;
        const ugNbs = nbs.filter((nb) => nb.isExplicitUg);
        if (ugNbs.length > 0) {
            const minGroundKm = Math.min(...ugNbs.map((nb) => nb.groundKm ?? nb.lenKm ?? 0));
            explicitUgMeters = Math.round(minGroundKm * 1000);
        }
        const remainMeters = Math.max(0, DEFAULT_STATION_UG_METERS - explicitUgMeters);
        return getStationExitUgVector(remainMeters);
    }

    function loadLocalCalibMap() {
        try { return JSON.parse(localStorage.getItem(FEEDER_CALIB_KEY) || '{}') || {}; }
        catch (e) { return {}; }
    }

    function mergeCalibMaps(mapA, mapB) {
        const merged = Object.assign({}, mapA || {});
        Object.entries(mapB || {}).forEach(([k, inc]) => {
            if (!k || !inc || typeof inc !== 'object') return;
            const ex = merged[k];
            const incMs = new Date(inc.updatedAt || 0).getTime() || 0;
            const exMs = ex ? (new Date(ex.updatedAt || 0).getTime() || 0) : -1;
            if (!ex || incMs > exMs || (incMs === exMs && inc.deleted && !ex.deleted)) {
                merged[k] = inc;
            }
        });
        return merged;
    }

    function pullCloudCalibIntoLocal() {
        try {
            const locMap = JSON.parse(localStorage.getItem(STORAGE_KEY_TECH_LOC) || '{}') || {};
            const myScope = getCurrentScopeKey();
            const myBranch = getCurrentBranchForCalib();
            let localMap = loadLocalCalibMap();
            let changed = false;

            Object.entries(locMap).forEach(([k, v]) => {
                if (!k.startsWith(CLOUD_CALIB_PREFIX) || !v?.calibMap || typeof v.calibMap !== 'object') return;
                const shardGrp = normGrp(k.slice(CLOUD_CALIB_PREFIX.length)) || normGrp(v.group) || 'กฟส.บึง';
                if (myScope !== '__ADMIN_ALL__' && shardGrp !== myBranch) return;
                const next = mergeCalibMaps(localMap, v.calibMap);
                if (JSON.stringify(next) !== JSON.stringify(localMap)) {
                    localMap = next;
                    changed = true;
                }
            });

            if (changed) {
                localStorage.setItem(FEEDER_CALIB_KEY, JSON.stringify(localMap));
                const srcId = document.getElementById('scadaFaultSourceSelect')?.value || '';
                if (srcId) updateCalibBadgeUI(srcId);
            }
            return localMap;
        } catch (e) {
            return loadLocalCalibMap();
        }
    }

    function pushCalibMapToCloud(branchGrp, updatedCalibMap) {
        if (typeof window.isViewerRole === 'function' && window.isViewerRole()) return;
        const targetGrp = normGrp(branchGrp) || getCurrentBranchForCalib();
        const regKey = CLOUD_CALIB_PREFIX + targetGrp;
        const nowIso = new Date().toISOString();

        const compactCalib = {};
        const nowMs = Date.now();
        Object.entries(updatedCalibMap || {}).forEach(([k, rec]) => {
            if (!k || !rec || typeof rec !== 'object') return;
            const rMs = new Date(rec.updatedAt || 0).getTime() || 0;
            if (rec.deleted && rMs > 0 && (nowMs - rMs > 30 * 86400000)) return;
            if ((rec.ownerGroup || targetGrp) !== targetGrp) return;
            compactCalib[k] = rec;
        });

        const regEntry = {
            isSystemRegistry: true,
            group: targetGrp,
            gpsDisabled: true,
            lat: null,
            lon: null,
            calibMap: compactCalib,
            updatedAt: nowIso,
            lastSeenAt: nowIso
        };

        try {
            const locMap = JSON.parse(localStorage.getItem(STORAGE_KEY_TECH_LOC) || '{}') || {};
            locMap[regKey] = regEntry;
            window.PeaCore?.unlockCloudWrite?.(20000);
            localStorage.setItem(STORAGE_KEY_TECH_LOC, JSON.stringify(locMap));
        } catch (e) {}

        const apiUrl = typeof window.getActiveCloudApiUrl === 'function' ? window.getActiveCloudApiUrl() : '';
        if (apiUrl && localStorage.getItem('elec_app_logged_in') === 'true' && navigator.onLine !== false) {
            window.PeaCore?.unlockCloudWrite?.(20000);
            fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({
                    action: 'patchDelta',
                    group: targetGrp,
                    forceSheetWrite: true,
                    techLocDelta: { techLocations: { [regKey]: regEntry } }
                })
            }).catch(() => {});
        }
    }

    function getSourceCalibRecord(sourcePinId) {
        if (!sourcePinId) return null;
        const map = pullCloudCalibIntoLocal();
        let rec = map[sourcePinId];
        if (!rec) {
            const pins = getVisibleScadaPins();
            const sp = pins.find((p) => p.id === sourcePinId);
            const ownerGrp = normGrp(sp?.ownerGroup) || getCurrentBranchForCalib();
            const nameKey = sp?.name ? ('NAME::' + ownerGrp + '::' + String(sp.name).trim().toUpperCase()) : '';
            if (nameKey && map[nameKey]) rec = map[nameKey];
        }
        if (!rec || rec.deleted || typeof rec.factor !== 'number' || isNaN(rec.factor)) return null;
        return {
            factor: Math.max(0.65, Math.min(1.45, rec.factor)),
            refName: rec.refName || '',
            refAmp: rec.refAmp || 0,
            syncedBy: rec.syncedBy || '',
            updatedAt: rec.updatedAt || ''
        };
    }

    function saveSourceCalibRecord(sourcePinId, sourcePinObj, recObjOrNull) {
        if (!sourcePinId) return;
        const ownerGrp = normGrp(sourcePinObj?.ownerGroup) || getCurrentBranchForCalib();
        const nowIso = new Date().toISOString();
        const map = pullCloudCalibIntoLocal();
        const nameKey = sourcePinObj?.name ? ('NAME::' + ownerGrp + '::' + String(sourcePinObj.name).trim().toUpperCase()) : '';

        const entry = recObjOrNull
            ? Object.assign({}, recObjOrNull, { ownerGroup: ownerGrp, deleted: false, updatedAt: nowIso })
            : { ownerGroup: ownerGrp, deleted: true, updatedAt: nowIso };

        map[sourcePinId] = entry;
        if (nameKey) map[nameKey] = entry;

        try { localStorage.setItem(FEEDER_CALIB_KEY, JSON.stringify(map)); } catch (e) {}
        pushCalibMapToCloud(ownerGrp, map);
    }

    // ========================================================================
    // 2. สมการฟิสิกส์ลัดวงจร 22kV แท้ (Symmetrical Components: 3P, LL, LLG, LG)
    // ========================================================================
    function cMul(ar, ai, br, bi) {
        return { r: ar * br - ai * bi, i: ar * bi + ai * br };
    }

    function cDiv(ar, ai, br, bi) {
        const den = br * br + bi * bi;
        if (den < 1e-12) return { r: 0, i: 0 };
        return { r: (ar * br + ai * bi) / den, i: (ai * br - ar * bi) / den };
    }

    function normalizeFaultTypeCode(rawPhaseOrType) {
        const s = String(rawPhaseOrType || '').toUpperCase().trim();
        if (!s) return 'LL';
        if (s === '3P' || s === 'LL' || s === 'LLG' || s === 'LG') return s;
        if (/3\s*เฟส|3\s*P|3\s*Φ|A\s*[-/,]?\s*B\s*[-/,]?\s*C/.test(s)) return '3P';
        if (/(?:ABG|BCG|CAG|ACG)|(?:A\s*[-/,]\s*B|B\s*[-/,]\s*C|C\s*[-/,]\s*A|A\s*[-/,]\s*C)\s*[-/,]\s*[GN]/.test(s)) return 'LLG';
        if (/ช็อต\s*2|2\s*เฟส|ระหว่างเฟส|\b(?:AB|BC|CA)\b|(?:^|[^A-Z])(?:A\s*[-/,]\s*B|B\s*[-/,]\s*C|C\s*[-/,]\s*A)(?![A-Z])/.test(s)) return 'LL';
        if (/ลงดิน|1\s*เฟส|เฟสเดียว|\b(?:EF|AG|BG|CG|AN|BN|CN|EARTH|GROUND)\b|(?:^|[^A-Z])[ABC]\s*[-/,]\s*[GN](?![A-Z])|เฟส\s*[ABC]|(?:^|\s)[ABC](?:\s|$)/.test(s)) return 'LG';
        return 'LL';
    }

    function getFaultTypeLabelThai(ft) {
        if (ft === '3P') return 'ช็อต 3 เฟส (3P)';
        if (ft === 'LLG') return '2 เฟสลงดิน (LLG)';
        if (ft === 'LG') return 'ลงดิน 1 เฟส (LG)';
        return 'ช็อต 2 เฟส (LL)';
    }

    function calcFaultCurrentAtVector(accVec, faultType, srcBus, rfOhm, busKv = DEFAULT_BUS_KV, calFactor = 1.0) {
        const vLL = (Number(busKv) >= 18 && Number(busKv) <= 26 ? Number(busKv) : DEFAULT_BUS_KV) * 1000;
        const vLN = vLL / Math.sqrt(3);
        const scale = (Number(calFactor) >= 0.65 && Number(calFactor) <= 1.45) ? Number(calFactor) : 1.0;
        const rf = Math.max(0, Number(rfOhm) || 0);

        const r1 = srcBus.rs1 + accVec.r1;
        const x1 = srcBus.xs1 + accVec.x1;
        const r0 = srcBus.rs0 + accVec.r0;
        const x0 = srcBus.xs0 + accVec.x0;

        let rawAmp = 99999;
        if (faultType === '3P') {
            const z = Math.hypot(r1 + rf, x1);
            rawAmp = z > 1e-6 ? (vLN / z) : 99999;
        } else if (faultType === 'LL') {
            const zLoop = Math.hypot(2 * r1 + rf, 2 * x1);
            rawAmp = zLoop > 1e-6 ? (vLL / zLoop) : 99999;
        } else if (faultType === 'LLG') {
            const r0g = r0 + 3 * rf;
            const zSumR = r1 + r0g, zSumI = x1 + x0;
            if (zSumR * zSumR + zSumI * zSumI > 1e-10) {
                const numP = cMul(r1, x1, r0g, x0);
                const zp = cDiv(numP.r, numP.i, zSumR, zSumI);
                const i1 = cDiv(vLN, 0, r1 + zp.r, x1 + zp.i);
                const k2 = cDiv(r0g, x0, zSumR, zSumI);
                const k0 = cDiv(r1, x1, zSumR, zSumI);
                const m2 = cMul(i1.r, i1.i, k2.r, k2.i);
                const m0 = cMul(i1.r, i1.i, k0.r, k0.i);
                const i2 = { r: -m2.r, i: -m2.i };
                const i0 = { r: -m0.r, i: -m0.i };

                const SQ3_2 = Math.sqrt(3) / 2;
                const a1 = cMul(-0.5, SQ3_2, i1.r, i1.i);
                const a2_1 = cMul(-0.5, -SQ3_2, i1.r, i1.i);
                const a_2 = cMul(-0.5, SQ3_2, i2.r, i2.i);
                const a2_2 = cMul(-0.5, -SQ3_2, i2.r, i2.i);

                const ibR = a2_1.r + a_2.r + i0.r, ibI = a2_1.i + a_2.i + i0.i;
                const icR = a1.r + a2_2.r + i0.r, icI = a1.i + a2_2.i + i0.i;
                rawAmp = Math.max(Math.hypot(ibR, ibI), Math.hypot(icR, icI));
            }
        } else {
            const zLg = Math.hypot(2 * r1 + r0 + 3 * rf, 2 * x1 + x0);
            rawAmp = zLg > 1e-6 ? ((3 * vLN) / zLg) : 99999;
        }
        return rawAmp * scale;
    }

    function solveUniformDistanceKmFromAmp(ampVal, faultType, cableKey, sourceKey, rfOhm, baseLineVec = null, busKv = DEFAULT_BUS_KV, calFactor = 1.0) {
        const I = parseFloat(ampVal);
        if (isNaN(I) || I <= 0) return { error: 'กรุณาระบุกระแสฟอลต์ (แอมป์) ให้มากกว่า 0' };
        const cab = PEA_22KV_CABLES[cableKey] || PEA_22KV_CABLES.SAC185;
        const src = PEA_SOURCE_BUS_PRESETS[sourceKey] || PEA_SOURCE_BUS_PRESETS.SUB_50MVA;
        const bv = baseLineVec || { r1: 0, x1: 0, r0: 0, x0: 0 };

        const iAtZero = calcFaultCurrentAtVector(bv, faultType, src, rfOhm, busKv, calFactor);
        const maxPossibleAmp = Math.round(iAtZero);
        if (I >= iAtZero) return { km: 0.03, clampedNearBus: true, maxPossibleAmp };

        let lo = 0, hi = 150;
        for (let iter = 0; iter < 32; iter++) {
            const mid = (lo + hi) / 2;
            const vec = {
                r1: bv.r1 + cab.r1 * mid, x1: bv.x1 + cab.x1 * mid,
                r0: bv.r0 + cab.r0 * mid, x0: bv.x0 + cab.x0 * mid
            };
            if (calcFaultCurrentAtVector(vec, faultType, src, rfOhm, busKv, calFactor) > I) lo = mid;
            else hi = mid;
        }
        return { km: Number(Math.max(0.03, (lo + hi) / 2).toFixed(2)), clampedNearBus: false, maxPossibleAmp };
    }

    function estimateImpliedRfOhm(accVecAtPoint, measuredAmp, faultType, srcBus, busKv, calFactor) {
        if (!measuredAmp || measuredAmp <= 0 || !accVecAtPoint) return null;
        const iZeroRf = calcFaultCurrentAtVector(accVecAtPoint, faultType, srcBus, 0, busKv, calFactor);
        if (measuredAmp >= iZeroRf * 0.96) return 0;
        let lo = 0, hi = 80;
        for (let i = 0; i < 26; i++) {
            const mid = (lo + hi) / 2;
            if (calcFaultCurrentAtVector(accVecAtPoint, faultType, srcBus, mid, busKv, calFactor) > measuredAmp) lo = mid;
            else hi = mid;
        }
        return Number(((lo + hi) / 2).toFixed(1));
    }

    // ========================================================================
    // 3. เชื่อมแผนที่ Leaflet, กำหนด CB/RC ทุกตัวเป็นต้นทางจ่ายไฟ & คัดกรองจุดรวมสถานี
    // ========================================================================
    function injectFaultLocatorStyles() {
        if (document.getElementById('peaScadaFaultLocatorCss') || !document.head) return;
        const st = document.createElement('style');
        st.id = 'peaScadaFaultLocatorCss';
        st.textContent = `
            @keyframes peaFaultTargetPulse { 0% { transform: scale(0.85); opacity: 0.95; } 70%, 100% { transform: scale(1.6); opacity: 0; } }
            #labeledInteractiveMap.scada-draw-cursor .leaflet-scadaFaultLocatorPane-pane *,
            #labeledInteractiveMap.scada-move-wire-active .leaflet-scadaFaultLocatorPane-pane *,
            #labeledInteractiveMap.scada-move-pin-active .leaflet-scadaFaultLocatorPane-pane * { pointer-events: none !important; }
            body.role-viewer-readonly .fault-calib-write-only { display: none !important; }
        `;
        document.head.appendChild(st);
    }

    function attachMapInstance(mapObj) {
        const container = mapObj?.getContainer?.();
        if (!mapObj || container?.id !== 'labeledInteractiveMap') return false;
        if (capturedMap === mapObj && faultLayerGroup && capturedMap.hasLayer?.(faultLayerGroup)) return true;
        capturedMap = mapObj;
        if (!capturedMap.getPane('scadaFaultLocatorPane')) {
            const p = capturedMap.createPane('scadaFaultLocatorPane');
            p.style.zIndex = '635';
        }
        faultLayerGroup = L.layerGroup().addTo(capturedMap);
        checkPendingFaultPacket();
        return true;
    }

    function tryDiscoverExistingMap() {
        if (capturedMap && capturedMap.getContainer?.()?.isConnected) return true;
        for (const m of [window.labeledMap, window.scadaMap, window.equipMap, window.__labeledLeafletMap]) {
            if (attachMapInstance(m)) return true;
        }
        const el = document.getElementById('labeledInteractiveMap');
        if (el) {
            for (const k of Object.keys(el)) {
                const v = el[k];
                if (v && typeof v.createPane === 'function' && typeof v.getContainer === 'function' && attachMapInstance(v)) return true;
            }
        }
        return false;
    }

    function hookLeafletInstance() {
        if (typeof window.L === 'undefined' || !L.Map) return;
        if (!L.Map.__peaFaultHooked) {
            L.Map.__peaFaultHooked = true;
            L.Map.addInitHook(function () { setTimeout(() => attachMapInstance(this), 0); });
            ['invalidateSize', 'setView', 'fitBounds'].forEach((fn) => {
                const orig = L.Map.prototype[fn];
                if (typeof orig !== 'function') return;
                L.Map.prototype[fn] = function () { attachMapInstance(this); return orig.apply(this, arguments); };
            });
        }
        tryDiscoverExistingMap();
    }
    hookLeafletInstance();

    function haversineKm(lat1, lon1, lat2, lon2) {
        if (typeof window.calcHaversineKm === 'function') return window.calcHaversineKm(lat1, lon1, lat2, lon2);
        const R = 6371.0088, toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    function copyTextReliableWithFeedback(text, toastMsg, btnEl = null) {
        const showDone = () => {
            window.showToast?.(toastMsg);
            if (btnEl && btnEl.tagName === 'BUTTON') {
                if (!btnEl.dataset.origLabel) btnEl.dataset.origLabel = btnEl.innerHTML;
                btnEl.innerHTML = '✅ คัดลอกแล้ว!';
                clearTimeout(btnEl.__copyFeedbackTimer);
                btnEl.__copyFeedbackTimer = setTimeout(() => {
                    if (btnEl.dataset.origLabel) btnEl.innerHTML = btnEl.dataset.origLabel;
                }, 1700);
            }
        };

        const legacyExecCopy = () => {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try {
                document.execCommand('copy');
                showDone();
            } catch (e) {
                window.showToast?.('⚠️ คัดลอกอัตโนมัติไม่สำเร็จ กรุณาลองอีกครั้ง');
            }
            document.body.removeChild(ta);
        };

        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(showDone).catch(legacyExecCopy);
        } else {
            legacyExecCopy();
        }
    }

    function openFaultLineShareSafe(text) {
        const lineUrl = 'https://line.me/R/share?text=' + encodeURIComponent(text);
        const win = window.open(lineUrl, '_blank');
        if (!win && !window.PeaCore?.isEmbeddedIframe) window.location.href = lineUrl;
    }

    function openFaultStreetView(lat, lon) {
        const la = Number(lat), lo = Number(lon);
        if (isNaN(la) || isNaN(lo)) return;
        const svUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${la.toFixed(6)},${lo.toFixed(6)}`;
        window.open(svUrl, '_blank', 'noopener,noreferrer');
    }

    function getCurrentScopeKey() {
        let curGrp = '';
        try { curGrp = (typeof window.getCurrentUserGroup === 'function' ? window.getCurrentUserGroup() : '') || localStorage.getItem('elec_app_current_group') || ''; } catch (e) {}
        const isAdminAll = typeof window.isCurrentUserAdmin === 'function' && window.isCurrentUserAdmin() && !normGrp(curGrp);
        return isAdminAll ? '__ADMIN_ALL__' : (normGrp(curGrp) || 'กฟส.บึง');
    }

    function getVisibleScadaPins() {
        let rawPins = [], delMap = {};
        try { rawPins = JSON.parse(localStorage.getItem(STORAGE_KEY_LABELS) || '[]'); } catch (e) {}
        try { delMap = JSON.parse(localStorage.getItem(STORAGE_KEY_DELETED) || '{}'); } catch (e) {}
        if (!Array.isArray(rawPins)) return [];
        const scopeKey = getCurrentScopeKey();
        return rawPins.filter((p) => {
            if (!p?.id || isNaN(parseFloat(p.lat)) || isNaN(parseFloat(p.lon))) return false;
            const delIso = delMap[p.id];
            if (delIso && (new Date(p.updatedAt || 0).getTime() || 0) <= (new Date(delIso).getTime() || 0)) return false;
            if (scopeKey === '__ADMIN_ALL__') return true;
            const fallbackGrp = (p.ownerUser && typeof window.getUserGroupName === 'function') ? window.getUserGroupName(p.ownerUser) : '';
            return (normGrp(p.ownerGroup || fallbackGrp) || 'กฟส.บึง') === scopeKey;
        });
    }

    function isNodeTTap(pin, allPins) {
        if (!pin) return false;
        const explicitType = pin.scadaNode?.t;
        if (explicitType && explicitType !== 'TAP' && explicitType !== 'PIN') return false;
        if (explicitType === 'TAP' || pin.isTTap === true) return true;
        if (/^(?:•\s*)?t-tap\b|จุดแทป|แทปสาย|แทปกลางสาย|หมุดแทป/i.test(`${pin.name || ''} ${pin.note || ''}`)) return true;
        if (Array.isArray(pin.scadaLines) && pin.scadaLines.some((l) => l && (l._ttapTrunk || l._ttapFromId))) return true;
        return Array.isArray(allPins) && allPins.some((p) => p && p.id !== pin.id && Array.isArray(p.scadaLines) && p.scadaLines.some((l) => l && l.to === pin.id && l._ttapId));
    }

    function extractPinFeederCode(pin) {
        if (!pin) return '';
        const explicitFd = String(pin.scadaNode?.fd || '').trim().replace(/\s+/g, '').toUpperCase();
        const mExp = explicitFd.match(/\b([A-Z]{2,4}\d{1,2})\b/);
        if (mExp) return mExp[1];
        if (explicitFd) return explicitFd;
        const m = String(pin.name || '').trim().match(/\b([A-Z]{2,4}\d{1,2})(?:S|VS|VSC|RC|CB|VB|DF|F|-)/i);
        return m ? m[1].toUpperCase() : '';
    }

    // กำหนดให้ทุกหมุดที่เป็น CB, RC หรือ GEN เป็นต้นทางจ่ายไฟทั้งหมด ไม่ว่าจะใช้รหัสหรือชื่ออะไร
    function isSubstationBreakerOrSourceNode(pin) {
        if (!pin) return false;
        const eqT = String(pin.scadaNode?.t || 'PIN').toUpperCase();
        if (eqT === 'CB' || eqT === 'RC' || eqT === 'GEN') return true;
        const nm = String(pin.name || '').trim();
        if (/\(\s*(?:CB|RC)\b/i.test(nm)) return true;
        return false;
    }

    function detectSubstationBusbarHubIds(pins, pinMap, fullPhysAdj) {
        const hubIds = new Set();
        pins.forEach((p) => {
            if (!p) return;
            const eqT = String(p.scadaNode?.t || 'PIN').toUpperCase();
            if (eqT === 'GEN' || /^(?:สฟฟ\.?|สถานีไฟฟ้า)|busbar|\bbus\b/i.test(String(p.name || '').trim())) {
                hubIds.add(p.id);
                return;
            }
            if (isSubstationBreakerOrSourceNode(p)) return;
            const nbs = fullPhysAdj.get(p.id) || [];
            if (nbs.length < 2) return;
            const connectedBreakerFeeders = new Set();
            let breakerCount = 0;
            nbs.forEach((nb) => {
                if ((nb.groundKm ?? nb.lenKm) > 0.65) return;
                const nbP = pinMap.get(nb.toId);
                if (nbP && isSubstationBreakerOrSourceNode(nbP)) {
                    breakerCount++;
                    connectedBreakerFeeders.add(extractPinFeederCode(nbP) || nbP.id);
                }
            });
            if (breakerCount >= 2 && connectedBreakerFeeders.size >= 2) {
                hubIds.add(p.id);
            }
        });
        return hubIds;
    }

    function resolveBranchFeederCode(hubId, firstNextId, edgeFd, pinMap, adj) {
        const explicit = String(edgeFd || '').trim().replace(/\s+/g, '').toUpperCase();
        const mExp = explicit.match(/\b([A-Z]{2,4}\d{1,2})\b/);
        if (mExp) return mExp[1];

        const vis = new Set([hubId, firstNextId]);
        const q = [{ id: firstNextId, depth: 0 }];
        while (q.length > 0) {
            const { id, depth } = q.shift();
            const p = pinMap.get(id);
            const pFd = extractPinFeederCode(p);
            if (pFd) return pFd;
            if (depth >= 8) continue;
            for (const nb of (adj.get(id) || [])) {
                if (vis.has(nb.toId)) continue;
                vis.add(nb.toId);
                const nbEdgeFd = String(nb.fd || '').trim().replace(/\s+/g, '').toUpperCase();
                const mNb = nbEdgeFd.match(/\b([A-Z]{2,4}\d{1,2})\b/);
                if (mNb) return mNb[1];
                q.push({ id: nb.toId, depth: depth + 1 });
            }
        }
        return '';
    }

    function buildTransitHubsAndFeederGate(sourcePinId, pinMap, adj, busbarHubIds) {
        const transitHubIds = new Set();
        const blockedHubExitPairs = new Set();
        const srcPin = pinMap.get(sourcePinId);
        if (!srcPin || !adj.has(sourcePinId)) return { transitHubIds, blockedHubExitPairs };

        const hubs = busbarHubIds || new Set();
        if (hubs.has(sourcePinId)) transitHubIds.add(sourcePinId);

        const isHubOrSource = (id) => {
            const p = pinMap.get(id);
            return hubs.has(id) || isSubstationBreakerOrSourceNode(p);
        };
        const startNbs = adj.get(sourcePinId) || [];
        const hasDirectNonHubExit = startNbs.some((nb) => !isHubOrSource(nb.toId));
        const srcFd = extractPinFeederCode(srcPin);

        if (!hasDirectNonHubExit) {
            const q = [{ id: sourcePinId, distKm: 0 }];
            const vis = new Set([sourcePinId]);
            while (q.length > 0) {
                const cur = q.shift();
                (adj.get(cur.id) || []).forEach((nb) => {
                    if (vis.has(nb.toId)) return;
                    const nextDist = cur.distKm + (nb.groundKm ?? nb.lenKm ?? 0);
                    const nbPin = pinMap.get(nb.toId);
                    const nbFd = extractPinFeederCode(nbPin);
                    const sameOrNeutralFd = !nbFd || !srcFd || nbFd === srcFd;
                    if (nextDist <= 0.85 && (hubs.has(nb.toId) || (isSubstationBreakerOrSourceNode(nbPin) && sameOrNeutralFd))) {
                        vis.add(nb.toId);
                        transitHubIds.add(nb.toId);
                        q.push({ id: nb.toId, distKm: nextDist });
                    }
                });
            }
            if (transitHubIds.size === 0) {
                startNbs.forEach((nb) => {
                    if ((nb.groundKm ?? nb.lenKm ?? 0) <= 0.5 && isHubOrSource(nb.toId)) {
                        transitHubIds.add(nb.toId);
                    }
                });
            }
        }

        if (srcFd && transitHubIds.size > 0) {
            transitHubIds.forEach((hubId) => {
                const outEdges = (adj.get(hubId) || []).filter((nb) => {
                    if (nb.toId === sourcePinId || transitHubIds.has(nb.toId)) return false;
                    return !isSubstationBreakerOrSourceNode(pinMap.get(nb.toId));
                });
                const tagged = outEdges.map((nb) => ({
                    toId: nb.toId,
                    fd: resolveBranchFeederCode(hubId, nb.toId, nb.fd, pinMap, adj)
                }));
                const hasOwnFeederExit = tagged.some((x) => x.fd === srcFd);
                if (hasOwnFeederExit) {
                    tagged.forEach((x) => {
                        if (x.fd && x.fd !== srcFd) {
                            blockedHubExitPairs.add(`${hubId}__${x.toId}`);
                        }
                    });
                }
            });
        }

        return { transitHubIds, blockedHubExitPairs };
    }

    // ========================================================================
    // 4. ประเมินสายกิ่ง 50/95 อัตโนมัติ + ชดเชย X1 สายเคเบิลมุดดิน + กราฟสายส่ง
    // ========================================================================
    function parseExplicitEdgeCable(edgeObj) {
        if (!edgeObj) return null;
        const lb = String(edgeObj.lb || '').toUpperCase();
        if (edgeObj.st === 'ug' || /UG|XLPE|240|เคเบิล|ใต้ดิน|มุดดิน|RISER/.test(lb)) return PEA_22KV_CABLES.UG240;
        if (/50(?![0-9])|35(?![0-9])/.test(lb)) return PEA_22KV_CABLES.SAC50;
        if (/95(?![0-9])/.test(lb)) return PEA_22KV_CABLES.SAC95;
        if (/120(?![0-9])/.test(lb)) return PEA_22KV_CABLES.SAC120;
        if (/185(?![0-9])/.test(lb)) return /AAC|เปลือย/.test(lb) ? PEA_22KV_CABLES.AAC185 : PEA_22KV_CABLES.SAC185;
        return null;
    }

    function buildCanonicalGeomSig(pts, idA, idB, fdStr) {
        const orderedPts = idA <= idB ? pts : [...pts].reverse();
        const geom = orderedPts.map((pt) => `${pt[0].toFixed(5)},${pt[1].toFixed(5)}`).join(';');
        return `${idA <= idB ? `${idA}__${idB}` : `${idB}__${idA}`}|${String(fdStr || '').toUpperCase()}|${geom}`;
    }

    function inferAutomaticLateralProfiles(pins, pinMap, rawEdges, defaultCableKey, autoLateralEnabled) {
        const fallbackCab = PEA_22KV_CABLES[defaultCableKey] || PEA_22KV_CABLES.SAC185;
        const refX1 = fallbackCab.x1 || 0.345;

        if (!autoLateralEnabled) {
            rawEdges.forEach((re) => {
                re.cabProf = re.explicitCab || fallbackCab;
                re.slackFactor = re.cabProf.isUg ? UG_SLACK_FACTOR : 1.0;
                re.elecLenKm = re.groundLenKm * re.slackFactor;
                re.x1Ratio = 1.0;
                re.relayLenKm = re.elecLenKm;
            });
            return;
        }

        const deg = new Map(), inc = new Map();
        pins.forEach((p) => { deg.set(p.id, 0); inc.set(p.id, []); });
        rawEdges.forEach((re, idx) => {
            deg.set(re.uId, (deg.get(re.uId) || 0) + 1);
            deg.set(re.vId, (deg.get(re.vId) || 0) + 1);
            inc.get(re.uId).push({ idx, nb: re.vId });
            inc.get(re.vId).push({ idx, nb: re.uId });
        });

        const peeledNode = new Set(), peeledEdge = new Set(), leafQ = [];
        pins.forEach((p) => {
            const t = p.scadaNode?.t || 'PIN';
            if ((deg.get(p.id) || 0) <= 1 && !MAIN_TRUNK_ANCHOR_TYPES.has(t)) leafQ.push(p.id);
        });

        const curDeg = new Map(deg);
        while (leafQ.length > 0) {
            const lid = leafQ.shift();
            if (peeledNode.has(lid)) continue;
            const lPin = pinMap.get(lid);
            if (MAIN_TRUNK_ANCHOR_TYPES.has(lPin?.scadaNode?.t || 'PIN')) continue;
            peeledNode.add(lid);
            (inc.get(lid) || []).forEach(({ idx, nb }) => {
                if (peeledEdge.has(idx)) return;
                peeledEdge.add(idx);
                const nd = (curDeg.get(nb) || 1) - 1;
                curDeg.set(nb, nd);
                const nbPin = pinMap.get(nb);
                if (nd <= 1 && !MAIN_TRUNK_ANCHOR_TYPES.has(nbPin?.scadaNode?.t || 'PIN')) leafQ.push(nb);
            });
        }

        const rootSeeds = pins.filter((p) => !peeledNode.has(p.id) || isSubstationBreakerOrSourceNode(p)).map((p) => p.id);
        const vis = new Set(rootSeeds), q = [...rootSeeds];
        const treeChildren = new Map(), behindDfNode = new Set();
        pins.forEach((p) => {
            treeChildren.set(p.id, []);
            if (p.scadaNode?.t === 'DF') behindDfNode.add(p.id);
        });

        const bfsOrder = [];
        while (q.length > 0) {
            const u = q.shift();
            bfsOrder.push(u);
            (inc.get(u) || []).forEach(({ idx, nb }) => {
                if (!peeledEdge.has(idx) || vis.has(nb)) return;
                vis.add(nb);
                if (behindDfNode.has(u) || pinMap.get(nb)?.scadaNode?.t === 'DF') behindDfNode.add(nb);
                treeChildren.get(u).push({ idx, child: nb });
                q.push(nb);
            });
        }

        const maxSubtreeKm = new Map();
        for (let i = bfsOrder.length - 1; i >= 0; i--) {
            const u = bfsOrder[i];
            let best = 0;
            (treeChildren.get(u) || []).forEach(({ idx, child }) => {
                const d = rawEdges[idx].groundLenKm + (maxSubtreeKm.get(child) || 0);
                if (d > best) best = d;
            });
            maxSubtreeKm.set(u, best);
        }

        const busHubPreview = new Set();
        pins.forEach((p) => {
            if ((deg.get(p.id) || 0) >= 3) {
                let brkCnt = 0;
                (inc.get(p.id) || []).forEach(({ nb }) => { if (isSubstationBreakerOrSourceNode(pinMap.get(nb))) brkCnt++; });
                if (brkCnt >= 2) busHubPreview.add(p.id);
            }
        });

        const lateralEdgeAuto = new Map();
        bfsOrder.forEach((u) => {
            const children = treeChildren.get(u) || [];
            if (!children.length) return;
            const uPin = pinMap.get(u);
            const uIsStationOrRc = isSubstationBreakerOrSourceNode(uPin) || busHubPreview.has(u);
            const uIsJunction = !uIsStationOrRc && ((deg.get(u) || 0) >= 3 || isNodeTTap(uPin, pins));
            let longestChildIdx = -1, longestReach = -1;
            children.forEach(({ idx, child }) => {
                const r = rawEdges[idx].groundLenKm + (maxSubtreeKm.get(child) || 0);
                if (r > longestReach) { longestReach = r; longestChildIdx = idx; }
            });

            children.forEach(({ idx, child }) => {
                const re = rawEdges[idx];
                const childPin = pinMap.get(child);
                const spurTotalKm = re.groundLenKm + (maxSubtreeKm.get(child) || 0);
                const isDfBranch = behindDfNode.has(u) || uPin?.scadaNode?.t === 'DF' || childPin?.scadaNode?.t === 'DF';
                const isExplicitTap = Boolean(re.edge?._ttapTap && !re.edge?._ttapTrunk);
                const isShortSideSpur = uIsJunction && (idx !== longestChildIdx || isExplicitTap) && !re.edge?._ttapTrunk && spurTotalKm <= 2.3;

                if (isDfBranch || isShortSideSpur) {
                    const autoProf = spurTotalKm <= 1.35 ? PEA_22KV_CABLES.SAC50 : PEA_22KV_CABLES.SAC95;
                    lateralEdgeAuto.set(idx, autoProf);
                    const subQ = [child];
                    while (subQ.length > 0) {
                        const cur = subQ.shift();
                        (treeChildren.get(cur) || []).forEach((sc) => {
                            if (!lateralEdgeAuto.has(sc.idx)) lateralEdgeAuto.set(sc.idx, PEA_22KV_CABLES.SAC50);
                            subQ.push(sc.child);
                        });
                    }
                }
            });
        });

        rawEdges.forEach((re, idx) => {
            const chosen = re.explicitCab || lateralEdgeAuto.get(idx) || fallbackCab;
            re.cabProf = chosen;
            re.isAutoLateral = Boolean(!re.explicitCab && lateralEdgeAuto.has(idx));
            re.behindDf = Boolean(behindDfNode.has(re.uId) || behindDfNode.has(re.vId) || pinMap.get(re.uId)?.scadaNode?.t === 'DF' || pinMap.get(re.vId)?.scadaNode?.t === 'DF');
            re.slackFactor = chosen.isUg ? UG_SLACK_FACTOR : OVERHEAD_SAG_FACTOR;
            re.elecLenKm = re.groundLenKm * re.slackFactor;
            re.x1Ratio = chosen.x1 / refX1;
            re.relayLenKm = re.elecLenKm * re.x1Ratio;
        });
    }

    function buildScadaGraphs(pins, pinMap, stopAtOpenSwitch, cableKey, autoLateralEnabled = true, bypassOpenSet = null) {
        const adj = new Map(), fullPhysAdj = new Map(), rawActiveEdges = [], rawPhysEdges = [];
        const seenPhysGeom = new Set(), seenActiveGeom = new Set();
        pins.forEach((p) => { adj.set(p.id, []); fullPhysAdj.set(p.id, []); });

        pins.forEach((p) => {
            (p.scadaLines || []).forEach((e, idx) => {
                const dst = pinMap.get(e?.to);
                if (!dst || dst.id === p.id) return;
                const fwdPts = [[Number(p.lat), Number(p.lon)], ...(e.w || []).map((w) => [Number(w[0]), Number(w[1])]), [Number(dst.lat), Number(dst.lon)]];
                let groundLenKm = 0;
                for (let i = 0; i < fwdPts.length - 1; i++) groundLenKm += haversineKm(fwdPts[i][0], fwdPts[i][1], fwdPts[i + 1][0], fwdPts[i + 1][1]);
                if (groundLenKm <= 0) return;

                const explicitCab = parseExplicitEdgeCable(e);
                const geomSig = buildCanonicalGeomSig(fwdPts, p.id, dst.id, e.fd);
                if (!seenPhysGeom.has(geomSig)) {
                    seenPhysGeom.add(geomSig);
                    rawPhysEdges.push({ uId: p.id, vId: dst.id, groundLenKm, explicitCab, edge: e });
                }

                const isBypassedWire = Boolean(bypassOpenSet && (bypassOpenSet.has(p.id) || bypassOpenSet.has(dst.id)));
                if (stopAtOpenSwitch && !isBypassedWire && (e.manualNO === true || e.st === 'O')) return;
                if (seenActiveGeom.has(geomSig)) return;
                seenActiveGeom.add(geomSig);

                rawActiveEdges.push({
                    edgeId: `${p.id}__${idx}`, uId: p.id, vId: dst.id,
                    fwdPts, revPts: [...fwdPts].reverse(),
                    groundLenKm, explicitCab, edge: e
                });
            });
        });

        inferAutomaticLateralProfiles(pins, pinMap, rawPhysEdges, cableKey || 'SAC185', autoLateralEnabled);
        inferAutomaticLateralProfiles(pins, pinMap, rawActiveEdges, cableKey || 'SAC185', autoLateralEnabled);

        rawPhysEdges.forEach((pe) => {
            const eFd = pe.edge?.fd || '';
            const isExplicitUg = Boolean(pe.explicitCab?.isUg);
            fullPhysAdj.get(pe.uId).push({ toId: pe.vId, lenKm: pe.elecLenKm, relayKm: pe.relayLenKm, groundKm: pe.groundLenKm, cabProf: pe.cabProf, fd: eFd, isExplicitUg });
            fullPhysAdj.get(pe.vId).push({ toId: pe.uId, lenKm: pe.elecLenKm, relayKm: pe.relayLenKm, groundKm: pe.groundLenKm, cabProf: pe.cabProf, fd: eFd, isExplicitUg });
        });

        rawActiveEdges.forEach((ae) => {
            const eFd = ae.edge?.fd || '';
            const isExplicitUg = Boolean(ae.explicitCab?.isUg);
            adj.get(ae.uId).push({ toId: ae.vId, lenKm: ae.elecLenKm, relayKm: ae.relayLenKm, groundKm: ae.groundLenKm, cabProf: ae.cabProf, pts: ae.fwdPts, fd: eFd, isExplicitUg });
            adj.get(ae.vId).push({ toId: ae.uId, lenKm: ae.elecLenKm, relayKm: ae.relayLenKm, groundKm: ae.groundLenKm, cabProf: ae.cabProf, pts: ae.revPts, fd: eFd, isExplicitUg });
        });

        const busbarHubIds = detectSubstationBusbarHubIds(pins, pinMap, fullPhysAdj);
        return { adj, fullPhysAdj, physicalEdges: rawActiveEdges, busbarHubIds };
    }

    // ========================================================================
    // 5. เรขาคณิตตัดเส้นสาย, คำนวณสายต้นน้ำ + บวกสาย UG ในสถานี 150 ม. ทุกวงจรจ่ายไฟ
    // ========================================================================
    function resolveRealDestinationName(startToId, fromId, pinMap, adj, allPins) {
        const firstPin = pinMap.get(startToId);
        if (!firstPin) return '-';
        if (!isNodeTTap(firstPin, allPins)) return firstPin.name || '-';
        const foundNames = [], vis = new Set([fromId, startToId]), q = [{ id: startToId, depth: 0 }];
        while (q.length > 0 && foundNames.length < 2) {
            const { id, depth } = q.shift();
            if (depth >= 12) continue;
            const cur = pinMap.get(id);
            const trunkTargets = (cur?.scadaLines || []).filter((l) => l?._ttapTrunk && l.to && !vis.has(l.to)).map((l) => l.to);
            const nextIds = trunkTargets.length > 0 ? trunkTargets : (adj.get(id) || []).map((n) => n.toId).filter((nid) => !vis.has(nid));
            for (const nid of nextIds) {
                vis.add(nid);
                const np = pinMap.get(nid);
                if (!np) continue;
                if (!isNodeTTap(np, allPins)) { foundNames.push(np.name); if (foundNames.length >= 2) break; }
                else q.push({ id: nid, depth: depth + 1 });
            }
        }
        return foundNames.length > 0 ? foundNames.join(' / ') : (firstPin.name || '-');
    }

    function slicePolylineUpToGroundKm(pts, targetGroundKm) {
        if (!pts?.length) return { path: [], point: [0, 0] };
        if (pts.length === 1 || targetGroundKm <= 0) return { path: [pts[0]], point: pts[0] };
        const out = [pts[0]];
        let acc = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            const seg = haversineKm(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
            if (acc + seg >= targetGroundKm) {
                const t = seg > 1e-9 ? Math.max(0, Math.min(1, (targetGroundKm - acc) / seg)) : 0;
                const pt = [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])];
                out.push(pt);
                return { path: out, point: pt };
            }
            out.push(pts[i + 1]);
            acc += seg;
        }
        return { path: out, point: pts[pts.length - 1] };
    }

    function slicePolylineBetweenGroundKm(pts, startGroundKm, endGroundKm) {
        if (!pts || pts.length < 2 || endGroundKm <= startGroundKm) return [];
        const pStart = slicePolylineUpToGroundKm(pts, startGroundKm).point;
        const pEnd = slicePolylineUpToGroundKm(pts, endGroundKm).point;
        const out = [pStart];
        let acc = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            acc += haversineKm(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
            if (acc > startGroundKm + 1e-5 && acc < endGroundKm - 1e-5) out.push(pts[i + 1]);
        }
        out.push(pEnd);
        return out;
    }

    function isBarrierTerminalNode(pin, sourcePin, stopAtOpenSwitch, bypassOpenSet = null, busbarHubIds = null, transitHubIds = null) {
        if (!pin || !sourcePin || pin.id === sourcePin.id) return false;
        if (transitHubIds && transitHubIds.has(pin.id)) return false;
        if (busbarHubIds && busbarHubIds.has(pin.id)) return true;
        if (isSubstationBreakerOrSourceNode(pin)) return true;
        if (bypassOpenSet && bypassOpenSet.has(pin.id)) return false;
        const eqT = pin.scadaNode?.t || 'PIN';
        return Boolean(stopAtOpenSwitch && SWITCHABLE_TYPES.has(eqT) && (pin.scadaNode?.st || 'C') === 'O');
    }

    function isNodeOnAncestorChain(nodeId, targetAncestorId, parentMap) {
        if (!nodeId || !targetAncestorId) return false;
        if (nodeId === targetAncestorId) return true;
        let cur = nodeId;
        const seen = new Set();
        while (parentMap.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            cur = parentMap.get(cur).prevId;
            if (cur === targetAncestorId) return true;
        }
        return false;
    }

    function hasAnyAncestorInSet(nodeId, targetSet, parentMap) {
        if (!nodeId || !targetSet || targetSet.size === 0) return false;
        if (targetSet.has(nodeId)) return true;
        let cur = nodeId;
        const seen = new Set();
        while (parentMap.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            cur = parentMap.get(cur).prevId;
            if (targetSet.has(cur)) return true;
        }
        return false;
    }

    function collectDownstreamSamplePoints(startNodeId, blockBackNodeId, adj, parentMap, maxNodes = 80) {
        const pts = [];
        const vis = new Set([blockBackNodeId, startNodeId]);
        const q = [startNodeId];
        while (q.length > 0 && vis.size < maxNodes) {
            const u = q.shift();
            (adj.get(u) || []).forEach((nb) => {
                if (vis.has(nb.toId)) return;
                if (parentMap.get(nb.toId)?.prevId !== u) return;
                vis.add(nb.toId);
                if (Array.isArray(nb.pts)) nb.pts.forEach((pt) => pts.push(pt));
                q.push(nb.toId);
            });
        }
        return pts;
    }

    function findNearbyLandmarkPin(lat, lon, pins, excludeRefName) {
        let best = null, bestScore = -Infinity;
        pins.forEach((p) => {
            if (!p || isNodeTTap(p, pins)) return;
            const dKm = haversineKm(lat, lon, Number(p.lat), Number(p.lon));
            if (dKm > 0.18) return;
            const dMeters = Math.round(dKm * 1000);
            if (p.name === excludeRefName && dMeters > 25) return;
            const fullTxt = `${p.name || ''} ${p.note || ''}`;
            const isTx = /\b\d{2}-\d{5,7}\b|\bkva\b|หม้อแปลง|TR\b/i.test(fullTxt);
            const score = (isTx ? 60 : 0) - dMeters * 0.5;
            if (score > bestScore) {
                bestScore = score;
                best = { name: p.name, note: p.note || '', distMeters: dMeters, isTx };
            }
        });
        return best;
    }

    function getRecentActiveOutageReports() {
        const out = [];
        if (incomingReporterCoords && !isNaN(incomingReporterCoords.lat) && !isNaN(incomingReporterCoords.lon)) {
            out.push({ lat: incomingReporterCoords.lat, lon: incomingReporterCoords.lon, label: 'พิกัดแจ้งเหตุในฟอร์ม TR/TL', isPrimary: true });
        }
        let jobs = [], closedReg = {}, delReg = {}, shortCache = {};
        try { jobs = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]'); } catch (e) {}
        try { closedReg = JSON.parse(localStorage.getItem('elec_closed_jobs_registry') || '{}'); } catch (e) {}
        try { delReg = JSON.parse(localStorage.getItem('elec_deleted_jobs_registry') || '{}'); } catch (e) {}
        try { shortCache = JSON.parse(localStorage.getItem(SHORT_LINK_CACHE_KEY) || '{}'); } catch (e) {}
        if (!Array.isArray(jobs)) return out;

        const nowMs = Date.now();
        const MAX_AGE_MS = 14 * 60 * 60 * 1000;
        const parseCoordsFn = window.deepParseCoords || (() => null);

        jobs.forEach((j) => {
            if (!j || (j.dateTimeSaved && delReg[j.dateTimeSaved])) return;
            if (typeof window.canCurrentUserSeeJob === 'function' && !window.canCurrentUserSeeJob(j)) return;

            const rep = j.techReport || (j.dateTimeSaved ? closedReg[j.dateTimeSaved] : null);
            const isClosed = Boolean(rep && String(rep.status || '').includes('เสร็จสิ้น') && (!j.reopenedAt || String(rep.updatedAt || '') >= String(j.reopenedAt)));
            if (isClosed) return;

            let jobMs = Number(j.createdAtMs || 0);
            if (!jobMs && j.dateTimeSaved) {
                const p = String(j.dateTimeSaved).trim().split(/\s+/), dp = (p[0] || '').split('/');
                if (dp.length === 3) {
                    let yr = parseInt(dp[2], 10) || 2569; if (yr > 2400) yr -= 543;
                    const tp = (p[1] || '00:00').split(/[:.]/);
                    jobMs = new Date(yr, (parseInt(dp[1], 10) || 1) - 1, parseInt(dp[0], 10) || 1, parseInt(tp[0], 10) || 0, parseInt(tp[1], 10) || 0).getTime() || 0;
                }
            }
            if (jobMs > 0 && Math.abs(nowMs - jobMs) > MAX_AGE_MS) return;

            const rawGps = String(j.gps || '').trim();
            let c = parseCoordsFn(rawGps) || parseCoordsFn(j.address || '');
            if (!c && rawGps) {
                const cleanUrl = rawGps.split('?')[0].replace(/^(?!https?:\/\/)/i, 'https://');
                if (shortCache[cleanUrl]?.lat) c = shortCache[cleanUrl];
            }
            if (c && !isNaN(c.lat) && !isNaN(c.lon)) {
                const desc = [j.issueType, j.area].filter((x) => x && x !== '-').join(' • ') || 'รับแจ้งไฟดับ';
                out.push({ lat: Number(c.lat), lon: Number(c.lon), label: desc, isPrimary: false });
            }
        });
        return out.slice(0, 40);
    }

    function getHistoricalFaultHotspots() {
        const hotspots = [];
        let outJobs = [], fltJobs = [], closedReg = {}, delReg = {}, shortCache = {};
        try { outJobs = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]'); } catch (e) {}
        try { fltJobs = JSON.parse(localStorage.getItem('fault_reports_all') || '[]'); } catch (e) {}
        try { closedReg = JSON.parse(localStorage.getItem('elec_closed_jobs_registry') || '{}'); } catch (e) {}
        try { delReg = JSON.parse(localStorage.getItem('elec_deleted_jobs_registry') || '{}'); } catch (e) {}
        try { shortCache = JSON.parse(localStorage.getItem(SHORT_LINK_CACHE_KEY) || '{}'); } catch (e) {}

        const parseCoordsFn = window.deepParseCoords || (() => null);
        const mvCauseRe = /ฟิวส์แรงสูง|Drop\s*Out|กิ่งไม้|ต้นไม้|สัตว์|งู|กระรอก|นก|อีกา|ลูกถ้วย|สายขาด|สายแรงสูง|เสาหัก|ฟ้าผ่า/i;
        const nowMs = Date.now();

        [...(Array.isArray(fltJobs) ? fltJobs : []), ...(Array.isArray(outJobs) ? outJobs : [])].forEach((j) => {
            if (!j) return;
            const rk = j.timestamp || j.dateTimeSaved;
            if (rk && delReg[rk]) return;
            if (typeof window.canCurrentUserSeeJob === 'function' && !window.canCurrentUserSeeJob(j)) return;

            const jMs = Number(j.createdAtMs || 0) || (j.timestamp ? new Date(j.timestamp).getTime() : 0);
            if (jMs > 0 && Math.abs(nowMs - jMs) < 2 * 3600000) return;

            const rep = j.techReport || (rk ? closedReg[rk] : null);
            const causeStr = [rep?.realCause, j.reporter, j.issueType, j.cause].filter((x) => x && x !== '-').join(' ');
            if (!j.circuit && !mvCauseRe.test(causeStr)) return;

            const rawGps = String(rep?.fieldGps || j.gps || '').trim();
            let c = parseCoordsFn(rawGps);
            if (!c && rawGps) {
                const cleanUrl = rawGps.split('?')[0].replace(/^(?!https?:\/\/)/i, 'https://');
                if (shortCache[cleanUrl]?.lat) c = shortCache[cleanUrl];
            }
            if (c && !isNaN(c.lat) && !isNaN(c.lon)) {
                const shortCause = (rep?.realCause && rep.realCause !== '-') ? rep.realCause : (j.reporter || j.issueType || 'เหตุแรงสูง');
                hotspots.push({ lat: Number(c.lat), lon: Number(c.lon), cause: String(shortCause).slice(0, 38) });
            }
        });
        return hotspots.slice(0, 80);
    }

    function computeUpstreamFilterAndVector(sourcePinId, pins, pinMap, activeAdj, fullPhysAdj, busbarHubIds = null, transitHubIds = null, stationUgEnabled = true) {
        const zeroVec = { r1: 0, x1: 0, r0: 0, x0: 0 };
        const srcPin = pinMap.get(sourcePinId);
        const hubs = busbarHubIds || new Set();
        const transits = transitHubIds || new Set();
        if (!srcPin) {
            return { blockedNodes: new Set(), blockedStartNeighbors: new Set(), upstreamVec: zeroVec, upstreamKm: 0, stationUgKm: 0, parentBrkId: '', parentBrkName: '' };
        }

        // ทุกหมุดที่เป็น CB / RC / GEN คือต้นทางจ่ายไฟทั้งหมด และบวกค่าสาย UG ในสถานี 150 ม. (0.15 กม.) เข้าเป็นฐานของทุกวงจรจ่ายไฟอัตโนมัติ
        if (isSubstationBreakerOrSourceNode(srcPin) || hubs.has(sourcePinId)) {
            const stUg = computeEffectiveStationUgVector(sourcePinId, fullPhysAdj, stationUgEnabled);
            const blockedNodes = new Set(), blockedStartNeighbors = new Set();
            if (!hubs.has(sourcePinId)) {
                (fullPhysAdj.get(sourcePinId) || []).forEach((nb) => {
                    if (transits.has(nb.toId)) return;
                    const nbP = pinMap.get(nb.toId);
                    if (!nbP) return;
                    if (hubs.has(nb.toId) || isSubstationBreakerOrSourceNode(nbP)) {
                        blockedNodes.add(nb.toId);
                        blockedStartNeighbors.add(nb.toId);
                    }
                });
            }
            const hasActiveExit = (activeAdj.get(sourcePinId) || []).some((nb) => !blockedStartNeighbors.has(nb.toId));
            if (!hasActiveExit) {
                blockedNodes.clear();
                blockedStartNeighbors.clear();
            }
            return {
                blockedNodes,
                blockedStartNeighbors,
                upstreamVec: { r1: stUg.r1, x1: stUg.x1, r0: stUg.r0, x0: stUg.x0 },
                upstreamKm: 0,
                stationUgKm: stUg.km,
                parentBrkId: '',
                parentBrkName: ''
            };
        }

        const runDijkstra = (adjGraph, startId, ignoreOpenSw, skipNodeId = null) => {
            const dMap = new Map([[startId, 0]]), vMap = new Map([[startId, { ...zeroVec }]]), vis = new Set(), pq = [{ id: startId, d: 0 }];
            while (pq.length > 0) {
                pq.sort((a, b) => a.d - b.d);
                const { id: u, d: du } = pq.shift();
                if (vis.has(u)) continue;
                vis.add(u);
                if (u !== startId) {
                    const uP = pinMap.get(u), eqT = uP?.scadaNode?.t || 'PIN', st = uP?.scadaNode?.st || 'C';
                    if (isSubstationBreakerOrSourceNode(uP) || hubs.has(u)) continue;
                    if (!ignoreOpenSw && SWITCHABLE_TYPES.has(eqT) && st === 'O') continue;
                }
                const uVec = vMap.get(u) || zeroVec;
                (adjGraph.get(u) || []).forEach((nb) => {
                    if (nb.toId === skipNodeId) return;
                    const nbP = pinMap.get(nb.toId), nbT = nbP?.scadaNode?.t || 'PIN', nbSt = nbP?.scadaNode?.st || 'C';
                    if (!ignoreOpenSw && !isSubstationBreakerOrSourceNode(nbP) && !hubs.has(nb.toId) && SWITCHABLE_TYPES.has(nbT) && nbSt === 'O') return;
                    const nd = du + nb.lenKm;
                    if (nd < (dMap.get(nb.toId) ?? Infinity)) {
                        dMap.set(nb.toId, nd);
                        const cp = nb.cabProf || PEA_22KV_CABLES.SAC185;
                        vMap.set(nb.toId, {
                            r1: uVec.r1 + cp.r1 * nb.lenKm, x1: uVec.x1 + cp.x1 * nb.lenKm,
                            r0: uVec.r0 + cp.r0 * nb.lenKm, x0: uVec.x0 + cp.x0 * nb.lenKm
                        });
                        pq.push({ id: nb.toId, d: nd });
                    }
                });
            }
            return { dMap, vMap };
        };

        const srcFd = extractPinFeederCode(srcPin);
        const allPowerSources = pins.filter((p) => p.id !== sourcePinId && (isSubstationBreakerOrSourceNode(p) || hubs.has(p.id)));
        const isCompatibleRoot = (b, strictSameFeeder) => {
            const bFd = extractPinFeederCode(b);
            if (strictSameFeeder) return Boolean(srcFd && bFd && bFd === srcFd);
            if (srcFd && bFd && bFd !== srcFd) return false;
            return true;
        };

        let useGraph = activeAdj, ignoreOpen = false;
        let resFromSrc = runDijkstra(useGraph, sourcePinId, false, null);
        let rootPool = allPowerSources.filter((b) => resFromSrc.dMap.has(b.id) && isCompatibleRoot(b, false));

        if (!rootPool.length) {
            rootPool = allPowerSources.filter((b) => resFromSrc.dMap.has(b.id));
        }
        if (!rootPool.length && srcFd) {
            const sameFdRoots = allPowerSources.filter((b) => isCompatibleRoot(b, true));
            if (sameFdRoots.length > 0) {
                useGraph = fullPhysAdj;
                ignoreOpen = true;
                resFromSrc = runDijkstra(useGraph, sourcePinId, true, null);
                rootPool = sameFdRoots.filter((b) => resFromSrc.dMap.has(b.id));
            }
        }
        if (!rootPool.length) {
            const stUgFallback = computeEffectiveStationUgVector(sourcePinId, fullPhysAdj, stationUgEnabled);
            return {
                blockedNodes: new Set(),
                blockedStartNeighbors: new Set(),
                upstreamVec: { r1: stUgFallback.r1, x1: stUgFallback.x1, r0: stUgFallback.r0, x0: stUgFallback.x0 },
                upstreamKm: 0,
                stationUgKm: stUgFallback.km,
                parentBrkId: '',
                parentBrkName: ''
            };
        }

        rootPool.sort((a, b) => {
            const aClosed = (a.scadaNode?.st || 'C') !== 'O' ? 1 : 0, bClosed = (b.scadaNode?.st || 'C') !== 'O' ? 1 : 0;
            const aFd = (srcFd && extractPinFeederCode(a) === srcFd) ? 1 : 0;
            const bFd = (srcFd && extractPinFeederCode(b) === srcFd) ? 1 : 0;
            return (bFd - aFd) || (bClosed - aClosed) || ((resFromSrc.dMap.get(a.id) ?? Infinity) - (resFromSrc.dMap.get(b.id) ?? Infinity));
        });

        const parentBrk = rootPool[0];
        const stUgRoot = computeEffectiveStationUgVector(parentBrk.id, fullPhysAdj, stationUgEnabled);
        const withSrc = runDijkstra(useGraph, parentBrk.id, ignoreOpen, null);
        const withoutSrc = runDijkstra(useGraph, parentBrk.id, ignoreOpen, sourcePinId);
        const srcDistFromBrk = withSrc.dMap.get(sourcePinId) ?? 0;
        const lineUpVec = withSrc.vMap.get(sourcePinId) || zeroVec;
        const upstreamVec = {
            r1: stUgRoot.r1 + lineUpVec.r1,
            x1: stUgRoot.x1 + lineUpVec.x1,
            r0: stUgRoot.r0 + lineUpVec.r0,
            x0: stUgRoot.x0 + lineUpVec.x0
        };
        const blockedNodes = new Set([parentBrk.id]), blockedStartNeighbors = new Set();

        (useGraph.get(sourcePinId) || []).forEach((nb) => {
            if (transits.has(nb.toId)) return;
            const nbDist = withoutSrc.dMap.get(nb.toId);
            if (nbDist !== undefined && nbDist + nb.lenKm <= srcDistFromBrk + 0.02) { blockedStartNeighbors.add(nb.toId); blockedNodes.add(nb.toId); }
        });
        const hasDownstreamLeft = (activeAdj.get(sourcePinId) || []).some((nb) => !blockedStartNeighbors.has(nb.toId));
        return hasDownstreamLeft
            ? { blockedNodes, blockedStartNeighbors, upstreamVec, upstreamKm: srcDistFromBrk, stationUgKm: stUgRoot.km, parentBrkId: parentBrk.id, parentBrkName: parentBrk.name || '' }
            : { blockedNodes: new Set(), blockedStartNeighbors: new Set(), upstreamVec, upstreamKm: srcDistFromBrk, stationUgKm: stUgRoot.km, parentBrkId: parentBrk.id, parentBrkName: parentBrk.name || '' };
    }

    function findAmpHitDistanceOnSpan(vecStart, cabProfile, spanElecLimitKm, targetAmp, faultType, srcBus, rfOhm, busKv, calFactor, allowClampOrigin) {
        const addSpanVec = (elecKm) => ({
            r1: vecStart.r1 + cabProfile.r1 * elecKm, x1: vecStart.x1 + cabProfile.x1 * elecKm,
            r0: vecStart.r0 + cabProfile.r0 * elecKm, x0: vecStart.x0 + cabProfile.x0 * elecKm
        });
        const iStart = calcFaultCurrentAtVector(vecStart, faultType, srcBus, rfOhm, busKv, calFactor);
        const iEnd = calcFaultCurrentAtVector(addSpanVec(spanElecLimitKm), faultType, srcBus, rfOhm, busKv, calFactor);
        if (targetAmp > iStart) {
            return allowClampOrigin ? { hit: true, deltaElecKm: Math.min(0.02, spanElecLimitKm * 0.5) } : { hit: false, exceedsOriginAmp: iStart };
        }
        if (targetAmp < iEnd) return { hit: false, minAmpAtEnd: iEnd };
        let lo = 0, hi = spanElecLimitKm;
        for (let iter = 0; iter < 26; iter++) {
            const mid = (lo + hi) / 2;
            if (calcFaultCurrentAtVector(addSpanVec(mid), faultType, srcBus, rfOhm, busKv, calFactor) > targetAmp) lo = mid;
            else hi = mid;
        }
        return { hit: true, deltaElecKm: (lo + hi) / 2 };
    }
    // ===== จบพาทที่ 1 / 2 ของไฟล์ scada-fault-locator.js (v3.5) =====
        // ===== เริ่มพาทที่ 2 / 2 ของไฟล์ scada-fault-locator.js (v3.5 — วางต่อจากพาทที่ 1 / 2 จนจบไฟล์) =====
    // ========================================================================
    // 6. แกนประมวลผลคำนวณระยะสายหลัก + รวมสาย UG สถานี 150 ม. ทั้งโหมดกระแสและรีเลย์
    // ========================================================================
    function collectValidWiredPinIds(pins) {
        const pinIdSet = new Set(pins.map((p) => p.id));
        const wiredIds = new Set();
        pins.forEach((p) => {
            (p.scadaLines || []).forEach((l) => {
                if (l?.to && l.to !== p.id && pinIdSet.has(l.to)) {
                    wiredIds.add(p.id);
                    wiredIds.add(l.to);
                }
            });
        });
        return wiredIds;
    }

    function resolveWiredTwinSourcePin(sourcePinId, pins, wiredIds) {
        const rawPin = pins.find((p) => p.id === sourcePinId);
        if (!rawPin || wiredIds.has(sourcePinId)) return rawPin || null;

        const cleanName = String(rawPin.name || '').trim().toLowerCase();
        const codeMatch = cleanName.match(/\b([a-z]{2,4}\d{1,2}(?:s|cb|rc|vb|vs|vsc|f)-\d+)\b/i);
        const coreCode = codeMatch ? codeMatch[1].toLowerCase() : cleanName;
        const rawFd = extractPinFeederCode(rawPin);

        const wiredCandidates = pins.filter((p) => p.id !== sourcePinId && wiredIds.has(p.id) && !isNodeTTap(p, pins));
        const exactTwin = wiredCandidates.find((p) => {
            const pName = String(p.name || '').trim().toLowerCase();
            return pName === cleanName || (coreCode.length >= 4 && pName.includes(coreCode));
        });
        if (exactTwin) return exactTwin;

        if (rawFd) {
            const fdBreakerTwin = wiredCandidates.find((p) => isSubstationBreakerOrSourceNode(p) && extractPinFeederCode(p) === rawFd);
            if (fdBreakerTwin) return fdBreakerTwin;
        }
        return rawPin;
    }

    function traceFaultLocations(sourcePinId, targetKm, tolKm, stopAtOpenSwitch, downstreamOnly, ampCalcCfg = null, filterOpts = {}) {
        const pins = getVisibleScadaPins();
        const wiredIds = collectValidWiredPinIds(pins);
        const resolvedSrcPin = resolveWiredTwinSourcePin(sourcePinId, pins, wiredIds);
        if (!resolvedSrcPin) return { error: 'ไม่พบหมุดต้นทางที่เลือกในผัง' };

        const effectiveSourceId = resolvedSrcPin.id;
        const pinMap = new Map(pins.map((p) => [p.id, p]));
        const srcPin = pinMap.get(effectiveSourceId);

        const autoLateral = filterOpts.autoLateral !== false;
        const stationUg = filterOpts.stationUg !== false;
        const mustPassId = (filterOpts.mustPassId && filterOpts.mustPassId !== effectiveSourceId && pinMap.has(filterOpts.mustPassId)) ? filterOpts.mustPassId : '';
        const bypassIsolateId = (filterOpts.bypassIsolateId && filterOpts.bypassIsolateId !== effectiveSourceId && pinMap.has(filterOpts.bypassIsolateId)) ? filterOpts.bypassIsolateId : '';
        const notPassSet = new Set(Array.from(filterOpts.notPassIds || []).filter((id) => id && id !== effectiveSourceId && id !== mustPassId && pinMap.has(id)));
        const bypassOpenSet = new Set([effectiveSourceId, mustPassId, bypassIsolateId].filter(Boolean));
        const tripStatus = filterOpts.tripStatus || 'AUTO';

        const { adj, fullPhysAdj, physicalEdges, busbarHubIds } = buildScadaGraphs(pins, pinMap, stopAtOpenSwitch, ampCalcCfg?.cableKey || 'SAC185', autoLateral, bypassOpenSet);
        const { transitHubIds, blockedHubExitPairs } = buildTransitHubsAndFeederGate(effectiveSourceId, pinMap, adj, busbarHubIds);

        if (mustPassId && !busbarHubIds.has(mustPassId)) transitHubIds.add(mustPassId);
        if (bypassIsolateId && !busbarHubIds.has(bypassIsolateId)) transitHubIds.add(bypassIsolateId);

        const lockedFd = filterOpts._lockedFeederCode || '';
        if (lockedFd && !extractPinFeederCode(srcPin)) {
            [effectiveSourceId, ...Array.from(transitHubIds)].forEach((hubId) => {
                const outEdges = (adj.get(hubId) || []).filter((nb) => nb.toId !== effectiveSourceId && !transitHubIds.has(nb.toId));
                const tagged = outEdges.map((nb) => ({
                    toId: nb.toId,
                    fd: resolveBranchFeederCode(hubId, nb.toId, nb.fd, pinMap, adj)
                }));
                if (tagged.some((x) => x.fd === lockedFd)) {
                    tagged.forEach((x) => {
                        if (x.fd && x.fd !== lockedFd) blockedHubExitPairs.add(`${hubId}__${x.toId}`);
                    });
                }
            });
        }

        const startEdges = adj.get(effectiveSourceId) || [];
        if (startEdges.length > 0 && startEdges.every((nb) => isBarrierTerminalNode(pinMap.get(nb.toId), srcPin, stopAtOpenSwitch, bypassOpenSet, busbarHubIds, transitHubIds))) {
            const srcFd = extractPinFeederCode(srcPin) || lockedFd;
            startEdges.forEach((nb) => {
                transitHubIds.add(nb.toId);
                if (srcFd) {
                    const outFromNb = (adj.get(nb.toId) || []).filter((x) => x.toId !== effectiveSourceId);
                    const tagged = outFromNb.map((x) => ({ toId: x.toId, fd: resolveBranchFeederCode(nb.toId, x.toId, x.fd, pinMap, adj) }));
                    if (tagged.some((t) => t.fd === srcFd)) {
                        tagged.forEach((t) => { if (t.fd && t.fd !== srcFd) blockedHubExitPairs.add(`${nb.toId}__${t.toId}`); });
                    }
                }
            });
        }

        const upInfo = computeUpstreamFilterAndVector(effectiveSourceId, pins, pinMap, adj, fullPhysAdj, busbarHubIds, transitHubIds, stationUg);
        const upFilter = downstreamOnly ? upInfo : { blockedNodes: new Set(), blockedStartNeighbors: new Set() };
        const useUpstreamZ = !ampCalcCfg || ampCalcCfg.sourceKey !== 'IDEAL_ZERO';
        const stUgOnlyVec = stationUg ? getStationExitUgVector((upInfo.stationUgKm || 0) * 1000) : { r1: 0, x1: 0, r0: 0, x0: 0 };
        const initVec = useUpstreamZ ? upInfo.upstreamVec : stUgOnlyVec;
        const stationUgMeters = Math.round((upInfo.stationUgKm || 0) * 1000);

        const useMultiCableAmp = Boolean(ampCalcCfg && ampCalcCfg.ampVal > 0 && ampCalcCfg.useAmpSolver !== false);
        const srcBus = ampCalcCfg ? (PEA_SOURCE_BUS_PRESETS[ampCalcCfg.sourceKey] || PEA_SOURCE_BUS_PRESETS.SUB_50MVA) : PEA_SOURCE_BUS_PRESETS.SUB_50MVA;
        const busKv = ampCalcCfg?.busKv || DEFAULT_BUS_KV;
        const calFactor = ampCalcCfg?.calFactor || 1.0;
        const maxOriginAmp = ampCalcCfg ? Math.round(calcFaultCurrentAtVector(initVec, ampCalcCfg.faultType, srcBus, ampCalcCfg.rfOhm, busKv, calFactor)) : 0;
        const allowClampAtRoot = !useUpstreamZ || upInfo.upstreamKm <= 0.05;

        // กรณีเลือกสวิตช์ลูกข่าย (VS/VB/S/DF) แล้วกรอกกระแสสูงเกินพิกัดจุดนั้น ให้ถอยกลับไปเริ่มวัดจากต้นทาง CB/RC ของวงจรให้อัตโนมัติ
        if (useMultiCableAmp && !allowClampAtRoot && ampCalcCfg.ampVal > maxOriginAmp && upInfo.parentBrkId && upInfo.parentBrkId !== effectiveSourceId && !filterOpts._autoSteppedBack) {
            const origFd = extractPinFeederCode(srcPin);
            const steppedOpts = Object.assign({}, filterOpts, {
                mustPassId: '',
                _autoSteppedBack: true,
                _stepBackTargetId: effectiveSourceId,
                _lockedFeederCode: origFd
            });
            let steppedRes = traceFaultLocations(upInfo.parentBrkId, targetKm, tolKm, stopAtOpenSwitch, true, ampCalcCfg, steppedOpts);
            if ((!steppedRes || !steppedRes.candidates?.length) && stopAtOpenSwitch) {
                steppedRes = traceFaultLocations(upInfo.parentBrkId, targetKm, tolKm, false, true, ampCalcCfg, steppedOpts);
            }
            if (steppedRes && !steppedRes.error && steppedRes.candidates?.length > 0) {
                steppedRes.autoSteppedBackInfo = {
                    fromPinId: effectiveSourceId,
                    fromPinName: srcPin.name,
                    fromMaxAmp: maxOriginAmp,
                    toBrkName: steppedRes.srcPin?.name || upInfo.parentBrkName
                };
                return steppedRes;
            }
        }

        // ชดเชยค่ารีแอกแตนซ์ของสาย UG ในสถานี 150 ม. สำหรับโหมดระบุระยะทางจากรีเลย์ (กม.)
        const defaultCabKey = ampCalcCfg?.cableKey || document.getElementById('scadaFaultCableSelect')?.value || 'SAC185';
        const refCabForRelay = PEA_22KV_CABLES[defaultCabKey] || PEA_22KV_CABLES.SAC185;
        const ugRelayEqKm = (!useMultiCableAmp && stationUg && upInfo.stationUgKm > 0 && (isSubstationBreakerOrSourceNode(srcPin) || busbarHubIds.has(effectiveSourceId)))
            ? (upInfo.stationUgKm * (PEA_22KV_CABLES.UG240.x1 / (refCabForRelay.x1 || 0.345)))
            : 0;
        const initRelayKm = (ugRelayEqKm > 0 && targetKm > ugRelayEqKm + 0.02) ? ugRelayEqKm : 0;

        const elecDist = new Map([[effectiveSourceId, 0]]);
        const relayDist = new Map([[effectiveSourceId, initRelayKm]]);
        const groundDist = new Map([[effectiveSourceId, 0]]);
        const vecMap = new Map([[effectiveSourceId, { ...initVec }]]);
        const parentMap = new Map();
        const behindDfMap = new Map([[effectiveSourceId, srcPin.scadaNode?.t === 'DF']]);
        const visited = new Set(), pq = [{ id: effectiveSourceId, cost: 0 }];

        while (pq.length > 0) {
            pq.sort((a, b) => a.cost - b.cost);
            const { id: u } = pq.shift();
            if (visited.has(u)) continue;
            visited.add(u);

            if (u !== effectiveSourceId && notPassSet.has(u)) continue;
            if (isBarrierTerminalNode(pinMap.get(u), srcPin, stopAtOpenSwitch, bypassOpenSet, busbarHubIds, transitHubIds)) continue;

            const uElec = elecDist.get(u) || 0;
            const uRelay = relayDist.get(u) || 0;
            const uGround = groundDist.get(u) || 0;
            const uVec = vecMap.get(u) || initVec;
            const uBehindDf = Boolean(behindDfMap.get(u));

            (adj.get(u) || []).forEach((nb) => {
                if ((u === effectiveSourceId && upFilter.blockedStartNeighbors.has(nb.toId)) || upFilter.blockedNodes.has(nb.toId)) return;
                if (blockedHubExitPairs.has(`${u}__${nb.toId}`)) return;
                if (isBarrierTerminalNode(pinMap.get(nb.toId), srcPin, stopAtOpenSwitch, bypassOpenSet, busbarHubIds, transitHubIds)) return;

                const nextElec = uElec + nb.lenKm;
                const nextRelay = uRelay + nb.relayKm;
                const nextCost = useMultiCableAmp ? nextElec : nextRelay;
                const curBest = useMultiCableAmp ? (elecDist.get(nb.toId) ?? Infinity) : (relayDist.get(nb.toId) ?? Infinity);

                if (nextCost < curBest) {
                    elecDist.set(nb.toId, nextElec);
                    relayDist.set(nb.toId, nextRelay);
                    groundDist.set(nb.toId, uGround + nb.groundKm);
                    vecMap.set(nb.toId, {
                        r1: uVec.r1 + nb.cabProf.r1 * nb.lenKm, x1: uVec.x1 + nb.cabProf.x1 * nb.lenKm,
                        r0: uVec.r0 + nb.cabProf.r0 * nb.lenKm, x0: uVec.x0 + nb.cabProf.x0 * nb.lenKm
                    });
                    behindDfMap.set(nb.toId, uBehindDf || pinMap.get(nb.toId)?.scadaNode?.t === 'DF');
                    parentMap.set(nb.toId, { prevId: u, segElecKm: nb.lenKm, segRelayKm: nb.relayKm, segGroundKm: nb.groundKm, pts: nb.pts });
                    pq.push({ id: nb.toId, cost: nextCost });
                }
            });
        }

        const tracedSegments = [], rfArcZones = [], rawCandidates = [];
        let maxReachKm = 0, furthestPin = srcPin, minEndFaultAmp = Infinity, exceededMidSwitchAmp = false;
        elecDist.forEach((dVal, pid) => { if (dVal > maxReachKm) { maxReachKm = dVal; furthestPin = pinMap.get(pid) || srcPin; } });

        const evaluateDirectedSpan = (fromId, toId, pts, fullGroundKm, fullElecKm, spanElecLimitKm, edgeRecord) => {
            if (spanElecLimitKm <= 1e-6 || (fromId === effectiveSourceId && upFilter.blockedStartNeighbors.has(toId))) return;
            if (blockedHubExitPairs.has(`${fromId}__${toId}`)) return;

            const dstPin = pinMap.get(toId);
            if (toId !== effectiveSourceId && !transitHubIds.has(toId) && (busbarHubIds.has(toId) || isSubstationBreakerOrSourceNode(dstPin))) {
                return;
            }

            const duElec = elecDist.get(fromId);
            const duRelay = relayDist.get(fromId);
            if (duElec === undefined || duRelay === undefined) return;

            if (notPassSet.size > 0 && hasAnyAncestorInSet(fromId, notPassSet, parentMap)) return;
            const passedMustNode = !mustPassId || isNodeOnAncestorChain(fromId, mustPassId, parentMap);

            const slack = fullGroundKm > 1e-6 ? (fullElecKm / fullGroundKm) : OVERHEAD_SAG_FACTOR;
            const x1Ratio = edgeRecord.x1Ratio || 1.0;
            const spanGroundLimitKm = spanElecLimitKm / slack;
            const spanRelayLimitKm = spanElecLimitKm * x1Ratio;
            const endElecKm = duElec + spanElecLimitKm;
            const endRelayKm = duRelay + spanRelayLimitKm;
            if (endElecKm > maxReachKm) { maxReachKm = endElecKm; furthestPin = dstPin || furthestPin; }
            const spanPts = spanGroundLimitKm < fullGroundKm - 1e-5 ? slicePolylineUpToGroundKm(pts, spanGroundLimitKm).path : pts;

            let hitDeltaElecKm = null;
            if (useMultiCableAmp) {
                const uVec = vecMap.get(fromId) || initVec;
                const ampCheck = findAmpHitDistanceOnSpan(
                    uVec, edgeRecord.cabProf, spanElecLimitKm,
                    ampCalcCfg.ampVal, ampCalcCfg.faultType, srcBus, ampCalcCfg.rfOhm, busKv, calFactor,
                    fromId === effectiveSourceId && allowClampAtRoot
                );
                if (!ampCheck.hit) {
                    if (ampCheck.exceedsOriginAmp && fromId === effectiveSourceId) exceededMidSwitchAmp = true;
                    if (ampCheck.minAmpAtEnd !== undefined) {
                        if (ampCheck.minAmpAtEnd < minEndFaultAmp) minEndFaultAmp = ampCheck.minAmpAtEnd;
                        if (passedMustNode && spanPts.length >= 2) tracedSegments.push(spanPts);
                    }
                    return;
                }
                hitDeltaElecKm = ampCheck.deltaElecKm;

                if (passedMustNode && ampCalcCfg.faultType === 'LG' && (ampCalcCfg.rfOhm || 0) === 0) {
                    const rf2Check = findAmpHitDistanceOnSpan(uVec, edgeRecord.cabProf, spanElecLimitKm, ampCalcCfg.ampVal, 'LG', srcBus, 2.5, busKv, calFactor, false);
                    const startArcG = rf2Check.hit ? (rf2Check.deltaElecKm / slack) : 0;
                    const endArcG = hitDeltaElecKm / slack;
                    if (endArcG - startArcG > 0.04) {
                        const arcPath = slicePolylineBetweenGroundKm(pts, startArcG, endArcG);
                        if (arcPath.length >= 2) rfArcZones.push(arcPath);
                    }
                }
            } else {
                if (endRelayKm < targetKm) {
                    if (passedMustNode && spanPts.length >= 2) tracedSegments.push(spanPts);
                    return;
                }
                if (!(duRelay < targetKm && targetKm <= endRelayKm)) return;
                const hitDeltaRelayKm = targetKm - duRelay;
                hitDeltaElecKm = hitDeltaRelayKm / Math.max(0.15, x1Ratio);
            }

            if (!passedMustNode) return;

            const hitDeltaGroundKm = Math.min(fullGroundKm, hitDeltaElecKm / slack);
            const sliced = slicePolylineUpToGroundKm(pts, hitDeltaGroundKm);
            if (sliced.path.length >= 2) tracedSegments.push(sliced.path);
            const candLat = Number(sliced.point[0].toFixed(6)), candLon = Number(sliced.point[1].toFixed(6));
            if (rawCandidates.some((ex) => haversineKm(ex.lat, ex.lon, candLat, candLon) < 0.001)) return;

            const uVec = vecMap.get(fromId) || initVec;
            const vecAtHit = {
                r1: uVec.r1 + edgeRecord.cabProf.r1 * hitDeltaElecKm,
                x1: uVec.x1 + edgeRecord.cabProf.x1 * hitDeltaElecKm,
                r0: uVec.r0 + edgeRecord.cabProf.r0 * hitDeltaElecKm,
                x0: uVec.x0 + edgeRecord.cabProf.x0 * hitDeltaElecKm
            };

            let refPin = pinMap.get(fromId), refOffsetGroundKm = hitDeltaGroundKm, walkId = fromId, guard = 0;
            while (isNodeTTap(refPin, pins) && parentMap.has(walkId) && guard++ < 40) {
                const pInfo = parentMap.get(walkId);
                refOffsetGroundKm += pInfo.segGroundKm;
                walkId = pInfo.prevId;
                refPin = pinMap.get(walkId) || refPin;
            }

            const specTxt = edgeRecord.edge.lb || (edgeRecord.isAutoLateral ? `${edgeRecord.cabProf.short} (ประเมินสายกิ่ง)` : edgeRecord.cabProf.short);
            const isBehindDf = Boolean(behindDfMap.get(fromId) || edgeRecord.behindDf);
            const tolGround = tolKm / slack;
            const refNameStr = refPin ? refPin.name : '-';
            const nearbyLandmark = findNearbyLandmarkPin(candLat, candLon, pins, refNameStr);

            rawCandidates.push({
                lat: candLat, lon: candLon,
                fromId, toId,
                totalActualKm: Number((duElec + hitDeltaElecKm).toFixed(2)),
                totalGroundKm: Number(((groundDist.get(fromId) || 0) + hitDeltaGroundKm).toFixed(2)),
                totalRelayEqKm: Number((duRelay + hitDeltaElecKm * x1Ratio).toFixed(2)),
                refPinName: refNameStr,
                refOffsetMeters: Math.round(refOffsetGroundKm * 1000),
                towardName: resolveRealDestinationName(toId, fromId, pinMap, adj, pins),
                spec: specTxt,
                isAutoLateral: Boolean(edgeRecord.isAutoLateral),
                isBehindDf,
                vecAtHit,
                nearbyLandmark,
                tolZonePath: tolGround > 0 ? slicePolylineBetweenGroundKm(pts, Math.max(0, hitDeltaGroundKm - tolGround), Math.min(fullGroundKm, hitDeltaGroundKm + tolGround)) : []
            });
        };

        physicalEdges.forEach((er) => {
            if (upFilter.blockedNodes.has(er.uId) || upFilter.blockedNodes.has(er.vId)) return;
            const hasU = elecDist.has(er.uId) && !notPassSet.has(er.uId) && !isBarrierTerminalNode(pinMap.get(er.uId), srcPin, stopAtOpenSwitch, bypassOpenSet, busbarHubIds, transitHubIds);
            const hasV = elecDist.has(er.vId) && !notPassSet.has(er.vId) && !isBarrierTerminalNode(pinMap.get(er.vId), srcPin, stopAtOpenSwitch, bypassOpenSet, busbarHubIds, transitHubIds);
            const L = er.elecLenKm;
            if (hasU && hasV) {
                const du = elecDist.get(er.uId), dv = elecDist.get(er.vId);
                const splitFromU = Math.max(0, Math.min(L, (dv - du + L) / 2)), splitFromV = L - splitFromU;
                if (splitFromU > 1e-5) evaluateDirectedSpan(er.uId, er.vId, er.fwdPts, er.groundLenKm, L, splitFromU, er);
                if (splitFromV > 1e-5) evaluateDirectedSpan(er.vId, er.uId, er.revPts, er.groundLenKm, L, splitFromV, er);
            } else if (hasU && !hasV) evaluateDirectedSpan(er.uId, er.vId, er.fwdPts, er.groundLenKm, L, L, er);
            else if (!hasU && hasV) evaluateDirectedSpan(er.vId, er.uId, er.revPts, er.groundLenKm, L, L, er);
        });

        let clampedToMustPass = false;
        if (rawCandidates.length === 0 && mustPassId && elecDist.has(mustPassId) && !notPassSet.has(mustPassId)) {
            const mpPin = pinMap.get(mustPassId);
            const mpOut = (adj.get(mustPassId) || []).filter((nb) => !upFilter.blockedNodes.has(nb.toId) && !blockedHubExitPairs.has(`${mustPassId}__${nb.toId}`));
            if (mpOut.length > 0 && mpPin) {
                clampedToMustPass = true;
                mpOut.slice(0, 2).forEach((nb) => {
                    const isBracketedByNotPass = notPassSet.has(nb.toId);
                    const stepG = isBracketedByNotPass ? (nb.groundKm * 0.5) : Math.min(0.15, nb.groundKm * 0.5);
                    const sl = slicePolylineUpToGroundKm(nb.pts, stepG);
                    const candLat = Number(sl.point[0].toFixed(6)), candLon = Number(sl.point[1].toFixed(6));
                    rawCandidates.push({
                        lat: candLat, lon: candLon,
                        fromId: mustPassId, toId: nb.toId,
                        totalActualKm: Number((elecDist.get(mustPassId) + stepG).toFixed(2)),
                        totalGroundKm: Number(((groundDist.get(mustPassId) || 0) + stepG).toFixed(2)),
                        totalRelayEqKm: Number(((relayDist.get(mustPassId) || 0) + stepG).toFixed(2)),
                        refPinName: mpPin.name,
                        refOffsetMeters: Math.round(stepG * 1000),
                        towardName: resolveRealDestinationName(nb.toId, mustPassId, pinMap, adj, pins),
                        spec: nb.cabProf.short,
                        isAutoLateral: false,
                        isBehindDf: Boolean(behindDfMap.get(mustPassId)),
                        vecAtHit: vecMap.get(mustPassId) || initVec,
                        nearbyLandmark: findNearbyLandmarkPin(candLat, candLon, pins, mpPin.name),
                        tolZonePath: slicePolylineBetweenGroundKm(nb.pts, 0, isBracketedByNotPass ? nb.groundKm : Math.min(nb.groundKm, 0.35)),
                        clampedByFi: true,
                        bracketedPinName: isBracketedByNotPass ? (pinMap.get(nb.toId)?.name || '') : ''
                    });
                });
            }
        }

        const outageReports = getRecentActiveOutageReports();
        const historyHotspots = getHistoricalFaultHotspots();
        const stepBackTargetId = filterOpts._stepBackTargetId || '';

        rawCandidates.forEach((c) => {
            let score = rawCandidates.length === 1 ? 88 : 64;
            const reasons = [];

            if (stepBackTargetId && pinMap.has(stepBackTargetId)) {
                if (isNodeOnAncestorChain(stepBackTargetId, c.toId, parentMap) || isNodeOnAncestorChain(stepBackTargetId, c.fromId, parentMap)) {
                    score += 18;
                    reasons.push(`🎯 อยู่บนแนวสายเมนก่อนถึง ${pinMap.get(stepBackTargetId)?.name || ''}`);
                }
            }

            if (!useMultiCableAmp && ampCalcCfg?.ampVal > 0 && c.vecAtHit) {
                const boltedMaxA = calcFaultCurrentAtVector(c.vecAtHit, ampCalcCfg.faultType, srcBus, 0, busKv, calFactor);
                c.boltedMaxAmp = Math.round(boltedMaxA);
                c.candImpliedRf = estimateImpliedRfOhm(c.vecAtHit, ampCalcCfg.ampVal, ampCalcCfg.faultType, srcBus, busKv, calFactor);
                if (ampCalcCfg.ampVal > boltedMaxA * 1.12) {
                    score -= 26;
                    reasons.push(`⚠️ กระแสจริงสูงกว่าพิกัดลัดวงจรสูงสุดของกิ่งนี้ (~${c.boltedMaxAmp.toLocaleString()} A)`);
                } else {
                    score += 11;
                    reasons.push(`⚡ สอดคล้องพิกัดลัดวงจรของสาย (ช็อตตรงสูงสุด ~${c.boltedMaxAmp.toLocaleString()} A)`);
                }
            }

            if (mustPassId) {
                score += 14;
                reasons.push(`📟 ผ่านจุดเห็นฟอลต์ (${pinMap.get(mustPassId)?.name || 'FI'})`);
            }
            if (c.bracketedPinName) {
                score += 12;
                reasons.push(`📌 บีบโซนก่อนถึงจุดไฟไม่ผ่าน (${c.bracketedPinName})`);
            } else if (c.clampedByFi) {
                reasons.push('📌 ปรับตำแหน่งเริ่มหลังจุดเห็นฟอลต์จริง');
            }
            if (bypassIsolateId && isNodeOnAncestorChain(c.fromId, bypassIsolateId, parentMap)) {
                score += 12;
                reasons.push(`🔓 อยู่ในโซนหลังสวิตช์ที่สั่งปลด (${pinMap.get(bypassIsolateId)?.name || ''})`);
            }
            if (tripStatus === 'TL') {
                if (!c.isBehindDf && !c.isAutoLateral) {
                    score += 14;
                    reasons.push('⚡ สายเมนหลักสอดคล้องเหตุ T/L');
                } else if (c.isBehindDf) {
                    score -= 12;
                }
            }

            if (outageReports.length > 0) {
                const dsPts = collectDownstreamSamplePoints(c.toId, c.fromId, adj, parentMap, 60);
                let directHits = 0, downstreamHits = 0, bestReportLabel = '';
                outageReports.forEach((rep) => {
                    const dDirect = haversineKm(c.lat, c.lon, rep.lat, rep.lon);
                    if (dDirect <= 0.70) {
                        directHits += rep.isPrimary ? 2 : 1;
                        if (!bestReportLabel) bestReportLabel = rep.label;
                        return;
                    }
                    for (let i = 0; i < dsPts.length; i += 2) {
                        if (haversineKm(dsPts[i][0], dsPts[i][1], rep.lat, rep.lon) <= 0.55) {
                            downstreamHits++;
                            if (!bestReportLabel) bestReportLabel = rep.label;
                            break;
                        }
                    }
                });
                if (directHits > 0) {
                    score += Math.min(30, 20 + (directHits - 1) * 6);
                    reasons.push(`📞 ใกล้จุดรับแจ้งไฟดับ (${bestReportLabel})`);
                } else if (downstreamHits > 0) {
                    score += Math.min(22, 14 + (downstreamHits - 1) * 4);
                    reasons.push(`📞 มีผู้แจ้งไฟดับปลายสายกิ่งนี้ (${downstreamHits} จุด)`);
                }
            }

            if (historyHotspots.length > 0) {
                const pastHit = historyHotspots.find((h) => haversineKm(c.lat, c.lon, h.lat, h.lon) <= 0.35);
                if (pastHit) {
                    score += 6;
                    reasons.push(`🕘 เคยเกิดเหตุซ้ำบริเวณนี้ (${pastHit.cause})`);
                }
            }

            c.confidencePct = Math.max(18, Math.min(98, Math.round(score)));
            c.reasons = reasons;
        });

        rawCandidates.sort((a, b) => (b.confidencePct - a.confidencePct) || (a.totalActualKm - b.totalActualKm));

        let impliedRfOhm = null;
        if (!useMultiCableAmp && ampCalcCfg?.ampVal > 0 && rawCandidates.length > 0) {
            impliedRfOhm = rawCandidates[0].candImpliedRf ?? estimateImpliedRfOhm(rawCandidates[0].vecAtHit, ampCalcCfg.ampVal, ampCalcCfg.faultType, srcBus, busKv, calFactor);
        }

        return {
            srcPin, redirectedFromUnwired: effectiveSourceId !== sourcePinId,
            targetKm, tolKm, tracedSegments, rfArcZones,
            candidates: rawCandidates, maxReachKm, furthestPin,
            ampCalcCfg, minEndFaultAmp,
            upstreamKm: useUpstreamZ ? upInfo.upstreamKm : 0,
            stationUgMeters,
            exceededMidSwitchAmp, maxOriginAmp,
            mustPassPin: mustPassId ? pinMap.get(mustPassId) : null,
            bypassIsolatePin: bypassIsolateId ? pinMap.get(bypassIsolateId) : null,
            excludedPinsList: Array.from(notPassSet).map((id) => pinMap.get(id)).filter(Boolean),
            clampedToMustPass, impliedRfOhm, distMap: elecDist, vecMap
        };
    }

    // ========================================================================
    // 7. การจัดการ UI, ให้ CB/RC ทุกตัวอยู่กลุ่มต้นทางจ่ายไฟ & เทียบสเกลวงจร
    // ========================================================================
    function clearFaultLocatorOverlay() {
        faultLayerGroup?.clearLayers();
        lastFaultResult = null;
        const resBox = document.getElementById('scadaFaultResultBox');
        if (resBox) { resBox.innerHTML = ''; resBox.classList.add('hidden'); }
    }

    function renderExcludedNotPassChips() {
        const bar = document.getElementById('scadaFaultExcludedChipsBar');
        if (!bar) return;
        if (excludedNotPassIds.size === 0) {
            bar.innerHTML = '';
            bar.classList.add('hidden');
            return;
        }
        const pins = getVisibleScadaPins();
        const pinMap = new Map(pins.map((p) => [p.id, p]));
        const chipsHtml = Array.from(excludedNotPassIds).map((id) => {
            const p = pinMap.get(id);
            if (!p) return '';
            const safeId = String(id).replace(/'/g, "\\'");
            return `<span class="inline-flex items-center gap-1 bg-rose-950/90 text-rose-200 border border-rose-400/50 px-2 py-0.5 rounded-full text-[10px] font-bold">🚫 ${escHtml(p.name)} <button type="button" onclick="removeFaultExcludedNotPassPin('${safeId}')" class="text-amber-300 hover:text-white font-extrabold ml-0.5">✕</button></span>`;
        }).filter(Boolean);

        if (!chipsHtml.length) {
            excludedNotPassIds.clear();
            bar.innerHTML = '';
            bar.classList.add('hidden');
            return;
        }
        chipsHtml.push(`<button type="button" onclick="clearAllFaultExcludedPins()" class="text-[10px] text-slate-300 hover:text-white underline px-1">ล้างจุดตัดทั้งหมด</button>`);
        bar.innerHTML = chipsHtml.join('');
        bar.classList.remove('hidden');
    }

    function addFaultExcludedNotPassPin(pinId) {
        const sel = document.getElementById('scadaFaultNotPassSelect');
        const id = String(pinId || sel?.value || '').trim();
        if (sel) sel.value = '';
        if (!id) return;
        const mpId = document.getElementById('scadaFaultMustPassSelect')?.value || '';
        if (id === mpId) {
            return window.showToast?.('⚠️ หมุดนี้ถูกเลือกเป็นจุดเห็นฟอลต์อยู่แล้ว ไม่สามารถตั้งเป็นจุดไฟไม่ผ่านซ้ำกันได้');
        }
        excludedNotPassIds.add(id);
        renderExcludedNotPassChips();
        if (lastFaultResult) executeFaultDistanceSearch(0, 'auto');
    }

    function removeFaultExcludedNotPassPin(pinId) {
        excludedNotPassIds.delete(String(pinId || ''));
        renderExcludedNotPassChips();
        if (lastFaultResult) executeFaultDistanceSearch(0, 'auto');
    }

    function clearAllFaultExcludedPins() {
        excludedNotPassIds.clear();
        renderExcludedNotPassChips();
        if (lastFaultResult) executeFaultDistanceSearch(0, 'auto');
    }

    function onFaultConstraintChanged() {
        onFaultAmpParamsChanged(false);
        if (lastFaultResult) executeFaultDistanceSearch(0, 'auto');
    }

    function resetFaultLocatorInputs(silent = false) {
        activePacketApplySeq++;
        lastEditedMetric = 'auto';
        incomingReporterCoords = null;
        excludedNotPassIds.clear();
        renderExcludedNotPassChips();
        try { localStorage.removeItem(FAULT_PKT_KEY); } catch (e) {}

        ['scadaFaultKmInput', 'scadaFaultAmpInput', 'scadaFaultRfInput'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        ['scadaFaultMustPassSelect', 'scadaFaultNotPassSelect', 'scadaFaultBypassIsolateSelect'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const tripSel = document.getElementById('scadaFaultTripModeSelect');
        if (tripSel) tripSel.value = 'AUTO';
        const phSel = document.getElementById('scadaFaultPhaseSelect');
        if (phSel) phSel.value = 'LL';
        const tolSel = document.getElementById('scadaFaultTolSelect');
        if (tolSel) tolSel.value = '0.15';
        saveCalcPrefs({ faultType: 'LL' });

        const hintEl = document.getElementById('scadaFaultAmpCalcBadge');
        if (hintEl) {
            hintEl.textContent = DEFAULT_AMP_HINT_TEXT;
            hintEl.className = 'text-[10.5px] text-slate-400';
        }
        clearFaultLocatorOverlay();
        if (!silent) window.showToast?.('🧹 ล้างค่าคำนวณ ตัวกรอง FI และหมุดคาดการณ์เรียบร้อยแล้ว');
    }

    function clearQuickFaultLocatorFromMainForm(silent = false) {
        ['tab1QuickFaultAmpInput', 'tab1QuickFaultKmInput'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const typeSel = document.getElementById('tab1QuickFaultTypeSelect');
        if (typeSel) typeSel.value = 'AUTO';
        syncMainFormFaultCurrentsToQuickBar();
        try { localStorage.removeItem(FAULT_PKT_KEY); } catch (e) {}

        const clearPkt = { type: 'SCADA_CLEAR_FAULT_LOCATOR', ts: Date.now() };
        try { faultBc?.postMessage(clearPkt); } catch (e) {}
        try { document.getElementById('leftBrowserIframe')?.contentWindow?.postMessage(clearPkt, '*'); } catch (e) {}
        if (!silent) window.showToast?.('🧹 ล้างค่าระยะฟอลต์เรียบร้อยแล้ว');
    }

    function findMatchingPinByTextHint(hintText, candidatePins) {
        const clean = String(hintText || '').replace(/\(ID[^)]*\)/gi, '').trim().toLowerCase();
        if (clean.length < 2 || !Array.isArray(candidatePins)) return null;
        const exact = candidatePins.find((p) => String(p.name || '').trim().toLowerCase() === clean || String(p.scadaNode?.id || '').trim().toLowerCase() === clean);
        if (exact) return exact;
        const devRe = new RegExp(`(?:^|[^a-z0-9])${escapeRe(clean)}(?![0-9])`, 'i');
        const bHit = candidatePins.find((p) => devRe.test(String(p.name || '').trim()));
        if (bHit) return bHit;
        return candidatePins
            .filter((p) => String(p.name || '').trim().length >= 4)
            .sort((a, b) => String(b.name || '').length - String(a.name || '').length)
            .find((p) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(String(p.name || '').trim())}(?![0-9])`, 'i').test(clean)) || null;
    }

    function populateFilterAndCalibDropdowns(allCandidates, srcId) {
        const mpSel = document.getElementById('scadaFaultMustPassSelect');
        const npSel = document.getElementById('scadaFaultNotPassSelect');
        const isoSel = document.getElementById('scadaFaultBypassIsolateSelect');
        const calRefSel = document.getElementById('scadaCalibRefPinSelect');

        const filteredPins = allCandidates.filter((p) => p.id !== srcId && p.scadaNode?.t !== 'GEN');
        const switchOpts = filteredPins.map((p) => {
            const t = p.scadaNode?.t || 'หมุด';
            const openTag = (p.scadaNode?.st === 'O') ? ' (ปลด O)' : '';
            return `<option value="${escHtml(p.id)}">[${escHtml(t)}] ${escHtml(p.name)}${openTag}</option>`;
        }).join('');

        const openSwitchCandidates = filteredPins.filter((p) => SWITCHABLE_TYPES.has(p.scadaNode?.t || ''));
        const isoOpts = openSwitchCandidates.map((p) => {
            const stTag = p.scadaNode?.st === 'O' ? '🔓 ปลดอยู่ • ' : '';
            return `<option value="${escHtml(p.id)}">${stTag}[${escHtml(p.scadaNode?.t)}] ${escHtml(p.name)}</option>`;
        }).join('');

        if (mpSel && document.activeElement !== mpSel) {
            const prev = mpSel.value;
            const html = `<option value="">🟢 ผ่านจุด/เห็นฟอลต์: ไม่ระบุ</option>${switchOpts}`;
            if (mpSel.__lastHtml !== html) {
                mpSel.innerHTML = html;
                mpSel.__lastHtml = html;
                if (prev && filteredPins.some((p) => p.id === prev)) mpSel.value = prev;
            }
        }
        if (npSel && document.activeElement !== npSel) {
            const html = `<option value="">➕ ตัดจุด FI ปกติ/ไฟไม่ผ่าน (เลือกสะสมได้)...</option>${switchOpts}`;
            if (npSel.__lastHtml !== html) {
                npSel.innerHTML = html;
                npSel.__lastHtml = html;
            }
        }
        if (isoSel && document.activeElement !== isoSel) {
            const prev = isoSel.value;
            const html = `<option value="">🔓 ทะลุสวิตช์เพิ่งปลดแยกโซน: ไม่ระบุ</option>${isoOpts}`;
            if (isoSel.__lastHtml !== html) {
                isoSel.innerHTML = html;
                isoSel.__lastHtml = html;
                if (prev && openSwitchCandidates.some((p) => p.id === prev)) isoSel.value = prev;
            }
        }
        if (calRefSel && document.activeElement !== calRefSel) {
            const prev = calRefSel.value;
            const html = `<option value="">-- เลือกหมุดจุดเกิดเหตุจริงบนสายนี้ --</option>${switchOpts}`;
            if (calRefSel.__lastHtml !== html) {
                calRefSel.innerHTML = html;
                calRefSel.__lastHtml = html;
                if (prev && filteredPins.some((p) => p.id === prev)) calRefSel.value = prev;
            }
        }
        renderExcludedNotPassChips();
        updateCalibBadgeUI(srcId);
    }

    // จัดให้หมุด CB และ RC ทุกตัวเป็นกลุ่มต้นทางจ่ายไฟหลักทั้งหมดโดยไม่แบ่งแยกรหัสชื่อ
    function populateFaultSourceDropdown(preferFeeder = '', preferDevice = '', preferStation = '', preferIsolate = '') {
        const sel = document.getElementById('scadaFaultSourceSelect');
        if (!sel) return { unmatchedDeviceHint: '', matchedMustPassPin: null, matchedIsolatePin: null };
        const hasPrefer = Boolean(preferFeeder || preferDevice || preferStation || preferIsolate);

        if (!hasPrefer && document.activeElement === sel && sel.options.length > 0) {
            return { unmatchedDeviceHint: '', matchedMustPassPin: null, matchedIsolatePin: null };
        }

        const pins = getVisibleScadaPins();
        const prevVal = sel.value;
        const wiredIds = collectValidWiredPinIds(pins);
        const requireWired = wiredIds.size > 0;

        const sourceBreakers = [], switches = [], wiredPlainPins = [];
        pins.forEach((p) => {
            if (requireWired && !wiredIds.has(p.id)) return;
            const t = String(p.scadaNode?.t || 'PIN').toUpperCase();
            if (t === 'CB' || t === 'RC' || /\(\s*(?:CB|RC)\b/i.test(String(p.name || ''))) {
                sourceBreakers.push(p);
            } else if (['VB', 'VS', 'VSC', 'S', 'DF', 'GEN'].includes(t)) {
                switches.push(p);
            } else if (wiredIds.has(p.id) && !isNodeTTap(p, pins)) {
                wiredPlainPins.push(p);
            }
        });

        const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'th');
        sourceBreakers.sort(byName);
        switches.sort(byName);

        const allCandidates = [...sourceBreakers, ...switches, ...wiredPlainPins];
        const opts = [
            ...sourceBreakers.map((b) => `<option value="${escHtml(b.id)}">■ [${escHtml(b.scadaNode?.t || 'CB')}] ${escHtml(b.name)}${b.scadaNode?.fd ? ` (${escHtml(b.scadaNode.fd)})` : ''}</option>`),
            ...switches.map((s) => `<option value="${escHtml(s.id)}">${s.scadaNode?.t === 'VB' ? '▣' : '⚡'} [${escHtml(s.scadaNode?.t)}] ${escHtml(s.name)}</option>`),
            ...wiredPlainPins.map((wp) => `<option value="${escHtml(wp.id)}">📍 [หมุด] ${escHtml(wp.name)}</option>`)
        ];
        const nextOptsHtml = opts.length ? opts.join('') : '<option value="">-- ยังไม่มีหมุดที่เชื่อมสายไฟในผัง --</option>';

        if (sel.__lastOptsHtml !== nextOptsHtml || sel.options.length === 0) {
            sel.innerHTML = nextOptsHtml;
            sel.__lastOptsHtml = nextOptsHtml;
            if (prevVal) {
                if (allCandidates.some((p) => p.id === prevVal)) {
                    sel.value = prevVal;
                } else {
                    const twin = resolveWiredTwinSourcePin(prevVal, pins, wiredIds);
                    if (twin && allCandidates.some((p) => p.id === twin.id)) sel.value = twin.id;
                }
            }
        }

        let matchedFeederBreaker = null;
        if (preferFeeder || preferStation) {
            const numM = String(preferFeeder).match(/(\d+)\s*$/), fNum = numM ? parseInt(numM[1], 10) : null;
            const cleanFd = String(preferFeeder).trim().toUpperCase().replace(/\s+/g, '');
            const stPrefix = (String(preferStation || '').toUpperCase().match(/[A-Z]{2,4}/) || [''])[0];
            const pool = sourceBreakers.length > 0 ? sourceBreakers : allCandidates;
            const scored = pool.map((b) => {
                const bFd = String(b.scadaNode?.fd || '').toUpperCase().replace(/\s+/g, '');
                const bTxt = `${bFd} ${b.name || ''} ${b.note || ''}`.toUpperCase();
                let score = (isSubstationBreakerOrSourceNode(b) ? 25 : 0) + ((bFd && cleanFd && bFd === cleanFd) ? 120 : 0);
                if (fNum !== null) {
                    const fdM = Array.from(bTxt.matchAll(/(?:\b(?!KV)[A-Z]{2,4}\s*F?\s*0*(\d+)|\bF\s*0*(\d+)|วงจร\s*0*(\d+))(?![0-9]|KV)/gi));
                    if (fdM.some((m) => parseInt(m[1] || m[2] || m[3], 10) === fNum)) score += 65;
                    else if (Array.from(bTxt.matchAll(/\b(?:CB|RC)\s*-?\s*0*(\d+)(?![0-9])/gi)).some((m) => parseInt(m[1], 10) === fNum)) score += 45;
                }
                if (stPrefix && bTxt.includes(stPrefix)) score += 30;
                if (preferStation && `${b.name || ''} ${b.note || ''}`.includes(preferStation.trim())) score += 25;
                return { b, score };
            }).filter((x) => x.score >= 45).sort((a, b) => b.score - a.score);
            if (scored.length > 0) matchedFeederBreaker = scored[0].b;
        }

        let unmatchedDeviceHint = '';
        let matchedMustPassPin = null;
        const devPin = findMatchingPinByTextHint(preferDevice, allCandidates);
        if (preferDevice && preferDevice.trim().length >= 2 && !devPin) {
            unmatchedDeviceHint = preferDevice.trim();
        }
        const matchedIsolatePin = findMatchingPinByTextHint(preferIsolate, allCandidates);

        if (devPin && isSubstationBreakerOrSourceNode(devPin) && (!matchedFeederBreaker || extractPinFeederCode(devPin) === extractPinFeederCode(matchedFeederBreaker))) {
            sel.value = devPin.id;
        } else if (matchedFeederBreaker) {
            sel.value = matchedFeederBreaker.id;
            if (devPin && devPin.id !== matchedFeederBreaker.id) matchedMustPassPin = devPin;
        } else if (devPin) {
            sel.value = devPin.id;
        } else if (prevVal && allCandidates.some((p) => p.id === prevVal) && sel.value !== prevVal) {
            sel.value = prevVal;
        }

        populateFilterAndCalibDropdowns(allCandidates, sel.value);
        if (matchedMustPassPin) {
            const mpSel = document.getElementById('scadaFaultMustPassSelect');
            if (mpSel) mpSel.value = matchedMustPassPin.id;
        }
        if (matchedIsolatePin && matchedIsolatePin.id !== sel.value) {
            const isoSel = document.getElementById('scadaFaultBypassIsolateSelect');
            if (isoSel) isoSel.value = matchedIsolatePin.id;
        }
        return { unmatchedDeviceHint, matchedMustPassPin, matchedIsolatePin };
    }

    function getSelectedSourceUpstreamQuick(srcId, cableKey, stopOpen, autoLateral, stationUg = true) {
        if (!srcId) return { upstreamVec: { r1: 0, x1: 0, r0: 0, x0: 0 }, upstreamKm: 0, stationUgKm: 0, parentBrkId: '', parentBrkName: '' };
        const pins = getVisibleScadaPins();
        const wiredIds = collectValidWiredPinIds(pins);
        const resolved = resolveWiredTwinSourcePin(srcId, pins, wiredIds);
        if (!resolved) return { upstreamVec: { r1: 0, x1: 0, r0: 0, x0: 0 }, upstreamKm: 0, stationUgKm: 0, parentBrkId: '', parentBrkName: '' };
        const pinMap = new Map(pins.map((p) => [p.id, p]));
        const { adj, fullPhysAdj, busbarHubIds } = buildScadaGraphs(pins, pinMap, stopOpen, cableKey, autoLateral, new Set([resolved.id]));
        const { transitHubIds } = buildTransitHubsAndFeederGate(resolved.id, pinMap, adj, busbarHubIds);
        return computeUpstreamFilterAndVector(resolved.id, pins, pinMap, adj, fullPhysAdj, busbarHubIds, transitHubIds, stationUg);
    }

    function readPage2AmpCalcConfig(updateKmPreview = false) {
        const ampRaw = parseFloat(document.getElementById('scadaFaultAmpInput')?.value || '');
        const faultType = document.getElementById('scadaFaultPhaseSelect')?.value || 'LL';
        const cableKey = document.getElementById('scadaFaultCableSelect')?.value || 'SAC185';
        const sourceKey = document.getElementById('scadaFaultSubZSelect')?.value || 'SUB_50MVA';
        const busKv = parseFloat(document.getElementById('scadaFaultBusKvSelect')?.value || String(DEFAULT_BUS_KV)) || DEFAULT_BUS_KV;
        const rfOhm = Math.max(0, parseFloat(document.getElementById('scadaFaultRfInput')?.value || '0') || 0);
        const autoLateral = document.getElementById('scadaFaultAutoLateralChk')?.checked !== false;
        const stationUg = document.getElementById('scadaFaultStationUgChk')?.checked !== false;
        saveCalcPrefs({ faultType, cableKey, sourceKey, busKv, autoLateral, stationUg });

        const srcId = document.getElementById('scadaFaultSourceSelect')?.value || '';
        const calRec = getSourceCalibRecord(srcId);
        const calFactor = calRec ? calRec.factor : 1.0;

        if (isNaN(ampRaw) || ampRaw <= 0) return null;

        const stopOpen = document.getElementById('scadaFaultStopOpenChk')?.checked !== false;
        const upQuick = getSelectedSourceUpstreamQuick(srcId, cableKey, stopOpen, autoLateral, stationUg);
        const baseVec = sourceKey !== 'IDEAL_ZERO'
            ? upQuick.upstreamVec
            : (stationUg ? getStationExitUgVector((upQuick.stationUgKm || 0) * 1000) : null);

        const solved = solveUniformDistanceKmFromAmp(ampRaw, faultType, cableKey, sourceKey, rfOhm, baseVec, busKv, calFactor);
        if (solved.error) return null;
        const exceedsMidSwitch = Boolean(solved.clampedNearBus && upQuick.upstreamKm > 0.05 && sourceKey !== 'IDEAL_ZERO');

        if (updateKmPreview) {
            const tolSel = document.getElementById('scadaFaultTolSelect');
            if (tolSel && faultType === 'LG' && parseFloat(tolSel.value) < 0.3) tolSel.value = '0.30';
        }
        return {
            ampVal: ampRaw, faultType, cableKey, sourceKey, busKv, rfOhm, calFactor, calRec,
            approxUniformKm: solved.km, clampedNearBus: solved.clampedNearBus,
            exceedsMidSwitch, maxPossibleAmp: solved.maxPossibleAmp,
            upstreamKm: sourceKey !== 'IDEAL_ZERO' ? upQuick.upstreamKm : 0,
            stationUgMeters: Math.round((upQuick.stationUgKm || 0) * 1000),
            parentBrkId: upQuick.parentBrkId || '', parentBrkName: upQuick.parentBrkName || '',
            useAmpSolver: true
        };
    }

    function onFaultKmManualInput() {
        const kmRaw = (document.getElementById('scadaFaultKmInput')?.value || '').trim();
        lastEditedMetric = kmRaw !== '' ? 'km' : 'auto';
        onFaultAmpParamsChanged(false);
    }

    function onFaultFilterPinsChanged() {
        const srcId = document.getElementById('scadaFaultSourceSelect')?.value || '';
        const pins = getVisibleScadaPins();
        const wiredIds = collectValidWiredPinIds(pins);
        const wiredList = wiredIds.size > 0 ? pins.filter((p) => wiredIds.has(p.id)) : pins;
        populateFilterAndCalibDropdowns(wiredList, srcId);
        onFaultAmpParamsChanged(Boolean(lastFaultResult));
    }

    function onFaultAmpParamsChanged(triggerSearch = false) {
        if (document.activeElement?.id === 'scadaFaultAmpInput') lastEditedMetric = 'amp';
        const srcId = document.getElementById('scadaFaultSourceSelect')?.value || '';
        updateCalibBadgeUI(srcId);

        const kmTyped = parseFloat(document.getElementById('scadaFaultKmInput')?.value || '');
        const hasKmTyped = !isNaN(kmTyped) && kmTyped > 0;
        const stationUgChk = document.getElementById('scadaFaultStationUgChk')?.checked !== false;
        saveCalcPrefs({ stationUg: stationUgChk });
        const cfg = readPage2AmpCalcConfig(lastEditedMetric !== 'km' || !hasKmTyped);
        const hintEl = document.getElementById('scadaFaultAmpCalcBadge');

        if (hintEl) {
            if (!cfg && !hasKmTyped) {
                hintEl.textContent = DEFAULT_AMP_HINT_TEXT;
                hintEl.className = 'text-[10.5px] text-slate-400';
            } else if (!cfg && hasKmTyped) {
                const ugKmNote = stationUgChk ? ` • หักสาย UG ในสถานี ${DEFAULT_STATION_UG_METERS} ม. แล้ว` : '';
                hintEl.textContent = `📏 คำนวณตามระยะรีเลย์ ${kmTyped.toFixed(2)} กม.${ugKmNote}`;
                hintEl.className = 'text-[10.5px] text-sky-300 font-bold';
            } else if (lastEditedMetric === 'km' && hasKmTyped) {
                const ugNote = cfg.stationUgMeters > 0 ? ` + หัก UG สถานี ${cfg.stationUgMeters} ม.` : '';
                hintEl.textContent = `📏 ใช้ระยะรีเลย์ ${kmTyped.toFixed(2)} กม. (ชดเชย X1${ugNote}) + คานผลกระแส ${cfg.ampVal.toLocaleString()} A`;
                hintEl.className = 'text-[10.5px] text-sky-300 font-bold';
            } else if (cfg.exceedsMidSwitch) {
                const autoBackTxt = cfg.parentBrkName
                    ? `กด "คำนวณจุด" เพื่อถอยไปเริ่มวัดจากต้นสาย (${cfg.parentBrkName}) อัตโนมัติ`
                    : 'แนะนำเลือก ■ CB/RC ต้นทางจ่ายไฟ';
                hintEl.textContent = `🔄 กระแส ${cfg.ampVal.toLocaleString()} A เกิดฝั่งต้นสายก่อนถึงสวิตช์นี้ (สูงสุดณจุดนี้ ~${cfg.maxPossibleAmp.toLocaleString()} A) • ${autoBackTxt}`;
                hintEl.className = 'text-[10.5px] text-cyan-300 font-bold';
            } else if (cfg.clampedNearBus) {
                hintEl.textContent = `⚡ กระแส ${cfg.ampVal.toLocaleString()} A สูงระดับช่วงออกสถานี/Riser Pole (สูงสุด ~${cfg.maxPossibleAmp.toLocaleString()} A) ➔ เริ่มจากต้นสาย`;
                hintEl.className = 'text-[10.5px] text-amber-300 font-bold';
            } else {
                const fLabel = getFaultTypeLabelThai(cfg.faultType);
                const ugTag = cfg.stationUgMeters > 0 ? ` • รวม UG สถานี ${cfg.stationUgMeters} ม.` : '';
                const rfTag = cfg.rfOhm > 0 ? ` • หักดิน ${cfg.rfOhm}Ω` : '';
                const calTag = cfg.calRec ? ` • ☁️ สเกลวงจร x${cfg.calFactor.toFixed(2)}` : '';
                const upTxt = cfg.upstreamKm > 0.05 ? ` • รวมสายต้นน้ำ ${cfg.upstreamKm.toFixed(2)} กม.` : '';
                hintEl.textContent = `⚡ ${cfg.ampVal.toLocaleString()} A (${fLabel} @ ${cfg.busKv}kV${ugTag}${rfTag}) ≈ ระยะสายอากาศ ${cfg.approxUniformKm.toFixed(2)} กม.${upTxt}${calTag}`;
                hintEl.className = 'text-[10.5px] text-emerald-300 font-bold';
            }
        }
        if (triggerSearch && (cfg || hasKmTyped)) executeFaultDistanceSearch(0, lastEditedMetric);
    }

    function updateCalibBadgeUI(srcId) {
        const btn = document.getElementById('btnFaultToggleCalib');
        const statusEl = document.getElementById('scadaCalibStatusText');
        const rec = getSourceCalibRecord(srcId);
        if (btn) {
            btn.textContent = rec ? `☁️ เทียบสเกลแล้ว (x${rec.factor.toFixed(2)})` : '🎯 เทียบสเกลวงจร';
            btn.className = rec
                ? 'bg-emerald-700 hover:bg-emerald-600 text-white border border-emerald-400 px-2 py-0.5 rounded-lg text-[10.5px] font-extrabold'
                : 'bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-400/40 px-2 py-0.5 rounded-lg text-[10.5px] font-bold';
        }
        if (statusEl) {
            const byTxt = rec?.syncedBy ? ` • โดย ${rec.syncedBy}` : '';
            statusEl.textContent = rec
                ? `✅ ซิงค์สเกลวงจรร่วมทั้งสาขาแล้ว: ตัวคูณ x${rec.factor.toFixed(3)} (อ้างอิงจุด "${rec.refName}" ที่กระแส ${rec.refAmp} A${byTxt})`
                : 'ℹ️ เลือกหมุดที่เคยเกิดฟอลต์จริงบนสายนี้ + กรอกกระแสที่อ่านได้ ระบบจะจำค่า Z จริงและซิงค์ให้ทุกเครื่องในสาขาอัตโนมัติ';
        }
    }

    function openFaultCalibrateModal(forceState) {
        calibDrawerOpen = typeof forceState === 'boolean' ? forceState : !calibDrawerOpen;
        document.getElementById('scadaFaultCalibDrawer')?.classList.toggle('hidden', !calibDrawerOpen);
        const curAmp = document.getElementById('scadaFaultAmpInput')?.value || '';
        const calAmpEl = document.getElementById('scadaCalibRealAmpInput');
        if (calibDrawerOpen && curAmp && calAmpEl && !calAmpEl.value) calAmpEl.value = curAmp;
    }

    function saveFaultFeederCalibration() {
        if (typeof window.isViewerRole === 'function' && window.isViewerRole()) {
            return window.showToast?.('🔒 สิทธิ์ผู้สำรวจไม่สามารถบันทึกแก้ไขค่าเทียบสเกลได้');
        }
        const srcId = document.getElementById('scadaFaultSourceSelect')?.value || '';
        const refPinId = document.getElementById('scadaCalibRefPinSelect')?.value || '';
        const realAmp = parseFloat(document.getElementById('scadaCalibRealAmpInput')?.value || '');
        if (!srcId) return window.showToast?.('⚠️ กรุณาเลือกหมุดต้นทาง (CB/RC) ก่อนเทียบสเกล');
        if (!refPinId) return window.showToast?.('⚠️ กรุณาเลือกหมุดจุดเกิดเหตุจริงที่ใช้เทียบสเกล');
        if (isNaN(realAmp) || realAmp <= 50) return window.showToast?.('⚠️ กรุณากรอกกระแสฟอลต์จริง (แอมป์) ให้ถูกต้อง');

        const faultType = document.getElementById('scadaFaultPhaseSelect')?.value || 'LL';
        const cableKey = document.getElementById('scadaFaultCableSelect')?.value || 'SAC185';
        const sourceKey = document.getElementById('scadaFaultSubZSelect')?.value || 'SUB_50MVA';
        const busKv = parseFloat(document.getElementById('scadaFaultBusKvSelect')?.value || String(DEFAULT_BUS_KV)) || DEFAULT_BUS_KV;
        const autoLateral = document.getElementById('scadaFaultAutoLateralChk')?.checked !== false;
        const stationUg = document.getElementById('scadaFaultStationUgChk')?.checked !== false;

        const probe = traceFaultLocations(srcId, 999, 0, false, true, {
            ampVal: 0, faultType, cableKey, sourceKey, busKv, rfOhm: 0, calFactor: 1.0, useAmpSolver: false
        }, { autoLateral, stationUg });

        const vecAtRef = probe.vecMap?.get(refPinId);
        if (!vecAtRef) return window.showToast?.('⚠️ หมุดที่เลือกไม่ได้เชื่อมต่อสายไฟถึงต้นทางวงจรนี้');

        const srcBus = PEA_SOURCE_BUS_PRESETS[sourceKey] || PEA_SOURCE_BUS_PRESETS.SUB_50MVA;
        const theoryAmp = calcFaultCurrentAtVector(vecAtRef, faultType, srcBus, 0, busKv, 1.0);
        const rawFactor = realAmp / Math.max(1, theoryAmp);
        if (rawFactor < 0.65 || rawFactor > 1.45) {
            return window.showToast?.(`⚠️ ค่ากระแสต่างจากสเปกสายเกินจริง (ทฤษฎี ~${Math.round(theoryAmp)} A) กรุณาเช็กชนิดฟอลต์หรือมีความต้านทานดินปนอยู่`);
        }

        const pins = getVisibleScadaPins();
        const refPin = pins.find((p) => p.id === refPinId);
        const rawUser = localStorage.getItem('elec_app_current_user') || '';
        const cleanUser = typeof window.formatTechDisplayName === 'function' ? window.formatTechDisplayName(rawUser) : rawUser;

        saveSourceCalibRecord(probe.srcPin.id, probe.srcPin, {
            factor: Number(rawFactor.toFixed(4)),
            refName: refPin?.name || refPinId,
            refAmp: realAmp,
            syncedBy: cleanUser
        });
        updateCalibBadgeUI(probe.srcPin.id);
        onFaultAmpParamsChanged(true);
        window.showToast?.(`☁️ บันทึกและซิงค์สเกลวงจรให้ทุกเครื่องสำเร็จ (x${rawFactor.toFixed(3)})!`);
    }

    function clearFaultFeederCalibration() {
        if (typeof window.isViewerRole === 'function' && window.isViewerRole()) return;
        const srcId = document.getElementById('scadaFaultSourceSelect')?.value || '';
        if (!srcId) return;
        const srcPin = getVisibleScadaPins().find((p) => p.id === srcId);
        saveSourceCalibRecord(srcId, srcPin, null);
        updateCalibBadgeUI(srcId);
        onFaultAmpParamsChanged(Boolean(lastFaultResult));
        window.showToast?.('🧹 รีเซ็ตค่าเทียบสเกลของวงจรนี้กลับเป็นค่ามาตรฐานแล้ว');
    }

    // ========================================================================
    // 8. การวาดผลลัพธ์บนแผนที่, ปุ่มคัดลอกสำหรับ PC & ปุ่มส่งเข้า LINE
    // ========================================================================
    function navigateToFaultCandidate(idx) {
        const c = lastFaultResult?.candidates?.[idx];
        if (!c) return;
        const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}&travelmode=driving`;
        if (typeof window.recordEquipmentNavStart === 'function' && !(typeof window.isViewerRole === 'function' && window.isViewerRole())) {
            const startCoord = window.lastKnownTechCoords;
            const route = (startCoord && typeof window.calculateInstantRouteFallback === 'function')
                ? window.calculateInstantRouteFallback(startCoord, { lat: c.lat, lon: c.lon })
                : { distanceKm: '3.0', durationMin: 8, isArrived: false };
            const offTxt = c.refOffsetMeters >= 1000 ? `${(c.refOffsetMeters / 1000).toFixed(2)} กม.` : `${c.refOffsetMeters} ม.`;
            window.recordEquipmentNavStart({
                id: `fault_cand_${idx + 1}`,
                name: `🎯 จุดคาดการณ์ #${idx + 1} (${c.confidencePct}% • เลย ${c.refPinName} ${offTxt})`,
                note: `ระยะสาย ${c.totalActualKm.toFixed(2)} กม. มุ่งหน้า ${c.towardName}`,
                lat: c.lat, lon: c.lon, ownerGroup: lastFaultResult.srcPin?.ownerGroup || ''
            }, route);
        }
        window.open(mapsUrl, '_blank', 'noopener');
    }

    async function executeFaultDistanceSearch(retryCount = 0, modeHint = 'auto') {
        if (!document.getElementById('techMainApp')) return;
        if (window.PeaIdbStore?.isHydrating?.()) await window.PeaIdbStore.ready;
        tryDiscoverExistingMap();
        if (!capturedMap || !faultLayerGroup) {
            if (retryCount >= 12) return window.showToast?.('⚠️ แผนที่ยังไม่พร้อมใช้งาน กรุณาลองอีกครั้ง');
            if (retryCount === 0 && typeof window.switchTechMainTab === 'function') window.switchTechMainTab('map');
            setTimeout(() => executeFaultDistanceSearch(retryCount + 1, modeHint), 250);
            return;
        }

        const sel = document.getElementById('scadaFaultSourceSelect');
        if (sel && (!sel.options.length || !sel.value)) populateFaultSourceDropdown();
        const srcId = sel?.value || '';
        const kmVal = parseFloat(document.getElementById('scadaFaultKmInput')?.value || '');
        const hasKm = !isNaN(kmVal) && kmVal > 0;
        const hasAmp = parseFloat(document.getElementById('scadaFaultAmpInput')?.value || '') > 0;

        const preferKmSolver = (modeHint === 'km' && hasKm) || (modeHint === 'auto' && lastEditedMetric === 'km' && hasKm) || (!hasAmp && hasKm);
        const ampCfg = hasAmp ? readPage2AmpCalcConfig(!preferKmSolver) : null;
        if (ampCfg && preferKmSolver) ampCfg.useAmpSolver = false;

        const tolVal = parseFloat(document.getElementById('scadaFaultTolSelect')?.value || '0.15') || 0;
        const stopOpen = document.getElementById('scadaFaultStopOpenChk')?.checked !== false;
        const downstreamOnly = document.getElementById('scadaFaultDownstreamChk')?.checked !== false;
        const autoLateral = document.getElementById('scadaFaultAutoLateralChk')?.checked !== false;
        const stationUg = document.getElementById('scadaFaultStationUgChk')?.checked !== false;
        const mustPassId = document.getElementById('scadaFaultMustPassSelect')?.value || '';
        const bypassIsolateId = document.getElementById('scadaFaultBypassIsolateSelect')?.value || '';
        const tripStatus = document.getElementById('scadaFaultTripModeSelect')?.value || 'AUTO';

        const pendingSingleNotPass = document.getElementById('scadaFaultNotPassSelect')?.value || '';
        if (pendingSingleNotPass && pendingSingleNotPass !== mustPassId) {
            excludedNotPassIds.add(pendingSingleNotPass);
            const npEl = document.getElementById('scadaFaultNotPassSelect');
            if (npEl) npEl.value = '';
            renderExcludedNotPassChips();
        }

        if (!srcId) return window.showToast?.('⚠️ กรุณาตั้งค่าหมุด ■ CB/RC หรือลากสายเชื่อมหมุดต้นทางในผังก่อนครับ');
        if (!hasKm && !ampCfg) {
            return window.showToast?.('⚠️ กรุณากรอก "ระยะรีเลย์ (กม.)" หรือ "กระแสฟอลต์ (แอมป์)" อย่างใดอย่างหนึ่งก่อนคำนวณครับ');
        }

        if (document.getElementById('btnToggleScadaLines')?.textContent?.includes('ซ่อน')) window.toggleScadaLinesVisibility?.();
        const allColorBtn = document.getElementById('colorFilterBtn-all');
        if (allColorBtn && !allColorBtn.className.includes('bg-slate-800')) window.selectEquipPinColorFilter?.('all');

        faultLayerGroup.clearLayers();
        const effectiveKm = (!preferKmSolver && ampCfg) ? ampCfg.approxUniformKm : kmVal;
        const res = traceFaultLocations(srcId, effectiveKm, tolVal, stopOpen, downstreamOnly, ampCfg, {
            autoLateral, stationUg, mustPassId, bypassIsolateId, notPassIds: excludedNotPassIds, tripStatus
        });
        if (res.error) return window.showToast?.('⚠️ ' + res.error);
        lastFaultResult = res;

        if ((res.redirectedFromUnwired || res.autoSteppedBackInfo) && sel && Array.from(sel.options).some((o) => o.value === res.srcPin.id)) {
            sel.value = res.srcPin.id;
            onFaultAmpParamsChanged(false);
        }
        const fdFilterEl = document.getElementById('scadaFeederFilterSelect');
        if (fdFilterEl && fdFilterEl.value !== 'ALL' && fdFilterEl.value !== (res.srcPin?.scadaNode?.fd || '')) {
            fdFilterEl.value = 'ALL'; window.onScadaFeederFilterChange?.('ALL');
        }

        const bounds = [[Number(res.srcPin.lat), Number(res.srcPin.lon)]];
        res.tracedSegments.forEach((seg) => {
            if (seg.length < 2) return;
            L.polyline(seg, { pane: 'scadaFaultLocatorPane', color: '#f43f5e', weight: 6, opacity: 0.40, interactive: false }).addTo(faultLayerGroup);
            L.polyline(seg, { pane: 'scadaFaultLocatorPane', color: '#fbbf24', weight: 2.6, dashArray: '6, 5', opacity: 0.95, interactive: false }).addTo(faultLayerGroup);
        });

        res.rfArcZones.forEach((arcSeg) => {
            if (arcSeg.length < 2) return;
            L.polyline(arcSeg, { pane: 'scadaFaultLocatorPane', color: '#f97316', weight: 9, dashArray: '4, 8', opacity: 0.45, interactive: false }).addTo(faultLayerGroup);
        });

        res.candidates.forEach((c, idx) => {
            bounds.push([c.lat, c.lon]);
            const isTopPick = idx === 0 && res.candidates.length > 1;
            const zoneColor = isTopPick ? '#10b981' : '#ef4444';
            if (c.tolZonePath?.length >= 2) {
                L.polyline(c.tolZonePath, { pane: 'scadaFaultLocatorPane', color: zoneColor, weight: 10, opacity: 0.38, interactive: false }).addTo(faultLayerGroup);
            }
            const badgeNo = idx + 1;
            const offsetStr = c.refOffsetMeters >= 1000 ? `${(c.refOffsetMeters / 1000).toFixed(2)} กม.` : `${c.refOffsetMeters} เมตร`;
            const ampTag = (ampCfg && ampCfg.useAmpSolver !== false) ? ` • ${ampCfg.ampVal.toLocaleString()} A` : '';
            const badgeBg = isTopPick ? '#059669' : '#dc2626';
            const badgePrefix = isTopPick ? '⭐' : '🎯';
            const nearHtml = c.nearbyLandmark
                ? `<div class="text-[10.5px] text-indigo-800 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-md font-bold">🔎 ใกล้ ${c.nearbyLandmark.isTx ? 'หม้อแปลง ' : ''}${escHtml(c.nearbyLandmark.name)} (~${c.nearbyLandmark.distMeters} ม.)</div>`
                : '';
            const reasonHtml = c.reasons?.length
                ? `<div class="text-[10.5px] text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-md font-semibold">${c.reasons.map(escHtml).join('<br>')}</div>`
                : '';

            const icon = L.divIcon({
                className: '',
                html: `<div style="position:relative;width:44px;height:40px;display:flex;align-items:center;justify-content:center;"><div style="position:absolute;inset:0;border-radius:9999px;background:${isTopPick ? 'rgba(16,185,129,0.34)' : 'rgba(239,68,68,0.32)'};border:2px solid ${zoneColor};animation:peaFaultTargetPulse 1.2s infinite ease-out;"></div><div style="position:relative;z-index:2;background:${badgeBg};color:#fff;border:2px solid #fde047;border-radius:9999px;padding:1px 6px;font-size:10.5px;font-weight:900;white-space:nowrap;box-shadow:0 3px 10px rgba(0,0,0,0.55);">${badgePrefix}#${badgeNo}</div></div>`,
                iconSize: [44, 40], iconAnchor: [22, 20], popupAnchor: [0, -16]
            });
            L.marker([c.lat, c.lon], { icon, pane: 'scadaFaultLocatorPane' }).addTo(faultLayerGroup).bindPopup(
                `<div style="font-family:'Prompt',sans-serif;min-width:265px;" class="space-y-1.5 text-xs">` +
                `<div style="background:${badgeBg};" class="text-white px-2.5 py-1 rounded-lg font-extrabold flex justify-between items-center gap-2"><span>${badgePrefix} จุดคาดการณ์ #${badgeNo} (${c.confidencePct}%)</span><span>${c.totalActualKm.toFixed(2)} กม.${escHtml(ampTag)}</span></div>` +
                `<div class="font-bold text-slate-800">📍 เลย <u>${escHtml(c.refPinName)}</u> ไป ${offsetStr}</div>` +
                `<div class="text-[11px] text-slate-600">➡️ มุ่งหน้า: <b>${escHtml(c.towardName)}</b> (${escHtml(c.spec)})</div>` +
                nearHtml +
                reasonHtml +
                `<div class="text-[10px] text-slate-400">พิกัด: ${c.lat}, ${c.lon} (ระยะถนน/ผัง ${c.totalGroundKm.toFixed(2)} กม.${res.stationUgMeters > 0 ? ` • รวมคิด UG สถานี ${res.stationUgMeters} ม.` : ''})</div>` +
                `<div class="pt-1 grid grid-cols-2 gap-1">` +
                `<button type="button" onclick="navigateToFaultCandidate(${idx})" style="background:#2563eb;color:#fff;padding:5px 6px;border-radius:8px;font-weight:700;font-size:10.5px;white-space:nowrap;">🚗 นำทาง Maps</button>` +
                `<button type="button" onclick="openFaultStreetView(${c.lat},${c.lon})" style="background:#d97706;color:#fff;padding:5px 6px;border-radius:8px;font-weight:700;font-size:10.5px;white-space:nowrap;">🛣️ ส่องเสาจริง</button>` +
                `<button type="button" onclick="copyFaultLocatorReport(this)" style="background:#334155;color:#fde047;border:1px solid rgba(251,191,36,0.55);padding:5px 6px;border-radius:8px;font-weight:700;font-size:10.5px;white-space:nowrap;">📋 คัดลอก</button>` +
                `<button type="button" onclick="shareFaultLocatorReportToLine()" style="background:#00B900;color:#fff;padding:5px 6px;border-radius:8px;font-weight:700;font-size:10.5px;white-space:nowrap;">💬 ส่งเข้า LINE</button>` +
                `</div></div>`
            );
        });

        const resBox = document.getElementById('scadaFaultResultBox');
        if (resBox) {
            resBox.classList.remove('hidden');
            const diagNotices = [];
            if (res.autoSteppedBackInfo) {
                diagNotices.push(`<div class="px-2 py-1 bg-cyan-950/80 border border-cyan-400/50 rounded-lg text-[10.5px] text-cyan-200">🔄 <b>ถอยกลับต้นสายอัตโนมัติ:</b> กระแส ${ampCfg.ampVal.toLocaleString()} A เกิดก่อนถึงสวิตช์ <b>${escHtml(res.autoSteppedBackInfo.fromPinName)}</b> (~${res.autoSteppedBackInfo.fromMaxAmp.toLocaleString()} A) ระบบจึงเริ่มวัดจากต้นวงจร <b>${escHtml(res.autoSteppedBackInfo.toBrkName)}</b> ให้ทันที</div>`);
            }
            if (res.impliedRfOhm !== null) {
                const rfDesc = res.impliedRfOhm < 0.8
                    ? 'ลัดวงจรโดยตรง (สายขาดช็อตโครง/ลูกถ้วยแตก)'
                    : (res.impliedRfOhm <= 4.0 ? 'ความต้านทานแฝงปานกลาง (กิ่งไม้สด/สัตว์/อาร์ก)' : 'ความต้านทานดินสูง (กิ่งไม้พาดสาย/สายตกพื้นแห้ง)');
                diagNotices.push(`<div class="px-2 py-1 bg-sky-950/75 border border-sky-400/40 rounded-lg text-[10.5px] text-sky-200">🔍 <b>วิเคราะห์ความต้านทานจุดฟอลต์:</b> ประมาณ <b>~${res.impliedRfOhm} Ω</b> — ${escHtml(rfDesc)}</div>`);
            } else if (ampCfg?.faultType === 'LG' && ampCfg.useAmpSolver !== false && (ampCfg.rfOhm || 0) === 0) {
                diagNotices.push(`<div class="px-2 py-1 bg-amber-950/70 border border-amber-400/40 rounded-lg text-[10px] text-amber-200">🟠 <b>ฟอลต์ลงดิน 1 เฟส:</b> เส้นปะสีส้มก่อนถึงจุดหมายคือ<b>โซนเผื่อกิ่งไม้แตะสาย (0–2.5 Ω)</b> แนะนำไล่สายตั้งแต่ต้นเส้นปะสีส้ม</div>`);
            }

            if (res.candidates.length === 0) {
                if (res.exceededMidSwitchAmp) {
                    resBox.innerHTML = `<div class="p-2 bg-amber-950/80 border border-amber-400/50 rounded-xl text-amber-200 text-[11px]">⚠️ กระแส <b>${ampCfg.ampVal.toLocaleString()} A</b> สูงกว่ากระแสลัดวงจรสูงสุด ณ จุด <b>${escHtml(res.srcPin.name)}</b> (~${res.maxOriginAmp.toLocaleString()} A) จุดเกิดเหตุอยู่<b>ฝั่งต้นสายก่อนถึงสวิตช์นี้</b> (แนะนำเปลี่ยนต้นทางเป็น ■ CB/RC)</div>`;
                } else {
                    const endAmpNote = (ampCfg && isFinite(res.minEndFaultAmp)) ? ` (กระแสลัดวงจรต่ำสุดที่ปลายผังคือ ~${Math.round(res.minEndFaultAmp).toLocaleString()} A)` : '';
                    const filterHint = (res.mustPassPin || res.excludedPinsList?.length) ? ' หรือเกิดจากตัวกรองจุดผ่าน/ไม่ผ่านที่เลือกไว้' : '';
                    resBox.innerHTML = res.maxReachKm <= 0.001
                        ? `<div class="p-2 bg-amber-950/80 border border-amber-400/50 rounded-xl text-amber-200 text-[11px]">⚠️ หมุด <b>${escHtml(res.srcPin.name)}</b> ยังไม่ได้ลากเส้นสายไฟเชื่อมเข้าผัง (หากมีหมุดชื่อซ้ำ กรุณาเลือกตัวที่มีรหัสวงจรกำกับ)</div>`
                        : `<div class="p-2 bg-amber-950/80 border border-amber-400/50 rounded-xl text-amber-200 text-[11px]">⚠️ ไม่พบจุดตรงเงื่อนไขบนแนวสาย (สายยาวสุด ${res.maxReachKm.toFixed(2)} กม. ถึงจุด ${escHtml(res.furthestPin?.name || '-')})${escHtml(endAmpNote + filterHint)}</div>`;
                    if (res.furthestPin) bounds.push([Number(res.furthestPin.lat), Number(res.furthestPin.lon)]);
                }
            } else {
                const ugHeadNote = res.stationUgMeters > 0 ? ` • รวม UG สถานี ${res.stationUgMeters} ม.` : '';
                const upNote = res.upstreamKm > 0.05 ? ` • สายต้นน้ำ ${res.upstreamKm.toFixed(2)} กม.` : '';
                const headTxt = (ampCfg && ampCfg.useAmpSolver !== false)
                    ? `🎯 จัดอันดับ ${res.candidates.length} จุดคาดการณ์ จากกระแส ${ampCfg.ampVal.toLocaleString()} A${ugHeadNote}${upNote}`
                    : `🎯 จัดอันดับ ${res.candidates.length} จุดคาดการณ์ตามระยะรีเลย์ (${effectiveKm.toFixed(2)} กม.${ugHeadNote})`;
                resBox.innerHTML = `${diagNotices.join('')}` +
                    `<div class="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-rose-200 font-bold">` +
                    `<span class="min-w-0">${escHtml(headTxt)}</span>` +
                    `<div class="flex items-center gap-1 shrink-0 ml-auto">` +
                    `<button type="button" onclick="copyFaultLocatorReport(this)" class="bg-slate-700 hover:bg-slate-600 text-amber-300 border border-amber-400/50 px-2.5 py-1 rounded-lg text-[10px] font-extrabold whitespace-nowrap shadow-sm transition">📋 คัดลอก</button>` +
                    `<button type="button" onclick="shareFaultLocatorReportToLine()" class="bg-[#00B900] hover:bg-[#009900] text-white px-2.5 py-1 rounded-lg text-[10px] font-extrabold whitespace-nowrap shadow-sm transition">💬 ส่งเข้า LINE</button>` +
                    `</div></div>` +
                    `<div class="grid grid-cols-1 sm:grid-cols-2 gap-1 pt-1 max-h-32 overflow-y-auto">` +
                    res.candidates.map((c, i) => {
                        const offTxt = c.refOffsetMeters >= 1000 ? `${(c.refOffsetMeters / 1000).toFixed(2)} กม.` : `${c.refOffsetMeters} ม.`;
                        const topCls = (i === 0 && res.candidates.length > 1) ? 'border-emerald-400/80 bg-emerald-950/50' : 'border-rose-400/40 bg-slate-950/90';
                        const nearShort = c.nearbyLandmark ? ` • ใกล้ ${c.nearbyLandmark.name}` : (c.reasons?.[0] ? ` • ${c.reasons[0]}` : '');
                        return `<div class="flex items-center gap-1 rounded-lg border ${topCls} pr-1"><button type="button" onclick="zoomToFaultCandidate(${i})" class="flex-1 min-w-0 text-left px-2 py-1.5 text-[10px] text-white truncate"><b class="${i === 0 ? 'text-emerald-300' : 'text-amber-300'}">${i === 0 && res.candidates.length > 1 ? '⭐' : '#'}${i + 1} [${c.confidencePct}%]</b> เลย ${escHtml(c.refPinName)} (${offTxt}) ➔ ${escHtml(c.towardName)}${escHtml(nearShort)}</button><button type="button" onclick="openFaultStreetView(${c.lat},${c.lon})" title="ส่องเสาไฟจริงบน Google Street View" class="shrink-0 bg-amber-600/85 hover:bg-amber-500 text-white px-1.5 py-1 rounded text-[9.5px] font-bold">🛣️</button></div>`;
                    }).join('') + `</div>`;
            }
        }
        if (bounds.length >= 2) capturedMap.fitBounds(bounds, { padding: [42, 42], maxZoom: 16 });
        else if (bounds.length === 1) capturedMap.setView(bounds[0], 16);
    }

    function zoomToFaultCandidate(idx) {
        const c = lastFaultResult?.candidates?.[idx];
        if (!c || !capturedMap) return;
        capturedMap.setView([c.lat, c.lon], 17);
        faultLayerGroup?.eachLayer((ly) => {
            const ll = ly.getLatLng?.();
            if (ll && Math.abs(ll.lat - c.lat) < 1e-5 && Math.abs(ll.lng - c.lon) < 1e-5) ly.openPopup?.();
        });
    }

    function buildFaultLocatorReportText() {
        if (!lastFaultResult?.candidates?.length) return '';
        const r = lastFaultResult, ac = r.ampCalcCfg;
        const ugReportTag = r.stationUgMeters > 0 ? ` • รวมสาย UG ในสถานี ${r.stationUgMeters} ม.` : '';
        const metricLine = (ac && ac.useAmpSolver !== false)
            ? `⚡ คำนวณจากกระแส : ${ac.ampVal.toLocaleString()} A (${getFaultTypeLabelThai(ac.faultType)} @ ${ac.busKv}kV${ugReportTag}${ac.rfOhm > 0 ? ` • ดิน ${ac.rfOhm} Ω` : ''})`
            : `📏 ระยะจากรีเลย์ : ${r.targetKm.toFixed(2)} กม. (±${r.tolKm.toFixed(2)} กม.${ugReportTag})${r.impliedRfOhm !== null ? ` • ประเมินความต้านทาน ~${r.impliedRfOhm} Ω` : ''}`;
        const fiLine = r.mustPassPin ? `📟 ผ่านจุดเห็นฟอลต์ : ${r.mustPassPin.name}` : '';
        const isoLine = r.bypassIsolatePin ? `🔓 โซนหลังสวิตช์ปลด : ${r.bypassIsolatePin.name}` : '';
        const lines = [
            `🎯 รายงานจุดคาดการณ์ตามแนวสาย 22kV (v3.5)`,
            `⚡ ต้นทางจ่ายไฟ : ${r.srcPin.name}${r.srcPin.scadaNode?.fd ? ` (${r.srcPin.scadaNode.fd})` : ''}`,
            metricLine,
            fiLine,
            isoLine,
            `━━━━━━━━━━━━━━━━━━`
        ].filter(Boolean);

        r.candidates.forEach((c, i) => {
            const offTxt = c.refOffsetMeters >= 1000 ? `${(c.refOffsetMeters / 1000).toFixed(2)} กม.` : `${c.refOffsetMeters} เมตร`;
            const rankStar = (i === 0 && r.candidates.length > 1) ? '⭐ แนะนำจุดแรก ' : '';
            const nearTail = c.nearbyLandmark ? `\n   🔎 ใกล้${c.nearbyLandmark.isTx ? 'หม้อแปลง ' : ''}${c.nearbyLandmark.name} (~${c.nearbyLandmark.distMeters} ม.)` : '';
            const reasonTail = c.reasons?.length ? `\n   💡 ${c.reasons.join(' | ')}` : '';
            lines.push(
                `${i + 1}) ${rankStar}[โอกาส ${c.confidencePct}%] เลย ${c.refPinName} ไป ${offTxt} (มุ่งหน้า ${c.towardName} • ${c.spec})${nearTail}${reasonTail}`,
                `   📍 นำทาง: https://www.google.com/maps?q=${c.lat},${c.lon}`,
                `   🛣️ ส่องเสาจริง: https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${c.lat},${c.lon}`
            );
        });
        return lines.join('\n');
    }

    function copyFaultLocatorReport(btnEl = null) {
        const msg = buildFaultLocatorReportText();
        if (!msg) return window.showToast?.('⚠️ ยังไม่มีจุดคาดการณ์สำหรับคัดลอก');
        copyTextReliableWithFeedback(msg, '📋 คัดลอกผลและพิกัดแล้ว! (กดวางใน LINE PC ได้เลย)', btnEl);
    }

    function shareFaultLocatorReportToLine() {
        const msg = buildFaultLocatorReportText();
        if (!msg) return window.showToast?.('⚠️ ยังไม่มีจุดคาดการณ์สำหรับส่ง LINE');
        copyTextReliableWithFeedback(msg, '💬 คัดลอกพิกัดและลิงก์ Street View แล้ว กำลังเปิด LINE...');
        openFaultLineShareSafe(msg);
    }

    async function toggleScadaFaultLocatorPanel(forceOpen) {
        panelOpen = typeof forceOpen === 'boolean' ? forceOpen : !panelOpen;
        document.getElementById('scadaFaultLocatorPanel')?.classList.toggle('hidden', !panelOpen);
        const btn = document.getElementById('btnToggleFaultLocator');
        if (btn) btn.className = panelOpen
            ? 'bg-rose-600 text-white border border-amber-300 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow'
            : 'bg-rose-900/90 hover:bg-rose-800 text-rose-100 border border-rose-400/50 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow';
        if (panelOpen) {
            if (window.PeaIdbStore?.isHydrating?.()) await window.PeaIdbStore.ready;
            pullCloudCalibIntoLocal();
            populateFaultSourceDropdown();
        }
        setTimeout(() => capturedMap?.invalidateSize?.(), 60);
    }

    function injectPage2ToolbarLocatorUI() {
        const tb = document.getElementById('scadaControlToolbar');
        if (!tb) return false;
        if (document.getElementById('btnToggleFaultLocator')) return true;
        const simBtn = document.getElementById('btnToggleScadaSimMode');
        if (simBtn?.parentElement) {
            const btn = document.createElement('button');
            btn.type = 'button'; btn.id = 'btnToggleFaultLocator'; btn.onclick = () => toggleScadaFaultLocatorPanel();
            btn.className = 'bg-rose-900/90 hover:bg-rose-800 text-rose-100 border border-rose-400/50 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow';
            btn.innerHTML = '🎯 วัดระยะ/กระแสฟอลต์';
            simBtn.parentElement.insertBefore(btn, simBtn);
        }

        const prefs = loadCalcPrefs();
        const cableOpts = Object.entries(PEA_22KV_CABLES).map(([k, v]) => `<option value="${k}"${prefs.cableKey === k ? ' selected' : ''}>${escHtml(v.label)}</option>`).join('');
        const subOpts = Object.entries(PEA_SOURCE_BUS_PRESETS).map(([k, v]) => `<option value="${k}"${prefs.sourceKey === k ? ' selected' : ''}>${escHtml(v.label)}</option>`).join('');
        const busKvOpts = [22.0, 22.4, 22.6, 22.8, 23.0].map((kv) => `<option value="${kv}"${Math.abs(Number(prefs.busKv) - kv) < 0.06 ? ' selected' : ''}>บัส ${kv.toFixed(1)} kV</option>`).join('');

        const pnl = document.createElement('div');
        pnl.id = 'scadaFaultLocatorPanel';
        pnl.className = 'hidden pt-2 border-t border-rose-500/40 space-y-2 text-xs';
        pnl.innerHTML =
            `<div class="p-2.5 rounded-xl bg-gradient-to-r from-rose-950/90 via-slate-900 to-slate-900 border border-rose-400/40 space-y-2">` +
            `<div class="grid grid-cols-2 sm:grid-cols-12 gap-1.5 items-center">` +
            `<select id="scadaFaultSourceSelect" onchange="onFaultFilterPinsChanged()" class="col-span-2 sm:col-span-4 px-2.5 py-1.5 rounded-lg bg-slate-800 text-amber-300 border border-slate-600 text-xs font-bold"></select>` +
            `<input type="number" step="0.01" min="0.05" inputmode="decimal" id="scadaFaultKmInput" placeholder="ระยะรีเลย์ กม. (เช่น 4.35)" oninput="onFaultKmManualInput()" onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();executeFaultDistanceSearch(0,'km');}" class="col-span-1 sm:col-span-3 px-2.5 py-1.5 rounded-lg bg-slate-800 text-white border border-slate-600 text-xs font-bold">` +
            `<select id="scadaFaultTolSelect" class="col-span-1 sm:col-span-2 px-2.5 py-1.5 rounded-lg bg-slate-800 text-slate-200 border border-slate-600 text-[11px] font-bold"><option value="0.15">เผื่อ ±150 ม.</option><option value="0.30">เผื่อ ±300 ม.</option><option value="0">จุดเป๊ะ</option></select>` +
            `<div class="col-span-2 sm:col-span-3 flex gap-1"><button type="button" onclick="executeFaultDistanceSearch(0,'auto')" class="flex-1 bg-rose-600 hover:bg-rose-500 text-white py-1.5 px-2 rounded-lg text-[11px] font-extrabold shadow whitespace-nowrap">🔍 คำนวณจุด</button><button type="button" onclick="resetFaultLocatorInputs(false)" class="bg-slate-700 hover:bg-slate-600 text-amber-300 border border-slate-500/60 py-1.5 px-2.5 rounded-lg text-[11px] font-extrabold whitespace-nowrap" title="ล้างค่าที่กรอกและหมุดบนแผนที่">🧹 ล้างค่า</button></div></div>` +

            `<div class="p-2 rounded-lg bg-slate-950/75 border border-amber-400/30 space-y-1.5">` +
            `<div class="grid grid-cols-2 sm:grid-cols-12 gap-1.5 items-center">` +
            `<input type="number" step="10" min="50" inputmode="numeric" id="scadaFaultAmpInput" placeholder="⚡ กระแสฟอลต์ (A)" oninput="onFaultAmpParamsChanged(false)" onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();onFaultAmpParamsChanged(true);}" class="col-span-1 sm:col-span-2 px-2 py-1.5 rounded-lg bg-slate-800 text-amber-300 border border-amber-400/50 text-xs font-extrabold placeholder:text-amber-200/50">` +
            `<select id="scadaFaultPhaseSelect" onchange="onFaultAmpParamsChanged(true)" class="col-span-1 sm:col-span-2 px-2 py-1.5 rounded-lg bg-slate-800 text-white border border-slate-600 text-[11px] font-bold">` +
            `<option value="LL"${prefs.faultType === 'LL' ? ' selected' : ''}>⚡ ช็อต 2 เฟส (LL)</option>` +
            `<option value="LLG"${prefs.faultType === 'LLG' ? ' selected' : ''}>⚡🌱 2 เฟสลงดิน (LLG)</option>` +
            `<option value="3P"${prefs.faultType === '3P' ? ' selected' : ''}>💥 ช็อต 3 เฟส (3P)</option>` +
            `<option value="LG"${prefs.faultType === 'LG' ? ' selected' : ''}>🌱 ลงดิน 1 เฟส (LG)</option></select>` +
            `<select id="scadaFaultCableSelect" onchange="onFaultAmpParamsChanged(true)" class="col-span-2 sm:col-span-3 px-2 py-1.5 rounded-lg bg-slate-800 text-slate-200 border border-slate-600 text-[11px] font-bold">${cableOpts}</select>` +
            `<select id="scadaFaultSubZSelect" onchange="onFaultAmpParamsChanged(true)" class="col-span-1 sm:col-span-2 px-2 py-1.5 rounded-lg bg-slate-800 text-slate-200 border border-slate-600 text-[11px] font-bold">${subOpts}</select>` +
            `<select id="scadaFaultBusKvSelect" onchange="onFaultAmpParamsChanged(true)" class="col-span-1 sm:col-span-1 px-1.5 py-1.5 rounded-lg bg-slate-800 text-cyan-200 border border-slate-600 text-[10.5px] font-bold">${busKvOpts}</select>` +
            `<div class="col-span-2 sm:col-span-2 flex items-center bg-slate-800 border border-slate-600 rounded-lg px-2 py-1" title="ความต้านทานดิน/กิ่งไม้ (โอห์ม) ปกติช็อตตรงเว้นว่างเป็น 0">` +
            `<span class="text-[10px] text-amber-200/80 font-bold whitespace-nowrap mr-1.5">Ω ดิน:</span>` +
            `<input type="number" step="0.5" min="0" max="50" id="scadaFaultRfInput" value="" onchange="onFaultAmpParamsChanged(true)" placeholder="0 (ปกติ)" class="w-full min-w-0 bg-transparent border-0 text-slate-100 text-[11px] font-extrabold text-center focus:outline-none"></div></div>` +

            `<div class="grid grid-cols-1 sm:grid-cols-12 gap-1.5 pt-0.5">` +
            `<select id="scadaFaultMustPassSelect" onchange="onFaultConstraintChanged()" class="sm:col-span-3 px-2 py-1 rounded-lg bg-slate-800 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold"><option value="">🟢 ผ่านจุด/เห็นฟอลต์: ไม่ระบุ</option></select>` +
            `<select id="scadaFaultNotPassSelect" onchange="addFaultExcludedNotPassPin(this.value)" class="sm:col-span-4 px-2 py-1 rounded-lg bg-slate-800 text-rose-300 border border-rose-500/40 text-[11px] font-bold"><option value="">➕ ตัดจุด FI ปกติ/ไฟไม่ผ่าน (เลือกสะสมได้)...</option></select>` +
            `<select id="scadaFaultBypassIsolateSelect" onchange="onFaultConstraintChanged()" class="sm:col-span-3 px-2 py-1 rounded-lg bg-slate-800 text-sky-300 border border-sky-500/40 text-[11px] font-bold"><option value="">🔓 ทะลุสวิตช์เพิ่งปลดแยกโซน: ไม่ระบุ</option></select>` +
            `<select id="scadaFaultTripModeSelect" onchange="onFaultConstraintChanged()" class="sm:col-span-2 px-2 py-1 rounded-lg bg-slate-800 text-slate-200 border border-slate-600 text-[11px] font-bold"><option value="AUTO">อาการ: อัตโนมัติ</option><option value="TL">🔒 T/L (ล็อกเอาต์)</option><option value="TR">🔄 T/R (ชั่วคราว)</option></select>` +
            `</div>` +
            `<div id="scadaFaultExcludedChipsBar" class="hidden flex flex-wrap items-center gap-1 pt-0.5"></div>` +

            `<div id="scadaFaultAmpCalcBadge" class="text-[10.5px] text-slate-400">${DEFAULT_AMP_HINT_TEXT}</div></div>` +

            `<div class="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-300">` +
            `<div class="flex flex-wrap items-center gap-3">` +
            `<label class="inline-flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" id="scadaFaultStopOpenChk" checked onchange="onFaultConstraintChanged()" class="accent-rose-500 rounded"><span>หยุดที่สวิตช์ปลด (Tie)</span></label>` +
            `<label class="inline-flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" id="scadaFaultDownstreamChk" checked onchange="onFaultConstraintChanged()" class="accent-rose-500 rounded"><span>เฉพาะท้ายน้ำ</span></label>` +
            `<label class="inline-flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" id="scadaFaultStationUgChk"${prefs.stationUg !== false ? ' checked' : ''} onchange="onFaultAmpParamsChanged(true)" class="accent-cyan-400 rounded"><span class="text-cyan-200 font-semibold">คิดสาย UG ในสถานี 150 ม. ทุกวงจร</span></label>` +
            `<label class="inline-flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" id="scadaFaultAutoLateralChk"${prefs.autoLateral !== false ? ' checked' : ''} onchange="onFaultAmpParamsChanged(true)" class="accent-emerald-500 rounded"><span>ประเมินสายกิ่ง &amp; สายหย่อน (+3.5%)</span></label>` +
            `</div>` +
            `<button type="button" id="btnFaultToggleCalib" onclick="openFaultCalibrateModal()" class="bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-400/40 px-2 py-0.5 rounded-lg text-[10.5px] font-bold">🎯 เทียบสเกลวงจร</button>` +
            `</div>` +

            `<div id="scadaFaultCalibDrawer" class="hidden p-2 rounded-xl bg-slate-950/90 border border-emerald-400/40 space-y-1.5 text-[11px]">` +
            `<div class="font-bold text-emerald-300">☁️ เทียบสเกลค่าอิมพีแดนซ์จริงประจำวงจร (ซิงค์ร่วมกันทุกเครื่องในสาขา)</div>` +
            `<div id="scadaCalibStatusText" class="text-[10px] text-slate-300"></div>` +
            `<div class="fault-calib-write-only grid grid-cols-1 sm:grid-cols-12 gap-1.5 items-center">` +
            `<select id="scadaCalibRefPinSelect" class="sm:col-span-6 px-2 py-1.5 rounded-lg bg-slate-800 text-white border border-slate-600 text-[11px] font-bold"></select>` +
            `<input type="number" step="10" min="50" inputmode="numeric" id="scadaCalibRealAmpInput" placeholder="กระแสที่อ่านได้จริง (A)" class="sm:col-span-3 px-2 py-1.5 rounded-lg bg-slate-800 text-amber-300 border border-amber-400/50 text-[11px] font-extrabold">` +
            `<div class="sm:col-span-3 flex gap-1"><button type="button" onclick="saveFaultFeederCalibration()" class="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white py-1.5 px-2 rounded-lg text-[10.5px] font-extrabold">✅ บันทึกสเกล</button><button type="button" onclick="clearFaultFeederCalibration()" class="bg-slate-700 hover:bg-rose-700 text-slate-200 py-1.5 px-2 rounded-lg text-[10.5px] font-bold">ล้าง</button></div>` +
            `</div></div>` +

            `<div id="scadaFaultResultBox" class="hidden space-y-1"></div></div>`;
        tb.appendChild(pnl);
        return true;
    }

    function refreshFaultSourceOptions() { populateFaultSourceDropdown(); }

    // ========================================================================
    // 9. เชื่อมฟอร์มรายงานเหตุ TR/TL (แท็บ 1 ใน index.html) อ่านกระแส + สวิตช์ปลด + คลายลิงก์สั้น
    // ========================================================================
    function extractTab1AutoCurrentAndType() {
        const phaseVal = (document.getElementById('phaseSelect')?.value || '').trim().toUpperCase();
        const cA = parseFloat(document.getElementById('currA')?.value || '') || 0;
        const cB = parseFloat(document.getElementById('currB')?.value || '') || 0;
        const cC = parseFloat(document.getElementById('currC')?.value || '') || 0;
        const cG = parseFloat(document.getElementById('currG')?.value || '') || 0;

        let faultType = 'LL';
        if (phaseVal) {
            faultType = normalizeFaultTypeCode(phaseVal);
        } else {
            const highPhases = [cA, cB, cC].filter((v) => v >= 320).length;
            if (highPhases >= 3) faultType = '3P';
            else if (highPhases === 2) faultType = cG >= 180 ? 'LLG' : 'LL';
            else if (highPhases === 1 || cG >= 150) faultType = 'LG';
        }

        let autoAmp = 0;
        if (faultType === '3P') {
            const vals = [cA, cB, cC].filter((v) => v > 0);
            const maxP = Math.max(0, ...vals);
            const active = vals.filter((v) => v >= maxP * 0.72);
            autoAmp = active.length >= 2 ? Math.round(active.reduce((s, v) => s + v, 0) / active.length) : maxP;
        } else if (faultType === 'LL') {
            const vals = [cA, cB, cC].filter((v) => v > 0).sort((a, b) => b - a);
            autoAmp = (vals.length >= 2 && vals[1] >= vals[0] * 0.65) ? Math.round((vals[0] + vals[1]) / 2) : (vals[0] || 0);
        } else if (faultType === 'LLG') {
            autoAmp = Math.round(Math.max(cA, cB, cC));
        } else {
            if (/^A(?:-G)?$/.test(phaseVal) && cA > 0) autoAmp = Math.max(cA, cG);
            else if (/^B(?:-G)?$/.test(phaseVal) && cB > 0) autoAmp = Math.max(cB, cG);
            else if (/^C(?:-G)?$/.test(phaseVal) && cC > 0) autoAmp = Math.max(cC, cG);
            else autoAmp = Math.max(cA, cB, cC, cG);
        }

        const causeVal = (document.getElementById('causeSelect')?.value || '').toUpperCase();
        const tlVal = (document.getElementById('tlSelect')?.value || '').toUpperCase();
        const tripMode = (causeVal === 'T/L' || tlVal === 'T/L') ? 'TL' : (causeVal === 'T/R' ? 'TR' : 'AUTO');

        return { autoAmp: Math.round(autoAmp), faultType, tripMode };
    }

    function syncMainFormFaultCurrentsToQuickBar() {
        const ampInp = document.getElementById('tab1QuickFaultAmpInput');
        if (!ampInp) return;
        const { autoAmp, faultType } = extractTab1AutoCurrentAndType();
        ampInp.placeholder = autoAmp > 0 ? `⚡ อัตโนมัติ ${autoAmp} A (${faultType})` : '⚡ กระแส (แอมป์)';
    }

    function handleIncomingLocatorMessage(pkt) {
        if (!pkt || !document.getElementById('techMainApp')) return;
        if (pkt.type === 'SCADA_CLEAR_FAULT_LOCATOR') {
            if (pkt.ts && pkt.ts <= lastClearedPktTs) return;
            lastClearedPktTs = pkt.ts || Date.now();
            resetFaultLocatorInputs(true);
            return;
        }
        if (pkt.type === 'SCADA_LOCATE_FAULT_DISTANCE') applyIncomingFaultPacket(pkt);
    }

    async function applyIncomingFaultPacket(pkt) {
        if (!pkt || pkt.type !== 'SCADA_LOCATE_FAULT_DISTANCE' || !document.getElementById('techMainApp')) return;
        if (pkt.ts && pkt.ts <= lastHandledPktTs) return;
        lastHandledPktTs = pkt.ts || Date.now();
        safeSessionSet(HANDLED_PKT_SESSION_KEY, String(lastHandledPktTs));

        incomingReporterCoords = (pkt.reporterCoords && !isNaN(pkt.reporterCoords.lat)) ? pkt.reporterCoords : null;
        const mySeq = ++activePacketApplySeq;
        if (window.PeaIdbStore?.ready) await window.PeaIdbStore.ready;

        for (let attempt = 0; attempt < 25; attempt++) {
            if (mySeq !== activePacketApplySeq) return;
            let loggedIn = false;
            try { loggedIn = localStorage.getItem('elec_app_logged_in') === 'true'; } catch (e) {}
            if (!loggedIn) { await new Promise((r) => setTimeout(r, 250)); continue; }

            window.switchTechMainTab?.('map');
            tryDiscoverExistingMap();
            if (injectPage2ToolbarLocatorUI() && document.getElementById('scadaFaultKmInput')) {
                if (window.PeaIdbStore?.isHydrating?.()) await window.PeaIdbStore.ready;
                pullCloudCalibIntoLocal();
                await toggleScadaFaultLocatorPanel(true);

                excludedNotPassIds.clear();
                renderExcludedNotPassChips();
                ['scadaFaultMustPassSelect', 'scadaFaultBypassIsolateSelect', 'scadaFaultRfInput'].forEach((id) => {
                    const el = document.getElementById(id);
                    if (el) el.value = '';
                });

                const matchRes = populateFaultSourceDropdown(pkt.feeder || '', pkt.deviceHint || '', pkt.stationHint || '', pkt.isolateHint || '');

                const ampInp = document.getElementById('scadaFaultAmpInput');
                const kmInp = document.getElementById('scadaFaultKmInput');
                const phSel = document.getElementById('scadaFaultPhaseSelect');
                const tripSel = document.getElementById('scadaFaultTripModeSelect');

                if (pkt.faultType && phSel) phSel.value = normalizeFaultTypeCode(pkt.faultType);
                if (pkt.tripMode && tripSel) tripSel.value = pkt.tripMode;

                const hasExplicitKm = Boolean(pkt.hasExplicitRelayKm && Number(pkt.distanceKm) > 0);
                const hasAmp = Number(pkt.faultAmp) > 0;

                if (hasExplicitKm && hasAmp) {
                    lastEditedMetric = 'km';
                    if (kmInp) kmInp.value = String(pkt.distanceKm);
                    if (ampInp) ampInp.value = String(pkt.faultAmp);
                    onFaultAmpParamsChanged(false);
                } else if (hasAmp && ampInp) {
                    lastEditedMetric = 'amp';
                    if (kmInp) kmInp.value = '';
                    ampInp.value = String(pkt.faultAmp);
                    onFaultAmpParamsChanged(false);
                } else if (kmInp && Number(pkt.distanceKm) > 0) {
                    lastEditedMetric = 'km';
                    if (ampInp) ampInp.value = '';
                    kmInp.value = String(pkt.distanceKm);
                    onFaultAmpParamsChanged(false);
                }

                if (matchRes.unmatchedDeviceHint) {
                    window.showToast?.(`⚠️ ไม่พบหมุด "${matchRes.unmatchedDeviceHint}" ในผัง ระบบเริ่มวัดจากต้นวงจรแทน`);
                }
                setTimeout(() => executeFaultDistanceSearch(0, hasExplicitKm ? 'km' : (hasAmp ? 'amp' : 'km')), 150);
                return;
            }
            await new Promise((r) => setTimeout(r, 200));
        }
    }

    function checkPendingFaultPacket() {
        if (!document.getElementById('techMainApp')) return;
        try {
            const pkt = JSON.parse(localStorage.getItem(FAULT_PKT_KEY) || 'null');
            if (pkt && Date.now() - (pkt.ts || 0) < 25000 && pkt.ts > lastHandledPktTs) applyIncomingFaultPacket(pkt);
        } catch (e) {}
    }

    function onQuickFaultKmBarInput(val) {
        const qAmp = document.getElementById('tab1QuickFaultAmpInput');
        if (qAmp && val) qAmp.value = '';
        const dz = document.getElementById('distanceZoneField'), dist115 = document.getElementById('distanceInput');
        if (dz && !dz.classList.contains('hidden') && dist115) dist115.value = val;
    }

    function injectIndexTab1QuickLocatorBar() {
        if (document.getElementById('techMainApp') || document.getElementById('tab1FaultLocatorQuickBox')) return;
        const anchorEl = document.getElementById('sortable-tab1') || document.getElementById('distanceZoneField') || document.getElementById('deviceInput')?.closest('div');
        if (!anchorEl?.parentElement) return;

        const box = document.createElement('div');
        box.id = 'tab1FaultLocatorQuickBox';
        box.className = 'mb-2.5 p-2.5 bg-gradient-to-r from-rose-50 to-amber-50 border border-rose-200 rounded-xl flex flex-wrap items-center justify-between gap-2';
        box.innerHTML = `<span class="text-xs font-bold text-rose-900 flex items-center gap-1">🎯 <span>คำนวณจุดฟอลต์ 22kV:</span></span>` +
            `<div class="flex flex-wrap items-center gap-1.5 flex-1 sm:flex-initial justify-end">` +
            `<input type="number" step="10" min="50" inputmode="numeric" id="tab1QuickFaultAmpInput" placeholder="⚡ กระแส (แอมป์)" oninput="if(this.value){const k=document.getElementById('tab1QuickFaultKmInput');if(k)k.value='';}" onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();triggerFaultLocatorFromMainForm();}" class="w-32 px-2 py-1 text-xs font-extrabold bg-white border border-amber-400 rounded-lg text-slate-800">` +
            `<select id="tab1QuickFaultTypeSelect" class="px-1.5 py-1 text-[11px] font-bold bg-white border border-amber-300 rounded-lg text-slate-700"><option value="AUTO">เฟสอัตโนมัติ</option><option value="LL">ช็อต 2 เฟส (LL)</option><option value="LLG">2 เฟสลงดิน (LLG)</option><option value="LG">ลงดิน 1 เฟส (LG)</option><option value="3P">ช็อต 3 เฟส (3P)</option></select>` +
            `<input type="number" step="0.01" min="0.05" inputmode="decimal" id="tab1QuickFaultKmInput" placeholder="หรือ กม." oninput="onQuickFaultKmBarInput(this.value)" onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();triggerFaultLocatorFromMainForm();}" class="w-24 px-2 py-1 text-xs font-bold bg-white border border-rose-300 rounded-lg text-slate-800">` +
            `<button type="button" onclick="triggerFaultLocatorFromMainForm()" class="bg-rose-600 hover:bg-rose-700 text-white px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold shadow-sm shrink-0">🎯 ดูจุดบนผัง</button>` +
            `<button type="button" onclick="clearQuickFaultLocatorFromMainForm(false)" class="bg-white hover:bg-slate-100 text-slate-700 border border-rose-300 px-2 py-1.5 rounded-lg text-[11px] font-extrabold shadow-sm shrink-0" title="ล้างค่าระยะฟอลต์">🧹 ล้างค่า</button></div>`;
        anchorEl.parentElement.insertBefore(box, anchorEl);

        ['currA', 'currB', 'currC', 'currG', 'phaseSelect'].forEach((id) => {
            const el = document.getElementById(id);
            el?.addEventListener('input', syncMainFormFaultCurrentsToQuickBar);
            el?.addEventListener('change', syncMainFormFaultCurrentsToQuickBar);
        });
        syncMainFormFaultCurrentsToQuickBar();

        document.getElementById('distanceInput')?.addEventListener('input', function () {
            const q = document.getElementById('tab1QuickFaultKmInput');
            if (q && document.activeElement !== q) { const parsed = parseFloat(this.value); q.value = !isNaN(parsed) && parsed > 0 ? parsed : ''; }
        });
        if (typeof window.resetFaultForm === 'function' && !window.resetFaultForm.__faultKmHooked) {
            const origReset = window.resetFaultForm;
            window.resetFaultForm = Object.assign(function () {
                const r = origReset.apply(this, arguments);
                clearQuickFaultLocatorFromMainForm(true);
                return r;
            }, { __faultKmHooked: true });
        }
    }

    async function triggerFaultLocatorFromMainForm() {
        const autoExtracted = extractTab1AutoCurrentAndType();
        const rawQuickAmp = document.getElementById('tab1QuickFaultAmpInput')?.value || '';
        const typedAmp = parseFloat(String(rawQuickAmp).replace(/,/g, '').replace(/[^0-9.]/g, ''));
        const amp = (!isNaN(typedAmp) && typedAmp > 0) ? typedAmp : autoExtracted.autoAmp;

        const dz = document.getElementById('distanceZoneField');
        const dist115Val = (dz && !dz.classList.contains('hidden')) ? (document.getElementById('distanceInput')?.value || '') : '';
        const rawKm = document.getElementById('tab1QuickFaultKmInput')?.value || dist115Val;
        const explicitKm = parseFloat(String(rawKm).replace(/,/g, '.').replace(/[^0-9.]/g, ''));
        const hasExplicitRelayKm = !isNaN(explicitKm) && explicitKm > 0;

        const selMode = document.getElementById('tab1QuickFaultTypeSelect')?.value || 'AUTO';
        const faultType = selMode === 'AUTO' ? autoExtracted.faultType : selMode;

        let km = hasExplicitRelayKm ? explicitKm : 0;
        if (!hasExplicitRelayKm && amp > 0) {
            const prefs = loadCalcPrefs();
            const baseUgVec = prefs.stationUg !== false ? getStationExitUgVector(DEFAULT_STATION_UG_METERS) : null;
            km = solveUniformDistanceKmFromAmp(amp, faultType, prefs.cableKey, prefs.sourceKey, 0, baseUgVec, prefs.busKv || DEFAULT_BUS_KV, 1.0).km || 1.0;
        }
        if (km <= 0 && (!amp || amp <= 0)) {
            return window.showToast?.('⚠️ กรุณากรอกกระแส A, B, C, G หรือระยะทาง (กม.) ก่อนกดดูจุดบนผัง');
        }

        const rawGpsTxt = (document.getElementById('gpsInput')?.value || '').trim();
        let reporterCoords = typeof window.deepParseCoords === 'function' ? window.deepParseCoords(rawGpsTxt) : null;
        if (!reporterCoords && rawGpsTxt && SHORT_URL_REGEX.test(rawGpsTxt) && typeof window.resolveGoogleShortLinkUniversal === 'function') {
            window.showToast?.('⏳ กำลังแปลงลิงก์สั้น Google Maps...');
            try {
                reporterCoords = await Promise.race([
                    window.resolveGoogleShortLinkUniversal(rawGpsTxt),
                    new Promise((resolve) => setTimeout(() => resolve(null), 2200))
                ]);
            } catch (e) {}
        }

        const pkt = {
            type: 'SCADA_LOCATE_FAULT_DISTANCE',
            feeder: document.getElementById('circuitSelect')?.value || '',
            deviceHint: document.getElementById('deviceInput')?.value || '',
            isolateHint: document.getElementById('disconnectDeviceInput')?.value || '',
            stationHint: document.getElementById('stationValue')?.value || '',
            faultAmp: amp > 0 ? amp : 0,
            faultType,
            tripMode: autoExtracted.tripMode,
            distanceKm: km,
            hasExplicitRelayKm,
            reporterCoords,
            ts: Date.now()
        };
        try { localStorage.setItem(FAULT_PKT_KEY, JSON.stringify(pkt)); } catch (e) {}
        if (typeof window.openScadaDiagramWorkspace === 'function') window.openScadaDiagramWorkspace();
        else window.open('page2.html?tab=map', '_blank');

        setTimeout(() => {
            const ifr = document.getElementById('leftBrowserIframe');
            const sendToFrame = () => { try { faultBc?.postMessage(pkt); } catch (e) {} try { ifr?.contentWindow?.postMessage(pkt, '*'); } catch (e) {} };
            if (ifr) {
                if (ifr.__faultLoadHandler) ifr.removeEventListener('load', ifr.__faultLoadHandler);
                ifr.__faultLoadHandler = () => setTimeout(sendToFrame, 250);
                ifr.addEventListener('load', ifr.__faultLoadHandler, { once: true });
            }
            sendToFrame();
        }, 420);
    }

    function syncAuthScopeState() {
        const curScope = getCurrentScopeKey();
        let isLogged = false;
        try { isLogged = localStorage.getItem('elec_app_logged_in') === 'true'; } catch (e) {}
        const scopeChanged = Boolean(lastActiveScopeKey && curScope !== lastActiveScopeKey);
        const loginChanged = (isLogged !== lastKnownLoggedState);

        if (!isLogged || scopeChanged) {
            excludedNotPassIds.clear();
            renderExcludedNotPassChips();
            clearFaultLocatorOverlay();
            if (!isLogged && panelOpen) toggleScadaFaultLocatorPanel(false);
        }
        lastActiveScopeKey = curScope;
        lastKnownLoggedState = isLogged;

        if (isLogged) {
            if (scopeChanged || loginChanged) pullCloudCalibIntoLocal();
            const sel = document.getElementById('scadaFaultSourceSelect');
            if (panelOpen && (scopeChanged || loginChanged || !sel?.options?.length)) {
                populateFaultSourceDropdown();
            }
            checkPendingFaultPacket();
        }
    }

    function hookRoleChangeCleanup() {
        if (typeof window.__onScadaRoleUpdated === 'function' && !window.__onScadaRoleUpdated.__faultLocatorHooked) {
            const origRoleUpd = window.__onScadaRoleUpdated;
            window.__onScadaRoleUpdated = Object.assign(function () {
                const ret = origRoleUpd.apply(this, arguments);
                syncAuthScopeState();
                return ret;
            }, { __faultLocatorHooked: true });
        }
    }

    window.addEventListener('message', (ev) => handleIncomingLocatorMessage(ev?.data));
    if (faultBc) faultBc.onmessage = (ev) => handleIncomingLocatorMessage(ev?.data);
    window.PeaCore?.onRealtimeChange?.((keys) => {
        if (!Array.isArray(keys)) return;
        if (keys.includes(STORAGE_KEY_TECH_LOC)) pullCloudCalibIntoLocal();
        if (panelOpen && (keys.includes(STORAGE_KEY_LABELS) || keys.includes(STORAGE_KEY_DELETED))) {
            populateFaultSourceDropdown();
        }
    });
    window.addEventListener('storage', (ev) => {
        if (ev?.key === STORAGE_KEY_TECH_LOC) pullCloudCalibIntoLocal();
        if (panelOpen && (ev?.key === STORAGE_KEY_LABELS || ev?.key === STORAGE_KEY_DELETED)) {
            populateFaultSourceDropdown();
        }
    });

    Object.assign(window, {
        toggleScadaFaultLocatorPanel, executeFaultDistanceSearch, clearFaultLocatorOverlay,
        resetFaultLocatorInputs, clearQuickFaultLocatorFromMainForm,
        zoomToFaultCandidate, navigateToFaultCandidate, openFaultStreetView,
        buildFaultLocatorReportText, copyFaultLocatorReport, shareFaultLocatorReportToLine,
        triggerFaultLocatorFromMainForm, refreshFaultSourceOptions, onQuickFaultKmBarInput,
        onFaultAmpParamsChanged, onFaultKmManualInput, onFaultFilterPinsChanged, onFaultConstraintChanged,
        addFaultExcludedNotPassPin, removeFaultExcludedNotPassPin, clearAllFaultExcludedPins,
        openFaultCalibrateModal, saveFaultFeederCalibration, clearFaultFeederCalibration,
        syncMainFormFaultCurrentsToQuickBar
    });

    function initFaultLocatorModule() {
        lastActiveScopeKey = getCurrentScopeKey();
        try { lastKnownLoggedState = localStorage.getItem('elec_app_logged_in') === 'true'; } catch (e) {}
        pullCloudCalibIntoLocal();
        injectFaultLocatorStyles(); hookLeafletInstance(); hookRoleChangeCleanup(); injectIndexTab1QuickLocatorBar();
        if (document.getElementById('techMainApp')) {
            if (!injectPage2ToolbarLocatorUI()) {
                const obs = new MutationObserver(() => { hookLeafletInstance(); hookRoleChangeCleanup(); if (injectPage2ToolbarLocatorUI()) obs.disconnect(); });
                obs.observe(document.getElementById('techMainApp'), { childList: true, subtree: true });
            }
            setInterval(() => { hookLeafletInstance(); hookRoleChangeCleanup(); syncAuthScopeState(); }, 2500);
            if (lastKnownLoggedState) checkPendingFaultPacket();
        }
    }

    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', initFaultLocatorModule);
    else initFaultLocatorModule();
})();
// ==================== จบไฟล์ scada-fault-locator.js (v3.5) ====================