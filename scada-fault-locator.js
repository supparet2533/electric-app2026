// ============================================================================
// 🎯⚡ PEA SMART GRID — FAULT DISTANCE LOCATOR v1.7 (scada-fault-locator.js)
// แสดงแถบวัดระยะแท็บ 1 ทุกโครงสร้างหน้า + รองรับวัดระยะจากหมุดสายไฟทั่วไป + แม่นยำทั้งลูปและจุดทริป
// ============================================================================
(function () {
    'use strict';

    const FAULT_BRIDGE_CH = 'pea_scada_fault_locator_v1';
    const FAULT_PKT_KEY = 'elec_scada_fault_locator_pkt';
    const HANDLED_PKT_SESSION_KEY = 'elec_scada_handled_fault_pkt_ts';
    const STORAGE_KEY_LABELS = 'elec_labeled_places_list';
    const STORAGE_KEY_DELETED = 'elec_deleted_labeled_places_map';
    const SWITCHABLE_TYPES = new Set(['RC', 'CB', 'VB', 'VS', 'VSC', 'S', 'DF', 'GEN']);

    function safeSessionGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
    function safeSessionSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) {} }
    function escapeRe(s) { return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    let faultBc = null;
    try { if ('BroadcastChannel' in window) faultBc = new BroadcastChannel(FAULT_BRIDGE_CH); } catch (e) {}

    let capturedMap = null;
    let faultLayerGroup = null;
    let panelOpen = false;
    let lastFaultResult = null;
    let lastActiveScopeKey = '';
    let lastHandledPktTs = parseInt(safeSessionGet(HANDLED_PKT_SESSION_KEY) || '0', 10) || 0;

    function injectFaultLocatorStyles() {
        if (document.getElementById('peaScadaFaultLocatorCss')) return;
        const st = document.createElement('style');
        st.id = 'peaScadaFaultLocatorCss';
        st.textContent = `
            #labeledInteractiveMap.scada-draw-cursor .leaflet-scadaFaultLocatorPane-pane *,
            #labeledInteractiveMap.scada-move-wire-active .leaflet-scadaFaultLocatorPane-pane *,
            #labeledInteractiveMap.scada-move-pin-active .leaflet-scadaFaultLocatorPane-pane * {
                pointer-events: none !important;
            }
        `;
        document.head.appendChild(st);
    }

    function attachMapInstance(mapObj) {
        if (!mapObj || mapObj.getContainer?.()?.id !== 'labeledInteractiveMap' || capturedMap === mapObj) return;
        capturedMap = mapObj;
        if (!capturedMap.getPane('scadaFaultLocatorPane')) {
            const p = capturedMap.createPane('scadaFaultLocatorPane');
            p.style.zIndex = '635';
        }
        faultLayerGroup = L.layerGroup().addTo(capturedMap);
        checkPendingFaultPacket();
    }

    function hookLeafletInstance() {
        if (typeof window.L === 'undefined' || !L.Map || L.Map.__peaFaultHooked) return;
        L.Map.__peaFaultHooked = true;
        L.Map.addInitHook(function () { setTimeout(() => attachMapInstance(this), 0); });
        const origInv = L.Map.prototype.invalidateSize;
        L.Map.prototype.invalidateSize = function () { attachMapInstance(this); return origInv.apply(this, arguments); };
    }
    hookLeafletInstance();

    function haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371.0088, toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    function escHtml(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function openFaultLineShareSafe(text) {
        const lineUrl = 'https://line.me/R/share?text=' + encodeURIComponent(text);
        const win = window.open(lineUrl, '_blank');
        if (!win && !window.PeaCore?.isEmbeddedIframe) window.location.href = lineUrl;
    }

    function normGrp(raw) {
        if (typeof window.normalizePeaGroupName === 'function') return window.normalizePeaGroupName(raw) || '';
        return String(raw || '').trim().replace(/\s+/g, ' ').replace(/^(กฟ[สฟจตอ])\.?\s+/, '$1.').replace(/^(กฟ[สฟจตอ])(?![.\s])/, '$1.');
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
            if (!p || !p.id || isNaN(parseFloat(p.lat)) || isNaN(parseFloat(p.lon))) return false;
            const delIso = delMap[p.id];
            if (delIso && (new Date(p.updatedAt || 0).getTime() || 0) <= (new Date(delIso).getTime() || 0)) return false;
            if (scopeKey === '__ADMIN_ALL__') return true;
            const pGrp = normGrp(p.ownerGroup || (p.ownerUser && typeof window.getUserGroupName === 'function' ? window.getUserGroupName(p.ownerUser) : '')) || 'กฟส.บึง';
            return pGrp === scopeKey;
        });
    }

    function isNodeTTap(pin, allPins) {
        if (!pin) return false;
        const explicitType = pin.scadaNode?.t;
        if (explicitType && explicitType !== 'TAP' && explicitType !== 'PIN') return false;
        if (explicitType === 'TAP' || pin.isTTap === true) return true;
        if (/^(?:•\s*)?t-tap\b|จุดแทป|แทปสาย|แทปกลางสาย|หมุดแทป/i.test(`${pin.name || ''} ${pin.note || ''}`)) return true;
        if (Array.isArray(pin.scadaLines) && pin.scadaLines.some(l => l && (l._ttapTrunk || l._ttapFromId))) return true;
        if (Array.isArray(allPins)) return allPins.some(p => p && p.id !== pin.id && Array.isArray(p.scadaLines) && p.scadaLines.some(l => l && l.to === pin.id && l._ttapId));
        return false;
    }

    function resolveRealDestinationName(startToId, fromId, pinMap, adj, allPins) {
        const firstPin = pinMap.get(startToId);
        if (!firstPin) return '-';
        if (!isNodeTTap(firstPin, allPins)) return firstPin.name || '-';

        const foundNames = [];
        const vis = new Set([fromId, startToId]);
        const q = [{ id: startToId, depth: 0 }];
        while (q.length > 0 && foundNames.length < 2) {
            const { id, depth } = q.shift();
            if (depth >= 12) continue;
            const cur = pinMap.get(id);
            const trunkTargets = (cur?.scadaLines || []).filter(l => l?._ttapTrunk && l.to && !vis.has(l.to)).map(l => l.to);
            const nextIds = trunkTargets.length > 0
                ? trunkTargets
                : (adj.get(id) || []).map(n => n.toId).filter(nid => !vis.has(nid));

            for (const nid of nextIds) {
                vis.add(nid);
                const np = pinMap.get(nid);
                if (!np) continue;
                if (!isNodeTTap(np, allPins)) {
                    foundNames.push(np.name);
                    if (foundNames.length >= 2) break;
                } else {
                    q.push({ id: nid, depth: depth + 1 });
                }
            }
        }
        return foundNames.length > 0 ? foundNames.join(' / ') : (firstPin.name || '-');
    }

    function slicePolylineUpToKm(pts, targetKm) {
        if (!pts || pts.length === 0) return { path: [], point: [0, 0] };
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
        const pStart = slicePolylineUpToKm(pts, startKm).point;
        const pEnd = slicePolylineUpToKm(pts, endKm).point;
        const out = [pStart];
        let acc = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            acc += haversineKm(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
            if (acc > startKm + 1e-5 && acc < endKm - 1e-5) out.push(pts[i + 1]);
        }
        out.push(pEnd);
        return out;
    }

    function computeUpstreamFilter(sourcePinId, pins, pinMap, activeAdj, fullPhysAdj) {
        const srcPin = pinMap.get(sourcePinId);
        const srcT = srcPin?.scadaNode?.t || 'PIN';
        if (srcT === 'RC' || srcT === 'CB') return { blockedNodes: new Set(), blockedStartNeighbors: new Set() };

        const runDijkstra = (adjGraph, startId, ignoreOpenSw, skipNodeId = null) => {
            const dMap = new Map([[startId, 0]]);
            const vis = new Set();
            const pq = [{ id: startId, d: 0 }];
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
                (adjGraph.get(u) || []).forEach((nb) => {
                    if (nb.toId === skipNodeId) return;
                    const nbP = pinMap.get(nb.toId), nbT = nbP?.scadaNode?.t || 'PIN', nbSt = nbP?.scadaNode?.st || 'C';
                    if (!ignoreOpenSw && nbT !== 'RC' && nbT !== 'CB' && SWITCHABLE_TYPES.has(nbT) && nbSt === 'O') return;
                    const nd = du + nb.lenKm;
                    if (nd < (dMap.get(nb.toId) ?? Infinity)) {
                        dMap.set(nb.toId, nd);
                        pq.push({ id: nb.toId, d: nd });
                    }
                });
            }
            return dMap;
        };

        const breakers = pins.filter(p => p.id !== sourcePinId && (p.scadaNode?.t === 'RC' || p.scadaNode?.t === 'CB'));
        if (!breakers.length) return { blockedNodes: new Set(), blockedStartNeighbors: new Set() };

        let useGraph = activeAdj;
        let ignoreOpen = false;
        let distFromSrc = runDijkstra(useGraph, sourcePinId, false, null);
        let reachableBrks = breakers.filter(b => distFromSrc.has(b.id));

        if (!reachableBrks.length) {
            useGraph = fullPhysAdj;
            ignoreOpen = true;
            distFromSrc = runDijkstra(useGraph, sourcePinId, true, null);
            reachableBrks = breakers.filter(b => distFromSrc.has(b.id));
        }
        if (!reachableBrks.length) return { blockedNodes: new Set(), blockedStartNeighbors: new Set() };

        const srcFd = String(srcPin?.scadaNode?.fd || '').trim().toUpperCase();
        reachableBrks.sort((a, b) => {
            const aClosed = (a.scadaNode?.st || 'C') === 'C' ? 1 : 0;
            const bClosed = (b.scadaNode?.st || 'C') === 'C' ? 1 : 0;
            const aFdMatch = (srcFd && String(a.scadaNode?.fd || '').trim().toUpperCase() === srcFd) ? 1 : 0;
            const bFdMatch = (srcFd && String(b.scadaNode?.fd || '').trim().toUpperCase() === srcFd) ? 1 : 0;
            if (aFdMatch !== bFdMatch) return bFdMatch - aFdMatch;
            if (aClosed !== bClosed) return bClosed - aClosed;
            return (distFromSrc.get(a.id) ?? Infinity) - (distFromSrc.get(b.id) ?? Infinity);
        });

        const parentBrk = reachableBrks[0];
        const dWithSrc = runDijkstra(useGraph, parentBrk.id, ignoreOpen, null);
        const dWithoutSrc = runDijkstra(useGraph, parentBrk.id, ignoreOpen, sourcePinId);
        const srcDistFromBrk = dWithSrc.get(sourcePinId) ?? Infinity;

        const blockedNodes = new Set([parentBrk.id]);
        const blockedStartNeighbors = new Set();

        (useGraph.get(sourcePinId) || []).forEach((nb) => {
            const nbDist = dWithoutSrc.get(nb.toId);
            if (nbDist !== undefined && nbDist + nb.lenKm <= srcDistFromBrk + 0.02) {
                blockedStartNeighbors.add(nb.toId);
                blockedNodes.add(nb.toId);
            }
        });

        const activeSrcNbs = activeAdj.get(sourcePinId) || [];
        const hasDownstreamLeft = activeSrcNbs.some(nb => !blockedStartNeighbors.has(nb.toId));
        if (!hasDownstreamLeft) return { blockedNodes: new Set(), blockedStartNeighbors: new Set() };
        return { blockedNodes, blockedStartNeighbors };
    }

    function isBarrierTerminalNode(pin, sourcePinId, stopAtOpenSwitch) {
        if (!pin || pin.id === sourcePinId) return false;
        const eqT = pin.scadaNode?.t || 'PIN';
        if (eqT === 'RC' || eqT === 'CB') return true;
        if (stopAtOpenSwitch && SWITCHABLE_TYPES.has(eqT) && (pin.scadaNode?.st || 'C') === 'O') return true;
        return false;
    }

    function traceFaultLocations(sourcePinId, targetKm, tolKm, stopAtOpenSwitch, downstreamOnly) {
        const pins = getVisibleScadaPins();
        const pinMap = new Map(pins.map((p) => [p.id, p]));
        const srcPin = pinMap.get(sourcePinId);
        if (!srcPin) return { error: 'ไม่พบหมุดต้นทางที่เลือกในผัง' };

        const adj = new Map(), fullPhysAdj = new Map();
        const physicalEdges = [];
        const seenPhysPairFd = new Set(), seenActivePairFd = new Set();
        pins.forEach((p) => { adj.set(p.id, []); fullPhysAdj.set(p.id, []); });

        pins.forEach((p) => {
            (p.scadaLines || []).forEach((e, idx) => {
                const dst = pinMap.get(e?.to);
                if (!dst || dst.id === p.id) return;
                const fwdPts = [[Number(p.lat), Number(p.lon)], ...(e.w || []).map(w => [Number(w[0]), Number(w[1])]), [Number(dst.lat), Number(dst.lon)]];
                let lenKm = 0;
                for (let i = 0; i < fwdPts.length - 1; i++) lenKm += haversineKm(fwdPts[i][0], fwdPts[i][1], fwdPts[i + 1][0], fwdPts[i + 1][1]);
                if (lenKm <= 0) return;

                const pairFd = `${p.id < dst.id ? `${p.id}__${dst.id}` : `${dst.id}__${p.id}`}|${String(e.fd || '').toUpperCase()}`;
                if (!seenPhysPairFd.has(pairFd)) {
                    seenPhysPairFd.add(pairFd);
                    fullPhysAdj.get(p.id).push({ toId: dst.id, lenKm });
                    fullPhysAdj.get(dst.id).push({ toId: p.id, lenKm });
                }

                if (stopAtOpenSwitch && e.off) return;
                if (seenActivePairFd.has(pairFd)) return;
                seenActivePairFd.add(pairFd);

                const revPts = [...fwdPts].reverse();
                physicalEdges.push({ edgeId: `${p.id}__${idx}`, uId: p.id, vId: dst.id, fwdPts, revPts, lenKm, edge: e });
                adj.get(p.id).push({ toId: dst.id, lenKm });
                adj.get(dst.id).push({ toId: p.id, lenKm });
            });
        });

        const upFilter = downstreamOnly
            ? computeUpstreamFilter(sourcePinId, pins, pinMap, adj, fullPhysAdj)
            : { blockedNodes: new Set(), blockedStartNeighbors: new Set() };

        const dist = new Map([[sourcePinId, 0]]);
        const parentMap = new Map();
        const visited = new Set();
        const pq = [{ id: sourcePinId, d: 0 }];

        while (pq.length > 0) {
            pq.sort((a, b) => a.d - b.d);
            const { id: u, d: du } = pq.shift();
            if (visited.has(u)) continue;
            visited.add(u);

            const uPin = pinMap.get(u);
            if (isBarrierTerminalNode(uPin, sourcePinId, stopAtOpenSwitch)) continue;

            (adj.get(u) || []).forEach((nb) => {
                if (u === sourcePinId && upFilter.blockedStartNeighbors.has(nb.toId)) return;
                if (upFilter.blockedNodes.has(nb.toId)) return;
                const nbPin = pinMap.get(nb.toId);
                if (isBarrierTerminalNode(nbPin, sourcePinId, stopAtOpenSwitch)) return;
                const nd = du + nb.lenKm;
                if (nd < (dist.get(nb.toId) ?? Infinity)) {
                    dist.set(nb.toId, nd);
                    parentMap.set(nb.toId, { prevId: u, segKm: nb.lenKm });
                    pq.push({ id: nb.toId, d: nd });
                }
            });
        }

        const tracedSegments = [], candidates = [];
        let maxReachKm = 0, furthestPin = srcPin;
        dist.forEach((dVal, pid) => { if (dVal > maxReachKm) { maxReachKm = dVal; furthestPin = pinMap.get(pid) || srcPin; } });

        const evaluateDirectedSpan = (fromId, toId, pts, fullWireLenKm, spanLimitKm, edgeObj) => {
            if (spanLimitKm <= 1e-6) return;
            if (fromId === sourcePinId && upFilter.blockedStartNeighbors.has(toId)) return;
            const du = dist.get(fromId);
            if (du === undefined) return;
            const endKm = du + spanLimitKm;
            const dstPin = pinMap.get(toId);
            if (endKm > maxReachKm) { maxReachKm = endKm; furthestPin = dstPin || furthestPin; }

            const spanPts = spanLimitKm < fullWireLenKm - 1e-5 ? slicePolylineUpToKm(pts, spanLimitKm).path : pts;
            if (endKm < targetKm) {
                if (spanPts.length >= 2) tracedSegments.push(spanPts);
            } else if (du < targetKm && targetKm <= endKm) {
                const deltaKm = targetKm - du;
                const sliced = slicePolylineUpToKm(pts, deltaKm);
                if (sliced.path.length >= 2) tracedSegments.push(sliced.path);

                const candLat = Number(sliced.point[0].toFixed(6));
                const candLon = Number(sliced.point[1].toFixed(6));
                if (candidates.some((ex) => haversineKm(ex.lat, ex.lon, candLat, candLon) < 0.0008)) return;

                let refPin = pinMap.get(fromId), refOffsetKm = deltaKm, walkId = fromId, guard = 0;
                while (isNodeTTap(refPin, pins) && parentMap.has(walkId) && guard++ < 40) {
                    const pInfo = parentMap.get(walkId);
                    refOffsetKm += pInfo.segKm;
                    walkId = pInfo.prevId;
                    refPin = pinMap.get(walkId) || refPin;
                }
                const towardDisplay = resolveRealDestinationName(toId, fromId, pinMap, adj, pins);
                const tolZonePath = tolKm > 0
                    ? slicePolylineBetweenKm(pts, Math.max(0, deltaKm - tolKm), Math.min(fullWireLenKm, deltaKm + tolKm))
                    : [];

                candidates.push({
                    lat: candLat,
                    lon: candLon,
                    refPinName: refPin ? refPin.name : '-',
                    refOffsetMeters: Math.round(refOffsetKm * 1000),
                    towardName: towardDisplay,
                    spec: edgeObj.lb || (edgeObj.st === 'ug' ? 'UG.' : 'OH'),
                    tolZonePath
                });
            }
        };

        physicalEdges.forEach((er) => {
            if (upFilter.blockedNodes.has(er.uId) || upFilter.blockedNodes.has(er.vId)) return;
            const hasU = dist.has(er.uId) && !isBarrierTerminalNode(pinMap.get(er.uId), sourcePinId, stopAtOpenSwitch);
            const hasV = dist.has(er.vId) && !isBarrierTerminalNode(pinMap.get(er.vId), sourcePinId, stopAtOpenSwitch);

            if (hasU && hasV) {
                const du = dist.get(er.uId), dv = dist.get(er.vId), L = er.lenKm;
                const splitFromU = Math.max(0, Math.min(L, (dv - du + L) / 2));
                const splitFromV = L - splitFromU;
                if (splitFromU > 1e-5) evaluateDirectedSpan(er.uId, er.vId, er.fwdPts, L, splitFromU, er.edge);
                if (splitFromV > 1e-5) evaluateDirectedSpan(er.vId, er.uId, er.revPts, L, splitFromV, er.edge);
            } else if (hasU && !hasV) {
                evaluateDirectedSpan(er.uId, er.vId, er.fwdPts, er.lenKm, er.lenKm, er.edge);
            } else if (!hasU && hasV) {
                evaluateDirectedSpan(er.vId, er.uId, er.revPts, er.lenKm, er.lenKm, er.edge);
            }
        });

        return { srcPin, targetKm, tolKm, tracedSegments, candidates, maxReachKm, furthestPin };
    }

    function clearFaultLocatorOverlay() {
        faultLayerGroup?.clearLayers();
        lastFaultResult = null;
        const resBox = document.getElementById('scadaFaultResultBox');
        if (resBox) { resBox.innerHTML = ''; resBox.classList.add('hidden'); }
    }

    function populateFaultSourceDropdown(preferFeeder = '', preferDevice = '', preferStation = '') {
        const sel = document.getElementById('scadaFaultSourceSelect');
        if (!sel) return;
        const pins = getVisibleScadaPins();
        const prevVal = sel.value;
        const wiredIds = new Set();
        pins.forEach((p) => {
            (p.scadaLines || []).forEach((l) => {
                if (l?.to && l.to !== p.id) { wiredIds.add(p.id); wiredIds.add(l.to); }
            });
        });

        const breakers = [], switches = [], wiredPlainPins = [];
        pins.forEach((p) => {
            const t = p.scadaNode?.t || 'PIN';
            if (t === 'RC' || t === 'CB') breakers.push(p);
            else if (['VB', 'VS', 'VSC', 'S', 'DF', 'GEN'].includes(t)) switches.push(p);
            else if (wiredIds.has(p.id) && !isNodeTTap(p, pins)) wiredPlainPins.push(p);
        });

        const allCandidates = [...breakers, ...switches, ...wiredPlainPins];
        const opts = [];
        breakers.forEach((b) => opts.push(`<option value="${escHtml(b.id)}">■ [CB] ${escHtml(b.name)}${b.scadaNode?.fd ? ` (${escHtml(b.scadaNode.fd)})` : ''}</option>`));
        switches.forEach((s) => opts.push(`<option value="${escHtml(s.id)}">⚡ [${escHtml(s.scadaNode?.t)}] ${escHtml(s.name)}</option>`));
        wiredPlainPins.forEach((wp) => opts.push(`<option value="${escHtml(wp.id)}">📍 [หมุด] ${escHtml(wp.name)}</option>`));
        sel.innerHTML = opts.length ? opts.join('') : '<option value="">-- ยังไม่มีหมุดที่เชื่อมสายไฟในผัง --</option>';

        const devClean = String(preferDevice || '').replace(/\(ID[^)]*\)/gi, '').trim().toLowerCase();
        if (devClean.length >= 2) {
            const exact = allCandidates.find((p) => String(p.name || '').trim().toLowerCase() === devClean || String(p.scadaNode?.id || '').trim().toLowerCase() === devClean);
            if (exact) { sel.value = exact.id; return; }

            const devBoundaryRe = new RegExp(`(?:^|[^a-z0-9])${escapeRe(devClean)}(?![0-9])`, 'i');
            const boundaryHit = allCandidates.find((p) => devBoundaryRe.test(String(p.name || '').trim()));
            if (boundaryHit) { sel.value = boundaryHit.id; return; }

            const reverseHit = allCandidates
                .filter((p) => String(p.name || '').trim().length >= 4)
                .sort((a, b) => String(b.name || '').length - String(a.name || '').length)
                .find((p) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(String(p.name || '').trim())}(?![0-9])`, 'i').test(devClean));
            if (reverseHit) { sel.value = reverseHit.id; return; }
        }

        if (preferFeeder) {
            const numM = String(preferFeeder).match(/(\d+)\s*$/);
            const fNum = numM ? parseInt(numM[1], 10) : null;
            const cleanFd = String(preferFeeder).trim().toUpperCase().replace(/\s+/g, '');
            const stCodeM = String(preferStation || '').toUpperCase().match(/[A-Z]{2,4}/);
            const stPrefix = stCodeM ? stCodeM[0] : '';
            const poolForFeeder = breakers.length > 0 ? breakers : allCandidates;

            const scored = poolForFeeder.map((b) => {
                const bFd = String(b.scadaNode?.fd || '').toUpperCase().replace(/\s+/g, '');
                const bTxt = `${bFd} ${b.name || ''} ${b.note || ''}`.toUpperCase();
                let score = 0;
                if (bFd && bFd === cleanFd) score += 120;
                if (fNum !== null) {
                    const fdMatches = Array.from(bTxt.matchAll(/(?:\b(?!KV)[A-Z]{2,4}\s*F?\s*0*(\d+)|\bF\s*0*(\d+)|วงจร\s*0*(\d+))(?![0-9]|KV)/gi));
                    if (fdMatches.some((m) => parseInt(m[1] || m[2] || m[3], 10) === fNum)) score += 65;
                    else {
                        const cbMatches = Array.from(bTxt.matchAll(/\b(?:CB|RC)\s*-?\s*0*(\d+)(?![0-9])/gi));
                        if (cbMatches.some((m) => parseInt(m[1], 10) === fNum)) score += 45;
                    }
                }
                if (stPrefix && bTxt.includes(stPrefix)) score += 30;
                if (preferStation && `${b.name || ''} ${b.note || ''}`.includes(preferStation.trim())) score += 25;
                return { b, score };
            }).filter((x) => x.score >= 45).sort((a, b) => b.score - a.score);

            if (scored.length > 0) { sel.value = scored[0].b.id; return; }
        }
        if (prevVal && allCandidates.some((p) => p.id === prevVal)) sel.value = prevVal;
    }

    async function executeFaultDistanceSearch(retryCount = 0) {
        if (!document.getElementById('techMainApp')) return;
        if (window.PeaIdbStore?.isHydrating?.()) await window.PeaIdbStore.ready;
        if (!capturedMap || !faultLayerGroup) {
            if (retryCount >= 8) return window.showToast?.('⚠️ แผนที่ยังไม่พร้อมใช้งาน กรุณาลองใหม่อีกครั้ง');
            if (retryCount === 0 && typeof window.switchTechMainTab === 'function') window.switchTechMainTab('map');
            setTimeout(() => executeFaultDistanceSearch(retryCount + 1), 250);
            return;
        }
        const sel = document.getElementById('scadaFaultSourceSelect');
        if (sel && (!sel.options.length || !sel.value)) populateFaultSourceDropdown();
        const srcId = sel?.value || '';
        const distVal = parseFloat(document.getElementById('scadaFaultKmInput')?.value || '');
        const tolVal = parseFloat(document.getElementById('scadaFaultTolSelect')?.value || '0.15') || 0;
        const stopOpen = document.getElementById('scadaFaultStopOpenChk')?.checked !== false;
        const downstreamOnly = document.getElementById('scadaFaultDownstreamChk')?.checked !== false;

        if (!srcId) return window.showToast?.('⚠️ กรุณาตั้งค่าหมุด ■ CB หรือลากสายเชื่อมหมุดต้นทางในผังก่อนครับ');
        if (isNaN(distVal) || distVal <= 0) return window.showToast?.('⚠️ กรุณาระบุระยะทางฟอลต์ (กม.) ให้มากกว่า 0');

        const fdFilterEl = document.getElementById('scadaFeederFilterSelect');
        const checkSrcPin = getVisibleScadaPins().find((p) => p.id === srcId);
        if (fdFilterEl && fdFilterEl.value !== 'ALL' && fdFilterEl.value !== (checkSrcPin?.scadaNode?.fd || '')) {
            fdFilterEl.value = 'ALL';
            window.onScadaFeederFilterChange?.('ALL');
        }

        faultLayerGroup.clearLayers();
        const res = traceFaultLocations(srcId, distVal, tolVal, stopOpen, downstreamOnly);
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
            if (c.tolZonePath?.length >= 2) {
                L.polyline(c.tolZonePath, { pane: 'scadaFaultLocatorPane', color: '#ef4444', weight: 10, opacity: 0.35, interactive: false }).addTo(faultLayerGroup);
            }
            const badgeNo = idx + 1;
            const icon = L.divIcon({
                className: '',
                html: `<div style="position:relative;width:38px;height:38px;display:flex;align-items:center;justify-content:center;"><div style="position:absolute;inset:0;border-radius:9999px;background:rgba(239,68,68,0.28);border:2px solid #ef4444;animation:scadaPinSelectPulse 1.1s infinite;"></div><div style="position:relative;z-index:2;background:#dc2626;color:#fff;border:2px solid #fde047;border-radius:9999px;padding:1px 6px;font-size:11px;font-weight:900;box-shadow:0 3px 10px rgba(0,0,0,0.55);">🎯#${badgeNo}</div></div>`,
                iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -16]
            });
            const offsetStr = c.refOffsetMeters >= 1000 ? `${(c.refOffsetMeters / 1000).toFixed(2)} กม.` : `${c.refOffsetMeters} เมตร`;
            const mk = L.marker([c.lat, c.lon], { icon, pane: 'scadaFaultLocatorPane' }).addTo(faultLayerGroup);
            mk.bindPopup(`<div style="font-family:'Prompt',sans-serif;min-width:235px;" class="space-y-1.5 text-xs"><div class="bg-rose-600 text-white px-2 py-1 rounded-lg font-extrabold flex justify-between"><span>🎯 จุดคาดการณ์ฟอลต์ #${badgeNo}</span><span>${distVal.toFixed(2)} กม.</span></div><div class="font-bold text-slate-800">📍 เลย <u>${escHtml(c.refPinName)}</u> ไป ${offsetStr}</div><div class="text-[11px] text-slate-600">➡️ มุ่งหน้า: <b>${escHtml(c.towardName)}</b> (${escHtml(c.spec)})</div><div class="text-[10px] text-slate-400">${c.lat}, ${c.lon}</div><div class="pt-1 flex gap-1.5"><a href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}&travelmode=driving" target="_blank" rel="noopener noreferrer" style="background:#2563eb;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;flex:1;text-align:center;">🗺️ นำทาง Maps</a><button type="button" onclick="shareFaultLocatorReportToLine()" style="background:#00B900;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;flex:1;">💬 ส่ง LINE</button></div></div>`);
        });

        const resBox = document.getElementById('scadaFaultResultBox');
        if (resBox) {
            resBox.classList.remove('hidden');
            if (res.candidates.length === 0) {
                resBox.innerHTML = res.maxReachKm <= 0.001
                    ? `<div class="p-2 bg-amber-950/80 border border-amber-400/50 rounded-xl text-amber-200 text-[11px]">⚠️ หมุด <b>${escHtml(res.srcPin.name)}</b> ยังไม่ได้ลากเส้นสายไฟเชื่อมเข้าผัง SCADA (หรือสวิตช์ฝั่งท้ายน้ำปลด N.O. อยู่ทั้งหมด)</div>`
                    : `<div class="p-2 bg-amber-950/80 border border-amber-400/50 rounded-xl text-amber-200 text-[11px]">⚠️ ระยะ <b>${distVal.toFixed(2)} กม.</b> เกินปลายสายในผัง (สายยาวสุดจาก ${escHtml(res.srcPin.name)} คือ <b>${res.maxReachKm.toFixed(2)} กม.</b> ที่จุด ${escHtml(res.furthestPin?.name || '-')})</div>`;
                if (res.furthestPin) bounds.push([Number(res.furthestPin.lat), Number(res.furthestPin.lon)]);
            } else {
                resBox.innerHTML = `<div class="flex items-center justify-between text-[11px] text-rose-200 font-bold"><span>🎯 พบ ${res.candidates.length} จุดคาดการณ์ตามแนวสาย (${distVal.toFixed(2)} กม.)</span><button type="button" onclick="shareFaultLocatorReportToLine()" class="bg-[#00B900] text-white px-2 py-0.5 rounded-lg text-[10px] font-extrabold">💬 ส่งพิกัดเข้า LINE</button></div><div class="grid grid-cols-1 sm:grid-cols-2 gap-1 pt-1 max-h-28 overflow-y-auto">` +
                    res.candidates.map((c, i) => {
                        const offTxt = c.refOffsetMeters >= 1000 ? `${(c.refOffsetMeters / 1000).toFixed(2)} กม.` : `${c.refOffsetMeters} ม.`;
                        return `<button type="button" onclick="zoomToFaultCandidate(${i})" class="text-left px-2.5 py-1.5 rounded-lg bg-slate-950/90 hover:bg-slate-800 border border-rose-400/40 text-[10px] text-white truncate"><b class="text-amber-300">#${i + 1}</b> เลย ${escHtml(c.refPinName)} (${offTxt}) ➔ ${escHtml(c.towardName)}</button>`;
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
        const r = lastFaultResult;
        const lines = [
            `🎯 ชี้เป้าจุดคาดการณ์ฟอลต์ตามแนวสาย SCADA`,
            `⚡ ต้นทางวัดระยะ : ${r.srcPin.name}${r.srcPin.scadaNode?.fd ? ` (${r.srcPin.scadaNode.fd})` : ''}`,
            `📏 ระยะฟอลต์จากรีเลย์ : ${r.targetKm.toFixed(2)} กม. (±${r.tolKm.toFixed(2)} กม.)`,
            `━━━━━━━━━━━━━━━━━━`
        ];
        r.candidates.forEach((c, i) => {
            const offTxt = c.refOffsetMeters >= 1000 ? `${(c.refOffsetMeters / 1000).toFixed(2)} กม.` : `${c.refOffsetMeters} เมตร`;
            lines.push(`${i + 1}) เลย ${c.refPinName} ไป ${offTxt} (มุ่งหน้า ${c.towardName})`, `   📍 https://www.google.com/maps?q=${c.lat},${c.lon}`);
        });
        const msg = lines.join('\n');
        if (typeof window.copyTechText === 'function') window.copyTechText(msg, '💬 คัดลอกพิกัดคาดการณ์ฟอลต์แล้ว กำลังเปิด LINE...');
        openFaultLineShareSafe(msg);
    }

    async function toggleScadaFaultLocatorPanel(forceOpen) {
        panelOpen = typeof forceOpen === 'boolean' ? forceOpen : !panelOpen;
        const pnl = document.getElementById('scadaFaultLocatorPanel');
        const btn = document.getElementById('btnToggleFaultLocator');
        if (pnl) pnl.classList.toggle('hidden', !panelOpen);
        if (btn) btn.className = panelOpen
            ? 'bg-rose-600 text-white border border-amber-300 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow'
            : 'bg-rose-900/90 hover:bg-rose-800 text-rose-100 border border-rose-400/50 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow';
        if (panelOpen) {
            if (window.PeaIdbStore?.isHydrating?.()) await window.PeaIdbStore.ready;
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
            btn.type = 'button'; btn.id = 'btnToggleFaultLocator';
            btn.onclick = () => toggleScadaFaultLocatorPanel();
            btn.className = 'bg-rose-900/90 hover:bg-rose-800 text-rose-100 border border-rose-400/50 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow';
            btn.innerHTML = '🎯 วัดระยะฟอลต์';
            simBtn.parentElement.insertBefore(btn, simBtn);
        }
        const pnl = document.createElement('div');
        pnl.id = 'scadaFaultLocatorPanel';
        pnl.className = 'hidden pt-2 border-t border-rose-500/40 space-y-2 text-xs';
        pnl.innerHTML = `<div class="p-2.5 rounded-xl bg-gradient-to-r from-rose-950/90 via-slate-900 to-slate-900 border border-rose-400/40 space-y-2"><div class="grid grid-cols-2 sm:grid-cols-12 gap-1.5 items-center"><select id="scadaFaultSourceSelect" onfocus="refreshFaultSourceOptions()" class="col-span-2 sm:col-span-5 px-2.5 py-1.5 rounded-lg bg-slate-800 text-amber-300 border border-slate-600 text-xs font-bold"></select><input type="number" step="0.01" min="0.05" inputmode="decimal" id="scadaFaultKmInput" placeholder="ระยะ กม. (เช่น 4.35)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();executeFaultDistanceSearch(0);}" class="col-span-1 sm:col-span-3 px-2.5 py-1.5 rounded-lg bg-slate-800 text-white border border-slate-600 text-xs font-bold"><select id="scadaFaultTolSelect" class="col-span-1 sm:col-span-2 px-2.5 py-1.5 rounded-lg bg-slate-800 text-slate-200 border border-slate-600 text-[11px] font-bold"><option value="0.15">เผื่อ ±150 ม.</option><option value="0.30">เผื่อ ±300 ม.</option><option value="0">จุดเป๊ะ</option></select><div class="col-span-2 sm:col-span-2 flex gap-1"><button type="button" onclick="executeFaultDistanceSearch(0)" class="flex-1 bg-rose-600 hover:bg-rose-500 text-white py-1.5 px-2 rounded-lg text-[11px] font-extrabold shadow">🔍 ชี้เป้า</button><button type="button" onclick="clearFaultLocatorOverlay()" class="bg-slate-700 hover:bg-slate-600 text-slate-200 py-1.5 px-2 rounded-lg text-[11px] font-bold" title="ล้างเส้น">✖</button></div></div><div class="flex flex-wrap items-center gap-3 text-[11px] text-slate-300"><label class="inline-flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" id="scadaFaultStopOpenChk" checked class="accent-rose-500 rounded"><span>หยุดที่สวิตช์ปลด (N.O.)</span></label><label class="inline-flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" id="scadaFaultDownstreamChk" checked class="accent-rose-500 rounded"><span>วัดเฉพาะฝั่งท้ายน้ำ (กรณีเริ่มจาก VB/สวิตช์กลางสาย)</span></label></div><div id="scadaFaultResultBox" class="hidden space-y-1"></div></div>`;
        tb.appendChild(pnl);
        return true;
    }

    function refreshFaultSourceOptions() { populateFaultSourceDropdown(); }

    async function applyIncomingFaultPacket(pkt) {
        if (!pkt || pkt.type !== 'SCADA_LOCATE_FAULT_DISTANCE') return;
        if (!document.getElementById('techMainApp')) return;
        if (pkt.ts && pkt.ts <= lastHandledPktTs) return;
        lastHandledPktTs = pkt.ts || Date.now();
        safeSessionSet(HANDLED_PKT_SESSION_KEY, String(lastHandledPktTs));

        if (window.PeaIdbStore?.ready) await window.PeaIdbStore.ready;
        if (typeof window.switchTechMainTab === 'function') window.switchTechMainTab('map');
        setTimeout(async () => {
            if (window.PeaIdbStore?.isHydrating?.()) await window.PeaIdbStore.ready;
            injectPage2ToolbarLocatorUI();
            await toggleScadaFaultLocatorPanel(true);
            populateFaultSourceDropdown(pkt.feeder || '', pkt.deviceHint || '', pkt.stationHint || '');
            const kmInp = document.getElementById('scadaFaultKmInput');
            if (kmInp && pkt.distanceKm) kmInp.value = String(pkt.distanceKm);
            setTimeout(() => executeFaultDistanceSearch(0), 180);
        }, 240);
    }

    function checkPendingFaultPacket() {
        if (!document.getElementById('techMainApp')) return;
        try {
            const raw = localStorage.getItem(FAULT_PKT_KEY);
            if (!raw) return;
            const pkt = JSON.parse(raw);
            if (pkt && Date.now() - (pkt.ts || 0) < 15000 && pkt.ts > lastHandledPktTs) {
                applyIncomingFaultPacket(pkt);
            }
        } catch (e) {}
    }

    function onQuickFaultKmBarInput(val) {
        const dz = document.getElementById('distanceZoneField');
        const dist115 = document.getElementById('distanceInput');
        if (dz && !dz.classList.contains('hidden') && dist115) {
            dist115.value = val;
        }
    }

    function injectIndexTab1QuickLocatorBar() {
        if (document.getElementById('techMainApp') || document.getElementById('tab1FaultLocatorQuickBox')) return;
        const sortTab1 = document.getElementById('sortable-tab1');
        const anchorEl = sortTab1 || document.getElementById('distanceZoneField') || document.getElementById('deviceInput')?.closest('div');
        if (!anchorEl || !anchorEl.parentElement) return;

        const box = document.createElement('div');
        box.id = 'tab1FaultLocatorQuickBox';
        box.className = 'mb-2.5 p-2.5 bg-gradient-to-r from-rose-50 to-amber-50 border border-rose-200 rounded-xl flex flex-wrap items-center justify-between gap-2';
        box.innerHTML = `<span class="text-xs font-bold text-rose-900 flex items-center gap-1">🎯 <span>วัดระยะฟอลต์บนผังสาย:</span></span><div class="flex items-center gap-1.5 flex-1 sm:flex-initial justify-end"><input type="number" step="0.01" min="0.05" inputmode="decimal" id="tab1QuickFaultKmInput" placeholder="กม. จากรีเลย์" oninput="onQuickFaultKmBarInput(this.value)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();triggerFaultLocatorFromMainForm();}" class="w-28 px-2.5 py-1 text-xs font-bold bg-white border border-rose-300 rounded-lg text-slate-800"><button type="button" onclick="triggerFaultLocatorFromMainForm()" class="bg-rose-600 hover:bg-rose-700 text-white px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold shadow-sm shrink-0">🎯 ชี้เป้าบนผัง</button></div>`;
        anchorEl.parentElement.insertBefore(box, anchorEl);

        const dist115 = document.getElementById('distanceInput');
        if (dist115) {
            dist115.addEventListener('input', function () {
                const q = document.getElementById('tab1QuickFaultKmInput');
                if (q && document.activeElement !== q) q.value = parseFloat(this.value) || '';
            });
        }
        if (typeof window.resetFaultForm === 'function' && !window.resetFaultForm.__faultKmHooked) {
            const origReset = window.resetFaultForm;
            const wrapped = function () {
                const r = origReset.apply(this, arguments);
                const q = document.getElementById('tab1QuickFaultKmInput');
                if (q) q.value = '';
                return r;
            };
            wrapped.__faultKmHooked = true;
            window.resetFaultForm = wrapped;
        }
    }

    function triggerFaultLocatorFromMainForm() {
        const rawKm = document.getElementById('tab1QuickFaultKmInput')?.value || document.getElementById('distanceInput')?.value || '';
        const km = parseFloat(String(rawKm).replace(/[^0-9.]/g, ''));
        if (isNaN(km) || km <= 0) return window.showToast?.('⚠️ กรุณากรอกระยะทางฟอลต์ (กม.) เช่น 4.35 ก่อนกดชี้เป้า');
        const feeder = document.getElementById('circuitSelect')?.value || '';
        const deviceHint = document.getElementById('deviceInput')?.value || '';
        const stationHint = document.getElementById('stationValue')?.value || '';
        const pkt = { type: 'SCADA_LOCATE_FAULT_DISTANCE', feeder, deviceHint, stationHint, distanceKm: km, ts: Date.now() };
        try { localStorage.setItem(FAULT_PKT_KEY, JSON.stringify(pkt)); } catch (e) {}

        if (typeof window.openScadaDiagramWorkspace === 'function') window.openScadaDiagramWorkspace();
        else window.open('page2.html?tab=map', '_blank');

        setTimeout(() => {
            const ifr = document.getElementById('leftBrowserIframe');
            const sendToFrame = () => {
                try { faultBc?.postMessage(pkt); } catch (e) {}
                try { ifr?.contentWindow?.postMessage(pkt, '*'); } catch (e) {}
            };
            if (ifr) {
                if (ifr.__faultLoadHandler) ifr.removeEventListener('load', ifr.__faultLoadHandler);
                ifr.__faultLoadHandler = () => setTimeout(sendToFrame, 250);
                ifr.addEventListener('load', ifr.__faultLoadHandler, { once: true });
            }
            sendToFrame();
        }, 420);
    }

    function hookRoleChangeCleanup() {
        if (typeof window.__onScadaRoleUpdated === 'function' && !window.__onScadaRoleUpdated.__faultLocatorHooked) {
            const origRoleUpd = window.__onScadaRoleUpdated;
            const wrappedRoleUpd = function () {
                const curScope = getCurrentScopeKey();
                let isLogged = false;
                try { isLogged = localStorage.getItem('elec_app_logged_in') === 'true'; } catch (e) {}
                if (!isLogged || (lastActiveScopeKey && curScope !== lastActiveScopeKey)) {
                    clearFaultLocatorOverlay();
                    if (!isLogged) toggleScadaFaultLocatorPanel(false);
                }
                lastActiveScopeKey = curScope;
                if (isLogged && panelOpen) populateFaultSourceDropdown();
                return origRoleUpd.apply(this, arguments);
            };
            wrappedRoleUpd.__faultLocatorHooked = true;
            window.__onScadaRoleUpdated = wrappedRoleUpd;
        }
    }

    window.addEventListener('message', (ev) => { if (ev?.data?.type === 'SCADA_LOCATE_FAULT_DISTANCE') applyIncomingFaultPacket(ev.data); });
    if (faultBc) faultBc.onmessage = (ev) => applyIncomingFaultPacket(ev?.data);

    Object.assign(window, {
        toggleScadaFaultLocatorPanel, executeFaultDistanceSearch, clearFaultLocatorOverlay,
        zoomToFaultCandidate, shareFaultLocatorReportToLine, triggerFaultLocatorFromMainForm,
        refreshFaultSourceOptions, onQuickFaultKmBarInput
    });

    function initFaultLocatorModule() {
        lastActiveScopeKey = getCurrentScopeKey();
        injectFaultLocatorStyles();
        hookLeafletInstance();
        hookRoleChangeCleanup();
        injectIndexTab1QuickLocatorBar();
        if (document.getElementById('techMainApp') && !injectPage2ToolbarLocatorUI()) {
            const obs = new MutationObserver(() => {
                hookLeafletInstance();
                hookRoleChangeCleanup();
                if (injectPage2ToolbarLocatorUI()) obs.disconnect();
            });
            obs.observe(document.getElementById('techMainApp'), { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', initFaultLocatorModule);
    else initFaultLocatorModule();
})();