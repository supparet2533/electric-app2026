// ============================================================================
// 💾 PEA SMART GRID — HYBRID RAM + INDEXEDDB STORAGE ENGINE v2.2 (pea-idb-store.js)
// ซิงค์คีย์ CA + แผนงาน PM + ประวัติวัดโหลดหม้อแปลง + สเกลฟอลต์ 22kV
// รองรับโหมดจำลองสับพ่วง (scada-tie-advisor.js / simSandbox) 100% ทุกขนาดผังข้อมูล
// ============================================================================
(function () {
    'use strict';

    const DB_NAME = 'pea_smart_grid_idb_v1';
    const STORE_NAME = 'kv_store';
    const OFFLOAD_MARKER = '__PEA_IDB_OFFLOAD__';
    const META_TS_KEY = '__pea_idb_phys_ts_map__';
    const SYNC_CHANNEL = 'pea_idb_kv_sync_v1';
    const PENDING_PUSH_KEY = 'elec_tech_has_pending_push';
    const ACTIVE_NAV_KEY = 'elec_scada_active_map_nav';
    const BC_INLINE_MAX_CHARS = 4000000;
    const IDB_OPEN_TIMEOUT_MS = 2500;

    const OFFLOAD_LIMITS = {
        elec_auto_backup_snapshot: 50000,
        elec_app_auto_backup_snapshot: 50000,
        elec_cloud_group_backups_map: 100000,
        elec_labeled_places_list: 450000,
        elec_tx_load_records_v1: 2500000, // เก็บแบบ Mirrored (RAM+IDB+LS) เพื่อให้หน้าฟอร์มแยกอ่านตรงได้ และย้ายลง IDB อัตโนมัติเมื่อโควตาเต็ม
        elec_scada_22kv_feeder_calib_v1: 500000,
        default: 400000
    };

    const MANAGED_KEYS = new Set([
        'elec_labeled_places_list',
        'elec_deleted_labeled_places_map',
        'elec_deleted_equip_audit_logs',
        'elecReportsComplete_all',
        'fault_reports_all',
        'elec_cloud_group_backups_map',
        'elec_app_auto_backup_snapshot',
        'elec_auto_backup_snapshot',
        'faultHistory',
        'outageHistory',
        'overdue_ca_list',
        'elec_ca_overdue_list',
        'elec_pm_calendar_plans_v1',
        'elec_tx_load_records_v1',
        'elec_scada_22kv_feeder_calib_v1'
    ]);

    const EMPTY_FALLBACK = {
        elec_labeled_places_list: '[]',
        elec_deleted_labeled_places_map: '{}',
        elec_deleted_equip_audit_logs: '[]',
        elecReportsComplete_all: '[]',
        fault_reports_all: '[]',
        elec_cloud_group_backups_map: '{}',
        elec_app_auto_backup_snapshot: '',
        elec_auto_backup_snapshot: '',
        faultHistory: '[]',
        outageHistory: '[]',
        overdue_ca_list: '[]',
        elec_ca_overdue_list: '[]',
        elec_pm_calendar_plans_v1: '[]',
        elec_tx_load_records_v1: '[]',
        elec_scada_22kv_feeder_calib_v1: '{}'
    };

    const rawGet = Storage.prototype.getItem;
    const rawSet = Storage.prototype.setItem;
    const rawRem = Storage.prototype.removeItem;
    const rawClr = Storage.prototype.clear;

    const ramCache = new Map();
    const keyVersionMap = new Map();
    const bootPhysicalState = new Map();
    const pendingPreReadyOps = new Map();
    const hydratingOffloadedKeys = new Set();
    const hydratedKeys = new Set();
    const inFlightKeys = new Set();
    const dirtyWriteQueue = new Map();
    const senderId = 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    let physTsMap = {};
    let lastMonotonicTs = 0;
    let clearEpoch = 0;
    let dbInst = null;
    let dbOpenPromise = null;
    let isDbReady = false;
    let bc = null;

    try {
        if ('BroadcastChannel' in window) bc = new BroadcastChannel(SYNC_CHANNEL);
    } catch (e) {}

    try {
        physTsMap = JSON.parse(rawGet.call(window.localStorage, META_TS_KEY) || '{}') || {};
    } catch (e) {
        physTsMap = {};
    }

    function nextWriteTs() {
        lastMonotonicTs = Math.max(Date.now(), lastMonotonicTs + 1);
        return lastMonotonicTs;
    }

    function bumpKeyVersion(key) {
        const nextVer = (keyVersionMap.get(key) || 0) + 1;
        keyVersionMap.set(key, nextVer);
        return nextVer;
    }

    function savePhysTs(key, ts) {
        physTsMap[key] = ts;
        try {
            rawSet.call(window.localStorage, META_TS_KEY, JSON.stringify(physTsMap));
        } catch (e) {}
    }

    function isOffloadMarker(val) {
        return typeof val === 'string' && val.startsWith(OFFLOAD_MARKER);
    }

    function shouldOffloadKey(key, valStr) {
        if (!valStr) return false;
        const limit = OFFLOAD_LIMITS[key] || OFFLOAD_LIMITS.default;
        return valStr.length >= limit;
    }

    function unwrapIdbRecord(rec) {
        if (typeof rec === 'string') return { val: rec, ts: 0 };
        if (rec && typeof rec === 'object' && rec.__peaIdbEnv === 1 && typeof rec.val === 'string') {
            return { val: rec.val, ts: Number(rec.ts) || 0 };
        }
        return null;
    }

    // อ่านสถานะเริ่มต้นจาก localStorage เข้า RAM ทันทีที่โหลดสคริปต์ (0ms)
    MANAGED_KEYS.forEach((key) => {
        try {
            const physVal = rawGet.call(window.localStorage, key);
            bootPhysicalState.set(key, physVal);
            if (isOffloadMarker(physVal) || (physVal === null && physTsMap[key])) {
                hydratingOffloadedKeys.add(key);
                ramCache.set(key, EMPTY_FALLBACK[key] ?? '[]');
            } else if (physVal !== null) {
                ramCache.set(key, physVal);
            }
        } catch (e) {}
    });

    function ensureDbOpen() {
        if (dbInst) return Promise.resolve(dbInst);
        if (dbOpenPromise) return dbOpenPromise;
        if (!('indexedDB' in window)) return Promise.resolve(null);

        dbOpenPromise = new Promise((resolve) => {
            let settled = false;
            const finish = (val) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                dbOpenPromise = null;
                resolve(val);
            };
            const timer = setTimeout(() => finish(null), IDB_OPEN_TIMEOUT_MS);

            let req;
            try {
                req = indexedDB.open(DB_NAME, 1);
            } catch (e) {
                return finish(null);
            }
            req.onupgradeneeded = (ev) => {
                const db = ev.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
            };
            req.onblocked = () => finish(null);
            req.onerror = () => finish(null);
            req.onsuccess = (ev) => {
                const openedDb = ev.target.result;
                openedDb.onversionchange = () => {
                    try { openedDb.close(); } catch (e) {}
                    if (dbInst === openedDb) dbInst = null;
                };
                openedDb.onclose = () => {
                    if (dbInst === openedDb) dbInst = null;
                };
                if (settled) {
                    try { openedDb.close(); } catch (e) {}
                    return;
                }
                dbInst = openedDb;
                finish(dbInst);
            };
        });
        return dbOpenPromise;
    }

    async function idbPutEnvelope(key, valStr, ts) {
        const db = dbInst || await ensureDbOpen();
        if (!db) return false;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).put({ __peaIdbEnv: 1, ts, val: valStr }, key);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
                tx.onabort = () => resolve(false);
            } catch (e) {
                resolve(false);
            }
        });
    }

    async function idbGetEnvelope(key) {
        const db = dbInst || await ensureDbOpen();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const req = tx.objectStore(STORE_NAME).get(key);
                req.onsuccess = () => resolve(unwrapIdbRecord(req.result));
                req.onerror = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        });
    }

    async function idbDelete(key) {
        const db = dbInst || await ensureDbOpen();
        if (!db) return false;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).delete(key);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
                tx.onabort = () => resolve(false);
            } catch (e) {
                resolve(false);
            }
        });
    }

    async function idbClearAll() {
        const db = dbInst || await ensureDbOpen();
        if (!db) return;
        try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).clear();
        } catch (e) {}
    }

    function getItemRecencyMs(obj) {
        if (!obj || typeof obj !== 'object') return 0;
        const iso = obj.updatedAt || obj.editedAt || obj.deletedAt || obj.savedAt || obj.timestamp || obj.dateTimeSaved;
        if (!iso) return 0;
        const ms = typeof iso === 'number' ? iso : new Date(iso).getTime();
        return isNaN(ms) ? 0 : ms;
    }

    function filterDeletedPinsJson(pinsJsonStr, delMapJsonStr) {
        if (!pinsJsonStr || !delMapJsonStr || delMapJsonStr === '{}') return pinsJsonStr;
        try {
            const pins = JSON.parse(pinsJsonStr);
            const delMap = JSON.parse(delMapJsonStr);
            if (!Array.isArray(pins) || !delMap || typeof delMap !== 'object') return pinsJsonStr;
            const filtered = pins.filter((p) => {
                if (!p || !p.id) return false;
                const dIso = delMap[p.id];
                if (!dIso) return true;
                return (new Date(p.updatedAt || 0).getTime() || 0) > (new Date(dIso).getTime() || 0);
            });
            return filtered.length !== pins.length ? JSON.stringify(filtered) : pinsJsonStr;
        } catch (e) {
            return pinsJsonStr;
        }
    }

    function mergeOffloadedJson(key, idbStr, earlyDeltaStr) {
        if (!earlyDeltaStr || earlyDeltaStr === '[]' || earlyDeltaStr === '{}' || earlyDeltaStr === idbStr) return idbStr;
        try {
            const idbData = JSON.parse(idbStr);
            const ramData = JSON.parse(earlyDeltaStr);
            if (Array.isArray(idbData) && Array.isArray(ramData) && ramData.length > 0) {
                if (idbData.some((x) => typeof x !== 'object' || x === null) || ramData.some((x) => typeof x !== 'object' || x === null)) {
                    return JSON.stringify(Array.from(new Set([...idbData, ...ramData])));
                }
                const map = new Map();
                const getKey = (it) => {
                    const explicitId = it?.id || it?.recordId || it?.jobId || it?.logId || it?.uid || it?.timestamp || it?.dateTimeSaved;
                    return explicitId ? `id_${explicitId}` : `raw_${JSON.stringify(it)}`;
                };
                idbData.forEach((it) => map.set(getKey(it), it));
                ramData.forEach((it) => {
                    const itemKey = getKey(it);
                    const prev = map.get(itemKey);
                    if (!prev || getItemRecencyMs(it) >= getItemRecencyMs(prev)) map.set(itemKey, it);
                });
                return JSON.stringify(Array.from(map.values()));
            }
            if (idbData && typeof idbData === 'object' && !Array.isArray(idbData) && ramData && typeof ramData === 'object' && !Array.isArray(ramData)) {
                return JSON.stringify({ ...idbData, ...ramData });
            }
        } catch (e) {}
        return idbStr;
    }

    function dispatchSyntheticStorageEvent(key, newVal) {
        let ev = null;
        try {
            ev = new StorageEvent('storage', { key, newValue: newVal, oldValue: null, storageArea: window.localStorage });
        } catch (e1) {
            try {
                ev = new StorageEvent('storage', { key, newValue: newVal, oldValue: null });
            } catch (e2) {}
        }
        if (ev) {
            try { window.dispatchEvent(ev); } catch (e) {}
        }
    }

    function triggerAppRefreshForKeys(keysArr, isInitialBoot = false) {
        if (!keysArr || !keysArr.length) return;
        const simActive = Boolean(window.PeaCore?.simSandbox?.active);

        const hasEquipUpdate = keysArr.some((k) =>
            k === 'elec_labeled_places_list' ||
            k === 'elec_deleted_labeled_places_map' ||
            k === 'elec_deleted_equip_audit_logs'
        );
        if (hasEquipUpdate && !simActive) {
            try {
                window.PeaCore?.refreshRamDelPinsIndex?.();
                const parsed = JSON.parse(ramCache.get('elec_labeled_places_list') || '[]');
                window.PeaCore?.refreshRamPinsIndex?.(parsed);
            } catch (e) {}
        }

        if (typeof window.PeaCore?.notifyStorageUpdated === 'function') {
            window.PeaCore.notifyStorageUpdated(keysArr);
        } else {
            keysArr.forEach((key) => dispatchSyntheticStorageEvent(key, ramCache.get(key) ?? null));
        }

        if (hasEquipUpdate && !simActive) {
            window.refreshFaultSourceOptions?.();
            window.onTieAdvisorFeederFilterChange?.();
            if (isInitialBoot) {
                if (rawGet.call(window.localStorage, 'elec_app_logged_in') === 'true' && typeof window.__onScadaRoleUpdated === 'function') {
                    window.__onScadaRoleUpdated();
                } else {
                    window.renderLabeledPlacesList?.(true);
                }
            }
        }
        if (keysArr.some((k) => k === 'elecReportsComplete_all' || k === 'fault_reports_all' || k === 'faultHistory' || k === 'outageHistory')) {
            window.loadFaultHistory?.();
            window.loadOutageHistory?.();
            window.autoFillJobNo?.(false);
            window.renderJobCards?.();
        }
        if (keysArr.includes('overdue_ca_list') || keysArr.includes('elec_ca_overdue_list')) {
            window.reloadOverdueCaFromStorage?.();
            window.syncCaAndStripBadges?.();
            const rawCa = ramCache.get('overdue_ca_list') || ramCache.get('elec_ca_overdue_list') || '[]';
            try {
                const cnt = String(JSON.parse(rawCa).length);
                document.querySelectorAll('#caCountBadge').forEach((el) => { el.textContent = cnt; });
            } catch (e) {}
            window.renderCaModalList?.();
        }
    }

    async function reloadSingleKeyFromIdb(key, minTs = 0) {
        const verBefore = keyVersionMap.get(key) || 0;
        const env = await idbGetEnvelope(key);
        if ((keyVersionMap.get(key) || 0) !== verBefore) return;
        if (env && (!minTs || env.ts >= minTs) && env.val !== ramCache.get(key)) {
            if (env.ts) physTsMap[key] = env.ts;
            hydratingOffloadedKeys.delete(key);
            ramCache.set(key, env.val);
            triggerAppRefreshForKeys([key], false);
        }
    }

    // ซิงค์ข้ามหน้าจอแยก (index.html <-> page2.html <-> tx-load-form.html)
    window.addEventListener('storage', function (e) {
        if (!e || e.isTrusted === false) return;
        if (e.key === null) {
            clearEpoch++;
            hydratingOffloadedKeys.clear();
            dirtyWriteQueue.clear();
            ramCache.clear();
            return;
        }
        if (e.key === META_TS_KEY && e.newValue) {
            try { physTsMap = JSON.parse(e.newValue) || physTsMap; } catch (err) {}
            return;
        }
        if (!MANAGED_KEYS.has(e.key)) return;
        if (isOffloadMarker(e.newValue)) {
            e.stopImmediatePropagation();
            if (!bc) reloadSingleKeyFromIdb(e.key);
            return;
        }
        if (e.newValue === null) {
            e.stopImmediatePropagation();
            const verBefore = keyVersionMap.get(e.key) || 0;
            idbGetEnvelope(e.key).then((env) => {
                if ((keyVersionMap.get(e.key) || 0) !== verBefore) return;
                const curPhys = rawGet.call(window.localStorage, e.key);
                if (isOffloadMarker(curPhys) || env) {
                    if (env && env.val !== ramCache.get(e.key)) {
                        ramCache.set(e.key, env.val);
                        triggerAppRefreshForKeys([e.key], false);
                    }
                } else if (curPhys === null) {
                    hydratingOffloadedKeys.delete(e.key);
                    ramCache.delete(e.key);
                    triggerAppRefreshForKeys([e.key], false);
                }
            });
            return;
        }
        const ts = nextWriteTs();
        const ver = bumpKeyVersion(e.key);
        pendingPreReadyOps.delete(e.key);
        hydratingOffloadedKeys.delete(e.key);
        ramCache.set(e.key, e.newValue);
        // บันทึกข้อมูลที่เขียนมาจากแท็บฟอร์มแยก (เช่น tx-load-form.html) ลง IndexedDB อัตโนมัติ
        if (isDbReady && dbInst) {
            dirtyWriteQueue.set(e.key, { op: 'set', valStr: e.newValue, ts, ver, epoch: clearEpoch, offload: shouldOffloadKey(e.key, e.newValue) });
            flushKeyWriteQueue(e.key);
        }
    }, true);

    if (bc) {
        bc.onmessage = function (ev) {
            const msg = ev?.data;
            if (!msg || msg.senderId === senderId || !MANAGED_KEYS.has(msg.key)) return;
            if (msg.type === 'IDB_KV_SET') {
                const curTs = Number(physTsMap[msg.key]) || 0;
                if (msg.ts && curTs > msg.ts) return;
                bumpKeyVersion(msg.key);
                pendingPreReadyOps.delete(msg.key);
                if (msg.ts) physTsMap[msg.key] = msg.ts;
                hydratingOffloadedKeys.delete(msg.key);
                if (ramCache.get(msg.key) === msg.valStr) return;
                ramCache.set(msg.key, msg.valStr);
                triggerAppRefreshForKeys([msg.key], false);
            } else if (msg.type === 'IDB_KV_RELOAD') {
                const curTs = Number(physTsMap[msg.key]) || 0;
                if (msg.ts && curTs > msg.ts) return;
                reloadSingleKeyFromIdb(msg.key, msg.ts || 0);
            } else if (msg.type === 'IDB_KV_REM') {
                bumpKeyVersion(msg.key);
                pendingPreReadyOps.delete(msg.key);
                hydratingOffloadedKeys.delete(msg.key);
                if (!ramCache.has(msg.key)) return;
                ramCache.delete(msg.key);
                triggerAppRefreshForKeys([msg.key], false);
            }
        };
    }

    async function flushKeyWriteQueue(key) {
        if (inFlightKeys.has(key)) return;
        inFlightKeys.add(key);
        try {
            while (dirtyWriteQueue.has(key)) {
                const job = dirtyWriteQueue.get(key);
                dirtyWriteQueue.delete(key);
                if (job.epoch !== clearEpoch || (keyVersionMap.get(key) || 0) !== job.ver) continue;

                if (job.op === 'del') {
                    await idbDelete(key);
                    continue;
                }

                const ok = await idbPutEnvelope(key, job.valStr, job.ts);
                if (job.epoch !== clearEpoch) { await idbClearAll(); continue; }
                if (!ramCache.has(key)) { await idbDelete(key); continue; }
                if ((keyVersionMap.get(key) || 0) !== job.ver || dirtyWriteQueue.has(key)) continue;

                if (ok && job.offload) {
                    const curPhys = rawGet.call(window.localStorage, key);
                    if (!isOffloadMarker(curPhys) || !bc) {
                        const markerVal = bc ? OFFLOAD_MARKER : `${OFFLOAD_MARKER}:${job.ts}`;
                        try {
                            rawSet.call(window.localStorage, key, markerVal);
                        } catch (e) {
                            try {
                                rawRem.call(window.localStorage, key);
                                rawSet.call(window.localStorage, key, markerVal);
                            } catch (e2) {}
                        }
                    }
                    savePhysTs(key, job.ts);
                    if (bc && job.valStr.length > BC_INLINE_MAX_CHARS) {
                        try { bc.postMessage({ type: 'IDB_KV_RELOAD', key, ts: job.ts, senderId }); } catch (e) {}
                    }
                } else if (!ok && job.offload) {
                    try {
                        rawSet.call(window.localStorage, key, job.valStr);
                        savePhysTs(key, job.ts);
                    } catch (e) {}
                }
            }
        } finally {
            inFlightKeys.delete(key);
            if (dirtyWriteQueue.has(key)) flushKeyWriteQueue(key);
        }
    }

    function persistManagedKeyPhysical(key, valStr, ts, ver, broadcast = true) {
        const writeTs = ts || nextWriteTs();
        const writeVer = ver || (keyVersionMap.get(key) || bumpKeyVersion(key));
        let offload = shouldOffloadKey(key, valStr);

        if (!offload) {
            try {
                if (rawGet.call(window.localStorage, key) !== valStr) {
                    rawSet.call(window.localStorage, key, valStr);
                }
                savePhysTs(key, writeTs);
            } catch (quotaErr) {
                offload = true;
                ['elec_auto_backup_snapshot', 'elec_app_auto_backup_snapshot', 'elec_cloud_group_backups_map', 'elec_tx_load_records_v1'].forEach((bkKey) => {
                    if (key !== bkKey && ramCache.has(bkKey)) {
                        const bkStr = ramCache.get(bkKey);
                        const bkVer = bumpKeyVersion(bkKey);
                        dirtyWriteQueue.set(bkKey, { op: 'set', valStr: bkStr, ts: writeTs, ver: bkVer, epoch: clearEpoch, offload: true });
                        flushKeyWriteQueue(bkKey);
                    }
                });
            }
        }

        if (broadcast && bc && valStr.length <= BC_INLINE_MAX_CHARS) {
            try { bc.postMessage({ type: 'IDB_KV_SET', key, valStr, ts: writeTs, senderId }); } catch (e) {}
        }

        dirtyWriteQueue.set(key, { op: 'set', valStr, ts: writeTs, ver: writeVer, epoch: clearEpoch, offload });
        flushKeyWriteQueue(key);
    }

    function enqueueKeyDelete(key, ver) {
        dirtyWriteQueue.set(key, { op: 'del', ts: nextWriteTs(), ver, epoch: clearEpoch });
        flushKeyWriteQueue(key);
    }

    // รองรับโหมดซ้อมสับ-ปลด (simSandbox ของ shared-core.js และ scada-tie-advisor.js) ทั้งขาอ่านและขาเขียน
    const idbGetItemFn = function (key) {
        if (this === window.localStorage) {
            if (key === PENDING_PUSH_KEY && hydratingOffloadedKeys.size > 0) return null;
            if (key === 'elec_labeled_places_list' &&
                Storage.prototype.getItem === idbGetItemFn &&
                window.localStorage.getItem === idbGetItemFn &&
                window.PeaCore?.simSandbox?.active &&
                typeof window.PeaCore.simSandbox.workingJson === 'string') {
                return window.PeaCore.simSandbox.workingJson;
            }
            if (MANAGED_KEYS.has(key)) {
                if (ramCache.has(key)) return ramCache.get(key);
                const v = rawGet.call(this, key);
                return isOffloadMarker(v) ? (EMPTY_FALLBACK[key] ?? null) : v;
            }
        }
        return rawGet.call(this, key);
    };

    const idbSetItemFn = function (key, value) {
        if (this !== window.localStorage || !MANAGED_KEYS.has(key)) {
            return rawSet.call(this, key, value);
        }
        const valStr = String(value ?? '');
        if (isOffloadMarker(valStr)) return;
        if (key === 'elec_labeled_places_list' &&
            Storage.prototype.setItem === idbSetItemFn &&
            window.localStorage.setItem === idbSetItemFn &&
            window.PeaCore?.simSandbox?.active) {
            window.PeaCore.simSandbox.workingJson = valStr;
            return;
        }
        if (hydratingOffloadedKeys.has(key) && (valStr === '[]' || valStr === '{}' || valStr === '')) return;
        if ((key === 'elec_auto_backup_snapshot' || key === 'elec_app_auto_backup_snapshot') && hydratingOffloadedKeys.size > 0) return;

        const ts = nextWriteTs();
        const ver = bumpKeyVersion(key);
        ramCache.set(key, valStr);

        if (!hydratedKeys.has(key) || !dbInst) {
            pendingPreReadyOps.set(key, { op: 'set', valStr, ts, ver });
            if (!isOffloadMarker(bootPhysicalState.get(key)) && !shouldOffloadKey(key, valStr)) {
                try {
                    rawSet.call(this, key, valStr);
                    savePhysTs(key, ts);
                } catch (e) {}
            }
            if (bc && valStr.length <= BC_INLINE_MAX_CHARS) {
                try { bc.postMessage({ type: 'IDB_KV_SET', key, valStr, ts, senderId }); } catch (e) {} }
            return;
        }

        hydratingOffloadedKeys.delete(key);
        persistManagedKeyPhysical(key, valStr, ts, ver, true);
    };

    Storage.prototype.getItem = idbGetItemFn;
    Storage.prototype.setItem = idbSetItemFn;

    Storage.prototype.removeItem = function (key) {
        if (this === window.localStorage) {
            if (key === ACTIVE_NAV_KEY && hydratingOffloadedKeys.has('elec_labeled_places_list')) return;
            if (MANAGED_KEYS.has(key)) {
                const ver = bumpKeyVersion(key);
                hydratingOffloadedKeys.delete(key);
                ramCache.delete(key);
                delete physTsMap[key];
                try { rawSet.call(window.localStorage, META_TS_KEY, JSON.stringify(physTsMap)); } catch (e) {}
                if (!hydratedKeys.has(key) || !dbInst) {
                    pendingPreReadyOps.set(key, { op: 'del', ts: nextWriteTs(), ver });
                } else {
                    enqueueKeyDelete(key, ver);
                }
                if (bc) { try { bc.postMessage({ type: 'IDB_KV_REM', key, senderId }); } catch (e) {} }
            }
        }
        return rawRem.call(this, key);
    };

    Storage.prototype.clear = function () {
        if (this === window.localStorage) {
            clearEpoch++;
            MANAGED_KEYS.forEach(bumpKeyVersion);
            hydratingOffloadedKeys.clear();
            pendingPreReadyOps.clear();
            dirtyWriteQueue.clear();
            ramCache.clear();
            physTsMap = {};
            idbClearAll();
        }
        return rawClr.call(this);
    };

    async function hydrateAllManagedKeys() {
        const db = await ensureDbOpen();
        if (!db) {
            MANAGED_KEYS.forEach((k) => hydratedKeys.add(k));
            isDbReady = true;
            hydratingOffloadedKeys.clear();
            return false;
        }

        const orderedKeys = [
            'elec_deleted_labeled_places_map',
            ...Array.from(MANAGED_KEYS).filter((k) => k !== 'elec_deleted_labeled_places_map')
        ];
        const envMap = new Map();
        await Promise.all(orderedKeys.map(async (k) => {
            envMap.set(k, await idbGetEnvelope(k));
        }));

        const updatedKeys = new Set();
        orderedKeys.forEach((key) => {
            const env = envMap.get(key);
            const bootPhys = bootPhysicalState.get(key);
            const latestPreOp = pendingPreReadyOps.get(key);
            const receivedLiveExternalSync = (keyVersionMap.get(key) || 0) > 0 && !latestPreOp;
            pendingPreReadyOps.delete(key);
            hydratedKeys.add(key);
            hydratingOffloadedKeys.delete(key);

            if (receivedLiveExternalSync) return;

            if (latestPreOp?.op === 'del') {
                enqueueKeyDelete(key, latestPreOp.ver);
                return;
            }

            if (isOffloadMarker(bootPhys) || bootPhys === null) {
                if (env && env.val.length > 0) {
                    let merged = latestPreOp?.op === 'set' ? mergeOffloadedJson(key, env.val, latestPreOp.valStr) : env.val;
                    if (key === 'elec_labeled_places_list') {
                        merged = filterDeletedPinsJson(merged, ramCache.get('elec_deleted_labeled_places_map'));
                    }
                    const ver = bumpKeyVersion(key);
                    ramCache.set(key, merged);
                    const needSyncDisk = merged !== env.val || (shouldOffloadKey(key, merged) !== isOffloadMarker(bootPhys));
                    if (needSyncDisk) {
                        persistManagedKeyPhysical(key, merged, nextWriteTs(), ver, Boolean(latestPreOp));
                    }
                    updatedKeys.add(key);
                } else if (latestPreOp?.op === 'set') {
                    persistManagedKeyPhysical(key, latestPreOp.valStr, latestPreOp.ts, latestPreOp.ver, true);
                } else if (isOffloadMarker(bootPhys)) {
                    try { rawSet.call(window.localStorage, key, EMPTY_FALLBACK[key] ?? '[]'); } catch (e) {}
                }
            } else if (typeof bootPhys === 'string') {
                const physTs = Number(physTsMap[key]) || 0;
                const finalVal = latestPreOp?.op === 'set'
                    ? latestPreOp.valStr
                    : ((env && env.ts > physTs && env.val && env.val !== bootPhys) ? env.val : bootPhys);
                const ver = bumpKeyVersion(key);
                ramCache.set(key, finalVal);
                if (finalVal !== bootPhys) updatedKeys.add(key);

                if (!env || env.val !== finalVal || finalVal !== bootPhys || shouldOffloadKey(key, finalVal)) {
                    persistManagedKeyPhysical(
                        key,
                        finalVal,
                        latestPreOp?.ts || Math.max(physTs, env?.ts || 0) || nextWriteTs(),
                        ver,
                        Boolean(latestPreOp)
                    );
                }
            }
        });

        // เชื่อมข้อมูล CA จากคีย์เดิม (ถ้ามี) เข้าสู่คีย์หลัก overdue_ca_list อัตโนมัติ
        const mainCa = ramCache.get('overdue_ca_list');
        const legacyCa = ramCache.get('elec_ca_overdue_list');
        if ((!mainCa || mainCa === '[]') && legacyCa && legacyCa !== '[]') {
            const ts = nextWriteTs(), ver = bumpKeyVersion('overdue_ca_list');
            ramCache.set('overdue_ca_list', legacyCa);
            persistManagedKeyPhysical('overdue_ca_list', legacyCa, ts, ver, false);
            updatedKeys.add('overdue_ca_list');
        }

        hydratingOffloadedKeys.clear();
        isDbReady = true;

        if (updatedKeys.size > 0) triggerAppRefreshForKeys(Array.from(updatedKeys), true);
        if (rawGet.call(window.localStorage, PENDING_PUSH_KEY) === 'true') {
            setTimeout(() => window.pushAllJobsToCloud?.(true), 300);
        }
        return true;
    }

    const readyPromise = hydrateAllManagedKeys();

    function ensureFetchBootGuarded() {
        if (typeof window.fetch !== 'function' || window.fetch.__peaIdbOuterGuarded) return;
        const prevFetch = window.fetch;
        const bootSafeFetch = function () {
            if (!isDbReady || hydratingOffloadedKeys.size > 0) {
                const args = arguments;
                return readyPromise.then(() => prevFetch.apply(window, args));
            }
            return prevFetch.apply(window, arguments);
        };
        bootSafeFetch.__peaIdbOuterGuarded = true;
        window.fetch = bootSafeFetch;
    };
    ensureFetchBootGuarded();

    function attachPostCoreGuards() {
        ensureFetchBootGuarded();

        // ป้องกัน PeaCore.rawStorageGet คืนค่า "__PEA_IDB_OFFLOAD__" ตอนที่ scada-tie-advisor.js หรือโหมดซ้อมดึงผังจริงก่อนจำลองสับพ่วง
        if (window.PeaCore && typeof window.PeaCore.rawStorageGet === 'function' && !window.PeaCore.rawStorageGet.__peaIdbGuarded) {
            const origRawGet = window.PeaCore.rawStorageGet;
            const safeRawGet = function (key) {
                if (MANAGED_KEYS.has(key) && ramCache.has(key)) {
                    return ramCache.get(key);
                }
                const v = origRawGet.call(window.PeaCore, key);
                return isOffloadMarker(v) ? (EMPTY_FALLBACK[key] ?? null) : v;
            };
            safeRawGet.__peaIdbGuarded = true;
            window.PeaCore.rawStorageGet = safeRawGet;
        }

        if (typeof window.pushAllJobsToCloud === 'function' && !window.pushAllJobsToCloud.__idbGuarded) {
            const origPush = window.pushAllJobsToCloud;
            const guardedPush = async function () {
                if (!isDbReady || hydratingOffloadedKeys.size > 0) await readyPromise;
                return origPush.apply(this, arguments);
            };
            guardedPush.__idbGuarded = true;
            window.pushAllJobsToCloud = guardedPush;
        }
    }
    setTimeout(attachPostCoreGuards, 0);
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', attachPostCoreGuards);
    else attachPostCoreGuards();
    window.addEventListener('load', attachPostCoreGuards);

    window.PeaIdbStore = {
        ready: readyPromise,
        isHydrating: () => !isDbReady || hydratingOffloadedKeys.size > 0,
        getCommittedItem: (key) => {
            if (MANAGED_KEYS.has(key) && ramCache.has(key)) return ramCache.get(key);
            const v = rawGet.call(window.localStorage, key);
            return isOffloadMarker(v) ? (EMPTY_FALLBACK[key] ?? null) : v;
        },
        getStats() {
            const report = {};
            MANAGED_KEYS.forEach((k) => {
                const ram = ramCache.get(k) || '';
                const phys = rawGet.call(window.localStorage, k);
                report[k] = {
                    sizeKB: Number((ram.length / 1024).toFixed(1)),
                    mode: isOffloadMarker(phys) ? 'IndexedDB (Offloaded)' : 'Mirrored (IDB + LocalStorage)',
                    lastUpdatedTs: physTsMap[k] || 0
                };
            });
            return report;
        }
    };
})();
// ==================== จบไฟล์ pea-idb-store.js (v2.2) ====================