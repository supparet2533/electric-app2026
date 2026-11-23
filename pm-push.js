// ============================================================================
// 📲 PEA SMART GRID — FIREBASE WEB PUSH CLIENT MODULE v1.2.2 (pm-push.js)
// ผูกเครื่องรับแจ้งเตือนแม้ปัดปิดแอป + ปลอดการชนกับ IndexedDB / โหมดซ้อม SCADA 100%
// โปรเจกต์: SamSrikacha (samsrikacha-da210)
// ============================================================================
(function () {
    'use strict';

    // 1. ค่า Config ของโปรเจกต์ samsrikacha-da210 (Public Web Config)
    const FIREBASE_WEB_CONFIG = {
        apiKey: "AIzaSyCarWjdeay4cNJJ9PYYPcpL0dcznDbDDbU",
        authDomain: "samsrikacha-da210.firebaseapp.com",
        projectId: "samsrikacha-da210",
        storageBucket: "samsrikacha-da210.firebasestorage.app",
        messagingSenderId: "590526339452",
        appId: "1:590526339452:web:bfd057319595709f1e2cf9"
    };

    // 2. Web Push Public Certificate Key Pair (VAPID Key)
    const FIREBASE_VAPID_PUBLIC_KEY = "BOBDNQzpcQGdg3cCu4oSfjnSJc2P-LAoPFqEmlIwJSf8lUqnxxuKyA7aGbiCulbSuJ4nY8imwZKWEBAnmG0UuPI";

    const PUSH_TOKEN_KEY = 'elec_pm_fcm_token_v1';
    const PUSH_TOKEN_GRP_KEY = 'elec_pm_fcm_group_v1';
    const SAVED_SCHED_SIG_KEY = 'elec_pm_push_sched_sig_v1';
    const PM_STORAGE_KEY = 'elec_pm_calendar_plans_v1';
    const PM_SYNC_CHANNEL = 'pea_pm_live_sync_v1';
    const MAX_PUSH_SCHEDULE_ITEMS = 55; // ป้องกันเกินเพดาน 9 KB ของ PropertiesService ใน GAS

    const isEmbeddedFrame = Boolean(window.PeaCore?.isEmbeddedIframe || (window.self !== window.top));
    const scriptPromises = new Map();

    let fcmMessagingInstance = null;
    let lastSyncedScheduleSig = localStorage.getItem(SAVED_SCHED_SIG_KEY) || '';
    let syncDebounceTimer = null;
    let isSyncInFlight = false;
    let isEnablingPush = false;
    let pendingOpenPmOnLogin = false;
    let permBtnObserver = null;

    function notifyMsg(msg) {
        if (typeof window.showToast === 'function') window.showToast(msg);
        else console.log('[PM-Push]', msg);
    }

    function normPushGrp(raw) {
        if (typeof window.normalizePeaGroupName === 'function') {
            return window.normalizePeaGroupName(raw) || '';
        }
        let g = String(raw || '').trim().replace(/\s+/g, ' ');
        g = g.replace(/^(กฟ[ก-ฮ]{1,2})\.\s+/, '$1.')
             .replace(/^(กฟ[สฟจตอยภผกนฉ])\s+/, '$1.')
             .replace(/^(กฟ[สฟจตอยภผกนฉ])(?![.\s]|[ก-ฮ]\.|$)/, '$1.');
        return g.trim();
    }

    function isViewerOnly() {
        if (typeof window.isViewerRole === 'function') return Boolean(window.isViewerRole());
        return (localStorage.getItem('elec_app_current_role') || '').trim() === 'viewer';
    }

    function getCloudUrl() {
        if (typeof window.getActiveCloudApiUrl === 'function') {
            const u = window.getActiveCloudApiUrl();
            if (u) return u.trim();
        }
        return (
            localStorage.getItem('elec_pm_last_api_url_v1') ||
            localStorage.getItem('elec_cloud_user_api_url') ||
            localStorage.getItem('elec_cloud_api_url') ||
            window.CLOUD_API_URL ||
            ''
        ).trim();
    }

    function getUserGroup() {
        const explicit = (typeof window.getCurrentUserGroup === 'function' ? window.getCurrentUserGroup() : '') ||
                         localStorage.getItem('elec_app_current_group') ||
                         localStorage.getItem('elec_pm_last_group_v1') ||
                         localStorage.getItem('elec_last_logged_group_name') || '';
        const normExp = normPushGrp(explicit);
        if (normExp) return normExp;
        try {
            const plans = JSON.parse(localStorage.getItem(PM_STORAGE_KEY) || '[]');
            const firstGrp = Array.isArray(plans) ? plans.find((p) => p && !p.pmDeleted && p.ownerGroup)?.ownerGroup : '';
            if (normPushGrp(firstGrp)) return normPushGrp(firstGrp);
        } catch (e) {}
        return 'กฟส.บึง';
    }

    function loadScriptOnce(src) {
        if (scriptPromises.has(src)) return scriptPromises.get(src);
        const p = new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing && window.firebase) return resolve(true);
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve(true);
            s.onerror = () => {
                scriptPromises.delete(src);
                reject(new Error('โหลดไลบรารี Firebase ไม่สำเร็จ กรุณาเช็กอินเทอร์เน็ต'));
            };
            document.head.appendChild(s);
        });
        scriptPromises.set(src, p);
        return p;
    }

    async function ensureFirebaseMessaging() {
        if (fcmMessagingInstance) return fcmMessagingInstance;
        await loadScriptOnce('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
        await loadScriptOnce('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
        if (!window.firebase?.apps?.length) {
            window.firebase.initializeApp(FIREBASE_WEB_CONFIG);
        }
        fcmMessagingInstance = window.firebase.messaging();
        return fcmMessagingInstance;
    }

    async function postToGas(payload) {
        const apiUrl = getCloudUrl();
        if (!apiUrl) throw new Error('ไม่พบลิงก์ Google Apps Script หลังบ้าน');
        window.PeaCore?.unlockCloudWrite?.(15000);
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => null);
        if (!data) throw new Error(`เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (HTTP ${res.status})`);
        return data;
    }

    function calcAbsDaysFromToday(isoStr) {
        const m = String(isoStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return 999999;
        const now = new Date();
        const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const targetMs = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
        return Math.abs(Math.round((targetMs - todayMs) / 86400000));
    }

    // ซิงค์เฉพาะเมื่อตารางเวลาเปลี่ยนจริง (รอ IndexedDB พร้อม + ไม่ทำงานในโหมดซ้อม SCADA)
    async function syncStrippedScheduleToBackend(force = false) {
        if (isEmbeddedFrame || isSyncInFlight || navigator.onLine === false) return;
        if (localStorage.getItem('elec_app_logged_in') !== 'true' || isViewerOnly()) return;
        if (window.PeaCore?.simSandbox?.active) return;

        if (window.PeaIdbStore?.ready) {
            try { await window.PeaIdbStore.ready; } catch (e) {}
        }
        if (window.PeaIdbStore?.isHydrating?.() || window.PeaCore?.simSandbox?.active) return;

        const grp = getUserGroup();
        let rawPlans = [];
        try { rawPlans = JSON.parse(localStorage.getItem(PM_STORAGE_KEY) || '[]'); } catch (e) {}

        let scadaDue = [];
        if (localStorage.getItem('elec_pm_show_scada_due_pins') !== 'false') {
            try {
                const pins = JSON.parse(localStorage.getItem('elec_labeled_places_list') || '[]');
                const del = JSON.parse(localStorage.getItem('elec_deleted_labeled_places_map') || '{}');
                scadaDue = (Array.isArray(pins) ? pins : [])
                    .filter((p) => {
                        if (!p?.id || !p.dueDate) return false;
                        const delIso = del[p.id];
                        if (delIso && (new Date(p.updatedAt || 0).getTime() || 0) <= (new Date(delIso).getTime() || 0)) return false;
                        return (normPushGrp(p.ownerGroup) || 'กฟส.บึง') === grp;
                    })
                    .map((p) => ({
                        id: 'scada_due_' + p.id,
                        date: String(p.dueDate).trim(),
                        notifyDaysBefore: 3,
                        alertMode: 'standard',
                        customAlertTimes: [],
                        status: 'pending',
                        pmDeleted: false
                    }));
            } catch (e) {}
        }

        const activePlans = (Array.isArray(rawPlans) ? rawPlans : [])
            .filter((p) => p && p.id && !p.pmDeleted && p.status !== 'done' && (normPushGrp(p.ownerGroup) || 'กฟส.บึง') === grp)
            .map((p) => {
                const cTimes = Array.isArray(p.customAlertTimes) ? p.customAlertTimes.filter(Boolean) : [];
                const mode = p.alertMode || (cTimes.length > 0 ? 'both' : 'standard');
                return {
                    id: p.id,
                    date: p.date,
                    notifyDaysBefore: Number(p.notifyDaysBefore ?? 3),
                    alertMode: mode,
                    customAlertTimes: cTimes,
                    status: p.status || 'pending',
                    pmDeleted: false
                };
            })
            .filter((p) => p.alertMode !== 'off' && !(p.alertMode === 'custom_only' && p.customAlertTimes.length === 0));

        const stripped = activePlans
            .concat(scadaDue)
            .sort((a, b) => calcAbsDaysFromToday(a.date) - calcAbsDaysFromToday(b.date))
            .slice(0, MAX_PUSH_SCHEDULE_ITEMS)
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));

        const sig = grp + '__' + JSON.stringify(stripped);
        if (!force && sig === lastSyncedScheduleSig) return;

        isSyncInFlight = true;
        try {
            const res = await postToGas({ action: 'pmPushSyncSchedule', group: grp, schedule: stripped });
            if (res && res.ok) {
                lastSyncedScheduleSig = sig;
                localStorage.setItem(SAVED_SCHED_SIG_KEY, sig);
            }
        } catch (e) {
            // หากออฟไลน์จะลองซิงค์ใหม่เมื่อออนไลน์หรือรอบถัดไปอัตโนมัติ
        } finally {
            isSyncInFlight = false;
        }
    }

    function scheduleDebouncedPushSync() {
        if (isEmbeddedFrame || window.PeaCore?.simSandbox?.active) return;
        if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
        syncDebounceTimer = setTimeout(() => syncStrippedScheduleToBackend(false), 1500);
    }

    async function enableBackgroundPushAlerts() {
        if (isEnablingPush) return;
        if (isViewerOnly()) {
            notifyMsg('🔒 บัญชีผู้สำรวจไม่สามารถผูกระบบแจ้งเตือนขณะปิดแอปหลังบ้านได้');
            return;
        }
        if (isEmbeddedFrame && window.top && window.top !== window.self) {
            try {
                if (typeof window.top.enableBackgroundPushAlerts === 'function') {
                    return window.top.enableBackgroundPushAlerts();
                }
            } catch (e) {}
        }
        if (!('Notification' in window) || !('serviceWorker' in navigator)) {
            notifyMsg('⚠️ บน iPhone กรุณากดปุ่มแชร์ -> "เพิ่มไปยังหน้าจอโฮม" ก่อนเปิดแจ้งเตือนครับ');
            return;
        }

        isEnablingPush = true;
        const permBtn = document.getElementById('pmNotifPermBtn');
        if (permBtn) { permBtn.disabled = true; permBtn.textContent = '⏳ กำลังเชื่อมต่อ...'; }

        try {
            notifyMsg('⏳ กำลังเปิดระบบแจ้งเตือนขณะปิดแอป...');
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') {
                notifyMsg('⚠️ กรุณากดอนุญาตการแจ้งเตือนในเบราว์เซอร์');
                return;
            }

            let swReg = await navigator.serviceWorker.getRegistration('./');
            if (!swReg) await navigator.serviceWorker.register('./sw.js');
            swReg = await navigator.serviceWorker.ready;

            const messaging = await ensureFirebaseMessaging();
            let token = '';
            try {
                token = await messaging.getToken({
                    vapidKey: FIREBASE_VAPID_PUBLIC_KEY,
                    serviceWorkerRegistration: swReg
                });
            } catch (tokErr) {
                try {
                    const oldSub = await swReg.pushManager?.getSubscription();
                    if (oldSub) await oldSub.unsubscribe();
                } catch (e) {}
                token = await messaging.getToken({
                    vapidKey: FIREBASE_VAPID_PUBLIC_KEY,
                    serviceWorkerRegistration: swReg
                });
            }

            if (!token) throw new Error('ไม่ได้รับรหัส FCM Token จากระบบ');

            const grp = getUserGroup();
            const pageFile = location.pathname.includes('page2') ? './page2.html?openPm=1' : './index.html?openPm=1';

            const regRes = await postToGas({ action: 'pmPushRegister', token, group: grp, pageUrl: pageFile });
            if (regRes && (regRes.ok === false || regRes.skippedViewer)) {
                throw new Error(regRes.error || 'บันทึก Token หลังบ้านไม่สำเร็จ');
            }

            await syncStrippedScheduleToBackend(true);
            localStorage.setItem(PUSH_TOKEN_KEY, token);
            localStorage.setItem(PUSH_TOKEN_GRP_KEY, grp);
            updatePushBtnUI();

            const testRes = await postToGas({ action: 'pmPushTest', token, group: grp, pageUrl: pageFile });
            if (testRes && testRes.ok) {
                notifyMsg('✅ เปิดแจ้งเตือนแม้ปิดแอปสำเร็จ! (ส่งแจ้งเตือนทดสอบเข้าเครื่องแล้ว)');
            } else {
                notifyMsg('⚠️ ผูกเครื่องแล้ว แต่ส่งทดสอบไม่ผ่าน: ' + (testRes?.detail || 'ตรวจสอบ FIREBASE_SERVICE_ACCOUNT_JSON ใน Apps Script'));
            }
        } catch (err) {
            console.error('FCM Push Setup Error:', err);
            notifyMsg('❌ เปิดแจ้งเตือนไม่สำเร็จ: ' + (err.message || err));
        } finally {
            isEnablingPush = false;
            if (permBtn) permBtn.disabled = false;
            updatePushBtnUI();
        }
    }

    function hookOpenPmModalButtonSync() {
        if (typeof window.openPmCalendarModal === 'function' && !window.openPmCalendarModal.__pushUiHooked) {
            const origOpen = window.openPmCalendarModal;
            window.openPmCalendarModal = Object.assign(function () {
                const res = origOpen.apply(this, arguments);
                updatePushBtnUI();
                return res;
            }, { __pushUiHooked: true });
        }
    }

    function attachPermBtnObserver(permBtn) {
        if (!permBtn || permBtn.__pushObserved || typeof MutationObserver === 'undefined') return;
        permBtn.__pushObserved = true;
        permBtnObserver = new MutationObserver(() => {
            if (!isEnablingPush) updatePushBtnUI();
        });
        permBtnObserver.observe(permBtn, { childList: true, characterData: true, subtree: true });
    }

    function updatePushBtnUI() {
        window.requestPmBrowserNotificationPermission = enableBackgroundPushAlerts;
        hookOpenPmModalButtonSync();
        const permBtn = document.getElementById('pmNotifPermBtn');
        if (!permBtn || isEnablingPush) return;

        attachPermBtnObserver(permBtn);

        const viewer = isViewerOnly();
        permBtn.classList.toggle('hidden', viewer);
        if (viewer) return;

        const savedToken = localStorage.getItem(PUSH_TOKEN_KEY);
        const granted = ('Notification' in window) && Notification.permission === 'granted';
        permBtn.onclick = () => enableBackgroundPushAlerts();

        const targetText = (savedToken && granted)
            ? '📲 แจ้งเตือนปิดแอป: เปิดแล้ว'
            : '📲 เปิดแจ้งเตือน (แม้ปิดแอป)';
        const targetCls = (savedToken && granted)
            ? 'bg-emerald-500/90 hover:bg-emerald-600 text-white border border-emerald-200/60 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow-sm'
            : 'bg-amber-400 hover:bg-amber-300 text-slate-950 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow-sm';

        if (permBtn.textContent !== targetText) permBtn.textContent = targetText;
        if (permBtn.className !== targetCls) permBtn.className = targetCls;
    }

    function triggerOpenPmFromNotification() {
        if (localStorage.getItem('elec_app_logged_in') === 'true') {
            pendingOpenPmOnLogin = false;
            window.openPmCalendarModal?.();
        } else {
            pendingOpenPmOnLogin = true;
            window.openPmCalendarModal?.();
        }
    }

    // ดักการเปลี่ยนแปลงตารางเวลาผ่านระบบ Event มาตรฐาน โดยไม่แตะต้อง localStorage.setItem
    const WATCHED_SCHED_KEYS = new Set([
        PM_STORAGE_KEY,
        'elec_labeled_places_list',
        'elec_deleted_labeled_places_map',
        'elec_pm_show_scada_due_pins'
    ]);

    window.PeaCore?.onRealtimeChange?.((keys) => {
        if (Array.isArray(keys) && keys.some((k) => WATCHED_SCHED_KEYS.has(k))) {
            scheduleDebouncedPushSync();
        }
    });
    window.addEventListener('storage', (e) => {
        if (e?.key && WATCHED_SCHED_KEYS.has(e.key)) scheduleDebouncedPushSync();
    });
    window.addEventListener('message', (e) => {
        if (e?.data?.type === 'PM_PLANS_SYNC') scheduleDebouncedPushSync();
    });
    window.addEventListener('online', () => {
        if (!isEmbeddedFrame && localStorage.getItem('elec_app_logged_in') === 'true' && !isViewerOnly()) {
            scheduleDebouncedPushSync();
        }
    });
    try {
        if ('BroadcastChannel' in window) {
            const pmBc = new BroadcastChannel(PM_SYNC_CHANNEL);
            pmBc.onmessage = (e) => { if (e?.data?.type === 'PM_PLANS_SYNC') scheduleDebouncedPushSync(); };
        }
    } catch (e) {}

    if ('serviceWorker' in navigator && !isEmbeddedFrame) {
        navigator.serviceWorker.addEventListener('message', (ev) => {
            if (ev.data?.type === 'OPEN_PM_FROM_PUSH') {
                triggerOpenPmFromNotification();
            }
        });
    }

    function bootPmPushClient() {
        window.requestPmBrowserNotificationPermission = enableBackgroundPushAlerts;
        updatePushBtnUI();
        if (isEmbeddedFrame) return;

        let wasLoggedIn = localStorage.getItem('elec_app_logged_in') === 'true';

        setTimeout(() => {
            updatePushBtnUI();
            if (location.search.includes('openPm=1')) {
                try {
                    const cleanUrl = new URL(location.href);
                    cleanUrl.searchParams.delete('openPm');
                    history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
                } catch (e) {}
                triggerOpenPmFromNotification();
            }
        }, 1000);

        setTimeout(() => {
            if (localStorage.getItem('elec_app_logged_in') === 'true' && !isViewerOnly()) {
                syncStrippedScheduleToBackend(false);
            }
        }, 6000);

        setInterval(() => {
            updatePushBtnUI();
            const nowLogged = localStorage.getItem('elec_app_logged_in') === 'true';
            if (nowLogged && !wasLoggedIn && pendingOpenPmOnLogin) {
                pendingOpenPmOnLogin = false;
                setTimeout(() => window.openPmCalendarModal?.(), 250);
            }
            if (nowLogged && !isViewerOnly()) {
                if (!wasLoggedIn) scheduleDebouncedPushSync();
                const savedToken = localStorage.getItem(PUSH_TOKEN_KEY);
                const savedGrp = normPushGrp(localStorage.getItem(PUSH_TOKEN_GRP_KEY));
                const curGrp = getUserGroup();
                if (savedToken && savedGrp !== curGrp && navigator.onLine !== false) {
                    localStorage.setItem(PUSH_TOKEN_GRP_KEY, curGrp);
                    const pageFile = location.pathname.includes('page2') ? './page2.html?openPm=1' : './index.html?openPm=1';
                    postToGas({ action: 'pmPushRegister', token: savedToken, group: curGrp, pageUrl: pageFile })
                        .catch(() => localStorage.setItem(PUSH_TOKEN_GRP_KEY, savedGrp));
                }
            }
            wasLoggedIn = nowLogged;
        }, 3000);
    }

    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', bootPmPushClient);
    else bootPmPushClient();

    window.enableBackgroundPushAlerts = enableBackgroundPushAlerts;
})();
// ==================== จบไฟล์ pm-push.js (v1.2.2) ====================