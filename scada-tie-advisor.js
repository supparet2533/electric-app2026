// ============================================================================
// 🔀⚡ PEA SMART GRID — AUTO TIE-SWITCH & ISOLATION ADVISOR v1.2 (scada-tie-advisor.js)
// วิเคราะห์แผนปลดกั้นโซนสายเสีย (หัว-ท้าย) + ค้นหาสวิตช์พ่วง (Tie Switch) จ่ายไฟคืนอัตโนมัติ
// รองรับล็อกนิรภัยป้าย LOTO, สายปลด (e.off), ประเมินโหลดหม้อแปลง (kVA/A) & จำลองผลบนผัง
// ============================================================================
(function () {
    'use strict';

    const STORAGE_KEY_LABELS = 'elec_labeled_places_list';
    const STORAGE_KEY_DELETED = 'elec_deleted_labeled_places_map';
    const TX_STORAGE_KEY = 'elec_tx_load_records_v1';

    const SOURCE_PIN_TYPES = new Set(['CB', 'RC', 'GEN']);
    const ISOLATING_SW_TYPES = new Set(['CB', 'RC', 'VB', 'VS', 'VSC', 'S', 'DF']);
    const TIE_CAPABLE_TYPES = new Set(['VB', 'VS', 'VSC', 'S', 'RC', 'CB']);
    const DEFAULT_BUS_KV = 22.6;

    const escHtml = (s) => String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    let capturedMap = null;
    let tieLayerGroup = null;
    let panelOpen = false;
    let isPickingOnMap = false;
    let mapPickCleanupFn = null;
    let selectedFaultEdgeKey = '';
    let lastAdvisorPlan = null;
    let selectedOptionByIsland = {}; // islandIdx -> optionIdx
    let preSimBackupJson = null;
    let lastActiveScopeKey = '';

    // ========================================================================
    // 1. ระบบเชื่อมแผนที่ Leaflet, สิทธิ์สาขา และการคัดลอกข้อความลง LINE PC
    // ========================================================================
    function injectTieAdvisorStyles() {
        if (document.getElementById('peaScadaTieAdvisorCss') || !document.head) return;
        const st = document.createElement('style');
        st.id = 'peaScadaTieAdvisorCss';
        st.textContent = `
            @keyframes peaTiePulse { 0% { transform: scale(0.88); opacity: 0.95; } 70%, 100% { transform: scale(1.65); opacity: 0; } }
            #labeledInteractiveMap.pea-tie-pick-cursor { cursor: crosshair !important; }
            #labeledInteractiveMap.scada-draw-cursor .leaflet-scadaTieAdvisorPane-pane *,
            #labeledInteractiveMap.scada-move-wire-active .leaflet-scadaTieAdvisorPane-pane *,
            #labeledInteractiveMap.scada-move-pin-active .leaflet-scadaTieAdvisorPane-pane * { pointer-events: none !important; }
        `;
        document.head.appendChild(st);
    }

    function attachMapInstance(mapObj) {
        const container = mapObj?.getContainer?.();
        if (!mapObj || container?.id !== 'labeledInteractiveMap') return false;
        if (capturedMap === mapObj && tieLayerGroup && capturedMap.hasLayer?.(tieLayerGroup)) return true;
        capturedMap = mapObj;
        if (!capturedMap.getPane('scadaTieAdvisorPane')) {
            const p = capturedMap.createPane('scadaTieAdvisorPane');
            p.style.zIndex = '636';
        }
        tieLayerGroup = L.layerGroup().addTo(capturedMap);
        return true;
    }

    function tryDiscoverMap() {
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

    function hookLeafletMap() {
        if (typeof window.L === 'undefined' || !L.Map) return;
        if (!L.Map.__peaTieAdvisorHooked) {
            L.Map.__peaTieAdvisorHooked = true;
            L.Map.addInitHook(function () { setTimeout(() => attachMapInstance(this), 0); });
            ['invalidateSize', 'setView', 'fitBounds'].forEach((fn) => {
                const orig = L.Map.prototype[fn];
                if (typeof orig !== 'function' || orig.__peaTieWrapped) return;
                const wrapped = function () {
                    attachMapInstance(this);
                    return orig.apply(this, arguments);
                };
                wrapped.__peaTieWrapped = true;
                L.Map.prototype[fn] = wrapped;
            });
        }
        tryDiscoverMap();
    }

    function haversineKm(lat1, lon1, lat2, lon2) {
        if (typeof window.calcHaversineKm === 'function') return window.calcHaversineKm(lat1, lon1, lat2, lon2);
        const R = 6371.0088, toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    function normGrp(raw) {
        if (typeof window.normalizePeaGroupName === 'function') return window.normalizePeaGroupName(raw) || '';
        let g = String(raw || '').trim().replace(/\s+/g, ' ');
        g = g.replace(/^(กฟ[ก-ฮ]{1,2})\.\s+/, '$1.').replace(/^(กฟ[สฟจตอยภผกนฉ])\s+/, '$1.').replace(/^(กฟ[สฟจตอยภผกนฉ])(?![.\s]|[ก-ฮ]\.|$)/, '$1.');
        return g.trim();
    }

    function getCurrentScopeKey() {
        let curGrp = '';
        try {
            curGrp = (typeof window.getCurrentUserGroup === 'function' ? window.getCurrentUserGroup() : '') ||
                     localStorage.getItem('elec_app_current_group') || '';
        } catch (e) {}
        const isAdminAll = typeof window.isCurrentUserAdmin === 'function' && window.isCurrentUserAdmin() && !normGrp(curGrp);
        return isAdminAll ? '__ADMIN_ALL__' : (normGrp(curGrp) || 'กฟส.บึง');
    }

    function getVisiblePins(overrideRawStr = null) {
        let rawPins = [], delMap = {};
        try { rawPins = JSON.parse(overrideRawStr ?? (localStorage.getItem(STORAGE_KEY_LABELS) || '[]')); } catch (e) {}
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

    function getLiveCommittedLotoMap() {
        const lotoMap = new Map();
        try {
            const rawStr = window.PeaCore?.rawStorageGet
                ? window.PeaCore.rawStorageGet(STORAGE_KEY_LABELS)
                : localStorage.getItem(STORAGE_KEY_LABELS);
            const list = JSON.parse(rawStr || '[]');
            (Array.isArray(list) ? list : []).forEach((p) => {
                if (p?.id && p.scadaNode?.loto && String(p.scadaNode.loto).trim()) {
                    lotoMap.set(p.id, {
                        loto: String(p.scadaNode.loto).trim(),
                        lotoBy: String(p.scadaNode.lotoBy || '').trim()
                    });
                }
            });
        } catch (e) {}
        return lotoMap;
    }

    function loadTxLoadMapByPeaNo() {
        const map = new Map();
        try {
            const list = JSON.parse(localStorage.getItem(TX_STORAGE_KEY) || '[]');
            const scopeKey = getCurrentScopeKey();
            (Array.isArray(list) ? list : []).forEach((r) => {
                if (!r || r.deleted || !r.peaNo) return;
                if (scopeKey !== '__ADMIN_ALL__' && (normGrp(r.ownerGroup) || 'กฟส.บึง') !== scopeKey) return;
                const cleanPea = String(r.peaNo).trim();
                if (!map.has(cleanPea)) map.set(cleanPea, r);
            });
        } catch (e) {}
        return map;
    }

    function copyTextWithBtnFeedback(text, toastMsg, btnEl = null) {
        const done = () => {
            window.showToast?.(toastMsg);
            if (btnEl && btnEl.tagName === 'BUTTON') {
                if (!btnEl.dataset.origHtml) btnEl.dataset.origHtml = btnEl.innerHTML;
                btnEl.innerHTML = '✅ คัดลอกแล้ว!';
                clearTimeout(btnEl.__cpTimer);
                btnEl.__cpTimer = setTimeout(() => {
                    if (btnEl.dataset.origHtml) btnEl.innerHTML = btnEl.dataset.origHtml;
                }, 1700);
            }
        };
        const fallback = () => {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try { document.execCommand('copy'); done(); } catch (e) {}
            document.body.removeChild(ta);
        };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done).catch(fallback);
        else fallback();
    }

    // ========================================================================
    // 2. สร้างโครงข่ายกราฟไฟฟ้า 22kV, แยกแหล่งจ่ายต้นทาง และประเมินโหลดหม้อแปลง
    // ========================================================================
    function getPinEquipType(pin) {
        if (!pin) return 'PIN';
        const explicit = String(pin.scadaNode?.t || 'PIN').toUpperCase();
        if (explicit !== 'PIN') return explicit;
        const nm = String(pin.name || '');
        if (/\(\s*CB\b/i.test(nm)) return 'CB';
        if (/\(\s*RC\b/i.test(nm)) return 'RC';
        return 'PIN';
    }

    function isPinIsolatingSwitch(pin) {
        return ISOLATING_SW_TYPES.has(getPinEquipType(pin));
    }

    function isPinOpenSwitch(pin) {
        const t = getPinEquipType(pin);
        return (ISOLATING_SW_TYPES.has(t) || t === 'GEN') && String(pin?.scadaNode?.st || 'C').toUpperCase() === 'O';
    }

    function hasPinLoto(pin, liveLotoMap = null) {
        if (pin?.scadaNode?.loto && String(pin.scadaNode.loto).trim()) return true;
        return Boolean(liveLotoMap && pin?.id && liveLotoMap.has(pin.id));
    }

    function getPinLotoMeta(pin, liveLotoMap = null) {
        if (pin?.scadaNode?.loto && String(pin.scadaNode.loto).trim()) {
            return {
                reason: String(pin.scadaNode.loto).trim(),
                by: String(pin.scadaNode.lotoBy || '').trim()
            };
        }
        const live = liveLotoMap?.get(pin?.id);
        return { reason: live?.loto || 'ติดป้ายห้ามสับไฟ', by: live?.lotoBy || '' };
    }

    function isNodeTTap(pin, allPins) {
        if (!pin) return false;
        const t = getPinEquipType(pin);
        if (t !== 'TAP' && t !== 'PIN') return false;
        if (t === 'TAP' || pin.isTTap === true) return true;
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

    function parsePinTransformerLoad(pin, txRecordMap) {
        if (!pin) return null;
        const eqT = getPinEquipType(pin);
        if (SOURCE_PIN_TYPES.has(eqT) || ['VB', 'VS', 'VSC', 'S'].includes(eqT)) return null;
        const txt = `${pin.name || ''} ${pin.note || ''}`;
        const mPea = txt.match(/\b(\d{2}-\d{5,7})\b/);
        const mKva = txt.match(/\b(30|50|75|100|125|160|200|250|315|400|500|630|800|1000|1250|1600|2000)\s*(?:kva|k\b)/i);
        const isNamedTx = eqT === 'TR' || /หม้อแปลง|\bTR\b/i.test(txt);
        if (!mPea && !mKva && !isNamedTx) return null;

        const peaNo = mPea ? mPea[1] : '';
        const txRec = peaNo ? txRecordMap.get(peaNo) : null;
        const ratedKva = txRec?.kva ? Number(txRec.kva) : (mKva ? Number(mKva[1]) : 100);
        let demandKva = ratedKva * 0.55;
        if (txRec?.totals) {
            const sumLtAmp = (Number(txRec.totals.sumA) || 0) + (Number(txRec.totals.sumB) || 0) + (Number(txRec.totals.sumC) || 0);
            if (sumLtAmp > 0) demandKva = (sumLtAmp * 230) / 1000;
        }
        return { peaNo, ratedKva, demandKva, measured: Boolean(txRec) };
    }

    // คัดแยกหมุดต้นทางจ่ายไฟหลัก (CB, GEN, เบรกเกอร์สถานี F-xx / S-01 หรือ RC ต้นสาย) ออกจาก RC ลูกข่ายกลางสาย
    function detectRootPowerSourceIds(pins, pinMap, adj, edgesMap) {
        const rootIds = new Set();
        const busHubIds = new Set();

        pins.forEach((p) => {
            const t = getPinEquipType(p);
            if (t === 'GEN' || /^(?:สฟฟ\.?|สถานีไฟฟ้า)|busbar|\bbus\b/i.test(String(p.name || '').trim())) {
                busHubIds.add(p.id);
            }
        });

        // รอบที่ 1: หมุด CB, GEN หรือ RC ที่เป็นเบรกเกอร์หน้าสถานีชัดเจน
        pins.forEach((p) => {
            const t = getPinEquipType(p);
            if (t === 'CB' || t === 'GEN') {
                rootIds.add(p.id);
                return;
            }
            if (t === 'RC') {
                const nm = String(p.name || '').trim();
                const closedNbs = (adj.get(p.id) || []).filter((nb) => !edgesMap.get(nb.edgeKey)?.isOpenEdge);
                const nearHub = closedNbs.some((nb) => busHubIds.has(nb.toId) && nb.lenKm <= 0.8);
                const isSubBreakerName = /\b[A-Z]{2,4}\d{1,2}(?:CB|F)-0*\d+\b/i.test(nm) ||
                                         /\b[A-Z]{2,4}\d{1,2}S-0*1\b/i.test(nm) ||
                                         /\(\s*CB\b|สถานี|สฟฟ/i.test(nm);
                if (isSubBreakerName || nearHub) {
                    rootIds.add(p.id);
                }
            }
        });

        // รอบที่ 2: วงจรที่ยังไม่มีเบรกเกอร์ต้นทาง ให้เลือก RC ต้นสายเพียง 1 ตัวต่อวงจร (ไม่ดึง RC ปลายสายซ้อน)
        const coveredFeeders = new Set();
        rootIds.forEach((id) => {
            const fd = extractPinFeederCode(pinMap.get(id));
            if (fd) coveredFeeders.add(fd);
        });

        const rcByFeeder = new Map();
        pins.forEach((p) => {
            if (getPinEquipType(p) !== 'RC' || rootIds.has(p.id)) return;
            const fd = extractPinFeederCode(p);
            if (!fd || coveredFeeders.has(fd)) return;
            if (!rcByFeeder.has(fd)) rcByFeeder.set(fd, []);
            rcByFeeder.get(fd).push(p);
        });
        rcByFeeder.forEach((rcList, fd) => {
            rcList.sort((a, b) => {
                const degA = (adj.get(a.id) || []).filter((nb) => !edgesMap.get(nb.edgeKey)?.isOpenEdge).length;
                const degB = (adj.get(b.id) || []).filter((nb) => !edgesMap.get(nb.edgeKey)?.isOpenEdge).length;
                return ((degA <= 1 ? 0 : 1) - (degB <= 1 ? 0 : 1)) || String(a.name || '').localeCompare(String(b.name || ''), 'th');
            });
            rootIds.add(rcList[0].id);
            coveredFeeders.add(fd);
        });

        // รอบที่ 3: กันเหนียวกรณีกลุ่มสายที่เชื่อมถึงกันไม่ระบุรหัส fd เลย
        const visComp = new Set();
        pins.forEach((p) => {
            if (visComp.has(p.id) || (adj.get(p.id) || []).length === 0) return;
            const comp = [];
            const q = [p.id];
            visComp.add(p.id);
            while (q.length > 0) {
                const cur = q.shift();
                comp.push(cur);
                (adj.get(cur) || []).forEach((nb) => {
                    if (edgesMap.get(nb.edgeKey)?.isOpenEdge || visComp.has(nb.toId)) return;
                    visComp.add(nb.toId);
                    q.push(nb.toId);
                });
            }
            if (!comp.some((id) => rootIds.has(id))) {
                const rcs = comp.filter((id) => getPinEquipType(pinMap.get(id)) === 'RC').sort((a, b) => {
                    const degA = (adj.get(a) || []).filter((nb) => !edgesMap.get(nb.edgeKey)?.isOpenEdge).length;
                    const degB = (adj.get(b) || []).filter((nb) => !edgesMap.get(nb.edgeKey)?.isOpenEdge).length;
                    return (degA <= 1 ? 0 : 1) - (degB <= 1 ? 0 : 1);
                });
                if (rcs[0]) rootIds.add(rcs[0]);
            }
        });

        return rootIds;
    }

    function buildNetworkTopology(overridePinsStr = null) {
        const pins = getVisiblePins(overridePinsStr);
        const pinMap = new Map(pins.map((p) => [p.id, p]));
        const adj = new Map();
        const edgesMap = new Map();
        pins.forEach((p) => adj.set(p.id, []));

        pins.forEach((p) => {
            (p.scadaLines || []).forEach((e, idx) => {
                const dst = pinMap.get(e?.to);
                if (!dst || dst.id === p.id) return;
                const fwdPts = [[Number(p.lat), Number(p.lon)], ...(e.w || []).map((w) => [Number(w[0]), Number(w[1])]), [Number(dst.lat), Number(dst.lon)]];
                let lenKm = 0;
                for (let i = 0; i < fwdPts.length - 1; i++) lenKm += haversineKm(fwdPts[i][0], fwdPts[i][1], fwdPts[i + 1][0], fwdPts[i + 1][1]);
                if (lenKm <= 0) return;

                const idA = p.id <= dst.id ? p.id : dst.id;
                const idB = p.id <= dst.id ? dst.id : p.id;
                const orderedPts = p.id <= dst.id ? fwdPts : [...fwdPts].reverse();
                const geomSig = orderedPts.map((pt) => `${pt[0].toFixed(5)},${pt[1].toFixed(5)}`).join(';');
                const edgeKey = `${idA}__${idB}__${geomSig}`;
                const isOpenEdge = Boolean(e.off || e.manualNO === true || String(e.st || '').toUpperCase() === 'O');
                const fdCode = String(e.fd || '').trim().toUpperCase();

                if (edgesMap.has(edgeKey)) {
                    const ex = edgesMap.get(edgeKey);
                    if (isOpenEdge) ex.isOpenEdge = true;
                    if (!ex.fd && fdCode) ex.fd = fdCode;
                    ex.rawRefs.push({ ownerId: p.id, lineIdx: idx });
                    return;
                }

                const rec = {
                    edgeKey,
                    uId: p.id,
                    vId: dst.id,
                    pts: fwdPts,
                    lenKm,
                    isOpenEdge,
                    fd: fdCode || extractPinFeederCode(p) || extractPinFeederCode(dst),
                    spec: e.lb || (e.st === 'ug' ? 'UG 240' : '22kV'),
                    rawRefs: [{ ownerId: p.id, lineIdx: idx }]
                };
                edgesMap.set(edgeKey, rec);
                adj.get(p.id).push({ toId: dst.id, edgeKey, lenKm, pts: fwdPts });
                adj.get(dst.id).push({ toId: p.id, edgeKey, lenKm, pts: [...fwdPts].reverse() });
            });
        });

        const rootSourceIds = detectRootPowerSourceIds(pins, pinMap, adj, edgesMap);
        return { pins, pinMap, adj, edges: Array.from(edgesMap.values()), edgesMap, rootSourceIds };
    }

    function pointToSegmentDistKm(pLat, pLon, aLat, aLon, bLat, bLon) {
        const cosLat = Math.cos(((aLat + bLat) * 0.5 * Math.PI) / 180);
        const px = (pLon - aLon) * cosLat, py = pLat - aLat;
        const bx = (bLon - aLon) * cosLat, by = bLat - aLat;
        const lenSq = bx * bx + by * by;
        const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, (px * bx + py * by) / lenSq)) : 0;
        const projLat = aLat + t * (bLat - aLat);
        const projLon = aLon + t * (bLon - aLon);
        return { distKm: haversineKm(pLat, pLon, projLat, projLon), lat: projLat, lon: projLon };
    }

    function findClosestEdgeToCoord(lat, lon, edges, maxDistKm = 0.30) {
        let bestEdge = null, bestDist = maxDistKm, bestPt = null;
        edges.forEach((er) => {
            for (let i = 0; i < er.pts.length - 1; i++) {
                const hit = pointToSegmentDistKm(lat, lon, er.pts[i][0], er.pts[i][1], er.pts[i + 1][0], er.pts[i + 1][1]);
                if (hit.distKm < bestDist) {
                    bestDist = hit.distKm;
                    bestEdge = er;
                    bestPt = [Number(hit.lat.toFixed(6)), Number(hit.lon.toFixed(6))];
                }
            }
        });
        return bestEdge ? { edge: bestEdge, point: bestPt, distKm: bestDist } : null;
    }

    function computeEnergizedStateMap(pins, pinMap, adj, edgesMap, rootSourceIds, forcedOpenPinIds, blockedEdgeKeys, faultedNodeIds) {
        const energized = new Map();
        const pq = [];

        const activeSources = pins.filter((p) => {
            if (!rootSourceIds.has(p.id)) return false;
            if (forcedOpenPinIds.has(p.id) || faultedNodeIds.has(p.id) || isPinOpenSwitch(p)) return false;
            return true;
        }).sort((a, b) => (getPinEquipType(a) === 'GEN' ? 1 : 0) - (getPinEquipType(b) === 'GEN' ? 1 : 0));

        activeSources.forEach((src) => {
            const fd = extractPinFeederCode(src) || src.name;
            energized.set(src.id, { sourceId: src.id, sourceName: src.name, feeder: fd, distKm: 0 });
            pq.push({ id: src.id, d: 0, prio: getPinEquipType(src) === 'GEN' ? 1 : 0 });
        });

        const vis = new Set();
        while (pq.length > 0) {
            pq.sort((a, b) => (a.prio - b.prio) || (a.d - b.d));
            const cur = pq.shift();
            if (vis.has(cur.id)) continue;
            vis.add(cur.id);

            const curInfo = energized.get(cur.id);
            const curPin = pinMap.get(cur.id);
            if (forcedOpenPinIds.has(cur.id) || isPinOpenSwitch(curPin)) continue;

            (adj.get(cur.id) || []).forEach((nb) => {
                if (blockedEdgeKeys.has(nb.edgeKey) || faultedNodeIds.has(nb.toId)) return;
                const edgeObj = edgesMap.get(nb.edgeKey);
                if (!edgeObj || edgeObj.isOpenEdge) return;
                const nbPin = pinMap.get(nb.toId);
                if (!nbPin || forcedOpenPinIds.has(nb.toId) || isPinOpenSwitch(nbPin)) return;
                if (rootSourceIds.has(nb.toId) && energized.has(nb.toId)) return;

                const nd = cur.d + nb.lenKm;
                const ex = energized.get(nb.toId);
                if (!ex || nd < ex.distKm - 1e-6) {
                    const nextFd = extractPinFeederCode(nbPin) || edgeObj.fd || curInfo.feeder;
                    energized.set(nb.toId, {
                        sourceId: curInfo.sourceId,
                        sourceName: curInfo.sourceName,
                        feeder: nextFd,
                        distKm: nd
                    });
                    pq.push({ id: nb.toId, d: nd, prio: cur.prio });
                }
            });
        }
        return energized;
    }

    // ========================================================================
    // 3. สมองกลวางแผนสับ-ปลด (FLISR: Fault Isolation & Tie Restoration Engine)
    // ========================================================================
    function analyzeSwitchingPlanForTarget({ faultEdgeKey = '', faultPinId = '', faultPoint = null, faultAtSwitchPole = false }) {
        const baseTopo = buildNetworkTopology(preSimBackupJson);
        const { pins, pinMap, adj, edges, edgesMap, rootSourceIds } = baseTopo;
        if (!edges.length) return { error: 'ยังไม่มีเส้นสายไฟในผัง SCADA สำหรับวิเคราะห์สับพ่วง' };

        const liveLotoMap = getLiveCommittedLotoMap();
        const txRecordMap = loadTxLoadMapByPeaNo();
        const baseEnergized = computeEnergizedStateMap(pins, pinMap, adj, edgesMap, rootSourceIds, new Set(), new Set(), new Set());

        let seedEdges = [];
        let seedPassThroughPinId = '';
        let targetTitle = '';
        let markerCoord = faultPoint;

        if (faultEdgeKey && edgesMap.has(faultEdgeKey)) {
            const er = edgesMap.get(faultEdgeKey);
            seedEdges.push(er);
            const uP = pinMap.get(er.uId), vP = pinMap.get(er.vId);
            targetTitle = `สายช่วง ${uP?.name || '-'} ↔ ${vP?.name || '-'}`;
            if (!markerCoord) {
                const mid = er.pts[Math.floor(er.pts.length / 2)] || er.pts[0];
                markerCoord = [mid[0], mid[1]];
            }
        } else if (faultPinId && pinMap.has(faultPinId)) {
            const fp = pinMap.get(faultPinId);
            markerCoord = markerCoord || [Number(fp.lat), Number(fp.lon)];
            if (isPinIsolatingSwitch(fp) && !faultAtSwitchPole) {
                const fpDist = baseEnergized.get(fp.id)?.distKm ?? 0;
                const downNbs = (adj.get(fp.id) || []).filter((nb) => {
                    const eObj = edgesMap.get(nb.edgeKey);
                    if (!eObj || eObj.isOpenEdge) return false;
                    const nbD = baseEnergized.get(nb.toId)?.distKm ?? Infinity;
                    return nbD >= fpDist - 0.01 && !rootSourceIds.has(nb.toId);
                });
                const pickedNbs = downNbs.length > 0 ? downNbs : (adj.get(fp.id) || []).filter((nb) => !edgesMap.get(nb.edgeKey)?.isOpenEdge);
                seedEdges = pickedNbs.map((nb) => edgesMap.get(nb.edgeKey)).filter(Boolean);
                targetTitle = `โซนสายด้านหลัง ${fp.name}`;
            } else {
                seedPassThroughPinId = fp.id;
                seedEdges = (adj.get(fp.id) || []).map((nb) => edgesMap.get(nb.edgeKey)).filter((e) => e && !e.isOpenEdge);
                targetTitle = `ชำรุดที่จุด ${fp.name}`;
            }
        }

        if (!seedEdges.length) {
            return { error: 'ไม่พบช่วงสายที่เชื่อมกับจุดที่เลือก กรุณาแตะเลือกเส้นสายบนแผนที่' };
        }

        // ขั้นที่ 1: ขยายหาขอบเขตโซนสายเสียจนชนสวิตช์ปลดกั้นทุกด้าน (กั้นไม่ให้ข้าม GEN หน้าสถานี)
        const faultedEdgeKeys = new Set();
        const faultedInteriorNodes = new Set();
        const boundarySwitchIds = new Set();
        const alreadyOpenBoundaryIds = new Set();
        const qNodes = [];

        if (seedPassThroughPinId) faultedInteriorNodes.add(seedPassThroughPinId);

        const inspectEndpoint = (pid) => {
            const p = pinMap.get(pid);
            if (!p || getPinEquipType(p) === 'GEN') return;
            if (pid !== seedPassThroughPinId && isPinOpenSwitch(p)) {
                alreadyOpenBoundaryIds.add(pid);
                return;
            }
            if (pid !== seedPassThroughPinId && isPinIsolatingSwitch(p)) {
                boundarySwitchIds.add(pid);
                return;
            }
            if (!faultedInteriorNodes.has(pid)) {
                faultedInteriorNodes.add(pid);
                qNodes.push(pid);
            }
        };

        seedEdges.forEach((se) => {
            faultedEdgeKeys.add(se.edgeKey);
            inspectEndpoint(se.uId);
            inspectEndpoint(se.vId);
        });

        while (qNodes.length > 0) {
            const curId = qNodes.shift();
            (adj.get(curId) || []).forEach((nb) => {
                if (faultedEdgeKeys.has(nb.edgeKey)) return;
                const eObj = edgesMap.get(nb.edgeKey);
                if (!eObj || eObj.isOpenEdge) return;
                faultedEdgeKeys.add(nb.edgeKey);
                inspectEndpoint(nb.toId);
            });
        }

        let faultZoneTxCount = 0, faultZoneKva = 0;
        faultedInteriorNodes.forEach((nid) => {
            const tx = parsePinTransformerLoad(pinMap.get(nid), txRecordMap);
            if (tx) { faultZoneTxCount++; faultZoneKva += tx.ratedKva; }
        });

        // ขั้นที่ 2: จำลองปลดสวิตช์ขอบเขตทั้งหมดเพื่อแยกสวิตช์กั้นต้นทาง กับ สวิตช์กั้นท้ายทาง
        const postIsoEnergized = computeEnergizedStateMap(
            pins, pinMap, adj, edgesMap, rootSourceIds,
            boundarySwitchIds, faultedEdgeKeys, faultedInteriorNodes
        );

        const upstreamSwitches = [];
        const downstreamBoundarySet = new Set();
        const recloseSourceSwitches = [];
        const lotoBlockedSwitches = [];

        const addLotoBlocked = (pinObj, roleLabel) => {
            if (!pinObj || lotoBlockedSwitches.some((x) => x.id === pinObj.id)) return;
            const meta = getPinLotoMeta(pinObj, liveLotoMap);
            lotoBlockedSwitches.push({
                id: pinObj.id,
                name: pinObj.name,
                role: roleLabel,
                reason: meta.reason,
                by: meta.by
            });
        };

        boundarySwitchIds.forEach((swId) => {
            const swPin = pinMap.get(swId);
            if (!swPin) return;
            const hasLiveFeedSide = rootSourceIds.has(swId) || (adj.get(swId) || []).some((nb) => {
                if (faultedEdgeKeys.has(nb.edgeKey) || edgesMap.get(nb.edgeKey)?.isOpenEdge) return false;
                return postIsoEnergized.has(nb.toId);
            });

            if (hasLiveFeedSide) upstreamSwitches.push(swPin);
            else downstreamBoundarySet.add(swId);
        });

        // หากสวิตช์กั้นต้นทางถูกเปิด 'O' ไว้ก่อนแล้ว ให้แสดงยืนยันในรายการตรวจสอบด้วย
        if (upstreamSwitches.length === 0 && alreadyOpenBoundaryIds.size > 0) {
            alreadyOpenBoundaryIds.forEach((openSwId) => {
                const opPin = pinMap.get(openSwId);
                if (!opPin) return;
                const hasLiveSide = rootSourceIds.has(openSwId) || (adj.get(openSwId) || []).some((nb) => {
                    if (faultedEdgeKeys.has(nb.edgeKey) || edgesMap.get(nb.edgeKey)?.isOpenEdge) return false;
                    return postIsoEnergized.has(nb.toId);
                });
                if (hasLiveSide) upstreamSwitches.push(opPin);
            });
        } else {
            upstreamSwitches.forEach((upSw) => {
                if (rootSourceIds.has(upSw.id)) return;
                const visUp = new Set([upSw.id, ...Array.from(faultedInteriorNodes)]);
                const uq = [upSw.id];
                while (uq.length > 0) {
                    const cid = uq.shift();
                    (adj.get(cid) || []).forEach((nb) => {
                        if (faultedEdgeKeys.has(nb.edgeKey) || visUp.has(nb.toId)) return;
                        const eObj = edgesMap.get(nb.edgeKey);
                        if (!eObj || eObj.isOpenEdge) return;
                        visUp.add(nb.toId);
                        const np = pinMap.get(nb.toId);
                        if (!np) return;
                        if (rootSourceIds.has(np.id) && isPinOpenSwitch(np)) {
                            if (hasPinLoto(np, liveLotoMap)) addLotoBlocked(np, 'ต้นสาย');
                            else if (!recloseSourceSwitches.some((x) => x.id === np.id)) recloseSourceSwitches.push(np);
                        } else if (!isPinOpenSwitch(np)) {
                            uq.push(nb.toId);
                        }
                    });
                }
            });
        }

        // ขั้นที่ 3: ค้นหากลุ่มสายส่วนดีที่ไฟดับหลังปลดกั้น (รองรับทั้งกลุ่มหมุดและช่วงสายสั้นชนสวิตช์ Tie โดยตรง)
        const visitedHealthy = new Set();
        const visitedHealthyEdges = new Set();
        const restorableIslands = [];
        const deadEndSpurSummary = { txCount: 0, kva: 0, lineKm: 0, pinCount: 0 };

        const evaluateCandidateIsland = (islandNodes, islandEdges, borderingDownstreamSwIds, openSwitchPinCandidates, openEdgeKeyCandidates) => {
            islandEdges.forEach((ek) => visitedHealthyEdges.add(ek));
            let txCount = 0, ratedKva = 0, demandKva = 0, lineKm = 0;
            islandNodes.forEach((nid) => {
                const tx = parsePinTransformerLoad(pinMap.get(nid), txRecordMap);
                if (tx) { txCount++; ratedKva += tx.ratedKva; demandKva += tx.demandKva; }
            });
            islandEdges.forEach((ek) => { lineKm += edgesMap.get(ek)?.lenKm || 0; });
            const estAmp22kV = Number((demandKva / (Math.sqrt(3) * DEFAULT_BUS_KV)).toFixed(1));

            const validTieOptions = [];

            openSwitchPinCandidates.forEach((tieId) => {
                const tiePin = pinMap.get(tieId);
                if (!tiePin || !TIE_CAPABLE_TYPES.has(getPinEquipType(tiePin))) return;
                const tieNbs = adj.get(tieId) || [];
                // กฎนิรภัย: ห้ามสับสวิตช์ Tie ที่ต่อตรงเข้าโซนสายเสีย หรือติดป้ายห้ามสับไฟ (LOTO) เด็ดขาด
                const touchesFaultDirectly = tieNbs.some((nb) => faultedEdgeKeys.has(nb.edgeKey) || faultedInteriorNodes.has(nb.toId));
                if (touchesFaultDirectly) return;
                if (hasPinLoto(tiePin, liveLotoMap)) {
                    addLotoBlocked(tiePin, 'สวิตช์พ่วง');
                    return;
                }

                let bestFeedInfo = null;
                tieNbs.forEach((nb) => {
                    const eObj = edgesMap.get(nb.edgeKey);
                    if (!eObj || eObj.isOpenEdge) return;
                    const feed = postIsoEnergized.get(nb.toId);
                    if (feed && (!bestFeedInfo || feed.distKm + nb.lenKm < bestFeedInfo.totalDistKm)) {
                        bestFeedInfo = {
                            sourceId: feed.sourceId,
                            sourceName: feed.sourceName,
                            feeder: feed.feeder || extractPinFeederCode(pinMap.get(nb.toId)) || 'วงจรข้างเคียง',
                            totalDistKm: Number((feed.distKm + nb.lenKm).toFixed(2))
                        };
                    }
                });

                if (bestFeedInfo) {
                    validTieOptions.push({
                        mode: 'pin',
                        tieId: tiePin.id,
                        tieName: tiePin.name,
                        tieType: getPinEquipType(tiePin),
                        lat: Number(tiePin.lat),
                        lon: Number(tiePin.lon),
                        backupFeeder: bestFeedInfo.feeder,
                        backupSourceName: bestFeedInfo.sourceName,
                        backupDistKm: bestFeedInfo.totalDistKm
                    });
                }
            });

            openEdgeKeyCandidates.forEach((ek) => {
                const eObj = edgesMap.get(ek);
                if (!eObj) return;
                const uInSide = islandNodes.has(eObj.uId) || borderingDownstreamSwIds.has(eObj.uId);
                const deadEndId = uInSide ? eObj.uId : eObj.vId;
                const liveSideId = uInSide ? eObj.vId : eObj.uId;
                if (faultedInteriorNodes.has(liveSideId) || faultedInteriorNodes.has(deadEndId)) return;

                const deadPin = pinMap.get(deadEndId), livePin = pinMap.get(liveSideId);
                if (hasPinLoto(deadPin, liveLotoMap)) { addLotoBlocked(deadPin, 'จุดปลดสายพ่วง'); return; }
                if (hasPinLoto(livePin, liveLotoMap)) { addLotoBlocked(livePin, 'จุดปลดสายพ่วง'); return; }

                const feed = postIsoEnergized.get(liveSideId);
                if (!feed) return;
                const midPt = eObj.pts[Math.floor(eObj.pts.length / 2)] || [Number(deadPin.lat), Number(deadPin.lon)];
                validTieOptions.push({
                    mode: 'edge',
                    edgeKey: ek,
                    tieId: ek,
                    tieName: `จุดปลดสาย ${deadPin?.name || ''} ↔ ${livePin?.name || ''}`,
                    tieType: 'JUMP',
                    lat: Number(midPt[0]),
                    lon: Number(midPt[1]),
                    backupFeeder: feed.feeder || 'วงจรข้างเคียง',
                    backupSourceName: feed.sourceName,
                    backupDistKm: Number((feed.distKm + eObj.lenKm).toFixed(2))
                });
            });

            validTieOptions.sort((a, b) => a.backupDistKm - b.backupDistKm);

            const sampleNames = Array.from(islandNodes)
                .map((nid) => pinMap.get(nid))
                .filter((p) => p && !isNodeTTap(p, pins))
                .slice(0, 2)
                .map((p) => p.name);
            const fallbackSwName = Array.from(borderingDownstreamSwIds).map((id) => pinMap.get(id)?.name).filter(Boolean)[0] || '';
            const zoneLabel = sampleNames.length
                ? `โซน ${sampleNames.join(' - ')}`
                : (fallbackSwName ? `โซนท้ายสวิตช์ ${fallbackSwName}` : 'โซนปลายสายส่วนดี');

            if (validTieOptions.length > 0) {
                restorableIslands.push({
                    zoneLabel,
                    islandNodes,
                    islandEdges,
                    requiredDownstreamSwitches: Array.from(borderingDownstreamSwIds).map((id) => pinMap.get(id)).filter(Boolean),
                    tieOptions: validTieOptions,
                    txCount,
                    ratedKva,
                    estAmp22kV,
                    lineKm: Number(lineKm.toFixed(2))
                });
            } else {
                deadEndSpurSummary.pinCount += islandNodes.size;
                deadEndSpurSummary.txCount += txCount;
                deadEndSpurSummary.kva += ratedKva;
                deadEndSpurSummary.lineKm += lineKm;
            }
        };

        // 3.1 สำรวจกลุ่มสายส่วนดีที่มีหมุดภายในโซน
        pins.forEach((startPin) => {
            if (visitedHealthy.has(startPin.id)) return;
            if (faultedInteriorNodes.has(startPin.id) || boundarySwitchIds.has(startPin.id)) return;
            if (postIsoEnergized.has(startPin.id) || isPinOpenSwitch(startPin)) return;

            const incidentHealthyEdges = (adj.get(startPin.id) || []).filter((nb) => !faultedEdgeKeys.has(nb.edgeKey));
            if (incidentHealthyEdges.length === 0) return;

            const islandNodes = new Set([startPin.id]);
            const islandEdges = new Set();
            const borderingDownstreamSwIds = new Set();
            const openSwitchPinCandidates = new Set();
            const openEdgeKeyCandidates = new Set();
            const iq = [startPin.id];
            visitedHealthy.add(startPin.id);

            while (iq.length > 0) {
                const uid = iq.shift();
                (adj.get(uid) || []).forEach((nb) => {
                    if (faultedEdgeKeys.has(nb.edgeKey)) return;
                    const eObj = edgesMap.get(nb.edgeKey);
                    if (!eObj) return;

                    if (eObj.isOpenEdge) {
                        openEdgeKeyCandidates.add(nb.edgeKey);
                        return;
                    }
                    const nbPin = pinMap.get(nb.toId);
                    if (!nbPin) return;

                    if (boundarySwitchIds.has(nb.toId)) {
                        if (downstreamBoundarySet.has(nb.toId)) borderingDownstreamSwIds.add(nb.toId);
                        islandEdges.add(nb.edgeKey);
                        return;
                    }
                    if (isPinOpenSwitch(nbPin)) {
                        openSwitchPinCandidates.add(nb.toId);
                        islandEdges.add(nb.edgeKey);
                        return;
                    }
                    if (faultedInteriorNodes.has(nb.toId) || postIsoEnergized.has(nb.toId)) return;

                    islandEdges.add(nb.edgeKey);
                    if (!visitedHealthy.has(nb.toId)) {
                        visitedHealthy.add(nb.toId);
                        islandNodes.add(nb.toId);
                        iq.push(nb.toId);
                    }
                });
            }

            evaluateCandidateIsland(islandNodes, islandEdges, borderingDownstreamSwIds, openSwitchPinCandidates, openEdgeKeyCandidates);
        });

        // 3.2 สำรวจช่วงสายสั้นจากสวิตช์กั้นท้ายทางที่ลากชนหมุด Tie (O) โดยตรงแบบไม่มีหมุดคั่นกลาง
        downstreamBoundarySet.forEach((dswId) => {
            (adj.get(dswId) || []).forEach((nb) => {
                if (faultedEdgeKeys.has(nb.edgeKey) || visitedHealthyEdges.has(nb.edgeKey)) return;
                const eObj = edgesMap.get(nb.edgeKey);
                const nbPin = pinMap.get(nb.toId);
                if (!eObj || !nbPin) return;

                if (eObj.isOpenEdge) {
                    evaluateCandidateIsland(new Set(), new Set([nb.edgeKey]), new Set([dswId]), new Set(), new Set([nb.edgeKey]));
                } else if (isPinOpenSwitch(nbPin)) {
                    evaluateCandidateIsland(new Set(), new Set([nb.edgeKey]), new Set([dswId]), new Set([nb.toId]), new Set());
                }
            });
        });

        const faultPolylines = Array.from(faultedEdgeKeys).map((ek) => edgesMap.get(ek)?.pts).filter(Boolean);

        return {
            targetTitle,
            markerCoord,
            faultPolylines,
            faultZoneTxCount,
            faultZoneKva,
            upstreamSwitches,
            recloseSourceSwitches,
            lotoBlockedSwitches,
            restorableIslands,
            deadEndSpurSummary,
            rootSourceIds,
            edgesMap
        };
    }

    // ========================================================================
    // 4. วาดแผนผังสับ-ปลดบน Leaflet Map และระบบจำลองผล (1-Click Sim Preview)
    // ========================================================================
    function renderAdvisorMapOverlay(plan) {
        if (!tieLayerGroup || !capturedMap || !plan) return;
        tieLayerGroup.clearLayers();
        const bounds = [];

        if (plan.markerCoord) {
            bounds.push(plan.markerCoord);
            const faultIcon = L.divIcon({
                className: '',
                html: `<div style="position:relative;width:42px;height:42px;display:flex;align-items:center;justify-content:center;"><div style="position:absolute;inset:0;border-radius:9999px;background:rgba(244,63,94,0.38);border:2px solid #f43f5e;animation:peaTiePulse 1.15s infinite ease-out;"></div><div style="position:relative;z-index:2;background:#be123c;color:#fff;border:2px solid #fde047;border-radius:9999px;padding:1px 6px;font-size:10px;font-weight:900;white-space:nowrap;box-shadow:0 3px 10px rgba(0,0,0,0.6);">⚡จุดเสีย</div></div>`,
                iconSize: [42, 42], iconAnchor: [21, 21]
            });
            L.marker(plan.markerCoord, { icon: faultIcon, pane: 'scadaTieAdvisorPane' })
                .addTo(tieLayerGroup)
                .bindPopup(`<div style="font-family:'Prompt',sans-serif;" class="text-xs font-bold text-rose-700">⚡ ${escHtml(plan.targetTitle)}</div>`);
        }

        (plan.faultPolylines || []).forEach((pts) => {
            if (pts.length < 2) return;
            L.polyline(pts, { pane: 'scadaTieAdvisorPane', color: '#ef4444', weight: 8, opacity: 0.42, interactive: false }).addTo(tieLayerGroup);
            L.polyline(pts, { pane: 'scadaTieAdvisorPane', color: '#fef08a', weight: 2.5, dashArray: '5, 6', opacity: 0.95, interactive: false }).addTo(tieLayerGroup);
        });

        const addStepMarker = (pin, badgeTxt, bgHex, borderHex, roleDesc) => {
            const lat = Number(pin.lat), lon = Number(pin.lon);
            bounds.push([lat, lon]);
            const ic = L.divIcon({
                className: '',
                html: `<div style="background:${bgHex};color:#fff;border:2px solid ${borderHex};border-radius:10px;padding:2px 7px;font-family:'Prompt',sans-serif;font-size:10px;font-weight:900;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.55);transform:translate(-50%,-135%);">${escHtml(badgeTxt)}</div>`,
                iconSize: [0, 0], iconAnchor: [0, 0]
            });
            L.marker([lat, lon], { icon: ic, pane: 'scadaTieAdvisorPane' })
                .addTo(tieLayerGroup)
                .bindPopup(`<div style="font-family:'Prompt',sans-serif;min-width:205px;" class="text-xs space-y-1"><div class="font-extrabold text-slate-800">${escHtml(badgeTxt)} — ${escHtml(pin.name)}</div><div class="text-[11px] text-slate-600">${escHtml(roleDesc)}</div><a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving" target="_blank" rel="noopener" style="display:block;text-align:center;background:#2563eb;color:#fff;padding:4px 8px;border-radius:7px;font-weight:700;text-decoration:none;margin-top:4px;">🚗 นำทางไปสวิตช์นี้</a></div>`);
        };

        plan.upstreamSwitches.forEach((sw) => {
            const lbl = isPinOpenSwitch(sw) ? '🔴 กั้นต้นทาง (ปลดแล้ว)' : '🔴 ปลดกั้นต้นทาง';
            addStepMarker(sw, lbl, '#dc2626', '#fde047', 'ปลดแยกจุดเสียออกจากสายหลักด้านต้นทาง');
        });

        const drawnDownSw = new Set();
        plan.restorableIslands.forEach((isl, islIdx) => {
            isl.islandEdges.forEach((ek) => {
                const pts = plan.edgesMap.get(ek)?.pts;
                if (pts && pts.length >= 2) {
                    L.polyline(pts, { pane: 'scadaTieAdvisorPane', color: '#10b981', weight: 7, opacity: 0.42, interactive: false }).addTo(tieLayerGroup);
                }
            });
            isl.requiredDownstreamSwitches.forEach((dsw) => {
                if (drawnDownSw.has(dsw.id)) return;
                drawnDownSw.add(dsw.id);
                addStepMarker(dsw, '🔴 ปลดกั้นท้ายทาง', '#e11d48', '#fecdd3', 'ปลดกั้นท้ายโซนเสียก่อนรับไฟพ่วงย้อนกลับ');
            });

            const optIdx = selectedOptionByIsland[islIdx] || 0;
            const chosenTie = isl.tieOptions[optIdx] || isl.tieOptions[0];
            if (chosenTie) {
                bounds.push([chosenTie.lat, chosenTie.lon]);
                const tieIc = L.divIcon({
                    className: '',
                    html: `<div style="position:relative;display:inline-block;transform:translate(-50%,-135%);"><div style="background:#059669;color:#fff;border:2px solid #6ee7b7;border-radius:10px;padding:2px 8px;font-family:'Prompt',sans-serif;font-size:10.5px;font-weight:900;white-space:nowrap;box-shadow:0 4px 14px rgba(5,150,105,0.75);">🟢 สับพ่วง (${escHtml(chosenTie.backupFeeder)})</div></div>`,
                    iconSize: [0, 0], iconAnchor: [0, 0]
                });
                L.marker([chosenTie.lat, chosenTie.lon], { icon: tieIc, pane: 'scadaTieAdvisorPane' })
                    .addTo(tieLayerGroup)
                    .bindPopup(`<div style="font-family:'Prompt',sans-serif;min-width:215px;" class="text-xs space-y-1"><div class="font-extrabold text-emerald-700">🟢 สับพ่วง: ${escHtml(chosenTie.tieName)}</div><div class="text-[11px] text-slate-600">รับไฟจาก: <b>${escHtml(chosenTie.backupFeeder)}</b> (${escHtml(chosenTie.backupSourceName)})<br>โหลดที่รับพ่วง: ~${isl.ratedKva.toLocaleString()} kVA (~${isl.estAmp22kV} A)</div><a href="https://www.google.com/maps/dir/?api=1&destination=${chosenTie.lat},${chosenTie.lon}&travelmode=driving" target="_blank" rel="noopener" style="display:block;text-align:center;background:#059669;color:#fff;padding:4px 8px;border-radius:7px;font-weight:700;text-decoration:none;margin-top:4px;">🚗 นำทางไปจุดสับพ่วง</a></div>`);
            }
        });

        if (bounds.length >= 2) capturedMap.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 });
        else if (bounds.length === 1) capturedMap.setView(bounds[0], 15);
    }

    function syncSimSandboxResetIfExited() {
        if (preSimBackupJson && !window.PeaCore?.simSandbox?.active) {
            preSimBackupJson = null;
            document.getElementById('btnRestoreTieSim')?.classList.add('hidden');
        }
    }

    function previewTieAdvisorInSim() {
        if (!lastAdvisorPlan) return window.showToast?.('⚠️ กรุณาคำนวณแผนสับพ่วงก่อนจำลองผล');
        syncSimSandboxResetIfExited();

        if (!preSimBackupJson) {
            preSimBackupJson = window.PeaCore?.rawStorageGet
                ? (window.PeaCore.rawStorageGet(STORAGE_KEY_LABELS) || '[]')
                : (localStorage.getItem(STORAGE_KEY_LABELS) || '[]');
        }

        if (!window.PeaCore?.simSandbox?.active) {
            const simBtn = document.getElementById('btnToggleScadaSimMode');
            if (simBtn) simBtn.click();
            if (!window.PeaCore?.simSandbox?.active && window.PeaCore?.enterSimSandbox) {
                try { window.PeaCore.enterSimSandbox(JSON.parse(preSimBackupJson)); } catch (e) {}
            }
        }

        try {
            const liveLotoMap = getLiveCommittedLotoMap();
            const workingPins = JSON.parse(preSimBackupJson);
            const pinById = new Map(workingPins.map((p) => [p?.id, p]));

            // อัปเดตป้าย LOTO ล่าสุดจากผังจริงเข้าสู่ผังซ้อม เพื่อห้ามสับทับจุดที่มีช่างแขวนป้าย
            liveLotoMap.forEach((meta, pid) => {
                const p = pinById.get(pid);
                if (p) {
                    p.scadaNode = Object.assign({}, p.scadaNode || { t: 'VS' }, { loto: meta.loto, lotoBy: meta.lotoBy });
                }
            });

            const setPinSwitchState = (pid, stateCode) => {
                const p = pinById.get(pid);
                if (!p) return;
                if (stateCode === 'C' && hasPinLoto(p, liveLotoMap)) return;
                const curSt = String(p.scadaNode?.st || 'C').toUpperCase();
                if (curSt === stateCode) return;
                p.scadaNode = Object.assign({}, p.scadaNode || { t: 'VS' }, { st: stateCode });
                p.updatedAt = new Date().toISOString();
            };

            lastAdvisorPlan.upstreamSwitches.forEach((sw) => setPinSwitchState(sw.id, 'O'));
            lastAdvisorPlan.recloseSourceSwitches.forEach((src) => setPinSwitchState(src.id, 'C'));

            lastAdvisorPlan.restorableIslands.forEach((isl, islIdx) => {
                isl.requiredDownstreamSwitches.forEach((dsw) => setPinSwitchState(dsw.id, 'O'));
                const chosen = isl.tieOptions[selectedOptionByIsland[islIdx] || 0] || isl.tieOptions[0];
                if (!chosen) return;
                if (chosen.mode === 'pin') {
                    setPinSwitchState(chosen.tieId, 'C');
                } else if (chosen.mode === 'edge') {
                    const edgeRec = lastAdvisorPlan.edgesMap.get(chosen.edgeKey);
                    (edgeRec?.rawRefs || []).forEach(({ ownerId, lineIdx }) => {
                        const op = pinById.get(ownerId);
                        const ln = op?.scadaLines?.[lineIdx];
                        if (ln) {
                            delete ln.off;
                            ln.manualNO = false;
                            if (String(ln.st || '').toUpperCase() === 'O') ln.st = 'oh';
                        }
                    });
                }
            });

            localStorage.setItem(STORAGE_KEY_LABELS, JSON.stringify(workingPins));
            window.PeaCore?.notifyStorageUpdated?.([STORAGE_KEY_LABELS]);
            if (typeof window.renderLabeledPlacesList === 'function') window.renderLabeledPlacesList();
            document.getElementById('btnRestoreTieSim')?.classList.remove('hidden');
            window.showToast?.('🧪 จำลองสับ-ปลดและจ่ายไฟพ่วงบนผังแล้ว (โหมดซ้อมปลอดภัย ไม่กระทบคลาวด์)');
        } catch (e) {
            window.showToast?.('⚠️ ไม่สามารถจำลองสถานะสวิตช์ได้');
        }
    }

    function restoreTieAdvisorSimPreview() {
        if (window.PeaCore?.simSandbox?.active) {
            if (typeof window.toggleScadaSimMode === 'function') {
                window.toggleScadaSimMode(false);
            } else {
                const simBtn = document.getElementById('btnToggleScadaSimMode');
                if (simBtn) simBtn.click();
            }
            if (window.PeaCore?.simSandbox?.active) window.PeaCore.exitSimSandbox(null);
        } else if (preSimBackupJson) {
            localStorage.setItem(STORAGE_KEY_LABELS, preSimBackupJson);
        }
        preSimBackupJson = null;
        window.PeaCore?.notifyStorageUpdated?.([STORAGE_KEY_LABELS]);
        if (typeof window.renderLabeledPlacesList === 'function') window.renderLabeledPlacesList();
        document.getElementById('btnRestoreTieSim')?.classList.add('hidden');
        window.showToast?.('↩️ คืนค่าสถานะสวิตช์กลับสู่ผังปกติเรียบร้อยแล้ว');
    }

    // ========================================================================
    // 5. สร้างใบลำดับคำสั่งสับ-ปลด (Switching Order) ส่งเข้า LINE และแสดงผล UI
    // ========================================================================
    function buildSwitchingOrderSteps(plan) {
        if (!plan) return [];
        const steps = [];
        let stepNo = 1;

        plan.upstreamSwitches.forEach((sw) => {
            const alreadyOpen = isPinOpenSwitch(sw);
            steps.push({
                no: stepNo++,
                action: 'OPEN',
                badge: alreadyOpen ? '🔴 ตรวจสอบปลดกั้นต้นทาง (ปลดอยู่แล้ว)' : '🔴 สั่งปลด (กั้นต้นทาง)',
                pinId: sw.id,
                name: sw.name,
                lat: Number(sw.lat),
                lon: Number(sw.lon),
                note: plan.rootSourceIds?.has(sw.id)
                    ? 'ปลดต้นทางแยกช่วงสายที่ชำรุด'
                    : 'ปลดแยกโซนสายเสียเพื่อให้ช่วงต้นสายจ่ายไฟได้ตามปกติ'
            });
        });

        plan.recloseSourceSwitches.forEach((src) => {
            steps.push({
                no: stepNo++,
                action: 'CLOSE_SRC',
                badge: '🟢 สับจ่ายคืนต้นสาย',
                pinId: src.id,
                name: src.name,
                lat: Number(src.lat),
                lon: Number(src.lon),
                note: 'จ่ายไฟคืนช่วงต้นสายที่ปลอดภัย (หลังปลดกั้นจุดเสียแล้ว)'
            });
        });

        const addedDownIds = new Set();
        plan.restorableIslands.forEach((isl) => {
            isl.requiredDownstreamSwitches.forEach((dsw) => {
                if (addedDownIds.has(dsw.id)) return;
                addedDownIds.add(dsw.id);
                steps.push({
                    no: stepNo++,
                    action: 'OPEN',
                    badge: '🔴 สั่งปลด (กั้นท้ายทาง)',
                    pinId: dsw.id,
                    name: dsw.name,
                    lat: Number(dsw.lat),
                    lon: Number(dsw.lon),
                    note: `กั้นโซนสายเสียก่อนรับไฟพ่วงย้อนเข้า ${isl.zoneLabel}`
                });
            });
        });

        plan.restorableIslands.forEach((isl, islIdx) => {
            const chosen = isl.tieOptions[selectedOptionByIsland[islIdx] || 0] || isl.tieOptions[0];
            if (!chosen) return;
            const loadNote = isl.txCount > 0
                ? ` • คืนไฟหม้อแปลง ${isl.txCount} เครื่อง (~${isl.ratedKva.toLocaleString()} kVA / ~${isl.estAmp22kV} A)`
                : ` • คืนไฟสายยาว ${isl.lineKm} กม.`;
            steps.push({
                no: stepNo++,
                action: 'CLOSE_TIE',
                badge: `🟢 สั่งสับพ่วง (${chosen.backupFeeder})`,
                pinId: chosen.mode === 'pin' ? chosen.tieId : '',
                name: chosen.tieName,
                lat: chosen.lat,
                lon: chosen.lon,
                note: `รับไฟจาก ${chosen.backupFeeder} (${chosen.backupSourceName} ระยะ ${chosen.backupDistKm} กม.)${loadNote}`
            });
        });

        return steps;
    }

    function buildSwitchingOrderReportText() {
        if (!lastAdvisorPlan) return '';
        const p = lastAdvisorPlan;
        const steps = buildSwitchingOrderSteps(p);
        if (!steps.length && !p.lotoBlockedSwitches?.length) return '';

        const lines = [
            `🔀 แผนลำดับสับ-ปลดสวิตช์พ่วงจ่ายไฟคืน (22kV)`,
            `⚡ จุดเกิดเหตุ : ${p.targetTitle}`,
            `⚠️ กฎความปลอดภัย : ต้องปลดกั้นหัว-ท้ายโซนสายเสียให้ครบก่อนสับพ่วงเสมอ`
        ];
        if (p.lotoBlockedSwitches?.length) {
            lines.push(`🔒 ห้ามสับทับป้าย LOTO : ${p.lotoBlockedSwitches.map((x) => `${x.name} (${x.reason})`).join(', ')}`);
        }
        lines.push(`━━━━━━━━━━━━━━━━━━`);

        steps.forEach((s) => {
            lines.push(
                `ขั้นที่ ${s.no}) ${s.badge} : ${s.name}`,
                `   ↳ ${s.note}`,
                `   📍 https://www.google.com/maps?q=${s.lat},${s.lon}`
            );
        });
        if (p.faultZoneTxCount > 0 || p.deadEndSpurSummary.txCount > 0) {
            const unresTx = p.faultZoneTxCount + p.deadEndSpurSummary.txCount;
            const unresKva = p.faultZoneKva + p.deadEndSpurSummary.kva;
            lines.push(`━━━━━━━━━━━━━━━━━━`, `🛠️ หม้อแปลงในโซนรอซ่อม/สายปลายตัน : ${unresTx} เครื่อง (รวม ${unresKva.toLocaleString()} kVA)`);
        }
        return lines.join('\n');
    }

    function renderAdvisorResultPanel(plan) {
        const box = document.getElementById('scadaTieAdvisorResultBox');
        if (!box) return;
        if (!plan) {
            box.innerHTML = '';
            box.classList.add('hidden');
            return;
        }
        box.classList.remove('hidden');

        const steps = buildSwitchingOrderSteps(plan);
        const lotoWarnHtml = plan.lotoBlockedSwitches?.length
            ? `<div class="px-2.5 py-1.5 rounded-lg bg-red-950/90 border border-red-400/70 text-[10.5px] text-red-200 font-bold">🔒 <b>ระบบล็อกนิรภัยข้ามสวิตช์ติดป้าย LOTO อัตโนมัติ:</b> ${plan.lotoBlockedSwitches.map((x) => `${escHtml(x.name)} ("${escHtml(x.reason)}"${x.by ? ` • ${escHtml(x.by)}` : ''})`).join(', ')}</div>`
            : '';

        const altSelectorsHtml = plan.restorableIslands.map((isl, islIdx) => {
            if (isl.tieOptions.length <= 1) return '';
            const curOpt = selectedOptionByIsland[islIdx] || 0;
            const btns = isl.tieOptions.map((opt, oIdx) => {
                const active = oIdx === curOpt;
                const cls = active
                    ? 'bg-emerald-600 text-white border-emerald-300'
                    : 'bg-slate-800 text-slate-300 border-slate-600 hover:bg-slate-700';
                return `<button type="button" onclick="selectTieAdvisorAltOption(${islIdx},${oIdx})" class="px-2 py-0.5 rounded-lg border text-[10px] font-bold whitespace-nowrap ${cls}">${oIdx === 0 ? '⭐ แผน #1' : `สำรอง #${oIdx + 1}`}: ${escHtml(opt.tieName)} (${escHtml(opt.backupFeeder)} • ${opt.backupDistKm} กม.)</button>`;
            }).join('');
            return `<div class="p-1.5 rounded-lg bg-slate-950/80 border border-emerald-500/30 space-y-1"><div class="text-[10px] text-emerald-300 font-bold">🔀 เลือกทางเลือกสับพ่วงสำหรับ ${escHtml(isl.zoneLabel)} (⚠️ เลือกสับพ่วงเพียง 1 จุด ห้ามสับชนกัน):</div><div class="flex flex-wrap gap-1">${btns}</div></div>`;
        }).filter(Boolean).join('');

        const noTieNotice = plan.restorableIslands.length === 0
            ? `<div class="px-2.5 py-1.5 rounded-lg bg-amber-950/80 border border-amber-400/40 text-[10.5px] text-amber-200">ℹ️ <b>ไม่มีสวิตช์พ่วง (Tie) ที่สับได้ฝั่งท้ายน้ำของจุดนี้:</b> สามารถปลดกั้นต้นทางเพื่อจ่ายไฟคืนช่วงต้นสายหลักได้ทันที ส่วนปลายสายต้องรอซ่อมจุดชำรุด${plan.deadEndSpurSummary.txCount > 0 ? ` (กระทบหม้อแปลง ${plan.deadEndSpurSummary.txCount} เครื่อง / ${plan.deadEndSpurSummary.kva.toLocaleString()} kVA)` : ''}</div>`
            : '';

        const faultTxNotice = plan.faultZoneTxCount > 0
            ? `<div class="text-[10px] text-rose-200/90 px-1">⚡ หม้อแปลงที่ติดอยู่ในช่วงสายชำรุดโดยตรง: <b>${plan.faultZoneTxCount} เครื่อง (${plan.faultZoneKva.toLocaleString()} kVA)</b></div>`
            : '';

        const stepsHtml = steps.length > 0
            ? `<div class="space-y-1 max-h-40 overflow-y-auto pr-0.5">` + steps.map((s) => {
                const rowBorder = s.action.startsWith('CLOSE') ? 'border-emerald-400/60 bg-emerald-950/40' : 'border-rose-400/50 bg-slate-950/90';
                const badgeCol = s.action.startsWith('CLOSE') ? 'text-emerald-300' : 'text-rose-300';
                return `<div class="flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg border ${rowBorder} text-[10.5px] text-white">` +
                    `<button type="button" onclick="zoomToTieAdvisorStepPin(${s.lat},${s.lon})" class="flex-1 min-w-0 text-left truncate"><b class="${badgeCol}">ขั้นที่ ${s.no} • ${escHtml(s.badge)}:</b> <b>${escHtml(s.name)}</b> <span class="text-slate-300">(${escHtml(s.note)})</span></button>` +
                    `<a href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving" target="_blank" rel="noopener" class="shrink-0 bg-blue-600 hover:bg-blue-500 text-white px-2 py-0.5 rounded text-[9.5px] font-bold whitespace-nowrap">🚗 ไปจุดนี้</a>` +
                    `</div>`;
            }).join('') + `</div>`
            : `<div class="p-2 rounded-lg bg-amber-950/80 border border-amber-400/40 text-[11px] text-amber-200">⚠️ ไม่พบสวิตช์ปลดกั้นรอบจุดที่เลือก กรุณาตรวจสอบการเชื่อมสายหรือประเภทหมุดสวิตช์ในผัง</div>`;

        const simActiveCls = preSimBackupJson ? '' : 'hidden';

        box.innerHTML =
            `<div class="flex flex-wrap items-center justify-between gap-1.5 pt-1">` +
            `<span class="text-[11px] font-extrabold text-teal-200">⚡ แผนสับ-ปลดแก้เหตุ: ${escHtml(plan.targetTitle)}</span>` +
            `<div class="flex flex-wrap items-center gap-1 ml-auto">` +
            `<button type="button" onclick="previewTieAdvisorInSim()" class="bg-purple-600 hover:bg-purple-500 text-white px-2.5 py-1 rounded-lg text-[10px] font-extrabold whitespace-nowrap shadow">🧪 จำลองสับบนผัง</button>` +
            `<button type="button" id="btnRestoreTieSim" onclick="restoreTieAdvisorSimPreview()" class="${simActiveCls} bg-amber-500 hover:bg-amber-400 text-slate-950 px-2 py-1 rounded-lg text-[10px] font-extrabold whitespace-nowrap shadow">↩️ คืนค่าผังปกติ</button>` +
            `<button type="button" onclick="copyTieAdvisorOrder(this)" class="bg-slate-700 hover:bg-slate-600 text-amber-300 border border-amber-400/50 px-2.5 py-1 rounded-lg text-[10px] font-extrabold whitespace-nowrap">📋 คัดลอก</button>` +
            `<button type="button" onclick="shareTieAdvisorOrderToLine()" class="bg-[#00B900] hover:bg-[#009900] text-white px-2.5 py-1 rounded-lg text-[10px] font-extrabold whitespace-nowrap">💬 ส่งเข้า LINE</button>` +
            `</div></div>` +
            lotoWarnHtml +
            altSelectorsHtml +
            noTieNotice +
            stepsHtml +
            faultTxNotice;
    }

    // ========================================================================
    // 6. การโต้ตอบผู้ใช้, สลับพับแผงอัตโนมัติ (Accordion) & ปุ่มลัดเชื่อมผลฟอลต์
    // ========================================================================
    function populateTieTargetDropdowns() {
        const fdSel = document.getElementById('scadaTieFeederFilter');
        const pinSel = document.getElementById('scadaTieFaultPinSelect');
        if (!pinSel) return;

        const { pins, adj } = buildNetworkTopology(preSimBackupJson);
        const wiredPins = pins.filter((p) => (adj.get(p.id) || []).length > 0 && getPinEquipType(p) !== 'GEN');

        if (fdSel && document.activeElement !== fdSel) {
            const prevFd = fdSel.value || 'ALL';
            const feeders = Array.from(new Set(wiredPins.map(extractPinFeederCode).filter(Boolean))).sort();
            const fdHtml = `<option value="ALL">ทุกวงจร (${wiredPins.length})</option>` +
                feeders.map((f) => `<option value="${escHtml(f)}">วงจร ${escHtml(f)}</option>`).join('');
            if (fdSel.__lastHtml !== fdHtml) {
                fdSel.innerHTML = fdHtml;
                fdSel.__lastHtml = fdHtml;
                if (feeders.includes(prevFd)) fdSel.value = prevFd;
            }
        }

        const activeFd = fdSel?.value || 'ALL';
        const prevPin = pinSel.value;
        const filtered = wiredPins.filter((p) => activeFd === 'ALL' || extractPinFeederCode(p) === activeFd)
            .sort((a, b) => (isPinIsolatingSwitch(b) ? 1 : 0) - (isPinIsolatingSwitch(a) ? 1 : 0) || String(a.name || '').localeCompare(String(b.name || ''), 'th'));

        const pinHtml = `<option value="">-- เลือกสวิตช์/หมุดใกล้จุดชำรุด หรือกด 👆 แตะบนแผนที่ --</option>` +
            filtered.map((p) => {
                const t = getPinEquipType(p);
                const icon = SOURCE_PIN_TYPES.has(t) ? '■' : (ISOLATING_SW_TYPES.has(t) ? '⚡' : '📍');
                return `<option value="${escHtml(p.id)}">${icon} [${escHtml(t)}] ${escHtml(p.name)}</option>`;
            }).join('');

        if (pinSel.__lastHtml !== pinHtml) {
            pinSel.innerHTML = pinHtml;
            pinSel.__lastHtml = pinHtml;
            if (prevPin && filtered.some((p) => p.id === prevPin)) pinSel.value = prevPin;
        }
    }

    function stopMapPickMode() {
        isPickingOnMap = false;
        if (mapPickCleanupFn) { mapPickCleanupFn(); mapPickCleanupFn = null; }
        document.getElementById('labeledInteractiveMap')?.classList.remove('pea-tie-pick-cursor');
        const btn = document.getElementById('btnTiePickOnMap');
        if (btn) {
            btn.textContent = '👆 แตะจุดเสียบนแผนที่';
            btn.className = 'flex-1 bg-amber-600 hover:bg-amber-500 text-white py-1.5 px-2 rounded-lg text-[11px] font-extrabold whitespace-nowrap shadow';
        }
    }

    function startTieAdvisorMapPickMode() {
        tryDiscoverMap();
        syncSimSandboxResetIfExited();
        const mapEl = document.getElementById('labeledInteractiveMap');
        if (!capturedMap || !mapEl) return window.showToast?.('⚠️ แผนที่ยังไม่พร้อมใช้งาน');

        if (isPickingOnMap) { stopMapPickMode(); return; }
        window.toggleScadaDrawMode?.(false);
        window.toggleScadaWireMoveMode?.(false);
        window.toggleScadaPinMoveMode?.(false);
        window.cancelPmMapInteractiveModes?.();

        isPickingOnMap = true;
        mapEl.classList.add('pea-tie-pick-cursor');
        const btn = document.getElementById('btnTiePickOnMap');
        if (btn) {
            btn.textContent = '🎯 แตะบนเส้นสายไฟ... (กดซ้ำยกเลิก)';
            btn.className = 'flex-1 bg-emerald-600 text-white border border-amber-300 py-1.5 px-2 rounded-lg text-[11px] font-extrabold whitespace-nowrap shadow';
        }
        window.showToast?.('👆 แตะลงบนเส้นสายไฟ 22kV ช่วงที่ชำรุดบนแผนที่ได้เลยครับ');

        let downPt = null;
        const onDown = (ev) => { downPt = { x: ev.clientX, y: ev.clientY }; };
        const onUp = (ev) => {
            if (mapEl.classList.contains('scada-draw-cursor') ||
                mapEl.classList.contains('scada-move-wire-active') ||
                mapEl.classList.contains('scada-move-pin-active') ||
                mapEl.classList.contains('pm-pin-drop-active-map')) {
                stopMapPickMode();
                return;
            }
            if (!downPt || Math.hypot(ev.clientX - downPt.x, ev.clientY - downPt.y) > 8) return;
            if (ev.target.closest?.('.leaflet-control-container, .leaflet-popup-pane')) return;
            const ll = capturedMap.mouseEventToLatLng(ev);
            if (!ll) return;
            const { edges } = buildNetworkTopology(preSimBackupJson);
            const hit = findClosestEdgeToCoord(ll.lat, ll.lng, edges, 0.35);
            if (!hit) {
                window.showToast?.('⚠️ แตะห่างแนวสายไฟเกินไป กรุณาแตะให้ชิดเส้นสาย 22kV');
                return;
            }
            stopMapPickMode();
            selectedFaultEdgeKey = hit.edge.edgeKey;
            const pinSel = document.getElementById('scadaTieFaultPinSelect');
            if (pinSel) pinSel.value = '';
            selectedOptionByIsland = {};
            const res = analyzeSwitchingPlanForTarget({ faultEdgeKey: hit.edge.edgeKey, faultPoint: hit.point });
            if (res.error) return window.showToast?.('⚠️ ' + res.error);
            lastAdvisorPlan = res;
            renderAdvisorMapOverlay(res);
            renderAdvisorResultPanel(res);
        };

        mapEl.addEventListener('pointerdown', onDown, true);
        mapEl.addEventListener('pointerup', onUp, true);
        mapPickCleanupFn = () => {
            mapEl.removeEventListener('pointerdown', onDown, true);
            mapEl.removeEventListener('pointerup', onUp, true);
        };
    }

    async function importFaultToTieAdvisor(candLat = null, candLon = null) {
        syncSimSandboxResetIfExited();
        let targetLat = Number(candLat), targetLon = Number(candLon);
        if (!candLat || isNaN(targetLat) || isNaN(targetLon)) {
            const svBtn = document.querySelector('#scadaFaultResultBox button[onclick*="openFaultStreetView"]');
            const m = String(svBtn?.getAttribute('onclick') || '').match(/openFaultStreetView\(\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*\)/);
            if (m) {
                targetLat = parseFloat(m[1]);
                targetLon = parseFloat(m[2]);
            }
        }

        await toggleScadaTieAdvisorPanel(true);
        tryDiscoverMap();

        if (isNaN(targetLat) || isNaN(targetLon)) {
            return window.showToast?.('ℹ️ ยังไม่มีจุดคาดการณ์จากตัวคำนวณฟอลต์ (กด 👆 แตะจุดเสียบนแผนที่ได้โดยตรง)');
        }

        const { edges } = buildNetworkTopology(preSimBackupJson);
        const hit = findClosestEdgeToCoord(targetLat, targetLon, edges, 0.25);
        if (!hit) return window.showToast?.('⚠️ ไม่พบเส้นสายไฟบริเวณจุดคาดการณ์ฟอลต์');

        selectedFaultEdgeKey = hit.edge.edgeKey;
        const pinSel = document.getElementById('scadaTieFaultPinSelect');
        if (pinSel) pinSel.value = '';
        selectedOptionByIsland = {};
        const res = analyzeSwitchingPlanForTarget({ faultEdgeKey: hit.edge.edgeKey, faultPoint: hit.point });
        if (res.error) return window.showToast?.('⚠️ ' + res.error);
        lastAdvisorPlan = res;
        renderAdvisorMapOverlay(res);
        renderAdvisorResultPanel(res);
        window.showToast?.('🔀 สร้างแผนปลดกั้นและสับพ่วงจากจุดคาดการณ์ฟอลต์เรียบร้อย!');
    }

    function runScadaTieAdvisorAnalysis() {
        tryDiscoverMap();
        syncSimSandboxResetIfExited();
        const pinId = document.getElementById('scadaTieFaultPinSelect')?.value || '';
        const faultAtPole = document.getElementById('scadaTieFaultScopeSelect')?.value === 'AT_PIN';
        if (!pinId && !selectedFaultEdgeKey) {
            return window.showToast?.('⚠️ กรุณาเลือกสวิตช์/หมุดจากรายการ หรือกด "👆 แตะจุดเสียบนแผนที่" ก่อนครับ');
        }
        selectedOptionByIsland = {};
        const res = pinId
            ? analyzeSwitchingPlanForTarget({ faultPinId: pinId, faultAtSwitchPole: faultAtPole })
            : analyzeSwitchingPlanForTarget({ faultEdgeKey: selectedFaultEdgeKey });
        if (res.error) return window.showToast?.('⚠️ ' + res.error);
        lastAdvisorPlan = res;
        renderAdvisorMapOverlay(res);
        renderAdvisorResultPanel(res);
    }

    function selectTieAdvisorAltOption(islandIdx, optionIdx) {
        selectedOptionByIsland[islandIdx] = optionIdx;
        if (lastAdvisorPlan) {
            renderAdvisorMapOverlay(lastAdvisorPlan);
            renderAdvisorResultPanel(lastAdvisorPlan);
            if (preSimBackupJson) previewTieAdvisorInSim();
        }
    }

    function zoomToTieAdvisorStepPin(lat, lon) {
        if (capturedMap && !isNaN(lat) && !isNaN(lon)) capturedMap.setView([lat, lon], 17);
    }

    function copyTieAdvisorOrder(btnEl = null) {
        const msg = buildSwitchingOrderReportText();
        if (!msg) return window.showToast?.('⚠️ ยังไม่มีแผนลำดับสับ-ปลดสำหรับคัดลอก');
        copyTextWithBtnFeedback(msg, '📋 คัดลอกแผนสับ-ปลดสวิตช์แล้ว! (กดวางใน LINE PC ได้เลย)', btnEl);
    }

    function shareTieAdvisorOrderToLine() {
        const msg = buildSwitchingOrderReportText();
        if (!msg) return window.showToast?.('⚠️ ยังไม่มีแผนลำดับสับ-ปลดสำหรับส่ง LINE');
        copyTextWithBtnFeedback(msg, '💬 คัดลอกแผนสับ-ปลดแล้ว กำลังเปิด LINE...');
        const lineUrl = 'https://line.me/R/share?text=' + encodeURIComponent(msg);
        const win = window.open(lineUrl, '_blank');
        if (!win && !window.PeaCore?.isEmbeddedIframe) window.location.href = lineUrl;
    }

    function clearTieAdvisorOverlay(silent = false) {
        stopMapPickMode();
        syncSimSandboxResetIfExited();
        if (preSimBackupJson) restoreTieAdvisorSimPreview();
        tieLayerGroup?.clearLayers();
        lastAdvisorPlan = null;
        selectedFaultEdgeKey = '';
        selectedOptionByIsland = {};
        const pinSel = document.getElementById('scadaTieFaultPinSelect');
        if (pinSel) pinSel.value = '';
        renderAdvisorResultPanel(null);
        if (!silent) window.showToast?.('🧹 ล้างแผนแนะนำสับพ่วงเรียบร้อยแล้ว');
    }

    function onTieAdvisorFeederFilterChange() {
        populateTieTargetDropdowns();
    }

    function onTieAdvisorTargetSelectChange() {
        selectedFaultEdgeKey = '';
        if (document.getElementById('scadaTieFaultPinSelect')?.value) {
            runScadaTieAdvisorAnalysis();
        }
    }

    function onTieAdvisorScopeChange() {
        if (document.getElementById('scadaTieFaultPinSelect')?.value) {
            runScadaTieAdvisorAnalysis();
        }
    }

    // ผูกระบบสลับพับแผงอัตโนมัติ (Accordion) ไม่ให้แผงฟอลต์กับแผงสับพ่วงกางซ้อนกันจนบังแผนที่บนมือถือ
    function hookFaultPanelAccordion() {
        if (typeof window.toggleScadaFaultLocatorPanel === 'function' && !window.toggleScadaFaultLocatorPanel.__tieAccordionHooked) {
            const origToggleFault = window.toggleScadaFaultLocatorPanel;
            window.toggleScadaFaultLocatorPanel = Object.assign(async function (forceOpen) {
                const willOpen = typeof forceOpen === 'boolean'
                    ? forceOpen
                    : Boolean(document.getElementById('scadaFaultLocatorPanel')?.classList.contains('hidden'));
                if (willOpen && panelOpen) await toggleScadaTieAdvisorPanel(false);
                return origToggleFault.apply(this, arguments);
            }, { __tieAccordionHooked: true });
        }
    }

    async function toggleScadaTieAdvisorPanel(forceOpen) {
        syncSimSandboxResetIfExited();
        hookFaultPanelAccordion();
        panelOpen = typeof forceOpen === 'boolean' ? forceOpen : !panelOpen;
        if (!panelOpen) stopMapPickMode();
        if (panelOpen && typeof window.toggleScadaFaultLocatorPanel === 'function' && !document.getElementById('scadaFaultLocatorPanel')?.classList.contains('hidden')) {
            await window.toggleScadaFaultLocatorPanel(false);
        }
        document.getElementById('scadaTieAdvisorPanel')?.classList.toggle('hidden', !panelOpen);
        const btn = document.getElementById('btnToggleTieAdvisor');
        if (btn) {
            btn.className = panelOpen
                ? 'bg-teal-600 text-white border border-amber-300 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow'
                : 'bg-teal-900/90 hover:bg-teal-800 text-teal-100 border border-teal-400/50 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow';
        }
        if (panelOpen) {
            if (window.PeaIdbStore?.isHydrating?.()) await window.PeaIdbStore.ready;
            populateTieTargetDropdowns();
        }
        setTimeout(() => capturedMap?.invalidateSize?.(), 60);
    }

    function injectTieAdvisorToolbarUI() {
        const tb = document.getElementById('scadaControlToolbar');
        if (!tb) return false;
        if (document.getElementById('btnToggleTieAdvisor')) return true;

        const simBtn = document.getElementById('btnToggleScadaSimMode');
        if (simBtn?.parentElement) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'btnToggleTieAdvisor';
            btn.onclick = () => toggleScadaTieAdvisorPanel();
            btn.className = 'bg-teal-900/90 hover:bg-teal-800 text-teal-100 border border-teal-400/50 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow';
            btn.innerHTML = '🔀 แนะนำสับพ่วง (Tie)';
            simBtn.parentElement.insertBefore(btn, simBtn);
        }

        ['btnToggleScadaDrawMode', 'btnToggleWireMoveMode', 'btnTogglePinMoveMode', 'btnDropNewPmPinOnScada'].forEach((id) => {
            const b = document.getElementById(id);
            if (b && !b.__tieCancelBound) {
                b.__tieCancelBound = true;
                b.addEventListener('click', () => { if (isPickingOnMap) stopMapPickMode(); });
            }
        });

        const pnl = document.createElement('div');
        pnl.id = 'scadaTieAdvisorPanel';
        pnl.className = 'hidden pt-2 border-t border-teal-500/40 space-y-2 text-xs';
        pnl.innerHTML =
            `<div class="p-2.5 rounded-xl bg-gradient-to-r from-teal-950/90 via-slate-900 to-slate-900 border border-teal-400/40 space-y-2">` +
            `<div class="flex flex-wrap items-center justify-between gap-1.5">` +
            `<span class="text-[11.5px] font-extrabold text-teal-300">🔀 วางแผนปลดกั้นโซนชำรุด &amp; แนะนำสวิตช์พ่วงจ่ายไฟคืน (FLISR)</span>` +
            `<button type="button" onclick="importFaultToTieAdvisor()" class="bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1 rounded-lg text-[10.5px] font-extrabold shadow whitespace-nowrap">🎯 ดึงจุดเสียจากผลคำนวณฟอลต์</button>` +
            `</div>` +
            `<div class="grid grid-cols-2 sm:grid-cols-12 gap-1.5 items-center">` +
            `<select id="scadaTieFeederFilter" onchange="onTieAdvisorFeederFilterChange()" class="col-span-1 sm:col-span-2 px-2 py-1.5 rounded-lg bg-slate-800 text-teal-200 border border-slate-600 text-[11px] font-bold"><option value="ALL">ทุกวงจร</option></select>` +
            `<select id="scadaTieFaultPinSelect" onchange="onTieAdvisorTargetSelectChange()" class="col-span-1 sm:col-span-4 px-2 py-1.5 rounded-lg bg-slate-800 text-amber-300 border border-slate-600 text-[11px] font-bold"></select>` +
            `<select id="scadaTieFaultScopeSelect" onchange="onTieAdvisorScopeChange()" class="col-span-2 sm:col-span-2 px-2 py-1.5 rounded-lg bg-slate-800 text-slate-200 border border-slate-600 text-[10.5px] font-bold">` +
            `<option value="AFTER_PIN">⚡ สายช่วงหลังหมุดนี้</option>` +
            `<option value="AT_PIN">💥 ชำรุดที่ตัวหมุดนี้เอง</option></select>` +
            `<div class="col-span-2 sm:col-span-4 flex gap-1">` +
            `<button type="button" id="btnTiePickOnMap" onclick="startTieAdvisorMapPickMode()" class="flex-1 bg-amber-600 hover:bg-amber-500 text-white py-1.5 px-2 rounded-lg text-[11px] font-extrabold whitespace-nowrap shadow">👆 แตะจุดเสียบนแผนที่</button>` +
            `<button type="button" onclick="runScadaTieAdvisorAnalysis()" class="bg-teal-600 hover:bg-teal-500 text-white py-1.5 px-2.5 rounded-lg text-[11px] font-extrabold whitespace-nowrap shadow">🔍 วิเคราะห์</button>` +
            `<button type="button" onclick="clearTieAdvisorOverlay(false)" class="bg-slate-700 hover:bg-slate-600 text-amber-300 border border-slate-500/60 py-1.5 px-2 rounded-lg text-[11px] font-extrabold whitespace-nowrap" title="ล้างแผนสับพ่วง">🧹</button>` +
            `</div></div>` +
            `<div id="scadaTieAdvisorResultBox" class="hidden space-y-1.5 pt-1 border-t border-slate-700/80"></div>` +
            `</div>`;
        tb.appendChild(pnl);
        return true;
    }

    function observeFaultLocatorResultBox() {
        const faultBox = document.getElementById('scadaFaultResultBox');
        if (!faultBox || faultBox.__tieObserverAttached) return;
        faultBox.__tieObserverAttached = true;

        const injectQuickTieBtns = () => {
            if (faultBox.querySelector('.pea-quick-tie-btn')) return;
            const svBtns = faultBox.querySelectorAll('button[onclick*="openFaultStreetView"]');
            svBtns.forEach((svBtn) => {
                const m = String(svBtn.getAttribute('onclick') || '').match(/openFaultStreetView\(\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*\)/);
                if (!m) return;
                const tieBtn = document.createElement('button');
                tieBtn.type = 'button';
                tieBtn.className = 'pea-quick-tie-btn shrink-0 bg-teal-600 hover:bg-teal-500 text-white px-1.5 py-1 rounded text-[9.5px] font-extrabold whitespace-nowrap';
                tieBtn.title = 'วางแผนปลดกั้นและสับสวิตช์พ่วงสำหรับจุดนี้';
                tieBtn.textContent = '🔀 พ่วงไฟ';
                tieBtn.onclick = () => importFaultToTieAdvisor(parseFloat(m[1]), parseFloat(m[2]));
                svBtn.parentElement?.appendChild(tieBtn);
            });
        };

        const obs = new MutationObserver(injectQuickTieBtns);
        obs.observe(faultBox, { childList: true, subtree: true });
        injectQuickTieBtns();
    }

    function hookRoleChangeCleanup() {
        if (typeof window.__onScadaRoleUpdated === 'function' && !window.__onScadaRoleUpdated.__tieAdvisorHooked) {
            const origRoleUpd = window.__onScadaRoleUpdated;
            window.__onScadaRoleUpdated = Object.assign(function () {
                const ret = origRoleUpd.apply(this, arguments);
                const curScope = getCurrentScopeKey();
                if (lastActiveScopeKey && curScope !== lastActiveScopeKey) {
                    clearTieAdvisorOverlay(true);
                    if (panelOpen) populateTieTargetDropdowns();
                }
                lastActiveScopeKey = curScope;
                return ret;
            }, { __tieAdvisorHooked: true });
        }
    }

    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && isPickingOnMap) stopMapPickMode();
    });

    window.PeaCore?.onRealtimeChange?.((keys) => {
        syncSimSandboxResetIfExited();
        if (!Array.isArray(keys)) return;
        if (keys.includes(STORAGE_KEY_LABELS) || keys.includes(STORAGE_KEY_DELETED)) {
            if (panelOpen && !preSimBackupJson) populateTieTargetDropdowns();
            // หากกำลังเปิดแผนสับพ่วงอยู่แล้วมีคนแขวน/ปลดป้าย LOTO สด ให้คำนวณเตือนใหม่ทันที
            if (lastAdvisorPlan && !preSimBackupJson) {
                const pinId = document.getElementById('scadaTieFaultPinSelect')?.value || '';
                const faultAtPole = document.getElementById('scadaTieFaultScopeSelect')?.value === 'AT_PIN';
                if (pinId || selectedFaultEdgeKey) {
                    const updated = pinId
                        ? analyzeSwitchingPlanForTarget({ faultPinId: pinId, faultAtSwitchPole: faultAtPole })
                        : analyzeSwitchingPlanForTarget({ faultEdgeKey: selectedFaultEdgeKey, faultPoint: lastAdvisorPlan.markerCoord });
                    if (!updated.error) {
                        lastAdvisorPlan = updated;
                        renderAdvisorMapOverlay(updated);
                        renderAdvisorResultPanel(updated);
                    }
                }
            }
        }
    });

    Object.assign(window, {
        toggleScadaTieAdvisorPanel,
        onTieAdvisorFeederFilterChange,
        onTieAdvisorTargetSelectChange,
        onTieAdvisorScopeChange,
        startTieAdvisorMapPickMode,
        importFaultToTieAdvisor,
        runScadaTieAdvisorAnalysis,
        selectTieAdvisorAltOption,
        previewTieAdvisorInSim,
        restoreTieAdvisorSimPreview,
        zoomToTieAdvisorStepPin,
        copyTieAdvisorOrder,
        shareTieAdvisorOrderToLine,
        clearTieAdvisorOverlay
    });

    function initTieAdvisorModule() {
        if (!document.getElementById('techMainApp')) return;
        lastActiveScopeKey = getCurrentScopeKey();
        injectTieAdvisorStyles();
        hookLeafletMap();
        hookFaultPanelAccordion();
        hookRoleChangeCleanup();
        if (!injectTieAdvisorToolbarUI()) {
            const obs = new MutationObserver(() => {
                hookLeafletMap();
                hookFaultPanelAccordion();
                hookRoleChangeCleanup();
                if (injectTieAdvisorToolbarUI()) obs.disconnect();
            });
            obs.observe(document.getElementById('techMainApp'), { childList: true, subtree: true });
        }
        setInterval(() => {
            hookLeafletMap();
            hookFaultPanelAccordion();
            hookRoleChangeCleanup();
            syncSimSandboxResetIfExited();
            observeFaultLocatorResultBox();
            const curScope = getCurrentScopeKey();
            let isLogged = false;
            try { isLogged = localStorage.getItem('elec_app_logged_in') === 'true'; } catch (e) {}
            if (!isLogged || (lastActiveScopeKey && curScope !== lastActiveScopeKey)) {
                clearTieAdvisorOverlay(true);
                if (!isLogged && panelOpen) toggleScadaTieAdvisorPanel(false);
            }
            lastActiveScopeKey = curScope;
        }, 2000);
    }

    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', initTieAdvisorModule);
    else initTieAdvisorModule();
})();
// ==================== จบไฟล์ scada-tie-advisor.js (v1.2 Final) ====================