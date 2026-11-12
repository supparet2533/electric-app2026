// ============================================================================
// 📲 PEA SMART GRID — FIREBASE WEB PUSH CLIENT MODULE (pm-push.js)
// ผูกเครื่องรับแจ้งเตือนแม้ปัดปิดแอป + ซิงค์เฉพาะตารางเวลาเตือนไร้ข้อมูลลับขึ้นหลังบ้าน
// โปรเจกต์: SamSrikacha (samsrikacha-da210) — รุ่นลดภาระคิวซิงค์ตอนเปิดแอป
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

    let fcmMessagingInstance = null;
    let lastSyncedScheduleSig = localStorage.getItem(SAVED_SCHED_SIG_KEY) || '';
    let syncDebounceTimer = null;
    let isSyncInFlight = false;

    function notifyMsg(msg) {
        if (typeof window.showToast === 'function') window.showToast(msg);
        else console.log('[PM-Push]', msg);
    }

    function getCloudUrl() {
        if (typeof window.getActiveCloudApiUrl === 'function') {
            const u = window.getActiveCloudApiUrl();
            if (u) return u.trim();
        }
        return (
            localStorage.getItem('elec_pm_last_api_url_v1') ||
            localStorage.getItem('elec_cloud_api_url') ||
            window.CLOUD_API_URL ||
            ''
        ).trim();
    }

    function getUserGroup() {
        const g = (typeof window.getCurrentUserGroup === 'function' ? window.getCurrentUserGroup() : '') ||
                  localStorage.getItem('elec_app_current_group') ||
                  localStorage.getItem('elec_pm_last_group_v1') ||
                  'กฟส.บึง';
        return g.trim() || 'กฟส.บึง';
    }

    function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) return resolve(true);
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve(true);
            s.onerror = () => reject(new Error('โหลดไลบรารี Firebase ไม่สำเร็จ'));
            document.head.appendChild(s);
        });
    }

    async function ensureFirebaseMessaging() {
        if (fcmMessagingInstance) return fcmMessagingInstance;
        await loadScriptOnce('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
        await loadScriptOnce('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
        if (!window.firebase.apps.length) {
            window.firebase.initializeApp(FIREBASE_WEB_CONFIG);
        }
        fcmMessagingInstance = window.firebase.messaging();
        return fcmMessagingInstance;
    }

    async function postToGas(payload) {
        const apiUrl = getCloudUrl();
        if (!apiUrl) throw new Error('ไม่พบลิงก์ Google Apps Script หลังบ้าน');
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });
        return res.json();
    }

    // ซิงค์เฉพาะเมื่อตารางเวลาเปลี่ยนจริง (ตัดชื่อแผนงาน รหัสอุปกรณ์ และพิกัดออก 100%)
    async function syncStrippedScheduleToBackend(force = false) {
        if (isSyncInFlight || localStorage.getItem('elec_app_logged_in') !== 'true') return;
        const grp = getUserGroup();
        let rawPlans = [];
        try { rawPlans = JSON.parse(localStorage.getItem(PM_STORAGE_KEY) || '[]'); } catch (e) {}

        let scadaDue = [];
        if (localStorage.getItem('elec_pm_show_scada_due_pins') !== 'false') {
            try {
                const pins = JSON.parse(localStorage.getItem('elec_labeled_places_list') || '[]');
                const del = JSON.parse(localStorage.getItem('elec_deleted_labeled_places_map') || '{}');
                scadaDue = pins
                    .filter(p => p?.id && p.dueDate && !del[p.id] && (p.ownerGroup || 'กฟส.บึง').trim() === grp)
                    .map(p => ({
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

        const stripped = rawPlans
            .filter(p => p && p.id && !p.pmDeleted && p.status !== 'done' && (p.ownerGroup || 'กฟส.บึง').trim() === grp)
            .map(p => ({
                id: p.id,
                date: p.date,
                notifyDaysBefore: Number(p.notifyDaysBefore ?? 3),
                alertMode: p.alertMode || 'standard',
                customAlertTimes: Array.isArray(p.customAlertTimes) ? p.customAlertTimes : [],
                status: p.status || 'pending',
                pmDeleted: false
            }))
            .concat(scadaDue);

        const sig = grp + '__' + JSON.stringify(stripped);
        if (!force && sig === lastSyncedScheduleSig) return;

        isSyncInFlight = true;
        try {
            const res = await postToGas({ action: 'pmPushSyncSchedule', group: grp, schedule: stripped });
            if (res && res.ok) {
                lastSyncedScheduleSig = sig;
                _origSetItem.call(localStorage, SAVED_SCHED_SIG_KEY, sig);
            }
        } catch (e) {
            // หากออฟไลน์จะลองซิงค์ใหม่รอบถัดไปอัตโนมัติ
        } finally {
            isSyncInFlight = false;
        }
    }

    async function enableBackgroundPushAlerts() {
        if (!('Notification' in window) || !('serviceWorker' in navigator)) {
            notifyMsg('⚠️ บน iPhone กรุณากดปุ่มแชร์ -> "เพิ่มไปยังหน้าจอโฮม" ก่อนเปิดแจ้งเตือนครับ');
            return;
        }

        try {
            notifyMsg('⏳ กำลังเปิดระบบแจ้งเตือนขณะปิดแอป...');
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') {
                notifyMsg('⚠️ กรุณากดอนุญาตการแจ้งเตือนในเบราว์เซอร์');
                return;
            }

            let swReg = await navigator.serviceWorker.getRegistration();
            if (!swReg) swReg = await navigator.serviceWorker.register('./sw.js');
            await navigator.serviceWorker.ready;

            const messaging = await ensureFirebaseMessaging();
            const token = await messaging.getToken({
                vapidKey: FIREBASE_VAPID_PUBLIC_KEY,
                serviceWorkerRegistration: swReg
            });

            if (!token) throw new Error('ไม่ได้รับรหัส FCM Token จากระบบ');

            const grp = getUserGroup();
            const pageFile = location.pathname.includes('page2') ? './page2.html?openPm=1' : './index.html?openPm=1';

            const regRes = await postToGas({ action: 'pmPushRegister', token, group: grp, pageUrl: pageFile });
            if (regRes && regRes.ok === false) {
                throw new Error(regRes.error || 'บันทึก Token หลังบ้านไม่สำเร็จ');
            }

            await syncStrippedScheduleToBackend(true);
            _origSetItem.call(localStorage, PUSH_TOKEN_KEY, token);
            _origSetItem.call(localStorage, PUSH_TOKEN_GRP_KEY, grp);
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
        }
    }

    function updatePushBtnUI() {
        window.requestPmBrowserNotificationPermission = enableBackgroundPushAlerts;

        const permBtn = document.getElementById('pmNotifPermBtn');
        if (!permBtn) return;
        const savedToken = localStorage.getItem(PUSH_TOKEN_KEY);
        const granted = ('Notification' in window) && Notification.permission === 'granted';
        permBtn.onclick = () => enableBackgroundPushAlerts();

        if (savedToken && granted) {
            permBtn.textContent = '📲 แจ้งเตือนปิดแอป: เปิดแล้ว';
            permBtn.className = 'bg-emerald-500/90 hover:bg-emerald-600 text-white border border-emerald-200/60 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow-sm';
        } else {
            permBtn.textContent = '📲 เปิดแจ้งเตือน (แม้ปิดแอป)';
            permBtn.className = 'bg-amber-400 hover:bg-amber-300 text-slate-950 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow-sm';
        }
    }

    // รวมจังหวะการบันทึกแผนงานต่อเนื่องให้ยิงซิงค์หลังบ้านเพียงครั้งเดียว (Debounce 1.5 วินาที)
    const _origSetItem = localStorage.setItem;
    localStorage.setItem = function (key, val) {
        _origSetItem.apply(this, arguments);
        if (key === PM_STORAGE_KEY) {
            if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
            syncDebounceTimer = setTimeout(() => syncStrippedScheduleToBackend(false), 1500);
        }
    };

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (ev) => {
            if (ev.data?.type === 'OPEN_PM_FROM_PUSH' && typeof window.openPmCalendarModal === 'function') {
                window.openPmCalendarModal();
            }
        });
    }

    function bootPmPushClient() {
        window.requestPmBrowserNotificationPermission = enableBackgroundPushAlerts;

        // 1. อัปเดตปุ่มหน้าจอทันทีโดยไม่แตะเครือข่าย (ไม่รบกวนการโหลดใบงานหลัก)
        setTimeout(() => {
            updatePushBtnUI();
            if (location.search.includes('openPm=1') && typeof window.openPmCalendarModal === 'function') {
                window.openPmCalendarModal();
            }
        }, 1000);

        // 2. หน่วงงานเช็กซิงค์เบื้องหลังออกไป 6 วินาที ให้ระบบรันเลขงานและโหลดใบงานหลักเสร็จก่อน
        setTimeout(() => {
            syncStrippedScheduleToBackend(false);

            const savedToken = localStorage.getItem(PUSH_TOKEN_KEY);
            const savedGrp = localStorage.getItem(PUSH_TOKEN_GRP_KEY);
            if (savedToken && localStorage.getItem('elec_app_logged_in') === 'true' && savedGrp !== getUserGroup()) {
                const pageFile = location.pathname.includes('page2') ? './page2.html?openPm=1' : './index.html?openPm=1';
                postToGas({ action: 'pmPushRegister', token: savedToken, group: getUserGroup(), pageUrl: pageFile })
                    .then(() => _origSetItem.call(localStorage, PUSH_TOKEN_GRP_KEY, getUserGroup()))
                    .catch(() => {});
            }
        }, 6000);

        setInterval(updatePushBtnUI, 3000);
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', bootPmPushClient);
    } else {
        bootPmPushClient();
    }

    window.enableBackgroundPushAlerts = enableBackgroundPushAlerts;
})();