// ============================================================================
// 📅📍 PEA SMART GRID — MAINTENANCE SCHEDULE & WORK PLAN PINS ENGINE v6.5 (pm-calendar.js)
// ระบบปฏิทินแผนงานบำรุงรักษา + หมุดแผนงานบนแผนที่ (SCADA / แผนที่ซ่อม / ปฏิทิน) + แจ้งเตือน 00:00 & 07:00
// พาทที่ 1 / 3 : Config, Pin Themes, Dynamic Leaflet Loader, Sync Bus & Alert Scheduler
// ============================================================================
(function () {
    'use strict';

    const Core = window.PeaCore;
    const PM_STORAGE_KEY = 'elec_pm_calendar_plans_v1';
    const PM_ACK_LOG_KEY = 'elec_pm_alert_ack_log_v1';
    const PM_SOUND_KEY = 'elec_pm_alert_sound_enabled';
    const PM_SHOW_SCADA_DUE_KEY = 'elec_pm_show_scada_due_pins';
    const PM_SHOW_MAP_PINS_KEY = 'elec_pm_show_pins_on_map';
    const PM_MAP_FILTER_MODE_KEY = 'elec_pm_map_pin_filter_mode';
    const PM_LOC_PREFIX = '__PM_SCHEDULE__';

    const MAX_TOMBSTONE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const MAX_CLOUD_SYNC_ITEMS = 120;

    const THAI_MONTHS = [
        'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
        'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
    ];
    const THAI_DAYS_SHORT = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

        const PM_CATEGORIES = {
        tree: {
            key: 'tree',
            icon: '🌳',
            name: 'ตัดรอนกิ่งไม้ใกล้แนวสาย',
            pillCls: 'bg-emerald-100 text-emerald-800 border-emerald-300',
            barBg: '#10b981',
            defaultColor: 'emerald'
        },
        scada: {
            key: 'scada',
            icon: '⚡',
            name: 'ตรวจสวิตช์ / อุปกรณ์ SCADA',
            pillCls: 'bg-sky-100 text-sky-800 border-sky-300',
            barBg: '#0284c7',
            defaultColor: 'sky'
        },
        tr: {
            key: 'tr',
            icon: '🔌',
            name: 'บำรุงรักษาหม้อแปลง / โหลด',
            pillCls: 'bg-amber-100 text-amber-900 border-amber-300',
            barBg: '#f59e0b',
            defaultColor: 'amber'
        },
        thermo: {
            key: 'thermo',
            icon: '🔥',
            name: 'ส่องกล้องความร้อน (Thermo)',
            pillCls: 'bg-rose-100 text-rose-800 border-rose-300',
            barBg: '#e11d48',
            defaultColor: 'rose'
        },
        hotline: {
            key: 'hotline',
            icon: '🦺',
            name: 'HOTLINE เข้าทำงาน',
            pillCls: 'bg-orange-100 text-orange-900 border-orange-300',
            barBg: '#ea580c',
            defaultColor: 'orange'
        },
        patrol: {
            key: 'patrol',
            icon: '🛠️',
            name: 'สวิชชิ่งแผนดับไฟปฏิบัติงาน',
            pillCls: 'bg-purple-100 text-purple-800 border-purple-300',
            barBg: '#7c3aed',
            defaultColor: 'purple'
        }
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
    let calendarLeftViewMode = 'grid'; // 'grid' | 'map'
    let isTechStripCollapsed = false;

    let isPmSoundEnabled = localStorage.getItem(PM_SOUND_KEY) !== 'false';
    let showScadaDuePins = localStorage.getItem(PM_SHOW_SCADA_DUE_KEY) !== 'false';
    let showPmPinsOnMaps = localStorage.getItem(PM_SHOW_MAP_PINS_KEY) !== 'false';
    let pmMapFilterMode = localStorage.getItem(PM_MAP_FILTER_MODE_KEY) || 'pending'; // 'pending' | 'alert'
    let isSyncingPmInternal = false;
    let lastCheckedAlertMinuteKey = '';

    // ตัวแปรควบคุมแผนที่และโหมดปัก/ย้ายหมุดแผนงาน
    let scadaMapRef = null;
    let scadaPmLayer = null;
    let scadaPmMarkersById = {};
    let repairMapRef = null;
    let repairPmLayer = null;
    let repairPmMarkersById = {};

    let calendarMapInstance = null;
    let calendarPmLayer = null;
    let calendarPmMarkersById = {};

    let formMiniMap = null;
    let formMiniMarker = null;
    let isFormMiniMapOpen = false;

    let pmPinDropModeActive = false;
    let pmPinMoveTargetId = null;
    let leafletLoadPromise = null;

    // ========================================================================
    // 1. โหลดไลบรารีแผนที่อัตโนมัติ (สำหรับ index.html) & ฟังก์ชันวันที่/สิทธิ์
    // ========================================================================
    function rawGet(key) {
        return Core && typeof Core.rawStorageGet === 'function'
            ? Core.rawStorageGet(key)
            : localStorage.getItem(key);
    }

    function ensureLeafletReady() {
        if (typeof L !== 'undefined' && L.map) return Promise.resolve(true);
        if (leafletLoadPromise) return leafletLoadPromise;

        leafletLoadPromise = new Promise((resolve) => {
            if (!document.querySelector('link[href*="leaflet.css"]')) {
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
                document.head.appendChild(link);
            }
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            script.onload = () => {
                if (typeof bindLeafletMapHooks === 'function') bindLeafletMapHooks();
                resolve(true);
            };
            script.onerror = () => {
                leafletLoadPromise = null;
                resolve(false);
            };
            document.head.appendChild(script);
        });
        return leafletLoadPromise;
    }

    function toLocalIsoDate(dateObj) {
        const d = dateObj instanceof Date ? dateObj : new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function getTodayIso() {
        return toLocalIsoDate(new Date());
    }

    function parseIsoToMidnightMs(isoStr) {
        if (!isoStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(isoStr).trim())) return NaN;
        const [y, m, d] = String(isoStr).trim().split('-').map(Number);
        return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    }

    function calcDaysUntil(targetIso, baseIso = getTodayIso()) {
        const tMs = parseIsoToMidnightMs(targetIso);
        const bMs = parseIsoToMidnightMs(baseIso);
        if (isNaN(tMs) || isNaN(bMs)) return 99999;
        return Math.round((tMs - bMs) / 86400000);
    }

    function addMonthsToIsoDate(isoStr, monthsToAdd) {
        if (!isoStr || !/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return getTodayIso();
        const [y, m, d] = isoStr.split('-').map(Number);
        const target = new Date(y, (m - 1) + Number(monthsToAdd || 0), d);
        return toLocalIsoDate(target);
    }

    function formatThaiDateFull(isoStr) {
        if (!isoStr || !String(isoStr).includes('-')) return '-';
        const [y, m, d] = String(isoStr).split('-').map(Number);
        if (!y || !m || !d) return isoStr;
        const dow = THAI_DAYS_SHORT[new Date(y, m - 1, d).getDay()] || '';
        return `${dow} ${d} ${THAI_MONTHS[m - 1]} ${y + 543}`;
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

    function getActivePmGroup() {
        const g = (typeof getCurrentUserGroup === 'function' ? getCurrentUserGroup() : '') ||
                  rawGet('elec_app_current_group') || '';
        return g.trim() || 'กฟส.บึง';
    }

    function canManagePmSchedule() {
        return rawGet('elec_app_logged_in') === 'true' &&
               !isViewerRole() &&
               canCurrentUserEditScada() &&
               !(Core && Core.simSandbox && Core.simSandbox.active);
    }

    function canCompletePmTask() {
        return rawGet('elec_app_logged_in') === 'true' &&
               !isViewerRole() &&
               !(Core && Core.simSandbox && Core.simSandbox.active);
    }

    function canSeePmPlan(plan) {
        if (!plan || plan.pmDeleted) return false;
        const role = rawGet('elec_app_current_role') || 'user';
        const myGrp = (typeof getCurrentUserGroup === 'function' ? getCurrentUserGroup() : '') ||
                      rawGet('elec_app_current_group') || '';
        if (role === 'admin' && !myGrp) return true;
        return (plan.ownerGroup || 'กฟส.บึง').trim() === getActivePmGroup();
    }

    function getCategoryMeta(catKey) {
        return PM_CATEGORIES[catKey] || PM_CATEGORIES.scada;
    }

    function getPlanPinVisualTheme(item) {
        const cat = getCategoryMeta(item?.category);
        const chosenKey = (item?.pinColor && PM_PIN_COLORS[item.pinColor] && item.pinColor !== 'auto')
            ? item.pinColor
            : cat.defaultColor;
        const cMeta = PM_PIN_COLORS[chosenKey] || PM_PIN_COLORS.sky;
        return {
            icon: cat.icon,
            catName: cat.name,
            hex: cMeta.hex,
            grad: cMeta.grad
        };
    }

    // ========================================================================
    // 2. คลังข้อมูลหมุดแผนงาน & ซิงค์อัตโนมัติผ่าน MQTT + Google Sheets
    // ========================================================================
    function prunePmPlansArray(rawArr) {
        if (!Array.isArray(rawArr)) return [];
        const now = Date.now();
        const byId = new Map();

        rawArr.forEach(item => {
            if (!item || !item.id) return;
            const updMs = new Date(item.updatedAt || 0).getTime() || 0;
            if (item.pmDeleted && updMs > 0 && (now - updMs > MAX_TOMBSTONE_AGE_MS)) return;
            const existing = byId.get(item.id);
            const exMs = existing ? (new Date(existing.updatedAt || 0).getTime() || 0) : -1;
            if (!existing || updMs >= exMs) {
                byId.set(item.id, item);
            }
        });

        return Array.from(byId.values()).sort((a, b) => {
            const dCmp = String(a.date || '').localeCompare(String(b.date || ''));
            if (dCmp !== 0) return dCmp;
            return String(a.timeSlot || '').localeCompare(String(b.timeSlot || ''));
        });
    }

    function loadPmPlansFromStorage() {
        try {
            pmPlans = prunePmPlansArray(JSON.parse(rawGet(PM_STORAGE_KEY) || '[]'));
        } catch (e) {
            pmPlans = [];
        }
        return pmPlans;
    }

    function buildCloudCarrierMapForGroup(groupName) {
        const now = Date.now();
        const relevant = pmPlans.filter(p => (p.ownerGroup || 'กฟส.บึง').trim() === groupName);
        const prioritized = relevant
            .filter(p => {
                if (p.pmDeleted) return (now - (new Date(p.updatedAt || 0).getTime() || 0)) <= MAX_TOMBSTONE_AGE_MS;
                if (p.status === 'done') {
                    const dMs = parseIsoToMidnightMs(p.date);
                    return isNaN(dMs) || (now - dMs) <= (90 * 86400000);
                }
                return true;
            })
            .slice(-MAX_CLOUD_SYNC_ITEMS);

        const out = {};
        prioritized.forEach(p => { out[p.id] = p; });
        return out;
    }

    async function savePmPlansAndSync(pushCloud = true) {
        pmPlans = prunePmPlansArray(pmPlans);
        localStorage.setItem(PM_STORAGE_KEY, JSON.stringify(pmPlans));

        isSyncingPmInternal = true;
        try {
            const locMap = getTechLocationsMap();
            const groups = new Set([getActivePmGroup()]);
            pmPlans.forEach(p => { if (p?.ownerGroup) groups.add(p.ownerGroup.trim()); });

            const nowIso = new Date().toISOString();
            groups.forEach(grp => {
                if (!grp) return;
                locMap[PM_LOC_PREFIX + grp] = {
                    isSystemRegistry: true,
                    username: '',
                    group: grp,
                    isOnline: false,
                    gpsDisabled: true,
                    lat: null,
                    lon: null,
                    pmPlansMap: buildCloudCarrierMapForGroup(grp),
                    lastSeenAt: nowIso,
                    updatedAt: nowIso
                };
            });

            if (Core && typeof Core.unlockCloudWrite === 'function') Core.unlockCloudWrite(20000);
            localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
        } finally {
            isSyncingPmInternal = false;
        }

        if (typeof refreshPmAllViews === 'function') refreshPmAllViews();

        if (pushCloud) {
            if (typeof window.syncJobsWithFieldPage === 'function') {
                await window.syncJobsWithFieldPage();
            } else if (typeof window.pushAllJobsToCloud === 'function') {
                await window.pushAllJobsToCloud(true);
            }
        }
    }

    function syncPmPlansFromLocationsMap() {
        if (isSyncingPmInternal) return false;
        loadPmPlansFromStorage();

        const locMap = getTechLocationsMap();
        const incomingList = [];

        Object.keys(locMap).forEach(k => {
            if (!k.startsWith(PM_LOC_PREFIX)) return;
            const pMap = locMap[k]?.pmPlansMap;
            if (pMap && typeof pMap === 'object') {
                Object.values(pMap).forEach(item => {
                    if (item && item.id) incomingList.push(item);
                });
            }
        });

        if (incomingList.length === 0) return false;
        const beforeSig = JSON.stringify(pmPlans);
        const merged = prunePmPlansArray([...pmPlans, ...incomingList]);
        if (JSON.stringify(merged) !== beforeSig) {
            pmPlans = merged;
            localStorage.setItem(PM_STORAGE_KEY, JSON.stringify(pmPlans));
            if (typeof refreshPmAllViews === 'function') refreshPmAllViews();
            checkAndTriggerScheduledPmAlerts(false);
            return true;
        }
        return false;
    }

    function getVirtualScadaDueItems() {
        if (!showScadaDuePins) return [];
        try {
            const pins = JSON.parse(rawGet('elec_labeled_places_list') || '[]');
            const delMap = JSON.parse(rawGet('elec_deleted_labeled_places_map') || '{}');
            const role = rawGet('elec_app_current_role') || 'user';
            const myGrp = (typeof getCurrentUserGroup === 'function' ? getCurrentUserGroup() : '') ||
                          rawGet('elec_app_current_group') || '';

            return pins.filter(p => {
                if (!p || !p.id || !p.dueDate || delMap[p.id]) return false;
                if (role === 'admin' && !myGrp) return true;
                return (p.ownerGroup || 'กฟส.บึง').trim() === getActivePmGroup();
            }).map(p => ({
                id: 'scada_due_' + p.id,
                isScadaPinDue: true,
                linkedPinId: p.id,
                title: `ครบกำหนดหมุด: ${p.name}`,
                category: 'scada',
                pinColor: 'auto',
                date: String(p.dueDate).trim(),
                timeSlot: '08.30 น.',
                notifyDaysBefore: 3,
                equipCode: p.name || '',
                feeder: p.scadaNode?.fd || '',
                note: p.note || 'ตั้งเตือนวันครบกำหนดจากผังอุปกรณ์ไฟฟ้า',
                lat: parseFloat(p.lat),
                lon: parseFloat(p.lon),
                gpsLink: `https://www.google.com/maps?q=${Number(p.lat).toFixed(6)},${Number(p.lon).toFixed(6)}`,
                ownerGroup: (p.ownerGroup || 'กฟส.บึง').trim(),
                status: 'pending'
            }));
        } catch (e) {
            return [];
        }
    }

    function getAllVisibleCalendarItems() {
        loadPmPlansFromStorage();
        const realVisible = pmPlans.filter(canSeePmPlan);
        const virtualPins = getVirtualScadaDueItems();
        return [...realVisible, ...virtualPins].sort((a, b) => {
            if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
            const dCmp = String(a.date || '').localeCompare(String(b.date || ''));
            if (dCmp !== 0) return dCmp;
            return String(a.timeSlot || '').localeCompare(String(b.timeSlot || ''));
        });
    }

    // คัดกรองรายการที่มีพิกัดสำหรับนำไปปักแสดงเป็น "หมุดแผนงาน" บนแผนที่
    function getPlottablePmMapPins(forExternalMap = true) {
        const todayIso = getTodayIso();
        return getAllVisibleCalendarItems().filter(item => {
            if (item.isScadaPinDue && forExternalMap) return false;
            if (item.status === 'done') return false;
            if (isNaN(parseFloat(item.lat)) || isNaN(parseFloat(item.lon))) return false;
            if (pmMapFilterMode === 'alert') {
                const daysLeft = calcDaysUntil(item.date, todayIso);
                return daysLeft <= Number(item.notifyDaysBefore ?? 3);
            }
            return true;
        });
    }

    // ========================================================================
    // 3. ระบบแจ้งเตือนอัตโนมัติ 2 รอบ (00.00 น. และ 07.00 น.)
    // ========================================================================
    function getAlertCandidatesForToday() {
        const todayIso = getTodayIso();
        return getAllVisibleCalendarItems()
            .filter(item => item.status !== 'done' && item.date)
            .map(item => {
                const daysLeft = calcDaysUntil(item.date, todayIso);
                const warnDays = Number(item.notifyDaysBefore ?? 3);
                let alertLevel = null;
                if (daysLeft < 0) alertLevel = 'overdue';
                else if (daysLeft === 0) alertLevel = 'today';
                else if (daysLeft <= warnDays) alertLevel = 'upcoming';
                return alertLevel ? { ...item, daysLeft, alertLevel } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.daysLeft - b.daysLeft);
    }

    function getCurrentAlertRoundInfo() {
        const now = new Date();
        const isMorning = now.getHours() >= 7;
        return {
            slotKey: `${toLocalIsoDate(now)}_${isMorning ? '07' : '00'}`,
            roundTitle: isMorning
                ? '🌅 แจ้งเตือนหมุดแผนงานบำรุงรักษารอบเช้า (07.00 น.)'
                : '🌙 แจ้งเตือนหมุดแผนงานบำรุงรักษารอบเที่ยงคืน (00.00 น.)'
        };
    }

    function getAckLogMap() {
        try { return JSON.parse(rawGet(PM_ACK_LOG_KEY) || '{}'); } catch (e) { return {}; }
    }

    function acknowledgeCurrentPmAlertRound() {
        const curUser = (rawGet('elec_app_current_user') || 'guest').trim();
        const { slotKey } = getCurrentAlertRoundInfo();
        const ackMap = getAckLogMap();
        ackMap[`${curUser}__${getActivePmGroup()}__${slotKey}`] = getAlertCandidatesForToday().map(c => c.id);
        const keys = Object.keys(ackMap);
        if (keys.length > 80) keys.slice(0, keys.length - 80).forEach(k => delete ackMap[k]);
        localStorage.setItem(PM_ACK_LOG_KEY, JSON.stringify(ackMap));
        document.getElementById('pmAlertPopupModal')?.classList.add('hidden');
        showToast('✅ รับทราบการแจ้งเตือนแผนงานรอบนี้แล้ว');
    }

    function playPmAlertChime() {
        if (!isPmSoundEnabled || (Core && Core.isEmbeddedIframe)) return;
        try {
            if (navigator.vibrate) navigator.vibrate([220, 100, 220]);
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            if (ctx.state === 'suspended') ctx.resume();
            [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.14);
                gain.gain.setValueAtTime(0.16, ctx.currentTime + idx * 0.14);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.14 + 0.28);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(ctx.currentTime + idx * 0.14);
                osc.stop(ctx.currentTime + idx * 0.14 + 0.28);
            });
            setTimeout(() => { if (ctx?.close) ctx.close().catch(() => {}); }, 1200);
        } catch (e) {}
    }

    function checkAndTriggerScheduledPmAlerts(forceShow = false) {
        if (rawGet('elec_app_logged_in') !== 'true' || (Core && Core.isEmbeddedIframe)) return;
        const candidates = getAlertCandidatesForToday();
        if (typeof updatePmHeaderBadgesAndStrip === 'function') updatePmHeaderBadgesAndStrip(candidates);
        if (candidates.length === 0) return;

        const curUser = (rawGet('elec_app_current_user') || 'guest').trim();
        const { slotKey, roundTitle } = getCurrentAlertRoundInfo();
        const ackedIds = new Set(getAckLogMap()[`${curUser}__${getActivePmGroup()}__${slotKey}`] || []);
        if (!forceShow && !candidates.some(c => !ackedIds.has(c.id))) return;

        playPmAlertChime();
        if ('Notification' in window && Notification.permission === 'granted') {
            try {
                new Notification(roundTitle, {
                    body: `${getActivePmGroup()}: มีแผนบำรุงรักษา ${candidates.length} รายการ (1. ${candidates[0]?.title || ''})`,
                    tag: 'pea-pm-alert-' + slotKey
                });
            } catch (e) {}
        }
        if (typeof showPmAlertSummaryModal === 'function') showPmAlertSummaryModal(roundTitle, candidates);
    }
    // ===== จบพาทที่ 1 / 3 ของไฟล์ pm-calendar.js (นำพาทที่ 2 / 3 มาวางต่อจากบรรทัดนี้ได้เลยครับ) =====
        // ===== เริ่มพาทที่ 2 / 3 ของไฟล์ pm-calendar.js (วางต่อจากพาทที่ 1 / 3) =====

    // ========================================================================
    // 4. สไตล์ชีตหมุดแผนงาน, ปุ่มบนแถบเมนู & แถบคิวแผนงานในหน้าช่าง
    // ========================================================================
    function injectPmCalendarStyles() {
        if (document.getElementById('peaPmCalendarStyles')) return;
        const st = document.createElement('style');
        st.id = 'peaPmCalendarStyles';
        st.textContent = `
            .pm-day-cell { min-height: 60px; transition: all 0.15s ease; }
            @media (min-width: 640px) { .pm-day-cell { min-height: 76px; } }
            .pm-day-cell:hover { background-color: #f0f9ff; border-color: #60a5fa; }
            .pm-day-selected { background-color: #eff6ff !important; border-color: #2563eb !important; box-shadow: inset 0 0 0 1.5px #2563eb; }
            .pm-badge-pulse { animation: pmPulseGlow 1.8s infinite ease-in-out; }
            @keyframes pmPulseGlow { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.06); } }

            /* สไตล์หมุดแผนงานบำรุงรักษา (PM Plan Pin) บนแผนที่ */
            .pm-plan-pin-wrap { position: relative; width: 34px; height: 40px; display: flex; flex-direction: column; align-items: center; }
            .pm-plan-pin-head { position: relative; z-index: 2; width: 30px; height: 30px; border-radius: 10px 10px 10px 3px; transform: rotate(-45deg); border: 2.5px solid #ffffff; box-shadow: 0 4px 10px rgba(15,23,42,0.45); display: flex; align-items: center; justify-content: center; }
            .pm-plan-pin-head > span { transform: rotate(45deg); font-size: 15px; line-height: 1; }
            .pm-plan-pin-date { position: absolute; top: -9px; right: -12px; z-index: 4; background: #0f172a; color: #fde047; border: 1.5px solid #ffffff; border-radius: 9999px; padding: 0 4px; font-size: 8.5px; font-weight: 800; line-height: 13px; white-space: nowrap; box-shadow: 0 2px 5px rgba(0,0,0,0.4); }
            .pm-plan-pin-pulse { position: absolute; top: -3px; left: -1px; width: 36px; height: 36px; border-radius: 9999px; animation: pmPinRingWave 1.7s infinite ease-out; pointer-events: none; z-index: 1; }
            @keyframes pmPinRingWave { 0% { transform: scale(0.8); opacity: 0.9; } 100% { transform: scale(1.65); opacity: 0; } }
            .pm-plan-pin-moving .pm-plan-pin-head { box-shadow: 0 0 0 4px #22d3ee, 0 6px 14px rgba(0,0,0,0.5) !important; }
            .pm-plan-tooltip { background: rgba(15,23,42,0.93) !important; color: #f8fafc !important; border: 1.5px solid #818cf8 !important; border-radius: 0.5rem !important; padding: 2px 7px !important; font-family: 'Prompt',sans-serif !important; font-size: 10.5px !important; font-weight: 700 !important; }
            .pm-pin-drop-active-map { cursor: crosshair !important; }
            body.role-viewer-readonly .pm-edit-only, body.scada-sim-active .pm-edit-only { display: none !important; }
        `;
        document.head.appendChild(st);
    }

    function injectPmButtonsIntoScadaToolbar() {
        const scadaBar = document.getElementById('scadaControlToolbar');
        if (!scadaBar) return;
        const rightGroup = scadaBar.querySelector('.flex.items-center.gap-1\\.5.flex-wrap:last-child');
        if (!rightGroup) return;

        if (!document.getElementById('btnTogglePmMapPins')) {
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.id = 'btnTogglePmMapPins';
            toggleBtn.onclick = () => toggleShowPmPinsOnMaps();
            rightGroup.insertBefore(toggleBtn, rightGroup.firstChild);
        }
        if (!document.getElementById('btnDropNewPmPinOnScada')) {
            const dropBtn = document.createElement('button');
            dropBtn.type = 'button';
            dropBtn.id = 'btnDropNewPmPinOnScada';
            dropBtn.onclick = () => togglePmPinDropMode(undefined, 'scada');
            rightGroup.insertBefore(dropBtn, document.getElementById('btnTogglePmMapPins').nextSibling);
        }
        updateScadaToolbarPmButtonsUI();
    }

    function updateScadaToolbarPmButtonsUI() {
        const pinCount = getPlottablePmMapPins(true).length;
        const toggleBtn = document.getElementById('btnTogglePmMapPins');
        if (toggleBtn) {
            toggleBtn.textContent = showPmPinsOnMaps ? `📅 หมุดแผน (${pinCount})` : '📅 หมุดแผน: ซ่อน';
            toggleBtn.className = showPmPinsOnMaps
                ? 'bg-indigo-700 hover:bg-indigo-600 text-indigo-100 border border-indigo-400/60 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow transition'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-600 px-2.5 py-1 rounded-xl text-[11px] font-bold transition';
        }
        const dropBtn = document.getElementById('btnDropNewPmPinOnScada');
        if (dropBtn) {
            dropBtn.style.display = canManagePmSchedule() ? '' : 'none';
            dropBtn.textContent = pmPinDropModeActive ? '❌ ยกเลิกปักแผน' : '📍 ปักหมุดแผน';
            dropBtn.className = pmPinDropModeActive
                ? 'pm-edit-only bg-amber-400 text-slate-950 border border-white px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow animate-pulse'
                : 'pm-edit-only bg-indigo-500 hover:bg-indigo-400 text-white px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow transition';
        }
    }

    function injectPmHeaderButtonsAndStrip() {
        const mainHeaderGrp = document.querySelector('#mainAppContent .bg-gradient-to-r .flex.items-center.gap-1\\.5.shrink-0');
        if (mainHeaderGrp && !document.getElementById('pmMainHeaderBtn')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'pmMainHeaderBtn';
            btn.onclick = () => openPmCalendarModal();
            btn.className = 'bg-indigo-500/90 hover:bg-indigo-600 text-white px-2.5 py-1.5 rounded-xl text-xs transition shadow-sm flex items-center gap-1 font-semibold border border-indigo-300/40';
            btn.innerHTML = `📅 <span>แผน PM</span><span id="pmMainAlertCountBadge" class="hidden bg-rose-500 text-white text-[10px] font-extrabold px-1.5 rounded-full">0</span>`;
            const backupBtn = mainHeaderGrp.querySelector('button[onclick="openBackupModal()"]');
            if (backupBtn) mainHeaderGrp.insertBefore(btn, backupBtn);
            else mainHeaderGrp.appendChild(btn);
        }

        const techHeaderGrp = document.querySelector('#techMainApp .bg-gradient-to-r .flex.flex-wrap.items-center.gap-1\\.5');
        if (techHeaderGrp && !document.getElementById('pmTechHeaderBtn')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'pmTechHeaderBtn';
            btn.onclick = () => openPmCalendarModal();
            btn.className = 'bg-indigo-500/90 hover:bg-indigo-600 text-white px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm flex items-center gap-1 border border-indigo-300/40';
            btn.innerHTML = `📅 <span>แผน PM</span><span id="pmTechAlertCountBadge" class="hidden bg-rose-500 text-white text-[10px] font-extrabold px-1.5 rounded-full">0</span>`;
            techHeaderGrp.insertBefore(btn, techHeaderGrp.firstChild);
        }

        const jobCardsEl = document.getElementById('jobCardsContainer');
        if (jobCardsEl?.parentElement && !document.getElementById('pmTechQueueBannerWrap')) {
            const wrap = document.createElement('div');
            wrap.id = 'pmTechQueueBannerWrap';
            wrap.className = 'hidden px-4 pt-2 pb-1';
            const anchor = document.getElementById('repairJobsMapSection') || jobCardsEl;
            jobCardsEl.parentElement.insertBefore(wrap, anchor);
        }
        injectPmButtonsIntoScadaToolbar();
    }

    function togglePmTechStripCollapse() {
        isTechStripCollapsed = !isTechStripCollapsed;
        updatePmHeaderBadgesAndStrip();
    }

    function updatePmHeaderBadgesAndStrip(preCandidates = null) {
        injectPmHeaderButtonsAndStrip();
        const candidates = preCandidates || getAlertCandidatesForToday();
        const urgentCnt = candidates.filter(c => c.daysLeft <= 0).length;

        ['pmMainAlertCountBadge', 'pmTechAlertCountBadge'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            if (candidates.length > 0) {
                el.textContent = String(candidates.length);
                el.className = `${urgentCnt > 0 ? 'bg-rose-500 pm-badge-pulse' : 'bg-amber-400 text-slate-950'} text-[10px] font-extrabold px-1.5 rounded-full shadow`;
                el.classList.remove('hidden');
            } else el.classList.add('hidden');
        });

        const stripWrap = document.getElementById('pmTechQueueBannerWrap');
        if (!stripWrap) return;
        if (candidates.length === 0 || rawGet('elec_app_logged_in') !== 'true') {
            stripWrap.classList.add('hidden');
            stripWrap.innerHTML = '';
            return;
        }

        stripWrap.classList.remove('hidden');
        const rowsHtml = isTechStripCollapsed ? '' : `<div class="p-2.5 space-y-1.5 bg-white max-h-48 overflow-y-auto">${candidates.slice(0, 6).map(item => {
            const cat = getCategoryMeta(item.category);
            const safeId = String(item.id).replace(/'/g, "\\'");
            const hasCoord = !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lon));
            const badge = item.daysLeft < 0
                ? `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-extrabold px-1.5 py-0.5 rounded">เลย ${Math.abs(item.daysLeft)} วัน</span>`
                : (item.daysLeft === 0 ? `<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-1.5 py-0.5 rounded">📌 วันนี้</span>` : `<span class="bg-sky-50 text-sky-700 border border-sky-200 text-[10px] font-bold px-1.5 py-0.5 rounded">อีก ${item.daysLeft} วัน</span>`);
            return `<div class="p-2 rounded-xl border border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2 text-xs"><div class="min-w-0 flex-1"><div class="flex items-center gap-1.5 flex-wrap">${badge}<span class="font-bold text-slate-800 truncate">${cat.icon} ${escapeHtmlStr(item.title)}</span></div>${item.equipCode ? `<div class="text-[10px] text-teal-700 font-semibold mt-0.5">⚡ ${escapeHtmlStr(item.equipCode)}</div>` : ''}</div><div class="flex items-center gap-1 shrink-0">${hasCoord ? `<button type="button" onclick="focusPmPlanPinOnMap('${safeId}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-1 rounded-lg text-[10px] font-bold">📍 ดูหมุด</button><button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">🗺️ นำทาง</button>` : ''}${(!item.isScadaPinDue && canCompletePmTask()) ? `<button type="button" onclick="togglePmPlanCompleteStatus('${safeId}')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-1 rounded-lg text-[10px] font-bold">✅ เสร็จ</button>` : ''}</div></div>`;
        }).join('')}</div>`;

        stripWrap.innerHTML = `<div class="rounded-2xl border-2 border-indigo-400/80 overflow-hidden shadow-sm bg-white"><div class="bg-gradient-to-r from-indigo-900 via-blue-900 to-teal-800 px-3 py-2 text-white flex items-center justify-between gap-2"><div onclick="openPmCalendarModal()" class="cursor-pointer flex items-center gap-1.5 min-w-0 flex-1"><span>📅</span><span class="text-xs font-extrabold truncate">หมุดแผนบำรุงรักษา (PM): แจ้งเตือน ${candidates.length} รายการ</span></div><div class="flex items-center gap-1 shrink-0"><button type="button" onclick="openPmCalendarModal()" class="bg-white/20 hover:bg-white/30 text-white px-2 py-0.5 rounded-lg text-[10px] font-bold">ปฏิทิน/แมพ</button><button type="button" onclick="togglePmTechStripCollapse()" class="bg-white/15 hover:bg-white/25 text-white px-2 py-0.5 rounded-lg text-[10px] font-bold">${isTechStripCollapsed ? '🔽 ขยาย' : '🔼 ย่อ'}</button></div></div>${rowsHtml}</div>`;
    }

    // ========================================================================
    // 5. เอนจินวาด "หมุดแผนงาน" บนแผนที่ (SCADA Map / แผนที่งานซ่อม / แผนที่ปฏิทิน)
    // ========================================================================
    function buildPmPlanMarkerIcon(item, isMovingThis = false) {
        const vis = getPlanPinVisualTheme(item);
        const daysLeft = calcDaysUntil(item.date, getTodayIso());
        const isUrgent = item.status !== 'done' && daysLeft <= 0;
        const pulseColor = daysLeft < 0 ? 'rgba(225,29,72,0.58)' : 'rgba(245,158,11,0.58)';
        const pulseHtml = isUrgent ? `<div class="pm-plan-pin-pulse" style="background:${pulseColor};"></div>` : '';
        const dateTag = formatThaiDayMonthShort(item.date);
        const doneStyle = item.status === 'done' ? 'opacity:0.55;filter:grayscale(0.5);' : '';

        return L.divIcon({
            className: isMovingThis ? 'pm-plan-pin-moving' : '',
            html: `<div class="pm-plan-pin-wrap" style="${doneStyle}">${pulseHtml}<div class="pm-plan-pin-date">${escapeHtmlStr(dateTag)}</div><div class="pm-plan-pin-head" style="background:${vis.grad};"><span>${vis.icon}</span></div></div>`,
            iconSize: [34, 40],
            iconAnchor: [17, 34],
            popupAnchor: [0, -32]
        });
    }

    function buildPmPlanPopupHtml(item) {
        const vis = getPlanPinVisualTheme(item);
        const daysLeft = calcDaysUntil(item.date, getTodayIso());
        const isDone = item.status === 'done';
        const safeId = String(item.id).replace(/'/g, "\\'");
        const statusTag = isDone
            ? '<span class="bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">✅ เสร็จสิ้นแล้ว</span>'
            : (daysLeft < 0
                ? `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">🚨 เลยกำหนด ${Math.abs(daysLeft)} วัน</span>`
                : (daysLeft === 0
                    ? '<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">📌 กำหนดวันนี้</span>'
                    : `<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-2 py-0.5 rounded-full">🗓️ อีก ${daysLeft} วัน</span>`));

        const allowEdit = !item.isScadaPinDue && canManagePmSchedule();
        const allowDone = !item.isScadaPinDue && canCompletePmTask();

        return `
            <div style="font-family:'Prompt',sans-serif;min-width:240px;" class="space-y-1.5 text-xs">
                <div class="flex items-center justify-between gap-1">
                    <span class="px-2 py-0.5 rounded text-white text-[10px] font-extrabold" style="background:${vis.hex}">${vis.icon} หมุดแผนงาน PM</span>
                    ${statusTag}
                </div>
                <div class="font-extrabold text-slate-900 text-sm break-words pt-0.5">${escapeHtmlStr(item.title)}</div>
                <div class="text-[11px] text-slate-600 space-y-0.5">
                    <div>📅 <b>วันที่:</b> ${formatThaiDateFull(item.date)} (${escapeHtmlStr(item.timeSlot || '-')})</div>
                    ${item.equipCode ? `<div>⚡ <b>อุปกรณ์:</b> ${escapeHtmlStr(item.equipCode)} ${item.feeder ? `(วงจร ${escapeHtmlStr(item.feeder)})` : ''}</div>` : ''}
                    ${item.note ? `<div>📝 <b>รายละเอียด:</b> ${escapeHtmlStr(item.note)}</div>` : ''}
                    <div class="text-[10px] text-slate-400">📍 ${Number(item.lat).toFixed(6)}, ${Number(item.lon).toFixed(6)}</div>
                </div>
                <div class="pt-1.5 border-t border-slate-200 grid grid-cols-2 gap-1">
                    <button type="button" onclick="navigatePmPlanGps('${safeId}')" style="background:#2563eb;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;">🗺️ นำทาง Maps</button>
                    <button type="button" onclick="shareSinglePmPlanToLine('${safeId}')" style="background:#00B900;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;">💬 แชร์ LINE</button>
                    ${allowDone ? `<button type="button" onclick="togglePmPlanCompleteStatus('${safeId}')" class="col-span-2" style="background:${isDone ? '#64748b' : '#059669'};color:#fff;padding:5px 8px;border-radius:8px;font-weight:800;font-size:11px;">${isDone ? '↩️ คืนสถานะรอดำเนินการ' : '✅ บันทึกดำเนินงานเสร็จสิ้น'}</button>` : ''}
                    ${allowEdit ? `<button type="button" onclick="openPmPlanFormModal('${safeId}')" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;padding:4px 8px;border-radius:8px;font-weight:700;font-size:10.5px;">✏️ แก้ไขแผน</button><button type="button" onclick="startMovePmPlanPinOnMap('${safeId}')" style="background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;padding:4px 8px;border-radius:8px;font-weight:700;font-size:10.5px;">📍 ย้ายจุดหมุด</button>` : ''}
                </div>
            </div>`;
    }

    function renderPmPinsOnTargetMap(mapInstance, layerGroup, storeObj, forExternalMap = true) {
        if (!mapInstance || !layerGroup || typeof L === 'undefined') return;
        layerGroup.clearLayers();
        Object.keys(storeObj).forEach(k => delete storeObj[k]);

        if (forExternalMap && !showPmPinsOnMaps) return;
        const items = forExternalMap
            ? getPlottablePmMapPins(true)
            : getAllVisibleCalendarItems().filter(i => !isNaN(parseFloat(i.lat)) && !isNaN(parseFloat(i.lon)));

        const coordCount = {};
        items.forEach(item => {
            const baseLat = parseFloat(item.lat), baseLon = parseFloat(item.lon);
            if (isNaN(baseLat) || isNaN(baseLon)) return;

            // เยื้องพิกัดเล็กน้อยอัตโนมัติหากสร้างทับบนหมุดสวิตช์ SCADA เพื่อให้คลิกได้ทั้งคู่ไม่บังกัน
            const cKey = `${baseLat.toFixed(4)}_${baseLon.toFixed(4)}`;
            const idx = coordCount[cKey] || (item.linkedPinId && forExternalMap ? 1 : 0);
            coordCount[cKey] = idx + 1;
            const ang = (idx * 55) * (Math.PI / 180);
            const rad = idx > 0 ? 0.00011 * Math.ceil(idx / 5) : 0;
            const dispLat = baseLat + Math.sin(ang) * rad;
            const dispLon = baseLon + Math.cos(ang) * rad;

            const isMoving = (pmPinMoveTargetId === item.id);
            const marker = L.marker([dispLat, dispLon], {
                icon: buildPmPlanMarkerIcon(item, isMoving),
                draggable: isMoving && canManagePmSchedule(),
                zIndexOffset: 760
            });

            const vis = getPlanPinVisualTheme(item);
            marker.bindTooltip(`${vis.icon} ${escapeHtmlStr(item.title)} (${formatThaiDayMonthShort(item.date)})`, {
                direction: 'top',
                offset: [0, -32],
                className: 'pm-plan-tooltip'
            });
            marker.bindPopup(buildPmPlanPopupHtml(item));

            if (isMoving) {
                marker.on('dragend', (ev) => {
                    const ll = ev.target.getLatLng();
                    commitMovedPmPlanPinLocation(item.id, ll.lat, ll.lng);
                });
            }

            marker.addTo(layerGroup);
            storeObj[item.id] = marker;
        });
    }

    function renderAllExternalPmMapLayers() {
        injectPmButtonsIntoScadaToolbar();
        updateScadaToolbarPmButtonsUI();
        if (scadaMapRef && scadaPmLayer) renderPmPinsOnTargetMap(scadaMapRef, scadaPmLayer, scadaPmMarkersById, true);
        if (repairMapRef && repairPmLayer) renderPmPinsOnTargetMap(repairMapRef, repairPmLayer, repairPmMarkersById, true);
        if (calendarMapInstance && calendarPmLayer) renderPmPinsOnTargetMap(calendarMapInstance, calendarPmLayer, calendarPmMarkersById, false);
    }

    function toggleShowPmPinsOnMaps() {
        showPmPinsOnMaps = !showPmPinsOnMaps;
        localStorage.setItem(PM_SHOW_MAP_PINS_KEY, String(showPmPinsOnMaps));
        renderAllExternalPmMapLayers();
        showToast(showPmPinsOnMaps ? '📅 แสดงหมุดแผนงานบำรุงรักษาบนแผนที่แล้ว' : '🚫 ซ่อนหมุดแผนงานบำรุงรักษาชั่วคราว');
    }

    function cyclePmMapFilterMode() {
        pmMapFilterMode = pmMapFilterMode === 'pending' ? 'alert' : 'pending';
        localStorage.setItem(PM_MAP_FILTER_MODE_KEY, pmMapFilterMode);
        renderAllExternalPmMapLayers();
        const btn = document.getElementById('pmCalMapFilterBtn');
        if (btn) btn.textContent = pmMapFilterMode === 'alert' ? '🔔 กรอง: เฉพาะใกล้ถึง/เลยกำหนด' : '📋 กรอง: แผนรอดำเนินการทั้งหมด';
        showToast(pmMapFilterMode === 'alert' ? '🔔 แสดงเฉพาะหมุดแผนงานที่ถึงระยะเตือนล่วงหน้า' : '📋 แสดงหมุดแผนงานที่รอดำเนินการทั้งหมด');
    }

    function updatePinDropBannerOnMaps() {
        document.querySelectorAll('.pm-pin-drop-banner').forEach(el => el.remove());
        ['labeledInteractiveMap', 'pmCalendarEmbeddedMap'].forEach(id => {
            document.getElementById(id)?.classList.toggle('pm-pin-drop-active-map', pmPinDropModeActive || Boolean(pmPinMoveTargetId));
        });
        updateScadaToolbarPmButtonsUI();
        const calDropBtn = document.getElementById('btnCalMapDropPin');
        if (calDropBtn) {
            calDropBtn.textContent = pmPinDropModeActive ? '❌ ยกเลิกปักหมุด' : '📍 จิ้มปักหมุดแผนใหม่';
            calDropBtn.className = pmPinDropModeActive
                ? 'pointer-events-auto bg-amber-400 text-slate-950 border border-white px-3 py-1.5 rounded-xl text-[11px] font-extrabold shadow-lg animate-pulse'
                : 'pm-edit-only pointer-events-auto bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-xl text-[11px] font-extrabold shadow-lg';
        }

        if (!pmPinDropModeActive && !pmPinMoveTargetId) return;
        const msg = pmPinMoveTargetId
            ? '📍 โหมดย้ายหมุดแผนงาน: ลากหมุดที่กระพริบ หรือแตะจุดใหม่บนแผนที่เพื่อวาง'
            : '📍 โหมดปักหมุดแผนงาน: แตะจุดที่ต้องการบนแผนที่เพื่อสร้างแผนงานใหม่';

        [document.getElementById('labeledInteractiveMap')?.parentElement, document.getElementById('pmCalendarEmbeddedMap')?.parentElement]
            .filter(Boolean)
            .forEach(wrap => {
                const b = document.createElement('div');
                b.className = 'pm-pin-drop-banner absolute top-3 left-1/2 -translate-x-1/2 z-[500] bg-indigo-950/95 text-amber-300 border border-amber-400 px-3 py-1.5 rounded-full text-[11px] font-extrabold shadow-xl flex items-center gap-2 whitespace-nowrap';
                b.innerHTML = `<span>${msg}</span><button type="button" onclick="cancelPmMapInteractiveModes()" class="bg-rose-600 text-white px-2 py-0.5 rounded-full text-[10px]">ยกเลิก</button>`;
                wrap.appendChild(b);
            });
    }

    function cancelPmMapInteractiveModes() {
        pmPinDropModeActive = false;
        pmPinMoveTargetId = null;
        updatePinDropBannerOnMaps();
        renderAllExternalPmMapLayers();
    }

    function togglePmPinDropMode(forceState, targetMapType = 'scada') {
        if (!canManagePmSchedule()) {
            showToast('🔒 เฉพาะแอดมินและผู้ใช้งานทั่วไปเท่านั้นที่ปักหมุดแผนงานได้');
            return;
        }
        pmPinMoveTargetId = null;
        pmPinDropModeActive = typeof forceState === 'boolean' ? forceState : !pmPinDropModeActive;
        if (pmPinDropModeActive && targetMapType === 'scada') {
            if (typeof window.toggleScadaDrawMode === 'function') window.toggleScadaDrawMode(false);
            if (typeof window.toggleScadaWireMoveMode === 'function') window.toggleScadaWireMoveMode(false);
            if (typeof window.toggleScadaPinMoveMode === 'function') window.toggleScadaPinMoveMode(false);
        }
        updatePinDropBannerOnMaps();
        if (pmPinDropModeActive) showToast('👆 แตะจุดที่ต้องการบนแผนที่เพื่อปักหมุดแผนงานได้เลย');
    }

    function startMovePmPlanPinOnMap(planId) {
        if (!canManagePmSchedule()) return;
        pmPinDropModeActive = false;
        pmPinMoveTargetId = planId;
        scadaMapRef?.closePopup();
        repairMapRef?.closePopup();
        calendarMapInstance?.closePopup();
        updatePinDropBannerOnMaps();
        renderAllExternalPmMapLayers();
        showToast('📍 ลากหมุดแผนงาน หรือแตะตำแหน่งใหม่บนแผนที่ได้เลย');
    }

    async function commitMovedPmPlanPinLocation(planId, newLat, newLon) {
        loadPmPlansFromStorage();
        const idx = pmPlans.findIndex(p => p.id === planId && !p.pmDeleted);
        if (idx === -1) return cancelPmMapInteractiveModes();

        pmPlans[idx].lat = Number(Number(newLat).toFixed(6));
        pmPlans[idx].lon = Number(Number(newLon).toFixed(6));
        pmPlans[idx].gpsLink = `https://www.google.com/maps?q=${pmPlans[idx].lat.toFixed(6)},${pmPlans[idx].lon.toFixed(6)}`;
        pmPlans[idx].updatedAt = new Date().toISOString();
        pmPinMoveTargetId = null;

        updatePinDropBannerOnMaps();
        await savePmPlansAndSync(true);
        showToast(`📍 ย้ายตำแหน่งหมุด "${pmPlans[idx].title}" เรียบร้อยแล้ว`);
    }

    async function focusPmPlanPinOnMap(itemId) {
        const item = getAllVisibleCalendarItems().find(x => x.id === itemId);
        if (!item || isNaN(parseFloat(item.lat)) || isNaN(parseFloat(item.lon))) {
            showToast('⚠️ แผนงานนี้ยังไม่ได้ระบุพิกัดหมุดบนแผนที่');
            return;
        }
        const lat = parseFloat(item.lat), lon = parseFloat(item.lon);

        // หากอยู่ในหน้าช่าง (page2.html) ให้สลับไปซูมดูบนแผนที่ผัง SCADA ทันที
        if (document.getElementById('techMainApp') && typeof window.switchTechMainTab === 'function') {
            closePmCalendarModal();
            document.getElementById('pmAlertPopupModal')?.classList.add('hidden');
            showPmPinsOnMaps = true;
            localStorage.setItem(PM_SHOW_MAP_PINS_KEY, 'true');
            window.switchTechMainTab('map');
            setTimeout(() => {
                renderAllExternalPmMapLayers();
                if (scadaMapRef) {
                    scadaMapRef.invalidateSize();
                    scadaMapRef.setView([lat, lon], 17);
                    scadaPmMarkersById[item.id]?.openPopup();
                }
            }, 220);
            return;
        }

        // หากอยู่ในหน้าหลัก (index.html) ให้เปิดแท็บแผนที่ภายในหน้าต่างปฏิทินแล้วซูมไปยังหมุดทันที
        openPmCalendarModal(item.date);
        await switchCalendarLeftViewMode('map');
        setTimeout(() => {
            if (calendarMapInstance) {
                calendarMapInstance.invalidateSize();
                calendarMapInstance.setView([lat, lon], 16);
                calendarPmMarkersById[item.id]?.openPopup();
            }
        }, 180);
    }

    function createPmPlanFromScadaPinPopup(scadaPinId) {
        if (!canManagePmSchedule()) return;
        scadaMapRef?.closePopup();
        openPmPlanFormModal(null, selectedDateIso || getTodayIso(), null, null, scadaPinId);
    }

    function bindSingleLeafletMapEvents(map) {
        if (!map || map.__pmHookBound) return;
        const containerId = map.getContainer?.()?.id || '';
        if (containerId !== 'labeledInteractiveMap' && containerId !== 'repairJobsLeafletMap') return;
        map.__pmHookBound = true;

        if (containerId === 'labeledInteractiveMap') {
            scadaMapRef = map;
            scadaPmLayer = L.layerGroup().addTo(map);
            map.on('popupopen', (e) => {
                if (!canManagePmSchedule()) return;
                const el = e.popup?.getElement?.();
                const html = e.popup?.getContent?.();
                const m = typeof html === 'string' ? html.match(/openEquipPinModal\('([^']+)'\)/) : null;
                if (m && el && !el.querySelector('.pm-create-from-scada-btn')) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'pm-create-from-scada-btn pm-edit-only w-full mt-1.5 py-1.5 px-2 rounded-lg font-extrabold text-[10px] text-white bg-gradient-to-r from-indigo-600 to-violet-600 shadow-sm';
                    btn.innerHTML = '📅 สร้างหมุดแผนงาน PM ที่อุปกรณ์นี้';
                    btn.onclick = () => createPmPlanFromScadaPinPopup(m[1]);
                    (el.querySelector('.scada-popup-panel') || el.querySelector('.leaflet-popup-content > div'))?.appendChild(btn);
                }
            });
        } else if (containerId === 'repairJobsLeafletMap') {
            repairMapRef = map;
            repairPmLayer = L.layerGroup().addTo(map);
        }

        map.on('click', (e) => {
            if (!e.latlng) return;
            if (pmPinMoveTargetId) {
                commitMovedPmPlanPinLocation(pmPinMoveTargetId, e.latlng.lat, e.latlng.lng);
            } else if (pmPinDropModeActive && containerId === 'labeledInteractiveMap') {
                const { lat, lng } = e.latlng;
                cancelPmMapInteractiveModes();
                openPmPlanFormModal(null, selectedDateIso || getTodayIso(), lat, lng);
            }
        });

        setTimeout(renderAllExternalPmMapLayers, 120);
    }

    function bindLeafletMapHooks() {
        if (typeof L === 'undefined' || !L.Map || L.Map.__pmInitHookAdded) return;
        L.Map.__pmInitHookAdded = true;
        L.Map.addInitHook(function () {
            setTimeout(() => bindSingleLeafletMapEvents(this), 50);
        });
    }

    // ========================================================================
    // 6. สร้าง DOM หน้าต่างปฏิทิน (พร้อมแท็บแผนที่หมุดแผนงาน) & ฟอร์มมินิแมพ
    // ========================================================================
    function injectPmModalsDOM() {
        if (document.getElementById('pmCalendarModal')) return;

        const catOptions = Object.values(PM_CATEGORIES).map(c => `<option value="${c.key}">${c.icon} ${c.name}</option>`).join('');
        const pinColorBtns = Object.values(PM_PIN_COLORS).map(c => `
            <button type="button" id="pmFormColorBtn-${c.key}" onclick="selectPmFormPinColor('${c.key}')" class="px-2 py-1 rounded-lg border text-[10px] font-bold transition">${c.label}</button>
        `).join('');

        document.body.insertAdjacentHTML('beforeend', `
            <!-- 📅 หน้าต่างหลัก: ปฏิทิน & แผนที่หมุดแผนงานบำรุงรักษา -->
            <div id="pmCalendarModal" class="fixed inset-0 bg-slate-950/70 hidden z-[1320] flex items-center justify-center p-2 sm:p-4 backdrop-blur-sm">
                <div class="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[94dvh] overflow-hidden flex flex-col border border-slate-200">
                    <div class="px-4 py-3 bg-gradient-to-r from-indigo-900 via-blue-800 to-teal-700 text-white flex flex-wrap justify-between items-center gap-2 shrink-0">
                        <div class="flex items-center gap-2">
                            <span class="text-lg">📅</span>
                            <div>
                                <h3 class="font-bold text-sm sm:text-base flex items-center gap-2">
                                    <span>ปฏิทิน &amp; หมุดแผนงานบำรุงรักษา (PM)</span>
                                    <span id="pmHeaderGroupBadge" class="bg-white/20 text-amber-200 text-[10px] font-extrabold px-2 py-0.5 rounded-md">-</span>
                                </h3>
                                <p class="text-[10px] text-blue-100">แจ้งเตือนอัตโนมัติ 00.00 น. / 07.00 น. • ปักหมุดแผนงานและนำทาง GPS</p>
                            </div>
                        </div>
                        <div class="flex flex-wrap items-center gap-1.5">
                            <button type="button" id="pmNotifPermBtn" onclick="requestPmBrowserNotificationPermission()" class="bg-white/15 hover:bg-white/25 text-white px-2.5 py-1 rounded-xl text-[11px] font-bold">📲 แจ้งเตือนเครื่อง</button>
                            <button type="button" id="pmSoundToggleBtn" onclick="togglePmSoundSetting()" class="bg-white/15 hover:bg-white/25 text-white px-2.5 py-1 rounded-xl text-[11px] font-bold">🔔 เสียง: เปิด</button>
                            <button type="button" onclick="exportPmPlansToExcel()" class="bg-emerald-500 hover:bg-emerald-600 text-white px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow">📊 Excel</button>
                            <button type="button" onclick="shareDailyOrAlertSummaryToLine()" class="bg-[#00B900] hover:bg-[#009900] text-white px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow">💬 สรุปส่ง LINE</button>
                            <button type="button" onclick="closePmCalendarModal()" class="text-white/80 hover:text-white text-2xl font-bold leading-none px-1.5">&times;</button>
                        </div>
                    </div>

                    <div class="p-3 sm:p-4 overflow-y-auto flex-1 bg-slate-50 grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
                        <!-- ฝั่งซ้าย: สลับดู ตารางปฏิทินรายเดือน <-> แผนที่หมุดแผนงาน -->
                        <div class="lg:col-span-7 bg-white p-3 rounded-2xl border border-slate-200 shadow-sm space-y-2.5">
                            <div class="flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-slate-100">
                                <div class="inline-flex bg-slate-100 p-1 rounded-xl text-xs font-extrabold">
                                    <button type="button" id="pmViewTab-grid" onclick="switchCalendarLeftViewMode('grid')" class="px-3 py-1 rounded-lg bg-indigo-600 text-white shadow-sm">🗓️ ตารางปฏิทิน</button>
                                    <button type="button" id="pmViewTab-map" onclick="switchCalendarLeftViewMode('map')" class="px-3 py-1 rounded-lg text-slate-600">📍 แผนที่หมุดแผนงาน (<span id="pmCalMapPinCount">0</span>)</button>
                                </div>
                                <label class="flex items-center gap-1 text-[10px] font-bold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-1 rounded-lg cursor-pointer select-none">
                                    <input type="checkbox" id="pmShowScadaDueChk" onchange="toggleShowScadaDueOnCalendar(this.checked)" class="accent-teal-600 rounded">
                                    <span>รวมหมุดครบกำหนด SCADA</span>
                                </label>
                            </div>

                            <div id="pmMonthSummaryBar" class="grid grid-cols-4 gap-1.5 text-center text-[10px]"></div>

                            <!-- โหมด 1: ตารางปฏิทิน -->
                            <div id="pmCalendarGridPanel" class="space-y-2">
                                <div class="flex items-center justify-between gap-2">
                                    <div class="flex items-center gap-1">
                                        <button type="button" onclick="changePmCalendarMonth(-1)" class="px-2.5 py-1 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-extrabold">◀</button>
                                        <button type="button" onclick="jumpPmCalendarToday()" class="px-2.5 py-1 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-xs font-bold">วันนี้</button>
                                        <button type="button" onclick="changePmCalendarMonth(1)" class="px-2.5 py-1 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-extrabold">▶</button>
                                    </div>
                                    <h4 id="pmCalendarMonthTitle" class="text-sm sm:text-base font-extrabold text-slate-800">-</h4>
                                    <span class="text-[10px] text-slate-400">แตะวันเพื่อดูงาน</span>
                                </div>
                                <div class="grid grid-cols-7 gap-1 text-center text-[11px] font-extrabold text-slate-500">
                                    <div class="text-rose-500">อา.</div><div>จ.</div><div>อ.</div><div>พ.</div><div>พฤ.</div><div>ศ.</div><div class="text-indigo-600">ส.</div>
                                </div>
                                <div id="pmCalendarDaysGrid" class="grid grid-cols-7 gap-1"></div>
                            </div>

                            <!-- โหมด 2: แผนที่รวมหมุดแผนงาน (เปิดปัก/ดูหมุดได้ทั้งใน index.html และ page2.html) -->
                            <div id="pmCalendarMapPanel" class="hidden space-y-2">
                                <div class="relative isolate rounded-2xl overflow-hidden border-2 border-indigo-200 bg-slate-100">
                                    <div id="pmCalendarEmbeddedMap" class="w-full h-[320px] sm:h-[390px] z-0"></div>
                                    <div class="absolute bottom-2.5 left-2.5 right-2.5 z-[420] flex flex-wrap items-center justify-between gap-1.5 pointer-events-none">
                                        <button type="button" onclick="fitCalendarEmbeddedMapPins()" class="pointer-events-auto bg-white/95 hover:bg-white text-slate-800 border border-slate-300 px-2.5 py-1.5 rounded-xl text-[11px] font-bold shadow-lg">🎯 ซูมดูหมุดทั้งหมด</button>
                                        <button type="button" id="btnCalMapDropPin" onclick="togglePmPinDropMode(undefined, 'calendar')" class="pm-edit-only pointer-events-auto bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-xl text-[11px] font-extrabold shadow-lg">📍 จิ้มปักหมุดแผนใหม่</button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- ฝั่งขวา: รายการแผนงาน -->
                        <div class="lg:col-span-5 bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm flex flex-col space-y-2.5">
                            <div class="flex items-center justify-between gap-2">
                                <div class="grid grid-cols-3 gap-1 flex-1 bg-slate-100 p-1 rounded-xl text-[11px] font-bold">
                                    <button type="button" id="pmFilterBtn-day" onclick="setPmListStatusFilter('day')" class="py-1 rounded-lg">📌 วันที่เลือก</button>
                                    <button type="button" id="pmFilterBtn-alert" onclick="setPmListStatusFilter('alert')" class="py-1 rounded-lg">🔔 แจ้งเตือน</button>
                                    <button type="button" id="pmFilterBtn-all" onclick="setPmListStatusFilter('all')" class="py-1 rounded-lg">📋 ทั้งเดือน</button>
                                </div>
                                <button type="button" id="pmAddPlanPrimaryBtn" onclick="openPmPlanFormModal(null, selectedDateIso)" class="pm-edit-only shrink-0 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-xl text-xs font-extrabold shadow-sm">➕ ปักแผนใหม่</button>
                            </div>
                            <div id="pmSelectedListHeader" class="text-xs font-bold text-slate-700 px-1 flex items-center justify-between"></div>
                            <div id="pmSelectedDayTasksContainer" class="space-y-2 max-h-[46vh] lg:max-h-[54vh] overflow-y-auto pr-0.5"></div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 📝 หน้าต่างเพิ่ม / แก้ไขหมุดแผนงานบำรุงรักษา (พร้อมมินิแมพจิ้มปักหมุด) -->
            <div id="pmPlanFormModal" class="fixed inset-0 bg-slate-950/75 hidden z-[1360] flex items-center justify-center p-3 backdrop-blur-sm">
                <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[92dvh] overflow-hidden flex flex-col border border-slate-200">
                    <div class="px-4 py-3 bg-gradient-to-r from-blue-700 to-indigo-800 text-white flex justify-between items-center">
                        <h3 id="pmPlanFormTitle" class="font-bold text-sm">📍 เพิ่มหมุดแผนงานบำรุงรักษา</h3>
                        <button type="button" onclick="closePmPlanFormModal()" class="text-white/80 hover:text-white text-xl font-bold leading-none">&times;</button>
                    </div>
                    <div class="p-4 space-y-3 text-xs overflow-y-auto flex-1">
                        <div>
                            <label class="block font-bold text-slate-700 mb-1">🏷️ ชื่อหมุดแผนงาน / เรื่องที่ปฏิบัติงาน <span class="text-rose-500">*</span></label>
                            <input type="text" id="pmTitleInput" placeholder="เช่น ตัดกิ่งไม้หน้าโรงงาน..., ตรวจสวิตช์ BNF06..." class="w-full px-3.5 py-2 text-sm font-semibold text-slate-800 bg-white">
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div><label class="block font-bold text-slate-700 mb-1">📂 ประเภทหมุดแผนงาน</label><select id="pmCategorySelect" class="w-full px-2.5 py-2 font-bold text-slate-700 bg-white">${catOptions}</select></div>
                            <div><label class="block font-bold text-slate-700 mb-1">📅 วันที่กำหนดทำ <span class="text-rose-500">*</span></label><input type="date" id="pmDateInput" class="w-full px-2.5 py-2 font-bold text-slate-800 bg-white"></div>
                        </div>
                        <div>
                            <label class="block font-bold text-slate-700 mb-1">🎨 สีป้ายหมุดแผนงานบนแผนที่</label>
                            <input type="hidden" id="pmPinColorInput" value="auto">
                            <div class="flex flex-wrap gap-1">${pinColorBtns}</div>
                        </div>
                        <div class="grid grid-cols-3 gap-2">
                            <div><label class="block font-bold text-slate-700 mb-1">⏰ เวลา</label><input type="text" id="pmTimeSlotInput" value="09.00-12.00" class="w-full px-2 py-2 text-center font-semibold bg-white"></div>
                            <div><label class="block font-bold text-amber-800 mb-1">🔔 เตือนล่วงหน้า</label><select id="pmNotifyBeforeSelect" class="w-full px-2 py-2 font-bold text-amber-900 bg-amber-50 border-amber-300"><option value="0">เฉพาะวันจริง</option><option value="1">1 วัน</option><option value="2">2 วัน</option><option value="3" selected>3 วัน</option><option value="5">5 วัน</option><option value="7">7 วัน</option><option value="14">14 วัน</option><option value="30">30 วัน</option></select></div>
                            <div><label class="block font-bold text-indigo-800 mb-1">🔁 รอบทำซ้ำ</label><select id="pmRepeatMonthsSelect" class="w-full px-2 py-2 font-bold text-indigo-900 bg-indigo-50 border-indigo-200"><option value="0" selected>ครั้งเดียว</option><option value="1">ทุก 1 เดือน</option><option value="3">ทุก 3 เดือน</option><option value="6">ทุก 6 เดือน</option><option value="12">ทุก 1 ปี</option></select></div>
                        </div>
                        <div class="p-2.5 bg-teal-50/80 border border-teal-200 rounded-xl space-y-2">
                            <label class="block font-bold text-teal-900">⚡ ผูกกับหมุดอุปกรณ์ในผัง SCADA (ดึงพิกัดอัตโนมัติ)</label>
                            <select id="pmScadaPinPicker" onchange="onPmScadaEquipPick(this.value)" class="w-full px-2.5 py-1.5 bg-white text-xs font-semibold text-slate-700"><option value="">-- เลือกอุปกรณ์จากผัง SCADA --</option></select>
                            <div class="grid grid-cols-2 gap-2">
                                <input type="text" id="pmEquipCodeInput" placeholder="รหัสอุปกรณ์ เช่น BNF06VS-01" class="px-2.5 py-1.5 bg-white font-semibold">
                                <input type="text" id="pmFeederInput" placeholder="วงจร เช่น BNF06" class="px-2.5 py-1.5 bg-white font-semibold uppercase">
                            </div>
                        </div>
                        <div class="space-y-1.5">
                            <div class="flex flex-wrap items-center justify-between gap-1">
                                <label class="font-bold text-slate-700">📍 พิกัดหมุดแผนงาน</label>
                                <div class="flex gap-1">
                                    <button type="button" onclick="togglePmFormMiniMap()" class="text-[10px] bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-lg font-bold">🗺️ จิ้มเลือกบนแมพ</button>
                                    <button type="button" onclick="fillPmCurrentMobileGps()" class="text-[10px] bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-lg font-bold">📍 พิกัดฉัน</button>
                                </div>
                            </div>
                            <input type="text" id="pmCoordInput" oninput="onPmCoordTextManualInput(this.value)" placeholder="วางพิกัด เช่น 13.1361, 101.0322 หรือลิงก์สั้น maps.app.goo.gl" class="w-full px-3 py-2 bg-white font-mono">
                            <div id="pmFormMiniMapWrap" class="hidden rounded-xl overflow-hidden border-2 border-indigo-300">
                                <div class="bg-indigo-900 text-white text-[10px] font-bold px-2.5 py-1 flex justify-between"><span>👆 แตะบนแผนที่หรือลากหมุดเพื่อเลือกจุดปฏิบัติงาน</span><button type="button" onclick="togglePmFormMiniMap(false)">✕ ซ่อนแมพ</button></div>
                                <div id="pmFormMiniLeafletMap" class="w-full h-44 bg-slate-100"></div>
                            </div>
                        </div>
                        <div><label class="block font-bold text-slate-700 mb-1">👷 ผู้รับผิดชอบ / รายละเอียดงาน</label><textarea id="pmNoteInput" rows="2" placeholder="ระบุผู้รับผิดชอบ หรือสิ่งที่ต้องเตรียม..." class="w-full px-3 py-2 bg-white"></textarea></div>
                    </div>
                    <div class="p-3 bg-slate-50 border-t flex items-center justify-between gap-2">
                        <button type="button" id="pmDeleteBtnInModal" onclick="deletePmPlanFromModal()" class="hidden px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs">🗑️ ลบหมุดแผน</button>
                        <div class="flex gap-2 ml-auto">
                            <button type="button" onclick="closePmPlanFormModal()" class="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl text-xs">ยกเลิก</button>
                            <button type="button" id="pmSaveSubmitBtn" onclick="savePmPlanFromModal()" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold rounded-xl text-xs shadow">💾 บันทึกหมุดแผนงาน</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 🔔 ป๊อปอัปแจ้งเตือนรอบ 00.00 น. และ 07.00 น. -->
            <div id="pmAlertPopupModal" class="fixed inset-0 bg-slate-950/75 hidden z-[1420] flex items-center justify-center p-3 backdrop-blur-sm">
                <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border-2 border-amber-400 flex flex-col max-h-[88dvh]">
                    <div class="px-4 py-3.5 bg-gradient-to-r from-amber-500 via-orange-500 to-rose-600 text-white flex justify-between items-center">
                        <h3 id="pmAlertPopupTitle" class="font-extrabold text-sm">🔔 แจ้งเตือนหมุดแผนงานบำรุงรักษา</h3>
                        <button type="button" onclick="document.getElementById('pmAlertPopupModal').classList.add('hidden')" class="text-white/85 hover:text-white text-xl font-bold leading-none">&times;</button>
                    </div>
                    <div id="pmAlertPopupBody" class="p-4 space-y-2 overflow-y-auto flex-1 bg-slate-50 text-xs"></div>
                    <div class="p-3 bg-white border-t flex flex-wrap items-center justify-between gap-2">
                        <button type="button" onclick="shareDailyOrAlertSummaryToLine()" class="px-3 py-2 bg-[#00B900] hover:bg-[#009900] text-white rounded-xl text-xs font-extrabold">💬 ส่งเข้า LINE</button>
                        <div class="flex gap-1.5">
                            <button type="button" onclick="document.getElementById('pmAlertPopupModal').classList.add('hidden'); openPmCalendarModal();" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold">📅 ดูปฏิทิน/แมพ</button>
                            <button type="button" onclick="acknowledgeCurrentPmAlertRound()" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-extrabold shadow">✅ รับทราบรอบนี้</button>
                        </div>
                    </div>
                </div>
            </div>
        `);
    }
    // ===== จบพาทที่ 2 / 3 ของไฟล์ pm-calendar.js (นำพาทที่ 3 / 3 มาวางต่อจากบรรทัดนี้ได้เลยครับ) =====
        // ===== เริ่มพาทที่ 3 / 4 ของไฟล์ pm-calendar.js (วางต่อจากพาทที่ 2) =====

    // ========================================================================
    // 7. ช่องพิมพ์ใส่แผนงานลงปฏิทินโดยตรง (Quick Inline Input + พิมพ์ด้วยเสียง 🎙️)
    // ========================================================================
    function injectQuickAddBoxIntoCalendar() {
        const listHdr = document.getElementById('pmSelectedListHeader');
        if (!listHdr || !listHdr.parentElement || document.getElementById('pmQuickInlineBox')) return;

        const catOptions = Object.values(PM_CATEGORIES)
            .map(c => `<option value="${c.key}">${c.icon} ${c.name}</option>`)
            .join('');

        const box = document.createElement('div');
        box.id = 'pmQuickInlineBox';
        box.className = 'pm-edit-only p-3 rounded-2xl bg-gradient-to-br from-blue-50 via-indigo-50/80 to-teal-50 border-2 border-indigo-300 shadow-sm space-y-2 transition-all';
        box.innerHTML = `
            <div class="flex items-center justify-between gap-1.5">
                <span class="text-[11px] font-extrabold text-indigo-950 flex items-center gap-1">
                    <span>✍️ พิมพ์เพิ่มแผนงานลงวันที่:</span>
                    <span id="pmQuickTargetDateBadge" class="bg-indigo-600 text-white px-2 py-0.5 rounded-md text-[10px] font-extrabold">-</span>
                </span>
                <button type="button" onclick="expandQuickInputToFullModal()" class="text-[10px] font-bold text-indigo-700 hover:underline shrink-0">🗺️ จิ้มแมพละเอียด</button>
            </div>

            <div class="relative flex items-center gap-1">
                <div class="relative flex-1">
                    <input type="text" id="pmQuickTitleInput"
                        onkeydown="if(event.key==='Enter'){ event.preventDefault(); submitQuickInlinePmPlan(); }"
                        placeholder="พิมพ์แผนงานที่นี่ แล้วกด Enter ได้เลย..."
                        class="w-full px-3 py-2 pr-8 text-xs font-semibold text-slate-800 bg-white border border-indigo-300 rounded-xl focus:outline-none">
                    <button type="button" onclick="startPmQuickVoiceInput()" title="พูดเพื่อพิมพ์แผนงาน"
                        class="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-rose-600 p-1 text-sm leading-none">🎙️</button>
                </div>
                <button type="button" id="pmQuickSubmitBtn" onclick="submitQuickInlinePmPlan()"
                    class="shrink-0 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold px-3 py-2 rounded-xl text-xs shadow-sm transition">
                    ➕ บันทึก
                </button>
            </div>

            <div class="grid grid-cols-12 gap-1.5 items-center">
                <select id="pmQuickCategorySelect" class="col-span-5 px-2 py-1.5 text-[11px] font-bold text-slate-700 bg-white border border-slate-300 rounded-lg">
                    ${catOptions}
                </select>
                <input type="text" id="pmQuickTimeInput" value="09.00-12.00" placeholder="เวลา"
                    class="col-span-3 px-2 py-1.5 text-[11px] font-semibold text-center text-slate-700 bg-white border border-slate-300 rounded-lg">
                <input type="text" id="pmQuickCoordInput"
                    onkeydown="if(event.key==='Enter'){ event.preventDefault(); submitQuickInlinePmPlan(); }"
                    placeholder="📍 พิกัด/ลิงก์ (ถ้ามี)"
                    class="col-span-4 px-2 py-1.5 text-[10.5px] font-mono text-slate-700 bg-white border border-slate-300 rounded-lg">
            </div>
        `;
        listHdr.parentElement.insertBefore(box, listHdr);
        updateQuickInlineBoxUI();
    }

    function updateQuickInlineBoxUI() {
        const box = document.getElementById('pmQuickInlineBox');
        if (!box) return;
        const allow = canManagePmSchedule();
        box.classList.toggle('hidden', !allow);
        const dateBadge = document.getElementById('pmQuickTargetDateBadge');
        if (dateBadge) {
            dateBadge.textContent = formatThaiDateShort(selectedDateIso || getTodayIso());
        }
    }

    function focusQuickInlineInputForDate(isoStr) {
        if (isoStr) selectedDateIso = isoStr;
        currentFilterStatus = 'day';
        renderPmCalendarGrid();
        renderPmSelectedDayList();
        updateQuickInlineBoxUI();

        const box = document.getElementById('pmQuickInlineBox');
        const inp = document.getElementById('pmQuickTitleInput');
        if (box && inp && canManagePmSchedule()) {
            box.classList.add('ring-4', 'ring-amber-300');
            setTimeout(() => box.classList.remove('ring-4', 'ring-amber-300'), 750);
            inp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            setTimeout(() => inp.focus(), 60);
        }
    }

    function startPmQuickVoiceInput() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            showToast('⚠️ เบราว์เซอร์นี้ไม่รองรับการพิมพ์ด้วยเสียง');
            return;
        }
        const inp = document.getElementById('pmQuickTitleInput');
        if (!inp) return;

        const rec = new SR();
        rec.lang = 'th-TH';
        rec.onstart = () => showToast('🎙️ กำลังฟัง... พูดรายละเอียดแผนงานได้เลยครับ');
        rec.onresult = (e) => {
            const transcript = (e.results?.[0]?.[0]?.transcript || '').trim();
            if (transcript) {
                inp.value = (inp.value ? inp.value + ' ' : '') + transcript;
                inp.focus();
            }
        };
        rec.onerror = () => showToast('❌ รับเสียงไม่สำเร็จ กรุณาลองใหม่');
        rec.start();
    }

    function expandQuickInputToFullModal() {
        if (!canManagePmSchedule()) return;
        const typedTitle = (document.getElementById('pmQuickTitleInput')?.value || '').trim();
        const typedCat = document.getElementById('pmQuickCategorySelect')?.value || 'tree';
        const typedTime = (document.getElementById('pmQuickTimeInput')?.value || '').trim();
        const typedCoord = (document.getElementById('pmQuickCoordInput')?.value || '').trim();

        openPmPlanFormModal(null, selectedDateIso || getTodayIso());
        if (typedTitle) document.getElementById('pmTitleInput').value = typedTitle;
        if (typedCat) document.getElementById('pmCategorySelect').value = typedCat;
        if (typedTime) document.getElementById('pmTimeSlotInput').value = typedTime;
        if (typedCoord) {
            document.getElementById('pmCoordInput').value = typedCoord;
            onPmCoordTextManualInput(typedCoord);
        }
        togglePmFormMiniMap(true);
    }

    async function submitQuickInlinePmPlan() {
        if (!canManagePmSchedule()) {
            showToast('🔒 เฉพาะแอดมินและผู้ใช้งานทั่วไปเท่านั้นที่เพิ่มแผนงานได้');
            return;
        }
        const titleEl = document.getElementById('pmQuickTitleInput');
        const catEl = document.getElementById('pmQuickCategorySelect');
        const timeEl = document.getElementById('pmQuickTimeInput');
        const coordEl = document.getElementById('pmQuickCoordInput');
        const submitBtn = document.getElementById('pmQuickSubmitBtn');

        const rawTitle = (titleEl?.value || '').trim();
        if (!rawTitle) {
            showToast('✍️ กรุณาพิมพ์ชื่อแผนงานก่อนกดบันทึก');
            titleEl?.focus();
            return;
        }

        const rawCoord = (coordEl?.value || '').trim();
        let parsedCoord = null;
        if (rawCoord) {
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '⏳...'; }
            parsedCoord = await parsePmCoordOrShortLink(rawCoord);
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '➕ บันทึก'; }
            if (!parsedCoord) {
                showToast('❌ พิกัดหรือลิงก์ไม่ถูกต้อง (เว้นว่างได้หากไม่ระบุพิกัด)');
                return;
            }
        }

        const targetDate = selectedDateIso || getTodayIso();
        const category = catEl?.value || 'tree';
        const timeSlot = (timeEl?.value || '').trim() || '09.00-12.00';
        const curUser = (rawGet('elec_app_current_user') || 'admin').trim();
        const nowIso = new Date().toISOString();

        loadPmPlansFromStorage();
        pmPlans.push({
            id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            title: rawTitle,
            category,
            pinColor: 'auto',
            date: targetDate,
            timeSlot,
            notifyDaysBefore: 3,
            repeatMonths: 0,
            equipCode: '',
            feeder: '',
            note: '',
            lat: parsedCoord ? parsedCoord.lat : null,
            lon: parsedCoord ? parsedCoord.lon : null,
            gpsLink: parsedCoord ? `https://www.google.com/maps?q=${parsedCoord.lat.toFixed(6)},${parsedCoord.lon.toFixed(6)}` : '',
            status: 'pending',
            ownerGroup: getActivePmGroup(),
            createdBy: curUser,
            updatedBy: curUser,
            updatedAt: nowIso
        });

        if (titleEl) titleEl.value = '';
        if (coordEl) coordEl.value = '';
        currentFilterStatus = 'day';

        await savePmPlansAndSync(true);
        showToast(`✅ เพิ่มแผนงานลงวันที่ ${formatThaiDateShort(targetDate)} เรียบร้อยแล้ว`);
        titleEl?.focus();
    }

    function quickEditPmPlanTitle(planId) {
        if (!canManagePmSchedule()) return;
        loadPmPlansFromStorage();
        const target = pmPlans.find(p => p.id === planId && !p.pmDeleted);
        if (!target) return;

        showCustomPrompt('แก้ไขข้อความแผนงานด่วน:', target.title, async function (newVal) {
            const trimmed = String(newVal || '').trim();
            if (!trimmed || trimmed === target.title) return;
            target.title = trimmed;
            target.updatedBy = (rawGet('elec_app_current_user') || 'admin').trim();
            target.updatedAt = new Date().toISOString();
            await savePmPlansAndSync(true);
            showToast('✅ อัปเดตข้อความแผนงานแล้ว');
        }, '✏️ แก้ไขข้อความแผนงาน');
    }

    // ========================================================================
    // 8. ตารางปฏิทินรายเดือน, แผนที่หมุดแผนงานในปฏิทิน & รายการงานรายวัน
    // ========================================================================
    async function initCalendarEmbeddedMap() {
        const mapEl = document.getElementById('pmCalendarEmbeddedMap');
        if (!mapEl) return;
        const ok = await ensureLeafletReady();
        if (!ok || typeof L === 'undefined') {
            showToast('⚠️ ไม่สามารถโหลดไลบรารีแผนที่ได้ กรุณาตรวจสอบอินเทอร์เน็ต');
            return;
        }

        if (!calendarMapInstance) {
            const defCenter = window.lastKnownTechCoords
                ? [window.lastKnownTechCoords.lat, window.lastKnownTechCoords.lon]
                : [13.1361, 101.0322];
            calendarMapInstance = L.map('pmCalendarEmbeddedMap').setView(defCenter, 12);
            const gStreets = L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' }).addTo(calendarMapInstance);
            const gHybrid = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' });
            L.control.layers({ '🗺️ ถนน': gStreets, '🛰️ ดาวเทียม': gHybrid }, null, { position: 'topright' }).addTo(calendarMapInstance);
            calendarPmLayer = L.layerGroup().addTo(calendarMapInstance);

            calendarMapInstance.on('click', (e) => {
                if (!e.latlng) return;
                if (pmPinMoveTargetId) {
                    commitMovedPmPlanPinLocation(pmPinMoveTargetId, e.latlng.lat, e.latlng.lng);
                } else if (pmPinDropModeActive) {
                    const { lat, lng } = e.latlng;
                    cancelPmMapInteractiveModes();
                    openPmPlanFormModal(null, selectedDateIso || getTodayIso(), lat, lng);
                }
            });
        }

        setTimeout(() => {
            calendarMapInstance.invalidateSize();
            renderPmPinsOnTargetMap(calendarMapInstance, calendarPmLayer, calendarPmMarkersById, false);
        }, 100);
    }

    function fitCalendarEmbeddedMapPins() {
        if (!calendarMapInstance) return;
        const pts = getAllVisibleCalendarItems()
            .filter(i => !isNaN(parseFloat(i.lat)) && !isNaN(parseFloat(i.lon)))
            .map(i => [parseFloat(i.lat), parseFloat(i.lon)]);
        if (pts.length === 0) {
            showToast('⚠️ ยังไม่มีหมุดแผนงานที่ระบุพิกัดในกลุ่มนี้');
            return;
        }
        calendarMapInstance.invalidateSize();
        calendarMapInstance.fitBounds(pts, { padding: [35, 35], maxZoom: 16 });
    }

    async function switchCalendarLeftViewMode(mode) {
        calendarLeftViewMode = mode === 'map' ? 'map' : 'grid';
        const isMap = (calendarLeftViewMode === 'map');

        document.getElementById('pmCalendarGridPanel')?.classList.toggle('hidden', isMap);
        document.getElementById('pmCalendarMapPanel')?.classList.toggle('hidden', !isMap);

        const btnGrid = document.getElementById('pmViewTab-grid');
        const btnMap = document.getElementById('pmViewTab-map');
        if (btnGrid) btnGrid.className = !isMap ? 'px-3 py-1 rounded-lg bg-indigo-600 text-white shadow-sm' : 'px-3 py-1 rounded-lg text-slate-600 hover:bg-slate-200/60';
        if (btnMap) btnMap.className = isMap ? 'px-3 py-1 rounded-lg bg-indigo-600 text-white shadow-sm' : 'px-3 py-1 rounded-lg text-slate-600 hover:bg-slate-200/60';

        if (isMap) {
            await initCalendarEmbeddedMap();
            setTimeout(fitCalendarEmbeddedMapPins, 200);
        } else {
            cancelPmMapInteractiveModes();
        }
    }

    function openPmCalendarModal(presetDateIso = null) {
        injectPmModalsDOM();
        injectQuickAddBoxIntoCalendar();
        if (presetDateIso && /^\d{4}-\d{2}-\d{2}$/.test(presetDateIso)) {
            selectedDateIso = presetDateIso;
            const [y, m] = presetDateIso.split('-').map(Number);
            viewYear = y;
            viewMonth = m - 1;
            currentFilterStatus = 'day';
        }
        refreshPmAllViews();
        document.getElementById('pmCalendarModal')?.classList.remove('hidden');
        if (calendarLeftViewMode === 'map') {
            setTimeout(() => calendarMapInstance?.invalidateSize(), 150);
        }
    }

    function closePmCalendarModal() {
        cancelPmMapInteractiveModes();
        document.getElementById('pmCalendarModal')?.classList.add('hidden');
    }

    function changePmCalendarMonth(delta) {
        const d = new Date(viewYear, viewMonth + delta, 1);
        viewYear = d.getFullYear();
        viewMonth = d.getMonth();
        renderPmCalendarGrid();
        renderPmSelectedDayList();
    }

    function jumpPmCalendarToday() {
        const now = new Date();
        viewYear = now.getFullYear();
        viewMonth = now.getMonth();
        selectedDateIso = toLocalIsoDate(now);
        currentFilterStatus = 'day';
        renderPmCalendarGrid();
        renderPmSelectedDayList();
        updateQuickInlineBoxUI();
    }

    function selectPmCalendarDate(isoStr) {
        selectedDateIso = isoStr;
        currentFilterStatus = 'day';
        renderPmCalendarGrid();
        renderPmSelectedDayList();
        updateQuickInlineBoxUI();
    }

    function setPmListStatusFilter(filterVal) {
        currentFilterStatus = filterVal || 'day';
        renderPmSelectedDayList();
    }

    function toggleShowScadaDueOnCalendar(checked) {
        showScadaDuePins = Boolean(checked);
        localStorage.setItem(PM_SHOW_SCADA_DUE_KEY, String(showScadaDuePins));
        refreshPmAllViews();
    }

    function renderPmCalendarGrid() {
        const gridEl = document.getElementById('pmCalendarDaysGrid');
        const titleEl = document.getElementById('pmCalendarMonthTitle');
        const summaryEl = document.getElementById('pmMonthSummaryBar');
        const grpBadge = document.getElementById('pmHeaderGroupBadge');
        const scadaChk = document.getElementById('pmShowScadaDueChk');
        const addBtn = document.getElementById('pmAddPlanPrimaryBtn');
        const mapCntEl = document.getElementById('pmCalMapPinCount');
        if (!gridEl) return;

        const allItems = getAllVisibleCalendarItems();
        const pinnedItemsCnt = allItems.filter(i => !isNaN(parseFloat(i.lat)) && !isNaN(parseFloat(i.lon))).length;

        if (grpBadge) grpBadge.textContent = `🏢 ${getActivePmGroup()}`;
        if (scadaChk) scadaChk.checked = showScadaDuePins;
        if (mapCntEl) mapCntEl.textContent = String(pinnedItemsCnt);
        if (addBtn) addBtn.classList.toggle('hidden', !canManagePmSchedule());
        if (titleEl) titleEl.textContent = `${THAI_MONTHS[viewMonth]} ${viewYear + 543}`;
        updateQuickInlineBoxUI();

        const monthPrefix = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-`;
        const monthItems = allItems.filter(it => String(it.date || '').startsWith(monthPrefix));
        const byDate = new Map();
        monthItems.forEach(it => {
            if (!byDate.has(it.date)) byDate.set(it.date, []);
            byDate.get(it.date).push(it);
        });

        const todayIso = getTodayIso();
        const pendingCnt = monthItems.filter(i => i.status !== 'done').length;
        const doneCnt = monthItems.filter(i => i.status === 'done').length;
        const alertCnt = getAlertCandidatesForToday().length;

        if (summaryEl) {
            summaryEl.innerHTML = `
                <div class="bg-slate-100 border border-slate-200 rounded-xl py-1.5 px-1 font-bold text-slate-700">เดือนนี้ <b class="text-slate-900">${monthItems.length}</b></div>
                <div class="bg-amber-50 border border-amber-200 rounded-xl py-1.5 px-1 font-bold text-amber-800">รอทำ <b>${pendingCnt}</b></div>
                <div class="bg-emerald-50 border border-emerald-200 rounded-xl py-1.5 px-1 font-bold text-emerald-800">เสร็จแล้ว <b>${doneCnt}</b></div>
                <div onclick="setPmListStatusFilter('alert')" class="cursor-pointer bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl py-1.5 px-1 font-extrabold text-rose-700">🔔 เตือน <b>${alertCnt}</b></div>`;
        }

        const firstDow = new Date(viewYear, viewMonth, 1).getDay();
        const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        const allowAdd = canManagePmSchedule();
        const cells = [];

        for (let b = 0; b < firstDow; b++) {
            cells.push('<div class="rounded-xl bg-slate-50/60 border border-transparent"></div>');
        }

        for (let day = 1; day <= daysInMonth; day++) {
            const iso = `${monthPrefix}${String(day).padStart(2, '0')}`;
            const dayTasks = byDate.get(iso) || [];
            const isToday = (iso === todayIso);
            const isSel = (iso === selectedDateIso);
            const hasOverdue = dayTasks.some(t => t.status !== 'done' && calcDaysUntil(t.date, todayIso) < 0);

            const barsHtml = dayTasks.slice(0, 2).map(t => {
                const vis = getPlanPinVisualTheme(t);
                const doneStyle = t.status === 'done' ? 'opacity:0.45;text-decoration:line-through;' : '';
                const pinDot = (!isNaN(parseFloat(t.lat)) && !isNaN(parseFloat(t.lon))) ? '📍' : '';
                return `<div class="truncate text-[9px] text-white font-bold px-1 rounded leading-tight" style="background:${vis.hex};${doneStyle}">${pinDot}${vis.icon} ${escapeHtmlStr(t.title)}</div>`;
            }).join('');
            const moreHtml = dayTasks.length > 2
                ? `<div class="text-[9px] font-extrabold text-indigo-700 leading-none">+อีก ${dayTasks.length - 2} งาน</div>`
                : '';
            const quickPlusBtn = allowAdd
                ? `<span onclick="event.stopPropagation(); focusQuickInlineInputForDate('${iso}')" title="คลิกเพื่อพิมพ์เพิ่มแผนงานในวันนี้" class="pm-edit-only opacity-0 group-hover:opacity-100 ${isSel ? '!opacity-100' : ''} w-4 h-4 rounded-full bg-indigo-100 hover:bg-indigo-600 text-indigo-700 hover:text-white flex items-center justify-center text-[11px] font-extrabold leading-none transition">+</span>`
                : '';

            cells.push(`
                <div onclick="selectPmCalendarDate('${iso}')" ondblclick="focusQuickInlineInputForDate('${iso}')" class="group cursor-pointer pm-day-cell rounded-xl border p-1 flex flex-col items-stretch text-left bg-white ${isSel ? 'pm-day-selected' : 'border-slate-200'} ${isToday ? 'ring-2 ring-amber-400' : ''}">
                    <div class="flex items-center justify-between w-full mb-0.5">
                        <span class="text-[11px] font-extrabold ${isToday ? 'bg-amber-400 text-slate-950 px-1.5 rounded-full' : 'text-slate-700'}">${day}</span>
                        <div class="flex items-center gap-0.5">
                            ${hasOverdue ? '<span class="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>' : ''}
                            ${quickPlusBtn}
                        </div>
                    </div>
                    <div class="space-y-0.5 overflow-hidden flex-1">${barsHtml}${moreHtml}</div>
                </div>`);
        }
        gridEl.innerHTML = cells.join('');
    }

    function renderPmSelectedDayList() {
        const listEl = document.getElementById('pmSelectedDayTasksContainer');
        const hdrEl = document.getElementById('pmSelectedListHeader');
        if (!listEl) return;

        ['day', 'alert', 'all'].forEach(k => {
            const btn = document.getElementById('pmFilterBtn-' + k);
            if (btn) btn.className = currentFilterStatus === k ? 'py-1 rounded-lg bg-indigo-600 text-white shadow-sm' : 'py-1 rounded-lg text-slate-600 hover:bg-slate-200/70';
        });

        const monthPrefix = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-`;
        const todayIso = getTodayIso();
        let items = [];

        if (currentFilterStatus === 'alert') {
            items = getAlertCandidatesForToday();
            if (hdrEl) hdrEl.innerHTML = `<span>🔔 งานถึงกำหนด / เตือนล่วงหน้า (${items.length})</span>`;
        } else if (currentFilterStatus === 'all') {
            items = getAllVisibleCalendarItems().filter(it => String(it.date || '').startsWith(monthPrefix));
            if (hdrEl) hdrEl.innerHTML = `<span>📋 แผนงานทั้งเดือน ${THAI_MONTHS[viewMonth]} (${items.length})</span>`;
        } else {
            items = getAllVisibleCalendarItems().filter(it => it.date === selectedDateIso);
            if (hdrEl) hdrEl.innerHTML = `<span>📌 ${formatThaiDateFull(selectedDateIso)} (${items.length} งาน)</span>`;
        }

        if (items.length === 0) {
            listEl.innerHTML = `<div class="text-center py-8 px-4 bg-slate-50 rounded-2xl border border-dashed border-slate-300 text-xs text-slate-400">ยังไม่มีแผนงานในวันนี้ พิมพ์ใส่ช่องด้านบนแล้วกด Enter ได้เลยครับ</div>`;
            return;
        }

        const allowEdit = canManagePmSchedule();
        const allowDone = canCompletePmTask();

        listEl.innerHTML = items.map(item => {
            const cat = getCategoryMeta(item.category);
            const isDone = item.status === 'done';
            const daysLeft = calcDaysUntil(item.date, todayIso);
            const safeId = String(item.id).replace(/'/g, "\\'");
            const hasCoord = !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lon));

            const dueBadge = isDone
                ? '<span class="bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded-full">✅ เสร็จแล้ว</span>'
                : (daysLeft < 0
                    ? `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">🚨 เลย ${Math.abs(daysLeft)} วัน</span>`
                    : (daysLeft === 0 ? '<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">📌 วันนี้</span>' : `<span class="bg-slate-100 text-slate-600 text-[10px] font-bold px-2 py-0.5 rounded-full">อีก ${daysLeft} วัน</span>`));

            return `
                <div class="p-3 rounded-2xl border ${isDone ? 'bg-slate-50 border-slate-200 opacity-75' : 'bg-white border-slate-200 shadow-sm'} space-y-1.5 text-xs">
                    <div class="flex items-start justify-between gap-2">
                        <div class="space-y-0.5 min-w-0 flex-1">
                            <div class="flex items-center gap-1 flex-wrap">
                                <span class="border text-[10px] font-bold px-1.5 py-0.5 rounded ${cat.pillCls}">${cat.icon} ${cat.name}</span>
                                ${hasCoord ? '<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-1.5 py-0.5 rounded">📍 มีหมุดแผนที่</span>' : ''}
                            </div>
                            <div ${(!item.isScadaPinDue && allowEdit) ? `onclick="quickEditPmPlanTitle('${safeId}')" title="คลิกเพื่อแก้ข้อความด่วน"` : ''} class="font-extrabold text-slate-800 text-xs sm:text-sm break-words ${(!item.isScadaPinDue && allowEdit) ? 'cursor-pointer hover:text-indigo-700' : ''} ${isDone ? 'line-through' : ''}">${escapeHtmlStr(item.title)}</div>
                        </div>
                        <div class="shrink-0 flex items-center gap-1">
                            ${dueBadge}
                            ${(!item.isScadaPinDue && allowEdit) ? `<button type="button" onclick="quickDeletePmPlanCard('${safeId}')" class="text-slate-300 hover:text-rose-600 font-bold text-sm px-1" title="ลบแผนงาน">&times;</button>` : ''}
                        </div>
                    </div>
                    <div class="text-[11px] text-slate-600">📅 ${formatThaiDateShort(item.date)} (${escapeHtmlStr(item.timeSlot || '-')}) • 🔔 เตือนล่วงหน้า ${Number(item.notifyDaysBefore ?? 3)} วัน</div>
                    ${item.equipCode ? `<div class="text-[11px] font-bold text-teal-800">⚡ อุปกรณ์: ${escapeHtmlStr(item.equipCode)} ${item.feeder ? `(${escapeHtmlStr(item.feeder)})` : ''}</div>` : ''}
                    ${item.note ? `<div class="text-[11px] text-slate-500 break-words">📝 ${escapeHtmlStr(item.note)}</div>` : ''}
                    <div class="pt-1.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-1.5">
                        <div class="flex flex-wrap gap-1">
                            ${hasCoord ? `<button type="button" onclick="focusPmPlanPinOnMap('${safeId}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-1 rounded-lg text-[10px] font-bold">📍 ดูหมุด</button><button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">🗺️ นำทาง</button>` : ''}
                            <button type="button" onclick="shareSinglePmPlanToLine('${safeId}')" class="bg-[#00B900] hover:bg-[#009900] text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">💬 LINE</button>
                            ${(!item.isScadaPinDue && allowEdit) ? `<button type="button" onclick="openPmPlanFormModal('${safeId}')" class="bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 px-2 py-1 rounded-lg text-[10px] font-bold">✏️ แก้ไข/ปักหมุด</button>` : ''}
                        </div>
                        ${(!item.isScadaPinDue && allowDone) ? `<button type="button" onclick="togglePmPlanCompleteStatus('${safeId}')" class="${isDone ? 'bg-slate-200 text-slate-700' : 'bg-emerald-600 hover:bg-emerald-700 text-white'} px-2.5 py-1 rounded-lg text-[10px] font-extrabold shadow-sm">${isDone ? '↩️ เปิดใหม่' : '✅ เสร็จสิ้น'}</button>` : ''}
                    </div>
                </div>`;
        }).join('');
    }

    function showPmAlertSummaryModal(roundTitle, candidates) {
        injectPmModalsDOM();
        const modal = document.getElementById('pmAlertPopupModal');
        const titleEl = document.getElementById('pmAlertPopupTitle');
        const bodyEl = document.getElementById('pmAlertPopupBody');
        if (!modal || !bodyEl) return;

        if (titleEl) titleEl.textContent = roundTitle;
        bodyEl.innerHTML = candidates.map(c => {
            const cat = getCategoryMeta(c.category);
            const safeId = String(c.id).replace(/'/g, "\\'");
            const hasCoord = !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lon));
            const badge = c.daysLeft < 0
                ? `<span class="bg-rose-600 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full">เลยกำหนด ${Math.abs(c.daysLeft)} วัน</span>`
                : (c.daysLeft === 0 ? `<span class="bg-amber-500 text-slate-950 text-[10px] font-extrabold px-2 py-0.5 rounded-full">📌 วันนี้ (${escapeHtmlStr(c.timeSlot || '-')})</span>` : `<span class="bg-sky-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">อีก ${c.daysLeft} วัน (${formatThaiDateShort(c.date)})</span>`);
            return `
                <div class="p-3 bg-white rounded-2xl border border-slate-200 shadow-sm space-y-1">
                    <div class="flex items-center justify-between gap-2">${badge}<span class="text-[10px] font-bold text-slate-500">${cat.icon} ${cat.name}</span></div>
                    <div class="font-extrabold text-slate-800 text-xs sm:text-sm">${escapeHtmlStr(c.title)}</div>
                    ${hasCoord ? `<div class="pt-1 flex gap-1.5"><button type="button" onclick="focusPmPlanPinOnMap('${safeId}')" class="bg-indigo-50 text-indigo-700 border border-indigo-200 px-2.5 py-1 rounded-lg text-[10px] font-bold">📍 ดูหมุดบนแมพ</button><button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-600 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">🗺️ นำทาง Maps</button></div>` : ''}
                </div>`;
        }).join('');
        modal.classList.remove('hidden');
    }

    function refreshPmAllViews() {
        updatePmHeaderBadgesAndStrip();
        renderAllExternalPmMapLayers();
        const calModal = document.getElementById('pmCalendarModal');
        if (calModal && !calModal.classList.contains('hidden')) {
            injectQuickAddBoxIntoCalendar();
            renderPmCalendarGrid();
            renderPmSelectedDayList();
        }
    }
    // ===== จบพาทที่ 3 / 4 ของไฟล์ pm-calendar.js (นำพาทที่ 4 / 4 มาวางต่อจากบรรทัดนี้ได้เลยครับ) =====
        // ===== เริ่มพาทที่ 4 / 4 ของไฟล์ pm-calendar.js (วางต่อจากพาทที่ 3 / 4 จนจบไฟล์) =====

    // ========================================================================
    // 9. ฟอร์มหมุดแผนงาน, เลือกสีหมุด, มินิแมพจิ้มพิกัด & บันทึก/ลบ/ทำซ้ำอัตโนมัติ
    // ========================================================================
    function copyPmTextSafe(text, successMsg) {
        if (typeof window.copyTextToClipboard === 'function') return window.copyTextToClipboard(text, successMsg);
        if (typeof window.copyTechText === 'function') return window.copyTechText(text, successMsg);
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                if (successMsg && typeof showToast === 'function') showToast(successMsg);
            }).catch(() => {});
        }
    }

    function loadPmXlsxSafe() {
        if (typeof XLSX !== 'undefined') return Promise.resolve(true);
        if (typeof window.ensureXlsxLoaded === 'function') return window.ensureXlsxLoaded();
        if (typeof window.ensureTechXlsxLoaded === 'function') return window.ensureTechXlsxLoaded();
        return new Promise((resolve) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
            s.onload = () => resolve(true);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
    }

    if (typeof window.showCustomPrompt !== 'function') {
        window.showCustomPrompt = function (message, defaultValue = '', onConfirm, title = '✏️ แก้ไขข้อมูล') {
            let modal = document.getElementById('pmFallbackPromptModal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'pmFallbackPromptModal';
                modal.className = 'fixed inset-0 z-[1460] flex items-center justify-center bg-slate-950/65 backdrop-blur-sm p-4';
                modal.innerHTML = `
                    <div class="bg-slate-800 text-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4 border border-slate-700">
                        <h3 id="pmFallbackPromptTitle" class="text-base font-bold text-amber-400"></h3>
                        <p id="pmFallbackPromptMsg" class="text-xs text-slate-200"></p>
                        <input type="text" id="pmFallbackPromptInput" class="w-full px-3.5 py-2 text-slate-800 font-semibold rounded-xl text-sm bg-white focus:outline-none">
                        <div class="flex justify-end gap-2 pt-1">
                            <button type="button" onclick="document.getElementById('pmFallbackPromptModal').classList.add('hidden')" class="text-slate-300 px-4 py-2 rounded-xl text-xs font-bold">ยกเลิก</button>
                            <button type="button" id="pmFallbackPromptOk" class="bg-blue-500 hover:bg-blue-600 text-white font-bold text-xs px-5 py-2 rounded-xl shadow">บันทึก</button>
                        </div>
                    </div>`;
                document.body.appendChild(modal);
            }
            document.getElementById('pmFallbackPromptTitle').textContent = title;
            document.getElementById('pmFallbackPromptMsg').textContent = message;
            const inp = document.getElementById('pmFallbackPromptInput');
            inp.value = defaultValue || '';
            const submit = () => {
                modal.classList.add('hidden');
                if (typeof onConfirm === 'function') onConfirm(inp.value);
            };
            document.getElementById('pmFallbackPromptOk').onclick = submit;
            inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
            modal.classList.remove('hidden');
            setTimeout(() => inp.focus(), 60);
        };
    }

    function selectPmFormPinColor(colorKey) {
        const validKey = PM_PIN_COLORS[colorKey] ? colorKey : 'auto';
        const inp = document.getElementById('pmPinColorInput');
        if (inp) inp.value = validKey;

        Object.keys(PM_PIN_COLORS).forEach(k => {
            const btn = document.getElementById('pmFormColorBtn-' + k);
            if (!btn) return;
            btn.className = k === validKey
                ? 'px-2.5 py-1 rounded-lg border-2 border-indigo-600 bg-indigo-50 text-indigo-900 text-[10px] font-extrabold shadow-sm transition'
                : 'px-2 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 text-[10px] font-bold transition opacity-80';
        });
    }

    function populatePmScadaPinPicker(selectedPinId = '') {
        const picker = document.getElementById('pmScadaPinPicker');
        if (!picker) return;
        try {
            const pins = JSON.parse(rawGet('elec_labeled_places_list') || '[]');
            const delMap = JSON.parse(rawGet('elec_deleted_labeled_places_map') || '{}');
            const role = rawGet('elec_app_current_role') || 'user';
            const myGrp = (typeof getCurrentUserGroup === 'function' ? getCurrentUserGroup() : '') ||
                          rawGet('elec_app_current_group') || '';

            const visiblePins = pins.filter(p => {
                if (!p || !p.id || delMap[p.id]) return false;
                if (role === 'admin' && !myGrp) return true;
                return (p.ownerGroup || 'กฟส.บึง').trim() === getActivePmGroup();
            }).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'th'));

            picker.innerHTML = `<option value="">-- เลือกอุปกรณ์จากผัง SCADA (${visiblePins.length} จุด) --</option>` +
                visiblePins.map(p => {
                    const fd = p.scadaNode?.fd ? ` [${p.scadaNode.fd}]` : '';
                    return `<option value="${escapeHtmlStr(p.id)}" ${p.id === selectedPinId ? 'selected' : ''}>⚡ ${escapeHtmlStr(p.name)}${escapeHtmlStr(fd)}</option>`;
                }).join('');
        } catch (e) {
            picker.innerHTML = '<option value="">-- ไม่พบรายการหมุดอุปกรณ์ --</option>';
        }
    }

    function syncFormMiniMapMarker(lat, lon, panTo = true) {
        if (!formMiniMap || typeof L === 'undefined') return;
        if (isNaN(lat) || isNaN(lon)) {
            if (formMiniMarker) { formMiniMap.removeLayer(formMiniMarker); formMiniMarker = null; }
            return;
        }
        if (!formMiniMarker) {
            formMiniMarker = L.marker([lat, lon], { draggable: true }).addTo(formMiniMap);
            formMiniMarker.on('dragend', (ev) => {
                const ll = ev.target.getLatLng();
                const cdEl = document.getElementById('pmCoordInput');
                if (cdEl) cdEl.value = `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;
            });
        } else {
            formMiniMarker.setLatLng([lat, lon]);
        }
        if (panTo) formMiniMap.setView([lat, lon], Math.max(formMiniMap.getZoom(), 15));
    }

    async function togglePmFormMiniMap(forceOpen) {
        const wrap = document.getElementById('pmFormMiniMapWrap');
        if (!wrap) return;
        isFormMiniMapOpen = typeof forceOpen === 'boolean' ? forceOpen : !isFormMiniMapOpen;
        wrap.classList.toggle('hidden', !isFormMiniMapOpen);
        if (!isFormMiniMapOpen) return;

        const ok = await ensureLeafletReady();
        if (!ok || typeof L === 'undefined') return;

        if (!formMiniMap) {
            const defCenter = window.lastKnownTechCoords
                ? [window.lastKnownTechCoords.lat, window.lastKnownTechCoords.lon]
                : [13.1361, 101.0322];
            formMiniMap = L.map('pmFormMiniLeafletMap').setView(defCenter, 13);
            L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' }).addTo(formMiniMap);
            formMiniMap.on('click', (e) => {
                if (!e.latlng) return;
                const lat = Number(e.latlng.lat.toFixed(6));
                const lon = Number(e.latlng.lng.toFixed(6));
                const cdEl = document.getElementById('pmCoordInput');
                if (cdEl) cdEl.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                syncFormMiniMapMarker(lat, lon, false);
            });
        }

        setTimeout(async () => {
            formMiniMap.invalidateSize();
            const rawCoord = document.getElementById('pmCoordInput')?.value || '';
            const parsed = await parsePmCoordOrShortLink(rawCoord);
            if (parsed) syncFormMiniMapMarker(parsed.lat, parsed.lon, true);
        }, 90);
    }

    async function onPmCoordTextManualInput(rawVal) {
        if (!isFormMiniMapOpen || !formMiniMap) return;
        const parsed = await parsePmCoordOrShortLink(rawVal);
        if (parsed) syncFormMiniMapMarker(parsed.lat, parsed.lon, true);
    }

    function onPmScadaEquipPick(pinId) {
        if (!pinId) return;
        try {
            const pins = JSON.parse(rawGet('elec_labeled_places_list') || '[]');
            const target = pins.find(p => p && p.id === pinId);
            if (!target) return;

            const eqEl = document.getElementById('pmEquipCodeInput');
            const fdEl = document.getElementById('pmFeederInput');
            const cdEl = document.getElementById('pmCoordInput');
            const ttEl = document.getElementById('pmTitleInput');

            if (eqEl) eqEl.value = target.name || '';
            if (fdEl) fdEl.value = (target.scadaNode?.fd || '').toUpperCase();
            if (!isNaN(parseFloat(target.lat)) && !isNaN(parseFloat(target.lon))) {
                const lat = Number(target.lat), lon = Number(target.lon);
                if (cdEl) cdEl.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                if (isFormMiniMapOpen) syncFormMiniMapMarker(lat, lon, true);
            }
            if (ttEl && !ttEl.value.trim()) {
                const cat = getCategoryMeta(document.getElementById('pmCategorySelect')?.value || 'scada');
                ttEl.value = `${cat.name} (${target.name})`;
            }
            showToast(`⚡ ดึงพิกัดหมุดจาก "${target.name}" แล้ว`);
        } catch (e) {}
    }

    function fillPmCurrentMobileGps() {
        const coordEl = document.getElementById('pmCoordInput');
        if (!navigator.geolocation) {
            showToast('⚠️ เบราว์เซอร์ไม่รองรับ GPS');
            return;
        }
        showToast('⏳ กำลังดึงพิกัดมือถือปัจจุบัน...');
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = Number(pos.coords.latitude.toFixed(6));
                const lon = Number(pos.coords.longitude.toFixed(6));
                if (coordEl) coordEl.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                if (isFormMiniMapOpen) syncFormMiniMapMarker(lat, lon, true);
                showToast(`📍 ดึงพิกัดสำเร็จ (${lat.toFixed(6)}, ${lon.toFixed(6)})`);
            },
            () => {
                if (window.lastKnownTechCoords && coordEl) {
                    const lat = Number(window.lastKnownTechCoords.lat.toFixed(6));
                    const lon = Number(window.lastKnownTechCoords.lon.toFixed(6));
                    coordEl.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
                    if (isFormMiniMapOpen) syncFormMiniMapMarker(lat, lon, true);
                    showToast('📍 ใช้พิกัดล่าสุดของเครื่อง');
                } else {
                    showToast('❌ ไม่สามารถดึงพิกัดได้ กรุณาเปิด Location ในเครื่อง');
                }
            },
            { enableHighAccuracy: true, timeout: 8000 }
        );
    }

    async function parsePmCoordOrShortLink(rawStr) {
        const txt = String(rawStr || '').trim();
        if (!txt) return null;

        let pair = typeof deepParseCoords === 'function' ? deepParseCoords(txt, false) : null;
        if (!pair && /(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(txt) && typeof resolveGoogleShortLinkUniversal === 'function') {
            pair = await resolveGoogleShortLinkUniversal(txt);
        }
        if (!pair) {
            const nums = txt.match(/-?\d+\.\d+/g);
            if (nums && nums.length >= 2) pair = { lat: nums[0], lon: nums[1] };
        }
        if (!pair) return null;

        let lat = parseFloat(pair.lat), lon = parseFloat(pair.lon);
        if (isNaN(lat) || isNaN(lon)) return null;
        if (lat > 90 && lon < 90) { const tmp = lat; lat = lon; lon = tmp; }
        return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
    }

    function openPmPlanFormModal(planId = null, presetDate = null, presetLat = null, presetLon = null, presetScadaPinId = null) {
        if (!canManagePmSchedule()) {
            showToast('🔒 เฉพาะแอดมินและผู้ใช้งานทั่วไปเท่านั้นที่เพิ่ม/แก้ไขแผนงานได้');
            return;
        }
        injectPmModalsDOM();
        loadPmPlansFromStorage();
        editingPlanId = planId || null;

        const modal = document.getElementById('pmPlanFormModal');
        const titleHdr = document.getElementById('pmPlanFormTitle');
        const delBtn = document.getElementById('pmDeleteBtnInModal');
        if (!modal) return;

        if (editingPlanId) {
            const target = pmPlans.find(p => p.id === editingPlanId && !p.pmDeleted);
            if (!target) return;
            if (titleHdr) titleHdr.textContent = '✏️ แก้ไขข้อมูล / หมุดแผนงานบำรุงรักษา';
            populatePmScadaPinPicker(target.linkedPinId || '');
            selectPmFormPinColor(target.pinColor || 'auto');
            document.getElementById('pmTitleInput').value = target.title || '';
            document.getElementById('pmCategorySelect').value = target.category || 'scada';
            document.getElementById('pmDateInput').value = target.date || getTodayIso();
            document.getElementById('pmTimeSlotInput').value = target.timeSlot || '09.00-12.00';
            document.getElementById('pmNotifyBeforeSelect').value = String(target.notifyDaysBefore ?? 3);
            document.getElementById('pmRepeatMonthsSelect').value = String(target.repeatMonths ?? 0);
            document.getElementById('pmEquipCodeInput').value = target.equipCode || '';
            document.getElementById('pmFeederInput').value = target.feeder || '';
            const hasC = !isNaN(parseFloat(target.lat)) && !isNaN(parseFloat(target.lon));
            document.getElementById('pmCoordInput').value = hasC ? `${Number(target.lat).toFixed(6)}, ${Number(target.lon).toFixed(6)}` : (target.gpsLink || '');
            document.getElementById('pmNoteInput').value = target.note || '';
            delBtn?.classList.remove('hidden');
            if (hasC && isFormMiniMapOpen) syncFormMiniMapMarker(Number(target.lat), Number(target.lon), true);
        } else {
            if (titleHdr) titleHdr.textContent = (presetLat != null && presetLon != null) ? '📍 ปักหมุดแผนงานใหม่ (จากจุดที่แตะบนแมพ)' : '➕ เพิ่มหมุดแผนงานบำรุงรักษาใหม่';
            populatePmScadaPinPicker(presetScadaPinId || '');
            selectPmFormPinColor('auto');
            document.getElementById('pmTitleInput').value = '';
            document.getElementById('pmCategorySelect').value = presetScadaPinId ? 'scada' : 'tree';
            document.getElementById('pmDateInput').value = presetDate || selectedDateIso || getTodayIso();
            document.getElementById('pmTimeSlotInput').value = '09.00-12.00';
            document.getElementById('pmNotifyBeforeSelect').value = '3';
            document.getElementById('pmRepeatMonthsSelect').value = '0';
            document.getElementById('pmEquipCodeInput').value = '';
            document.getElementById('pmFeederInput').value = '';
            document.getElementById('pmCoordInput').value = (presetLat != null && presetLon != null)
                ? `${Number(presetLat).toFixed(6)}, ${Number(presetLon).toFixed(6)}`
                : '';
            document.getElementById('pmNoteInput').value = '';
            delBtn?.classList.add('hidden');

            if (presetScadaPinId) onPmScadaEquipPick(presetScadaPinId);
            if (presetLat != null && presetLon != null) togglePmFormMiniMap(true);
        }

        modal.classList.remove('hidden');
        setTimeout(() => document.getElementById('pmTitleInput')?.focus(), 80);
    }

    function closePmPlanFormModal() {
        editingPlanId = null;
        document.getElementById('pmPlanFormModal')?.classList.add('hidden');
    }

    async function savePmPlanFromModal() {
        if (!canManagePmSchedule()) return;

        const title = (document.getElementById('pmTitleInput')?.value || '').trim();
        const category = document.getElementById('pmCategorySelect')?.value || 'scada';
        const pinColor = document.getElementById('pmPinColorInput')?.value || 'auto';
        const dateVal = (document.getElementById('pmDateInput')?.value || '').trim();
        const timeSlot = (document.getElementById('pmTimeSlotInput')?.value || '').trim() || '09.00-12.00';
        const notifyDaysBefore = parseInt(document.getElementById('pmNotifyBeforeSelect')?.value || '3', 10);
        const repeatMonths = parseInt(document.getElementById('pmRepeatMonthsSelect')?.value || '0', 10);
        const linkedPinId = (document.getElementById('pmScadaPinPicker')?.value || '').trim();
        const equipCode = (document.getElementById('pmEquipCodeInput')?.value || '').trim();
        const feeder = (document.getElementById('pmFeederInput')?.value || '').trim().toUpperCase();
        const rawCoord = (document.getElementById('pmCoordInput')?.value || '').trim();
        const note = (document.getElementById('pmNoteInput')?.value || '').trim();
        const saveBtn = document.getElementById('pmSaveSubmitBtn');

        if (!title) { showToast('⚠️ กรุณาระบุชื่อหมุดแผนงาน / หัวข้องาน'); return; }
        if (!dateVal) { showToast('⚠️ กรุณาเลือกวันที่กำหนดทำ'); return; }

        let parsedCoord = null;
        if (rawCoord) {
            if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ กำลังตรวจสอบพิกัด...'; }
            parsedCoord = await parsePmCoordOrShortLink(rawCoord);
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 บันทึกหมุดแผนงาน'; }
            if (!parsedCoord) { showToast('❌ รูปแบบพิกัดหรือลิงก์ Maps ไม่ถูกต้อง'); return; }
        }

        loadPmPlansFromStorage();
        const nowIso = new Date().toISOString();
        const curUser = (rawGet('elec_app_current_user') || 'admin').trim();
        const myGroup = getActivePmGroup();
        const gpsLink = parsedCoord ? `https://www.google.com/maps?q=${parsedCoord.lat.toFixed(6)},${parsedCoord.lon.toFixed(6)}` : '';

        if (editingPlanId) {
            const idx = pmPlans.findIndex(p => p.id === editingPlanId);
            if (idx !== -1) {
                pmPlans[idx] = {
                    ...pmPlans[idx],
                    title, category, pinColor, date: dateVal, timeSlot,
                    notifyDaysBefore: isNaN(notifyDaysBefore) ? 3 : notifyDaysBefore,
                    repeatMonths: isNaN(repeatMonths) ? 0 : repeatMonths,
                    linkedPinId: linkedPinId || undefined,
                    equipCode, feeder, note,
                    lat: parsedCoord ? parsedCoord.lat : null,
                    lon: parsedCoord ? parsedCoord.lon : null,
                    gpsLink, updatedBy: curUser, updatedAt: nowIso
                };
            }
        } else {
            pmPlans.push({
                id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                title, category, pinColor, date: dateVal, timeSlot,
                notifyDaysBefore: isNaN(notifyDaysBefore) ? 3 : notifyDaysBefore,
                repeatMonths: isNaN(repeatMonths) ? 0 : repeatMonths,
                linkedPinId: linkedPinId || undefined,
                equipCode, feeder, note,
                lat: parsedCoord ? parsedCoord.lat : null,
                lon: parsedCoord ? parsedCoord.lon : null,
                gpsLink, status: 'pending', ownerGroup: myGroup,
                createdBy: curUser, updatedBy: curUser, updatedAt: nowIso
            });
        }

        selectedDateIso = dateVal;
        const [y, m] = dateVal.split('-').map(Number);
        if (y && m) { viewYear = y; viewMonth = m - 1; }
        currentFilterStatus = 'day';

        closePmPlanFormModal();
        await savePmPlansAndSync(true);
        showToast(parsedCoord ? '📍 บันทึกหมุดแผนงานบนแผนที่และปฏิทินแล้ว!' : '✅ บันทึกแผนงานลงปฏิทินเรียบร้อยแล้ว');
    }

    function deletePmPlanById(planId, closeFormAfter = false) {
        if (!planId || !canManagePmSchedule()) return;
        loadPmPlansFromStorage();
        const target = pmPlans.find(p => p.id === planId && !p.pmDeleted);
        if (!target) return;

        showCustomConfirm(`ต้องการลบแผนงาน "${target.title}" ออกจากปฏิทินและแผนที่ใช่หรือไม่?`, async function () {
            const idx = pmPlans.findIndex(p => p.id === planId);
            if (idx !== -1) {
                pmPlans[idx] = {
                    id: pmPlans[idx].id,
                    ownerGroup: pmPlans[idx].ownerGroup || getActivePmGroup(),
                    pmDeleted: true,
                    updatedAt: new Date().toISOString()
                };
            }
            if (closeFormAfter) closePmPlanFormModal();
            await savePmPlansAndSync(true);
            showToast('🗑️ ลบหมุดแผนงานเรียบร้อยแล้ว');
        }, '🗑️ ยืนยันการลบแผนงาน');
    }

    function deletePmPlanFromModal() { if (editingPlanId) deletePmPlanById(editingPlanId, true); }
    function quickDeletePmPlanCard(planId) { deletePmPlanById(planId, false); }

    async function togglePmPlanCompleteStatus(planId) {
        if (!canCompletePmTask()) return;
        loadPmPlansFromStorage();
        const idx = pmPlans.findIndex(p => p.id === planId && !p.pmDeleted);
        if (idx === -1) return;

        const plan = pmPlans[idx];
        const nextStatus = plan.status === 'done' ? 'pending' : 'done';
        const nowIso = new Date().toISOString();
        const curUser = formatTechDisplayName(rawGet('elec_app_current_user') || 'ผู้ปฏิบัติงาน');

        plan.status = nextStatus;
        plan.completedAt = nextStatus === 'done' ? nowIso : undefined;
        plan.completedBy = nextStatus === 'done' ? curUser : undefined;
        plan.updatedAt = nowIso;

        let spawnedNextDate = '';
        if (nextStatus === 'done' && Number(plan.repeatMonths) > 0 && !plan.spawnedNextCycle) {
            spawnedNextDate = addMonthsToIsoDate(plan.date, Number(plan.repeatMonths));
            plan.spawnedNextCycle = true;
            pmPlans.push({
                ...plan,
                id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                date: spawnedNextDate,
                status: 'pending',
                completedAt: undefined,
                completedBy: undefined,
                spawnedNextCycle: undefined,
                updatedAt: new Date(Date.now() + 10).toISOString()
            });
        }

        scadaMapRef?.closePopup();
        repairMapRef?.closePopup();
        calendarMapInstance?.closePopup();

        await savePmPlansAndSync(true);
        showToast(spawnedNextDate
            ? `✅ เสร็จสิ้น! และปักหมุดรอบถัดไป (${formatThaiDateShort(spawnedNextDate)}) อัตโนมัติแล้ว`
            : (nextStatus === 'done' ? '✅ บันทึกดำเนินงานเสร็จสิ้นแล้ว' : '↩️ เปิดหมุดแผนงานกลับมาใหม่แล้ว'));
    }

    // ========================================================================
    // 10. นำทาง GPS, แชร์ LINE, ส่งออก Excel, ตั้งเวลาเตือน 00:00/07:00 & เริ่มต้นระบบ
    // ========================================================================
    function navigatePmPlanGps(itemId) {
        const item = getAllVisibleCalendarItems().find(x => x.id === itemId);
        if (!item) return;

        if (item.linkedPinId && typeof window.startLabeledPlaceNavigation === 'function') {
            closePmCalendarModal();
            document.getElementById('pmAlertPopupModal')?.classList.add('hidden');
            window.startLabeledPlaceNavigation(item.linkedPinId, true);
            return;
        }
        const lat = parseFloat(item.lat), lon = parseFloat(item.lon);
        if (isNaN(lat) || isNaN(lon)) {
            showToast('⚠️ หมุดแผนงานนี้ยังไม่ได้ระบุพิกัด GPS');
            return;
        }
        if (typeof window.recordEquipmentNavStart === 'function' && !isViewerRole()) {
            window.recordEquipmentNavStart(
                { id: item.id, name: `PM: ${item.title}`, note: item.note || '', ownerGroup: item.ownerGroup || getActivePmGroup(), lat, lon },
                { distanceKm: '2.0', durationMin: 5, isArrived: false }
            );
        }
        window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=driving`, '_blank');
    }

    function shareSinglePmPlanToLine(itemId) {
        const item = getAllVisibleCalendarItems().find(x => x.id === itemId);
        if (!item) return;
        const cat = getCategoryMeta(item.category);
        const lines = [
            `📅 หมุดแผนงานบำรุงรักษา (${item.ownerGroup || getActivePmGroup()})`,
            `${cat.icon} ประเภท : ${cat.name}`,
            `🏷️ เรื่อง : ${item.title}`,
            `🗓️ กำหนดการ : ${formatThaiDateFull(item.date)} (${item.timeSlot || '-'})`
        ];
        if (item.equipCode) lines.push(`⚡ อุปกรณ์ : ${item.equipCode}${item.feeder ? ` (วงจร ${item.feeder})` : ''}`);
        if (item.note) lines.push(`📝 รายละเอียด : ${item.note}`);
        if (!isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lon))) {
            lines.push(`📍 พิกัดหมุด : https://www.google.com/maps?q=${Number(item.lat).toFixed(6)},${Number(item.lon).toFixed(6)}`);
        }
        const txt = lines.join('\n');
        copyPmTextSafe(txt, '💬 คัดลอกแผนงานและกำลังเปิดแอป LINE...');
        window.open('https://line.me/R/share?text=' + encodeURIComponent(txt), '_blank');
    }

    function shareDailyOrAlertSummaryToLine() {
        const alerts = getAlertCandidatesForToday();
        const list = alerts.length > 0 ? alerts : getAllVisibleCalendarItems().filter(i => i.date === selectedDateIso);
        if (list.length === 0) { showToast('⚠️ ไม่มีรายการแผนงานสำหรับส่งสรุปเข้า LINE'); return; }

        const hdr = alerts.length > 0
            ? `🔔 สรุปแจ้งเตือนแผนงานบำรุงรักษา (${getActivePmGroup()})\n📅 ณ ${formatThaiDateFull(getTodayIso())}`
            : `📅 แผนงานบำรุงรักษา (${getActivePmGroup()})\n🗓️ ${formatThaiDateFull(selectedDateIso)}`;

        const body = list.slice(0, 15).map((it, idx) => {
            const cat = getCategoryMeta(it.category);
            const dTag = it.daysLeft !== undefined ? (it.daysLeft < 0 ? `[เลย ${Math.abs(it.daysLeft)} วัน] ` : (it.daysLeft === 0 ? '[วันนี้] ' : `[อีก ${it.daysLeft} วัน] `)) : '';
            const gps = (!isNaN(parseFloat(it.lat)) && !isNaN(parseFloat(it.lon))) ? `\n   📍 https://www.google.com/maps?q=${Number(it.lat).toFixed(6)},${Number(it.lon).toFixed(6)}` : '';
            return `${idx + 1}. ${dTag}${cat.icon} ${it.title} (${formatThaiDateShort(it.date)})${gps}`;
        }).join('\n');

        const full = `${hdr}\n━━━━━━━━━━━━━━━━━━\n${body}`;
        copyPmTextSafe(full, '💬 คัดลอกสรุปแผนงานและกำลังเปิด LINE...');
        window.open('https://line.me/R/share?text=' + encodeURIComponent(full), '_blank');
    }

    async function exportPmPlansToExcel() {
        const items = getAllVisibleCalendarItems();
        if (items.length === 0) { showToast('⚠️ ยังไม่มีข้อมูลแผนงานสำหรับส่งออก'); return; }
        const myGrp = getActivePmGroup();
        const headers = ['ลำดับ', 'กลุ่มสังกัด', 'วันที่กำหนด', 'เวลา', 'ประเภทงาน', 'หัวข้อแผนงาน', 'รหัสอุปกรณ์', 'วงจร', 'รายละเอียด', 'เตือนล่วงหน้า(วัน)', 'สถานะ', 'ผู้ทำเสร็จ', 'ลิงก์พิกัดหมุด'];
        const rows = items.map((it, i) => [
            String(i + 1), it.ownerGroup || myGrp, formatThaiDateShort(it.date), it.timeSlot || '-',
            getCategoryMeta(it.category).name, it.title || '-', it.equipCode || '-', it.feeder || '-',
            it.note || '-', String(it.notifyDaysBefore ?? 3), it.status === 'done' ? 'เสร็จสิ้นแล้ว' : 'รอดำเนินการ',
            it.completedBy || '-', (!isNaN(parseFloat(it.lat)) && !isNaN(parseFloat(it.lon))) ? `https://www.google.com/maps?q=${Number(it.lat).toFixed(6)},${Number(it.lon).toFixed(6)}` : '-'
        ]);
        const fn = `PM_Schedule_${myGrp.replace(/\s+/g, '_')}_${getTodayIso()}.xlsx`;
        if ((await loadPmXlsxSafe()) && typeof XLSX !== 'undefined') {
            const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
            XLSX.utils.book_append_sheet(wb, ws, 'หมุดแผนงาน_PM');
            XLSX.writeFile(wb, fn);
            showToast(`📊 ส่งออกไฟล์ Excel (${items.length} แผนงาน) สำเร็จ!`);
        } else if (Core && typeof Core.downloadCsvFallback === 'function') {
            Core.downloadCsvFallback(headers, rows, fn);
        }
    }

    function updatePmSoundAndNotifButtonsUI() {
        const sndBtn = document.getElementById('pmSoundToggleBtn');
        if (sndBtn) sndBtn.textContent = isPmSoundEnabled ? '🔔 เสียง: เปิด' : '🔕 เสียง: ปิด';
        const permBtn = document.getElementById('pmNotifPermBtn');
        if (permBtn && 'Notification' in window) {
            permBtn.textContent = Notification.permission === 'granted' ? '📲 แจ้งเตือน: เปิดแล้ว' : '📲 แจ้งเตือนเครื่อง';
        }
    }

    function togglePmSoundSetting() {
        isPmSoundEnabled = !isPmSoundEnabled;
        localStorage.setItem(PM_SOUND_KEY, String(isPmSoundEnabled));
        updatePmSoundAndNotifButtonsUI();
        if (isPmSoundEnabled) playPmAlertChime();
        showToast(isPmSoundEnabled ? '🔔 เปิดเสียงเตือนแผนงานแล้ว' : '🔕 ปิดเสียงเตือนแผนงานแล้ว');
    }

    async function requestPmBrowserNotificationPermission() {
        if (!('Notification' in window)) { showToast('⚠️ เบราว์เซอร์นี้ไม่รองรับ System Notification'); return; }
        const perm = await Notification.requestPermission();
        updatePmSoundAndNotifButtonsUI();
        if (perm === 'granted') { showToast('✅ เปิดแจ้งเตือนบนเครื่องเรียบร้อย!'); checkAndTriggerScheduledPmAlerts(true); }
    }

    function checkExactScheduleClockTick() {
        if (rawGet('elec_app_logged_in') !== 'true' || (Core && Core.isEmbeddedIframe)) return;
        const now = new Date();
        const hr = now.getHours(), min = now.getMinutes();
        const minKey = `${toLocalIsoDate(now)}_${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        if (minKey === lastCheckedAlertMinuteKey) return;
        lastCheckedAlertMinuteKey = minKey;

        if ((hr === 0 && min === 0) || (hr === 7 && min === 0)) {
            refreshPmAllViews();
            checkAndTriggerScheduledPmAlerts(false);
        } else if (min === 0) {
            refreshPmAllViews();
        }
    }

    bindLeafletMapHooks();

    if (Core && typeof Core.onRealtimeChange === 'function') {
        Core.onRealtimeChange((keys) => {
            if (keys.some(k => k === 'elec_tech_locations_map' || k === PM_STORAGE_KEY)) syncPmPlansFromLocationsMap();
            if (keys.some(k => k === 'elec_labeled_places_list' || k === 'elec_deleted_labeled_places_map')) refreshPmAllViews();
        });
    }

    Object.assign(window, {
        openPmCalendarModal, closePmCalendarModal, changePmCalendarMonth, jumpPmCalendarToday,
        selectPmCalendarDate, setPmListStatusFilter, toggleShowScadaDueOnCalendar, togglePmTechStripCollapse,
        switchCalendarLeftViewMode, fitCalendarEmbeddedMapPins, toggleShowPmPinsOnMaps, cyclePmMapFilterMode,
        togglePmPinDropMode, startMovePmPlanPinOnMap, cancelPmMapInteractiveModes, focusPmPlanPinOnMap,
        focusQuickInlineInputForDate, startPmQuickVoiceInput, expandQuickInputToFullModal, submitQuickInlinePmPlan, quickEditPmPlanTitle,
        selectPmFormPinColor, togglePmFormMiniMap, onPmCoordTextManualInput, onPmScadaEquipPick, fillPmCurrentMobileGps,
        openPmPlanFormModal, closePmPlanFormModal, savePmPlanFromModal, deletePmPlanFromModal, quickDeletePmPlanCard,
        togglePmPlanCompleteStatus, navigatePmPlanGps, shareSinglePmPlanToLine, shareDailyOrAlertSummaryToLine,
        exportPmPlansToExcel, togglePmSoundSetting, requestPmBrowserNotificationPermission, acknowledgeCurrentPmAlertRound
    });

    function bootstrapPmCalendarModule() {
        bindLeafletMapHooks();
        injectPmCalendarStyles();
        injectPmModalsDOM();
        injectQuickAddBoxIntoCalendar();
        loadPmPlansFromStorage();
        syncPmPlansFromLocationsMap();
        updatePmSoundAndNotifButtonsUI();
        refreshPmAllViews();

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

        setTimeout(() => {
            syncPmPlansFromLocationsMap();
            refreshPmAllViews();
            checkAndTriggerScheduledPmAlerts(false);
        }, 1400);

        setInterval(checkExactScheduleClockTick, 15000);
        setInterval(() => {
            if (!document.hidden && rawGet('elec_app_logged_in') === 'true') {
                syncPmPlansFromLocationsMap();
                updatePmHeaderBadgesAndStrip();
            }
        }, 10000);
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', bootstrapPmCalendarModule);
    } else {
        bootstrapPmCalendarModule();
    }
})();
// ==================== จบไฟล์ pm-calendar.js ====================