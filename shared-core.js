// ============================================================================
// ⚡ PEA SMART GRID — SHARED CORE ENGINE v6.7 (shared-core.js)
// ระบบแกนกลางร่วมสำหรับ index.html และ page2.html (เชื่อม IndexedDB v2.0, SCADA v6.5 & PM v7.3 ครบ 100%)
// พาทที่ 1 / 4 : Config, Group Normalization, RBAC, UI Modals & Z-Index Safeguards
// ============================================================================
(function () {
    'use strict';

    const CLOUD_USER_API_URL = "https://script.google.com/macros/s/AKfycbzLEIlMtJ2u9U8XsSCAbta_Df2mmhzlNN-O2ZKrxH4RiN8-DTyw8bIIn2PCzl9eokpI/exec";
    const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
    const MAX_REGISTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const MAX_STALE_LOC_AGE_MS = 14 * 24 * 60 * 60 * 1000;
    const ONLINE_THRESHOLD_MS = 180 * 1000;
    const CHANNEL_NAME = 'pea_smart_grid_hyper_v4';
    const SHORT_LINK_CACHE_KEY = 'elec_resolved_shortlinks_cache_v2';
    const SHORT_URL_REGEX = /(?:https?:\/\/)?(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/[A-Za-z0-9_-]+(?:\?[^\s"'<>]*)?/i;
    const LAST_GROUP_SESSION_KEY = 'elec_last_logged_group_name';
    const SHEET_CACHE_STORAGE_KEY = 'elec_sheet_cache_by_group_v3';
    const SHEET_DISK_CACHE_MAX_CHARS = 180000;
    const REGISTRY_LOC_KEY = '__NAV_CANCEL_REGISTRY__';
    const PM_LOC_PREFIX = '__PM_SCHEDULE__';

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

    let cachedAccountsStr = '';
    let cachedParsedAccounts = [];
    let isGroupViewFilterActive = false;
    let isApplyingRemotePacket = false;
    let isInternalSanitizing = false;
    let inFlightCloudGetCount = 0;
    let allowWriteUntilMs = 0;
    let forceManualGet = false;
    const sheetMemoryCacheMap = new Map();

    // ป้องกันป๊อปอัปแก้ไขบัญชี/ตำบลจมหลังหน้าต่างหลักใน index.html และ page2.html
    function injectCoreModalZIndexFixes() {
        if (document.getElementById('peaCoreZIndexFixCss') || !document.head) return;
        const st = document.createElement('style');
        st.id = 'peaCoreZIndexFixCss';
        st.textContent = `
            #onlineUsersModal, #techOnlineModal { z-index: 1280 !important; }
            #customUserEditModal, #customTambonEditModal { z-index: 1470 !important; }
            #customAlertModal, #customConfirmModal, #customPromptModal { z-index: 1480 !important; }
        `;
        document.head.appendChild(st);
    }
    injectCoreModalZIndexFixes();

    function rawStorageGet(key) {
        return nativeGetItem.call(localStorage, key);
    }

    function rawStorageSet(key, val) {
        try {
            nativeSetItem.call(localStorage, key, val);
        } catch (err) {
            try {
                nativeRemoveItem.call(localStorage, 'elec_closed_reports_map');
                nativeRemoveItem.call(localStorage, 'elec_sheet_cache_2k');
                nativeRemoveItem.call(localStorage, SHEET_CACHE_STORAGE_KEY);
                nativeRemoveItem.call(localStorage, SHORT_LINK_CACHE_KEY);
                const reg = JSON.parse(rawStorageGet('elec_closed_jobs_registry') || '{}');
                nativeSetItem.call(localStorage, 'elec_closed_jobs_registry', JSON.stringify(pruneClosedRegistryMap(reg)));
                nativeSetItem.call(localStorage, key, val);
            } catch (e) {
                if (key !== SHEET_CACHE_STORAGE_KEY && typeof showToast === 'function') {
                    showToast('⚠️ ความจำเบราว์เซอร์เต็ม กรุณาสำรองข้อมูลออกเป็นไฟล์');
                }
            }
        }
    }

    function isSystemLocRegistryKey(k, itemObj) {
        if (!k) return true;
        return k === REGISTRY_LOC_KEY || String(k).startsWith(PM_LOC_PREFIX) || Boolean(itemObj && itemObj.isSystemRegistry);
    }

    // ========================================================================
    // 1. ระบบจัดมาตรฐานกลุ่มสังกัด (กฟส.), รหัสพนักงาน/ชื่อเต็ม และสิทธิ์การใช้งาน (RBAC)
    // ========================================================================
    function getActiveCloudApiUrl() {
        const custom = (rawStorageGet('elec_cloud_user_api_url') || '').trim();
        if (custom && custom.startsWith('https://script.google.com/')) return custom;
        return CLOUD_USER_API_URL;
    }

    function normalizePeaGroupName(rawGrp) {
        let g = String(rawGrp || '').replace(/[\r\n\t]+/g, ' ').trim().replace(/\s+/g, ' ');
        if (!g || g.toLowerCase() === 'admin' || g.toUpperCase() === 'ALL' || g === '__ADMIN_ALL__') return '';
        if (/[()[\]{}<>\\\/]/.test(g) || /^\d+$/.test(g)) return '';
        g = g.replace(/^(กฟ[ก-ฮ]{1,2})\.\s+/, '$1.');
        g = g.replace(/^(กฟ[สฟจตอยภผกนฉ])\s+/, '$1.');
        g = g.replace(/^(กฟ[สฟจตอยภผกนฉ])(?![.\s]|[ก-ฮ]\.|$)/, '$1.');
        return g.length > 60 ? g.substring(0, 60).trim() : g.trim();
    }

    function stripPeaGroupSuffix(rawUsername) {
        return String(rawUsername || '').trim().replace(/\s+/g, ' ').replace(/\s*(กฟ(?:[ก-ฮ]{1,2}\.|[สฟจตอยภผกนฉ]\.?).*)$/i, '').trim();
    }

    function getUserGroupName(username) {
        if (!username) return '';
        const s = String(username).replace(/\([^)]*\)/g, ' ').trim().replace(/\s+/g, ' ');
        if (!s || s.toLowerCase() === 'admin') return '';
        const peaMatch = s.match(/(กฟ(?:[ก-ฮ]{1,2}\.|[สฟจตอยภผกนฉ]\.?).*)$/);
        if (peaMatch) return normalizePeaGroupName(peaMatch[1]);
        const numGroupMatch = s.match(/^(\d{3,12})\s*([ก-๙a-zA-Z].*)$/);
        if (numGroupMatch && !/^(?:นาย|นาง|น\.ส\.|นางสาว|คุณ|ช่าง)/.test(numGroupMatch[2])) {
            return normalizePeaGroupName(numGroupMatch[2]);
        }
        const parts = s.split(/\s+/);
        if (parts.length > 1 && /^กฟ/.test(parts[parts.length - 1])) return normalizePeaGroupName(parts[parts.length - 1]);
        return '';
    }

    function getUserBaseId(username) {
        if (!username) return '';
        const s = String(username).replace(/\([^)]*\)/g, ' ').trim().replace(/\s+/g, ' ');
        if (s.toLowerCase() === 'admin') return 'admin';
        const withoutPea = stripPeaGroupSuffix(s);
        if (!withoutPea) return s.toLowerCase();
        const numMatch = withoutPea.match(/^(\d{3,12})(?:\b|$)/);
        if (numMatch) return numMatch[1].toLowerCase();
        const stuckNumMatch = s.match(/^(\d{3,12})(?=[ก-๙a-zA-Z])/);
        if (stuckNumMatch) return stuckNumMatch[1].toLowerCase();
        return withoutPea.toLowerCase();
    }

    function normalizeUsernameFormat(rawUsername) {
        const s = String(rawUsername || '').trim().replace(/\s+/g, ' ');
        if (!s) return '';
        if (s.toLowerCase() === 'admin') return 'admin';
        const peaMatch = s.match(/^(.*?)\s*(กฟ(?:[ก-ฮ]{1,2}\.|[สฟจตอยภผกนฉ]\.?).*)$/);
        if (peaMatch) {
            const front = peaMatch[1].trim(), grp = normalizePeaGroupName(peaMatch[2]);
            return (front && grp && front.toLowerCase() !== grp.toLowerCase()) ? `${front} ${grp}` : (front || grp || s);
        }
        const numMatch = s.match(/^(\d{3,12})\s*([ก-๙a-zA-Z].*)$/);
        if (numGroupMatchCheck(numMatch)) {
            const grp = normalizePeaGroupName(numMatch[2]);
            return grp ? `${numMatch[1]} ${grp}` : s;
        }
        return s;
    }

    function numGroupMatchCheck(m) {
        return Boolean(m && !/^(?:นาย|นาง|น\.ส\.|นางสาว|คุณ|ช่าง)/.test(m[2]));
    }
    function isUsernameMatchingAccount(inputUser, accountUser) {
        if (!inputUser || !accountUser) return false;
        const inTrim = String(inputUser).trim().replace(/\s+/g, ' ').toLowerCase();
        const accTrim = String(accountUser).trim().replace(/\s+/g, ' ').toLowerCase();
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
        if (str.includes(',')) return str.split(',').map(s => formatTechDisplayName(s.trim())).join(', ');
        const matched = getParsedUserAccounts().find(a => isUsernameMatchingAccount(str, a.username));
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
        getParsedUserAccounts().forEach(a => { const g = getUserGroupName(a.username); if (g) set.add(g); });
        return set;
    }

    function getCurrentUserGroup() {
        const curUser = rawStorageGet('elec_app_current_user') || '';
        const role = (rawStorageGet('elec_app_current_role') || 'user').trim();
        const direct = getUserGroupName(curUser);
        if (direct) return direct;
        const saved = normalizePeaGroupName(rawStorageGet('elec_app_current_group') || '');
        if (saved) return saved;
        const baseId = getUserBaseId(curUser);
        const matched = getParsedUserAccounts().find(a => isUsernameMatchingAccount(curUser, a.username) || (baseId && getUserBaseId(a.username) === baseId));
        const fromAcc = matched ? getUserGroupName(matched.username) : '';
        if (fromAcc) return fromAcc;
        if (role !== 'admin') {
            const lastGrp = normalizePeaGroupName(rawStorageGet(LAST_GROUP_SESSION_KEY) || '');
            if (lastGrp && lastGrp !== '__ADMIN_ALL__') return lastGrp;
            const validGroups = Array.from(getValidSystemGroupsSet());
            return validGroups.length === 1 ? validGroups[0] : 'กฟส.บึง';
        }
        return '';
    }

    function getJobGroupName(job) {
        if (!job) return 'กฟส.บึง';
        const validGroups = getValidSystemGroupsSet();
        if (job.ownerGroup && String(job.ownerGroup).trim() !== '') {
            const og = normalizePeaGroupName(job.ownerGroup);
            if (og && (validGroups.size === 0 || validGroups.has(og) || /^กฟ/.test(og))) return og;
        }
        const accounts = getParsedUserAccounts();
        for (const c of [job.ownerUser, job.techNav?.techName, job.techReport?.inspector].filter(Boolean)) {
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

    function isCurrentUserAdmin() { return rawStorageGet('elec_app_logged_in') === 'true' && rawStorageGet('elec_app_current_role') === 'admin'; }
    function isViewerRole() { return rawStorageGet('elec_app_logged_in') === 'true' && rawStorageGet('elec_app_current_role') === 'viewer'; }
    function canCurrentUserEditScada() {
        if (rawStorageGet('elec_app_logged_in') !== 'true') return false;
        const r = (rawStorageGet('elec_app_current_role') || '').trim();
        return r === 'admin' || r === 'user';
    }
    function canCurrentUserSeeJob(job) {
        if ((rawStorageGet('elec_app_current_role') || 'user') === 'admin') return true;
        const myGrp = normalizePeaGroupName(getCurrentUserGroup() || 'กฟส.บึง');
        return myGrp === normalizePeaGroupName(getJobGroupName(job) || 'กฟส.บึง');
    }
    function runWithGroupViewFilter(fn, context, args) {
        isGroupViewFilterActive = true;
        try { return fn.apply(context, args || []); } finally { isGroupViewFilterActive = false; }
    }
    function escapeHtmlStr(str) {
        return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function hexToClosestPinColorKey(hexStr) {
        const s = String(hexStr || '').trim();
        if (!/^#[0-9A-Fa-f]{6}$/.test(s)) return 'green';
        const r = parseInt(s.slice(1, 3), 16), g = parseInt(s.slice(3, 5), 16), b = parseInt(s.slice(5, 7), 16);
        let best = 'green', minD = Infinity;
        THEME_RGB_LIST.forEach(t => { const d = (r - t.r) ** 2 + (g - t.g) ** 2 + (b - t.b) ** 2; if (d < minD) { minD = d; best = t.key; } });
        return best;
    }

    // ========================================================================
    // 2. กล่องแจ้งเตือนมาตรฐาน (z-[1480] ไม่ถูกบัง) & ส่งออกตารางคืนแรมปลอดภัย
    // ========================================================================
    function showToast(msg) {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg; t.classList.remove('opacity-0'); t.classList.add('opacity-100');
        clearTimeout(t.__hideTimer);
        t.__hideTimer = setTimeout(() => { t.classList.remove('opacity-100'); t.classList.add('opacity-0'); }, 2500);
    }

    function showCustomAlert(message, title = '⚡ แจ้งเตือนระบบ') {
        let modal = document.getElementById('customAlertModal');
        if (!modal) {
            modal = document.createElement('div'); modal.id = 'customAlertModal';
            modal.className = 'fixed inset-0 z-[1480] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4 transition-opacity';
            modal.innerHTML = `<div class="bg-slate-800 text-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4 border border-slate-700"><h3 id="customAlertTitle" class="text-lg font-bold text-amber-400"></h3><p id="customAlertMessage" class="text-sm text-slate-200 leading-relaxed whitespace-pre-line"></p><div class="flex justify-end pt-2"><button type="button" onclick="document.getElementById('customAlertModal').classList.add('hidden')" class="bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm px-5 py-2 rounded-xl shadow transition">ตกลง</button></div></div>`;
            document.body.appendChild(modal);
        }
        document.getElementById('customAlertTitle').textContent = title;
        document.getElementById('customAlertMessage').textContent = message;
        modal.classList.remove('hidden');
    }
    window.alert = (msg) => showCustomAlert(msg, '⚡ แจ้งเตือนระบบ');

    function showCustomConfirm(message, onConfirm, title = '⚡ ยืนยันการทำรายการ') {
        if (typeof window.__customConfirmInterceptor === 'function' && window.__customConfirmInterceptor(message, onConfirm, title)) return;
        let modal = document.getElementById('customConfirmModal');
        if (!modal) {
            modal = document.createElement('div'); modal.id = 'customConfirmModal';
            modal.className = 'fixed inset-0 z-[1480] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4 transition-opacity';
            modal.innerHTML = `<div class="bg-slate-800 text-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4 border border-slate-700"><h3 id="customConfirmTitle" class="text-lg font-bold text-amber-400"></h3><p id="customConfirmMessage" class="text-sm text-slate-200 leading-relaxed whitespace-pre-line"></p><div class="flex justify-end gap-2 pt-2"><button type="button" onclick="document.getElementById('customConfirmModal').classList.add('hidden')" class="text-slate-300 hover:text-white font-semibold text-sm px-4 py-2 rounded-xl hover:bg-slate-700/50 transition">ยกเลิก</button><button type="button" id="customConfirmOkBtn" class="bg-rose-500 hover:bg-rose-600 text-white font-bold text-sm px-5 py-2 rounded-xl shadow transition">ตกลง</button></div></div>`;
            document.body.appendChild(modal);
        }
        document.getElementById('customConfirmTitle').textContent = title;
        document.getElementById('customConfirmMessage').textContent = message;
        document.getElementById('customConfirmOkBtn').onclick = function () { modal.classList.add('hidden'); unlockCloudWrite(20000); if (typeof onConfirm === 'function') onConfirm(); };
        modal.classList.remove('hidden');
    }

    function showCustomPrompt(message, defaultValue = '', onConfirm, title = '✏️ แก้ไขข้อมูล') {
        let modal = document.getElementById('customPromptModal');
        if (!modal) {
            modal = document.createElement('div'); modal.id = 'customPromptModal';
            modal.className = 'fixed inset-0 z-[1480] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4 transition-opacity';
            modal.innerHTML = `<div class="bg-slate-800 text-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4 border border-slate-700"><h3 id="customPromptTitle" class="text-lg font-bold text-amber-400"></h3><p id="customPromptMessage" class="text-sm text-slate-200 leading-relaxed"></p><input type="text" id="customPromptInput" class="w-full px-3.5 py-2 text-slate-800 font-medium rounded-xl text-sm bg-white focus:outline-none"><div class="flex justify-end gap-2 pt-2"><button type="button" onclick="document.getElementById('customPromptModal').classList.add('hidden')" class="text-slate-300 hover:text-white font-semibold text-sm px-4 py-2 rounded-xl hover:bg-slate-700/50 transition">ยกเลิก</button><button type="button" id="customPromptOkBtn" class="bg-blue-500 hover:bg-blue-600 text-white font-bold text-sm px-5 py-2 rounded-xl shadow transition">บันทึก</button></div></div>`;
            document.body.appendChild(modal);
        }
        document.getElementById('customPromptTitle').textContent = title;
        document.getElementById('customPromptMessage').textContent = message;
        const inp = document.getElementById('customPromptInput'); inp.value = defaultValue;
        const submit = () => { modal.classList.add('hidden'); unlockCloudWrite(20000); if (typeof onConfirm === 'function') onConfirm(inp.value); };
        document.getElementById('customPromptOkBtn').onclick = submit;
        inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } };
        modal.classList.remove('hidden'); setTimeout(() => inp.focus(), 50);
    }

    function fallbackCopy(text, successMsg) {
        const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
        document.body.appendChild(ta); ta.focus(); ta.select();
        try { document.execCommand('copy'); showToast(successMsg); } catch (e) { showToast('⚠️ คัดลอกไม่สำเร็จ'); }
        document.body.removeChild(ta);
    }
    function copyTextToClipboard(text, successMsg = '📋 คัดลอกข้อความสำเร็จ!') {
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => showToast(successMsg)).catch(() => fallbackCopy(text, successMsg));
        else fallbackCopy(text, successMsg);
    }
    function ensureXlsxLibraryLoaded() {
        return new Promise((resolve) => {
            if (typeof XLSX !== 'undefined') return resolve(true);
            const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
            s.onload = () => resolve(true); s.onerror = () => resolve(false); document.head.appendChild(s);
        });
    }
    function downloadCsvFallback(headers, rows, filename) {
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = '\uFEFF' + [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\r\n');
        const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        const link = document.createElement('a'); link.href = blobUrl;
        link.download = String(filename || 'export.csv').replace(/\.xlsx?$/i, '.csv');
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 5000);
    }
    // ===== จบพาทที่ 1 / 4 ของไฟล์ shared-core.js =====
        // ===== เริ่มพาทที่ 2 / 4 ของไฟล์ shared-core.js (วางต่อจากพาทที่ 1 / 4) =====
    // ========================================================================
    // 3. ระบบ Storage Bus รวมศูนย์, Single-Pass RAM Index, IndexedDB Stats & Sandbox
    // ========================================================================
    const simSandbox = {
        active: false, committing: false, bypassRead: false,
        workingJson: '[]', deferredCloudLocReg: null
    };

    const ramIndex = {
        pinsRaw: null, pinsList: [], pinsById: new Map(), hasBackboneSwitches: false,
        delPinsRaw: null, delPinsObj: {}, knownPinUpdatedMs: new Map(),
        pendingJsonImportMap: new Map(), topoEpoch: 1
    };

    const mqttSentPinMetaMap = new Map();

    function seedMqttPinBaseline(pinsArr) {
        if (!Array.isArray(pinsArr) || simSandbox.active) return;
        mqttSentPinMetaMap.clear();
        pinsArr.forEach(p => {
            if (!p?.id) return;
            mqttSentPinMetaMap.set(p.id, {
                sig: JSON.stringify(p),
                grp: normalizePeaGroupName(p.ownerGroup || 'กฟส.บึง') || 'กฟส.บึง'
            });
        });
    }

    function updateRamPinsFromList(list, jsonStr) {
        ramIndex.pinsRaw = jsonStr;
        ramIndex.pinsList = Array.isArray(list) ? list : [];
        ramIndex.topoEpoch++;
        ramIndex.pinsById.clear();
        ramIndex.hasBackboneSwitches = false;
        ramIndex.pinsList.forEach(p => {
            if (!p || !p.id) return;
            ramIndex.pinsById.set(p.id, p);
            const ms = new Date(p.updatedAt || 0).getTime() || 0;
            if (ms > (ramIndex.knownPinUpdatedMs.get(p.id) || 0)) ramIndex.knownPinUpdatedMs.set(p.id, ms);
            const t = p.scadaNode?.t;
            if (t === 'RC' || t === 'CB' || t === 'VB' || t === 'VS' || t === 'VSC' || t === 'S' || t === 'GEN') {
                ramIndex.hasBackboneSwitches = true;
            }
        });
    }

    function refreshRamPinsIndex(preParsedList = null) {
        const raw = (simSandbox.active && !simSandbox.bypassRead)
            ? simSandbox.workingJson
            : (rawStorageGet('elec_labeled_places_list') || '[]');
        if (raw === ramIndex.pinsRaw && !Array.isArray(preParsedList)) return;
        try {
            const arr = Array.isArray(preParsedList) ? preParsedList : JSON.parse(raw);
            updateRamPinsFromList(Array.isArray(arr) ? arr : [], raw);
        } catch (e) {
            updateRamPinsFromList([], raw);
        }
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
                return { ...log, scadaLines: log.scadaLines.map(l => { const c = { ...l }; delete c.w; return c; }) };
            });
        }
        return trimmed;
    }

        function pruneDeletedJobsMap(rawMap) {
        if (!rawMap || typeof rawMap !== 'object') return {};
        const now = Date.now();
        const entries = Object.entries(rawMap)
            .map(([jk, v]) => {
                const ts = typeof v === 'number' ? v : (/^\d+$/.test(String(v || '')) ? Number(v) : (v === true ? now : (new Date(v || 0).getTime() || 0)));
                return [jk, ts];
            })
            .filter(([jk, ts]) => Boolean(jk) && ts > 0 && (now - ts < MAX_REGISTRY_AGE_MS))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 300);
        return Object.fromEntries(entries);
    }

    function pruneTechLocationsForSheetQuota(locMapObj) {
        if (!locMapObj || typeof locMapObj !== 'object') return {};
        const now = Date.now();
        const out = {};
        Object.entries(locMapObj).forEach(([k, v]) => {
            if (!k || !v || typeof v !== 'object') return;
            if (isSystemLocRegistryKey(k, v)) { out[k] = v; return; }
            const seenMs = new Date(v.lastSeenAt || v.updatedAt || 0).getTime() || 0;
            if (seenMs > 0 && (now - seenMs > MAX_STALE_LOC_AGE_MS) && v.isOnline === false) return;
            out[k] = v;
        });
        if (JSON.stringify(out).length > 40000) {
            const techKeys = Object.keys(out).filter(k => !isSystemLocRegistryKey(k, out[k]))
                .sort((a, b) => (new Date(out[a]?.lastSeenAt || 0).getTime() || 0) - (new Date(out[b]?.lastSeenAt || 0).getTime() || 0));
            while (techKeys.length > 15 && JSON.stringify(out).length > 40000) {
                delete out[techKeys.shift()];
            }
        }
        return out;
    }

    function parseJobTimeMs(item) {
        if (!item) return 0;
        if (item.createdAtMs) return Number(item.createdAtMs) || 0;
        if (item.timestamp) { const t = new Date(item.timestamp).getTime(); if (!isNaN(t)) return t; }
        if (item.dateTimeSaved) {
            const p = String(item.dateTimeSaved).trim().split(/\s+/), dp = (p[0] || '').split('/');
            if (dp.length === 3) {
                let yr = parseInt(dp[2], 10) || 2569; if (yr > 2400) yr -= 543;
                const tp = (p[1] || '00:00:00').split(/[:.]/);
                return new Date(yr, (parseInt(dp[1], 10) || 1) - 1, parseInt(dp[0], 10) || 1, parseInt(tp[0], 10) || 0, parseInt(tp[1], 10) || 0, parseInt(tp[2], 10) || 0).getTime() || 0;
            }
        }
        return 0;
    }

    // คัดกรองหมุดตามสาขาอัตโนมัติ + ไม่เขียนทับสีหมุดอิสระ + ตัดลูปสะท้อนจาก main-app.js
    function sanitizePinsBeforeWrite(rawValStr, updateRamNow = false) {
        try {
            const parsed = JSON.parse(rawValStr);
            if (!Array.isArray(parsed)) return rawValStr;
            refreshRamDelPinsIndex();
            const delMap = { ...(ramIndex.delPinsObj || {}) };
            const isLogged = rawStorageGet('elec_app_logged_in') === 'true';
            const isAdmin = isLogged && (rawStorageGet('elec_app_current_role') || 'user') === 'admin';
            const activeMyGrp = (isLogged && !isAdmin) ? (normalizePeaGroupName(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง') : '';
            let delMapChanged = false;

            const byId = new Map();
            parsed.forEach(p => {
                if (!p || !p.id) return;
                p.ownerGroup = normalizePeaGroupName(p.ownerGroup || (p.ownerUser ? getUserGroupName(p.ownerUser) : '') || 'กฟส.บึง') || 'กฟส.บึง';
                if (activeMyGrp && p.ownerGroup !== activeMyGrp) return;

                const pMs = new Date(p.updatedAt || 0).getTime() || 0;
                if (!simSandbox.active && delMap[p.id]) {
                    const dMs = new Date(delMap[p.id]).getTime() || 0;
                    if (pMs > dMs) { delete delMap[p.id]; delMapChanged = true; }
                    else return;
                }
                if (ramIndex.pendingJsonImportMap.size > 0) {
                    const locK = `LOC:${String(p.name || '').trim().toLowerCase()}__${Number(p.lat || 0).toFixed(5)}__${Number(p.lon || 0).toFixed(5)}`;
                    const ov = ramIndex.pendingJsonImportMap.get('ID:' + p.id) || ramIndex.pendingJsonImportMap.get(locK);
                    if (ov) {
                        if (ov.scadaNode !== undefined) p.scadaNode = ov.scadaNode;
                        if (ov.scadaLines !== undefined) p.scadaLines = ov.scadaLines;
                        if (ov.isTTap !== undefined) p.isTTap = ov.isTTap;
                    }
                }
                if (!p.pinColor) {
                    p.pinColor = p.scadaNode?.col ? hexToClosestPinColorKey(p.scadaNode.col) : 'green';
                }
                const ex = byId.get(p.id);
                if (!ex || pMs >= (new Date(ex.updatedAt || 0).getTime() || 0)) byId.set(p.id, p);
            });

            if (delMapChanged && !simSandbox.active) {
                const delStr = JSON.stringify(delMap);
                rawStorageSet('elec_deleted_labeled_places_map', delStr);
                ramIndex.delPinsRaw = delStr;
                ramIndex.delPinsObj = delMap;
            }

            const list = Array.from(byId.values());
            const seenLocKeys = new Map();
            list.forEach(p => {
                const grp = p.ownerGroup || 'กฟส.บึง';
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

            if (typeof window.__scadaSanitizePinsHook === 'function') window.__scadaSanitizePinsHook(list);
            const finalStr = JSON.stringify(list);
            if (updateRamNow && !simSandbox.bypassRead) updateRamPinsFromList(list, finalStr);
            return finalStr;
        } catch (e) { return rawValStr; }
    }

    Storage.prototype.getItem = function (key) {
        if (this === localStorage) {
            if (simSandbox.active && !simSandbox.bypassRead && key === 'elec_labeled_places_list') return simSandbox.workingJson;
            if (isGroupViewFilterActive && (key === 'elecReportsComplete_all' || key === 'fault_reports_all')) {
                const raw = nativeGetItem.call(this, key);
                if ((nativeGetItem.call(this, 'elec_app_current_role') || 'user') === 'admin') return raw;
                try { return JSON.stringify(JSON.parse(raw || '[]').filter(canCurrentUserSeeJob)); } catch (e) { return raw; }
            }
        }
        return nativeGetItem.apply(this, arguments);
    };

    Storage.prototype.setItem = function (key, value) {
        if (this !== localStorage || typeof value !== 'string') return nativeSetItem.apply(this, arguments);

        if (simSandbox.active && !simSandbox.committing && key === 'elec_labeled_places_list') {
            if (inFlightCloudGetCount > 0) return;
            simSandbox.workingJson = sanitizePinsBeforeWrite(value, true);
            return;
        }

        const prevVal = LOCAL_WATCHED_KEYS.has(key) ? rawStorageGet(key) : null;

        if (!isInternalSanitizing) {
            isInternalSanitizing = true;
            try {
                if (key === 'elec_labeled_places_list') {
                    value = sanitizePinsBeforeWrite(value, true);
                } else if (key === 'elec_deleted_labeled_places_map') {
                    const prevDel = JSON.parse(rawStorageGet('elec_deleted_labeled_places_map') || '{}');
                    const nextDel = JSON.parse(value || '{}');
                    const now = Date.now();
                    Object.keys(nextDel).forEach(id => {
                        if (!prevDel[id]) {
                            const pinMs = ramIndex.knownPinUpdatedMs.get(id) || 0;
                            const delMs = new Date(nextDel[id] || 0).getTime() || 0;
                            if (pinMs > 0 && delMs <= pinMs) nextDel[id] = new Date(pinMs + 500).toISOString();
                        }
                    });
                    const entries = Object.entries(nextDel)
                        .filter(([id, iso]) => { if (!id) return false; const t = new Date(iso).getTime(); return isNaN(t) || (now - t <= MAX_REGISTRY_AGE_MS); })
                        .sort((a, b) => (new Date(b[1] || 0).getTime() || 0) - (new Date(a[1] || 0).getTime() || 0))
                        .slice(0, 2000);
                    const cleanDelObj = Object.fromEntries(entries);
                    value = JSON.stringify(cleanDelObj);
                    if (!simSandbox.active) {
                        const curPins = ramIndex.pinsRaw ? ramIndex.pinsList : JSON.parse(rawStorageGet('elec_labeled_places_list') || '[]');
                        const surviving = curPins.filter(p => p?.id && (!cleanDelObj[p.id] || (new Date(p.updatedAt || 0).getTime() || 0) > (new Date(cleanDelObj[p.id]).getTime() || 0)));
                        if (surviving.length !== curPins.length) {
                            const sStr = JSON.stringify(surviving);
                            rawStorageSet('elec_labeled_places_list', sStr);
                            updateRamPinsFromList(surviving, sStr);
                        }
                    }
                } else if (key === 'elec_deleted_equip_audit_logs') {
                    value = JSON.stringify(trimAuditLogsForSheetQuota(JSON.parse(value || '[]')));
                } else if (key === 'elec_cloud_group_backups_map') {
                    value = slimGroupBackupsJson(value);
                } else if (key === 'elec_deleted_jobs_registry') {
                    const mergedDelJobs = { ...JSON.parse(rawStorageGet('elec_deleted_jobs_registry') || '{}'), ...JSON.parse(value || '{}') };
                    value = JSON.stringify(pruneDeletedJobsMap(mergedDelJobs));
                } else if (key === 'elec_tech_locations_map') {
                    const curUser = (rawStorageGet('elec_app_current_user') || '').trim();
                    const role = rawStorageGet('elec_app_current_role') || 'user';
                    const locObj = pruneTechLocationsForSheetQuota(JSON.parse(value || '{}'));
                    if (curUser && locObj[curUser] && !isSystemLocRegistryKey(curUser, locObj[curUser])) {
                        if (isEmbeddedIframe && String(locObj[curUser].currentPage || '').includes('หน้าช่าง')) locObj[curUser].currentPage = '💻 หน้าหลัก (เปิดคู่หน้าช่าง)';
                        if (isEmbeddedIframe || role === 'viewer') { locObj[curUser].gpsDisabled = true; locObj[curUser].lat = null; locObj[curUser].lon = null; }
                    }
                    value = JSON.stringify(locObj);
                } else if (key === 'elecReportsComplete_all' || key === 'fault_reports_all') {
                    const isF = (key === 'fault_reports_all'), arr = JSON.parse(value || '[]');
                    const closedReg = JSON.parse(rawStorageGet('elec_closed_jobs_registry') || '{}');
                    let closedDirty = false;
                    arr.forEach(item => {
                        if (!item) return;
                        item.ownerGroup = getJobGroupName(item);
                        const jk = isF ? item.timestamp : item.dateTimeSaved;
                        if (item.reopenedAt) {
                            const rMs = new Date(item.reopenedAt).getTime() || 0;
                            const repMs = new Date(item.techReport?.updatedAt || 0).getTime() || 0;
                            if (item.techReport) { if (repMs > rMs) delete item.reopenedAt; else delete item.techReport; }
                            if (!item.techReport) {
                                if (item.formattedText && item.formattedText.includes('--- 🛠️ ผลตรวจสอบหน้างาน ---')) item.formattedText = item.formattedText.split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0];
                                if (jk && closedReg[jk] && rMs >= (new Date(closedReg[jk]?.updatedAt || 0).getTime() || 0)) { delete closedReg[jk]; closedDirty = true; }
                            }
                        }
                    });
                    if (closedDirty) rawStorageSet('elec_closed_jobs_registry', JSON.stringify(closedReg));
                    value = JSON.stringify(arr);
                }
            } catch (e) {} finally { isInternalSanitizing = false; }
        }

        rawStorageSet(key, value);
        if (key === 'elec_labeled_places_list') refreshRamPinsIndex();
        else if (key === 'elec_deleted_labeled_places_map') refreshRamDelPinsIndex();

        if (!isApplyingRemotePacket && LOCAL_WATCHED_KEYS.has(key) && prevVal !== value) {
            broadcastSameDevice(key);
            broadcastDeltaOverMqtt(key, value);
        }
    };

        Storage.prototype.removeItem = function (key) {
        if (this === localStorage && (key === 'elec_app_current_user' || key === 'elec_app_session_token')) {
            const u = (rawStorageGet('elec_app_current_user') || recentLogoutAuthCache.user || '').trim();
            const t = (rawStorageGet('elec_app_session_token') || recentLogoutAuthCache.token || '').trim();
            if (u && t) recentLogoutAuthCache = { user: u, token: t, ts: Date.now() };
        }
        const res = nativeRemoveItem.apply(this, arguments);
        if (key === 'elec_labeled_places_list') { ramIndex.pinsRaw = null; refreshRamPinsIndex(); }
        else if (key === 'elec_deleted_labeled_places_map') { ramIndex.delPinsRaw = null; refreshRamDelPinsIndex(); }
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
                    if (obj.name && lat != null && lon != null) ramIndex.pendingJsonImportMap.set(`LOC:${String(obj.name).trim().toLowerCase()}__${Number(lat).toFixed(5)}__${Number(lon).toFixed(5)}`, payload);
                });
                setTimeout(() => ramIndex.pendingJsonImportMap.clear(), 5000);
            } catch (err) {}
        };
        reader.readAsText(file, 'UTF-8');
    }, true);

    function getStorageUsageStats() {
        let physBytes = 0, idbBytes = 0;
        const idbStats = typeof window.PeaIdbStore?.getStats === 'function' ? window.PeaIdbStore.getStats() : null;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i) || '';
            const isOffloaded = Boolean(idbStats?.[k]?.mode && String(idbStats[k].mode).includes('Offloaded'));
            const v = rawStorageGet(k) || '';
            if (isOffloaded) {
                physBytes += (k.length + 22) * 2;
                idbBytes += v.length * 2;
            } else {
                physBytes += (k.length + v.length) * 2;
            }
        }
        return {
            usedMb: (physBytes / (1024 * 1024)).toFixed(2),
            idbMb: (idbBytes / (1024 * 1024)).toFixed(2),
            maxMb: '5.00',
            pct: Math.min(100, Math.round((physBytes / (5 * 1024 * 1024)) * 100))
        };
    }

    function cleanTemporaryCacheSafe() {
        invalidateSheetCaches();
        const closedReg = getClosedJobsRegistry();
        ['elecReportsComplete_all', 'fault_reports_all'].forEach(k => {
            const isF = (k === 'fault_reports_all'), arr = JSON.parse(rawStorageGet(k) || '[]');
            arr.forEach(it => { const id = isF ? it?.timestamp : it?.dateTimeSaved; if (it && !it.techReport && !it.reopenedAt && id && closedReg[id]) it.techReport = closedReg[id]; });
            localStorage.setItem(k, JSON.stringify(arr));
        });
        syncClosedRegistryObject(closedReg);
        showToast('🧹 ล้างแคชซ้ำซ้อนเรียบร้อย (ประวัติใบงานและหมุดอยู่ครบ 100%)');
    }
    // ===== จบพาทที่ 2 / 4 ของไฟล์ shared-core.js =====
        // ===== เริ่มพาทที่ 3 / 4 ของไฟล์ shared-core.js (วางต่อจากพาทที่ 2 / 4) =====
    // ========================================================================
    // 4. ทะเบียนงานที่ปิด/ลบแล้ว, พิกัดช่าง & ซิงค์แผนงาน PM แบบรักษา Priority
    // ========================================================================
    function isAutoGeneratedFakeClosure(rep) {
        if (!rep) return false;
        if (rep.realCause === 'ปิดงานโดยผู้ใช้งานทั่วไป' && rep.actionTaken === 'ดำเนินการเสร็จสิ้นจากระบบหลัก') return true;
        return rep.status === 'แก้ไขเสร็จสิ้น (ปิดงานแล้ว)' || rep.updatedAt === '1970-01-01T00:00:00.000Z';
    }

    function getReopenedTimestampsMap() {
        const map = new Map();
        try {
            ['elecReportsComplete_all', 'fault_reports_all'].forEach(sk => {
                const isF = (sk === 'fault_reports_all');
                JSON.parse(rawStorageGet(sk) || '[]').forEach(it => {
                    const jk = isF ? it?.timestamp : it?.dateTimeSaved;
                    if (!jk || !it?.reopenedAt) return;
                    const rMs = new Date(it.reopenedAt).getTime() || 0, repMs = new Date(it.techReport?.updatedAt || 0).getTime() || 0;
                    if (rMs > repMs) map.set(jk, rMs);
                });
            });
        } catch (e) {}
        return map;
    }

    function pruneClosedRegistryMap(rawMap) {
        if (!rawMap || typeof rawMap !== 'object') return {};
        const now = Date.now(), reopenedMap = getReopenedTimestampsMap();
        const entries = Object.entries(rawMap).filter(([jk, val]) => {
            if (!val || typeof val !== 'object' || isAutoGeneratedFakeClosure(val)) return false;
            const t = val.updatedAt ? new Date(val.updatedAt).getTime() : now;
            if (isNaN(t) || (now - t > MAX_REGISTRY_AGE_MS)) return false;
            const rMs = reopenedMap.get(jk) || 0;
            return !(rMs > 0 && rMs >= t);
        });
        entries.sort((a, b) => (new Date(b[1]?.updatedAt || 0).getTime() || 0) - (new Date(a[1]?.updatedAt || 0).getTime() || 0));
        return Object.fromEntries(entries.slice(0, 300));
    }

    function getClosedJobsRegistry() {
        try { return pruneClosedRegistryMap({ ...JSON.parse(rawStorageGet('elec_closed_jobs_registry') || '{}'), ...JSON.parse(rawStorageGet('elec_closed_reports_map') || '{}') }); }
        catch (e) { return {}; }
    }
    function syncClosedRegistryObject(mapObj) {
        if (!mapObj || typeof mapObj !== 'object') return;
        localStorage.setItem('elec_closed_jobs_registry', JSON.stringify(pruneClosedRegistryMap(mapObj)));
        nativeRemoveItem.call(localStorage, 'elec_closed_reports_map');
    }
    function saveClosedJobToRegistry(jobKey, reportObj) {
        if (!jobKey) return;
        const reg = getClosedJobsRegistry();
        reg[jobKey] = reportObj || { status: 'แก้ไขเสร็จสิ้น (จ่ายไฟคืนแล้ว)', realCause: '-', actionTaken: 'ปิดงานเรียบร้อย', finishTime: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) + ' น.', inspector: formatTechDisplayName(rawStorageGet('elec_app_current_user') || 'ผู้ใช้งาน'), updatedAt: new Date().toISOString() };
        syncClosedRegistryObject(reg);
    }

    function getDeletedJobsRegistry() {
        try { return pruneDeletedJobsMap(JSON.parse(rawStorageGet('elec_deleted_jobs_registry') || '{}')); } catch (e) { return {}; }
    }
    function recordDeletedJobToRegistry(jobKey) {
        if (!jobKey) return;
        unlockCloudWrite(20000);
        const reg = getDeletedJobsRegistry(); reg[jobKey] = Date.now();
        localStorage.setItem('elec_deleted_jobs_registry', JSON.stringify(reg));
    }
    function syncDeletedRegistryObject(mergedObj) {
        if (!mergedObj || typeof mergedObj !== 'object') return;
        localStorage.setItem('elec_deleted_jobs_registry', JSON.stringify(pruneDeletedJobsMap(mergedObj)));
    }

    function getTechLocationsMap() {
        try { return JSON.parse(rawStorageGet('elec_tech_locations_map') || '{}'); } catch (e) { return {}; }
    }

    function mergeTechLocationsMap(cloudLocs) {
        if (!cloudLocs || typeof cloudLocs !== 'object') return;
        const localMap = getTechLocationsMap();
        const curUser = (rawStorageGet('elec_app_current_user') || '').trim();
        const gpsDisabledLocal = rawStorageGet('elec_tech_gps_enabled') === 'false' || isEmbeddedIframe || isViewerRole();
        const nowMs = Date.now(), RECENT_PM_MS = 7 * 24 * 60 * 60 * 1000;

        Object.keys(cloudLocs).forEach(uKey => {
            const cItem = cloudLocs[uKey];
            if (!cItem || typeof cItem !== 'object') return;
            if (uKey.startsWith(PM_LOC_PREFIX)) {
                const lItem = localMap[uKey];
                const mergedPlans = { ...(lItem?.pmPlansMap || {}) };
                Object.entries(cItem.pmPlansMap || {}).forEach(([pid, pObj]) => {
                    if (!pObj?.id) return;
                    const exP = mergedPlans[pid];
                    const cUpd = new Date(pObj.updatedAt || 0).getTime() || 0, lUpd = exP ? (new Date(exP.updatedAt || 0).getTime() || 0) : -1;
                    if (!exP || cUpd > lUpd || (cUpd === lUpd && pObj.pmDeleted && !exP.pmDeleted)) mergedPlans[pid] = pObj;
                });
                const validEntries = Object.entries(mergedPlans).filter(([, p]) => p?.id && !(p.pmDeleted && (nowMs - (new Date(p.updatedAt || 0).getTime() || 0)) > MAX_REGISTRY_AGE_MS));
                const recentTrans = validEntries.filter(([, p]) => (p.pmDeleted || p.status === 'done') && (nowMs - (new Date(p.updatedAt || 0).getTime() || 0)) <= RECENT_PM_MS)
                    .sort((a, b) => (new Date(b[1]?.updatedAt || 0).getTime() || 0) - (new Date(a[1]?.updatedAt || 0).getTime() || 0)).slice(0, 15);
                const rSet = new Set(recentTrans.map(([id]) => id));
                const restEntries = validEntries.filter(([id]) => !rSet.has(id)).sort((a, b) => {
                    const pa = a[1], pb = b[1], rk = x => (!x.pmDeleted && x.status !== 'done') ? 0 : (x.pmDeleted ? 1 : 2);
                    return (rk(pa) - rk(pb)) || String(pa.date || '').localeCompare(String(pb.date || '')) || ((new Date(pb.updatedAt || 0).getTime() || 0) - (new Date(pa.updatedAt || 0).getTime() || 0));
                });
                const cT = new Date(cItem.updatedAt || cItem.lastSeenAt || 0).getTime() || 0, lT = new Date(lItem?.updatedAt || lItem?.lastSeenAt || 0).getTime() || 0;
                const bestIso = (cT >= lT ? (cItem.updatedAt || cItem.lastSeenAt) : (lItem?.updatedAt || lItem?.lastSeenAt)) || new Date().toISOString();
                localMap[uKey] = { ...(lItem || {}), ...cItem, pmPlansMap: Object.fromEntries([...recentTrans, ...restEntries].slice(0, 60)), lastSeenAt: bestIso, updatedAt: bestIso };
                return;
            }
                        if (gpsDisabledLocal && curUser && !isSystemLocRegistryKey(uKey, cItem) && (isSameTechPerson(uKey, curUser) || isSameTechPerson(cItem.username, curUser))) return;
            const lItem = localMap[uKey];
            const cTime = Math.max(new Date(cItem.lastSeenAt || 0).getTime() || 0, new Date(cItem.updatedAt || 0).getTime() || 0);
            const lTime = Math.max(new Date(lItem?.lastSeenAt || 0).getTime() || 0, new Date(lItem?.updatedAt || 0).getTime() || 0);
            const getEqNavMs = (nav) => !nav ? 0 : Math.max(Number(nav.departTimestamp || 0) || 0, new Date(nav.updatedAt || 0).getTime() || 0, Number(nav.cancelledAtMs || 0) || 0);
            const exNavT = getEqNavMs(lItem?.activeEquipNav),
                inNavT = getEqNavMs(cItem?.activeEquipNav);
            if (!lItem || cTime >= lTime) {
                localMap[uKey] = (exNavT > inNavT && lItem?.activeEquipNav) ? { ...cItem, activeEquipNav: lItem.activeEquipNav } : cItem;
            } else if (inNavT > exNavT && cItem?.activeEquipNav) {
                localMap[uKey] = { ...lItem, activeEquipNav: cItem.activeEquipNav, updatedAt: cItem.updatedAt || lItem.updatedAt };
            }
            });
            localStorage.setItem('elec_tech_locations_map', JSON.stringify(localMap));
            }
    function cleanReopenedAndCancelledJobsInStorage() {
        try {
            const closedReg = getClosedJobsRegistry(), cancelJobMap = JSON.parse(rawStorageGet('elec_cancelled_job_nav_map') || '{}');
            let regChanged = false;
            ['elecReportsComplete_all', 'fault_reports_all'].forEach(sk => {
                const isF = (sk === 'fault_reports_all'), list = JSON.parse(rawStorageGet(sk) || '[]');
                let listChanged = false;
                list.forEach(item => {
                    if (!item) return;
                    const k = isF ? item.timestamp : item.dateTimeSaved, cancelIso = (k && cancelJobMap[k]) ? cancelJobMap[k] : (item.navCancelledAt || '');
                    if (cancelIso && item.techNav && (new Date(cancelIso).getTime() || 0) >= (new Date(item.techNav.updatedAt || 0).getTime() || 0)) { delete item.techNav; item.navCancelledAt = cancelIso; listChanged = true; }
                    if (!item.reopenedAt) return;
                    const rMs = new Date(item.reopenedAt).getTime() || 0;
                    if (item.techReport && rMs >= (new Date(item.techReport.updatedAt || 0).getTime() || 0)) { delete item.techReport; listChanged = true; }
                    if (!item.techReport) {
                        if (k && closedReg[k] && rMs >= (new Date(closedReg[k]?.updatedAt || 0).getTime() || 0)) { delete closedReg[k]; regChanged = true; }
                        if (item.formattedText && item.formattedText.includes('--- 🛠️ ผลตรวจสอบหน้างาน ---')) { item.formattedText = item.formattedText.split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0]; listChanged = true; }
                    }
                });
                if (listChanged) localStorage.setItem(sk, JSON.stringify(list));
            });
            if (regChanged) syncClosedRegistryObject(closedReg);
        } catch (e) {}
    }

    // ========================================================================
    // 5. ท่อซิงค์เรียลไทม์ (MQTT Pin-Level Delta ปลอดลูปสะท้อนกลับ) & ปกป้องผัง Cloud
    // ========================================================================
    const WS_BROKERS = [
        'wss://broker.emqx.io:8084/mqtt',
        'wss://broker.hivemq.com:8884/mqtt',
        'wss://mqtt.eclipseprojects.io:443/mqtt'
    ];
    let mqttClient = null;
    let lastMqttAuthSig = '';
    const activeSubscribedTopics = new Set();
    let brokerFallbackIdx = 0;
    let consecutiveMqttErrors = 0;
    let mqttFailoverTimer = null;
    const debounceMqttTimers = {};
    const realtimeSubscribers = new Set();
    let uiRefreshRaf = null;
    const pendingRefreshKeys = new Set();

    const syncedJobHashes = new Map();
    let lastCloudTechLocSnapshot = null;
    let hasLocalEquipMutation = false;
    let lastBackupsHash = '';
    let lastPinsHash = '';
    let lastDelPinsHash = '';
    let lastAuditLogsHash = '';
    let lastSyncedLocalPinsStr = null;
    let lastSyncedLocalDelPinsStr = null;
    let lastSyncedLocalAuditStr = null;
    let lastSyncedLocalBackupsStr = null;
    let hasFirstBaseline = false;
    let pendingPostTask = null;
    let pendingPostWaiters = [];
    let isPostWorkerRunning = false;

    function snapshotCleanLocalEquipStrings() {
        if (rawStorageGet('elec_tech_has_pending_push') === 'true' || simSandbox.active) return;
        lastSyncedLocalPinsStr = rawStorageGet('elec_labeled_places_list') || '[]';
        lastSyncedLocalDelPinsStr = rawStorageGet('elec_deleted_labeled_places_map') || '{}';
        lastSyncedLocalAuditStr = rawStorageGet('elec_deleted_equip_audit_logs') || '[]';
        lastSyncedLocalBackupsStr = rawStorageGet('elec_cloud_group_backups_map') || '{}';
    }

    function hashString(str) {
        let h = 0; const s = String(str || 'default');
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
            h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (h2 >>> 0).toString(36) + '_' + (h1 >>> 0).toString(36);
    }

    function xorCipherTransform(text, keyStr) {
        let out = '';
        for (let i = 0; i < text.length; i++) out += String.fromCharCode(text.charCodeAt(i) ^ keyStr.charCodeAt(i % keyStr.length) ^ ((i * 31) & 0xff));
        return out;
    }

    function encryptMqttPayload(plainStr, ts) {
        try { return 'ENC1_' + btoa(xorCipherTransform(encodeURIComponent(plainStr), getOrgSecretKey() + '#' + (ts % 9973))); }
        catch (e) { return plainStr; }
    }

    function decryptMqttPayload(cipherStr, ts) {
        try {
            if (!cipherStr || !cipherStr.startsWith('ENC1_')) return null;
            return decodeURIComponent(xorCipherTransform(atob(cipherStr.slice(5)), getOrgSecretKey() + '#' + (ts % 9973)));
        } catch (e) { return null; }
    }

    function ensureMySessionTokenSyncedInUsers(usersArr) {
        if (!Array.isArray(usersArr) || rawStorageGet('elec_app_logged_in') !== 'true') return usersArr;
        const curUser = (rawStorageGet('elec_app_current_user') || '').trim(); if (!curUser) return usersArr;
        let localToken = rawStorageGet('elec_app_session_token') || '';
        if (!localToken) { localToken = 'sess_' + Date.now(); rawStorageSet('elec_app_session_token', localToken); }
        usersArr.forEach(u => {
            if (!u?.username || !isUsernameMatchingAccount(curUser, u.username)) return;
            u.sessionToken = localToken;
            if (typeof u.role === 'string' && u.role.includes('::')) { const parts = u.role.split('::'); parts[1] = localToken; u.role = parts.join('::'); }
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
            if (keys.includes('elec_labeled_places_list')) { refreshRamPinsIndex(); seedMqttPinBaseline(ramIndex.pinsList); }
            if (keys.includes('elec_deleted_labeled_places_map')) refreshRamDelPinsIndex();
            if (keys.includes('elec_user_accounts')) cachedAccountsStr = '';
            realtimeSubscribers.forEach(fn => { try { fn(keys); } catch (e) {} });
            keys.forEach(k => {
                try { window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: rawStorageGet(k) })); } catch (e) {}
            });
        });
    }

    function isPinIncomingStrictlyNewer(inPin, exPin) {
        if (!exPin) return true;
        const inMs = new Date(inPin.updatedAt || 0).getTime() || 0;
        const exMs = new Date(exPin.updatedAt || 0).getTime() || 0;
        if (inMs > exMs) return true;
        if (inMs === exMs && JSON.stringify(inPin) !== JSON.stringify(exPin)) return true;
        return false;
    }

    function applyIncomingPinDeltaPacket(deltaJsonStr) {
        if (!deltaJsonStr || simSandbox.active) return;
        isApplyingRemotePacket = true;
        try {
            const d = JSON.parse(deltaJsonStr);
            const isAdmin = (rawStorageGet('elec_app_current_role') || 'user') === 'admin';
            const myGrp = normalizePeaGroupName(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
            refreshRamDelPinsIndex();
            const curDel = { ...(ramIndex.delPinsObj || {}) };
            let delChanged = false;

            if (d?.deletedMap && typeof d.deletedMap === 'object') {
                Object.entries(d.deletedMap).forEach(([pid, iso]) => {
                    if (!pid || !iso) return;
                    if (!curDel[pid] || String(iso) > String(curDel[pid])) { curDel[pid] = iso; delChanged = true; }
                });
            }
            if (delChanged) localStorage.setItem('elec_deleted_labeled_places_map', JSON.stringify(curDel));

            const curPins = ramIndex.pinsRaw ? ramIndex.pinsList : JSON.parse(rawStorageGet('elec_labeled_places_list') || '[]');
            const pinMap = new Map();
            curPins.forEach(p => {
                if (!p?.id) return;
                const pMs = new Date(p.updatedAt || 0).getTime() || 0;
                if (curDel[p.id] && pMs <= (new Date(curDel[p.id]).getTime() || 0)) return;
                pinMap.set(p.id, p);
            });

            let pinsChanged = pinMap.size !== curPins.length;
            if (Array.isArray(d?.upserted)) {
                d.upserted.forEach(p => {
                    if (!p?.id) return;
                    const pGrp = normalizePeaGroupName(p.ownerGroup || 'กฟส.บึง') || 'กฟส.บึง';
                    if (!isAdmin && pGrp !== myGrp) return;
                    const pMs = new Date(p.updatedAt || 0).getTime() || 0;
                    if (curDel[p.id] && pMs <= (new Date(curDel[p.id]).getTime() || 0)) return;
                    if (isPinIncomingStrictlyNewer(p, pinMap.get(p.id))) {
                        pinMap.set(p.id, p);
                        pinsChanged = true;
                    }
                });
            }

            if (pinsChanged) {
                localStorage.setItem('elec_labeled_places_list', JSON.stringify(Array.from(pinMap.values())));
                seedMqttPinBaseline(ramIndex.pinsList);
                snapshotCleanLocalEquipStrings();
                invalidateSheetCaches();
                scheduleRealtimeRefresh('elec_labeled_places_list');
            } else if (delChanged) {
                snapshotCleanLocalEquipStrings();
                invalidateSheetCaches();
                scheduleRealtimeRefresh('elec_deleted_labeled_places_map');
            }
        } catch (e) {} finally { isApplyingRemotePacket = false; }
    }

    function applyIncomingLivePacket(key, incomingValStr) {
        if (!incomingValStr) return;
        if (simSandbox.active && key === 'elec_labeled_places_list') return;
        isApplyingRemotePacket = true;
        try {
            const curStr = rawStorageGet(key);
            if (curStr === incomingValStr) return;
            const isAdmin = (rawStorageGet('elec_app_current_role') || 'user') === 'admin';
            const myGrp = normalizePeaGroupName(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';

            if (key === 'elecReportsComplete_all' || key === 'fault_reports_all') {
                const isFault = (key === 'fault_reports_all'), kField = isFault ? 'timestamp' : 'dateTimeSaved';
                const delReg = getDeletedJobsRegistry(), closedReg = getClosedJobsRegistry();
                const cancelJobMap = JSON.parse(rawStorageGet('elec_cancelled_job_nav_map') || '{}');
                let closedChanged = false;
                const map = new Map();

                JSON.parse(curStr || '[]').forEach(it => { if (it?.[kField] && !delReg[it[kField]] && canCurrentUserSeeJob(it)) map.set(it[kField], it); });
                JSON.parse(incomingValStr || '[]').forEach(inItem => {
                    if (!inItem?.[kField] || delReg[inItem[kField]]) return;
                    if (inItem.techReport && isAutoGeneratedFakeClosure(inItem.techReport)) delete inItem.techReport;
                    inItem.ownerGroup = getJobGroupName(inItem);
                    if (!canCurrentUserSeeJob(inItem)) return;
                    const id = inItem[kField], ex = map.get(id);
                    if (!ex) { map.set(id, inItem); return; }

                    const bestRep = (inItem.techReport?.updatedAt || '') >= (ex.techReport?.updatedAt || '') ? (inItem.techReport || ex.techReport) : ex.techReport;
                    const latestReopen = (inItem.reopenedAt || '') >= (ex.reopenedAt || '') ? inItem.reopenedAt : ex.reopenedAt;
                    const validRep = (latestReopen && (!bestRep?.updatedAt || latestReopen > bestRep.updatedAt)) ? undefined : bestRep;
                    if (!validRep && latestReopen && closedReg[id] && latestReopen >= (closedReg[id]?.updatedAt || '')) { delete closedReg[id]; closedChanged = true; }

                    const cancelIso = cancelJobMap[id] || ((inItem.navCancelledAt || '') >= (ex.navCancelledAt || '') ? inItem.navCancelledAt : ex.navCancelledAt) || '';
                    let bestNav = (inItem.techNav?.updatedAt || '') >= (ex.techNav?.updatedAt || '') ? (inItem.techNav || ex.techNav) : ex.techNav;
                    if ((validRep && String(validRep.status || '').includes('เสร็จสิ้น')) || (cancelIso && (!bestNav?.updatedAt || cancelIso >= bestNav.updatedAt))) bestNav = undefined;

                    const baseCore = (ex.editedAt || '') > (inItem.editedAt || '') ? { ...inItem, ...ex } : { ...ex, ...inItem };
                    let fmtText = baseCore.formattedText || '';
                    if (!validRep && fmtText.includes('--- 🛠️ ผลตรวจสอบหน้างาน ---')) fmtText = fmtText.split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0];

                    const merged = { ...baseCore, formattedText: fmtText, ownerGroup: getJobGroupName(baseCore), techReport: validRep, reopenedAt: latestReopen || undefined, navCancelledAt: cancelIso || undefined };
                    if (!validRep) delete merged.techReport;
                    if (bestNav) merged.techNav = bestNav; else delete merged.techNav;
                    map.set(id, merged);
                });
                const sorted = Array.from(map.values()).sort((a, b) => parseJobTimeMs(b) - parseJobTimeMs(a));
                localStorage.setItem(key, JSON.stringify(sorted.slice(0, 300)));
                if (closedChanged) { syncClosedRegistryObject(closedReg); scheduleRealtimeRefresh('elec_closed_jobs_registry'); }
            } else if (key === 'elec_deleted_labeled_places_map') {
                localStorage.setItem(key, JSON.stringify({ ...JSON.parse(curStr || '{}'), ...JSON.parse(incomingValStr || '{}') }));
                snapshotCleanLocalEquipStrings();
                scheduleRealtimeRefresh('elec_labeled_places_list');
            } else if (key === 'elec_labeled_places_list') {
                const delEquip = JSON.parse(rawStorageGet('elec_deleted_labeled_places_map') || '{}');
                const curArr = JSON.parse(curStr || '[]');
                const pinMap = new Map();
                curArr.forEach(p => {
                    if (!p?.id) return;
                    const pMs = new Date(p.updatedAt || 0).getTime() || 0;
                    if (delEquip[p.id] && pMs <= (new Date(delEquip[p.id]).getTime() || 0)) return;
                    pinMap.set(p.id, p);
                });
                let changed = pinMap.size !== curArr.length;
                JSON.parse(incomingValStr || '[]').forEach(p => {
                    if (!p?.id) return;
                    const pGrp = normalizePeaGroupName(p.ownerGroup || 'กฟส.บึง') || 'กฟส.บึง';
                    if (!isAdmin && pGrp !== myGrp) return;
                    const pMs = new Date(p.updatedAt || 0).getTime() || 0;
                    if (delEquip[p.id] && pMs <= (new Date(delEquip[p.id]).getTime() || 0)) return;
                    if (isPinIncomingStrictlyNewer(p, pinMap.get(p.id))) { pinMap.set(p.id, p); changed = true; }
                });
                if (!changed) return;
                localStorage.setItem(key, JSON.stringify(Array.from(pinMap.values())));
                seedMqttPinBaseline(ramIndex.pinsList);
                snapshotCleanLocalEquipStrings();
            } else if (key === 'elec_deleted_equip_audit_logs') {
                const logMap = new Map();
                [...JSON.parse(curStr || '[]'), ...JSON.parse(incomingValStr || '[]')].forEach(l => {
                    if (l?.logId && (isAdmin || normalizePeaGroupName(l.ownerGroup || 'กฟส.บึง') === myGrp)) logMap.set(l.logId, l);
                });
                localStorage.setItem(key, JSON.stringify(Array.from(logMap.values())));
                snapshotCleanLocalEquipStrings();
            } else if (key === 'elec_tech_locations_map') {
                mergeTechLocationsMap(JSON.parse(incomingValStr || '{}'));
            } else if (key === 'elec_user_accounts') {
                cachedAccountsStr = '';
                localStorage.setItem(key, JSON.stringify(ensureMySessionTokenSyncedInUsers(JSON.parse(incomingValStr || '[]'))));
            } else if (key === 'elec_closed_jobs_registry') {
                syncClosedRegistryObject({ ...JSON.parse(curStr || '{}'), ...JSON.parse(incomingValStr || '{}') });
            } else if (key === 'elec_deleted_jobs_registry' || key === 'elec_active_equip_nav_map_v2' || key.includes('cancelled')) {
                localStorage.setItem(key, JSON.stringify({ ...JSON.parse(curStr || '{}'), ...JSON.parse(incomingValStr || '{}') }));
            } else {
                localStorage.setItem(key, incomingValStr);
            }

            if (rawStorageGet(key) !== curStr) {
                invalidateSheetCaches();
                scheduleRealtimeRefresh(key);
            }
        } catch (e) {} finally { isApplyingRemotePacket = false; }
    }
    // ===== จบพาทที่ 3 / 4 ของไฟล์ shared-core.js =====
    // ===== เริ่มพาทที่ 4 / 5 ของไฟล์ shared-core.js (วางต่อจากพาทที่ 3) =====
    // ========================================================================
    // 6. Write Gate, Sandbox, Same-Device Bus & MQTT Pin-Delta Engine
    // ========================================================================
    let localBroadcastCh = null;
    try { if ('BroadcastChannel' in window) localBroadcastCh = new BroadcastChannel(CHANNEL_NAME); } catch (e) {}

    function unlockCloudWrite(durationMs = 20000) {
        allowWriteUntilMs = Math.max(allowWriteUntilMs, Date.now() + (Number(durationMs) || 20000));
    }

    function invalidateSheetCaches() {
        sheetMemoryCacheMap.clear();
        try { nativeRemoveItem.call(localStorage, SHEET_CACHE_STORAGE_KEY); } catch (e) {}
    }

    function forceCloudRead() {
        forceManualGet = true;
        invalidateSheetCaches();
    }

    function onRealtimeChange(fn) {
        if (typeof fn === 'function') realtimeSubscribers.add(fn);
        return () => realtimeSubscribers.delete(fn);
    }

    function notifyStorageUpdated(keysArr) {
        (Array.isArray(keysArr) ? keysArr : [keysArr]).forEach(k => {
            if (k) scheduleRealtimeRefresh(k);
        });
    }

    function createTrailingAsyncQueue(asyncFn) {
        let running = false, queuedArgs = null, waiters = [];
        const drain = async () => {
            if (running || !queuedArgs) return;
            running = true;
            const args = queuedArgs, batch = waiters;
            queuedArgs = null; waiters = [];
            try {
                const res = await asyncFn.apply(null, args);
                batch.forEach(w => w.resolve(res));
            } catch (err) {
                batch.forEach(w => w.reject(err));
            } finally {
                running = false;
                if (queuedArgs) drain();
            }
        };
        return function (...args) {
            return new Promise((resolve, reject) => {
                queuedArgs = args;
                waiters.push({ resolve, reject });
                drain();
            });
        };
    }

    function enterSimSandbox(workingPins) {
        simSandbox.active = true;
        simSandbox.committing = false;
        simSandbox.deferredCloudLocReg = null;
        simSandbox.workingJson = JSON.stringify(Array.isArray(workingPins) ? workingPins : []);
        refreshRamPinsIndex(workingPins);
    }

    function exitSimSandbox(commitPinsOrNull = null) {
        const deferred = simSandbox.deferredCloudLocReg;
        simSandbox.deferredCloudLocReg = null;
        if (Array.isArray(commitPinsOrNull)) {
            simSandbox.committing = true;
            simSandbox.active = false;
            localStorage.setItem('elec_labeled_places_list', JSON.stringify(commitPinsOrNull));
            simSandbox.committing = false;
        } else {
            simSandbox.active = false;
            simSandbox.committing = false;
            ramIndex.pinsRaw = null;
            refreshRamPinsIndex();
            if (deferred && typeof window.__mergeCloudEquipRegistry === 'function') {
                window.__mergeCloudEquipRegistry(deferred);
            }
        }
    }

    function broadcastSameDevice(key) {
        const msg = { type: 'PEA_SAME_DEVICE_KV', sender: MY_PEER_ID, key, ts: Date.now() };
        try { localBroadcastCh?.postMessage(msg); } catch (e) {}
        try {
            if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
            document.getElementById('leftBrowserIframe')?.contentWindow?.postMessage(msg, '*');
        } catch (e) {}
    }

    function handleSameDeviceMsg(msg) {
        if (!msg || msg.type !== 'PEA_SAME_DEVICE_KV' || msg.sender === MY_PEER_ID || !msg.key) return;
        scheduleRealtimeRefresh(msg.key);
    }
    if (localBroadcastCh) localBroadcastCh.onmessage = (e) => handleSameDeviceMsg(e.data);
    window.addEventListener('message', (e) => handleSameDeviceMsg(e.data));

    function getMqttTopicPair() {
        const orgHash = hashString(getOrgSecretKey());
        const grp = normalizePeaGroupName(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
        return {
            globalTopic: `pea_sg_v6/${orgHash}/ALL`,
            groupTopic: `pea_sg_v6/${orgHash}/G_${hashString(grp)}`
        };
    }

    function connectMqttLiveBus(forceResubscribe = false) {
        if (typeof mqtt === 'undefined' || typeof mqtt.connect !== 'function') return;
        const topics = getMqttTopicPair();
        const authSig = `${brokerFallbackIdx}::${topics.globalTopic}::${topics.groupTopic}`;
        if (mqttClient && lastMqttAuthSig === authSig && !forceResubscribe) return;
        lastMqttAuthSig = authSig;

        if (mqttClient) {
            try { activeSubscribedTopics.forEach(t => mqttClient.unsubscribe(t)); mqttClient.end(true); } catch (e) {}
            mqttClient = null;
            activeSubscribedTopics.clear();
        }

        const brokerUrl = WS_BROKERS[brokerFallbackIdx % WS_BROKERS.length];
        try {
            mqttClient = mqtt.connect(brokerUrl, {
                clientId: `${MY_PEER_ID}_${Math.random().toString(36).slice(2, 6)}`,
                clean: true, connectTimeout: 6000, reconnectPeriod: 4000
            });
            mqttClient.on('connect', () => {
                consecutiveMqttErrors = 0;
                [topics.globalTopic, topics.groupTopic].forEach(tp => {
                    mqttClient.subscribe(tp, { qos: 0 }, (err) => { if (!err) activeSubscribedTopics.add(tp); });
                });
            });
            mqttClient.on('message', (_topic, payloadBuf) => {
                try {
                    const pkt = JSON.parse(payloadBuf.toString());
                    if (!pkt || pkt.p === MY_PEER_ID || !pkt.d || !pkt.t) return;
                    if (computePacketSignature(pkt.d, pkt.t, getOrgSecretKey()) !== pkt.s) return;
                    const plain = decryptMqttPayload(pkt.d, pkt.t);
                    if (plain === null) return;
                    if (pkt.k === '__PIN_DELTA__') applyIncomingPinDeltaPacket(plain);
                    else if (LOCAL_WATCHED_KEYS.has(pkt.k)) applyIncomingLivePacket(pkt.k, plain);
                } catch (e) {}
            });
            mqttClient.on('error', () => {
                consecutiveMqttErrors++;
                if (consecutiveMqttErrors >= 3 && !mqttFailoverTimer) {
                    mqttFailoverTimer = setTimeout(() => {
                        mqttFailoverTimer = null;
                        brokerFallbackIdx = (brokerFallbackIdx + 1) % WS_BROKERS.length;
                        connectMqttLiveBus(true);
                    }, 2500);
                }
            });
        } catch (e) {}
    }

    function broadcastDeltaOverMqtt(key, value) {
        if (key === 'elec_labeled_places_list' || key === 'elec_deleted_labeled_places_map' || key === 'elec_deleted_equip_audit_logs') {
            hasLocalEquipMutation = true;
            unlockCloudWrite(25000);
        }
        if (!SYNC_KEYS.has(key) || simSandbox.active || isViewerRole()) return;
        clearTimeout(debounceMqttTimers[key]);
        debounceMqttTimers[key] = setTimeout(() => {
            if (!mqttClient || !mqttClient.connected || simSandbox.active) return;
            const ts = Date.now(), topics = getMqttTopicPair();
            const targetTopic = key === 'elec_user_accounts' ? topics.globalTopic : topics.groupTopic;

            if (key === 'elec_labeled_places_list' || key === 'elec_deleted_labeled_places_map') {
                refreshRamPinsIndex(); refreshRamDelPinsIndex();
                const upserted = [], deletedMap = {};
                ramIndex.pinsList.forEach(p => {
                    if (!p?.id) return;
                    const sig = JSON.stringify(p);
                    if (mqttSentPinMetaMap.get(p.id)?.sig !== sig) {
                        upserted.push(p);
                        mqttSentPinMetaMap.set(p.id, { sig, grp: normalizePeaGroupName(p.ownerGroup || 'กฟส.บึง') || 'กฟส.บึง' });
                    }
                });
                Object.entries(ramIndex.delPinsObj || {}).forEach(([pid, iso]) => {
                    if (mqttSentPinMetaMap.has(pid) || key === 'elec_deleted_labeled_places_map') {
                        deletedMap[pid] = iso;
                        mqttSentPinMetaMap.delete(pid);
                    }
                });
                if (!upserted.length && !Object.keys(deletedMap).length) return;
                const deltaStr = JSON.stringify({ upserted, deletedMap });
                if (deltaStr.length > 130000) return;
                const enc = encryptMqttPayload(deltaStr, ts);
                mqttClient.publish(targetTopic, JSON.stringify({ p: MY_PEER_ID, t: ts, k: '__PIN_DELTA__', d: enc, s: computePacketSignature(enc, ts, getOrgSecretKey()) }));
                return;
            }
            const curVal = value ?? rawStorageGet(key) ?? '';
            if (!curVal || curVal.length > 130000) return;
            const enc = encryptMqttPayload(curVal, ts);
            mqttClient.publish(targetTopic, JSON.stringify({ p: MY_PEER_ID, t: ts, k: key, d: enc, s: computePacketSignature(enc, ts, getOrgSecretKey()) }));
        }, 180);
    }

    // ========================================================================
    // 7. Smart Fetch Interceptor — ตัวสร้าง patchDelta และคิวส่งข้อมูลขึ้นชีต
    // ========================================================================
    let activeSyncScopeSig = '';
    const syncedDeletedJobKeys = new Map();

    function canonicalizeForJobHash(val) {
        if (val === null || typeof val !== 'object') return val;
        if (Array.isArray(val)) return val.map(canonicalizeForJobHash);
        const sorted = {};
        Object.keys(val).sort().forEach(k => {
            if (k === 'pendingInitialUpload' || k === 'restoredAtMs' || k === 'needsMainSync' || k === 'recommendedTech') return;
            const v = val[k];
            if (v === undefined || v === '') return;
            sorted[k] = canonicalizeForJobHash(v);
        });
        return sorted;
    }

    function computeCanonicalJobHash(job) {
        if (!job || typeof job !== 'object') return 0;
        const norm = { ...job, ownerGroup: normalizePeaGroupName(getJobGroupName(job) || 'กฟส.บึง') || 'กฟส.บึง' };
        if (!norm.jobType) norm.jobType = (norm.circuit || norm.system) && !norm.jobNo ? 'fault' : 'outage';
        return hashString(JSON.stringify(canonicalizeForJobHash(norm)));
    }

    function ensureSyncScopeFresh() {
        const logged = rawStorageGet('elec_app_logged_in') === 'true';
        const sig = logged ? `${rawStorageGet('elec_app_current_user') || ''}::${rawStorageGet('elec_app_current_role') || ''}::${getCurrentUserGroup()}` : '__LOGGED_OUT__';
        if (sig === activeSyncScopeSig) return;
        activeSyncScopeSig = sig;
        syncedJobHashes.clear();
        syncedDeletedJobKeys.clear();
        lastCloudTechLocSnapshot = null;
        hasFirstBaseline = false;
        lastPinsHash = ''; lastDelPinsHash = ''; lastAuditLogsHash = ''; lastBackupsHash = '';
        lastSyncedLocalPinsStr = null; lastSyncedLocalDelPinsStr = null; lastSyncedLocalAuditStr = null; lastSyncedLocalBackupsStr = null;
    }

        let recentLogoutAuthCache = { user: '', token: '', ts: 0 };

    function getActiveAuthCredentialsForFetch() {
        const curUser = (rawStorageGet('elec_app_current_user') || '').trim();
        const curTok = (rawStorageGet('elec_app_session_token') || '').trim();
        if (curUser && curTok) {
            recentLogoutAuthCache = { user: curUser, token: curTok, ts: Date.now() };
            return { user: curUser, token: curTok };
        }
        if (recentLogoutAuthCache.user && recentLogoutAuthCache.token && (Date.now() - recentLogoutAuthCache.ts < 5000)) {
            return { user: recentLogoutAuthCache.user, token: recentLogoutAuthCache.token };
        }
        return { user: '', token: '' };
    }

    function handleServerUnauthorizedIfNeeded(parsedJson) {
        if (!parsedJson || parsedJson.unauthorized !== true) return;
        if (rawStorageGet('elec_app_logged_in') !== 'true') return;
        ['elec_app_logged_in', 'elec_app_session_token'].forEach(k => nativeRemoveItem.call(localStorage, k));
        if (typeof window.checkLoginStatus === 'function') window.checkLoginStatus();
        if (typeof window.checkTechAuth === 'function') window.checkTechAuth();
        showToast('🔒 เซสชันหมดอายุหรือรหัสผ่านมีการเปลี่ยนแปลง กรุณาเข้าสู่ระบบใหม่');
    }

    function buildScopedSheetUrl(rawUrl) {
        ensureSyncScopeFresh();
        const u = String(rawUrl || '');
        const role = (rawStorageGet('elec_app_current_role') || 'user').trim();
        const grp = getCurrentUserGroup();
        const auth = getActiveAuthCredentialsForFetch();
        const sep = u.includes('?') ? '&' : '?';
        const extras = [];
        if (!/[?&]group=/.test(u)) extras.push(`group=${encodeURIComponent(grp)}`);
        if (!/[?&]role=/.test(u)) extras.push(`role=${encodeURIComponent(role)}`);
        if (auth.user && !/[?&]authUser=/.test(u)) extras.push(`authUser=${encodeURIComponent(auth.user)}`);
        if (auth.token && !/[?&]authToken=/.test(u)) extras.push(`authToken=${encodeURIComponent(auth.token)}`);
        return extras.length ? `${u}${sep}${extras.join('&')}` : u;
    }

    function buildPatchDeltaFromSaveJobs(bodyObj) {
        ensureSyncScopeFresh();
        const role = (rawStorageGet('elec_app_current_role') || 'user').trim();
        const rawGrp = bodyObj.group !== undefined ? bodyObj.group : getCurrentUserGroup();
        const grp = normalizePeaGroupName(rawGrp) || (role === 'admin' ? '' : 'กฟส.บึง');
        const rawJobs = Array.isArray(bodyObj.jobs) ? bodyObj.jobs : [];
        const locIn = rawJobs.find(j => j && j.jobType === 'tech_loc') || {};
        const upsertedJobs = [], nextJobHashes = new Map(), restoredMap = new Map();

        ['elecReportsComplete_all', 'fault_reports_all'].forEach(sk => {
            const isF = (sk === 'fault_reports_all');
            try {
                JSON.parse(rawStorageGet(sk) || '[]').forEach(it => {
                    const rk = isF ? it?.timestamp : it?.dateTimeSaved;
                    if (rk && it?.restoredAtMs) restoredMap.set((isF ? 'F_' : 'O_') + rk, Number(it.restoredAtMs));
                });
            } catch (e) {}
        });

        rawJobs.forEach(j => {
            if (!j || j.jobType === 'tech_loc') return;
            const rk = j.jobType === 'fault' ? j.timestamp : j.dateTimeSaved;
            if (!rk) return;
            const uk = (j.jobType === 'fault' ? 'F_' : 'O_') + rk;
            const restMs = j.restoredAtMs || restoredMap.get(uk) || 0;
            const jobOut = restMs ? { ...j, restoredAtMs: restMs } : j;
            const h = computeCanonicalJobHash(j);
            nextJobHashes.set(uk, h);
            if (restMs || !hasFirstBaseline || syncedJobHashes.get(uk) !== h) upsertedJobs.push(jobOut);
        });

        const delReg = { ...getDeletedJobsRegistry(), ...(locIn.deletedJobsMap || {}) };
        const cloudDelMap = lastCloudTechLocSnapshot?.deletedJobsMap || {};
        const removedJobKeys = Object.keys(delReg).filter(rk => {
            const ts = Number(delReg[rk] || 0);
            if (syncedJobHashes.has('O_' + rk) || syncedJobHashes.has('F_' + rk)) return true;
            const knownTs = Math.max(Number(cloudDelMap[rk] || 0), Number(syncedDeletedJobKeys.get(rk) || 0));
            return !hasFirstBaseline || knownTs <= 0 || ts > knownTs;
        });

        const pinsStr = simSandbox.active ? (lastSyncedLocalPinsStr || '[]') : (rawStorageGet('elec_labeled_places_list') || '[]');
        const delPinsStr = rawStorageGet('elec_deleted_labeled_places_map') || '{}';
        const auditStr = rawStorageGet('elec_deleted_equip_audit_logs') || '[]';
        const bkStr = slimGroupBackupsJson(rawStorageGet('elec_cloud_group_backups_map') || '{}');

        const pHash = `${hashString(pinsStr)}_${pinsStr.length}`;
        const dpHash = `${hashString(delPinsStr)}_${delPinsStr.length}`;
        const auHash = `${hashString(auditStr)}_${auditStr.length}`;
        const bkHash = `${hashString(bkStr)}_${bkStr.length}`;
        const emptyBkHash = `${hashString('{}')}_2`;

        const keepPins = Boolean((hasFirstBaseline && pHash === lastPinsHash && pinsStr === lastSyncedLocalPinsStr) || (!hasFirstBaseline && !hasLocalEquipMutation && pinsStr === '[]'));
        const keepDelPins = Boolean((hasFirstBaseline && dpHash === lastDelPinsHash && delPinsStr === lastSyncedLocalDelPinsStr) || (!hasFirstBaseline && !hasLocalEquipMutation && delPinsStr === '{}'));
        const keepAudit = Boolean((hasFirstBaseline && auHash === lastAuditLogsHash && auditStr === lastSyncedLocalAuditStr) || (!hasFirstBaseline && !hasLocalEquipMutation && auditStr === '[]'));
        const parsedBk = JSON.parse(bkStr || '{}');
        const hadNonEmptyBk = Boolean((lastSyncedLocalBackupsStr && lastSyncedLocalBackupsStr !== '{}') || (lastBackupsHash && lastBackupsHash !== emptyBkHash));
        const keepBk = Boolean((hasFirstBaseline && bkHash === lastBackupsHash && bkStr === lastSyncedLocalBackupsStr) || (Object.keys(parsedBk).length === 0 && !(hasFirstBaseline && hadNonEmptyBk)));

        const techLocDelta = {
            ...(lastCloudTechLocSnapshot || {}), ...locIn,
            id: 'TECH_LOC_REGISTRY', jobType: 'tech_loc', dateTimeSaved: 'TECH_LOC_REGISTRY',
            techLocations: locIn.techLocations || getTechLocationsMap(),
            closedJobsMap: locIn.closedJobsMap || getClosedJobsRegistry(),
            deletedJobsMap: delReg,
            clearedAuditLogsTimestamp: parseInt(rawStorageGet('elec_cleared_audit_logs_ts') || '0', 10) || 0,
            updatedAt: new Date().toISOString()
        };

        if (keepPins) { techLocDelta._keepPins = true; delete techLocDelta.electricEquipmentPins; }
        else { techLocDelta.electricEquipmentPins = JSON.parse(pinsStr); techLocDelta._keepPins = false; }
        if (keepDelPins) { techLocDelta._keepDelPins = true; delete techLocDelta.deletedElectricEquipmentMap; }
        else { techLocDelta.deletedElectricEquipmentMap = JSON.parse(delPinsStr); techLocDelta._keepDelPins = false; }
        if (keepAudit) { techLocDelta._keepAuditLogs = true; delete techLocDelta.deletedEquipAuditLogs; }
        else { techLocDelta.deletedEquipAuditLogs = trimAuditLogsForSheetQuota(JSON.parse(auditStr)); techLocDelta._keepAuditLogs = false; }
        if (keepBk) { techLocDelta._keepBackups = true; delete techLocDelta.cloudGroupBackups; }
        else { techLocDelta.cloudGroupBackups = parsedBk; techLocDelta._keepBackups = false; }

        return {
            payload: { action: 'patchDelta', group: grp, upsertedJobs, removedJobKeys, techLocDelta },
            meta: {
                nextJobHashes, removedJobKeys, delReg, pHash, dpHash, auHash, bkHash,
                sentPinsStr: keepPins ? null : pinsStr,
                sentDelPinsStr: keepDelPins ? null : delPinsStr,
                sentAuditStr: keepAudit ? null : auditStr,
                sentBkStr: keepBk ? null : bkStr
            }
        };
    }

        async function nativePostWithBackoff(url, payloadObj, maxRetries = 3) {
        let attempt = 0;
        while (true) {
            try {
                const res = await nativeFetch.call(window, url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify(payloadObj)
                });
                const resText = await res.text();
                let isBusy = [408, 429, 500, 502, 503, 504].includes(res.status);
                if (!isBusy) {
                    try {
                        const j = JSON.parse(resText);
                        if (j && (j.busy === true || j.retryable === true || j.code === 'SERVER_BUSY' || j.skippedBusyRam === true)) {
                            isBusy = !payloadObj?.ramOnly;
                        } else if (j && j.status === 'error' && /server busy|lock timeout|too many|service invoked/i.test(String(j.message || ''))) {
                            isBusy = !payloadObj?.ramOnly;
                        }
                    } catch (e) {}
                }
                if (!isBusy || attempt >= maxRetries || navigator.onLine === false) {
                    return { res, resText };
                }
            } catch (netErr) {
                if (attempt >= maxRetries || navigator.onLine === false) throw netErr;
            }
            attempt++;
            unlockCloudWrite(20000);
            const waitMs = (1300 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 650);
            if (!payloadObj?.ramOnly) {
                showToast(`⏳ คิวเซิร์ฟเวอร์หนาแน่น ระบบกำลังส่งซ้ำอัตโนมัติ (รอบที่ ${attempt}/${maxRetries})...`);
            }
            await new Promise(r => setTimeout(r, waitMs));
        }
    }

    async function drainCloudPostWorker() {
        if (isPostWorkerRunning || !pendingPostTask) return;
        isPostWorkerRunning = true;
        try {
            while (pendingPostTask) {
                const task = pendingPostTask, waiters = pendingPostWaiters;
                pendingPostTask = null; pendingPostWaiters = [];
                try {
                    const { res, resText } = await nativePostWithBackoff(task.url, task.payload, 3);
                    let ok = res.ok;
                    try {
                        const j = JSON.parse(resText);
                        handleServerUnauthorizedIfNeeded(j);
                        if (j?.status === 'ok' && j?.ok !== false && !j?.skippedQuota && !j?.skippedBusyRam) ok = true;
                        else if (j?.status === 'error' || j?.ok === false || j?.skippedBusyRam) ok = false;
                    } catch (e) {}
                    if (ok && task.meta) {
                        task.meta.nextJobHashes.forEach((h, k) => syncedJobHashes.set(k, h));
                        (task.meta.removedJobKeys || []).forEach(rk => {
                            syncedDeletedJobKeys.set(rk, Number(task.meta.delReg?.[rk] || Date.now()));
                            syncedJobHashes.delete('O_' + rk);
                            syncedJobHashes.delete('F_' + rk);
                        });
                        if (task.meta.sentPinsStr !== null) { lastPinsHash = task.meta.pHash; lastSyncedLocalPinsStr = task.meta.sentPinsStr; }
                        if (task.meta.sentDelPinsStr !== null) { lastDelPinsHash = task.meta.dpHash; lastSyncedLocalDelPinsStr = task.meta.sentDelPinsStr; }
                        if (task.meta.sentAuditStr !== null) { lastAuditLogsHash = task.meta.auHash; lastSyncedLocalAuditStr = task.meta.sentAuditStr; }
                        if (task.meta.sentBkStr !== null) { lastBackupsHash = task.meta.bkHash; lastSyncedLocalBackupsStr = task.meta.sentBkStr; }
                        hasLocalEquipMutation = false;
                        hasFirstBaseline = true;
                        invalidateSheetCaches();
                    }
                    waiters.forEach(w => w.resolve(new Response(resText, { status: res.status || 200, headers: { 'Content-Type': 'application/json' } })));
                } catch (err) {
                    waiters.forEach(w => w.reject(err));
                }
            }
        } finally {
            isPostWorkerRunning = false;
        }
    }

    window.fetch = async function (input, init) {
        const rawUrl = typeof input === 'string' ? input : (input?.url || '');
        if (!rawUrl.includes('script.google.com')) return nativeFetch.apply(window, arguments);

        const method = (init?.method || 'GET').toUpperCase();
        const scopedUrl = buildScopedSheetUrl(rawUrl);
        const cacheKey = `${getCurrentUserGroup() || '__ADMIN__'}::${rawStorageGet('elec_app_current_role') || 'user'}`;

        if (method === 'GET') {
            const isSpecialGetAction = /[?&]action=(?:listTxLoads|getJob)\b/i.test(rawUrl);
            if (!isSpecialGetAction) {
                const mem = sheetMemoryCacheMap.get(cacheKey);
                if (!forceManualGet && mem && (Date.now() - mem.ts < 3500)) {
                    return new Response(mem.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                forceManualGet = false;
            }
            inFlightCloudGetCount++;
            try {
                const res = await nativeFetch.call(window, scopedUrl, init);
                const text = await res.text();
                try {
                    const data = JSON.parse(text);
                    handleServerUnauthorizedIfNeeded(data);
                    if (!isSpecialGetAction && data?.status === 'ok' && Array.isArray(data.jobs)) {
                        data.jobs.forEach(j => {
                            if (!j || j.jobType === 'tech_loc') return;
                            const rk = j.jobType === 'fault' ? j.timestamp : j.dateTimeSaved;
                            if (rk) syncedJobHashes.set((j.jobType === 'fault' ? 'F_' : 'O_') + rk, computeCanonicalJobHash(j));
                        });
                        const locReg = data.jobs.find(j => j && j.jobType === 'tech_loc');
                        if (locReg) {
                            lastCloudTechLocSnapshot = locReg;
                            if (simSandbox.active) simSandbox.deferredCloudLocReg = locReg;
                            const canSyncClean = !hasLocalEquipMutation && !pendingPostTask && !isPostWorkerRunning;
                            if (Array.isArray(locReg.electricEquipmentPins)) { const s = JSON.stringify(locReg.electricEquipmentPins); lastPinsHash = `${hashString(s)}_${s.length}`; if (canSyncClean && lastSyncedLocalPinsStr === null) lastSyncedLocalPinsStr = s; }
                            if (locReg.deletedElectricEquipmentMap) { const s = JSON.stringify(locReg.deletedElectricEquipmentMap); lastDelPinsHash = `${hashString(s)}_${s.length}`; if (canSyncClean && lastSyncedLocalDelPinsStr === null) lastSyncedLocalDelPinsStr = s; }
                            if (Array.isArray(locReg.deletedEquipAuditLogs)) { const s = JSON.stringify(locReg.deletedEquipAuditLogs); lastAuditLogsHash = `${hashString(s)}_${s.length}`; if (canSyncClean && lastSyncedLocalAuditStr === null) lastSyncedLocalAuditStr = s; }
                            if (locReg.cloudGroupBackups) { const s = slimGroupBackupsJson(JSON.stringify(locReg.cloudGroupBackups)); lastBackupsHash = `${hashString(s)}_${s.length}`; if (!pendingPostTask && !isPostWorkerRunning) lastSyncedLocalBackupsStr = s; }
                            hasFirstBaseline = true;
                        }
                        sheetMemoryCacheMap.set(cacheKey, { ts: Date.now(), text });
                        if (text.length <= SHEET_DISK_CACHE_MAX_CHARS) rawStorageSet(SHEET_CACHE_STORAGE_KEY, text);
                    }
                } catch (e) {}
                return new Response(text, { status: res.status || 200, headers: { 'Content-Type': 'application/json' } });
            } finally {
                inFlightCloudGetCount = Math.max(0, inFlightCloudGetCount - 1);
            }
        }

        if (method === 'POST' && typeof init?.body === 'string') {
            try {
                const bodyObj = JSON.parse(init.body);
                if (['verifyLogin', 'verifyPassword', 'verifyUserPassword', 'login', 'saveUsers', 'resolveShortUrl'].includes(bodyObj?.action)) {
                    if (bodyObj.action === 'saveUsers') invalidateSheetCaches();
                    const authRes = await nativeFetch.call(window, scopedUrl, init);
                    if (bodyObj.action === 'saveUsers') {
                        try { handleServerUnauthorizedIfNeeded(await authRes.clone().json()); } catch (e) {}
                    }
                    return authRes;
                }
                if (isViewerRole() && bodyObj?.action !== 'listTxLoads') {
                    return new Response(JSON.stringify({ status: 'ok', skippedViewer: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                if (bodyObj?.action === 'patchDelta') {
                    const res = await nativeFetch.call(window, scopedUrl, init);
                    try { handleServerUnauthorizedIfNeeded(await res.clone().json()); } catch (e) {}
                    invalidateSheetCaches();
                    return res;
                }
                if (bodyObj?.action === 'saveJobs') {
                    const built = buildPatchDeltaFromSaveJobs(bodyObj);
                    return new Promise((resolve, reject) => {
                        if (pendingPostTask) {
                            const mapU = new Map();
                            [...(pendingPostTask.payload.upsertedJobs || []), ...built.payload.upsertedJobs].forEach(j => {
                                const rk = j.jobType === 'fault' ? j.timestamp : j.dateTimeSaved;
                                if (rk) mapU.set((j.jobType === 'fault' ? 'F_' : 'O_') + rk, j);
                            });
                            built.payload.upsertedJobs = Array.from(mapU.values());
                            built.payload.removedJobKeys = Array.from(new Set([...(pendingPostTask.payload.removedJobKeys || []), ...built.payload.removedJobKeys]));
                            built.meta.removedJobKeys = built.payload.removedJobKeys;
                            built.meta.nextJobHashes = new Map([...pendingPostTask.meta.nextJobHashes, ...built.meta.nextJobHashes]);
                        }
                        pendingPostTask = { url: scopedUrl, payload: built.payload, meta: built.meta };
                        pendingPostWaiters.push({ resolve, reject });
                        drainCloudPostWorker();
                    });
                }
            } catch (e) {}
        }

        const fallbackRes = await nativeFetch.call(window, scopedUrl, init);
        try { handleServerUnauthorizedIfNeeded(await fallbackRes.clone().json()); } catch (e) {}
        return fallbackRes;
    };

    // ========================================================================
    // 8. Server Auth (SHA-256), Online Presence, Geo & ShortLink Utilities
    // ========================================================================
    async function computeSha256Hex(str) {
        if (!window.crypto?.subtle) return '';
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str ?? '')));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function matchAccountLocally(uInput, pwdPlain, accountsList) {
        const pwdHash = await computeSha256Hex(pwdPlain);
        return (accountsList || []).find(acc => {
            if (!isUsernameMatchingAccount(uInput, acc.username)) return false;
            const stored = String(acc.password || '').trim(), cleanStored = stored.replace(/^sha256:/i, '').toLowerCase();
            return stored === pwdPlain || (pwdHash && cleanStored === pwdHash);
        }) || null;
    }

    async function verifyLoginOnServer(username, password) {
        const normU = normalizeUsernameFormat(username), pwd = String(password || '').trim();
        const sessToken = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const res = await nativeFetch.call(window, getActiveCloudApiUrl(), {
            method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'verifyLogin', username: normU, rawUsername: String(username || '').trim(), password: pwd, sessionToken: sessToken })
        });
        const data = await res.json();
        if (Array.isArray(data?.users) && data.users.length > 0) {
            cachedAccountsStr = '';
            rawStorageSet('elec_user_accounts', JSON.stringify(data.users.map(parseAccountRecord)));
        }
        let authedUser = (data?.authenticated && data?.user) ? parseAccountRecord(data.user) : null;
        if (data?.authenticated === undefined) {
            authedUser = await matchAccountLocally(normU, pwd, getParsedUserAccounts());
        }
        if (!authedUser) return { status: 'ok', authenticated: false };

        const canonUser = normalizeUsernameFormat(authedUser.username);
        const role = (authedUser.role || 'user').split('::')[0] || 'user';
        const grp = normalizePeaGroupName(data?.user?.group || getUserGroupName(canonUser)) || (role !== 'admin' ? 'กฟส.บึง' : '');
        const finalToken = data?.user?.sessionToken || sessToken;

        rawStorageSet('elec_app_logged_in', 'true');
        rawStorageSet('elec_app_current_user', canonUser);
        rawStorageSet('elec_app_current_role', role);
        rawStorageSet('elec_app_current_group', grp);
        rawStorageSet(LAST_GROUP_SESSION_KEY, grp || '__ADMIN_ALL__');
        rawStorageSet('elec_app_session_token', finalToken);
        rawStorageSet('elec_app_last_active', String(Date.now()));
        invalidateSheetCaches();
        connectMqttLiveBus(true);
        return { status: 'ok', authenticated: true, user: { username: canonUser, role, group: grp, displayName: authedUser.displayName || '' } };
    }

    async function verifyPasswordOnServer(typedPassword) {
        const pwd = String(typedPassword || '').trim();
        if (!pwd) return false;
        const curUser = normalizeUsernameFormat(rawStorageGet('elec_app_current_user') || '');
        const candidates = curUser && curUser.toLowerCase() !== 'admin' ? [curUser, 'admin'] : ['admin'];
        for (const u of candidates) {
            try {
                const res = await nativeFetch.call(window, getActiveCloudApiUrl(), {
                    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({ action: 'verifyLogin', username: u, rawUsername: u, password: pwd, checkOnly: true })
                });
                const d = await res.json();
                if (d?.authenticated === true) return true;
                if (d?.authenticated === undefined && await matchAccountLocally(u, pwd, getParsedUserAccounts())) return true;
            } catch (e) {
                if (await matchAccountLocally(u, pwd, getParsedUserAccounts())) return true;
            }
        }
        return false;
    }

    function updateUserOnlineHeartbeat(currentPageLabel = '💻 หน้าหลัก', coordsObj = null, gpsEnabled = false) {
        if (rawStorageGet('elec_app_logged_in') !== 'true') return;
        const curUser = normalizeUsernameFormat(rawStorageGet('elec_app_current_user') || '');
        if (!curUser) return;
        const role = (rawStorageGet('elec_app_current_role') || 'user').trim();
        const grp = normalizePeaGroupName(getCurrentUserGroup());
        const nowIso = new Date().toISOString();
        const locMap = getTechLocationsMap();
        const prev = locMap[curUser] || {};
        const allowGps = Boolean(gpsEnabled && coordsObj && !isEmbeddedIframe && role !== 'viewer' && !isNaN(parseFloat(coordsObj.lat)) && !isNaN(parseFloat(coordsObj.lon)));

        locMap[curUser] = {
            ...prev, username: curUser, role, group: grp, isOnline: true,
            currentPage: isEmbeddedIframe ? '💻 หน้าหลัก (เปิดคู่หน้าช่าง)' : currentPageLabel,
            gpsDisabled: !allowGps,
            lat: allowGps ? Number(parseFloat(coordsObj.lat).toFixed(6)) : null,
            lon: allowGps ? Number(parseFloat(coordsObj.lon).toFixed(6)) : null,
            lastSeenAt: nowIso, updatedAt: nowIso
        };
        localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
    }

    function getAccountsOnlineStatusList(myPageLabel = '💻 หน้าหลัก', myHasGps = false) {
        const accounts = getParsedUserAccounts(), locMap = getTechLocationsMap();
        const curUser = rawStorageGet('elec_app_current_user') || '', isLogged = rawStorageGet('elec_app_logged_in') === 'true', now = Date.now();
        return accounts.map(acc => {
            const isMe = Boolean(isLogged && curUser && isUsernameMatchingAccount(curUser, acc.username));
            const locEntry = Object.entries(locMap).find(([k, v]) => !isSystemLocRegistryKey(k, v) && (isUsernameMatchingAccount(k, acc.username) || isUsernameMatchingAccount(v?.username, acc.username)))?.[1] || null;
            const lastSeenMs = isMe ? now : (locEntry ? (new Date(locEntry.lastSeenAt || locEntry.updatedAt || 0).getTime() || 0) : 0);
            const diffMs = lastSeenMs ? Math.max(0, now - lastSeenMs) : Infinity;
            const isOnline = isMe || Boolean(locEntry && locEntry.isOnline !== false && lastSeenMs > 0 && diffMs <= ONLINE_THRESHOLD_MS);
            return {
                username: acc.username, displayName: formatTechDisplayName(acc.username), role: acc.role || 'user',
                group: getUserGroupName(acc.username), isOnline, isMe,
                currentPage: isMe ? myPageLabel : (locEntry?.currentPage || '📱 ระบบงานไฟฟ้า'),
                hasGps: isMe ? Boolean(myHasGps) : Boolean(locEntry && !locEntry.gpsDisabled && !isNaN(parseFloat(locEntry.lat)) && !isNaN(parseFloat(locEntry.lon))),
                lastSeenMs, diffMs
            };
        }).sort((a, b) => (Number(b.isOnline) - Number(a.isOnline)) || (a.diffMs - b.diffMs));
    }

    function calcHaversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371.0088, toRad = Math.PI / 180;
        const dLat = (parseFloat(lat2) - parseFloat(lat1)) * toRad, dLon = (parseFloat(lon2) - parseFloat(lon1)) * toRad;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(parseFloat(lat1) * toRad) * Math.cos(parseFloat(lat2) * toRad) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    function deepParseCoords(rawStr) {
        if (!rawStr) return null;
        let s = String(rawStr).trim();
        try { s = decodeURIComponent(s); } catch (e) {}
        const dms = s.match(/(\d{1,2})°\s*(\d{1,2})['′]\s*(\d{1,2}(?:\.\d+)?)["″]?\s*([NSns])\s*[,\s]+\s*(\d{1,3})°\s*(\d{1,2})['′]\s*(\d{1,2}(?:\.\d+)?)["″]?\s*([EWew])/);
        if (dms) {
            const la = (Number(dms[1]) + Number(dms[2]) / 60 + Number(dms[3]) / 3600) * (/s/i.test(dms[4]) ? -1 : 1);
            const lo = (Number(dms[5]) + Number(dms[6]) / 60 + Number(dms[7]) / 3600) * (/w/i.test(dms[8]) ? -1 : 1);
            return { lat: Number(la.toFixed(6)), lon: Number(lo.toFixed(6)) };
        }
        const m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/i) ||
            s.match(/[?&](?:q|ll|destination|query|center|daddr)=(-?\d+\.\d+)\s*,\s*\+?(-?\d+\.\d+)/i) ||
            s.match(/@(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/) ||
            s.match(/(?:lat(?:itude)?|ละติจูด)\s*[:：=]?\s*(-?\d{1,3}\.\d{3,})[\s,;\/|]*(?:long(?:itude)?|lon|lng|ลองจิจูด)\s*[:：=]?\s*\+?(-?\d{1,3}\.\d{3,})/i) ||
            s.match(/(-?\d{1,3}\.\d{3,})\s*,\s*\+?(-?\d{1,3}\.\d{3,})/);
        if (!m) return null;
        let la = parseFloat(m[1]), lo = parseFloat(m[2]);
        if (isNaN(la) || isNaN(lo)) return null;
        if (la >= 95 && la <= 108 && lo >= 4 && lo <= 23) { const t = la; la = lo; lo = t; }
        return (Math.abs(la) <= 90 && Math.abs(lo) <= 180) ? { lat: Number(la.toFixed(6)), lon: Number(lo.toFixed(6)) } : null;
    }

    async function resolveGoogleShortLinkUniversal(rawInput) {
        const direct = deepParseCoords(rawInput);
        if (direct) return direct;
        const m = String(rawInput || '').match(SHORT_URL_REGEX);
        if (!m) return null;
        const shortUrl = (/^https?:\/\//i.test(m[0]) ? m[0] : 'https://' + m[0]).trim();
        const cacheKey = shortUrl.split('?')[0];
        let cache = {};
        try { cache = JSON.parse(rawStorageGet(SHORT_LINK_CACHE_KEY) || '{}') || {}; } catch (e) {}
        if (cache[cacheKey]?.lat && cache[cacheKey]?.lon) return cache[cacheKey];

        let found = null;
        try {
            const res = await nativeFetch.call(window, getActiveCloudApiUrl(), {
                method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({ action: 'resolveShortUrl', url: shortUrl })
            });
            const d = await res.json();
            found = (d?.lat && d?.lon) ? deepParseCoords(`${d.lat},${d.lon}`) : deepParseCoords(d?.resolvedUrl || d?.url || d?.html || '');
        } catch (e) {}
        if (!found) {
            try {
                const r2 = await nativeFetch.call(window, `https://unshorten.me/json/${encodeURIComponent(shortUrl)}`);
                const d2 = await r2.json();
                found = deepParseCoords(d2?.resolved_url || '');
            } catch (e) {}
        }
        if (found) {
            cache[cacheKey] = found;
            rawStorageSet(SHORT_LINK_CACHE_KEY, JSON.stringify(Object.fromEntries(Object.entries(cache).slice(-250))));
        }
        return found;
    }

    ['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, () => {
        if (rawStorageGet('elec_app_logged_in') === 'true') rawStorageSet('elec_app_last_active', String(Date.now()));
    }, { passive: true }));
    setInterval(() => {
        if (rawStorageGet('elec_app_logged_in') !== 'true') return;
        const lastAct = parseInt(rawStorageGet('elec_app_last_active') || '0', 10);
        if (lastAct > 0 && (Date.now() - lastAct > INACTIVITY_TIMEOUT_MS)) {
            if (typeof window.triggerAutoLogout === 'function') window.triggerAutoLogout();
            else if (typeof window.handleTechLogout === 'function') window.handleTechLogout();
        }
    }, 30000);

    window.PeaCore = {
        REGISTRY_LOC_KEY, isEmbeddedIframe, simSandbox, ramIndex,
        rawStorageGet, rawStorageSet, refreshRamPinsIndex, refreshRamDelPinsIndex,
        unlockCloudWrite, forceCloudRead, invalidateSheetCaches, onRealtimeChange, notifyStorageUpdated,
        createTrailingAsyncQueue, enterSimSandbox, exitSimSandbox,
        verifyLoginOnServer, verifyPasswordOnServer, updateUserOnlineHeartbeat, getAccountsOnlineStatusList,
        cleanReopenedAndCancelledJobsInStorage, runWithGroupViewFilter, getStorageUsageStats, cleanTemporaryCacheSafe,
        downloadCsvFallback, calcHaversineKm, deepParseCoords, resolveGoogleShortLinkUniversal
    };

    Object.assign(window, {
        CLOUD_USER_API_URL, getActiveCloudApiUrl, normalizePeaGroupName, stripPeaGroupSuffix,
        getUserGroupName, getUserBaseId, normalizeUsernameFormat, isUsernameMatchingAccount,
        parseAccountRecord, getParsedUserAccounts, formatTechDisplayName, isSameTechPerson,
        getValidSystemGroupsSet, getCurrentUserGroup, getJobGroupName,
        isCurrentUserAdmin, isViewerRole, canCurrentUserEditScada, canCurrentUserSeeJob,
        escapeHtmlStr, hexToClosestPinColorKey, showToast, showCustomAlert, showCustomConfirm, showCustomPrompt,
        copyTextToClipboard, copyTechText: copyTextToClipboard,
        ensureXlsxLibraryLoaded, ensureXlsxLoaded: ensureXlsxLibraryLoaded, ensureTechXlsxLoaded: ensureXlsxLibraryLoaded,
        downloadCsvFallback, isAutoGeneratedFakeClosure,
        getClosedJobsRegistry, getClosedReportsRegistry: getClosedJobsRegistry,
        syncClosedRegistryObject, saveClosedReportsRegistry: syncClosedRegistryObject, saveClosedJobToRegistry,
        getDeletedJobsRegistry, recordDeletedJobToRegistry, syncDeletedRegistryObject,
        getTechLocationsMap, mergeTechLocationsMap, calcHaversineKm, deepParseCoords, resolveGoogleShortLinkUniversal
    });

    refreshRamDelPinsIndex();
    refreshRamPinsIndex();
    seedMqttPinBaseline(ramIndex.pinsList);
    connectMqttLiveBus(false);
})();

// ============================================================================
// 🛡️ PEA CONCURRENCY SHIELD: Write Queue + Exponential Backoff + Button Cooldown
// ============================================================================
(function () {
    'use strict';
    if (window.__peaConcurrencyShieldInstalled) return;
    window.__peaConcurrencyShieldInstalled = true;

    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 1300;
    const BUTTON_COOLDOWN_MS = 3500; // หน่วงปุ่มกดซ้ำ 3.5 วินาทีหลังส่งข้อมูลเสร็จ

    // เฉพาะคำสั่งเขียนตรง (ส่วน saveJobs ใช้คิวยุบรวมใน drainCloudPostWorker อยู่แล้ว ไม่ให้ซ้อนคิว)
    const QUEUED_DIRECT_WRITE_ACTIONS = new Set([
        'patchDelta', 'saveTxLoad', 'deleteTxLoad', 'deleteTxPdf', 'saveMeterState', 'saveUsers', 'uploadJobPhoto', 'uploadTxPdf'
    ]);
    const DIRECT_RETRY_POST_ACTIONS = new Set([
        'patchDelta', 'saveTxLoad', 'deleteTxLoad', 'deleteTxPdf', 'saveMeterState', 'saveUsers', 'uploadJobPhoto', 'uploadTxPdf'
    ]);

    const SUBMIT_BTN_SELECTOR = [
        '#saveTxRecordBtn',
        '#deleteActivePdfBtn',
        '#saveEquipPinSubmitBtn',
        '#confirmClearEquipSubmitBtn',
        '#techLoginBtn',
        'button[onclick*="saveAndCopyFault"]',
        'button[onclick*="generateOutageMessage"]',
        'button[onclick*="submitTechReport"]',
        'button[onclick*="saveScadaNodeModal"]',
        'button[onclick*="applySimulatedStateToRealGrid"]',
        'button[onclick*="handleLogin("]'
    ].join(', ');

    const origFetch = window.fetch.bind(window);
    let writeQueueChain = Promise.resolve();
    let recentClickedBtn = null;
    let recentClickAtMs = 0;
    let recentClickWasEnabled = true;

    function sleepMs(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isGasEndpoint(urlStr) {
        return typeof urlStr === 'string' && /script\.google\.com|script\.googleusercontent\.com/i.test(urlStr);
    }

    function inspectRequestMeta(input, init) {
        const urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : String(input || ''));
        const method = String((init && init.method) || 'GET').toUpperCase();
        if (!isGasEndpoint(urlStr)) return { isGas: false };

        let action = '';
        let isRamOnly = false;
        if (method === 'POST' && init && typeof init.body === 'string') {
            try {
                const parsed = JSON.parse(init.body);
                action = String(parsed.action || '').trim();
                isRamOnly = Boolean(parsed.ramOnly);
            } catch (e) {}
        } else if (method === 'GET') {
            const mAct = urlStr.match(/[?&]action=([^&#]+)/i);
            if (mAct) action = decodeURIComponent(mAct[1]);
        }

        const isSpecialOneShotGet = method === 'GET' && (action === 'listTxLoads' || action === 'getJob');
        const maxRetries = (method === 'POST' && !isRamOnly && DIRECT_RETRY_POST_ACTIONS.has(action))
            ? ((action === 'uploadJobPhoto' || action === 'uploadTxPdf') ? 2 : MAX_RETRIES)
            : (isSpecialOneShotGet ? 2 : 0);

        return {
            isGas: true,
            method,
            action,
            isRamOnly,
            maxRetries,
            shouldQueue: method === 'POST' && !isRamOnly && QUEUED_DIRECT_WRITE_ACTIONS.has(action),
            shouldRetry: maxRetries > 0
        };
    }

    async function isRetryableServerResponse(res) {
        if (!res) return true;
        if ([408, 429, 500, 502, 503, 504].includes(res.status)) return true;
        if (res.status === 200) {
            try {
                const data = await res.clone().json();
                if (data && (data.busy === true || data.retryable === true || data.code === 'SERVER_BUSY')) {
                    return true;
                }
                if (data && data.status === 'error' && /server busy|lock timeout|too many|service invoked/i.test(String(data.message || ''))) {
                    return true;
                }
            } catch (e) {}
        }
        return false;
    }

    async function executeFetchWithBackoff(input, init, meta) {
        let attempt = 0;
        while (true) {
            const reqInit = init ? Object.assign({}, init) : undefined;
            if (meta.method === 'POST' && !meta.isRamOnly && (attempt > 0 || DIRECT_RETRY_POST_ACTIONS.has(meta.action))) {
                window.PeaCore?.unlockCloudWrite?.(20000);
            }
            try {
                const res = await origFetch(input, reqInit);
                if (!meta.shouldRetry || attempt >= meta.maxRetries || !(await isRetryableServerResponse(res))) {
                    return res;
                }
            } catch (netErr) {
                if (!meta.shouldRetry || attempt >= meta.maxRetries || navigator.onLine === false) {
                    throw netErr;
                }
            }

            attempt++;
            const jitterMs = Math.floor(Math.random() * 650);
            const waitMs = (BASE_DELAY_MS * Math.pow(2, attempt - 1)) + jitterMs;

            if (meta.method === 'POST' && typeof window.showToast === 'function') {
                window.showToast(`⏳ คิวเซิร์ฟเวอร์หนาแน่น ระบบกำลังส่งซ้ำอัตโนมัติ (รอบที่ ${attempt}/${meta.maxRetries})...`);
            }
            await sleepMs(waitMs);
        }
    }

    function lockButtonWithCooldown(btn, promiseToWait, wasEnabledBeforeClick) {
        if (!btn || btn.dataset.peaLockedFlight === '1') return;
        btn.dataset.peaLockedFlight = '1';
        btn.dataset.peaTapGuard = '1';
        const prevOpacity = btn.style.opacity;
        const prevPointer = btn.style.pointerEvents;

        btn.disabled = true;
        btn.style.opacity = '0.65';
        btn.style.pointerEvents = 'none';

        Promise.resolve(promiseToWait).finally(() => {
            setTimeout(() => {
                if (wasEnabledBeforeClick) btn.disabled = false;
                btn.style.opacity = prevOpacity;
                btn.style.pointerEvents = prevPointer;
                delete btn.dataset.peaLockedFlight;
                delete btn.dataset.peaTapGuard;
            }, BUTTON_COOLDOWN_MS);
        });
    }

    window.fetch = function (input, init) {
        const meta = inspectRequestMeta(input, init);
        if (!meta.isGas) return origFetch(input, init);

        const runTask = () => executeFetchWithBackoff(input, init, meta);
        let taskPromise;

        if (meta.shouldQueue) {
            const nextInQueue = writeQueueChain.then(runTask, runTask);
            writeQueueChain = nextInQueue.catch(() => {});
            taskPromise = nextInQueue;
        } else {
            taskPromise = runTask();
        }

        if (meta.method === 'POST' && !meta.isRamOnly && recentClickedBtn && (Date.now() - recentClickAtMs < 1500)) {
            lockButtonWithCooldown(recentClickedBtn, taskPromise, recentClickWasEnabled);
            recentClickedBtn = null;
        }

        return taskPromise;
    };

    document.addEventListener('click', function (e) {
        const btn = e.target && e.target.closest ? e.target.closest(SUBMIT_BTN_SELECTOR) : null;
        if (!btn) return;

        if (btn.dataset.peaTapGuard === '1' || btn.dataset.peaLockedFlight === '1') {
            e.preventDefault();
            e.stopImmediatePropagation();
            window.showToast?.('⏳ ระบบกำลังบันทึกข้อมูล กรุณารอสักครู่...');
            return;
        }

        btn.dataset.peaTapGuard = '1';
        recentClickedBtn = btn;
        recentClickAtMs = Date.now();
        recentClickWasEnabled = !btn.disabled;

        setTimeout(() => {
            if (btn.dataset.peaLockedFlight !== '1') {
                delete btn.dataset.peaTapGuard;
            }
        }, 850);
    }, true);
})();
// ==================== จบไฟล์ shared-core.js (v6.7) ====================