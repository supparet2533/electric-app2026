// ============================================================================
// 🎯⚡ PEA SMART GRID — FAULT DISTANCE & CURRENT LOCATOR v2.5 (scada-fault-locator.js)
// ชี้เป้าฟอลต์ 22kV จากระยะ (กม.) หรือกระแส (A) + ปุ่มล้างค่าที่กรอก + ปลอดจอกระพริบ 100%
// พาทที่ 1 / 2 : 22kV Line Impedance, Upstream Z Solver & Multi-Cable Graph Engine
// ============================================================================
(function () {
    'use strict';

    const FAULT_BRIDGE_CH = 'pea_scada_fault_locator_v1';
    const FAULT_PKT_KEY = 'elec_scada_fault_locator_pkt';
    const HANDLED_PKT_SESSION_KEY = 'elec_scada_handled_fault_pkt_ts';
    const FAULT_PREF_KEY = 'elec_scada_22kv_fault_calc_prefs_v1';
    const STORAGE_KEY_LABELS = 'elec_labeled_places_list';
    const STORAGE_KEY_DELETED = 'elec_deleted_labeled_places_map';
    const SWITCHABLE_TYPES = new Set(['RC', 'CB', 'VB', 'VS', 'VSC', 'S', 'DF', 'GEN']);

    const PEA_V_LL = 22000;
    const PEA_V_LN = PEA_V_LL / Math.sqrt(3);
    const PEA_22KV_CABLES = {
        SAC185: { label: 'สายเมนหุ้มฉนวน 185 ตร.มม.', r1: 0.164, x1: 0.345, r0: 0.312, x0: 1.560 },
        AAC185: { label: 'สายเมนเปลือย 185 ตร.มม.', r1: 0.159, x1: 0.378, r0: 0.307, x0: 1.620 },
        SAC120: { label: 'สายขนาด 120 ตร.มม.', r1: 0.253, x1: 0.362, r0: 0.401, x0: 1.595 },
        SAC95:  { label: 'สายขนาด 95 ตร.มม.',  r1: 0.320, x1: 0.372, r0: 0.468, x0: 1.615 },
        SAC50:  { label: 'สายกิ่ง 50 ตร.มม.',  r1: 0.603, x1: 0.398, r0: 0.751, x0: 1.665 },
        UG240:  { label: 'สายเคเบิลใต้ดิน 240 ตร.มม.', r1: 0.125, x1: 0.118, r0: 0.395, x0: 0.360 }
    };

    const PEA_SOURCE_BUS_PRESETS = {
        SUB_50MVA:  { label: 'หม้อแปลงสถานี 50 MVA', rs1: 0.05, xs1: 1.48, rs0: 0.06, xs0: 1.42 },
        SUB_25MVA:  { label: 'หม้อแปลงสถานี 25 MVA', rs1: 0.10, xs1: 2.52, rs0: 0.12, xs0: 2.45 },
        SUB_STRONG: { label: 'สถานีขนานหม้อแปลงใหญ่', rs1: 0.03, xs1: 0.96, rs0: 0.04, xs0: 0.95 },
        IDEAL_ZERO: { label: 'ไม่คิดอิมพีแดนซ์สถานี', rs1: 0.01, xs1: 0.15, rs0: 0.02, xs0: 0.25 }
    };

    const DEFAULT_AMP_HINT_TEXT = '💡 กรอกกระแสฟอลต์ (แอมป์) เพื่อคำนวณเป็นระยะ กม. อัตโนมัติ (ระบบ 22kV)';

    const safeSessionGet = (k) => { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } };
    const safeSessionSet = (k, v) => { try { window.sessionStorage.setItem(k, v); } catch (e) {} };
    const escapeRe = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    let faultBc = null;
    try { if ('BroadcastChannel' in window) faultBc = new BroadcastChannel(FAULT_BRIDGE_CH); } catch (e) {}

    let capturedMap = null;
    let faultLayerGroup = null;
    let panelOpen = false;
    let lastFaultResult = null;
    let lastActiveScopeKey = '';
    let lastKnownLoggedState = false;
    let activePacketApplySeq = 0;
    let lastHandledPktTs = parseInt(safeSessionGet(HANDLED_PKT_SESSION_KEY) || '0', 10) || 0;
    let lastClearedPktTs = 0;

    function loadCalcPrefs() {
        try {
            return Object.assign({ faultType: 'LL', cableKey: 'SAC185', sourceKey: 'SUB_50MVA', rfOhm: 0 },
                JSON.parse(localStorage.getItem(FAULT_PREF_KEY) || '{}') || {});
        } catch (e) {
            return { faultType: 'LL', cableKey: 'SAC185', sourceKey: 'SUB_50MVA', rfOhm: 0 };
        }
    }
    function saveCalcPrefs(patch) {
        try { localStorage.setItem(FAULT_PREF_KEY, JSON.stringify(Object.assign(loadCalcPrefs(), patch || {}))); } catch (e) {}
    }

    function normalizeFaultTypeCode(rawPhaseOrType) {
        const s = String(rawPhaseOrType || '').toUpperCase().trim();
        if (!s) return 'LL';
        if (s === '3P' || s === 'LL' || s === 'LG') return s;
        if (s === 'LLG') return 'LL';
        if (/3\s*เฟส|3\s*P|3\s*Φ|A\s*[-/,]?\s*B\s*[-/,]?\s*C/.test(s)) return '3P';
        if (/ช็อต\s*2|2\s*เฟส|ระหว่างเฟส|\b(?:AB|BC|CA)\b|(?:^|[^A-Z])(?:A\s*[-/,]\s*B|B\s*[-/,]\s*C|C\s*[-/,]\s*A)(?![A-Z])/.test(s)) return 'LL';
        if (/ลงดิน|1\s*เฟส|เฟสเดียว|\b(?:EF|AG|BG|CG|AN|BN|CN|EARTH|GROUND)\b|(?:^|[^A-Z])[ABC]\s*[-/,]\s*[GN](?![A-Z])|เฟส\s*[ABC]|(?:^|\s)[ABC](?:\s|$)/.test(s)) return 'LG';
        return 'LL';
    }

    function resolveEdgeCableProfile(edgeObj, defaultCableKey) {
        const fallback = PEA_22KV_CABLES[defaultCableKey] || PEA_22KV_CABLES.SAC185;
        if (!edgeObj) return fallback;
        const lb = String(edgeObj.lb || '').toUpperCase();
        if (edgeObj.st === 'ug' || /UG|XLPE|240|ใต้ดิน/.test(lb)) return PEA_22KV_CABLES.UG240;
        if (/50(?![0-9])|35(?![0-9])/.test(lb)) return PEA_22KV_CABLES.SAC50;
        if (/95(?![0-9])/.test(lb)) return PEA_22KV_CABLES.SAC95;
        if (/120(?![0-9])/.test(lb)) return PEA_22KV_CABLES.SAC120;
        if (/185(?![0-9])/.test(lb)) return /AAC|เปลือย/.test(lb) ? PEA_22KV_CABLES.AAC185 : PEA_22KV_CABLES.SAC185;
        return fallback;
    }

    function calcFaultCurrentAtVector(accVec, faultType, srcBus, rfOhm) {
        const rf = Math.max(0, Number(rfOhm) || 0);
        const r1 = srcBus.rs1 + accVec.r1, x1 = srcBus.xs1 + accVec.x1;
        if (faultType === '3P') {
            const z = Math.hypot(r1 + rf, x1);
            return z > 1e-6 ? (PEA_V_LN / z) : 99999;
        }
        if (faultType === 'LL') {
            const zLoop = Math.hypot(2 * r1 + rf, 2 * x1);
            return zLoop > 1e-6 ? (PEA_V_LL / zLoop) : 99999;
        }
        const r0 = srcBus.rs0 + accVec.r0, x0 = srcBus.xs0 + accVec.x0;
        const zLg = Math.hypot(2 * r1 + r0 + 3 * rf, 2 * x1 + x0);
        return zLg > 1e-6 ? ((3 * PEA_V_LN) / zLg) : 99999;
    }

    function solveUniformDistanceKmFromAmp(ampVal, faultType, cableKey, sourceKey, rfOhm, baseLineVec = null) {
        const I = parseFloat(ampVal);
        if (isNaN(I) || I <= 0) return { error: 'กรุณาระบุกระแสฟอลต์ (แอมป์) ให้มากกว่า 0' };
        const cab = PEA_22KV_CABLES[cableKey] || PEA_22KV_CABLES.SAC185;
        const src = PEA_SOURCE_BUS_PRESETS[sourceKey] || PEA_SOURCE_BUS_PRESETS.SUB_50MVA;
        const bv = baseLineVec || { r1: 0, x1: 0, r0: 0, x0: 0 };
        const rf = Math.max(0, parseFloat(rfOhm) || 0);

        const sr1 = src.rs1 + bv.r1, sx1 = src.xs1 + bv.x1, sr0 = src.rs0 + bv.r0, sx0 = src.xs0 + bv.x0;
        let reqZ = 0, rBase = 0, xBase = 0, rPerKm = 0, xPerKm = 0;
        if (faultType === '3P') {
            reqZ = PEA_V_LN / I; rBase = sr1 + rf; xBase = sx1; rPerKm = cab.r1; xPerKm = cab.x1;
        } else if (faultType === 'LL') {
            reqZ = PEA_V_LL / I; rBase = 2 * sr1 + rf; xBase = 2 * sx1; rPerKm = 2 * cab.r1; xPerKm = 2 * cab.x1;
        } else {
            reqZ = (3 * PEA_V_LN) / I; rBase = 2 * sr1 + sr0 + 3 * rf; xBase = 2 * sx1 + sx0;
            rPerKm = 2 * cab.r1 + cab.r0; xPerKm = 2 * cab.x1 + cab.x0;
        }

        const zAtZero = Math.hypot(rBase, xBase);
        const maxPossibleAmp = Math.round((faultType === '3P' ? PEA_V_LN : (faultType === 'LG' ? 3 * PEA_V_LN : PEA_V_LL)) / Math.max(0.05, zAtZero));
        if (reqZ <= zAtZero) return { km: 0.03, clampedNearBus: true, maxPossibleAmp };

        const a = rPerKm * rPerKm + xPerKm * xPerKm;
        const b = 2 * (rBase * rPerKm + xBase * xPerKm);
        const c = (rBase * rBase + xBase * xBase) - (reqZ * reqZ);
        const L = (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
        return { km: Number(Math.max(0.03, L).toFixed(2)), clampedNearBus: false, maxPossibleAmp };
    }

    function injectFaultLocatorStyles() {
        if (document.getElementById('peaScadaFaultLocatorCss') || !document.head) return;
        const st = document.createElement('style');
        st.id = 'peaScadaFaultLocatorCss';
        st.textContent = `
            @keyframes peaFaultTargetPulse { 0% { transform: scale(0.85); opacity: 0.95; } 70%, 100% { transform: scale(1.55); opacity: 0; } }
            #labeledInteractiveMap.scada-draw-cursor .leaflet-scadaFaultLocatorPane-pane *,
            #labeledInteractiveMap.scada-move-wire-active .leaflet-scadaFaultLocatorPane-pane *,
            #labeledInteractiveMap.scada-move-pin-active .leaflet-scadaFaultLocatorPane-pane * { pointer-events: none !important; }
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

    function openFaultLineShareSafe(text) {
        const lineUrl = 'https://line.me/R/share?text=' + encodeURIComponent(text);
        const win = window.open(lineUrl, '_blank');
        if (!win && !window.PeaCore?.isEmbeddedIframe) window.location.href = lineUrl;
    }

    function normGrp(raw) {
        if (typeof window.normalizePeaGroupName === 'function') return window.normalizePeaGroupName(raw) || '';
        let g = String(raw || '').trim().replace(/\s+/g, ' ');
        g = g.replace(/^(กฟ[ก-ฮ]{1,2})\.\s+/, '$1.').replace(/^(กฟ[สฟจตอยภผกนฉ])\s+/, '$1.').replace(/^(กฟ[สฟจตอยภผกนฉ])(?![.\s]|[ก-ฮ]\.|$)/, '$1.');
        return g.trim();
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

    function slicePolylineUpToKm(pts, targetKm) {
        if (!pts?.length) return { path: [], point: [0, 0] };
        if (pts.length === 1 || targetKm <= 0) return { path: [pts[0]], point: pts[0] };
        const out = [pts[0]];
        let acc = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            const seg = haversineKm(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
            if (acc + seg >= targetKm) {
                const t = seg > 1e-9 ? Math.max(0, Math.min(1, (targetKm - acc) / seg)) : 0;
                const pt = [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])];
                out.push(pt);
                return { path: out, point: pt };
            }
            out.push(pts[i + 1]);
            acc += seg;
        }
        return { path: out, point: pts[pts.length - 1] };
    }

    function slicePolylineBetweenKm(pts, startKm, endKm) {
        if (!pts || pts.length < 2 || endKm <= startKm) return [];
        const pStart = slicePolylineUpToKm(pts, startKm).point, pEnd = slicePolylineUpToKm(pts, endKm).point;
        const out = [pStart];
        let acc = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            acc += haversineKm(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
            if (acc > startKm + 1e-5 && acc < endKm - 1e-5) out.push(pts[i + 1]);
        }
        out.push(pEnd);
        return out;
    }

    function isBarrierTerminalNode(pin, sourcePinId, stopAtOpenSwitch) {
        if (!pin || pin.id === sourcePinId) return false;
        const eqT = pin.scadaNode?.t || 'PIN';
        if (eqT === 'RC' || eqT === 'CB') return true;
        return Boolean(stopAtOpenSwitch && SWITCHABLE_TYPES.has(eqT) && (pin.scadaNode?.st || 'C') === 'O');
    }

    function buildCanonicalGeomSig(pts, idA, idB, fdStr) {
        const orderedPts = idA <= idB ? pts : [...pts].reverse();
        const geom = orderedPts.map((pt) => `${pt[0].toFixed(5)},${pt[1].toFixed(5)}`).join(';');
        return `${idA <= idB ? `${idA}__${idB}` : `${idB}__${idA}`}|${String(fdStr || '').toUpperCase()}|${geom}`;
    }

    function buildScadaGraphs(pins, pinMap, stopAtOpenSwitch, cableKey) {
        const adj = new Map(), fullPhysAdj = new Map(), physicalEdges = [];
        const seenPhysGeom = new Set(), seenActiveGeom = new Set();
        pins.forEach((p) => { adj.set(p.id, []); fullPhysAdj.set(p.id, []); });

        pins.forEach((p) => {
            (p.scadaLines || []).forEach((e, idx) => {
                const dst = pinMap.get(e?.to);
                if (!dst || dst.id === p.id) return;
                const fwdPts = [[Number(p.lat), Number(p.lon)], ...(e.w || []).map((w) => [Number(w[0]), Number(w[1])]), [Number(dst.lat), Number(dst.lon)]];
                let lenKm = 0;
                for (let i = 0; i < fwdPts.length - 1; i++) lenKm += haversineKm(fwdPts[i][0], fwdPts[i][1], fwdPts[i + 1][0], fwdPts[i + 1][1]);
                if (lenKm <= 0) return;

                const cabProf = resolveEdgeCableProfile(e, cableKey || 'SAC185');
                const geomSig = buildCanonicalGeomSig(fwdPts, p.id, dst.id, e.fd);
                if (!seenPhysGeom.has(geomSig)) {
                    seenPhysGeom.add(geomSig);
                    fullPhysAdj.get(p.id).push({ toId: dst.id, lenKm, cabProf });
                    fullPhysAdj.get(dst.id).push({ toId: p.id, lenKm, cabProf });
                }
                if (stopAtOpenSwitch && (e.off || e.manualNO === true || e.st === 'O')) return;
                if (seenActiveGeom.has(geomSig)) return;
                seenActiveGeom.add(geomSig);

                physicalEdges.push({ edgeId: `${p.id}__${idx}`, uId: p.id, vId: dst.id, fwdPts, revPts: [...fwdPts].reverse(), lenKm, edge: e, cabProf });
                adj.get(p.id).push({ toId: dst.id, lenKm, cabProf });
                adj.get(dst.id).push({ toId: p.id, lenKm, cabProf });
            });
        });
        return { adj, fullPhysAdj, physicalEdges };
    }
    // ===== จบพาทที่ 1 / 2 ของไฟล์ scada-fault-locator.js (v2.5) =====
        // ===== เริ่มพาทที่ 2 / 2 ของไฟล์ scada-fault-locator.js (วางต่อจากพาทที่ 1 / 2 จนจบไฟล์) =====
    function computeUpstreamFilterAndVector(sourcePinId, pins, pinMap, activeAdj, fullPhysAdj) {
        const zeroVec = { r1: 0, x1: 0, r0: 0, x0: 0 };
        const srcPin = pinMap.get(sourcePinId), srcT = srcPin?.scadaNode?.t || 'PIN';
        if (srcT === 'RC' || srcT === 'CB') return { blockedNodes: new Set(), blockedStartNeighbors: new Set(), upstreamVec: zeroVec, upstreamKm: 0 };

        const runDijkstra = (adjGraph, startId, ignoreOpenSw, skipNodeId = null) => {
            const dMap = new Map([[startId, 0]]), vMap = new Map([[startId, { ...zeroVec }]]), vis = new Set(), pq = [{ id: startId, d: 0 }];
            while (pq.length > 0) {
                pq.sort((a, b) => a.d - b.d);
                const { id: u, d: du } = pq.shift();
                if (vis.has(u)) continue;
                vis.add(u);
                if (u !== startId) {
                    const uP = pinMap.get(u), eqT = uP?.scadaNode?.t || 'PIN', st = uP?.scadaNode?.st || 'C';
                    if (eqT === 'RC' || eqT === 'CB') continue;
                    if (!ignoreOpenSw && SWITCHABLE_TYPES.has(eqT) && st === 'O') continue;
                }
                const uVec = vMap.get(u) || zeroVec;
                (adjGraph.get(u) || []).forEach((nb) => {
                    if (nb.toId === skipNodeId) return;
                    const nbP = pinMap.get(nb.toId), nbT = nbP?.scadaNode?.t || 'PIN', nbSt = nbP?.scadaNode?.st || 'C';
                    if (!ignoreOpenSw && nbT !== 'RC' && nbT !== 'CB' && SWITCHABLE_TYPES.has(nbT) && nbSt === 'O') return;
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

        const breakers = pins.filter((p) => p.id !== sourcePinId && (p.scadaNode?.t === 'RC' || p.scadaNode?.t === 'CB'));
        if (!breakers.length) return { blockedNodes: new Set(), blockedStartNeighbors: new Set(), upstreamVec: zeroVec, upstreamKm: 0 };

        let useGraph = activeAdj, ignoreOpen = false;
        let resFromSrc = runDijkstra(useGraph, sourcePinId, false, null);
        let rootPool = breakers.filter((b) => resFromSrc.dMap.has(b.id));
        if (!rootPool.length) {
            useGraph = fullPhysAdj; ignoreOpen = true;
            resFromSrc = runDijkstra(useGraph, sourcePinId, true, null);
            rootPool = breakers.filter((b) => resFromSrc.dMap.has(b.id));
        }
        if (!rootPool.length) return { blockedNodes: new Set(), blockedStartNeighbors: new Set(), upstreamVec: zeroVec, upstreamKm: 0 };

        const srcFd = String(srcPin?.scadaNode?.fd || '').trim().toUpperCase();
        rootPool.sort((a, b) => {
            const aClosed = (a.scadaNode?.st || 'C') !== 'O' ? 1 : 0, bClosed = (b.scadaNode?.st || 'C') !== 'O' ? 1 : 0;
            const aFd = (srcFd && String(a.scadaNode?.fd || '').trim().toUpperCase() === srcFd) ? 1 : 0;
            const bFd = (srcFd && String(b.scadaNode?.fd || '').trim().toUpperCase() === srcFd) ? 1 : 0;
            return (bFd - aFd) || (bClosed - aClosed) || ((resFromSrc.dMap.get(a.id) ?? Infinity) - (resFromSrc.dMap.get(b.id) ?? Infinity));
        });

        const parentBrk = rootPool[0];
        const withSrc = runDijkstra(useGraph, parentBrk.id, ignoreOpen, null);
        const withoutSrc = runDijkstra(useGraph, parentBrk.id, ignoreOpen, sourcePinId);
        const srcDistFromBrk = withSrc.dMap.get(sourcePinId) ?? 0;
        const upstreamVec = withSrc.vMap.get(sourcePinId) || zeroVec;
        const blockedNodes = new Set([parentBrk.id]), blockedStartNeighbors = new Set();

        (useGraph.get(sourcePinId) || []).forEach((nb) => {
            const nbDist = withoutSrc.dMap.get(nb.toId);
            if (nbDist !== undefined && nbDist + nb.lenKm <= srcDistFromBrk + 0.02) { blockedStartNeighbors.add(nb.toId); blockedNodes.add(nb.toId); }
        });
        const hasDownstreamLeft = (activeAdj.get(sourcePinId) || []).some((nb) => !blockedStartNeighbors.has(nb.toId));
        return hasDownstreamLeft
            ? { blockedNodes, blockedStartNeighbors, upstreamVec, upstreamKm: srcDistFromBrk }
            : { blockedNodes: new Set(), blockedStartNeighbors: new Set(), upstreamVec, upstreamKm: srcDistFromBrk };
    }

    function findAmpHitDistanceOnSpan(vecStart, cabProfile, spanLimitKm, targetAmp, faultType, srcBus, rfOhm, allowClampOrigin) {
        const addSpanVec = (km) => ({
            r1: vecStart.r1 + cabProfile.r1 * km, x1: vecStart.x1 + cabProfile.x1 * km,
            r0: vecStart.r0 + cabProfile.r0 * km, x0: vecStart.x0 + cabProfile.x0 * km
        });
        const iStart = calcFaultCurrentAtVector(vecStart, faultType, srcBus, rfOhm);
        const iEnd = calcFaultCurrentAtVector(addSpanVec(spanLimitKm), faultType, srcBus, rfOhm);
        if (targetAmp > iStart) {
            return allowClampOrigin ? { hit: true, deltaKm: Math.min(0.02, spanLimitKm * 0.5) } : { hit: false, exceedsOriginAmp: iStart };
        }
        if (targetAmp < iEnd) return { hit: false, minAmpAtEnd: iEnd };
        let lo = 0, hi = spanLimitKm;
        for (let iter = 0; iter < 24; iter++) {
            const mid = (lo + hi) / 2;
            if (calcFaultCurrentAtVector(addSpanVec(mid), faultType, srcBus, rfOhm) > targetAmp) lo = mid; else hi = mid;
        }
        return { hit: true, deltaKm: (lo + hi) / 2 };
    }

    function traceFaultLocations(sourcePinId, targetKm, tolKm, stopAtOpenSwitch, downstreamOnly, ampCalcCfg = null) {
        const pins = getVisibleScadaPins(), pinMap = new Map(pins.map((p) => [p.id, p]));
        const srcPin = pinMap.get(sourcePinId);
        if (!srcPin) return { error: 'ไม่พบหมุดต้นทางที่เลือกในผัง' };

        const { adj, fullPhysAdj, physicalEdges } = buildScadaGraphs(pins, pinMap, stopAtOpenSwitch, ampCalcCfg?.cableKey || 'SAC185');
        const upInfo = computeUpstreamFilterAndVector(sourcePinId, pins, pinMap, adj, fullPhysAdj);
        const upFilter = downstreamOnly ? upInfo : { blockedNodes: new Set(), blockedStartNeighbors: new Set() };
        const useUpstreamZ = Boolean(ampCalcCfg && ampCalcCfg.sourceKey !== 'IDEAL_ZERO');
        const initVec = useUpstreamZ ? upInfo.upstreamVec : { r1: 0, x1: 0, r0: 0, x0: 0 };

        const dist = new Map([[sourcePinId, 0]]), vecMap = new Map([[sourcePinId, { ...initVec }]]);
        const parentMap = new Map(), visited = new Set(), pq = [{ id: sourcePinId, d: 0 }];

        while (pq.length > 0) {
            pq.sort((a, b) => a.d - b.d);
            const { id: u, d: du } = pq.shift();
            if (visited.has(u)) continue;
            visited.add(u);
            if (isBarrierTerminalNode(pinMap.get(u), sourcePinId, stopAtOpenSwitch)) continue;
            const uVec = vecMap.get(u) || initVec;
            (adj.get(u) || []).forEach((nb) => {
                if ((u === sourcePinId && upFilter.blockedStartNeighbors.has(nb.toId)) || upFilter.blockedNodes.has(nb.toId)) return;
                if (isBarrierTerminalNode(pinMap.get(nb.toId), sourcePinId, stopAtOpenSwitch)) return;
                const nd = du + nb.lenKm;
                if (nd < (dist.get(nb.toId) ?? Infinity)) {
                    dist.set(nb.toId, nd);
                    vecMap.set(nb.toId, {
                        r1: uVec.r1 + nb.cabProf.r1 * nb.lenKm, x1: uVec.x1 + nb.cabProf.x1 * nb.lenKm,
                        r0: uVec.r0 + nb.cabProf.r0 * nb.lenKm, x0: uVec.x0 + nb.cabProf.x0 * nb.lenKm
                    });
                    parentMap.set(nb.toId, { prevId: u, segKm: nb.lenKm });
                    pq.push({ id: nb.toId, d: nd });
                }
            });
        }

        const useMultiCableAmp = Boolean(ampCalcCfg && ampCalcCfg.ampVal > 0);
        const srcBus = ampCalcCfg ? (PEA_SOURCE_BUS_PRESETS[ampCalcCfg.sourceKey] || PEA_SOURCE_BUS_PRESETS.SUB_50MVA) : null;
        const maxOriginAmp = useMultiCableAmp ? Math.round(calcFaultCurrentAtVector(initVec, ampCalcCfg.faultType, srcBus, ampCalcCfg.rfOhm)) : 0;
        const allowClampAtRoot = !useUpstreamZ || upInfo.upstreamKm <= 0.05;
        const tracedSegments = [], candidates = [];
        let maxReachKm = 0, furthestPin = srcPin, minEndFaultAmp = Infinity, exceededMidSwitchAmp = false;
        dist.forEach((dVal, pid) => { if (dVal > maxReachKm) { maxReachKm = dVal; furthestPin = pinMap.get(pid) || srcPin; } });

        const evaluateDirectedSpan = (fromId, toId, pts, fullWireLenKm, spanLimitKm, edgeObj, cabProf) => {
            if (spanLimitKm <= 1e-6 || (fromId === sourcePinId && upFilter.blockedStartNeighbors.has(toId))) return;
            const du = dist.get(fromId);
            if (du === undefined) return;
            const endKm = du + spanLimitKm, dstPin = pinMap.get(toId);
            if (endKm > maxReachKm) { maxReachKm = endKm; furthestPin = dstPin || furthestPin; }
            const spanPts = spanLimitKm < fullWireLenKm - 1e-5 ? slicePolylineUpToKm(pts, spanLimitKm).path : pts;

            let hitDeltaKm = null;
            if (useMultiCableAmp) {
                const uVec = vecMap.get(fromId) || initVec;
                const ampCheck = findAmpHitDistanceOnSpan(uVec, cabProf, spanLimitKm, ampCalcCfg.ampVal, ampCalcCfg.faultType, srcBus, ampCalcCfg.rfOhm, fromId === sourcePinId && allowClampAtRoot);
                if (!ampCheck.hit) {
                    if (ampCheck.exceedsOriginAmp && fromId === sourcePinId) exceededMidSwitchAmp = true;
                    if (ampCheck.minAmpAtEnd !== undefined) {
                        if (ampCheck.minAmpAtEnd < minEndFaultAmp) minEndFaultAmp = ampCheck.minAmpAtEnd;
                        if (spanPts.length >= 2) tracedSegments.push(spanPts);
                    }
                    return;
                }
                hitDeltaKm = ampCheck.deltaKm;
            } else {
                if (endKm < targetKm) { if (spanPts.length >= 2) tracedSegments.push(spanPts); return; }
                if (!(du < targetKm && targetKm <= endKm)) return;
                hitDeltaKm = targetKm - du;
            }

            const sliced = slicePolylineUpToKm(pts, hitDeltaKm);
            if (sliced.path.length >= 2) tracedSegments.push(sliced.path);
            const candLat = Number(sliced.point[0].toFixed(6)), candLon = Number(sliced.point[1].toFixed(6));
            if (candidates.some((ex) => haversineKm(ex.lat, ex.lon, candLat, candLon) < 0.0008)) return;

            let refPin = pinMap.get(fromId), refOffsetKm = hitDeltaKm, walkId = fromId, guard = 0;
            while (isNodeTTap(refPin, pins) && parentMap.has(walkId) && guard++ < 40) {
                const pInfo = parentMap.get(walkId);
                refOffsetKm += pInfo.segKm; walkId = pInfo.prevId; refPin = pinMap.get(walkId) || refPin;
            }
            candidates.push({
                lat: candLat, lon: candLon,
                totalActualKm: Number((du + hitDeltaKm).toFixed(2)),
                refPinName: refPin ? refPin.name : '-',
                refOffsetMeters: Math.round(refOffsetKm * 1000),
                towardName: resolveRealDestinationName(toId, fromId, pinMap, adj, pins),
                spec: edgeObj.lb || (edgeObj.st === 'ug' ? 'เคเบิลใต้ดิน' : cabProf.label),
                tolZonePath: tolKm > 0 ? slicePolylineBetweenKm(pts, Math.max(0, hitDeltaKm - tolKm), Math.min(fullWireLenKm, hitDeltaKm + tolKm)) : []
            });
        };

        physicalEdges.forEach((er) => {
            if (upFilter.blockedNodes.has(er.uId) || upFilter.blockedNodes.has(er.vId)) return;
            const hasU = dist.has(er.uId) && !isBarrierTerminalNode(pinMap.get(er.uId), sourcePinId, stopAtOpenSwitch);
            const hasV = dist.has(er.vId) && !isBarrierTerminalNode(pinMap.get(er.vId), sourcePinId, stopAtOpenSwitch);
            if (hasU && hasV) {
                const du = dist.get(er.uId), dv = dist.get(er.vId), L = er.lenKm;
                const splitFromU = Math.max(0, Math.min(L, (dv - du + L) / 2)), splitFromV = L - splitFromU;
                if (splitFromU > 1e-5) evaluateDirectedSpan(er.uId, er.vId, er.fwdPts, L, splitFromU, er.edge, er.cabProf);
                if (splitFromV > 1e-5) evaluateDirectedSpan(er.vId, er.uId, er.revPts, L, splitFromV, er.edge, er.cabProf);
            } else if (hasU && !hasV) evaluateDirectedSpan(er.uId, er.vId, er.fwdPts, er.lenKm, er.lenKm, er.edge, er.cabProf);
            else if (!hasU && hasV) evaluateDirectedSpan(er.vId, er.uId, er.revPts, er.lenKm, er.lenKm, er.edge, er.cabProf);
        });

        return { srcPin, targetKm, tolKm, tracedSegments, candidates, maxReachKm, furthestPin, ampCalcCfg, minEndFaultAmp, upstreamKm: useUpstreamZ ? upInfo.upstreamKm : 0, exceededMidSwitchAmp, maxOriginAmp };
    }

    function clearFaultLocatorOverlay() {
        faultLayerGroup?.clearLayers();
        lastFaultResult = null;
        const resBox = document.getElementById('scadaFaultResultBox');
        if (resBox) { resBox.innerHTML = ''; resBox.classList.add('hidden'); }
    }

    function resetFaultLocatorInputs(silent = false) {
        activePacketApplySeq++;
        try { localStorage.removeItem(FAULT_PKT_KEY); } catch (e) {}
        ['scadaFaultKmInput', 'scadaFaultAmpInput', 'scadaFaultRfInput'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const phSel = document.getElementById('scadaFaultPhaseSelect');
        if (phSel) phSel.value = 'LL';
        const tolSel = document.getElementById('scadaFaultTolSelect');
        if (tolSel) tolSel.value = '0.15';
        saveCalcPrefs({ faultType: 'LL', rfOhm: 0 });

        const hintEl = document.getElementById('scadaFaultAmpCalcBadge');
        if (hintEl) {
            hintEl.textContent = DEFAULT_AMP_HINT_TEXT;
            hintEl.className = 'text-[10.5px] text-slate-400';
        }
        clearFaultLocatorOverlay();
        if (!silent) window.showToast?.('🧹 ล้างค่าคำนวณและหมุดชี้เป้าฟอลต์เรียบร้อยแล้ว');
    }

    function clearQuickFaultLocatorFromMainForm(silent = false) {
        ['tab1QuickFaultAmpInput', 'tab1QuickFaultKmInput'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const typeSel = document.getElementById('tab1QuickFaultTypeSelect');
        if (typeSel) typeSel.value = 'AUTO';
        try { localStorage.removeItem(FAULT_PKT_KEY); } catch (e) {}

        const clearPkt = { type: 'SCADA_CLEAR_FAULT_LOCATOR', ts: Date.now() };
        try { faultBc?.postMessage(clearPkt); } catch (e) {}
        try { document.getElementById('leftBrowserIframe')?.contentWindow?.postMessage(clearPkt, '*'); } catch (e) {}
        if (!silent) window.showToast?.('🧹 ล้างค่าชี้เป้าฟอลต์เรียบร้อยแล้ว');
    }

    function populateFaultSourceDropdown(preferFeeder = '', preferDevice = '', preferStation = '') {
        const sel = document.getElementById('scadaFaultSourceSelect');
        if (!sel) return { unmatchedDeviceHint: '' };
        const hasPrefer = Boolean(preferFeeder || preferDevice || preferStation);

        if (!hasPrefer && document.activeElement === sel && sel.options.length > 0) {
            return { unmatchedDeviceHint: '' };
        }

        const pins = getVisibleScadaPins(), prevVal = sel.value, wiredIds = new Set();
        pins.forEach((p) => (p.scadaLines || []).forEach((l) => { if (l?.to && l.to !== p.id) { wiredIds.add(p.id); wiredIds.add(l.to); } }));

        const breakers = [], switches = [], wiredPlainPins = [];
        pins.forEach((p) => {
            const t = p.scadaNode?.t || 'PIN';
            if (t === 'RC' || t === 'CB') breakers.push(p);
            else if (['VB', 'VS', 'VSC', 'S', 'DF', 'GEN'].includes(t)) switches.push(p);
            else if (wiredIds.has(p.id) && !isNodeTTap(p, pins)) wiredPlainPins.push(p);
        });
        const allCandidates = [...breakers, ...switches, ...wiredPlainPins];
        const opts = [
            ...breakers.map((b) => `<option value="${escHtml(b.id)}">■ [CB] ${escHtml(b.name)}${b.scadaNode?.fd ? ` (${escHtml(b.scadaNode.fd)})` : ''}</option>`),
            ...switches.map((s) => `<option value="${escHtml(s.id)}">${s.scadaNode?.t === 'VB' ? '▣' : '⚡'} [${escHtml(s.scadaNode?.t)}] ${escHtml(s.name)}</option>`),
            ...wiredPlainPins.map((wp) => `<option value="${escHtml(wp.id)}">📍 [หมุด] ${escHtml(wp.name)}</option>`)
        ];
        const nextOptsHtml = opts.length ? opts.join('') : '<option value="">-- ยังไม่มีหมุดที่เชื่อมสายไฟในผัง --</option>';

        if (sel.__lastOptsHtml !== nextOptsHtml || sel.options.length === 0) {
            sel.innerHTML = nextOptsHtml;
            sel.__lastOptsHtml = nextOptsHtml;
            if (prevVal && allCandidates.some((p) => p.id === prevVal)) sel.value = prevVal;
        }

        let unmatchedDeviceHint = '';
        const devClean = String(preferDevice || '').replace(/\(ID[^)]*\)/gi, '').trim().toLowerCase();
        if (devClean.length >= 2) {
            const exact = allCandidates.find((p) => String(p.name || '').trim().toLowerCase() === devClean || String(p.scadaNode?.id || '').trim().toLowerCase() === devClean);
            if (exact) { sel.value = exact.id; return { unmatchedDeviceHint: '' }; }
            const devRe = new RegExp(`(?:^|[^a-z0-9])${escapeRe(devClean)}(?![0-9])`, 'i');
            const bHit = allCandidates.find((p) => devRe.test(String(p.name || '').trim()));
            if (bHit) { sel.value = bHit.id; return { unmatchedDeviceHint: '' }; }
            const revHit = allCandidates.filter((p) => String(p.name || '').trim().length >= 4).sort((a, b) => String(b.name || '').length - String(a.name || '').length)
                .find((p) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(String(p.name || '').trim())}(?![0-9])`, 'i').test(devClean));
            if (revHit) { sel.value = revHit.id; return { unmatchedDeviceHint: '' }; }
            unmatchedDeviceHint = preferDevice.trim();
        }
        if (preferFeeder) {
            const numM = String(preferFeeder).match(/(\d+)\s*$/), fNum = numM ? parseInt(numM[1], 10) : null;
            const cleanFd = String(preferFeeder).trim().toUpperCase().replace(/\s+/g, '');
            const stPrefix = (String(preferStation || '').toUpperCase().match(/[A-Z]{2,4}/) || [''])[0];
            const pool = breakers.length > 0 ? breakers : allCandidates;
            const scored = pool.map((b) => {
                const bFd = String(b.scadaNode?.fd || '').toUpperCase().replace(/\s+/g, ''), bTxt = `${bFd} ${b.name || ''} ${b.note || ''}`.toUpperCase();
                let score = (bFd && bFd === cleanFd) ? 120 : 0;
                if (fNum !== null) {
                    const fdM = Array.from(bTxt.matchAll(/(?:\b(?!KV)[A-Z]{2,4}\s*F?\s*0*(\d+)|\bF\s*0*(\d+)|วงจร\s*0*(\d+))(?![0-9]|KV)/gi));
                    if (fdM.some((m) => parseInt(m[1] || m[2] || m[3], 10) === fNum)) score += 65;
                    else if (Array.from(bTxt.matchAll(/\b(?:CB|RC)\s*-?\s*0*(\d+)(?![0-9])/gi)).some((m) => parseInt(m[1], 10) === fNum)) score += 45;
                }
                if (stPrefix && bTxt.includes(stPrefix)) score += 30;
                if (preferStation && `${b.name || ''} ${b.note || ''}`.includes(preferStation.trim())) score += 25;
                return { b, score };
            }).filter((x) => x.score >= 45).sort((a, b) => b.score - a.score);
            if (scored.length > 0) { sel.value = scored[0].b.id; return { unmatchedDeviceHint }; }
        }
        if (prevVal && allCandidates.some((p) => p.id === prevVal) && sel.value !== prevVal) sel.value = prevVal;
        return { unmatchedDeviceHint };
    }

    function getSelectedSourceUpstreamQuick(srcId, cableKey, stopOpen) {
        if (!srcId) return { upstreamVec: { r1: 0, x1: 0, r0: 0, x0: 0 }, upstreamKm: 0 };
        const pins = getVisibleScadaPins(), pinMap = new Map(pins.map((p) => [p.id, p]));
        if (!pinMap.has(srcId)) return { upstreamVec: { r1: 0, x1: 0, r0: 0, x0: 0 }, upstreamKm: 0 };
        const { adj, fullPhysAdj } = buildScadaGraphs(pins, pinMap, stopOpen, cableKey);
        return computeUpstreamFilterAndVector(srcId, pins, pinMap, adj, fullPhysAdj);
    }

    function readPage2AmpCalcConfig(updateKmPreview = true) {
        const ampRaw = parseFloat(document.getElementById('scadaFaultAmpInput')?.value || '');
        const faultType = document.getElementById('scadaFaultPhaseSelect')?.value || 'LL';
        const cableKey = document.getElementById('scadaFaultCableSelect')?.value || 'SAC185';
        const sourceKey = document.getElementById('scadaFaultSubZSelect')?.value || 'SUB_50MVA';
        const rfOhm = Math.max(0, parseFloat(document.getElementById('scadaFaultRfInput')?.value || '0') || 0);
        saveCalcPrefs({ faultType, cableKey, sourceKey, rfOhm });
        if (isNaN(ampRaw) || ampRaw <= 0) return null;

        const srcId = document.getElementById('scadaFaultSourceSelect')?.value || '';
        const stopOpen = document.getElementById('scadaFaultStopOpenChk')?.checked !== false;
        const upQuick = sourceKey !== 'IDEAL_ZERO' ? getSelectedSourceUpstreamQuick(srcId, cableKey, stopOpen) : { upstreamVec: null, upstreamKm: 0 };
        const solved = solveUniformDistanceKmFromAmp(ampRaw, faultType, cableKey, sourceKey, rfOhm, upQuick.upstreamVec);
        if (solved.error) return null;
        const exceedsMidSwitch = Boolean(solved.clampedNearBus && upQuick.upstreamKm > 0.05);
        if (updateKmPreview) {
            const kmInp = document.getElementById('scadaFaultKmInput');
            if (kmInp) kmInp.value = exceedsMidSwitch ? '' : String(solved.km);
            const tolSel = document.getElementById('scadaFaultTolSelect');
            if (tolSel && faultType === 'LG' && parseFloat(tolSel.value) < 0.3) tolSel.value = '0.30';
        }
        return { ampVal: ampRaw, faultType, cableKey, sourceKey, rfOhm, approxUniformKm: solved.km, clampedNearBus: solved.clampedNearBus, exceedsMidSwitch, maxPossibleAmp: solved.maxPossibleAmp, upstreamKm: upQuick.upstreamKm };
    }

    function onFaultKmManualInput() {
        const ampEl = document.getElementById('scadaFaultAmpInput');
        if (ampEl) ampEl.value = '';
        onFaultAmpParamsChanged(false);
    }

    function onFaultAmpParamsChanged(triggerSearch = false) {
        const cfg = readPage2AmpCalcConfig(true);
        const hintEl = document.getElementById('scadaFaultAmpCalcBadge');
        if (hintEl) {
            if (!cfg) {
                hintEl.textContent = DEFAULT_AMP_HINT_TEXT;
                hintEl.className = 'text-[10.5px] text-slate-400';
            } else if (cfg.exceedsMidSwitch) {
                hintEl.textContent = `⚠️ กระแส ${cfg.ampVal.toLocaleString()} แอมป์ สูงกว่าพิกัดลัดวงจร ณ หมุดนี้ (~${cfg.maxPossibleAmp.toLocaleString()} แอมป์) • จุดช็อตอยู่ฝั่งต้นสายก่อนถึงหมุดนี้`;
                hintEl.className = 'text-[10.5px] text-amber-300 font-bold';
            } else if (cfg.clampedNearBus) {
                hintEl.textContent = `⚡ กระแส ${cfg.ampVal.toLocaleString()} แอมป์ สูงระดับหน้าบัสสถานี (สูงสุด ~${cfg.maxPossibleAmp.toLocaleString()} แอมป์) ➔ ชี้เป้าต้นสาย`;
                hintEl.className = 'text-[10.5px] text-amber-300 font-bold';
            } else {
                const fLabel = cfg.faultType === 'LG' ? 'ลงดิน 1 เฟส' : (cfg.faultType === '3P' ? 'ช็อต 3 เฟส' : 'ช็อต 2 เฟส');
                const upTxt = cfg.upstreamKm > 0.05 ? ` • หักสายต้นน้ำ ${cfg.upstreamKm.toFixed(2)} กม. แล้ว` : '';
                hintEl.textContent = `⚡ ${cfg.ampVal.toLocaleString()} แอมป์ (${fLabel}) ≈ เลยหมุดนี้ไป ${cfg.approxUniformKm.toFixed(2)} กม.${upTxt}`;
                hintEl.className = 'text-[10.5px] text-emerald-300 font-bold';
            }
        }
        if (triggerSearch && cfg) executeFaultDistanceSearch(0, 'amp');
    }

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
                name: `🎯 เป้าฟอลต์ #${idx + 1} (เลย ${c.refPinName} ${offTxt})`,
                note: `ระยะ ${c.totalActualKm.toFixed(2)} กม. มุ่งหน้า ${c.towardName}`,
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
            if (retryCount >= 12) return window.showToast?.('⚠️ แผนที่ยังไม่พร้อมใช้งาน กรุณากดชี้เป้าอีกครั้ง');
            if (retryCount === 0 && typeof window.switchTechMainTab === 'function') window.switchTechMainTab('map');
            setTimeout(() => executeFaultDistanceSearch(retryCount + 1, modeHint), 250);
            return;
        }

        const sel = document.getElementById('scadaFaultSourceSelect');
        if (sel && (!sel.options.length || !sel.value)) populateFaultSourceDropdown();
        const srcId = sel?.value || '';
        const hasAmpTyped = parseFloat(document.getElementById('scadaFaultAmpInput')?.value || '') > 0;
        const ampCfg = (modeHint === 'km' || !hasAmpTyped) ? null : readPage2AmpCalcConfig(modeHint === 'amp' || !document.getElementById('scadaFaultKmInput')?.value);
        const distVal = parseFloat(document.getElementById('scadaFaultKmInput')?.value || '');
        const tolVal = parseFloat(document.getElementById('scadaFaultTolSelect')?.value || '0.15') || 0;
        const stopOpen = document.getElementById('scadaFaultStopOpenChk')?.checked !== false;
        const downstreamOnly = document.getElementById('scadaFaultDownstreamChk')?.checked !== false;

        if (!srcId) return window.showToast?.('⚠️ กรุณาตั้งค่าหมุด ■ CB หรือลากสายเชื่อมหมุดต้นทางในผังก่อนครับ');
        if (!ampCfg && (isNaN(distVal) || distVal <= 0)) {
            return window.showToast?.('⚠️ กรุณากรอก "ระยะ กม." หรือ "กระแสฟอลต์ (แอมป์)" อย่างใดอย่างหนึ่งก่อนกดชี้เป้าครับ');
        }

        if (document.getElementById('btnToggleScadaLines')?.textContent?.includes('ซ่อน')) window.toggleScadaLinesVisibility?.();
        const allColorBtn = document.getElementById('colorFilterBtn-all');
        if (allColorBtn && !allColorBtn.className.includes('bg-slate-800')) window.selectEquipPinColorFilter?.('all');
        const fdFilterEl = document.getElementById('scadaFeederFilterSelect');
        const checkSrcPin = getVisibleScadaPins().find((p) => p.id === srcId);
        if (fdFilterEl && fdFilterEl.value !== 'ALL' && fdFilterEl.value !== (checkSrcPin?.scadaNode?.fd || '')) {
            fdFilterEl.value = 'ALL'; window.onScadaFeederFilterChange?.('ALL');
        }

        faultLayerGroup.clearLayers();
        const effectiveKm = ampCfg ? ampCfg.approxUniformKm : distVal;
        const res = traceFaultLocations(srcId, effectiveKm, tolVal, stopOpen, downstreamOnly, ampCfg);
        if (res.error) return window.showToast?.('⚠️ ' + res.error);
        lastFaultResult = res;

        const bounds = [[Number(res.srcPin.lat), Number(res.srcPin.lon)]];
        res.tracedSegments.forEach((seg) => {
            if (seg.length < 2) return;
            L.polyline(seg, { pane: 'scadaFaultLocatorPane', color: '#f43f5e', weight: 6, opacity: 0.42, interactive: false }).addTo(faultLayerGroup);
            L.polyline(seg, { pane: 'scadaFaultLocatorPane', color: '#fbbf24', weight: 2.6, dashArray: '6, 5', opacity: 0.95, interactive: false }).addTo(faultLayerGroup);
        });

        res.candidates.forEach((c, idx) => {
            bounds.push([c.lat, c.lon]);
            if (c.tolZonePath?.length >= 2) L.polyline(c.tolZonePath, { pane: 'scadaFaultLocatorPane', color: '#ef4444', weight: 10, opacity: 0.35, interactive: false }).addTo(faultLayerGroup);
            const badgeNo = idx + 1, offsetStr = c.refOffsetMeters >= 1000 ? `${(c.refOffsetMeters / 1000).toFixed(2)} กม.` : `${c.refOffsetMeters} เมตร`;
            const ampTag = ampCfg ? ` (${ampCfg.ampVal.toLocaleString()} แอมป์)` : '';
            const icon = L.divIcon({
                className: '',
                html: `<div style="position:relative;width:38px;height:38px;display:flex;align-items:center;justify-content:center;"><div style="position:absolute;inset:0;border-radius:9999px;background:rgba(239,68,68,0.32);border:2px solid #ef4444;animation:peaFaultTargetPulse 1.2s infinite ease-out;"></div><div style="position:relative;z-index:2;background:#dc2626;color:#fff;border:2px solid #fde047;border-radius:9999px;padding:1px 6px;font-size:11px;font-weight:900;box-shadow:0 3px 10px rgba(0,0,0,0.55);">🎯#${badgeNo}</div></div>`,
                iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -16]
            });
            L.marker([c.lat, c.lon], { icon, pane: 'scadaFaultLocatorPane' }).addTo(faultLayerGroup).bindPopup(
                `<div style="font-family:'Prompt',sans-serif;min-width:245px;" class="space-y-1.5 text-xs">` +
                `<div class="bg-rose-600 text-white px-2 py-1 rounded-lg font-extrabold flex justify-between"><span>🎯 จุดคาดการณ์ฟอลต์ #${badgeNo}</span><span>${c.totalActualKm.toFixed(2)} กม.${escHtml(ampTag)}</span></div>` +
                `<div class="font-bold text-slate-800">📍 เลย <u>${escHtml(c.refPinName)}</u> ไป ${offsetStr}</div>` +
                `<div class="text-[11px] text-slate-600">➡️ มุ่งหน้า: <b>${escHtml(c.towardName)}</b> (${escHtml(c.spec)})</div>` +
                `<div class="text-[10px] text-slate-400">${c.lat}, ${c.lon}</div>` +
                `<div class="pt-1 flex gap-1.5"><button type="button" onclick="navigateToFaultCandidate(${idx})" style="background:#2563eb;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;flex:1;">🚗 นำทาง Maps</button><button type="button" onclick="shareFaultLocatorReportToLine()" style="background:#00B900;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;flex:1;">💬 ส่ง LINE</button></div></div>`
            );
        });

        const resBox = document.getElementById('scadaFaultResultBox');
        if (resBox) {
            resBox.classList.remove('hidden');
            const lgNotice = ampCfg?.faultType === 'LG'
                ? `<div class="px-2 py-1 bg-amber-950/70 border border-amber-400/40 rounded-lg text-[10px] text-amber-200">💡 <b>ฟอลต์ลงดิน 1 เฟส:</b> หากกิ่งไม้/ดินมีความต้านทานแฝง จุดเกิดเหตุจริงอาจอยู่<b>ใกล้เข้ามาทางต้นสาย</b>มากกว่าจุดที่มาร์ค</div>` : '';
            if (res.candidates.length === 0) {
                if (res.exceededMidSwitchAmp) {
                    resBox.innerHTML = `<div class="p-2 bg-amber-950/80 border border-amber-400/50 rounded-xl text-amber-200 text-[11px]">⚠️ กระแส <b>${ampCfg.ampVal.toLocaleString()} แอมป์</b> สูงกว่ากระแสลัดวงจรสูงสุด ณ จุด <b>${escHtml(res.srcPin.name)}</b> (~${res.maxOriginAmp.toLocaleString()} แอมป์) จุดเกิดเหตุน่าจะอยู่<b>ฝั่งต้นสายก่อนถึงหมุดนี้</b> (แนะนำเปลี่ยนหมุดต้นทางเป็น ■ CB หน้าสถานี)</div>`;
                } else {
                    const endAmpNote = (ampCfg && isFinite(res.minEndFaultAmp)) ? ` (กระแสลัดวงจรต่ำสุดที่ปลายผังคือ ~${Math.round(res.minEndFaultAmp).toLocaleString()} แอมป์)` : '';
                    resBox.innerHTML = res.maxReachKm <= 0.001
                        ? `<div class="p-2 bg-amber-950/80 border border-amber-400/50 rounded-xl text-amber-200 text-[11px]">⚠️ หมุด <b>${escHtml(res.srcPin.name)}</b> ยังไม่ได้ลากเส้นสายไฟเชื่อมเข้าผัง SCADA</div>`
                        : `<div class="p-2 bg-amber-950/80 border border-amber-400/50 rounded-xl text-amber-200 text-[11px]">⚠️ ระยะคำนวณเกินความยาวสายในผัง (สายยาวสุดจากจุดนี้ ${res.maxReachKm.toFixed(2)} กม. ถึงจุด ${escHtml(res.furthestPin?.name || '-')})${escHtml(endAmpNote)}</div>`;
                    if (res.furthestPin) bounds.push([Number(res.furthestPin.lat), Number(res.furthestPin.lon)]);
                }
            } else {
                const upNote = (ampCfg && res.upstreamKm > 0.05) ? ` • รวมสายต้นน้ำ ${res.upstreamKm.toFixed(2)} กม.` : '';
                const headTxt = ampCfg
                    ? `🎯 พบ ${res.candidates.length} จุดคาดการณ์ จากกระแส ${ampCfg.ampVal.toLocaleString()} แอมป์${upNote}`
                    : `🎯 พบ ${res.candidates.length} จุดคาดการณ์ตามแนวสาย (${effectiveKm.toFixed(2)} กม.)`;
                resBox.innerHTML = `${lgNotice}<div class="flex items-center justify-between text-[11px] text-rose-200 font-bold"><span>${escHtml(headTxt)}</span><button type="button" onclick="shareFaultLocatorReportToLine()" class="bg-[#00B900] text-white px-2 py-0.5 rounded-lg text-[10px] font-extrabold">💬 ส่งพิกัดเข้า LINE</button></div><div class="grid grid-cols-1 sm:grid-cols-2 gap-1 pt-1 max-h-28 overflow-y-auto">` +
                    res.candidates.map((c, i) => {
                        const offTxt = c.refOffsetMeters >= 1000 ? `${(c.refOffsetMeters / 1000).toFixed(2)} กม.` : `${c.refOffsetMeters} ม.`;
                        return `<button type="button" onclick="zoomToFaultCandidate(${i})" class="text-left px-2.5 py-1.5 rounded-lg bg-slate-950/90 hover:bg-slate-800 border border-rose-400/40 text-[10px] text-white truncate"><b class="text-amber-300">#${i + 1} (${c.totalActualKm.toFixed(2)} กม.)</b> เลย ${escHtml(c.refPinName)} (${offTxt}) ➔ ${escHtml(c.towardName)}</button>`;
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

    function shareFaultLocatorReportToLine() {
        if (!lastFaultResult?.candidates?.length) return window.showToast?.('⚠️ ยังไม่มีจุดคาดการณ์ฟอลต์สำหรับส่ง LINE');
        const r = lastFaultResult, ac = r.ampCalcCfg;
        const metricLine = ac
            ? `⚡ คำนวณจากกระแส 22kV : ${ac.ampVal.toLocaleString()} แอมป์ (${ac.faultType === 'LG' ? 'ลงดิน 1 เฟส' : (ac.faultType === '3P' ? 'ช็อต 3 เฟส' : 'ช็อต 2 เฟส')}${ac.rfOhm > 0 ? ` • ความต้านทานดิน ${ac.rfOhm} โอห์ม` : ''})`
            : `📏 ระยะฟอลต์จากรีเลย์ : ${r.targetKm.toFixed(2)} กม. (±${r.tolKm.toFixed(2)} กม.)`;
        const lines = [`🎯 ชี้เป้าจุดคาดการณ์ฟอลต์ตามแนวสาย SCADA`, `⚡ ต้นทางวัดระยะ : ${r.srcPin.name}${r.srcPin.scadaNode?.fd ? ` (${r.srcPin.scadaNode.fd})` : ''}`, metricLine, `━━━━━━━━━━━━━━━━━━`];
        r.candidates.forEach((c, i) => {
            const offTxt = c.refOffsetMeters >= 1000 ? `${(c.refOffsetMeters / 1000).toFixed(2)} กม.` : `${c.refOffsetMeters} เมตร`;
            lines.push(`${i + 1}) ระยะ ${c.totalActualKm.toFixed(2)} กม. — เลย ${c.refPinName} ไป ${offTxt} (มุ่งหน้า ${c.towardName})`, `   📍 https://www.google.com/maps?q=${c.lat},${c.lon}`);
        });
        const msg = lines.join('\n');
        window.copyTechText?.(msg, '💬 คัดลอกพิกัดคาดการณ์ฟอลต์แล้ว กำลังเปิด LINE...');
        openFaultLineShareSafe(msg);
    }

    async function toggleScadaFaultLocatorPanel(forceOpen) {
        panelOpen = typeof forceOpen === 'boolean' ? forceOpen : !panelOpen;
        document.getElementById('scadaFaultLocatorPanel')?.classList.toggle('hidden', !panelOpen);
        const btn = document.getElementById('btnToggleFaultLocator');
        if (btn) btn.className = panelOpen
            ? 'bg-rose-600 text-white border border-amber-300 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow'
            : 'bg-rose-900/90 hover:bg-rose-800 text-rose-100 border border-rose-400/50 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow';
        if (panelOpen) { if (window.PeaIdbStore?.isHydrating?.()) await window.PeaIdbStore.ready; populateFaultSourceDropdown(); }
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
        const rfInitVal = Number(prefs.rfOhm) > 0 ? String(prefs.rfOhm) : '';
        const cableOpts = Object.entries(PEA_22KV_CABLES).map(([k, v]) => `<option value="${k}"${prefs.cableKey === k ? ' selected' : ''}>${escHtml(v.label)}</option>`).join('');
        const subOpts = Object.entries(PEA_SOURCE_BUS_PRESETS).map(([k, v]) => `<option value="${k}"${prefs.sourceKey === k ? ' selected' : ''}>${escHtml(v.label)}</option>`).join('');
        const pnl = document.createElement('div');
        pnl.id = 'scadaFaultLocatorPanel';
        pnl.className = 'hidden pt-2 border-t border-rose-500/40 space-y-2 text-xs';
        pnl.innerHTML =
            `<div class="p-2.5 rounded-xl bg-gradient-to-r from-rose-950/90 via-slate-900 to-slate-900 border border-rose-400/40 space-y-2">` +
            `<div class="grid grid-cols-2 sm:grid-cols-12 gap-1.5 items-center">` +
            `<select id="scadaFaultSourceSelect" onchange="onFaultAmpParamsChanged(false)" class="col-span-2 sm:col-span-4 px-2.5 py-1.5 rounded-lg bg-slate-800 text-amber-300 border border-slate-600 text-xs font-bold"></select>` +
            `<input type="number" step="0.01" min="0.05" inputmode="decimal" id="scadaFaultKmInput" placeholder="ระยะ กม. (เช่น 4.35)" oninput="onFaultKmManualInput()" onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();executeFaultDistanceSearch(0,'km');}" class="col-span-1 sm:col-span-3 px-2.5 py-1.5 rounded-lg bg-slate-800 text-white border border-slate-600 text-xs font-bold">` +
            `<select id="scadaFaultTolSelect" class="col-span-1 sm:col-span-2 px-2.5 py-1.5 rounded-lg bg-slate-800 text-slate-200 border border-slate-600 text-[11px] font-bold"><option value="0.15">เผื่อ ±150 ม.</option><option value="0.30">เผื่อ ±300 ม.</option><option value="0">จุดเป๊ะ</option></select>` +
            `<div class="col-span-2 sm:col-span-3 flex gap-1"><button type="button" onclick="executeFaultDistanceSearch(0,'auto')" class="flex-1 bg-rose-600 hover:bg-rose-500 text-white py-1.5 px-2 rounded-lg text-[11px] font-extrabold shadow whitespace-nowrap">🔍 ชี้เป้า</button><button type="button" onclick="resetFaultLocatorInputs(false)" class="bg-slate-700 hover:bg-slate-600 text-amber-300 border border-slate-500/60 py-1.5 px-2.5 rounded-lg text-[11px] font-extrabold whitespace-nowrap" title="ล้างค่าที่กรอกและหมุดชี้เป้า">🧹 ล้างค่า</button></div></div>` +
            `<div class="p-2 rounded-lg bg-slate-950/75 border border-amber-400/30 space-y-1.5">` +
            `<div class="grid grid-cols-2 sm:grid-cols-12 gap-1.5 items-center">` +
            `<input type="number" step="10" min="50" inputmode="numeric" id="scadaFaultAmpInput" placeholder="⚡ กระแสฟอลต์ (แอมป์)" oninput="onFaultAmpParamsChanged(false)" onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();onFaultAmpParamsChanged(true);}" class="col-span-1 sm:col-span-3 px-2.5 py-1.5 rounded-lg bg-slate-800 text-amber-300 border border-amber-400/50 text-xs font-extrabold placeholder:text-amber-200/50">` +
            `<select id="scadaFaultPhaseSelect" onchange="onFaultAmpParamsChanged(true)" class="col-span-1 sm:col-span-2 px-2 py-1.5 rounded-lg bg-slate-800 text-white border border-slate-600 text-[11px] font-bold"><option value="LL"${prefs.faultType === 'LL' ? ' selected' : ''}>⚡ ช็อต 2 เฟส</option><option value="3P"${prefs.faultType === '3P' ? ' selected' : ''}>💥 ช็อต 3 เฟส</option><option value="LG"${prefs.faultType === 'LG' ? ' selected' : ''}>🌱 ลงดิน 1 เฟส</option></select>` +
            `<select id="scadaFaultCableSelect" onchange="onFaultAmpParamsChanged(true)" class="col-span-1 sm:col-span-3 px-2 py-1.5 rounded-lg bg-slate-800 text-slate-200 border border-slate-600 text-[11px] font-bold">${cableOpts}</select>` +
            `<select id="scadaFaultSubZSelect" onchange="onFaultAmpParamsChanged(true)" class="col-span-1 sm:col-span-2 px-2 py-1.5 rounded-lg bg-slate-800 text-slate-200 border border-slate-600 text-[11px] font-bold">${subOpts}</select>` +
            `<input type="number" step="0.5" min="0" max="50" id="scadaFaultRfInput" value="${rfInitVal}" title="ความต้านทานดิน/กิ่งไม้ (โอห์ม)" onchange="onFaultAmpParamsChanged(true)" placeholder="โอห์มดิน (ปกติ 0)" class="col-span-2 sm:col-span-2 px-2 py-1.5 rounded-lg bg-slate-800 text-slate-200 border border-slate-600 text-[11px] font-bold"></div>` +
            `<div id="scadaFaultAmpCalcBadge" class="text-[10.5px] text-slate-400">${DEFAULT_AMP_HINT_TEXT}</div></div>` +
            `<div class="flex flex-wrap items-center gap-3 text-[11px] text-slate-300">` +
            `<label class="inline-flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" id="scadaFaultStopOpenChk" checked onchange="onFaultAmpParamsChanged(false)" class="accent-rose-500 rounded"><span>หยุดที่สวิตช์ปลด</span></label>` +
            `<label class="inline-flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" id="scadaFaultDownstreamChk" checked class="accent-rose-500 rounded"><span>วัดเฉพาะฝั่งท้ายน้ำ (กรณีเริ่มจากสวิตช์กลางสาย)</span></label></div>` +
            `<div id="scadaFaultResultBox" class="hidden space-y-1"></div></div>`;
        tb.appendChild(pnl);
        return true;
    }

    function refreshFaultSourceOptions() { populateFaultSourceDropdown(); }

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
                await toggleScadaFaultLocatorPanel(true);
                const matchRes = populateFaultSourceDropdown(pkt.feeder || '', pkt.deviceHint || '', pkt.stationHint || '');
                const ampInp = document.getElementById('scadaFaultAmpInput'), kmInp = document.getElementById('scadaFaultKmInput'), phSel = document.getElementById('scadaFaultPhaseSelect');
                if (pkt.faultType && phSel) phSel.value = normalizeFaultTypeCode(pkt.faultType);
                if (pkt.faultAmp && Number(pkt.faultAmp) > 0 && ampInp) {
                    ampInp.value = String(pkt.faultAmp);
                    onFaultAmpParamsChanged(false);
                } else if (kmInp && pkt.distanceKm) {
                    if (ampInp) ampInp.value = '';
                    kmInp.value = String(pkt.distanceKm);
                }
                if (matchRes.unmatchedDeviceHint) window.showToast?.(`⚠️ ไม่พบหมุด "${matchRes.unmatchedDeviceHint}" ในผัง ระบบจึงเริ่มวัดจากต้นวงจรแทน`);
                setTimeout(() => executeFaultDistanceSearch(0, pkt.faultAmp > 0 ? 'amp' : 'km'), 150);
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

    function detectMainFormPhaseHint() {
        const phaseRaw = document.getElementById('phaseSelect')?.value || document.getElementById('faultPhaseInput')?.value || document.getElementById('phaseInput')?.value || '';
        const explicitPhaseBoxes = Array.from(document.querySelectorAll('#sortable-tab1 input[type="checkbox"]:checked'))
            .map((el) => el.getAttribute('value') || '')
            .filter((v) => v && v.toLowerCase() !== 'on')
            .join(' ');
        return normalizeFaultTypeCode(`${phaseRaw} ${explicitPhaseBoxes}`);
    }

    function injectIndexTab1QuickLocatorBar() {
        if (document.getElementById('techMainApp') || document.getElementById('tab1FaultLocatorQuickBox')) return;
        const anchorEl = document.getElementById('sortable-tab1') || document.getElementById('distanceZoneField') || document.getElementById('deviceInput')?.closest('div');
        if (!anchorEl?.parentElement) return;
        const box = document.createElement('div');
        box.id = 'tab1FaultLocatorQuickBox';
        box.className = 'mb-2.5 p-2.5 bg-gradient-to-r from-rose-50 to-amber-50 border border-rose-200 rounded-xl flex flex-wrap items-center justify-between gap-2';
        box.innerHTML = `<span class="text-xs font-bold text-rose-900 flex items-center gap-1">🎯 <span>ชี้เป้าฟอลต์ 22kV:</span></span>` +
            `<div class="flex flex-wrap items-center gap-1.5 flex-1 sm:flex-initial justify-end">` +
            `<input type="number" step="10" min="50" inputmode="numeric" id="tab1QuickFaultAmpInput" placeholder="⚡ กระแส (แอมป์)" oninput="if(this.value){const k=document.getElementById('tab1QuickFaultKmInput');if(k)k.value='';}" onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();triggerFaultLocatorFromMainForm();}" class="w-28 px-2 py-1 text-xs font-extrabold bg-white border border-amber-400 rounded-lg text-slate-800">` +
            `<select id="tab1QuickFaultTypeSelect" class="px-1.5 py-1 text-[11px] font-bold bg-white border border-amber-300 rounded-lg text-slate-700"><option value="AUTO">เฟสอัตโนมัติ</option><option value="LL">ช็อต 2 เฟส</option><option value="LG">ลงดิน 1 เฟส</option><option value="3P">ช็อต 3 เฟส</option></select>` +
            `<input type="number" step="0.01" min="0.05" inputmode="decimal" id="tab1QuickFaultKmInput" placeholder="หรือ กม." oninput="onQuickFaultKmBarInput(this.value)" onkeydown="if(event.key==='Enter'&&!event.isComposing){event.preventDefault();triggerFaultLocatorFromMainForm();}" class="w-24 px-2 py-1 text-xs font-bold bg-white border border-rose-300 rounded-lg text-slate-800">` +
            `<button type="button" onclick="triggerFaultLocatorFromMainForm()" class="bg-rose-600 hover:bg-rose-700 text-white px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold shadow-sm shrink-0">🎯 ชี้เป้าบนผัง</button>` +
            `<button type="button" onclick="clearQuickFaultLocatorFromMainForm(false)" class="bg-white hover:bg-slate-100 text-slate-700 border border-rose-300 px-2 py-1.5 rounded-lg text-[11px] font-extrabold shadow-sm shrink-0" title="ล้างค่าชี้เป้าฟอลต์">🧹 ล้างค่า</button></div>`;
        anchorEl.parentElement.insertBefore(box, anchorEl);

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

    function triggerFaultLocatorFromMainForm() {
        const rawAmp = document.getElementById('tab1QuickFaultAmpInput')?.value || '';
        const amp = parseFloat(String(rawAmp).replace(/,/g, '').replace(/[^0-9.]/g, ''));
        const dz = document.getElementById('distanceZoneField');
        const dist115Val = (dz && !dz.classList.contains('hidden')) ? (document.getElementById('distanceInput')?.value || '') : '';
        const rawKm = document.getElementById('tab1QuickFaultKmInput')?.value || dist115Val;
        let km = parseFloat(String(rawKm).replace(/,/g, '.').replace(/[^0-9.]/g, ''));
        const selMode = document.getElementById('tab1QuickFaultTypeSelect')?.value || 'AUTO';
        const faultType = selMode === 'AUTO' ? detectMainFormPhaseHint() : selMode;

        if ((!isNaN(amp) && amp > 0) && (isNaN(km) || km <= 0)) {
            const prefs = loadCalcPrefs();
            km = solveUniformDistanceKmFromAmp(amp, faultType, prefs.cableKey, prefs.sourceKey, prefs.rfOhm).km || 1.0;
        }
        if ((isNaN(km) || km <= 0) && (isNaN(amp) || amp <= 0)) {
            return window.showToast?.('⚠️ กรุณากรอก "กระแสฟอลต์ (แอมป์)" หรือ "ระยะทาง (กม.)" ก่อนกดชี้เป้า');
        }

        const pkt = {
            type: 'SCADA_LOCATE_FAULT_DISTANCE',
            feeder: document.getElementById('circuitSelect')?.value || '',
            deviceHint: document.getElementById('deviceInput')?.value || '',
            stationHint: document.getElementById('stationValue')?.value || '',
            faultAmp: (!isNaN(amp) && amp > 0) ? amp : 0,
            faultType, distanceKm: km, ts: Date.now()
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
            clearFaultLocatorOverlay();
            if (!isLogged && panelOpen) toggleScadaFaultLocatorPanel(false);
        }
        lastActiveScopeKey = curScope;
        lastKnownLoggedState = isLogged;

        if (isLogged) {
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
        if (panelOpen && Array.isArray(keys) && (keys.includes(STORAGE_KEY_LABELS) || keys.includes(STORAGE_KEY_DELETED))) {
            populateFaultSourceDropdown();
        }
    });
    window.addEventListener('storage', (ev) => {
        if (panelOpen && (ev?.key === STORAGE_KEY_LABELS || ev?.key === STORAGE_KEY_DELETED)) {
            populateFaultSourceDropdown();
        }
    });

    Object.assign(window, {
        toggleScadaFaultLocatorPanel, executeFaultDistanceSearch, clearFaultLocatorOverlay,
        resetFaultLocatorInputs, clearQuickFaultLocatorFromMainForm,
        zoomToFaultCandidate, navigateToFaultCandidate, shareFaultLocatorReportToLine,
        triggerFaultLocatorFromMainForm, refreshFaultSourceOptions, onQuickFaultKmBarInput,
        onFaultAmpParamsChanged, onFaultKmManualInput
    });

    function initFaultLocatorModule() {
        lastActiveScopeKey = getCurrentScopeKey();
        try { lastKnownLoggedState = localStorage.getItem('elec_app_logged_in') === 'true'; } catch (e) {}
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
// ==================== จบไฟล์ scada-fault-locator.js (v2.5) ====================