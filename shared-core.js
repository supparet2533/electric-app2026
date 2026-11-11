// ============================================================================
// ⚡ PEA SMART GRID — SHARED CORE ENGINE v6.0 (shared-core.js)
// ระบบแกนกลางร่วมสำหรับ index.html และ page2.html
// พาทที่ 1 / 2 : Config, RBAC, UI Modals, Unified Storage Bus & Job Registries
// ============================================================================
(function () {
    'use strict';

    const CLOUD_USER_API_URL = "https://script.google.com/macros/s/AKfycbzLEIlMtJ2u9U8XsSCAbta_Df2mmhzlNN-O2ZKrxH4RiN8-DTyw8bIIn2PCzl9eokpI/exec";
    const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
    const MAX_REGISTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const ONLINE_THRESHOLD_MS = 180 * 1000;
    const CHANNEL_NAME = 'pea_smart_grid_hyper_v4';
    const SHORT_LINK_CACHE_KEY = 'elec_resolved_shortlinks_cache_v2';
    const SHORT_URL_REGEX = /(?:https?:\/\/)?(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/[A-Za-z0-9_-]+(?:\?[^\s"'<>]*)?/i;
    const LAST_GROUP_SESSION_KEY = 'elec_last_logged_group_name';
    const REGISTRY_LOC_KEY = '__NAV_CANCEL_REGISTRY__';

    const isEmbeddedIframe = (window.self !== window.top);
    const MY_PEER_ID = 'p20k_' + Math.random().toString(36).substring(2, 9) + '_' + (Date.now() % 100000);

    const SYNC_KEYS = new Set([
        'elecReportsComplete_all', 'fault_reports_all',
        'elec_closed_jobs_registry', 'elec_deleted_jobs_registry',
        'elec_tech_locations_map', 'elec_active_equip_nav_map_v2',
        'elec_cancelled_equip_nav_map', 'elec_cancelled_job_nav_map',
        'elec_labeled_places_list', 'elec_deleted_labeled_places_map',
        'elec_deleted_equip_audit_logs'
    ]);
    const LOCAL_WATCHED_KEYS = new Set([...SYNC_KEYS, 'elec_user_accounts']);

    const THEME_RGB_LIST = [
        { key: 'green', hex: '#10b981', r: 16, g: 185, b: 129 },
        { key: 'yellow', hex: '#eab308', r: 234, g: 179, b: 8 },
        { key: 'orange', hex: '#f97316', r: 249, g: 115, b: 22 },
        { key: 'red', hex: '#ef4444', r: 239, g: 68, b: 68 },
        { key: 'blue', hex: '#0ea5e9', r: 14, g: 165, b: 233 },
        { key: 'purple', hex: '#8b5cf6', r: 139, g: 92, b: 246 },
        { key: 'brown', hex: '#a16207', r: 161, g: 98, b: 7 }
    ];

    const nativeGetItem = Storage.prototype.getItem;
    const nativeSetItem = Storage.prototype.setItem;
    const nativeRemoveItem = Storage.prototype.removeItem;
    const nativeFetch = window.fetch;

    // ตัวแปรสถานะร่วมสำหรับ Storage Bus, Cloud Sync & MQTT
    let cachedAccountsStr = '';
    let cachedParsedAccounts = [];
    let isGroupViewFilterActive = false;
    let isApplyingRemotePacket = false;
    let isInternalSanitizing = false;
    let inFlightCloudGetCount = 0;
    let allowWriteUntilMs = 0;
    let forceManualGet = false;
    let lastRealSheetGetMs = 0;
    let cachedSheetText = nativeGetItem.call(localStorage, 'elec_sheet_cache_2k') || null;

    function rawStorageGet(key) {
        return nativeGetItem.call(localStorage, key);
    }

    function rawStorageSet(key, val) {
        try {
            nativeSetItem.call(localStorage, key, val);
        } catch (err) {
            try {
                nativeRemoveItem.call(localStorage, 'elec_closed_reports_map');
                nativeRemoveItem.call(localStorage, 'elec_app_auto_backup_snapshot');
                const reg = JSON.parse(rawStorageGet('elec_closed_jobs_registry') || '{}');
                nativeSetItem.call(localStorage, 'elec_closed_jobs_registry', JSON.stringify(pruneClosedRegistryMap(reg)));
                nativeSetItem.call(localStorage, key, val);
            } catch (e) {
                if (typeof showToast === 'function') {
                    showToast('⚠️ ความจำเบราว์เซอร์เต็ม กรุณาสำรองข้อมูลออกเป็นไฟล์');
                }
            }
        }
    }

    // ========================================================================
    // 1. ระบบแยกกลุ่มสังกัด (กฟส.), รหัสพนักงาน และสิทธิ์การใช้งาน (RBAC)
    // ========================================================================
    function getActiveCloudApiUrl() {
        const custom = (rawStorageGet('elec_cloud_user_api_url') || '').trim();
        if (custom && custom.startsWith('https://script.google.com/')) return custom;
        return CLOUD_USER_API_URL;
    }

    function getUserGroupName(username) {
        if (!username) return '';
        const s = String(username).trim();
        if (s.toLowerCase() === 'admin') return '';
        const peaMatch = s.match(/(กฟ[สฟจตอ]\.?.*)$/);
        if (peaMatch) return peaMatch[1].trim();
        const parts = s.split(/\s+/);
        if (parts.length > 1) return parts.slice(1).join(' ').trim();
        const numGroupMatch = s.match(/^(\d{4,10})([ก-๙a-zA-Z].*)$/);
        if (numGroupMatch) return numGroupMatch[2].trim();
        return '';
    }

    function getUserBaseId(username) {
        if (!username) return '';
        const s = String(username).trim();
        const firstPart = s.split(/\s+/)[0];
        const withoutPea = firstPart.replace(/(กฟ[สฟจตอ]\.?.*)$/, '').trim();
        if (!withoutPea) return s.toLowerCase();
        const numMatch = withoutPea.match(/^(\d{4,10})/);
        return (numMatch ? numMatch[1] : withoutPea).toLowerCase();
    }

    function normalizeUsernameFormat(rawUsername) {
        const s = String(rawUsername || '').trim();
        if (!s) return '';
        const baseId = getUserBaseId(s);
        const groupName = getUserGroupName(s);
        if (baseId && groupName && baseId.toLowerCase() !== groupName.toLowerCase() && s.toLowerCase() !== 'admin') {
            const origBase = s.split(/\s+/)[0].replace(/(กฟ[สฟจตอ]\.?.*)$/, '').trim() || baseId;
            return `${origBase} ${groupName}`;
        }
        return s;
    }

    function isUsernameMatchingAccount(inputUser, accountUser) {
        if (!inputUser || !accountUser) return false;
        const inTrim = String(inputUser).trim().toLowerCase();
        const accTrim = String(accountUser).trim().toLowerCase();
        if (inTrim === accTrim) return true;
        const inBase = getUserBaseId(inputUser);
        const accBase = getUserBaseId(accountUser);
        if (!inBase || !accBase || inBase !== accBase) return false;
        const inGroup = getUserGroupName(inputUser).toLowerCase();
        const accGroup = getUserGroupName(accountUser).toLowerCase();
        if (inGroup && accGroup && inGroup !== accGroup) return false;
        return true;
    }

    function parseAccountRecord(rawAcc) {
        const rawRole = String(rawAcc?.role || 'user');
        const parts = rawRole.split('::');
        const parsed = {
            username: normalizeUsernameFormat(rawAcc?.username || ''),
            password: String(rawAcc?.password || '').trim(),
            role: parts[0] || 'user',
            sessionToken: rawAcc?.sessionToken !== undefined ? rawAcc.sessionToken : (parts[1] || ''),
            displayName: rawAcc?.displayName !== undefined ? String(rawAcc.displayName).trim() : (parts[2] || '').trim()
        };
        if (rawStorageGet('elec_app_logged_in') === 'true') {
            const curUser = rawStorageGet('elec_app_current_user') || '';
            const localToken = rawStorageGet('elec_app_session_token') || '';
            if (curUser && localToken && isUsernameMatchingAccount(curUser, parsed.username)) {
                parsed.sessionToken = localToken;
            }
        }
        return parsed;
    }

    function getParsedUserAccounts() {
        const rawStr = rawStorageGet('elec_user_accounts') || '[]';
        if (rawStr !== cachedAccountsStr) {
            cachedAccountsStr = rawStr;
            try {
                const arr = JSON.parse(rawStr);
                cachedParsedAccounts = Array.isArray(arr) ? arr.map(parseAccountRecord) : [];
            } catch (e) { cachedParsedAccounts = []; }
        }
        return cachedParsedAccounts;
    }

    function formatTechDisplayName(rawNameOrList) {
        if (!rawNameOrList || rawNameOrList === '-') return '-';
        const str = String(rawNameOrList).trim();
        if (str.includes(',')) {
            return str.split(',').map(s => formatTechDisplayName(s.trim())).join(', ');
        }
        const accounts = getParsedUserAccounts();
        const matched = accounts.find(a => isUsernameMatchingAccount(str, a.username));
        if (matched && matched.displayName) {
            const grp = getUserGroupName(matched.username) || getUserGroupName(str);
            return (grp && !matched.displayName.includes(grp)) ? `${matched.displayName} ${grp}` : matched.displayName;
        }
        return str;
    }

    function isSameTechPerson(nameA, nameB) {
        if (!nameA || !nameB) return false;
        if (isUsernameMatchingAccount(nameA, nameB)) return true;
        const dA = formatTechDisplayName(nameA).toLowerCase().replace(/\s+/g, '');
        const dB = formatTechDisplayName(nameB).toLowerCase().replace(/\s+/g, '');
        return Boolean(dA && dB && dA === dB);
    }

    function getValidSystemGroupsSet() {
        const set = new Set();
        getParsedUserAccounts().forEach(a => {
            const g = getUserGroupName(a.username);
            if (g) set.add(g);
        });
        return set;
    }

    function getCurrentUserGroup() {
        const curUser = rawStorageGet('elec_app_current_user') || '';
        const direct = getUserGroupName(curUser);
        if (direct) return direct;
        const saved = rawStorageGet('elec_app_current_group') || '';
        if (saved) return saved;
        const baseId = getUserBaseId(curUser);
        const matched = getParsedUserAccounts().find(a => isUsernameMatchingAccount(curUser, a.username) || getUserBaseId(a.username) === baseId);
        return matched ? getUserGroupName(matched.username) : '';
    }

    function getJobGroupName(job) {
        if (!job) return '';
        const validGroups = getValidSystemGroupsSet();
        if (job.ownerGroup && String(job.ownerGroup).trim() !== '') {
            const og = String(job.ownerGroup).trim();
            if (validGroups.size === 0 || validGroups.has(og) || /^กฟ/.test(og)) return og;
        }
        const accounts = getParsedUserAccounts();
        const candidates = [job.ownerUser, job.techNav?.techName, job.techReport?.inspector].filter(Boolean);
        for (const c of candidates) {
            const g = getUserGroupName(c);
            if (g && (validGroups.size === 0 || validGroups.has(g) || /^กฟ/.test(g))) return g;
            const cBase = getUserBaseId(c);
            if (cBase) {
                const acc = accounts.find(a => isUsernameMatchingAccount(c, a.username) || getUserBaseId(a.username) === cBase);
                if (acc && getUserGroupName(acc.username)) return getUserGroupName(acc.username);
            }
        }
        return 'กฟส.บึง';
    }

    function isCurrentUserAdmin() {
        return rawStorageGet('elec_app_logged_in') === 'true' && rawStorageGet('elec_app_current_role') === 'admin';
    }
    function isViewerRole() {
        return rawStorageGet('elec_app_logged_in') === 'true' && rawStorageGet('elec_app_current_role') === 'viewer';
    }
    function canCurrentUserEditScada() {
        if (rawStorageGet('elec_app_logged_in') !== 'true') return false;
        const r = (rawStorageGet('elec_app_current_role') || '').trim();
        return r === 'admin' || r === 'user';
    }
    function canCurrentUserSeeJob(job) {
        if ((rawStorageGet('elec_app_current_role') || 'user') === 'admin') return true;
        const myGroup = getCurrentUserGroup();
        return !myGroup || myGroup === getJobGroupName(job);
    }

    function runWithGroupViewFilter(fn, context, args) {
        isGroupViewFilterActive = true;
        try {
            return fn.apply(context, args || []);
        } finally {
            isGroupViewFilterActive = false;
        }
    }

    function escapeHtmlStr(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function hexToClosestPinColorKey(hexStr) {
        const s = String(hexStr || '').trim();
        if (!/^#[0-9A-Fa-f]{6}$/.test(s)) return 'green';
        const r = parseInt(s.slice(1, 3), 16), g = parseInt(s.slice(3, 5), 16), b = parseInt(s.slice(5, 7), 16);
        let best = 'green', minD = Infinity;
        THEME_RGB_LIST.forEach(t => {
            const d = (r - t.r) ** 2 + (g - t.g) ** 2 + (b - t.b) ** 2;
            if (d < minD) { minD = d; best = t.key; }
        });
        return best;
    }

    // ========================================================================
    // 2. กล่องแจ้งเตือนมาตรฐาน (Toast, Alert, Confirm, Prompt) & ส่งออกตาราง
    // ========================================================================
    function showToast(msg) {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.remove('opacity-0');
        t.classList.add('opacity-100');
        clearTimeout(t.__hideTimer);
        t.__hideTimer = setTimeout(() => {
            t.classList.remove('opacity-100');
            t.classList.add('opacity-0');
        }, 2500);
    }

    function showCustomAlert(message, title = '⚡ แจ้งเตือนระบบ') {
        let modal = document.getElementById('customAlertModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'customAlertModal';
            modal.className = 'fixed inset-0 z-[1450] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4 transition-opacity';
            modal.innerHTML = `
                <div class="bg-slate-800 text-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4 border border-slate-700">
                    <h3 id="customAlertTitle" class="text-lg font-bold text-amber-400"></h3>
                    <p id="customAlertMessage" class="text-sm text-slate-200 leading-relaxed whitespace-pre-line"></p>
                    <div class="flex justify-end pt-2">
                        <button type="button" onclick="document.getElementById('customAlertModal').classList.add('hidden')" class="bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm px-5 py-2 rounded-xl shadow transition">ตกลง</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }
        document.getElementById('customAlertTitle').textContent = title;
        document.getElementById('customAlertMessage').textContent = message;
        modal.classList.remove('hidden');
    }
    window.alert = (msg) => showCustomAlert(msg, '⚡ แจ้งเตือนระบบ');

    function showCustomConfirm(message, onConfirm, title = '⚡ ยืนยันการทำรายการ') {
        if (typeof window.__customConfirmInterceptor === 'function') {
            if (window.__customConfirmInterceptor(message, onConfirm, title)) return;
        }
        let modal = document.getElementById('customConfirmModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'customConfirmModal';
            modal.className = 'fixed inset-0 z-[1450] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4 transition-opacity';
            modal.innerHTML = `
                <div class="bg-slate-800 text-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4 border border-slate-700">
                    <h3 id="customConfirmTitle" class="text-lg font-bold text-amber-400"></h3>
                    <p id="customConfirmMessage" class="text-sm text-slate-200 leading-relaxed whitespace-pre-line"></p>
                    <div class="flex justify-end gap-2 pt-2">
                        <button type="button" onclick="document.getElementById('customConfirmModal').classList.add('hidden')" class="text-slate-300 hover:text-white font-semibold text-sm px-4 py-2 rounded-xl hover:bg-slate-700/50 transition">ยกเลิก</button>
                        <button type="button" id="customConfirmOkBtn" class="bg-rose-500 hover:bg-rose-600 text-white font-bold text-sm px-5 py-2 rounded-xl shadow transition">ตกลง</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }
        document.getElementById('customConfirmTitle').textContent = title;
        document.getElementById('customConfirmMessage').textContent = message;
        document.getElementById('customConfirmOkBtn').onclick = function () {
            modal.classList.add('hidden');
            unlockCloudWrite(20000);
            if (typeof onConfirm === 'function') onConfirm();
        };
        modal.classList.remove('hidden');
    }

    function showCustomPrompt(message, defaultValue = '', onConfirm, title = '✏️ แก้ไขข้อมูล') {
        let modal = document.getElementById('customPromptModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'customPromptModal';
            modal.className = 'fixed inset-0 z-[1450] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4 transition-opacity';
            modal.innerHTML = `
                <div class="bg-slate-800 text-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4 border border-slate-700">
                    <h3 id="customPromptTitle" class="text-lg font-bold text-amber-400"></h3>
                    <p id="customPromptMessage" class="text-sm text-slate-200 leading-relaxed"></p>
                    <input type="text" id="customPromptInput" class="w-full px-3.5 py-2 text-slate-800 font-medium rounded-xl text-sm focus:outline-none">
                    <div class="flex justify-end gap-2 pt-2">
                        <button type="button" onclick="document.getElementById('customPromptModal').classList.add('hidden')" class="text-slate-300 hover:text-white font-semibold text-sm px-4 py-2 rounded-xl hover:bg-slate-700/50 transition">ยกเลิก</button>
                        <button type="button" id="customPromptOkBtn" class="bg-blue-500 hover:bg-blue-600 text-white font-bold text-sm px-5 py-2 rounded-xl shadow transition">บันทึก</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }
        document.getElementById('customPromptTitle').textContent = title;
        document.getElementById('customPromptMessage').textContent = message;
        const inp = document.getElementById('customPromptInput');
        inp.value = defaultValue;
        const submit = () => {
            modal.classList.add('hidden');
            unlockCloudWrite(20000);
            if (typeof onConfirm === 'function') onConfirm(inp.value);
        };
        document.getElementById('customPromptOkBtn').onclick = submit;
        inp.onkeypress = (e) => { if (e.key === 'Enter') submit(); };
        modal.classList.remove('hidden');
        setTimeout(() => inp.focus(), 50);
    }

    function copyTextToClipboard(text, successMsg = '📋 คัดลอกข้อความสำเร็จ!') {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => showToast(successMsg)).catch(() => fallbackCopy(text, successMsg));
        } else {
            fallbackCopy(text, successMsg);
        }
    }
    function fallbackCopy(text, successMsg) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand('copy'); showToast(successMsg); } catch (e) { showToast('⚠️ คัดลอกไม่สำเร็จ'); }
        document.body.removeChild(ta);
    }

    function ensureXlsxLibraryLoaded() {
        return new Promise((resolve) => {
            if (typeof XLSX !== 'undefined') return resolve(true);
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
            s.onload = () => resolve(true);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
    }

    function downloadCsvFallback(headers, rows, filename) {
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = '\uFEFF' + [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = String(filename || 'export.csv').replace(/\.xlsx?$/i, '.csv');
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    // ========================================================================
    // 3. ระบบ Storage Bus รวมศูนย์, RAM Index, Quota Guard & Simulation Sandbox
    // ========================================================================
    const simSandbox = {
        active: false,
        committing: false,
        bypassRead: false,
        workingJson: '[]',
        deferredCloudLocReg: null
    };

    const ramIndex = {
        pinsRaw: null,
        pinsById: new Map(),
        hasBackboneSwitches: false,
        delPinsRaw: null,
        delPinsObj: {},
        knownPinUpdatedMs: new Map(),
        pendingJsonImportMap: new Map(),
        topoEpoch: 1
    };

    function refreshRamPinsIndex() {
        const raw = (simSandbox.active && !simSandbox.bypassRead)
            ? simSandbox.workingJson
            : (rawStorageGet('elec_labeled_places_list') || '[]');
        if (raw === ramIndex.pinsRaw) return;
        ramIndex.pinsRaw = raw;
        ramIndex.topoEpoch++;
        ramIndex.pinsById.clear();
        ramIndex.hasBackboneSwitches = false;
        try {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                arr.forEach(p => {
                    if (!p || !p.id) return;
                    ramIndex.pinsById.set(p.id, p);
                    const ms = new Date(p.updatedAt || 0).getTime() || 0;
                    if (ms > (ramIndex.knownPinUpdatedMs.get(p.id) || 0)) {
                        ramIndex.knownPinUpdatedMs.set(p.id, ms);
                    }
                    const t = p.scadaNode?.t;
                    if (t === 'RC' || t === 'CB' || t === 'VB' || t === 'VS' || t === 'VSC' || t === 'S' || t === 'GEN') {
                        ramIndex.hasBackboneSwitches = true;
                    }
                });
            }
        } catch (e) {}
    }

    function refreshRamDelPinsIndex() {
        const raw = rawStorageGet('elec_deleted_labeled_places_map') || '{}';
        if (raw !== ramIndex.delPinsRaw) {
            ramIndex.delPinsRaw = raw;
            ramIndex.topoEpoch++;
            try { ramIndex.delPinsObj = JSON.parse(raw) || {}; } catch (e) { ramIndex.delPinsObj = {}; }
        }
    }

    function slimGroupBackupsJson(rawStr) {
        try {
            if (!rawStr || rawStr.length <= 16000) return rawStr;
            const mapObj = JSON.parse(rawStr);
            Object.keys(mapObj).forEach(grp => {
                const b = mapObj[grp];
                if (!b || typeof b !== 'object') return;
                if (Array.isArray(b.outages)) b.outages = b.outages.slice(0, 25).map(o => { const c = { ...o }; delete c.formattedText; return c; });
                if (Array.isArray(b.faults)) b.faults = b.faults.slice(0, 25).map(f => { const c = { ...f }; delete c.formattedText; return c; });
                if (b.settings) {
                    delete b.settings.elec_labeled_places_list;
                    delete b.settings.elec_deleted_labeled_places_map;
                    delete b.settings.elec_deleted_equip_audit_logs;
                }
            });
            return JSON.stringify(mapObj);
        } catch (e) { return '{}'; }
    }

    function trimAuditLogsForSheetQuota(logsArr) {
        if (!Array.isArray(logsArr)) return [];
        let trimmed = logsArr.slice(0, 50);
        if (JSON.stringify(trimmed).length > 10000) {
            trimmed = trimmed.map((log, idx) => {
                if (idx < 10 || !Array.isArray(log?.scadaLines)) return log;
                const copy = { ...log };
                copy.scadaLines = copy.scadaLines.map(l => { const c = { ...l }; delete c.w; return c; });
                return copy;
            });
        }
        return trimmed;
    }

    function sanitizePinsBeforeWrite(rawValStr) {
        try {
            const parsed = JSON.parse(rawValStr);
            if (!Array.isArray(parsed)) return rawValStr;

            const byId = new Map();
            parsed.forEach(p => {
                if (!p || !p.id) return;
                if (ramIndex.pendingJsonImportMap.size > 0) {
                    const locK = `LOC:${String(p.name || '').trim().toLowerCase()}__${Number(p.lat || 0).toFixed(5)}__${Number(p.lon || 0).toFixed(5)}`;
                    const ov = ramIndex.pendingJsonImportMap.get('ID:' + p.id) || ramIndex.pendingJsonImportMap.get(locK);
                    if (ov) {
                        if (ov.scadaNode !== undefined) p.scadaNode = ov.scadaNode;
                        if (ov.scadaLines !== undefined) p.scadaLines = ov.scadaLines;
                        if (ov.isTTap !== undefined) p.isTTap = ov.isTTap;
                    }
                }
                if (p.scadaNode && p.scadaNode.t !== 'PIN' && (p.scadaNode.st || 'C') === 'C' && p.scadaNode.col) {
                    p.pinColor = hexToClosestPinColorKey(p.scadaNode.col);
                }
                const ex = byId.get(p.id);
                if (!ex || (new Date(p.updatedAt || 0).getTime() || 0) >= (new Date(ex.updatedAt || 0).getTime() || 0)) {
                    byId.set(p.id, p);
                }
            });

            const list = Array.from(byId.values());
            const seenLocKeys = new Map();
            list.forEach(p => {
                const grp = String(p.ownerGroup || 'กฟส.บึง').trim();
                const lat5 = Number(p.lat || 0).toFixed(5), lon5 = Number(p.lon || 0).toFixed(5);
                let locK = `${grp}__${String(p.name || '').trim().toLowerCase()}__${lat5}__${lon5}`;
                if (seenLocKeys.has(locK) && seenLocKeys.get(locK) !== p.id) {
                    let seq = 2;
                    const baseName = String(p.name || 'T-Tap').replace(/\s*#\d+$/, '').trim();
                    while (seenLocKeys.has(`${grp}__${(baseName + ' #' + seq).toLowerCase()}__${lat5}__${lon5}`)) seq++;
                    p.name = `${baseName} #${seq}`;
                    locK = `${grp}__${p.name.toLowerCase()}__${lat5}__${lon5}`;
                }
                seenLocKeys.set(locK, p.id);
            });

            if (typeof window.__scadaSanitizePinsHook === 'function') {
                window.__scadaSanitizePinsHook(list);
            }
            return JSON.stringify(list);
        } catch (e) { return rawValStr; }
    }

    Storage.prototype.getItem = function (key) {
        if (this === localStorage) {
            if (simSandbox.active && !simSandbox.bypassRead && key === 'elec_labeled_places_list') {
                return simSandbox.workingJson;
            }
            if (isGroupViewFilterActive && (key === 'elecReportsComplete_all' || key === 'fault_reports_all')) {
                const raw = nativeGetItem.call(this, key);
                if ((nativeGetItem.call(this, 'elec_app_current_role') || 'user') === 'admin') return raw;
                try {
                    return JSON.stringify(JSON.parse(raw || '[]').filter(canCurrentUserSeeJob));
                } catch (e) { return raw; }
            }
        }
        return nativeGetItem.apply(this, arguments);
    };

    Storage.prototype.setItem = function (key, value) {
        if (this !== localStorage || typeof value !== 'string') {
            return nativeSetItem.apply(this, arguments);
        }

        if (simSandbox.active && !simSandbox.committing && key === 'elec_labeled_places_list') {
            if (inFlightCloudGetCount > 0) return;
            simSandbox.workingJson = sanitizePinsBeforeWrite(value);
            refreshRamPinsIndex();
            return;
        }

        if (!isInternalSanitizing) {
            isInternalSanitizing = true;
            try {
                if (key === 'elec_labeled_places_list') {
                    value = sanitizePinsBeforeWrite(value);
                } else if (key === 'elec_deleted_labeled_places_map') {
                    const prevDel = JSON.parse(rawStorageGet('elec_deleted_labeled_places_map') || '{}');
                    const nextDel = JSON.parse(value || '{}');
                    const merged = { ...prevDel, ...nextDel };
                    Object.keys(merged).forEach(id => {
                        const pinMs = ramIndex.knownPinUpdatedMs.get(id) || 0;
                        const delMs = new Date(merged[id] || 0).getTime() || 0;
                        if (pinMs > 0 && delMs <= pinMs) merged[id] = new Date(pinMs + 2000).toISOString();
                    });
                    const entries = Object.entries(merged)
                        .sort((a, b) => (new Date(b[1] || 0).getTime() || 0) - (new Date(a[1] || 0).getTime() || 0))
                        .slice(0, 2000);
                    value = JSON.stringify(Object.fromEntries(entries));
                } else if (key === 'elec_deleted_equip_audit_logs') {
                    value = JSON.stringify(trimAuditLogsForSheetQuota(JSON.parse(value || '[]')));
                } else if (key === 'elec_cloud_group_backups_map') {
                    value = slimGroupBackupsJson(value);
                } else if (key === 'elec_deleted_jobs_registry') {
                    const exDel = JSON.parse(rawStorageGet('elec_deleted_jobs_registry') || '{}');
                    value = JSON.stringify({ ...exDel, ...JSON.parse(value || '{}') });
                } else if (key === 'elec_tech_locations_map') {
                    const curUser = (rawStorageGet('elec_app_current_user') || '').trim();
                    const role = rawStorageGet('elec_app_current_role') || 'user';
                    if (curUser) {
                        const locObj = JSON.parse(value || '{}');
                        if (locObj[curUser]) {
                            if (isEmbeddedIframe && String(locObj[curUser].currentPage || '').includes('หน้าช่าง')) {
                                locObj[curUser].currentPage = '💻 หน้าหลัก (เปิดคู่หน้าช่าง)';
                            }
                            if (isEmbeddedIframe || role === 'viewer') {
                                locObj[curUser].gpsDisabled = true;
                                locObj[curUser].lat = null;
                                locObj[curUser].lon = null;
                            }
                            value = JSON.stringify(locObj);
                        }
                    }
                } else if (key === 'elecReportsComplete_all' || key === 'fault_reports_all') {
                    const arr = JSON.parse(value || '[]');
                    arr.forEach(item => {
                        if (!item?.techReport || !String(item.techReport.status || '').includes('เสร็จสิ้น') || !item.reopenedAt) return;
                        const rMs = new Date(item.reopenedAt).getTime() || 0;
                        const repMs = new Date(item.techReport.updatedAt || 0).getTime() || 0;
                        if (repMs >= rMs) delete item.reopenedAt;
                        else if (Date.now() - repMs < 15000) {
                            item.techReport.updatedAt = new Date(rMs + 1000).toISOString();
                            delete item.reopenedAt;
                        }
                    });
                    value = JSON.stringify(arr);
                }
            } catch (e) {} finally { isInternalSanitizing = false; }
        }

        const prevVal = LOCAL_WATCHED_KEYS.has(key) ? rawStorageGet(key) : null;
        rawStorageSet(key, value);

        if (key === 'elec_labeled_places_list') refreshRamPinsIndex();
        else if (key === 'elec_deleted_labeled_places_map') refreshRamDelPinsIndex();

        if (!isApplyingRemotePacket && LOCAL_WATCHED_KEYS.has(key) && prevVal !== value) {
            broadcastSameDevice(key);
            broadcastDeltaOverMqtt(key, value);
        }
    };

    Storage.prototype.removeItem = function (key) {
        const res = nativeRemoveItem.apply(this, arguments);
        if (key === 'elec_labeled_places_list') refreshRamPinsIndex();
        else if (key === 'elec_deleted_labeled_places_map') refreshRamDelPinsIndex();
        return res;
    };

    document.addEventListener('change', function (e) {
        if (e.target?.id !== 'importLabelsFileInput') return;
        const file = e.target.files?.[0];
        if (!file || !/\.(?:json|geojson)$/i.test(file.name)) return;
        const reader = new FileReader();
        reader.onload = function (ev) {
            try {
                const parsed = JSON.parse(String(ev.target.result || '[]'));
                const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.features) ? parsed.features : []);
                ramIndex.pendingJsonImportMap.clear();
                list.forEach(it => {
                    const obj = it?.properties || it;
                    if (!obj || (obj.scadaNode === undefined && obj.scadaLines === undefined && obj.isTTap === undefined)) return;
                    const payload = { scadaNode: obj.scadaNode, scadaLines: obj.scadaLines, isTTap: obj.isTTap };
                    if (obj.id) ramIndex.pendingJsonImportMap.set('ID:' + obj.id, payload);
                    const lat = obj.lat ?? it?.geometry?.coordinates?.[1], lon = obj.lon ?? it?.geometry?.coordinates?.[0];
                    if (obj.name && lat != null && lon != null) {
                        ramIndex.pendingJsonImportMap.set(`LOC:${String(obj.name).trim().toLowerCase()}__${Number(lat).toFixed(5)}__${Number(lon).toFixed(5)}`, payload);
                    }
                });
                setTimeout(() => ramIndex.pendingJsonImportMap.clear(), 5000);
            } catch (err) {}
        };
        reader.readAsText(file, 'UTF-8');
    }, true);

    function getStorageUsageStats() {
        let totalBytes = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i) || '';
            const v = rawStorageGet(k) || '';
            totalBytes += (k.length + v.length) * 2;
        }
        return {
            usedMb: (totalBytes / (1024 * 1024)).toFixed(2),
            maxMb: '5.00',
            pct: Math.min(100, Math.round((totalBytes / (5 * 1024 * 1024)) * 100))
        };
    }

    function cleanTemporaryCacheSafe() {
        const closedReg = getClosedJobsRegistry();
        ['elecReportsComplete_all', 'fault_reports_all'].forEach(k => {
            const isF = (k === 'fault_reports_all');
            const arr = JSON.parse(rawStorageGet(k) || '[]');
            arr.forEach(it => {
                const id = isF ? it?.timestamp : it?.dateTimeSaved;
                if (it && !it.techReport && id && closedReg[id]) it.techReport = closedReg[id];
            });
            localStorage.setItem(k, JSON.stringify(arr));
        });
        syncClosedRegistryObject(closedReg);
        showToast('🧹 ล้างแคชซ้ำซ้อนเรียบร้อย (ประวัติใบงานอยู่ครบ 100%)');
    }

    // ========================================================================
    // 4. ทะเบียนงานที่ปิด/ลบแล้ว, พิกัดช่าง & ตัวล้างสถานะเปิดใบงานใหม่
    // ========================================================================
    function isAutoGeneratedFakeClosure(rep) {
        if (!rep) return false;
        if (rep.realCause === 'ปิดงานโดยผู้ใช้งานทั่วไป' && rep.actionTaken === 'ดำเนินการเสร็จสิ้นจากระบบหลัก') return true;
        return rep.status === 'แก้ไขเสร็จสิ้น (ปิดงานแล้ว)' || rep.updatedAt === '1970-01-01T00:00:00.000Z';
    }

    function pruneClosedRegistryMap(rawMap) {
        if (!rawMap || typeof rawMap !== 'object') return {};
        const now = Date.now();
        const entries = Object.entries(rawMap).filter(([, val]) => {
            if (!val || typeof val !== 'object' || isAutoGeneratedFakeClosure(val)) return false;
            const t = val.updatedAt ? new Date(val.updatedAt).getTime() : now;
            return !isNaN(t) && (now - t <= MAX_REGISTRY_AGE_MS);
        });
        entries.sort((a, b) => (new Date(b[1]?.updatedAt || 0).getTime() || 0) - (new Date(a[1]?.updatedAt || 0).getTime() || 0));
        return Object.fromEntries(entries.slice(0, 300));
    }

    function getClosedJobsRegistry() {
        try {
            const r1 = JSON.parse(rawStorageGet('elec_closed_jobs_registry') || '{}');
            const r2 = JSON.parse(rawStorageGet('elec_closed_reports_map') || '{}');
            return pruneClosedRegistryMap({ ...r1, ...r2 });
        } catch (e) { return {}; }
    }

    function syncClosedRegistryObject(mapObj) {
        if (!mapObj || typeof mapObj !== 'object') return;
        localStorage.setItem('elec_closed_jobs_registry', JSON.stringify(pruneClosedRegistryMap(mapObj)));
        nativeRemoveItem.call(localStorage, 'elec_closed_reports_map');
    }

    function saveClosedJobToRegistry(jobKey, reportObj) {
        if (!jobKey) return;
        const reg = getClosedJobsRegistry();
        reg[jobKey] = reportObj || {
            status: 'แก้ไขเสร็จสิ้น (จ่ายไฟคืนแล้ว)',
            realCause: '-',
            actionTaken: 'ปิดงานเรียบร้อย',
            finishTime: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) + ' น.',
            inspector: formatTechDisplayName(rawStorageGet('elec_app_current_user') || 'ผู้ใช้งาน'),
            updatedAt: new Date().toISOString()
        };
        syncClosedRegistryObject(reg);
    }

    function getDeletedJobsRegistry() {
        try {
            const raw = JSON.parse(rawStorageGet('elec_deleted_jobs_registry') || '{}');
            const now = Date.now();
            const valid = Object.entries(raw).filter(([, ts]) => (now - Number(ts)) < MAX_REGISTRY_AGE_MS);
            return Object.fromEntries(valid.slice(-300));
        } catch (e) { return {}; }
    }

    function recordDeletedJobToRegistry(jobKey) {
        if (!jobKey) return;
        unlockCloudWrite(20000);
        const reg = getDeletedJobsRegistry();
        reg[jobKey] = Date.now();
        localStorage.setItem('elec_deleted_jobs_registry', JSON.stringify(reg));
    }

    function syncDeletedRegistryObject(mergedObj) {
        if (!mergedObj || typeof mergedObj !== 'object') return;
        const now = Date.now();
        const valid = Object.entries(mergedObj).filter(([, ts]) => (now - Number(ts)) < MAX_REGISTRY_AGE_MS);
        localStorage.setItem('elec_deleted_jobs_registry', JSON.stringify(Object.fromEntries(valid.slice(-300))));
    }

    function getTechLocationsMap() {
        try { return JSON.parse(rawStorageGet('elec_tech_locations_map') || '{}'); } catch (e) { return {}; }
    }

    function mergeTechLocationsMap(cloudLocs) {
        if (!cloudLocs || typeof cloudLocs !== 'object') return;
        const localMap = getTechLocationsMap();
        const curUser = (rawStorageGet('elec_app_current_user') || '').trim();
        const gpsDisabledLocal = rawStorageGet('elec_tech_gps_enabled') === 'false' || isEmbeddedIframe || isViewerRole();

        Object.keys(cloudLocs).forEach(uKey => {
            const cItem = cloudLocs[uKey];
            if (!cItem || typeof cItem !== 'object') return;
            if (gpsDisabledLocal && curUser && uKey !== REGISTRY_LOC_KEY &&
                (isSameTechPerson(uKey, curUser) || isSameTechPerson(cItem.username, curUser))) {
                return;
            }
            const lItem = localMap[uKey];
            const cTime = new Date(cItem.lastSeenAt || cItem.updatedAt || 0).getTime() || 0;
            const lTime = new Date(lItem?.lastSeenAt || lItem?.updatedAt || 0).getTime() || 0;
            if (!lItem || cTime >= lTime) {
                const exNavT = Number(lItem?.activeEquipNav?.departTimestamp || 0);
                const inNavT = Number(cItem?.activeEquipNav?.departTimestamp || 0);
                localMap[uKey] = (exNavT > inNavT && lItem?.activeEquipNav)
                    ? { ...cItem, activeEquipNav: lItem.activeEquipNav }
                    : cItem;
            }
        });
        localStorage.setItem('elec_tech_locations_map', JSON.stringify(localMap));
    }

    function cleanReopenedAndCancelledJobsInStorage() {
        try {
            const closedReg = getClosedJobsRegistry();
            const cancelJobMap = JSON.parse(rawStorageGet('elec_cancelled_job_nav_map') || '{}');
            let regChanged = false;

            ['elecReportsComplete_all', 'fault_reports_all'].forEach(storageKey => {
                const isFault = (storageKey === 'fault_reports_all');
                const list = JSON.parse(rawStorageGet(storageKey) || '[]');
                let listChanged = false;

                list.forEach(item => {
                    if (!item) return;
                    const k = isFault ? item.timestamp : item.dateTimeSaved;
                    const cancelIso = (k && cancelJobMap[k]) ? cancelJobMap[k] : (item.navCancelledAt || '');
                    if (cancelIso && item.techNav) {
                        const cMs = new Date(cancelIso).getTime() || 0;
                        const nMs = new Date(item.techNav.updatedAt || 0).getTime() || 0;
                        if (cMs >= nMs) {
                            delete item.techNav;
                            item.navCancelledAt = cancelIso;
                            listChanged = true;
                        }
                    }
                    if (!item.reopenedAt) return;
                    const reopenMs = new Date(item.reopenedAt).getTime() || 0;
                    if (item.techReport && reopenMs > (new Date(item.techReport.updatedAt || 0).getTime() || 0)) {
                        delete item.techReport;
                        listChanged = true;
                    }
                    if (!item.techReport) {
                        if (k && closedReg[k] && reopenMs >= (new Date(closedReg[k]?.updatedAt || 0).getTime() || 0)) {
                            delete closedReg[k];
                            regChanged = true;
                        }
                        if (item.formattedText && item.formattedText.includes('--- 🛠️ ผลตรวจสอบหน้างาน ---')) {
                            item.formattedText = item.formattedText.split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0];
                            listChanged = true;
                        }
                    }
                });
                if (listChanged) localStorage.setItem(storageKey, JSON.stringify(list));
            });
            if (regChanged) syncClosedRegistryObject(closedReg);
        } catch (e) {}
    }
    // ===== จบพาทที่ 1 / 2 ของไฟล์ shared-core.js (นำพาทที่ 2 / 2 มาวางต่อจากบรรทัดนี้ได้เลยครับ) =====
    // ===== เริ่มพาทที่ 2 / 2 ของไฟล์ shared-core.js (วางต่อจากพาทที่ 1 / 2 จนจบไฟล์) =====

    // ========================================================================
    // 5. ท่อซิงค์เรียลไทม์ (Encrypted MQTT + BroadcastChannel) & Cloud Delta Engine
    // ========================================================================
    const WS_BROKERS = [
        'wss://broker.emqx.io:8084/mqtt',
        'wss://broker.hivemq.com:8884/mqtt',
        'wss://mqtt.eclipseprojects.io:443/mqtt'
    ];
    let mqttClient = null;
    let lastMqttAuthSig = '';
    let brokerFallbackIdx = 0;
    const debounceMqttTimers = {};
    const realtimeSubscribers = new Set();
    let uiRefreshRaf = null;
    const pendingRefreshKeys = new Set();

    const syncedJobHashes = new Map();
    let lastBackupsHash = '';
    let lastPinsHash = '';
    let lastDelPinsHash = '';
    let lastAuditLogsHash = '';
    let hasFirstBaseline = false;
    let pendingPostTask = null;
    let isPostWorkerRunning = false;

    function hashString(str) {
        let h = 0;
        const s = String(str || 'default');
        for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
        return Math.abs(h);
    }

    function getOrgSecretKey() {
        return getActiveCloudApiUrl() + '::' + (rawStorageGet('elec_mqtt_secret_key') || 'PEA_SMART_GRID_SECURE_2026');
    }

    function computePacketSignature(payloadStr, ts, secret) {
        const str = payloadStr + '|' + ts + '|' + secret;
        let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (h2 >>> 0).toString(36) + '_' + (h1 >>> 0).toString(36);
    }

    function xorCipherTransform(text, keyStr) {
        let out = '';
        for (let i = 0; i < text.length; i++) {
            out += String.fromCharCode(text.charCodeAt(i) ^ keyStr.charCodeAt(i % keyStr.length) ^ ((i * 31) & 0xff));
        }
        return out;
    }

    function encryptMqttPayload(plainStr, ts) {
        try {
            const secret = getOrgSecretKey() + '#' + (ts % 9973);
            return 'ENC1_' + btoa(xorCipherTransform(encodeURIComponent(plainStr), secret));
        } catch (e) { return plainStr; }
    }

    function decryptMqttPayload(cipherStr, ts) {
        try {
            if (!cipherStr || !cipherStr.startsWith('ENC1_')) return null;
            const secret = getOrgSecretKey() + '#' + (ts % 9973);
            return decodeURIComponent(xorCipherTransform(atob(cipherStr.slice(5)), secret));
        } catch (e) { return null; }
    }

    function ensureMySessionTokenSyncedInUsers(usersArr) {
        if (!Array.isArray(usersArr) || rawStorageGet('elec_app_logged_in') !== 'true') return usersArr;
        const curUser = (rawStorageGet('elec_app_current_user') || '').trim();
        if (!curUser) return usersArr;
        let localToken = rawStorageGet('elec_app_session_token') || '';
        if (!localToken) {
            localToken = 'sess_' + Date.now();
            rawStorageSet('elec_app_session_token', localToken);
        }
        usersArr.forEach(u => {
            if (!u || !u.username) return;
            if (isUsernameMatchingAccount(curUser, u.username)) {
                u.sessionToken = localToken;
                if (typeof u.role === 'string' && u.role.includes('::')) {
                    const parts = u.role.split('::');
                    parts[1] = localToken;
                    u.role = parts.join('::');
                }
            }
        });
        return usersArr;
    }

    function scheduleRealtimeRefresh(changedKey) {
        if (changedKey) pendingRefreshKeys.add(changedKey);
        if (uiRefreshRaf) return;
        uiRefreshRaf = requestAnimationFrame(() => {
            uiRefreshRaf = null;
            const keys = Array.from(pendingRefreshKeys);
            pendingRefreshKeys.clear();
            realtimeSubscribers.forEach(fn => { try { fn(keys); } catch (e) {} });
            keys.forEach(k => { try { window.dispatchEvent(new StorageEvent('storage', { key: k })); } catch (e) {} });
        });
    }

    function applyIncomingLivePacket(key, incomingValStr) {
        if (!incomingValStr) return;
        if (simSandbox.active && key === 'elec_labeled_places_list') return;
        isApplyingRemotePacket = true;
        try {
            const curStr = rawStorageGet(key);
            if (curStr === incomingValStr) return;

            if (key === 'elecReportsComplete_all' || key === 'fault_reports_all') {
                const isFault = (key === 'fault_reports_all');
                const kField = isFault ? 'timestamp' : 'dateTimeSaved';
                const delReg = getDeletedJobsRegistry();
                const cancelJobMap = JSON.parse(rawStorageGet('elec_cancelled_job_nav_map') || '{}');
                const map = new Map();

                JSON.parse(curStr || '[]').forEach(it => { if (it?.[kField] && !delReg[it[kField]]) map.set(it[kField], it); });
                JSON.parse(incomingValStr || '[]').forEach(inItem => {
                    if (!inItem?.[kField] || delReg[inItem[kField]]) return;
                    const id = inItem[kField];
                    const ex = map.get(id);
                    if (!ex) { map.set(id, inItem); return; }

                    const bestRep = (inItem.techReport?.updatedAt || '') >= (ex.techReport?.updatedAt || '')
                        ? (inItem.techReport || ex.techReport) : ex.techReport;
                    const latestReopen = (inItem.reopenedAt || '') >= (ex.reopenedAt || '') ? inItem.reopenedAt : ex.reopenedAt;
                    const validRep = (latestReopen && (!bestRep?.updatedAt || latestReopen > bestRep.updatedAt)) ? undefined : bestRep;

                    const cancelIso = cancelJobMap[id] || ((inItem.navCancelledAt || '') >= (ex.navCancelledAt || '') ? inItem.navCancelledAt : ex.navCancelledAt) || '';
                    let bestNav = (inItem.techNav?.updatedAt || '') >= (ex.techNav?.updatedAt || '') ? (inItem.techNav || ex.techNav) : ex.techNav;
                    if ((validRep && String(validRep.status || '').includes('เสร็จสิ้น')) || (cancelIso && (!bestNav?.updatedAt || cancelIso >= bestNav.updatedAt))) {
                        bestNav = undefined;
                    }
                    const merged = { ...ex, ...inItem, techReport: validRep, reopenedAt: latestReopen || undefined, navCancelledAt: cancelIso || undefined };
                    if (!validRep) delete merged.techReport;
                    if (bestNav) merged.techNav = bestNav; else delete merged.techNav;
                    map.set(id, merged);
                });
                localStorage.setItem(key, JSON.stringify(Array.from(map.values())));
            } else if (key === 'elec_deleted_labeled_places_map') {
                const mergedDel = { ...JSON.parse(curStr || '{}'), ...JSON.parse(incomingValStr || '{}') };
                localStorage.setItem(key, JSON.stringify(mergedDel));
                const curPins = JSON.parse(rawStorageGet('elec_labeled_places_list') || '[]');
                const surviving = curPins.filter(p => {
                    if (!p?.id) return false;
                    if (!mergedDel[p.id]) return true;
                    return (new Date(p.updatedAt || 0).getTime() || 0) > (new Date(mergedDel[p.id]).getTime() || 0);
                });
                if (surviving.length !== curPins.length && !simSandbox.active) {
                    localStorage.setItem('elec_labeled_places_list', JSON.stringify(surviving));
                    scheduleRealtimeRefresh('elec_labeled_places_list');
                }
            } else if (key === 'elec_labeled_places_list') {
                const delEquip = JSON.parse(rawStorageGet('elec_deleted_labeled_places_map') || '{}');
                const pinMap = new Map();
                [...JSON.parse(curStr || '[]'), ...JSON.parse(incomingValStr || '[]')].forEach(p => {
                    if (!p?.id) return;
                    if (delEquip[p.id] && (new Date(p.updatedAt || 0).getTime() || 0) <= (new Date(delEquip[p.id]).getTime() || 0)) return;
                    const ex = pinMap.get(p.id);
                    if (!ex || (p.updatedAt || '') > (ex.updatedAt || '')) pinMap.set(p.id, p);
                });
                localStorage.setItem(key, JSON.stringify(Array.from(pinMap.values())));
            } else if (key === 'elec_deleted_equip_audit_logs') {
                const logMap = new Map();
                [...JSON.parse(curStr || '[]'), ...JSON.parse(incomingValStr || '[]')].forEach(l => {
                    if (l?.logId) logMap.set(l.logId, l);
                });
                localStorage.setItem(key, JSON.stringify(Array.from(logMap.values())));
            } else if (key === 'elec_tech_locations_map') {
                mergeTechLocationsMap(JSON.parse(incomingValStr || '{}'));
            } else if (key === 'elec_user_accounts') {
                const inAccs = ensureMySessionTokenSyncedInUsers(JSON.parse(incomingValStr || '[]'));
                cachedAccountsStr = '';
                localStorage.setItem(key, JSON.stringify(inAccs));
            } else if (key === 'elec_closed_jobs_registry' || key === 'elec_deleted_jobs_registry' || key === 'elec_active_equip_nav_map_v2' || key.includes('cancelled')) {
                localStorage.setItem(key, JSON.stringify({ ...JSON.parse(curStr || '{}'), ...JSON.parse(incomingValStr || '{}') }));
            } else {
                localStorage.setItem(key, incomingValStr);
            }
            scheduleRealtimeRefresh(key);
        } catch (e) {} finally { isApplyingRemotePacket = false; }
    }

    function getMqttTopicBase() {
        return 'pea_hyper_v4_' + hashString(getActiveCloudApiUrl());
    }
    function getMyGroupShard() {
        return encodeURIComponent((getCurrentUserGroup() || 'กฟส.บึง').trim() || 'DEFAULT');
    }

    function refreshMqttSubscriptions() {
        if (!mqttClient || !mqttClient.connected) return;
        const isLogged = rawStorageGet('elec_app_logged_in') === 'true';
        const role = isLogged ? (rawStorageGet('elec_app_current_role') || 'user') : 'guest';
        const shard = getMyGroupShard();
        const base = getMqttTopicBase();
        const sig = `${role}::${shard}::${base}`;
        if (sig === lastMqttAuthSig) return;
        lastMqttAuthSig = sig;

        try {
            if (role === 'admin') {
                mqttClient.subscribe([`${base}/grp/+/+`, `${base}/global/+`], { qos: 0 });
            } else {
                mqttClient.unsubscribe(`${base}/grp/+/+`, () => {
                    if (isLogged) mqttClient.subscribe([`${base}/grp/${shard}/+`, `${base}/global/+`], { qos: 0 });
                });
            }
        } catch (e) {}
    }

    function initMqttTransport() {
        if (typeof mqtt === 'undefined' || typeof mqtt.connect !== 'function') {
            if (!document.getElementById('peaMqttCdnLoader')) {
                const s = document.createElement('script');
                s.id = 'peaMqttCdnLoader';
                s.src = 'https://unpkg.com/mqtt@5.3.4/dist/mqtt.min.js';
                s.onload = () => initMqttTransport();
                document.head.appendChild(s);
            }
            return;
        }
        if (mqttClient) { try { mqttClient.end(true); } catch (e) {} }

        const shardHash = hashString(getMyGroupShard());
        const brokerUrl = WS_BROKERS[(shardHash + brokerFallbackIdx) % WS_BROKERS.length];
        const opts = { clientId: MY_PEER_ID, clean: true, connectTimeout: 4500, reconnectPeriod: 3500 };
        const mUser = rawStorageGet('elec_mqtt_username'), mPass = rawStorageGet('elec_mqtt_password');
        if (mUser && mPass) { opts.username = mUser; opts.password = mPass; }

        try {
            mqttClient = mqtt.connect(brokerUrl, opts);
            mqttClient.on('connect', () => { lastMqttAuthSig = ''; refreshMqttSubscriptions(); });
            mqttClient.on('error', () => { brokerFallbackIdx++; });
            mqttClient.on('message', (topic, buf) => {
                try {
                    const rawStr = (buf && typeof buf.toString === 'function') ? buf.toString() : String(buf || '');
                    const pkt = JSON.parse(rawStr);
                    if (!pkt || pkt.sender === MY_PEER_ID || pkt.type !== 'DELTA_KEY') return;
                    if (!pkt.ts || Math.abs(Date.now() - Number(pkt.ts)) > 3600000) return;
                    const decVal = decryptMqttPayload(pkt.val, pkt.ts);
                    if (!decVal || pkt.sig !== computePacketSignature(decVal, pkt.ts, getOrgSecretKey())) return;
                    applyIncomingLivePacket(pkt.key, decVal);
                } catch (e) {}
            });
        } catch (e) {}
    }

    setInterval(() => {
        if (mqttClient && mqttClient.connected) refreshMqttSubscriptions();
    }, 6000);

    function broadcastDeltaOverMqtt(key, valStr) {
        if (!SYNC_KEYS.has(key) || simSandbox.active) return;
        clearTimeout(debounceMqttTimers[key]);
        debounceMqttTimers[key] = setTimeout(() => {
            try {
                if (!mqttClient || !mqttClient.connected) return;
                const shard = getMyGroupShard();
                const myGrp = decodeURIComponent(shard);
                let payloadStr = valStr;

                if (key === 'elecReportsComplete_all' || key === 'fault_reports_all') {
                    payloadStr = JSON.stringify(JSON.parse(valStr || '[]').filter(i => !i.ownerGroup || i.ownerGroup === myGrp).slice(0, 25));
                } else if (key === 'elec_labeled_places_list') {
                    payloadStr = JSON.stringify(JSON.parse(valStr || '[]').filter(p => !p.ownerGroup || p.ownerGroup === myGrp));
                }
                const maxLen = key === 'elec_labeled_places_list' ? 250000 : 65000;
                if (payloadStr.length >= maxLen) return;

                const ts = Date.now();
                const sig = computePacketSignature(payloadStr, ts, getOrgSecretKey());
                const packet = JSON.stringify({
                    type: 'DELTA_KEY', sender: MY_PEER_ID, key,
                    val: encryptMqttPayload(payloadStr, ts), ts, sig
                });
                mqttClient.publish(`${getMqttTopicBase()}/grp/${shard}/${key}`, packet, { qos: 0, retain: false });
            } catch (e) {}
        }, 25);
    }

    let localChannel = null;
    try {
        if ('BroadcastChannel' in window) {
            localChannel = new BroadcastChannel(CHANNEL_NAME);
            localChannel.onmessage = (e) => { if (e.data?.type === 'LOCAL_TURBO') scheduleRealtimeRefresh(e.data.key); };
        }
    } catch (e) {}
    window.addEventListener('message', (e) => { if (e.data?.type === 'LOCAL_TURBO') scheduleRealtimeRefresh(e.data.key); });

    function broadcastSameDevice(key) {
        const msg = { type: 'LOCAL_TURBO', key, ts: Date.now() };
        try { if (localChannel) localChannel.postMessage(msg); } catch (e) {}
        try {
            if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
            const leftIf = document.getElementById('leftBrowserIframe');
            if (leftIf?.contentWindow) leftIf.contentWindow.postMessage(msg, '*');
        } catch (e) {}
    }

    // ตัวควบคุมโควตาและคิวส่งข้อมูลขึ้น Google Sheets (Auto-Shard + patchDelta)
    function unlockCloudWrite(durationMs = 20000) {
        if (!isViewerRole()) allowWriteUntilMs = Math.max(allowWriteUntilMs, Date.now() + durationMs);
    }

    function forceCloudRead() {
        forceManualGet = true;
        lastRealSheetGetMs = 0;
        nativeRemoveItem.call(localStorage, 'elec_sheet_cache_2k');
    }

    function createTrailingAsyncQueue(asyncFn) {
        let activePromise = null;
        let hasTrailing = false;
        let queuedSilent = true;
        return async function (silent = false) {
            if (!silent) queuedSilent = false;
            if (activePromise) {
                hasTrailing = true;
                return await activePromise;
            }
            activePromise = (async () => {
                let res = false;
                try {
                    res = await asyncFn(silent);
                    while (hasTrailing) {
                        const nextSilent = queuedSilent;
                        hasTrailing = false;
                        queuedSilent = true;
                        unlockCloudWrite(20000);
                        res = await asyncFn(nextSilent);
                    }
                } finally { activePromise = null; }
                return res;
            })();
            return await activePromise;
        };
    }

    function getJobDiffKey(j) {
        if (!j || typeof j !== 'object') return '';
        if (j.jobType === 'tech_loc') return 'TECH_LOC_REGISTRY';
        const isF = j.jobType === 'fault';
        return (isF ? 'F_' : 'O_') + String(isF ? (j.timestamp || '') : (j.dateTimeSaved || j.timestamp || ''));
    }

    function recordCloudBaseline(jobsArr) {
        if (!Array.isArray(jobsArr)) return;
        const seen = new Set();
        jobsArr.forEach(j => {
            if (!j || typeof j !== 'object') return;
            if (j.jobType === 'tech_loc') {
                if (j.cloudGroupBackups) lastBackupsHash = JSON.stringify(j.cloudGroupBackups);
                if (j.electricEquipmentPins) lastPinsHash = JSON.stringify(j.electricEquipmentPins);
                if (j.deletedElectricEquipmentMap) lastDelPinsHash = JSON.stringify(j.deletedElectricEquipmentMap);
                if (j.deletedEquipAuditLogs) lastAuditLogsHash = JSON.stringify(j.deletedEquipAuditLogs);
            } else {
                const k = getJobDiffKey(j);
                if (k) { seen.add(k); syncedJobHashes.set(k, JSON.stringify(j)); }
            }
        });
        Array.from(syncedJobHashes.keys()).forEach(k => { if (!seen.has(k)) syncedJobHashes.delete(k); });
        if (jobsArr.length > 0) hasFirstBaseline = true;
    }

    function prepareJobsArrayForCloud(jobsArr) {
        if (!Array.isArray(jobsArr)) return [];
        cleanReopenedAndCancelledJobsInStorage();

        const role = rawStorageGet('elec_app_current_role') || 'user';
        const myGrp = getCurrentUserGroup();
        const delJobs = getDeletedJobsRegistry();
        const backups = JSON.parse(rawStorageGet('elec_cloud_group_backups_map') || '{}');
        let pins = JSON.parse(rawStorageGet('elec_labeled_places_list') || '[]');
        const delPins = JSON.parse(rawStorageGet('elec_deleted_labeled_places_map') || '{}');
        let auditLogs = trimAuditLogsForSheetQuota(JSON.parse(rawStorageGet('elec_deleted_equip_audit_logs') || '[]'));
        const clearedTs = parseInt(rawStorageGet('elec_cleared_audit_logs_ts') || '0', 10);
        const overrides = window.cloudEditedJobsOverrideMap || {};

        if (role !== 'admin' && myGrp) {
            pins = pins.filter(p => p && (p.ownerGroup || 'กฟส.บึง').trim() === myGrp);
            auditLogs = auditLogs.filter(l => l && (l.ownerGroup || 'กฟส.บึง').trim() === myGrp);
        }

        return jobsArr.filter(j => {
            if (!j) return false;
            if (j.jobType === 'tech_loc') return true;
            const rk = j.jobType === 'fault' ? j.timestamp : j.dateTimeSaved;
            return !(rk && delJobs[rk]);
        }).map(j => {
            if (j.jobType === 'tech_loc') {
                return {
                    ...j,
                    closedJobsMap: getClosedJobsRegistry(),
                    deletedJobsMap: delJobs,
                    electricEquipmentPins: pins,
                    deletedElectricEquipmentMap: delPins,
                    deletedEquipAuditLogs: auditLogs,
                    clearedAuditLogsTimestamp: clearedTs,
                    ...(Object.keys(backups).length > 0 ? { cloudGroupBackups: backups } : {})
                };
            }
            const uKey = getJobDiffKey(j);
            return overrides[uKey] ? { ...j, ...overrides[uKey] } : { ...j, ownerGroup: getJobGroupName(j) || myGrp || 'กฟส.บึง' };
        });
    }

    function buildDeltaFromSaveJobs(fullJobs) {
        if (!hasFirstBaseline || !Array.isArray(fullJobs)) return null;
        const upsertedJobs = [];
        const currentKeys = new Set();
        let techLoc = null;

        fullJobs.forEach(j => {
            if (!j || typeof j !== 'object') return;
            if (j.jobType === 'tech_loc') { techLoc = j; return; }
            const k = getJobDiffKey(j);
            if (!k) return;
            currentKeys.add(k);
            if (syncedJobHashes.get(k) !== JSON.stringify(j)) upsertedJobs.push(j);
        });
        if (upsertedJobs.length > 40) return null;

        const removedJobKeys = [];
        syncedJobHashes.forEach((_, oldK) => { if (!currentKeys.has(oldK)) removedJobKeys.push(oldK); });

        let techLocDelta = null;
        if (techLoc) {
            const canEditScada = canCurrentUserEditScada();
            const bStr = JSON.stringify(techLoc.cloudGroupBackups || {});
            const pStr = JSON.stringify(techLoc.electricEquipmentPins || []);
            const dpStr = JSON.stringify(techLoc.deletedElectricEquipmentMap || {});
            const aStr = JSON.stringify(techLoc.deletedEquipAuditLogs || []);

            const keepBackups = !canEditScada || (bStr === lastBackupsHash || !techLoc.cloudGroupBackups);
            const keepPins = !canEditScada || simSandbox.active || (pStr === lastPinsHash && (techLoc.electricEquipmentPins?.length > 0 || lastPinsHash === '[]'));
            const keepDelPins = !canEditScada || simSandbox.active || (dpStr === lastDelPinsHash);
            const keepAuditLogs = !canEditScada || simSandbox.active || (aStr === lastAuditLogsHash && (techLoc.deletedEquipAuditLogs?.length > 0 || lastAuditLogsHash === '[]'));

            techLocDelta = {
                jobType: 'tech_loc', dateTimeSaved: 'TECH_LOC_REGISTRY',
                techLocations: techLoc.techLocations || {},
                closedJobsMap: techLoc.closedJobsMap || {},
                deletedJobsMap: techLoc.deletedJobsMap || {},
                clearedAuditLogsTimestamp: techLoc.clearedAuditLogsTimestamp || 0,
                _keepBackups: keepBackups, _keepPins: keepPins, _keepDelPins: keepDelPins, _keepAuditLogs: keepAuditLogs,
                ...(keepBackups ? {} : { cloudGroupBackups: techLoc.cloudGroupBackups }),
                ...(keepPins ? {} : { electricEquipmentPins: techLoc.electricEquipmentPins }),
                ...(keepDelPins ? {} : { deletedElectricEquipmentMap: techLoc.deletedElectricEquipmentMap }),
                ...(keepAuditLogs ? {} : { deletedEquipAuditLogs: techLoc.deletedEquipAuditLogs }),
                updatedAt: new Date().toISOString()
            };
        }
        return { action: 'patchDelta', ramOnly: false, upsertedJobs, removedJobKeys, techLocDelta };
    }

    async function runPostQueueWorker() {
        if (isPostWorkerRunning || !pendingPostTask) return;
        isPostWorkerRunning = true;
        while (pendingPostTask) {
            const task = pendingPostTask;
            pendingPostTask = null;
            try {
                let bodyStr = task.bodyStr;
                const origObj = JSON.parse(bodyStr);
                if (origObj?.action === 'saveJobs' && Array.isArray(origObj.jobs)) {
                    simSandbox.bypassRead = true;
                    try { origObj.jobs = prepareJobsArrayForCloud(origObj.jobs); } finally { simSandbox.bypassRead = false; }
                    const delta = buildDeltaFromSaveJobs(origObj.jobs);
                    bodyStr = JSON.stringify(delta || origObj);
                }
                const res = await nativeFetch.call(window, task.url, { ...task.init, body: bodyStr });
                if (res && res.ok) {
                    const rJson = await res.clone().json().catch(() => ({}));
                    if (rJson?.requireFullSync && origObj?.action === 'saveJobs') {
                        await nativeFetch.call(window, task.url, { ...task.init, body: JSON.stringify(origObj) });
                    }
                    if (Array.isArray(origObj?.jobs)) recordCloudBaseline(origObj.jobs);
                    nativeRemoveItem.call(localStorage, 'elec_tech_has_pending_push');
                }
            } catch (err) {
                rawStorageSet('elec_tech_has_pending_push', 'true');
            }
        }
        isPostWorkerRunning = false;
    }

    function sanitizeFetchedJsonUsers(rawText) {
        if (!rawText || !rawText.includes('"users"')) return rawText;
        try {
            const parsed = JSON.parse(rawText);
            if (Array.isArray(parsed?.users)) {
                ensureMySessionTokenSyncedInUsers(parsed.users);
                return JSON.stringify(parsed);
            }
        } catch (e) {}
        return rawText;
    }

    window.fetch = async function (input, init) {
        let urlStr = typeof input === 'string' ? input : (input?.url || '');
        if (urlStr.includes('generativelanguage.googleapis.com')) {
            urlStr = urlStr.replace('models/gemini-3.8-flash-preview:', 'models/gemini-2.5-flash:').replace('models/gemini-3.8-flash:', 'models/gemini-2.5-flash:');
            input = urlStr;
        }
        if (!urlStr.includes('script.google.com')) return nativeFetch.apply(this, arguments);

        if (!urlStr.includes('group=')) {
            const grp = getCurrentUserGroup();
            const role = rawStorageGet('elec_app_current_role') || 'user';
            urlStr += `${urlStr.includes('?') ? '&' : '?'}group=${encodeURIComponent(grp)}&role=${encodeURIComponent(role)}`;
        }

        const method = (init?.method || 'GET').toUpperCase();
        const now = Date.now();

        if (method === 'GET') {
            const cooldown = (mqttClient && mqttClient.connected) ? 1200000 : 300000;
            if (!forceManualGet && cachedSheetText && (now - lastRealSheetGetMs < cooldown)) {
                return new Response(sanitizeFetchedJsonUsers(cachedSheetText), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            forceManualGet = false;
            lastRealSheetGetMs = now;
            inFlightCloudGetCount++;
            try {
                const res = await nativeFetch.call(window, urlStr, init);
                if (res && res.ok) {
                    let txt = await res.clone().text();
                    if (txt && txt.includes('"status":"ok"')) {
                        txt = sanitizeFetchedJsonUsers(txt);
                        cachedSheetText = txt;
                        rawStorageSet('elec_sheet_cache_2k', txt);
                        const parsed = JSON.parse(txt);
                        if (Array.isArray(parsed?.jobs)) {
                            recordCloudBaseline(parsed.jobs);
                            const locReg = parsed.jobs.find(j => j?.jobType === 'tech_loc');
                            if (locReg && simSandbox.active) simSandbox.deferredCloudLocReg = locReg;
                        }
                        return new Response(txt, { status: 200, headers: { 'Content-Type': 'application/json' } });
                    }
                }
                return res;
            } catch (err) {
                if (cachedSheetText) return new Response(sanitizeFetchedJsonUsers(cachedSheetText), { status: 200, headers: { 'Content-Type': 'application/json' } });
                throw err;
            } finally {
                Promise.resolve().then(() => { inFlightCloudGetCount = Math.max(0, inFlightCloudGetCount - 1); });
            }
        }

        if (method === 'POST' && typeof init?.body === 'string') {
            if (init.body.includes('"verifyLogin"') || init.body.includes('"verifyUserPassword"')) {
                lastRealSheetGetMs = 0;
                return nativeFetch.call(window, urlStr, init);
            }
            if (init.body.includes('"saveUsers"')) {
                try {
                    const b = JSON.parse(init.body);
                    if (Array.isArray(b?.users)) {
                        ensureMySessionTokenSyncedInUsers(b.users);
                        init = { ...init, body: JSON.stringify(b) };
                    }
                } catch (e) {}
                lastRealSheetGetMs = 0;
                return nativeFetch.call(window, urlStr, init);
            }
            if (init.body.includes('"saveJobs"') || init.body.includes('"patchDelta"')) {
                if (isViewerRole() || now > allowWriteUntilMs) {
                    return new Response(JSON.stringify({ status: 'ok', skippedQuota: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                pendingPostTask = { url: urlStr, init: { ...init }, bodyStr: init.body };
                setTimeout(runPostQueueWorker, 10);
                return new Response(JSON.stringify({ status: 'ok', queued: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
        }
        return nativeFetch.call(window, urlStr, init);
    };

    // ควบคุมเข้า-ออกโหมดซ้อมสับ-ปลด (Virtual Simulation Sandbox)
    function enterSimSandbox(initialPinsArray) {
        const clone = Array.isArray(initialPinsArray)
            ? JSON.parse(JSON.stringify(initialPinsArray))
            : JSON.parse(rawStorageGet('elec_labeled_places_list') || '[]');
        simSandbox.workingJson = sanitizePinsBeforeWrite(JSON.stringify(clone));
        simSandbox.deferredCloudLocReg = null;
        simSandbox.committing = false;
        simSandbox.active = true;
        refreshRamPinsIndex();
    }

    function exitSimSandbox(commitPinsArray = null) {
        if (Array.isArray(commitPinsArray) && canCurrentUserEditScada()) {
            simSandbox.committing = true;
            simSandbox.active = false;
            simSandbox.deferredCloudLocReg = null;
            try {
                unlockCloudWrite(25000);
                localStorage.setItem('elec_labeled_places_list', JSON.stringify(commitPinsArray));
            } finally {
                simSandbox.committing = false;
            }
        } else {
            simSandbox.active = false;
            const snap = simSandbox.deferredCloudLocReg;
            simSandbox.deferredCloudLocReg = null;
            if (snap) {
                try {
                    const curDel = JSON.parse(rawStorageGet('elec_deleted_labeled_places_map') || '{}');
                    if (snap.deletedElectricEquipmentMap) {
                        Object.assign(curDel, snap.deletedElectricEquipmentMap);
                        localStorage.setItem('elec_deleted_labeled_places_map', JSON.stringify(curDel));
                    }
                    if (Array.isArray(snap.electricEquipmentPins)) {
                        const curPins = JSON.parse(rawStorageGet('elec_labeled_places_list') || '[]');
                        const byId = new Map();
                        [...curPins, ...snap.electricEquipmentPins].forEach(p => {
                            if (!p?.id) return;
                            if (curDel[p.id] && (new Date(p.updatedAt || 0).getTime() || 0) <= (new Date(curDel[p.id]).getTime() || 0)) return;
                            const ex = byId.get(p.id);
                            if (!ex || String(p.updatedAt || '') >= String(ex.updatedAt || '')) byId.set(p.id, p);
                        });
                        localStorage.setItem('elec_labeled_places_list', JSON.stringify(Array.from(byId.values())));
                    }
                } catch (e) {}
            }
        }
        ramIndex.pinsRaw = null;
        refreshRamPinsIndex();
    }

    // ========================================================================
    // 6. ระบบยืนยันตัวตนหลังบ้าน, Inactivity Auto-Logout & Online Presence
    // ========================================================================
    async function verifyLoginOnServer(username, password) {
        unlockCloudWrite(20000);
        forceCloudRead();
        const newSessionToken = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        const res = await fetch(CLOUD_USER_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'verifyLogin', username, password, sessionToken: newSessionToken })
        });
        const data = await res.json();
        if (data?.status === 'ok' && data.authenticated && data.user) {
            const fullUser = normalizeUsernameFormat(data.user.username);
            const grp = getUserGroupName(fullUser);
            const role = data.user.role || 'user';
            const token = data.user.sessionToken || newSessionToken;

            if (data.targetApiUrl && String(data.targetApiUrl).startsWith('https://script.google.com/')) {
                rawStorageSet('elec_cloud_user_api_url', String(data.targetApiUrl).trim());
            } else {
                nativeRemoveItem.call(localStorage, 'elec_cloud_user_api_url');
            }

            const prevGrp = (rawStorageGet(LAST_GROUP_SESSION_KEY) || '').trim();
            if (grp && prevGrp && grp !== prevGrp && role !== 'admin') {
                try {
                    const myPins = JSON.parse(rawStorageGet('elec_labeled_places_list') || '[]')
                        .filter(p => p && (p.ownerGroup || 'กฟส.บึง').trim() === grp);
                    rawStorageSet('elec_labeled_places_list', JSON.stringify(myPins));
                } catch (e) {}
            }
            if (grp) rawStorageSet(LAST_GROUP_SESSION_KEY, grp);

            rawStorageSet('elec_app_logged_in', 'true');
            rawStorageSet('elec_app_current_user', fullUser);
            rawStorageSet('elec_app_current_group', grp);
            rawStorageSet('elec_app_current_role', role);
            rawStorageSet('elec_app_session_token', token);
            rawStorageSet('elec_app_last_active', String(Date.now()));

            if (Array.isArray(data.users) && data.users.length > 0) {
                cachedAccountsStr = '';
                localStorage.setItem('elec_user_accounts', JSON.stringify(data.users.map(parseAccountRecord)));
            }
            refreshMqttSubscriptions();
        }
        return data;
    }

    async function verifyPasswordOnServer(password, usernameOpt) {
        const curUser = usernameOpt || rawStorageGet('elec_app_current_user') || '';
        const res = await fetch(CLOUD_USER_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'verifyUserPassword', username: curUser, password })
        });
        const data = await res.json();
        return Boolean(data && data.status === 'ok' && data.verified);
    }

    function updateUserOnlineHeartbeat(pageLabel = '📱 หน้าช่าง', coords = null, gpsEnabled = true) {
        if (rawStorageGet('elec_app_logged_in') !== 'true') return;
        const curUser = (rawStorageGet('elec_app_current_user') || '').trim();
        if (!curUser) return;

        const curRole = rawStorageGet('elec_app_current_role') || 'user';
        const nowIso = new Date().toISOString();
        const locMap = getTechLocationsMap();
        const existing = locMap[curUser] || {};

        Object.keys(locMap).forEach(k => {
            if (k !== curUser && k !== REGISTRY_LOC_KEY && isSameTechPerson(k, curUser)) delete locMap[k];
        });

        const allowGps = gpsEnabled && !isEmbeddedIframe && curRole !== 'viewer' && curRole !== 'admin';
        locMap[curUser] = {
            ...existing,
            username: curUser,
            role: curRole,
            group: getCurrentUserGroup(),
            lat: allowGps ? (coords?.lat ?? existing.lat ?? null) : null,
            lon: allowGps ? (coords?.lon ?? existing.lon ?? null) : null,
            gpsDisabled: !allowGps,
            currentPage: isEmbeddedIframe ? '💻 หน้าหลัก (เปิดคู่หน้าช่าง)' : pageLabel,
            isOnline: true,
            lastSeenAt: nowIso,
            updatedAt: nowIso
        };
        localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
    }

    function getAccountsOnlineStatusList(localPageLabel = '📱 หน้าช่าง', hasLocalGps = false) {
        const curUser = (rawStorageGet('elec_app_current_user') || '').trim();
        const locMap = getTechLocationsMap();
        const accounts = getParsedUserAccounts();
        const now = Date.now();

        return accounts.map(acc => {
            let matchedLoc = null, bestMs = -1;
            Object.keys(locMap).forEach(k => {
                if (k === REGISTRY_LOC_KEY) return;
                const c = locMap[k];
                if (c && (isSameTechPerson(k, acc.username) || isSameTechPerson(c.username, acc.username))) {
                    const tMs = new Date(c.lastSeenAt || c.updatedAt || 0).getTime() || 0;
                    if (tMs > bestMs) { bestMs = tMs; matchedLoc = c; }
                }
            });
            const isMe = isSameTechPerson(curUser, acc.username);
            const lastSeenMs = bestMs > 0 ? bestMs : 0;
            const diffMs = now - lastSeenMs;
            const isOnline = isMe || Boolean(matchedLoc && matchedLoc.isOnline !== false && lastSeenMs > 0 && diffMs <= ONLINE_THRESHOLD_MS);
            return {
                username: acc.username,
                displayName: formatTechDisplayName(acc.username),
                role: acc.role || 'user',
                isOnline,
                isMe,
                lastSeenMs,
                diffMs,
                currentPage: isMe ? localPageLabel : (matchedLoc?.currentPage || (acc.role === 'tech' ? '📱 หน้าช่าง' : '💻 หน้าหลัก')),
                hasGps: isMe ? Boolean(hasLocalGps) : Boolean(matchedLoc && !matchedLoc.gpsDisabled && matchedLoc.lat && matchedLoc.lon)
            };
        }).sort((a, b) => (a.isOnline !== b.isOnline ? (a.isOnline ? -1 : 1) : (b.lastSeenMs || 0) - (a.lastSeenMs || 0)));
    }

    let lastActivityTouchMs = 0;
    function touchSessionActivity() {
        const now = Date.now();
        if (now - lastActivityTouchMs < 4000) return;
        lastActivityTouchMs = now;
        if (rawStorageGet('elec_app_logged_in') !== 'true') return;
        const last = parseInt(rawStorageGet('elec_app_last_active') || '0', 10);
        if (last > 0 && (now - last > INACTIVITY_TIMEOUT_MS)) {
            if (typeof window.triggerAutoLogout === 'function') window.triggerAutoLogout();
            else if (typeof window.handleTechLogout === 'function') {
                window.handleTechLogout();
                showCustomAlert('⏳ ระบบได้ออกจากระบบอัตโนมัติ เนื่องจากไม่มีการใช้งานเกิน 1 ชั่วโมง', '🔒 หมดเวลาการเชื่อมต่อ');
            }
            return;
        }
        rawStorageSet('elec_app_last_active', String(now));
    }
    ['mousedown', 'keydown', 'touchstart', 'click'].forEach(ev => window.addEventListener(ev, touchSessionActivity, { passive: true }));
    window.addEventListener('focus', () => {
        if (rawStorageGet('elec_app_logged_in') === 'true') rawStorageSet('elec_app_last_active', String(Date.now()));
    });

    // ========================================================================
    // 7. ระบบคลายลิงก์ย่อ Google Maps 5 ชั้น + S2 Cell Decoder + Haversine
    // ========================================================================
    function calcHaversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * (Math.sin(dLon / 2) ** 2);
        return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    }

    function decodeS2CellIdToLatLon(hexStr) {
        try {
            const id = BigInt('0x' + hexStr);
            if (id === 0n) return null;
            const face = Number(id >> 61n);
            if (face < 0 || face > 5) return null;
            const posToIJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]];
            const posToOrientation = [1, 0, 0, 3];
            const lookupIJ = new Int32Array(1024);
            const initCell = (lv, i, j, origO, pos, o) => {
                if (lv === 4) lookupIJ[(pos << 2) + origO] = (((i << 4) + j) << 2) + o;
                else {
                    const r = posToIJ[o];
                    for (let k = 0; k < 4; k++) initCell(lv + 1, (i << 1) + (r[k] >> 1), (j << 1) + (r[k] & 1), origO, (pos << 2) + k, o ^ posToOrientation[k]);
                }
            };
            for (let d = 0; d < 4; d++) initCell(0, 0, 0, d, 0, d);
            let i = 0, j = 0, o = face & 1;
            for (let k = 7; k >= 0; k--) {
                const nbits = (k === 7) ? 2 : 4;
                const bits = Number((id >> BigInt(k * 8 + 1)) & ((1n << BigInt(2 * nbits)) - 1n));
                const val = lookupIJ[(bits << 2) + o];
                i += (val >> 6) << (k * 4); j += ((val >> 2) & 15) << (k * 4); o = val & 3;
            }
            const stToUV = (s) => (s >= 0.5) ? (1 / 3) * (4 * s * s - 1) : (1 / 3) * (1 - 4 * (1 - s) * (1 - s));
            const u = stToUV((i + 0.5) / 1073741824.0), v = stToUV((j + 0.5) / 1073741824.0);
            const xyz = [[1, u, v], [-u, 1, v], [-u, -v, 1], [-1, -v, -u], [v, -1, -u], [v, u, -1]][face];
            const lat = Math.atan2(xyz[2], Math.hypot(xyz[0], xyz[1])) * (180 / Math.PI);
            const lon = Math.atan2(xyz[1], xyz[0]) * (180 / Math.PI);
            if (lat >= 5 && lat <= 21 && lon >= 97 && lon <= 106) return { lat: lat.toFixed(6), lon: lon.toFixed(6) };
        } catch (e) {}
        return null;
    }

    function deepParseCoords(rawStr, isHtmlBody = false) {
        if (!rawStr) return null;
        let s = String(rawStr).replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=').replace(/\\u002f/gi, '/').replace(/&amp;/gi, '&');
        for (let i = 0; i < 3; i++) { try { s = decodeURIComponent(s); } catch (e) { break; } }

        const m3d = s.match(/!3d(-?\d{1,2}\.\d{4,})!4d(-?\d{2,3}\.\d{4,})/);
        if (m3d) return { lat: parseFloat(m3d[1]).toFixed(6), lon: parseFloat(m3d[2]).toFixed(6) };

        const mUrl = s.match(/(?:@|center=|q=|ll=|sll=|daddr=|destination=|search\/|place\/|dir\/\/)(-?\d{1,2}\.\d{3,})\s*[,\s+]+\s*\+?(-?\d{2,3}\.\d{3,})/i);
        if (mUrl) return { lat: parseFloat(mUrl[1]).toFixed(6), lon: parseFloat(mUrl[2]).toFixed(6) };

        const mDms = s.match(/(\d{1,2})[°\s]+(\d{1,2})['’′\s]+([\d.]+)["”″\s]*([NS])[\s,+]*(\d{2,3})[°\s]+(\d{1,2})['’′\s]+([\d.]+)["”″\s]*([EW])/i);
        if (mDms) {
            let lat = parseFloat(mDms[1]) + parseFloat(mDms[2]) / 60 + parseFloat(mDms[3]) / 3600;
            if (mDms[4].toUpperCase() === 'S') lat = -lat;
            let lon = parseFloat(mDms[5]) + parseFloat(mDms[6]) / 60 + parseFloat(mDms[7]) / 3600;
            if (mDms[8].toUpperCase() === 'W') lon = -lon;
            return { lat: lat.toFixed(6), lon: lon.toFixed(6) };
        }
        const mLatLon = s.match(/Lat[\s:=]*(-?\d+\.\d+)[\s,]*Long?[\s:=]*(-?\d+\.\d+)/i);
        if (mLatLon) return { lat: parseFloat(mLatLon[1]).toFixed(6), lon: parseFloat(mLatLon[2]).toFixed(6) };

        const mFtid = s.match(/(?:!1s|ftid=|\b)0x([0-9a-f]{16}):0x[0-9a-f]{8,16}/i);
        if (mFtid) { const s2 = decodeS2CellIdToLatLon(mFtid[1]); if (s2) return s2; }

        const mNull = s.match(/\[null\s*,\s*null\s*,\s*([5-9]\.\d{4,}|1\d\.\d{4,}|20\.\d{4,})\s*,\s*(9[7-9]\.\d{4,}|10[0-6]\.\d{4,})\]/);
        if (mNull) return { lat: parseFloat(mNull[1]).toFixed(6), lon: parseFloat(mNull[2]).toFixed(6) };

        if (!isHtmlBody && s.length < 400) {
            const mPair = s.match(/(-?\d{1,2}\.\d{3,})\s*,\s*\+?(-?\d{2,3}\.\d{3,})/);
            if (mPair) {
                const a = parseFloat(mPair[1]), b = parseFloat(mPair[2]);
                if (a >= 95 && a <= 108 && b >= 4 && b <= 23) return { lat: b.toFixed(6), lon: a.toFixed(6) };
                return { lat: a.toFixed(6), lon: b.toFixed(6) };
            }
        }
        return null;
    }

    async function fetchWithTimeout(url, ms = 6000) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ms);
        try { return await nativeFetch.call(window, url, { signal: ctrl.signal, cache: 'no-store' }); }
        finally { clearTimeout(timer); }
    }

    async function queryUnshorteners(targetUrl) {
        const enc = encodeURIComponent(targetUrl);
        const extractNext = (h) => {
            const m = String(h || '').replace(/\\u0026/gi, '&').match(/https?:\/\/(?:www\.|maps\.)?google\.[a-z.]+\/maps[^\s"'<>\\]+/i);
            return m ? m[0] : null;
        };
        return Promise.any([
            fetchWithTimeout(`https://api.microlink.io/?url=${enc}`).then(r => r.json()).then(d => {
                const c = deepParseCoords(`${d?.data?.url || ''} ${d?.data?.image?.url || ''}`, false);
                if (c) return { coords: c };
                if (d?.data?.url && d.data.url !== targetUrl) return { nextUrl: d.data.url };
                throw 0;
            }),
            fetchWithTimeout(`https://api.allorigins.win/get?url=${enc}`).then(r => r.json()).then(d => {
                const c = deepParseCoords(d?.status?.url || '', false) || deepParseCoords(d?.contents || '', true);
                if (c) return { coords: c };
                const nx = extractNext(d?.status?.url || d?.contents);
                if (nx) return { nextUrl: nx };
                throw 0;
            }),
            fetchWithTimeout(`https://unshorten.me/json/${targetUrl}`).then(r => r.json()).then(d => {
                const c = deepParseCoords(d?.resolved_url || '', false);
                if (c) return { coords: c };
                if (d?.resolved_url && d.resolved_url !== targetUrl) return { nextUrl: d.resolved_url };
                throw 0;
            }),
            fetchWithTimeout(`https://api.codetabs.com/v1/proxy?quest=${enc}`).then(r => r.text()).then(t => {
                const c = deepParseCoords(t, true);
                if (c) return { coords: c };
                const nx = extractNext(t);
                if (nx) return { nextUrl: nx };
                throw 0;
            }),
            fetchWithTimeout(`https://corsproxy.io/?${enc}`).then(async r => {
                const t = await r.text();
                const c = deepParseCoords(r.url || '', false) || deepParseCoords(t, true);
                if (c) return { coords: c };
                const nx = extractNext(t);
                if (nx) return { nextUrl: nx };
                throw 0;
            })
        ]);
    }

    async function resolveGoogleShortLinkUniversal(rawInput) {
        const text = String(rawInput || '').trim();
        if (!text) return null;
        const direct = deepParseCoords(text, false);
        if (direct) return direct;

        const match = text.match(SHORT_URL_REGEX);
        if (!match) return null;
        const shortUrl = (/^https?:\/\//i.test(match[0]) ? match[0] : 'https://' + match[0]).split('?')[0];

        try {
            const cache = JSON.parse(rawStorageGet(SHORT_LINK_CACHE_KEY) || '{}');
            if (cache[shortUrl]?.lat && cache[shortUrl]?.lon) return cache[shortUrl];
        } catch (e) {}

        try {
            const step1 = await queryUnshorteners(shortUrl);
            let coords = step1?.coords || (step1?.nextUrl ? (deepParseCoords(step1.nextUrl, false) || (await queryUnshorteners(step1.nextUrl))?.coords) : null);
            if (coords?.lat && coords?.lon) {
                const cache = JSON.parse(rawStorageGet(SHORT_LINK_CACHE_KEY) || '{}');
                cache[shortUrl] = coords;
                rawStorageSet(SHORT_LINK_CACHE_KEY, JSON.stringify(cache));
                return coords;
            }
        } catch (e) {}
        return null;
    }

    async function autoResolveShortLinkInputEl(el) {
        if (!el || el.dataset.resolvingShort === 'true') return;
        const rawVal = el.value || '';
        const match = rawVal.match(SHORT_URL_REGEX);
        if (!match || el.id === 'rawCustomerPasteInput' || el.id === 'address') return;

        el.dataset.resolvingShort = 'true';
        showToast('⏳ กำลังแปลงลิงก์ย่อ Google Maps เป็นพิกัด...');
        try {
            const coords = await resolveGoogleShortLinkUniversal(match[0]);
            if (!coords?.lat || !coords?.lon) {
                showToast('⚠️ คลายลิงก์สั้นไม่สำเร็จ กรุณาวางพิกัดตัวเลขแทน');
                return;
            }
            const id = el.id || '';
            const pairStr = `${coords.lat}, ${coords.lon}`;
            const fullUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lon}`;

            if (id.includes('LatInput') || id.includes('LonInput')) {
                const pfx = id.replace(/(?:Lat|Lon)Input$/, '');
                const latEl = document.getElementById(pfx + 'LatInput'), lonEl = document.getElementById(pfx + 'LonInput');
                if (latEl && lonEl) { latEl.value = coords.lat; lonEl.value = coords.lon; }
            } else if (id === 'leftBrowserUrlInput') {
                el.value = fullUrl;
                const ifr = document.getElementById('leftBrowserIframe');
                if (ifr) ifr.src = `${fullUrl}&hl=th&z=16&output=embed`;
            } else if (id === 'gps' || id === 'gpsInput' || id === 'ce_gps' || id === 'techGpsInput') {
                el.value = fullUrl;
            } else {
                el.value = pairStr;
            }
            const statusHint = document.getElementById('equipShortLinkStatus');
            if (statusHint && id === 'equipCoordInput') {
                statusHint.textContent = `✅ แปลงลิงก์สั้นสำเร็จ: ${pairStr}`;
                statusHint.className = 'text-[10px] text-emerald-600 font-bold mt-1';
            }
            showToast(`📍 แปลงลิงก์ย่อสำเร็จ: ${pairStr}`);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } finally {
            delete el.dataset.resolvingShort;
        }
    }

    ['input', 'change'].forEach(evt => {
        document.addEventListener(evt, (e) => {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && SHORT_URL_REGEX.test(t.value || '')) {
                autoResolveShortLinkInputEl(t);
            }
        }, true);
    });

    document.addEventListener('paste', (e) => {
        const t = e.target;
        if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
        setTimeout(() => {
            if (SHORT_URL_REGEX.test(t.value || '')) autoResolveShortLinkInputEl(t);
        }, 50);
    }, true);

    // ========================================================================
    // 8. ระบบ PWA Install, Service Worker & วาดไอคอนหน้าจอโฮมอัตโนมัติ
    // ========================================================================
    function renderCanvasHomeIconIfPresent() {
        try {
            const favEl = document.getElementById('favIconPng');
            const touchEl = document.getElementById('appleTouchIconPng');
            if (!favEl && !touchEl) return;
            const isTech = Boolean(document.getElementById('techMainApp'));

            const cv = document.createElement('canvas');
            cv.width = 512; cv.height = 512;
            const ctx = cv.getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 512, 512);
            if (isTech) {
                grad.addColorStop(0, '#0f766e'); grad.addColorStop(0.5, '#0d9488'); grad.addColorStop(1, '#1e3a8a');
            } else {
                grad.addColorStop(0, '#1e3a8a'); grad.addColorStop(0.5, '#2563eb'); grad.addColorStop(1, '#4f46e5');
            }
            const r = 115;
            ctx.beginPath();
            ctx.moveTo(r, 0); ctx.lineTo(512 - r, 0); ctx.quadraticCurveTo(512, 0, 512, r);
            ctx.lineTo(512, 512 - r); ctx.quadraticCurveTo(512, 512, 512 - r, 512);
            ctx.lineTo(r, 512); ctx.quadraticCurveTo(0, 512, 0, 512 - r);
            ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0); ctx.closePath();
            ctx.fillStyle = grad; ctx.fill();

            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.font = '310px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
            ctx.fillText(isTech ? '🛠️' : '⚡', 256, 270);
            if (isTech) {
                ctx.font = '205px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
                ctx.fillText('⚡', 266, 252);
            }
            const png = cv.toDataURL('image/png');
            if (favEl) favEl.href = png;
            if (touchEl) touchEl.href = png;
        } catch (e) {}
    }

    function initPwaAndServiceWorker() {
        renderCanvasHomeIconIfPresent();
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js').then(reg => reg.update()).catch(() => {});
        }
        if (isEmbeddedIframe || window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) return;
        if (document.getElementById('pwaInstallBanner')) return;

        let deferredPrompt = null;
        const banner = document.createElement('div');
        banner.id = 'pwaInstallBanner';
        banner.className = 'fixed top-3 left-1/2 -translate-x-1/2 z-[180] hidden items-center gap-2 bg-slate-900/95 text-white px-4 py-2 rounded-full shadow-2xl border border-emerald-400/50 text-xs font-bold backdrop-blur-md';
        banner.innerHTML = `
            <span>📲 ติดตั้งเป็นแอปเต็มจอ</span>
            <button type="button" id="pwaInstallConfirmBtn" class="bg-emerald-500 hover:bg-emerald-600 text-white px-3 py-1 rounded-full text-[11px] font-extrabold shadow transition">ติดตั้งเลย</button>
            <button type="button" onclick="this.parentElement.classList.add('hidden')" class="text-slate-400 hover:text-white pl-1 text-base leading-none">&times;</button>`;
        document.body.appendChild(banner);

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            banner.classList.remove('hidden');
            banner.classList.add('flex');
        });
        document.getElementById('pwaInstallConfirmBtn').onclick = async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                if (outcome === 'accepted') banner.classList.add('hidden');
                deferredPrompt = null;
            }
        };
    }

    // ========================================================================
    // 9. ส่งออก API กลาง (PeaCore Namespace + Backward-Compatible Globals)
    // ========================================================================
    refreshRamDelPinsIndex();
    refreshRamPinsIndex();

    const PeaCore = {
        CLOUD_USER_API_URL,
        REGISTRY_LOC_KEY,
        isEmbeddedIframe,
        simSandbox,
        ramIndex,
        rawStorageGet,
        rawStorageSet,
        refreshRamPinsIndex,
        refreshRamDelPinsIndex,
        enterSimSandbox,
        exitSimSandbox,
        unlockCloudWrite,
        forceCloudRead,
        createTrailingAsyncQueue,
        onRealtimeChange(fn) { if (typeof fn === 'function') realtimeSubscribers.add(fn); },
        verifyLoginOnServer,
        verifyPasswordOnServer,
        updateUserOnlineHeartbeat,
        getAccountsOnlineStatusList,
        runWithGroupViewFilter,
        cleanReopenedAndCancelledJobsInStorage,
        getStorageUsageStats,
        cleanTemporaryCacheSafe,
        downloadCsvFallback
    };

    window.PeaCore = PeaCore;
    window.CLOUD_USER_API_URL = CLOUD_USER_API_URL;
    window.getActiveCloudApiUrl = getActiveCloudApiUrl;
    window.getUserGroupName = getUserGroupName;
    window.getUserBaseId = getUserBaseId;
    window.normalizeUsernameFormat = normalizeUsernameFormat;
    window.isUsernameMatchingAccount = isUsernameMatchingAccount;
    window.parseAccountRecord = parseAccountRecord;
    window.getParsedUserAccounts = getParsedUserAccounts;
    window.formatTechDisplayName = formatTechDisplayName;
    window.isSameTechPerson = isSameTechPerson;
    window.getValidSystemGroupsSet = getValidSystemGroupsSet;
    window.getCurrentUserGroup = getCurrentUserGroup;
    window.getJobGroupName = getJobGroupName;
    window.isCurrentUserAdmin = isCurrentUserAdmin;
    window.isViewerRole = isViewerRole;
    window.canCurrentUserEditScada = canCurrentUserEditScada;
    window.canCurrentUserSeeJob = canCurrentUserSeeJob;
    window.escapeHtmlStr = escapeHtmlStr;
    window.hexToClosestPinColorKey = hexToClosestPinColorKey;

    window.showToast = showToast;
    window.showCustomAlert = showCustomAlert;
    window.showCustomConfirm = showCustomConfirm;
    window.showCustomPrompt = showCustomPrompt;
    window.copyTextToClipboard = copyTextToClipboard;
    window.copyTechText = copyTextToClipboard;
    window.ensureXlsxLoaded = ensureXlsxLibraryLoaded;
    window.ensureTechXlsxLoaded = ensureXlsxLibraryLoaded;

    window.isAutoGeneratedFakeClosure = isAutoGeneratedFakeClosure;
    window.getClosedJobsRegistry = getClosedJobsRegistry;
    window.getClosedReportsRegistry = getClosedJobsRegistry;
    window.saveClosedJobToRegistry = saveClosedJobToRegistry;
    window.saveClosedReportsRegistry = syncClosedRegistryObject;
    window.syncClosedRegistryObject = syncClosedRegistryObject;
    window.getDeletedJobsRegistry = getDeletedJobsRegistry;
    window.recordDeletedJobToRegistry = recordDeletedJobToRegistry;
    window.syncDeletedRegistryObject = syncDeletedRegistryObject;
    window.getTechLocationsMap = getTechLocationsMap;
    window.mergeTechLocationsMap = mergeTechLocationsMap;

    window.calcHaversineKm = calcHaversineKm;
    window.deepParseCoords = deepParseCoords;
    window.resolveGoogleShortLinkUniversal = resolveGoogleShortLinkUniversal;
    window.__unlockCloudWrite = unlockCloudWrite;

    if (rawStorageGet('elec_app_logged_in') === 'true') {
        rawStorageSet('elec_app_last_active', String(Date.now()));
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', () => {
            initPwaAndServiceWorker();
            initMqttTransport();
        });
    } else {
        initPwaAndServiceWorker();
        initMqttTransport();
    }
})();
// ==================== จบไฟล์ shared-core.js ====================
