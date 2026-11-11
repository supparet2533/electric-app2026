// ============================================================================
// 🛠️⚡ PEA SMART GRID — TECH WORKFORCE & REPAIR JOBS ENGINE v6.0 (tech-jobs.js)
// ระบบจัดการใบงานซ่อม นำทางเรียลไทม์ สั่งปิดงานด้วยเสียง และแผนที่จุดงานซ่อม (สำหรับ page2.html)
// พาทที่ 1 / 3 : State, Auth & Role UI, Sound Alerts, GPS Tracker & Live Navigation
// ============================================================================
(function () {
    'use strict';

    const Core = window.PeaCore;
    const VIEWER_LOCK_MSG = '🔒 สิทธิ์ผู้สำรวจ: ดูข้อมูลอย่างเดียว ไม่สามารถเพิ่ม แก้ไข หรือลบข้อมูลได้';
    const SHORT_URL_COORD_CACHE_KEY = 'elec_job_shortlink_coords_cache_v1';
    const EQUIP_NAV_STORAGE_KEY = 'elec_active_equip_nav_map_v2';
    const CANCELLED_JOB_NAV_KEY = 'elec_cancelled_job_nav_map';
    const CANCELLED_EQUIP_NAV_KEY = 'elec_cancelled_equip_nav_map';

    const EXTENDED_AREA_COORDS = {
        'บึง': { lat: 13.1361, lon: 101.0322 },
        'บ่อวิน': { lat: 13.0645, lon: 101.1611 },
        'เขาคันทรง': { lat: 13.1165, lon: 101.2144 },
        'หนองขาม': { lat: 13.1189, lon: 100.9856 },
        'สุรศักดิ์': { lat: 13.1592, lon: 100.9581 },
        'ศรีราชา': { lat: 13.1737, lon: 100.9311 },
        'แหลมฉบัง': { lat: 13.0825, lon: 100.9167 },
        'ทุ่งสุขลา': { lat: 13.1058, lon: 100.9242 },
        'บางพระ': { lat: 13.2142, lon: 100.9461 },
        'มาบปู': { lat: 13.0519, lon: 101.1558 },
        'ปลวกแดง': { lat: 12.9736, lon: 101.2153 },
        'มาบยางพร': { lat: 12.9906, lon: 101.1481 },
        'ตาสิทธิ์': { lat: 13.0561, lon: 101.2169 },
        'ละหาร': { lat: 12.9869, lon: 101.2597 }
    };

    let lastTechLoginTimestamp = 0;
    let currentEditingJobKey = null;
    let currentEditingJobType = 'outage';
    let cachedCloudJobs = [];
    let isSyncingNow = false;
    let syncTickCounter = 0;
    let lastIdleHeartbeatWriteMs = 0;
    let lastRenderedCardsSignature = '';

    let isSoundAlertEnabled = localStorage.getItem('elec_tech_sound_enabled') !== 'false';
    let knownPendingJobKeys = new Set();
    let hasInitializedPendingBaseline = false;

    let isGpsTrackingEnabled = localStorage.getItem('elec_tech_gps_enabled') !== 'false';
    let techGpsIntervalId = null;
    let lastKnownTechCoords = null;
    let activeNavWatchId = null;
    let activeNavJobKey = null;
    let activeNavJobType = 'outage';
    let lastNavCloudPushTime = 0;
    let screenWakeLock = null;
    const recentlyCancelledNavKeys = new Map();

    // ซิงค์ตัวแปรพิกัดให้ scada-engine.js เรียกใช้ร่วมกันได้แบบเรียลไทม์
    Object.defineProperty(window, 'lastKnownTechCoords', {
        get: () => lastKnownTechCoords,
        set: (val) => { lastKnownTechCoords = val; },
        configurable: true
    });
    Object.defineProperty(window, 'isGpsTrackingEnabled', {
        get: () => isGpsTrackingEnabled,
        configurable: true
    });

    // ========================================================================
    // 1. ระบบล็อกอินหน้าช่าง, จัดการสิทธิ์ (RBAC) & สถานะออนไลน์สำหรับ Admin
    // ========================================================================
    function syncTechLoginVisibility() {
        const loginEl = document.getElementById('techLoginScreen');
        if (!loginEl) return;
        const isLogged = localStorage.getItem('elec_app_logged_in') === 'true';
        loginEl.classList.toggle('hidden', isLogged);
        loginEl.style.display = isLogged ? 'none' : 'flex';
    }

    function checkTechAuth() {
        syncTechLoginVisibility();
        updateRoleNavigationUI();
    }

    function goBackToMainPage() {
        if ((localStorage.getItem('elec_app_current_role') || 'user') === 'tech') {
            showToast('⛔ บัญชีผู้ใช้งานช่าง เข้าใช้งานได้เฉพาะหน้านี้เท่านั้น');
            return;
        }
        window.location.href = 'index.html';
    }

    function updateRoleNavigationUI() {
        const currentUser = localStorage.getItem('elec_app_current_user') || '';
        const currentRole = localStorage.getItem('elec_app_current_role') || 'user';
        const myGroup = getCurrentUserGroup();
        const isViewer = isViewerRole();
        const canEditScada = canCurrentUserEditScada();

        document.body.classList.toggle('role-viewer-readonly', isViewer);
        document.body.classList.toggle('role-scada-readonly', !canEditScada);

        const backBtn = document.getElementById('backToMainBtn');
        if (backBtn) {
            if (currentRole === 'tech' || Core.isEmbeddedIframe) {
                backBtn.classList.add('hidden');
                backBtn.classList.remove('flex');
                if (Core.isEmbeddedIframe) backBtn.style.display = 'none';
            } else {
                backBtn.classList.remove('hidden');
                backBtn.classList.add('flex');
            }
        }

        const userBadge = document.getElementById('loggedUserDisplayBadge');
        if (userBadge) {
            if (!currentUser) {
                userBadge.textContent = '';
            } else {
                const accounts = getParsedUserAccounts();
                const matchedAcc = accounts.find(a => isUsernameMatchingAccount(currentUser, a.username));
                const nameDisplay = matchedAcc?.displayName || getUserBaseId(currentUser) || currentUser;
                const groupTag = (currentRole !== 'admin' && myGroup) ? ` [🏢 ${myGroup}]` : '';

                if (currentRole === 'admin' && nameDisplay.toLowerCase() === 'admin') {
                    userBadge.textContent = '👑 แอดมิน';
                    userBadge.className = 'text-[11px] font-semibold text-slate-500 truncate';
                } else if (isViewer) {
                    userBadge.textContent = `👁️ ผู้สำรวจ (ดูอย่างเดียว): ${nameDisplay}${groupTag}`;
                    userBadge.className = 'text-[11px] font-bold text-teal-700 bg-teal-50 border border-teal-200 px-2.5 py-0.5 rounded-full truncate';
                } else {
                    const roleName = currentRole === 'admin' ? '👑 แอดมิน' : (currentRole === 'tech' ? '🛠️ ช่าง' : '👷 ผู้ใช้');
                    userBadge.textContent = `${roleName}: ${nameDisplay}${groupTag}`;
                    userBadge.className = 'text-[11px] font-semibold text-slate-500 truncate';
                }
            }
        }

        updateTechOnlineCountUI();
        if (typeof window.__onScadaRoleUpdated === 'function') {
            window.__onScadaRoleUpdated();
        }
    }

    function injectTechOnlineButton() {
        const headerRight = document.querySelector('#techMainApp .bg-gradient-to-r .flex.flex-wrap.items-center.gap-1\\.5');
        if (!headerRight) return;

        let btn = document.getElementById('techOnlineUsersBtn');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'techOnlineUsersBtn';
            btn.onclick = openTechOnlineModal;
            btn.className = 'hidden bg-emerald-500/90 hover:bg-emerald-600 text-white px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm items-center gap-1';
            btn.title = 'ดูรายชื่อผู้ที่กำลังออนไลน์ (เฉพาะแอดมิน)';
            btn.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-200 animate-ping"></span><span>ออนไลน์ (<span id="techOnlineCountBadge">1</span>)</span>`;
            headerRight.insertBefore(btn, headerRight.firstChild);
        }

        const isAdmin = isCurrentUserAdmin();
        btn.classList.toggle('hidden', !isAdmin);
        btn.classList.toggle('flex', isAdmin);
        if (!isAdmin) document.getElementById('techOnlineModal')?.classList.add('hidden');
    }

    function updateTechOnlineCountUI() {
        injectTechOnlineButton();
        if (!isCurrentUserAdmin()) return;
        const list = Core.getAccountsOnlineStatusList('📱 หน้าช่าง', Boolean(isGpsTrackingEnabled && lastKnownTechCoords));
        const badge = document.getElementById('techOnlineCountBadge');
        if (badge) badge.textContent = String(list.filter(i => i.isOnline).length);
        const modal = document.getElementById('techOnlineModal');
        if (modal && !modal.classList.contains('hidden')) renderTechOnlineModalList(list);
    }

    function openTechOnlineModal() {
        if (!isCurrentUserAdmin()) {
            showCustomAlert('⛔ เฉพาะแอดมิน (ผู้ดูแลระบบ) เท่านั้นที่สามารถดูสถานะออนไลน์ได้', '🔒 จำกัดสิทธิ์การเข้าถึง');
            return;
        }
        let modal = document.getElementById('techOnlineModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'techOnlineModal';
            modal.className = 'fixed inset-0 bg-slate-900/60 hidden z-[190] flex items-center justify-center p-3 backdrop-blur-sm';
            modal.innerHTML = `
                <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[85vh]">
                    <div class="px-4 py-3 bg-gradient-to-r from-teal-700 to-emerald-600 text-white flex justify-between items-center">
                        <h3 class="font-bold text-sm flex items-center gap-2">
                            <span class="w-2.5 h-2.5 rounded-full bg-emerald-300 animate-ping"></span>
                            <span>สถานะผู้ใช้งานออนไลน์ (เฉพาะ Admin)</span>
                        </h3>
                        <button type="button" onclick="document.getElementById('techOnlineModal').classList.add('hidden')" class="text-white/80 hover:text-white text-xl font-bold leading-none">&times;</button>
                    </div>
                    <div class="px-4 py-2 bg-emerald-50 border-b border-emerald-100 flex justify-between items-center text-[11px] text-emerald-800 font-semibold">
                        <span id="techOnlineSummaryText">กำลังตรวจสอบ...</span>
                        <button type="button" onclick="syncJobsFromCloud(false)" class="text-teal-700 hover:underline font-bold">🔄 ซิงค์สถานะ</button>
                    </div>
                    <div id="techOnlineListContainer" class="p-3.5 overflow-y-auto space-y-2 flex-1 bg-slate-50"></div>
                    <div class="p-3 bg-white border-t flex justify-end">
                        <button type="button" onclick="document.getElementById('techOnlineModal').classList.add('hidden')" class="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition">ปิดหน้าต่าง</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }
        renderTechOnlineModalList();
        modal.classList.remove('hidden');
    }

    function renderTechOnlineModalList(precomputedList) {
        if (!isCurrentUserAdmin()) return;
        const container = document.getElementById('techOnlineListContainer');
        const summaryEl = document.getElementById('techOnlineSummaryText');
        if (!container) return;

        const list = precomputedList || Core.getAccountsOnlineStatusList('📱 หน้าช่าง', Boolean(isGpsTrackingEnabled && lastKnownTechCoords));
        if (summaryEl) summaryEl.textContent = `🟢 ออนไลน์ขณะนี้ ${list.filter(i => i.isOnline).length} คน (ทั้งหมด ${list.length} บัญชี)`;

        container.innerHTML = list.map(item => {
            const roleIcon = item.role === 'admin' ? '👑' : (item.role === 'tech' ? '🛠️' : (item.role === 'viewer' ? '👁️' : '👷'));
            const statusBadge = item.isOnline
                ? `<span class="inline-flex items-center gap-1 bg-emerald-100 text-emerald-700 border border-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>ออนไลน์</span>`
                : `<span class="inline-flex items-center gap-1 bg-slate-100 text-slate-500 border border-slate-200 text-[10px] font-semibold px-2 py-0.5 rounded-full">⚪ ออฟไลน์</span>`;

            let timeLabel = 'ยังไม่เคยออนไลน์';
            if (item.isOnline) timeLabel = 'ออนไลน์ขณะนี้';
            else if (item.lastSeenMs) {
                const mins = Math.max(1, Math.floor(item.diffMs / 60000));
                const hrs = Math.floor(mins / 60);
                timeLabel = mins < 60 ? `ออฟไลน์เมื่อ ${mins} นาทีที่แล้ว` : (hrs < 24 ? `ออฟไลน์เมื่อ ${hrs} ชม. ที่แล้ว` : `ออนไลน์ล่าสุด ${new Date(item.lastSeenMs).toLocaleDateString('th-TH')}`);
            }

            return `
                <div class="p-3 rounded-xl border bg-white shadow-sm flex items-center justify-between gap-2 ${item.isOnline ? 'border-emerald-300 border-l-4 border-l-emerald-500' : 'border-slate-200 opacity-75'}">
                    <div class="min-w-0 flex-1 space-y-0.5">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="font-bold text-slate-800 text-xs truncate">${roleIcon} ${escapeHtmlStr(item.displayName)}</span>
                            ${item.isMe ? `<span class="bg-teal-100 text-teal-800 text-[9px] font-bold px-1.5 py-0.5 rounded">คุณ</span>` : ''}
                        </div>
                        <div class="text-[10px] text-slate-500 flex items-center gap-2">
                            ${item.isOnline ? `<span class="text-teal-700 font-semibold">${escapeHtmlStr(item.currentPage)}</span>` : ''}
                            ${item.role === 'tech' ? `<span>• ${item.hasGps ? '📍 เปิด GPS' : '🚫 ปิด GPS'}</span>` : ''}
                        </div>
                        <div class="text-[10px] ${item.isOnline ? 'text-emerald-600 font-semibold' : 'text-slate-400'}">🕒 ${timeLabel}</div>
                    </div>
                    <div class="shrink-0">${statusBadge}</div>
                </div>`;
        }).join('');
    }

    async function handleTechLogin() {
        const u = document.getElementById('techUsername')?.value.trim() || '';
        const p = document.getElementById('techPassword')?.value.trim() || '';
        const btn = document.getElementById('techLoginBtn');
        if (!u || !p) { showToast('⚠️ กรุณากรอกรหัสพนักงานและรหัสผ่าน'); return; }

        if (btn) { btn.disabled = true; btn.textContent = '⏳ กำลังตรวจสอบรหัสผ่านที่เซิร์ฟเวอร์...'; }
        try {
            isSyncingNow = false;
            const data = await Core.verifyLoginOnServer(u, p);
            if (btn) { btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ'; }

            if (data?.status === 'ok' && data.authenticated && data.user) {
                lastTechLoginTimestamp = Date.now();
                document.getElementById('techUsername').value = '';
                document.getElementById('techPassword').value = '';
                lastRenderedCardsSignature = '';
                checkTechAuth();
                await syncJobsFromCloud(false);
                initTechGpsTracker();
                renderJobCards();
                showToast(`🔓 ยินดีต้อนรับคุณ ${formatTechDisplayName(data.user.username)}`);
            } else {
                showToast('❌ รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง');
            }
        } catch (err) {
            if (btn) { btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ'; }
            showToast('⚠️ ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ตรวจสอบรหัสผ่านได้');
        }
    }

    async function handleTechLogout() {
        if (typeof window.toggleScadaSimMode === 'function' && Core.simSandbox.active) {
            window.toggleScadaSimMode(false, true);
        }
        stopRealtimeGpsWatch();
        const curUser = (localStorage.getItem('elec_app_current_user') || '').trim();
        if (curUser) {
            const locMap = getTechLocationsMap();
            const nowIso = new Date().toISOString();
            Object.keys(locMap).forEach(k => {
                if (k !== Core.REGISTRY_LOC_KEY && (isSameTechPerson(k, curUser) || isSameTechPerson(locMap[k]?.username, curUser))) {
                    locMap[k] = { ...locMap[k], isOnline: false, gpsDisabled: true, lat: null, lon: null, lastSeenAt: nowIso, updatedAt: nowIso };
                }
            });
            localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
            try { Core.unlockCloudWrite(15000); await pushAllJobsToCloud(true); } catch (e) {}
        }
        ['elec_app_logged_in', 'elec_app_current_user', 'elec_app_current_group', 'elec_app_current_role', 'elec_app_session_token', 'elec_app_last_active']
            .forEach(k => localStorage.removeItem(k));
        lastRenderedCardsSignature = '';
        checkTechAuth();
        showToast('🔒 ออกจากระบบเรียบร้อยแล้ว');
    }

    // ========================================================================
    // 2. ระบบเสียงแจ้งเตือนและสั่นเตือนเมื่อมีใบงานใหม่เข้าเครื่องช่าง
    // ========================================================================
    function updateSoundToggleButtonUI() {
        const btn = document.getElementById('soundAlertToggleBtn');
        if (!btn) return;
        btn.textContent = isSoundAlertEnabled ? '🔔 เสียง: เปิด' : '🔕 เสียง: ปิด';
        btn.className = isSoundAlertEnabled
            ? 'bg-white/20 hover:bg-white/30 text-white px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm'
            : 'bg-slate-800/50 hover:bg-slate-800/70 text-slate-200 px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm';
    }

    function toggleSoundAlert() {
        isSoundAlertEnabled = !isSoundAlertEnabled;
        localStorage.setItem('elec_tech_sound_enabled', isSoundAlertEnabled ? 'true' : 'false');
        updateSoundToggleButtonUI();
        if (isSoundAlertEnabled) {
            playNewJobAlertSound(false);
            showToast('🔔 เปิดเสียงแจ้งเตือนใบงานใหม่แล้ว');
        } else {
            showToast('🔕 ปิดเสียงแจ้งเตือนใบงานใหม่แล้ว');
        }
    }

    function playNewJobAlertSound(isCritical = false) {
        if (!isSoundAlertEnabled || Core.isEmbeddedIframe) return;
        try {
            if (navigator.vibrate) navigator.vibrate(isCritical ? [300, 120, 300, 120, 400] : [200, 100, 200]);
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            if (ctx.state === 'suspended') ctx.resume();

            const playTone = (freq, startSec, durSec) => {
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = isCritical ? 'sawtooth' : 'sine';
                osc.frequency.setValueAtTime(freq, ctx.currentTime + startSec);
                gain.gain.setValueAtTime(0.18, ctx.currentTime + startSec);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startSec + durSec);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(ctx.currentTime + startSec); osc.stop(ctx.currentTime + startSec + durSec);
            };
            if (isCritical) {
                playTone(880, 0, 0.18); playTone(1174, 0.20, 0.18); playTone(880, 0.40, 0.18); playTone(1318, 0.60, 0.35);
            } else {
                playTone(659.25, 0, 0.16); playTone(880, 0.18, 0.30);
            }
            setTimeout(() => { if (ctx?.close) ctx.close().catch(() => {}); }, 1200);
        } catch (e) {}
    }

    function checkNewIncomingPendingJobs() {
        const outages = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]');
        const faults = JSON.parse(localStorage.getItem('fault_reports_all') || '[]');
        const currentKeys = new Set();
        let foundNew = false, foundCritical = false;

        outages.forEach(item => {
            if (!canCurrentUserSeeJob(item) || (item.techReport && String(item.techReport.status || '').includes('เสร็จสิ้น'))) return;
            const k = 'O_' + item.dateTimeSaved;
            currentKeys.add(k);
            if (hasInitializedPendingBaseline && !knownPendingJobKeys.has(k)) {
                foundNew = true;
                if (item.priorityLevel === 'critical') foundCritical = true;
            }
        });
        faults.forEach(item => {
            if (!canCurrentUserSeeJob(item) || (item.techReport && String(item.techReport.status || '').includes('เสร็จสิ้น'))) return;
            const k = 'F_' + item.timestamp;
            currentKeys.add(k);
            if (hasInitializedPendingBaseline && !knownPendingJobKeys.has(k)) {
                foundNew = true; foundCritical = true;
            }
        });

        knownPendingJobKeys = currentKeys;
        if (!hasInitializedPendingBaseline) { hasInitializedPendingBaseline = true; return; }
        if (foundNew) {
            playNewJobAlertSound(foundCritical);
            showToast(foundCritical ? '🚨 มีใบงานด่วน/วิกฤต เข้ามาใหม่!' : '🔔 มีใบงานแจ้งซ่อมเข้ามาใหม่!');
        }
    }

    // ========================================================================
    // 3. ระบบติดตามพิกัด GPS, แนะนำช่างใกล้สุด & นำทางไปจุดเกิดเหตุเรียลไทม์
    // ========================================================================
    function updateGpsToggleButtonUI() {
        const btn = document.getElementById('gpsToggleBtn');
        if (!btn) return;
        btn.textContent = isGpsTrackingEnabled ? '📍 GPS: เปิด' : '🚫 GPS: ปิด';
        btn.className = isGpsTrackingEnabled
            ? 'bg-white/20 hover:bg-white/30 text-white px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm'
            : 'bg-slate-800/50 hover:bg-slate-800/70 text-slate-200 px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm';
    }

    function clearMyGpsFromLocationsMap() {
        Core.updateUserOnlineHeartbeat('📱 หน้าช่าง', null, false);
    }

    async function toggleGpsTracking() {
        isGpsTrackingEnabled = !isGpsTrackingEnabled;
        localStorage.setItem('elec_tech_gps_enabled', isGpsTrackingEnabled ? 'true' : 'false');
        updateGpsToggleButtonUI();

        if (isGpsTrackingEnabled) {
            showToast('📍 เปิดการแชร์พิกัด GPS แล้ว กำลังค้นหาตำแหน่ง...');
            initTechGpsTracker(true);
        } else {
            stopRealtimeGpsWatch();
            if (techGpsIntervalId) { clearInterval(techGpsIntervalId); techGpsIntervalId = null; }
            lastKnownTechCoords = null;
            clearMyGpsFromLocationsMap();
            updateMyTechMarkerOnRepairMap();
            if (typeof window.__onTechGpsUpdated === 'function') window.__onTechGpsUpdated();
            renderJobCards();
            showToast('🚫 ปิดการแชร์พิกัด GPS และล้างตำแหน่งค้างเรียบร้อยแล้ว');
            Core.unlockCloudWrite(15000);
            await pushAllJobsToCloud(true);
        }
    }

    async function requestScreenWakeLock() {
        try {
            if ('wakeLock' in navigator && !screenWakeLock) {
                screenWakeLock = await navigator.wakeLock.request('screen');
                screenWakeLock.addEventListener('release', () => { screenWakeLock = null; });
            }
        } catch (e) {}
    }

    function recordCurrentTechGpsLocation(lat, lon) {
        const role = localStorage.getItem('elec_app_current_role') || 'user';
        if (!isGpsTrackingEnabled || !lat || !lon || Core.isEmbeddedIframe || role === 'viewer') return;
        lastKnownTechCoords = { lat: parseFloat(lat), lon: parseFloat(lon) };
        if (role !== 'admin') {
            Core.updateUserOnlineHeartbeat('📱 หน้าช่าง', lastKnownTechCoords, true);
        }
        updateMyTechMarkerOnRepairMap();
        if (typeof window.__onTechGpsUpdated === 'function') window.__onTechGpsUpdated();
    }

    function initTechGpsTracker(showFeedback = false) {
        updateGpsToggleButtonUI();
        if (!isGpsTrackingEnabled || Core.isEmbeddedIframe || isViewerRole()) {
            clearMyGpsFromLocationsMap();
            renderJobCards();
            return;
        }
        if (!navigator.geolocation) {
            if (showFeedback) showToast('⚠️ เบราว์เซอร์ของคุณไม่รองรับ GPS');
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                recordCurrentTechGpsLocation(pos.coords.latitude, pos.coords.longitude);
                renderJobCards();
                pushAllJobsToCloud(true);
                if (showFeedback) showToast('🟢 จับพิกัด GPS ปัจจุบันสำเร็จ!');
            },
            () => { if (showFeedback) showToast('⚠️ ไม่สามารถดึงพิกัดได้ กรุณาเปิด Location ในเครื่อง'); },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
        );
        if (techGpsIntervalId) clearInterval(techGpsIntervalId);
        techGpsIntervalId = setInterval(() => {
            if (!isGpsTrackingEnabled || localStorage.getItem('elec_app_logged_in') !== 'true') return;
            navigator.geolocation.getCurrentPosition(
                (pos) => recordCurrentTechGpsLocation(pos.coords.latitude, pos.coords.longitude),
                () => {},
                { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 }
            );
        }, 30000);
    }

    function captureCurrentTechGpsForModal() {
        const gpsInput = document.getElementById('techGpsInput');
        if (!navigator.geolocation) { showToast('⚠️ เบราว์เซอร์ไม่รองรับการดึงพิกัด GPS'); return; }
        showToast('⏳ กำลังดึงพิกัด GPS ปัจจุบัน...');
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = pos.coords.latitude.toFixed(6), lon = pos.coords.longitude.toFixed(6);
                if (isGpsTrackingEnabled) recordCurrentTechGpsLocation(lat, lon);
                if (gpsInput) gpsInput.value = `https://www.google.com/maps?q=${lat},${lon}`;
                showToast(`📍 ดึงพิกัดหน้างานสำเร็จ (${lat}, ${lon})`);
            },
            () => {
                if (lastKnownTechCoords && gpsInput) {
                    const lat = lastKnownTechCoords.lat.toFixed(6), lon = lastKnownTechCoords.lon.toFixed(6);
                    gpsInput.value = `https://www.google.com/maps?q=${lat},${lon}`;
                    showToast(`📍 ใช้พิกัดล่าสุดของเครื่อง (${lat}, ${lon})`);
                } else {
                    showToast('❌ ไม่สามารถดึงพิกัดได้ กรุณาเปิด Location ในมือถือ');
                }
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
        );
    }

    function extractCoordsFromJob(item) {
        const textBlob = `${item?.techReport?.fieldGps || ''} ${item?.gps || ''} ${item?.address || ''} ${item?.area || ''} ${item?.weather || ''}`.trim();
        if (!textBlob) return null;
        const direct = deepParseCoords(textBlob, false);
        if (direct) return { lat: parseFloat(direct.lat), lon: parseFloat(direct.lon) };

        for (const [tbName, tbCoord] of Object.entries(EXTENDED_AREA_COORDS)) {
            if (textBlob.includes(tbName)) return { lat: tbCoord.lat, lon: tbCoord.lon, isApproxTambon: true };
        }
        return null;
    }

    function findNearestTechForJob(item) {
        const destCoord = extractCoordsFromJob(item);
        if (!destCoord) return null;

        const jobGroup = getJobGroupName(item);
        const locMap = getTechLocationsMap();
        const accounts = getParsedUserAccounts();
        const curUser = (localStorage.getItem('elec_app_current_user') || '').trim();
        const curRole = localStorage.getItem('elec_app_current_role') || 'user';
        const nowMs = Date.now();

        if (isGpsTrackingEnabled && lastKnownTechCoords && curUser && curRole !== 'admin' && curRole !== 'viewer' && !Core.isEmbeddedIframe) {
            locMap[curUser] = {
                username: curUser, role: curRole, group: getCurrentUserGroup(),
                lat: lastKnownTechCoords.lat, lon: lastKnownTechCoords.lon,
                gpsDisabled: false, isOnline: true, lastSeenAt: new Date().toISOString()
            };
        }

        const candidates = [];
        Object.entries(locMap).forEach(([k, loc]) => {
            if (k === Core.REGISTRY_LOC_KEY || !loc || loc.isOnline === false || loc.gpsDisabled || !loc.lat || !loc.lon || !loc.username) return;
            if (!isGpsTrackingEnabled && curUser && isSameTechPerson(loc.username, curUser)) return;
            const seenMs = new Date(loc.lastSeenAt || loc.updatedAt || 0).getTime() || 0;
            if (seenMs <= 0 || (nowMs - seenMs) > 180000) return;

            const accMatch = accounts.find(a => isUsernameMatchingAccount(loc.username, a.username));
            const effRole = accMatch ? accMatch.role : (loc.role || 'tech');
            if (effRole === 'viewer' || effRole === 'admin') return;

            const effGroup = getUserGroupName(loc.username) || loc.group || '';
            if (jobGroup && effGroup && jobGroup !== effGroup) return;

            const roadKm = Math.max(0.2, calcHaversineKm(loc.lat, loc.lon, destCoord.lat, destCoord.lon) * 1.35);
            candidates.push({
                username: accMatch ? accMatch.username : loc.username,
                roadKm,
                estMin: Math.max(1, Math.round((roadKm / 45) * 60)),
                isTechRole: effRole === 'tech'
            });
        });

        const techOnly = candidates.filter(c => c.isTechRole);
        const pool = techOnly.length > 0 ? techOnly : candidates;
        if (pool.length === 0) return null;

        pool.sort((a, b) => a.roadKm - b.roadKm);
        const best = pool[0];
        return {
            techName: best.username,
            distanceKm: best.roadKm.toFixed(1),
            durationMin: best.estMin,
            hasGps: true,
            isMe: Boolean(curUser && isSameTechPerson(best.username, curUser))
        };
    }

    function calculateInstantRouteFallback(startCoord, destCoord) {
        const straightKm = calcHaversineKm(startCoord.lat, startCoord.lon, destCoord.lat, destCoord.lon);
        if (straightKm <= 0.12) return { distanceKm: '0.0', durationMin: 0, isArrived: true };
        const roadKm = Math.max(0.3, straightKm * 1.35);
        return { distanceKm: roadKm.toFixed(1), durationMin: Math.max(2, Math.round((roadKm / 45) * 60)), isArrived: false };
    }

    async function calculateDrivingRoute(startCoord, destCoord) {
        const straightKm = calcHaversineKm(startCoord.lat, startCoord.lon, destCoord.lat, destCoord.lon);
        if (straightKm <= 0.12) return { distanceKm: '0.0', durationMin: 0, isArrived: true };
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 1800);
            const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${startCoord.lon},${startCoord.lat};${destCoord.lon},${destCoord.lat}?overview=false`, { signal: ctrl.signal });
            clearTimeout(timer);
            if (res.ok) {
                const route = (await res.json())?.routes?.[0];
                if (route) {
                    return {
                        distanceKm: Math.max(0.1, route.distance / 1000).toFixed(1),
                        durationMin: Math.max(1, Math.round((route.duration / 60) * 1.15)),
                        isArrived: false
                    };
                }
            }
        } catch (e) {}
        return calculateInstantRouteFallback(startCoord, destCoord);
    }

    function stopRealtimeGpsWatch() {
        if (activeNavWatchId !== null && navigator.geolocation) {
            navigator.geolocation.clearWatch(activeNavWatchId);
            activeNavWatchId = null;
        }
        activeNavJobKey = null;
    }
    // ===== จบพาทที่ 1 / 3 ของไฟล์ tech-jobs.js (นำพาทที่ 2 / 3 มาวางต่อจากบรรทัดนี้ได้เลยครับ) =====
    // ===== เริ่มพาทที่ 2 / 3 ของไฟล์ tech-jobs.js (วางต่อจากพาทที่ 1 / 3) =====

    // ========================================================================
    // 4. ระบบนำทางใบงานซ่อมเรียลไทม์ (Start / Watch / Cancel Navigation)
    // ========================================================================
    function startRealtimeGpsWatch(key, jobType, destCoord) {
        stopRealtimeGpsWatch();
        if (!isGpsTrackingEnabled || !navigator.geolocation || !destCoord) return;

        activeNavJobKey = key;
        activeNavJobType = jobType;
        requestScreenWakeLock();

        activeNavWatchId = navigator.geolocation.watchPosition(
            async (pos) => {
                if (!isGpsTrackingEnabled) { stopRealtimeGpsWatch(); return; }
                recordCurrentTechGpsLocation(pos.coords.latitude, pos.coords.longitude);
                const nowMs = Date.now();
                if (nowMs - lastNavCloudPushTime < 8000) return;
                lastNavCloudPushTime = nowMs;

                const storageKey = activeNavJobType === 'outage' ? 'elecReportsComplete_all' : 'fault_reports_all';
                const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
                const idx = list.findIndex(i => (activeNavJobType === 'outage' ? i.dateTimeSaved : i.timestamp) === activeNavJobKey);
                if (idx === -1) { stopRealtimeGpsWatch(); return; }

                const item = list[idx];
                if (!item.techNav || (item.techReport && String(item.techReport.status || '').includes('เสร็จสิ้น'))) {
                    stopRealtimeGpsWatch();
                    return;
                }

                const routeInfo = await calculateDrivingRoute(lastKnownTechCoords, destCoord);
                const prevNav = item.techNav || {};
                const etaMs = nowMs + (routeInfo.durationMin * 60000);
                const etaDate = new Date(etaMs);
                const etaTimeStr = `${String(etaDate.getHours()).padStart(2, '0')}.${String(etaDate.getMinutes()).padStart(2, '0')} น.`;

                item.techNav = {
                    ...prevNav,
                    durationMin: routeInfo.durationMin,
                    distanceKm: routeInfo.distanceKm,
                    initialDistanceKm: prevNav.initialDistanceKm || routeInfo.distanceKm,
                    departTimestamp: prevNav.departTimestamp || nowMs,
                    etaTimestamp: etaMs,
                    etaTime: routeInfo.isArrived ? 'ถึงจุดเกิดเหตุแล้ว' : etaTimeStr,
                    isArrived: routeInfo.isArrived,
                    techLat: lastKnownTechCoords.lat,
                    techLon: lastKnownTechCoords.lon,
                    statusText: routeInfo.isArrived
                        ? '📍 ถึงจุดเกิดเหตุแล้ว (กำลังตรวจสอบ)'
                        : `อีกประมาณ ${routeInfo.durationMin} นาทีถึง (ถึง ~${etaTimeStr})`,
                    updatedAt: new Date().toISOString(),
                    needsMainSync: true
                };

                localStorage.setItem(storageKey, JSON.stringify(list));
                updateLiveNavDomElements();
                Core.unlockCloudWrite(20000);
                await pushAllJobsToCloud(true);

                if (routeInfo.isArrived) {
                    showToast('📍 คุณเดินทางถึงจุดเกิดเหตุแล้ว!');
                    stopRealtimeGpsWatch();
                }
            },
            () => {},
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
        );
    }

    async function handleStartNavigation(key, jobType, gpsLink) {
        if (isViewerRole()) {
            if (gpsLink) {
                window.open(gpsLink, '_blank');
                showToast('🗺️ เปิดแผนที่ Google Maps (โหมดผู้สำรวจ)');
            } else {
                showToast(VIEWER_LOCK_MSG);
            }
            return;
        }

        Core.unlockCloudWrite(20000);
        recentlyCancelledNavKeys.delete(key);

        const cancelJobMap = JSON.parse(localStorage.getItem(CANCELLED_JOB_NAV_KEY) || '{}');
        const prevCancelIso = cancelJobMap[key] || '';
        if (cancelJobMap[key]) {
            delete cancelJobMap[key];
            localStorage.setItem(CANCELLED_JOB_NAV_KEY, JSON.stringify(cancelJobMap));
        }

        const storageKey = jobType === 'outage' ? 'elecReportsComplete_all' : 'fault_reports_all';
        const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const idx = list.findIndex(i => (jobType === 'outage' ? i.dateTimeSaved : i.timestamp) === key);
        if (idx === -1) {
            if (gpsLink) window.open(gpsLink, '_blank');
            return;
        }

        const item = list[idx];
        const prevCancelMs = Math.max(
            prevCancelIso ? new Date(prevCancelIso).getTime() : 0,
            item.navCancelledAt ? new Date(item.navCancelledAt).getTime() : 0
        );
        cachedCloudJobs.forEach(cj => {
            if ((cj.jobType === 'fault' ? cj.timestamp : cj.dateTimeSaved) === key) delete cj.navCancelledAt;
        });

        const loggedInUser = (localStorage.getItem('elec_app_current_user') || 'ช่างหน้างาน').trim();
        const myGroup = getCurrentUserGroup();
        const now = new Date();
        const safeStartMs = Math.max(now.getTime(), prevCancelMs + 2000);
        const departTimeStr = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')} น.`;
        const destCoord = extractCoordsFromJob(item);
        const startCoord = lastKnownTechCoords || { lat: 13.1361, lon: 101.0322 };

        const route = destCoord
            ? calculateInstantRouteFallback(startCoord, destCoord)
            : { distanceKm: '5.0', durationMin: 15, isArrived: false };

        const etaMs = safeStartMs + (route.durationMin * 60000);
        const etaDate = new Date(etaMs);
        const etaTimeStr = `${String(etaDate.getHours()).padStart(2, '0')}.${String(etaDate.getMinutes()).padStart(2, '0')} น.`;

        item.techNav = {
            durationMin: route.durationMin,
            initialDurationMin: route.durationMin,
            distanceKm: route.distanceKm,
            initialDistanceKm: route.distanceKm,
            departTime: departTimeStr,
            departTimestamp: safeStartMs,
            etaTime: etaTimeStr,
            etaTimestamp: etaMs,
            isArrived: route.isArrived,
            techName: loggedInUser,
            statusText: route.isArrived
                ? '📍 ถึงจุดเกิดเหตุแล้ว (กำลังตรวจสอบ)'
                : `อีกประมาณ ${route.durationMin} นาทีถึง (ถึง ~${etaTimeStr})`,
            updatedAt: new Date(safeStartMs).toISOString(),
            needsMainSync: true
        };
        delete item.navCancelledAt;
        if (myGroup) item.ownerGroup = myGroup;

        // บันทึกสถานะลงเครื่องทันทีก่อนสลับไปเปิดแอป Google Maps ป้องกันเบราว์เซอร์มือถือตัดการทำงาน
        localStorage.setItem(storageKey, JSON.stringify(list));
        switchStatusTab('traveling');
        showToast(gpsLink ? '🚗 บันทึกสถานะเดินทางและกำลังเปิด Google Maps...' : '🚗 บันทึกสถานะกำลังเดินทางไปหน้างานแล้ว!');

        if (gpsLink) window.open(gpsLink, '_blank');
        if (destCoord && isGpsTrackingEnabled) startRealtimeGpsWatch(key, jobType, destCoord);
        await pushAllJobsToCloud(true);
    }

    async function handleCancelNavigation(key, jobType) {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        stopRealtimeGpsWatch();
        Core.unlockCloudWrite(20000);

        const storageKey = jobType === 'outage' ? 'elecReportsComplete_all' : 'fault_reports_all';
        const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const idx = list.findIndex(i => (jobType === 'outage' ? i.dateTimeSaved : i.timestamp) === key);
        if (idx === -1) return;

        const prevNavMs = list[idx]?.techNav?.updatedAt ? new Date(list[idx].techNav.updatedAt).getTime() : 0;
        const safeCancelIso = new Date(Math.max(Date.now(), prevNavMs) + 2000).toISOString();

        recentlyCancelledNavKeys.set(key, { ts: Date.now(), iso: safeCancelIso });
        const cancelMap = JSON.parse(localStorage.getItem(CANCELLED_JOB_NAV_KEY) || '{}');
        cancelMap[key] = safeCancelIso;
        localStorage.setItem(CANCELLED_JOB_NAV_KEY, JSON.stringify(cancelMap));

        delete list[idx].techNav;
        list[idx].navCancelledAt = safeCancelIso;
        localStorage.setItem(storageKey, JSON.stringify(list));

        switchStatusTab('pending');
        showToast("↩️ ยกเลิกการเดินทางแล้ว ย้ายงานกลับไปช่อง 'รอแก้ไข'");
        await pushAllJobsToCloud(true);
    }

    function formatRealtimeNavHtml(nav) {
        if (!nav) return '';
        const nowMs = Date.now();
        const isGpsFresh = nav.updatedAt && (nowMs - new Date(nav.updatedAt).getTime() < 45000);
        const liveBadge = isGpsFresh
            ? `<span class="inline-flex items-center gap-1 bg-emerald-100 text-emerald-700 text-[9px] font-bold px-1.5 py-0.5 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>GPS สด</span>`
            : `<span class="inline-flex items-center gap-1 bg-blue-100 text-blue-700 text-[9px] font-bold px-1.5 py-0.5 rounded-full">⏱️ เรียลไทม์</span>`;
        const friendlyTech = escapeHtmlStr(formatTechDisplayName(nav.techName || '-'));

        if (nav.isArrived) {
            return `
                <div class="flex justify-between items-center">
                    <div class="font-bold text-emerald-700">📍 ถึงจุดเกิดเหตุแล้ว (กำลังตรวจสอบหน้างาน)</div>
                    ${liveBadge}
                </div>
                <div class="w-full bg-emerald-200 h-2 rounded-full overflow-hidden my-1"><div class="bg-emerald-600 h-full w-full"></div></div>
                <div class="text-[10px] text-emerald-800">👷 ช่าง: ${friendlyTech} (ออกเดินทาง ${escapeHtmlStr(nav.departTime || '-')})</div>`;
        }

        if (nav.etaTimestamp && nav.departTimestamp) {
            const remainSec = Math.max(0, Math.floor((nav.etaTimestamp - nowMs) / 1000));
            const totalDurSec = Math.max(60, Math.floor((nav.etaTimestamp - nav.departTimestamp) / 1000));
            const elapsedRatio = Math.min(1, Math.max(0.05, 1 - (remainSec / totalDurSec)));
            const progressPct = Math.round(elapsedRatio * 100);
            const initDist = parseFloat(nav.initialDistanceKm || nav.distanceKm || 0);
            const curDist = parseFloat(nav.distanceKm || 0);
            const estRemainDist = isGpsFresh ? curDist.toFixed(1) : Math.max(0.1, initDist * (1 - elapsedRatio * 0.95)).toFixed(1);

            if (remainSec <= 0) {
                return `
                    <div class="flex justify-between items-center">
                        <div class="font-bold text-emerald-700">📍 คาดว่าถึงจุดเกิดเหตุแล้ว (ครบกำหนดเวลา ${escapeHtmlStr(nav.etaTime || '')})</div>
                        ${liveBadge}
                    </div>
                    <div class="w-full bg-emerald-200 h-2 rounded-full overflow-hidden my-1"><div class="bg-emerald-600 h-full w-full"></div></div>
                    <div class="text-[10px] text-blue-800">👷 ช่าง: ${friendlyTech} (ออกเดินทาง ${escapeHtmlStr(nav.departTime || '-')})</div>`;
            }

            const mins = Math.floor(remainSec / 60);
            const secs = String(remainSec % 60).padStart(2, '0');
            return `
                <div class="flex justify-between items-center gap-1">
                    <div class="font-bold text-blue-700">🚗 กำลังเดินทาง: อีก ${mins} นาที ${secs} วินาที (ถึง ~${escapeHtmlStr(nav.etaTime || '-')})</div>
                    ${liveBadge}
                </div>
                <div class="relative w-full bg-blue-200/80 h-2 rounded-full overflow-hidden my-1.5">
                    <div class="bg-gradient-to-r from-blue-500 to-indigo-600 h-full transition-all duration-700" style="width:${progressPct}%"></div>
                </div>
                <div class="flex justify-between items-center text-[10px] text-blue-800">
                    <span>📏 ระยะทางเหลือ: ~${estRemainDist} กม. (${progressPct}%)</span>
                    <span>👷 ${friendlyTech} (ออก ${escapeHtmlStr(nav.departTime || '-')})</span>
                </div>`;
        }

        return `
            <div class="font-bold text-blue-700">🚗 ${escapeHtmlStr(nav.statusText || 'กำลังเดินทาง')}</div>
            <div class="text-[10px] text-blue-800">👷 ช่าง: ${friendlyTech} (ออกเดินทาง ${escapeHtmlStr(nav.departTime || '-')})</div>`;
    }

    function updateLiveNavDomElements() {
        document.querySelectorAll('.realtime-nav-box').forEach(box => {
            const key = box.getAttribute('data-job-key');
            const jType = box.getAttribute('data-job-type');
            const list = JSON.parse(localStorage.getItem(jType === 'outage' ? 'elecReportsComplete_all' : 'fault_reports_all') || '[]');
            const item = list.find(i => (jType === 'outage' ? i.dateTimeSaved : i.timestamp) === key);
            if (item?.techNav && !(item.techReport && String(item.techReport.status || '').includes('เสร็จสิ้น'))) {
                box.innerHTML = formatRealtimeNavHtml(item.techNav);
            }
        });
    }

    // ========================================================================
    // 5. ระบบซิงค์ใบงานกับ Google Sheets (Pull / Merge / Trailing Queue Push)
    // ========================================================================
    function rescueFalselyClosedRecentJobs() {
        const now = new Date();
        const todayThai = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear() + 543}`;
        const closedMap = getClosedReportsRegistry();
        let mapChanged = false, outagesChanged = false;

        const localOutages = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]');
        localOutages.forEach(item => {
            const dStr = (item.reportDate && item.reportDate !== '-') ? item.reportDate : (item.dateTimeSaved ? item.dateTimeSaved.split(' ')[0] : '');
            if (dStr === todayThai && isAutoGeneratedFakeClosure(item.techReport)) {
                delete item.techReport;
                outagesChanged = true;
                if (closedMap[item.dateTimeSaved] && isAutoGeneratedFakeClosure(closedMap[item.dateTimeSaved])) {
                    delete closedMap[item.dateTimeSaved];
                    mapChanged = true;
                }
            }
        });
        Object.keys(closedMap).forEach(k => {
            if (k.startsWith(todayThai) && isAutoGeneratedFakeClosure(closedMap[k])) {
                delete closedMap[k];
                mapChanged = true;
            }
        });
        if (outagesChanged) localStorage.setItem('elecReportsComplete_all', JSON.stringify(localOutages));
        if (mapChanged) saveClosedReportsRegistry(closedMap);
    }

    function normalizeJobGpsAndReportText(storageKey, isFault) {
        try {
            const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
            let changed = false;
            list.forEach(item => {
                if (!item) return;
                if (item.gps && item.gps !== '-' && !String(item.gps).startsWith('http')) {
                    const m = String(item.gps).trim().match(/^(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{2,3}\.\d{4,})$/);
                    if (m) { item.gps = `https://www.google.com/maps?q=${m[1]},${m[2]}`; changed = true; }
                }
                const tr = item.techReport;
                if (tr?.status && tr.status !== 'รอแก้ไข') {
                    if (tr.fieldGps && tr.fieldGps !== '-' && item.gps !== tr.fieldGps) {
                        const mG = String(tr.fieldGps).trim().match(/^(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{2,3}\.\d{4,})$/);
                        item.gps = mG ? `https://www.google.com/maps?q=${mG[1]},${mG[2]}` : tr.fieldGps;
                        changed = true;
                    }
                    const urg = getJobUrgencyInfo(item, isFault ? 'fault' : 'outage');
                    const hdr = !isFault
                        ? `${urg.dot} งานที่ ${item.jobNo || '-'} กะ ${item.shift || '-'} (${item.issueType || '-'})`
                        : `${urg.dot} วงจร ${item.circuit || '-'} สถานี${item.station || '-'} (${item.system || '-'})`;
                    const gpsLine = tr.fieldGps ? `\n📍 พิกัดหน้างาน : ${tr.fieldGps}` : '';
                    const techText = `--- 🛠️ ผลตรวจสอบหน้างาน ---\n${hdr}\n🚦 สถานะ : ${tr.status}\n🔍 สาเหตุจริง : ${tr.realCause || '-'}\n🛠️ การแก้ไข : ${tr.actionTaken || '-'}\n⏰ เวลาเสร็จ : ${tr.finishTime || '-'}\n👷 ผู้ตรวจสอบ : ${tr.inspector || '-'}${gpsLine}`;
                    const baseText = (item.formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0];
                    const full = `${baseText}\n\n${techText}`;
                    if (item.formattedText !== full) { item.formattedText = full; changed = true; }
                } else if (item.formattedText && item.formattedText.includes('--- 🛠️ ผลตรวจสอบหน้างาน ---')) {
                    item.formattedText = item.formattedText.split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0];
                    changed = true;
                }
            });
            if (changed) localStorage.setItem(storageKey, JSON.stringify(list));
        } catch (e) {}
    }

    function mergeCloudJobsToLocal(cloudJobs) {
        Core.cleanReopenedAndCancelledJobsInStorage();
        rescueFalselyClosedRecentJobs();

        const localOutages = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]');
        const localFaults = JSON.parse(localStorage.getItem('fault_reports_all') || '[]');
        const closedMap = getClosedReportsRegistry();
        const now = Date.now();

        const mergeItem = (existing, cJob) => {
            if (cJob.techReport && isAutoGeneratedFakeClosure(cJob.techReport)) delete cJob.techReport;
            if (!existing) return cJob;
            if (existing.techReport && isAutoGeneratedFakeClosure(existing.techReport)) delete existing.techReport;

            const jobKey = cJob.jobType === 'fault' ? cJob.timestamp : cJob.dateTimeSaved;
            const exRepT = existing.techReport?.updatedAt || '';
            const cRepT = cJob.techReport?.updatedAt || '';
            let bestReport = cRepT >= exRepT ? (cJob.techReport || existing.techReport) : existing.techReport;
            if (!bestReport && jobKey && closedMap[jobKey] && !isAutoGeneratedFakeClosure(closedMap[jobKey])) {
                bestReport = closedMap[jobKey];
            }

            const latestReopen = (cJob.reopenedAt || '') >= (existing.reopenedAt || '') ? (cJob.reopenedAt || '') : (existing.reopenedAt || '');
            if (latestReopen && (!bestReport?.updatedAt || latestReopen > bestReport.updatedAt)) {
                bestReport = undefined;
                if (jobKey) delete closedMap[jobKey];
            }

            const recentCancel = jobKey ? recentlyCancelledNavKeys.get(jobKey) : null;
            let latestCancel = (cJob.navCancelledAt || '') >= (existing.navCancelledAt || '') ? (cJob.navCancelledAt || '') : (existing.navCancelledAt || '');
            if (recentCancel && (now - recentCancel.ts < 8000) && recentCancel.iso > latestCancel) {
                latestCancel = recentCancel.iso;
            }

            const exNavT = existing.techNav?.updatedAt || '';
            const cNavT = cJob.techNav?.updatedAt || '';
            let bestNav = cNavT >= exNavT ? (cJob.techNav || existing.techNav) : existing.techNav;

            const isNowDone = bestReport && String(bestReport.status || '').includes('เสร็จสิ้น');
            if (isNowDone || (latestCancel && (!bestNav?.updatedAt || latestCancel >= bestNav.updatedAt))) {
                bestNav = undefined;
            }
            if (isNowDone && jobKey) {
                closedMap[jobKey] = bestReport;
                if (activeNavJobKey === jobKey) stopRealtimeGpsWatch();
            }

            const baseCore = (existing.editedAt || '') > (cJob.editedAt || '') ? { ...cJob, ...existing } : { ...existing, ...cJob };
            const merged = {
                ...baseCore,
                techReport: bestReport,
                reopenedAt: latestReopen || undefined,
                navCancelledAt: latestCancel || undefined
            };
            delete merged.pendingInitialUpload;
            if (!bestReport) delete merged.techReport;
            if (bestNav) merged.techNav = bestNav; else delete merged.techNav;
            return merged;
        };

        const outageMap = new Map(localOutages.map(i => [i.dateTimeSaved, i]));
        cloudJobs.filter(j => j.jobType !== 'fault' && j.dateTimeSaved).forEach(cj => {
            outageMap.set(cj.dateTimeSaved, mergeItem(outageMap.get(cj.dateTimeSaved), cj));
        });

        const faultMap = new Map(localFaults.map(i => [i.timestamp, i]));
        cloudJobs.filter(j => j.jobType === 'fault' && j.timestamp).forEach(cj => {
            faultMap.set(cj.timestamp, mergeItem(faultMap.get(cj.timestamp), cj));
        });

        saveClosedReportsRegistry(closedMap);
        localStorage.setItem('elecReportsComplete_all', JSON.stringify(
            Array.from(outageMap.values()).sort((a, b) => getJobSortTimeMs(b, 'outage') - getJobSortTimeMs(a, 'outage'))
        ));
        localStorage.setItem('fault_reports_all', JSON.stringify(
            Array.from(faultMap.values()).sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
        ));

        Core.cleanReopenedAndCancelledJobsInStorage();
        normalizeJobGpsAndReportText('elecReportsComplete_all', false);
        normalizeJobGpsAndReportText('fault_reports_all', true);
    }

    function applyCloudLocRegistry(locReg) {
        if (!locReg) return {};
        const delMap = locReg.deletedJobsMap || {};
        if (locReg.techLocations) mergeTechLocationsMap(locReg.techLocations);
        if (locReg.closedReports || locReg.closedJobsMap) {
            const localClosed = getClosedReportsRegistry();
            Object.assign(localClosed, locReg.closedReports || {}, locReg.closedJobsMap || {});
            saveClosedReportsRegistry(localClosed);
        }
        if (Object.keys(delMap).length > 0) {
            localStorage.setItem('elec_deleted_jobs_registry', JSON.stringify(delMap));
            localStorage.setItem('elecReportsComplete_all', JSON.stringify(
                JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]').filter(o => !delMap[o.dateTimeSaved])
            ));
            localStorage.setItem('fault_reports_all', JSON.stringify(
                JSON.parse(localStorage.getItem('fault_reports_all') || '[]').filter(f => !delMap[f.timestamp])
            ));
        }
        if (typeof window.__mergeCloudEquipRegistry === 'function') {
            window.__mergeCloudEquipRegistry(locReg);
        }
        return delMap;
    }

    async function syncJobsFromCloud(silent = false) {
        syncTickCounter++;
        const isLoggingInNow = document.getElementById('techLoginBtn')?.disabled === true;
        const forceFreshRead = (!silent || isLoggingInNow || syncTickCounter === 1 || syncTickCounter % 3 === 0);

        if (!forceFreshRead) {
            renderJobCards();
            if (typeof renderRepairJobsMapMarkers === 'function') renderRepairJobsMapMarkers(false);
            return;
        }
        if (isSyncingNow && silent) return;
        isSyncingNow = true;
        Core.forceCloudRead();

        const statusEl = document.getElementById('cloudStatusText');
        if (!silent && statusEl) statusEl.textContent = '⏳ กำลังดึงใบงานล่าสุด...';

        try {
            const res = await fetch(getActiveCloudApiUrl() + '?t=' + Date.now(), { cache: 'no-store' });
            const data = await res.json();
            if (data?.status === 'ok') {
                if (Array.isArray(data.users) && data.users.length > 0) {
                    const parsedUsers = data.users.map(parseAccountRecord);
                    localStorage.setItem('elec_user_accounts', JSON.stringify(parsedUsers));
                    if (localStorage.getItem('elec_app_logged_in') === 'true' && (Date.now() - lastTechLoginTimestamp > 8000)) {
                        const curUser = localStorage.getItem('elec_app_current_user') || '';
                        const matched = parsedUsers.find(u => isUsernameMatchingAccount(curUser, u.username));
                        if (matched) {
                            const fullName = normalizeUsernameFormat(matched.username);
                            localStorage.setItem('elec_app_current_user', fullName);
                            localStorage.setItem('elec_app_current_group', getUserGroupName(fullName));
                            localStorage.setItem('elec_app_current_role', matched.role || 'user');
                            updateRoleNavigationUI();
                        }
                    }
                }
                if (Array.isArray(data.jobs)) {
                    const locReg = data.jobs.find(j => j.jobType === 'tech_loc');
                    const delMap = applyCloudLocRegistry(locReg);
                    const realJobs = data.jobs.filter(j => j.jobType !== 'tech_loc' && !delMap[j.jobType === 'fault' ? j.timestamp : j.dateTimeSaved]);
                    cachedCloudJobs = realJobs;
                    mergeCloudJobsToLocal(realJobs);
                    checkNewIncomingPendingJobs();
                    if (statusEl) {
                        statusEl.textContent = `🟢 ซิงค์ล่าสุดแล้ว (${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} น. • ออนไลน์ ${realJobs.length} งาน)`;
                    }
                }
                Core.updateUserOnlineHeartbeat('📱 หน้าช่าง', lastKnownTechCoords, isGpsTrackingEnabled);
                updateTechOnlineCountUI();
                renderJobCards();
                if (!silent) showToast('🔄 อัปเดตใบงานล่าสุดเรียบร้อย');
            }
        } catch (e) {
            if (statusEl) statusEl.textContent = '⚠️ โหมดออฟไลน์ (แสดงข้อมูลในเครื่อง)';
            renderJobCards();
        }
        isSyncingNow = false;
    }

    const _queuedPushAllJobs = Core.createTrailingAsyncQueue(async function (silent = false) {
        if (isViewerRole()) return true;
        if (!navigator.onLine) {
            localStorage.setItem('elec_tech_has_pending_push', 'true');
            const statusEl = document.getElementById('cloudStatusText');
            if (statusEl) statusEl.textContent = '🟠 บันทึกลงเครื่องแล้ว (รอส่งขึ้นระบบอัตโนมัติเมื่อมีเน็ต)';
            return false;
        }

        Core.updateUserOnlineHeartbeat('📱 หน้าช่าง', lastKnownTechCoords, isGpsTrackingEnabled);
        if (typeof syncEquipNavToTechLocations === 'function') syncEquipNavToTechLocations();
        Core.cleanReopenedAndCancelledJobsInStorage();
        normalizeJobGpsAndReportText('elecReportsComplete_all', false);
        normalizeJobGpsAndReportText('fault_reports_all', true);

        const now = Date.now();
        if (!silent || activeNavWatchId !== null || localStorage.getItem('elec_tech_has_pending_push') === 'true' || (now - lastIdleHeartbeatWriteMs >= 60000)) {
            lastIdleHeartbeatWriteMs = now;
            Core.unlockCloudWrite(20000);
        }

        const statusEl = document.getElementById('cloudStatusText');
        if (!silent && statusEl) statusEl.textContent = '⏳ กำลังอัปเดตข้อมูลใบงานขึ้นระบบ...';

        try {
            try {
                const preRes = await fetch(getActiveCloudApiUrl() + '?t=' + Date.now(), { cache: 'no-store' });
                const preData = await preRes.json();
                if (preData?.status === 'ok' && Array.isArray(preData.jobs)) {
                    const delMap = applyCloudLocRegistry(preData.jobs.find(j => j.jobType === 'tech_loc'));
                    const latestReal = preData.jobs.filter(j => j.jobType !== 'tech_loc' && !delMap[j.jobType === 'fault' ? j.timestamp : j.dateTimeSaved]);
                    cachedCloudJobs = latestReal;
                    mergeCloudJobsToLocal(latestReal);
                }
            } catch (e) {}

            const delMap = getDeletedJobsRegistry();
            const localOutages = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]')
                .filter(i => !delMap[i.dateTimeSaved])
                .map(i => { const c = { ...i, jobType: 'outage' }; if (c.recommendedTech && !c.recommendedTech.hasGps) delete c.recommendedTech; return c; });
            const localFaults = JSON.parse(localStorage.getItem('fault_reports_all') || '[]')
                .filter(i => !delMap[i.timestamp])
                .map(i => { const c = { ...i, jobType: 'fault' }; if (c.recommendedTech && !c.recommendedTech.hasGps) delete c.recommendedTech; return c; });

            const combinedMap = new Map();
            cachedCloudJobs.forEach(cj => {
                if (cj.jobType === 'tech_loc') return;
                const rk = cj.jobType === 'fault' ? cj.timestamp : cj.dateTimeSaved;
                if (rk && !delMap[rk]) combinedMap.set((cj.jobType === 'fault' ? 'F_' : 'O_') + rk, cj);
            });
            [...localOutages.slice(0, 300), ...localFaults.slice(0, 300)].forEach(lj => {
                const rk = lj.jobType === 'fault' ? lj.timestamp : lj.dateTimeSaved;
                if (rk) combinedMap.set((lj.jobType === 'fault' ? 'F_' : 'O_') + rk, lj);
            });

            const locRegistryItem = {
                jobType: 'tech_loc',
                dateTimeSaved: 'TECH_LOC_REGISTRY',
                techLocations: getTechLocationsMap(),
                closedJobsMap: getClosedReportsRegistry(),
                deletedJobsMap: delMap,
                updatedAt: new Date().toISOString()
            };
            const payloadJobs = [...Array.from(combinedMap.values()), locRegistryItem];
            cachedCloudJobs = Array.from(combinedMap.values());

            const res = await fetch(getActiveCloudApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({ action: 'saveJobs', jobs: payloadJobs })
            });
            const data = await res.json();
            if (data?.status === 'ok') {
                localStorage.removeItem('elec_tech_has_pending_push');
                if (statusEl) statusEl.textContent = `🟢 อัปเดตข้อมูลล่าสุดแล้ว (${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} น.)`;
                return true;
            }
        } catch (e) {}
        localStorage.setItem('elec_tech_has_pending_push', 'true');
        if (statusEl) statusEl.textContent = '🟠 บันทึกลงเครื่องแล้ว (รอส่งซ้ำเมื่อสัญญาณเสถียร)';
        return false;
    });

    function pushAllJobsToCloud(silent = false) {
        return _queuedPushAllJobs(silent);
    }

    // ========================================================================
    // 6. ตัวกรองวันที่/กะ/สถานะ & ฟังก์ชันจัดรูปแบบความเร่งด่วนของใบงาน
    // ========================================================================
    function updateDateFilterButtonsUI() {
        const dateVal = document.getElementById('filterJobDate')?.value || '';
        const btnToday = document.getElementById('dateBtnToday');
        const btnAll = document.getElementById('dateBtnAll');
        if (!btnToday || !btnAll) return;

        const now = new Date();
        const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const activeCls = 'px-3 py-1.5 rounded-xl text-xs font-bold border border-teal-600 bg-teal-600 text-white shadow-sm transition whitespace-nowrap';
        const idleCls = 'px-3 py-1.5 rounded-xl text-xs font-bold border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 transition whitespace-nowrap';

        btnAll.className = !dateVal ? activeCls : idleCls;
        btnToday.className = (dateVal === todayIso) ? activeCls : idleCls;
    }

    function setTechDateFilterToday() {
        const now = new Date();
        const dateEl = document.getElementById('filterJobDate');
        if (dateEl) dateEl.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        updateDateFilterButtonsUI();
        renderJobCards();
    }

    function clearTechDateFilter() {
        const dateEl = document.getElementById('filterJobDate');
        if (dateEl) dateEl.value = '';
        updateDateFilterButtonsUI();
        renderJobCards();
    }

    function onTechDateInputChanged() {
        updateDateFilterButtonsUI();
        renderJobCards();
    }

    function selectShiftFilter(shiftVal) {
        const shiftSelect = document.getElementById('filterJobShift');
        if (shiftSelect) shiftSelect.value = shiftVal;
        ['all', '1', '2', '3'].forEach(s => {
            const pill = document.getElementById('shiftPill-' + s);
            if (pill) {
                pill.className = s === shiftVal
                    ? 'py-1.5 px-2 rounded-xl text-[11px] font-bold border transition bg-teal-600 text-white border-teal-600 shadow-sm'
                    : 'py-1.5 px-2 rounded-xl text-[11px] font-bold border transition bg-white text-slate-600 border-slate-200 hover:bg-slate-100';
            }
        });
        renderJobCards();
    }

    function switchStatusTab(tabValue) {
        if (typeof window.switchTechMainTab === 'function') window.switchTechMainTab('jobs');
        const selectEl = document.getElementById('filterJobStatus');
        if (selectEl) selectEl.value = tabValue;

        ['all', 'pending', 'traveling', 'done'].forEach(t => {
            const btn = document.getElementById('tabBox-' + t);
            if (!btn) return;
            btn.classList.toggle('border-amber-300', t === tabValue);
            btn.classList.toggle('shadow-md', t === tabValue);
            btn.classList.toggle('ring-2', t === tabValue);
            btn.classList.toggle('ring-amber-300/40', t === tabValue);
            btn.classList.toggle('border-transparent', t !== tabValue);
        });

        const badge = document.getElementById('currentViewBadge');
        if (badge) {
            const mapMeta = {
                pending: ['⏳ กำลังแสดง: งานรอแก้ไข (ยังไม่เดินทาง)', 'text-amber-700 bg-amber-50 border-amber-200'],
                traveling: ['🚗 กำลังแสดง: งานที่กำลังเดินทางไปหน้างาน', 'text-blue-700 bg-blue-50 border-blue-200'],
                done: ['✅ กำลังแสดง: งานแก้ไขเสร็จสิ้นแล้ว', 'text-emerald-700 bg-emerald-50 border-emerald-200'],
                all: ['📋 กำลังแสดง: งานทั้งหมด', 'text-slate-700 bg-slate-100 border-slate-300']
            }[tabValue] || ['📋 กำลังแสดง: งานทั้งหมด', 'text-slate-700 bg-slate-100 border-slate-300'];
            badge.textContent = mapMeta[0];
            badge.className = `text-xs font-bold border px-3 py-1 rounded-full ${mapMeta[1]}`;
        }

        const mapSec = document.getElementById('repairJobsMapSection');
        if (mapSec) mapSec.classList.toggle('hidden', tabValue === 'done');
        renderJobCards();

        if (tabValue !== 'done') {
            setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
                renderRepairJobsMapMarkers(true);
            }, 80);
        }
    }

    function getEffectiveJobShift(item) {
        if (item?.shift !== undefined && item?.shift !== null && String(item.shift).trim() !== '' && String(item.shift).trim() !== '-') {
            return String(item.shift).trim();
        }
        const m = String(item?.time || '').match(/(\d{1,2})[\.:](\d{1,2})/);
        if (m) {
            const totalMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
            if (totalMin >= 30 && totalMin < 510) return '1';
            if (totalMin >= 510 && totalMin < 990) return '2';
            return '3';
        }
        return 'ไม่ระบุ';
    }

    function getJobDateDisplay(item) {
        if (item?.reportDate && item.reportDate !== '-') return String(item.reportDate).trim();
        if (item?.dateTimeSaved) return String(item.dateTimeSaved).split(' ')[0].trim();
        if (item?.timestamp) {
            const d = new Date(item.timestamp);
            if (!isNaN(d.getTime())) {
                return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear() + 543}`;
            }
        }
        return 'ไม่ระบุวันที่';
    }

    function getJobDateNumericValue(item) {
        const parts = getJobDateDisplay(item).split('/');
        if (parts.length === 3) {
            const d = parseInt(parts[0], 10) || 0, m = parseInt(parts[1], 10) || 0;
            let y = parseInt(parts[2], 10) || 0;
            if (y < 2400) y += 543;
            return y * 10000 + m * 100 + d;
        }
        return 0;
    }

    function getJobLoggedTimeDisplay(item, jobType) {
        if (jobType === 'fault') {
            if (item?.time && item.time !== '-') return String(item.time).trim();
            if (item?.timestamp) {
                const d = new Date(item.timestamp);
                if (!isNaN(d.getTime())) return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')} น.`;
            }
            return '-';
        }
        if (item?.dateTimeSaved) {
            const parts = String(item.dateTimeSaved).trim().split(/\s+/);
            if (parts.length > 1) {
                const tp = parts[1].split(/[:\.]/);
                return tp.length >= 2 ? `${tp[0].padStart(2, '0')}.${tp[1].padStart(2, '0')} น.` : parts[1] + ' น.';
            }
        }
        if (item?.createdAtMs) {
            const d = new Date(item.createdAtMs);
            if (!isNaN(d.getTime())) return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')} น.`;
        }
        return '-';
    }

    function getJobSortTimeMs(item) {
        if (item?.techReport?.updatedAt) {
            const t = new Date(item.techReport.updatedAt).getTime();
            if (t > 10000000) return t;
        }
        if (item?.timestamp) {
            const t = new Date(item.timestamp).getTime();
            if (!isNaN(t)) return t;
        }
        if (item?.dateTimeSaved) {
            const parts = String(item.dateTimeSaved).trim().split(/\s+/);
            const dp = (parts[0] || '').split('/');
            if (dp.length === 3) {
                let yr = parseInt(dp[2], 10) || 2569;
                if (yr > 2400) yr -= 543;
                const tp = (parts[1] || '00:00:00').split(/[:\.]/);
                return new Date(yr, (parseInt(dp[1], 10) || 1) - 1, parseInt(dp[0], 10) || 1, parseInt(tp[0], 10) || 0, parseInt(tp[1], 10) || 0, parseInt(tp[2], 10) || 0).getTime();
            }
        }
        return 0;
    }

    function getJobUrgencyInfo(item, jobType) {
        const STYLES = {
            red: { dot: '🔴', label: 'ด่วนมาก', cardBorder: 'border-rose-300 border-l-[6px] border-l-rose-600 ring-1 ring-rose-100', tagClass: 'bg-rose-50 text-rose-700 border-rose-200', titleColor: 'text-rose-950' },
            orange: { dot: '🟠', label: 'ด่วน', cardBorder: 'border-orange-300 border-l-[6px] border-l-orange-500 ring-1 ring-orange-100', tagClass: 'bg-orange-50 text-orange-700 border-orange-200', titleColor: 'text-slate-900' },
            yellow: { dot: '🟡', label: 'ปานกลาง', cardBorder: 'border-amber-300 border-l-[6px] border-l-amber-400 ring-1 ring-amber-100', tagClass: 'bg-amber-50 text-amber-800 border-amber-200', titleColor: 'text-slate-800' },
            green: { dot: '🟢', label: 'ทั่วไป', cardBorder: 'border-emerald-300 border-l-[6px] border-l-emerald-500 ring-1 ring-emerald-100', tagClass: 'bg-emerald-50 text-emerald-700 border-emerald-200', titleColor: 'text-slate-800' },
            blue: { dot: '🔵', label: 'ทั่วไป', cardBorder: 'border-sky-300 border-l-[6px] border-l-sky-500 ring-1 ring-sky-100', tagClass: 'bg-sky-50 text-sky-700 border-sky-200', titleColor: 'text-slate-800' },
            purple: { dot: '🟣', label: 'พิเศษ', cardBorder: 'border-purple-300 border-l-[6px] border-l-purple-500 ring-1 ring-purple-100', tagClass: 'bg-purple-50 text-purple-700 border-purple-200', titleColor: 'text-slate-800' }
        };
        if (jobType === 'fault') return STYLES.red;

        const baseLine = String((item?.formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0] || '');
        const mEmoji = baseLine.match(/([🔴🟠🟡🟢🔵🟣])\s*(?:📋\s*)?(?:งานที่|ใบงาน|แจ้ง)/u) || baseLine.match(/^[^\n]*([🔴🟠🟡🟢🔵🟣])/u);
        if (mEmoji) {
            const mapE = { '🔴': STYLES.red, '🟠': STYLES.orange, '🟡': STYLES.yellow, '🟢': STYLES.green, '🔵': STYLES.blue, '🟣': STYLES.purple };
            if (mapE[mEmoji[1]]) return mapE[mEmoji[1]];
        }

        const pLevel = String(item?.priorityLevel || item?.priority || item?.urgency || '').toLowerCase().trim();
        if (['critical', 'danger', 'red', 'high', 'ด่วนมาก', 'วิกฤต'].includes(pLevel)) return STYLES.red;
        if (['urgent', 'orange', 'ด่วน'].includes(pLevel)) return STYLES.orange;
        if (['warning', 'medium', 'yellow', 'ปานกลาง'].includes(pLevel)) return STYLES.yellow;

        const sym = `${item?.issueType || ''} ${item?.cause || ''}`.toLowerCase();
        if (['ไฟไหม้', 'มิเตอร์ไหม้', 'หม้อแปลงระเบิด', 'หม้อแปลงไหม้', 'ระเบิด', 'สายไฟขาด', 'สายแรงสูงขาด', 'สายเมนขาด', 'เสาไฟล้ม', 'เสาไฟหัก', 'ไฟช็อต', 'ประกายไฟ', 'ไฟดูด', 'ดับบริเวณกว้าง', 'ดับทั้งหมู่บ้าน', 'ดับหลายหลัง', 'โรงพยาบาล', 'ฉุกเฉิน'].some(k => sym.includes(k))) return STYLES.red;
        if (['ไฟดับ', 'ไฟตกไฟดับ', 'กระแสไฟขัดข้อง', 'เฟสขาด', 'ไม่ครบเฟส', 'ฟิวส์ขาด', 'ฟิวส์แรงสูง', 'เบรกเกอร์', 'ทริป', 'ต้นไม้', 'กิ่งไม้', 'สัตว์', 'งู', 'นก', 'กระรอก'].some(k => sym.includes(k))) return STYLES.orange;
        if (['ไฟตก', 'ไฟกระพริบ', 'ไฟเกิน', 'มิเตอร์ชำรุด', 'ขั้วมิเตอร์', 'สายหลวม', 'สายเมนหลวม'].some(k => sym.includes(k))) return STYLES.yellow;
        return STYLES.green;
    }

    function buildRecommendedTechBadgeHtml(item) {
        const rec = findNearestTechForJob(item);
        if (rec?.hasGps && rec.distanceKm) {
            return `
                <div class="p-2 bg-purple-50/90 border border-purple-200 rounded-xl text-[11px] text-purple-950 flex flex-wrap items-center justify-between gap-1">
                    <div class="font-bold text-purple-800 flex items-center gap-1">
                        <span>🎯 แนะนำช่างใกล้สุด: ${escapeHtmlStr(formatTechDisplayName(rec.techName))}</span>
                        ${rec.isMe ? `<span class="bg-amber-400 text-slate-950 text-[9px] font-extrabold px-1.5 py-0.5 rounded-full">⭐ คุณอยู่ใกล้สุด</span>` : ''}
                    </div>
                    <span class="text-[10px] font-semibold text-purple-700 bg-white px-2 py-0.5 rounded-md border border-purple-200">
                        📍 ห่าง ~${rec.distanceKm} กม. (~${rec.durationMin} นาที)
                    </span>
                </div>`;
        }
        return `
            <div class="p-2 bg-slate-100 border border-slate-200 rounded-xl text-[11px] text-slate-600 flex items-center justify-between gap-1">
                <span class="font-semibold text-slate-500">⏳ รอช่างออนไลน์ / เปิดพิกัด GPS</span>
                <span class="text-[10px] text-slate-400">(รอแก้ไข)</span>
            </div>`;
    }
    // ===== จบพาทที่ 2 / 3 ของไฟล์ tech-jobs.js (นำพาทที่ 3 / 3 มาวางต่อจากบรรทัดนี้ได้เลยครับ) =====
    // ===== เริ่มพาทที่ 3 / 3 ของไฟล์ tech-jobs.js (วางต่อจากพาทที่ 2 / 3 จนจบไฟล์) =====

    // ========================================================================
    // 7. ระบบซิงค์สถานะเดินทางไปหมุดอุปกรณ์ไฟฟ้า & แถบลอยแจ้งเตือน (#pea-equip-nav-banner)
    // ========================================================================
    let isStoppingEquipNavInternal = false;
    let lastLocalEquipNavStartMs = 0;

    function injectTechJobsDynamicStylesAndBanner() {
        if (!document.getElementById('peaTechJobsCoreStyles')) {
            const st = document.createElement('style');
            st.id = 'peaTechJobsCoreStyles';
            st.textContent = `
                html, body { overflow-x: hidden; overflow-y: auto !important; height: auto !important; touch-action: pan-y pinch-zoom !important; }
                @media (max-width: 1023px) { #jobCardsContainer, #labeledPlacesCardsContainer { max-height: none !important; overflow-y: visible !important; } #repairJobsLeafletMap { height: 220px !important; } }
                #jobCardsContainer > div.sticky { position: relative !important; top: auto !important; z-index: 1 !important; }
                #inspectModal { z-index: 1200 !important; }
                @keyframes voicePulseWave { 0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(225,29,72,0.55); } 50% { transform: scale(1.04); box-shadow: 0 0 0 10px rgba(225,29,72,0); } }
                .voice-listening-active { animation: voicePulseWave 1.2s infinite ease-in-out; }
                @keyframes repairJobPulseRing { 0% { transform: scale(0.85); opacity: 0.95; } 70%, 100% { transform: scale(1.65); opacity: 0; } }
                .repair-job-lightning-wrapper { position: relative; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; }
                .repair-job-pulse-ring { position: absolute; inset: -4px; border-radius: 9999px; animation: repairJobPulseRing 1.8s infinite ease-out; pointer-events: none; }
                .repair-job-lightning-pin { position: relative; width: 34px; height: 34px; border-radius: 9999px 9999px 9999px 4px; transform: rotate(-45deg); border: 2.5px solid #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 2; }
                .repair-job-lightning-pin span { transform: rotate(45deg); font-size: 17px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.55)); }
                .repair-job-pin-tooltip { background: linear-gradient(135deg,#881337,#be123c) !important; color: #fff !important; border: 1.5px solid #fde047 !important; border-radius: 0.55rem !important; padding: 2px 8px !important; font-family: 'Prompt',sans-serif !important; font-size: 11px !important; font-weight: 700 !important; white-space: nowrap !important; }
                .repair-job-pin-tooltip::before { border-top-color: #be123c !important; }
                .repair-job-pin-tooltip.is-traveling-tooltip { background: linear-gradient(135deg,#1e3a8a,#2563eb) !important; border-color: #93c5fd !important; }
                .repair-job-pin-tooltip.is-traveling-tooltip::before { border-top-color: #2563eb !important; }
                #repairJobsLeafletMap.hide-job-tooltips .repair-job-pin-tooltip { display: none !important; }
                #repairJobsMapFullscreenBox.repair-map-fullscreen { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100dvh !important; max-height: 100dvh !important; z-index: 950 !important; background: #0f172a !important; padding: 0.5rem !important; display: flex !important; flex-direction: column !important; border-radius: 0 !important; border: none !important; }
                #repairJobsMapFullscreenBox.repair-map-fullscreen #repairJobsMapInnerWrap { flex: 1 1 0% !important; min-height: 0 !important; display: flex !important; flex-direction: column !important; }
                #repairJobsMapFullscreenBox.repair-map-fullscreen #repairJobsLeafletMap { flex: 1 1 0% !important; height: 100% !important; min-height: 0 !important; }
                #pea-equip-nav-banner { display: none; position: fixed; bottom: 14px; left: 14px; right: 14px; max-width: 540px; margin: 0 auto; background: linear-gradient(135deg,#0284c7,#1d4ed8); color: #fff; padding: 11px 15px; border-radius: 16px; box-shadow: 0 10px 25px rgba(2,132,199,0.45); z-index: 75; align-items: center; justify-content: space-between; gap: 10px; border: 2px solid rgba(255,255,255,0.3); }
                #pea-equip-nav-cards-mount { width: 100%; grid-column: 1 / -1 !important; }
                body.role-viewer-readonly button[onclick^="openInspectModal"], body.role-viewer-readonly .btn-voice-quick-close, body.role-viewer-readonly #oneTapVoiceModalBox, body.role-viewer-readonly #peaEquipBannerFinishBtn, body.role-viewer-readonly #peaEquipBannerCancelBtn { display: none !important; }
            `;
            document.head.appendChild(st);
        }
        if (!document.getElementById('pea-equip-nav-banner')) {
            const b = document.createElement('div');
            b.id = 'pea-equip-nav-banner';
            b.innerHTML = `
                <div class="flex-1 min-w-0">
                    <div class="text-[13px] font-bold flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-amber-300 animate-ping"></span><span>🚗 กำลังเดินทางไปอุปกรณ์ไฟฟ้า (<span id="peaEquipBannerCount">1</span>)</span></div>
                    <div id="peaEquipBannerTarget" class="text-[11.5px] opacity-95 truncate mt-0.5">เป้าหมาย: -</div>
                </div>
                <div class="flex gap-1.5 items-center shrink-0">
                    <button type="button" onclick="openTravelingDashboardFromEquipBanner()" class="bg-white/20 hover:bg-white/30 text-white border border-white/40 px-2.5 py-1.5 rounded-xl text-[11px] font-bold">📋 ดูสถานะ</button>
                    <button type="button" id="peaEquipBannerFinishBtn" onclick="finishMyEquipmentNavigation(true)" class="bg-emerald-500 hover:bg-emerald-600 text-white px-3 py-1.5 rounded-xl text-[11px] font-extrabold shadow">✅ ถึงที่หมาย</button>
                    <button type="button" id="peaEquipBannerCancelBtn" onclick="finishMyEquipmentNavigation(false)" class="bg-rose-500/90 hover:bg-rose-600 text-white px-2.5 py-1.5 rounded-xl text-[11px] font-bold">✖</button>
                </div>`;
            document.body.appendChild(b);
        }
    }

    function getEquipNavMap() { try { return JSON.parse(localStorage.getItem(EQUIP_NAV_STORAGE_KEY) || '{}') || {}; } catch (e) { return {}; } }
    function saveEquipNavMap(m) { localStorage.setItem(EQUIP_NAV_STORAGE_KEY, JSON.stringify(m || {})); }
    function getCancelledEquipNavMap() { try { return JSON.parse(localStorage.getItem(CANCELLED_EQUIP_NAV_KEY) || '{}') || {}; } catch (e) { return {}; } }
    function normalizeEquipTechKey(name) { const b = getUserBaseId(name); return b ? ('equip_nav_' + b.replace(/\s+/g, '_')) : 'equip_nav_guest'; }
    function getNavEffectiveTimeMs(nav) { return !nav ? 0 : Math.max(Number(nav.departTimestamp || 0), nav.updatedAt ? new Date(nav.updatedAt).getTime() || 0 : 0, Number(nav.cancelledAtMs || 0)); }

    function canUserControlNavigation(navTechName) {
        if (isCurrentUserAdmin()) return true;
        const curUser = (localStorage.getItem('elec_app_current_user') || '').trim();
        return !navTechName || isSameTechPerson(curUser, navTechName);
    }

    function getActiveEquipmentNavItems() {
        const curRole = localStorage.getItem('elec_app_current_role') || 'user';
        const myGroup = getCurrentUserGroup();
        return Object.values(getEquipNavMap()).filter(it => it?.isTraveling && (curRole === 'admin' || !myGroup || !it.ownerGroup || myGroup === it.ownerGroup));
    }

    function syncEquipNavToTechLocations() {
        const locMap = getTechLocationsMap();
        const equipMap = getEquipNavMap();
        const exReg = locMap[Core.REGISTRY_LOC_KEY] || {};
        const mergedEquipCancel = { ...(exReg.equipCancelMap || {}), ...getCancelledEquipNavMap() };

        Object.entries(equipMap).forEach(([key, nav]) => {
            const techName = String(nav?.techName || '').trim();
            if (!techName) return;
            if (!locMap[techName]) locMap[techName] = { username: techName, group: nav.ownerGroup || getCurrentUserGroup() || 'กฟส.บึง', isOnline: true, updatedAt: nav.updatedAt || new Date().toISOString() };
            if (getNavEffectiveTimeMs(nav) >= getNavEffectiveTimeMs(locMap[techName].activeEquipNav)) locMap[techName].activeEquipNav = { ...nav };
            if (nav.isTraveling && getNavEffectiveTimeMs(nav) > Number(mergedEquipCancel[key] || 0)) delete mergedEquipCancel[key];
        });

        locMap[Core.REGISTRY_LOC_KEY] = {
            isSystemRegistry: true, updatedAt: new Date().toISOString(),
            jobCancelMap: { ...(exReg.jobCancelMap || {}), ...JSON.parse(localStorage.getItem(CANCELLED_JOB_NAV_KEY) || '{}') },
            equipCancelMap: mergedEquipCancel
        };
        localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
    }

    function syncEquipNavFromTechLocations() {
        const locMap = getTechLocationsMap();
        const cloudCancel = locMap[Core.REGISTRY_LOC_KEY]?.equipCancelMap || {};
        const localCancel = getCancelledEquipNavMap();
        const equipMap = getEquipNavMap();
        let changed = false;

        Object.entries(cloudCancel).forEach(([k, cMs]) => {
            if (Number(cMs || 0) > Number(localCancel[k] || 0) && Number(cMs || 0) >= getNavEffectiveTimeMs(equipMap[k])) { localCancel[k] = Number(cMs); changed = true; }
        });
        if (changed) localStorage.setItem(CANCELLED_EQUIP_NAV_KEY, JSON.stringify(localCancel));

        Object.entries(locMap).forEach(([tKey, locObj]) => {
            const cNav = (tKey !== Core.REGISTRY_LOC_KEY) ? locObj?.activeEquipNav : null;
            if (!cNav) return;
            const navKey = cNav.id || normalizeEquipTechKey(cNav.techName || tKey);
            const pNav = equipMap[navKey];
            const pTime = getNavEffectiveTimeMs(pNav), cTime = getNavEffectiveTimeMs(cNav);
            if (pNav?.isTraveling && (pTime >= cTime || Date.now() - lastLocalEquipNavStartMs < 10000)) return;

            const maxCancel = Math.max(Number(localCancel[navKey] || 0), Number(cloudCancel[navKey] || 0), Number(cNav.cancelledAtMs || 0));
            if (cTime > pTime) {
                if (maxCancel >= cTime || cNav.isTraveling === false) { if (equipMap[navKey]) { delete equipMap[navKey]; changed = true; } }
                else if (cNav.isTraveling) { equipMap[navKey] = { ...cNav, id: navKey }; changed = true; }
            } else if (pNav && maxCancel >= pTime) { delete equipMap[navKey]; changed = true; }
        });

        if (changed) { saveEquipNavMap(equipMap); lastRenderedCardsSignature = ''; }

        const hasMine = Object.values(equipMap).some(it => it?.isTraveling && canUserControlNavigation(it.techName));
        const mapNavBox = document.getElementById('mapActiveNavContainer');
        if (!hasMine && mapNavBox && !mapNavBox.classList.contains('hidden') && (Date.now() - lastLocalEquipNavStartMs > 10000) && !isStoppingEquipNavInternal) {
            isStoppingEquipNavInternal = true;
            try { if (typeof window.__stopScadaMapRoute === 'function') window.__stopScadaMapRoute(true); } finally { isStoppingEquipNavInternal = false; }
        }
        updateEquipNavFloatingBanner();
    }

    function recordEquipmentNavStart(targetPin, routeInfo) {
        if (isViewerRole() || !targetPin) return;
        lastLocalEquipNavStartMs = Date.now();
        const techName = (localStorage.getItem('elec_app_current_user') || 'ช่างหน้างาน').trim();
        const navKey = normalizeEquipTechKey(techName);
        const now = new Date(), nowMs = now.getTime();
        const depStr = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')} น.`;
        const durMin = Number(routeInfo?.durationMin ?? 5);
        const etaMs = nowMs + durMin * 60000, etaD = new Date(etaMs);
        const etaStr = `${String(etaD.getHours()).padStart(2, '0')}.${String(etaD.getMinutes()).padStart(2, '0')} น.`;

        const cMap = getCancelledEquipNavMap();
        delete cMap[navKey];
        localStorage.setItem(CANCELLED_EQUIP_NAV_KEY, JSON.stringify(cMap));

        const equipMap = getEquipNavMap();
        equipMap[navKey] = {
            id: navKey, placeId: targetPin.id || '', placeTitle: targetPin.name || 'อุปกรณ์ไฟฟ้า',
            placeCategory: 'อุปกรณ์ไฟฟ้า', placeDetails: targetPin.note || '',
            ownerGroup: targetPin.ownerGroup || getCurrentUserGroup() || 'กฟส.บึง',
            techName, destLat: Number(targetPin.lat), destLon: Number(targetPin.lon),
            distanceKm: String(routeInfo?.distanceKm || '2.0'), initialDistanceKm: String(routeInfo?.distanceKm || '2.0'),
            durationMin: durMin, initialDurationMin: durMin, departTime: depStr, departTimestamp: nowMs,
            etaTime: routeInfo?.isArrived ? 'ถึงจุดหมายแล้ว' : etaStr, etaTimestamp: etaMs,
            isArrived: Boolean(routeInfo?.isArrived), updatedAt: now.toISOString(), isTraveling: true, status: 'traveling'
        };
        saveEquipNavMap(equipMap);
        syncEquipNavToTechLocations();
        updateEquipNavFloatingBanner();
        lastRenderedCardsSignature = '';
        renderJobCards();
        Core.unlockCloudWrite(20000);
        pushAllJobsToCloud(true);
    }

    function updateEquipmentNavRouteInfo(routeInfo) {
        if (!routeInfo) return;
        const navKey = normalizeEquipTechKey((localStorage.getItem('elec_app_current_user') || 'ช่างหน้างาน').trim());
        const equipMap = getEquipNavMap();
        if (!equipMap[navKey]?.isTraveling) return;
        Object.assign(equipMap[navKey], {
            distanceKm: String(routeInfo.distanceKm ?? equipMap[navKey].distanceKm),
            durationMin: routeInfo.durationMin ?? equipMap[navKey].durationMin,
            etaTimestamp: routeInfo.etaTimestamp ?? equipMap[navKey].etaTimestamp,
            etaTime: routeInfo.etaTime ?? equipMap[navKey].etaTime,
            isArrived: Boolean(routeInfo.isArrived),
            updatedAt: new Date().toISOString()
        });
        saveEquipNavMap(equipMap);
        syncEquipNavToTechLocations();
        updateEquipNavFloatingBanner();
    }

    function stopEquipmentNavigationByKey(navKey, isArrived = false) {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return false; }
        const equipMap = getEquipNavMap();
        const targetNav = equipMap[navKey];
        const techName = targetNav?.techName || (localStorage.getItem('elec_app_current_user') || 'ช่างหน้างาน').trim();
        if (targetNav && !canUserControlNavigation(targetNav.techName)) {
            showToast('⛔ เฉพาะช่างผู้กำลังเดินทาง หรือ Admin เท่านั้นที่ยกเลิกได้');
            return false;
        }
        const safeMs = Math.max(Date.now(), getNavEffectiveTimeMs(targetNav)) + 1000;
        const safeIso = new Date(safeMs).toISOString();
        const cancelMap = getCancelledEquipNavMap();
        cancelMap[navKey] = safeMs;
        localStorage.setItem(CANCELLED_EQUIP_NAV_KEY, JSON.stringify(cancelMap));

        delete equipMap[navKey];
        saveEquipNavMap(equipMap);

        const locMap = getTechLocationsMap();
        if (locMap[techName]?.activeEquipNav) {
            locMap[techName].activeEquipNav = { id: navKey, techName, isTraveling: false, status: isArrived ? 'arrived' : 'cancelled', cancelledAtMs: safeMs, updatedAt: safeIso };
            locMap[techName].updatedAt = safeIso;
            localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
        }
        syncEquipNavToTechLocations();

        if (canUserControlNavigation(techName) && !isStoppingEquipNavInternal) {
            isStoppingEquipNavInternal = true;
            try { if (typeof window.__stopScadaMapRoute === 'function') window.__stopScadaMapRoute(true); } finally { isStoppingEquipNavInternal = false; }
        }
        updateEquipNavFloatingBanner();
        lastRenderedCardsSignature = '';
        renderJobCards();
        showToast(isArrived ? '✅ บันทึกสถานะถึงจุดติดตั้งอุปกรณ์ไฟฟ้าแล้ว' : '↩️ ยกเลิกการเดินทางไปอุปกรณ์ไฟฟ้าแล้ว');
        Core.unlockCloudWrite(20000);
        pushAllJobsToCloud(true);
        return true;
    }

    function finishMyEquipmentNavigation(isArrived = false) {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        const myKey = normalizeEquipTechKey((localStorage.getItem('elec_app_current_user') || 'ช่างหน้างาน').trim());
        const equipMap = getEquipNavMap();
        const targetKey = equipMap[myKey] ? myKey : (Object.keys(equipMap).find(k => canUserControlNavigation(equipMap[k]?.techName)) || Object.keys(equipMap)[0]);
        if (targetKey) stopEquipmentNavigationByKey(targetKey, Boolean(isArrived));
    }

    function openTravelingDashboardFromEquipBanner() {
        if (typeof window.switchTechMainTab === 'function') window.switchTechMainTab('jobs');
        switchStatusTab('traveling');
        setTimeout(() => document.getElementById('pea-equip-nav-cards-mount')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    }

    function updateEquipNavFloatingBanner() {
        const banner = document.getElementById('pea-equip-nav-banner');
        if (!banner) return;
        const activeList = getActiveEquipmentNavItems();
        if (activeList.length === 0) { banner.style.display = 'none'; return; }

        const myNav = activeList.find(it => canUserControlNavigation(it.techName)) || activeList[0];
        const countEl = document.getElementById('peaEquipBannerCount');
        const targetEl = document.getElementById('peaEquipBannerTarget');
        if (countEl) countEl.textContent = String(activeList.length);
        if (targetEl && myNav) {
            const dist = myNav.distanceKm ? ` (${Number(myNav.distanceKm).toFixed(1)} กม.)` : '';
            const eta = myNav.durationMin ? ` ~${Math.ceil(Number(myNav.durationMin))} นาที` : '';
            targetEl.textContent = `${myNav.placeTitle || 'อุปกรณ์ไฟฟ้า'}${dist}${eta} ➔ ${formatTechDisplayName(myNav.techName || '')}`;
        }
        const canCtrl = !isViewerRole() && (myNav ? canUserControlNavigation(myNav.techName) : true);
        const fBtn = document.getElementById('peaEquipBannerFinishBtn'), cBtn = document.getElementById('peaEquipBannerCancelBtn');
        if (fBtn) fBtn.style.display = canCtrl ? 'inline-block' : 'none';
        if (cBtn) cBtn.style.display = canCtrl ? 'inline-block' : 'none';
        banner.style.display = 'flex';
    }

    function renderEquipmentNavCardsHtml(items) {
        if (!items?.length) return '';
        return items.map(nav => {
            const canCtrl = !isViewerRole() && canUserControlNavigation(nav.techName);
            const safeKey = String(nav.id || normalizeEquipTechKey(nav.techName)).replace(/'/g, "\\'");
            const grp = escapeHtmlStr(nav.ownerGroup || getCurrentUserGroup() || 'กฟส.บึง');
            const details = nav.placeDetails ? ` | 📝 รายละเอียด: ${escapeHtmlStr(nav.placeDetails)}` : '';
            return `
            <div class="p-3.5 rounded-2xl border bg-white shadow-sm space-y-2 border-sky-300 border-l-[6px] border-l-sky-500 ring-1 ring-sky-100 mb-3">
                <div class="flex justify-between items-start gap-2">
                    <div class="min-w-0 flex-1">
                        <div class="mb-1 flex flex-wrap items-center gap-1">
                            <span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-2 py-0.5 rounded-md">🏢 ${grp}</span>
                            <span class="bg-sky-50 text-sky-700 border border-sky-200 text-[10px] font-bold px-2 py-0.5 rounded-md">⚡ แผนที่อุปกรณ์</span>
                        </div>
                        <div class="text-sky-900 text-sm font-extrabold">⚡ อุปกรณ์ไฟฟ้า: ${escapeHtmlStr(nav.placeTitle || 'หมุดอุปกรณ์')}</div>
                    </div>
                    <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 bg-blue-100 text-blue-700 border-blue-300 animate-pulse">🚗 กำลังเดินทาง</span>
                </div>
                <div class="text-xs text-slate-600">📍 หมวดหมู่: อุปกรณ์ไฟฟ้า${details}</div>
                <div class="equip-realtime-nav-box p-2.5 bg-blue-50/90 border border-blue-200 rounded-xl text-[11px] text-blue-950 space-y-1" data-equip-key="${safeKey}">${formatRealtimeNavHtml(nav)}</div>
                <div class="flex flex-wrap items-center justify-between gap-1.5 pt-1 border-t border-slate-100">
                    <div class="flex flex-wrap gap-1.5">
                        ${(nav.destLat && nav.destLon) ? `<button type="button" onclick="window.open('https://www.google.com/maps/dir/?api=1&destination=${nav.destLat},${nav.destLon}&travelmode=driving','_blank')" class="bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-200 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold">🗺️ นำทาง Maps</button>` : ''}
                        ${canCtrl ? `<button type="button" onclick="stopEquipmentNavigationByKey('${safeKey}', false)" class="bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 px-2.5 py-1.5 rounded-lg text-[11px] font-bold">❌ ยกเลิกเดินทาง</button>` : ''}
                    </div>
                    ${canCtrl ? `<button type="button" onclick="stopEquipmentNavigationByKey('${safeKey}', true)" class="bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 rounded-xl text-[11px] font-bold shadow-sm">✅ ถึงหน้างาน</button>` : ''}
                </div>
            </div>`;
        }).join('');
    }

    // ========================================================================
    // 8. เรนเดอร์การ์ดใบงานซ่อม (Anti-Flicker + ล็อกตำแหน่ง Scroll + ปุ่มเสียง & แผนที่)
    // ========================================================================
    function computeJobCardsRenderSignature(rawList, equipNavItems) {
        const jobType = document.getElementById('filterJobType')?.value || 'outage';
        const fStat = document.getElementById('filterJobStatus')?.value || 'pending';
        const fShift = document.getElementById('filterJobShift')?.value || 'all';
        const fDate = document.getElementById('filterJobDate')?.value || '';
        const sOrd = document.getElementById('sortJobOrder')?.value || 'shift_job_asc';
        const kw = (document.getElementById('searchJobKeyword')?.value || '').trim().toLowerCase();
        const role = localStorage.getItem('elec_app_current_role') || '';
        const grp = localStorage.getItem('elec_app_current_group') || '';
        const eqSig = equipNavItems.map(n => `${n.id}:${n.placeTitle}:${n.isTraveling}`).join('|');
        const jSig = rawList.map(it => {
            const k = jobType === 'outage' ? it.dateTimeSaved : it.timestamp;
            const tr = it.techReport || {};
            const rec = (!tr.status && !it.techNav) ? findNearestTechForJob(it) : null;
            return `${k}~${it.jobNo}~${it.shift}~${it.issueType}~${it.gps}~${tr.status || ''}~${tr.finishTime || ''}~${it.techNav ? it.techNav.techName + ':' + Boolean(it.techNav.isArrived) : ''}~${rec ? rec.techName + ':' + rec.distanceKm : ''}`;
        }).join('|');
        return `${jobType}#${fStat}#${fShift}#${fDate}#${sOrd}#${kw}#${role}#${grp}##${eqSig}##${jSig}`;
    }

    function renderJobCards() {
        Core.cleanReopenedAndCancelledJobsInStorage();
        normalizeJobGpsAndReportText('elecReportsComplete_all', false);
        normalizeJobGpsAndReportText('fault_reports_all', true);

        const container = document.getElementById('jobCardsContainer');
        if (!container) return;

        const jobType = document.getElementById('filterJobType')?.value || 'outage';
        const statusFilter = document.getElementById('filterJobStatus')?.value || 'pending';
        const shiftFilter = document.getElementById('filterJobShift')?.value || 'all';
        const selectedDateIso = document.getElementById('filterJobDate')?.value || '';
        const sortOrder = document.getElementById('sortJobOrder')?.value || 'shift_job_asc';
        const keyword = (document.getElementById('searchJobKeyword')?.value || '').toLowerCase().trim();
        const isViewer = isViewerRole();

        let targetThaiDateStr = '';
        if (selectedDateIso) {
            const [y, m, d] = selectedDateIso.split('-');
            targetThaiDateStr = `${d}/${m}/${parseInt(y, 10) + 543}`;
        }

        const allRawList = JSON.parse(localStorage.getItem(jobType === 'outage' ? 'elecReportsComplete_all' : 'fault_reports_all') || '[]');
        const rawList = allRawList.filter(it => canCurrentUserSeeJob(it) && (!targetThaiDateStr || getJobDateDisplay(it) === targetThaiDateStr));
        const equipNavItems = getActiveEquipmentNavItems();

        const newSig = computeJobCardsRenderSignature(rawList, equipNavItems);
        if (container.children.length > 0 && newSig === lastRenderedCardsSignature) {
            updateLiveNavDomElements();
            renderRepairJobsMapMarkers(false);
            return;
        }
        lastRenderedCardsSignature = newSig;

        let pendingCount = 0, jobTravelingCount = 0, doneCount = 0;
        rawList.forEach(it => {
            const isDone = it.techReport && String(it.techReport.status || '').includes('เสร็จสิ้น');
            if (isDone) doneCount++;
            else if (it.techNav) jobTravelingCount++;
            else pendingCount++;
        });
        const totalTravelingCount = jobTravelingCount + equipNavItems.length;

        document.getElementById('countAllJobs').textContent = String(rawList.length);
        document.getElementById('countPendingJobs').textContent = String(pendingCount);
        document.getElementById('countTravelingJobs').textContent = String(totalTravelingCount);
        document.getElementById('countDoneJobs').textContent = String(doneCount);

        const statusFiltered = rawList.filter(it => {
            const isDone = it.techReport && String(it.techReport.status || '').includes('เสร็จสิ้น');
            const isTrav = !isDone && Boolean(it.techNav);
            if (statusFilter === 'pending' && (isDone || isTrav)) return false;
            if (statusFilter === 'traveling' && !isTrav) return false;
            if (statusFilter === 'done' && !isDone) return false;
            return !keyword || JSON.stringify(it).toLowerCase().includes(keyword);
        });

        let cS1 = 0, cS2 = 0, cS3 = 0;
        statusFiltered.forEach(it => {
            const sh = getEffectiveJobShift(it);
            if (sh === '1') cS1++; else if (sh === '2') cS2++; else if (sh === '3') cS3++;
        });
        const extraEq = (statusFilter === 'traveling' || statusFilter === 'all') ? equipNavItems.length : 0;
        if (document.getElementById('countShiftAll')) document.getElementById('countShiftAll').textContent = String(statusFiltered.length + extraEq);
        if (document.getElementById('countShift1')) document.getElementById('countShift1').textContent = String(cS1);
        if (document.getElementById('countShift2')) document.getElementById('countShift2').textContent = String(cS2);
        if (document.getElementById('countShift3')) document.getElementById('countShift3').textContent = String(cS3);

        const filtered = statusFiltered.filter(it => shiftFilter === 'all' || getEffectiveJobShift(it) === shiftFilter);
        filtered.sort((a, b) => {
            const jA = parseInt(a.jobNo, 10) || 0, jB = parseInt(b.jobNo, 10) || 0;
            const sA = parseInt(getEffectiveJobShift(a), 10) || 99, sB = parseInt(getEffectiveJobShift(b), 10) || 99;
            const dA = getJobDateNumericValue(a), dB = getJobDateNumericValue(b);
            const tA = getJobSortTimeMs(a), tB = getJobSortTimeMs(b);
            if (sortOrder === 'shift_job_asc') return (dB - dA) || (sA - sB) || (jA - jB) || (tA - tB);
            if (sortOrder === 'shift_job_desc') return (dB - dA) || (sB - sA) || (jB - jA) || (tB - tA);
            if (sortOrder === 'job_asc') return (jA - jB) || (dB - dA);
            if (sortOrder === 'job_desc') return (jB - jA) || (dB - dA);
            if (sortOrder === 'time_asc') return (dA - dB) || (tA - tB) || (jA - jB);
            return (dB - dA) || (tB - tA) || (jB - jA);
        });

        const savedScrollY = window.scrollY;
        const prevH = container.offsetHeight;
        if (prevH > 100) container.style.minHeight = prevH + 'px';

        container.innerHTML = '';

        if (equipNavItems.length > 0 && (statusFilter === 'traveling' || statusFilter === 'all')) {
            const mountEl = document.createElement('div');
            mountEl.id = 'pea-equip-nav-cards-mount';
            mountEl.innerHTML = renderEquipmentNavCardsHtml(equipNavItems);
            container.appendChild(mountEl);
        }

        if (statusFilter === 'pending' && totalTravelingCount > 0) {
            const banner = document.createElement('button');
            banner.type = 'button';
            banner.onclick = () => switchStatusTab('traveling');
            banner.className = 'w-full p-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-2xl shadow-md flex items-center justify-between text-xs font-bold transition';
            banner.innerHTML = `<span>🚗 ขณะนี้มีช่างกำลังเดินทางไปหน้างาน ${totalTravelingCount} งาน</span><span class="bg-white/20 px-2.5 py-1 rounded-xl text-[11px]">กดดูเวลาเดินทาง ➔</span>`;
            container.appendChild(banner);
        }

        if (filtered.length === 0 && !(equipNavItems.length > 0 && (statusFilter === 'traveling' || statusFilter === 'all'))) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'text-center text-slate-400 text-xs py-10 px-4';
            emptyDiv.textContent = targetThaiDateStr
                ? `ไม่มีรายการใบงานในวันที่ ${targetThaiDateStr} (กดปุ่ม "📅 ทุกวัน" เพื่อดูทั้งหมด)`
                : (shiftFilter !== 'all' ? `ไม่มีรายการใบงานใน "กะ ${shiftFilter}"` : (statusFilter === 'pending' ? '🎉 ไม่มีงานค้างในฝั่งรอแก้ไข' : 'ไม่พบรายการใบงานในหมวดนี้'));
            container.appendChild(emptyDiv);
        } else {
            const shiftGroupCounts = {};
            filtered.forEach(it => { const gk = `${getJobDateDisplay(it)}__${getEffectiveJobShift(it)}`; shiftGroupCounts[gk] = (shiftGroupCounts[gk] || 0) + 1; });
            const showHeaders = sortOrder.startsWith('shift_') || statusFilter === 'done' || shiftFilter !== 'all';
            let lastGroupKey = null;

            filtered.forEach(item => {
                const dStr = getJobDateDisplay(item), shStr = getEffectiveJobShift(item), gKey = `${dStr}__${shStr}`;
                if (showHeaders && gKey !== lastGroupKey) {
                    lastGroupKey = gKey;
                    const sTime = shStr === '1' ? '00.30 - 08.30 น.' : (shStr === '2' ? '08.30 - 16.30 น.' : (shStr === '3' ? '16.30 - 00.30 น.' : ''));
                    const sEmo = shStr === '1' ? '🌅' : (shStr === '2' ? '☀️' : (shStr === '3' ? '🌙' : '🕒'));
                    const hdr = document.createElement('div');
                    hdr.className = 'sticky top-0 z-10 flex items-center justify-between bg-gradient-to-r from-slate-800 to-teal-900 text-white px-3.5 py-2 rounded-xl shadow-sm text-xs font-bold mt-2';
                    hdr.innerHTML = `<div class="flex items-center gap-1.5"><span>📅 ${escapeHtmlStr(dStr)}</span><span class="text-teal-300">•</span><span class="text-amber-300">${sEmo} กะ ${escapeHtmlStr(shStr)} ${sTime ? `<span class="text-[10px] font-normal text-slate-300">(${sTime})</span>` : ''}</span></div><span class="bg-white/20 text-white text-[10px] px-2 py-0.5 rounded-full">${shiftGroupCounts[gKey]} งาน</span>`;
                    container.appendChild(hdr);
                }

                const key = jobType === 'outage' ? item.dateTimeSaved : item.timestamp;
                const safeKey = String(key).replace(/'/g, "\\'");
                const tr = item.techReport, nav = item.techNav;
                const isDone = Boolean(tr && String(tr.status || '').includes('เสร็จสิ้น'));
                const jobGroup = getJobGroupName(item);
                const loggedTimeStr = getJobLoggedTimeDisplay(item, jobType);
                const urgency = getJobUrgencyInfo(item, jobType);
                const badgeClass = isDone ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : (tr ? 'bg-amber-100 text-amber-700 border-amber-300' : (nav ? 'bg-blue-100 text-blue-700 border-blue-300 animate-pulse' : 'bg-rose-100 text-rose-700 border-rose-300'));
                const badgeLabel = tr ? tr.status : (nav ? (nav.isArrived ? '📍 ถึงหน้างานแล้ว' : '🚗 กำลังเดินทาง') : '⏳ รอแก้ไข');
                const gpsLink = (item.gps && String(item.gps).startsWith('http')) ? String(item.gps) : '';
                const safeGps = gpsLink.replace(/'/g, "\\'");
                const phoneNum = (item.phone && item.phone !== '-') ? item.phone : '';

                const metaBadges = `${jobGroup ? `<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-2 py-0.5 rounded-md mr-1">🏢 ${escapeHtmlStr(jobGroup)}</span>` : ''}<span class="bg-teal-50 text-teal-800 border border-teal-200 text-[10px] font-bold px-2 py-0.5 rounded-md mr-1">🕒 กะ ${escapeHtmlStr(shStr)}</span>${loggedTimeStr !== '-' ? `<span class="bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-bold px-2 py-0.5 rounded-md mr-1">⏰ ${escapeHtmlStr(loggedTimeStr)}</span>` : ''}<span class="border text-[10px] font-bold px-2 py-0.5 rounded-md mr-1 ${urgency.tagClass}">${urgency.dot} ${urgency.label}</span>`;
                const mainTitle = jobType === 'outage' ? `งานที่ ${escapeHtmlStr(item.jobNo || '-')} • ${escapeHtmlStr(item.issueType || '-')}` : `⚡ ${escapeHtmlStr(item.circuit || '-')} สถานี${escapeHtmlStr(item.station || '-')} (${escapeHtmlStr(item.system || '-')})`;
                const subHtml = jobType === 'outage' ? `📍 บริเวณ: ${escapeHtmlStr(item.area || '-')} | 🏠 ที่อยู่: ${escapeHtmlStr(item.address || '-')}` : `🚨 เหตุ: ${escapeHtmlStr(item.cause || '-')} (${escapeHtmlStr(item.phase || '-')}) | 📞 แจ้งจาก: ${escapeHtmlStr(item.reporter || '-')}`;

                const travelBtn = gpsLink
                    ? `<button type="button" onclick="handleStartNavigation('${safeKey}', '${jobType}', '${safeGps}')" class="bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-200 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold">🗺️ ${nav ? 'นำทางซ้ำ' : 'นำทาง Maps'}</button>`
                    : ((!isDone && !isViewer) ? `<button type="button" onclick="handleStartNavigation('${safeKey}', '${jobType}', '')" class="bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 px-2.5 py-1.5 rounded-lg text-[11px] font-bold">🚗 ${nav ? 'อัปเดตเดินทาง' : 'กดออกเดินทาง'}</button>` : '');

                const card = document.createElement('div');
                card.className = `p-3.5 rounded-2xl border bg-white shadow-sm space-y-2 ${urgency.cardBorder}`;
                card.innerHTML = `
                    <div class="flex justify-between items-start gap-2">
                        <div class="min-w-0 flex-1">
                            <div class="mb-1 flex flex-wrap items-center gap-y-1">${metaBadges}</div>
                            <div class="${urgency.titleColor} text-sm font-extrabold flex items-center gap-1"><span>${urgency.dot}</span><span>${mainTitle}</span></div>
                        </div>
                        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${badgeClass}">${escapeHtmlStr(badgeLabel)}</span>
                    </div>
                    <div class="text-xs text-slate-600">${subHtml}</div>
                    ${(!isDone && !nav) ? `<div class="px-2.5 py-1.5 bg-amber-50/90 border border-amber-200 rounded-xl text-[11px] text-amber-900 flex flex-wrap items-center justify-between gap-1"><span class="font-bold text-amber-800">⏰ เวลาลงข้อมูล: ${escapeHtmlStr(loggedTimeStr)} (${escapeHtmlStr(dStr)})</span>${(jobType === 'outage' && item.workerName && item.workerName !== '-') ? `<span class="text-[10px] font-semibold text-slate-600 bg-white px-2 py-0.5 rounded border border-amber-200">👷 ผู้แจ้ง: ${escapeHtmlStr(formatTechDisplayName(item.workerName))}</span>` : ''}</div>${buildRecommendedTechBadgeHtml(item)}` : ''}
                    ${(nav && !isDone) ? `<div class="realtime-nav-box p-2.5 bg-blue-50/90 border border-blue-200 rounded-xl text-[11px] text-blue-950 space-y-1" data-job-key="${escapeHtmlStr(key)}" data-job-type="${jobType}">${formatRealtimeNavHtml(nav)}</div>` : ''}
                    ${tr ? `<div class="p-2.5 bg-emerald-50/80 border border-emerald-200 rounded-xl text-[11px] text-emerald-950 space-y-0.5"><div><strong>🔍 สาเหตุจริง:</strong> ${escapeHtmlStr(tr.realCause || '-')}</div><div><strong>🛠️ การแก้ไข:</strong> ${escapeHtmlStr(tr.actionTaken || '-')}</div><div class="text-[10px] text-emerald-700 pt-0.5">📅 ${escapeHtmlStr(dStr)} | ⏰ ลงข้อมูล: ${escapeHtmlStr(loggedTimeStr)} | ✅ เสร็จ: ${escapeHtmlStr(tr.finishTime || '-')} | 👷 ช่าง: ${escapeHtmlStr(formatTechDisplayName(tr.inspector || '-'))}</div></div>` : ''}
                    <div class="flex flex-wrap items-center justify-between gap-1.5 pt-1 border-t border-slate-100">
                        <div class="flex flex-wrap gap-1.5 mr-auto">
                            ${phoneNum ? `<a href="tel:${escapeHtmlStr(phoneNum)}" class="bg-slate-100 hover:bg-slate-200 text-slate-700 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold">📞 โทร ${escapeHtmlStr(phoneNum)}</a>` : ''}
                            ${travelBtn}
                            ${(nav && !isDone && !isViewer) ? `<button type="button" onclick="handleCancelNavigation('${safeKey}', '${jobType}')" class="bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 px-2.5 py-1.5 rounded-lg text-[11px] font-bold">❌ ยกเลิกเดินทาง</button>` : ''}
                            ${!isDone ? `<button type="button" onclick="focusSingleRepairJobOnMap('${safeKey}')" class="btn-focus-repair-map bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 px-2.5 py-1.5 rounded-lg text-[11px] font-bold">⚡ ดูจุดบนแมพ</button>` : ''}
                        </div>
                        ${(!isDone && !isViewer) ? `<button type="button" onclick="quickVoiceCloseFromCard('${safeKey}', '${jobType}')" class="btn-voice-quick-close bg-rose-600 hover:bg-rose-700 text-white px-2.5 py-1.5 rounded-xl text-xs font-extrabold shadow-sm flex items-center gap-1 shrink-0">🎙️ พูดปิดงาน</button>` : ''}
                        ${!isViewer ? `<button type="button" onclick="openInspectModal('${safeKey}', '${jobType}')" class="bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 rounded-xl text-xs font-bold shadow-sm shrink-0">${tr ? '✏️ แก้ไขผลหน้างาน' : '🛠️ แจ้งผลตรวจสอบ'}</button>` : ''}
                    </div>`;
                container.appendChild(card);
            });
        }

        renderRepairJobsMapMarkers(false);
        requestAnimationFrame(() => {
            container.style.minHeight = '';
            if (savedScrollY > 0 && Math.abs(window.scrollY - savedScrollY) > 40) window.scrollTo(0, savedScrollY);
        });
    }

    // ========================================================================
    // 9. ฟอร์มบันทึกผลตรวจสอบหน้างาน & ระบบสั่งปิดงานด้วยเสียงพูดประโยคเดียว (One-Tap Voice)
    // ========================================================================
    let activeVoiceRecognition = null;
    let autoSubmitVoiceTimer = null;

    function stopActiveVoiceSession() {
        if (autoSubmitVoiceTimer) { clearTimeout(autoSubmitVoiceTimer); autoSubmitVoiceTimer = null; }
        if (activeVoiceRecognition) { try { activeVoiceRecognition.abort(); } catch (e) {} activeVoiceRecognition = null; }
    }

    function parseVoiceCloseSentence(rawTranscript) {
        let s = String(rawTranscript || '').trim();
        [['หนึ่งร้อย','100'],['สองร้อย','200'],['ห้าสิบ','50'],['สี่สิบ','40'],['สามสิบ','30'],['ยี่สิบห้า','25'],['ยี่สิบ','20'],['สิบห้า','15'],['สิบสอง','12'],['สิบ','10'],['แปด','8'],['หก','6'],['ห้า','5'],['สี่','4'],['สาม','3'],['สอง','2'],['หนึ่ง','1']]
            .forEach(([w, n]) => { s = s.replace(new RegExp(w + '\\s*(?=แอม|เค|เส้น|เฟส|ลูก|ต้น)', 'g'), n + ' '); });
        s = s.replace(/(\d+)\s*(?:แอมป์|แอมแปร์|แอม|amps?|a(?![a-zA-Z]))/gi, '$1A').replace(/(\d+)\s*(?:เค(?![ก-๙])|k(?![a-zA-Z]))/gi, '$1K').replace(/(\d+)\s*(?:เควีเอ|เคพีเอ|kva)/gi, '$1 kVA').replace(/ดร๊อป|ดร็อป/g, 'ดรอป').replace(/เบรคเกอร์/g, 'เบรกเกอร์').replace(/คัทเอาท์|คัตเอาท์/g, 'คัตเอาต์').replace(/ช๊อต/g, 'ช็อต').replace(/\s+/g, ' ').trim();
        if (!s) return { status: 'แก้ไขเสร็จสิ้น (จ่ายไฟคืนแล้ว)', realCause: 'ตรวจสอบแล้วกระแสไฟปกติ', actionTaken: 'ดำเนินการตรวจสอบและจ่ายไฟคืนปกติ' };

        const status = /(รอพัสดุ|ส่งต่อแผนก|ส่งต่อ|ตั้งเสาใหม่|รอหม้อแปลง)/.test(s) ? 'ส่งต่อแผนกอื่น / รอพัสดุ' : (/(กำลังดำเนินการ|กำลังทำ|ยังไม่เสร็จ|อยู่ระหว่าง)/.test(s) ? 'กำลังดำเนินการ' : 'แก้ไขเสร็จสิ้น (จ่ายไฟคืนแล้ว)');
        const splitM = s.match(/\s*(?=(?:ดำเนินการ|ทำการ|แก้ไขโดย|แก้ไข|เปลี่ยน|ใส่ฟิวส์|ใส่ดรอป|สับดรอป|ยกดรอป|ต่อสาย|พันเทป|กวดขั้ว|ขันขั้ว|ตัดกิ่งไม้|ตัดต้นไม้|รอนกิ่งไม้|นำสัตว์ออก|เอาสัตว์ออก|เขี่ยออก|ยกเบรกเกอร์|ออนเบรกเกอร์|สับคัตเอาต์|ทดลองจ่ายไฟ|จ่ายไฟคืน|จ่ายไฟแล้ว|จ่ายไฟปกติ))/i);
        const causePart = (splitM && splitM.index > 0) ? s.substring(0, splitM.index).trim() : s;
        const actionPart = (splitM && splitM.index > 0) ? s.substring(splitM.index).trim() : '';
        const rating = (s.match(/(\d+\s*(?:A|K|kVA))(?![a-zA-Z])/i)?.[1] || '').replace(/\s+/g, '');

        let cleanCause = causePart.replace(/(\d+\s*(?:A|K))(?![a-zA-Z])/gi, '').replace(/\s+/g, ' ').trim() || causePart;
        if (rating && /ฟิวส์|ดรอป/.test(cleanCause) && !cleanCause.includes(rating)) cleanCause += ` (ขนาด ${rating})`;

        let finalAction = actionPart;
        if (!finalAction || /^(?:เปลี่ยนเสร็จ|แก้ไขเสร็จ|ทำเสร็จ|เสร็จแล้ว|เรียบร้อย)?\s*(?:จ่ายไฟคืนแล้ว|จ่ายไฟแล้ว|จ่ายไฟปกติ|จ่ายไฟเรียบร้อย)?$/.test(finalAction)) {
            if (/ฟิวส์แรงต่ำ/.test(cleanCause)) finalAction = `เปลี่ยนฟิวส์แรงต่ำ${rating ? ' ' + rating : ''} เสร็จสิ้น จ่ายไฟคืนปกติ`;
            else if (/ฟิวส์แรงสูง|ดรอป/.test(cleanCause)) finalAction = `เปลี่ยนฟิวส์แรงสูง (Drop Out Fuse)${rating ? ' ' + rating : ''} จ่ายไฟคืนปกติ`;
            else if (/กิ่งไม้|ต้นไม้/.test(cleanCause)) finalAction = 'ตัดรอนกิ่งไม้พ้นแนวสายไฟ จ่ายไฟคืนปกติ';
            else if (/สัตว์|งู|นก|กระรอก/.test(cleanCause)) finalAction = 'นำสัตว์ออกจากระบบจำหน่ายและตรวจสอบอุปกรณ์ จ่ายไฟคืนปกติ';
            else if (/หลวม|ช็อต/.test(cleanCause)) finalAction = 'กวดขั้วต่อสายและพันเทปฉนวนใหม่ จ่ายไฟคืนปกติ';
            else if (/เบรกเกอร์|คัตเอาต์/.test(cleanCause)) finalAction = 'ตรวจสอบและยกเบรกเกอร์จ่ายไฟคืนปกติ';
            else finalAction = `ดำเนินการแก้ไขเรียบร้อย${rating ? ' (' + rating + ')' : ''} จ่ายไฟคืนปกติ`;
        } else {
            if (rating && /เปลี่ยน/.test(finalAction) && !finalAction.includes(rating)) finalAction = finalAction.replace(/เปลี่ยน(?:ฟิวส์)?/, `เปลี่ยนฟิวส์ ${rating} `);
            if (status.includes('เสร็จสิ้น') && !/จ่ายไฟ/.test(finalAction)) finalAction += ' จ่ายไฟคืนปกติ';
        }
        return { status, realCause: cleanCause.trim(), actionTaken: finalAction.replace(/\s+/g, ' ').trim() };
    }

    function ensureVoiceControlBoxInModal() {
        const summaryEl = document.getElementById('modalJobSummary');
        if (!summaryEl || document.getElementById('oneTapVoiceModalBox')) return;
        const box = document.createElement('div');
        box.id = 'oneTapVoiceModalBox';
        box.className = 'p-3 bg-gradient-to-r from-rose-50 via-amber-50 to-teal-50 border-2 border-teal-400 rounded-2xl space-y-2 shadow-sm';
        box.innerHTML = `
            <div class="font-extrabold text-teal-950 text-xs flex items-center gap-1.5"><span>🎙️ พูดประโยคเดียว (แยกสาเหตุ + แก้ไข + ปิดงานอัตโนมัติ)</span></div>
            <div class="text-[11px] text-slate-600">ตัวอย่าง: <b class="text-teal-800">"ฟิวส์แรงต่ำขาด 30 แอมป์ เปลี่ยนเสร็จจ่ายไฟแล้ว"</b></div>
            <div class="grid grid-cols-2 gap-2 pt-0.5">
                <button type="button" id="btnVoiceCloseCopy" onclick="triggerOneTapVoiceInModal(false)" class="bg-teal-600 hover:bg-teal-700 text-white font-extrabold py-2 px-2.5 rounded-xl text-xs shadow">🎙️ พูดปิดงาน & คัดลอก</button>
                <button type="button" id="btnVoiceCloseLine" onclick="triggerOneTapVoiceInModal(true)" class="bg-[#00B900] hover:bg-[#009900] text-white font-extrabold py-2 px-2.5 rounded-xl text-xs shadow">🎙️ พูดปิดงาน & ส่ง LINE</button>
            </div>
            <div id="voiceAutoCloseStatusBanner" class="hidden p-2.5 bg-white border border-teal-300 rounded-xl space-y-1.5">
                <div id="voiceRecognizedPreviewText" class="text-xs font-bold text-slate-800 break-words"></div>
                <div class="flex items-center justify-between gap-2 pt-1">
                    <span id="voiceCountdownLabel" class="text-[11px] font-extrabold text-emerald-700 animate-pulse">⏳ กำลังบันทึกอัตโนมัติ...</span>
                    <div class="flex gap-1.5">
                        <button type="button" onclick="cancelVoiceAutoSubmit()" class="bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 px-2.5 py-1 rounded-lg text-[11px] font-bold">✋ แก้ไขเอง</button>
                        <button type="button" id="btnVoiceConfirmNow" class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1 rounded-lg text-[11px] font-bold shadow-sm">✅ ปิดทันที</button>
                    </div>
                </div>
            </div>`;
        summaryEl.insertAdjacentElement('afterend', box);
    }

    function cancelVoiceAutoSubmit() {
        if (autoSubmitVoiceTimer) { clearTimeout(autoSubmitVoiceTimer); autoSubmitVoiceTimer = null; }
        const lbl = document.getElementById('voiceCountdownLabel');
        if (lbl) { lbl.textContent = '✏️ หยุดส่งอัตโนมัติแล้ว (แก้ไขข้อความด้านล่างได้เลย)'; lbl.className = 'text-[11px] font-bold text-amber-700'; }
        showToast('✋ หยุดการส่งอัตโนมัติแล้ว');
    }

    function triggerOneTapVoiceInModal(sendLine = false) {
        if (isViewerRole()) return;
        ensureVoiceControlBoxInModal();
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { showCustomAlert('เบราว์เซอร์ไม่รองรับการสั่งงานด้วยเสียง แนะนำให้เปิดผ่าน Google Chrome ครับ', '🎙️ ไม่รองรับไมโครโฟน'); return; }
        stopActiveVoiceSession();

        const activeBtn = document.getElementById(sendLine ? 'btnVoiceCloseLine' : 'btnVoiceCloseCopy');
        const origHtml = activeBtn ? activeBtn.innerHTML : '';
        const banner = document.getElementById('voiceAutoCloseStatusBanner');
        const previewEl = document.getElementById('voiceRecognizedPreviewText');
        const countdownEl = document.getElementById('voiceCountdownLabel');

        const rec = new SR();
        activeVoiceRecognition = rec;
        rec.lang = 'th-TH';
        rec.onstart = () => {
            if (activeBtn) { activeBtn.classList.add('voice-listening-active', 'bg-rose-600'); activeBtn.innerHTML = '🔴 กำลังฟัง... พูดได้เลยครับ'; }
            if (banner) banner.classList.remove('hidden');
            if (previewEl) previewEl.innerHTML = '🎙️ <span class="text-rose-600">กำลังฟังเสียงพูดของคุณ...</span>';
            showToast('🎙️ กำลังฟัง... พูดสาเหตุและการแก้ไขได้เลยครับ');
        };
        rec.onresult = (ev) => {
            const transcript = (ev.results?.[0]?.[0]?.transcript || '').trim();
            const parsed = parseVoiceCloseSentence(transcript);
            document.getElementById('techStatusInput').value = parsed.status;
            document.getElementById('techCauseInput').value = parsed.realCause;
            document.getElementById('techActionInput').value = parsed.actionTaken;
            const gpsEl = document.getElementById('techGpsInput');
            if (gpsEl && !gpsEl.value.trim() && lastKnownTechCoords) gpsEl.value = `https://www.google.com/maps?q=${lastKnownTechCoords.lat.toFixed(6)},${lastKnownTechCoords.lon.toFixed(6)}`;
            if (previewEl) previewEl.innerHTML = `🗣️ เสียงที่รับได้: <span class="text-teal-700">"${escapeHtmlStr(transcript)}"</span>`;
            if (countdownEl) countdownEl.textContent = '⏳ กำลังบันทึกปิดงานใน 1.8 วินาที...';

            const doSubmit = () => {
                if (autoSubmitVoiceTimer) { clearTimeout(autoSubmitVoiceTimer); autoSubmitVoiceTimer = null; }
                banner?.classList.add('hidden');
                submitTechReport(sendLine);
            };
            const confirmBtn = document.getElementById('btnVoiceConfirmNow');
            if (confirmBtn) confirmBtn.onclick = doSubmit;
            autoSubmitVoiceTimer = setTimeout(doSubmit, 1800);
        };
        rec.onerror = (err) => {
            banner?.classList.add('hidden');
            if (err.error === 'not-allowed') showCustomAlert('กรุณาอนุญาตการใช้ไมโครโฟนที่แถบตั้งค่าของเบราว์เซอร์ก่อนใช้งานครับ', '🎙️ ไมโครโฟนถูกบล็อก');
        };
        rec.onend = () => {
            if (activeBtn) { activeBtn.classList.remove('voice-listening-active', 'bg-rose-600'); activeBtn.innerHTML = origHtml; }
            activeVoiceRecognition = null;
        };
        try { rec.start(); } catch (e) {}
    }

    function quickVoiceCloseFromCard(jobKey, jobType) {
        if (isViewerRole()) return;
        openInspectModal(jobKey, jobType);
        triggerOneTapVoiceInModal(false);
    }

    function startVoice(inputId) {
        stopActiveVoiceSession();
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { showToast('เบราว์เซอร์ไม่รองรับสั่งงานด้วยเสียง'); return; }
        const rec = new SR();
        rec.lang = 'th-TH';
        rec.onstart = () => showToast('🎙️ กำลังฟัง... พูดได้เลยครับ');
        rec.onresult = (e) => {
            const el = document.getElementById(inputId);
            if (el) el.value = (el.value ? el.value + ' ' : '') + e.results[0][0].transcript;
        };
        rec.start();
    }

    function openInspectModal(key, jobType) {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        stopActiveVoiceSession();
        currentEditingJobKey = key;
        currentEditingJobType = jobType;

        const list = JSON.parse(localStorage.getItem(jobType === 'outage' ? 'elecReportsComplete_all' : 'fault_reports_all') || '[]');
        const item = list.find(i => (jobType === 'outage' ? i.dateTimeSaved : i.timestamp) === key);
        if (!item) return;

        const loggedTimeModal = getJobLoggedTimeDisplay(item, jobType);
        const urgency = getJobUrgencyInfo(item, jobType);
        document.getElementById('modalJobSummary').innerHTML = jobType === 'outage'
            ? `<div>${urgency.dot} <strong>งานที่ ${escapeHtmlStr(item.jobNo)} (กะ ${escapeHtmlStr(item.shift)})</strong> วันที่ ${escapeHtmlStr(item.reportDate)} <span class="text-amber-700 font-bold">(⏰ ลงข้อมูล ${escapeHtmlStr(loggedTimeModal)})</span></div><div>⚡ อาการรับแจ้ง: ${escapeHtmlStr(item.issueType)} <span class="px-1.5 py-0.5 rounded text-[10px] font-bold border ${urgency.tagClass}">${urgency.dot} ${urgency.label}</span></div><div>🏠 บริเวณ/ที่อยู่: ${escapeHtmlStr(item.area)} (${escapeHtmlStr(item.address)})</div>`
            : `<div>${urgency.dot} <strong>วงจร ${escapeHtmlStr(item.circuit)} สถานี${escapeHtmlStr(item.station)}</strong> เวลา ${escapeHtmlStr(item.time)}</div><div>🚨 เหตุ: ${escapeHtmlStr(item.cause)} เฟส ${escapeHtmlStr(item.phase)}</div>`;

        ensureVoiceControlBoxInModal();
        document.getElementById('voiceAutoCloseStatusBanner')?.classList.add('hidden');

        const statusSelect = document.getElementById('techStatusInput');
        if (statusSelect && !statusSelect.querySelector('option[value="รอแก้ไข"]')) {
            const opt = document.createElement('option');
            opt.value = 'รอแก้ไข';
            opt.textContent = '⏳ คืนสถานะเป็น "รอแก้ไข" (เปิดใบงานใหม่)';
            statusSelect.appendChild(opt);
        }

        const now = new Date();
        const defTime = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')} น.`;
        const tr = item.techReport || {};
        const loggedUser = (localStorage.getItem('elec_app_current_user') || '').trim();

        statusSelect.value = tr.status || 'แก้ไขเสร็จสิ้น (จ่ายไฟคืนแล้ว)';
        document.getElementById('techCauseInput').value = tr.realCause || '';
        document.getElementById('techActionInput').value = tr.actionTaken || '';
        document.getElementById('techGpsInput').value = (item.gps && item.gps !== '-') ? item.gps : (tr.fieldGps || '');
        document.getElementById('techFinishTimeInput').value = tr.finishTime || defTime;
        document.getElementById('techInspectorInput').value = loggedUser ? formatTechDisplayName(loggedUser) : (tr.inspector ? formatTechDisplayName(tr.inspector) : '');
        document.getElementById('inspectModal')?.classList.remove('hidden');
    }

    function closeInspectModal() {
        stopActiveVoiceSession();
        document.getElementById('inspectModal')?.classList.add('hidden');
    }

    async function submitTechReport(sendLine = false) {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        stopRealtimeGpsWatch();
        Core.unlockCloudWrite(20000);

        const gpsEl = document.getElementById('techGpsInput');
        if (gpsEl?.value && /(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(gpsEl.value)) {
            const c = await resolveGoogleShortLinkUniversal(gpsEl.value);
            if (c?.lat && c?.lon) gpsEl.value = `https://www.google.com/maps?q=${c.lat},${c.lon}`;
        }
        if (gpsEl?.value) {
            const m = gpsEl.value.trim().match(/^(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{2,3}\.\d{4,})$/);
            if (m) gpsEl.value = `https://www.google.com/maps?q=${m[1]},${m[2]}`;
        }

        const storageKey = currentEditingJobType === 'outage' ? 'elecReportsComplete_all' : 'fault_reports_all';
        const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const idx = list.findIndex(i => (currentEditingJobType === 'outage' ? i.dateTimeSaved : i.timestamp) === currentEditingJobKey);
        if (idx === -1) return;

        const item = list[idx];
        const loggedUser = (localStorage.getItem('elec_app_current_user') || '').trim();
        const myGroup = getCurrentUserGroup();
        const status = document.getElementById('techStatusInput').value;
        const realCause = document.getElementById('techCauseInput').value.trim() || '-';
        const actionTaken = document.getElementById('techActionInput').value.trim() || '-';
        const fieldGps = gpsEl?.value.trim() || '';
        const finishTime = document.getElementById('techFinishTimeInput').value.trim() || '-';
        const inspector = document.getElementById('techInspectorInput').value.trim() || (loggedUser ? formatTechDisplayName(loggedUser) : '-');

        if (myGroup && !item.ownerGroup) item.ownerGroup = myGroup;
        if (fieldGps) item.gps = fieldGps;

        if (status === 'รอแก้ไข') {
            delete item.techReport;
            delete item.techNav;
            item.reopenedAt = new Date().toISOString();
            item.formattedText = (item.formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0];
            const closedMap = getClosedReportsRegistry();
            delete closedMap[currentEditingJobKey];
            saveClosedReportsRegistry(closedMap);

            localStorage.setItem(storageKey, JSON.stringify(list));
            closeInspectModal();
            switchStatusTab('pending');
            renderRepairJobsMapMarkers(true);
            showToast("⏳ คืนสถานะใบงานกลับไปช่อง 'รอแก้ไข' เรียบร้อยแล้ว!");
            await pushAllJobsToCloud(false);
            return;
        }

        item.techReport = { status, realCause, actionTaken, fieldGps: fieldGps || item.gps || '', finishTime, inspector, updatedAt: new Date().toISOString(), needsMainSync: true };
        if (status.includes('เสร็จสิ้น')) {
            delete item.techNav;
            delete item.pendingInitialUpload;
            delete item.reopenedAt;
            const closedMap = getClosedReportsRegistry();
            closedMap[currentEditingJobKey] = item.techReport;
            saveClosedReportsRegistry(closedMap);
        }

        const urgency = getJobUrgencyInfo(item, currentEditingJobType);
        const hdrLine = currentEditingJobType === 'outage' ? `${urgency.dot} งานที่ ${item.jobNo || '-'} กะ ${item.shift || '-'} (${item.issueType || '-'})` : `${urgency.dot} วงจร ${item.circuit || '-'} สถานี${item.station || '-'} (${item.system || '-'})`;
        const techOnlyText = `--- 🛠️ ผลตรวจสอบหน้างาน ---\n${hdrLine}\n🚦 สถานะ : ${status}\n🔍 สาเหตุจริง : ${realCause}\n🛠️ การแก้ไข : ${actionTaken}\n⏰ เวลาเสร็จ : ${finishTime}\n👷 ผู้ตรวจสอบ : ${inspector}${fieldGps ? `\n📍 พิกัดหน้างาน : ${fieldGps}` : ''}`;
        item.formattedText = `${(item.formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0]}\n\n${techOnlyText}`;

        localStorage.setItem(storageKey, JSON.stringify(list));
        closeInspectModal();
        renderJobCards();
        renderRepairJobsMapMarkers(true);

        if (sendLine) {
            copyTechText(techOnlyText, '✅ บันทึกและกำลังเปิดแอป LINE...');
            window.open('https://line.me/R/share?text=' + encodeURIComponent(techOnlyText), '_blank');
        } else {
            copyTechText(techOnlyText, `✅ บันทึกและคัดลอกผลตรวจสอบ (${hdrLine}) แล้ว!`);
        }
        await pushAllJobsToCloud(false);
    }

    // ========================================================================
    // 10. ระบบแผนที่รายการใบงานซ่อม (#repairJobsMapSection)
    // ========================================================================
    let repairJobsMap = null;
    let repairJobsMarkersLayer = null;
    let repairTechSelfMarker = null;
    let repairJobMarkersByKey = {};
    let currentlyOpenRepairPopupKey = null;
    let isRepairMapCollapsed = false;
    let isRepairMapFullscreen = false;
    let showRepairJobTooltips = true;
    let lastRepairJobsSignature = '';
    let lastAutoFittedCoordsSig = '';

    function injectRepairJobsMapSection() {
        if (document.getElementById('repairJobsMapSection')) return;
        const jobCardsEl = document.getElementById('jobCardsContainer');
        if (!jobCardsEl?.parentElement) return;

        const section = document.createElement('div');
        section.id = 'repairJobsMapSection';
        section.className = 'px-4 pt-2 pb-1';
        section.innerHTML = `
            <div id="repairJobsMapFullscreenBox" class="bg-white border-2 border-teal-500/80 rounded-2xl shadow-sm overflow-hidden">
                <div id="repairJobsMapHeader" class="bg-gradient-to-r from-slate-900 via-teal-900 to-emerald-800 px-3 py-2.5 text-white space-y-2">
                    <div class="flex items-center gap-2">
                        <span class="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-amber-400 text-slate-950 font-extrabold text-sm shrink-0">⚡</span>
                        <div class="min-w-0 flex-1">
                            <div class="text-xs sm:text-sm font-extrabold flex flex-wrap items-center gap-1.5">
                                <span>แผนที่รายการใบงานซ่อม</span>
                                <span id="repairMapPendingCountBadge" class="bg-rose-500 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full border border-white/30">⚡ รอแก้ไข 0 งาน</span>
                            </div>
                            <p class="text-[10px] text-emerald-200 truncate">มาร์คจุดสายฟ้าเฉพาะงานรอแก้ไข และลบออกอัตโนมัติเมื่องานเสร็จสิ้น</p>
                        </div>
                    </div>
                    <div class="grid grid-cols-4 gap-1.5 w-full">
                        <button type="button" onclick="fitAllRepairJobPinsOnMap(true)" class="bg-amber-400 hover:bg-amber-300 text-slate-950 px-1.5 py-1.5 rounded-xl text-[10px] sm:text-[11px] font-extrabold truncate">🎯 ซูมงานซ่อม</button>
                        <button type="button" onclick="centerRepairMapOnMyGps()" class="bg-white/15 hover:bg-white/25 text-white px-1.5 py-1.5 rounded-xl text-[10px] sm:text-[11px] font-bold truncate">📍 พิกัดฉัน</button>
                        <button type="button" id="toggleRepairJobLabelsBtn" onclick="toggleRepairJobTooltips()" class="bg-white/15 hover:bg-white/25 text-white px-1.5 py-1.5 rounded-xl text-[10px] sm:text-[11px] font-bold truncate">🏷️ ป้าย: เปิด</button>
                        <button type="button" id="toggleRepairMapCollapseBtn" onclick="handleTopRightRepairMapAction()" class="bg-white/20 hover:bg-white/30 text-white px-1.5 py-1.5 rounded-xl text-[10px] sm:text-[11px] font-bold truncate">🔼 ซ่อนแผนที่</button>
                    </div>
                </div>
                <div id="repairJobsMapInnerWrap" class="relative isolate bg-slate-100">
                    <div id="repairJobsLeafletMap" class="w-full h-[300px] sm:h-[360px] lg:h-[420px] z-0"></div>
                    <div class="absolute bottom-3 left-2.5 right-2.5 z-[400] flex items-center justify-between gap-2 pointer-events-none">
                        <button type="button" onclick="fitAllRepairJobPinsOnMap(true)" class="pointer-events-auto bg-white/95 hover:bg-white text-slate-800 border border-slate-300 px-3 py-1.5 rounded-xl text-[11px] font-bold shadow-lg truncate">⚡ ดูจุดงานซ่อมทั้งหมด</button>
                        <button type="button" id="toggleRepairMapFullscreenBtn" onclick="toggleRepairJobsMapFullscreen()" class="pointer-events-auto bg-slate-900/95 hover:bg-slate-900 text-white border border-amber-400/60 px-3 py-1.5 rounded-xl text-[11px] font-extrabold shadow-lg shrink-0">⛶ ขยายแผนที่เต็มจอ</button>
                    </div>
                </div>
            </div>`;
        jobCardsEl.parentElement.insertBefore(section, jobCardsEl);
        if (typeof L !== 'undefined' && !repairJobsMap) {
            repairJobsMap = L.map('repairJobsLeafletMap').setView([13.1361, 101.0322], 12);
            const gStreets = L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' }).addTo(repairJobsMap);
            const gHybrid = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' });
            const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
            L.control.layers({ '🗺️ แผนที่ถนน (Google)': gStreets, '🛰️ ดาวเทียม+ชื่อถนน (Google)': gHybrid, '🌐 OpenStreetMap': osm }, null, { position: 'topright' }).addTo(repairJobsMap);
            repairJobsMarkersLayer = L.layerGroup().addTo(repairJobsMap);
            updateMyTechMarkerOnRepairMap();
        }
    }

    function updateMyTechMarkerOnRepairMap() {
        if (!repairJobsMap || typeof L === 'undefined') return;
        if (!lastKnownTechCoords || !isGpsTrackingEnabled) {
            if (repairTechSelfMarker) { repairJobsMap.removeLayer(repairTechSelfMarker); repairTechSelfMarker = null; }
            return;
        }
        const ll = [lastKnownTechCoords.lat, lastKnownTechCoords.lon];
        if (!repairTechSelfMarker) {
            const ic = L.divIcon({ className: '', html: '<div style="width:26px;height:26px;border-radius:9999px;background:#2563eb;border:3px solid #fff;box-shadow:0 0 10px rgba(37,99,235,0.85);display:flex;align-items:center;justify-content:center;font-size:13px;">🚗</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
            repairTechSelfMarker = L.marker(ll, { icon: ic, zIndexOffset: 950 }).addTo(repairJobsMap).bindPopup('<b>🚗 ตำแหน่งปัจจุบันของคุณ</b>');
        } else {
            repairTechSelfMarker.setLatLng(ll);
        }
    }

    function getPendingRepairJobsForMap() {
        const jType = document.getElementById('filterJobType')?.value || 'outage';
        const shFilter = document.getElementById('filterJobShift')?.value || 'all';
        const dIso = document.getElementById('filterJobDate')?.value || '';
        const kw = (document.getElementById('searchJobKeyword')?.value || '').toLowerCase().trim();
        const tThai = dIso ? `${dIso.split('-')[2]}/${dIso.split('-')[1]}/${parseInt(dIso.split('-')[0], 10) + 543}` : '';
        const delMap = getDeletedJobsRegistry(), closedMap = getClosedReportsRegistry();
        let shortCache = {};
        try { shortCache = JSON.parse(localStorage.getItem(SHORT_URL_COORD_CACHE_KEY) || '{}'); } catch (e) {}

        const list = JSON.parse(localStorage.getItem(jType === 'fault' ? 'fault_reports_all' : 'elecReportsComplete_all') || '[]');
        const results = [];

        list.forEach(item => {
            if (!canCurrentUserSeeJob(item)) return;
            const key = jType === 'fault' ? item.timestamp : item.dateTimeSaved;
            if (!key || delMap[key]) return;
            if (item.techReport && String(item.techReport.status || '').includes('เสร็จสิ้น')) return;
            const cRep = closedMap[key];
            if (cRep && String(cRep.status || '').includes('เสร็จสิ้น') && (!item.reopenedAt || (cRep.updatedAt && cRep.updatedAt > item.reopenedAt))) return;
            if (tThai && getJobDateDisplay(item) !== tThai) return;
            if (shFilter !== 'all' && getEffectiveJobShift(item) !== shFilter) return;
            if (kw && !JSON.stringify(item).toLowerCase().includes(kw)) return;

            const coord = (shortCache[key]?.lat && shortCache[key]?.lon)
                ? { lat: parseFloat(shortCache[key].lat), lon: parseFloat(shortCache[key].lon), isApproxTambon: false }
                : (extractCoordsFromJob(item) || { lat: 13.1361, lon: 101.0322, isApproxTambon: true });
            results.push({ key, jobType: jType, item, lat: coord.lat, lon: coord.lon, isApproxTambon: Boolean(coord.isApproxTambon) });
        });

        const countMap = {};
        results.forEach(en => {
            const ck = `${en.lat.toFixed(4)}_${en.lon.toFixed(4)}`, idx = countMap[ck] || 0;
            countMap[ck] = idx + 1;
            const ang = (idx * 60) * (Math.PI / 180), rad = idx > 0 ? 0.00018 * Math.ceil(idx / 6) : 0;
            en.displayLat = en.lat + Math.sin(ang) * rad;
            en.displayLon = en.lon + Math.cos(ang) * rad;
        });
        return results;
    }

    function renderRepairJobsMapMarkers(forceRedraw = false) {
        injectRepairJobsMapSection();
        updateMyTechMarkerOnRepairMap();
        const pendingList = getPendingRepairJobsForMap();
        const badge = document.getElementById('repairMapPendingCountBadge');
        if (badge) {
            badge.textContent = pendingList.length > 0 ? `⚡ รอแก้ไข ${pendingList.length} งาน` : '✅ ไม่มีงานค้าง';
            badge.className = pendingList.length > 0 ? 'bg-rose-500 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full border border-white/30 animate-pulse' : 'bg-emerald-500 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full border border-white/30';
        }
        if (!repairJobsMap || !repairJobsMarkersLayer) return;

        const sig = pendingList.map(p => `${p.key}:${p.displayLat.toFixed(5)},${p.displayLon.toFixed(5)}:${Boolean(p.item.techNav)}:${p.item.techReport?.status || ''}`).join('|');
        if (!forceRedraw && sig === lastRepairJobsSignature) return;
        lastRepairJobsSignature = sig;

        const savedKey = currentlyOpenRepairPopupKey;
        repairJobsMarkersLayer.clearLayers();
        repairJobMarkersByKey = {};
        if (pendingList.length === 0) { currentlyOpenRepairPopupKey = null; lastAutoFittedCoordsSig = ''; return; }

        pendingList.forEach(en => {
            const { key, jobType, item, displayLat, displayLon, isApproxTambon } = en;
            const isTrav = Boolean(item.techNav), urg = getJobUrgencyInfo(item, jobType);
            const shStr = getEffectiveJobShift(item), dStr = getJobDateDisplay(item), tStr = getJobLoggedTimeDisplay(item, jobType);
            const grad = isTrav ? 'linear-gradient(135deg,#2563eb,#1e40af)' : (urg.dot === '🟠' ? 'linear-gradient(135deg,#f97316,#c2410c)' : (urg.dot === '🟡' ? 'linear-gradient(135deg,#eab308,#a16207)' : (urg.dot === '🟢' ? 'linear-gradient(135deg,#10b981,#047857)' : 'linear-gradient(135deg,#e11d48,#9f1239)')));
            const pulse = isTrav ? 'rgba(37,99,235,0.55)' : 'rgba(225,29,72,0.55)';

            const ic = L.divIcon({ className: '', html: `<div class="repair-job-lightning-wrapper"><div class="repair-job-pulse-ring" style="background:${pulse};"></div><div class="repair-job-lightning-pin" style="background:${grad};"><span>⚡</span></div></div>`, iconSize: [36, 36], iconAnchor: [18, 34], popupAnchor: [0, -32] });
            const tip = jobType === 'outage' ? `${isTrav ? '🚗' : '⚡'} งานที่ ${item.jobNo || '-'} (กะ ${shStr}) • ${item.issueType || 'ไฟขัดข้อง'}` : `${isTrav ? '🚗' : '⚡'} TR/TL: ${item.circuit || '-'} สถานี${item.station || '-'}`;
            const mk = L.marker([displayLat, displayLon], { icon: ic, zIndexOffset: 800 }).bindTooltip(escapeHtmlStr(tip), { permanent: true, direction: 'top', offset: [0, -32], className: `repair-job-pin-tooltip ${isTrav ? 'is-traveling-tooltip' : ''}` });

            const mapsUrl = (item.gps && String(item.gps).startsWith('http')) ? String(item.gps).trim() : `https://www.google.com/maps/dir/?api=1&destination=${en.lat},${en.lon}&travelmode=driving`;
            const sKey = String(key).replace(/'/g, "\\'"), sMaps = mapsUrl.replace(/'/g, "\\'");
            const stTxt = item.techReport?.status || (isTrav ? `🚗 กำลังเดินทาง (${formatTechDisplayName(item.techNav?.techName || 'ช่าง')})` : '⏳ รอแก้ไข');

            mk.bindPopup(`<div style="font-family:'Prompt',sans-serif;min-width:250px;" class="space-y-1.5 text-xs"><div class="flex justify-between gap-1"><span class="bg-rose-100 text-rose-800 border border-rose-300 text-[10px] font-extrabold px-2 py-0.5 rounded-full">⚡ ${escapeHtmlStr(stTxt)}</span><span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-2 py-0.5 rounded">🏢 ${escapeHtmlStr(getJobGroupName(item))}</span></div><div class="font-extrabold text-slate-900 text-sm pt-0.5">${urg.dot} ${escapeHtmlStr(tip)}</div><div class="text-slate-600 text-[11px] space-y-0.5">${jobType === 'outage' ? `<div>📍 <b>บริเวณ:</b> ${escapeHtmlStr(item.area || '-')}</div><div>🏠 <b>ที่อยู่:</b> ${escapeHtmlStr(item.address || '-')}</div>` : `<div>🚨 <b>สาเหตุ:</b> ${escapeHtmlStr(item.cause || '-')}</div>`}<div>⏰ <b>เวลาแจ้ง:</b> ${escapeHtmlStr(tStr)} (${escapeHtmlStr(dStr)})</div>${isApproxTambon ? '<div class="text-amber-700 font-semibold text-[10px]">⚠️ พิกัดอ้างอิงระดับตำบล</div>' : ''}</div><div class="pt-1.5 border-t border-slate-200 flex flex-wrap gap-1">${(item.phone && item.phone !== '-') ? `<a href="tel:${escapeHtmlStr(item.phone)}" style="background:#f1f5f9;color:#334155;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;text-decoration:none;">📞 โทร</a>` : ''}<button type="button" onclick="handleStartNavigation('${sKey}','${jobType}','')" style="background:#0284c7;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;flex:1;">🚗 ออกเดินทาง</button><button type="button" onclick="handleStartNavigation('${sKey}','${jobType}','${sMaps}')" style="background:#2563eb;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;flex:1;">🗺️ นำทาง Maps</button><button type="button" onclick="openInspectModal('${sKey}','${jobType}')" style="background:#0d9488;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;width:100%;margin-top:2px;">🛠️ แจ้งผลตรวจสอบ / ปิดงาน</button></div></div>`);
            mk.on('popupopen', () => { currentlyOpenRepairPopupKey = key; });
            mk.on('popupclose', () => { if (currentlyOpenRepairPopupKey === key) currentlyOpenRepairPopupKey = null; });
            mk.addTo(repairJobsMarkersLayer);
            repairJobMarkersByKey[key] = mk;
        });

        if (savedKey && repairJobMarkersByKey[savedKey]) repairJobMarkersByKey[savedKey].openPopup();
        const coordsSig = pendingList.map(p => `${p.key}:${p.displayLat.toFixed(5)},${p.displayLon.toFixed(5)}`).join('|');
        if (coordsSig !== lastAutoFittedCoordsSig && !currentlyOpenRepairPopupKey) {
            lastAutoFittedCoordsSig = coordsSig;
            setTimeout(() => fitAllRepairJobPinsOnMap(false), 60);
        }
    }

    function focusSingleRepairJobOnMap(jobKey) {
        if (isRepairMapCollapsed) toggleRepairJobsMapCollapse();
        const mk = repairJobMarkersByKey[jobKey];
        if (!mk || !repairJobsMap) { showToast('⚠️ ไม่พบพิกัดของใบงานนี้บนแผนที่'); return; }
        if (!isRepairMapFullscreen) document.getElementById('repairJobsMapSection')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => { repairJobsMap.invalidateSize(); repairJobsMap.setView(mk.getLatLng(), 16); mk.openPopup(); }, 150);
    }

    function fitAllRepairJobPinsOnMap(showFeedback = true) {
        if (isRepairMapCollapsed) { if (showFeedback) toggleRepairJobsMapCollapse(); else return; }
        const list = getPendingRepairJobsForMap();
        if (!repairJobsMap || list.length === 0) { if (showFeedback) showToast('🎉 ไม่มีใบงานรอแก้ไขค้างอยู่บนแผนที่'); return; }
        repairJobsMap.invalidateSize();
        repairJobsMap.fitBounds(list.map(p => [p.displayLat, p.displayLon]), { paddingTopLeft: [45, 55], paddingBottomRight: [45, 52], maxZoom: 16 });
        if (showFeedback) showToast(`⚡ ซูมแสดงจุดสายฟ้าใบงานรอแก้ไขทั้งหมด (${list.length} งาน)`);
    }

    function centerRepairMapOnMyGps() {
        if (isRepairMapCollapsed) toggleRepairJobsMapCollapse();
        if (!navigator.geolocation) { showToast('⚠️ เบราว์เซอร์ไม่รองรับ GPS'); return; }
        showToast('⏳ กำลังค้นหาพิกัดปัจจุบันของคุณ...');
        navigator.geolocation.getCurrentPosition(
            (pos) => { recordCurrentTechGpsLocation(pos.coords.latitude, pos.coords.longitude); repairJobsMap?.invalidateSize(); repairJobsMap?.setView([pos.coords.latitude, pos.coords.longitude], 16); showToast('📍 ซูมไปยังตำแหน่งปัจจุบันแล้ว'); },
            () => { if (lastKnownTechCoords && repairJobsMap) repairJobsMap.setView([lastKnownTechCoords.lat, lastKnownTechCoords.lon], 15); else showToast('⚠️ ไม่สามารถดึงพิกัดได้'); },
            { enableHighAccuracy: true, timeout: 7000 }
        );
    }

    function toggleRepairJobTooltips() {
        showRepairJobTooltips = !showRepairJobTooltips;
        document.getElementById('repairJobsLeafletMap')?.classList.toggle('hide-job-tooltips', !showRepairJobTooltips);
        const btn = document.getElementById('toggleRepairJobLabelsBtn');
        if (btn) btn.textContent = showRepairJobTooltips ? '🏷️ ป้าย: เปิด' : '🏷️ ป้าย: ปิด';
    }

    function updateRepairMapBtnsUI() {
        const topBtn = document.getElementById('toggleRepairMapCollapseBtn');
        const fullBtn = document.getElementById('toggleRepairMapFullscreenBtn');
        if (topBtn) topBtn.innerHTML = isRepairMapFullscreen ? '✖️ ย่อแผนที่' : (isRepairMapCollapsed ? '🔽 เปิดแผนที่' : '🔼 ซ่อนแผนที่');
        if (fullBtn) fullBtn.innerHTML = isRepairMapFullscreen ? '✖️ ย่อกลับขนาดปกติ' : '⛶ ขยายแผนที่เต็มจอ';
    }

    function handleTopRightRepairMapAction() { if (isRepairMapFullscreen) toggleRepairJobsMapFullscreen(); else toggleRepairJobsMapCollapse(); }
    function toggleRepairJobsMapCollapse() {
        if (isRepairMapFullscreen) return toggleRepairJobsMapFullscreen();
        isRepairMapCollapsed = !isRepairMapCollapsed;
        document.getElementById('repairJobsMapInnerWrap')?.classList.toggle('hidden', isRepairMapCollapsed);
        updateRepairMapBtnsUI();
        if (!isRepairMapCollapsed && repairJobsMap) setTimeout(() => { repairJobsMap.invalidateSize(); fitAllRepairJobPinsOnMap(false); }, 150);
    }

    function toggleRepairJobsMapFullscreen() {
        const box = document.getElementById('repairJobsMapFullscreenBox');
        if (!box) return;
        if (isRepairMapCollapsed) { isRepairMapCollapsed = false; document.getElementById('repairJobsMapInnerWrap')?.classList.remove('hidden'); }
        isRepairMapFullscreen = !isRepairMapFullscreen;
        box.classList.toggle('repair-map-fullscreen', isRepairMapFullscreen);
        updateRepairMapBtnsUI();
        setTimeout(() => { repairJobsMap?.invalidateSize(); fitAllRepairJobPinsOnMap(false); }, 150);
    }

    function upgradeRepairJobsShortLinks() {
        let cache = {};
        try { cache = JSON.parse(localStorage.getItem(SHORT_URL_COORD_CACHE_KEY) || '{}'); } catch (e) {}
        ['elecReportsComplete_all', 'fault_reports_all'].forEach(sk => {
            const isF = (sk === 'fault_reports_all');
            JSON.parse(localStorage.getItem(sk) || '[]').forEach(async item => {
                const jk = isF ? item?.timestamp : item?.dateTimeSaved;
                const rawGps = String(item?.techReport?.fieldGps || item?.gps || '').trim();
                if (!jk || cache[jk] || !/(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(rawGps)) return;
                const c = await resolveGoogleShortLinkUniversal(rawGps);
                if (c?.lat && c?.lon) {
                    const latest = JSON.parse(localStorage.getItem(SHORT_URL_COORD_CACHE_KEY) || '{}');
                    latest[jk] = { lat: parseFloat(c.lat), lon: parseFloat(c.lon), updatedAt: Date.now() };
                    localStorage.setItem(SHORT_URL_COORD_CACHE_KEY, JSON.stringify(latest));
                    renderRepairJobsMapMarkers(true);
                }
            });
        });
    }

    // ========================================================================
    // 11. เชื่อมเหตุการณ์ระบบ, ตั้งเวลาอัปเดตสด & ส่งออกฟังก์ชันสู่ Global
    // ========================================================================
    async function flushPendingJobsWhenOnline() {
        if (!navigator.onLine || localStorage.getItem('elec_app_logged_in') !== 'true') return;
        if (localStorage.getItem('elec_tech_has_pending_push') === 'true') {
            showToast('🌐 สัญญาณเน็ตกลับมาแล้ว กำลังอัปเดตงานขึ้นระบบ...');
            await syncJobsFromCloud(true);
            await pushAllJobsToCloud(false);
        } else {
            await syncJobsFromCloud(true);
        }
    }

    window.addEventListener('online', flushPendingJobsWhenOnline);
    window.addEventListener('offline', () => {
        const el = document.getElementById('cloudStatusText');
        if (el) el.textContent = '🟠 ขาดการเชื่อมต่อเน็ต (บันทึกงานได้ ระบบจะส่งให้อัตโนมัติเมื่อมีเน็ต)';
        showToast('⚠️ สัญญาณอินเทอร์เน็ตขาดหาย (โหมดออฟไลน์อัตโนมัติ)');
    });
    window.addEventListener('focus', () => { if (localStorage.getItem('elec_app_logged_in') === 'true') { checkTechAuth(); flushPendingJobsWhenOnline(); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isRepairMapFullscreen) toggleRepairJobsMapFullscreen(); });

    Core.onRealtimeChange((keys) => {
        if (keys.some(k => k.includes('equip') || k === 'elec_tech_locations_map' || k.includes('cancelled'))) syncEquipNavFromTechLocations();
        if (keys.some(k => k === 'elecReportsComplete_all' || k === 'fault_reports_all' || k.includes('jobs_registry') || k === 'elec_tech_locations_map')) {
            checkNewIncomingPendingJobs();
            renderJobCards();
        }
    });

    Object.assign(window, {
        checkTechAuth, goBackToMainPage, updateRoleNavigationUI, openTechOnlineModal, handleTechLogin, handleTechLogout,
        toggleSoundAlert, playNewJobAlertSound, checkNewIncomingPendingJobs,
        toggleGpsTracking, requestScreenWakeLock, recordCurrentTechGpsLocation, initTechGpsTracker, captureCurrentTechGpsForModal,
        extractCoordsFromJob, findNearestTechForJob, calculateInstantRouteFallback, calculateDrivingRoute,
        handleStartNavigation, handleCancelNavigation, formatRealtimeNavHtml, updateLiveNavDomElements,
        syncJobsFromCloud, pushAllJobsToCloud,
        setTechDateFilterToday, clearTechDateFilter, onTechDateInputChanged, selectShiftFilter, switchStatusTab,
        getEffectiveJobShift, getJobDateDisplay, getJobLoggedTimeDisplay, getJobUrgencyInfo, renderJobCards,
        openInspectModal, closeInspectModal, submitTechReport, startVoice,
        triggerOneTapVoiceInModal, cancelVoiceAutoSubmit, quickVoiceCloseFromCard,
        canUserControlNavigation, getActiveEquipmentNavItems, syncEquipNavToTechLocations, syncEquipNavFromTechLocations,
        recordEquipmentNavStart, updateEquipmentNavRouteInfo, stopEquipmentNavigationByKey, finishMyEquipmentNavigation, openTravelingDashboardFromEquipBanner,
        renderRepairJobsMapMarkers, focusSingleRepairJobOnMap, fitAllRepairJobPinsOnMap, centerRepairMapOnMyGps,
        toggleRepairJobTooltips, handleTopRightRepairMapAction, toggleRepairJobsMapCollapse, toggleRepairJobsMapFullscreen
    });

    window.addEventListener('DOMContentLoaded', async () => {
        injectTechJobsDynamicStylesAndBanner();
        rescueFalselyClosedRecentJobs();
        checkTechAuth();
        updateSoundToggleButtonUI();
        updateGpsToggleButtonUI();
        updateDateFilterButtonsUI();
        syncEquipNavToTechLocations();
        syncEquipNavFromTechLocations();
        switchStatusTab('pending');

        await syncJobsFromCloud(true);
        checkNewIncomingPendingJobs();
        if (localStorage.getItem('elec_tech_has_pending_push') === 'true' && navigator.onLine) await pushAllJobsToCloud(false);
        initTechGpsTracker();
        setTimeout(upgradeRepairJobsShortLinks, 1200);

        setInterval(() => {
            updateLiveNavDomElements();
            document.querySelectorAll('.equip-realtime-nav-box').forEach(box => {
                const nav = getEquipNavMap()[box.getAttribute('data-equip-key')];
                if (nav?.isTraveling) box.innerHTML = formatRealtimeNavHtml(nav);
            });
        }, 1000);
        setInterval(syncEquipNavFromTechLocations, 2000);
        setInterval(upgradeRepairJobsShortLinks, 6000);
        setInterval(() => {
            if (!document.hidden && localStorage.getItem('elec_app_logged_in') === 'true') {
                Core.updateUserOnlineHeartbeat('📱 หน้าช่าง', lastKnownTechCoords, isGpsTrackingEnabled);
                updateTechOnlineCountUI();
            }
        }, 15000);
        setInterval(async () => {
            if (!document.hidden && localStorage.getItem('elec_app_logged_in') === 'true') {
                await syncJobsFromCloud(true);
                if (localStorage.getItem('elec_tech_has_pending_push') === 'true' && navigator.onLine) await pushAllJobsToCloud(false);
            }
        }, 5000);
    });
})();
// ==================== จบไฟล์ tech-jobs.js ====================
