// ============================================================================
// 📅⏰ PEA SMART GRID — MAINTENANCE SCHEDULE & CUSTOM ALERT ENGINE v7.3 (pm-calendar.js)
// ระบบปฏิทินแผนงานบำรุงรักษา + หมุดแผนงาน + ตั้งเวลาเตือนแยกแต่ละงาน + เตือนซ้ำทุกนาทีจนกว่าจะรับทราบ
// พาทที่ 1 / 6 : Config, Safe Cross-Page Wrappers, Baseline Helpers & Quota-Safe Shard Builder
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
    const MAX_TOMBSTONE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const MAX_DONE_CLOUD_AGE_MS = 60 * 24 * 60 * 60 * 1000;
    const MAX_CLOUD_SYNC_ITEMS = 60;
    const MAX_SHARD_JSON_CHARS = 18000;

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
    // 1. Safe Cross-Page Wrappers (ทำงานได้ทั้ง index.html และ page2.html โดยไม่เกิด ReferenceError)
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
    // ===== จบพาทที่ 1 / 6 ของไฟล์ pm-calendar.js =====
    // ===== เริ่มพาทที่ 2 / 6 ของไฟล์ pm-calendar.js (วางทับพาทที่ 2 / 6 เดิม) =====
    // ========================================================================
    // 2. จัดการคลังแผนงาน & บีบอัด Shard (กันนาฬิกาเพี้ยน + ล็อกโหมดเตือน + กันตกหล่นเกิน 60 งาน)
    // ========================================================================
    const MAX_RECENT_TRANSITION_QUOTA = 15;
    const RECENT_TRANSITION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

    function slimPlanForCloud(p, grp) {
        if (!p || !p.id) return null;
        if (p.pmDeleted) return { id: p.id, ownerGroup: grp, pmDeleted: true, updatedAt: p.updatedAt };
        const out = {
            id: p.id, title: p.title || '', category: p.category || 'scada',
            date: p.date || '', status: p.status || 'pending',
            ownerGroup: grp, updatedAt: p.updatedAt
        };
        if (p.pinColor && p.pinColor !== 'auto') out.pinColor = p.pinColor;
        if (p.timeSlot && p.timeSlot !== '09.00-12.00') out.timeSlot = p.timeSlot;
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
        return {
            ...raw,
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

        const recentTransitions = valid
            .filter(([, p]) => (p.pmDeleted || p.status === 'done') && (now - (new Date(p.updatedAt || 0).getTime() || 0)) <= RECENT_TRANSITION_AGE_MS)
            .sort((a, b) => (new Date(b[1].updatedAt || 0).getTime() || 0) - (new Date(a[1].updatedAt || 0).getTime() || 0))
            .slice(0, MAX_RECENT_TRANSITION_QUOTA);
        const reservedIds = new Set(recentTransitions.map(([id]) => id));

        const restSorted = valid
            .filter(([id]) => !reservedIds.has(id))
            .sort((a, b) => {
                const pa = a[1], pb = b[1];
                const rank = x => (!x.pmDeleted && x.status !== 'done') ? 0 : (x.pmDeleted ? 1 : 2);
                const rDiff = rank(pa) - rank(pb);
                if (rDiff !== 0) return rDiff;
                if (!pa.pmDeleted && pa.status !== 'done') {
                    return Math.abs(calcDaysUntil(pa.date)) - Math.abs(calcDaysUntil(pb.date));
                }
                return (new Date(pb.updatedAt || 0).getTime() || 0) - (new Date(pa.updatedAt || 0).getTime() || 0);
            });

        const byPriority = [...recentTransitions, ...restSorted].slice(0, MAX_CLOUD_SYNC_ITEMS);
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
        if (isUserCurrentlyLoggedIn() || !hasRememberedPmSession() || (Core && Core.isEmbeddedIframe) || !navigator.onLine) return false;
        const baseApiUrl = (rawGet(PM_LAST_API_URL_KEY) || (typeof window.getActiveCloudApiUrl === 'function' ? window.getActiveCloudApiUrl() : '')).trim();
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
    // ===== จบพาทที่ 2 / 6 ของไฟล์ pm-calendar.js =====
    // ===== เริ่มพาทที่ 3 / 6 ของไฟล์ pm-calendar.js (วางทับพาทที่ 3 / 6 เดิม) =====
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

        if (isGas && init && init.method === 'POST' && typeof init.body === 'string') {
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
                        init = { ...init, body: JSON.stringify(bodyObj) };
                        didAttachPmWrite = true;
                        attachedSyncSeq = pendingPmSyncSeq;
                    } else if (bodyObj.action === 'patchDelta' && (bodyObj.techLocDelta || hasPendingPmCloudSync)) {
                        if (!bodyObj.techLocDelta) {
                            bodyObj.techLocDelta = { id: 'TECH_LOC_REGISTRY', jobType: 'tech_loc', techLocations: safeGetLocMap(), updatedAt: new Date().toISOString() };
                        }
                        bodyObj.techLocDelta.techLocations = writePmShardsIntoLocMap(bodyObj.techLocDelta.techLocations || safeGetLocMap());
                        init = { ...init, body: JSON.stringify(bodyObj) };
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
                        if (rj && (rj.status === 'error' || rj.result === 'error' || rj.ok === false)) gasWriteOk = false;
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
                window.syncJobsWithFieldPage(true);
            }
            if (fallbackCloudTimer) clearTimeout(fallbackCloudTimer);
            const runFallbackCheck = (attempt = 0) => {
                if (ackedPmSyncSeq >= targetSeq || !hasPendingPmCloudSync || !navigator.onLine) return;
                if (inFlightGasCount > 0 && attempt < 3) {
                    fallbackCloudTimer = setTimeout(() => runFallbackCheck(attempt + 1), 2500);
                    return;
                }
                const apiUrl = (typeof window.getActiveCloudApiUrl === 'function' ? window.getActiveCloudApiUrl() : rawGet(PM_LAST_API_URL_KEY) || '').trim();
                if (apiUrl && apiUrl.includes('script.google.com')) {
                    loadPmPlansFromStorage();
                    const freshLocMap = writePmShardsIntoLocMap(safeGetLocMap());
                    fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                        body: JSON.stringify({
                            action: 'patchDelta',
                            group: getActivePmGroup(),
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
                    id: 'scada_due_' + p.id, isScadaPinDue: true, linkedPinId: p.id,
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
    // ===== จบพาทที่ 3 / 6 ของไฟล์ pm-calendar.js =====
    // ===== เริ่มพาทที่ 4 / 6 ของไฟล์ pm-calendar.js (วางทับพาทที่ 4 / 6 เดิม) =====
    // ========================================================================
    // 4. สไตล์ชีต, แถบเครื่องมือผัง SCADA & แบนเนอร์แจ้งเตือนหน้าช่าง
    // ========================================================================
    let isQuickInlineBoxVisible = false;
    let desktopModalWidthMode = '65vw';

    function injectPmCalendarStyles() {
        if (document.getElementById('peaPmCalendarStyles')) return;
        const st = document.createElement('style');
        st.id = 'peaPmCalendarStyles';
        st.textContent = `
            #toast { z-index: 1500 !important; }
            #customAlertModal, #customConfirmModal, #customPromptModal { z-index: 1460 !important; }
            .pm-day-cell { min-height: 60px; transition: all 0.15s ease; }
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
            .pm-plan-pin-pulse { position: absolute; top: -3px; left: -1px; width: 36px; height: 36px; border-radius: 9999px; animation: pmPinRingWave 1.7s infinite ease-out; pointer-events: none; z-index: 1; }
            @keyframes pmPinRingWave { 0% { transform: scale(0.8); opacity: 0.9; } 100% { transform: scale(1.65); opacity: 0; } }
            .pm-plan-pin-moving .pm-plan-pin-head { box-shadow: 0 0 0 4px #22d3ee, 0 6px 14px rgba(0,0,0,0.5) !important; }
            .pm-plan-tooltip { background: rgba(15,23,42,0.93) !important; color: #f8fafc !important; border: 1.5px solid #818cf8 !important; border-radius: 0.5rem !important; padding: 2px 7px !important; font-family: 'Prompt',sans-serif !important; font-size: 10.5px !important; font-weight: 700 !important; }
            .pm-pin-drop-active-map { cursor: crosshair !important; }
            #labeledInteractiveMap.pm-pin-drop-active-map .leaflet-scadaUnifiedLinesPane-pane,
            #labeledInteractiveMap.pm-pin-drop-active-map .leaflet-scadaUnifiedLinesPane-pane *,
            #labeledInteractiveMap.pm-pin-drop-active-map .leaflet-overlay-pane svg,
            #labeledInteractiveMap.pm-pin-drop-active-map .leaflet-overlay-pane canvas,
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
            jobCardsEl.parentElement.insertBefore(wrap, document.getElementById('repairJobsMapSection') || jobCardsEl);
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
        const rowsHtml = isTechStripCollapsed ? '' : `<div class="p-2.5 space-y-1.5 bg-white max-h-48 overflow-y-auto">${candidates.slice(0, 6).map(item => {
            const cat = getCategoryMeta(item.category), alCfg = getPlanEffectiveAlertConfig(item), safeId = String(item.id).replace(/'/g, "\\'"), hasCoord = !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lon));
            const badge = item.daysLeft < 0 ? `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-extrabold px-1.5 py-0.5 rounded">เลย ${Math.abs(item.daysLeft)} วัน</span>` : (item.daysLeft === 0 ? `<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-1.5 py-0.5 rounded">📌 วันนี้</span>` : `<span class="bg-sky-50 text-sky-700 border border-sky-200 text-[10px] font-bold px-1.5 py-0.5 rounded">อีก ${item.daysLeft} วัน</span>`);
            return `<div class="p-2 rounded-xl border border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2 text-xs"><div class="min-w-0 flex-1"><div class="flex items-center gap-1.5 flex-wrap">${badge}<span class="font-bold text-slate-800 truncate">${cat.icon} ${safeEscHtml(item.title)}</span><span class="text-[10px] text-indigo-700 font-semibold">${safeEscHtml(alCfg.badgeLabel)}</span></div>${item.equipCode ? `<div class="text-[10px] text-teal-700 font-semibold mt-0.5">⚡ ${safeEscHtml(item.equipCode)}</div>` : ''}</div><div class="flex items-center gap-1 shrink-0">${hasCoord ? `<button type="button" onclick="focusPmPlanPinOnMap('${safeId}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-1 rounded-lg text-[10px] font-bold">📍 ดูหมุด</button><button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">🗺️ นำทาง</button>` : ''}${(!item.isScadaPinDue && allowDone) ? `<button type="button" onclick="togglePmPlanCompleteStatus('${safeId}')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-1 rounded-lg text-[10px] font-bold">✅ เสร็จ</button>` : ''}</div></div>`;
        }).join('')}</div>`;
        const nextBannerHtml = `<div class="rounded-2xl border-2 border-indigo-400/80 overflow-hidden shadow-sm bg-white"><div class="bg-gradient-to-r from-indigo-900 via-blue-900 to-teal-800 px-3 py-2 text-white flex items-center justify-between gap-2"><div onclick="openPmCalendarModal()" class="cursor-pointer flex items-center gap-1.5 min-w-0 flex-1"><span>📅</span><span class="text-xs font-extrabold truncate">หมุดแผนบำรุงรักษา (PM): แจ้งเตือน ${candidates.length} รายการ</span></div><div class="flex items-center gap-1 shrink-0"><button type="button" onclick="openPmCalendarModal()" class="bg-white/20 hover:bg-white/30 text-white px-2 py-0.5 rounded-lg text-[10px] font-bold">ปฏิทิน/แมพ</button><button type="button" onclick="togglePmTechStripCollapse()" class="bg-white/15 hover:bg-white/25 text-white px-2 py-0.5 rounded-lg text-[10px] font-bold">${isTechStripCollapsed ? '🔽 ขยาย' : '🔼 ย่อ'}</button></div></div>${rowsHtml}</div>`;
        if (nextBannerHtml !== lastRenderedTechStripSig || stripWrap.innerHTML === '') { stripWrap.innerHTML = nextBannerHtml; lastRenderedTechStripSig = nextBannerHtml; }
    }

    // ========================================================================
    // 5. เอนจินวาด "หมุดแผนงาน" บนแผนที่ (จับแมพเดิมอัตโนมัติ + ซ่อนป๊อปอัปก่อนโฟกัสแมพทุกหน้า)
    // ========================================================================
    function buildPmPlanMarkerIcon(item, isMovingThis = false) {
        const vis = getPlanPinVisualTheme(item), daysLeft = calcDaysUntil(item.date, getTodayIso()), isUrgent = item.status !== 'done' && daysLeft <= 0;
        const pulseHtml = isUrgent ? `<div class="pm-plan-pin-pulse" style="background:${daysLeft < 0 ? 'rgba(225,29,72,0.58)' : 'rgba(245,158,11,0.58)'};"></div>` : '';
        return L.divIcon({ className: isMovingThis ? 'pm-plan-pin-moving' : '', html: `<div class="pm-plan-pin-wrap" style="${item.status === 'done' ? 'opacity:0.55;filter:grayscale(0.5);' : ''}">${pulseHtml}<div class="pm-plan-pin-date">${safeEscHtml(formatThaiDayMonthShort(item.date))}</div><div class="pm-plan-pin-head" style="background:${vis.grad};"><span>${vis.icon}</span></div></div>`, iconSize: [34, 40], iconAnchor: [17, 34], popupAnchor: [0, -32] });
    }

    function buildPmPlanPopupHtml(item) {
        const vis = getPlanPinVisualTheme(item), alCfg = getPlanEffectiveAlertConfig(item), daysLeft = calcDaysUntil(item.date, getTodayIso()), isDone = item.status === 'done', safeId = String(item.id).replace(/'/g, "\\'");
        const statusTag = isDone ? '<span class="bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">✅ เสร็จสิ้นแล้ว</span>' : (daysLeft < 0 ? `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">🚨 เลยกำหนด ${Math.abs(daysLeft)} วัน</span>` : (daysLeft === 0 ? '<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">📌 กำหนดวันนี้</span>' : `<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-2 py-0.5 rounded-full">🗓️ อีก ${daysLeft} วัน</span>`));
        const allowEdit = !item.isScadaPinDue && canManagePmSchedule(), allowDone = !item.isScadaPinDue && canCompletePmTask();
        return `<div style="font-family:'Prompt',sans-serif;min-width:245px;" class="space-y-1.5 text-xs"><div class="flex items-center justify-between gap-1"><span class="px-2 py-0.5 rounded text-white text-[10px] font-extrabold" style="background:${vis.hex}">${vis.icon} หมุดแผนงาน PM</span>${statusTag}</div><div class="font-extrabold text-slate-900 text-sm break-words pt-0.5">${safeEscHtml(item.title)}</div><div class="text-[11px] text-slate-600 space-y-0.5"><div>📅 <b>วันที่:</b> ${formatThaiDateFull(item.date)} (${safeEscHtml(item.timeSlot || '-')})</div><div>⏰ <b>เวลาเตือน:</b> <span class="text-indigo-700 font-bold">${safeEscHtml(alCfg.badgeLabel)}</span></div>${item.equipCode ? `<div>⚡ <b>อุปกรณ์:</b> ${safeEscHtml(item.equipCode)} ${item.feeder ? `(วงจร ${safeEscHtml(item.feeder)})` : ''}</div>` : ''}${item.note ? `<div>📝 <b>รายละเอียด:</b> ${safeEscHtml(item.note)}</div>` : ''}</div><div class="pt-1.5 border-t border-slate-200 grid grid-cols-2 gap-1"><button type="button" onclick="navigatePmPlanGps('${safeId}')" style="background:#2563eb;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;">🗺️ นำทาง Maps</button><button type="button" onclick="shareSinglePmPlanToLine('${safeId}')" style="background:#00B900;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;">💬 แชร์ LINE</button>${allowDone ? `<button type="button" onclick="togglePmPlanCompleteStatus('${safeId}')" class="col-span-2" style="background:${isDone ? '#64748b' : '#059669'};color:#fff;padding:5px 8px;border-radius:8px;font-weight:800;font-size:11px;">${isDone ? '↩️ คืนสถานะรอดำเนินการ' : '✅ บันทึกดำเนินงานเสร็จสิ้น'}</button>` : ''}${allowEdit ? `<button type="button" onclick="openPmPlanFormModal('${safeId}')" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;padding:4px 8px;border-radius:8px;font-weight:700;font-size:10.5px;">✏️ แก้ไข/ตั้งเวลา</button><button type="button" onclick="startMovePmPlanPinOnMap('${safeId}')" style="background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;padding:4px 8px;border-radius:8px;font-weight:700;font-size:10.5px;">📍 ย้ายจุดหมุด</button>` : ''}</div></div>`;
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
            const tipHtml = `${vis.icon} ${safeEscHtml(item.title)} (${formatThaiDayMonthShort(item.date)})`, popupHtml = buildPmPlanPopupHtml(item);
            const iconSig = `${item.status}|${item.date}|${vis.grad}|${vis.icon}|${calcDaysUntil(item.date, todayIso)}|${isMoving ? 1 : 0}`;
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
        if (calendarMapInstance && calendarPmLayer) renderPmPinsOnTargetMap(calendarMapInstance, calendarPmLayer, calendarPmMarkersById, false);
    }
    function toggleShowPmPinsOnMaps() { showPmPinsOnMaps = !showPmPinsOnMaps; localStorage.setItem(PM_SHOW_MAP_PINS_KEY, String(showPmPinsOnMaps)); renderAllExternalPmMapLayers(); safeToast(showPmPinsOnMaps ? '📅 แสดงหมุดแผนงานบนแผนที่แล้ว' : '🚫 ซ่อนหมุดแผนงานชั่วคราว'); }
    function cyclePmMapFilterMode() { pmMapFilterMode = pmMapFilterMode === 'pending' ? 'alert' : 'pending'; localStorage.setItem(PM_MAP_FILTER_MODE_KEY, pmMapFilterMode); renderAllExternalPmMapLayers(); }

    function updatePinDropBannerOnMaps() {
        document.querySelectorAll('.pm-pin-drop-banner').forEach(el => el.remove());
        const isMove = Boolean(pmPinMoveTargetId), isAny = pmPinDropModeActive || isMove;
        ['labeledInteractiveMap', 'pmCalendarEmbeddedMap'].forEach(id => document.getElementById(id)?.classList.toggle('pm-pin-drop-active-map', isAny));
        document.getElementById('repairJobsLeafletMap')?.classList.toggle('pm-pin-drop-active-map', isMove);
        updateScadaToolbarPmButtonsUI();
        const calDropBtn = document.getElementById('btnCalMapDropPin');
        if (calDropBtn) { calDropBtn.textContent = pmPinDropModeActive ? '❌ ยกเลิกปักหมุด' : '📍 จิ้มปักหมุดแผนใหม่'; calDropBtn.className = pmPinDropModeActive ? 'pointer-events-auto bg-amber-400 text-slate-950 border border-white px-3 py-1.5 rounded-xl text-[11px] font-extrabold shadow-lg animate-pulse' : 'pm-edit-only pointer-events-auto bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-xl text-[11px] font-extrabold shadow-lg'; }
        if (!isAny) return;
        const msg = isMove ? '📍 โหมดย้ายหมุดแผนงาน: ลากหมุด หรือแตะจุดใหม่บนแผนที่เพื่อวาง' : '📍 โหมดปักหมุดแผนงาน: แตะจุดที่ต้องการบนแผนที่เพื่อสร้างแผนงานใหม่';
        const targetMapIds = isMove ? ['labeledInteractiveMap', 'repairJobsLeafletMap', 'pmCalendarEmbeddedMap'] : ['labeledInteractiveMap', 'pmCalendarEmbeddedMap'];
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
        pmPlans[idx].lat = Number(Number(newLat).toFixed(6)); pmPlans[idx].lon = Number(Number(newLon).toFixed(6));
        pmPlans[idx].gpsLink = `https://www.google.com/maps?q=${pmPlans[idx].lat.toFixed(6)},${pmPlans[idx].lon.toFixed(6)}`;
        delete pmPlans[idx].linkedPinId;
        pmPlans[idx].updatedBy = (rawGet('elec_app_current_user') || 'admin').trim();
        pmPlans[idx].updatedAt = nextPmUpdatedIso(pmPlans[idx].updatedAt);
        pmPinMoveTargetId = null; updatePinDropBannerOnMaps();
        await savePmPlansAndSync(true); safeToast(`📍 ย้ายตำแหน่งหมุด "${pmPlans[idx].title}" เรียบร้อยแล้ว`);
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
        if (containerId !== 'labeledInteractiveMap' && containerId !== 'repairJobsLeafletMap') return;
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
        if (typeof L === 'undefined' || !L.Map || (scadaMapRef && repairMapRef)) return;
        let needResize = false;
        [['labeledInteractiveMap', scadaMapRef], ['repairJobsLeafletMap', repairMapRef]].forEach(([id, ref]) => {
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
                        if (!this.__pmHookBound) { const cid = this._container?.id || ''; if (cid === 'labeledInteractiveMap' || cid === 'repairJobsLeafletMap') setTimeout(() => bindSingleLeafletMapEvents(this), 0); }
                        return orig.apply(this, args);
                    };
                    wrapped.__pmWrapped = true; L.Map.prototype[fnName] = wrapped;
                }
            });
        }
        discoverExistingLeafletMaps();
    }
    // ===== จบพาทที่ 4 / 6 ของไฟล์ pm-calendar.js =====
    // ===== เริ่มพาทที่ 5 / 6 ของไฟล์ pm-calendar.js (วางทับพาทที่ 5 / 6 เดิม) =====
    // ========================================================================
    // 6. สร้าง DOM หน้าต่างปฏิทิน (65% บนคอม) & ปุ่มสลับเตือนรัวซ้ำทุกนาที
    // ========================================================================
    function injectPmModalsDOM() {
        if (document.getElementById('pmCalendarModal')) return;
        const catOptions = Object.values(PM_CATEGORIES).map(c => `<option value="${c.key}">${c.icon} ${c.name}</option>`).join('');
        const pinColorBtns = Object.values(PM_PIN_COLORS).map(c => `<button type="button" id="pmFormColorBtn-${c.key}" onclick="selectPmFormPinColor('${c.key}')" class="px-2 py-1 rounded-lg border text-[10px] font-bold transition">${c.label}</button>`).join('');
        const presetTimesBtns = ['06:30', '08:00', '08:30', '12:00', '13:00', '16:30'].map(t => `<button type="button" onclick="addPmCustomTimeChip('${t}')" class="px-2 py-0.5 rounded-md bg-white hover:bg-indigo-100 border border-indigo-200 text-[10px] font-bold text-indigo-700">+${t}</button>`).join('');
        document.body.insertAdjacentHTML('beforeend', `
            <div id="pmCalendarModal" class="fixed inset-0 bg-slate-950/70 hidden z-[1320] flex items-center justify-center p-2 sm:p-4 backdrop-blur-sm"><div class="pm-calendar-dialog bg-white rounded-2xl shadow-2xl w-full max-h-[94dvh] overflow-hidden flex flex-col border border-slate-200" style="--pm-desktop-w: 65vw;">
                <div class="px-4 py-3 bg-gradient-to-r from-indigo-900 via-blue-800 to-teal-700 text-white flex flex-wrap justify-between items-center gap-2 shrink-0">
                    <div class="flex items-center gap-2"><span class="text-lg">📅</span><div><h3 class="font-bold text-sm sm:text-base flex items-center gap-2"><span>ปฏิทิน &amp; หมุดแผนงานบำรุงรักษา (PM)</span><span id="pmHeaderGroupBadge" class="bg-white/20 text-amber-200 text-[10px] font-extrabold px-2 py-0.5 rounded-md">-</span></h3><p class="text-[10px] text-blue-100">ตั้งเวลาเตือนรายแผนงานอิสระ + รอบ 00.00 / 07.00 น. (ทำงานแม้อยู่หน้าล็อกอิน)</p></div></div>
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
                    <div class="space-y-1.5"><div class="flex flex-wrap items-center justify-between gap-1"><label class="font-bold text-slate-700">📍 พิกัดหมุดแผนงาน</label><div class="flex gap-1"><button type="button" onclick="togglePmFormMiniMap()" class="text-[10px] bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-lg font-bold">🗺️ จิ้มเลือกบนแมพ</button><button type="button" onclick="fillPmCurrentMobileGps()" class="text-[10px] bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-lg font-bold">📍 พิกัดฉัน</button></div></div><input type="text" id="pmCoordInput" oninput="onPmCoordTextManualInput(this.value)" placeholder="วางพิกัด เช่น 13.1361, 101.0322 หรือลิงก์ Google Maps" class="w-full px-3 py-2 bg-white font-mono"><div id="pmFormMiniMapWrap" class="hidden rounded-xl overflow-hidden border-2 border-indigo-300"><div class="bg-indigo-900 text-white text-[10px] font-bold px-2.5 py-1 flex justify-between"><span>👆 แตะบนแผนที่หรือลากหมุดเพื่อเลือกจุดปฏิบัติงาน</span><button type="button" onclick="togglePmFormMiniMap(false)">✕ ซ่อนแมพ</button></div><div id="pmFormMiniLeafletMap" class="w-full h-44 bg-slate-100"></div></div></div>
                    <div><label class="block font-bold text-slate-700 mb-1">👷 ผู้รับผิดชอบ / รายละเอียดงาน</label><textarea id="pmNoteInput" rows="2" placeholder="ระบุผู้รับผิดชอบ หรือสิ่งที่ต้องเตรียม..." class="w-full px-3 py-2 bg-white"></textarea></div>
                </div>
                <div class="p-3 bg-slate-50 border-t flex items-center justify-between gap-2"><button type="button" id="pmDeleteBtnInModal" onclick="deletePmPlanFromModal()" class="hidden px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs">🗑️ ลบหมุดแผน</button><div class="flex gap-2 ml-auto"><button type="button" onclick="closePmPlanFormModal()" class="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl text-xs">ยกเลิก</button><button type="button" id="pmSaveSubmitBtn" onclick="savePmPlanFromModal()" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold rounded-xl text-xs shadow">💾 บันทึกหมุดแผนงาน</button></div></div>
            </div></div>
            <div id="pmAlertPopupModal" class="fixed inset-0 bg-slate-950/75 hidden z-[1420] flex items-center justify-center p-3 backdrop-blur-sm"><div class="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border-2 border-amber-400 flex flex-col max-h-[88dvh]">
                <div class="px-4 py-3.5 bg-gradient-to-r from-amber-500 via-orange-500 to-rose-600 text-white flex justify-between items-center"><h3 id="pmAlertPopupTitle" class="font-extrabold text-sm">🔔 แจ้งเตือนหมุดแผนงานบำรุงรักษา</h3><button type="button" id="pmAlertPopupCloseX" onclick="document.getElementById('pmAlertPopupModal').classList.add('hidden')" class="text-white/85 hover:text-white text-xl font-bold leading-none">&times;</button></div>
                <div class="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center justify-between gap-2 text-[11px]"><span id="pmAlertRepeatStatusHint" class="font-extrabold text-rose-700">🔊 เตือนซ้ำทุก 1 นาที จนกว่าจะกดรับทราบ</span><button type="button" id="pmPopupRepeatMinToggleBtn" onclick="togglePmRepeatEveryMinSetting()" class="shrink-0 bg-rose-600 hover:bg-rose-700 text-white px-2.5 py-1 rounded-lg font-extrabold text-[10.5px] shadow-sm transition">🔁 เตือนซ้ำ: เปิด</button></div>
                <div id="pmAlertPopupBody" class="p-4 space-y-2 overflow-y-auto flex-1 bg-slate-50 text-xs"></div>
                <div class="p-3 bg-white border-t flex flex-wrap items-center justify-between gap-2"><button type="button" onclick="shareDailyOrAlertSummaryToLine()" class="px-3 py-2 bg-[#00B900] hover:bg-[#009900] text-white rounded-xl text-xs font-extrabold">💬 ส่งเข้า LINE</button><div class="flex gap-1.5"><button type="button" id="pmAlertModalCalOrLoginBtn" onclick="document.getElementById('pmAlertPopupModal').classList.add('hidden'); openPmCalendarModal();" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold">📅 ดูปฏิทิน/แมพ</button><button type="button" onclick="acknowledgeCurrentPmAlertRound()" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-extrabold shadow">✅ รับทราบรอบนี้</button></div></div>
            </div></div>`);
    }

    // ========================================================================
    // 7. ช่องพิมพ์แผนงานด่วน (กันปุ่มบันทึกค้างเมื่อเน็ตสะดุด + พิมพ์ด้วยเสียง)
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
            <div><label for="pmQuickCoordInput" class="block text-[10px] font-bold text-slate-600 mb-0.5 pl-0.5">📍 พิกัดหมุดแผนงาน (ถ้ามี)</label><input type="text" id="pmQuickCoordInput" onkeydown="if(event.key==='Enter'){ event.preventDefault(); submitQuickInlinePmPlan(); }" placeholder="วางพิกัด Lat, Lon หรือลิงก์ Google Maps" class="w-full px-2.5 py-1.5 text-[10.5px] font-mono text-slate-700 bg-white border border-slate-300 rounded-lg"></div>`;
        listHdr.parentElement.insertBefore(box, listHdr);
        syncQuickAlertTimeLabel(); updateQuickInlineBoxUI();
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
        isQuickInlineBoxVisible = typeof forceState === 'boolean' ? forceState : !isQuickInlineBoxVisible;
        if (isQuickInlineBoxVisible && currentFilterStatus !== 'day') { currentFilterStatus = 'day'; renderPmSelectedDayList(); }
        syncQuickAlertTimeLabel(); updateQuickInlineBoxUI();
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
        const typedTitle = (document.getElementById('pmQuickTitleInput')?.value || '').trim(), typedCat = document.getElementById('pmQuickCategorySelect')?.value || 'tree';
        const typedTime = (document.getElementById('pmQuickTimeInput')?.value || '').trim(), typedAlertTime = normalizeTimeHHMM(document.getElementById('pmQuickAlertTimeInput')?.value || ''), typedCoord = (document.getElementById('pmQuickCoordInput')?.value || '').trim();
        openPmPlanFormModal(null, selectedDateIso || getTodayIso());
        if (typedTitle) document.getElementById('pmTitleInput').value = typedTitle;
        if (typedCat) document.getElementById('pmCategorySelect').value = typedCat;
        if (typedTime) document.getElementById('pmTimeSlotInput').value = typedTime;
        if (typedAlertTime) { document.getElementById('pmAlertModeSelect').value = 'both'; onPmAlertModeChange('both'); addPmCustomTimeChip(typedAlertTime); }
        if (typedCoord) { document.getElementById('pmCoordInput').value = typedCoord; onPmCoordTextManualInput(typedCoord); }
    }

    async function submitQuickInlinePmPlan() {
        if (!canManagePmSchedule()) return;
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
        const newPlan = {
            id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), title: rawTitle, category: catEl?.value || 'tree', pinColor: 'auto',
            alertMode: customT ? 'both' : 'standard', customAlertTimes: customT ? [customT] : [], alertBaselineAt: getMinuteFloorIso(), createdAt: nowIso, date: targetDate,
            timeSlot: (timeEl?.value || '').trim() || '09.00-12.00', notifyDaysBefore: 3, repeatMonths: 0, equipCode: '', feeder: '', note: '',
            lat: parsedCoord ? parsedCoord.lat : null, lon: parsedCoord ? parsedCoord.lon : null,
            gpsLink: parsedCoord ? `https://www.google.com/maps?q=${parsedCoord.lat.toFixed(6)},${parsedCoord.lon.toFixed(6)}` : '',
            status: 'pending', ownerGroup: myGrp, createdBy: curUser, updatedBy: curUser, updatedAt: nowIso
        };
        loadPmPlansFromStorage(); pmPlans.push(newPlan); preAckPastSlotsForPlanToday(newPlan);
        if (titleEl) titleEl.value = ''; if (coordEl) coordEl.value = ''; if (alertTimeEl) alertTimeEl.value = '';
        syncQuickAlertTimeLabel(); currentFilterStatus = 'day';
        await savePmPlansAndSync(true);
        safeToast(`✅ บันทึกแผนงานวันที่ ${formatThaiDateShort(targetDate)} เรียบร้อยแล้ว`);
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
    // 8. ตารางปฏิทินรายเดือน (65% จอคอม), แผนที่หมุดแผนงาน & รายการงานรายวัน
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
        setTimeout(() => { calendarMapInstance.invalidateSize(); renderPmPinsOnTargetMap(calendarMapInstance, calendarPmLayer, calendarPmMarkersById, false); }, 100);
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
        injectPmModalsDOM(); injectQuickAddBoxIntoCalendar();
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
    function closePmCalendarModal() { isQuickInlineBoxVisible = false; cancelPmMapInteractiveModes(); document.getElementById('pmCalendarModal')?.classList.add('hidden'); }
    function changePmCalendarMonth(delta) { const d = new Date(viewYear, viewMonth + delta, 1); viewYear = d.getFullYear(); viewMonth = d.getMonth(); renderPmCalendarGrid(); renderPmSelectedDayList(); }
    function jumpPmCalendarToday() { const now = new Date(); viewYear = now.getFullYear(); viewMonth = now.getMonth(); selectedDateIso = toLocalIsoDate(now); currentFilterStatus = 'day'; renderPmCalendarGrid(); renderPmSelectedDayList(); updateQuickInlineBoxUI(); }
    function selectPmCalendarDate(isoStr) { selectedDateIso = isoStr; currentFilterStatus = 'day'; renderPmCalendarGrid(); renderPmSelectedDayList(); updateQuickInlineBoxUI(); }
    function setPmListStatusFilter(filterVal) { currentFilterStatus = filterVal || 'day'; renderPmSelectedDayList(); }
    function toggleShowScadaDueOnCalendar(checked) { showScadaDuePins = Boolean(checked); localStorage.setItem(PM_SHOW_SCADA_DUE_KEY, String(showScadaDuePins)); refreshPmAllViews(); }

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
                const vis = getPlanPinVisualTheme(t), doneStyle = t.status === 'done' ? 'opacity:0.45;text-decoration:line-through;' : '', pinDot = (!isNaN(parseFloat(t.lat)) && !isNaN(parseFloat(t.lon))) ? '📍' : '';
                return `<div class="truncate text-[9.5px] text-white font-bold px-1 rounded leading-tight" style="background:${vis.hex};${doneStyle}">${pinDot}${vis.icon} ${safeEscHtml(t.title)}</div>`;
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
        if (!items.length) { listEl.innerHTML = `<div class="text-center py-8 px-4 bg-slate-50 rounded-2xl border border-dashed border-slate-300 text-xs text-slate-400">ยังไม่มีแผนงานในวันนี้ กดปุ่ม <b>➕ ปักแผนใหม่</b> ด้านบนเพื่อเพิ่มแผนงานได้เลยครับ</div>`; return; }
        const allowEdit = canManagePmSchedule(), allowDone = canCompletePmTask();
        listEl.innerHTML = items.map(item => {
            const cat = getCategoryMeta(item.category), alCfg = getPlanEffectiveAlertConfig(item), isDone = item.status === 'done';
            const daysLeft = calcDaysUntil(item.date, todayIso), safeId = String(item.id).replace(/'/g, "\\'"), hasCoord = !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lon));
            const dueBadge = isDone ? '<span class="bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded-full">✅ เสร็จแล้ว</span>'
                : (daysLeft < 0 ? `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">🚨 เลย ${Math.abs(daysLeft)} วัน</span>`
                : (daysLeft === 0 ? '<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">📌 วันนี้</span>' : `<span class="bg-slate-100 text-slate-600 text-[10px] font-bold px-2 py-0.5 rounded-full">อีก ${daysLeft} วัน</span>`));
            return `<div class="p-3 rounded-2xl border ${isDone ? 'bg-slate-50 border-slate-200 opacity-75' : 'bg-white border-slate-200 shadow-sm'} space-y-1.5 text-xs"><div class="flex items-start justify-between gap-2"><div class="space-y-0.5 min-w-0 flex-1"><div class="flex items-center gap-1 flex-wrap"><span class="border text-[10px] font-bold px-1.5 py-0.5 rounded ${cat.pillCls}">${cat.icon} ${cat.name}</span>${hasCoord ? '<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-1.5 py-0.5 rounded">📍 มีหมุด</span>' : ''}</div><div ${(!item.isScadaPinDue && allowEdit) ? `onclick="quickEditPmPlanTitle('${safeId}')" title="คลิกเพื่อแก้ข้อความด่วน"` : ''} class="font-extrabold text-slate-800 text-xs sm:text-sm break-words ${(!item.isScadaPinDue && allowEdit) ? 'cursor-pointer hover:text-indigo-700' : ''} ${isDone ? 'line-through' : ''}">${safeEscHtml(item.title)}</div></div><div class="shrink-0 flex items-center gap-1">${dueBadge}${(!item.isScadaPinDue && allowEdit) ? `<button type="button" onclick="quickDeletePmPlanCard('${safeId}')" class="text-slate-300 hover:text-rose-600 font-bold text-sm px-1" title="ลบแผนงาน">&times;</button>` : ''}</div></div><div class="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600"><span>📅 ${formatThaiDateShort(item.date)} (${safeEscHtml(item.timeSlot || '-')})</span><span>• เตือนล่วงหน้า ${Number(item.notifyDaysBefore ?? 3)} วัน</span><span ${(!item.isScadaPinDue && allowEdit) ? `onclick="openPmPlanFormModal('${safeId}')" title="คลิกเพื่อตั้งเวลาเตือนของงานนี้"` : ''} class="bg-indigo-50 text-indigo-800 border border-indigo-200 px-1.5 py-0.5 rounded font-bold text-[10px] ${(!item.isScadaPinDue && allowEdit) ? 'cursor-pointer hover:bg-indigo-100' : ''}">${safeEscHtml(alCfg.badgeLabel)}</span></div>${item.equipCode ? `<div class="text-[11px] font-bold text-teal-800">⚡ อุปกรณ์: ${safeEscHtml(item.equipCode)} ${item.feeder ? `(${safeEscHtml(item.feeder)})` : ''}</div>` : ''}${item.note ? `<div class="text-[11px] text-slate-500 break-words">📝 ${safeEscHtml(item.note)}</div>` : ''}<div class="pt-1.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-1.5"><div class="flex flex-wrap gap-1">${hasCoord ? `<button type="button" onclick="focusPmPlanPinOnMap('${safeId}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-1 rounded-lg text-[10px] font-bold">📍 ดูหมุด</button><button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">🗺️ นำทาง</button>` : ''}<button type="button" onclick="shareSinglePmPlanToLine('${safeId}')" class="bg-[#00B900] hover:bg-[#009900] text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">💬 LINE</button>${(!item.isScadaPinDue && allowEdit) ? `<button type="button" onclick="openPmPlanFormModal('${safeId}')" class="bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 px-2 py-1 rounded-lg text-[10px] font-bold">✏️ แก้ไข/เวลาเตือน</button>` : ''}</div>${(!item.isScadaPinDue && allowDone) ? `<button type="button" onclick="togglePmPlanCompleteStatus('${safeId}')" class="${isDone ? 'bg-slate-200 text-slate-700' : 'bg-emerald-600 hover:bg-emerald-700 text-white'} px-2.5 py-1 rounded-lg text-[10px] font-extrabold shadow-sm">${isDone ? '↩️ เปิดใหม่' : '✅ เสร็จสิ้น'}</button>` : ''}</div></div>`;
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
            const badge = c.daysLeft < 0 ? `<span class="bg-rose-600 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full">เลยกำหนด ${Math.abs(c.daysLeft)} วัน</span>` : (c.daysLeft === 0 ? `<span class="bg-amber-500 text-slate-950 text-[10px] font-extrabold px-2 py-0.5 rounded-full">📌 วันนี้ (${safeEscHtml(c.timeSlot || '-')})</span>` : `<span class="bg-sky-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">อีก ${c.daysLeft} วัน (${formatThaiDateShort(c.date)})</span>`);
            return `<div class="p-3 bg-white rounded-2xl border border-slate-200 shadow-sm space-y-1"><div class="flex items-center justify-between gap-2">${badge}<span class="text-[10px] font-bold text-indigo-700">${safeEscHtml(alCfg.badgeLabel)}</span></div><div class="font-extrabold text-slate-800 text-xs sm:text-sm">${cat.icon} ${safeEscHtml(c.title)}</div>${hasCoord ? `<div class="pt-1 flex gap-1.5">${isLogged ? `<button type="button" onclick="focusPmPlanPinOnMap('${safeId}')" class="bg-indigo-50 text-indigo-700 border border-indigo-200 px-2.5 py-1 rounded-lg text-[10px] font-bold">📍 ดูหมุดบนแมพ</button>` : ''}<button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-600 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">🗺️ นำทาง Maps</button></div>` : ''}</div>`;
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
    // ===== จบพาทที่ 5 / 6 ของไฟล์ pm-calendar.js =====
    // ===== เริ่มพาทที่ 6 / 6 ของไฟล์ pm-calendar.js (วางทับพาทที่ 6 / 6 เดิม จนจบไฟล์) =====
    // ========================================================================
    // 9. ตั้งเวลาเตือนรายแผนงาน, มินิแมพปลอด Race, แปลงลิงก์ปลอดภัย & บันทึก/ลบ/ทำซ้ำ
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
    function syncFormMiniMapMarker(lat, lon, panTo = true) {
        if (!formMiniMap || typeof L === 'undefined') return;
        if (isNaN(lat) || isNaN(lon)) { if (formMiniMarker) { formMiniMap.removeLayer(formMiniMarker); formMiniMarker = null; } return; }
        if (!formMiniMarker) {
            formMiniMarker = L.marker([lat, lon], { draggable: true }).addTo(formMiniMap);
            formMiniMarker.on('dragend', ev => { const ll = ev.target.getLatLng(), cdEl = document.getElementById('pmCoordInput'); if (cdEl) cdEl.value = `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`; });
        } else formMiniMarker.setLatLng([lat, lon]);
        if (panTo) formMiniMap.setView([lat, lon], Math.max(formMiniMap.getZoom(), 15));
    }
    async function togglePmFormMiniMap(forceOpen) {
        const wrap = document.getElementById('pmFormMiniMapWrap'); if (!wrap) return;
        isFormMiniMapOpen = typeof forceOpen === 'boolean' ? forceOpen : !isFormMiniMapOpen;
        const reqSeq = ++miniMapSyncSeq;
        wrap.classList.toggle('hidden', !isFormMiniMapOpen);
        if (!isFormMiniMapOpen) { syncFormMiniMapMarker(NaN, NaN, false); return; }
        if (!(await ensureLeafletReady()) || typeof L === 'undefined' || !isFormMiniMapOpen || reqSeq !== miniMapSyncSeq) return;
        if (!formMiniMap) {
            const defCenter = window.lastKnownTechCoords ? [window.lastKnownTechCoords.lat, window.lastKnownTechCoords.lon] : [13.1361, 101.0322];
            formMiniMap = L.map('pmFormMiniLeafletMap').setView(defCenter, 13);
            L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' }).addTo(formMiniMap);
            formMiniMap.on('click', e => { if (!e.latlng) return; const la = Number(e.latlng.lat.toFixed(6)), lo = Number(e.latlng.lng.toFixed(6)), cdEl = document.getElementById('pmCoordInput'); if (cdEl) cdEl.value = `${la.toFixed(6)}, ${lo.toFixed(6)}`; syncFormMiniMapMarker(la, lo, false); });
        }
        setTimeout(async () => {
            if (!isFormMiniMapOpen || reqSeq !== miniMapSyncSeq || !formMiniMap) return;
            formMiniMap.invalidateSize();
            const parsed = await parsePmCoordOrShortLink(document.getElementById('pmCoordInput')?.value || '');
            if (!isFormMiniMapOpen || reqSeq !== miniMapSyncSeq) return;
            if (parsed) syncFormMiniMapMarker(parsed.lat, parsed.lon, true); else syncFormMiniMapMarker(NaN, NaN, false);
        }, 100);
    }
    async function onPmCoordTextManualInput(rawVal) {
        if (!isFormMiniMapOpen || !formMiniMap) return;
        const reqSeq = ++miniMapSyncSeq, p = await parsePmCoordOrShortLink(rawVal);
        if (!isFormMiniMapOpen || reqSeq !== miniMapSyncSeq) return;
        if (p) syncFormMiniMapMarker(p.lat, p.lon, true); else syncFormMiniMapMarker(NaN, NaN, false);
    }

    function onPmScadaEquipPick(pinId) {
        if (!pinId) return;
        try {
            const target = JSON.parse(rawGet('elec_labeled_places_list') || '[]').find(p => p?.id === pinId); if (!target) return;
            const eqEl = document.getElementById('pmEquipCodeInput'), fdEl = document.getElementById('pmFeederInput'), cdEl = document.getElementById('pmCoordInput'), ttEl = document.getElementById('pmTitleInput');
            if (eqEl) eqEl.value = target.name || ''; if (fdEl) fdEl.value = (target.scadaNode?.fd || '').toUpperCase();
            if (!isNaN(parseFloat(target.lat)) && !isNaN(parseFloat(target.lon))) { const lat = Number(target.lat), lon = Number(target.lon); if (cdEl) cdEl.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`; if (isFormMiniMapOpen) syncFormMiniMapMarker(lat, lon, true); }
            if (ttEl && !ttEl.value.trim()) ttEl.value = `${getCategoryMeta(document.getElementById('pmCategorySelect')?.value || 'scada').name} (${target.name})`;
            safeToast(`⚡ ดึงพิกัดหมุดจาก "${target.name}" แล้ว`);
        } catch (e) {}
    }
    function fillPmCurrentMobileGps() {
        const coordEl = document.getElementById('pmCoordInput');
        if (!navigator.geolocation) { safeToast('⚠️ เบราว์เซอร์ไม่รองรับ GPS'); return; }
        safeToast('⏳ กำลังดึงพิกัดมือถือปัจจุบัน...');
        navigator.geolocation.getCurrentPosition(
            pos => { const la = Number(pos.coords.latitude.toFixed(6)), lo = Number(pos.coords.longitude.toFixed(6)); if (coordEl) coordEl.value = `${la.toFixed(6)}, ${lo.toFixed(6)}`; if (isFormMiniMapOpen) syncFormMiniMapMarker(la, lo, true); safeToast(`📍 ดึงพิกัดสำเร็จ (${la.toFixed(6)}, ${lo.toFixed(6)})`); },
            () => { if (window.lastKnownTechCoords && coordEl) { const la = Number(window.lastKnownTechCoords.lat.toFixed(6)), lo = Number(window.lastKnownTechCoords.lon.toFixed(6)); coordEl.value = `${la.toFixed(6)}, ${lo.toFixed(6)}`; if (isFormMiniMapOpen) syncFormMiniMapMarker(la, lo, true); safeToast('📍 ใช้พิกัดล่าสุดของเครื่อง'); } else safeToast('❌ ไม่สามารถดึงพิกัดได้ กรุณาเปิด Location ในเครื่อง'); },
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
        injectPmModalsDOM(); loadPmPlansFromStorage(); editingPlanId = planId || null;
        const modal = document.getElementById('pmPlanFormModal'), titleHdr = document.getElementById('pmPlanFormTitle'), delBtn = document.getElementById('pmDeleteBtnInModal'), modeSel = document.getElementById('pmAlertModeSelect');
        if (!modal) return;
        syncFormMiniMapMarker(NaN, NaN, false);
        let shouldOpenMiniMap = false;
        if (editingPlanId) {
            const target = pmPlans.find(p => p.id === editingPlanId && !p.pmDeleted); if (!target) return;
            if (titleHdr) titleHdr.textContent = '✏️ แก้ไขข้อมูล / ตั้งเวลาเตือนแผนงาน';
            populatePmScadaPinPicker(target.linkedPinId || ''); selectPmFormPinColor(target.pinColor || 'auto');
            document.getElementById('pmTitleInput').value = target.title || ''; document.getElementById('pmCategorySelect').value = target.category || 'scada';
            document.getElementById('pmDateInput').value = target.date || getTodayIso(); document.getElementById('pmTimeSlotInput').value = target.timeSlot || '09.00-12.00';
            document.getElementById('pmNotifyBeforeSelect').value = String(target.notifyDaysBefore ?? 3); document.getElementById('pmRepeatMonthsSelect').value = String(target.repeatMonths ?? 0);
            tempFormCustomTimes = normalizeCustomTimesArray(target.customAlertTimes || []);
            const effMode = target.alertMode || (tempFormCustomTimes.length > 0 ? 'both' : 'standard');
            if (modeSel) modeSel.value = effMode; onPmAlertModeChange(effMode);
            document.getElementById('pmEquipCodeInput').value = target.equipCode || ''; document.getElementById('pmFeederInput').value = target.feeder || '';
            const hasC = !isNaN(parseFloat(target.lat)) && !isNaN(parseFloat(target.lon));
            document.getElementById('pmCoordInput').value = hasC ? `${Number(target.lat).toFixed(6)}, ${Number(target.lon).toFixed(6)}` : (target.gpsLink || '');
            document.getElementById('pmNoteInput').value = target.note || ''; delBtn?.classList.remove('hidden');
            shouldOpenMiniMap = hasC && isFormMiniMapOpen;
        } else {
            if (titleHdr) titleHdr.textContent = (presetLat != null && presetLon != null) ? '📍 ปักหมุดแผนงานใหม่ (จากจุดที่แตะบนแมพ)' : '➕ เพิ่มหมุดแผนงานบำรุงรักษาใหม่';
            populatePmScadaPinPicker(presetScadaPinId || ''); selectPmFormPinColor('auto');
            document.getElementById('pmTitleInput').value = ''; document.getElementById('pmCategorySelect').value = presetScadaPinId ? 'scada' : 'tree';
            document.getElementById('pmDateInput').value = presetDate || selectedDateIso || getTodayIso(); document.getElementById('pmTimeSlotInput').value = '09.00-12.00';
            document.getElementById('pmNotifyBeforeSelect').value = '3'; document.getElementById('pmRepeatMonthsSelect').value = '0';
            tempFormCustomTimes = []; if (modeSel) modeSel.value = 'standard'; onPmAlertModeChange('standard');
            document.getElementById('pmEquipCodeInput').value = ''; document.getElementById('pmFeederInput').value = '';
            document.getElementById('pmCoordInput').value = (presetLat != null && presetLon != null) ? `${Number(presetLat).toFixed(6)}, ${Number(presetLon).toFixed(6)}` : '';
            document.getElementById('pmNoteInput').value = ''; delBtn?.classList.add('hidden');
            if (presetScadaPinId) onPmScadaEquipPick(presetScadaPinId);
            shouldOpenMiniMap = (presetLat != null && presetLon != null);
        }
        modal.classList.remove('hidden');
        togglePmFormMiniMap(shouldOpenMiniMap);
        setTimeout(() => document.getElementById('pmTitleInput')?.focus(), 80);
    }
    function closePmPlanFormModal() { editingPlanId = null; togglePmFormMiniMap(false); document.getElementById('pmPlanFormModal')?.classList.add('hidden'); }

    async function savePmPlanFromModal() {
        if (!canManagePmSchedule()) return;
        const title = (document.getElementById('pmTitleInput')?.value || '').trim(), category = document.getElementById('pmCategorySelect')?.value || 'scada';
        const pinColor = document.getElementById('pmPinColorInput')?.value || 'auto', dateVal = (document.getElementById('pmDateInput')?.value || '').trim();
        const timeSlot = (document.getElementById('pmTimeSlotInput')?.value || '').trim() || '09.00-12.00';
        const notifyDaysBefore = parseInt(document.getElementById('pmNotifyBeforeSelect')?.value || '3', 10), repeatMonths = parseInt(document.getElementById('pmRepeatMonthsSelect')?.value || '0', 10);
        const alertMode = document.getElementById('pmAlertModeSelect')?.value || 'standard', rawLinkedPinId = (document.getElementById('pmScadaPinPicker')?.value || '').trim();
        const equipCode = (document.getElementById('pmEquipCodeInput')?.value || '').trim(), feeder = (document.getElementById('pmFeederInput')?.value || '').trim().toUpperCase();
        const rawCoord = (document.getElementById('pmCoordInput')?.value || '').trim(), note = (document.getElementById('pmNoteInput')?.value || '').trim(), saveBtn = document.getElementById('pmSaveSubmitBtn');
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
        let linkedPinId = rawLinkedPinId || undefined;
        if (linkedPinId) {
            try {
                const sp = JSON.parse(rawGet('elec_labeled_places_list') || '[]').find(p => p?.id === linkedPinId);
                if (!parsedCoord || (sp && !isNaN(parseFloat(sp.lat)) && !isNaN(parseFloat(sp.lon)) && (Math.abs(parseFloat(sp.lat) - parsedCoord.lat) > 0.00015 || Math.abs(parseFloat(sp.lon) - parsedCoord.lon) > 0.00015))) linkedPinId = undefined;
            } catch (e) {}
        }
        loadPmPlansFromStorage();
        const curUser = (rawGet('elec_app_current_user') || 'admin').trim(), myGroup = getActivePmGroup();
        const cleanNotify = isNaN(notifyDaysBefore) ? 3 : notifyDaysBefore, cleanRepeat = isNaN(repeatMonths) ? 0 : repeatMonths;
        const gpsLink = parsedCoord ? `https://www.google.com/maps?q=${parsedCoord.lat.toFixed(6)},${parsedCoord.lon.toFixed(6)}` : '';
        let savedRecord = null;
        if (editingPlanId) {
            const idx = pmPlans.findIndex(p => p.id === editingPlanId);
            if (idx !== -1) {
                const prev = pmPlans[idx];
                const alertChanged = (prev.date !== dateVal) || ((prev.alertMode || 'standard') !== alertMode) || (Number(prev.notifyDaysBefore ?? 3) !== cleanNotify) || (JSON.stringify(normalizeCustomTimesArray(prev.customAlertTimes || [])) !== JSON.stringify(customAlertTimes));
                const nextBaseline = alertChanged ? getMinuteFloorIso() : (prev.alertBaselineAt || prev.createdAt || getMinuteFloorIso());
                pmPlans[idx] = { ...prev, title, category, pinColor, date: dateVal, timeSlot, notifyDaysBefore: cleanNotify, repeatMonths: cleanRepeat, alertMode, customAlertTimes, alertBaselineAt: nextBaseline, linkedPinId, equipCode, feeder, note, lat: parsedCoord ? parsedCoord.lat : null, lon: parsedCoord ? parsedCoord.lon : null, gpsLink, ownerGroup: normPmGrp(prev.ownerGroup || myGroup) || myGroup, updatedBy: curUser, updatedAt: nextPmUpdatedIso(prev.updatedAt) };
                savedRecord = pmPlans[idx];
            }
        } else {
            const nowIso = nextPmUpdatedIso(safeGetLocMap()[PM_LOC_PREFIX + myGroup]?.updatedAt);
            savedRecord = { id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), title, category, pinColor, date: dateVal, timeSlot, notifyDaysBefore: cleanNotify, repeatMonths: cleanRepeat, alertMode, customAlertTimes, alertBaselineAt: getMinuteFloorIso(), createdAt: nowIso, linkedPinId, equipCode, feeder, note, lat: parsedCoord ? parsedCoord.lat : null, lon: parsedCoord ? parsedCoord.lon : null, gpsLink, status: 'pending', ownerGroup: myGroup, createdBy: curUser, updatedBy: curUser, updatedAt: nowIso };
            pmPlans.push(savedRecord);
        }
        if (savedRecord) preAckPastSlotsForPlanToday(savedRecord);
        const qTitle = document.getElementById('pmQuickTitleInput'); if (qTitle) qTitle.value = '';
        selectedDateIso = dateVal; const [y, m] = dateVal.split('-').map(Number); if (y && m) { viewYear = y; viewMonth = m - 1; }
        currentFilterStatus = 'day'; closePmPlanFormModal();
        await savePmPlansAndSync(true);
        safeToast(parsedCoord ? '📍 บันทึกหมุดแผนงานและเวลาเตือนเรียบร้อย!' : '✅ บันทึกแผนงานและเวลาเตือนเรียบร้อย!');
    }

    function deletePmPlanById(planId, closeFormAfter = false) {
        if (!planId || !canManagePmSchedule()) return;
        loadPmPlansFromStorage();
        const target = pmPlans.find(p => p.id === planId && !p.pmDeleted); if (!target) return;
        safeConfirm(`ต้องการลบแผนงาน "${target.title}" ออกจากปฏิทินและแผนที่ใช่หรือไม่?`, async function () {
            const idx = pmPlans.findIndex(p => p.id === planId);
            if (idx !== -1) pmPlans[idx] = { id: pmPlans[idx].id, ownerGroup: normPmGrp(pmPlans[idx].ownerGroup || getActivePmGroup()) || getActivePmGroup(), pmDeleted: true, updatedAt: nextPmUpdatedIso(pmPlans[idx].updatedAt) };
            if (closeFormAfter) closePmPlanFormModal();
            await savePmPlansAndSync(true); safeToast('🗑️ ลบหมุดแผนงานเรียบร้อยแล้ว');
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
            pmPlans.push({ ...plan, id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), date: spawnedNextDate, status: 'pending', alertBaselineAt: getMinuteFloorIso(), createdAt: spawnedIso, completedAt: undefined, completedBy: undefined, spawnedNextCycle: undefined, updatedAt: spawnedIso });
        }
        scadaMapRef?.closePopup(); repairMapRef?.closePopup(); calendarMapInstance?.closePopup();
        await savePmPlansAndSync(true);
        safeToast(spawnedNextDate ? `✅ เสร็จสิ้น! และปักหมุดรอบถัดไป (${formatThaiDateShort(spawnedNextDate)}) อัตโนมัติแล้ว` : (nextStatus === 'done' ? '✅ บันทึกดำเนินงานเสร็จสิ้นแล้ว' : '↩️ เปิดหมุดแผนงานกลับมาใหม่แล้ว'));
    }

    // ========================================================================
    // 10. นำทาง GPS, แชร์ LINE, Excel, ปุ่มเตือนซ้ำทุกนาที & นาฬิกาปลอดการยิงซ้อน
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
        if (isUserCurrentlyLoggedIn() && typeof window.recordEquipmentNavStart === 'function' && !safeIsViewer()) window.recordEquipmentNavStart({ id: item.id, name: `PM: ${item.title}`, note: item.note || '', ownerGroup: normPmGrp(item.ownerGroup || getActivePmGroup()), lat, lon }, { distanceKm: '2.0', durationMin: 5, isArrived: false });
        window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=driving`, '_blank');
    }
    function shareSinglePmPlanToLine(itemId) {
        const item = getAllVisibleCalendarItems().find(x => x.id === itemId); if (!item) return;
        const cat = getCategoryMeta(item.category), alCfg = getPlanEffectiveAlertConfig(item);
        const lines = [`📅 หมุดแผนงานบำรุงรักษา (${normPmGrp(item.ownerGroup || getActivePmGroup())})`, `${cat.icon} ประเภท : ${cat.name}`, `🏷️ เรื่อง : ${item.title}`, `🗓️ กำหนดการ : ${formatThaiDateFull(item.date)} (${item.timeSlot || '-'})`, `⏰ แจ้งเตือน : ${alCfg.badgeLabel}`];
        if (item.equipCode) lines.push(`⚡ อุปกรณ์ : ${item.equipCode}${item.feeder ? ` (วงจร ${item.feeder})` : ''}`);
        if (item.note) lines.push(`📝 รายละเอียด : ${item.note}`);
        if (!isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lon))) lines.push(`📍 พิกัดหมุด : https://www.google.com/maps?q=${Number(item.lat).toFixed(6)},${Number(item.lon).toFixed(6)}`);
        const txt = lines.join('\n'); copyPmTextSafe(txt, '💬 คัดลอกแผนงานและกำลังเปิดแอป LINE...'); window.open('https://line.me/R/share?text=' + encodeURIComponent(txt), '_blank');
    }
    function shareDailyOrAlertSummaryToLine() {
        const alerts = getAlertCandidatesForToday(), list = alerts.length > 0 ? alerts : getAllVisibleCalendarItems().filter(i => i.date === selectedDateIso);
        if (!list.length) { safeToast('⚠️ ไม่มีรายการแผนงานสำหรับส่งสรุปเข้า LINE'); return; }
        const hdr = alerts.length > 0 ? `🔔 สรุปแจ้งเตือนแผนงานบำรุงรักษา (${getActivePmGroup()})\n📅 ณ ${formatThaiDateFull(getTodayIso())}` : `📅 แผนงานบำรุงรักษา (${getActivePmGroup()})\n🗓️ ${formatThaiDateFull(selectedDateIso)}`;
        const body = list.slice(0, 15).map((it, idx) => { const cat = getCategoryMeta(it.category), dTag = it.daysLeft !== undefined ? (it.daysLeft < 0 ? `[เลย ${Math.abs(it.daysLeft)} วัน] ` : (it.daysLeft === 0 ? '[วันนี้] ' : `[อีก ${it.daysLeft} วัน] `)) : ''; const gps = (!isNaN(parseFloat(it.lat)) && !isNaN(parseFloat(it.lon))) ? `\n   📍 https://www.google.com/maps?q=${Number(it.lat).toFixed(6)},${Number(it.lon).toFixed(6)}` : ''; return `${idx + 1}. ${dTag}${cat.icon} ${it.title} (${formatThaiDateShort(it.date)})${gps}`; }).join('\n');
        const full = `${hdr}\n━━━━━━━━━━━━━━━━━━\n${body}`; copyPmTextSafe(full, '💬 คัดลอกสรุปแผนงานและกำลังเปิด LINE...'); window.open('https://line.me/R/share?text=' + encodeURIComponent(full), '_blank');
    }
    async function exportPmPlansToExcel() {
        const items = getAllVisibleCalendarItems(); if (!items.length) { safeToast('⚠️ ยังไม่มีข้อมูลแผนงานสำหรับส่งออก'); return; }
        const myGrp = getActivePmGroup(), headers = ['ลำดับ', 'กลุ่มสังกัด', 'วันที่กำหนด', 'เวลาปฏิบัติงาน', 'ประเภทงาน', 'หัวข้อแผนงาน', 'เงื่อนไขเวลาเตือน', 'เตือนล่วงหน้า(วัน)', 'รหัสอุปกรณ์', 'วงจร', 'รายละเอียด', 'สถานะ', 'ผู้ทำเสร็จ', 'ลิงก์พิกัดหมุด'];
        const rows = items.map((it, i) => [String(i + 1), normPmGrp(it.ownerGroup || myGrp), formatThaiDateShort(it.date), it.timeSlot || '-', getCategoryMeta(it.category).name, it.title || '-', getPlanEffectiveAlertConfig(it).badgeLabel, String(it.notifyDaysBefore ?? 3), it.equipCode || '-', it.feeder || '-', it.note || '-', it.status === 'done' ? 'เสร็จสิ้นแล้ว' : 'รอดำเนินการ', it.completedBy || '-', (!isNaN(parseFloat(it.lat)) && !isNaN(parseFloat(it.lon))) ? `https://www.google.com/maps?q=${Number(it.lat).toFixed(6)},${Number(it.lon).toFixed(6)}` : '-']);
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
        exportPmPlansToExcel, togglePmSoundSetting, togglePmRepeatEveryMinSetting, requestPmBrowserNotificationPermission, acknowledgeCurrentPmAlertRound
    });

    function bootstrapPmCalendarModule() {
        rememberActiveAuthForLoggedOutAlerts(); bindLeafletMapHooks(); injectPmCalendarStyles(); injectPmModalsDOM(); injectQuickAddBoxIntoCalendar();
        loadPmPlansFromStorage(); syncPmPlansFromLocationsMap(); updatePmSoundAndNotifButtonsUI();
        if (isUserCurrentlyLoggedIn()) refreshPmAllViews();
        if (typeof window.switchTechMainTab === 'function' && !window.switchTechMainTab.__pmWrapped) {
            const origSwitch = window.switchTechMainTab;
            const wrapped = function (...args) { const res = origSwitch.apply(this, args); setTimeout(() => { injectPmButtonsIntoScadaToolbar(); renderAllExternalPmMapLayers(); }, 180); return res; };
            wrapped.__pmWrapped = true; window.switchTechMainTab = wrapped;
        }
        let lastKnownLoginState = isUserCurrentlyLoggedIn();
        setInterval(() => {
            const nowLogged = isUserCurrentlyLoggedIn();
            if (nowLogged !== lastKnownLoginState) {
                lastKnownLoginState = nowLogged;
                if (nowLogged) { rememberActiveAuthForLoggedOutAlerts(); syncPmPlansFromLocationsMap(); refreshPmAllViews(); }
                else { closePmPlanFormModal(); closePmCalendarModal(); document.getElementById('pmFallbackPromptModal')?.classList.add('hidden'); const alBtn = document.getElementById('pmAlertModalCalOrLoginBtn'); if (alBtn) alBtn.textContent = '🔐 ล็อกอินเพื่อจัดการ'; updatePmHeaderBadgesAndStrip(); }
            }
        }, 1200);
        setTimeout(async () => { rememberActiveAuthForLoggedOutAlerts(); if (!isUserCurrentlyLoggedIn()) await pullPmPlansWhileLoggedOut(); else syncPmPlansFromLocationsMap(); if (isUserCurrentlyLoggedIn()) refreshPmAllViews(); checkAndTriggerScheduledPmAlerts(false); }, 1400);
        setInterval(checkExactScheduleClockTick, 15000);
        setInterval(() => { rememberActiveAuthForLoggedOutAlerts(); if (!document.hidden && isUserCurrentlyLoggedIn()) { syncPmPlansFromLocationsMap(); updatePmHeaderBadgesAndStrip(); } }, 10000);
        document.addEventListener('visibilitychange', triggerWakeScheduleCheck);
        window.addEventListener('focus', triggerWakeScheduleCheck);
    }
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', bootstrapPmCalendarModule);
    else bootstrapPmCalendarModule();
})();
// ==================== จบไฟล์ pm-calendar.js ====================