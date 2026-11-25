// ============================================================================
// 📅⏰📷📡 PEA SMART GRID — MAINTENANCE SCHEDULE, PHOTO, RADAR & ALERT ENGINE v7.6 (pm-calendar.js)
// ระบบปฏิทินแผนงานบำรุงรักษา + แนบรูป 3 รูป + โซนเรดาร์ & ดูดชื่อสถานที่แจ้งดับไฟ FB/LINE
// พาทที่ 1 / 6 : Config, Helpers, Cloud Shard (รองรับ pbp/pubPlaces) & Cross-Tab Sync
// ============================================================================
(function () {
    'use strict';

    const Core = window.PeaCore;
    const PM_STORAGE_KEY = 'elec_pm_calendar_plans_v1';
    const PM_ACK_LOG_KEY = 'elec_pm_alert_ack_log_v2';
    const PM_SOUND_KEY = 'elec_pm_alert_sound_enabled';
    const PM_REPEAT_EVERY_MIN_KEY = 'elec_pm_repeat_alert_every_min';
    const PM_SHOW_SCADA_DUE_KEY = 'elec_pm_show_scada_due_pins';
    const PM_SHOW_MAP_PINS_KEY = 'elec_pm_show_pins_on_map';
    const PM_MAP_FILTER_MODE_KEY = 'elec_pm_map_pin_filter_mode';
    const PM_LOC_PREFIX = '__PM_SCHEDULE__';
    const PM_SYNC_CHANNEL = 'pea_pm_live_sync_v1';

    const PM_LAST_GROUP_KEY = 'elec_pm_last_group_v1';
    const PM_LAST_USER_KEY = 'elec_pm_last_user_v1';
    const PM_LAST_ROLE_KEY = 'elec_pm_last_role_v1';
    const PM_LAST_API_URL_KEY = 'elec_pm_last_api_url_v1';
    const PM_HAS_SESSION_HISTORY_KEY = 'elec_pm_has_session_history_v1';

    const DEFAULT_STANDARD_ALERT_TIMES = ['00:00', '07:00'];
    const MAX_TOMBSTONE_AGE_MS = 35 * 24 * 60 * 60 * 1000;
    const MAX_DONE_CLOUD_AGE_MS = 60 * 24 * 60 * 60 * 1000;
    const MAX_CLOUD_SYNC_ITEMS = 60;
    const MAX_SHARD_JSON_CHARS = 32000;

    // ค่ากำหนดสำหรับระบบแนบรูปประกอบแผนงาน PM (สูงสุด 3 รูปต่อแผนงาน)
    const MAX_PM_PHOTOS = 3;
    const PM_PHOTO_MAX_DIM = 1280;
    const PM_PHOTO_QUALITY = 0.80;

    const THAI_MONTHS = [
        'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
        'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
    ];
    const THAI_DAYS_SHORT = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

    const PM_CATEGORIES = {
        tree: { key: 'tree', icon: '🌳', name: 'ตัดรอนกิ่งไม้ใกล้แนวสาย', pillCls: 'bg-emerald-100 text-emerald-800 border-emerald-300', barBg: '#10b981', defaultColor: 'emerald' },
        scada: { key: 'scada', icon: '⚡', name: 'ตรวจสวิตช์ / อุปกรณ์ SCADA', pillCls: 'bg-sky-100 text-sky-800 border-sky-300', barBg: '#0284c7', defaultColor: 'sky' },
        tr: { key: 'tr', icon: '🔌', name: 'บำรุงรักษาหม้อแปลง / โหลด', pillCls: 'bg-amber-100 text-amber-900 border-amber-300', barBg: '#f59e0b', defaultColor: 'amber' },
        thermo: { key: 'thermo', icon: '🔥', name: 'ส่องกล้องความร้อน (Thermo)', pillCls: 'bg-rose-100 text-rose-800 border-rose-300', barBg: '#e11d48', defaultColor: 'rose' },
        hotline: { key: 'hotline', icon: '🦺', name: 'HOTLINE เข้าทำงาน', pillCls: 'bg-orange-100 text-orange-900 border-orange-300', barBg: '#ea580c', defaultColor: 'orange' },
        patrol: { key: 'patrol', icon: '🛠️', name: 'แผนดับไฟปฏิบัติงาน / อื่นๆ', pillCls: 'bg-purple-100 text-purple-800 border-purple-300', barBg: '#7c3aed', defaultColor: 'purple' }
    };

    const PM_PIN_COLORS = {
        auto: { key: 'auto', label: 'ตามประเภท', hex: null, grad: null },
        emerald: { key: 'emerald', label: '🟢 เขียว', hex: '#10b981', grad: 'linear-gradient(135deg,#10b981,#047857)' },
        sky: { key: 'sky', label: '🔵 ฟ้า', hex: '#0284c7', grad: 'linear-gradient(135deg,#38bdf8,#0369a1)' },
        amber: { key: 'amber', label: '🟡 เหลืองทอง', hex: '#f59e0b', grad: 'linear-gradient(135deg,#fbbf24,#d97706)' },
        orange: { key: 'orange', label: '🟠 ส้ม', hex: '#ea580c', grad: 'linear-gradient(135deg,#fb923c,#c2410c)' },
        rose: { key: 'rose', label: '🔴 แดง', hex: '#e11d48', grad: 'linear-gradient(135deg,#f43f5e,#be123c)' },
        purple: { key: 'purple', label: '🟣 ม่วง', hex: '#7c3aed', grad: 'linear-gradient(135deg,#a855f7,#6d28d9)' }
    };

    const nowInit = new Date();
    let pmPlans = [];
    let viewYear = nowInit.getFullYear();
    let viewMonth = nowInit.getMonth();
    let selectedDateIso = toLocalIsoDate(nowInit);
    let editingPlanId = null;
    let currentFilterStatus = 'day';
    let calendarLeftViewMode = 'grid';
    let isTechStripCollapsed = false;
    let lastRenderedTechStripSig = '';

    let tempFormCustomTimes = [];
    let lastActivePopupAckTokens = [];
    let lastActivePopupDateIso = '';
    let isPopupOpenedByForcePreview = false;
    const firedAlertTokensInSession = new Set();
    let lastRepeatAlertMinuteKey = '';

    // สถานะจัดการรูปภาพประกอบแผนงาน PM, แคชไฟล์รูปใน RAM และตัวดูรูปเต็มจอ (Lightbox)
    let tempFormPhotoIds = [];
    let originalEditingPhotoIds = [];
    let sessionModalUploadedIds = [];
    let isUploadingModalPhotos = false;
    let tempQuickPhotoIds = [];
    let isUploadingQuickPhotos = false;
    const pmPhotoBlobCache = new Map();
    let lightboxPhotoIds = [];
    let lightboxActiveIdx = 0;
    let lightboxSourcePlanId = '';
    let pendingShareFilesPayload = null;
    let isSharingToLineBusy = false;

    let isPmSoundEnabled = localStorage.getItem(PM_SOUND_KEY) !== 'false';
    let isPmRepeatEveryMin = localStorage.getItem(PM_REPEAT_EVERY_MIN_KEY) !== 'false';
    let showScadaDuePins = localStorage.getItem(PM_SHOW_SCADA_DUE_KEY) !== 'false';
    let showPmPinsOnMaps = localStorage.getItem(PM_SHOW_MAP_PINS_KEY) !== 'false';
    let pmMapFilterMode = localStorage.getItem(PM_MAP_FILTER_MODE_KEY) || 'pending';
    let isSyncingPmInternal = false;
    let lastCheckedAlertMinuteKey = '';

    let scadaMapRef = null, scadaPmLayer = null, scadaPmMarkersById = {};
    let repairMapRef = null, repairPmLayer = null, repairPmMarkersById = {};
    let calendarMapInstance = null, calendarPmLayer = null, calendarPmMarkersById = {};
    let formMiniMap = null, formMiniMarker = null, isFormMiniMapOpen = false;
    let pmPinDropModeActive = false, pmPinMoveTargetId = null, leafletLoadPromise = null;

    let pmBroadcast = null;
    try { if ('BroadcastChannel' in window) pmBroadcast = new BroadcastChannel(PM_SYNC_CHANNEL); } catch (e) {}
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.update())).catch(() => {});
    }

    // ========================================================================
    // 1. Safe Cross-Page Wrappers & Photo Helpers
    // ========================================================================
    function rawGet(key) {
        return Core && typeof Core.rawStorageGet === 'function' ? Core.rawStorageGet(key) : localStorage.getItem(key);
    }
    function safeEscHtml(str) {
        if (typeof window.escapeHtmlStr === 'function') return window.escapeHtmlStr(str);
        return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function safeToast(msg) {
        if (typeof window.showToast === 'function') window.showToast(msg);
    }
    function safeIsViewer() {
        if (typeof window.isViewerRole === 'function') return Boolean(window.isViewerRole());
        return (rawGet('elec_app_current_role') || '').trim() === 'viewer';
    }
    function safeCanEditScada() {
        if (typeof window.canCurrentUserEditScada === 'function') return Boolean(window.canCurrentUserEditScada());
        return !safeIsViewer();
    }
    function safeGetLocMap() {
        if (typeof window.getTechLocationsMap === 'function') return window.getTechLocationsMap() || {};
        try { return JSON.parse(rawGet('elec_tech_locations_map') || '{}') || {}; } catch (e) { return {}; }
    }
    function safeFormatTechName(rawName) {
        if (typeof window.formatTechDisplayName === 'function') return window.formatTechDisplayName(rawName);
        return String(rawName || 'ผู้ปฏิบัติงาน').trim() || 'ผู้ปฏิบัติงาน';
    }
    function safeConfirm(msg, onOk, title = 'ยืนยันการทำรายการ') {
        if (typeof window.showCustomConfirm === 'function') return window.showCustomConfirm(msg, onOk, title);
        if (window.confirm(msg) && typeof onOk === 'function') onOk();
    }
    function normPmGrp(raw) {
        if (typeof window.normalizePeaGroupName === 'function') return window.normalizePeaGroupName(raw);
        return String(raw || '').trim().replace(/\s+/g, ' ')
            .replace(/^(กฟ[สฟจตอ])\.?\s+/, '$1.')
            .replace(/^(กฟ[สฟจตอ])(?![.\s])/, '$1.');
    }

    function normalizePmPhotoIds(rawObjOrArr) {
        const arr = Array.isArray(rawObjOrArr)
            ? rawObjOrArr
            : (Array.isArray(rawObjOrArr?.photoIds) ? rawObjOrArr.photoIds : (Array.isArray(rawObjOrArr?.ph) ? rawObjOrArr.ph : []));
        const seen = new Set();
        const out = [];
        arr.forEach(id => {
            const clean = String(id || '').trim();
            if (/^[a-zA-Z0-9_-]{15,65}$/.test(clean) && !seen.has(clean)) {
                seen.add(clean);
                if (out.length < MAX_PM_PHOTOS) out.push(clean);
            }
        });
        return out;
    }
    function getPmPhotoThumbUrl(fileId, size = 400) {
        return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${size}`;
    }
    function getPmPhotoDirectUrl(fileId, size = 1280) {
        return `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w${size}`;
    }
    function getPmPhotoDriveViewUrl(fileId) {
        return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
    }
    function rememberPmPhotoBlob(fileId, blob) {
        if (!fileId || !blob) return;
        if (pmPhotoBlobCache.has(fileId)) pmPhotoBlobCache.delete(fileId);
        pmPhotoBlobCache.set(fileId, blob);
        if (pmPhotoBlobCache.size > 24) {
            const oldestKey = pmPhotoBlobCache.keys().next().value;
            if (oldestKey) pmPhotoBlobCache.delete(oldestKey);
        }
    }
    function getActivePmCloudUrl() {
        return (
            (typeof window.getActiveCloudApiUrl === 'function' ? window.getActiveCloudApiUrl() : '') ||
            rawGet(PM_LAST_API_URL_KEY) ||
            rawGet('elec_cloud_user_api_url') ||
            rawGet('elec_cloud_api_url') ||
            window.CLOUD_API_URL ||
            ''
        ).trim();
    }
    function isMobileFileSharePreferred() {
        if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
            return false;
        }
        const ua = navigator.userAgent || '';
        if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
        if (/Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1) return true;
        return false;
    }

    function normalizeTimeHHMM(rawStr) {
        if (!rawStr) return '';
        const m = String(rawStr).trim().replace(/\./g, ':').match(/^(\d{1,2})\s*:\s*(\d{1,2})/);
        if (!m) return '';
        const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
        if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return '';
        return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
    function timeHHMMToMinutes(hhmm) {
        const clean = normalizeTimeHHMM(hhmm);
        if (!clean) return -1;
        const [h, m] = clean.split(':').map(Number);
        return h * 60 + m;
    }
    function getMinuteFloorIso(dateObj = new Date()) {
        const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
        if (isNaN(d.getTime())) return new Date().toISOString();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), 0, 0).toISOString();
    }
    function isSlotBeforePlanBaseline(item, dateIso, slotHHMM) {
        if (!item || item.isScadaPinDue) return false;
        const rawBase = item.alertBaselineAt || item.createdAt || '';
        if (!rawBase) return false;
        const baseMs = new Date(rawBase).getTime();
        if (isNaN(baseMs)) return false;
        const mins = timeHHMMToMinutes(slotHHMM);
        if (mins < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso || ''))) return false;
        const [y, m, d] = String(dateIso).split('-').map(Number);
        const slotMs = new Date(y, m - 1, d, Math.floor(mins / 60), mins % 60, 0, 0).getTime();
        const bf = new Date(baseMs);
        const baseFloorMs = new Date(bf.getFullYear(), bf.getMonth(), bf.getDate(), bf.getHours(), bf.getMinutes(), 0, 0).getTime();
        return slotMs < baseFloorMs;
    }
    function normalizeCustomTimesArray(arr) {
        if (!Array.isArray(arr)) return [];
        const set = new Set();
        arr.forEach(t => { const clean = normalizeTimeHHMM(t); if (clean) set.add(clean); });
        return Array.from(set).sort((a, b) => timeHHMMToMinutes(a) - timeHHMMToMinutes(b));
    }
    function getPlanEffectiveAlertConfig(item) {
        const customTimes = normalizeCustomTimesArray(item?.customAlertTimes || []);
        const rawMode = item?.alertMode || (customTimes.length > 0 ? 'both' : 'standard');
        if (rawMode === 'off') return { mode: 'off', customTimes, allTimes: [], badgeLabel: '🔕 ปิดเตือน' };
        if (rawMode === 'custom_only') return { mode: 'custom_only', customTimes, allTimes: customTimes, badgeLabel: customTimes.length > 0 ? `⏰ เตือน ${customTimes.join(', ')} น.` : '🔕 ยังไม่ระบุเวลา' };
        if (rawMode === 'both') {
            const combined = normalizeCustomTimesArray([...DEFAULT_STANDARD_ALERT_TIMES, ...customTimes]);
            return { mode: 'both', customTimes, allTimes: combined, badgeLabel: customTimes.length > 0 ? `🔔 ปกติ + ⏰ ${customTimes.join(', ')} น.` : '🔔 00:00, 07:00 น.' };
        }
        return { mode: 'standard', customTimes, allTimes: [...DEFAULT_STANDARD_ALERT_TIMES], badgeLabel: '🔔 00:00, 07:00 น.' };
    }

    function isUserCurrentlyLoggedIn() { return rawGet('elec_app_logged_in') === 'true'; }
    function rememberActiveAuthForLoggedOutAlerts() {
        if (!isUserCurrentlyLoggedIn()) return;
        const curUser = (rawGet('elec_app_current_user') || '').trim();
        const curRole = (rawGet('elec_app_current_role') || 'user').trim();
        const curGrp = normPmGrp((typeof window.getCurrentUserGroup === 'function' ? window.getCurrentUserGroup() : '') || rawGet('elec_app_current_group') || '');
        const apiUrl = (typeof window.getActiveCloudApiUrl === 'function' ? window.getActiveCloudApiUrl() : '').trim();
        localStorage.setItem(PM_HAS_SESSION_HISTORY_KEY, 'true');
        if (curUser) localStorage.setItem(PM_LAST_USER_KEY, curUser);
        if (curRole) localStorage.setItem(PM_LAST_ROLE_KEY, curRole);
        localStorage.setItem(PM_LAST_GROUP_KEY, curGrp);
        if (apiUrl) localStorage.setItem(PM_LAST_API_URL_KEY, apiUrl);
    }
    function hasRememberedPmSession() {
        if (isUserCurrentlyLoggedIn() || rawGet(PM_HAS_SESSION_HISTORY_KEY) === 'true') return true;
        if (rawGet(PM_LAST_GROUP_KEY) || rawGet('elec_last_logged_group_name')) return true;
        try { return JSON.parse(rawGet(PM_STORAGE_KEY) || '[]').some(p => p && !p.pmDeleted); } catch (e) { return false; }
    }
    function getEffectiveRoleAndExplicitGroup() {
        if (isUserCurrentlyLoggedIn()) {
            return {
                role: rawGet('elec_app_current_role') || 'user',
                explicitGroup: normPmGrp((typeof window.getCurrentUserGroup === 'function' ? window.getCurrentUserGroup() : '') || rawGet('elec_app_current_group') || '')
            };
        }
        return { role: rawGet(PM_LAST_ROLE_KEY) || 'user', explicitGroup: normPmGrp(rawGet(PM_LAST_GROUP_KEY) || rawGet('elec_last_logged_group_name') || '') };
    }
    function getActivePmGroup() {
        const { explicitGroup } = getEffectiveRoleAndExplicitGroup();
        if (explicitGroup) return explicitGroup;
        return normPmGrp(pmPlans.find(p => p && !p.pmDeleted && p.ownerGroup)?.ownerGroup || 'กฟส.บึง') || 'กฟส.บึง';
    }

    function ensureLeafletReady() {
        if (typeof L !== 'undefined' && L.map) return Promise.resolve(true);
        if (leafletLoadPromise) return leafletLoadPromise;
        leafletLoadPromise = new Promise((resolve) => {
            if (!document.querySelector('link[href*="leaflet.css"]')) {
                const link = document.createElement('link'); link.rel = 'stylesheet';
                link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(link);
            }
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            script.onload = () => { if (typeof bindLeafletMapHooks === 'function') bindLeafletMapHooks(); resolve(true); };
            script.onerror = () => { leafletLoadPromise = null; resolve(false); };
            document.head.appendChild(script);
        });
        return leafletLoadPromise;
    }

    function toLocalIsoDate(dateObj) {
        const d = dateObj instanceof Date ? dateObj : new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function getTodayIso() { return toLocalIsoDate(new Date()); }
    function parseIsoToMidnightMs(isoStr) {
        if (!isoStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(isoStr).trim())) return NaN;
        const [y, m, d] = String(isoStr).trim().split('-').map(Number);
        return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    }
    function calcDaysUntil(targetIso, baseIso = getTodayIso()) {
        const tMs = parseIsoToMidnightMs(targetIso), bMs = parseIsoToMidnightMs(baseIso);
        return (isNaN(tMs) || isNaN(bMs)) ? 99999 : Math.round((tMs - bMs) / 86400000);
    }
    function addMonthsToIsoDate(isoStr, monthsToAdd) {
        if (!isoStr || !/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return getTodayIso();
        const [y, m, d] = isoStr.split('-').map(Number);
        const totalMonths = (y * 12) + (m - 1) + Number(monthsToAdd || 0);
        const targetYear = Math.floor(totalMonths / 12), targetMonthIdx = ((totalMonths % 12) + 12) % 12;
        const maxDay = new Date(targetYear, targetMonthIdx + 1, 0).getDate();
        return toLocalIsoDate(new Date(targetYear, targetMonthIdx, Math.min(d, maxDay)));
    }
    function formatThaiDateFull(isoStr) {
        if (!isoStr || !String(isoStr).includes('-')) return '-';
        const [y, m, d] = String(isoStr).split('-').map(Number);
        return (!y || !m || !d) ? isoStr : `${THAI_DAYS_SHORT[new Date(y, m - 1, d).getDay()] || ''} ${d} ${THAI_MONTHS[m - 1]} ${y + 543}`;
    }
    function formatThaiDateShort(isoStr) {
        if (!isoStr || !String(isoStr).includes('-')) return '-';
        const [y, m, d] = String(isoStr).split('-').map(Number);
        return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y + 543}`;
    }
    function formatThaiDayMonthShort(isoStr) {
        if (!isoStr || !String(isoStr).includes('-')) return '';
        const [, m, d] = String(isoStr).split('-').map(Number);
        return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
    }

    function canManagePmSchedule() {
        return isUserCurrentlyLoggedIn() && !safeIsViewer() && safeCanEditScada() && !(Core?.simSandbox?.active);
    }
    function canCompletePmTask() {
        return isUserCurrentlyLoggedIn() && !safeIsViewer() && !(Core?.simSandbox?.active);
    }
    function canSeePmPlan(plan) {
        if (!plan || plan.pmDeleted) return false;
        const { role, explicitGroup } = getEffectiveRoleAndExplicitGroup();
        if (role === 'admin' && !explicitGroup) return true;
        return normPmGrp(plan.ownerGroup || 'กฟส.บึง') === getActivePmGroup();
    }
    function getCategoryMeta(catKey) { return PM_CATEGORIES[catKey] || PM_CATEGORIES.scada; }
    function getPlanPinVisualTheme(item) {
        const cat = getCategoryMeta(item?.category);
        const chosenKey = (item?.pinColor && PM_PIN_COLORS[item.pinColor] && item.pinColor !== 'auto') ? item.pinColor : cat.defaultColor;
        const cMeta = PM_PIN_COLORS[chosenKey] || PM_PIN_COLORS.sky;
        return { icon: cat.icon, catName: cat.name, hex: cMeta.hex, grad: cMeta.grad };
    }

    // ========================================================================
    // 2. จัดการคลังแผนงาน & บีบอัด Shard (รองรับ ph, oz, pbn และรายชื่อสถานที่ pbp)
    // ========================================================================
    const MAX_RECENT_TRANSITION_QUOTA = 15;
    const RECENT_TRANSITION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

    function normalizePmOutageZone(rawZone) {
        if (!rawZone || typeof rawZone !== 'object') return null;
        if (rawZone.t === 'c' && Array.isArray(rawZone.c) && rawZone.c.length >= 2) {
            const la = parseFloat(rawZone.c[0]), lo = parseFloat(rawZone.c[1]), r = Math.round(Number(rawZone.r) || 0);
            if (!isNaN(la) && !isNaN(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && r >= 20 && r <= 20000) {
                return { t: 'c', c: [Number(la.toFixed(5)), Number(lo.toFixed(5))], r };
            }
        }
        if (rawZone.t === 'p' && Array.isArray(rawZone.p)) {
            const pts = rawZone.p
                .filter(pt => Array.isArray(pt) && pt.length >= 2 && !isNaN(parseFloat(pt[0])) && !isNaN(parseFloat(pt[1])))
                .slice(0, 30)
                .map(pt => [Number(parseFloat(pt[0]).toFixed(5)), Number(parseFloat(pt[1]).toFixed(5))]);
            if (pts.length >= 3) return { t: 'p', p: pts };
        }
        return null;
    }

        function slimPlanForCloud(p, grp) {
        if (!p || !p.id) return null;
        if (p.pmDeleted) return { id: p.id, ownerGroup: grp, pmDeleted: true, updatedAt: p.updatedAt };
        const cleanOz = normalizePmOutageZone(p.oz);
        const isPubActive = Boolean(p.pub && cleanOz);
        const isArchivedDone = (p.status === 'done' && calcDaysUntil(p.date) < 0);
        const out = {
            id: p.id, title: p.title || '', category: p.category || 'scada',
            date: p.date || '', status: p.status || 'pending',
            ownerGroup: grp, updatedAt: p.updatedAt
        };
        if (p.pinColor && p.pinColor !== 'auto') out.pinColor = p.pinColor;
        if (isPubActive || (p.timeSlot && p.timeSlot !== '09.00-12.00')) {
            out.timeSlot = p.timeSlot || '09.00-12.00';
        }
        if (Number(p.notifyDaysBefore ?? 3) !== 3) out.notifyDaysBefore = Number(p.notifyDaysBefore);
        if (Number(p.repeatMonths || 0) > 0) out.repeatMonths = Number(p.repeatMonths);
        const cTimes = normalizeCustomTimesArray(p.customAlertTimes || []);
        if (cTimes.length > 0) out.customAlertTimes = cTimes;
        if ((p.alertMode && p.alertMode !== 'standard') || (p.alertMode === 'standard' && cTimes.length > 0)) {
            out.alertMode = p.alertMode;
        }
        if (p.alertBaselineAt) out.alertBaselineAt = p.alertBaselineAt;
        if (p.createdAt) out.createdAt = p.createdAt;
        if (p.linkedPinId) out.linkedPinId = p.linkedPinId;
        if (p.equipCode) out.equipCode = p.equipCode;
        if (p.feeder) out.feeder = p.feeder;
        if (p.note) out.note = String(p.note).slice(0, 300);
        const pIds = normalizePmPhotoIds(p);
        if (pIds.length > 0) out.ph = pIds;
        if (cleanOz && !isArchivedDone) out.oz = cleanOz;
        if (isPubActive && p.status !== 'done') out.pub = 1;
        if (p.pubNote && !isArchivedDone) out.pbn = String(p.pubNote).slice(0, 180);
if (p.pubPlaces && !isArchivedDone) out.pbp = String(p.pubPlaces).slice(0, 900);
        if (!isNaN(parseFloat(p.lat)) && !isNaN(parseFloat(p.lon))) {
            out.lat = Number(Number(p.lat).toFixed(6));
            out.lon = Number(Number(p.lon).toFixed(6));
        } else if (p.gpsLink) out.gpsLink = p.gpsLink;
        if (p.completedAt) out.completedAt = p.completedAt;
        if (p.completedBy) out.completedBy = p.completedBy;
        if (p.spawnedNextCycle) out.spawnedNextCycle = true;
        if (p.createdBy) out.createdBy = p.createdBy;
        if (p.updatedBy) out.updatedBy = p.updatedBy;
        return out;
    }

    function expandPlanDefaults(raw) {
        if (!raw || !raw.id) return null;
        const grp = normPmGrp(raw.ownerGroup || 'กฟส.บึง') || 'กฟส.บึง';
        if (raw.pmDeleted) return { id: raw.id, ownerGroup: grp, pmDeleted: true, updatedAt: raw.updatedAt };
        const hasCoord = !isNaN(parseFloat(raw.lat)) && !isNaN(parseFloat(raw.lon));
        const lat = hasCoord ? Number(Number(raw.lat).toFixed(6)) : null;
        const lon = hasCoord ? Number(Number(raw.lon).toFixed(6)) : null;
        const cTimes = normalizeCustomTimesArray(raw.customAlertTimes || []);
        const photoIds = normalizePmPhotoIds(raw);
        const oz = normalizePmOutageZone(raw.oz);
        const pub = Boolean((raw.pub === 1 || raw.pub === true) && oz);
        const pubNote = String(raw.pubNote ?? raw.pbn ?? '').trim();
        const pubPlaces = String(raw.pubPlaces ?? raw.pbp ?? '').trim();
        const cleanedRaw = { ...raw };
        delete cleanedRaw.ph;
        delete cleanedRaw.pbn;
        delete cleanedRaw.pbp;
        return {
            ...cleanedRaw,
            photoIds, oz, pub, pubNote, pubPlaces,
            pinColor: raw.pinColor || 'auto',
            timeSlot: raw.timeSlot || '09.00-12.00',
            notifyDaysBefore: Number(raw.notifyDaysBefore ?? 3),
            repeatMonths: Number(raw.repeatMonths ?? 0),
            alertMode: raw.alertMode || (cTimes.length > 0 ? 'both' : 'standard'),
            customAlertTimes: cTimes,
            equipCode: raw.equipCode || '',
            feeder: raw.feeder || '',
            note: raw.note || '',
            lat, lon,
            gpsLink: hasCoord ? `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}` : (raw.gpsLink || ''),
            status: raw.status || 'pending',
            ownerGroup: grp
        };
    }

    function prunePmPlansArray(rawArr) {
        if (!Array.isArray(rawArr)) return [];
        const now = Date.now(), byId = new Map();
        rawArr.forEach(rawItem => {
            const item = expandPlanDefaults(rawItem);
            if (!item) return;
            const updMs = new Date(item.updatedAt || 0).getTime() || 0;
            if (item.pmDeleted && updMs > 0 && (now - updMs > MAX_TOMBSTONE_AGE_MS)) return;
            const ex = byId.get(item.id);
            const exMs = ex ? (new Date(ex.updatedAt || 0).getTime() || 0) : -1;
            if (!ex || updMs > exMs || (updMs === exMs && item.pmDeleted && !ex.pmDeleted)) {
                byId.set(item.id, item);
            }
        });
        return Array.from(byId.values()).sort((a, b) =>
            (a.pmDeleted !== b.pmDeleted ? (a.pmDeleted ? 1 : -1) : 0) ||
            String(a.date || '').localeCompare(String(b.date || '')) ||
            String(a.timeSlot || '').localeCompare(String(b.timeSlot || ''))
        );
    }

    function loadPmPlansFromStorage() {
        try { pmPlans = prunePmPlansArray(JSON.parse(rawGet(PM_STORAGE_KEY) || '[]')); } catch (e) { pmPlans = []; }
        return pmPlans;
    }

        function selectPrioritizedCloudEntries(entriesArr, grp) {
        const now = Date.now();
        const valid = entriesArr.filter(([, p]) => {
            if (!p?.id) return false;
            const updMs = new Date(p.updatedAt || 0).getTime() || 0;
            if (p.pmDeleted) return (now - updMs) <= MAX_TOMBSTONE_AGE_MS;
            if (p.status === 'done') {
                const dMs = parseIsoToMidnightMs(p.date);
                return isNaN(dMs) || (now - dMs) <= MAX_DONE_CLOUD_AGE_MS;
            }
            return true;
        });

        const recentDeleted = valid
            .filter(([, p]) => p.pmDeleted && (now - (new Date(p.updatedAt || 0).getTime() || 0)) <= RECENT_TRANSITION_AGE_MS)
            .sort((a, b) => (new Date(b[1].updatedAt || 0).getTime() || 0) - (new Date(a[1].updatedAt || 0).getTime() || 0))
            .slice(0, 12);

        const activePending = valid
            .filter(([, p]) => !p.pmDeleted && p.status !== 'done')
            .sort((a, b) => Math.abs(calcDaysUntil(a[1].date)) - Math.abs(calcDaysUntil(b[1].date)));

        const recentDone = valid
            .filter(([, p]) => !p.pmDeleted && p.status === 'done')
            .sort((a, b) => (new Date(b[1].updatedAt || 0).getTime() || 0) - (new Date(a[1].updatedAt || 0).getTime() || 0));

        const seenIds = new Set();
        const byPriority = [];
        for (const pair of [...recentDeleted, ...activePending, ...recentDone]) {
            if (!seenIds.has(pair[0])) {
                seenIds.add(pair[0]);
                byPriority.push(pair);
                if (byPriority.length >= MAX_CLOUD_SYNC_ITEMS) break;
            }
        }

        const slimmed = [];
        let charBudget = 0;
        for (const [id, item] of byPriority) {
            const slim = slimPlanForCloud(item, grp);
            if (!slim) continue;
            const len = JSON.stringify(slim).length + id.length + 6;
            if (charBudget + len > MAX_SHARD_JSON_CHARS && slimmed.length >= 15) break;
            charBudget += len;
            slimmed.push([id, slim]);
        }
        return slimmed;
    }

    function buildCloudCarrierMapForGroup(groupName) {
        const targetGrp = normPmGrp(groupName) || 'กฟส.บึง';
        const pairs = pmPlans
            .filter(p => normPmGrp(p.ownerGroup || 'กฟส.บึง') === targetGrp)
            .map(p => [p.id, p]);
        return Object.fromEntries(selectPrioritizedCloudEntries(pairs, targetGrp));
    }

    function writePmShardsIntoLocMap(locMapObj) {
        const locMap = locMapObj || safeGetLocMap();
        const activeGrp = getActivePmGroup();
        const { role, explicitGroup } = getEffectiveRoleAndExplicitGroup();
        const groups = new Set([activeGrp]);
        if (role === 'admin' && !explicitGroup) {
            pmPlans.forEach(p => { if (p?.ownerGroup) groups.add(normPmGrp(p.ownerGroup)); });
        }
        const fallbackIso = new Date().toISOString();

        groups.forEach(grp => {
            if (!grp) return;
            const shardKey = PM_LOC_PREFIX + grp;
            const exShard = locMap[shardKey];
            const combinedShard = { ...(exShard?.pmPlansMap || {}) };

            pmPlans.forEach(p => {
                if (!p?.id || normPmGrp(p.ownerGroup || 'กฟส.บึง') !== grp) return;
                const ex = combinedShard[p.id];
                const pMs = new Date(p.updatedAt || 0).getTime() || 0;
                const exMs = ex ? (new Date(ex.updatedAt || 0).getTime() || 0) : -1;
                if (!ex || pMs > exMs || (pMs === exMs && (p.pmDeleted || !ex.pmDeleted))) {
                    combinedShard[p.id] = p;
                }
            });

            const trimmedEntries = selectPrioritizedCloudEntries(Object.entries(combinedShard), grp);
            if (trimmedEntries.length === 0 && !exShard) return;

            const nextPlansMap = Object.fromEntries(trimmedEntries);
            const prevMapSig = JSON.stringify(exShard?.pmPlansMap || {});
            const nextMapSig = JSON.stringify(nextPlansMap);
            const prevShardMs = new Date(exShard?.updatedAt || 0).getTime() || 0;
            let maxUpdMs = prevShardMs;
            trimmedEntries.forEach(([, p]) => {
                const t = new Date(p.updatedAt || 0).getTime() || 0;
                if (t > maxUpdMs) maxUpdMs = t;
            });
            if (nextMapSig !== prevMapSig) {
                maxUpdMs = Math.max(Date.now(), maxUpdMs, prevShardMs + 1000);
            }
            const shardIso = maxUpdMs > 0 ? new Date(maxUpdMs).toISOString() : fallbackIso;

            locMap[shardKey] = {
                isSystemRegistry: true, username: '', group: grp, isOnline: false, gpsDisabled: true,
                lat: null, lon: null, pmPlansMap: nextPlansMap, lastSeenAt: shardIso, updatedAt: shardIso
            };
        });
        return locMap;
    }

    // ========================================================================
    // 2.2 ซิงค์ข้ามแท็บ / Iframe / Cloud พร้อม Timeout กันค้าง & กันยิงซ้อน
    // ========================================================================
    function mergeIncomingPmItems(incomingArr, triggerAlertCheck = true) {
        if (!Array.isArray(incomingArr) || incomingArr.length === 0) return false;
        const memBeforeSig = JSON.stringify(pmPlans);
        loadPmPlansFromStorage();
        const storageBeforeSig = JSON.stringify(pmPlans);
        const merged = prunePmPlansArray([...pmPlans, ...incomingArr]);
        const mergedSig = JSON.stringify(merged);
        pmPlans = merged;
        if (mergedSig !== storageBeforeSig) {
            localStorage.setItem(PM_STORAGE_KEY, mergedSig);
        }
        if (mergedSig !== memBeforeSig || mergedSig !== storageBeforeSig) {
            if (typeof refreshPmAllViews === 'function') refreshPmAllViews();
            if (triggerAlertCheck && typeof checkAndTriggerScheduledPmAlerts === 'function') checkAndTriggerScheduledPmAlerts(false);
            return true;
        }
        return false;
    }

    async function pullPmPlansWhileLoggedOut() {
        if (isUserCurrentlyLoggedIn() || !(rawGet('elec_app_session_token') || '').trim()) return false;
        const baseApiUrl = getActivePmCloudUrl();
        if (!baseApiUrl) return false;
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 4500) : null;
        try {
            const { role, explicitGroup } = getEffectiveRoleAndExplicitGroup();
            if (Core && typeof Core.forceCloudRead === 'function') Core.forceCloudRead();
            const sep = baseApiUrl.includes('?') ? '&' : '?';
            const res = await fetch(`${baseApiUrl}${sep}group=${encodeURIComponent(explicitGroup || getActivePmGroup())}&role=${encodeURIComponent(role)}&t=${Date.now()}`, {
                cache: 'no-store', signal: ctrl ? ctrl.signal : undefined
            });
            const data = await res.json();
            const locReg = Array.isArray(data?.jobs) ? data.jobs.find(j => j && j.jobType === 'tech_loc') : null;
            if (!locReg?.techLocations) return false;
            const cloudItems = [];
            Object.keys(locReg.techLocations).forEach(k => {
                if (k.startsWith(PM_LOC_PREFIX) && locReg.techLocations[k]?.pmPlansMap) {
                    Object.values(locReg.techLocations[k].pmPlansMap).forEach(it => { if (it?.id) cloudItems.push(it); });
                }
            });
            return mergeIncomingPmItems(cloudItems, false);
        } catch (e) { return false; }
        finally { if (timer) clearTimeout(timer); }
    }

    function broadcastPmLocalInstant(requestParentCloudPush = false) {
        const pkt = { type: 'PM_PLANS_SYNC', plans: pmPlans, pushCloudFromIframe: Boolean(requestParentCloudPush), ts: Date.now() };
        try { pmBroadcast?.postMessage(pkt); } catch (e) {}
        try {
            if (window.parent && window.parent !== window) window.parent.postMessage(pkt, '*');
            document.getElementById('leftBrowserIframe')?.contentWindow?.postMessage(pkt, '*');
        } catch (e) {}
    }

    if (pmBroadcast) pmBroadcast.onmessage = (e) => { if (e.data?.type === 'PM_PLANS_SYNC') mergeIncomingPmItems(e.data.plans); };
    window.addEventListener('message', (e) => {
        if (e.data?.type === 'PM_PLANS_SYNC') {
            mergeIncomingPmItems(e.data.plans);
            if (e.data.pushCloudFromIframe && !(Core && Core.isEmbeddedIframe) && typeof savePmPlansAndSync === 'function') {
                savePmPlansAndSync(true);
            }
        }
    });
    window.addEventListener('storage', (e) => { if (e.key === PM_STORAGE_KEY && e.newValue) { try { mergeIncomingPmItems(JSON.parse(e.newValue)); } catch (err) {} } });
    // ===== จบพาทที่ 1 / 6 ของไฟล์ pm-calendar.js =====
        // ===== เริ่มพาทที่ 2 / 6 ของไฟล์ pm-calendar.js =====
    // ========================================================================
    // 2.3 ตัวดักซิงค์คลาวด์, เอนจินบีบอัด/อัปโหลด/ดึงรูปภาพ PM & ระบบแจ้งเตือนตามเวลา
    // ========================================================================
    let inFlightGasCount = 0;
    let pendingPmSyncSeq = 0;
    let ackedPmSyncSeq = 0;
    let hasPendingPmCloudSync = false;
    let fallbackCloudTimer = null;

    const _origFetchForPm = window.fetch;
    window.fetch = async function (input, init) {
        const urlStr = typeof input === 'string' ? input : (input?.url || '');
        const isGas = urlStr.includes('script.google.com');
        let didAttachPmWrite = false;
        let attachedSyncSeq = 0;

        if (isGas && init && init.method === 'POST' && typeof init.body === 'string' && (isUserCurrentlyLoggedIn() || hasPendingPmCloudSync)) {
            if (init.body.includes('"saveJobs"') || init.body.includes('"patchDelta"')) {
                try {
                    loadPmPlansFromStorage();
                    const bodyObj = JSON.parse(init.body);
                    if (bodyObj.action === 'saveJobs' && Array.isArray(bodyObj.jobs)) {
                        let targetReg = bodyObj.jobs.find(j => j && j.jobType === 'tech_loc');
                        if (!targetReg) {
                            targetReg = { id: 'TECH_LOC_REGISTRY', jobType: 'tech_loc', techLocations: safeGetLocMap(), updatedAt: new Date().toISOString() };
                            bodyObj.jobs.push(targetReg);
                        }
                        targetReg.techLocations = writePmShardsIntoLocMap(targetReg.techLocations || safeGetLocMap());
                        const nextBodyStr = JSON.stringify(bodyObj);
                        init = { ...init, body: nextBodyStr, ...(init.keepalive && new Blob([nextBodyStr]).size > 55000 ? { keepalive: false } : {}) };
                        didAttachPmWrite = true;
                        attachedSyncSeq = pendingPmSyncSeq;
                    } else if (bodyObj.action === 'patchDelta' && (bodyObj.techLocDelta || hasPendingPmCloudSync)) {
                        if (!bodyObj.techLocDelta) {
                            bodyObj.techLocDelta = { id: 'TECH_LOC_REGISTRY', jobType: 'tech_loc', techLocations: safeGetLocMap(), updatedAt: new Date().toISOString() };
                        }
                        bodyObj.techLocDelta.techLocations = writePmShardsIntoLocMap(bodyObj.techLocDelta.techLocations || safeGetLocMap());
                        const nextBodyStr = JSON.stringify(bodyObj);
                        init = { ...init, body: nextBodyStr, ...(init.keepalive && new Blob([nextBodyStr]).size > 55000 ? { keepalive: false } : {}) };
                        didAttachPmWrite = true;
                        attachedSyncSeq = pendingPmSyncSeq;
                    }
                } catch (e) {}
            }
        }
        if (isGas) inFlightGasCount++;
        try {
            const response = await _origFetchForPm.call(this, input, init);
            if (didAttachPmWrite && response && (response.ok || response.type === 'opaque')) {
                let gasWriteOk = true;
                if (response.ok) {
                    try {
                        const rj = await response.clone().json();
                        if (rj && (rj.status === 'error' || rj.result === 'error' || rj.ok === false || rj.skippedBusyRam || rj.skippedQuota || rj.skippedViewer || rj.patched === false)) {
                            gasWriteOk = false;
                        }
                    } catch (e) {}
                }
                if (gasWriteOk) {
                    if (attachedSyncSeq > ackedPmSyncSeq) ackedPmSyncSeq = attachedSyncSeq;
                    hasPendingPmCloudSync = ackedPmSyncSeq < pendingPmSyncSeq;
                }
            }
            if (isGas && (!init || !init.method || init.method.toUpperCase() === 'GET')) {
                try {
                    const data = await response.clone().json();
                    const locReg = Array.isArray(data?.jobs) ? data.jobs.find(j => j && j.jobType === 'tech_loc') : null;
                    if (locReg?.techLocations) {
                        const cloudItems = [];
                        Object.keys(locReg.techLocations).forEach(k => {
                            if (k.startsWith(PM_LOC_PREFIX) && locReg.techLocations[k]?.pmPlansMap) {
                                Object.values(locReg.techLocations[k].pmPlansMap).forEach(it => { if (it?.id) cloudItems.push(it); });
                            }
                        });
                        if (cloudItems.length > 0) mergeIncomingPmItems(cloudItems);
                    }
                } catch (e) {}
            }
            return response;
        } finally {
            if (isGas) inFlightGasCount = Math.max(0, inFlightGasCount - 1);
        }
    };

    // ========================================================================
    // 2.4 เอนจินจัดการรูปภาพแผนงาน PM (ย่อรูป <canvas>, อัปโหลด Drive, ลบรูปเก่า & ดึงไฟล์แชร์ LINE)
    // ========================================================================
    function getPmAuthPayloadFields() {
        const authUser = (rawGet('elec_app_current_user') || rawGet(PM_LAST_USER_KEY) || '').trim();
        const authToken = (
            rawGet('elec_app_session_token') ||
            rawGet('elec_app_auth_token') ||
            rawGet('elec_tech_session_token') ||
            ''
        ).trim();
        return { authUser, authToken };
    }

    async function postPmGasAction(payload) {
        const apiUrl = getActivePmCloudUrl();
        if (!apiUrl || !apiUrl.includes('script.google.com')) {
            throw new Error('ไม่พบลิงก์ Google Apps Script สำหรับจัดการรูปภาพ');
        }
        if (Core?.unlockCloudWrite) Core.unlockCloudWrite(20000);
        const authFields = getPmAuthPayloadFields();
        const bodyObj = {
            ...authFields,
            group: getActivePmGroup(),
            ...payload
        };
        const res = await window.fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(bodyObj)
        });
        const data = await res.json().catch(() => null);
        if (!data) throw new Error(`เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (HTTP ${res.status})`);
        return data;
    }

    function loadImageElementFromFile(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            let objUrl = '';
            try { objUrl = URL.createObjectURL(file); } catch (e) {}
            if (objUrl) {
                img.onload = () => { URL.revokeObjectURL(objUrl); resolve(img); };
                img.onerror = () => {
                    URL.revokeObjectURL(objUrl);
                    const reader = new FileReader();
                    reader.onload = ev => {
                        const img2 = new Image();
                        img2.onload = () => resolve(img2);
                        img2.onerror = () => reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ'));
                        img2.src = ev.target.result;
                    };
                    reader.onerror = () => reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ'));
                    reader.readAsDataURL(file);
                };
                img.src = objUrl;
            } else {
                const reader = new FileReader();
                reader.onload = ev => {
                    img.onload = () => resolve(img);
                    img.onerror = () => reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ'));
                    img.src = ev.target.result;
                };
                reader.onerror = () => reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ'));
                reader.readAsDataURL(file);
            }
        });
    }

    async function compressImageFileForPm(file) {
        if (!file || !String(file.type || '').startsWith('image/')) {
            throw new Error('กรุณาเลือกเฉพาะไฟล์รูปภาพเท่านั้น');
        }
        const img = await loadImageElementFromFile(file);
        let w = img.naturalWidth || img.width || 800;
        let h = img.naturalHeight || img.height || 600;
        if (w > PM_PHOTO_MAX_DIM || h > PM_PHOTO_MAX_DIM) {
            const ratio = Math.min(PM_PHOTO_MAX_DIM / w, PM_PHOTO_MAX_DIM / h);
            w = Math.max(1, Math.round(w * ratio));
            h = Math.max(1, Math.round(h * ratio));
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        const dataUrl = canvas.toDataURL('image/jpeg', PM_PHOTO_QUALITY);
        const blob = await new Promise(res => {
            if (typeof canvas.toBlob === 'function') {
                canvas.toBlob(b => res(b), 'image/jpeg', PM_PHOTO_QUALITY);
            } else {
                res(null);
            }
        });
        return { dataUrl, blob };
    }

    async function uploadSinglePmPhotoFile(file, labelHint = 'PM') {
        const { dataUrl, blob } = await compressImageFileForPm(file);
        const cleanHint = String(labelHint || 'Plan').replace(/[\\/:*?"<>|#%\r\n]+/g, '_').slice(0, 28).trim() || 'Plan';
        const res = await postPmGasAction({
            action: 'uploadJobPhoto',
            jobLabel: `PM_${cleanHint}`,
            mimeType: 'image/jpeg',
            base64Data: dataUrl
        });
        if (!res || res.status === 'error' || res.ok === false || !res.fileId) {
            throw new Error(res?.message || 'อัปโหลดรูปขึ้น Google Drive ไม่สำเร็จ');
        }
        if (blob) rememberPmPhotoBlob(res.fileId, blob);
        return String(res.fileId).trim();
    }

    function trashUnusedPmPhotoIdsInBackground(candidateIds) {
        const ids = normalizePmPhotoIds(candidateIds);
        if (!ids.length || !isUserCurrentlyLoggedIn() || safeIsViewer()) return;
        loadPmPlansFromStorage();
        const stillUsed = new Set();
        pmPlans.forEach(p => {
            if (p && !p.pmDeleted) normalizePmPhotoIds(p).forEach(fid => stillUsed.add(fid));
        });
        const unusedIds = ids.filter(fid => !stillUsed.has(fid));
        if (!unusedIds.length) return;
        unusedIds.forEach(fid => pmPhotoBlobCache.delete(fid));
        postPmGasAction({ action: 'deleteJobPhoto', fileIds: unusedIds }).catch(() => {});
    }

    function base64ToBlobPm(b64Str, mimeType = 'image/jpeg') {
        const bin = atob(String(b64Str || '').replace(/\s+/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mimeType });
    }

    async function fetchPmPhotoFilesForShare(photoIds) {
        const cleanIds = normalizePmPhotoIds(photoIds);
        if (!cleanIds.length) return [];

        const blobById = new Map();
        const missingIds = [];
        cleanIds.forEach(fid => {
            if (pmPhotoBlobCache.has(fid)) blobById.set(fid, pmPhotoBlobCache.get(fid));
            else missingIds.push(fid);
        });

        if (missingIds.length > 0 && navigator.onLine !== false) {
            try {
                const gasRes = await postPmGasAction({ action: 'getJobPhotoBase64', fileIds: missingIds });
                if (gasRes && Array.isArray(gasRes.files)) {
                    gasRes.files.forEach(f => {
                        if (f?.fileId && f.base64Data) {
                            const b = base64ToBlobPm(f.base64Data, f.mimeType || 'image/jpeg');
                            rememberPmPhotoBlob(f.fileId, b);
                            blobById.set(f.fileId, b);
                        }
                    });
                }
            } catch (e) {}
        }

        const stillMissing = cleanIds.filter(fid => !blobById.has(fid));
        if (stillMissing.length > 0 && navigator.onLine !== false) {
            await Promise.all(stillMissing.map(async fid => {
                for (const url of [getPmPhotoDirectUrl(fid, 1280), getPmPhotoThumbUrl(fid, 1000)]) {
                    try {
                        const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
                        if (r.ok) {
                            const b = await r.blob();
                            if (b && b.size > 0 && String(b.type || '').startsWith('image/')) {
                                rememberPmPhotoBlob(fid, b);
                                blobById.set(fid, b);
                                break;
                            }
                        }
                    } catch (e) {}
                }
            }));
        }

        const files = [];
        cleanIds.forEach((fid, idx) => {
            const b = blobById.get(fid);
            if (!b) return;
            const ext = String(b.type || '').includes('png') ? 'png' : 'jpg';
            try {
                files.push(new File([b], `PEA_PM_${idx + 1}.${ext}`, { type: b.type || 'image/jpeg' }));
            } catch (e) {}
        });
        return files;
    }

    function buildPmPhotoStripHtml(item, sizeMode = 'card') {
        const pIds = normalizePmPhotoIds(item);
        if (!pIds.length) return '';
        const safePlanId = String(item.id || '').replace(/'/g, "\\'");
        const boxCls = sizeMode === 'popup'
            ? 'w-14 h-14 rounded-lg'
            : (sizeMode === 'banner' ? 'w-11 h-11 rounded-lg' : 'w-16 h-16 sm:w-[4.5rem] sm:h-[4.5rem] rounded-xl');
        const thumbs = pIds.map((fid, idx) => {
            const thumbSrc = safeEscHtml(getPmPhotoThumbUrl(fid, 400));
            const fallbackSrc = safeEscHtml(getPmPhotoDirectUrl(fid, 800));
            return `<button type="button" onclick="event.stopPropagation(); openPmPhotoLightbox('${safePlanId}', ${idx})" title="แตะเพื่อขยายดูรูปที่ ${idx + 1}/${pIds.length}" class="relative ${boxCls} overflow-hidden border border-slate-300 bg-slate-100 shrink-0 group shadow-sm hover:ring-2 hover:ring-indigo-500 transition"><img src="${thumbSrc}" loading="lazy" onerror="if(!this.dataset.fbk){this.dataset.fbk='1';this.src='${fallbackSrc}';}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"><span class="absolute bottom-0.5 right-0.5 bg-slate-900/80 text-white text-[8.5px] font-extrabold px-1 rounded">${idx + 1}/${pIds.length}</span></button>`;
        }).join('');
        return `<div class="flex items-center gap-1.5 overflow-x-auto py-0.5">${thumbs}</div>`;
    }

    async function savePmPlansAndSync(pushCloud = true) {
        rememberActiveAuthForLoggedOutAlerts();
        pmPlans = prunePmPlansArray(pmPlans);
        localStorage.setItem(PM_STORAGE_KEY, JSON.stringify(pmPlans));
        const isEmbed = Boolean(Core && Core.isEmbeddedIframe);
        broadcastPmLocalInstant(isEmbed && pushCloud);
        let syncedLocMap = {};
        isSyncingPmInternal = true;
        try {
            syncedLocMap = writePmShardsIntoLocMap(safeGetLocMap());
            if (Core?.unlockCloudWrite) Core.unlockCloudWrite(20000);
            localStorage.setItem('elec_tech_locations_map', JSON.stringify(syncedLocMap));
        } finally { isSyncingPmInternal = false; }
        if (typeof refreshPmAllViews === 'function') refreshPmAllViews();
        checkAndTriggerScheduledPmAlerts(false);

        if (pushCloud && !isEmbed) {
            const targetSeq = ++pendingPmSyncSeq;
            hasPendingPmCloudSync = true;
            if (Core?.unlockCloudWrite) Core.unlockCloudWrite(20000);
            if (typeof window.pushAllJobsToCloud === 'function') {
                window.pushAllJobsToCloud(true);
            } else if (typeof window.syncJobsWithFieldPage === 'function') {
                window.syncJobsWithFieldPage();
            }
            if (fallbackCloudTimer) clearTimeout(fallbackCloudTimer);
            const runFallbackCheck = (attempt = 0) => {
                if (ackedPmSyncSeq >= targetSeq || !hasPendingPmCloudSync || !navigator.onLine) return;
                if (inFlightGasCount > 0 && attempt < 3) {
                    fallbackCloudTimer = setTimeout(() => runFallbackCheck(attempt + 1), 2500);
                    return;
                }
                const apiUrl = getActivePmCloudUrl();
                if (apiUrl && apiUrl.includes('script.google.com')) {
                    loadPmPlansFromStorage();
                    const freshLocMap = writePmShardsIntoLocMap(safeGetLocMap());
                    const { role, explicitGroup } = getEffectiveRoleAndExplicitGroup();
                    const targetGroupParam = (role === 'admin' && !explicitGroup) ? '' : getActivePmGroup();
                    fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                        body: JSON.stringify({
                            ...getPmAuthPayloadFields(),
                            action: 'patchDelta',
                            group: targetGroupParam,
                            techLocDelta: { id: 'TECH_LOC_REGISTRY', jobType: 'tech_loc', techLocations: freshLocMap, updatedAt: new Date().toISOString() }
                        })
                    }).catch(() => {}).finally(() => {
                        if (ackedPmSyncSeq < targetSeq && attempt < 4) {
                            fallbackCloudTimer = setTimeout(() => runFallbackCheck(4), 6000);
                        }
                    });
                }
            };
            fallbackCloudTimer = setTimeout(() => runFallbackCheck(0), 5000);
        }
    }

    function syncPmPlansFromLocationsMap() {
        if (isSyncingPmInternal) return false;
        const locMap = safeGetLocMap(), incomingList = [];
        Object.keys(locMap).forEach(k => {
            if (k.startsWith(PM_LOC_PREFIX) && locMap[k]?.pmPlansMap) {
                Object.values(locMap[k].pmPlansMap).forEach(item => { if (item?.id) incomingList.push(item); });
            }
        });
        return mergeIncomingPmItems(incomingList);
    }

    function getVirtualScadaDueItems() {
        if (!showScadaDuePins) return [];
        try {
            const pins = JSON.parse(rawGet('elec_labeled_places_list') || '[]');
            const delMap = JSON.parse(rawGet('elec_deleted_labeled_places_map') || '{}');
            const { role, explicitGroup } = getEffectiveRoleAndExplicitGroup();
            return pins.filter(p => p?.id && p.dueDate && !delMap[p.id] && ((role === 'admin' && !explicitGroup) || normPmGrp(p.ownerGroup || 'กฟส.บึง') === getActivePmGroup()))
                .map(p => ({
                    id: 'scada_due_' + p.id, isScadaPinDue: true, linkedPinId: p.id, photoIds: [], pubPlaces: '',
                    title: `ครบกำหนดหมุด: ${p.name}`, category: 'scada', pinColor: 'auto',
                    alertMode: 'standard', customAlertTimes: [],
                    date: String(p.dueDate).trim(), timeSlot: '08.30 น.', notifyDaysBefore: 3,
                    equipCode: p.name || '', feeder: p.scadaNode?.fd || '', note: p.note || 'ตั้งเตือนวันครบกำหนดจากผังอุปกรณ์ไฟฟ้า',
                    lat: parseFloat(p.lat), lon: parseFloat(p.lon), gpsLink: `https://www.google.com/maps?q=${Number(p.lat).toFixed(6)},${Number(p.lon).toFixed(6)}`,
                    ownerGroup: normPmGrp(p.ownerGroup || 'กฟส.บึง') || 'กฟส.บึง', status: 'pending'
                }));
        } catch (e) { return []; }
    }

    function getAllVisibleCalendarItems() {
        loadPmPlansFromStorage();
        return [...pmPlans.filter(canSeePmPlan), ...getVirtualScadaDueItems()].sort((a, b) =>
            (a.status !== b.status ? (a.status === 'done' ? 1 : -1) : 0) ||
            String(a.date || '').localeCompare(String(b.date || '')) || String(a.timeSlot || '').localeCompare(String(b.timeSlot || ''))
        );
    }

    function getPlottablePmMapPins(forExternalMap = true) {
        const todayIso = getTodayIso();
        return getAllVisibleCalendarItems().filter(item => {
            if ((item.isScadaPinDue && forExternalMap) || item.status === 'done') return false;
            if (isNaN(parseFloat(item.lat)) || isNaN(parseFloat(item.lon))) return false;
            return pmMapFilterMode === 'alert' ? calcDaysUntil(item.date, todayIso) <= Number(item.notifyDaysBefore ?? 3) : true;
        });
    }

    // ========================================================================
    // 3. เอนจินแจ้งเตือนรายแผนงาน (ซิงค์ Ack ข้ามสถานะล็อกอิน + เตือนทันทีตรงนาที)
    // ========================================================================
    function getAlertCandidatesForToday() {
        const todayIso = getTodayIso();
        return getAllVisibleCalendarItems()
            .filter(item => item.status !== 'done' && item.date)
            .map(item => {
                const daysLeft = calcDaysUntil(item.date, todayIso);
                const warnDays = Number(item.notifyDaysBefore ?? 3);
                const alertLevel = daysLeft < 0 ? 'overdue' : (daysLeft === 0 ? 'today' : (daysLeft <= warnDays ? 'upcoming' : null));
                return alertLevel ? { ...item, daysLeft, alertLevel } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.daysLeft - b.daysLeft);
    }

    function getAckLogMap() { try { return JSON.parse(rawGet(PM_ACK_LOG_KEY) || '{}'); } catch (e) { return {}; } }
    function getDailyAckBucketKey(dateIso = getTodayIso()) {
        const who = (rawGet('elec_app_current_user') || rawGet(PM_LAST_USER_KEY) || 'station').trim();
        return `${who}__${getActivePmGroup()}__${dateIso}`;
    }
    function getEffectiveAckedSetForDate(dateIso = getTodayIso()) {
        const ackMap = getAckLogMap();
        return new Set([
            ...(ackMap[getDailyAckBucketKey(dateIso)] || []),
            ...(ackMap[`__GRP__${getActivePmGroup()}__${dateIso}`] || [])
        ]);
    }

    function hasAnyUnackedActiveAlertNow() {
        const candidates = getAlertCandidatesForToday();
        if (candidates.length === 0) return false;
        const now = new Date(), curMin = now.getHours() * 60 + now.getMinutes(), todayIso = toLocalIsoDate(now);
        const ackedSet = getEffectiveAckedSetForDate(todayIso);
        return candidates.some(item => {
            const cfg = getPlanEffectiveAlertConfig(item);
            if (cfg.mode === 'off' || cfg.allTimes.length === 0) return false;
            return cfg.allTimes.some(t => timeHHMMToMinutes(t) <= curMin && !isSlotBeforePlanBaseline(item, todayIso, t) && !ackedSet.has(`${item.id}@${t}`));
        });
    }

    function preAckPastSlotsForPlanToday(planObj) {
        if (!planObj?.id) return;
        const now = new Date(), curMin = now.getHours() * 60 + now.getMinutes(), todayIso = toLocalIsoDate(now);
        const pastSlots = getPlanEffectiveAlertConfig(planObj).allTimes.filter(t => timeHHMMToMinutes(t) < curMin);
        if (pastSlots.length === 0) return;
        const ackMap = getAckLogMap(), bKey = getDailyAckBucketKey(todayIso), gKey = `__GRP__${getActivePmGroup()}__${todayIso}`;
        const setB = new Set(ackMap[bKey] || []), setG = new Set(ackMap[gKey] || []);
        pastSlots.forEach(t => { const tok = `${planObj.id}@${t}`; setB.add(tok); setG.add(tok); firedAlertTokensInSession.add(`${todayIso}__${tok}`); });
        ackMap[bKey] = Array.from(setB); ackMap[gKey] = Array.from(setG);
        localStorage.setItem(PM_ACK_LOG_KEY, JSON.stringify(ackMap));
    }

    function acknowledgeCurrentPmAlertRound() {
        const realTodayIso = getTodayIso(), ackDateIso = lastActivePopupDateIso || realTodayIso, ackMap = getAckLogMap();
        const bKey = getDailyAckBucketKey(ackDateIso), gKey = `__GRP__${getActivePmGroup()}__${ackDateIso}`;
        const setB = new Set(ackMap[bKey] || []), setG = new Set(ackMap[gKey] || []);
        lastActivePopupAckTokens.forEach(tok => { setB.add(tok); setG.add(tok); firedAlertTokensInSession.add(`${ackDateIso}__${tok}`); });
        ackMap[bKey] = Array.from(setB); ackMap[gKey] = Array.from(setG);
        const keys = Object.keys(ackMap);
        if (keys.length > 60) keys.slice(0, keys.length - 60).forEach(k => delete ackMap[k]);
        isPopupOpenedByForcePreview = false; lastActivePopupDateIso = '';
        localStorage.setItem(PM_ACK_LOG_KEY, JSON.stringify(ackMap));
        document.getElementById('pmAlertPopupModal')?.classList.add('hidden');
        safeToast('✅ รับทราบการแจ้งเตือนแผนงานรอบนี้แล้ว (หยุดเสียงเตือนซ้ำ)');
        if (ackDateIso !== realTodayIso) setTimeout(() => checkAndTriggerScheduledPmAlerts(false), 150);
    }

    let sharedPmAudioCtx = null;
    function ensurePmAudioUnlocked() {
        if (Core && Core.isEmbeddedIframe) return null;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return null;
            if (!sharedPmAudioCtx || sharedPmAudioCtx.state === 'closed') sharedPmAudioCtx = new AudioCtx();
            if (sharedPmAudioCtx.state === 'suspended') sharedPmAudioCtx.resume().catch(() => {});
            if (sharedPmAudioCtx.state === 'running') ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(ev => window.removeEventListener(ev, ensurePmAudioUnlocked));
            return sharedPmAudioCtx;
        } catch (e) { return null; }
    }
    if (!(Core && Core.isEmbeddedIframe)) ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(ev => window.addEventListener(ev, ensurePmAudioUnlocked, { passive: true }));

    function nextPmUpdatedIso(prevIso) {
        const prevMs = prevIso ? (new Date(prevIso).getTime() || 0) : 0;
        return new Date(Math.max(Date.now(), prevMs + 1000)).toISOString();
    }

    function playPmAlertChime(isRepeatWave = false) {
        if (!isPmSoundEnabled || (Core && Core.isEmbeddedIframe)) return;
        try {
            if (navigator.vibrate) navigator.vibrate(isRepeatWave ? [250, 100, 250, 100, 320] : [220, 100, 220]);
            const ctx = ensurePmAudioUnlocked();
            if (!ctx) return;
            const baseT = ctx.currentTime + 0.02, notes = isRepeatWave ? [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5] : [523.25, 659.25, 783.99, 1046.5];
            notes.forEach((freq, idx) => {
                const osc = ctx.createOscillator(), gain = ctx.createGain(), startT = baseT + idx * 0.14;
                osc.type = 'triangle'; osc.frequency.setValueAtTime(freq, startT);
                gain.gain.setValueAtTime(0.18, startT); gain.gain.exponentialRampToValueAtTime(0.001, startT + 0.28);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch (e) {} };
                osc.start(startT); osc.stop(startT + 0.28);
            });
        } catch (e) {}
    }

    async function fireCornerSystemNotification(roundTitle, list, tagSuffix) {
        if ((Core && Core.isEmbeddedIframe) || !('Notification' in window) || Notification.permission !== 'granted') return;
        const opts = {
            body: `🏢 ${getActivePmGroup()}: แจ้งเตือน ${list.length} งาน\n• ${list.slice(0, 2).map(c => `${c.title}${c.latestSlot ? ` (${c.latestSlot} น.)` : ''}`).join('\n• ')}`,
            tag: 'pea-pm-alert-' + tagSuffix, renotify: true, requireInteraction: true
        };
        try { const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null; if (reg?.showNotification) return await reg.showNotification(roundTitle, opts); } catch (e) {}
        try { const n = new Notification(roundTitle, opts); n.onclick = () => { window.focus(); if (isUserCurrentlyLoggedIn() && typeof _safeOpenPmCalendarModal === 'function') _safeOpenPmCalendarModal(); n.close(); }; } catch (e) {}
    }

    function checkAndTriggerScheduledPmAlerts(forceShow = false) {
        rememberActiveAuthForLoggedOutAlerts();
        if ((Core && Core.isEmbeddedIframe) || !hasRememberedPmSession()) return;
        const now = new Date(), curMin = now.getHours() * 60 + now.getMinutes(), todayIso = toLocalIsoDate(now);
        if (lastActivePopupDateIso && lastActivePopupDateIso !== todayIso && !isPopupOpenedByForcePreview) {
            lastActivePopupDateIso = ''; lastActivePopupAckTokens = [];
            document.getElementById('pmAlertPopupModal')?.classList.add('hidden');
        }
        const allCandidates = getAlertCandidatesForToday();
        if (typeof updatePmHeaderBadgesAndStrip === 'function' && isUserCurrentlyLoggedIn()) updatePmHeaderBadgesAndStrip(allCandidates);
        if (allCandidates.length === 0) return;

        const curMinKey = `${todayIso}_${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const ackedSet = getEffectiveAckedSetForDate(todayIso);
        const triggeredItems = [], tokensToAck = [], newlyFiredSlots = [], allUnackedSlots = [];
        let hasNewlyReachedSlot = false;

        allCandidates.forEach(item => {
            const cfg = getPlanEffectiveAlertConfig(item);
            if (!forceShow && (cfg.mode === 'off' || cfg.allTimes.length === 0)) return;
            const reached = cfg.allTimes.filter(t => timeHHMMToMinutes(t) <= curMin && (forceShow || !isSlotBeforePlanBaseline(item, todayIso, t)));
            const unacked = reached.filter(t => !ackedSet.has(`${item.id}@${t}`));
            if (forceShow || unacked.length > 0) {
                unacked.forEach(t => {
                    allUnackedSlots.push(t);
                    const sessionKey = `${todayIso}__${item.id}@${t}`;
                    if (!firedAlertTokensInSession.has(sessionKey)) { firedAlertTokensInSession.add(sessionKey); hasNewlyReachedSlot = true; newlyFiredSlots.push(t); }
                });
                reached.forEach(t => tokensToAck.push(`${item.id}@${t}`));
                triggeredItems.push({ ...item, latestSlot: unacked[unacked.length - 1] || reached[reached.length - 1] || cfg.allTimes[0] || '' });
            }
        });

        if (triggeredItems.length === 0) return;
        const shouldRepeatThisMinute = isPmRepeatEveryMin && (allUnackedSlots.length > 0) && (lastRepeatAlertMinuteKey !== curMinKey);
        if (!forceShow && !hasNewlyReachedSlot && !shouldRepeatThisMinute) return;

        isPopupOpenedByForcePreview = Boolean(forceShow && !hasNewlyReachedSlot && allUnackedSlots.length === 0);
        lastRepeatAlertMinuteKey = curMinKey; lastActivePopupAckTokens = tokensToAck; lastActivePopupDateIso = todayIso;

        const isRepeatWave = !forceShow && !hasNewlyReachedSlot && shouldRepeatThisMinute;
        const sortedNew = normalizeCustomTimesArray(newlyFiredSlots), sortedUnacked = normalizeCustomTimesArray(allUnackedSlots);
        const topSlot = sortedNew[sortedNew.length - 1] || sortedUnacked[sortedUnacked.length - 1] || triggeredItems[0]?.latestSlot || '';
        const baseRoundTitle = topSlot === '00:00' ? '🌙 แจ้งเตือนแผนงานบำรุงรักษารอบเที่ยงคืน (00.00 น.)'
            : (topSlot === '07:00' ? '🌅 แจ้งเตือนแผนงานบำรุงรักษารอบเช้า (07.00 น.)' : (topSlot ? `⏰ แจ้งเตือนตามเวลาแผนงาน (${topSlot} น.)` : '🔔 แจ้งเตือนแผนงานบำรุงรักษา (PM)'));
        const roundTitle = isRepeatWave ? `🔁 [เตือนซ้ำ] ${baseRoundTitle}` : baseRoundTitle;

        playPmAlertChime(isRepeatWave);
        fireCornerSystemNotification(roundTitle, triggeredItems, `${todayIso}_${topSlot || 'pm'}`);
        if (typeof showPmAlertSummaryModal === 'function') showPmAlertSummaryModal(roundTitle, triggeredItems);
    }
    // ===== จบพาทที่ 2 / 6 ของไฟล์ pm-calendar.js =====
        // ===== เริ่มพาทที่ 3 / 6 ของไฟล์ pm-calendar.js =====
    // ========================================================================
    // 4. สไตล์ชีต, แถบเครื่องมือผัง SCADA, แบนเนอร์หน้าช่าง & บอลลูนหมุดพร้อมปุ่มโพสต์ FB/LINE
    // ========================================================================
    let isQuickInlineBoxVisible = false;
    let desktopModalWidthMode = '65vw';

    function injectPmCalendarStyles() {
        if (document.getElementById('peaPmCalendarStyles')) return;
        const st = document.createElement('style');
        st.id = 'peaPmCalendarStyles';
        st.textContent = `
            #toast { z-index: 1500 !important; }
            #customAlertModal, #customConfirmModal, #customPromptModal { z-index: 1480 !important; }
            #pmCalendarModal h3 { flex-wrap: wrap !important; row-gap: 0.25rem !important; }
            #pmHeaderGroupBadge { white-space: nowrap !important; flex-shrink: 0 !important; }
            .pm-day-cell { min-height: 60px; transition: all 0.15s ease; }

            /* ขยายหน้าปฏิทินและฟอร์มแผน PM เต็มจอมือถือชิดขอบ 100% (ไร้ขอบมืดรอบนอก) */
            @media (max-width: 639px) {
                #pmCalendarModal,
                #pmPlanFormModal {
                    padding: 0 !important;
                    align-items: stretch !important;
                }
                #pmCalendarModal .pm-calendar-dialog,
                #pmPlanFormModal > div {
                    width: 100% !important;
                    max-width: 100% !important;
                    height: 100vh !important;
                    height: 100dvh !important;
                    max-height: 100vh !important;
                    max-height: 100dvh !important;
                    border-radius: 0 !important;
                    border: 0 !important;
                    box-shadow: none !important;
                }
                #pmCalendarModal .pm-calendar-dialog > div:first-child,
                #pmPlanFormModal > div > div:first-child {
                    padding-top: max(0.75rem, env(safe-area-inset-top)) !important;
                    padding-left: 0.85rem !important;
                    padding-right: 0.85rem !important;
                }
                #pmPlanFormModal > div > div:last-child {
                    padding-bottom: max(0.75rem, env(safe-area-inset-bottom)) !important;
                }
                #pmCalendarModal .pm-desktop-split {
                    padding: 0 0 max(0.75rem, env(safe-area-inset-bottom)) 0 !important;
                    gap: 0.5rem !important;
                }
                #pmCalendarModal .pm-desktop-split > div {
                    border-radius: 0 !important;
                    border-left: 0 !important;
                    border-right: 0 !important;
                    padding: 0.75rem 0.6rem !important;
                    box-shadow: none !important;
                }
                #pmSelectedDayTasksContainer {
                    max-height: none !important;
                    overflow-y: visible !important;
                }
            }

            @media (min-width: 640px) { .pm-day-cell { min-height: 76px; } }
            @media (min-width: 1024px) {
                #pmCalendarModal .pm-calendar-dialog { width: var(--pm-desktop-w, 65vw) !important; max-width: var(--pm-desktop-w, 65vw) !important; min-height: 84dvh; }
                #pmCalendarModal .pm-desktop-split { grid-template-columns: minmax(0, 65fr) minmax(0, 35fr) !important; }
                .pm-day-cell { min-height: 94px; padding: 6px !important; }
            }
            .pm-day-cell:hover { background-color: #f0f9ff; border-color: #60a5fa; }
            .pm-day-selected { background-color: #eff6ff !important; border-color: #2563eb !important; box-shadow: inset 0 0 0 1.5px #2563eb; }
            .pm-badge-pulse { animation: pmPulseGlow 1.8s infinite ease-in-out; }
            @keyframes pmPulseGlow { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.06); } }
            .pm-plan-pin-wrap { position: relative; width: 34px; height: 40px; display: flex; flex-direction: column; align-items: center; }
            .pm-plan-pin-head { position: relative; z-index: 2; width: 30px; height: 30px; border-radius: 10px 10px 10px 3px; transform: rotate(-45deg); border: 2.5px solid #ffffff; box-shadow: 0 4px 10px rgba(15,23,42,0.45); display: flex; align-items: center; justify-content: center; }
            .pm-plan-pin-head > span { transform: rotate(45deg); font-size: 15px; line-height: 1; }
            .pm-plan-pin-date { position: absolute; top: -9px; right: -12px; z-index: 4; background: #0f172a; color: #fde047; border: 1.5px solid #ffffff; border-radius: 9999px; padding: 0 4px; font-size: 8.5px; font-weight: 800; line-height: 13px; white-space: nowrap; box-shadow: 0 2px 5px rgba(0,0,0,0.4); }
            .pm-plan-pin-cam { position: absolute; bottom: 5px; left: -5px; z-index: 4; background: #4f46e5; color: #ffffff; border: 1.5px solid #ffffff; border-radius: 9999px; width: 15px; height: 15px; font-size: 8.5px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 4px rgba(0,0,0,0.35); }
            .pm-plan-pin-pulse { position: absolute; top: -3px; left: -1px; width: 36px; height: 36px; border-radius: 9999px; animation: pmPinRingWave 1.7s infinite ease-out; pointer-events: none; z-index: 1; }
            @keyframes pmPinRingWave { 0% { transform: scale(0.8); opacity: 0.9; } 100% { transform: scale(1.65); opacity: 0; } }
            .pm-plan-pin-moving .pm-plan-pin-head { box-shadow: 0 0 0 4px #22d3ee, 0 6px 14px rgba(0,0,0,0.5) !important; }
            .pm-plan-tooltip { background: rgba(15,23,42,0.93) !important; color: #f8fafc !important; border: 1.5px solid #818cf8 !important; border-radius: 0.5rem !important; padding: 2px 7px !important; font-family: 'Prompt',sans-serif !important; font-size: 10.5px !important; font-weight: 700 !important; }
            .pm-pin-drop-active-map { cursor: crosshair !important; }
            #labeledInteractiveMap.pm-pin-drop-active-map .leaflet-scadaUnifiedLinesPane-pane,
            #labeledInteractiveMap.pm-pin-drop-active-map .leaflet-scadaUnifiedLinesPane-pane *,
            #labeledInteractiveMap.pm-pin-drop-active-map .leaflet-overlay-pane svg,
            #labeledInteractiveMap.pm-pin-drop-active-map .leaflet-overlay-pane canvas,
            #repairJobsMapCanvas.pm-pin-drop-active-map .leaflet-overlay-pane svg,
            #repairJobsMapCanvas.pm-pin-drop-active-map .leaflet-overlay-pane canvas,
            #repairJobsLeafletMap.pm-pin-drop-active-map .leaflet-overlay-pane svg,
            #repairJobsLeafletMap.pm-pin-drop-active-map .leaflet-overlay-pane canvas { pointer-events: none !important; }
            body.role-viewer-readonly .pm-edit-only, body.scada-sim-active .pm-edit-only { display: none !important; }
        `;
        document.head.appendChild(st);
    }

    function setPmDesktopModalWidth(widthVal) {
        desktopModalWidthMode = widthVal || '65vw';
        const dlg = document.querySelector('#pmCalendarModal .pm-calendar-dialog');
        if (dlg) dlg.style.setProperty('--pm-desktop-w', desktopModalWidthMode);
        ['65vw', '80vw', '95vw'].forEach(w => {
            const btn = document.getElementById('pmDesktopWBtn-' + w);
            if (btn) btn.className = w === desktopModalWidthMode ? 'px-2 py-0.5 rounded bg-amber-400 text-slate-950 font-extrabold text-[10px]' : 'px-2 py-0.5 rounded text-blue-100 hover:bg-white/15 font-semibold text-[10px]';
        });
        if (calendarLeftViewMode === 'map') setTimeout(() => calendarMapInstance?.invalidateSize(), 120);
    }

    function injectPmButtonsIntoScadaToolbar() {
        const scadaBar = document.getElementById('scadaControlToolbar');
        const rightGroup = scadaBar?.querySelector('.flex.items-center.gap-1\\.5.flex-wrap:last-child');
        if (!rightGroup) return;
        if (!document.getElementById('btnTogglePmMapPins')) {
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button'; toggleBtn.id = 'btnTogglePmMapPins';
            toggleBtn.onclick = () => toggleShowPmPinsOnMaps();
            rightGroup.insertBefore(toggleBtn, rightGroup.firstChild);
        }
        if (!document.getElementById('btnDropNewPmPinOnScada')) {
            const dropBtn = document.createElement('button');
            dropBtn.type = 'button'; dropBtn.id = 'btnDropNewPmPinOnScada';
            dropBtn.onclick = () => togglePmPinDropMode(undefined, 'scada');
            rightGroup.insertBefore(dropBtn, document.getElementById('btnTogglePmMapPins').nextSibling);
        }
        ['btnToggleScadaDrawMode', 'btnToggleWireMoveMode', 'btnTogglePinMoveMode', 'btnToggleScadaSimMode'].forEach(id => {
            const b = document.getElementById(id);
            if (b && !b.__pmCancelBound) { b.__pmCancelBound = true; b.addEventListener('click', () => { if (pmPinDropModeActive || pmPinMoveTargetId) cancelPmMapInteractiveModes(); }); }
        });
        updateScadaToolbarPmButtonsUI();
    }

    function updateScadaToolbarPmButtonsUI() {
        const pinCount = getPlottablePmMapPins(true).length, toggleBtn = document.getElementById('btnTogglePmMapPins');
        if (toggleBtn) {
            toggleBtn.textContent = showPmPinsOnMaps ? `📅 หมุดแผน (${pinCount})` : '📅 หมุดแผน: ซ่อน';
            toggleBtn.className = showPmPinsOnMaps ? 'bg-indigo-700 hover:bg-indigo-600 text-indigo-100 border border-indigo-400/60 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow transition' : 'bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-600 px-2.5 py-1 rounded-xl text-[11px] font-bold transition';
        }
        const dropBtn = document.getElementById('btnDropNewPmPinOnScada');
        if (dropBtn) {
            dropBtn.style.display = canManagePmSchedule() ? '' : 'none';
            dropBtn.textContent = pmPinDropModeActive ? '❌ ยกเลิกปักแผน' : '📍 ปักหมุดแผน';
            dropBtn.className = pmPinDropModeActive ? 'pm-edit-only bg-amber-400 text-slate-950 border border-white px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow animate-pulse' : 'pm-edit-only bg-indigo-500 hover:bg-indigo-400 text-white px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow transition';
        }
    }

    function injectPmHeaderButtonsAndStrip() {
        const mainHeaderGrp = document.querySelector('#mainAppContent .bg-gradient-to-r .flex.items-center.gap-1\\.5.shrink-0');
        if (mainHeaderGrp && !document.getElementById('pmMainHeaderBtn')) {
            const btn = document.createElement('button');
            btn.type = 'button'; btn.id = 'pmMainHeaderBtn'; btn.onclick = () => _safeOpenPmCalendarModal();
            btn.className = 'bg-indigo-500/90 hover:bg-indigo-600 text-white px-2.5 py-1.5 rounded-xl text-xs transition shadow-sm flex items-center gap-1 font-semibold border border-indigo-300/40';
            btn.innerHTML = `📅 <span>แผน PM</span><span id="pmMainAlertCountBadge" class="hidden bg-rose-500 text-white text-[10px] font-extrabold px-1.5 rounded-full">0</span>`;
            const backupBtn = mainHeaderGrp.querySelector('button[onclick="openBackupModal()"]');
            if (backupBtn) mainHeaderGrp.insertBefore(btn, backupBtn); else mainHeaderGrp.appendChild(btn);
        }
        const techHeaderGrp = document.querySelector('#techMainApp .bg-gradient-to-r .flex.flex-wrap.items-center.gap-1\\.5');
        if (techHeaderGrp && !document.getElementById('pmTechHeaderBtn')) {
            const btn = document.createElement('button');
            btn.type = 'button'; btn.id = 'pmTechHeaderBtn'; btn.onclick = () => _safeOpenPmCalendarModal();
            btn.className = 'bg-indigo-500/90 hover:bg-indigo-600 text-white px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm flex items-center gap-1 border border-indigo-300/40';
            btn.innerHTML = `📅 <span>แผน PM</span><span id="pmTechAlertCountBadge" class="hidden bg-rose-500 text-white text-[10px] font-extrabold px-1.5 rounded-full">0</span>`;
            techHeaderGrp.insertBefore(btn, techHeaderGrp.firstChild);
        }
        const jobCardsEl = document.getElementById('jobCardsContainer');
        if (jobCardsEl?.parentElement && !document.getElementById('pmTechQueueBannerWrap')) {
            const wrap = document.createElement('div');
            wrap.id = 'pmTechQueueBannerWrap'; wrap.className = 'hidden px-4 pt-2 pb-1';
            jobCardsEl.parentElement.insertBefore(wrap, document.getElementById('repairJobsMapWrapper') || document.getElementById('repairJobsMapSection') || jobCardsEl);
        }
        injectPmButtonsIntoScadaToolbar();
    }

    function togglePmTechStripCollapse() { isTechStripCollapsed = !isTechStripCollapsed; lastRenderedTechStripSig = ''; updatePmHeaderBadgesAndStrip(); }

    function updatePmHeaderBadgesAndStrip(preCandidates = null) {
        injectPmHeaderButtonsAndStrip();
        const candidates = preCandidates || getAlertCandidatesForToday(), urgentCnt = candidates.filter(c => c.daysLeft <= 0).length;
        ['pmMainAlertCountBadge', 'pmTechAlertCountBadge'].forEach(id => {
            const el = document.getElementById(id); if (!el) return;
            if (candidates.length > 0 && isUserCurrentlyLoggedIn()) { el.textContent = String(candidates.length); el.className = `${urgentCnt > 0 ? 'bg-rose-500 pm-badge-pulse' : 'bg-amber-400 text-slate-950'} text-[10px] font-extrabold px-1.5 rounded-full shadow`; el.classList.remove('hidden'); }
            else el.classList.add('hidden');
        });
        const stripWrap = document.getElementById('pmTechQueueBannerWrap'); if (!stripWrap) return;
        if (candidates.length === 0 || !isUserCurrentlyLoggedIn()) {
            if (!stripWrap.classList.contains('hidden') || stripWrap.innerHTML !== '') { stripWrap.classList.add('hidden'); stripWrap.innerHTML = ''; }
            lastRenderedTechStripSig = ''; return;
        }
        stripWrap.classList.remove('hidden');
        const allowDone = canCompletePmTask();
        const rowsHtml = isTechStripCollapsed ? '' : `<div class="p-2.5 space-y-1.5 bg-white max-h-56 overflow-y-auto">${candidates.slice(0, 6).map(item => {
            const cat = getCategoryMeta(item.category), alCfg = getPlanEffectiveAlertConfig(item), safeId = String(item.id).replace(/'/g, "\\'"), hasCoord = !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lon)), pCount = normalizePmPhotoIds(item).length;
            const badge = item.daysLeft < 0 ? `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-extrabold px-1.5 py-0.5 rounded">เลย ${Math.abs(item.daysLeft)} วัน</span>` : (item.daysLeft === 0 ? `<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-1.5 py-0.5 rounded">📌 วันนี้</span>` : `<span class="bg-sky-50 text-sky-700 border border-sky-200 text-[10px] font-bold px-1.5 py-0.5 rounded">อีก ${item.daysLeft} วัน</span>`);
            return `<div class="p-2 rounded-xl border border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2 text-xs"><div class="min-w-0 flex-1 space-y-1"><div class="flex items-center gap-1.5 flex-wrap">${badge}<span class="font-bold text-slate-800 truncate">${cat.icon} ${safeEscHtml(item.title)}</span><span class="text-[10px] text-indigo-700 font-semibold">${safeEscHtml(alCfg.badgeLabel)}</span></div>${item.equipCode ? `<div class="text-[10px] text-teal-700 font-semibold">⚡ ${safeEscHtml(item.equipCode)}</div>` : ''}${pCount > 0 ? buildPmPhotoStripHtml(item, 'banner') : ''}</div><div class="flex items-center gap-1 shrink-0">${pCount > 0 ? `<button type="button" onclick="openPmPhotoLightbox('${safeId}', 0)" class="bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200 px-2 py-1 rounded-lg text-[10px] font-bold">🖼️ รูป (${pCount})</button>` : ''}${hasCoord ? `<button type="button" onclick="focusPmPlanPinOnMap('${safeId}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-1 rounded-lg text-[10px] font-bold">📍 ดูหมุด</button><button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">🗺️ นำทาง</button>` : ''}${(!item.isScadaPinDue && allowDone) ? `<button type="button" onclick="togglePmPlanCompleteStatus('${safeId}')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-1 rounded-lg text-[10px] font-bold">✅ เสร็จ</button>` : ''}</div></div>`;
        }).join('')}</div>`;
        const nextBannerHtml = `<div class="rounded-2xl border-2 border-indigo-400/80 overflow-hidden shadow-sm bg-white"><div class="bg-gradient-to-r from-indigo-900 via-blue-900 to-teal-800 px-3 py-2 text-white flex items-center justify-between gap-2"><div onclick="openPmCalendarModal()" class="cursor-pointer flex items-center gap-1.5 min-w-0 flex-1"><span>📅</span><span class="text-xs font-extrabold truncate">หมุดแผนบำรุงรักษา (PM): แจ้งเตือน ${candidates.length} รายการ</span></div><div class="flex items-center gap-1 shrink-0"><button type="button" onclick="openPmCalendarModal()" class="bg-white/20 hover:bg-white/30 text-white px-2 py-0.5 rounded-lg text-[10px] font-bold">ปฏิทิน/แมพ</button><button type="button" onclick="togglePmTechStripCollapse()" class="bg-white/15 hover:bg-white/25 text-white px-2 py-0.5 rounded-lg text-[10px] font-bold">${isTechStripCollapsed ? '🔽 ขยาย' : '🔼 ย่อ'}</button></div></div>${rowsHtml}</div>`;
        if (nextBannerHtml !== lastRenderedTechStripSig || stripWrap.innerHTML === '') { stripWrap.innerHTML = nextBannerHtml; lastRenderedTechStripSig = nextBannerHtml; }
    }

    // ========================================================================
    // 5. เอนจินวาด "หมุดแผนงาน" บนแผนที่ (พร้อมรูปตัวอย่างและปุ่มคัดลอกโพสต์แจ้งไฟดับ)
    // ========================================================================
    function buildPmPlanMarkerIcon(item, isMovingThis = false) {
        const vis = getPlanPinVisualTheme(item), daysLeft = calcDaysUntil(item.date, getTodayIso()), isUrgent = item.status !== 'done' && daysLeft <= 0;
        const hasPhotos = normalizePmPhotoIds(item).length > 0;
        const pulseHtml = isUrgent ? `<div class="pm-plan-pin-pulse" style="background:${daysLeft < 0 ? 'rgba(225,29,72,0.58)' : 'rgba(245,158,11,0.58)'};"></div>` : '';
        const camBadge = hasPhotos ? `<div class="pm-plan-pin-cam">📷</div>` : '';
        return L.divIcon({ className: isMovingThis ? 'pm-plan-pin-moving' : '', html: `<div class="pm-plan-pin-wrap" style="${item.status === 'done' ? 'opacity:0.55;filter:grayscale(0.5);' : ''}">${pulseHtml}<div class="pm-plan-pin-date">${safeEscHtml(formatThaiDayMonthShort(item.date))}</div>${camBadge}<div class="pm-plan-pin-head" style="background:${vis.grad};"><span>${vis.icon}</span></div></div>`, iconSize: [34, 40], iconAnchor: [17, 34], popupAnchor: [0, -32] });
    }

    function buildPmPlanPopupHtml(item) {
        const vis = getPlanPinVisualTheme(item), alCfg = getPlanEffectiveAlertConfig(item), daysLeft = calcDaysUntil(item.date, getTodayIso()), isDone = item.status === 'done', safeId = String(item.id).replace(/'/g, "\\'");
        const pCount = normalizePmPhotoIds(item).length;
        const statusTag = isDone ? '<span class="bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">✅ เสร็จสิ้นแล้ว</span>' : (daysLeft < 0 ? `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">🚨 เลยกำหนด ${Math.abs(daysLeft)} วัน</span>` : (daysLeft === 0 ? '<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">📌 กำหนดวันนี้</span>' : `<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-2 py-0.5 rounded-full">🗓️ อีก ${daysLeft} วัน</span>`));
        const allowEdit = !item.isScadaPinDue && canManagePmSchedule(), allowDone = !item.isScadaPinDue && canCompletePmTask();
        const photoStripHtml = pCount > 0 ? `<div class="pt-1">${buildPmPhotoStripHtml(item, 'popup')}</div>` : '';
        const pubZoneTag = (!isDone && ((item.pub && item.oz) || item.pubPlaces))
            ? `<div class="pt-0.5 space-y-1">${(item.pub && item.oz) ? '<div class="text-[10.5px] font-extrabold text-rose-600">📡 เปิดเรดาร์แจ้งดับไฟประชาชนแล้ว</div>' : ''}${item.pubPlaces ? `<div class="text-[10px] text-slate-600 bg-rose-50 border border-rose-200 rounded px-1.5 py-1">🏘️ <b>พื้นที่:</b> ${safeEscHtml(item.pubPlaces)}</div>` : ''}<button type="button" onclick="openPmPublicAnnounceModal('${safeId}')" style="background:#e11d48;color:#fff;padding:5px 8px;border-radius:8px;font-weight:800;font-size:10.5px;width:100%;">📢 คัดลอกโพสต์แจ้งไฟดับ (LINE / FB)</button></div>`
            : '';
        const lineBtnLabel = pCount > 0 ? `💬 ส่ง LINE + ${pCount} รูป` : '💬 แชร์ LINE';
        return `<div style="font-family:'Prompt',sans-serif;min-width:250px;" class="space-y-1.5 text-xs"><div class="flex items-center justify-between gap-1"><span class="px-2 py-0.5 rounded text-white text-[10px] font-extrabold" style="background:${vis.hex}">${vis.icon} หมุดแผนงาน PM</span>${statusTag}</div><div class="font-extrabold text-slate-900 text-sm break-words pt-0.5">${safeEscHtml(item.title)}</div><div class="text-[11px] text-slate-600 space-y-0.5"><div>📅 <b>วันที่:</b> ${formatThaiDateFull(item.date)} (${safeEscHtml(item.timeSlot || '-')})</div><div>⏰ <b>เวลาเตือน:</b> <span class="text-indigo-700 font-bold">${safeEscHtml(alCfg.badgeLabel)}</span></div>${item.equipCode ? `<div>⚡ <b>อุปกรณ์:</b> ${safeEscHtml(item.equipCode)} ${item.feeder ? `(วงจร ${safeEscHtml(item.feeder)})` : ''}</div>` : ''}${item.note ? `<div>📝 <b>รายละเอียด:</b> ${safeEscHtml(item.note)}</div>` : ''}${pubZoneTag}</div>${photoStripHtml}<div class="pt-1.5 border-t border-slate-200 grid grid-cols-2 gap-1"><button type="button" onclick="navigatePmPlanGps('${safeId}')" style="background:#2563eb;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;">🗺️ นำทาง Maps</button><button type="button" onclick="shareSinglePmPlanToLine('${safeId}')" style="background:#00B900;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;">${lineBtnLabel}</button>${allowDone ? `<button type="button" onclick="togglePmPlanCompleteStatus('${safeId}')" class="col-span-2" style="background:${isDone ? '#64748b' : '#059669'};color:#fff;padding:5px 8px;border-radius:8px;font-weight:800;font-size:11px;">${isDone ? '↩️ คืนสถานะรอดำเนินการ' : '✅ บันทึกดำเนินงานเสร็จสิ้น'}</button>` : ''}${allowEdit ? `<button type="button" onclick="openPmPlanFormModal('${safeId}')" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;padding:4px 8px;border-radius:8px;font-weight:700;font-size:10.5px;">✏️ แก้ไข/รูปภาพ</button><button type="button" onclick="startMovePmPlanPinOnMap('${safeId}')" style="background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;padding:4px 8px;border-radius:8px;font-weight:700;font-size:10.5px;">📍 ย้ายจุดหมุด</button>` : ''}</div></div>`;
    }

    function renderPmPinsOnTargetMap(mapInstance, layerGroup, storeObj, forExternalMap = true) {
        if (!mapInstance || !layerGroup || typeof L === 'undefined') return;
        if (forExternalMap && !showPmPinsOnMaps) { layerGroup.clearLayers(); Object.keys(storeObj).forEach(k => delete storeObj[k]); return; }
        const items = forExternalMap ? getPlottablePmMapPins(true) : getAllVisibleCalendarItems().filter(i => !isNaN(parseFloat(i.lat)) && !isNaN(parseFloat(i.lon)));
        const coordCount = {}, activeIds = new Set(), todayIso = getTodayIso();
        items.forEach(item => {
            const baseLat = parseFloat(item.lat), baseLon = parseFloat(item.lon);
            if (isNaN(baseLat) || isNaN(baseLon)) return;
            activeIds.add(item.id);
            const cKey = `${baseLat.toFixed(4)}_${baseLon.toFixed(4)}`, idx = coordCount[cKey] || (item.linkedPinId && forExternalMap ? 1 : 0);
            coordCount[cKey] = idx + 1;
            const ang = (idx * 55) * (Math.PI / 180), rad = idx > 0 ? 0.00011 * Math.ceil(idx / 5) : 0;
            const dispLat = baseLat + Math.sin(ang) * rad, dispLon = baseLon + Math.cos(ang) * rad;
            const isMoving = (pmPinMoveTargetId === item.id) && canManagePmSchedule(), vis = getPlanPinVisualTheme(item);
            const photoSig = normalizePmPhotoIds(item).join(',');
            const tipHtml = `${vis.icon} ${safeEscHtml(item.title)} (${formatThaiDayMonthShort(item.date)})`, popupHtml = buildPmPlanPopupHtml(item);
            const iconSig = `${item.status}|${item.date}|${vis.grad}|${vis.icon}|${calcDaysUntil(item.date, todayIso)}|${isMoving ? 1 : 0}|${photoSig}`;
            const existing = storeObj[item.id];
            if (existing && Boolean(existing._pmIsMoving) === isMoving) {
                const prevLL = existing.getLatLng();
                if (Math.abs(prevLL.lat - dispLat) > 1e-7 || Math.abs(prevLL.lng - dispLon) > 1e-7) existing.setLatLng([dispLat, dispLon]);
                if (existing._pmIconSig !== iconSig) { existing.setIcon(buildPmPlanMarkerIcon(item, isMoving)); existing._pmIconSig = iconSig; }
                if (existing._pmTipHtml !== tipHtml) { existing.setTooltipContent(tipHtml); existing._pmTipHtml = tipHtml; }
                if (existing._pmPopupHtml !== popupHtml) { existing.setPopupContent(popupHtml); existing._pmPopupHtml = popupHtml; }
                return;
            }
            if (existing) { layerGroup.removeLayer(existing); delete storeObj[item.id]; }
            const marker = L.marker([dispLat, dispLon], { icon: buildPmPlanMarkerIcon(item, isMoving), draggable: isMoving, zIndexOffset: 760 });
            marker._pmIsMoving = isMoving; marker._pmIconSig = iconSig; marker._pmTipHtml = tipHtml; marker._pmPopupHtml = popupHtml;
            marker.bindTooltip(tipHtml, { direction: 'top', offset: [0, -32], className: 'pm-plan-tooltip' });
            marker.bindPopup(popupHtml);
            if (isMoving) marker.on('dragend', ev => { const ll = ev.target.getLatLng(); commitMovedPmPlanPinLocation(item.id, ll.lat, ll.lng); });
            marker.addTo(layerGroup); storeObj[item.id] = marker;
        });
        Object.keys(storeObj).forEach(id => { if (!activeIds.has(id)) { layerGroup.removeLayer(storeObj[id]); delete storeObj[id]; } });
    }

    function renderAllExternalPmMapLayers() {
        discoverExistingLeafletMaps(); injectPmButtonsIntoScadaToolbar(); updateScadaToolbarPmButtonsUI();
        if (scadaMapRef && scadaPmLayer) renderPmPinsOnTargetMap(scadaMapRef, scadaPmLayer, scadaPmMarkersById, true);
        if (repairMapRef && repairPmLayer) renderPmPinsOnTargetMap(repairMapRef, repairPmLayer, repairPmMarkersById, true);
        if (calendarMapInstance && calendarPmLayer) {
            renderPmPinsOnTargetMap(calendarMapInstance, calendarPmLayer, calendarPmMarkersById, false);
            if (typeof renderZonesOnCalendarEmbeddedMap === 'function') renderZonesOnCalendarEmbeddedMap();
        }
    }
    function toggleShowPmPinsOnMaps() { showPmPinsOnMaps = !showPmPinsOnMaps; localStorage.setItem(PM_SHOW_MAP_PINS_KEY, String(showPmPinsOnMaps)); renderAllExternalPmMapLayers(); safeToast(showPmPinsOnMaps ? '📅 แสดงหมุดแผนงานบนแผนที่แล้ว' : '🚫 ซ่อนหมุดแผนงานชั่วคราว'); }
    function cyclePmMapFilterMode() { pmMapFilterMode = pmMapFilterMode === 'pending' ? 'alert' : 'pending'; localStorage.setItem(PM_MAP_FILTER_MODE_KEY, pmMapFilterMode); renderAllExternalPmMapLayers(); }

    function updatePinDropBannerOnMaps() {
        document.querySelectorAll('.pm-pin-drop-banner').forEach(el => el.remove());
        const isMove = Boolean(pmPinMoveTargetId), isAny = pmPinDropModeActive || isMove;
        ['labeledInteractiveMap', 'pmCalendarEmbeddedMap'].forEach(id => document.getElementById(id)?.classList.toggle('pm-pin-drop-active-map', isAny));
        ['repairJobsMapCanvas', 'repairJobsLeafletMap'].forEach(id => document.getElementById(id)?.classList.toggle('pm-pin-drop-active-map', isMove));
        updateScadaToolbarPmButtonsUI();
        const calDropBtn = document.getElementById('btnCalMapDropPin');
        if (calDropBtn) { calDropBtn.textContent = pmPinDropModeActive ? '❌ ยกเลิกปักหมุด' : '📍 จิ้มปักหมุดแผนใหม่'; calDropBtn.className = pmPinDropModeActive ? 'pointer-events-auto bg-amber-400 text-slate-950 border border-white px-3 py-1.5 rounded-xl text-[11px] font-extrabold shadow-lg animate-pulse' : 'pm-edit-only pointer-events-auto bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-xl text-[11px] font-extrabold shadow-lg'; }
        if (!isAny) return;
        const msg = isMove ? '📍 โหมดย้ายหมุดแผนงาน: ลากหมุด หรือแตะจุดใหม่บนแผนที่เพื่อวาง' : '📍 โหมดปักหมุดแผนงาน: แตะจุดที่ต้องการบนแผนที่เพื่อสร้างแผนงานใหม่';
        const targetMapIds = isMove ? ['labeledInteractiveMap', 'repairJobsMapCanvas', 'repairJobsLeafletMap', 'pmCalendarEmbeddedMap'] : ['labeledInteractiveMap', 'pmCalendarEmbeddedMap'];
        targetMapIds.map(id => document.getElementById(id)?.parentElement).filter(Boolean).forEach(wrap => {
            if (window.getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
            const b = document.createElement('div');
            b.className = 'pm-pin-drop-banner absolute top-3 left-1/2 -translate-x-1/2 z-[500] bg-indigo-950/95 text-amber-300 border border-amber-400 px-3 py-1.5 rounded-full text-[11px] font-extrabold shadow-xl flex items-center gap-2 whitespace-nowrap';
            b.innerHTML = `<span>${msg}</span><button type="button" onclick="cancelPmMapInteractiveModes()" class="bg-rose-600 text-white px-2 py-0.5 rounded-full text-[10px]">ยกเลิก</button>`;
            wrap.appendChild(b);
        });
    }

    function cancelPmMapInteractiveModes() { pmPinDropModeActive = false; pmPinMoveTargetId = null; updatePinDropBannerOnMaps(); renderAllExternalPmMapLayers(); }
    function togglePmPinDropMode(forceState, targetMapType = 'scada') {
        if (!canManagePmSchedule()) { safeToast('🔒 เฉพาะแอดมินและผู้ใช้งานทั่วไปเท่านั้นที่ปักหมุดแผนงานได้'); return; }
        pmPinMoveTargetId = null; pmPinDropModeActive = typeof forceState === 'boolean' ? forceState : !pmPinDropModeActive;
        if (pmPinDropModeActive && targetMapType === 'scada') { window.toggleScadaDrawMode?.(false); window.toggleScadaWireMoveMode?.(false); window.toggleScadaPinMoveMode?.(false); }
        updatePinDropBannerOnMaps(); if (pmPinDropModeActive) safeToast('👆 แตะจุดที่ต้องการบนแผนที่เพื่อปักหมุดแผนงานได้เลย');
    }
    function startMovePmPlanPinOnMap(planId) {
        if (!canManagePmSchedule()) return;
        pmPinDropModeActive = false; pmPinMoveTargetId = planId;
        scadaMapRef?.closePopup(); repairMapRef?.closePopup(); calendarMapInstance?.closePopup();
        updatePinDropBannerOnMaps(); renderAllExternalPmMapLayers(); safeToast('📍 ลากหมุดแผนงาน หรือแตะตำแหน่งใหม่บนแผนที่ได้เลย');
    }

    async function commitMovedPmPlanPinLocation(planId, newLat, newLon) {
        if (!canManagePmSchedule()) return cancelPmMapInteractiveModes();
        loadPmPlansFromStorage();
        const idx = pmPlans.findIndex(p => p.id === planId && !p.pmDeleted);
        if (idx === -1) return cancelPmMapInteractiveModes();
        const prevLat = parseFloat(pmPlans[idx].lat), prevLon = parseFloat(pmPlans[idx].lon);
        const nextLat = Number(Number(newLat).toFixed(6)), nextLon = Number(Number(newLon).toFixed(6));
        if (pmPlans[idx].oz) {
            if (pmPlans[idx].oz.t === 'c') {
                pmPlans[idx].oz = normalizePmOutageZone({ t: 'c', c: [nextLat, nextLon], r: pmPlans[idx].oz.r });
            } else if (pmPlans[idx].oz.t === 'p' && Array.isArray(pmPlans[idx].oz.p) && !isNaN(prevLat) && !isNaN(prevLon)) {
                const dLat = nextLat - prevLat, dLon = nextLon - prevLon;
                pmPlans[idx].oz = normalizePmOutageZone({
                    t: 'p',
                    p: pmPlans[idx].oz.p.map(pt => [pt[0] + dLat, pt[1] + dLon])
                });
            }
        }
        pmPlans[idx].lat = nextLat; pmPlans[idx].lon = nextLon;
        pmPlans[idx].gpsLink = `https://www.google.com/maps?q=${nextLat.toFixed(6)},${nextLon.toFixed(6)}`;
        delete pmPlans[idx].linkedPinId;
        pmPlans[idx].updatedBy = (rawGet('elec_app_current_user') || 'admin').trim();
        pmPlans[idx].updatedAt = nextPmUpdatedIso(pmPlans[idx].updatedAt);
        pmPinMoveTargetId = null; updatePinDropBannerOnMaps();
        await savePmPlansAndSync(true); safeToast(`📍 ย้ายตำแหน่งหมุดและโซนเรดาร์ "${pmPlans[idx].title}" เรียบร้อยแล้ว`);
    }

    async function focusPmPlanPinOnMap(itemId) {
        if (!isUserCurrentlyLoggedIn()) { safeToast('🔐 กรุณาเข้าสู่ระบบก่อนดูหมุดบนแผนที่'); return; }
        const item = getAllVisibleCalendarItems().find(x => x.id === itemId);
        if (!item || isNaN(parseFloat(item.lat)) || isNaN(parseFloat(item.lon))) { safeToast('⚠️ แผนงานนี้ยังไม่ได้ระบุพิกัดหมุดบนแผนที่'); return; }
        isPopupOpenedByForcePreview = false;
        document.getElementById('pmAlertPopupModal')?.classList.add('hidden');
        const lat = parseFloat(item.lat), lon = parseFloat(item.lon);
        if (document.getElementById('techMainApp') && item.status !== 'done' && typeof window.switchTechMainTab === 'function') {
            closePmCalendarModal();
            showPmPinsOnMaps = true; localStorage.setItem(PM_SHOW_MAP_PINS_KEY, 'true');
            if (pmMapFilterMode === 'alert') { pmMapFilterMode = 'pending'; localStorage.setItem(PM_MAP_FILTER_MODE_KEY, 'pending'); }
            window.switchTechMainTab('map');
            setTimeout(() => {
                renderAllExternalPmMapLayers();
                if (item.isScadaPinDue && item.linkedPinId && typeof window.focusSinglePinOnMap === 'function') window.focusSinglePinOnMap(item.linkedPinId);
                else if (scadaMapRef) { scadaMapRef.invalidateSize(); scadaMapRef.setView([lat, lon], 17); scadaPmMarkersById[item.id]?.openPopup(); }
            }, 250);
            return;
        }
        openPmCalendarModal(item.date);
        await switchCalendarLeftViewMode('map', true);
        setTimeout(() => { if (calendarMapInstance) { calendarMapInstance.invalidateSize(); calendarMapInstance.setView([lat, lon], 16); calendarPmMarkersById[item.id]?.openPopup(); } }, 220);
    }

    function bindSingleLeafletMapEvents(map) {
        if (!map || map.__pmHookBound) return;
        const mapDom = map.getContainer?.(), containerId = mapDom?.id || '';
        const isRepairMap = (containerId === 'repairJobsLeafletMap' || containerId === 'repairJobsMapCanvas');
        if (containerId !== 'labeledInteractiveMap' && !isRepairMap) return;
        map.__pmHookBound = true;
        if (mapDom && !mapDom.__pmCtxGuardBound) {
            mapDom.__pmCtxGuardBound = true;
            mapDom.addEventListener('contextmenu', ev => { if (pmPinDropModeActive || pmPinMoveTargetId) { ev.stopImmediatePropagation(); ev.preventDefault(); } }, true);
        }
        if (containerId === 'labeledInteractiveMap') {
            scadaMapRef = map; scadaPmLayer = L.layerGroup().addTo(map);
            map.on('popupopen', e => {
                if (!canManagePmSchedule()) return;
                const el = e.popup?.getElement?.(), html = e.popup?.getContent?.(), m = typeof html === 'string' ? html.match(/openEquipPinModal\('([^']+)'\)/) : null;
                if (m && el && !el.querySelector('.pm-create-from-scada-btn')) {
                    const btn = document.createElement('button'); btn.type = 'button';
                    btn.className = 'pm-create-from-scada-btn pm-edit-only w-full mt-1.5 py-1.5 px-2 rounded-lg font-extrabold text-[10px] text-white bg-gradient-to-r from-indigo-600 to-violet-600 shadow-sm';
                    btn.innerHTML = '📅 สร้างหมุดแผนงาน PM ที่อุปกรณ์นี้';
                    btn.onclick = () => { scadaMapRef?.closePopup(); openPmPlanFormModal(null, selectedDateIso || getTodayIso(), null, null, m[1]); };
                    (el.querySelector('.scada-popup-panel') || el.querySelector('.leaflet-popup-content > div'))?.appendChild(btn);
                }
            });
        } else { repairMapRef = map; repairPmLayer = L.layerGroup().addTo(map); }
        map.on('click', e => {
            if (!e.latlng) return;
            const scadaEl = document.getElementById('labeledInteractiveMap');
            if (scadaEl?.classList.contains('scada-draw-cursor') || scadaEl?.classList.contains('scada-move-wire-active') || scadaEl?.classList.contains('scada-move-pin-active') || document.body.classList.contains('scada-sim-active')) {
                if (pmPinDropModeActive || pmPinMoveTargetId) cancelPmMapInteractiveModes();
                return;
            }
            if (pmPinMoveTargetId) commitMovedPmPlanPinLocation(pmPinMoveTargetId, e.latlng.lat, e.latlng.lng);
            else if (pmPinDropModeActive && containerId === 'labeledInteractiveMap') { const { lat, lng } = e.latlng; cancelPmMapInteractiveModes(); openPmPlanFormModal(null, selectedDateIso || getTodayIso(), lat, lng); }
        });
        setTimeout(renderAllExternalPmMapLayers, 80);
    }

    const probedLeafletContainerIds = new Set();
    function discoverExistingLeafletMaps() {
        if (typeof L === 'undefined' || !L.Map) return;
        if (!scadaMapRef && window.__labeledLeafletMap) bindSingleLeafletMapEvents(window.__labeledLeafletMap);
        if (scadaMapRef && repairMapRef) return;
        let needResize = false;
        [['labeledInteractiveMap', scadaMapRef], ['repairJobsMapCanvas', repairMapRef], ['repairJobsLeafletMap', repairMapRef]].forEach(([id, ref]) => {
            if (ref || probedLeafletContainerIds.has(id)) return;
            const el = document.getElementById(id);
            if (el && (el._leaflet_id || el.classList.contains('leaflet-container'))) { probedLeafletContainerIds.add(id); needResize = true; }
        });
        if (needResize) setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    }

    function bindLeafletMapHooks() {
        if (typeof L === 'undefined' || !L.Map) return;
        if (!L.Map.__pmInitHookAdded) {
            L.Map.__pmInitHookAdded = true;
            L.Map.addInitHook(function () { setTimeout(() => bindSingleLeafletMapEvents(this), 50); });
            ['invalidateSize', 'setView', 'addLayer'].forEach(fnName => {
                const orig = L.Map.prototype[fnName];
                if (typeof orig === 'function' && !orig.__pmWrapped) {
                    const wrapped = function (...args) {
                        if (!this.__pmHookBound) {
                            const cid = this._container?.id || '';
                            if (cid === 'labeledInteractiveMap' || cid === 'repairJobsMapCanvas' || cid === 'repairJobsLeafletMap') {
                                setTimeout(() => bindSingleLeafletMapEvents(this), 0);
                            }
                        }
                        return orig.apply(this, args);
                    };
                    wrapped.__pmWrapped = true; L.Map.prototype[fnName] = wrapped;
                }
            });
        }
        discoverExistingLeafletMaps();
    }
    // ===== จบพาทที่ 3 / 6 ของไฟล์ pm-calendar.js =====
        // ===== เริ่มพาทที่ 4 / 6 ของไฟล์ pm-calendar.js =====
    // ========================================================================
    // 6. สร้าง DOM ปฏิทิน, ช่องแนบรูป 3 รูป, ตัวดูภาพเต็มจอ (Lightbox) & ช่องปักแผนด่วน
    // ========================================================================
    function injectPmModalsDOM() {
        if (document.getElementById('pmCalendarModal')) return;
        const catOptions = Object.values(PM_CATEGORIES).map(c => `<option value="${c.key}">${c.icon} ${c.name}</option>`).join('');
        const pinColorBtns = Object.values(PM_PIN_COLORS).map(c => `<button type="button" id="pmFormColorBtn-${c.key}" onclick="selectPmFormPinColor('${c.key}')" class="px-2 py-1 rounded-lg border text-[10px] font-bold transition">${c.label}</button>`).join('');
        const presetTimesBtns = ['06:30', '08:00', '08:30', '12:00', '13:00', '16:30'].map(t => `<button type="button" onclick="addPmCustomTimeChip('${t}')" class="px-2 py-0.5 rounded-md bg-white hover:bg-indigo-100 border border-indigo-200 text-[10px] font-bold text-indigo-700">+${t}</button>`).join('');
        document.body.insertAdjacentHTML('beforeend', `
            <div id="pmCalendarModal" class="fixed inset-0 bg-slate-950/70 hidden z-[1320] flex items-center justify-center p-2 sm:p-4 backdrop-blur-sm"><div class="pm-calendar-dialog bg-white rounded-2xl shadow-2xl w-full max-h-[94dvh] overflow-hidden flex flex-col border border-slate-200" style="--pm-desktop-w: 65vw;">
                <div class="px-4 py-3 bg-gradient-to-r from-indigo-900 via-blue-800 to-teal-700 text-white flex flex-wrap justify-between items-center gap-2 shrink-0">
                    <div class="flex items-center gap-2"><span class="text-lg">📅</span><div><h3 class="font-bold text-sm sm:text-base flex items-center gap-2"><span>ปฏิทิน &amp; หมุดแผนงานบำรุงรักษา (PM)</span><span id="pmHeaderGroupBadge" class="bg-white/20 text-amber-200 text-[10px] font-extrabold px-2 py-0.5 rounded-md">-</span></h3><p class="text-[10px] text-blue-100">แนบรูปหน้างาน 3 รูป + วาดเรดาร์ &amp; ดูดชื่อสถานที่แจ้งดับไฟ FB/LINE</p></div></div>
                    <div class="flex flex-wrap items-center gap-1.5">
                        <div class="hidden lg:inline-flex items-center bg-slate-900/45 border border-white/20 rounded-xl p-0.5 mr-1"><button type="button" id="pmDesktopWBtn-65vw" onclick="setPmDesktopModalWidth('65vw')" class="px-2 py-0.5 rounded bg-amber-400 text-slate-950 font-extrabold text-[10px]">65%</button><button type="button" id="pmDesktopWBtn-80vw" onclick="setPmDesktopModalWidth('80vw')" class="px-2 py-0.5 rounded text-blue-100 hover:bg-white/15 font-semibold text-[10px]">80%</button><button type="button" id="pmDesktopWBtn-95vw" onclick="setPmDesktopModalWidth('95vw')" class="px-2 py-0.5 rounded text-blue-100 hover:bg-white/15 font-semibold text-[10px]">95%</button></div>
                        <button type="button" id="pmNotifPermBtn" onclick="requestPmBrowserNotificationPermission()" class="bg-white/15 hover:bg-white/25 text-white px-2.5 py-1 rounded-xl text-[11px] font-bold">📲 แจ้งเตือนเครื่อง</button>
                        <button type="button" id="pmSoundToggleBtn" onclick="togglePmSoundSetting()" class="bg-white/15 hover:bg-white/25 text-white px-2.5 py-1 rounded-xl text-[11px] font-bold">🔔 เสียง: เปิด</button>
                        <button type="button" id="pmRepeatMinToggleBtn" onclick="togglePmRepeatEveryMinSetting()" class="bg-amber-400 hover:bg-amber-300 text-slate-950 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow transition">🔁 เตือนซ้ำทุกนาที: เปิด</button>
                        <button type="button" onclick="exportPmPlansToExcel()" class="bg-emerald-500 hover:bg-emerald-600 text-white px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow">📊 Excel</button>
                        <button type="button" onclick="shareDailyOrAlertSummaryToLine()" class="bg-[#00B900] hover:bg-[#009900] text-white px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow">💬 สรุปส่ง LINE</button>
                        <button type="button" onclick="closePmCalendarModal()" class="bg-rose-600 hover:bg-rose-700 active:scale-95 text-white border-2 border-white/75 px-3.5 py-1 rounded-xl text-[11px] font-extrabold shadow-md transition">✕ ออก</button>
                    </div>
                </div>
                <div class="pm-desktop-split p-3 sm:p-4 overflow-y-auto flex-1 bg-slate-50 grid grid-cols-1 gap-4 items-start">
                    <div class="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-2.5">
                        <div class="flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-slate-100"><div class="inline-flex bg-slate-100 p-1 rounded-xl text-xs font-extrabold"><button type="button" id="pmViewTab-grid" onclick="switchCalendarLeftViewMode('grid')" class="px-3 py-1 rounded-lg bg-indigo-600 text-white shadow-sm">🗓️ ตารางปฏิทิน</button><button type="button" id="pmViewTab-map" onclick="switchCalendarLeftViewMode('map')" class="px-3 py-1 rounded-lg text-slate-600">📍 แผนที่หมุดแผนงาน (<span id="pmCalMapPinCount">0</span>)</button></div><label class="flex items-center gap-1 text-[10px] font-bold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-1 rounded-lg cursor-pointer select-none"><input type="checkbox" id="pmShowScadaDueChk" onchange="toggleShowScadaDueOnCalendar(this.checked)" class="accent-teal-600 rounded"><span>รวมหมุดครบกำหนด SCADA</span></label></div>
                        <div id="pmMonthSummaryBar" class="grid grid-cols-4 gap-1.5 text-center text-[10px]"></div>
                        <div id="pmCalendarGridPanel" class="space-y-2"><div class="flex items-center justify-between gap-2"><div class="flex items-center gap-1"><button type="button" onclick="changePmCalendarMonth(-1)" class="px-2.5 py-1 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-extrabold">◀</button><button type="button" onclick="jumpPmCalendarToday()" class="px-2.5 py-1 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-xs font-bold">วันนี้</button><button type="button" onclick="changePmCalendarMonth(1)" class="px-2.5 py-1 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-extrabold">▶</button></div><h4 id="pmCalendarMonthTitle" class="text-sm sm:text-base font-extrabold text-slate-800">-</h4><span class="text-[10px] text-slate-400">แตะวันเพื่อดูงาน</span></div><div class="grid grid-cols-7 gap-1 text-center text-[11px] font-extrabold text-slate-500"><div class="text-rose-500">อา.</div><div>จ.</div><div>อ.</div><div>พ.</div><div>พฤ.</div><div>ศ.</div><div class="text-indigo-600">ส.</div></div><div id="pmCalendarDaysGrid" class="grid grid-cols-7 gap-1.5"></div></div>
                        <div id="pmCalendarMapPanel" class="hidden space-y-2"><div class="relative isolate rounded-2xl overflow-hidden border-2 border-indigo-200 bg-slate-100"><div id="pmCalendarEmbeddedMap" class="w-full h-[340px] lg:h-[480px] z-0"></div><div class="absolute bottom-2.5 left-2.5 right-2.5 z-[420] flex flex-wrap items-center justify-between gap-1.5 pointer-events-none"><button type="button" onclick="fitCalendarEmbeddedMapPins()" class="pointer-events-auto bg-white/95 hover:bg-white text-slate-800 border border-slate-300 px-2.5 py-1.5 rounded-xl text-[11px] font-bold shadow-lg">🎯 ซูมดูหมุดทั้งหมด</button><button type="button" id="btnCalMapDropPin" onclick="togglePmPinDropMode(undefined, 'calendar')" class="pm-edit-only pointer-events-auto bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-xl text-[11px] font-extrabold shadow-lg">📍 จิ้มปักหมุดแผนใหม่</button></div></div></div>
                    </div>
                    <div class="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm flex flex-col space-y-2.5"><div class="flex items-center justify-between gap-2"><div class="grid grid-cols-3 gap-1 flex-1 bg-slate-100 p-1 rounded-xl text-[11px] font-bold"><button type="button" id="pmFilterBtn-day" onclick="setPmListStatusFilter('day')" class="py-1 rounded-lg">📌 วันที่เลือก</button><button type="button" id="pmFilterBtn-alert" onclick="setPmListStatusFilter('alert')" class="py-1 rounded-lg">🔔 แจ้งเตือน</button><button type="button" id="pmFilterBtn-all" onclick="setPmListStatusFilter('all')" class="py-1 rounded-lg">📋 ทั้งเดือน</button></div><button type="button" id="pmAddPlanPrimaryBtn" onclick="togglePmQuickInlineBox()" class="pm-edit-only shrink-0 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-xl text-xs font-extrabold shadow-sm transition">➕ ปักแผนใหม่</button></div><div id="pmSelectedListHeader" class="text-xs font-bold text-slate-700 px-1 flex items-center justify-between"></div><div id="pmSelectedDayTasksContainer" class="space-y-2 max-h-[48vh] lg:max-h-[64vh] overflow-y-auto pr-0.5"></div></div>
                </div>
            </div></div>
            <div id="pmPlanFormModal" class="fixed inset-0 bg-slate-950/75 hidden z-[1360] flex items-center justify-center p-3 backdrop-blur-sm"><div class="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[92dvh] overflow-hidden flex flex-col border border-slate-200">
                <div class="px-4 py-3 bg-gradient-to-r from-blue-700 to-indigo-800 text-white flex justify-between items-center"><h3 id="pmPlanFormTitle" class="font-bold text-sm">📍 เพิ่มหมุดแผนงานบำรุงรักษา</h3><button type="button" onclick="closePmPlanFormModal()" class="text-white/80 hover:text-white text-xl font-bold leading-none">&times;</button></div>
                <div class="p-4 space-y-3 text-xs overflow-y-auto flex-1">
                    <div><label class="block font-bold text-slate-700 mb-1">🏷️ ชื่อหมุดแผนงาน / เรื่องที่ปฏิบัติงาน <span class="text-rose-500">*</span></label><input type="text" id="pmTitleInput" placeholder="เช่น ตัดกิ่งไม้หน้าโรงงาน..., HOTLINE เข้าทำงาน..." class="w-full px-3.5 py-2 text-sm font-semibold text-slate-800 bg-white"></div>
                    <div class="grid grid-cols-2 gap-2"><div><label class="block font-bold text-slate-700 mb-1">📂 ประเภทหมุดแผนงาน</label><select id="pmCategorySelect" class="w-full px-2.5 py-2 font-bold text-slate-700 bg-white">${catOptions}</select></div><div><label class="block font-bold text-slate-700 mb-1">📅 วันที่กำหนดทำ <span class="text-rose-500">*</span></label><input type="date" id="pmDateInput" class="w-full px-2.5 py-2 font-bold text-slate-800 bg-white"></div></div>
                    <div><label class="block font-bold text-slate-700 mb-1">🎨 สีป้ายหมุดแผนงานบนแผนที่</label><input type="hidden" id="pmPinColorInput" value="auto"><div class="flex flex-wrap gap-1">${pinColorBtns}</div></div>
                    <div class="grid grid-cols-3 gap-2"><div><label class="block font-bold text-slate-700 mb-1">⏰ ช่วงเวลาทำ</label><input type="text" id="pmTimeSlotInput" value="09.00-12.00" class="w-full px-2 py-2 text-center font-semibold bg-white"></div><div><label class="block font-bold text-amber-800 mb-1">📅 เตือนล่วงหน้า</label><select id="pmNotifyBeforeSelect" class="w-full px-2 py-2 font-bold text-amber-900 bg-amber-50 border-amber-300"><option value="0">เฉพาะวันจริง</option><option value="1">1 วัน</option><option value="2">2 วัน</option><option value="3" selected>3 วัน</option><option value="5">5 วัน</option><option value="7">7 วัน</option><option value="14">14 วัน</option><option value="30">30 วัน</option></select></div><div><label class="block font-bold text-indigo-800 mb-1">🔁 รอบทำซ้ำ</label><select id="pmRepeatMonthsSelect" class="w-full px-2 py-2 font-bold text-indigo-900 bg-indigo-50 border-indigo-200"><option value="0" selected>ครั้งเดียว</option><option value="1">ทุก 1 เดือน</option><option value="3">ทุก 3 เดือน</option><option value="6">ทุก 6 เดือน</option><option value="12">ทุก 1 ปี</option></select></div></div>
                    <div class="p-3 bg-indigo-50/85 border border-indigo-200 rounded-xl space-y-2"><label class="block font-extrabold text-indigo-950">⏰ เงื่อนไขเวลาแจ้งเตือนของงานนี้</label><select id="pmAlertModeSelect" onchange="onPmAlertModeChange(this.value)" class="w-full px-2.5 py-2 bg-white font-bold text-indigo-900 border-indigo-300"><option value="standard">🔔 มาตรฐาน (เตือนรอบ 00:00 น. และ 07:00 น.)</option><option value="both">🔔+⏰ เตือนรอบมาตรฐาน + เวลาที่ตั้งเองด้านล่าง</option><option value="custom_only">⏰ เตือนเฉพาะเวลาที่ตั้งเองเท่านั้น</option><option value="off">🔕 ปิดเสียง/ปิดป๊อปอัปแจ้งเตือนสำหรับงานนี้</option></select><div id="pmCustomTimesSection" class="hidden space-y-2 pt-1"><div class="flex items-center gap-1.5"><input type="time" id="pmCustomTimePickerInput" value="08:30" class="flex-1 px-2.5 py-1.5 bg-white font-mono font-bold text-slate-800 border-indigo-300"><button type="button" onclick="addPmCustomTimeChip()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-xl font-extrabold text-[11px] shadow-sm">➕ เพิ่มเวลาเตือน</button></div><div class="flex flex-wrap gap-1 items-center"><span class="text-[10px] text-slate-500 font-semibold">ด่วน:</span>${presetTimesBtns}</div><div id="pmCustomTimeChipsWrap" class="flex flex-wrap gap-1.5 pt-0.5"></div></div></div>
                    <div class="p-2.5 bg-teal-50/80 border border-teal-200 rounded-xl space-y-2"><label class="block font-bold text-teal-900">⚡ ผูกกับหมุดอุปกรณ์ในผัง SCADA (ดึงพิกัดอัตโนมัติ)</label><select id="pmScadaPinPicker" onchange="onPmScadaEquipPick(this.value)" class="w-full px-2.5 py-1.5 bg-white text-xs font-semibold text-slate-700"><option value="">-- เลือกอุปกรณ์จากผัง SCADA --</option></select><div class="grid grid-cols-2 gap-2"><input type="text" id="pmEquipCodeInput" placeholder="รหัสอุปกรณ์ เช่น BNF06VS-01" class="px-2.5 py-1.5 bg-white font-semibold"><input type="text" id="pmFeederInput" placeholder="วงจร เช่น BNF06" class="px-2.5 py-1.5 bg-white font-semibold uppercase"></div></div>
                    <div class="space-y-1.5"><div class="flex flex-wrap items-center justify-between gap-1"><label class="font-bold text-slate-700">📍 พิกัดหมุดแผนงาน</label><div class="flex gap-1"><button type="button" onclick="togglePmFormMiniMap()" class="text-[10px] bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-lg font-bold">🗺️ จิ้มเลือกบนแมพ</button><button type="button" onclick="fillPmCurrentMobileGps()" class="text-[10px] bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-lg font-bold">📍 พิกัดฉัน</button></div></div><input type="text" id="pmCoordInput" oninput="onPmCoordTextManualInput(this.value)" placeholder="วางพิกัด เช่น 13.1361, 101.0322 หรือลิงก์ Google Maps" class="w-full px-3 py-2 bg-white font-mono"><div id="pmFormMiniMapWrap" class="hidden rounded-xl overflow-hidden border-2 border-indigo-300"><div class="bg-indigo-900 text-white text-[10px] font-bold px-2.5 py-1 flex justify-between"><span>👆 แตะบนแผนที่หรือลากหมุดเพื่อเลือกจุดปฏิบัติงาน</span><button type="button" onclick="togglePmFormMiniMap('close_btn')">✕ ซ่อนแมพ</button></div><div id="pmFormMiniLeafletMap" class="w-full h-44 bg-slate-100"></div></div></div>
                    <div class="p-3 bg-violet-50/80 border border-violet-200 rounded-xl space-y-2">
                        <div class="flex items-center justify-between gap-2">
                            <label class="font-extrabold text-violet-950 flex items-center gap-1">📷 รูปภาพประกอบหน้างาน <span id="pmModalPhotoCountBadge" class="bg-violet-600 text-white text-[10px] px-1.5 py-0.5 rounded-full">0/${MAX_PM_PHOTOS}</span></label>
                            <div class="flex items-center gap-1">
                                <button type="button" id="pmModalBtnCamera" onclick="triggerPmPhotoInput('modal', 'camera')" class="bg-violet-600 hover:bg-violet-700 text-white px-2.5 py-1 rounded-lg text-[10.5px] font-extrabold shadow-sm">📸 ถ่ายรูป</button>
                                <button type="button" id="pmModalBtnGallery" onclick="triggerPmPhotoInput('modal', 'gallery')" class="bg-white hover:bg-violet-100 text-violet-800 border border-violet-300 px-2.5 py-1 rounded-lg text-[10.5px] font-extrabold shadow-sm">🖼️ เลือกรูป</button>
                            </div>
                        </div>
                        <input type="file" id="pmModalCameraInput" accept="image/*" capture="environment" class="hidden" onchange="handlePmModalPhotoSelect(event)">
                        <input type="file" id="pmModalGalleryInput" accept="image/*" multiple class="hidden" onchange="handlePmModalPhotoSelect(event)">
                        <div id="pmModalPhotoUploadStatus" class="hidden text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1.5 rounded-lg animate-pulse">⏳ กำลังย่อขนาดและอัปโหลดรูปภาพขึ้นคลาวด์...</div>
                        <div id="pmModalPhotoPreviewWrap" class="flex flex-wrap gap-2"></div>
                        <p class="text-[10px] text-slate-500">แนบได้สูงสุด ${MAX_PM_PHOTOS} รูป (เมื่อกดส่ง LINE บนมือถือ ระบบจะแนบไฟล์รูปจริงพร้อมคัดลอกข้อความให้อัตโนมัติ)</p>
                    </div>
                    <div><label class="block font-bold text-slate-700 mb-1">👷 ผู้รับผิดชอบ / รายละเอียดงาน</label><textarea id="pmNoteInput" rows="2" placeholder="ระบุผู้รับผิดชอบ หรือสิ่งที่ต้องเตรียม..." class="w-full px-3 py-2 bg-white"></textarea></div>
                </div>
                <div class="p-3 bg-slate-50 border-t flex items-center justify-between gap-2"><button type="button" id="pmDeleteBtnInModal" onclick="deletePmPlanFromModal()" class="hidden px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs">🗑️ ลบหมุดแผน</button><div class="flex gap-2 ml-auto"><button type="button" onclick="closePmPlanFormModal()" class="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl text-xs">ยกเลิก</button><button type="button" id="pmSaveSubmitBtn" onclick="savePmPlanFromModal()" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold rounded-xl text-xs shadow">💾 บันทึกหมุดแผนงาน</button></div></div>
            </div></div>
            <div id="pmAlertPopupModal" class="fixed inset-0 bg-slate-950/75 hidden z-[1420] flex items-center justify-center p-3 backdrop-blur-sm"><div class="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border-2 border-amber-400 flex flex-col max-h-[88dvh]">
                <div class="px-4 py-3.5 bg-gradient-to-r from-amber-500 via-orange-500 to-rose-600 text-white flex justify-between items-center"><h3 id="pmAlertPopupTitle" class="font-extrabold text-sm">🔔 แจ้งเตือนหมุดแผนงานบำรุงรักษา</h3><button type="button" id="pmAlertPopupCloseX" onclick="document.getElementById('pmAlertPopupModal').classList.add('hidden')" class="text-white/85 hover:text-white text-xl font-bold leading-none">&times;</button></div>
                <div class="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center justify-between gap-2 text-[11px]"><span id="pmAlertRepeatStatusHint" class="font-extrabold text-rose-700">🔊 เตือนซ้ำทุก 1 นาที จนกว่าจะกดรับทราบ</span><button type="button" id="pmPopupRepeatMinToggleBtn" onclick="togglePmRepeatEveryMinSetting()" class="shrink-0 bg-rose-600 hover:bg-rose-700 text-white px-2.5 py-1 rounded-lg font-extrabold text-[10.5px] shadow-sm transition">🔁 เตือนซ้ำ: เปิด</button></div>
                <div id="pmAlertPopupBody" class="p-4 space-y-2 overflow-y-auto flex-1 bg-slate-50 text-xs"></div>
                <div class="p-3 bg-white border-t flex flex-wrap items-center justify-between gap-2"><button type="button" onclick="shareDailyOrAlertSummaryToLine()" class="px-3 py-2 bg-[#00B900] hover:bg-[#009900] text-white rounded-xl text-xs font-extrabold">💬 ส่งเข้า LINE</button><div class="flex gap-1.5"><button type="button" id="pmAlertModalCalOrLoginBtn" onclick="document.getElementById('pmAlertPopupModal').classList.add('hidden'); openPmCalendarModal();" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold">📅 ดูปฏิทิน/แมพ</button><button type="button" onclick="acknowledgeCurrentPmAlertRound()" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-extrabold shadow">✅ รับทราบรอบนี้</button></div></div>
            </div></div>
            <div id="pmPhotoLightboxModal" onclick="if(event.target===this) closePmPhotoLightbox();" class="fixed inset-0 bg-slate-950/92 hidden z-[1490] flex flex-col items-center justify-between p-3 sm:p-5 backdrop-blur-md select-none">
                <div class="w-full max-w-3xl flex items-center justify-between gap-2 text-white pt-[env(safe-area-inset-top)]">
                    <span id="pmLightboxCounter" class="bg-white/15 px-3 py-1 rounded-full text-xs font-extrabold">รูปที่ 1 / 1</span>
                    <button type="button" onclick="closePmPhotoLightbox()" class="bg-rose-600 hover:bg-rose-700 text-white px-3.5 py-1 rounded-xl text-xs font-extrabold shadow">✕ ปิดรูป</button>
                </div>
                <div class="relative flex-1 w-full max-w-4xl flex items-center justify-center my-2 overflow-hidden">
                    <button type="button" id="pmLightboxPrevBtn" onclick="stepPmPhotoLightbox(-1)" class="hidden absolute left-2 z-10 w-10 h-10 rounded-full bg-slate-900/80 hover:bg-slate-800 text-white border border-white/30 font-extrabold text-base items-center justify-center shadow-xl">◀</button>
                    <img id="pmLightboxImg" src="" alt="รูปประกอบแผนงาน PM" class="max-w-full max-h-[75dvh] object-contain rounded-xl shadow-2xl border border-white/15">
                    <button type="button" id="pmLightboxNextBtn" onclick="stepPmPhotoLightbox(1)" class="hidden absolute right-2 z-10 w-10 h-10 rounded-full bg-slate-900/80 hover:bg-slate-800 text-white border border-white/30 font-extrabold text-base items-center justify-center shadow-xl">▶</button>
                </div>
                <div class="w-full max-w-xl flex flex-wrap items-center justify-center gap-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                    <a id="pmLightboxDriveLink" href="#" target="_blank" rel="noopener noreferrer" class="bg-white/15 hover:bg-white/25 text-white px-3.5 py-2 rounded-xl text-xs font-bold border border-white/20">🔗 เปิดไฟล์ต้นฉบับ Drive</a>
                    <button type="button" id="pmLightboxShareLineBtn" onclick="shareFromPmPhotoLightbox()" class="hidden bg-[#00B900] hover:bg-[#009900] text-white px-4 py-2 rounded-xl text-xs font-extrabold shadow-lg">💬 ส่งรูป+ข้อความเข้า LINE</button>
                </div>
            </div>
            <div id="pmLineShareReadyModal" class="fixed inset-0 bg-slate-950/75 hidden z-[1495] flex items-center justify-center p-4 backdrop-blur-sm">
                <div class="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-5 space-y-3.5 border-2 border-[#00B900] text-center">
                    <div class="text-3xl">📸💬</div>
                    <h4 class="font-extrabold text-slate-900 text-sm">เตรียมรูปภาพและคัดลอกข้อความแล้ว!</h4>
                    <p id="pmLineShareReadyDesc" class="text-xs text-slate-600 leading-relaxed">ระบบคัดลอกข้อความแผนงานไว้ในคลิปบอร์ดแล้ว แตะปุ่มสีเขียวด้านล่างเพื่อเลือกแอป <b>LINE</b> ส่งรูปภาพ จากนั้นกด<b>วางข้อความ</b>ในแชทได้เลยครับ</p>
                    <div class="space-y-2 pt-1">
                        <button type="button" onclick="confirmPendingPmLineFileShare()" class="w-full bg-[#00B900] hover:bg-[#009900] text-white font-extrabold py-2.5 rounded-xl text-xs shadow-lg">💬 แตะเพื่อส่งรูปภาพเข้า LINE</button>
                        <div class="flex gap-2">
                            <button type="button" onclick="fallbackPendingPmLineTextOnly()" class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2 rounded-xl text-[11px]">ส่งเฉพาะข้อความ+ลิงก์</button>
                            <button type="button" onclick="closePmLineShareReadyModal()" class="px-4 bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold py-2 rounded-xl text-[11px]">ยกเลิก</button>
                        </div>
                    </div>
                </div>
            </div>`);
    }

    // ========================================================================
    // 6.2 ฟังก์ชันจัดการเลือกรูป, พรีวิวรูปย่อ & เปิดขยายภาพเต็มจอ (Lightbox)
    // ========================================================================
    function renderPmModalPhotoPreviews() {
        const wrap = document.getElementById('pmModalPhotoPreviewWrap');
        const badge = document.getElementById('pmModalPhotoCountBadge');
        const camBtn = document.getElementById('pmModalBtnCamera');
        const galBtn = document.getElementById('pmModalBtnGallery');
        tempFormPhotoIds = normalizePmPhotoIds(tempFormPhotoIds);
        if (badge) badge.textContent = `${tempFormPhotoIds.length}/${MAX_PM_PHOTOS}`;
        const isFull = tempFormPhotoIds.length >= MAX_PM_PHOTOS || isUploadingModalPhotos;
        if (camBtn) camBtn.disabled = isFull;
        if (galBtn) galBtn.disabled = isFull;
        if (!wrap) return;
        if (!tempFormPhotoIds.length) {
            wrap.innerHTML = '<span class="text-[10.5px] text-slate-400 italic">ยังไม่มีรูปแนบ</span>';
            return;
        }
        wrap.innerHTML = tempFormPhotoIds.map((fid, idx) => {
            const thumbSrc = safeEscHtml(getPmPhotoThumbUrl(fid, 400));
            const fallbackSrc = safeEscHtml(getPmPhotoDirectUrl(fid, 800));
            return `<div class="relative w-20 h-20 rounded-xl overflow-hidden border-2 border-violet-300 bg-white shadow-sm group"><img src="${thumbSrc}" onclick="openPmRawPhotoLightbox(${idx}, 'modal')" onerror="if(!this.dataset.fbk){this.dataset.fbk='1';this.src='${fallbackSrc}';}" class="w-full h-full object-cover cursor-pointer"><button type="button" onclick="removePmModalPhotoAt(${idx})" title="ลบรูปนี้" class="absolute top-1 right-1 w-5 h-5 rounded-full bg-rose-600 hover:bg-rose-700 text-white text-xs font-extrabold flex items-center justify-center shadow">&times;</button><span class="pointer-events-none absolute bottom-0.5 left-1 bg-slate-900/75 text-white text-[9px] font-bold px-1 rounded">${idx + 1}</span></div>`;
        }).join('');
    }

    function renderPmQuickPhotoPreviews() {
        const wrap = document.getElementById('pmQuickPhotoPreviewWrap');
        const cntEl = document.getElementById('pmQuickPhotoCountTxt');
        tempQuickPhotoIds = normalizePmPhotoIds(tempQuickPhotoIds);
        if (cntEl) cntEl.textContent = `${tempQuickPhotoIds.length}/${MAX_PM_PHOTOS}`;
        if (!wrap) return;
        if (!tempQuickPhotoIds.length) {
            wrap.classList.add('hidden');
            wrap.innerHTML = '';
            return;
        }
        wrap.classList.remove('hidden');
        wrap.innerHTML = tempQuickPhotoIds.map((fid, idx) => {
            const thumbSrc = safeEscHtml(getPmPhotoThumbUrl(fid, 320));
            const fallbackSrc = safeEscHtml(getPmPhotoDirectUrl(fid, 600));
            return `<div class="relative w-14 h-14 rounded-xl overflow-hidden border border-violet-300 bg-white shadow-sm shrink-0"><img src="${thumbSrc}" onclick="openPmRawPhotoLightbox(${idx}, 'quick')" onerror="if(!this.dataset.fbk){this.dataset.fbk='1';this.src='${fallbackSrc}';}" class="w-full h-full object-cover cursor-pointer"><button type="button" onclick="removePmQuickPhotoAt(${idx})" class="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-rose-600 text-white text-[10px] font-extrabold flex items-center justify-center">&times;</button></div>`;
        }).join('');
    }

    function triggerPmPhotoInput(targetMode, sourceType) {
        if (!canManagePmSchedule()) return;
        const curList = targetMode === 'quick' ? tempQuickPhotoIds : tempFormPhotoIds;
        if (curList.length >= MAX_PM_PHOTOS) {
            safeToast(`⚠️ แนบรูปภาพได้สูงสุด ${MAX_PM_PHOTOS} รูปต่อ 1 แผนงานครับ`);
            return;
        }
        const inputId = targetMode === 'quick'
            ? (sourceType === 'camera' ? 'pmQuickCameraInput' : 'pmQuickGalleryInput')
            : (sourceType === 'camera' ? 'pmModalCameraInput' : 'pmModalGalleryInput');
        const inp = document.getElementById(inputId);
        if (inp) { inp.value = ''; inp.click(); }
    }

    async function handlePmModalPhotoSelect(event) {
        const files = Array.from(event?.target?.files || []);
        if (event?.target) event.target.value = '';
        if (!files.length || !canManagePmSchedule()) return;
        const remain = MAX_PM_PHOTOS - tempFormPhotoIds.length;
        if (remain <= 0) { safeToast(`⚠️ แนบรูปครบ ${MAX_PM_PHOTOS} รูปแล้ว`); return; }
        const picked = files.slice(0, remain);
        if (files.length > remain) safeToast(`ℹ️ เลือกเพิ่มได้อีก ${remain} รูป (สูงสุด ${MAX_PM_PHOTOS} รูป/แผนงาน)`);

        const statusEl = document.getElementById('pmModalPhotoUploadStatus');
        isUploadingModalPhotos = true;
        statusEl?.classList.remove('hidden');
        renderPmModalPhotoPreviews();

        const titleHint = (document.getElementById('pmTitleInput')?.value || 'PM').trim();
        let okCount = 0;
        try {
            for (let i = 0; i < picked.length; i++) {
                if (statusEl) statusEl.textContent = `⏳ กำลังอัปโหลดรูปที่ ${i + 1}/${picked.length}...`;
                const fid = await uploadSinglePmPhotoFile(picked[i], titleHint);
                if (fid) {
                    tempFormPhotoIds.push(fid);
                    sessionModalUploadedIds.push(fid);
                    okCount++;
                    renderPmModalPhotoPreviews();
                }
            }
            if (okCount > 0) safeToast(`📷 แนบรูปภาพสำเร็จ ${okCount} รูป`);
        } catch (err) {
            safeToast(`❌ อัปโหลดรูปไม่สำเร็จ: ${err?.message || err}`);
        } finally {
            isUploadingModalPhotos = false;
            statusEl?.classList.add('hidden');
            renderPmModalPhotoPreviews();
        }
    }

    function removePmModalPhotoAt(idx) {
        const removed = tempFormPhotoIds.splice(idx, 1)[0];
        renderPmModalPhotoPreviews();
        if (removed && sessionModalUploadedIds.includes(removed) && !originalEditingPhotoIds.includes(removed)) {
            sessionModalUploadedIds = sessionModalUploadedIds.filter(id => id !== removed);
            trashUnusedPmPhotoIdsInBackground([removed]);
        }
    }

    async function handlePmQuickPhotoSelect(event) {
        const files = Array.from(event?.target?.files || []);
        if (event?.target) event.target.value = '';
        if (!files.length || !canManagePmSchedule()) return;
        const remain = MAX_PM_PHOTOS - tempQuickPhotoIds.length;
        if (remain <= 0) { safeToast(`⚠️ แนบรูปครบ ${MAX_PM_PHOTOS} รูปแล้ว`); return; }
        const picked = files.slice(0, remain);

        const statusEl = document.getElementById('pmQuickPhotoUploadStatus');
        isUploadingQuickPhotos = true;
        statusEl?.classList.remove('hidden');
        const titleHint = (document.getElementById('pmQuickTitleInput')?.value || 'PM').trim();
        let okCount = 0;
        try {
            for (let i = 0; i < picked.length; i++) {
                if (statusEl) statusEl.textContent = `⏳ กำลังอัปโหลดรูป ${i + 1}/${picked.length}...`;
                const fid = await uploadSinglePmPhotoFile(picked[i], titleHint);
                if (fid) {
                    tempQuickPhotoIds.push(fid);
                    okCount++;
                    renderPmQuickPhotoPreviews();
                }
            }
            if (okCount > 0) safeToast(`📷 แนบรูปด่วนสำเร็จ ${okCount} รูป`);
        } catch (err) {
            safeToast(`❌ อัปโหลดรูปไม่สำเร็จ: ${err?.message || err}`);
        } finally {
            isUploadingQuickPhotos = false;
            statusEl?.classList.add('hidden');
            renderPmQuickPhotoPreviews();
        }
    }

    function removePmQuickPhotoAt(idx) {
        const removed = tempQuickPhotoIds.splice(idx, 1)[0];
        renderPmQuickPhotoPreviews();
        if (removed) trashUnusedPmPhotoIdsInBackground([removed]);
    }

    function refreshPmLightboxView() {
        const modal = document.getElementById('pmPhotoLightboxModal');
        const imgEl = document.getElementById('pmLightboxImg');
        const cntEl = document.getElementById('pmLightboxCounter');
        const prevBtn = document.getElementById('pmLightboxPrevBtn');
        const nextBtn = document.getElementById('pmLightboxNextBtn');
        const driveLink = document.getElementById('pmLightboxDriveLink');
        const shareBtn = document.getElementById('pmLightboxShareLineBtn');
        if (!modal || !imgEl || !lightboxPhotoIds.length) return;

        const fid = lightboxPhotoIds[lightboxActiveIdx] || lightboxPhotoIds[0];
        delete imgEl.dataset.fbk;
        imgEl.onerror = function () {
            if (!this.dataset.fbk) {
                this.dataset.fbk = '1';
                this.src = getPmPhotoThumbUrl(fid, 1200);
            }
        };
        imgEl.src = getPmPhotoDirectUrl(fid, 1600);
        if (cntEl) cntEl.textContent = `📷 รูปที่ ${lightboxActiveIdx + 1} / ${lightboxPhotoIds.length}`;
        if (driveLink) driveLink.href = getPmPhotoDriveViewUrl(fid);
        const hasMulti = lightboxPhotoIds.length > 1;
        if (prevBtn) { prevBtn.classList.toggle('hidden', !hasMulti); prevBtn.classList.toggle('flex', hasMulti); }
        if (nextBtn) { nextBtn.classList.toggle('hidden', !hasMulti); nextBtn.classList.toggle('flex', hasMulti); }
        if (shareBtn) shareBtn.classList.toggle('hidden', !lightboxSourcePlanId);
        modal.classList.remove('hidden');
    }

    function openPmPhotoLightbox(planId, startIdx = 0) {
        injectPmModalsDOM();
        const item = getAllVisibleCalendarItems().find(x => x.id === planId);
        const pIds = normalizePmPhotoIds(item);
        if (!pIds.length) return;
        lightboxPhotoIds = pIds;
        lightboxActiveIdx = Math.max(0, Math.min(Number(startIdx) || 0, pIds.length - 1));
        lightboxSourcePlanId = planId;
        refreshPmLightboxView();
    }

    function openPmRawPhotoLightbox(startIdx = 0, mode = 'modal') {
        injectPmModalsDOM();
        const pIds = normalizePmPhotoIds(mode === 'quick' ? tempQuickPhotoIds : tempFormPhotoIds);
        if (!pIds.length) return;
        lightboxPhotoIds = pIds;
        lightboxActiveIdx = Math.max(0, Math.min(Number(startIdx) || 0, pIds.length - 1));
        lightboxSourcePlanId = '';
        refreshPmLightboxView();
    }

    function stepPmPhotoLightbox(delta) {
        if (lightboxPhotoIds.length <= 1) return;
        lightboxActiveIdx = (lightboxActiveIdx + delta + lightboxPhotoIds.length) % lightboxPhotoIds.length;
        refreshPmLightboxView();
    }

    function closePmPhotoLightbox() {
        document.getElementById('pmPhotoLightboxModal')?.classList.add('hidden');
        const imgEl = document.getElementById('pmLightboxImg');
        if (imgEl) imgEl.src = '';
    }

    function shareFromPmPhotoLightbox() {
        if (!lightboxSourcePlanId) return;
        const pid = lightboxSourcePlanId;
        closePmPhotoLightbox();
        shareSinglePmPlanToLine(pid);
    }

    // ========================================================================
    // 7. ช่องพิมพ์แผนงานด่วน (รองรับแนบรูปสูงสุด 3 รูป + พิมพ์ด้วยเสียง)
    // ========================================================================
    function syncQuickAlertTimeLabel() {
        const inp = document.getElementById('pmQuickAlertTimeInput'), ph = document.getElementById('pmQuickAlertTimePlaceholder'), clr = document.getElementById('pmQuickAlertTimeClearBtn');
        const hasVal = Boolean(inp && inp.value && inp.value.trim());
        if (ph) ph.classList.toggle('hidden', hasVal);
        if (clr) { clr.classList.toggle('hidden', !hasVal); clr.classList.toggle('flex', hasVal); }
    }
    function clearQuickAlertTimeInput() { const inp = document.getElementById('pmQuickAlertTimeInput'); if (inp) inp.value = ''; syncQuickAlertTimeLabel(); }

    function injectQuickAddBoxIntoCalendar() {
        const listHdr = document.getElementById('pmSelectedListHeader');
        if (!listHdr || !listHdr.parentElement || document.getElementById('pmQuickInlineBox')) return;
        const catOptions = Object.values(PM_CATEGORIES).map(c => `<option value="${c.key}">${c.icon} ${c.name}</option>`).join('');
        const box = document.createElement('div');
        box.id = 'pmQuickInlineBox';
        box.className = 'hidden pm-edit-only p-3 rounded-2xl bg-gradient-to-br from-blue-50 via-indigo-50/85 to-teal-50 border-2 border-indigo-300 shadow-sm space-y-2.5 transition-all';
        box.innerHTML = `
            <div class="flex flex-wrap items-center justify-between gap-1.5"><span class="text-[11px] font-extrabold text-indigo-950 flex items-center gap-1"><span>✍️ แผนวันที่:</span><span id="pmQuickTargetDateBadge" class="bg-indigo-600 text-white px-2 py-0.5 rounded-md text-[10px] font-extrabold">-</span></span><button type="button" onclick="expandQuickInputToFullModal()" class="bg-white hover:bg-indigo-600 text-indigo-700 hover:text-white border-2 border-indigo-400 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow-sm transition flex items-center gap-1 shrink-0">📝 เพิ่มรายละเอียด</button></div>
            <div class="relative flex items-center gap-1.5"><div class="relative flex-1"><input type="text" id="pmQuickTitleInput" onkeydown="if(event.key==='Enter'){ event.preventDefault(); submitQuickInlinePmPlan(); }" placeholder="🏷️ พิมพ์ชื่อแผนงาน..." class="w-full px-3 py-2 pr-9 text-xs font-semibold text-slate-800 bg-white border border-indigo-300 rounded-xl focus:outline-none"><button type="button" onclick="startPmQuickVoiceInput()" title="พูดเพื่อพิมพ์แผนงาน" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-rose-600 p-1 text-sm leading-none">🎙️</button></div><button type="button" id="pmQuickSubmitBtn" onclick="submitQuickInlinePmPlan()" class="shrink-0 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold px-3 py-2 rounded-xl text-xs shadow-sm transition">💾 บันทึก</button></div>
            <div class="grid grid-cols-12 gap-2 items-end"><div class="col-span-7"><label for="pmQuickCategorySelect" class="block text-[10px] font-bold text-slate-600 mb-0.5 pl-0.5">📂 ประเภทงาน</label><select id="pmQuickCategorySelect" class="w-full px-2 py-1.5 text-[11px] font-bold text-slate-700 bg-white border border-slate-300 rounded-lg">${catOptions}</select></div><div class="col-span-5"><label for="pmQuickTimeInput" class="block text-[10px] font-bold text-slate-600 mb-0.5 pl-0.5">🕒 ช่วงเวลาทำงาน</label><input type="text" id="pmQuickTimeInput" value="09.00-12.00" placeholder="09.00-12.00" class="w-full px-2 py-1.5 text-[11px] font-semibold text-center text-slate-700 bg-white border border-slate-300 rounded-lg"></div></div>
            <div class="bg-amber-50/95 border border-amber-300 rounded-xl px-2.5 py-1.5 flex items-center justify-between gap-2"><label for="pmQuickAlertTimeInput" class="text-[11px] font-extrabold text-amber-900 flex items-center gap-1 shrink-0 cursor-pointer"><span>🔔 เวลาเตือนพิเศษ:</span></label><div class="flex items-center gap-1 flex-1 justify-end min-w-0"><div class="relative flex-1 max-w-[155px]"><input type="time" id="pmQuickAlertTimeInput" onclick="if(this.showPicker){try{this.showPicker();}catch(e){}}" onchange="syncQuickAlertTimeLabel()" oninput="syncQuickAlertTimeLabel()" title="ตั้งเวลาเตือนพิเศษเฉพาะงานนี้ (เว้นว่าง = เตือนรอบ 00:00 และ 07:00 น.)" class="w-full px-2.5 py-1 text-[11px] font-mono font-extrabold text-indigo-900 bg-white border border-amber-400 rounded-lg focus:outline-none cursor-pointer"><span id="pmQuickAlertTimePlaceholder" class="pointer-events-none absolute inset-y-[2px] left-2 right-6 flex items-center gap-1 bg-white text-[10.5px] font-bold text-amber-700 truncate">⏰ แตะตั้งเวลา</span></div><button type="button" id="pmQuickAlertTimeClearBtn" onclick="clearQuickAlertTimeInput()" title="ล้างเวลาเตือนพิเศษ" class="hidden shrink-0 w-6 h-6 rounded-lg bg-rose-100 hover:bg-rose-200 text-rose-600 border border-rose-200 font-extrabold text-xs items-center justify-center">&times;</button></div></div>
            <div><label for="pmQuickCoordInput" class="block text-[10px] font-bold text-slate-600 mb-0.5 pl-0.5">📍 พิกัดหมุดแผนงาน (ถ้ามี)</label><input type="text" id="pmQuickCoordInput" onkeydown="if(event.key==='Enter'){ event.preventDefault(); submitQuickInlinePmPlan(); }" placeholder="วางพิกัด Lat, Lon หรือลิงก์ Google Maps" class="w-full px-2.5 py-1.5 text-[10.5px] font-mono text-slate-700 bg-white border border-slate-300 rounded-lg"></div>
            <div class="bg-violet-50/90 border border-violet-200 rounded-xl px-2.5 py-1.5 space-y-1.5">
                <div class="flex items-center justify-between gap-1.5">
                    <span class="text-[10.5px] font-extrabold text-violet-900">📷 รูปประกอบ (<span id="pmQuickPhotoCountTxt">0/${MAX_PM_PHOTOS}</span>)</span>
                    <div class="flex items-center gap-1">
                        <button type="button" onclick="triggerPmPhotoInput('quick', 'camera')" class="bg-violet-600 hover:bg-violet-700 text-white px-2 py-0.5 rounded-lg text-[10px] font-bold">📸 ถ่ายรูป</button>
                        <button type="button" onclick="triggerPmPhotoInput('quick', 'gallery')" class="bg-white hover:bg-violet-100 text-violet-800 border border-violet-300 px-2 py-0.5 rounded-lg text-[10px] font-bold">🖼️ เลือกรูป</button>
                    </div>
                </div>
                <input type="file" id="pmQuickCameraInput" accept="image/*" capture="environment" class="hidden" onchange="handlePmQuickPhotoSelect(event)">
                <input type="file" id="pmQuickGalleryInput" accept="image/*" multiple class="hidden" onchange="handlePmQuickPhotoSelect(event)">
                <div id="pmQuickPhotoUploadStatus" class="hidden text-[10px] font-bold text-amber-700 animate-pulse">⏳ กำลังอัปโหลดรูป...</div>
                <div id="pmQuickPhotoPreviewWrap" class="hidden flex items-center gap-1.5 overflow-x-auto pt-0.5"></div>
            </div>`;
        listHdr.parentElement.insertBefore(box, listHdr);
        syncQuickAlertTimeLabel(); updateQuickInlineBoxUI();
    }

    function discardUnsavedQuickPhotos() {
        if (!tempQuickPhotoIds.length) return;
        const unsaved = [...tempQuickPhotoIds];
        tempQuickPhotoIds = [];
        renderPmQuickPhotoPreviews();
        trashUnusedPmPhotoIdsInBackground(unsaved);
    }

    function updateQuickInlineBoxUI() {
        const box = document.getElementById('pmQuickInlineBox'), primaryBtn = document.getElementById('pmAddPlanPrimaryBtn'), allow = canManagePmSchedule();
        if (primaryBtn) {
            primaryBtn.classList.toggle('hidden', !allow);
            primaryBtn.textContent = isQuickInlineBoxVisible ? '✕ ปิดช่องพิมพ์' : '➕ ปักแผนใหม่';
            primaryBtn.className = isQuickInlineBoxVisible ? 'pm-edit-only shrink-0 bg-slate-600 hover:bg-slate-700 text-white px-3 py-1.5 rounded-xl text-xs font-extrabold shadow-sm transition' : 'pm-edit-only shrink-0 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-xl text-xs font-extrabold shadow-sm transition';
        }
        if (!box) return;
        box.classList.toggle('hidden', !(allow && isQuickInlineBoxVisible));
        const dateBadge = document.getElementById('pmQuickTargetDateBadge');
        if (dateBadge) dateBadge.textContent = formatThaiDateShort(selectedDateIso || getTodayIso());
    }
    function togglePmQuickInlineBox(forceState) {
        if (!canManagePmSchedule()) { safeToast('🔒 เฉพาะแอดมินและผู้ใช้งานทั่วไปเท่านั้นที่เพิ่มแผนงานได้'); return; }
        injectQuickAddBoxIntoCalendar();
        const nextState = typeof forceState === 'boolean' ? forceState : !isQuickInlineBoxVisible;
        if (!nextState && isQuickInlineBoxVisible) discardUnsavedQuickPhotos();
        isQuickInlineBoxVisible = nextState;
        if (isQuickInlineBoxVisible && currentFilterStatus !== 'day') { currentFilterStatus = 'day'; renderPmSelectedDayList(); }
        syncQuickAlertTimeLabel(); renderPmQuickPhotoPreviews(); updateQuickInlineBoxUI();
        if (isQuickInlineBoxVisible) setTimeout(() => document.getElementById('pmQuickTitleInput')?.focus(), 60);
    }
    function focusQuickInlineInputForDate(isoStr) {
        if (isoStr) selectedDateIso = isoStr;
        currentFilterStatus = 'day'; isQuickInlineBoxVisible = true;
        renderPmCalendarGrid(); renderPmSelectedDayList(); syncQuickAlertTimeLabel(); updateQuickInlineBoxUI();
        setTimeout(() => document.getElementById('pmQuickTitleInput')?.focus(), 60);
    }
    function startPmQuickVoiceInput() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { safeToast('⚠️ เบราว์เซอร์นี้ไม่รองรับการพิมพ์ด้วยเสียง'); return; }
        const inp = document.getElementById('pmQuickTitleInput'); if (!inp) return;
        const rec = new SR(); rec.lang = 'th-TH';
        rec.onstart = () => safeToast('🎙️ กำลังฟัง... พูดรายละเอียดแผนงานได้เลยครับ');
        rec.onresult = e => { const tr = (e.results?.[0]?.[0]?.transcript || '').trim(); if (tr) { inp.value = (inp.value ? inp.value + ' ' : '') + tr; inp.focus(); } };
        rec.onerror = () => safeToast('❌ รับเสียงไม่สำเร็จ กรุณาลองใหม่');
        rec.start();
    }
    function expandQuickInputToFullModal() {
        if (!canManagePmSchedule()) return;
        if (isUploadingQuickPhotos) { safeToast('⏳ กรุณารออัปโหลดรูปสักครู่ก่อนขยายฟอร์ม'); return; }
        const typedTitle = (document.getElementById('pmQuickTitleInput')?.value || '').trim(), typedCat = document.getElementById('pmQuickCategorySelect')?.value || 'tree';
        const typedTime = (document.getElementById('pmQuickTimeInput')?.value || '').trim(), typedAlertTime = normalizeTimeHHMM(document.getElementById('pmQuickAlertTimeInput')?.value || ''), typedCoord = (document.getElementById('pmQuickCoordInput')?.value || '').trim();
        const carriedPhotos = [...tempQuickPhotoIds];
        tempQuickPhotoIds = [];
        renderPmQuickPhotoPreviews();
        openPmPlanFormModal(null, selectedDateIso || getTodayIso());
        if (carriedPhotos.length > 0) {
            tempFormPhotoIds = normalizePmPhotoIds(carriedPhotos);
            sessionModalUploadedIds.push(...tempFormPhotoIds);
            renderPmModalPhotoPreviews();
        }
        if (typedTitle) document.getElementById('pmTitleInput').value = typedTitle;
        if (typedCat) document.getElementById('pmCategorySelect').value = typedCat;
        if (typedTime) document.getElementById('pmTimeSlotInput').value = typedTime;
        if (typedAlertTime) { document.getElementById('pmAlertModeSelect').value = 'both'; onPmAlertModeChange('both'); addPmCustomTimeChip(typedAlertTime); }
        if (typedCoord) { document.getElementById('pmCoordInput').value = typedCoord; onPmCoordTextManualInput(typedCoord); }
    }

    async function submitQuickInlinePmPlan() {
        if (!canManagePmSchedule()) return;
        if (isUploadingQuickPhotos) { safeToast('⏳ กรุณารออัปโหลดรูปภาพให้เสร็จก่อนกดบันทึกครับ'); return; }
        const titleEl = document.getElementById('pmQuickTitleInput'), catEl = document.getElementById('pmQuickCategorySelect');
        const timeEl = document.getElementById('pmQuickTimeInput'), alertTimeEl = document.getElementById('pmQuickAlertTimeInput');
        const coordEl = document.getElementById('pmQuickCoordInput'), submitBtn = document.getElementById('pmQuickSubmitBtn');
        const rawTitle = (titleEl?.value || '').trim();
        if (!rawTitle) { safeToast('✍️ กรุณาพิมพ์ชื่อแผนงานก่อนกดบันทึก'); titleEl?.focus(); return; }
        const rawCoord = (coordEl?.value || '').trim();
        let parsedCoord = null;
        if (rawCoord) {
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '⏳...'; }
            try { parsedCoord = await parsePmCoordOrShortLink(rawCoord); }
            catch (e) { parsedCoord = null; }
            finally { if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '💾 บันทึก'; } }
            if (!parsedCoord) { safeToast('❌ พิกัดหรือลิงก์ไม่ถูกต้อง (เว้นว่างได้หากไม่ระบุพิกัด)'); return; }
        }
        const targetDate = selectedDateIso || getTodayIso(), customT = normalizeTimeHHMM(alertTimeEl?.value || ''), myGrp = getActivePmGroup();
        const curUser = (rawGet('elec_app_current_user') || 'admin').trim(), nowIso = nextPmUpdatedIso(safeGetLocMap()[PM_LOC_PREFIX + myGrp]?.updatedAt);
        const finalQuickPhotos = normalizePmPhotoIds(tempQuickPhotoIds);
        const newPlan = {
            id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), title: rawTitle, category: catEl?.value || 'tree', pinColor: 'auto',
            photoIds: finalQuickPhotos, pubPlaces: '',
            alertMode: customT ? 'both' : 'standard', customAlertTimes: customT ? [customT] : [], alertBaselineAt: getMinuteFloorIso(), createdAt: nowIso, date: targetDate,
            timeSlot: (timeEl?.value || '').trim() || '09.00-12.00', notifyDaysBefore: 3, repeatMonths: 0, equipCode: '', feeder: '', note: '',
            lat: parsedCoord ? parsedCoord.lat : null, lon: parsedCoord ? parsedCoord.lon : null,
            gpsLink: parsedCoord ? `https://www.google.com/maps?q=${parsedCoord.lat.toFixed(6)},${parsedCoord.lon.toFixed(6)}` : '',
            status: 'pending', ownerGroup: myGrp, createdBy: curUser, updatedBy: curUser, updatedAt: nowIso
        };
        loadPmPlansFromStorage(); pmPlans.push(newPlan); preAckPastSlotsForPlanToday(newPlan);
        tempQuickPhotoIds = []; renderPmQuickPhotoPreviews();
        if (titleEl) titleEl.value = ''; if (coordEl) coordEl.value = ''; if (alertTimeEl) alertTimeEl.value = '';
        syncQuickAlertTimeLabel(); currentFilterStatus = 'day';
        await savePmPlansAndSync(true);
        safeToast(`✅ บันทึกแผนงานวันที่ ${formatThaiDateShort(targetDate)}${finalQuickPhotos.length ? ` (พร้อมรูป ${finalQuickPhotos.length} รูป)` : ''} เรียบร้อยแล้ว`);
        titleEl?.focus();
    }

    function quickEditPmPlanTitle(planId) {
        if (!canManagePmSchedule()) return;
        loadPmPlansFromStorage();
        const target = pmPlans.find(p => p.id === planId && !p.pmDeleted); if (!target) return;
        window.showCustomPrompt('แก้ไขข้อความแผนงานด่วน:', target.title, async function (newVal) {
            const trimmed = String(newVal || '').trim();
            if (!trimmed || trimmed === target.title) return;
            target.title = trimmed; target.updatedBy = (rawGet('elec_app_current_user') || 'admin').trim();
            target.updatedAt = nextPmUpdatedIso(target.updatedAt);
            await savePmPlansAndSync(true); safeToast('✅ อัปเดตข้อความแผนงานแล้ว');
        }, '✏️ แก้ไขข้อความแผนงาน');
    }

    // ========================================================================
    // 8. ตารางปฏิทินรายเดือน, แผนที่หมุดแผนงาน & การสลับมุมมอง
    // ========================================================================
    async function initCalendarEmbeddedMap() {
        const mapEl = document.getElementById('pmCalendarEmbeddedMap'); if (!mapEl) return;
        if (!(await ensureLeafletReady()) || typeof L === 'undefined') { safeToast('⚠️ ไม่สามารถโหลดไลบรารีแผนที่ได้ กรุณาตรวจสอบอินเทอร์เน็ต'); return; }
        if (!calendarMapInstance) {
            const defCenter = window.lastKnownTechCoords ? [window.lastKnownTechCoords.lat, window.lastKnownTechCoords.lon] : [13.1361, 101.0322];
            calendarMapInstance = L.map('pmCalendarEmbeddedMap').setView(defCenter, 12);
            const gStreets = L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' }).addTo(calendarMapInstance);
            const gHybrid = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' });
            L.control.layers({ '🗺️ ถนน': gStreets, '🛰️ ดาวเทียม': gHybrid }, null, { position: 'topright' }).addTo(calendarMapInstance);
            calendarPmLayer = L.layerGroup().addTo(calendarMapInstance);
            mapEl.addEventListener('contextmenu', ev => { if (pmPinDropModeActive || pmPinMoveTargetId) { ev.stopImmediatePropagation(); ev.preventDefault(); } }, true);
            calendarMapInstance.on('click', e => {
                if (!e.latlng || !canManagePmSchedule()) return;
                if (pmPinMoveTargetId) commitMovedPmPlanPinLocation(pmPinMoveTargetId, e.latlng.lat, e.latlng.lng);
                else if (pmPinDropModeActive) { const { lat, lng } = e.latlng; cancelPmMapInteractiveModes(); openPmPlanFormModal(null, selectedDateIso || getTodayIso(), lat, lng); }
            });
        }
        setTimeout(() => {
            calendarMapInstance.invalidateSize();
            renderPmPinsOnTargetMap(calendarMapInstance, calendarPmLayer, calendarPmMarkersById, false);
            if (typeof renderZonesOnCalendarEmbeddedMap === 'function') renderZonesOnCalendarEmbeddedMap();
        }, 100);
    }
    function fitCalendarEmbeddedMapPins() {
        if (!calendarMapInstance) return;
        const pts = getAllVisibleCalendarItems().filter(i => !isNaN(parseFloat(i.lat)) && !isNaN(parseFloat(i.lon))).map(i => [parseFloat(i.lat), parseFloat(i.lon)]);
        if (!pts.length) { safeToast('⚠️ ยังไม่มีหมุดแผนงานที่ระบุพิกัดในกลุ่มนี้'); return; }
        calendarMapInstance.invalidateSize(); calendarMapInstance.fitBounds(pts, { padding: [35, 35], maxZoom: 16 });
    }
    async function switchCalendarLeftViewMode(mode, skipAutoFit = false) {
        calendarLeftViewMode = mode === 'map' ? 'map' : 'grid';
        const isMap = (calendarLeftViewMode === 'map');
        document.getElementById('pmCalendarGridPanel')?.classList.toggle('hidden', isMap);
        document.getElementById('pmCalendarMapPanel')?.classList.toggle('hidden', !isMap);
        const btnGrid = document.getElementById('pmViewTab-grid'), btnMap = document.getElementById('pmViewTab-map');
        if (btnGrid) btnGrid.className = !isMap ? 'px-3 py-1 rounded-lg bg-indigo-600 text-white shadow-sm' : 'px-3 py-1 rounded-lg text-slate-600 hover:bg-slate-200/60';
        if (btnMap) btnMap.className = isMap ? 'px-3 py-1 rounded-lg bg-indigo-600 text-white shadow-sm' : 'px-3 py-1 rounded-lg text-slate-600 hover:bg-slate-200/60';
        if (isMap) { await initCalendarEmbeddedMap(); if (!skipAutoFit) setTimeout(fitCalendarEmbeddedMapPins, 200); }
        else cancelPmMapInteractiveModes();
    }
    function openPmCalendarModal(presetDateIso = null) {
        injectPmModalsDOM(); ensurePmOutageZoneUiInjected(); injectQuickAddBoxIntoCalendar();
        if (pmPinDropModeActive || pmPinMoveTargetId) cancelPmMapInteractiveModes();
        isQuickInlineBoxVisible = false; setPmDesktopModalWidth(desktopModalWidthMode || '65vw');
        if (!document.getElementById('pmFullMonthFitStyle')) {
            const fitSt = document.createElement('style'); fitSt.id = 'pmFullMonthFitStyle';
            fitSt.textContent = `@media (max-width:639px){#pmCalendarModal .pm-day-cell{min-height:50px!important;padding:3px!important;}#pmCalendarDaysGrid{gap:4px!important;}}#pmCalendarMonthTitle,#pmCalendarGridPanel button[onclick="jumpPmCalendarToday()"]{white-space:nowrap;}`;
            document.head.appendChild(fitSt);
        }
        calendarLeftViewMode = 'grid';
        document.getElementById('pmCalendarGridPanel')?.classList.remove('hidden');
        document.getElementById('pmCalendarMapPanel')?.classList.add('hidden');
        const btnGrid = document.getElementById('pmViewTab-grid'), btnMap = document.getElementById('pmViewTab-map');
        if (btnGrid) btnGrid.className = 'px-3 py-1 rounded-lg bg-indigo-600 text-white shadow-sm';
        if (btnMap) btnMap.className = 'px-3 py-1 rounded-lg text-slate-600 hover:bg-slate-200/60';
        if (presetDateIso && /^\d{4}-\d{2}-\d{2}$/.test(presetDateIso)) { selectedDateIso = presetDateIso; const [y, m] = presetDateIso.split('-').map(Number); viewYear = y; viewMonth = m - 1; }
        else { const now = new Date(); viewYear = now.getFullYear(); viewMonth = now.getMonth(); selectedDateIso = toLocalIsoDate(now); }
        currentFilterStatus = 'day';
        const calModal = document.getElementById('pmCalendarModal'); calModal?.classList.remove('hidden');
        renderPmCalendarGrid(); renderPmSelectedDayList(); refreshPmAllViews();
        const scrollWrap = calModal?.querySelector('.pm-desktop-split');
        if (scrollWrap) { scrollWrap.scrollTop = 0; requestAnimationFrame(() => { scrollWrap.scrollTop = 0; }); }
    }
    function closePmCalendarModal() { discardUnsavedQuickPhotos(); isQuickInlineBoxVisible = false; cancelPmMapInteractiveModes(); document.getElementById('pmCalendarModal')?.classList.add('hidden'); }
    function changePmCalendarMonth(delta) { const d = new Date(viewYear, viewMonth + delta, 1); viewYear = d.getFullYear(); viewMonth = d.getMonth(); renderPmCalendarGrid(); renderPmSelectedDayList(); }
    function jumpPmCalendarToday() { const now = new Date(); viewYear = now.getFullYear(); viewMonth = now.getMonth(); selectedDateIso = toLocalIsoDate(now); currentFilterStatus = 'day'; renderPmCalendarGrid(); renderPmSelectedDayList(); updateQuickInlineBoxUI(); }
    function selectPmCalendarDate(isoStr) { selectedDateIso = isoStr; currentFilterStatus = 'day'; renderPmCalendarGrid(); renderPmSelectedDayList(); updateQuickInlineBoxUI(); }
    function setPmListStatusFilter(filterVal) { currentFilterStatus = filterVal || 'day'; renderPmSelectedDayList(); }
    function toggleShowScadaDueOnCalendar(checked) { showScadaDuePins = Boolean(checked); localStorage.setItem(PM_SHOW_SCADA_DUE_KEY, String(showScadaDuePins)); refreshPmAllViews(); }
    // ===== จบพาทที่ 4 / 6 ของไฟล์ pm-calendar.js =====
    // ===== เริ่มพาทที่ 5 / 6 ของไฟล์ pm-calendar.js =====
    function renderPmCalendarGrid() {
        const gridEl = document.getElementById('pmCalendarDaysGrid'), titleEl = document.getElementById('pmCalendarMonthTitle');
        const summaryEl = document.getElementById('pmMonthSummaryBar'), grpBadge = document.getElementById('pmHeaderGroupBadge');
        const scadaChk = document.getElementById('pmShowScadaDueChk'), mapCntEl = document.getElementById('pmCalMapPinCount');
        if (!gridEl) return;
        const allItems = getAllVisibleCalendarItems(), pinnedItemsCnt = allItems.filter(i => !isNaN(parseFloat(i.lat)) && !isNaN(parseFloat(i.lon))).length;
        if (grpBadge) grpBadge.textContent = `🏢 ${getActivePmGroup()}`;
        if (scadaChk) scadaChk.checked = showScadaDuePins;
        if (mapCntEl) mapCntEl.textContent = String(pinnedItemsCnt);
        if (titleEl) titleEl.textContent = `${THAI_MONTHS[viewMonth]} ${viewYear + 543}`;
        updateQuickInlineBoxUI();
        const monthPrefix = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-`, monthItems = allItems.filter(it => String(it.date || '').startsWith(monthPrefix));
        const byDate = new Map(); monthItems.forEach(it => { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); });
        const todayIso = getTodayIso(), pendingCnt = monthItems.filter(i => i.status !== 'done').length, doneCnt = monthItems.filter(i => i.status === 'done').length, alertCnt = getAlertCandidatesForToday().length;
        if (summaryEl) summaryEl.innerHTML = `<div class="bg-slate-100 border border-slate-200 rounded-xl py-1.5 px-1 font-bold text-slate-700">เดือนนี้ <b class="text-slate-900">${monthItems.length}</b></div><div class="bg-amber-50 border border-amber-200 rounded-xl py-1.5 px-1 font-bold text-amber-800">รอทำ <b>${pendingCnt}</b></div><div class="bg-emerald-50 border border-emerald-200 rounded-xl py-1.5 px-1 font-bold text-emerald-800">เสร็จแล้ว <b>${doneCnt}</b></div><div onclick="setPmListStatusFilter('alert')" class="cursor-pointer bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl py-1.5 px-1 font-extrabold text-rose-700">🔔 เตือน <b>${alertCnt}</b></div>`;
        const firstDow = new Date(viewYear, viewMonth, 1).getDay(), daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate(), cells = [];
        for (let b = 0; b < firstDow; b++) cells.push('<div class="rounded-xl bg-slate-50/60 border border-transparent"></div>');
        for (let day = 1; day <= daysInMonth; day++) {
            const iso = `${monthPrefix}${String(day).padStart(2, '0')}`, dayTasks = byDate.get(iso) || [], isToday = (iso === todayIso), isSel = (iso === selectedDateIso);
            const hasOverdue = dayTasks.some(t => t.status !== 'done' && calcDaysUntil(t.date, todayIso) < 0);
            const barsHtml = dayTasks.slice(0, 3).map(t => {
                const vis = getPlanPinVisualTheme(t), doneStyle = t.status === 'done' ? 'opacity:0.45;text-decoration:line-through;' : '', pinDot = (!isNaN(parseFloat(t.lat)) && !isNaN(parseFloat(t.lon))) ? '📍' : '', camDot = normalizePmPhotoIds(t).length > 0 ? '📷' : '', pubDot = (t.status !== 'done' && t.pub && t.oz) ? '📡' : '';
                return `<div class="truncate text-[9.5px] text-white font-bold px-1 rounded leading-tight" style="background:${vis.hex};${doneStyle}">${pubDot}${pinDot}${camDot}${vis.icon} ${safeEscHtml(t.title)}</div>`;
            }).join('');
            const moreHtml = dayTasks.length > 3 ? `<div class="text-[9px] font-extrabold text-indigo-700 leading-none">+อีก ${dayTasks.length - 3} งาน</div>` : '';
            cells.push(`<div onclick="selectPmCalendarDate('${iso}')" class="cursor-pointer pm-day-cell rounded-xl border p-1 flex flex-col items-stretch text-left bg-white ${isSel ? 'pm-day-selected' : 'border-slate-200'} ${isToday ? 'ring-2 ring-amber-400' : ''}"><div class="flex items-center justify-between w-full mb-0.5"><span class="text-[11px] font-extrabold ${isToday ? 'bg-amber-400 text-slate-950 px-1.5 rounded-full' : 'text-slate-700'}">${day}</span>${hasOverdue ? '<span class="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>' : (dayTasks.length > 0 ? `<span class="text-[9px] font-bold text-slate-400">${dayTasks.length}</span>` : '')}</div><div class="space-y-0.5 overflow-hidden flex-1">${barsHtml}${moreHtml}</div></div>`);
        }
        gridEl.innerHTML = cells.join('');
    }

    function renderPmSelectedDayList() {
        const listEl = document.getElementById('pmSelectedDayTasksContainer'), hdrEl = document.getElementById('pmSelectedListHeader'); if (!listEl) return;
        ['day', 'alert', 'all'].forEach(k => { const btn = document.getElementById('pmFilterBtn-' + k); if (btn) btn.className = currentFilterStatus === k ? 'py-1 rounded-lg bg-indigo-600 text-white shadow-sm' : 'py-1 rounded-lg text-slate-600 hover:bg-slate-200/70'; });
        const monthPrefix = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-`, todayIso = getTodayIso();
        let items = [];
        if (currentFilterStatus === 'alert') { items = getAlertCandidatesForToday(); if (hdrEl) hdrEl.innerHTML = `<span>🔔 งานถึงกำหนด / เตือนล่วงหน้า (${items.length})</span>`; }
        else if (currentFilterStatus === 'all') { items = getAllVisibleCalendarItems().filter(it => String(it.date || '').startsWith(monthPrefix)); if (hdrEl) hdrEl.innerHTML = `<span>📋 แผนงานทั้งเดือน ${THAI_MONTHS[viewMonth]} (${items.length})</span>`; }
        else { items = getAllVisibleCalendarItems().filter(it => it.date === selectedDateIso); if (hdrEl) hdrEl.innerHTML = `<span>📌 ${formatThaiDateFull(selectedDateIso)} (${items.length} งาน)</span>`; }
        if (!items.length) { listEl.innerHTML = `<div class="text-center py-8 px-4 bg-slate-50 rounded-2xl border border-dashed border-slate-300 text-xs text-slate-400">ยังไม่มีแผนงานในวันนี้ กดปุ่ม <b>➕ ปักแผนใหม่</b> ด้านบนเพื่อเพิ่มแผนงานและรูปภาพได้เลยครับ</div>`; return; }
        const allowEdit = canManagePmSchedule(), allowDone = canCompletePmTask();
        listEl.innerHTML = items.map(item => {
            const cat = getCategoryMeta(item.category), alCfg = getPlanEffectiveAlertConfig(item), isDone = item.status === 'done';
            const daysLeft = calcDaysUntil(item.date, todayIso), safeId = String(item.id).replace(/'/g, "\\'"), hasCoord = !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lon));
            const pCount = normalizePmPhotoIds(item).length;
            const hasPublicAnnounce = !item.isScadaPinDue && ((item.pub && item.oz) || Boolean(item.pubPlaces));
            const dueBadge = isDone ? '<span class="bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded-full">✅ เสร็จแล้ว</span>'
                : (daysLeft < 0 ? `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">🚨 เลย ${Math.abs(daysLeft)} วัน</span>`
                : (daysLeft === 0 ? '<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">📌 วันนี้</span>' : `<span class="bg-slate-100 text-slate-600 text-[10px] font-bold px-2 py-0.5 rounded-full">อีก ${daysLeft} วัน</span>`));
            return `<div class="p-3 rounded-2xl border ${isDone ? 'bg-slate-50 border-slate-200 opacity-75' : 'bg-white border-slate-200 shadow-sm'} space-y-1.5 text-xs"><div class="flex items-start justify-between gap-2"><div class="space-y-0.5 min-w-0 flex-1"><div class="flex items-center gap-1 flex-wrap"><span class="border text-[10px] font-bold px-1.5 py-0.5 rounded ${cat.pillCls}">${cat.icon} ${cat.name}</span>${hasCoord ? '<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-1.5 py-0.5 rounded">📍 มีหมุด</span>' : ''}${(!isDone && item.pub && item.oz) ? '<span onclick="openPublicOutageMapPage()" title="คลิกเปิดดูแมพเรดาร์ประชาชน" class="cursor-pointer bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-[10px] font-extrabold px-1.5 py-0.5 rounded">📡 เรดาร์ประชาชน</span>' : ''}${pCount > 0 ? `<span onclick="openPmPhotoLightbox('${safeId}', 0)" class="cursor-pointer bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200 text-[10px] font-bold px-1.5 py-0.5 rounded">📷 ${pCount} รูป</span>` : ''}</div><div ${(!item.isScadaPinDue && allowEdit) ? `onclick="quickEditPmPlanTitle('${safeId}')" title="คลิกเพื่อแก้ข้อความด่วน"` : ''} class="font-extrabold text-slate-800 text-xs sm:text-sm break-words ${(!item.isScadaPinDue && allowEdit) ? 'cursor-pointer hover:text-indigo-700' : ''} ${isDone ? 'line-through' : ''}">${safeEscHtml(item.title)}</div></div><div class="shrink-0 flex items-center gap-1">${dueBadge}${(!item.isScadaPinDue && allowEdit) ? `<button type="button" onclick="quickDeletePmPlanCard('${safeId}')" class="text-slate-300 hover:text-rose-600 font-bold text-sm px-1" title="ลบแผนงาน">&times;</button>` : ''}</div></div><div class="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600"><span>📅 ${formatThaiDateShort(item.date)} (${safeEscHtml(item.timeSlot || '-')})</span><span>• เตือนล่วงหน้า ${Number(item.notifyDaysBefore ?? 3)} วัน</span><span ${(!item.isScadaPinDue && allowEdit) ? `onclick="openPmPlanFormModal('${safeId}')" title="คลิกเพื่อตั้งเวลาเตือนของงานนี้"` : ''} class="bg-indigo-50 text-indigo-800 border border-indigo-200 px-1.5 py-0.5 rounded font-bold text-[10px] ${(!item.isScadaPinDue && allowEdit) ? 'cursor-pointer hover:bg-indigo-100' : ''}">${safeEscHtml(alCfg.badgeLabel)}</span></div>${item.equipCode ? `<div class="text-[11px] font-bold text-teal-800">⚡ อุปกรณ์: ${safeEscHtml(item.equipCode)} ${item.feeder ? `(${safeEscHtml(item.feeder)})` : ''}</div>` : ''}${item.note ? `<div class="text-[11px] text-slate-500 break-words">📝 ${safeEscHtml(item.note)}</div>` : ''}${item.pubPlaces ? `<div class="text-[11px] text-rose-900 bg-rose-50/80 border border-rose-200 rounded-lg px-2 py-1 break-words">🏘️ <b>พื้นที่ไฟดับ:</b> ${safeEscHtml(item.pubPlaces)}</div>` : ''}${pCount > 0 ? buildPmPhotoStripHtml(item, 'card') : ''}<div class="pt-1.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-1.5"><div class="flex flex-wrap gap-1">${hasCoord ? `<button type="button" onclick="focusPmPlanPinOnMap('${safeId}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-1 rounded-lg text-[10px] font-bold">📍 ดูหมุด</button><button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">🗺️ นำทาง</button>` : ''}<button type="button" onclick="shareSinglePmPlanToLine('${safeId}')" class="bg-[#00B900] hover:bg-[#009900] text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">${pCount > 0 ? `💬 LINE (${pCount} รูป)` : '💬 LINE'}</button>${hasPublicAnnounce ? `<button type="button" onclick="openPmPublicAnnounceModal('${safeId}')" class="bg-rose-600 hover:bg-rose-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-extrabold shadow-sm">📢 โพสต์ FB/LINE</button>` : ''}${(!item.isScadaPinDue && allowEdit) ? `<button type="button" onclick="openPmPlanFormModal('${safeId}')" class="bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 px-2 py-1 rounded-lg text-[10px] font-bold">✏️ แก้ไข/รูป</button>` : ''}</div>${(!item.isScadaPinDue && allowDone) ? `<button type="button" onclick="togglePmPlanCompleteStatus('${safeId}')" class="${isDone ? 'bg-slate-200 text-slate-700' : 'bg-emerald-600 hover:bg-emerald-700 text-white'} px-2.5 py-1 rounded-lg text-[10px] font-extrabold shadow-sm">${isDone ? '↩️ เปิดใหม่' : '✅ เสร็จสิ้น'}</button>` : ''}</div></div>`;
        }).join('');
    }

    function showPmAlertSummaryModal(roundTitle, candidates) {
        injectPmModalsDOM(); updatePmSoundAndNotifButtonsUI();
        const modal = document.getElementById('pmAlertPopupModal'), titleEl = document.getElementById('pmAlertPopupTitle'), bodyEl = document.getElementById('pmAlertPopupBody');
        if (!modal || !bodyEl) return;
        const isLogged = isUserCurrentlyLoggedIn();
        if (titleEl) titleEl.textContent = roundTitle;
        const closeX = document.getElementById('pmAlertPopupCloseX');
        if (closeX) closeX.onclick = () => { isPopupOpenedByForcePreview = false; modal.classList.add('hidden'); };
        const loggedOutHeader = !isLogged ? `<div class="p-2.5 rounded-xl bg-slate-900 text-amber-300 border border-amber-400/60 text-[11px] font-bold">🔒 แจ้งเตือนอัตโนมัติขณะออกจากระบบ (🏢 ${safeEscHtml(getActivePmGroup())})</div>` : '';
        bodyEl.innerHTML = loggedOutHeader + candidates.map(c => {
            const cat = getCategoryMeta(c.category), alCfg = getPlanEffectiveAlertConfig(c), safeId = String(c.id).replace(/'/g, "\\'"), hasCoord = !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lon));
            const pCount = normalizePmPhotoIds(c).length;
            const hasPublicAnnounce = !c.isScadaPinDue && ((c.pub && c.oz) || Boolean(c.pubPlaces));
            const badge = c.daysLeft < 0 ? `<span class="bg-rose-600 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full">เลยกำหนด ${Math.abs(c.daysLeft)} วัน</span>` : (c.daysLeft === 0 ? `<span class="bg-amber-500 text-slate-950 text-[10px] font-extrabold px-2 py-0.5 rounded-full">📌 วันนี้ (${safeEscHtml(c.timeSlot || '-')})</span>` : `<span class="bg-sky-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">อีก ${c.daysLeft} วัน (${formatThaiDateShort(c.date)})</span>`);
            return `<div class="p-3 bg-white rounded-2xl border border-slate-200 shadow-sm space-y-1.5"><div class="flex items-center justify-between gap-2">${badge}<span class="text-[10px] font-bold text-indigo-700">${safeEscHtml(alCfg.badgeLabel)}</span></div><div class="font-extrabold text-slate-800 text-xs sm:text-sm">${cat.icon} ${safeEscHtml(c.title)}</div>${pCount > 0 ? buildPmPhotoStripHtml(c, 'popup') : ''}<div class="pt-1 flex flex-wrap gap-1.5">${hasCoord && isLogged ? `<button type="button" onclick="focusPmPlanPinOnMap('${safeId}')" class="bg-indigo-50 text-indigo-700 border border-indigo-200 px-2.5 py-1 rounded-lg text-[10px] font-bold">📍 ดูหมุดบนแมพ</button>` : ''}${hasCoord ? `<button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-600 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">🗺️ นำทาง Maps</button>` : ''}<button type="button" onclick="shareSinglePmPlanToLine('${safeId}')" class="bg-[#00B900] text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">${pCount > 0 ? `💬 LINE (${pCount} รูป)` : '💬 LINE'}</button>${hasPublicAnnounce ? `<button type="button" onclick="openPmPublicAnnounceModal('${safeId}')" class="bg-rose-600 text-white px-2.5 py-1 rounded-lg text-[10px] font-extrabold">📢 โพสต์ FB/LINE</button>` : ''}</div></div>`;
        }).join('');
        const calOrLoginBtn = document.getElementById('pmAlertModalCalOrLoginBtn');
        if (calOrLoginBtn) {
            calOrLoginBtn.textContent = isLogged ? '📅 ดูปฏิทิน/แมพ' : '🔐 ล็อกอินเพื่อจัดการ';
            calOrLoginBtn.onclick = () => { isPopupOpenedByForcePreview = false; modal.classList.add('hidden'); if (isUserCurrentlyLoggedIn()) _safeOpenPmCalendarModal(); else (document.getElementById('loginUsername') || document.getElementById('techUsername'))?.focus(); };
        }
        modal.classList.remove('hidden');
    }

    function refreshPmAllViews() {
        updatePmSoundAndNotifButtonsUI();
        if (isUserCurrentlyLoggedIn()) { updatePmHeaderBadgesAndStrip(); renderAllExternalPmMapLayers(); }
        const alModal = document.getElementById('pmAlertPopupModal');
        if (alModal) {
            if (alModal.classList.contains('hidden')) isPopupOpenedByForcePreview = false;
            else if (!isPopupOpenedByForcePreview && !hasAnyUnackedActiveAlertNow()) alModal.classList.add('hidden');
        }
        const calModal = document.getElementById('pmCalendarModal');
        if (calModal && !calModal.classList.contains('hidden')) { injectQuickAddBoxIntoCalendar(); renderPmCalendarGrid(); renderPmSelectedDayList(); }
    }

    function copyPmTextSafe(text, successMsg) {
        if (typeof window.copyTextToClipboard === 'function') return window.copyTextToClipboard(text, successMsg);
        if (typeof window.copyTechText === 'function') return window.copyTechText(text, successMsg);
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => { if (successMsg) safeToast(successMsg); }).catch(() => {});
    }
    function loadPmXlsxSafe() {
        if (typeof XLSX !== 'undefined') return Promise.resolve(true);
        if (typeof window.ensureXlsxLoaded === 'function') return window.ensureXlsxLoaded();
        if (typeof window.ensureTechXlsxLoaded === 'function') return window.ensureTechXlsxLoaded();
        return new Promise(res => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; s.onload = () => res(true); s.onerror = () => res(false); document.head.appendChild(s); });
    }
    if (typeof window.showCustomPrompt !== 'function') {
        window.showCustomPrompt = function (message, defaultValue = '', onConfirm, title = '✏️ แก้ไขข้อมูล') {
            let modal = document.getElementById('pmFallbackPromptModal');
            if (!modal) {
                modal = document.createElement('div'); modal.id = 'pmFallbackPromptModal'; modal.className = 'fixed inset-0 z-[1460] flex items-center justify-center bg-slate-950/65 backdrop-blur-sm p-4';
                modal.innerHTML = `<div class="bg-slate-800 text-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4 border border-slate-700"><h3 id="pmFallbackPromptTitle" class="text-base font-bold text-amber-400"></h3><p id="pmFallbackPromptMsg" class="text-xs text-slate-200"></p><input type="text" id="pmFallbackPromptInput" class="w-full px-3.5 py-2 text-slate-800 font-semibold rounded-xl text-sm bg-white focus:outline-none"><div class="flex justify-end gap-2 pt-1"><button type="button" onclick="document.getElementById('pmFallbackPromptModal').classList.add('hidden')" class="text-slate-300 px-4 py-2 rounded-xl text-xs font-bold">ยกเลิก</button><button type="button" id="pmFallbackPromptOk" class="bg-blue-500 hover:bg-blue-600 text-white font-bold text-xs px-5 py-2 rounded-xl shadow">บันทึก</button></div></div>`;
                document.body.appendChild(modal);
            }
            document.getElementById('pmFallbackPromptTitle').textContent = title; document.getElementById('pmFallbackPromptMsg').textContent = message;
            const inp = document.getElementById('pmFallbackPromptInput'); inp.value = defaultValue || '';
            const submit = () => { modal.classList.add('hidden'); if (typeof onConfirm === 'function') onConfirm(inp.value); };
            document.getElementById('pmFallbackPromptOk').onclick = submit; inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
            modal.classList.remove('hidden'); setTimeout(() => inp.focus(), 60);
        };
    }

    // ========================================================================
    // 9. เอนจินวาดโซนเรดาร์ประชาชน + ดูดชื่อสถานที่ในกรอบไฟดับ & สร้างโพสต์ FB/LINE
    // ========================================================================
    function renderPmCustomTimeChips() {
        const wrap = document.getElementById('pmCustomTimeChipsWrap'); if (!wrap) return;
        tempFormCustomTimes = normalizeCustomTimesArray(tempFormCustomTimes);
        if (!tempFormCustomTimes.length) { wrap.innerHTML = '<span class="text-[10.5px] text-slate-400 italic">ยังไม่ได้เพิ่มเวลาเตือนพิเศษ (เลือกเวลาด้านบนแล้วกด ➕ เพิ่มเวลาเตือน)</span>'; return; }
        wrap.innerHTML = tempFormCustomTimes.map(t => `<span class="inline-flex items-center gap-1 bg-indigo-600 text-white px-2.5 py-1 rounded-full text-[11px] font-mono font-extrabold shadow-sm">⏰ ${safeEscHtml(t)} น.<button type="button" onclick="removePmCustomTimeChip('${safeEscHtml(t)}')" class="ml-0.5 text-indigo-200 hover:text-white font-bold leading-none">&times;</button></span>`).join('');
    }
    function onPmAlertModeChange(modeVal) {
        const showCustom = (modeVal === 'both' || modeVal === 'custom_only');
        document.getElementById('pmCustomTimesSection')?.classList.toggle('hidden', !showCustom);
        if (showCustom) renderPmCustomTimeChips();
    }
    function addPmCustomTimeChip(presetTime = '') {
        const clean = normalizeTimeHHMM(presetTime || (document.getElementById('pmCustomTimePickerInput')?.value || ''));
        if (!clean) { safeToast('⚠️ กรุณาเลือกเวลาแจ้งเตือนในรูปแบบ HH:MM'); return; }
        const modeSel = document.getElementById('pmAlertModeSelect');
        if (modeSel && (modeSel.value === 'standard' || modeSel.value === 'off')) { modeSel.value = 'both'; onPmAlertModeChange('both'); }
        if (!tempFormCustomTimes.includes(clean)) { tempFormCustomTimes.push(clean); tempFormCustomTimes = normalizeCustomTimesArray(tempFormCustomTimes); renderPmCustomTimeChips(); }
        else safeToast(`⏰ เวลา ${clean} น. อยู่ในรายการเตือนแล้ว`);
    }
    function removePmCustomTimeChip(timeStr) { tempFormCustomTimes = tempFormCustomTimes.filter(t => t !== timeStr); renderPmCustomTimeChips(); }

    function selectPmFormPinColor(colorKey) {
        const validKey = PM_PIN_COLORS[colorKey] ? colorKey : 'auto', inp = document.getElementById('pmPinColorInput');
        if (inp) inp.value = validKey;
        Object.keys(PM_PIN_COLORS).forEach(k => {
            const btn = document.getElementById('pmFormColorBtn-' + k);
            if (btn) btn.className = k === validKey ? 'px-2.5 py-1 rounded-lg border-2 border-indigo-600 bg-indigo-50 text-indigo-900 text-[10px] font-extrabold shadow-sm transition' : 'px-2 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 text-[10px] font-bold transition opacity-80';
        });
    }
    function populatePmScadaPinPicker(selectedPinId = '') {
        const picker = document.getElementById('pmScadaPinPicker'); if (!picker) return;
        try {
            const pins = JSON.parse(rawGet('elec_labeled_places_list') || '[]'), delMap = JSON.parse(rawGet('elec_deleted_labeled_places_map') || '{}'), { role, explicitGroup } = getEffectiveRoleAndExplicitGroup();
            const visiblePins = pins.filter(p => p?.id && !delMap[p.id] && ((role === 'admin' && !explicitGroup) || normPmGrp(p.ownerGroup || 'กฟส.บึง') === getActivePmGroup())).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'th'));
            picker.innerHTML = `<option value="">-- เลือกอุปกรณ์จากผัง SCADA (${visiblePins.length} จุด) --</option>` + visiblePins.map(p => `<option value="${safeEscHtml(p.id)}" ${p.id === selectedPinId ? 'selected' : ''}>⚡ ${safeEscHtml(p.name)}${p.scadaNode?.fd ? safeEscHtml(` [${p.scadaNode.fd}]`) : ''}</option>`).join('');
        } catch (e) { picker.innerHTML = '<option value="">-- ไม่พบรายการหมุดอุปกรณ์ --</option>'; }
    }

    let miniMapSyncSeq = 0;
    let tempPubEnabled = false;
    let tempZoneType = 'c';
    let tempCircleCenter = null;
    let tempCircleRadius = 300;
    let tempPolyPts = [];
    let pubDrawSubMode = 'circle'; // 'circle' | 'poly_click' | 'poly_lasso'
    let isMiniMapFullscreen = false;
    let formZoneShapeLayer = null;
    let formZoneHandlesLayer = null;
    let calMapZoneLayer = null;
    let lassoPolyline = null;
    let lassoRawPts = [];
    let isLassoDragging = false;
    let lastLassoFinishMs = 0;

        // ตัวแปรจัดการดูดชื่อสถานที่ในกรอบไฟดับ + AI Vision อ่านป้ายแผนที่แยกโควตารายกลุ่ม 100%
          const PM_GROUP_AI_KEY_PREFIX = 'elec_pm_ai_vision_key_v1__';
        const FALLBACK_GEMINI_VISION_MODELS = [
        'gemini-3.5-flash-lite',
        'gemini-3.8-flash',
        'gemini-3-flash',
        'gemini-3-flash-preview',
        'gemini-3.1-flash-lite-preview',
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash'
    ];
        const resolvedModelsByKeyCache = new Map();
    const unsupportedGeminiModels = new Set();
    let tempPubPlacesList = [];
    let isExtractingZonePlaces = false;
    let currentAnnounceModalItem = null;
    let currentAnnounceStyleMode = 'facebook';
    let pendingRunScanAfterKeySave = false;
    let directGoogleTileCorsBlocked = false;

    async function resolveAvailableVisionModelsPm(apiKey) {
        const keyTag = String(apiKey || '').slice(-10);
        const filterUnsupported = list => list.filter(m => !unsupportedGeminiModels.has(`${keyTag}:${m}`));
        if (resolvedModelsByKeyCache.has(keyTag)) {
            const cached = filterUnsupported(resolvedModelsByKeyCache.get(keyTag));
            if (cached.length > 0) return cached;
        }
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(apiKey)}`;
            const res = await _origFetchForPm(url, { signal: ctrl ? ctrl.signal : undefined });
            const data = await res.json().catch(() => null);
            if (res.status === 400 || res.status === 403) {
                const errMsg = String(data?.error?.message || '');
                if (/API_KEY_INVALID|API key not valid|key expired|PERMISSION_DENIED/i.test(errMsg)) {
                    const keyErr = new Error('API Key ไม่ถูกต้อง ถูกจำกัดสิทธิ์โดเมน หรือหมดอายุ กรุณาตั้งค่าคีย์ AI ใหม่');
                    keyErr.isInvalidKey = true;
                    throw keyErr;
                }
            }
            if (res.ok && Array.isArray(data?.models)) {
                const candidates = [];
                data.models.forEach(m => {
                    if (!Array.isArray(m?.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent')) return;
                    const id = String(m.name || '').replace(/^models\//, '').trim();
                    const match = id.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(-preview)?$/i);
                    if (!match) return;
                    const ver = parseFloat(match[1]);
                    if (isNaN(ver) || ver < 2.5) return;
                    const isLite = Boolean(match[2]);
                    const isPreview = Boolean(match[3]);
                    const retiringPenalty = id.toLowerCase() === 'gemini-2.5-flash' ? -25 : 0;
                    const score = (ver >= 3 ? 1000 : 0) + (ver * 100) + (isPreview ? 0 : 20) + (isLite ? 0 : 15) + retiringPenalty;
                    candidates.push({ id, score });
                });
                candidates.sort((a, b) => b.score - a.score);
                const ordered = candidates.map(c => c.id);
                if (ordered.length > 0) {
                    resolvedModelsByKeyCache.set(keyTag, ordered);
                    return filterUnsupported(ordered);
                }
            }
        } catch (err) {
            if (err?.isInvalidKey) throw err;
        } finally {
            if (timer) clearTimeout(timer);
        }
        return filterUnsupported(FALLBACK_GEMINI_VISION_MODELS);
    }

    function getGroupAiStorageKey(groupName = getActivePmGroup()) {
        const grp = normPmGrp(groupName || 'กฟส.บึง') || 'กฟส.บึง';
        return `${PM_GROUP_AI_KEY_PREFIX}${grp}`;
    }

    function getCurrentGroupAiApiKey() {
        const k = getGroupAiStorageKey();
        let val = '';
        try { val = localStorage.getItem(k) || ''; } catch (e) {}
        return String(val || rawGet(k) || '').trim();
    }

    function maskAiApiKeyPm(rawKey) {
        const k = String(rawKey || '').trim();
        if (k.length < 12) return '';
        return `${k.slice(0, 8)}••••••••${k.slice(-4)}`;
    }

    function updateGroupAiKeyButtonsUI() {
        const hasKey = Boolean(getCurrentGroupAiApiKey());
        const grp = getActivePmGroup();
        const btnMap = document.getElementById('btnConfigGroupAiKeyMap');
        if (btnMap) {
            btnMap.textContent = hasKey ? '🔑 AI: พร้อม' : '🔑 ตั้งคีย์ AI';
            btnMap.title = `ตั้งค่า Gemini API Key เฉพาะกลุ่ม ${grp} (แยกโควตา 100%)`;
            btnMap.className = hasKey
                ? 'bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/60 px-2 py-1 rounded-lg text-[10px] font-extrabold shrink-0'
                : 'bg-amber-400 hover:bg-amber-300 text-slate-950 px-2 py-1 rounded-lg text-[10px] font-extrabold shadow shrink-0';
        }
        const btnForm = document.getElementById('btnConfigGroupAiKeyForm');
        if (btnForm) {
            btnForm.textContent = hasKey ? '🔑 คีย์ AI: พร้อม' : '🔑 ตั้งคีย์ AI กลุ่ม';
            btnForm.title = `ตั้งค่า Gemini API Key เฉพาะกลุ่ม ${grp} (แยกโควตา 100%)`;
            btnForm.className = hasKey
                ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 px-2 py-1 rounded-lg text-[10px] font-extrabold'
                : 'bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-400 px-2 py-1 rounded-lg text-[10px] font-extrabold';
        }
    }

    function openPmAiKeyModal(runScanAfterSave = false) {
        injectPmModalsDOM();
        ensurePmOutageZoneUiInjected();
        pendingRunScanAfterKeySave = Boolean(runScanAfterSave);
        const grp = getActivePmGroup();
        const savedKey = getCurrentGroupAiApiKey();
        const grpBadge = document.getElementById('pmAiKeyModalGroupBadge');
        const statusEl = document.getElementById('pmAiKeyCurrentStatus');
        const inp = document.getElementById('pmAiKeyInput');
        const saveBtn = document.getElementById('pmAiKeySaveBtn');
        const clearBtn = document.getElementById('pmAiKeyClearBtn');
        const skipBtn = document.getElementById('pmAiKeySkipBasicBtn');

        if (grpBadge) grpBadge.textContent = `🏢 โควตาแยกเฉพาะกลุ่ม: ${grp} (ไม่ปนกับกลุ่มอื่น 100%)`;
        if (statusEl) {
            statusEl.innerHTML = savedKey
                ? `สถานะปัจจุบัน: <b class="text-emerald-700">ผูกคีย์แล้ว (${safeEscHtml(maskAiApiKeyPm(savedKey))})</b>`
                : `สถานะปัจจุบัน: <b class="text-rose-600">ยังไม่ได้ตั้งค่าคีย์ AI สำหรับกลุ่ม ${safeEscHtml(grp)} ในเครื่องนี้</b>`;
        }
        if (inp) inp.value = savedKey;
        if (saveBtn) saveBtn.textContent = pendingRunScanAfterKeySave ? '💾 บันทึกคีย์ & ดูดชื่อทันที' : '💾 บันทึกคีย์ประจำกลุ่ม';
        if (clearBtn) clearBtn.classList.toggle('hidden', !savedKey);
        if (skipBtn) skipBtn.classList.toggle('hidden', !pendingRunScanAfterKeySave);

        document.getElementById('pmAiKeyConfigModal')?.classList.remove('hidden');
        setTimeout(() => inp?.focus(), 60);
    }

    function closePmAiKeyModal() {
        pendingRunScanAfterKeySave = false;
        document.getElementById('pmAiKeyConfigModal')?.classList.add('hidden');
    }

    function savePmGroupAiKeyFromModal() {
        const inp = document.getElementById('pmAiKeyInput');
        const keyMatch = String(inp?.value || '').trim().match(/AIza[0-9A-Za-z_-]{25,60}/);
        const cleanKey = keyMatch ? keyMatch[0] : '';
        if (!cleanKey) {
            safeToast('⚠️ รูปแบบ API Key ไม่ถูกต้อง (คีย์จาก Google AI Studio ต้องขึ้นต้นด้วย AIza...)');
            inp?.focus();
            return;
        }
        const grp = getActivePmGroup();
        try {
            localStorage.setItem(getGroupAiStorageKey(grp), cleanKey);
        } catch (e) {
            safeToast('❌ พื้นที่เก็บข้อมูลเบราว์เซอร์เต็ม ไม่สามารถบันทึกคีย์ได้');
            return;
        }
        const shouldScanNow = pendingRunScanAfterKeySave;
        closePmAiKeyModal();
        updateGroupAiKeyButtonsUI();
        safeToast(`✅ บันทึกคีย์ AI แยกเฉพาะกลุ่ม "${grp}" เรียบร้อยแล้ว`);
        if (shouldScanNow) extractPlacesInCurrentOutageZone(false);
    }

    function clearPmGroupAiKeyFromModal() {
        const grp = getActivePmGroup();
        try { localStorage.removeItem(getGroupAiStorageKey(grp)); } catch (e) {}
        const inp = document.getElementById('pmAiKeyInput');
        if (inp) inp.value = '';
        updateGroupAiKeyButtonsUI();
        closePmAiKeyModal();
        safeToast(`🗑️ ลบคีย์ AI ของกลุ่ม "${grp}" ออกจากเครื่องนี้แล้ว`);
    }

    function skipAiAndExtractBasicZonePlaces() {
        closePmAiKeyModal();
        extractPlacesInCurrentOutageZone(true);
    }

    function getZoneCentroidPm(oz) {
        if (!oz) return null;
        if (oz.t === 'c' && Array.isArray(oz.c)) return { lat: oz.c[0], lon: oz.c[1] };
        if (oz.t === 'p' && Array.isArray(oz.p) && oz.p.length >= 3) {
            let sLat = 0, sLon = 0;
            oz.p.forEach(pt => { sLat += pt[0]; sLon += pt[1]; });
            return { lat: Number((sLat / oz.p.length).toFixed(6)), lon: Number((sLon / oz.p.length).toFixed(6)) };
        }
        return null;
    }

    function simplifyPolyRdpPm(pts, tolDeg) {
        if (pts.length <= 3) return pts;
        const sqDistSeg = (p, a, b) => {
            let x = a[1], y = a[0], dx = b[1] - x, dy = b[0] - y;
            if (dx !== 0 || dy !== 0) {
                const t = Math.max(0, Math.min(1, ((p[1] - x) * dx + (p[0] - y) * dy) / (dx * dx + dy * dy)));
                x += dx * t; y += dy * t;
            }
            return (p[1] - x) ** 2 + (p[0] - y) ** 2;
        };
        const rdp = (arr, sqTol) => {
            let maxD = 0, idx = 0;
            for (let i = 1; i < arr.length - 1; i++) {
                const d = sqDistSeg(arr[i], arr[0], arr[arr.length - 1]);
                if (d > maxD) { idx = i; maxD = d; }
            }
            if (maxD > sqTol) {
                const left = rdp(arr.slice(0, idx + 1), sqTol);
                const right = rdp(arr.slice(idx), sqTol);
                return left.slice(0, -1).concat(right);
            }
            return [arr[0], arr[arr.length - 1]];
        };
        let tol = tolDeg || 0.00012;
        let out = rdp(pts, tol * tol);
        while (out.length > 26) { tol *= 1.45; out = rdp(pts, tol * tol); }
        return out.map(pt => [Number(pt[0].toFixed(5)), Number(pt[1].toFixed(5))]);
    }

    function buildPublicOutageMapShareUrl() {
        const base = new URL('./outage-map.html', window.location.href);
        const grp = String(getActivePmGroup() || 'กฟส.บึง').trim();
        const safeGrpParam = /\s/.test(grp) ? encodeURIComponent(grp) : grp;
        return `${base.origin}${base.pathname}?g=${safeGrpParam}`;
    }

    function openPublicOutageMapPage() {
        window.open(buildPublicOutageMapShareUrl(), '_blank');
    }

    function copyPublicOutageMapLink() {
        const url = buildPublicOutageMapShareUrl();
        const msg = `📡 แผนที่ตรวจสอบพื้นที่แผนดับไฟล่วงหน้า (${getActivePmGroup()})\nตรวจสอบพิกัดบ้านหรือที่ทำงานของคุณได้ที่:\n${url}`;
        copyPmTextSafe(msg, '📋 คัดลอกลิงก์แมพแจ้งดับไฟประชาชนแล้ว ส่งเข้า LINE ได้เลย!');
    }

    function haversineMetersPm(lat1, lon1, lat2, lon2) {
        const R = 6371000, rad = x => x * Math.PI / 180;
        const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function isPointInPolyPm(lat, lon, pts) {
        if (!Array.isArray(pts) || pts.length < 3) return false;
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const yi = pts[i][0], xi = pts[i][1], yj = pts[j][0], xj = pts[j][1];
            const intersect = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function isPointInsidePmZone(lat, lon, oz) {
        if (!oz || isNaN(lat) || isNaN(lon)) return false;
        if (oz.t === 'c' && Array.isArray(oz.c)) return haversineMetersPm(lat, lon, oz.c[0], oz.c[1]) <= oz.r;
        if (oz.t === 'p' && Array.isArray(oz.p)) return isPointInPolyPm(lat, lon, oz.p);
        return false;
    }

    function isLikelyInternalScadaCode(nameStr) {
        const s = String(nameStr || '').trim();
        if (!s || s.length < 2) return true;
        if (/^(?:[A-Z]{2,5}\d{1,3}(?:[-_/\s]*[A-Z0-9.-]+)*|(?:PEA|TR|SW|ABS|RCS|VCS|LB|DS|FUSE|CAP|RECLOSER|FEEDER)(?:[-_\s.#]*[A-Z0-9.-]+)*)$/i.test(s)) return true;
        if (/^[A-Z0-9_./-]+$/i.test(s) && /\d/.test(s) && !/^(?:3BB|7-Eleven)$/i.test(s)) return true;
        return false;
    }

    // ป้องกันการหั่นชื่อบริษัทที่มี Co., Ltd. / Inc. / Corp. แยกเป็น 2 ป้าย
        function parsePlacesTextToList(rawStr) {
        const seen = new Set();
        const out = [];
        const src = Array.isArray(rawStr) ? rawStr.join('\n') : String(rawStr || '');
        const safeStr = src
            .replace(/\b(Co(?:\.|mpany)?)\s*,\s*(Ltd\.?|Limited)(?!\w)/gi, '$1\u0000 $2')
            .replace(/([A-Za-z0-9.)])\s*,\s*(Inc\.?|LLC|Corp\.?|PLC)(?!\w)/gi, '$1\u0000 $2');
        safeStr.split(/\s*[,،\n]+\s*/).forEach(part => {
            const clean = part.replace(/\u0000/g, ',').replace(/\s+/g, ' ').trim();
            const key = clean.toLowerCase();
            if (clean && !seen.has(key)) {
                seen.add(key);
                out.push(clean);
            }
        });
        return out;
    }
    function isAdminAreaSummaryItemPm(s) {
        return /^(?:ต\.|ตำบล|แขวง)\S+\s+(?:อ\.|อำเภอ|เขต)\S+/i.test(String(s || '').trim());
    }

    function buildPlacesChipsHtmlPm() {
        return tempPubPlacesList.length > 0
            ? tempPubPlacesList.map((name, idx) =>
                `<span class="inline-flex items-center gap-1 bg-rose-100 text-rose-950 border border-rose-300 px-2 py-0.5 rounded-full text-[10.5px] font-bold">${safeEscHtml(name)}<button type="button" onclick="removeTempPubPlaceAt(${idx})" class="text-rose-500 hover:text-rose-800 font-extrabold leading-none ml-0.5">&times;</button></span>`
            ).join('')
            : '<span class="text-[10px] text-slate-400 italic">ยังไม่มีรายชื่อสถานที่ — กดปุ่ม "🔍 ดูดชื่อสถานที่ในกรอบ" เพื่อให้ AI กวาดป้ายหอพัก/บริษัทในกรอบได้เลย</span>';
    }

    function renderTempPubPlacesUI(syncTextarea = true) {
        if (syncTextarea) {
            const joined = tempPubPlacesList.join(', ');
            const txtEl = document.getElementById('pmPubOutagePlacesInput');
            if (txtEl && txtEl.value !== joined) txtEl.value = joined;
        }
        const cntBadge = document.getElementById('pmZonePlacesCountBadge');
        if (cntBadge) cntBadge.textContent = String(tempPubPlacesList.length);
        const mapRow = document.getElementById('pmMapZonePlacesRow');
        if (mapRow) {
            mapRow.classList.toggle('hidden', tempPubPlacesList.length === 0);
            mapRow.classList.toggle('flex', tempPubPlacesList.length > 0);
        }
        const chipsHtml = buildPlacesChipsHtmlPm();
        const mapChipBox = document.getElementById('pmMapZonePlacesChipsWrap');
        if (mapChipBox) mapChipBox.innerHTML = chipsHtml;
        const formChipBox = document.getElementById('pmFormZonePlacesChipsWrap');
        if (formChipBox) formChipBox.innerHTML = chipsHtml;
    }

    function onPubPlacesTextareaInput(val) {
        tempPubPlacesList = parsePlacesTextToList(val);
        renderTempPubPlacesUI(false);
    }

    function addManualTempPubPlace(rawTextOpt) {
        const inp = document.getElementById('pmMapQuickPlaceAddInput');
        const raw = typeof rawTextOpt === 'string' ? rawTextOpt : (inp?.value || '');
        const additions = parsePlacesTextToList(raw);
        if (!additions.length) return;
        tempPubPlacesList = parsePlacesTextToList([...tempPubPlacesList, ...additions]);
        if (inp && typeof rawTextOpt !== 'string') inp.value = '';
        renderTempPubPlacesUI(true);
        if (isMiniMapFullscreen) setTimeout(() => formMiniMap?.invalidateSize(), 60);
    }

    function removeTempPubPlaceAt(idx) {
        tempPubPlacesList.splice(idx, 1);
        renderTempPubPlacesUI(true);
        if (isMiniMapFullscreen) setTimeout(() => formMiniMap?.invalidateSize(), 60);
    }

    function clearAllTempPubPlaces() {
        tempPubPlacesList = [];
        renderTempPubPlacesUI(true);
        if (isMiniMapFullscreen) setTimeout(() => formMiniMap?.invalidateSize(), 60);
    }

    function startPmZonePlaceVoiceInput() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { safeToast('⚠️ เบราว์เซอร์นี้ไม่รองรับการพิมพ์ด้วยเสียง'); return; }
        const rec = new SR();
        rec.lang = 'th-TH';
        rec.onstart = () => safeToast('🎙️ กำลังฟัง... อ่านชื่อหอพัก/ร้านค้า/ซอยที่เห็นบนแผนที่ได้เลยครับ');
        rec.onresult = e => {
            const tr = (e.results?.[0]?.[0]?.transcript || '').trim();
            if (tr) {
                addManualTempPubPlace(tr);
                safeToast(`✅ เพิ่ม "${tr}" เข้าพื้นที่ไฟดับแล้ว`);
            }
        };
        rec.onerror = () => safeToast('❌ รับเสียงไม่สำเร็จ กรุณาลองใหม่');
        rec.start();
    }

    async function getActiveDraftZoneForExtraction() {
        if (tempZoneType === 'p') {
            if (tempPolyPts.length < 3) return null;
            return normalizePmOutageZone({ t: 'p', p: tempPolyPts });
        }
        let center = tempCircleCenter;
        if (!center) {
            const parsed = await parsePmCoordOrShortLink(document.getElementById('pmCoordInput')?.value || '');
            if (parsed) center = [Number(parsed.lat.toFixed(5)), Number(parsed.lon.toFixed(5))];
        }
        if (!center) return null;
        return normalizePmOutageZone({ t: 'c', c: center, r: tempCircleRadius });
    }

    function getZoneSafeSamplePointPm(oz) {
        const cen = getZoneCentroidPm(oz);
        if (!cen) return null;
        if (oz.t === 'p' && Array.isArray(oz.p) && oz.p.length >= 3 && !isPointInPolyPm(cen.lat, cen.lon, oz.p)) {
            return { lat: oz.p[0][0], lon: oz.p[0][1] };
        }
        return cen;
    }

    // ========================================================================
    // 9.2 เอนจินดึงเฉพาะแผ่นแผนที่ที่ตัดผ่านโซนไฟดับ (รองรับแนวสายส่งทแยงมุม ซูมชัด z=18-19)
    // ========================================================================
    function lonToTileFloatXPm(lon, z) {
        return ((lon + 180) / 360) * Math.pow(2, z);
    }

    function latToTileFloatYPm(lat, z) {
        const rad = (lat * Math.PI) / 180;
        const sin = Math.max(-0.9999, Math.min(0.9999, Math.sin(rad)));
        return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * Math.pow(2, z);
    }

    function tileXToLonPm(x, z) {
        return (x / Math.pow(2, z)) * 360 - 180;
    }

    function tileYToLatPm(y, z) {
        const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
        return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }

    function segIntersectsBoxPm(y1, x1, y2, x2, minY, maxY, minX, maxX) {
        let t0 = 0, t1 = 1;
        const dy = y2 - y1, dx = x2 - x1;
        const checks = [[-dx, x1 - minX], [dx, maxX - x1], [-dy, y1 - minY], [dy, maxY - y1]];
        for (const [p, q] of checks) {
            if (Math.abs(p) < 1e-12) { if (q < 0) return false; }
            else {
                const r = q / p;
                if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
                else { if (r < t0) return false; if (r < t1) t1 = r; }
            }
        }
        return t0 <= t1;
    }

    function doesTileIntersectZonePm(tx, ty, z, oz) {
        const pad = 0.28; // เผื่อขอบสำหรับป้ายข้อความที่ยื่นล้ำรอยต่อแผ่น
        const minLon = tileXToLonPm(tx - pad, z);
        const maxLon = tileXToLonPm(tx + 1 + pad, z);
        const maxLat = tileYToLatPm(ty - pad, z);
        const minLat = tileYToLatPm(ty + 1 + pad, z);

        if (oz.t === 'c') {
            const cLat = Math.max(minLat, Math.min(maxLat, oz.c[0]));
            const cLon = Math.max(minLon, Math.min(maxLon, oz.c[1]));
            return haversineMetersPm(oz.c[0], oz.c[1], cLat, cLon) <= oz.r;
        }
        const pts = oz.p;
        for (let i = 0; i < pts.length; i++) {
            const [la, lo] = pts[i];
            if (la >= minLat && la <= maxLat && lo >= minLon && lo <= maxLon) return true;
        }
        const midLat = (minLat + maxLat) * 0.5, midLon = (minLon + maxLon) * 0.5;
        if (isPointInPolyPm(midLat, midLon, pts) || isPointInPolyPm(minLat, minLon, pts) ||
            isPointInPolyPm(minLat, maxLon, pts) || isPointInPolyPm(maxLat, minLon, pts) ||
            isPointInPolyPm(maxLat, maxLon, pts)) {
            return true;
        }
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            if (segIntersectsBoxPm(pts[j][0], pts[j][1], pts[i][0], pts[i][1], minLat, maxLat, minLon, maxLon)) return true;
        }
        return false;
    }

    async function fetchGoogleLabelTileImagePm(tx, ty, z) {
        const sub = Math.abs(tx + ty) % 4;
        // แนบ &_ai=1 เพื่อให้ sw.js ข้ามการแคชลง TILE_CACHE_NAME ไม่ไปเบียดแผ่นแผนที่ออฟไลน์ของช่าง
        const rawUrl = `https://mt${sub}.google.com/vt/lyrs=m&hl=th&x=${tx}&y=${ty}&z=${z}&scale=2`;
        const candidates = [];
        if (!directGoogleTileCorsBlocked) candidates.push({ url: rawUrl, isDirect: true });
        candidates.push(
            { url: `https://wsrv.nl/?url=${encodeURIComponent(rawUrl)}&output=png`, isDirect: false },
            { url: `https://corsproxy.io/?url=${encodeURIComponent(rawUrl)}`, isDirect: false },
            { url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(rawUrl)}`, isDirect: false }
        );

        for (const cand of candidates) {
            const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => ctrl.abort(), 7500) : null;
            try {
                const res = await _origFetchForPm(cand.url, {
                    mode: 'cors',
                    credentials: 'omit',
                    signal: ctrl ? ctrl.signal : undefined
                });
                if (res.ok) {
                    const blob = await res.blob();
                    if (blob && blob.size > 80 && (!blob.type || blob.type.startsWith('image/') || blob.type.includes('octet-stream'))) {
                        return await new Promise((resolve, reject) => {
                            const objUrl = URL.createObjectURL(blob);
                            const img = new Image();
                            img.onload = () => { URL.revokeObjectURL(objUrl); resolve(img); };
                            img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('tile decode err')); };
                            img.src = objUrl;
                        });
                    }
                }
            } catch (e) {
                if (cand.isDirect && e?.name !== 'AbortError') directGoogleTileCorsBlocked = true;
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
        return null;
    }

    async function captureOutageZoneMapBase64(oz) {
        let minLat, maxLat, minLon, maxLon;
        if (oz.t === 'c') {
            const [cLat, cLon] = oz.c;
            const dLat = oz.r / 111320;
            const dLon = oz.r / (111320 * Math.max(0.2, Math.cos((cLat * Math.PI) / 180)));
            minLat = cLat - dLat; maxLat = cLat + dLat;
            minLon = cLon - dLon; maxLon = cLon + dLon;
        } else {
            const lats = oz.p.map(pt => pt[0]);
            const lons = oz.p.map(pt => pt[1]);
            minLat = Math.min(...lats); maxLat = Math.max(...lats);
            minLon = Math.min(...lons); maxLon = Math.max(...lons);
        }

        // เผื่อขอบรอบกรอบ ~38 เมตร ป้องกันปลายข้อความของหมุดริมเส้นถูกตัดขาดที่ขอบแผ่นภาพ
        const padLatDeg = 38 / 111320;
        const padLonDeg = 38 / (111320 * Math.max(0.2, Math.cos(((minLat + maxLat) * 0.5 * Math.PI) / 180)));
        const qMinLat = minLat - padLatDeg, qMaxLat = maxLat + padLatDeg;
        const qMinLon = minLon - padLonDeg, qMaxLon = maxLon + padLonDeg;

        const spanMeters = Math.max(
            haversineMetersPm(minLat, minLon, maxLat, minLon),
            haversineMetersPm(minLat, minLon, minLat, maxLon)
        );
        const startZoom = spanMeters < 180 ? 19 : 18;

        let chosenZ = 13, minTx = 0, maxTx = 0, minTy = 0, maxTy = 0, activeTiles = [];
        for (let z = startZoom; z >= 13; z--) {
            const tx1 = Math.floor(lonToTileFloatXPm(qMinLon, z));
            const tx2 = Math.floor(lonToTileFloatXPm(qMaxLon, z));
            const ty1 = Math.floor(latToTileFloatYPm(qMaxLat, z));
            const ty2 = Math.floor(latToTileFloatYPm(qMinLat, z));
            const cols = tx2 - tx1 + 1, rows = ty2 - ty1 + 1;
            if (Math.max(cols, rows) <= 10) {
                const hitTiles = [];
                for (let ty = ty1; ty <= ty2; ty++) {
                    for (let tx = tx1; tx <= tx2; tx++) {
                        if (doesTileIntersectZonePm(tx, ty, z, oz)) hitTiles.push([tx, ty]);
                    }
                }
                const maxAllowed = z === 19 ? 12 : 24;
                if (hitTiles.length > 0 && hitTiles.length <= maxAllowed) {
                    chosenZ = z; minTx = tx1; maxTx = tx2; minTy = ty1; maxTy = ty2;
                    activeTiles = hitTiles;
                    break;
                }
            }
            if (z === 13) {
                chosenZ = 13;
                minTx = tx1; maxTx = Math.min(tx2, tx1 + 4);
                minTy = ty1; maxTy = Math.min(ty2, ty1 + 4);
                activeTiles = [];
                for (let ty = minTy; ty <= maxTy; ty++) {
                    for (let tx = minTx; tx <= maxTx; tx++) activeTiles.push([tx, ty]);
                }
            }
        }

        const cols = maxTx - minTx + 1, rows = maxTy - minTy + 1;
        const maxSideSpan = Math.max(cols, rows);
        const tileRenderPx = maxSideSpan <= 5 ? 512 : Math.max(256, Math.min(384, Math.floor(3400 / maxSideSpan)));
        const stitchCanvas = document.createElement('canvas');
        stitchCanvas.width = cols * tileRenderPx;
        stitchCanvas.height = rows * tileRenderPx;
        const sCtx = stitchCanvas.getContext('2d');
        sCtx.fillStyle = '#f1f5f9';
        sCtx.fillRect(0, 0, stitchCanvas.width, stitchCanvas.height);

        let loadedCount = 0;
        const drawTileAt = async (tx, ty) => {
            let img = await fetchGoogleLabelTileImagePm(tx, ty, chosenZ);
            if (!img) {
                await new Promise(r => setTimeout(r, 350));
                img = await fetchGoogleLabelTileImagePm(tx, ty, chosenZ);
            }
            if (img) {
                sCtx.drawImage(img, (tx - minTx) * tileRenderPx, (ty - minTy) * tileRenderPx, tileRenderPx, tileRenderPx);
                loadedCount++;
                return true;
            }
            return false;
        };

        if (activeTiles.length > 0) {
            await drawTileAt(activeTiles[0][0], activeTiles[0][1]);
        }
        let cursor = 1;
        const workerCount = Math.min(4, Math.max(0, activeTiles.length - 1));
        await Promise.all(Array.from({ length: workerCount }, async () => {
            while (cursor < activeTiles.length) {
                const idx = cursor++;
                await drawTileAt(activeTiles[idx][0], activeTiles[idx][1]);
            }
        }));

        if (loadedCount === 0 || loadedCount < Math.ceil(activeTiles.length * 0.5)) {
            stitchCanvas.width = 0; stitchCanvas.height = 0;
            throw new Error('ดึงแผ่นภาพป้ายชื่อแผนที่ได้ไม่ครบ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
        }

        const toStitchXY = (lat, lon) => [
            (lonToTileFloatXPm(lon, chosenZ) - minTx) * tileRenderPx,
            (latToTileFloatYPm(lat, chosenZ) - minTy) * tileRenderPx
        ];

        let polyCanvasPts = [];
        let circleCanvasGeom = null;
        let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;

        if (oz.t === 'c') {
            const [cLat, cLon] = oz.c;
            const [cx, cy] = toStitchXY(cLat, cLon);
            const dLon = oz.r / (111320 * Math.max(0.2, Math.cos((cLat * Math.PI) / 180)));
            const [edgeX] = toStitchXY(cLat, cLon + dLon);
            const rPx = Math.max(20, Math.abs(edgeX - cx));
            circleCanvasGeom = { cx, cy, rPx };
            bMinX = cx - rPx; bMaxX = cx + rPx;
            bMinY = cy - rPx; bMaxY = cy + rPx;
        } else {
            polyCanvasPts = oz.p.map(pt => {
                const [px, py] = toStitchXY(pt[0], pt[1]);
                if (px < bMinX) bMinX = px;
                if (px > bMaxX) bMaxX = px;
                if (py < bMinY) bMinY = py;
                if (py > bMaxY) bMaxY = py;
                return [px, py];
            });
        }

        const padPx = 64;
        const cropX = Math.max(0, Math.floor(bMinX - padPx));
        const cropY = Math.max(0, Math.floor(bMinY - padPx));
        const cropW = Math.max(64, Math.min(stitchCanvas.width - cropX, Math.ceil(bMaxX - bMinX + padPx * 2)));
        const cropH = Math.max(64, Math.min(stitchCanvas.height - cropY, Math.ceil(bMaxY - bMinY + padPx * 2)));

        const maxOutDim = 2400;
        const outScale = Math.min(1, maxOutDim / Math.max(cropW, cropH));
        const outCanvas = document.createElement('canvas');
        outCanvas.width = Math.max(64, Math.round(cropW * outScale));
        outCanvas.height = Math.max(64, Math.round(cropH * outScale));
        const oCtx = outCanvas.getContext('2d');

        oCtx.drawImage(stitchCanvas, cropX, cropY, cropW, cropH, 0, 0, outCanvas.width, outCanvas.height);
        oCtx.fillStyle = 'rgba(15, 23, 42, 0.78)';
        oCtx.fillRect(0, 0, outCanvas.width, outCanvas.height);

        const buildZonePathOnOut = () => {
            oCtx.beginPath();
            if (circleCanvasGeom) {
                oCtx.arc(
                    (circleCanvasGeom.cx - cropX) * outScale,
                    (circleCanvasGeom.cy - cropY) * outScale,
                    circleCanvasGeom.rPx * outScale,
                    0,
                    Math.PI * 2
                );
            } else {
                polyCanvasPts.forEach((pt, idx) => {
                    const ox = (pt[0] - cropX) * outScale;
                    const oy = (pt[1] - cropY) * outScale;
                    if (idx === 0) oCtx.moveTo(ox, oy);
                    else oCtx.lineTo(ox, oy);
                });
                oCtx.closePath();
            }
        };

        oCtx.save();
        buildZonePathOnOut();
        oCtx.clip();
        oCtx.drawImage(stitchCanvas, cropX, cropY, cropW, cropH, 0, 0, outCanvas.width, outCanvas.height);
        oCtx.restore();

        buildZonePathOnOut();
        oCtx.strokeStyle = '#e11d48';
        oCtx.lineWidth = 3.5;
        oCtx.stroke();

        const dataUrl = outCanvas.toDataURL('image/jpeg', 0.86);
        stitchCanvas.width = 0; stitchCanvas.height = 0;
        outCanvas.width = 0; outCanvas.height = 0;
        return dataUrl.replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
    }

    function parseGeminiPlacesJsonResponse(rawText) {
        const cleaned = String(rawText || '').replace(/```json/gi, '').replace(/```/g, '').trim();
        if (!cleaned) return [];
        let parsed = null;
        try {
            parsed = JSON.parse(cleaned);
        } catch (e) {
            const arrMatch = cleaned.match(/\[[\s\S]*\]/);
            if (arrMatch) {
                try { parsed = JSON.parse(arrMatch[0]); } catch (e2) {}
            }
        }
        let arr = [];
        if (Array.isArray(parsed)) arr = parsed;
        else if (parsed && typeof parsed === 'object') {
            const firstArr = Object.values(parsed).find(v => Array.isArray(v));
            if (firstArr) arr = firstArr;
        }
        return arr
            .map(x => String(x || '').replace(/\s+/g, ' ').trim())
            .filter(s => s.length >= 2 && !/^(?:google|map data)$/i.test(s) && !/^\d+[\/\-]?\d*$/.test(s));
    }

    async function queryGeminiVisionPlacesInZone(oz, apiKey) {
        const keyTag = String(apiKey || '').slice(-10);
        const modelList = await resolveAvailableVisionModelsPm(apiKey);
        if (!modelList.length) {
            throw new Error('ไม่พบโมเดล Gemini Vision ที่เปิดใช้งานสำหรับคีย์นี้');
        }
        const base64Img = await captureOutageZoneMapBase64(oz);
        const promptText = [
            'อ่านป้ายชื่อสถานที่ทั้งหมดที่อยู่ในเขตพื้นที่สว่างภายในเส้นขอบสีแดงบนภาพแผนที่นี้ เพื่อนำไปเขียนประกาศแจ้งพื้นที่ไฟดับให้ประชาชนทราบ',
            'กฎการสกัดข้อมูล:',
            '1. ดึงชื่อหอพัก อพาร์ตเมนต์ ห้องเช่า หมู่บ้านจัดสรร บริษัท โรงงาน ร้านค้า ปั๊มน้ำมัน โรงเรียน วัด สถานที่ราชการ รวมถึงชื่อถนนและซอยที่อยู่ด้านในกรอบสีแดง (พื้นที่สว่าง) ให้ครบทุกป้าย',
            '2. ยึดตำแหน่งไอคอนหมุด (Pin/วงกลมสี) เป็นหลัก: หากไอคอนหมุดอยู่ด้านในกรอบสีแดง (พื้นที่สว่าง) แม้ปลายตัวหนังสือจะยื่นล้ำเส้นสีแดงออกไปในโซนมืดเล็กน้อย ให้ดึงชื่อเต็มมาด้วย แต่ถ้าไอคอนหมุดอยู่นอกเส้นสีแดง (ในโซนมืดทึบ) ห้ามดึงมาเด็ดขาด',
            '3. หากป้ายชื่อเดียวกันถูกตัดแบ่งเป็น 2 บรรทัด (เช่น บรรทัดบน "บริษัท เดอะ พรีเชีย" บรรทัดล่าง "ส ทรานสปอร์ต จำกัด") ให้เชื่อมคำติดกันเป็นชื่อเต็มบรรทัดเดียวให้ถูกต้อง ("บริษัท เดอะ พรีเชียส ทรานสปอร์ต จำกัด")',
            '4. หากเป็นปั๊มน้ำมันที่มีเฉพาะชื่อแบรนด์ เช่น Shell, PTT, Bangchak, Caltex, PT, Esso ให้เติมคำว่า "ปั๊มน้ำมัน " นำหน้า เช่น "ปั๊มน้ำมัน Shell" และไม่เอาตัวเลขเดี่ยวๆ',
            '5. ตอบกลับเป็น JSON Array ของข้อความตามป้ายจริงเท่านั้น'
        ].join('\n');

        const baseSchemaCfg = {
            responseMimeType: 'application/json',
            responseSchema: { type: 'ARRAY', items: { type: 'STRING' } }
        };

        let lastErr = null;
        let sawQuota429 = false;
        for (const modelName of modelList) {
            if (unsupportedGeminiModels.has(`${keyTag}:${modelName}`)) continue;
            const verMatch = modelName.match(/^gemini-(\d+(?:\.\d+)?)/i);
            const majorVer = verMatch ? parseFloat(verMatch[1]) : 2.5;
            const primaryGenCfg = majorVer >= 3
                ? { ...baseSchemaCfg, thinkingConfig: { thinkingLevel: modelName.includes('lite') ? 'MINIMAL' : 'LOW' } }
                : { ...baseSchemaCfg, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } };

            for (const cfgAttempt of [primaryGenCfg, baseSchemaCfg]) {
                const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
                const timer = ctrl ? setTimeout(() => ctrl.abort(), 22000) : null;
                try {
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
                    const res = await _origFetchForPm(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{
                                parts: [
                                    { inlineData: { mimeType: 'image/jpeg', data: base64Img } },
                                    { text: promptText }
                                ]
                            }],
                            generationConfig: cfgAttempt
                        }),
                        signal: ctrl ? ctrl.signal : undefined
                    });

                    const data = await res.json().catch(() => null);
                    if (res.ok && data) {
                        const parts = data?.candidates?.[0]?.content?.parts || [];
                        const rawOut = parts.filter(pt => !pt?.thought && typeof pt?.text === 'string').map(pt => pt.text).join('\n').trim();
                        return parseGeminiPlacesJsonResponse(rawOut);
                    }

                    const errMsg = String(data?.error?.message || `HTTP ${res.status}`);
                    if (res.status === 400 || res.status === 403) {
                        if (/API_KEY_INVALID|API key not valid|key expired|API_KEY_HTTP_REFERRER_BLOCKED|Requests from referer/i.test(errMsg)) {
                            const keyErr = new Error('API Key ไม่ถูกต้อง ถูกจำกัดสิทธิ์โดเมน หรือหมดอายุ กรุณาตั้งค่าคีย์ AI ใหม่');
                            keyErr.isInvalidKey = true;
                            throw keyErr;
                        }
                        if (res.status === 400 && cfgAttempt === primaryGenCfg) continue;
                    }
                    if (res.status === 404 || res.status === 403) unsupportedGeminiModels.add(`${keyTag}:${modelName}`);
                    if (res.status === 429) sawQuota429 = true;
                    lastErr = new Error(errMsg);
                    break;
                } catch (err) {
                    if (err?.isInvalidKey) throw err;
                    lastErr = err;
                    break;
                } finally {
                    if (timer) clearTimeout(timer);
                }
            }
        }
        const finalErr = lastErr || new Error('เรียกใช้งาน AI ไม่สำเร็จ');
        if (sawQuota429) finalErr.isQuotaExceeded = true;
        throw finalErr;
    }

    async function queryOverpassPlacesInZone(oz) {
        let areaFilter = '';
        if (oz.t === 'c') {
            areaFilter = `(around:${Math.max(80, Math.min(5000, oz.r))},${oz.c[0]},${oz.c[1]})`;
        } else {
            const dedupPts = oz.p.filter((pt, i, arr) => i === 0 || pt[0] !== arr[i - 1][0] || pt[1] !== arr[i - 1][1]);
            const uniqueCoordCount = new Set(dedupPts.map(pt => `${pt[0]},${pt[1]}`)).size;
            if (uniqueCoordCount < 3) return [];
            areaFilter = `(poly:"${dedupPts.map(pt => `${pt[0]} ${pt[1]}`).join(' ')}")`;
        }
        const ql = `[out:json][timeout:9];(nw["name"]${areaFilter};nw["name:th"]${areaFilter};nw["brand"]${areaFilter};way["highway"]["ref"]${areaFilter};);out tags 180;`;
        const endpoints = [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter'
        ];
        for (const ep of endpoints) {
            const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => ctrl.abort(), 9500) : null;
            try {
                const res = await _origFetchForPm(ep, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                    body: 'data=' + encodeURIComponent(ql),
                    signal: ctrl ? ctrl.signal : undefined
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data?.remark && (!Array.isArray(data.elements) || data.elements.length === 0)) continue;
                    if (Array.isArray(data?.elements)) return data.elements;
                }
            } catch (e) {}
            finally { if (timer) clearTimeout(timer); }
        }
        return [];
    }

    async function queryNominatimAdminAtPoint(lat, lon) {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 6500) : null;
        try {
            const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1&accept-language=th`;
            const res = await _origFetchForPm(url, { signal: ctrl ? ctrl.signal : undefined });
            if (!res.ok) return null;
            const data = await res.json();
            const addr = data?.address || {};
            const road = String(addr.road || '').trim();
            const village = String(addr.hamlet || addr.village || addr.neighbourhood || addr.quarter || '').trim();
            const rawSub = String(addr.suburb || addr.town || addr.municipality || addr.city_district || '').trim();
            const rawDist = String(addr.county || addr.city || '').trim();
            const rawProv = String(addr.state || '').trim();
            const sub = rawSub ? (/^(?:ตำบล|ต\.|แขวง|เทศบาล)/.test(rawSub) ? rawSub : `ต.${rawSub}`) : '';
            const dist = rawDist ? (/^(?:อำเภอ|อ\.|เขต)/.test(rawDist) ? rawDist : `อ.${rawDist}`) : '';
            const prov = rawProv ? (/^(?:จังหวัด|จ\.|กรุงเทพ)/.test(rawProv) ? rawProv : `จ.${rawProv}`) : '';
            return { road, village, adminArea: [sub, dist, prov].filter(Boolean).join(' ') };
        } catch (e) { return null; }
        finally { if (timer) clearTimeout(timer); }
    }

    async function extractPlacesInCurrentOutageZone(skipAiMode = false) {
        if (isExtractingZonePlaces) return;
        addManualTempPubPlace();
        const oz = await getActiveDraftZoneForExtraction();
        if (!oz) {
            safeToast(tempZoneType === 'p' ? '⚠️ กรุณาปักมุมบนแผนที่ให้ครบอย่างน้อย 3 จุดก่อนดูดชื่อสถานที่ครับ' : '⚠️ กรุณาแตะเลือกจุดศูนย์กลางวงเรดาร์บนแผนที่ก่อนครับ');
            return;
        }

        const groupAiKey = skipAiMode ? '' : getCurrentGroupAiApiKey();
        if (!skipAiMode && !groupAiKey) {
            openPmAiKeyModal(true);
            return;
        }

        isExtractingZonePlaces = true;
        ['btnExtractZonePlacesMap', 'btnExtractZonePlacesForm'].forEach(id => {
            const b = document.getElementById(id);
            if (b) {
                b.disabled = true;
                if (!b.dataset.origTxt) b.dataset.origTxt = b.textContent;
                b.textContent = groupAiKey ? '🤖 AI กำลังอ่านป้ายในกรอบ...' : '⏳ กำลังดึงถนน/ตำบล...';
            }
        });

        let aiPlaces = [];
        let aiErrorObj = null;

        try {
            const cen = getZoneSafeSamplePointPm(oz);
            const [aiRes, osmElements, nomInfo] = await Promise.all([
                groupAiKey
                    ? queryGeminiVisionPlacesInZone(oz, groupAiKey).catch(err => { aiErrorObj = err; return []; })
                    : Promise.resolve([]),
                queryOverpassPlacesInZone(oz),
                cen ? queryNominatimAdminAtPoint(cen.lat, cen.lon) : Promise.resolve(null)
            ]);
            aiPlaces = Array.isArray(aiRes) ? aiRes : [];

            const roads = [], villages = [], landmarks = [];

            osmElements.forEach(el => {
                const tags = el?.tags;
                if (!tags || tags.boundary === 'administrative' || tags.power || tags.place === 'country' || tags.place === 'state') return;
                const roadRef = (tags.highway && tags.ref)
                    ? (/^(?:ถ\.|ถนน|ทล\.|ทางหลวง|สาย)/.test(String(tags.ref).trim()) ? String(tags.ref).trim() : `สาย ${String(tags.ref).trim()}`)
                    : '';
                let name = String(tags['name:th'] || tags.name || tags['brand:th'] || tags.brand || roadRef).replace(/\s+/g, ' ').trim();
                if (!name || /^\d+[\/\-]?\d*$/.test(name)) return;

                if (tags.highway) {
                    roads.push(name);
                } else if (tags.place || tags.landuse === 'residential') {
                    villages.push(name);
                } else {
                    if (tags.amenity === 'fuel' && !/^(?:ปั๊ม|สถานีบริการ)/.test(name)) name = `ปั๊มน้ำมัน ${name}`;
                    else if (tags.amenity === 'school' && !/^(?:โรงเรียน|รร\.|วิทยาลัย|ศูนย์พัฒนา)/.test(name)) name = `โรงเรียน${name}`;
                    landmarks.push(name);
                }
            });

            try {
                const pins = JSON.parse(rawGet('elec_labeled_places_list') || '[]');
                const delMap = JSON.parse(rawGet('elec_deleted_labeled_places_map') || '{}');
                const activeGrp = getActivePmGroup();
                pins.forEach(p => {
                    if (!p?.id || delMap[p.id] || p.scadaNode) return;
                    if (normPmGrp(p.ownerGroup || 'กฟส.บึง') !== activeGrp) return;
                    const la = parseFloat(p.lat), lo = parseFloat(p.lon);
                    if (!isPointInsidePmZone(la, lo, oz)) return;
                    const pName = String(p.name || '').trim();
                    if (pName && !isLikelyInternalScadaCode(pName)) landmarks.push(pName);
                });
            } catch (e) {}

            if (nomInfo?.road) roads.push(nomInfo.road);
            if (nomInfo?.village) villages.push(nomInfo.village);
            const adminTail = nomInfo?.adminArea ? [nomInfo.adminArea] : [];

            // แยก ต./อ./จ. ของรอบก่อนไปต่อท้ายสุดเสมอ แม้กดสแกนซ้ำหลายรอบ
            const prevNonAdmin = tempPubPlacesList.filter(x => !isAdminAreaSummaryItemPm(x));
            const prevAdmin = tempPubPlacesList.filter(x => isAdminAreaSummaryItemPm(x));
            const mergedAll = parsePlacesTextToList([
                ...prevNonAdmin,
                ...aiPlaces.slice(0, 35),
                ...landmarks.slice(0, 20),
                ...villages.slice(0, 10),
                ...roads.slice(0, 10),
                ...adminTail,
                ...prevAdmin
            ]);

            const addedCount = Math.max(0, mergedAll.length - tempPubPlacesList.length);
            tempPubPlacesList = mergedAll;
            renderTempPubPlacesUI(true);
            if (isMiniMapFullscreen) setTimeout(() => formMiniMap?.invalidateSize(), 60);

            if (aiErrorObj?.isInvalidKey) {
                safeToast(`❌ ${aiErrorObj.message}`);
                openPmAiKeyModal(true);
            } else if (aiErrorObj?.isQuotaExceeded) {
                safeToast('⚠️ โควตา AI ฟรีของคีย์กลุ่มนี้เต็มชั่วคราว (ดึงข้อมูลถนน/ตำบลพื้นฐานให้แทนแล้ว)');
            } else if (aiErrorObj && groupAiKey) {
                safeToast(`⚠️ AI อ่านภาพขัดข้อง (${aiErrorObj.message || 'เชื่อมต่อไม่สำเร็จ'}) ดึงข้อมูลพื้นฐานให้แทนแล้ว`);
            } else if (mergedAll.length > 0) {
                safeToast(addedCount > 0 ? `✅ ดูดชื่อสถานที่ในกรอบสำเร็จ (+${addedCount} แห่ง)` : 'ℹ️ รายชื่อสถานที่ในกรอบนี้อยู่ในรายการครบแล้ว');
            } else {
                safeToast('ℹ️ ไม่พบป้ายชื่อในกรอบนี้ สามารถพิมพ์หรือกด 🎙️ อ่านชื่อเพิ่มได้ครับ');
            }
        } catch (err) {
            safeToast('⚠️ ดึงข้อมูลแผนที่ออนไลน์ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ต');
        } finally {
            isExtractingZonePlaces = false;
            ['btnExtractZonePlacesMap', 'btnExtractZonePlacesForm'].forEach(id => {
                const b = document.getElementById(id);
                if (b) { b.disabled = false; if (b.dataset.origTxt) b.textContent = b.dataset.origTxt; }
            });
        }
    }

    function buildPublicOutageAnnouncementText(item, styleMode = 'facebook') {
        const branchName = normPmGrp(item.ownerGroup || getActivePmGroup()) || 'กฟส.บึง';
        const dateFull = formatThaiDateFull(item.date || getTodayIso());
        const cleanSlot = String(item.timeSlot || '09.00-16.00').replace(/\s*น\.?\s*$/g, '').trim() || '09.00-16.00';
        const causeTxt = String(item.pubNote || item.title || 'ปรับปรุงและบำรุงรักษาระบบจำหน่ายไฟฟ้า').trim();
        const includeRadar = Boolean(item.pub);
        const placesTxt = String(item.pubPlaces || '').trim() || (includeRadar ? 'พื้นที่ตามแนวเขตแผนที่เรดาร์แนบท้าย' : 'พื้นที่บริเวณตามแผนปฏิบัติงาน');
        const radarUrl = buildPublicOutageMapShareUrl();

        if (styleMode === 'line') {
            const lineRows = [
                `⚡ แจ้งแผนดับไฟปฏิบัติงาน (${branchName})`,
                `🗓️ ${dateFull}`,
                `⏰ เวลา ${cleanSlot} น. (โดยประมาณ)`,
                `🛠️ สาเหตุ: ${causeTxt}`,
                `📍 พื้นที่ไฟดับ: ${placesTxt}`
            ];
            if (includeRadar) {
                lineRows.push(`📡 เช็กพิกัดบ้านในเขตไฟดับได้ที่:`, radarUrl);
            }
            lineRows.push(`🙏 ขออภัยในความไม่สะดวก (หากเสร็จก่อนกำหนดจะจ่ายไฟทันทีครับ)`);
            return lineRows.join('\n');
        }

        const fbRows = [
            `📢 ประชาสัมพันธ์แจ้งแผนดับกระแสไฟฟ้าชั่วคราว`,
            `🏢 การไฟฟ้าส่วนภูมิภาค (${branchName})`,
            `━━━━━━━━━━━━━━━━━━`,
            `🗓️ วันที่ : ${dateFull}`,
            `⏰ เวลา : ${cleanSlot} น. (โดยประมาณ)`,
            `🛠️ งานที่ปฏิบัติ : ${causeTxt}`,
            ``,
            `📍 พื้นที่ได้รับผลกระทบ (บริเวณไฟดับ) :`,
            `${placesTxt}`
        ];
        if (includeRadar) {
            fbRows.push(
                ``,
                `📡 ตรวจสอบพิกัดหลังคาบ้าน/สถานประกอบการของท่านบนเรดาร์แผนที่ได้ที่ :`,
                `${radarUrl}`
            );
        }
        fbRows.push(
            `━━━━━━━━━━━━━━━━━━`,
            `🙏 การไฟฟ้าส่วนภูมิภาค (${branchName}) ขออภัยในความไม่สะดวกมา ณ ที่นี้ ทั้งนี้หากปฏิบัติงานแล้วเสร็จก่อนกำหนด จะดำเนินการจ่ายกระแสไฟฟ้าให้ตามปกติทันทีครับ`
        );
        return fbRows.join('\n');
    }

    function openPmPublicAnnounceModal(planIdOrDraft) {
        injectPmModalsDOM();
        ensurePmOutageZoneUiInjected();
        if (planIdOrDraft === '__FORM_DRAFT__') {
            addManualTempPubPlace();
            currentAnnounceModalItem = {
                ownerGroup: getActivePmGroup(),
                pub: Boolean(tempPubEnabled),
                title: (document.getElementById('pmTitleInput')?.value || '').trim(),
                date: (document.getElementById('pmDateInput')?.value || selectedDateIso || getTodayIso()).trim(),
                timeSlot: (document.getElementById('pmTimeSlotInput')?.value || '09.00-16.00').trim(),
                pubNote: (document.getElementById('pmPubOutageNoteInput')?.value || '').trim(),
                pubPlaces: (document.getElementById('pmPubOutagePlacesInput')?.value || tempPubPlacesList.join(', ')).trim()
            };
        } else {
            const found = getAllVisibleCalendarItems().find(x => x.id === planIdOrDraft);
            if (!found) return;
            currentAnnounceModalItem = found;
        }
        switchPmAnnounceStyle(currentAnnounceStyleMode || 'facebook');
        document.getElementById('pmPublicAnnounceModal')?.classList.remove('hidden');
    }

    function closePmPublicAnnounceModal() {
        document.getElementById('pmPublicAnnounceModal')?.classList.add('hidden');
    }

    function switchPmAnnounceStyle(mode) {
        currentAnnounceStyleMode = mode === 'line' ? 'line' : 'facebook';
        const fbBtn = document.getElementById('pmAnnStyleBtn-facebook');
        const lnBtn = document.getElementById('pmAnnStyleBtn-line');
        if (fbBtn) fbBtn.className = currentAnnounceStyleMode === 'facebook' ? 'flex-1 py-1.5 rounded-lg bg-blue-600 text-white font-extrabold text-xs shadow' : 'flex-1 py-1.5 rounded-lg text-slate-600 hover:bg-slate-200 font-bold text-xs';
        if (lnBtn) lnBtn.className = currentAnnounceStyleMode === 'line' ? 'flex-1 py-1.5 rounded-lg bg-[#00B900] text-white font-extrabold text-xs shadow' : 'flex-1 py-1.5 rounded-lg text-slate-600 hover:bg-slate-200 font-bold text-xs';
        const area = document.getElementById('pmPublicAnnounceTextarea');
        if (area && currentAnnounceModalItem) {
            area.value = buildPublicOutageAnnouncementText(currentAnnounceModalItem, currentAnnounceStyleMode);
        }
    }

    function copyPmPublicAnnounceText() {
        const area = document.getElementById('pmPublicAnnounceTextarea');
        const txt = (area?.value || '').trim();
        if (!txt) return;
        copyPmTextSafe(txt, '📋 คัดลอกประกาศแจ้งไฟดับแล้ว! กดวางโพสต์ใน Facebook หรือ LINE ได้เลย');
        try { area.select(); document.execCommand('copy'); } catch (e) {}
    }

    function sharePmPublicAnnounceToLine() {
        const txt = (document.getElementById('pmPublicAnnounceTextarea')?.value || '').trim();
        if (!txt) return;
        copyPmTextSafe(txt, '💬 คัดลอกข้อความและกำลังเปิดแอป LINE...');
        window.open('https://line.me/R/share?text=' + encodeURIComponent(txt), '_blank');
    }

    function ensurePmOutageZoneUiInjected() {
        const calHdrBtns = document.querySelector('#pmCalendarModal .pm-calendar-dialog > div:first-child > div:last-child');
        if (calHdrBtns && !document.getElementById('pmOpenPublicRadarBtn')) {
            const wrap = document.createElement('div');
            wrap.className = 'inline-flex items-center rounded-xl overflow-hidden border border-rose-300/60 shadow';
            wrap.innerHTML = `<button type="button" id="pmOpenPublicRadarBtn" onclick="openPublicOutageMapPage()" title="เปิดหน้าเว็บแมพเรดาร์แจ้งดับไฟสำหรับประชาชน" class="bg-rose-500 hover:bg-rose-600 text-white px-2.5 py-1 text-[11px] font-extrabold">📡 แมพประชาชน</button><button type="button" onclick="copyPublicOutageMapLink()" title="คัดลอกลิงก์ส่งให้ประชาชนตรวจสอบเอง" class="bg-rose-700 hover:bg-rose-800 text-amber-200 px-2 py-1 text-[11px] font-extrabold border-l border-white/25">🔗 คัดลอกลิงก์</button>`;
            calHdrBtns.insertBefore(wrap, calHdrBtns.firstChild);
        }

        const miniWrap = document.getElementById('pmFormMiniMapWrap');
        if (miniWrap && !document.getElementById('pmPubOutagePanel')) {
            const panelHtml = `
                <div id="pmPubOutagePanel" class="p-3 bg-rose-50/85 border-2 border-rose-200 rounded-xl space-y-2">
                    <div class="flex items-center justify-between gap-2">
                        <label class="flex items-center gap-2 font-extrabold text-rose-950 cursor-pointer select-none text-xs">
                            <input type="checkbox" id="pmPubOutageEnableChk" onchange="onTogglePmPublicOutage(this.checked)" class="w-4 h-4 accent-rose-600 rounded">
                            <span>📡 แสดงโซนเรดาร์แจ้งแผนดับไฟประชาชน (outage-map.html)</span>
                        </label>
                    </div>
                    <div id="pmPubOutageConfigBody" class="hidden space-y-2 pt-1.5 border-t border-rose-200/80">
                        <input type="text" id="pmPubOutageNoteInput" placeholder="💬 สาเหตุที่แจ้งประชาชน เช่น ดับไฟตัดรอนกิ่งไม้ / ปรับปรุงสายแรงสูง" class="w-full px-2.5 py-1.5 bg-white border border-rose-300 rounded-lg text-xs font-semibold text-slate-800">
                        <div class="p-2.5 bg-white rounded-xl border border-rose-200 space-y-1.5">
                            <div class="flex flex-wrap items-center justify-between gap-1">
                                <label class="font-extrabold text-rose-900 text-[11px]">🏘️ ชื่อสถานที่/ซอยในเขตไฟดับ (<span id="pmZonePlacesCountBadge">0</span>)</label>
                                <div class="flex flex-wrap gap-1">
                                    <button type="button" id="btnExtractZonePlacesForm" onclick="extractPlacesInCurrentOutageZone(false)" class="bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-1 rounded-lg text-[10px] font-extrabold shadow-sm">🔍 ดูดชื่อสถานที่ในกรอบ</button>
                                    <button type="button" id="btnConfigGroupAiKeyForm" onclick="openPmAiKeyModal(false)" class="bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-400 px-2 py-1 rounded-lg text-[10px] font-extrabold">🔑 ตั้งคีย์ AI กลุ่ม</button>
                                    <button type="button" onclick="openPmPublicAnnounceModal('__FORM_DRAFT__')" class="bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded-lg text-[10px] font-extrabold shadow-sm">📢 สร้างโพสต์ FB/LINE</button>
                                </div>
                            </div>
                            <div id="pmFormZonePlacesChipsWrap" class="flex flex-wrap gap-1 max-h-24 overflow-y-auto py-0.5"></div>
                            <textarea id="pmPubOutagePlacesInput" rows="2" oninput="onPubPlacesTextareaInput(this.value)" placeholder="กดปุ่ม 🔍 ดูดชื่อสถานที่ในกรอบด้วย AI หรือพิมพ์ชื่อหอพัก/หมู่บ้าน/โรงงาน คั่นด้วยเครื่องหมายจุลภาค (,)" class="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-[11px] font-semibold text-slate-800"></textarea>
                        </div>
                    </div>
                </div>`;
            miniWrap.insertAdjacentHTML('afterend', panelHtml);

            const mapHdr = miniWrap.firstElementChild;
            if (mapHdr && !document.getElementById('pmZoneDrawToolbar')) {
                mapHdr.innerHTML = `<span id="pmMiniMapHdrHint" class="truncate">👆 แตะบนแผนที่เพื่อเลือกจุดปฏิบัติงาน</span><div class="flex items-center gap-1.5 shrink-0"><button type="button" id="pmMiniMapFsBtn" onclick="togglePmMiniMapFullscreen()" class="bg-amber-400 hover:bg-amber-300 text-slate-950 px-2 py-0.5 rounded font-extrabold text-[10px]">⛶ ขยายเต็มจอ</button><button type="button" onclick="togglePmFormMiniMap('close_btn')" class="bg-rose-600 hover:bg-rose-700 text-white px-2 py-0.5 rounded font-bold text-[10px]">✕ ซ่อน</button></div>`;
                mapHdr.insertAdjacentHTML('afterend', `
                    <div id="pmZoneDrawToolbar" class="hidden bg-slate-900 text-white px-2.5 py-2 space-y-2 border-b border-slate-700 text-[11px]">
                        <div class="flex flex-wrap items-center justify-between gap-1">
                            <div class="inline-flex bg-slate-800 p-0.5 rounded-lg gap-0.5 flex-wrap">
                                <button type="button" id="pmDrawModeBtn-circle" onclick="setPmZoneDrawSubMode('circle')" class="px-2 py-1 rounded-md font-extrabold text-[10.5px]">⭕ วงกลมเรดาร์</button>
                                <button type="button" id="pmDrawModeBtn-poly_click" onclick="setPmZoneDrawSubMode('poly_click')" class="px-2 py-1 rounded-md font-bold text-[10.5px]">📐 ปักมุมหลายเหลี่ยม</button>
                                <button type="button" id="pmDrawModeBtn-poly_lasso" onclick="setPmZoneDrawSubMode('poly_lasso')" class="px-2 py-1 rounded-md font-bold text-[10.5px]">✍️ ลากนิ้วตีกรอบเอง</button>
                            </div>
                            <div id="pmPolyActionsGrp" class="hidden items-center gap-1">
                                <button type="button" onclick="undoLastPmZonePolyPoint()" class="bg-slate-700 hover:bg-slate-600 text-amber-300 px-2 py-1 rounded-md text-[10px] font-bold">↩️ ลบมุม</button>
                                <button type="button" onclick="clearPmZonePolygon()" class="bg-rose-700 hover:bg-rose-600 text-white px-2 py-1 rounded-md text-[10px] font-bold">🗑️ ล้างกรอบ</button>
                            </div>
                        </div>
                        <div id="pmCircleRadiusControls" class="flex flex-wrap items-center gap-2">
                            <span class="text-[10.5px] text-amber-300 font-extrabold shrink-0">รัศมี: <b id="pmCircleRadiusLabel">300</b> ม.</span>
                            <input type="range" id="pmCircleRadiusSlider" min="50" max="3000" step="25" value="300" oninput="onPmCircleRadiusInput(this.value)" class="flex-1 min-w-[100px] accent-rose-500 cursor-pointer">
                            <div class="flex gap-1 shrink-0">
                                <button type="button" onclick="onPmCircleRadiusInput(150)" class="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px]">150ม.</button>
                                <button type="button" onclick="onPmCircleRadiusInput(300)" class="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px]">300ม.</button>
                                <button type="button" onclick="onPmCircleRadiusInput(500)" class="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px]">500ม.</button>
                                <button type="button" onclick="onPmCircleRadiusInput(1000)" class="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px]">1กม.</button>
                            </div>
                        </div>
                        <div id="pmPolyStatusHint" class="hidden text-[10.5px] text-emerald-300 font-semibold"></div>
                        <div class="pt-1.5 border-t border-slate-700/90 space-y-1.5">
                            <div class="flex flex-wrap items-center gap-1">
                                <button type="button" id="btnExtractZonePlacesMap" onclick="extractPlacesInCurrentOutageZone(false)" class="bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-2.5 py-1 rounded-lg text-[10.5px] font-extrabold shadow shrink-0">🔍 ดูดชื่อสถานที่ในกรอบ</button>
                                <button type="button" id="btnConfigGroupAiKeyMap" onclick="openPmAiKeyModal(false)" class="bg-amber-400 hover:bg-amber-300 text-slate-950 px-2 py-1 rounded-lg text-[10px] font-extrabold shadow shrink-0">🔑 ตั้งคีย์ AI</button>
                                <div class="flex items-center gap-1 flex-1 min-w-[155px]">
                                    <input type="text" id="pmMapQuickPlaceAddInput" onkeydown="if(event.key==='Enter'){event.preventDefault();addManualTempPubPlace();}" placeholder="+ พิมพ์ชื่อเพิ่มเติม..." class="flex-1 min-w-0 px-2 py-1 rounded-lg bg-slate-800 border border-slate-600 text-white text-[10.5px] focus:outline-none">
                                    <button type="button" onclick="startPmZonePlaceVoiceInput()" title="กดพูดชื่อสถานที่ตามที่เห็นบนแมพ" class="bg-slate-700 hover:bg-slate-600 text-amber-300 px-2 py-1 rounded-lg text-xs">🎙️</button>
                                    <button type="button" onclick="addManualTempPubPlace()" class="bg-indigo-600 hover:bg-indigo-500 text-white px-2 py-1 rounded-lg text-[10px] font-extrabold">เพิ่ม</button>
                                </div>
                                <button type="button" onclick="openPmPublicAnnounceModal('__FORM_DRAFT__')" class="bg-rose-600 hover:bg-rose-500 text-white px-2 py-1 rounded-lg text-[10px] font-extrabold shrink-0">📢 โพสต์ FB/LINE</button>
                            </div>
                            <div id="pmMapZonePlacesRow" class="hidden items-start justify-between gap-1 bg-slate-950/75 rounded-lg p-1.5">
                                <div id="pmMapZonePlacesChipsWrap" class="flex flex-wrap gap-1 max-h-14 overflow-y-auto flex-1"></div>
                                <button type="button" onclick="clearAllTempPubPlaces()" title="ล้างรายชื่อทั้งหมด" class="text-[9.5px] text-slate-400 hover:text-rose-400 font-bold px-1 shrink-0">ล้าง</button>
                            </div>
                        </div>
                    </div>`);
            }
        }

        if (!document.getElementById('pmPublicAnnounceModal')) {
            document.body.insertAdjacentHTML('beforeend', `
                <div id="pmPublicAnnounceModal" onclick="if(event.target===this) closePmPublicAnnounceModal();" class="fixed inset-0 bg-slate-950/80 hidden z-[1492] flex items-center justify-center p-3 backdrop-blur-sm">
                    <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border-2 border-rose-400 flex flex-col max-h-[90dvh]">
                        <div class="px-4 py-3 bg-gradient-to-r from-rose-600 via-pink-600 to-indigo-800 text-white flex justify-between items-center">
                            <h3 class="font-extrabold text-sm">📢 ข้อความแจ้งดับไฟประชาชน (Facebook / LINE)</h3>
                            <button type="button" onclick="closePmPublicAnnounceModal()" class="text-white/85 hover:text-white text-xl font-bold leading-none">&times;</button>
                        </div>
                        <div class="p-3.5 space-y-2.5 overflow-y-auto flex-1 bg-slate-50 text-xs">
                            <div class="flex bg-slate-200 p-1 rounded-xl gap-1">
                                <button type="button" id="pmAnnStyleBtn-facebook" onclick="switchPmAnnounceStyle('facebook')" class="flex-1 py-1.5 rounded-lg bg-blue-600 text-white font-extrabold text-xs shadow">📘 สไตล์เพจ Facebook</button>
                                <button type="button" id="pmAnnStyleBtn-line" onclick="switchPmAnnounceStyle('line')" class="flex-1 py-1.5 rounded-lg text-slate-600 hover:bg-slate-200 font-bold text-xs">💬 สไตล์ส่งกลุ่ม LINE</button>
                            </div>
                            <textarea id="pmPublicAnnounceTextarea" rows="11" class="w-full p-3 rounded-2xl bg-white border-2 border-slate-300 focus:border-indigo-500 focus:outline-none text-xs font-medium text-slate-800 leading-relaxed"></textarea>
                            <p class="text-[10.5px] text-slate-500">✏️ แก้ไขตกแต่งข้อความในกล่องด้านบนเพิ่มเติมได้ตามต้องการ (ระบบตัดรหัสสวิตช์และโน้ตภายในของช่างออกให้อัตโนมัติแล้ว)</p>
                        </div>
                        <div class="p-3 bg-white border-t flex flex-wrap gap-2">
                            <button type="button" onclick="copyPmPublicAnnounceText()" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-extrabold py-2.5 px-3 rounded-xl text-xs shadow">📋 คัดลอกไปวาง Facebook / LINE</button>
                            <button type="button" onclick="sharePmPublicAnnounceToLine()" class="bg-[#00B900] hover:bg-[#009900] text-white font-extrabold py-2.5 px-3.5 rounded-xl text-xs shadow">💬 ส่ง LINE ทันที</button>
                        </div>
                    </div>
                </div>`);
        }

        if (!document.getElementById('pmAiKeyConfigModal')) {
            document.body.insertAdjacentHTML('beforeend', `
                <div id="pmAiKeyConfigModal" onclick="if(event.target===this) closePmAiKeyModal();" class="fixed inset-0 bg-slate-950/80 hidden z-[1496] flex items-center justify-center p-3 backdrop-blur-sm">
                    <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border-2 border-emerald-400 flex flex-col">
                        <div class="px-4 py-3 bg-gradient-to-r from-emerald-700 via-teal-700 to-slate-900 text-white flex justify-between items-center">
                            <h3 class="font-extrabold text-sm">🔑 ตั้งค่า API Key AI อ่านป้ายชื่อแผนที่</h3>
                            <button type="button" onclick="closePmAiKeyModal()" class="text-white/85 hover:text-white text-xl font-bold leading-none">&times;</button>
                        </div>
                        <div class="p-4 space-y-3 text-xs bg-slate-50">
                            <div id="pmAiKeyModalGroupBadge" class="bg-indigo-950 text-amber-300 font-extrabold px-3 py-1.5 rounded-xl text-[11px] text-center shadow-sm">-</div>
                            <div id="pmAiKeyCurrentStatus" class="text-[11px] text-slate-700 bg-white border border-slate-200 rounded-xl px-3 py-2"></div>
                            <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-2.5 space-y-1.5 text-[11px] text-slate-700">
                                <div class="font-extrabold text-emerald-900">วิธีรับคีย์ฟรี (แยกโควตาเฉพาะกลุ่ม 100% ไม่ต้องใช้บัตรเครดิต):</div>
                                <div>1. กดปุ่มด้านล่าง ล็อกอินด้วย Gmail ประจำกลุ่ม/สาขา</div>
                                <div>2. กด <b>Create API key in new project</b> (สำคัญ: ต้องสร้างใน Project ใหม่ โควตาถึงจะแยกขาดกัน 100%)</div>
                                <div class="pt-1">
                                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold px-3 py-1.5 rounded-lg text-[11px] shadow-sm">🔗 เปิดหน้าขอรับ API Key ฟรี (Google AI Studio)</a>
                                </div>
                            </div>
                            <div>
                                <label class="block font-extrabold text-slate-700 mb-1">วางรหัส Gemini API Key ของกลุ่มนี้:</label>
                                <input type="text" id="pmAiKeyInput" onkeydown="if(event.key==='Enter'){event.preventDefault();savePmGroupAiKeyFromModal();}" placeholder="AIzaSy..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" style="-webkit-text-security:disc;text-security:disc;" class="w-full px-3 py-2 rounded-xl bg-white border-2 border-slate-300 focus:border-emerald-500 focus:outline-none font-mono text-xs text-slate-900">
                            </div>
                        </div>
                        <div class="p-3 bg-white border-t space-y-2">
                            <div class="flex flex-wrap gap-2">
                                <button type="button" id="pmAiKeyClearBtn" onclick="clearPmGroupAiKeyFromModal()" class="hidden bg-rose-100 hover:bg-rose-200 text-rose-700 font-bold py-2 px-3 rounded-xl text-xs">🗑️ ลบคีย์</button>
                                <button type="button" onclick="closePmAiKeyModal()" class="bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold py-2 px-3.5 rounded-xl text-xs ml-auto">ยกเลิก</button>
                                <button type="button" id="pmAiKeySaveBtn" onclick="savePmGroupAiKeyFromModal()" class="bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold py-2 px-4 rounded-xl text-xs shadow">💾 บันทึกคีย์ประจำกลุ่ม</button>
                            </div>
                            <button type="button" id="pmAiKeySkipBasicBtn" onclick="skipAiAndExtractBasicZonePlaces()" class="hidden w-full bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold py-1.5 rounded-xl text-[11px]">ข้ามไปดึงเฉพาะชื่อถนน/ตำบลพื้นฐานก่อน (ไม่ใช้ AI)</button>
                        </div>
                    </div>
                </div>`);
        }
        updateGroupAiKeyButtonsUI();
    }
    // ===== จบพาทที่ 5 / 6 ของไฟล์ pm-calendar.js =====
    // ===== เริ่มพาทที่ 6 / 6 ของไฟล์ pm-calendar.js =====
    function togglePmMiniMapFullscreen(forceState) {
        addManualTempPubPlace();
        const wrap = document.getElementById('pmFormMiniMapWrap'), mapCanvas = document.getElementById('pmFormMiniLeafletMap'), fsBtn = document.getElementById('pmMiniMapFsBtn');
        if (!wrap || !mapCanvas) return;
        isMiniMapFullscreen = typeof forceState === 'boolean' ? forceState : !isMiniMapFullscreen;
        if (isMiniMapFullscreen) {
            wrap.className = 'fixed inset-0 z-[1460] bg-slate-950 flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]';
            mapCanvas.style.height = 'auto';
            mapCanvas.style.flex = '1 1 0%';
            if (fsBtn) fsBtn.textContent = '✅ เสร็จ / ย่อกลับ';
        } else {
            wrap.className = `${isFormMiniMapOpen ? '' : 'hidden '}relative rounded-xl overflow-hidden border-2 border-indigo-300`;
            mapCanvas.style.flex = '';
            mapCanvas.style.height = tempPubEnabled ? '300px' : '185px';
            if (fsBtn) fsBtn.textContent = '⛶ ขยายเต็มจอ';
        }
        if (formMiniMap) mapCanvas.classList.add('leaflet-container');
        setTimeout(() => formMiniMap?.invalidateSize(), 60);
        setTimeout(() => formMiniMap?.invalidateSize(), 220);
    }

    function updatePmZoneDrawToolbarUI() {
        ensurePmOutageZoneUiInjected();
        updateGroupAiKeyButtonsUI();
        if (!document.getElementById('pmLeafletTileFixStyle')) {
            const fixSt = document.createElement('style');
            fixSt.id = 'pmLeafletTileFixStyle';
            fixSt.textContent = '#pmFormMiniLeafletMap img, #pmCalendarEmbeddedMap img, .leaflet-container img, .leaflet-container svg { max-width: none !important; max-height: none !important; }';
            document.head.appendChild(fixSt);
        }
        const tb = document.getElementById('pmZoneDrawToolbar'), cfgBody = document.getElementById('pmPubOutageConfigBody');
        const chk = document.getElementById('pmPubOutageEnableChk'), mapCanvas = document.getElementById('pmFormMiniLeafletMap'), hdrHint = document.getElementById('pmMiniMapHdrHint');
        if (chk) chk.checked = tempPubEnabled;
        cfgBody?.classList.toggle('hidden', !tempPubEnabled);
        tb?.classList.toggle('hidden', !tempPubEnabled);
        if (!isMiniMapFullscreen && mapCanvas) {
            mapCanvas.style.flex = '';
            mapCanvas.style.height = tempPubEnabled ? '300px' : '185px';
        }
        if (formMiniMap && mapCanvas) mapCanvas.classList.add('leaflet-container');

        ['circle', 'poly_click', 'poly_lasso'].forEach(m => {
            const b = document.getElementById('pmDrawModeBtn-' + m);
            if (b) b.className = (pubDrawSubMode === m) ? 'px-2 py-1 rounded-md bg-rose-600 text-white font-extrabold text-[10.5px] shadow' : 'px-2 py-1 rounded-md text-slate-300 hover:bg-slate-700 font-bold text-[10.5px]';
        });

        const isCircle = (pubDrawSubMode === 'circle');
        document.getElementById('pmCircleRadiusControls')?.classList.toggle('hidden', !isCircle);
        const polyGrp = document.getElementById('pmPolyActionsGrp');
        if (polyGrp) { polyGrp.classList.toggle('hidden', isCircle); polyGrp.classList.toggle('flex', !isCircle); }
        const polyHint = document.getElementById('pmPolyStatusHint');
        if (polyHint) {
            polyHint.classList.toggle('hidden', isCircle);
            polyHint.textContent = pubDrawSubMode === 'poly_lasso'
                ? '✍️ กดนิ้ว/เมาส์ค้างบนแผนที่แล้วลากวนคลุมพื้นที่ไฟดับ เมื่อปล่อยนิ้วระบบจะสร้างกรอบให้อัตโนมัติ'
                : `📐 ปักมุมแล้ว ${tempPolyPts.length} จุด ${tempPolyPts.length < 3 ? '(แตะเพิ่มให้ครบอย่างน้อย 3 มุม)' : '(ลากจุดสีขาวเพื่อขยับมุมแก้ไขได้)'}`;
        }
        if (hdrHint) {
            hdrHint.textContent = !tempPubEnabled
                ? '👆 แตะบนแผนที่หรือลากหมุดเพื่อเลือกจุดปฏิบัติงาน'
                : (isCircle ? '📡 แตะเลือกจุดศูนย์กลางวงเรดาร์ หรือลากจุดส้มขอบวงเพื่อปรับรัศมี' : (pubDrawSubMode === 'poly_lasso' ? '✍️ โหมดลากตีกรอบอิสระ: กดค้างแล้วลากวนรอบพื้นที่' : '📐 แตะปักมุมล้อมรอบพื้นที่ดับไฟ'));
        }
        const rLbl = document.getElementById('pmCircleRadiusLabel'), rSld = document.getElementById('pmCircleRadiusSlider');
        if (rLbl) rLbl.textContent = String(tempCircleRadius);
        if (rSld) rSld.value = String(Math.min(3000, Math.max(50, tempCircleRadius)));

        if (formMiniMap) {
            const container = formMiniMap.getContainer();
            if (tempPubEnabled && pubDrawSubMode === 'poly_lasso') {
                formMiniMap.dragging.disable();
                container.style.touchAction = 'none';
                container.style.cursor = 'crosshair';
            } else {
                formMiniMap.dragging.enable();
                container.style.touchAction = '';
                container.style.cursor = '';
            }
            setTimeout(() => formMiniMap?.invalidateSize(), 80);
        }
    }

    function renderFormZoneOverlay() {
        if (!formMiniMap || typeof L === 'undefined') return;
        if (!formZoneHandlesLayer) formZoneHandlesLayer = L.layerGroup().addTo(formMiniMap);
        formZoneHandlesLayer.clearLayers();
        if (formZoneShapeLayer) { formMiniMap.removeLayer(formZoneShapeLayer); formZoneShapeLayer = null; }
        if (!tempPubEnabled) return;

        if (tempZoneType === 'c' && Array.isArray(tempCircleCenter)) {
            formZoneShapeLayer = L.circle(tempCircleCenter, {
                radius: tempCircleRadius, color: '#e11d48', weight: 2.5, fillColor: '#f43f5e', fillOpacity: 0.22
            }).addTo(formMiniMap);

            const [cLat, cLon] = tempCircleCenter;
            const edgeLon = cLon + (tempCircleRadius / (111320 * Math.max(0.2, Math.cos(cLat * Math.PI / 180))));
            const edgeIcon = L.divIcon({
                className: '',
                html: '<div title="ลากเพื่อปรับรัศมีวงเรดาร์" style="width:18px;height:18px;border-radius:9999px;background:#f59e0b;border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.45);cursor:ew-resize;"></div>',
                iconSize: [18, 18], iconAnchor: [9, 9]
            });
            const edgeHandle = L.marker([cLat, edgeLon], { icon: edgeIcon, draggable: true, zIndexOffset: 900 }).addTo(formZoneHandlesLayer);
            edgeHandle.on('drag', ev => {
                const dist = Math.max(30, Math.min(5000, Math.round(formMiniMap.distance(tempCircleCenter, ev.target.getLatLng()))));
                tempCircleRadius = dist;
                formZoneShapeLayer?.setRadius(dist);
                const rLbl = document.getElementById('pmCircleRadiusLabel'), rSld = document.getElementById('pmCircleRadiusSlider');
                if (rLbl) rLbl.textContent = String(dist);
                if (rSld) rSld.value = String(Math.min(3000, Math.max(50, dist)));
            });
            edgeHandle.on('dragend', () => renderFormZoneOverlay());
        } else if (tempZoneType === 'p' && tempPolyPts.length > 0) {
            if (tempPolyPts.length >= 3) {
                formZoneShapeLayer = L.polygon(tempPolyPts, {
                    color: '#e11d48', weight: 2.5, fillColor: '#f43f5e', fillOpacity: 0.24
                }).addTo(formMiniMap);
            } else if (tempPolyPts.length === 2) {
                formZoneShapeLayer = L.polyline(tempPolyPts, { color: '#e11d48', weight: 2.5, dashArray: '6 4' }).addTo(formMiniMap);
            }
            tempPolyPts.forEach((pt, idx) => {
                const vIcon = L.divIcon({
                    className: '',
                    html: `<div style="width:16px;height:16px;border-radius:9999px;background:${idx === 0 ? '#fde047' : '#ffffff'};border:2.5px solid #e11d48;box-shadow:0 2px 5px rgba(0,0,0,0.4);"></div>`,
                    iconSize: [16, 16], iconAnchor: [8, 8]
                });
                const vm = L.marker(pt, { icon: vIcon, draggable: true, zIndexOffset: 880 }).addTo(formZoneHandlesLayer);
                vm.on('click', ev => L.DomEvent.stopPropagation(ev));
                vm.on('drag', ev => {
                    const ll = ev.target.getLatLng();
                    tempPolyPts[idx] = [Number(ll.lat.toFixed(5)), Number(ll.lng.toFixed(5))];
                    if (formZoneShapeLayer?.setLatLngs) formZoneShapeLayer.setLatLngs(tempPolyPts);
                });
            });
        }
    }

    async function onTogglePmPublicOutage(checked) {
        tempPubEnabled = Boolean(checked);
        if (tempPubEnabled) {
            if (!isFormMiniMapOpen) await togglePmFormMiniMap(true);
            if (!tempCircleCenter && tempZoneType === 'c') {
                const parsed = await parsePmCoordOrShortLink(document.getElementById('pmCoordInput')?.value || '');
                if (parsed) tempCircleCenter = [Number(parsed.lat.toFixed(5)), Number(parsed.lon.toFixed(5))];
            }
        } else if (isMiniMapFullscreen) {
            togglePmMiniMapFullscreen(false);
        }
        renderTempPubPlacesUI();
        updatePmZoneDrawToolbarUI();
        renderFormZoneOverlay();
        if (tempPubEnabled && formMiniMap && formZoneShapeLayer?.getBounds) {
            try { formMiniMap.fitBounds(formZoneShapeLayer.getBounds(), { padding: [24, 24], maxZoom: 16 }); } catch (e) {}
        }
    }

    function setPmZoneDrawSubMode(mode) {
        pubDrawSubMode = mode;
        tempZoneType = (mode === 'circle') ? 'c' : 'p';
        if (mode === 'circle' && !tempCircleCenter && tempPolyPts.length >= 3) {
            const c = getZoneCentroidPm({ t: 'p', p: tempPolyPts });
            if (c) tempCircleCenter = [Number(c.lat.toFixed(5)), Number(c.lon.toFixed(5))];
        }
        updatePmZoneDrawToolbarUI();
        renderFormZoneOverlay();
    }

    function onPmCircleRadiusInput(val) {
        tempCircleRadius = Math.max(30, Math.min(10000, parseInt(val, 10) || 300));
        updatePmZoneDrawToolbarUI();
        renderFormZoneOverlay();
    }

    function undoLastPmZonePolyPoint() {
        if (!tempPolyPts.length) return;
        tempPolyPts.pop();
        updatePmZoneDrawToolbarUI();
        renderFormZoneOverlay();
    }

    function clearPmZonePolygon() {
        tempPolyPts = [];
        updatePmZoneDrawToolbarUI();
        renderFormZoneOverlay();
    }

    function bindMiniMapLassoEvents(map) {
        const el = map.getContainer();
        if (!el || el.__pmLassoBound) return;
        el.__pmLassoBound = true;

        const evToLatLng = ev => {
            const rect = el.getBoundingClientRect();
            const clientX = ev.touches?.[0]?.clientX ?? ev.clientX;
            const clientY = ev.touches?.[0]?.clientY ?? ev.clientY;
            return map.containerPointToLatLng([clientX - rect.left, clientY - rect.top]);
        };

        el.addEventListener('pointerdown', ev => {
            if (!tempPubEnabled || pubDrawSubMode !== 'poly_lasso') return;
            if (ev.target.closest('.leaflet-control')) return;
            ev.preventDefault(); ev.stopPropagation();
            try { el.setPointerCapture(ev.pointerId); } catch (e) {}
            const ll = evToLatLng(ev);
            isLassoDragging = true;
            lassoRawPts = [[ll.lat, ll.lng]];
            if (lassoPolyline) map.removeLayer(lassoPolyline);
            lassoPolyline = L.polyline(lassoRawPts, { color: '#fb923c', weight: 3.5, dashArray: '6 4' }).addTo(map);
        }, { passive: false });

        el.addEventListener('pointermove', ev => {
            if (!isLassoDragging) return;
            ev.preventDefault();
            const ll = evToLatLng(ev);
            const prev = lassoRawPts[lassoRawPts.length - 1];
            if (!prev || map.distance(prev, [ll.lat, ll.lng]) >= 8) {
                lassoRawPts.push([ll.lat, ll.lng]);
                lassoPolyline?.setLatLngs(lassoRawPts);
            }
        }, { passive: false });

        const finishLasso = ev => {
            if (!isLassoDragging) return;
            isLassoDragging = false;
            lastLassoFinishMs = Date.now();
            try { el.releasePointerCapture(ev.pointerId); } catch (e) {}
            if (lassoPolyline) { map.removeLayer(lassoPolyline); lassoPolyline = null; }
            if (lassoRawPts.length >= 3) {
                tempZoneType = 'p';
                tempPolyPts = simplifyPolyRdpPm(lassoRawPts, 0.00011);
                if (tempPolyPts.length >= 3) {
                    const cdEl = document.getElementById('pmCoordInput');
                    if (cdEl && !cdEl.value.trim()) {
                        const cen = getZoneCentroidPm({ t: 'p', p: tempPolyPts });
                        if (cen) { cdEl.value = `${cen.lat.toFixed(6)}, ${cen.lon.toFixed(6)}`; syncFormMiniMapMarker(cen.lat, cen.lon, false); }
                    }
                    setPmZoneDrawSubMode('poly_click');
                    safeToast(`✅ ลากตีกรอบเรดาร์สำเร็จ (${tempPolyPts.length} มุม) กดปุ่ม 🔍 ดูดชื่อสถานที่ต่อได้เลย!`);
                    return;
                }
            }
            safeToast('👆 กดค้างแล้วลากวนรอบบริเวณที่ต้องการคลุมให้กว้างขึ้นอีกนิดครับ');
        };
        el.addEventListener('pointerup', finishLasso);
        el.addEventListener('pointercancel', finishLasso);
    }

    function renderZonesOnCalendarEmbeddedMap() {
        if (!calendarMapInstance || typeof L === 'undefined') return;
        if (!calMapZoneLayer) calMapZoneLayer = L.layerGroup().addTo(calendarMapInstance);
        calMapZoneLayer.clearLayers();
        getAllVisibleCalendarItems().forEach(it => {
            if (it.status === 'done' || !it.pub || !it.oz) return;
            const z = it.oz;
            const style = { color: '#e11d48', weight: 2, dashArray: '5 4', fillColor: '#f43f5e', fillOpacity: 0.16 };
            const lyr = z.t === 'c' ? L.circle(z.c, { ...style, radius: z.r }) : L.polygon(z.p, style);
            lyr.bindTooltip(`📡 เขตแจ้งดับไฟประชาชน: ${safeEscHtml(it.title)}`, { sticky: true });
            lyr.addTo(calMapZoneLayer);
        });
    }

    function syncFormMiniMapMarker(lat, lon, panTo = true) {
        if (!formMiniMap || typeof L === 'undefined') return;
        if (isNaN(lat) || isNaN(lon)) { if (formMiniMarker) { formMiniMap.removeLayer(formMiniMarker); formMiniMarker = null; } return; }
        if (!formMiniMarker) {
            formMiniMarker = L.marker([lat, lon], { draggable: true }).addTo(formMiniMap);
            formMiniMarker.on('dragend', ev => {
                const ll = ev.target.getLatLng(), cdEl = document.getElementById('pmCoordInput');
                if (cdEl) cdEl.value = `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;
                if (tempPubEnabled && tempZoneType === 'c') { tempCircleCenter = [Number(ll.lat.toFixed(5)), Number(ll.lng.toFixed(5))]; renderFormZoneOverlay(); }
            });
        } else formMiniMarker.setLatLng([lat, lon]);
        if (panTo) formMiniMap.setView([lat, lon], Math.max(formMiniMap.getZoom(), 15));
    }

    async function togglePmFormMiniMap(forceOpen) {
        ensurePmOutageZoneUiInjected();
        if (forceOpen === false || forceOpen === 'close_btn') addManualTempPubPlace();
        if (forceOpen === 'close_btn' && isMiniMapFullscreen) return togglePmMiniMapFullscreen(false);
        const wrap = document.getElementById('pmFormMiniMapWrap'); if (!wrap) return;
        isFormMiniMapOpen = typeof forceOpen === 'boolean' ? forceOpen : (forceOpen === 'close_btn' ? false : !isFormMiniMapOpen);
        const reqSeq = ++miniMapSyncSeq;
        if (!isFormMiniMapOpen && isMiniMapFullscreen) togglePmMiniMapFullscreen(false);
        wrap.classList.toggle('hidden', !isFormMiniMapOpen);
        if (!isFormMiniMapOpen) { syncFormMiniMapMarker(NaN, NaN, false); return; }
        updatePmZoneDrawToolbarUI();
        if (!(await ensureLeafletReady()) || typeof L === 'undefined' || !isFormMiniMapOpen || reqSeq !== miniMapSyncSeq) return;
        if (!formMiniMap) {
            const kc = window.lastKnownTechCoords;
            const kcLat = parseFloat(kc?.lat), kcLon = parseFloat(kc?.lon ?? kc?.lng);
            const defCenter = (!isNaN(kcLat) && !isNaN(kcLon) && Math.abs(kcLat) > 0.1) ? [kcLat, kcLon] : [13.1361, 101.0322];
            formMiniMap = L.map('pmFormMiniLeafletMap').setView(defCenter, 14);
            const gHyb = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' }).addTo(formMiniMap);
            const gStr = L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' });
            L.control.layers({ '🛰️ ดาวเทียม': gHyb, '🗺️ ถนน': gStr }, null, { position: 'topright' }).addTo(formMiniMap);
            bindMiniMapLassoEvents(formMiniMap);
            formMiniMap.on('click', e => {
                if (!e.latlng || (Date.now() - lastLassoFinishMs < 350)) return;
                const la = Number(e.latlng.lat.toFixed(6)), lo = Number(e.latlng.lng.toFixed(6));
                const cdEl = document.getElementById('pmCoordInput');
                if (tempPubEnabled && pubDrawSubMode === 'poly_lasso') return;
                if (tempPubEnabled && pubDrawSubMode === 'poly_click') {
                    if (tempPolyPts.length >= 30) { safeToast('⚠️ ปักมุมได้สูงสุด 30 จุด'); return; }
                    tempZoneType = 'p';
                    tempPolyPts.push([Number(la.toFixed(5)), Number(lo.toFixed(5))]);
                    if (cdEl && !cdEl.value.trim()) { cdEl.value = `${la.toFixed(6)}, ${lo.toFixed(6)}`; syncFormMiniMapMarker(la, lo, false); }
                    updatePmZoneDrawToolbarUI();
                    renderFormZoneOverlay();
                    return;
                }
                if (cdEl) cdEl.value = `${la.toFixed(6)}, ${lo.toFixed(6)}`;
                syncFormMiniMapMarker(la, lo, false);
                if (tempPubEnabled && tempZoneType === 'c') {
                    tempCircleCenter = [Number(la.toFixed(5)), Number(lo.toFixed(5))];
                    renderFormZoneOverlay();
                }
            });
        }
        updatePmZoneDrawToolbarUI();
        requestAnimationFrame(() => formMiniMap?.invalidateSize());
        setTimeout(async () => {
            if (!isFormMiniMapOpen || reqSeq !== miniMapSyncSeq || !formMiniMap) return;
            formMiniMap.invalidateSize();
            const parsed = await parsePmCoordOrShortLink(document.getElementById('pmCoordInput')?.value || '');
            if (!isFormMiniMapOpen || reqSeq !== miniMapSyncSeq) return;
            if (parsed) {
                syncFormMiniMapMarker(parsed.lat, parsed.lon, !tempPubEnabled);
                if (tempPubEnabled && tempZoneType === 'c' && !tempCircleCenter) tempCircleCenter = [Number(parsed.lat.toFixed(5)), Number(parsed.lon.toFixed(5))];
            } else syncFormMiniMapMarker(NaN, NaN, false);
            renderFormZoneOverlay();
            if (tempPubEnabled && formZoneShapeLayer?.getBounds) {
                try { formMiniMap.fitBounds(formZoneShapeLayer.getBounds(), { padding: [24, 24], maxZoom: 16 }); } catch (e) {}
            }
            setTimeout(() => formMiniMap?.invalidateSize(), 180);
        }, 100);
    }

    async function onPmCoordTextManualInput(rawVal) {
        const reqSeq = ++miniMapSyncSeq, p = await parsePmCoordOrShortLink(rawVal);
        if (reqSeq !== miniMapSyncSeq) return;
        if (p && tempZoneType === 'c') tempCircleCenter = [Number(p.lat.toFixed(5)), Number(p.lon.toFixed(5))];
        if (!isFormMiniMapOpen || !formMiniMap) return;
        if (p) {
            syncFormMiniMapMarker(p.lat, p.lon, true);
            if (tempPubEnabled) renderFormZoneOverlay();
        } else syncFormMiniMapMarker(NaN, NaN, false);
    }

    function onPmScadaEquipPick(pinId) {
        if (!pinId) return;
        try {
            const target = JSON.parse(rawGet('elec_labeled_places_list') || '[]').find(p => p?.id === pinId); if (!target) return;
            const eqEl = document.getElementById('pmEquipCodeInput'), fdEl = document.getElementById('pmFeederInput'), cdEl = document.getElementById('pmCoordInput'), ttEl = document.getElementById('pmTitleInput');
            if (eqEl) eqEl.value = target.name || ''; if (fdEl) fdEl.value = (target.scadaNode?.fd || '').toUpperCase();
            if (!isNaN(parseFloat(target.lat)) && !isNaN(parseFloat(target.lon))) {
                const lat = Number(target.lat), lon = Number(target.lon);
                if (cdEl) cdEl.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                if (tempZoneType === 'c') tempCircleCenter = [Number(lat.toFixed(5)), Number(lon.toFixed(5))];
                if (isFormMiniMapOpen) { syncFormMiniMapMarker(lat, lon, true); renderFormZoneOverlay(); }
            }
            if (ttEl && !ttEl.value.trim()) ttEl.value = `${getCategoryMeta(document.getElementById('pmCategorySelect')?.value || 'scada').name} (${target.name})`;
            safeToast(`⚡ ดึงพิกัดหมุดจาก "${target.name}" แล้ว`);
        } catch (e) {}
    }

    function fillPmCurrentMobileGps() {
        const coordEl = document.getElementById('pmCoordInput');
        if (!navigator.geolocation) { safeToast('⚠️ เบราว์เซอร์ไม่รองรับ GPS'); return; }
        safeToast('⏳ กำลังดึงพิกัดมือถือปัจจุบัน...');
        navigator.geolocation.getCurrentPosition(
            pos => {
                const la = Number(pos.coords.latitude.toFixed(6)), lo = Number(pos.coords.longitude.toFixed(6));
                if (coordEl) coordEl.value = `${la.toFixed(6)}, ${lo.toFixed(6)}`;
                if (tempZoneType === 'c') tempCircleCenter = [Number(la.toFixed(5)), Number(lo.toFixed(5))];
                if (isFormMiniMapOpen) { syncFormMiniMapMarker(la, lo, true); renderFormZoneOverlay(); }
                safeToast(`📍 ดึงพิกัดสำเร็จ (${la.toFixed(6)}, ${lo.toFixed(6)})`);
            },
            () => {
                const kc = window.lastKnownTechCoords;
                const kcLat = parseFloat(kc?.lat), kcLon = parseFloat(kc?.lon ?? kc?.lng);
                if (!isNaN(kcLat) && !isNaN(kcLon) && coordEl) {
                    const la = Number(kcLat.toFixed(6)), lo = Number(kcLon.toFixed(6));
                    coordEl.value = `${la.toFixed(6)}, ${lo.toFixed(6)}`;
                    if (tempZoneType === 'c') tempCircleCenter = [Number(la.toFixed(5)), Number(lo.toFixed(5))];
                    if (isFormMiniMapOpen) { syncFormMiniMapMarker(la, lo, true); renderFormZoneOverlay(); }
                    safeToast('📍 ใช้พิกัดล่าสุดของเครื่อง');
                } else safeToast('❌ ไม่สามารถดึงพิกัดได้ กรุณาเปิด Location ในเครื่อง');
            },
            { enableHighAccuracy: true, timeout: 8000 }
        );
    }

    async function parsePmCoordOrShortLink(rawStr) {
        const txt = String(rawStr || '').trim(); if (!txt) return null;
        let pair = null;
        const m3d = txt.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/i);
        const mAt = !m3d ? txt.match(/@(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/) : null;
        const mQ = (!m3d && !mAt) ? txt.match(/[?&](?:q|ll|destination|query|center)=(-?\d+\.\d+)\s*(?:,|%2C)\s*(-?\d+\.\d+)/i) : null;
        if (m3d) pair = { lat: m3d[1], lon: m3d[2] }; else if (mAt) pair = { lat: mAt[1], lon: mAt[2] }; else if (mQ) pair = { lat: mQ[1], lon: mQ[2] };
        if (!pair && typeof window.deepParseCoords === 'function') { try { pair = window.deepParseCoords(txt, false); } catch (e) {} }
        if (!pair && /(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(txt) && typeof window.resolveGoogleShortLinkUniversal === 'function') {
            try { pair = await window.resolveGoogleShortLinkUniversal(txt); } catch (e) { pair = null; }
        }
        if (!pair) {
            const direct = txt.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/), nums = !direct ? txt.match(/-?\d+\.\d+/g) : null;
            if (direct) pair = { lat: direct[1], lon: direct[2] }; else if (nums?.length >= 2) pair = { lat: nums[0], lon: nums[1] };
        }
        if (!pair) return null;
        let lat = parseFloat(pair.lat), lon = parseFloat(pair.lon); if (isNaN(lat) || isNaN(lon)) return null;
        if (Math.abs(lat) > 90 && Math.abs(lon) <= 90 && Math.abs(lat) <= 180) { const tmp = lat; lat = lon; lon = tmp; }
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
    }

    function openPmPlanFormModal(planId = null, presetDate = null, presetLat = null, presetLon = null, presetScadaPinId = null) {
        if (!canManagePmSchedule()) { safeToast('🔒 กรุณาเข้าสู่ระบบด้วยสิทธิ์แอดมินหรือผู้ใช้งานทั่วไปเพื่อแก้ไขแผนงาน'); return; }
        injectPmModalsDOM(); ensurePmOutageZoneUiInjected(); loadPmPlansFromStorage(); editingPlanId = planId || null;
        const modal = document.getElementById('pmPlanFormModal'), titleHdr = document.getElementById('pmPlanFormTitle'), delBtn = document.getElementById('pmDeleteBtnInModal'), modeSel = document.getElementById('pmAlertModeSelect');
        if (!modal) return;
        syncFormMiniMapMarker(NaN, NaN, false);
        sessionModalUploadedIds = [];
        tempPubEnabled = false; tempZoneType = 'c'; tempCircleCenter = null; tempCircleRadius = 300; tempPolyPts = []; pubDrawSubMode = 'circle';
        tempPubPlacesList = [];
        const quickAddInp = document.getElementById('pmMapQuickPlaceAddInput');
        if (quickAddInp) quickAddInp.value = '';
        let shouldOpenMiniMap = false;

        if (editingPlanId) {
            const target = pmPlans.find(p => p.id === editingPlanId && !p.pmDeleted); if (!target) return;
            if (titleHdr) titleHdr.textContent = '✏️ แก้ไขแผนงาน / รูปภาพ / โซนเรดาร์ประชาชน';
            populatePmScadaPinPicker(target.linkedPinId || ''); selectPmFormPinColor(target.pinColor || 'auto');
            document.getElementById('pmTitleInput').value = target.title || ''; document.getElementById('pmCategorySelect').value = target.category || 'scada';
            document.getElementById('pmDateInput').value = target.date || getTodayIso(); document.getElementById('pmTimeSlotInput').value = target.timeSlot || '09.00-12.00';
            document.getElementById('pmNotifyBeforeSelect').value = String(target.notifyDaysBefore ?? 3); document.getElementById('pmRepeatMonthsSelect').value = String(target.repeatMonths ?? 0);
            tempFormCustomTimes = normalizeCustomTimesArray(target.customAlertTimes || []);
            const effMode = target.alertMode || (tempFormCustomTimes.length > 0 ? 'both' : 'standard');
            if (modeSel) modeSel.value = effMode; onPmAlertModeChange(effMode);
            originalEditingPhotoIds = normalizePmPhotoIds(target);
            tempFormPhotoIds = [...originalEditingPhotoIds];
            renderPmModalPhotoPreviews();
            document.getElementById('pmEquipCodeInput').value = target.equipCode || ''; document.getElementById('pmFeederInput').value = target.feeder || '';
            const hasC = !isNaN(parseFloat(target.lat)) && !isNaN(parseFloat(target.lon));
            document.getElementById('pmCoordInput').value = hasC ? `${Number(target.lat).toFixed(6)}, ${Number(target.lon).toFixed(6)}` : (target.gpsLink || '');
            document.getElementById('pmNoteInput').value = target.note || ''; delBtn?.classList.remove('hidden');

            const savedOz = normalizePmOutageZone(target.oz);
            tempPubEnabled = Boolean(target.pub && savedOz);
            const pubNoteEl = document.getElementById('pmPubOutageNoteInput');
            if (pubNoteEl) pubNoteEl.value = target.pubNote || '';
            tempPubPlacesList = parsePlacesTextToList(target.pubPlaces || '');
            renderTempPubPlacesUI();
            if (savedOz) {
                if (savedOz.t === 'c') { tempZoneType = 'c'; pubDrawSubMode = 'circle'; tempCircleCenter = [...savedOz.c]; tempCircleRadius = savedOz.r; }
                else if (savedOz.t === 'p') { tempZoneType = 'p'; pubDrawSubMode = 'poly_click'; tempPolyPts = savedOz.p.map(pt => [...pt]); }
            }
            shouldOpenMiniMap = tempPubEnabled || (hasC && isFormMiniMapOpen);
        } else {
            if (titleHdr) titleHdr.textContent = (presetLat != null && presetLon != null) ? '📍 ปักหมุดแผนงานใหม่ (จากจุดที่แตะบนแมพ)' : '➕ เพิ่มหมุดแผนงานบำรุงรักษาใหม่';
            populatePmScadaPinPicker(presetScadaPinId || ''); selectPmFormPinColor('auto');
            document.getElementById('pmTitleInput').value = ''; document.getElementById('pmCategorySelect').value = presetScadaPinId ? 'scada' : 'tree';
            document.getElementById('pmDateInput').value = presetDate || selectedDateIso || getTodayIso(); document.getElementById('pmTimeSlotInput').value = '09.00-12.00';
            document.getElementById('pmNotifyBeforeSelect').value = '3'; document.getElementById('pmRepeatMonthsSelect').value = '0';
            tempFormCustomTimes = []; if (modeSel) modeSel.value = 'standard'; onPmAlertModeChange('standard');
            originalEditingPhotoIds = []; tempFormPhotoIds = [];
            renderPmModalPhotoPreviews();
            document.getElementById('pmEquipCodeInput').value = ''; document.getElementById('pmFeederInput').value = '';
            document.getElementById('pmCoordInput').value = (presetLat != null && presetLon != null) ? `${Number(presetLat).toFixed(6)}, ${Number(presetLon).toFixed(6)}` : '';
            document.getElementById('pmNoteInput').value = ''; delBtn?.classList.add('hidden');
            const pubNoteEl = document.getElementById('pmPubOutageNoteInput');
            if (pubNoteEl) pubNoteEl.value = '';
            tempPubPlacesList = [];
            renderTempPubPlacesUI();
            if (presetLat != null && presetLon != null) tempCircleCenter = [Number(Number(presetLat).toFixed(5)), Number(Number(presetLon).toFixed(5))];
            if (presetScadaPinId) onPmScadaEquipPick(presetScadaPinId);
            shouldOpenMiniMap = (presetLat != null && presetLon != null);
        }
        updatePmZoneDrawToolbarUI();
        modal.classList.remove('hidden');
        togglePmFormMiniMap(shouldOpenMiniMap);
        setTimeout(() => document.getElementById('pmTitleInput')?.focus(), 80);
    }

    function closePmPlanFormModal(skipOrphanClean = false) {
        const quickAddInp = document.getElementById('pmMapQuickPlaceAddInput');
        if (quickAddInp) quickAddInp.value = '';
        if (!skipOrphanClean && sessionModalUploadedIds.length > 0) {
            const orphans = sessionModalUploadedIds.filter(id => !originalEditingPhotoIds.includes(id));
            sessionModalUploadedIds = [];
            if (orphans.length > 0) trashUnusedPmPhotoIdsInBackground(orphans);
        } else {
            sessionModalUploadedIds = [];
        }
        editingPlanId = null; tempFormPhotoIds = []; originalEditingPhotoIds = [];
        tempPubEnabled = false; tempPubPlacesList = [];
        closePmPublicAnnounceModal();
        if (isMiniMapFullscreen) togglePmMiniMapFullscreen(false);
        togglePmFormMiniMap(false);
        document.getElementById('pmPlanFormModal')?.classList.add('hidden');
    }

    async function savePmPlanFromModal() {
        if (!canManagePmSchedule()) return;
        if (isUploadingModalPhotos) { safeToast('⏳ กรุณารออัปโหลดรูปภาพให้เสร็จก่อนกดบันทึกครับ'); return; }
        addManualTempPubPlace();
        const title = (document.getElementById('pmTitleInput')?.value || '').trim(), category = document.getElementById('pmCategorySelect')?.value || 'scada';
        const pinColor = document.getElementById('pmPinColorInput')?.value || 'auto', dateVal = (document.getElementById('pmDateInput')?.value || '').trim();
        const timeSlot = (document.getElementById('pmTimeSlotInput')?.value || '').trim() || '09.00-12.00';
        const notifyDaysBefore = parseInt(document.getElementById('pmNotifyBeforeSelect')?.value || '3', 10), repeatMonths = parseInt(document.getElementById('pmRepeatMonthsSelect')?.value || '0', 10);
        const alertMode = document.getElementById('pmAlertModeSelect')?.value || 'standard', rawLinkedPinId = (document.getElementById('pmScadaPinPicker')?.value || '').trim();
        const equipCode = (document.getElementById('pmEquipCodeInput')?.value || '').trim(), feeder = (document.getElementById('pmFeederInput')?.value || '').trim().toUpperCase();
        const rawCoord = (document.getElementById('pmCoordInput')?.value || '').trim(), note = (document.getElementById('pmNoteInput')?.value || '').trim(), saveBtn = document.getElementById('pmSaveSubmitBtn');
        const pubNote = (document.getElementById('pmPubOutageNoteInput')?.value || '').trim();

        const rawPlacesList = parsePlacesTextToList(document.getElementById('pmPubOutagePlacesInput')?.value ?? tempPubPlacesList.join(', '));
        const keptPlaces = [];
        let placesLen = 0;
        for (const pl of rawPlacesList) {
            if (keptPlaces.length === 0 && pl.length > 900) {
                keptPlaces.push(pl.slice(0, 900).trim());
                break;
            }
            const nextLen = keptPlaces.length === 0 ? pl.length : placesLen + 2 + pl.length;
            if (nextLen > 900) break;
            keptPlaces.push(pl);
            placesLen = nextLen;
        }
        const pubPlaces = keptPlaces.join(', ');
        if (!title) { safeToast('⚠️ กรุณาระบุชื่อหมุดแผนงาน / หัวข้องาน'); return; }
        if (!dateVal) { safeToast('⚠️ กรุณาเลือกวันที่กำหนดทำ'); return; }
        let customAlertTimes = normalizeCustomTimesArray(tempFormCustomTimes);
        if ((alertMode === 'custom_only' || alertMode === 'both') && !customAlertTimes.length) { const fb = normalizeTimeHHMM(document.getElementById('pmCustomTimePickerInput')?.value || ''); if (fb) customAlertTimes = [fb]; }
        if (alertMode === 'custom_only' && !customAlertTimes.length) { safeToast('⚠️ กรุณากด ➕ เพิ่มเวลาเตือนอย่างน้อย 1 เวลา'); return; }

        let parsedCoord = null;
        if (rawCoord) {
            if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ กำลังตรวจสอบพิกัด...'; }
            try { parsedCoord = await parsePmCoordOrShortLink(rawCoord); }
            catch (e) { parsedCoord = null; }
            finally { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 บันทึกหมุดแผนงาน'; } }
            if (!parsedCoord) { safeToast('❌ รูปแบบพิกัดหรือลิงก์ Maps ไม่ถูกต้อง'); return; }
        }

        loadPmPlansFromStorage();
        const prevSavedOz = editingPlanId ? normalizePmOutageZone(pmPlans.find(p => p.id === editingPlanId)?.oz) : null;
        const hasDraftPoly = (tempZoneType === 'p' && tempPolyPts.length >= 3);
        let finalOz = null;
        if (tempPubEnabled || prevSavedOz || hasDraftPoly) {
            if (tempZoneType === 'c') {
                const center = tempCircleCenter || (parsedCoord ? [Number(parsedCoord.lat.toFixed(5)), Number(parsedCoord.lon.toFixed(5))] : null);
                if (center) finalOz = normalizePmOutageZone({ t: 'c', c: center, r: tempCircleRadius });
            } else if (tempZoneType === 'p' && tempPolyPts.length >= 3) {
                finalOz = normalizePmOutageZone({ t: 'p', p: tempPolyPts });
            }
        }

        if (tempPubEnabled && !finalOz) {
            safeToast(tempZoneType === 'p' ? '⚠️ กรุณาปักมุมหรือลากนิ้วตีกรอบบนแผนที่อย่างน้อย 3 มุม' : '⚠️ กรุณาแตะเลือกจุดศูนย์กลางวงเรดาร์บนแผนที่ก่อนบันทึก');
            return;
        }
        if (!parsedCoord && finalOz) {
            parsedCoord = getZoneSafeSamplePointPm(finalOz);
        }

        let linkedPinId = rawLinkedPinId || undefined;
        if (linkedPinId) {
            try {
                const sp = JSON.parse(rawGet('elec_labeled_places_list') || '[]').find(p => p?.id === linkedPinId);
                if (!parsedCoord || (sp && !isNaN(parseFloat(sp.lat)) && !isNaN(parseFloat(sp.lon)) && (Math.abs(parseFloat(sp.lat) - parsedCoord.lat) > 0.00015 || Math.abs(parseFloat(sp.lon) - parsedCoord.lon) > 0.00015))) linkedPinId = undefined;
            } catch (e) {}
        }

        const curUser = (rawGet('elec_app_current_user') || 'admin').trim(), myGroup = getActivePmGroup();
        const cleanNotify = isNaN(notifyDaysBefore) ? 3 : notifyDaysBefore, cleanRepeat = isNaN(repeatMonths) ? 0 : repeatMonths;
        const gpsLink = parsedCoord ? `https://www.google.com/maps?q=${parsedCoord.lat.toFixed(6)},${parsedCoord.lon.toFixed(6)}` : '';
        const finalPhotoIds = normalizePmPhotoIds(tempFormPhotoIds);
        const removedOldPhotos = originalEditingPhotoIds.filter(fid => !finalPhotoIds.includes(fid));
        const finalPub = Boolean(tempPubEnabled && finalOz);

        let savedRecord = null;
        if (editingPlanId) {
            const idx = pmPlans.findIndex(p => p.id === editingPlanId);
            if (idx !== -1) {
                const prev = pmPlans[idx];
                const alertChanged = (prev.date !== dateVal) || ((prev.alertMode || 'standard') !== alertMode) || (Number(prev.notifyDaysBefore ?? 3) !== cleanNotify) || (JSON.stringify(normalizeCustomTimesArray(prev.customAlertTimes || [])) !== JSON.stringify(customAlertTimes));
                const nextBaseline = alertChanged ? getMinuteFloorIso() : (prev.alertBaselineAt || prev.createdAt || getMinuteFloorIso());
                pmPlans[idx] = { ...prev, title, category, pinColor, photoIds: finalPhotoIds, oz: finalOz, pub: finalPub, pubNote, pubPlaces, date: dateVal, timeSlot, notifyDaysBefore: cleanNotify, repeatMonths: cleanRepeat, alertMode, customAlertTimes, alertBaselineAt: nextBaseline, linkedPinId, equipCode, feeder, note, lat: parsedCoord ? parsedCoord.lat : null, lon: parsedCoord ? parsedCoord.lon : null, gpsLink, ownerGroup: normPmGrp(prev.ownerGroup || myGroup) || myGroup, updatedBy: curUser, updatedAt: nextPmUpdatedIso(prev.updatedAt) };
                savedRecord = pmPlans[idx];
            }
        } else {
            const nowIso = nextPmUpdatedIso(safeGetLocMap()[PM_LOC_PREFIX + myGroup]?.updatedAt);
            savedRecord = { id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), title, category, pinColor, photoIds: finalPhotoIds, oz: finalOz, pub: finalPub, pubNote, pubPlaces, date: dateVal, timeSlot, notifyDaysBefore: cleanNotify, repeatMonths: cleanRepeat, alertMode, customAlertTimes, alertBaselineAt: getMinuteFloorIso(), createdAt: nowIso, linkedPinId, equipCode, feeder, note, lat: parsedCoord ? parsedCoord.lat : null, lon: parsedCoord ? parsedCoord.lon : null, gpsLink, status: 'pending', ownerGroup: myGroup, createdBy: curUser, updatedBy: curUser, updatedAt: nowIso };
            pmPlans.push(savedRecord);
        }
        if (savedRecord) preAckPastSlotsForPlanToday(savedRecord);
        const qTitle = document.getElementById('pmQuickTitleInput'); if (qTitle) qTitle.value = '';
        selectedDateIso = dateVal; const [y, m] = dateVal.split('-').map(Number); if (y && m) { viewYear = y; viewMonth = m - 1; }
        currentFilterStatus = 'day'; closePmPlanFormModal(true);
        await savePmPlansAndSync(true);
        renderZonesOnCalendarEmbeddedMap();
        if (removedOldPhotos.length > 0) trashUnusedPmPhotoIdsInBackground(removedOldPhotos);
        safeToast(finalPub ? '📡 บันทึกแผนงานและเปิดโซนเรดาร์แจ้งประชาชนเรียบร้อย!' : (parsedCoord ? '📍 บันทึกหมุดแผนงานและรูปภาพเรียบร้อย!' : '✅ บันทึกแผนงานเรียบร้อย!'));
    }

    function deletePmPlanById(planId, closeFormAfter = false) {
        if (!planId || !canManagePmSchedule()) return;
        loadPmPlansFromStorage();
        const target = pmPlans.find(p => p.id === planId && !p.pmDeleted); if (!target) return;
        safeConfirm(`ต้องการลบแผนงาน "${target.title}" ออกจากปฏิทินและแผนที่ใช่หรือไม่?`, async function () {
            const photosToClean = [...normalizePmPhotoIds(target), ...(closeFormAfter ? sessionModalUploadedIds : [])];
            const idx = pmPlans.findIndex(p => p.id === planId);
            if (idx !== -1) pmPlans[idx] = { id: pmPlans[idx].id, ownerGroup: normPmGrp(pmPlans[idx].ownerGroup || getActivePmGroup()) || getActivePmGroup(), pmDeleted: true, updatedAt: nextPmUpdatedIso(pmPlans[idx].updatedAt) };
            if (closeFormAfter) closePmPlanFormModal(true);
            await savePmPlansAndSync(true);
            renderZonesOnCalendarEmbeddedMap();
            if (photosToClean.length > 0) trashUnusedPmPhotoIdsInBackground(photosToClean);
            safeToast('🗑️ ลบหมุดแผนงานเรียบร้อยแล้ว');
        }, '🗑️ ยืนยันการลบแผนงาน');
    }
    function deletePmPlanFromModal() { if (editingPlanId) deletePmPlanById(editingPlanId, true); }
    function quickDeletePmPlanCard(planId) { deletePmPlanById(planId, false); }

    async function togglePmPlanCompleteStatus(planId) {
        if (!canCompletePmTask()) return;
        loadPmPlansFromStorage();
        const idx = pmPlans.findIndex(p => p.id === planId && !p.pmDeleted); if (idx === -1) return;
        const plan = pmPlans[idx], nextStatus = plan.status === 'done' ? 'pending' : 'done', nowIso = nextPmUpdatedIso(plan.updatedAt);
        plan.status = nextStatus; plan.completedAt = nextStatus === 'done' ? nowIso : undefined;
        plan.completedBy = nextStatus === 'done' ? safeFormatTechName(rawGet('elec_app_current_user') || 'ผู้ปฏิบัติงาน') : undefined;
        if (nextStatus === 'pending') { plan.alertBaselineAt = getMinuteFloorIso(); preAckPastSlotsForPlanToday(plan); }
        plan.updatedAt = nowIso;
        let spawnedNextDate = '';
        if (nextStatus === 'done' && Number(plan.repeatMonths) > 0 && !plan.spawnedNextCycle) {
            spawnedNextDate = addMonthsToIsoDate(plan.date, Number(plan.repeatMonths)); plan.spawnedNextCycle = true;
            const spawnedIso = nextPmUpdatedIso(nowIso);
            pmPlans.push({ ...plan, id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), pub: false, photoIds: normalizePmPhotoIds(plan), date: spawnedNextDate, status: 'pending', alertBaselineAt: getMinuteFloorIso(), createdAt: spawnedIso, completedAt: undefined, completedBy: undefined, spawnedNextCycle: undefined, updatedAt: spawnedIso });
        }
        scadaMapRef?.closePopup(); repairMapRef?.closePopup(); calendarMapInstance?.closePopup();
        await savePmPlansAndSync(true);
        renderZonesOnCalendarEmbeddedMap();
        safeToast(spawnedNextDate ? `✅ เสร็จสิ้น! และปักหมุดรอบถัดไป (${formatThaiDateShort(spawnedNextDate)}) อัตโนมัติแล้ว` : (nextStatus === 'done' ? '✅ บันทึกดำเนินงานเสร็จสิ้นแล้ว' : '↩️ เปิดหมุดแผนงานกลับมาใหม่แล้ว'));
    }

    // ========================================================================
    // 10. นำทาง GPS, ส่งรูปจริงเข้า LINE คู่คัดลอกข้อความ, Excel & นาฬิกาแจ้งเตือน
    // ========================================================================
    function navigatePmPlanGps(itemId) {
        const item = getAllVisibleCalendarItems().find(x => x.id === itemId); if (!item) return;
        const lat = parseFloat(item.lat), lon = parseFloat(item.lon), hasCoord = !isNaN(lat) && !isNaN(lon);
        if (isUserCurrentlyLoggedIn() && item.linkedPinId && typeof window.startLabeledPlaceNavigation === 'function') {
            let sameAsEquip = !hasCoord;
            if (hasCoord) {
                try {
                    const sp = JSON.parse(rawGet('elec_labeled_places_list') || '[]').find(p => p?.id === item.linkedPinId);
                    if (sp && !isNaN(parseFloat(sp.lat)) && !isNaN(parseFloat(sp.lon))) sameAsEquip = Math.abs(parseFloat(sp.lat) - lat) <= 0.00015 && Math.abs(parseFloat(sp.lon) - lon) <= 0.00015;
                } catch (e) {}
            }
            if (sameAsEquip) { closePmCalendarModal(); document.getElementById('pmAlertPopupModal')?.classList.add('hidden'); window.startLabeledPlaceNavigation(item.linkedPinId, true); return; }
        }
        if (!hasCoord) { safeToast('⚠️ หมุดแผนงานนี้ยังไม่ได้ระบุพิกัด GPS'); return; }
        if (isUserCurrentlyLoggedIn() && typeof window.recordEquipmentNavStart === 'function' && !safeIsViewer()) {
            const startCoord = window.lastKnownTechCoords;
            const route = (startCoord && typeof window.calculateInstantRouteFallback === 'function')
                ? window.calculateInstantRouteFallback(startCoord, { lat, lon })
                : { distanceKm: '2.0', durationMin: 5, isArrived: false };
            window.recordEquipmentNavStart({ id: item.id, name: `PM: ${item.title}`, note: item.note || '', ownerGroup: normPmGrp(item.ownerGroup || getActivePmGroup()), lat, lon }, route);
        }
        const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=driving`;
        const win = window.open(mapsUrl, '_blank');
        if (!win && !(Core && Core.isEmbeddedIframe)) window.location.href = mapsUrl;
    }

    function buildSinglePmPlanShareTexts(item) {
        const cat = getCategoryMeta(item.category), alCfg = getPlanEffectiveAlertConfig(item);
        const lines = [
            `📅 หมุดแผนงานบำรุงรักษา (${normPmGrp(item.ownerGroup || getActivePmGroup())})`,
            `${cat.icon} ประเภท : ${cat.name}`,
            `🏷️ เรื่อง : ${item.title}`,
            `🗓️ กำหนดการ : ${formatThaiDateFull(item.date)} (${item.timeSlot || '-'})`,
            `⏰ แจ้งเตือน : ${alCfg.badgeLabel}`
        ];
        if (item.equipCode) lines.push(`⚡ อุปกรณ์ : ${item.equipCode}${item.feeder ? ` (วงจร ${item.feeder})` : ''}`);
        if (item.note) lines.push(`📝 รายละเอียด : ${item.note}`);
        if (item.pubPlaces) lines.push(`🏘️ พื้นที่ไฟดับ : ${item.pubPlaces}`);
        if (!isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lon))) {
            lines.push(`📍 พิกัดหมุด : https://www.google.com/maps?q=${Number(item.lat).toFixed(6)},${Number(item.lon).toFixed(6)}`);
        }
        const baseText = lines.join('\n');
        const pIds = normalizePmPhotoIds(item);
        if (!pIds.length) return { baseText, textWithLinks: baseText };
        const linkLines = pIds.map((fid, i) => `🖼️ รูปที่ ${i + 1} : ${getPmPhotoDriveViewUrl(fid)}`);
        return { baseText, textWithLinks: `${baseText}\n${linkLines.join('\n')}` };
    }

    function closePmLineShareReadyModal() {
        pendingShareFilesPayload = null;
        document.getElementById('pmLineShareReadyModal')?.classList.add('hidden');
    }

    async function confirmPendingPmLineFileShare() {
        const payload = pendingShareFilesPayload;
        closePmLineShareReadyModal();
        if (!payload || !Array.isArray(payload.files) || !payload.files.length) return;
        copyPmTextSafe(payload.baseText);
        try {
            const shareData = navigator.canShare({ files: payload.files, text: payload.baseText })
                ? { files: payload.files, text: payload.baseText }
                : { files: payload.files };
            await navigator.share(shareData);
            safeToast('📋 ส่งรูปสำเร็จ! ข้อความอยู่ในคลิปบอร์ดแล้ว กดวางในห้อง LINE ได้เลยครับ');
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            copyPmTextSafe(payload.textWithLinks);
            window.open('https://line.me/R/share?text=' + encodeURIComponent(payload.textWithLinks), '_blank');
        }
    }

    function fallbackPendingPmLineTextOnly() {
        const payload = pendingShareFilesPayload;
        closePmLineShareReadyModal();
        if (!payload) return;
        copyPmTextSafe(payload.textWithLinks, '💬 คัดลอกแผนงานพร้อมลิงก์รูปแล้ว กำลังเปิด LINE...');
        window.open('https://line.me/R/share?text=' + encodeURIComponent(payload.textWithLinks), '_blank');
    }

    async function shareSinglePmPlanToLine(itemId) {
        const item = getAllVisibleCalendarItems().find(x => x.id === itemId); if (!item) return;
        const { baseText, textWithLinks } = buildSinglePmPlanShareTexts(item);
        const pIds = normalizePmPhotoIds(item);

        if (!pIds.length || !isMobileFileSharePreferred()) {
            copyPmTextSafe(textWithLinks, '💬 คัดลอกแผนงานและกำลังเปิดแอป LINE...');
            window.open('https://line.me/R/share?text=' + encodeURIComponent(textWithLinks), '_blank');
            return;
        }

        if (isSharingToLineBusy) return;
        isSharingToLineBusy = true;
        copyPmTextSafe(baseText);
        safeToast(`⏳ กำลังเตรียมรูปภาพ ${pIds.length} รูป ส่งเข้า LINE (คัดลอกข้อความให้แล้ว)...`);

        try {
            const files = await fetchPmPhotoFilesForShare(pIds);
            if (files.length > 0 && typeof navigator.canShare === 'function' && navigator.canShare({ files })) {
                const shareData = navigator.canShare({ files, text: baseText })
                    ? { files, text: baseText }
                    : { files };
                try {
                    await navigator.share(shareData);
                    safeToast('📋 คัดลอกข้อความไว้แล้ว! หลังส่งรูป กดวางข้อความในห้อง LINE ได้เลยครับ');
                    return;
                } catch (shareErr) {
                    if (shareErr && shareErr.name === 'AbortError') return;
                    injectPmModalsDOM();
                    pendingShareFilesPayload = { files, baseText, textWithLinks };
                    const descEl = document.getElementById('pmLineShareReadyDesc');
                    if (descEl) descEl.innerHTML = `เตรียมรูปภาพครบ <b>${files.length} รูป</b> และ<b>คัดลอกข้อความไว้แล้ว</b> แตะปุ่มสีเขียวเพื่อเลือกห้อง <b>LINE</b> ส่งรูป แล้วกดวางข้อความต่อได้เลยครับ`;
                    document.getElementById('pmLineShareReadyModal')?.classList.remove('hidden');
                    return;
                }
            }
            copyPmTextSafe(textWithLinks, '💬 คัดลอกแผนงานพร้อมลิงก์รูปแล้ว กำลังเปิด LINE...');
            window.open('https://line.me/R/share?text=' + encodeURIComponent(textWithLinks), '_blank');
        } finally {
            isSharingToLineBusy = false;
        }
    }

    async function shareDailyOrAlertSummaryToLine() {
        const alerts = getAlertCandidatesForToday(), list = alerts.length > 0 ? alerts : getAllVisibleCalendarItems().filter(i => i.date === selectedDateIso);
        if (!list.length) { safeToast('⚠️ ไม่มีรายการแผนงานสำหรับส่งสรุปเข้า LINE'); return; }
        if (list.length === 1 && normalizePmPhotoIds(list[0]).length > 0 && isMobileFileSharePreferred()) {
            return shareSinglePmPlanToLine(list[0].id);
        }
        const hdr = alerts.length > 0 ? `🔔 สรุปแจ้งเตือนแผนงานบำรุงรักษา (${getActivePmGroup()})\n📅 ณ ${formatThaiDateFull(getTodayIso())}` : `📅 แผนงานบำรุงรักษา (${getActivePmGroup()})\n🗓️ ${formatThaiDateFull(selectedDateIso)}`;
        const body = list.slice(0, 15).map((it, idx) => {
            const cat = getCategoryMeta(it.category), pIds = normalizePmPhotoIds(it);
            const dTag = it.daysLeft !== undefined ? (it.daysLeft < 0 ? `[เลย ${Math.abs(it.daysLeft)} วัน] ` : (it.daysLeft === 0 ? '[วันนี้] ' : `[อีก ${it.daysLeft} วัน] `)) : '';
            const gps = (!isNaN(parseFloat(it.lat)) && !isNaN(parseFloat(it.lon))) ? `\n   📍 https://www.google.com/maps?q=${Number(it.lat).toFixed(6)},${Number(it.lon).toFixed(6)}` : '';
            const pics = pIds.length > 0 ? `\n   🖼️ รูป (${pIds.length}): ${pIds.map(fid => getPmPhotoDriveViewUrl(fid)).join(' , ')}` : '';
            return `${idx + 1}. ${dTag}${cat.icon} ${it.title} (${formatThaiDateShort(it.date)})${gps}${pics}`;
        }).join('\n');
        const full = `${hdr}\n━━━━━━━━━━━━━━━━━━\n${body}`;
        copyPmTextSafe(full, '💬 คัดลอกสรุปแผนงานและกำลังเปิด LINE...');
        window.open('https://line.me/R/share?text=' + encodeURIComponent(full), '_blank');
    }

    async function exportPmPlansToExcel() {
        const items = getAllVisibleCalendarItems(); if (!items.length) { safeToast('⚠️ ยังไม่มีข้อมูลแผนงานสำหรับส่งออก'); return; }
        const myGrp = getActivePmGroup(), headers = ['ลำดับ', 'กลุ่มสังกัด', 'วันที่กำหนด', 'เวลาปฏิบัติงาน', 'ประเภทงาน', 'หัวข้อแผนงาน', 'เงื่อนไขเวลาเตือน', 'เตือนล่วงหน้า(วัน)', 'รหัสอุปกรณ์', 'วงจร', 'รายละเอียด', 'พื้นที่แจ้งไฟดับประชาชน', 'สถานะ', 'ผู้ทำเสร็จ', 'ลิงก์พิกัดหมุด', 'ลิงก์รูปภาพประกอบ'];
        const rows = items.map((it, i) => {
            const pIds = normalizePmPhotoIds(it);
            return [String(i + 1), normPmGrp(it.ownerGroup || myGrp), formatThaiDateShort(it.date), it.timeSlot || '-', getCategoryMeta(it.category).name, it.title || '-', getPlanEffectiveAlertConfig(it).badgeLabel, String(it.notifyDaysBefore ?? 3), it.equipCode || '-', it.feeder || '-', it.note || '-', it.pubPlaces || '-', it.status === 'done' ? 'เสร็จสิ้นแล้ว' : 'รอดำเนินการ', it.completedBy || '-', (!isNaN(parseFloat(it.lat)) && !isNaN(parseFloat(it.lon))) ? `https://www.google.com/maps?q=${Number(it.lat).toFixed(6)},${Number(it.lon).toFixed(6)}` : '-', pIds.length > 0 ? pIds.map(fid => getPmPhotoDriveViewUrl(fid)).join(' | ') : '-'];
        });
        const fn = `PM_Schedule_${myGrp.replace(/\s+/g, '_')}_${getTodayIso()}.xlsx`;
        if ((await loadPmXlsxSafe()) && typeof XLSX !== 'undefined') { const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet([headers, ...rows]); XLSX.utils.book_append_sheet(wb, ws, 'หมุดแผนงาน_PM'); XLSX.writeFile(wb, fn); safeToast(`📊 ส่งออกไฟล์ Excel (${items.length} แผนงาน) สำเร็จ!`); }
        else if (Core && typeof Core.downloadCsvFallback === 'function') Core.downloadCsvFallback(headers, rows, fn);
    }

    function updatePmSoundAndNotifButtonsUI() {
        const sndBtn = document.getElementById('pmSoundToggleBtn'); if (sndBtn) sndBtn.textContent = isPmSoundEnabled ? '🔔 เสียง: เปิด' : '🔕 เสียง: ปิด';
        const repBtn = document.getElementById('pmRepeatMinToggleBtn');
        if (repBtn) { repBtn.textContent = isPmRepeatEveryMin ? '🔁 เตือนซ้ำทุกนาที: เปิด' : '🔁 เตือนซ้ำทุกนาที: ปิด'; repBtn.className = isPmRepeatEveryMin ? 'bg-amber-400 hover:bg-amber-300 text-slate-950 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow transition' : 'bg-white/15 hover:bg-white/25 text-white/85 px-2.5 py-1 rounded-xl text-[11px] font-bold transition'; }
        const popRepBtn = document.getElementById('pmPopupRepeatMinToggleBtn');
        if (popRepBtn) { popRepBtn.textContent = isPmRepeatEveryMin ? '🔁 เตือนซ้ำ: เปิด' : '🔁 เตือนซ้ำ: ปิด'; popRepBtn.className = isPmRepeatEveryMin ? 'shrink-0 bg-rose-600 hover:bg-rose-700 text-white px-2.5 py-1 rounded-lg font-extrabold text-[10.5px] shadow-sm transition' : 'shrink-0 bg-slate-200 hover:bg-slate-300 text-slate-700 px-2.5 py-1 rounded-lg font-bold text-[10.5px] transition'; }
        const repHint = document.getElementById('pmAlertRepeatStatusHint');
        if (repHint) { repHint.textContent = isPmRepeatEveryMin ? '🔊 เตือนซ้ำทุก 1 นาที จนกว่าจะกดรับทราบ' : '🔔 โหมดเตือนครั้งเดียวต่อรอบเวลา (ปิดเตือนซ้ำ)'; repHint.className = isPmRepeatEveryMin ? 'font-extrabold text-rose-700' : 'font-semibold text-slate-600'; }
        const permBtn = document.getElementById('pmNotifPermBtn'); if (permBtn && 'Notification' in window) permBtn.textContent = Notification.permission === 'granted' ? '📲 แจ้งเตือน: เปิดแล้ว' : '📲 แจ้งเตือนเครื่อง';
    }
    function togglePmSoundSetting() { ensurePmAudioUnlocked(); isPmSoundEnabled = !isPmSoundEnabled; localStorage.setItem(PM_SOUND_KEY, String(isPmSoundEnabled)); updatePmSoundAndNotifButtonsUI(); if (isPmSoundEnabled) playPmAlertChime(false); safeToast(isPmSoundEnabled ? '🔔 เปิดเสียงเตือนแผนงานแล้ว' : '🔕 ปิดเสียงเตือนแผนงานแล้ว'); }
    function togglePmRepeatEveryMinSetting() {
        ensurePmAudioUnlocked(); isPmRepeatEveryMin = !isPmRepeatEveryMin; localStorage.setItem(PM_REPEAT_EVERY_MIN_KEY, String(isPmRepeatEveryMin));
        if (isPmRepeatEveryMin) { lastRepeatAlertMinuteKey = ''; if (!isPmSoundEnabled) { isPmSoundEnabled = true; localStorage.setItem(PM_SOUND_KEY, 'true'); } playPmAlertChime(false); }
        updatePmSoundAndNotifButtonsUI(); safeToast(isPmRepeatEveryMin ? '🔁 เปิดเสียงเตือนรัวซ้ำทุก 1 นาที (จนกว่าจะกดรับทราบ)' : '🔕 ปิดการเตือนซ้ำทุกนาทีแล้ว (เตือนเฉพาะเมื่อถึงเวลา)');
    }
    async function requestPmBrowserNotificationPermission() {
        ensurePmAudioUnlocked(); if (!('Notification' in window)) { safeToast('⚠️ เบราว์เซอร์นี้ไม่รองรับ System Notification'); return; }
        const perm = await Notification.requestPermission(); updatePmSoundAndNotifButtonsUI();
        if (perm === 'granted') { safeToast('✅ เปิดแจ้งเตือนมุมจอเรียบร้อย (ทำงานได้แม้อยู่หน้าล็อกอิน)!'); checkAndTriggerScheduledPmAlerts(true); }
    }

    let isClockTickRunning = false;
    let lastWakeTriggerMs = 0;
    async function checkExactScheduleClockTick() {
        if (isClockTickRunning) return;
        rememberActiveAuthForLoggedOutAlerts();
        if ((Core && Core.isEmbeddedIframe) || !hasRememberedPmSession()) return;
        const now = new Date(), hr = now.getHours(), min = now.getMinutes(), curMin = hr * 60 + min;
        const minKey = `${toLocalIsoDate(now)}_${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        if (minKey === lastCheckedAlertMinuteKey) return;
        isClockTickRunning = true; lastCheckedAlertMinuteKey = minKey;
        try {
            if (!isUserCurrentlyLoggedIn()) {
                const hasAlertNextMin = getAlertCandidatesForToday().some(it => getPlanEffectiveAlertConfig(it).allTimes.some(t => timeHHMMToMinutes(t) === (curMin + 1) % 1440));
                if (hasAlertNextMin || min % 5 === 0) await pullPmPlansWhileLoggedOut();
            } else { syncPmPlansFromLocationsMap(); if (min % 5 === 0) refreshPmAllViews(); }
            checkAndTriggerScheduledPmAlerts(false);
        } finally { isClockTickRunning = false; }
    }
    function triggerWakeScheduleCheck() {
        if (document.hidden) return;
        const nowMs = Date.now();
        if (nowMs - lastWakeTriggerMs < 1500) return;
        lastWakeTriggerMs = nowMs; lastCheckedAlertMinuteKey = ''; checkExactScheduleClockTick();
    }
    function _safeOpenPmCalendarModal(presetDateIso = null) {
        if (!isUserCurrentlyLoggedIn()) { safeToast('🔐 กรุณาเข้าสู่ระบบก่อนเปิดจัดการปฏิทินแผนงาน'); (document.getElementById('loginUsername') || document.getElementById('techUsername'))?.focus(); return; }
        return openPmCalendarModal(presetDateIso);
    }

        window.addEventListener('storage', e => {
        if (e.key === PM_REPEAT_EVERY_MIN_KEY) { isPmRepeatEveryMin = e.newValue !== 'false'; updatePmSoundAndNotifButtonsUI(); }
        else if (e.key === PM_SOUND_KEY) { isPmSoundEnabled = e.newValue !== 'false'; updatePmSoundAndNotifButtonsUI(); }
        else if (e.key && e.key.startsWith(PM_GROUP_AI_KEY_PREFIX)) { updateGroupAiKeyButtonsUI(); }
        else if (e.key === PM_ACK_LOG_KEY && !hasAnyUnackedActiveAlertNow()) { isPopupOpenedByForcePreview = false; document.getElementById('pmAlertPopupModal')?.classList.add('hidden'); }
    });
    bindLeafletMapHooks();
    if (Core && typeof Core.onRealtimeChange === 'function') {
        Core.onRealtimeChange(keys => {
            if (keys.some(k => k === 'elec_tech_locations_map' || k === PM_STORAGE_KEY)) syncPmPlansFromLocationsMap();
            if (keys.some(k => k === 'elec_labeled_places_list' || k === 'elec_deleted_labeled_places_map')) refreshPmAllViews();
        });
    }

        Object.assign(window, {
        openPmCalendarModal: _safeOpenPmCalendarModal, closePmCalendarModal, setPmDesktopModalWidth, changePmCalendarMonth, jumpPmCalendarToday,
        selectPmCalendarDate, setPmListStatusFilter, toggleShowScadaDueOnCalendar, togglePmTechStripCollapse,
        switchCalendarLeftViewMode, fitCalendarEmbeddedMapPins, toggleShowPmPinsOnMaps, cyclePmMapFilterMode,
        togglePmPinDropMode, startMovePmPlanPinOnMap, cancelPmMapInteractiveModes, focusPmPlanPinOnMap,
        togglePmQuickInlineBox, focusQuickInlineInputForDate, startPmQuickVoiceInput, expandQuickInputToFullModal,
        submitQuickInlinePmPlan, quickEditPmPlanTitle, syncQuickAlertTimeLabel, clearQuickAlertTimeInput,
        onPmAlertModeChange, addPmCustomTimeChip, removePmCustomTimeChip,
        selectPmFormPinColor, togglePmFormMiniMap, onPmCoordTextManualInput, onPmScadaEquipPick, fillPmCurrentMobileGps,
        openPmPlanFormModal, closePmPlanFormModal, savePmPlanFromModal, deletePmPlanFromModal, quickDeletePmPlanCard,
        togglePmPlanCompleteStatus, navigatePmPlanGps, shareSinglePmPlanToLine, shareDailyOrAlertSummaryToLine,
        exportPmPlansToExcel, togglePmSoundSetting, togglePmRepeatEveryMinSetting, requestPmBrowserNotificationPermission, acknowledgeCurrentPmAlertRound,
        triggerPmPhotoInput, handlePmModalPhotoSelect, removePmModalPhotoAt, handlePmQuickPhotoSelect, removePmQuickPhotoAt,
        openPmPhotoLightbox, openPmRawPhotoLightbox, closePmPhotoLightbox, stepPmPhotoLightbox, shareFromPmPhotoLightbox,
        confirmPendingPmLineFileShare, fallbackPendingPmLineTextOnly, closePmLineShareReadyModal,
        onTogglePmPublicOutage, setPmZoneDrawSubMode, onPmCircleRadiusInput,
        undoLastPmZonePolyPoint, clearPmZonePolygon, togglePmMiniMapFullscreen,
        openPublicOutageMapPage, copyPublicOutageMapLink,
        extractPlacesInCurrentOutageZone, addManualTempPubPlace, removeTempPubPlaceAt,
        clearAllTempPubPlaces, onPubPlacesTextareaInput, startPmZonePlaceVoiceInput,
        openPmPublicAnnounceModal, closePmPublicAnnounceModal, switchPmAnnounceStyle,
        copyPmPublicAnnounceText, sharePmPublicAnnounceToLine,
        openPmAiKeyModal, closePmAiKeyModal, savePmGroupAiKeyFromModal,
        clearPmGroupAiKeyFromModal, skipAiAndExtractBasicZonePlaces
    });

    function ensureSwitchTechTabWrapped() {
        if (typeof window.switchTechMainTab === 'function' && !window.switchTechMainTab.__pmWrapped) {
            const origSwitch = window.switchTechMainTab;
            const wrapped = function (...args) {
                const res = origSwitch.apply(this, args);
                setTimeout(() => { injectPmButtonsIntoScadaToolbar(); renderAllExternalPmMapLayers(); }, 180);
                return res;
            };
            wrapped.__pmWrapped = true;
            window.switchTechMainTab = wrapped;
        }
    }

    function bootstrapPmCalendarModule() {
        rememberActiveAuthForLoggedOutAlerts(); bindLeafletMapHooks(); injectPmCalendarStyles(); injectPmModalsDOM(); ensurePmOutageZoneUiInjected(); injectQuickAddBoxIntoCalendar();
        loadPmPlansFromStorage(); syncPmPlansFromLocationsMap(); updatePmSoundAndNotifButtonsUI(); updateGroupAiKeyButtonsUI();
        if (isUserCurrentlyLoggedIn()) refreshPmAllViews();
        ensureSwitchTechTabWrapped();
        if (window.PeaIdbStore?.ready) {
            window.PeaIdbStore.ready.then(() => {
                loadPmPlansFromStorage(); syncPmPlansFromLocationsMap();
                if (isUserCurrentlyLoggedIn()) refreshPmAllViews();
            }).catch(() => {});
        }
        let lastKnownLoginState = isUserCurrentlyLoggedIn();
        let lastKnownGroupName = getActivePmGroup();
        setInterval(() => {
            ensureSwitchTechTabWrapped();
            const nowLogged = isUserCurrentlyLoggedIn();
            const nowGrp = getActivePmGroup();
            if (nowGrp !== lastKnownGroupName) {
                lastKnownGroupName = nowGrp;
                updateGroupAiKeyButtonsUI();
            }
            if (nowLogged !== lastKnownLoginState) {
                lastKnownLoginState = nowLogged;
                updateGroupAiKeyButtonsUI();
                if (nowLogged) { rememberActiveAuthForLoggedOutAlerts(); syncPmPlansFromLocationsMap(); refreshPmAllViews(); }
                else { closePmPlanFormModal(); closePmCalendarModal(); closePmPhotoLightbox(); closePmLineShareReadyModal(); closePmPublicAnnounceModal(); closePmAiKeyModal(); document.getElementById('pmFallbackPromptModal')?.classList.add('hidden'); const alBtn = document.getElementById('pmAlertModalCalOrLoginBtn'); if (alBtn) alBtn.textContent = '🔐 ล็อกอินเพื่อจัดการ'; updatePmHeaderBadgesAndStrip(); }
            }
        }, 1200);
        setTimeout(async () => { ensureSwitchTechTabWrapped(); rememberActiveAuthForLoggedOutAlerts(); if (!isUserCurrentlyLoggedIn()) await pullPmPlansWhileLoggedOut(); else syncPmPlansFromLocationsMap(); if (isUserCurrentlyLoggedIn()) refreshPmAllViews(); checkAndTriggerScheduledPmAlerts(false); }, 1400);
        setInterval(checkExactScheduleClockTick, 15000);
        setInterval(() => { rememberActiveAuthForLoggedOutAlerts(); if (!document.hidden && isUserCurrentlyLoggedIn()) { syncPmPlansFromLocationsMap(); updatePmHeaderBadgesAndStrip(); } }, 10000);
        document.addEventListener('visibilitychange', triggerWakeScheduleCheck);
        window.addEventListener('focus', triggerWakeScheduleCheck);
    }
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', bootstrapPmCalendarModule);
    else bootstrapPmCalendarModule();
})();
// ==================== จบไฟล์ pm-calendar.js (v7.7) ====================