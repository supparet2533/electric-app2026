// ============================================================================
// 📅⚡ PEA SMART GRID — MAINTENANCE SCHEDULE & ALERT CALENDAR v6.0 (pm-calendar.js)
// ระบบปฏิทินแผนงานบำรุงรักษารายเดือน แจ้งเตือนอัตโนมัติ 00.00 น. / 07.00 น. และแนบพิกัด GPS
// พาทที่ 1 / 3 : State, Date Helpers, Cloud/MQTT Sync & 00:00 / 07:00 Alert Engine
// ============================================================================
(function () {
    'use strict';

    const Core = window.PeaCore;
    const PM_STORAGE_KEY = 'elec_pm_calendar_plans_v1';
    const PM_ACK_LOG_KEY = 'elec_pm_alert_ack_log_v1';
    const PM_SOUND_KEY = 'elec_pm_alert_sound_enabled';
    const PM_SHOW_SCADA_DUE_KEY = 'elec_pm_show_scada_due_pins';
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
            barBg: '#10b981'
        },
        scada: {
            key: 'scada',
            icon: '⚡',
            name: 'ตรวจสวิตช์ / อุปกรณ์ SCADA',
            pillCls: 'bg-sky-100 text-sky-800 border-sky-300',
            barBg: '#0284c7'
        },
        tr: {
            key: 'tr',
            icon: '🔌',
            name: 'บำรุงรักษาหม้อแปลง / โหลด',
            pillCls: 'bg-amber-100 text-amber-900 border-amber-300',
            barBg: '#f59e0b'
        },
        thermo: {
            key: 'thermo',
            icon: '🔥',
            name: 'ส่องกล้องความร้อน (Thermo)',
            pillCls: 'bg-rose-100 text-rose-800 border-rose-300',
            barBg: '#e11d48'
        },
        patrol: {
            key: 'patrol',
            icon: '🛠️',
            name: 'แผนดับไฟปฏิบัติงาน / อื่นๆ',
            pillCls: 'bg-purple-100 text-purple-800 border-purple-300',
            barBg: '#7c3aed'
        }
    };

    const nowInit = new Date();
    let pmPlans = [];
    let viewYear = nowInit.getFullYear();
    let viewMonth = nowInit.getMonth();
    let selectedDateIso = toLocalIsoDate(nowInit);
    let editingPlanId = null;
    let currentFilterStatus = 'all';
    let isTechStripCollapsed = false;

    let isPmSoundEnabled = localStorage.getItem(PM_SOUND_KEY) !== 'false';
    let showScadaDuePins = localStorage.getItem(PM_SHOW_SCADA_DUE_KEY) !== 'false';
    let isSyncingPmInternal = false;
    let lastCheckedAlertMinuteKey = '';

    // ========================================================================
    // 1. ฟังก์ชันจัดการวันที่ พ.ศ. & ตรวจสอบสิทธิ์ตามกลุ่มสังกัด (กฟส.)
    // ========================================================================
    function rawGet(key) {
        return Core && typeof Core.rawStorageGet === 'function'
            ? Core.rawStorageGet(key)
            : localStorage.getItem(key);
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

    function getActivePmGroup() {
        const g = (typeof getCurrentUserGroup === 'function' ? getCurrentUserGroup() : '') ||
                  rawGet('elec_app_current_group') || '';
        return g.trim() || 'กฟส.บึง';
    }

    function canManagePmSchedule() {
        return rawGet('elec_app_logged_in') === 'true' &&
               !isViewerRole() &&
               canCurrentUserEditScada();
    }

    function canCompletePmTask() {
        return rawGet('elec_app_logged_in') === 'true' && !isViewerRole();
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

    // ========================================================================
    // 2. คลังข้อมูลแผนงาน & ซิงค์อัตโนมัติผ่าน MQTT + Google Sheets (ไม่ต้องแก้ Code.gs)
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
                const shardKey = PM_LOC_PREFIX + grp;
                locMap[shardKey] = {
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
        const afterSig = JSON.stringify(merged);

        if (afterSig !== beforeSig) {
            pmPlans = merged;
            localStorage.setItem(PM_STORAGE_KEY, JSON.stringify(pmPlans));
            if (typeof refreshPmAllViews === 'function') refreshPmAllViews();
            checkAndTriggerScheduledPmAlerts(false);
            return true;
        }
        return false;
    }

    // ดึงหมุดอุปกรณ์ในผัง SCADA ที่ตั้ง "วันที่ครบกำหนดเปลี่ยนสี" มารวมบนปฏิทินอัตโนมัติ
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

    // ========================================================================
    // 3. ระบบแจ้งเตือนอัตโนมัติ 2 รอบ (00.00 น. และ 07.00 น.) + เตือนล่วงหน้า
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
        const todayIso = toLocalIsoDate(now);
        const isMorningRound = now.getHours() >= 7;
        return {
            slotKey: `${todayIso}_${isMorningRound ? '07' : '00'}`,
            roundCode: isMorningRound ? '07:00' : '00:00',
            roundTitle: isMorningRound
                ? '🌅 แจ้งเตือนแผนบำรุงรักษารอบเช้า (07.00 น.)'
                : '🌙 แจ้งเตือนแผนบำรุงรักษารอบเที่ยงคืน (00.00 น.)'
        };
    }

    function getAckLogMap() {
        try { return JSON.parse(rawGet(PM_ACK_LOG_KEY) || '{}'); } catch (e) { return {}; }
    }

    function acknowledgeCurrentPmAlertRound() {
        const curUser = (rawGet('elec_app_current_user') || 'guest').trim();
        const { slotKey } = getCurrentAlertRoundInfo();
        const candidates = getAlertCandidatesForToday();
        const ackMap = getAckLogMap();
        const ackId = `${curUser}__${getActivePmGroup()}__${slotKey}`;

        ackMap[ackId] = candidates.map(c => c.id);
        const keys = Object.keys(ackMap);
        if (keys.length > 80) {
            keys.slice(0, keys.length - 80).forEach(k => delete ackMap[k]);
        }
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
            const notes = [523.25, 659.25, 783.99, 1046.5];
            notes.forEach((freq, idx) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.14);
                gain.gain.setValueAtTime(0.16, ctx.currentTime + idx * 0.14);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.14 + 0.28);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(ctx.currentTime + idx * 0.14);
                osc.stop(ctx.currentTime + idx * 0.14 + 0.28);
            });
            setTimeout(() => { if (ctx?.close) ctx.close().catch(() => {}); }, 1200);
        } catch (e) {}
    }

    function fireBrowserSystemNotification(roundTitle, candidates) {
        if ((Core && Core.isEmbeddedIframe) || !('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;
        try {
            const todayCnt = candidates.filter(c => c.daysLeft === 0).length;
            const overCnt = candidates.filter(c => c.daysLeft < 0).length;
            const upCnt = candidates.filter(c => c.daysLeft > 0).length;
            const parts = [];
            if (todayCnt > 0) parts.push(`วันนี้ ${todayCnt} งาน`);
            if (overCnt > 0) parts.push(`เกินกำหนด ${overCnt} งาน`);
            if (upCnt > 0) parts.push(`เตือนล่วงหน้า ${upCnt} งาน`);

            const n = new Notification(roundTitle, {
                body: `${getActivePmGroup()}: ${parts.join(' • ')}\n1) ${candidates[0]?.title || ''}`,
                tag: 'pea-pm-alert-' + getCurrentAlertRoundInfo().slotKey
            });
            n.onclick = () => {
                window.focus();
                if (typeof openPmCalendarModal === 'function') openPmCalendarModal();
                n.close();
            };
        } catch (e) {}
    }

    function checkAndTriggerScheduledPmAlerts(forceShow = false) {
        if (rawGet('elec_app_logged_in') !== 'true' || (Core && Core.isEmbeddedIframe)) return;
        const candidates = getAlertCandidatesForToday();
        if (typeof updatePmHeaderBadgesAndStrip === 'function') updatePmHeaderBadgesAndStrip(candidates);
        if (candidates.length === 0) return;

        const curUser = (rawGet('elec_app_current_user') || 'guest').trim();
        const { slotKey, roundTitle } = getCurrentAlertRoundInfo();
        const ackMap = getAckLogMap();
        const ackId = `${curUser}__${getActivePmGroup()}__${slotKey}`;
        const ackedIds = new Set(Array.isArray(ackMap[ackId]) ? ackMap[ackId] : []);

        const hasUnackedItems = candidates.some(c => !ackedIds.has(c.id));
        if (!forceShow && !hasUnackedItems) return;

        playPmAlertChime();
        fireBrowserSystemNotification(roundTitle, candidates);
        if (typeof showPmAlertSummaryModal === 'function') {
            showPmAlertSummaryModal(roundTitle, candidates);
        }
    }
    // ===== จบพาทที่ 1 / 3 ของไฟล์ pm-calendar.js (นำพาทที่ 2 / 3 มาวางต่อจากบรรทัดนี้ได้เลยครับ) =====
        // ===== เริ่มพาทที่ 2 / 3 ของไฟล์ pm-calendar.js (วางต่อจากพาทที่ 1 / 3) =====

    // ========================================================================
    // 4. สไตล์ชีต, ปุ่มเปิดปฏิทินบน Header ทั้ง 2 หน้า & แถบคิวงานหน้าช่าง
    // ========================================================================
    function injectPmCalendarStyles() {
        if (document.getElementById('peaPmCalendarStyles')) return;
        const st = document.createElement('style');
        st.id = 'peaPmCalendarStyles';
        st.textContent = `
            .pm-day-cell { min-height: 62px; transition: all 0.15s ease; }
            @media (min-width: 640px) { .pm-day-cell { min-height: 78px; } }
            .pm-day-cell:hover { background-color: #f0f9ff; border-color: #60a5fa; }
            .pm-day-selected { background-color: #eff6ff !important; border-color: #2563eb !important; box-shadow: inset 0 0 0 1.5px #2563eb; }
            .pm-badge-pulse { animation: pmPulseGlow 1.8s infinite ease-in-out; }
            @keyframes pmPulseGlow {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.06); }
            }
            body.role-viewer-readonly .pm-edit-only { display: none !important; }
        `;
        document.head.appendChild(st);
    }

    function injectPmHeaderButtonsAndStrip() {
        // 1. ปุ่มปฏิทินบนแถบด้านบนของหน้าหลัก (index.html)
        const mainHeaderGrp = document.querySelector('#mainAppContent .bg-gradient-to-r .flex.items-center.gap-1\\.5.shrink-0');
        if (mainHeaderGrp && !document.getElementById('pmMainHeaderBtn')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'pmMainHeaderBtn';
            btn.onclick = () => openPmCalendarModal();
            btn.className = 'bg-indigo-500/90 hover:bg-indigo-600 text-white px-2.5 py-1.5 rounded-xl text-xs transition shadow-sm flex items-center gap-1 font-semibold border border-indigo-300/40';
            btn.title = 'เปิดปฏิทินแผนงานบำรุงรักษา (PM)';
            btn.innerHTML = `📅 <span>แผน PM</span><span id="pmMainAlertCountBadge" class="hidden bg-rose-500 text-white text-[10px] font-extrabold px-1.5 py-0.2 rounded-full">0</span>`;
            const backupBtn = mainHeaderGrp.querySelector('button[onclick="openBackupModal()"]');
            if (backupBtn) mainHeaderGrp.insertBefore(btn, backupBtn);
            else mainHeaderGrp.appendChild(btn);
        }

        // 2. ปุ่มปฏิทินบนแถบด้านบนของหน้าช่าง (page2.html)
        const techHeaderGrp = document.querySelector('#techMainApp .bg-gradient-to-r .flex.flex-wrap.items-center.gap-1\\.5');
        if (techHeaderGrp && !document.getElementById('pmTechHeaderBtn')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'pmTechHeaderBtn';
            btn.onclick = () => openPmCalendarModal();
            btn.className = 'bg-indigo-500/90 hover:bg-indigo-600 text-white px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm flex items-center gap-1 border border-indigo-300/40';
            btn.title = 'ดูปฏิทินแผนงานบำรุงรักษา';
            btn.innerHTML = `📅 <span>แผน PM</span><span id="pmTechAlertCountBadge" class="hidden bg-rose-500 text-white text-[10px] font-extrabold px-1.5 py-0.2 rounded-full">0</span>`;
            techHeaderGrp.insertBefore(btn, techHeaderGrp.firstChild);
        }

        // 3. แถบคิวแผนบำรุงรักษาที่ถึงกำหนดวันนี้/ใกล้ถึง ในหน้าช่าง (page2.html)
        const jobCardsEl = document.getElementById('jobCardsContainer');
        if (jobCardsEl?.parentElement && !document.getElementById('pmTechQueueBannerWrap')) {
            const wrap = document.createElement('div');
            wrap.id = 'pmTechQueueBannerWrap';
            wrap.className = 'hidden px-4 pt-2 pb-1';
            const anchor = document.getElementById('repairJobsMapSection') || jobCardsEl;
            jobCardsEl.parentElement.insertBefore(wrap, anchor);
        }
    }

    function togglePmTechStripCollapse() {
        isTechStripCollapsed = !isTechStripCollapsed;
        updatePmHeaderBadgesAndStrip();
    }

    function updatePmHeaderBadgesAndStrip(preCandidates = null) {
        injectPmHeaderButtonsAndStrip();
        const candidates = preCandidates || getAlertCandidatesForToday();
        const urgentCnt = candidates.filter(c => c.daysLeft <= 0).length;
        const totalAlertCnt = candidates.length;

        ['pmMainAlertCountBadge', 'pmTechAlertCountBadge'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            if (totalAlertCnt > 0) {
                el.textContent = String(totalAlertCnt);
                el.className = `${urgentCnt > 0 ? 'bg-rose-500 pm-badge-pulse' : 'bg-amber-400 text-slate-950'} text-[10px] font-extrabold px-1.5 rounded-full shadow`;
                el.classList.remove('hidden');
            } else {
                el.classList.add('hidden');
            }
        });

        const stripWrap = document.getElementById('pmTechQueueBannerWrap');
        if (!stripWrap) return;
        if (candidates.length === 0 || rawGet('elec_app_logged_in') !== 'true') {
            stripWrap.classList.add('hidden');
            stripWrap.innerHTML = '';
            return;
        }

        stripWrap.classList.remove('hidden');
        const listHtml = isTechStripCollapsed ? '' : `
            <div class="p-2.5 space-y-1.5 bg-white max-h-48 overflow-y-auto">
                ${candidates.slice(0, 6).map(item => {
                    const cat = getCategoryMeta(item.category);
                    const tag = item.daysLeft < 0
                        ? `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-extrabold px-1.5 py-0.5 rounded">เลยกำหนด ${Math.abs(item.daysLeft)} วัน</span>`
                        : (item.daysLeft === 0
                            ? `<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-1.5 py-0.5 rounded">📌 วันนี้ (${escapeHtmlStr(item.timeSlot || 'ทั้งวัน')})</span>`
                            : `<span class="bg-sky-50 text-sky-700 border border-sky-200 text-[10px] font-bold px-1.5 py-0.5 rounded">อีก ${item.daysLeft} วัน (${formatThaiDateShort(item.date)})</span>`);
                    const safeId = String(item.id).replace(/'/g, "\\'");
                    const hasCoord = !isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lon));
                    return `
                        <div class="p-2 rounded-xl border border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2 text-xs">
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-1.5 flex-wrap">
                                    ${tag}
                                    <span class="font-bold text-slate-800 truncate">${cat.icon} ${escapeHtmlStr(item.title)}</span>
                                </div>
                                ${item.equipCode ? `<div class="text-[10px] text-teal-700 font-semibold mt-0.5">⚡ อุปกรณ์: ${escapeHtmlStr(item.equipCode)} ${item.feeder ? `(${escapeHtmlStr(item.feeder)})` : ''}</div>` : ''}
                            </div>
                            <div class="flex items-center gap-1 shrink-0">
                                ${hasCoord ? `<button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold shadow-sm">🗺️ นำทาง</button>` : ''}
                                ${(!item.isScadaPinDue && canCompletePmTask()) ? `<button type="button" onclick="togglePmPlanCompleteStatus('${safeId}')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold shadow-sm">✅ เสร็จแล้ว</button>` : ''}
                            </div>
                        </div>`;
                }).join('')}
            </div>`;

        stripWrap.innerHTML = `
            <div class="rounded-2xl border-2 border-indigo-400/80 overflow-hidden shadow-sm bg-white">
                <div class="bg-gradient-to-r from-indigo-900 via-blue-900 to-teal-800 px-3 py-2 text-white flex items-center justify-between gap-2">
                    <div onclick="openPmCalendarModal()" class="cursor-pointer flex items-center gap-1.5 min-w-0 flex-1">
                        <span class="text-sm">📅</span>
                        <span class="text-xs font-extrabold truncate">แผนบำรุงรักษา (PM): แจ้งเตือน ${candidates.length} รายการ</span>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                        <button type="button" onclick="openPmCalendarModal()" class="bg-white/20 hover:bg-white/30 text-white px-2 py-0.5 rounded-lg text-[10px] font-bold">เปิดปฏิทิน</button>
                        <button type="button" onclick="togglePmTechStripCollapse()" class="bg-white/15 hover:bg-white/25 text-white px-2 py-0.5 rounded-lg text-[10px] font-bold">${isTechStripCollapsed ? '🔽 ขยาย' : '🔼 ย่อ'}</button>
                    </div>
                </div>
                ${listHtml}
            </div>`;
    }

    // ========================================================================
    // 5. สร้างหน้าต่างป๊อปอัปปฏิทินรายเดือน, ฟอร์มแผนงาน & ป๊อปอัปแจ้งเตือน 00:00 / 07:00
    // ========================================================================
    function injectPmModalsDOM() {
        if (!document.getElementById('pmCalendarModal')) {
            const catOptions = Object.values(PM_CATEGORIES)
                .map(c => `<option value="${c.key}">${c.icon} ${c.name}</option>`)
                .join('');

            document.body.insertAdjacentHTML('beforeend', `
                <!-- 📅 หน้าต่างหลัก: ปฏิทินแผนงานบำรุงรักษารายเดือน -->
                <div id="pmCalendarModal" class="fixed inset-0 bg-slate-950/70 hidden z-[1320] flex items-center justify-center p-2 sm:p-4 backdrop-blur-sm">
                    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[94dvh] overflow-hidden flex flex-col border border-slate-200">
                        <div class="px-4 py-3 bg-gradient-to-r from-indigo-900 via-blue-800 to-teal-700 text-white flex flex-wrap justify-between items-center gap-2 shrink-0">
                            <div class="flex items-center gap-2">
                                <span class="text-lg">📅</span>
                                <div>
                                    <h3 class="font-bold text-sm sm:text-base flex items-center gap-2">
                                        <span>ปฏิทินแผนงานบำรุงรักษาระบบไฟฟ้า (PM)</span>
                                        <span id="pmHeaderGroupBadge" class="bg-white/20 text-amber-200 text-[10px] font-extrabold px-2 py-0.5 rounded-md">-</span>
                                    </h3>
                                    <p class="text-[10px] text-blue-100">แจ้งเตือนอัตโนมัติรอบ 00.00 น. และ 07.00 น. พร้อมพิกัดนำทาง GPS</p>
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
                            <!-- ฝั่งซ้าย: ตารางปฏิทินรายเดือน -->
                            <div class="lg:col-span-7 bg-white p-3 rounded-2xl border border-slate-200 shadow-sm space-y-2.5">
                                <div class="flex items-center justify-between gap-2">
                                    <div class="flex items-center gap-1">
                                        <button type="button" onclick="changePmCalendarMonth(-1)" class="px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-extrabold">◀</button>
                                        <button type="button" onclick="jumpPmCalendarToday()" class="px-2.5 py-1.5 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-xs font-bold">วันนี้</button>
                                        <button type="button" onclick="changePmCalendarMonth(1)" class="px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-extrabold">▶</button>
                                    </div>
                                    <h4 id="pmCalendarMonthTitle" class="text-sm sm:text-base font-extrabold text-slate-800">-</h4>
                                    <label class="flex items-center gap-1 text-[10px] font-bold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-1 rounded-lg cursor-pointer select-none">
                                        <input type="checkbox" id="pmShowScadaDueChk" onchange="toggleShowScadaDueOnCalendar(this.checked)" class="accent-teal-600 rounded">
                                        <span>รวมหมุด SCADA</span>
                                    </label>
                                </div>

                                <div id="pmMonthSummaryBar" class="grid grid-cols-4 gap-1.5 text-center text-[10px]"></div>

                                <div class="grid grid-cols-7 gap-1 text-center text-[11px] font-extrabold text-slate-500 pt-1">
                                    <div class="text-rose-500">อา.</div><div>จ.</div><div>อ.</div><div>พ.</div><div>พฤ.</div><div>ศ.</div><div class="text-indigo-600">ส.</div>
                                </div>
                                <div id="pmCalendarDaysGrid" class="grid grid-cols-7 gap-1"></div>
                            </div>

                            <!-- ฝั่งขวา: รายการแผนงานตามวันที่เลือก / แจ้งเตือนล่วงหน้า -->
                            <div class="lg:col-span-5 bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm flex flex-col space-y-2.5">
                                <div class="flex items-center justify-between gap-2">
                                    <div class="grid grid-cols-3 gap-1 flex-1 bg-slate-100 p-1 rounded-xl text-[11px] font-bold">
                                        <button type="button" id="pmFilterBtn-day" onclick="setPmListStatusFilter('day')" class="py-1 rounded-lg">📌 วันที่เลือก</button>
                                        <button type="button" id="pmFilterBtn-alert" onclick="setPmListStatusFilter('alert')" class="py-1 rounded-lg">🔔 แจ้งเตือน</button>
                                        <button type="button" id="pmFilterBtn-all" onclick="setPmListStatusFilter('all')" class="py-1 rounded-lg">📋 ทั้งเดือน</button>
                                    </div>
                                    <button type="button" id="pmAddPlanPrimaryBtn" onclick="openPmPlanFormModal(null, selectedDateIso)" class="pm-edit-only shrink-0 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-xl text-xs font-extrabold shadow-sm">➕ เพิ่มแผน</button>
                                </div>

                                <div id="pmSelectedListHeader" class="text-xs font-bold text-slate-700 px-1 flex items-center justify-between"></div>
                                <div id="pmSelectedDayTasksContainer" class="space-y-2 max-h-[46vh] lg:max-h-[54vh] overflow-y-auto pr-0.5"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 📝 หน้าต่างเพิ่ม / แก้ไขแผนงานบำรุงรักษา -->
                <div id="pmPlanFormModal" class="fixed inset-0 bg-slate-950/75 hidden z-[1360] flex items-center justify-center p-3 backdrop-blur-sm">
                    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[92dvh] overflow-hidden flex flex-col border border-slate-200">
                        <div class="px-4 py-3 bg-gradient-to-r from-blue-700 to-indigo-800 text-white flex justify-between items-center">
                            <h3 id="pmPlanFormTitle" class="font-bold text-sm">➕ เพิ่มแผนงานบำรุงรักษาใหม่</h3>
                            <button type="button" onclick="closePmPlanFormModal()" class="text-white/80 hover:text-white text-xl font-bold leading-none">&times;</button>
                        </div>
                        <div class="p-4 space-y-3 text-xs overflow-y-auto flex-1">
                            <div>
                                <label class="block font-bold text-slate-700 mb-1">🏷️ หัวข้อแผนงานบำรุงรักษา <span class="text-rose-500">*</span></label>
                                <input type="text" id="pmTitleInput" placeholder="เช่น ตัดรอนกิ่งไม้แนวสาย BNF06, ส่อง Thermo หม้อแปลง..." class="w-full px-3.5 py-2 text-sm font-semibold text-slate-800 bg-white">
                            </div>
                            <div class="grid grid-cols-2 gap-2">
                                <div>
                                    <label class="block font-bold text-slate-700 mb-1">📂 ประเภทงาน</label>
                                    <select id="pmCategorySelect" class="w-full px-2.5 py-2 font-bold text-slate-700 bg-white">${catOptions}</select>
                                </div>
                                <div>
                                    <label class="block font-bold text-slate-700 mb-1">📅 วันที่ดำเนินการ <span class="text-rose-500">*</span></label>
                                    <input type="date" id="pmDateInput" class="w-full px-2.5 py-2 font-bold text-slate-800 bg-white">
                                </div>
                            </div>
                            <div class="grid grid-cols-3 gap-2">
                                <div>
                                    <label class="block font-bold text-slate-700 mb-1">⏰ ช่วงเวลา</label>
                                    <input type="text" id="pmTimeSlotInput" placeholder="09.00-12.00" value="08.30 น." class="w-full px-2.5 py-2 text-center font-semibold bg-white">
                                </div>
                                <div>
                                    <label class="block font-bold text-amber-800 mb-1">🔔 เตือนล่วงหน้า</label>
                                    <select id="pmNotifyBeforeSelect" class="w-full px-2 py-2 font-bold text-amber-900 bg-amber-50 border-amber-300">
                                        <option value="0">เฉพาะวันจริง</option>
                                        <option value="1">ล่วงหน้า 1 วัน</option>
                                        <option value="2">ล่วงหน้า 2 วัน</option>
                                        <option value="3" selected>ล่วงหน้า 3 วัน</option>
                                        <option value="5">ล่วงหน้า 5 วัน</option>
                                        <option value="7">ล่วงหน้า 7 วัน</option>
                                        <option value="14">ล่วงหน้า 14 วัน</option>
                                        <option value="30">ล่วงหน้า 30 วัน</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block font-bold text-indigo-800 mb-1">🔁 รอบทำซ้ำ</label>
                                    <select id="pmRepeatMonthsSelect" class="w-full px-2 py-2 font-bold text-indigo-900 bg-indigo-50 border-indigo-200">
                                        <option value="0" selected>ครั้งเดียว</option>
                                        <option value="1">ทุก 1 เดือน</option>
                                        <option value="3">ทุก 3 เดือน</option>
                                        <option value="6">ทุก 6 เดือน</option>
                                        <option value="12">ทุก 1 ปี</option>
                                    </select>
                                </div>
                            </div>

                            <div class="p-2.5 bg-teal-50/80 border border-teal-200 rounded-xl space-y-2">
                                <label class="block font-bold text-teal-900">⚡ ดึงรหัสและพิกัดจากหมุดอุปกรณ์ในผัง SCADA (ถ้ามี)</label>
                                <select id="pmScadaPinPicker" onchange="onPmScadaEquipPick(this.value)" class="w-full px-2.5 py-1.5 bg-white text-xs font-semibold text-slate-700">
                                    <option value="">-- เลือกอุปกรณ์จากผัง SCADA เพื่อดึงพิกัดอัตโนมัติ --</option>
                                </select>
                                <div class="grid grid-cols-2 gap-2">
                                    <input type="text" id="pmEquipCodeInput" placeholder="รหัสอุปกรณ์ เช่น BNF06VS-01" class="px-2.5 py-1.5 bg-white font-semibold">
                                    <input type="text" id="pmFeederInput" placeholder="วงจร เช่น BNF06" class="px-2.5 py-1.5 bg-white font-semibold uppercase">
                                </div>
                            </div>

                            <div>
                                <div class="flex items-center justify-between mb-1">
                                    <label class="font-bold text-slate-700">📍 พิกัดหน้างาน หรือ ลิงก์ Google Maps</label>
                                    <button type="button" onclick="fillPmCurrentMobileGps()" class="text-[10px] bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-lg font-bold">📍 ดึงพิกัดปัจจุบัน</button>
                                </div>
                                <input type="text" id="pmCoordInput" placeholder="วางพิกัด เช่น 13.1361, 101.0322 หรือลิงก์สั้น maps.app.goo.gl" class="w-full px-3 py-2 bg-white">
                            </div>

                            <div>
                                <label class="block font-bold text-slate-700 mb-1">👷 ผู้รับผิดชอบ / รายละเอียดเพิ่มเติม</label>
                                <textarea id="pmNoteInput" rows="2" placeholder="ระบุทีมงาน อุปกรณ์ที่ต้องเตรียม หรือจุดสังเกต..." class="w-full px-3 py-2 bg-white"></textarea>
                            </div>
                        </div>
                        <div class="p-3 bg-slate-50 border-t flex items-center justify-between gap-2">
                            <button type="button" id="pmDeleteBtnInModal" onclick="deletePmPlanFromModal()" class="hidden px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs">🗑️ ลบแผน</button>
                            <div class="flex gap-2 ml-auto">
                                <button type="button" onclick="closePmPlanFormModal()" class="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl text-xs">ยกเลิก</button>
                                <button type="button" id="pmSaveSubmitBtn" onclick="savePmPlanFromModal()" class="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold rounded-xl text-xs shadow">💾 บันทึกแผนงาน</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 🔔 ป๊อปอัปแจ้งเตือนอัตโนมัติรอบ 00.00 น. และ 07.00 น. -->
                <div id="pmAlertPopupModal" class="fixed inset-0 bg-slate-950/75 hidden z-[1420] flex items-center justify-center p-3 backdrop-blur-sm">
                    <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border-2 border-amber-400 flex flex-col max-h-[88dvh]">
                        <div class="px-4 py-3.5 bg-gradient-to-r from-amber-500 via-orange-500 to-rose-600 text-white flex justify-between items-center">
                            <h3 id="pmAlertPopupTitle" class="font-extrabold text-sm flex items-center gap-1.5">🔔 แจ้งเตือนแผนงานบำรุงรักษา</h3>
                            <button type="button" onclick="document.getElementById('pmAlertPopupModal').classList.add('hidden')" class="text-white/85 hover:text-white text-xl font-bold leading-none">&times;</button>
                        </div>
                        <div id="pmAlertPopupBody" class="p-4 space-y-2 overflow-y-auto flex-1 bg-slate-50 text-xs"></div>
                        <div class="p-3 bg-white border-t flex flex-wrap items-center justify-between gap-2">
                            <button type="button" onclick="shareDailyOrAlertSummaryToLine()" class="px-3 py-2 bg-[#00B900] hover:bg-[#009900] text-white rounded-xl text-xs font-extrabold shadow-sm">💬 ส่งเข้า LINE</button>
                            <div class="flex gap-1.5">
                                <button type="button" onclick="document.getElementById('pmAlertPopupModal').classList.add('hidden'); openPmCalendarModal();" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold">📅 ดูปฏิทิน</button>
                                <button type="button" onclick="acknowledgeCurrentPmAlertRound()" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-extrabold shadow">✅ รับทราบรอบนี้</button>
                            </div>
                        </div>
                    </div>
                </div>
            `);
        }
    }

    // ========================================================================
    // 6. เรนเดอร์ตารางปฏิทินรายเดือน, รายการงานรายวัน & ป๊อปอัปสรุปแจ้งเตือน
    // ========================================================================
    function openPmCalendarModal(presetDateIso = null) {
        injectPmModalsDOM();
        if (presetDateIso && /^\d{4}-\d{2}-\d{2}$/.test(presetDateIso)) {
            selectedDateIso = presetDateIso;
            const [y, m] = presetDateIso.split('-').map(Number);
            viewYear = y;
            viewMonth = m - 1;
            currentFilterStatus = 'day';
        } else if (currentFilterStatus !== 'alert') {
            currentFilterStatus = 'day';
        }
        refreshPmAllViews();
        document.getElementById('pmCalendarModal')?.classList.remove('hidden');
    }

    function closePmCalendarModal() {
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
    }

    function selectPmCalendarDate(isoStr) {
        selectedDateIso = isoStr;
        currentFilterStatus = 'day';
        renderPmCalendarGrid();
        renderPmSelectedDayList();
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
        if (!gridEl) return;

        if (grpBadge) grpBadge.textContent = `🏢 ${getActivePmGroup()}`;
        if (scadaChk) scadaChk.checked = showScadaDuePins;
        if (addBtn) addBtn.classList.toggle('hidden', !canManagePmSchedule());
        if (titleEl) titleEl.textContent = `${THAI_MONTHS[viewMonth]} ${viewYear + 543}`;

        const monthPrefix = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-`;
        const allItems = getAllVisibleCalendarItems();
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
                <div class="bg-amber-50 border border-amber-200 rounded-xl py-1.5 px-1 font-bold text-amber-800">รอดำเนินการ <b>${pendingCnt}</b></div>
                <div class="bg-emerald-50 border border-emerald-200 rounded-xl py-1.5 px-1 font-bold text-emerald-800">เสร็จแล้ว <b>${doneCnt}</b></div>
                <div onclick="setPmListStatusFilter('alert')" class="cursor-pointer bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl py-1.5 px-1 font-extrabold text-rose-700">🔔 เตือน <b>${alertCnt}</b></div>`;
        }

        const firstDow = new Date(viewYear, viewMonth, 1).getDay();
        const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
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
                const c = getCategoryMeta(t.category);
                const doneStyle = t.status === 'done' ? 'opacity:0.45;text-decoration:line-through;' : '';
                return `<div class="truncate text-[9px] text-white font-bold px-1 rounded leading-tight" style="background:${c.barBg};${doneStyle}">${c.icon} ${escapeHtmlStr(t.title)}</div>`;
            }).join('');
            const moreHtml = dayTasks.length > 2
                ? `<div class="text-[9px] font-extrabold text-indigo-700 leading-none">+อีก ${dayTasks.length - 2} งาน</div>`
                : '';

            cells.push(`
                <button type="button" onclick="selectPmCalendarDate('${iso}')" class="pm-day-cell rounded-xl border p-1 flex flex-col items-stretch text-left bg-white ${isSel ? 'pm-day-selected' : 'border-slate-200'} ${isToday ? 'ring-2 ring-amber-400' : ''}">
                    <div class="flex items-center justify-between w-full mb-0.5">
                        <span class="text-[11px] font-extrabold ${isToday ? 'bg-amber-400 text-slate-950 px-1.5 rounded-full' : 'text-slate-700'}">${day}</span>
                        ${hasOverdue ? '<span class="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>' : (dayTasks.length > 0 ? `<span class="text-[9px] font-bold text-slate-400">${dayTasks.length}</span>` : '')}
                    </div>
                    <div class="space-y-0.5 overflow-hidden flex-1">${barsHtml}${moreHtml}</div>
                </button>`);
        }
        gridEl.innerHTML = cells.join('');
    }

    function renderPmSelectedDayList() {
        const listEl = document.getElementById('pmSelectedDayTasksContainer');
        const hdrEl = document.getElementById('pmSelectedListHeader');
        if (!listEl) return;

        ['day', 'alert', 'all'].forEach(k => {
            const btn = document.getElementById('pmFilterBtn-' + k);
            if (!btn) return;
            btn.className = currentFilterStatus === k
                ? 'py-1 rounded-lg bg-indigo-600 text-white shadow-sm'
                : 'py-1 rounded-lg text-slate-600 hover:bg-slate-200/70';
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
            listEl.innerHTML = `<div class="text-center py-10 px-4 bg-slate-50 rounded-2xl border border-dashed border-slate-300 text-xs text-slate-400">ไม่มีรายการแผนงานในหมวดที่เลือก</div>`;
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

            let dueBadge = '';
            if (isDone) dueBadge = `<span class="bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded-full">✅ เสร็จแล้ว</span>`;
            else if (daysLeft < 0) dueBadge = `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">🚨 เลยกำหนด ${Math.abs(daysLeft)} วัน</span>`;
            else if (daysLeft === 0) dueBadge = `<span class="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">📌 วันนี้</span>`;
            else dueBadge = `<span class="bg-slate-100 text-slate-600 text-[10px] font-bold px-2 py-0.5 rounded-full">อีก ${daysLeft} วัน</span>`;

            return `
                <div class="p-3 rounded-2xl border ${isDone ? 'bg-slate-50 border-slate-200 opacity-75' : 'bg-white border-slate-200 shadow-sm'} space-y-1.5 text-xs">
                    <div class="flex items-start justify-between gap-2">
                        <div class="space-y-0.5 min-w-0 flex-1">
                            <div class="flex items-center gap-1 flex-wrap">
                                <span class="border text-[10px] font-bold px-1.5 py-0.5 rounded ${cat.pillCls}">${cat.icon} ${cat.name}</span>
                                ${Number(item.repeatMonths) > 0 ? `<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-1.5 py-0.5 rounded">🔁 ทุก ${item.repeatMonths} ด.</span>` : ''}
                            </div>
                            <div class="font-extrabold text-slate-800 text-xs sm:text-sm break-words ${isDone ? 'line-through' : ''}">${escapeHtmlStr(item.title)}</div>
                        </div>
                        <div class="shrink-0">${dueBadge}</div>
                    </div>
                    <div class="text-[11px] text-slate-600 flex flex-wrap gap-x-2 gap-y-0.5">
                        <span>📅 ${formatThaiDateShort(item.date)} (${escapeHtmlStr(item.timeSlot || '-')})</span>
                        <span>• 🔔 เตือนล่วงหน้า ${Number(item.notifyDaysBefore ?? 3)} วัน</span>
                    </div>
                    ${item.equipCode ? `<div class="text-[11px] font-bold text-teal-800">⚡ อุปกรณ์: ${escapeHtmlStr(item.equipCode)} ${item.feeder ? `(วงจร ${escapeHtmlStr(item.feeder)})` : ''}</div>` : ''}
                    ${item.note ? `<div class="text-[11px] text-slate-500 break-words">📝 ${escapeHtmlStr(item.note)}</div>` : ''}
                    <div class="pt-1.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-1.5">
                        <div class="flex flex-wrap gap-1">
                            ${hasCoord ? `<button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold shadow-sm">🗺️ นำทาง GPS</button>` : ''}
                            <button type="button" onclick="shareSinglePmPlanToLine('${safeId}')" class="bg-[#00B900] hover:bg-[#009900] text-white px-2.5 py-1 rounded-lg text-[10px] font-bold shadow-sm">💬 LINE</button>
                            ${(!item.isScadaPinDue && allowEdit) ? `<button type="button" onclick="openPmPlanFormModal('${safeId}')" class="bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 px-2 py-1 rounded-lg text-[10px] font-bold">✏️ แก้ไข</button>` : ''}
                        </div>
                        ${(!item.isScadaPinDue && allowDone) ? `<button type="button" onclick="togglePmPlanCompleteStatus('${safeId}')" class="${isDone ? 'bg-slate-200 text-slate-700' : 'bg-emerald-600 hover:bg-emerald-700 text-white'} px-2.5 py-1 rounded-lg text-[10px] font-extrabold shadow-sm">${isDone ? '↩️ เปิดงานใหม่' : '✅ บันทึกเสร็จสิ้น'}</button>` : ''}
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
            const badge = c.daysLeft < 0
                ? `<span class="bg-rose-600 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full">เลยกำหนด ${Math.abs(c.daysLeft)} วัน</span>`
                : (c.daysLeft === 0
                    ? `<span class="bg-amber-500 text-slate-950 text-[10px] font-extrabold px-2 py-0.5 rounded-full">📌 วันนี้ (${escapeHtmlStr(c.timeSlot || '-')})</span>`
                    : `<span class="bg-sky-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">อีก ${c.daysLeft} วัน (${formatThaiDateShort(c.date)})</span>`);
            const safeId = String(c.id).replace(/'/g, "\\'");
            const hasCoord = !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lon));
            return `
                <div class="p-3 bg-white rounded-2xl border border-slate-200 shadow-sm space-y-1">
                    <div class="flex items-center justify-between gap-2">${badge}<span class="text-[10px] font-bold text-slate-500">${cat.icon} ${cat.name}</span></div>
                    <div class="font-extrabold text-slate-800 text-xs sm:text-sm">${escapeHtmlStr(c.title)}</div>
                    ${c.equipCode ? `<div class="text-[11px] text-teal-700 font-semibold">⚡ ${escapeHtmlStr(c.equipCode)} ${c.feeder ? `(${escapeHtmlStr(c.feeder)})` : ''}</div>` : ''}
                    ${hasCoord ? `<div class="pt-1"><button type="button" onclick="navigatePmPlanGps('${safeId}')" class="bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 px-2.5 py-1 rounded-lg text-[10px] font-bold">🗺️ เปิดพิกัดนำทาง Maps</button></div>` : ''}
                </div>`;
        }).join('');

        modal.classList.remove('hidden');
    }

    function refreshPmAllViews() {
        updatePmHeaderBadgesAndStrip();
        const calModal = document.getElementById('pmCalendarModal');
        if (calModal && !calModal.classList.contains('hidden')) {
            renderPmCalendarGrid();
            renderPmSelectedDayList();
        }
    }
    // ===== จบพาทที่ 2 / 3 ของไฟล์ pm-calendar.js (นำพาทที่ 3 / 3 มาวางต่อจากบรรทัดนี้ได้เลยครับ) =====
        // ===== เริ่มพาทที่ 3 / 3 ของไฟล์ pm-calendar.js (วางต่อจากพาทที่ 2 / 3 จนจบไฟล์) =====

    // ========================================================================
    // 7. ฟอร์มเพิ่ม/แก้ไข/ลบแผนงาน, ดึงพิกัดหมุด SCADA & สร้างรอบทำซ้ำอัตโนมัติ
    // ========================================================================
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
            if (cdEl && !isNaN(parseFloat(target.lat)) && !isNaN(parseFloat(target.lon))) {
                cdEl.value = `${Number(target.lat).toFixed(6)}, ${Number(target.lon).toFixed(6)}`;
            }
            if (ttEl && !ttEl.value.trim()) {
                const cat = getCategoryMeta(document.getElementById('pmCategorySelect')?.value || 'scada');
                ttEl.value = `${cat.name} (${target.name})`;
            }
            showToast(`⚡ ดึงพิกัดจาก "${target.name}" แล้ว`);
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
                const lat = pos.coords.latitude.toFixed(6);
                const lon = pos.coords.longitude.toFixed(6);
                if (coordEl) coordEl.value = `${lat}, ${lon}`;
                showToast(`📍 ดึงพิกัดสำเร็จ (${lat}, ${lon})`);
            },
            () => {
                if (window.lastKnownTechCoords && coordEl) {
                    coordEl.value = `${window.lastKnownTechCoords.lat.toFixed(6)}, ${window.lastKnownTechCoords.lon.toFixed(6)}`;
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

        let lat = parseFloat(pair.lat);
        let lon = parseFloat(pair.lon);
        if (isNaN(lat) || isNaN(lon)) return null;
        if (lat > 90 && lon < 90) { const tmp = lat; lat = lon; lon = tmp; }
        return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
    }

    function openPmPlanFormModal(planId = null, presetDate = null) {
        if (!canManagePmSchedule()) {
            showToast('🔒 เฉพาะแอดมินและผู้ใช้งานทั่วไปเท่านั้นที่เพิ่ม/แก้ไขแผนบำรุงรักษาได้');
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
            if (titleHdr) titleHdr.textContent = '✏️ แก้ไขแผนงานบำรุงรักษา';
            populatePmScadaPinPicker(target.linkedPinId || '');
            document.getElementById('pmTitleInput').value = target.title || '';
            document.getElementById('pmCategorySelect').value = target.category || 'scada';
            document.getElementById('pmDateInput').value = target.date || getTodayIso();
            document.getElementById('pmTimeSlotInput').value = target.timeSlot || '08.30 น.';
            document.getElementById('pmNotifyBeforeSelect').value = String(target.notifyDaysBefore ?? 3);
            document.getElementById('pmRepeatMonthsSelect').value = String(target.repeatMonths ?? 0);
            document.getElementById('pmEquipCodeInput').value = target.equipCode || '';
            document.getElementById('pmFeederInput').value = target.feeder || '';
            document.getElementById('pmCoordInput').value = (!isNaN(parseFloat(target.lat)) && !isNaN(parseFloat(target.lon)))
                ? `${Number(target.lat).toFixed(6)}, ${Number(target.lon).toFixed(6)}`
                : (target.gpsLink || '');
            document.getElementById('pmNoteInput').value = target.note || '';
            delBtn?.classList.remove('hidden');
        } else {
            if (titleHdr) titleHdr.textContent = '➕ เพิ่มแผนงานบำรุงรักษาใหม่';
            populatePmScadaPinPicker('');
            document.getElementById('pmTitleInput').value = '';
            document.getElementById('pmCategorySelect').value = 'tree';
            document.getElementById('pmDateInput').value = presetDate || selectedDateIso || getTodayIso();
            document.getElementById('pmTimeSlotInput').value = '09.00 - 12.00 น.';
            document.getElementById('pmNotifyBeforeSelect').value = '3';
            document.getElementById('pmRepeatMonthsSelect').value = '0';
            document.getElementById('pmEquipCodeInput').value = '';
            document.getElementById('pmFeederInput').value = '';
            document.getElementById('pmCoordInput').value = '';
            document.getElementById('pmNoteInput').value = '';
            delBtn?.classList.add('hidden');
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
        const dateVal = (document.getElementById('pmDateInput')?.value || '').trim();
        const timeSlot = (document.getElementById('pmTimeSlotInput')?.value || '').trim() || '08.30 น.';
        const notifyDaysBefore = parseInt(document.getElementById('pmNotifyBeforeSelect')?.value || '3', 10);
        const repeatMonths = parseInt(document.getElementById('pmRepeatMonthsSelect')?.value || '0', 10);
        const linkedPinId = (document.getElementById('pmScadaPinPicker')?.value || '').trim();
        const equipCode = (document.getElementById('pmEquipCodeInput')?.value || '').trim();
        const feeder = (document.getElementById('pmFeederInput')?.value || '').trim().toUpperCase();
        const rawCoord = (document.getElementById('pmCoordInput')?.value || '').trim();
        const note = (document.getElementById('pmNoteInput')?.value || '').trim();
        const saveBtn = document.getElementById('pmSaveSubmitBtn');

        if (!title) { showToast('⚠️ กรุณาระบุหัวข้อแผนงานบำรุงรักษา'); return; }
        if (!dateVal) { showToast('⚠️ กรุณาเลือกวันที่ดำเนินการ'); return; }

        let parsedCoord = null;
        if (rawCoord) {
            if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ กำลังตรวจสอบพิกัด...'; }
            parsedCoord = await parsePmCoordOrShortLink(rawCoord);
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 บันทึกแผนงาน'; }
            if (!parsedCoord) {
                showToast('❌ รูปแบบพิกัดหรือลิงก์ Maps ไม่ถูกต้อง');
                return;
            }
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
                    title, category, date: dateVal, timeSlot,
                    notifyDaysBefore: isNaN(notifyDaysBefore) ? 3 : notifyDaysBefore,
                    repeatMonths: isNaN(repeatMonths) ? 0 : repeatMonths,
                    linkedPinId: linkedPinId || undefined,
                    equipCode, feeder, note,
                    lat: parsedCoord ? parsedCoord.lat : null,
                    lon: parsedCoord ? parsedCoord.lon : null,
                    gpsLink,
                    updatedBy: curUser,
                    updatedAt: nowIso
                };
            }
        } else {
            pmPlans.push({
                id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                title, category, date: dateVal, timeSlot,
                notifyDaysBefore: isNaN(notifyDaysBefore) ? 3 : notifyDaysBefore,
                repeatMonths: isNaN(repeatMonths) ? 0 : repeatMonths,
                linkedPinId: linkedPinId || undefined,
                equipCode, feeder, note,
                lat: parsedCoord ? parsedCoord.lat : null,
                lon: parsedCoord ? parsedCoord.lon : null,
                gpsLink,
                status: 'pending',
                ownerGroup: myGroup,
                createdBy: curUser,
                updatedBy: curUser,
                updatedAt: nowIso
            });
        }

        selectedDateIso = dateVal;
        const [y, m] = dateVal.split('-').map(Number);
        if (y && m) { viewYear = y; viewMonth = m - 1; }
        currentFilterStatus = 'day';

        closePmPlanFormModal();
        await savePmPlansAndSync(true);
        showToast('✅ บันทึกแผนงานบำรุงรักษาเรียบร้อยแล้ว');
    }

    function deletePmPlanFromModal() {
        if (!editingPlanId || !canManagePmSchedule()) return;
        const target = pmPlans.find(p => p.id === editingPlanId && !p.pmDeleted);
        if (!target) return;

        showCustomConfirm(`ต้องการลบแผนงาน "${target.title}" ออกจากปฏิทินใช่หรือไม่?`, async function () {
            const idx = pmPlans.findIndex(p => p.id === editingPlanId);
            if (idx !== -1) {
                pmPlans[idx] = {
                    id: pmPlans[idx].id,
                    ownerGroup: pmPlans[idx].ownerGroup || getActivePmGroup(),
                    pmDeleted: true,
                    updatedAt: new Date().toISOString()
                };
            }
            closePmPlanFormModal();
            await savePmPlansAndSync(true);
            showToast('🗑️ ลบแผนงานบำรุงรักษาแล้ว');
        }, '🗑️ ยืนยันการลบแผนงาน');
    }

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

        // หากตั้งรอบทำซ้ำไว้ (เช่น ทุก 3 เดือน) ให้สร้างแผนรอบถัดไปให้อัตโนมัติทันทีที่กดเสร็จสิ้น
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

        await savePmPlansAndSync(true);
        showToast(spawnedNextDate
            ? `✅ บันทึกเสร็จสิ้น และสร้างแผนรอบถัดไป (${formatThaiDateShort(spawnedNextDate)}) อัตโนมัติแล้ว!`
            : (nextStatus === 'done' ? '✅ บันทึกผลการบำรุงรักษาเสร็จสิ้นแล้ว' : '↩️ คืนสถานะแผนงานเป็นรอดำเนินการแล้ว'));
    }

    // ========================================================================
    // 8. นำทาง GPS, แชร์แผนงานเข้า LINE, ส่งออก Excel & ตั้งค่าเสียง/Notification
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

        const lat = parseFloat(item.lat);
        const lon = parseFloat(item.lon);
        if (isNaN(lat) || isNaN(lon)) {
            showToast('⚠️ แผนงานนี้ยังไม่ได้แนบพิกัด GPS');
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

    function buildSinglePmShareText(item) {
        const cat = getCategoryMeta(item.category);
        const lines = [
            `📅 แผนงานบำรุงรักษา (${item.ownerGroup || getActivePmGroup()})`,
            `${cat.icon} ประเภท : ${cat.name}`,
            `🏷️ เรื่อง : ${item.title}`,
            `🗓️ กำหนดการ : ${formatThaiDateFull(item.date)} (${item.timeSlot || '-'})`
        ];
        if (item.equipCode) lines.push(`⚡ อุปกรณ์ : ${item.equipCode}${item.feeder ? ` (วงจร ${item.feeder})` : ''}`);
        if (item.note) lines.push(`📝 รายละเอียด : ${item.note}`);
        if (!isNaN(parseFloat(item.lat)) && !isNaN(parseFloat(item.lon))) {
            lines.push(`📍 พิกัดนำทาง : https://www.google.com/maps?q=${Number(item.lat).toFixed(6)},${Number(item.lon).toFixed(6)}`);
        }
        return lines.join('\n');
    }

    function shareSinglePmPlanToLine(itemId) {
        const item = getAllVisibleCalendarItems().find(x => x.id === itemId);
        if (!item) return;
        const txt = buildSinglePmShareText(item);
        copyTextToClipboard(txt, '💬 คัดลอกแผนงานและกำลังเปิดแอป LINE...');
        window.open('https://line.me/R/share?text=' + encodeURIComponent(txt), '_blank');
    }

    function shareDailyOrAlertSummaryToLine() {
        const alerts = getAlertCandidatesForToday();
        const targetList = alerts.length > 0
            ? alerts
            : getAllVisibleCalendarItems().filter(i => i.date === selectedDateIso);

        if (targetList.length === 0) {
            showToast('⚠️ ไม่มีรายการแผนงานสำหรับส่งสรุปเข้า LINE');
            return;
        }

        const hdr = alerts.length > 0
            ? `🔔 สรุปแจ้งเตือนแผนงานบำรุงรักษา (${getActivePmGroup()})\n📅 ข้อมูล ณ ${formatThaiDateFull(getTodayIso())}`
            : `📅 แผนงานบำรุงรักษาประจำวัน (${getActivePmGroup()})\n🗓️ ${formatThaiDateFull(selectedDateIso)}`;

        const body = targetList.slice(0, 15).map((it, idx) => {
            const cat = getCategoryMeta(it.category);
            const dTag = it.daysLeft !== undefined
                ? (it.daysLeft < 0 ? `[เลย ${Math.abs(it.daysLeft)} วัน] ` : (it.daysLeft === 0 ? '[วันนี้] ' : `[อีก ${it.daysLeft} วัน] `))
                : '';
            const gps = (!isNaN(parseFloat(it.lat)) && !isNaN(parseFloat(it.lon)))
                ? `\n   📍 https://www.google.com/maps?q=${Number(it.lat).toFixed(6)},${Number(it.lon).toFixed(6)}`
                : '';
            return `${idx + 1}. ${dTag}${cat.icon} ${it.title} (${formatThaiDateShort(it.date)} ${it.timeSlot || ''})${it.equipCode ? `\n   ⚡ ${it.equipCode}` : ''}${gps}`;
        }).join('\n');

        const fullText = `${hdr}\n━━━━━━━━━━━━━━━━━━\n${body}`;
        copyTextToClipboard(fullText, '💬 คัดลอกสรุปแผนงานและกำลังเปิด LINE...');
        window.open('https://line.me/R/share?text=' + encodeURIComponent(fullText), '_blank');
    }

    async function exportPmPlansToExcel() {
        const items = getAllVisibleCalendarItems();
        if (items.length === 0) {
            showToast('⚠️ ยังไม่มีข้อมูลแผนงานบำรุงรักษาสำหรับส่งออก');
            return;
        }

        const myGrp = getActivePmGroup();
        const headers = [
            'ลำดับ', 'กลุ่มสังกัด', 'วันที่กำหนด', 'ช่วงเวลา', 'ประเภทงาน', 'หัวข้อแผนงาน',
            'รหัสอุปกรณ์', 'วงจร', 'รายละเอียด/ผู้รับผิดชอบ', 'เตือนล่วงหน้า (วัน)',
            'สถานะ', 'ผู้ดำเนินการเสร็จ', 'พิกัด Google Maps'
        ];
        const rows = items.map((it, idx) => [
            String(idx + 1),
            it.ownerGroup || myGrp,
            formatThaiDateShort(it.date),
            it.timeSlot || '-',
            getCategoryMeta(it.category).name,
            it.title || '-',
            it.equipCode || '-',
            it.feeder || '-',
            it.note || '-',
            String(it.notifyDaysBefore ?? 3),
            it.status === 'done' ? 'เสร็จสิ้นแล้ว' : 'รอดำเนินการ',
            it.completedBy || '-',
            (!isNaN(parseFloat(it.lat)) && !isNaN(parseFloat(it.lon)))
                ? `https://www.google.com/maps?q=${Number(it.lat).toFixed(6)},${Number(it.lon).toFixed(6)}`
                : '-'
        ]);

        const filename = `PM_Schedule_${myGrp.replace(/\s+/g, '_')}_${getTodayIso()}.xlsx`;
        if ((await ensureXlsxLoaded()) && typeof XLSX !== 'undefined') {
            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
            XLSX.utils.book_append_sheet(wb, ws, 'แผนบำรุงรักษา_PM');
            XLSX.writeFile(wb, filename);
            showToast(`📊 ส่งออกตารางแผนงาน PM (${items.length} รายการ) สำเร็จ!`);
        } else if (Core && typeof Core.downloadCsvFallback === 'function') {
            Core.downloadCsvFallback(headers, rows, filename);
        }
    }

    function updatePmSoundAndNotifButtonsUI() {
        const sndBtn = document.getElementById('pmSoundToggleBtn');
        if (sndBtn) {
            sndBtn.textContent = isPmSoundEnabled ? '🔔 เสียง: เปิด' : '🔕 เสียง: ปิด';
            sndBtn.className = isPmSoundEnabled
                ? 'bg-white/20 hover:bg-white/30 text-white px-2.5 py-1 rounded-xl text-[11px] font-bold'
                : 'bg-slate-900/50 text-slate-300 px-2.5 py-1 rounded-xl text-[11px] font-bold';
        }
        const permBtn = document.getElementById('pmNotifPermBtn');
        if (permBtn && 'Notification' in window) {
            permBtn.textContent = Notification.permission === 'granted' ? '📲 แจ้งเตือน: เปิดแล้ว' : '📲 เปิดแจ้งเตือนเครื่อง';
        }
    }

    function togglePmSoundSetting() {
        isPmSoundEnabled = !isPmSoundEnabled;
        localStorage.setItem(PM_SOUND_KEY, String(isPmSoundEnabled));
        updatePmSoundAndNotifButtonsUI();
        if (isPmSoundEnabled) playPmAlertChime();
        showToast(isPmSoundEnabled ? '🔔 เปิดเสียงเตือนแผนงาน PM แล้ว' : '🔕 ปิดเสียงเตือนแผนงาน PM แล้ว');
    }

    async function requestPmBrowserNotificationPermission() {
        if (!('Notification' in window)) {
            showToast('⚠️ เบราว์เซอร์นี้ไม่รองรับ System Notification');
            return;
        }
        const perm = await Notification.requestPermission();
        updatePmSoundAndNotifButtonsUI();
        if (perm === 'granted') {
            showToast('✅ เปิดรับการแจ้งเตือนบนหน้าจอมือถือ/คอมพิวเตอร์เรียบร้อย!');
            checkAndTriggerScheduledPmAlerts(true);
        } else {
            showToast('⚠️ กรุณากดอนุญาตการแจ้งเตือนในการตั้งค่าเบราว์เซอร์');
        }
    }

    // ========================================================================
    // 9. ตัวจับเวลาปลุกเตือนตรงเวลา 00.00 น. และ 07.00 น. & เริ่มต้นระบบ
    // ========================================================================
    function checkExactScheduleClockTick() {
        if (rawGet('elec_app_logged_in') !== 'true' || (Core && Core.isEmbeddedIframe)) return;
        const now = new Date();
        const hr = now.getHours();
        const min = now.getMinutes();
        const minKey = `${toLocalIsoDate(now)}_${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}`;

        if (minKey === lastCheckedAlertMinuteKey) return;
        lastCheckedAlertMinuteKey = minKey;

        // ปลุกเตือนอัตโนมัติทันทีเมื่อเข็มนาฬิกาแตะ 00:00 น. หรือ 07:00 น.
        if ((hr === 0 && min === 0) || (hr === 7 && min === 0)) {
            updatePmHeaderBadgesAndStrip();
            checkAndTriggerScheduledPmAlerts(false);
        } else if (min === 0) {
            updatePmHeaderBadgesAndStrip();
        }
    }

    if (Core && typeof Core.onRealtimeChange === 'function') {
        Core.onRealtimeChange((keys) => {
            if (keys.some(k => k === 'elec_tech_locations_map' || k === PM_STORAGE_KEY)) {
                syncPmPlansFromLocationsMap();
            }
            if (keys.some(k => k === 'elec_labeled_places_list' || k === 'elec_deleted_labeled_places_map')) {
                refreshPmAllViews();
            }
        });
    }

    Object.assign(window, {
        openPmCalendarModal,
        closePmCalendarModal,
        changePmCalendarMonth,
        jumpPmCalendarToday,
        selectPmCalendarDate,
        setPmListStatusFilter,
        toggleShowScadaDueOnCalendar,
        togglePmTechStripCollapse,
        openPmPlanFormModal,
        closePmPlanFormModal,
        onPmScadaEquipPick,
        fillPmCurrentMobileGps,
        savePmPlanFromModal,
        deletePmPlanFromModal,
        togglePmPlanCompleteStatus,
        navigatePmPlanGps,
        shareSinglePmPlanToLine,
        shareDailyOrAlertSummaryToLine,
        exportPmPlansToExcel,
        togglePmSoundSetting,
        requestPmBrowserNotificationPermission,
        acknowledgeCurrentPmAlertRound
    });

    function bootstrapPmCalendarModule() {
        injectPmCalendarStyles();
        injectPmModalsDOM();
        loadPmPlansFromStorage();
        syncPmPlansFromLocationsMap();
        updatePmSoundAndNotifButtonsUI();
        updatePmHeaderBadgesAndStrip();

        // ตรวจสอบแจ้งเตือนรอบ 00.00 น. / 07.00 น. หลังเปิดหน้าเว็บ 1.5 วินาที
        setTimeout(() => {
            syncPmPlansFromLocationsMap();
            updatePmHeaderBadgesAndStrip();
            checkAndTriggerScheduledPmAlerts(false);
        }, 1500);

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