// ============================================================================
// 🎙️🌸 PEA SMART GRID — GEMINI LIVE VOICE PR PRESENTER & ASSISTANT v2.9 (pea-live-voice.js)
// ระบบผู้ช่วยเสียงพูดสดสองทาง + Auto-Scroll เลื่อนหน้าจออัตโนมัติขณะนำเสนอ
// เชื่อมต่อ DOM จริงครบทุกหน้า (index.html, page2.html, pm-calendar.js, meter & tx-load)
// ==================== เริ่มพาทที่ 1 / 2 ====================
(function () {
    'use strict';

    // ป้องกันการสร้างปุ่มซ้อนทับเมื่อ page2.html ถูกเปิดฝังอยู่ใน Iframe ฝั่งซ้ายของ index.html
    if (window.self !== window.top) return;

    const Core = window.PeaCore;
    const SHARED_GROUP_AI_KEY_PREFIX = 'elec_pm_ai_vision_key_v1__';
    const VOICE_PREF_STORAGE_KEY = 'elec_live_voice_name_v1';
    const RESUME_STATE_STORAGE_PREFIX = 'elec_live_resume_v5__';
    const RESUME_HANDLE_TTL_MS = 2 * 60 * 60 * 1000;
    const MAX_AUTO_RECONNECT_ATTEMPTS = 6;
    const SPEAKER_ECHO_GATE_RMS = 0.045;
    const BARGE_IN_MIN_MS = 120; // ต้องมีเสียงพูดต่อเนื่อง >= 120ms ป้องกันเสียงเคาะจอตัดบทพูด
    const POST_TURN_BARGE_WINDOW_MS = 4500;
    const DEMO_PM_DRAFT_TITLE = 'แผนดับไฟปรับปรุงระบบจำหน่าย 22kV และตัดรอนกิ่งไม้ (ตัวอย่างสาธิต)';

    const PRESENTATION_SYNC_TOOLS = new Set([
        'navigateAppScreen',
        'demoCalculate22kVFuse',
        'demoScadaFaultSearch',
        'demoScadaSwitchSimulation',
        'demoPmOutageRadarStep'
    ]);

    const TAB1_DEMO_FIELD_IDS = [
        'timeInput', 'systemSelect', 'circuitSelect', 'stationValue',
        'causeSelect', 'countSelect', 'tlSelect', 'phaseSelect',
        'currA', 'currB', 'currC', 'currG', 'distanceInput', 'zoneInput',
        'tambonSelect', 'weatherSelect', 'presentCurrInput',
        'deviceInput', 'disconnectDeviceInput', 'powerUpToDeviceInput',
        'powerUpTimeInput', 'reporterInput', 'gpsInput',
        'tab1QuickFaultKmInput', 'tab1QuickFaultAmpInput'
    ];

    const FEMALE_VOICE_PROFILES = {
        Aoede: { id: 'Aoede', label: '🌸 นุ่มนวลอบอุ่น (Aoede)' },
        Kore: { id: 'Kore', label: '✨ ชัดเจนสดใส (Kore)' }
    };

    const FALLBACK_LIVE_MODELS = [
        'models/gemini-3.8-live',
        'models/gemini-3.8-live-extended-thinking',
        'models/gemini-2.5-flash-native-audio-preview-12-2025',
        'models/gemini-3.1-flash-live-preview',
        'models/gemini-live-2.5-flash-preview',
        'models/gemini-2.0-flash-live-001'
    ];

    const utf8Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
    const resolvedLiveModelsCache = new Map();
    const unsupportedLiveModels = new Set();

    let sessionEpoch = 0;
    let turnInterruptionSeq = 0;
    let textCueSeq = 0;
    let toolCallChain = Promise.resolve();
    let pendingTopicCueAfterConnect = '';
    let pendingAutoPresentAfterConnect = false;
    let openedLeftDockByVoice = false;
    let activatedSimByVoice = false;
    let openedPmDraftByVoice = false;
    let demoFaultHighlightLayer = null;
    let tab1DemoBackup = null;
    let isApplyingTab1DemoFill = false;
    let tab1GuardBound = false;
    let lastKnownGroupApiKey = '';
    let lastTrackRecoveryAtMs = 0;

    // ตัวแปรควบคุมเอนจิน Auto-Scroll พาชมหน้าจออัตโนมัติ (หยุดทันทีเมื่อผู้ใช้วางนิ้วเลื่อนเอง)
    let autoScrollTimers = [];
    let autoScrollCleanupFns = [];

    let liveWs = null;
    let activeConnectedModel = '';
    let isLiveConnected = false;
    let isLiveConnecting = false;
    let isUserSessionActive = false;
    let isReconnecting = false;
    let reconnectAttemptCount = 0;
    let seamlessRenewCount = 0;
    let pendingToolCallCount = 0;
    let reconnectTimer = null;
    let restartSessionTimer = null;
    let goAwaySwapTimer = null;
    let playbackIdleWatchdogTimer = null;
    let frozenAudioCheckTimer = null;
    let pendingGoAwayReconnect = false;
    let isServerTurnGenerating = false;
    let serverTurnCompletedWhilePlaying = false;
    let bargeInSpeechMs = 0;
    let lastUserSpeechAtMs = 0;

    let isMicMuted = false;
    let isDockMinimized = false;
    let selectedFemaleVoice = 'Aoede';
    try {
        selectedFemaleVoice = localStorage.getItem(VOICE_PREF_STORAGE_KEY) || 'Aoede';
    } catch (e) {}
    if (!FEMALE_VOICE_PROFILES[selectedFemaleVoice]) selectedFemaleVoice = 'Aoede';

    let micInitPromise = null;
    let micStream = null;
    let inputAudioCtx = null;
    let micSourceNode = null;
    let micProcessorNode = null;
    let outputAudioCtx = null;
    let nextPlayTimeSec = 0;
    let bargeInHoldUntilMs = 0;
    const activePlaybackSources = new Set();
    const handoverAudioRingBuffer = [];
    let visualizerAnimId = null;
    let currentMicLevel = 0;
    let isAiSpeakingNow = false;

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', (ev) => {
            if (!isUserSessionActive && !isLiveConnecting) return;
            ev.stopImmediatePropagation();
            if (!document.getElementById('swUpdateReadyBar')) {
                const bar = document.createElement('button');
                bar.type = 'button';
                bar.id = 'swUpdateReadyBar';
                bar.onclick = function () { stopPeaLiveVoiceSession(true); window.location.reload(); };
                bar.className = 'fixed top-3 left-1/2 -translate-x-1/2 z-[1600] bg-amber-500 hover:bg-amber-600 text-slate-950 font-extrabold text-xs px-4 py-2 rounded-full shadow-2xl border-2 border-white';
                bar.textContent = '⚡ มีอัปเดตเวอร์ชันใหม่ แตะเพื่อรีเฟรชหลังจบการสนทนา';
                document.body.appendChild(bar);
            }
        }, true);
    }

    ['pointerdown', 'touchend', 'click', 'keydown'].forEach(evName => {
        window.addEventListener(evName, () => {
            if (!isUserSessionActive) return;
            if (outputAudioCtx && (outputAudioCtx.state === 'suspended' || outputAudioCtx.state === 'interrupted')) {
                outputAudioCtx.resume().catch(() => {});
            }
            if (inputAudioCtx && (inputAudioCtx.state === 'suspended' || inputAudioCtx.state === 'interrupted')) {
                inputAudioCtx.resume().catch(() => {});
            }
        }, { passive: true });
    });

    // ========================================================================
    // 1. Helpers กลุ่มสังกัด, เอนจิน Auto-Scroll นำเสนอ & สำรอง/คืนค่าฟอร์มอัตโนมัติ
    // ========================================================================
    function stopVoiceAutoScroll() {
        while (autoScrollTimers.length > 0) {
            clearTimeout(autoScrollTimers.pop());
        }
        while (autoScrollCleanupFns.length > 0) {
            try { autoScrollCleanupFns.pop()(); } catch (e) {}
        }
    }

    function bindCancelAutoScrollOnUserTouch(targetWin) {
        if (!targetWin || !targetWin.addEventListener) return;
        const onUserScrollIntent = (ev) => {
            if (!ev.isTrusted) return;
            if (ev.target?.closest?.('#peaLiveVoiceDock')) return;
            stopVoiceAutoScroll();
        };
        ['touchmove', 'wheel'].forEach(evName => {
            targetWin.addEventListener(evName, onUserScrollIntent, { passive: true });
        });
        autoScrollCleanupFns.push(() => {
            ['touchmove', 'wheel'].forEach(evName => {
                try { targetWin.removeEventListener(evName, onUserScrollIntent); } catch (e) {}
            });
        });
    }

    function scrollElementSmoothlyInWin(targetWin, selectorOrEl, blockMode = 'center') {
        const w = targetWin || window;
        const doc = w.document;
        if (!doc) return;
        let el = null;
        if (typeof selectorOrEl === 'string') {
            const list = Array.from(doc.querySelectorAll(selectorOrEl));
            el = list.find(node => node.getClientRects && node.getClientRects().length > 0) || list[0] || null;
        } else {
            el = selectorOrEl;
        }
        if (!el) return;
        try {
            el.scrollIntoView({ behavior: 'smooth', block: blockMode, inline: 'nearest' });
        } catch (e) {
            try { el.scrollIntoView(true); } catch (e2) {}
        }
    }

    // สั่งเลื่อนหน้าจอพาชมจุดสำคัญตามจังหวะเวลาบรรยายของ AI (รองรับทั้งหน้าหลักและ Iframe หน้าช่าง/SCADA)
    function runGuidedAutoScrollSequence(targetWin, steps = []) {
        stopVoiceAutoScroll();
        const w = targetWin || window;
        bindCancelAutoScrollOnUserTouch(window);
        if (w !== window) bindCancelAutoScrollOnUserTouch(w);

        steps.forEach(({ selector, el, delayMs = 0, block = 'center', topZero = false }) => {
            const tid = setTimeout(() => {
                if (!isUserSessionActive) return;
                if (topZero) {
                    try { w.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
                    return;
                }
                scrollElementSmoothlyInWin(w, el || selector, block);
            }, Math.max(0, Number(delayMs) || 0));
            autoScrollTimers.push(tid);
        });
    }

    function rawGet(key) {
        try {
            return Core && typeof Core.rawStorageGet === 'function' ? Core.rawStorageGet(key) : localStorage.getItem(key);
        } catch (e) {
            return '';
        }
    }

    function safeEsc(str) {
        if (typeof window.escapeHtmlStr === 'function') return window.escapeHtmlStr(str);
        return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function safeToast(msg) {
        if (typeof window.showToast === 'function') window.showToast(msg);
    }

    function isLoggedIn() {
        return rawGet('elec_app_logged_in') === 'true';
    }

    function isViewer() {
        if (typeof window.isViewerRole === 'function') return Boolean(window.isViewerRole());
        return (rawGet('elec_app_current_role') || '').trim() === 'viewer';
    }

    function canEditPmAndScadaSafe() {
        if (!isLoggedIn() || isViewer()) return false;
        if (Core?.simSandbox?.active) return false;
        if (typeof window.canCurrentUserEditScada === 'function') {
            return Boolean(window.canCurrentUserEditScada());
        }
        return (rawGet('elec_app_current_role') || 'user').trim() !== 'tech';
    }

    function normGroup(raw) {
        if (typeof window.normalizePeaGroupName === 'function') return window.normalizePeaGroupName(raw);
        let g = String(raw || '').trim().replace(/\s+/g, ' ');
        g = g.replace(/^(กฟ[ก-ฮ]{1,2})\.\s+/, '$1.')
            .replace(/^(กฟ[สฟจตอยภผกนฉ])\s+/, '$1.')
            .replace(/^(กฟ[สฟจตอยภผกนฉ])(?![.\s]|[ก-ฮ]\.|$)/, '$1.');
        return g.trim();
    }

    function getActiveVoiceGroup() {
        const explicit = normGroup(
            (typeof window.getCurrentUserGroup === 'function' ? window.getCurrentUserGroup() : '') ||
            rawGet('elec_app_current_group') || ''
        );
        if (explicit) return explicit;
        try {
            const plans = JSON.parse(rawGet('elec_pm_calendar_plans_v1') || '[]');
            const fromPm = normGroup(plans.find(p => p && !p.pmDeleted && p.ownerGroup)?.ownerGroup || '');
            if (fromPm) return fromPm;
        } catch (e) {}
        return 'กฟส.บึง';
    }

    // ดึงคีย์ประจำกลุ่มเป็นหลัก พร้อมรองรับคีย์สำรองจากตั้งค่าแชตบอทหน้าหลัก (gemini_api_key)
    function getGroupApiKey() {
        const grp = getActiveVoiceGroup();
        const k = `${SHARED_GROUP_AI_KEY_PREFIX}${grp}`;
        let val = '';
        try {
            val = localStorage.getItem(k) || rawGet(k) || localStorage.getItem('gemini_api_key') || rawGet('gemini_api_key') || '';
        } catch (e) {}
        return String(val || '').replace(/[^\x21-\x7E]/g, '').trim();
    }

    // เปิดหน้าต่างตั้งค่าคีย์ประจำกลุ่ม (#pmAiKeyConfigModal) เป็นอันดับแรกเพื่อให้ตรงกับคีย์ที่ระบบเสียงสดอ่าน
    function openKeySetupModalFallback() {
        if (typeof window.openPmAiKeyModal === 'function') {
            window.openPmAiKeyModal(false);
            const pmKeyModal = document.getElementById('pmAiKeyConfigModal');
            if (pmKeyModal) pmKeyModal.style.zIndex = '1475';
            return;
        }
        if (typeof window.openApiKeyModal === 'function') {
            window.openApiKeyModal();
            const mainKeyModal = document.getElementById('apiKeyModal');
            if (mainKeyModal) mainKeyModal.style.zIndex = '1475';
            return;
        }
        safeToast('⚠️ กรุณาตั้งค่า Gemini API Key ประจำกลุ่มก่อนใช้งานเสียงสด');
    }

    function getResumptionStorageKey(grp = getActiveVoiceGroup()) {
        return `${RESUME_STATE_STORAGE_PREFIX}${normGroup(grp) || 'กฟส.บึง'}`;
    }

    function loadValidResumptionState(targetModel = '') {
        try {
            const raw = sessionStorage.getItem(getResumptionStorageKey());
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed.handle !== 'string' || !parsed.handle.trim()) return null;
            if (Date.now() - Number(parsed.savedAtMs || 0) > RESUME_HANDLE_TTL_MS) {
                sessionStorage.removeItem(getResumptionStorageKey());
                return null;
            }
            if (parsed.voiceName && parsed.voiceName !== selectedFemaleVoice) return null;
            if (targetModel && parsed.modelName && parsed.modelName !== targetModel) return null;
            return parsed;
        } catch (e) {
            return null;
        }
    }

    function saveResumptionHandleState(newHandle, modelName) {
        const clean = String(newHandle || '').trim();
        if (!clean) return;
        try {
            sessionStorage.setItem(getResumptionStorageKey(), JSON.stringify({
                handle: clean,
                modelName: modelName || activeConnectedModel || '',
                voiceName: selectedFemaleVoice,
                savedAtMs: Date.now()
            }));
            updateMemoryBadgeUI();
        } catch (e) {}
    }

    function clearResumptionHandleState(grp = getActiveVoiceGroup()) {
        try { sessionStorage.removeItem(getResumptionStorageKey(grp)); } catch (e) {}
        updateMemoryBadgeUI();
    }

    function disposeWebSocketCleanly(ws, reason = 'closed') {
        if (!ws) return;
        ws._peaDisposed = true;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close(1000, reason);
            }
        } catch (e) {}
    }

    function discardTab1DemoBackup() {
        tab1DemoBackup = null;
    }

    function ensureTab1ManualEditGuardBound() {
        if (tab1GuardBound) return;
        const formEl = document.getElementById('sortable-tab1');
        if (!formEl) return;
        tab1GuardBound = true;
        const onUserTouchForm = (ev) => {
            if (ev.isTrusted && !isApplyingTab1DemoFill && tab1DemoBackup) {
                discardTab1DemoBackup();
            }
        };
        formEl.addEventListener('input', onUserTouchForm, true);
        formEl.addEventListener('change', onUserTouchForm, true);
        document.querySelectorAll('button[onclick*="saveAndCopyFault"]').forEach(btn => {
            btn.addEventListener('click', () => discardTab1DemoBackup(), true);
        });
    }

    function snapshotTab1BeforeDemo() {
        ensureTab1ManualEditGuardBound();
        if (tab1DemoBackup || !document.getElementById('sortable-tab1')) return;
        if (rawGet('elec_editing_fault_id')) return;
        const values = {};
        TAB1_DEMO_FIELD_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (el) values[id] = el.value;
        });
        const stDisp = document.getElementById('stationTypeDisplay');
        let rawDraft = null;
        try { rawDraft = localStorage.getItem('elec_draft_tab1_fault'); } catch (e) {}
        tab1DemoBackup = {
            values,
            stationDispText: stDisp ? stDisp.textContent : '',
            stationDispCls: stDisp ? stDisp.className : '',
            rawDraft,
            wasTimeManual: Boolean(window.isTimeManuallyEdited)
        };
    }

    function restoreTab1DemoBackupIfNeeded() {
        if (!tab1DemoBackup) return;
        const snap = tab1DemoBackup;
        tab1DemoBackup = null;
        if (!document.getElementById('sortable-tab1') || rawGet('elec_editing_fault_id')) return;
        isApplyingTab1DemoFill = true;
        try {
            const sysEl = document.getElementById('systemSelect');
            if (sysEl && snap.values.systemSelect !== undefined) {
                sysEl.value = snap.values.systemSelect;
                window.updateCircuitDropdown?.();
            }
            TAB1_DEMO_FIELD_IDS.forEach(id => {
                if (id === 'systemSelect') return;
                const el = document.getElementById(id);
                if (el && snap.values[id] !== undefined) el.value = snap.values[id];
            });
            const stDisp = document.getElementById('stationTypeDisplay');
            if (stDisp && snap.stationDispText) {
                stDisp.textContent = snap.stationDispText;
                if (snap.stationDispCls) stDisp.className = snap.stationDispCls;
            }
            try {
                if (snap.rawDraft !== null && snap.rawDraft !== undefined) {
                    localStorage.setItem('elec_draft_tab1_fault', snap.rawDraft);
                } else {
                    localStorage.removeItem('elec_draft_tab1_fault');
                }
            } catch (e) {}
            if ('isTimeManuallyEdited' in window) {
                window.isTimeManuallyEdited = snap.wasTimeManual;
            }
            if (!snap.values.gpsInput && typeof window.updateMapPreviewTab1 === 'function') {
                window.updateMapPreviewTab1(null);
            }
            window.checkAndRenderFormScadaWarnings?.();
        } catch (e) {} finally {
            isApplyingTab1DemoFill = false;
        }
    }

    function getPublicOutageRadarUrl(forcePercentEncode = false) {
        const grp = String(getActiveVoiceGroup() || 'กฟส.บึง').trim();
        const grpParam = (forcePercentEncode || /\s/.test(grp)) ? encodeURIComponent(grp) : grp;
        try {
            const base = new URL('./outage-map.html', window.location.href);
            return `${base.origin}${base.pathname}?g=${grpParam}`;
        } catch (e) {
            return `outage-map.html?g=${encodeURIComponent(grp)}`;
        }
    }

    function copyPeaLivePublicRadarLink() {
        if (typeof window.copyPublicOutageMapLink === 'function') {
            window.copyPublicOutageMapLink();
            return;
        }
        const url = getPublicOutageRadarUrl(false);
        const msg = `📡 แผนที่ตรวจสอบพื้นที่แผนดับไฟล่วงหน้า (${getActiveVoiceGroup()})\nตรวจสอบพิกัดบ้านหรือสถานประกอบการของคุณได้ที่:\n${url}`;
        if (typeof window.copyTextToClipboard === 'function') {
            window.copyTextToClipboard(msg, '📋 คัดลอกลิงก์เรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟแล้ว!');
        } else if (navigator.clipboard) {
            navigator.clipboard.writeText(msg).then(() => safeToast('📋 คัดลอกลิงก์เรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟแล้ว!')).catch(() => {});
        }
    }

    function openPeaLivePublicRadarPreview(activeZonesCount = 0) {
        const grp = getActiveVoiceGroup();
        const safeIframeUrl = getPublicOutageRadarUrl(true);
        const displayShareUrl = getPublicOutageRadarUrl(false);
        let modal = document.getElementById('peaLivePublicRadarModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'peaLivePublicRadarModal';
            modal.className = 'fixed inset-0 z-[1450] hidden bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-0 pb-[62px] sm:p-4';
            modal.onclick = (e) => { if (e.target === modal) closePeaLivePublicRadarPreview(); };
            modal.innerHTML = `
                <div class="bg-slate-900 text-white rounded-none sm:rounded-3xl shadow-2xl w-full max-w-5xl h-full sm:h-[88dvh] overflow-hidden flex flex-col border-0 sm:border-2 sm:border-rose-400/80">
                    <div class="px-3.5 pb-2.5 pt-[max(0.65rem,env(safe-area-inset-top))] sm:py-2.5 bg-gradient-to-r from-rose-700 via-pink-700 to-indigo-900 flex flex-wrap items-center justify-between gap-2 shrink-0">
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="w-2.5 h-2.5 rounded-full bg-amber-300 animate-ping shrink-0"></span>
                            <div class="min-w-0">
                                <div class="text-xs sm:text-sm font-extrabold truncate flex items-center gap-1.5">
                                    <span>📡 แผนที่เรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟ</span>
                                    <span id="peaLiveRadarGrpBadge" class="bg-black/30 text-amber-300 px-2 py-0.5 rounded-md text-[10px] font-extrabold shrink-0"></span>
                                </div>
                                <div id="peaLiveRadarSubHint" class="text-[10px] text-rose-100 truncate">มุมมองเว็บสาธารณะ (outage-map.html) — ผู้ใช้ไฟกดเช็กพิกัด GPS บ้านตนเองได้ทันทีโดยไม่ต้องล็อกอิน</div>
                            </div>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0 ml-auto">
                            <button type="button" onclick="copyPeaLivePublicRadarLink()" class="bg-white/15 hover:bg-white/25 text-white px-2.5 py-1 rounded-xl text-[11px] font-extrabold border border-white/25">🔗 คัดลอกลิงก์</button>
                            <a id="peaLiveRadarExtLink" href="#" target="_blank" rel="noopener noreferrer" class="bg-amber-400 hover:bg-amber-300 text-slate-950 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow">↗ เปิดแท็บเต็ม</a>
                            <button type="button" onclick="closePeaLivePublicRadarPreview()" class="bg-rose-600 hover:bg-rose-700 text-white px-3 py-1 rounded-xl text-[11px] font-extrabold border border-white/50 shadow">✕ ปิด</button>
                        </div>
                    </div>
                    <iframe id="peaLivePublicRadarIframe" src="about:blank" allow="geolocation" title="แผนที่เรดาร์ตรวจสอบพื้นที่ไฟดับสำหรับประชาชน" class="w-full flex-1 bg-slate-950 border-0"></iframe>
                </div>
            `;
            document.body.appendChild(modal);
        }

        const grpBadge = document.getElementById('peaLiveRadarGrpBadge');
        if (grpBadge) grpBadge.textContent = `🏢 ${grp}`;
        const extLink = document.getElementById('peaLiveRadarExtLink');
        if (extLink) extLink.href = displayShareUrl;
        const subHint = document.getElementById('peaLiveRadarSubHint');
        if (subHint) {
            subHint.textContent = activeZonesCount > 0
                ? `🟢 กำลังแสดงโซนแผนดับไฟจริงของ ${grp} (${activeZonesCount} โซน) • ผู้ใช้ไฟกดเช็ก GPS บ้านตนเองได้ทันที`
                : `💡 หน้าเว็บจริงสำหรับประชาชน (${grp}) • เมื่อเปิดสวิตช์เรดาร์ในแผน PM โซนสีแดงจะแสดงให้ผู้ใช้ไฟเช็กพิกัดทันที`;
        }

        const iframe = document.getElementById('peaLivePublicRadarIframe');
        if (iframe && iframe.getAttribute('data-loaded-radar') !== safeIframeUrl) {
            iframe.src = safeIframeUrl;
            iframe.setAttribute('data-loaded-radar', safeIframeUrl);
        }
        modal.classList.remove('hidden');
    }

    function closePeaLivePublicRadarPreview() {
        const modal = document.getElementById('peaLivePublicRadarModal');
        if (modal && !modal.classList.contains('hidden')) {
            modal.classList.add('hidden');
        }
        const iframe = document.getElementById('peaLivePublicRadarIframe');
        if (iframe && iframe.getAttribute('src') !== 'about:blank') {
            iframe.src = 'about:blank';
            iframe.removeAttribute('data-loaded-radar');
        }
    }

    function buildSampleAnnouncementTextForVoice(grp, styleMode = 'facebook') {
        const radarUrl = getPublicOutageRadarUrl(false);
        const dStr = new Date().toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
        const places = `ชุมชนและสถานประกอบการในรัศมีเรดาร์ 350 เมตร, หอพักและหมู่บ้านริมแนวสายส่ง (${grp})`;
        const cause = 'ปรับปรุงสายแรงสูง 22kV และตัดรอนกิ่งไม้ใกล้แนวสายเพื่อป้องกันกระแสไฟฟ้าขัดข้อง';
        if (styleMode === 'line') {
            return [
                `⚡ แจ้งแผนดับไฟปฏิบัติงาน (${grp})`,
                `🗓️ ${dStr}`,
                `⏰ เวลา 09.00-15.00 น. (โดยประมาณ)`,
                `🛠️ สาเหตุ: ${cause}`,
                `📍 พื้นที่ไฟดับ: ${places}`,
                `📡 เช็กพิกัดบ้านในเขตไฟดับได้ที่:`,
                radarUrl,
                `🙏 ขออภัยในความไม่สะดวก (หากเสร็จก่อนกำหนดจะจ่ายไฟทันทีครับ)`
            ].join('\n');
        }
        return [
            `📢 ประชาสัมพันธ์แจ้งแผนดับกระแสไฟฟ้าชั่วคราว`,
            `🏢 การไฟฟ้าส่วนภูมิภาค (${grp})`,
            `━━━━━━━━━━━━━━━━━━`,
            `🗓️ วันที่ : ${dStr}`,
            `⏰ เวลา : ${cleanSlotText('09.00-15.00')} น. (โดยประมาณ)`,
            `🛠️ งานที่ปฏิบัติ : ${cause}`,
            ``,
            `📍 พื้นที่ได้รับผลกระทบ (บริเวณไฟดับ) :`,
            places,
            ``,
            `📡 ตรวจสอบพิกัดหลังคาบ้าน/สถานประกอบการของท่านบนเรดาร์แผนที่ได้ที่ :`,
            radarUrl,
            `━━━━━━━━━━━━━━━━━━`,
            `🙏 การไฟฟ้าส่วนภูมิภาค (${grp}) ขออภัยในความไม่สะดวกมา ณ ที่นี้ ทั้งนี้หากปฏิบัติงานแล้วเสร็จก่อนกำหนด จะดำเนินการจ่ายกระแสไฟฟ้าให้ตามปกติทันทีครับ`
        ].join('\n');
    }

    function cleanSlotText(s) {
        return String(s || '09.00-15.00').replace(/\s*น\.?\s*$/g, '').trim();
    }

    function closeVoiceOpenedPmDraftOnly() {
        const annModal = document.getElementById('pmPublicAnnounceModal');
        if (annModal) {
            annModal.style.zIndex = '';
            delete annModal.dataset.voiceDemoFallback;
            if (!annModal.classList.contains('hidden')) {
                window.closePmPublicAnnounceModal?.();
                annModal.classList.add('hidden');
            }
        }
        const formModal = document.getElementById('pmPlanFormModal');
        if (openedPmDraftByVoice) {
            openedPmDraftByVoice = false;
            if (formModal && !formModal.classList.contains('hidden') && formModal.dataset.voiceDemoDraft === '1') {
                delete formModal.dataset.voiceDemoDraft;
                window.closePmPlanFormModal?.(true);
            }
        } else if (formModal?.dataset.voiceDemoDraft) {
            delete formModal.dataset.voiceDemoDraft;
        }
    }

    function closeVoiceOpenedPmAndRadarModals() {
        closePeaLivePublicRadarPreview();
        closeVoiceOpenedPmDraftOnly();
        window.closePmCalendarModal?.();
    }

    function pickRepresentativeBranchCoord() {
        const grp = getActiveVoiceGroup();
        try {
            const plans = JSON.parse(rawGet('elec_pm_calendar_plans_v1') || '[]');
            const pWithCoord = plans.find(p => p && !p.pmDeleted && normGroup(p.ownerGroup || 'กฟส.บึง') === grp && !isNaN(parseFloat(p.lat)) && !isNaN(parseFloat(p.lon)));
            if (pWithCoord) return { lat: Number(parseFloat(pWithCoord.lat).toFixed(6)), lon: Number(parseFloat(pWithCoord.lon).toFixed(6)) };
        } catch (e) {}
        try {
            const delPins = JSON.parse(rawGet('elec_deleted_labeled_places_map') || '{}');
            const pins = JSON.parse(rawGet('elec_labeled_places_list') || '[]');
            const pin = pins.find(p => p?.id && !delPins[p.id] && normGroup(p.ownerGroup || 'กฟส.บึง') === grp && !isNaN(parseFloat(p.lat)) && !isNaN(parseFloat(p.lon)));
            if (pin) return { lat: Number(parseFloat(pin.lat).toFixed(6)), lon: Number(parseFloat(pin.lon).toFixed(6)) };
        } catch (e) {}
        try {
            const tambons = JSON.parse(rawGet('tambonCoordinates_custom') || '{}');
            const firstTb = Object.values(tambons)[0];
            if (firstTb && !isNaN(parseFloat(firstTb.lat)) && !isNaN(parseFloat(firstTb.lon))) {
                return { lat: Number(parseFloat(firstTb.lat).toFixed(6)), lon: Number(parseFloat(firstTb.lon).toFixed(6)) };
            }
        } catch (e) {}
        const kc = window.lastKnownTechCoords;
        if (kc && !isNaN(parseFloat(kc.lat)) && !isNaN(parseFloat(kc.lon ?? kc.lng))) {
            return { lat: Number(parseFloat(kc.lat).toFixed(6)), lon: Number(parseFloat(kc.lon ?? kc.lng).toFixed(6)) };
        }
        return { lat: 13.1361, lon: 101.0322 };
    }

    function getAnyScadaWindowRef() {
        if (!document.getElementById('mainAppContent')) return window;
        const iframe = document.getElementById('leftBrowserIframe');
        if (iframe?.contentWindow) {
            try {
                const srcAttr = iframe.getAttribute('src') || '';
                if (srcAttr.includes('page2.html') || iframe.contentWindow.__labeledLeafletMap) {
                    return iframe.contentWindow;
                }
            } catch (e) {}
        }
        return null;
    }

    function clearDemoFaultHighlightLayer(scadaWinOpt) {
        if (!demoFaultHighlightLayer) return;
        try { demoFaultHighlightLayer.remove?.(); } catch (e) {}
        try {
            const w = scadaWinOpt || getAnyScadaWindowRef() || window;
            w?.__labeledLeafletMap?.removeLayer?.(demoFaultHighlightLayer);
        } catch (e) {}
        demoFaultHighlightLayer = null;
    }

    function exitVoiceActivatedSimModeIfNeeded(scadaWinOpt) {
        clearDemoFaultHighlightLayer(scadaWinOpt);
        if (!activatedSimByVoice) return;
        activatedSimByVoice = false;
        const w = scadaWinOpt || getAnyScadaWindowRef();
        if (!w) return;
        try {
            const isSimOn = Boolean(w.PeaCore?.simSandbox?.active || w.document?.body?.classList.contains('scada-sim-active'));
            if (!isSimOn) return;
            if (typeof w.toggleScadaSimMode === 'function') {
                w.toggleScadaSimMode(false);
            } else {
                w.document?.getElementById('btnToggleScadaSimMode')?.click();
            }
        } catch (e) {}
    }

    function closeVoiceOpenedLeftDockIfNeeded() {
        stopVoiceAutoScroll();
        exitVoiceActivatedSimModeIfNeeded();
        restoreTab1DemoBackupIfNeeded();
        if (window.innerWidth < 1024 || openedLeftDockByVoice) {
            openedLeftDockByVoice = false;
            if (typeof window.closeLeftWebBrowser === 'function') {
                window.closeLeftWebBrowser();
            } else {
                const dock = document.getElementById('leftBrowserDock');
                dock?.classList.remove('mobile-force-open', 'flex');
                dock?.classList.add('hidden');
                const retBar = document.getElementById('mobileScadaReturnBar');
                retBar?.classList.remove('flex');
                retBar?.classList.add('hidden');
            }
        }
    }

    async function ensureScadaMapWindowReady() {
        setDockMinimized(true);
        closeVoiceOpenedPmAndRadarModals();
        const isMainPage = Boolean(document.getElementById('mainAppContent'));

        if (!isMainPage) {
            window.switchTechMainTab?.('map');
            for (let i = 0; i < 25; i++) {
                if (window.__labeledLeafletMap) {
                    try { window.__labeledLeafletMap.invalidateSize(); } catch (e) {}
                    return window;
                }
                await new Promise(r => setTimeout(r, 150));
            }
            return window;
        }

        const leftDockEl = document.getElementById('leftBrowserDock');
        const iframe = document.getElementById('leftBrowserIframe');
        const isAlreadyScada = leftDockEl && !leftDockEl.classList.contains('hidden') && (iframe?.getAttribute('src') || '').includes('page2.html');

        if (!isAlreadyScada) {
            if (!leftDockEl || leftDockEl.classList.contains('hidden')) {
                openedLeftDockByVoice = true;
            }
            window.switchTab?.('tab1');
            window.openScadaDiagramWorkspace?.();
        }

        let switchedTabOnce = false;
        for (let i = 0; i < 34; i++) {
            const fEl = document.getElementById('leftBrowserIframe');
            try {
                const cw = fEl?.contentWindow;
                if (cw && cw.document?.readyState === 'complete') {
                    if (!switchedTabOnce && typeof cw.switchTechMainTab === 'function') {
                        switchedTabOnce = true;
                        cw.switchTechMainTab('map');
                    }
                    if (cw.__labeledLeafletMap) {
                        cw.__labeledLeafletMap.invalidateSize?.();
                        return cw;
                    }
                }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 150));
        }
        return document.getElementById('leftBrowserIframe')?.contentWindow || null;
    }

    function getBranchScadaPinsFromWin(scadaWin) {
        const grp = getActiveVoiceGroup();
        const w = scadaWin || window;
        try {
            const rawDel = w.PeaCore?.rawStorageGet ? w.PeaCore.rawStorageGet('elec_deleted_labeled_places_map') : rawGet('elec_deleted_labeled_places_map');
            const delMap = JSON.parse(rawDel || '{}');
            let list = [];
            if (w.PeaCore?.simSandbox?.active && w.localStorage) {
                list = JSON.parse(w.localStorage.getItem('elec_labeled_places_list') || '[]');
            } else {
                const rawPins = w.PeaCore?.rawStorageGet ? w.PeaCore.rawStorageGet('elec_labeled_places_list') : rawGet('elec_labeled_places_list');
                list = JSON.parse(rawPins || '[]');
            }
            return list.filter(p => p?.id && !delMap[p.id] && p.scadaNode && normGroup(p.ownerGroup || 'กฟส.บึง') === grp);
        } catch (e) {
            return [];
        }
    }

    function findLeafletMarkerForPin(scadaWin, map, pin) {
        if (!map || !pin) return null;
        let exactById = null;
        let nearestMarker = null;
        let minDist = Infinity;
        const pLat = parseFloat(pin.lat), pLon = parseFloat(pin.lon);

        map.eachLayer(layer => {
            if (exactById || typeof layer?.getLatLng !== 'function' || typeof layer?.openPopup !== 'function') return;
            const popHtml = String(layer.getPopup?.()?.getContent?.() || '');
            const iconHtml = String(layer.options?.icon?.options?.html || '');
            if (popHtml.includes('หมุดแผนงาน PM') || iconHtml.includes('pm-plan-pin-wrap')) return;
            if (pin.id && popHtml.includes(pin.id)) {
                exactById = layer;
                return;
            }
            const ll = layer.getLatLng();
            if (ll && !isNaN(pLat) && !isNaN(pLon)) {
                const d = Math.hypot(ll.lat - pLat, ll.lng - pLon);
                if (d < minDist && d < 0.0008) {
                    minDist = d;
                    nearestMarker = layer;
                }
            }
        });
        return exactById || nearestMarker;
    }

    // ========================================================================
    // 2. ตรวจสอบคุณสมบัติรายโมเดล & ค้นหาโมเดล Gemini Live อัตโนมัติ (รองรับ AIza & AQ.)
    // ========================================================================
    function isLegacy20LiveModel(modelName) {
        return /gemini-2\.0-/i.test(String(modelName || ''));
    }

    function isExtendedThinkingLiveModel(modelName) {
        return /extended-thinking/i.test(String(modelName || ''));
    }

    function isGemini3OrNewerLiveModel(modelName) {
        const m = String(modelName || '').match(/gemini-(?:live-)?(\d+(?:\.\d+)?)/i);
        return m ? parseFloat(m[1]) >= 3.0 : false;
    }

    function classifyWsServerErrorReason(reasonStr) {
        const r = String(reasonStr || '');
        return {
            isInvalidKey: /API_KEY_INVALID|API key not valid|key expired|UNAUTHENTICATED|PERMISSION_DENIED|API_KEY_HTTP_REFERRER_BLOCKED/i.test(r),
            isQuota: /quota|429|RESOURCE_EXHAUSTED/i.test(r),
            isModelNotFound: /(?:model|models\/[^\s]+)\s+is\s+not\s+found|requested\s+entity\s+was\s+not\s+found|not\s+found\s+for\s+api\s+version|not\s+supported\s+for\s+bidi|unimplemented/i.test(r)
        };
    }

    async function resolveLiveModelsForKey(apiKey) {
        const keyTag = String(apiKey || '').slice(-10);
        const filterValid = list => list.filter(m => !unsupportedLiveModels.has(`${keyTag}:${m}`));
        if (resolvedLiveModelsCache.has(keyTag)) {
            const cached = filterValid(resolvedLiveModelsCache.get(keyTag));
            if (cached.length > 0) return cached;
        }
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 5000) : null;
        try {
            const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100';
            const res = await fetch(url, {
                headers: { 'x-goog-api-key': apiKey },
                signal: ctrl ? ctrl.signal : undefined
            });
            const data = await res.json().catch(() => null);
            if (res.status === 400 || res.status === 401 || res.status === 403) {
                const msg = String(data?.error?.message || '');
                if (res.status === 401 || /API_KEY_INVALID|API key not valid|key expired|UNAUTHENTICATED|PERMISSION_DENIED|API_KEY_HTTP_REFERRER_BLOCKED|Requests from referer/i.test(msg)) {
                    const err = new Error('API Key ไม่ถูกต้อง ถูกจำกัดสิทธิ์โดเมน หรือหมดอายุ');
                    err.isInvalidKey = true;
                    throw err;
                }
            }
            if (res.ok && Array.isArray(data?.models)) {
                const ranked = [];
                data.models.forEach(m => {
                    const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
                    if (!methods.includes('bidiGenerateContent')) return;
                    const fullName = String(m.name || '').startsWith('models/') ? m.name : `models/${m.name}`;
                    const lower = fullName.toLowerCase();
                    if (!lower.includes('gemini') || lower.includes('translate') || lower.includes('tts') || lower.includes('image') || lower.includes('robotics')) return;
                    const verMatch = lower.match(/gemini-(?:live-)?(\d+(?:\.\d+)?)/);
                    const ver = verMatch ? parseFloat(verMatch[1]) : 2.0;
                    const exact38Bonus = lower === 'models/gemini-3.8-live' ? 950 : (lower.includes('gemini-3.8-live') ? 800 : 0);
                    const nativeBonus = lower.includes('native-audio') || lower.includes('live') ? 450 : 100;
                    const stableBonus = (lower.includes('preview') || lower.includes('exp')) ? 0 : 60;
                    ranked.push({ name: fullName, score: exact38Bonus + nativeBonus + (ver * 100) + stableBonus });
                });
                ranked.sort((a, b) => b.score - a.score);
                const ordered = ranked.map(r => r.name);
                if (ordered.length > 0) {
                    resolvedLiveModelsCache.set(keyTag, ordered);
                    return filterValid(ordered);
                }
            }
        } catch (err) {
            if (err?.isInvalidKey) throw err;
        } finally {
            if (timer) clearTimeout(timer);
        }
        return filterValid(FALLBACK_LIVE_MODELS);
    }
// ===== จบพาทที่ 1 / 2 ของไฟล์ pea-live-voice.js (v2.9) =====
// ==================== เริ่มพาทที่ 2 / 2 (pea-live-voice.js v2.9) ====================

    // ========================================================================
    // 3. System Instruction & เครื่องมือสั่งงานหน้าจอพร้อม Auto-Scroll (Tools)
    // ========================================================================
    function buildPeaSystemInstruction() {
        const grp = getActiveVoiceGroup();
        const role = (rawGet('elec_app_current_role') || 'user').trim();
        return [
            `คุณคือ "น้องพีอา" (PEA Smart Grid AI Presenter & Assistant) ผู้ช่วยสาวเสียงหวาน สุภาพ กระชับ คล่องแคล่ว ประจำระบบเครื่องมือจัดการงานไฟฟ้าของ "${grp}" (สิทธิ์ผู้ใช้ปัจจุบัน: ${role})`,
            `พูดภาษาไทยธรรมชาติ ลงท้ายด้วย "ค่ะ" หรือ "นะคะ" เสมอ ห้ามอ่านโค้ดหรือสัญลักษณ์ Markdown ออกเสียง`,
            `กฎสำคัญเวลาพรีเซนต์หรือสาธิตระบบ:`,
            `1. ก่อนบรรยายแต่ละหน้าจอ ต้องเรียกฟังก์ชันเครื่องมือ (Tool) ของหน้านั้นก่อนเสมอ เพื่อให้หน้าจอสลับแท็บและเลื่อนหน้าจอ (Auto-Scroll) ไปยังจุดที่กำลังพูดโดยอัตโนมัติ`,
            `2. เมื่อผู้ฟังสั่ง "พรีเซนต์ทั้งหมด" หรือ "แนะนำระบบครบทุกฟีเจอร์" ให้เรียก getBranchLiveSummary ก่อน แล้วสลับหน้าสาธิตตามลำดับ: (1) navigateAppScreen("fault_form") แท็บรายงานเหตุ TR/TL -> (2) navigateAppScreen("outage_form") แท็บรับแจ้งไฟดับ แชตบอท AI และเช็กยอดค้าง CA 12 หลัก -> (3) demoCalculate22kVFuse(160) แท็บคำนวณฟิวส์เมน 22kV -> (4) navigateAppScreen("dashboard_stats") แท็บแดชบอร์ดสถิติกราฟ -> (5) demoScadaFaultSearch ชี้เป้าจุดฟอลต์บนผังสกาด้าจำลอง -> (6) demoScadaSwitchSimulation("open_switch") แล้วตามด้วย ("close_switch") -> (7) demoPmOutageRadarStep("open_calendar") และ ("open_public_radar") โดยบรรยายสรุปจุดเด่นแต่ละส่วนสั้นๆ กระชับ น่าประทับใจ แล้วค่อยเรียกเครื่องมือถัดไป`,
            `3. การสาธิตสกาด้าทุกครั้งทำงานในโหมดจำลอง (Simulation Sandbox) เท่านั้น ข้อมูลจริงปลอดภัย 100% และฟอร์มรายงานเหตุจะคืนค่าเดิมให้อัตโนมัติหลังจบการสาธิต`,
            `4. หากผู้ฟังพูดแทรกหรือถามคำถามเจาะจง ให้หยุดเรื่องเดิมแล้วตอบคำถามนั้นทันทีอย่างแม่นยำ อ้างอิงตัวเลขจริงจากระบบ`
        ].join('\n');
    }

    function buildVoiceToolsDeclaration() {
        return [{
            functionDeclarations: [
                {
                    name: 'getBranchLiveSummary',
                    description: 'ดึงข้อมูลสรุปสถานะจริงล่าสุดของสาขา เช่น จำนวนรายงานเหตุ TR/TL ยอดรับแจ้งขัดข้อง หมุดอุปกรณ์สกาด้า งานสั่งการช่าง และแผนดับไฟ PM',
                    parameters: { type: 'OBJECT', properties: {} }
                },
                {
                    name: 'navigateAppScreen',
                    description: 'สลับหน้าจอไปยังแท็บหรือเครื่องมือที่ต้องการ พร้อมเลื่อนหน้าจอพาชมอัตโนมัติ (Auto-Scroll)',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            screen: {
                                type: 'STRING',
                                description: 'ระบุค่าหนึ่งจาก: fault_form (แท็บ 1 TR/TL), outage_form (แท็บ 2 รับแจ้ง/AI/เช็ก CA), fuse_calc (แท็บ 3 ฟิวส์ 22kV), dashboard_stats (แท็บ 4 สถิติกราฟ), history_logs (ประวัติใบงาน), tech_dispatch (หน้างานช่าง), scada_map (ผังสกาด้า), pm_calendar (ปฏิทิน PM), public_outage_radar (เรดาร์ประชาชน), meter_form (ใบมิเตอร์), tx_load_form (วัดโหลดหม้อแปลง)'
                            }
                        },
                        required: ['screen']
                    }
                },
                {
                    name: 'demoCalculate22kVFuse',
                    description: 'เปิดแท็บ 3 คำนวณฟิวส์เมน 22kV เลือกขนาดหม้อแปลง (kVA) กดคำนวณผลลัพธ์ฟิวส์ Type K จริง และเลื่อนหน้าจอลงไปโชว์ผลลัพธ์',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            kva: { type: 'NUMBER', description: 'พิกัดหม้อแปลง kVA เช่น 30, 50, 100, 160, 250, 315, 500, 1000' }
                        },
                        required: ['kva']
                    }
                },
                {
                    name: 'demoScadaFaultSearch',
                    description: 'สาธิตการวิเคราะห์หาจุดเกิดเหตุฟอลต์บนแผนที่ผังสกาด้าจำลองจากระยะทาง (กม.) กระแสลัดวงจร (แอมป์) และสภาพอากาศ พร้อมเลื่อนจอโชว์หมุดผู้ต้องสงสัย #1 #2 #3',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            circuit: { type: 'STRING', description: 'ชื่อวงจรถ้ามี (เว้นว่างให้ระบบเลือกวงจรจริงของสาขาให้อัตโนมัติ)' },
                            distanceKm: { type: 'NUMBER', description: 'ระยะทางฟอลต์เป็นกิโลเมตร เช่น 4.2' },
                            faultCurrentAmp: { type: 'NUMBER', description: 'กระแสลัดวงจรเป็นแอมป์ เช่น 1850' },
                            weather: { type: 'STRING', description: 'สภาพอากาศ เช่น ฝนตกหนัก หรือ ฝนตกฟ้าคะนองรุนแรง' }
                        }
                    }
                },
                {
                    name: 'demoScadaSwitchSimulation',
                    description: 'สาธิตสับเปลี่ยนสวิตช์ในโหมดจำลองสกาด้า (ปลดสวิตช์ตัดตอนสายเสีย หรือสับ Tie Switch จ่ายไฟย้อนช่วยพื้นที่ไฟดับ) โดยไม่กระทบข้อมูลจริง',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            action: {
                                type: 'STRING',
                                description: 'ระบุ open_switch (จำลองปลดสวิตช์ตัดตอน), close_switch (จำลองสับสวิตช์/Tie จ่ายไฟย้อน) หรือ exit_sim (ออกจากโหมดจำลอง)'
                            },
                            deviceKeyword: { type: 'STRING', description: 'ชื่อหรือรหัสสวิตช์เป้าหมาย (ถ้าไม่ระบุระบบจะเลือกสวิตช์ที่เหมาะสมในสาขาให้อัตโนมัติ)' }
                        },
                        required: ['action']
                    }
                },
                {
                    name: 'demoPmOutageRadarStep',
                    description: 'สาธิตระบบวางแผนดับไฟ PM คำประกาศแจ้งไฟดับอัตโนมัติ และหน้าเว็บเรดาร์ตรวจสอบพื้นที่ไฟดับสำหรับประชาชน',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            step: {
                                type: 'STRING',
                                description: 'ระบุ open_calendar, open_plan_form_preview, preview_public_announce, open_public_radar หรือ close_all'
                            }
                        },
                        required: ['step']
                    }
                }
            ]
        }];
    }

    // ========================================================================
    // 4. ตัวรันคำสั่งเครื่องมือ + Auto-Scroll ตรงกับ DOM จริงของทุกหน้า 100%
    // ========================================================================
    function collectBranchLiveSummary() {
        const grp = getActiveVoiceGroup();
        let faultCount = 0, outageCount = 0, scadaCount = 0, openSwitchCount = 0, tieCount = 0, pmActiveCount = 0, radarCount = 0, techJobCount = 0;

        const domFault = parseInt(document.getElementById('statFaultTotal')?.textContent || '', 10);
        const domOutage = parseInt(document.getElementById('statOutageTotal')?.textContent || '', 10);
        const domPending = parseInt(document.getElementById('countPendingJobs')?.textContent || '', 10);
        const domTraveling = parseInt(document.getElementById('countTravelingJobs')?.textContent || '', 10);

        try {
            const allSaved = JSON.parse(rawGet('elecReportsComplete_all') || '[]');
            const closedReg = JSON.parse(rawGet('elec_closed_jobs_registry') || '{}');
            const branchJobs = allSaved.filter(j => j && !j.deleted && j.jobType !== 'tech_loc' && normGroup(j.ownerGroup || 'กฟส.บึง') === grp);
            if (branchJobs.length > 0) {
                faultCount = branchJobs.filter(j => j.jobType === 'fault' || (!j.jobType && j.circuit)).length;
                outageCount = branchJobs.filter(j => j.jobType !== 'fault' && (j.jobType === 'outage' || !j.circuit)).length;
                techJobCount = branchJobs.filter(j => {
                    const tr = (j.techReport && typeof j.techReport === 'object') ? j.techReport : closedReg[j.dateTimeSaved];
                    const st = String(tr?.status || j.status || '');
                    return !/เสร็จสิ้น|completed|done/i.test(st);
                }).length;
            }
        } catch (e) {}

        if (!faultCount) {
            try {
                const logs = JSON.parse(rawGet('electricity_logs') || rawGet('fault_logs') || '[]');
                faultCount = logs.filter(l => !l?.deleted && normGroup(l?.ownerGroup || 'กฟส.บึง') === grp).length;
            } catch (e) {}
            if (!faultCount && !isNaN(domFault)) faultCount = domFault;
        }

        if (!outageCount) {
            try {
                const oLogs = JSON.parse(rawGet('outage_logs') || '[]');
                outageCount = oLogs.filter(l => !l?.deleted && normGroup(l?.ownerGroup || 'กฟส.บึง') === grp).length;
            } catch (e) {}
            if (!outageCount && !isNaN(domOutage)) outageCount = domOutage;
        }

        if (!techJobCount && (!isNaN(domPending) || !isNaN(domTraveling))) {
            techJobCount = (isNaN(domPending) ? 0 : domPending) + (isNaN(domTraveling) ? 0 : domTraveling);
        }

        try {
            const pins = getBranchScadaPinsFromWin(window);
            scadaCount = pins.length;
            openSwitchCount = pins.filter(p => p.scadaNode?.currentState === 'open').length;
            tieCount = pins.filter(p => p.scadaNode?.normalState === 'open' || /tie/i.test(p.scadaNode?.equipType || '')).length;
        } catch (e) {}

        try {
            const plans = JSON.parse(rawGet('elec_pm_calendar_plans_v1') || '[]');
            const myPlans = plans.filter(p => p && !p.pmDeleted && normGroup(p.ownerGroup || 'กฟส.บึง') === grp);
            pmActiveCount = myPlans.filter(p => p.status !== 'done').length;
            radarCount = myPlans.filter(p => p.status !== 'done' && p.pub && p.oz).length;
        } catch (e) {}

        return {
            branchGroup: grp,
            totalFaultRecordsTab1: faultCount,
            totalOutageReportsTab2: outageCount,
            scadaEquipmentPins: scadaCount,
            currentlyOpenSwitches: openSwitchCount,
            tieSwitchesAvailable: tieCount,
            activePmPlans: pmActiveCount,
            activePublicRadarZones: radarCount,
            pendingTechDispatchJobs: techJobCount,
            publicRadarUrl: getPublicOutageRadarUrl(false)
        };
    }

        function openStandaloneToolInDock(relUrl, labelTxt) {
        const dock = document.getElementById('leftBrowserDock');
        const iframe = document.getElementById('leftBrowserIframe');
        const urlInp = document.getElementById('leftBrowserUrlInput');
        const retBar = document.getElementById('mobileScadaReturnBar');
        const retTxt = document.getElementById('mobileScadaReturnText');

        if (typeof window.openLeftWebBrowser === 'function') {
            openedLeftDockByVoice = true;
            window.openLeftWebBrowser(relUrl, labelTxt);
        }
        if (dock && iframe) {
            openedLeftDockByVoice = true;
            dock.classList.remove('hidden');
            dock.classList.add('flex');
            if (window.innerWidth < 1024) {
                dock.classList.add('mobile-force-open');
                if (retTxt) retTxt.textContent = labelTxt;
                retBar?.classList.remove('hidden');
                retBar?.classList.add('flex');
            }
            const cleanFile = relUrl.replace(/^\.\//, '');
            if (!(iframe.getAttribute('src') || '').includes(cleanFile)) {
                iframe.src = relUrl;
            }
            if (urlInp) urlInp.value = relUrl;
            return true;
        }
        return false;
    }

    async function handleNavigateAppScreen(screen) {
        const target = String(screen || '').trim().toLowerCase();
        const isMainPage = Boolean(document.getElementById('mainAppContent'));
        setDockMinimized(true);

        // แท็บ 1: ฟอร์มรายงานเหตุ TR / TL (#tab1)
        if (target === 'fault_form') {
            closeVoiceOpenedPmAndRadarModals();
            closeVoiceOpenedLeftDockIfNeeded();
            if (isMainPage) {
                window.switchTab?.('tab1');
                runGuidedAutoScrollSequence(window, [
                    { topZero: true, delayMs: 80 },
                    { selector: '#circuitSelect, #systemSelect', delayMs: 1600, block: 'center' },
                    { selector: '#currentsField, #currA', delayMs: 3800, block: 'center' },
                    { selector: '#weatherSelect, #liveWeatherStatus', delayMs: 6200, block: 'center' },
                    { selector: '#deviceInput, #disconnectDeviceInput', delayMs: 8600, block: 'center' },
                    { topZero: true, delayMs: 11200 }
                ]);
                return { ok: true, screen: 'fault_form', tab: 'tab1', note: 'เปิดแท็บ 1 ฟอร์มรายงานเหตุ TR/TL และกำลังเลื่อนหน้าจอพาชมช่องกรอกกระแสลัดวงจร เรดาร์น้ำฝน Rain Alarm และอุปกรณ์สวิตช์ให้อัตโนมัติ' };
            }
            window.switchTechMainTab?.('jobs');
            return { ok: true, screen: 'jobs_on_tech_page', note: 'อยู่ในหน้าปฏิบัติงานช่าง แสดงรายการใบงานแจ้งไฟดับจากศูนย์สั่งการ' };
        }

        // แท็บ 2: ฟอร์มรับแจ้งไฟฟ้าขัดข้อง + Gemini Flash Chatbot + เช็กยอดค้าง CA (#tab2)
        if (target === 'outage_form') {
            closeVoiceOpenedPmAndRadarModals();
            closeVoiceOpenedLeftDockIfNeeded();
            if (isMainPage) {
                window.switchTab?.('tab2');
                runGuidedAutoScrollSequence(window, [
                    { topZero: true, delayMs: 80 },
                    { selector: '#geminiChatbot', delayMs: 1200, block: 'center' },
                    { selector: '#autoFillCustomerContainer', delayMs: 3800, block: 'center' },
                    { selector: '#sortable-tab2', delayMs: 6500, block: 'center' },
                    { selector: '#historyListOutage', delayMs: 9200, block: 'center' },
                    { topZero: true, delayMs: 11800 }
                ]);
                return { ok: true, screen: 'outage_form', tab: 'tab2', summary: collectBranchLiveSummary(), note: 'เปิดแท็บ 2 รับแจ้งไฟฟ้าขัดข้อง พร้อมเลื่อนพาชมผู้ช่วย AI สรุปอาการ ช่องวางข้อมูลตรวจจับเลข CA 12 หลักค้างจ่ายอัตโนมัติ และประวัติรับแจ้ง' };
            }
            window.switchTechMainTab?.('jobs');
            return { ok: true, screen: 'jobs_on_tech_page', summary: collectBranchLiveSummary() };
        }

        // แท็บ 3: คำนวณฟิวส์เมน 22kV (#tab3)
        if (target === 'fuse_calc') {
            return await handleDemoCalculate22kVFuse({ kva: 160 });
        }

        // แท็บ 4: แดชบอร์ดและสถิติกราฟ (#tab4)
        if (target === 'dashboard_stats') {
            closeVoiceOpenedPmAndRadarModals();
            closeVoiceOpenedLeftDockIfNeeded();
            if (isMainPage) {
                window.switchTab?.('tab4');
                window.loadAnalyticsData?.();
                await new Promise(r => setTimeout(r, 150));
                const fTxt = document.getElementById('analyticsFaultCount')?.textContent || '';
                const oTxt = document.getElementById('analyticsOutageCount')?.textContent || '';
                runGuidedAutoScrollSequence(window, [
                    { topZero: true, delayMs: 100 },
                    { selector: '#analyticsFaultCount', delayMs: 1600, block: 'center' },
                    { selector: '#issueBarChart', delayMs: 4000, block: 'center' },
                    { selector: '#systemDoughnutChart', delayMs: 6800, block: 'center' },
                    { topZero: true, delayMs: 9600 }
                ]);
                return {
                    ok: true,
                    screen: 'dashboard_stats',
                    tab: 'tab4',
                    analyticsFaultText: fTxt,
                    analyticsOutageText: oTxt,
                    summary: collectBranchLiveSummary(),
                    note: 'เปิดแท็บ 4 แดชบอร์ดสถิติกราฟ โหลดข้อมูลล่าสุด และกำลังเลื่อนพาชมกราฟอาการขัดข้องยอดฮิตและสัดส่วนระบบ 22kV/115kV ให้อัตโนมัติ'
                };
            }
            return { ok: true, summary: collectBranchLiveSummary(), note: 'ดึงข้อมูลสรุปสถิติของสาขาเรียบร้อยแล้ว' };
        }

        // ประวัติการบันทึก (#historyListFault ใน Tab 1)
        if (target === 'history_logs') {
            closeVoiceOpenedPmAndRadarModals();
            closeVoiceOpenedLeftDockIfNeeded();
            if (isMainPage) {
                window.switchTab?.('tab1');
                window.loadFaultHistory?.();
                runGuidedAutoScrollSequence(window, [
                    { selector: '#statFaultTotal', delayMs: 150, block: 'center' },
                    { selector: '#searchFaultInput', delayMs: 1800, block: 'center' },
                    { selector: '#historyListFault', delayMs: 3600, block: 'center' }
                ]);
                return { ok: true, screen: 'history_logs', summary: collectBranchLiveSummary(), note: 'เลื่อนหน้าจอลงไปยังคลังประวัติรายงานเหตุและปุ่มส่งออกไฟล์ Excel เรียบร้อยแล้ว' };
            }
            return { ok: true, summary: collectBranchLiveSummary() };
        }

        // กระดานใบงานช่าง (#shiftQuickPills & #jobCardsContainer ใน page2.html)
        if (target === 'tech_dispatch') {
            closeVoiceOpenedPmAndRadarModals();
            if (!isMainPage) {
                window.switchTechMainTab?.('jobs');
                runGuidedAutoScrollSequence(window, [
                    { topZero: true, delayMs: 100 },
                    { selector: '#shiftQuickPills', delayMs: 1400, block: 'center' },
                    { selector: '#jobCardsContainer', delayMs: 3200, block: 'center' }
                ]);
                return { ok: true, screen: 'tech_dispatch', summary: collectBranchLiveSummary() };
            }
            const scadaWin = await ensureScadaMapWindowReady();
            scadaWin?.switchTechMainTab?.('jobs');
            if (scadaWin) {
                runGuidedAutoScrollSequence(scadaWin, [
                    { topZero: true, delayMs: 120 },
                    { selector: '#shiftQuickPills', delayMs: 1400, block: 'center' },
                    { selector: '#jobCardsContainer', delayMs: 3200, block: 'center' }
                ]);
            }
            return { ok: true, screen: 'tech_dispatch', summary: collectBranchLiveSummary(), note: 'เปิดกระดานสั่งงานช่างภาคสนามและเลื่อนชมตัวกรองกะกับการ์ดใบงานแบบเรียลไทม์แล้ว' };
        }

        // แผนที่ผัง SCADA (#labeledInteractiveMap & #mapFullscreenContainer ใน page2.html)
        if (target === 'scada_map') {
            const scadaWin = await ensureScadaMapWindowReady();
            if (scadaWin) {
                runGuidedAutoScrollSequence(scadaWin, [
                    { selector: '#labeledInteractiveMap, #mapFullscreenContainer', delayMs: 220, block: 'center' },
                    { selector: '#scadaFaultLocatorPanel, #scadaControlToolbar, #labeledInteractiveMap', delayMs: 4200, block: 'center' },
                    { selector: '#labeledInteractiveMap, #mapFullscreenContainer', delayMs: 7200, block: 'center' }
                ]);
            }
            return { ok: true, screen: 'scada_map', summary: collectBranchLiveSummary(), note: 'เปิดแผนที่ผังสกาด้า Single-Line บน GIS และเลื่อนจัดกึ่งกลางแผนที่ให้ชมชัดเจนแล้ว' };
        }

        if (target === 'pm_calendar') {
            return await handleDemoPmOutageRadarStep('open_calendar');
        }

        if (target === 'public_outage_radar') {
            return await handleDemoPmOutageRadarStep('open_public_radar');
        }

        if (target === 'meter_form') {
            closeVoiceOpenedPmAndRadarModals();
            if (openStandaloneToolInDock('./meter-form.html', '📋 แบบฟอร์มขอสับเปลี่ยนมิเตอร์')) {
                return { ok: true, screen: 'meter_form', note: 'เปิดหน้าแบบฟอร์มรายงานมิเตอร์ชำรุด เซ็นชื่อออนไลน์ 4 ช่อง และส่งออก PDF 1 หน้า A4 แล้ว' };
            }
            return { ok: true, screen: 'meter_form', note: 'พร้อมอธิบายระบบฟอร์มสับเปลี่ยนมิเตอร์ออนไลน์และส่งออก PDF 1 หน้า A4' };
        }

        if (target === 'tx_load_form') {
            closeVoiceOpenedPmAndRadarModals();
            if (openStandaloneToolInDock('./tx-load-form.html', '📊 ระบบวัดโหลดหม้อแปลง')) {
                return { ok: true, screen: 'tx_load_form', note: 'เปิดหน้าวัดโหลดหม้อแปลง คำนวณพิกัด F/L และเกณฑ์ตัดสินติดตั้งมิเตอร์ไม่เกิน 80% แล้ว' };
            }
            return { ok: true, screen: 'tx_load_form', note: 'พร้อมอธิบายระบบวัดโหลดหม้อแปลงและเกณฑ์ตัดสินติดตั้งมิเตอร์ไม่เกิน 80%' };
        }

        return { ok: true, summary: collectBranchLiveSummary() };
    }

    // เชื่อมตรงกับ #tab3, select.tx-input, calculateFuseCalc() และ #result-box-fuse ของ index.html
    async function handleDemoCalculate22kVFuse(args) {
        const standardKvas = [30, 50, 75, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500];
        const reqKva = Number(args?.kva) || 160;
        const chosenKva = standardKvas.reduce((prev, curr) => Math.abs(curr - reqKva) < Math.abs(prev - reqKva) ? curr : prev, 160);

        const isMainPage = Boolean(document.getElementById('mainAppContent'));
        setDockMinimized(true);
        closeVoiceOpenedPmAndRadarModals();
        closeVoiceOpenedLeftDockIfNeeded();

        const hvAmp = Number((chosenKva / (Math.sqrt(3) * 22)).toFixed(2));
        let resKvaText = `${chosenKva} kVA`;
        let resAmpText = `${hvAmp} A`;
        let resInrushText = '';
        let recommendedFuseText = '';

        if (isMainPage) {
            window.switchTab?.('tab3');
            await new Promise(r => setTimeout(r, 120));

            const sel = document.querySelector('#transformer-list select.tx-input') || document.querySelector('#tab3 select');
            if (sel) {
                sel.value = String(chosenKva);
                sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const qtyInp = document.querySelector('#transformer-list input.tx-qty');
            if (qtyInp) {
                qtyInp.value = '1';
                qtyInp.dispatchEvent(new Event('input', { bubbles: true }));
            }

            window.calculateFuseCalc?.();
            await new Promise(r => setTimeout(r, 140));

            resKvaText = document.getElementById('res-kva')?.textContent?.trim() || resKvaText;
            resAmpText = document.getElementById('res-amp')?.textContent?.trim() || resAmpText;
            resInrushText = document.getElementById('res-inrush')?.textContent?.trim() || '';
            recommendedFuseText = document.getElementById('res-fuse')?.textContent?.replace(/\s+/g, ' ')?.trim() || '';

            runGuidedAutoScrollSequence(window, [
                { selector: '#transformer-list', delayMs: 80, block: 'center' },
                { selector: '#result-box-fuse', delayMs: 1300, block: 'center' }
            ]);
        }

        return {
            ok: true,
            tab: 'tab3',
            transformerKva: resKvaText,
            ratedCurrent22kV: resAmpText,
            inrushWithMultiplier: resInrushText,
            recommendedTypeKFuse: recommendedFuseText || 'คำนวณตามมาตรฐานฟิวส์แรงสูง Type K ของ กฟภ.',
            note: 'เปิดแท็บ 3 เลือกขนาดหม้อแปลง กดปุ่มคำนวณขนาดฟิวส์ Type K และเลื่อนหน้าจอลงไปแสดงกล่องผลลัพธ์ #result-box-fuse เรียบร้อยแล้ว'
        };
    }

    async function handleDemoScadaFaultSearch(args) {
        const km = Math.max(0.3, Number(args?.distanceKm) || 4.2);
        const amp = Math.max(100, Number(args?.faultCurrentAmp) || 1850);
        const weather = String(args?.weather || 'ฝนตกหนัก').trim();

        if (document.getElementById('mainAppContent')) {
            snapshotTab1BeforeDemo();
            isApplyingTab1DemoFill = true;
            try {
                const distEl = document.getElementById('distanceInput');
                if (distEl) distEl.value = String(km);
                const currAEl = document.getElementById('currA');
                if (currAEl) currAEl.value = String(amp);
                const qKm = document.getElementById('tab1QuickFaultKmInput');
                if (qKm) qKm.value = String(km);
                const qAmp = document.getElementById('tab1QuickFaultAmpInput');
                if (qAmp) qAmp.value = String(amp);
            } finally {
                isApplyingTab1DemoFill = false;
            }
        }

        const scadaWin = await ensureScadaMapWindowReady();
        if (!scadaWin || !scadaWin.document) {
            return { ok: false, error: 'ไม่สามารถเปิดหน้าแผนที่สกาด้าได้ในขณะนี้' };
        }

        clearDemoFaultHighlightLayer(scadaWin);

        if (!scadaWin.PeaCore?.simSandbox?.active && typeof scadaWin.toggleScadaSimMode === 'function') {
            scadaWin.toggleScadaSimMode(true);
            activatedSimByVoice = true;
        }

        const pins = getBranchScadaPinsFromWin(scadaWin);
        let chosenCircuit = String(args?.circuit || '').trim();
        if (!chosenCircuit && pins.length > 0) {
            const freq = {};
            pins.forEach(p => {
                const c = String(p.scadaNode?.circuit || p.scadaNode?.feeder || p.scadaNode?.fd || '').trim();
                if (c) freq[c] = (freq[c] || 0) + 1;
            });
            chosenCircuit = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
        }

        const sDoc = scadaWin.document;
        scadaWin.openScadaFaultLocatorPanel?.();

        const cirEl = sDoc.getElementById('scadaFaultCircuitSelect') || sDoc.getElementById('scadaFaultCircuit');
        if (cirEl) {
            if (chosenCircuit) {
                const opt = Array.from(cirEl.options || []).find(o => o.value === chosenCircuit || o.textContent.includes(chosenCircuit));
                if (opt) cirEl.value = opt.value;
            } else if (cirEl.options?.length > 1 && !cirEl.value) {
                cirEl.selectedIndex = 1;
                chosenCircuit = cirEl.value;
            }
            cirEl.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const kmEl = sDoc.getElementById('scadaFaultKmInput') || sDoc.getElementById('scadaFaultDistanceKm');
        if (kmEl) {
            kmEl.value = String(km);
            kmEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const ampEl = sDoc.getElementById('scadaFaultAmpInput') || sDoc.getElementById('scadaFaultCurrentAmp');
        if (ampEl) {
            ampEl.value = String(amp);
            ampEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const wthEl = sDoc.getElementById('scadaFaultWeatherSelect') || sDoc.getElementById('scadaFaultWeather');
        if (wthEl) {
            const wOpt = Array.from(wthEl.options || []).find(o => o.value.includes(weather) || o.textContent.includes('ฝน'));
            if (wOpt) wthEl.value = wOpt.value;
            wthEl.dispatchEvent(new Event('change', { bubbles: true }));
        }

        scrollElementSmoothlyInWin(scadaWin, '#scadaFaultKmInput, #scadaFaultResultBox, #labeledInteractiveMap', 'center');

        if (typeof scadaWin.runScadaFaultLocatorSearch === 'function') {
            scadaWin.runScadaFaultLocatorSearch();
        } else if (typeof scadaWin.runScadaFaultLocator === 'function') {
            scadaWin.runScadaFaultLocator();
        } else if (typeof scadaWin.executeScadaFaultSearch === 'function') {
            scadaWin.executeScadaFaultSearch();
        } else {
            try {
                scadaWin.postMessage({
                    type: 'PEA_SCADA_FAULT_LOCATOR',
                    circuit: chosenCircuit,
                    distanceKm: km,
                    faultAmp: amp,
                    weather
                }, '*');
            } catch (e) {}
            window.openScadaFaultLocatorFromTab1?.();
        }

        let resultText = '';
        for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise(r => setTimeout(r, 120));
            const resBox = sDoc.getElementById('scadaFaultResultBox');
            const txt = resBox ? resBox.innerText.replace(/\s+/g, ' ').trim() : '';
            if (txt && txt.length > 20 && !/กำลังคำนวณ/.test(txt)) {
                resultText = txt.slice(0, 500);
                break;
            }
        }

        if (!resultText && pins.length === 0 && scadaWin.__labeledLeafletMap && scadaWin.L) {
            const c = pickRepresentativeBranchCoord();
            demoFaultHighlightLayer = scadaWin.L.circle([c.lat, c.lon], {
                radius: 350,
                color: '#ef4444',
                fillColor: '#f97316',
                fillOpacity: 0.28,
                weight: 3
            }).addTo(scadaWin.__labeledLeafletMap).bindPopup(`⚡ จุดสงสัยฟอลต์จำลอง (${km} กม. / ${amp} A)`).openPopup();
            scadaWin.__labeledLeafletMap.flyTo([c.lat, c.lon], 15, { duration: 0.9 });
        }

        runGuidedAutoScrollSequence(scadaWin, [
            { selector: '#scadaFaultResultBox, #scadaFaultKmInput', delayMs: 120, block: 'center' },
            { selector: '#labeledInteractiveMap, #mapFullscreenContainer', delayMs: 2400, block: 'center' }
        ]);

        return {
            ok: true,
            simulationSandbox: true,
            circuit: chosenCircuit || 'วงจรหลักของสาขา',
            distanceKm: km,
            faultCurrentAmp: amp,
            weather,
            candidatesSummary: resultText || `ชี้เป้าพิกัดสงสัยฟอลต์ที่ระยะ ${km} กม. กระแส ${amp} A บนแผนที่สกาด้าเรียบร้อยแล้ว`,
            note: 'แสดงผลการจัดอันดับจุดสงสัย #1 #2 #3 และเลื่อนหน้าจอไปยังแผนที่ผังสกาด้าให้ชมแล้ว'
        };
    }

    async function handleDemoScadaSwitchSimulation(args) {
        const action = String(args?.action || 'open_switch').trim().toLowerCase();
        const kw = String(args?.deviceKeyword || '').trim().toLowerCase();

        const scadaWin = await ensureScadaMapWindowReady();
        if (!scadaWin || !scadaWin.document) {
            return { ok: false, error: 'ยังไม่สามารถเชื่อมต่อหน้าผังสกาด้าได้' };
        }

        if (action === 'exit_sim') {
            exitVoiceActivatedSimModeIfNeeded(scadaWin);
            return { ok: true, action: 'exit_sim', note: 'ออกจากโหมดจำลองสกาด้าและคืนค่าผังสายส่งสู่สถานะใช้งานจริงเรียบร้อยแล้ว' };
        }

        if (!scadaWin.PeaCore?.simSandbox?.active) {
            if (typeof scadaWin.toggleScadaSimMode === 'function') {
                scadaWin.toggleScadaSimMode(true);
                activatedSimByVoice = true;
            } else {
                const simBtn = scadaWin.document.getElementById('btnToggleScadaSimMode');
                if (simBtn) {
                    simBtn.click();
                    activatedSimByVoice = true;
                }
            }
            await new Promise(r => setTimeout(r, 220));
        }

        const pins = getBranchScadaPinsFromWin(scadaWin);
        if (pins.length === 0) {
            return {
                ok: true,
                simulationSandbox: true,
                noPinsYet: true,
                note: 'เปิดโหมดจำลองสกาด้าแล้ว (สาขานี้ยังไม่มีหมุดสกาด้าในระบบ สามารถอธิบายหลักการปลดสวิตช์และ Tie Backfeed ได้เลย)'
            };
        }

        const wantOpen = action !== 'close_switch';
        const desiredState = wantOpen ? 'open' : 'closed';

        let targetPin = null;
        if (kw) {
            targetPin = pins.find(p =>
                String(p.name || '').toLowerCase().includes(kw) ||
                String(p.scadaNode?.deviceCode || '').toLowerCase().includes(kw)
            );
        }
        if (!targetPin) {
            if (wantOpen) {
                targetPin = pins.find(p =>
                    p.scadaNode?.currentState !== 'open' &&
                    !/substation|source/i.test(p.scadaNode?.equipType || '')
                ) || pins[0];
            } else {
                targetPin = pins.find(p =>
                    p.scadaNode?.currentState === 'open' &&
                    (p.scadaNode?.normalState === 'open' || /tie/i.test(p.scadaNode?.equipType || '') || /tie/i.test(p.name || ''))
                ) || pins.find(p => p.scadaNode?.currentState === 'open') || pins[0];
            }
        }

        scrollElementSmoothlyInWin(scadaWin, '#labeledInteractiveMap, #mapFullscreenContainer', 'center');

        if (typeof scadaWin.focusSinglePinOnMap === 'function') {
            scadaWin.focusSinglePinOnMap(targetPin.id);
        } else if (scadaWin.__labeledLeafletMap) {
            const lat = parseFloat(targetPin.lat), lon = parseFloat(targetPin.lon);
            if (!isNaN(lat) && !isNaN(lon)) {
                scadaWin.__labeledLeafletMap.flyTo([lat, lon], 16, { duration: 0.8 });
            }
        }

        await new Promise(r => setTimeout(r, 350));

        if (typeof scadaWin.simulateSwitchStateChange === 'function') {
            scadaWin.simulateSwitchStateChange(targetPin.id, desiredState);
        } else if (typeof scadaWin.setScadaDeviceState === 'function') {
            scadaWin.setScadaDeviceState(targetPin.id, desiredState);
        } else if (typeof scadaWin.quickToggleScadaNodeState === 'function') {
            scadaWin.quickToggleScadaNodeState(targetPin.id, desiredState);
        } else if (scadaWin.PeaCore?.simSandbox?.active && scadaWin.localStorage) {
            try {
                const list = JSON.parse(scadaWin.localStorage.getItem('elec_labeled_places_list') || '[]');
                const found = list.find(x => x && x.id === targetPin.id);
                if (found && found.scadaNode) {
                    found.scadaNode.currentState = desiredState;
                    scadaWin.localStorage.setItem('elec_labeled_places_list', JSON.stringify(list));
                    scadaWin.renderLabeledPlacesList?.();
                    scadaWin.refreshScadaTopologyOnMap?.();
                }
            } catch (e) {}
        }

        await new Promise(r => setTimeout(r, 320));

        const mk = findLeafletMarkerForPin(scadaWin, scadaWin.__labeledLeafletMap, targetPin);
        try { mk?.openPopup?.(); } catch (e) {}

        const tieBox = scadaWin.document.getElementById('scadaTieAdvisorBox') || scadaWin.document.getElementById('tieAdvisorResultBox');
        const tieHint = tieBox ? tieBox.innerText.replace(/\s+/g, ' ').trim().slice(0, 380) : '';

        if (tieHint) {
            runGuidedAutoScrollSequence(scadaWin, [
                { selector: '#labeledInteractiveMap, #mapFullscreenContainer', delayMs: 100, block: 'center' },
                { selector: '#scadaTieAdvisorBox, #tieAdvisorResultBox', delayMs: 2800, block: 'center' },
                { selector: '#labeledInteractiveMap, #mapFullscreenContainer', delayMs: 6200, block: 'center' }
            ]);
        }

        return {
            ok: true,
            simulationSandbox: true,
            switchedDeviceName: targetPin.name || targetPin.scadaNode?.deviceCode || 'สวิตช์แรงสูง',
            newState: desiredState === 'open' ? 'OPEN (ปลดสวิตช์ตัดตอน)' : 'CLOSED (สับสวิตช์จ่ายไฟ)',
            tieAdvisorRecommendation: tieHint || 'อัปเดตสีเส้นทางไหลของกระแสไฟบนผังสกาด้าจำลองทันที',
            note: 'ดำเนินการในโหมดจำลอง (Sandbox) โดยไม่กระทบข้อมูลจริงของ กฟภ.'
        };
    }

    async function handleDemoPmOutageRadarStep(stepRaw) {
        const step = String(stepRaw || 'open_calendar').trim().toLowerCase();
        const grp = getActiveVoiceGroup();
        setDockMinimized(true);

        if (step === 'close_all') {
            closeVoiceOpenedPmAndRadarModals();
            return { ok: true, step: 'close_all', note: 'ปิดหน้าต่างสาธิตแผน PM และเรดาร์เรียบร้อยแล้ว' };
        }

        let activePlans = [];
        let radarPlans = [];
        try {
            const all = JSON.parse(rawGet('elec_pm_calendar_plans_v1') || '[]');
            activePlans = all.filter(p => p && !p.pmDeleted && normGroup(p.ownerGroup || 'กฟส.บึง') === grp && p.status !== 'done');
            radarPlans = activePlans.filter(p => p.pub && p.oz);
        } catch (e) {}

        if (step === 'open_calendar') {
            closePeaLivePublicRadarPreview();
            closeVoiceOpenedPmDraftOnly();
            window.openPmCalendarModal?.();
            await new Promise(r => setTimeout(r, 220));
            const calModal = document.getElementById('pmCalendarModal');
            if (calModal) {
                runGuidedAutoScrollSequence(window, [
                    { el: document.getElementById('pmCalendarDaysGrid'), delayMs: 180, block: 'center' },
                    { el: document.getElementById('pmSelectedDayTasksContainer'), delayMs: 2800, block: 'center' }
                ]);
            }
            return {
                ok: true,
                step: 'open_calendar',
                branchGroup: grp,
                activePmPlansCount: activePlans.length,
                activeRadarZonesCount: radarPlans.length,
                note: 'เปิดปฏิทินแผนงานบำรุงรักษา PM และเลื่อนชมรายการแผนดับไฟล่วงหน้าแล้ว'
            };
        }

        if (step === 'open_plan_form_preview') {
            closePeaLivePublicRadarPreview();
            window.openPmCalendarModal?.();
            await new Promise(r => setTimeout(r, 150));
            if (canEditPmAndScadaSafe() && typeof window.openPmPlanFormModal === 'function') {
                window.openPmPlanFormModal();
                await new Promise(r => setTimeout(r, 200));
                const formModal = document.getElementById('pmPlanFormModal');
                if (formModal) {
                    formModal.dataset.voiceDemoDraft = '1';
                    openedPmDraftByVoice = true;
                    const titleInp = document.getElementById('pmTitleInput');
                    if (titleInp && !titleInp.value) titleInp.value = DEMO_PM_DRAFT_TITLE;
                    runGuidedAutoScrollSequence(window, [
                        { el: titleInp || formModal, delayMs: 120, block: 'center' },
                        { selector: '#pmFormMiniMapWrap, #pmPubOutagePanel', delayMs: 2400, block: 'center' }
                    ]);
                }
                return { ok: true, step: 'open_plan_form_preview', note: 'เปิดฟอร์มสร้างแผนงาน PM พร้อมเลื่อนให้ชมแผนที่และสวิตช์เปิดเรดาร์แจ้งเตือนประชาชนแล้ว' };
            }
            return {
                ok: true,
                step: 'open_plan_form_readonly',
                activePmPlansCount: activePlans.length,
                note: 'แสดงภาพรวมแผนงาน PM ในปฏิทิน (สิทธิ์ผู้ชมจะไม่เปิดฟอร์มแก้ไขข้อมูลจริง)'
            };
        }

        if (step === 'preview_public_announce') {
            closePeaLivePublicRadarPreview();
            const firstPlan = radarPlans[0] || activePlans[0];
            if (firstPlan && typeof window.openPmPublicAnnounceModal === 'function') {
                window.openPmPublicAnnounceModal(firstPlan.id);
                await new Promise(r => setTimeout(r, 180));
                const annModal = document.getElementById('pmPublicAnnounceModal');
                if (annModal) {
                    annModal.style.zIndex = '1445';
                    runGuidedAutoScrollSequence(window, [
                        { el: document.getElementById('pmPublicAnnounceTextarea') || annModal, delayMs: 200, block: 'center' }
                    ]);
                }
                return {
                    ok: true,
                    step: 'preview_public_announce',
                    planTitle: firstPlan.title || 'แผนงาน PM',
                    publicRadarUrl: getPublicOutageRadarUrl(false),
                    note: 'เปิดหน้าต่างสร้างคำประกาศแจ้งไฟดับอัตโนมัติสำหรับโพสต์ Facebook และ LINE พร้อมลิงก์เรดาร์แล้ว'
                };
            }
            const sampleText = buildSampleAnnouncementTextForVoice(grp, 'facebook');
            return {
                ok: true,
                step: 'preview_public_announce_sample',
                sampleAnnouncement: sampleText,
                publicRadarUrl: getPublicOutageRadarUrl(false),
                note: 'สร้างข้อความตัวอย่างประชาสัมพันธ์แจ้งแผนดับไฟพร้อมแนบลิงก์เรดาร์ตรวจสอบพิกัดให้เรียบร้อยแล้ว'
            };
        }

        if (step === 'open_public_radar') {
            closeVoiceOpenedPmDraftOnly();
            openPeaLivePublicRadarPreview(radarPlans.length);
            return {
                ok: true,
                step: 'open_public_radar',
                branchGroup: grp,
                activeRadarZonesCount: radarPlans.length,
                publicRadarUrl: getPublicOutageRadarUrl(false),
                note: 'เปิดหน้าเว็บเรดาร์ตรวจสอบพื้นที่ไฟดับสำหรับประชาชน (outage-map.html) ขึ้นแสดงบนหน้าจอแล้ว ผู้ใช้ไฟกดเช็กพิกัด GPS บ้านตนเองได้ทันทีโดยไม่ต้องล็อกอิน'
            };
        }

        return { ok: true, summary: collectBranchLiveSummary() };
    }

    async function executeVoiceToolCall(name, args) {
        try {
            switch (name) {
                case 'getBranchLiveSummary':
                    return collectBranchLiveSummary();
                case 'navigateAppScreen':
                    return await handleNavigateAppScreen(args?.screen);
                case 'demoCalculate22kVFuse':
                    return await handleDemoCalculate22kVFuse(args);
                case 'demoScadaFaultSearch':
                    return await handleDemoScadaFaultSearch(args);
                case 'demoScadaSwitchSimulation':
                    return await handleDemoScadaSwitchSimulation(args);
                case 'demoPmOutageRadarStep':
                    return await handleDemoPmOutageRadarStep(args?.step);
                default:
                    return { ok: false, error: `ไม่รู้จักคำสั่ง ${name}` };
            }
        } catch (err) {
            return { ok: false, error: String(err?.message || err || 'เกิดข้อผิดพลาดขณะรันคำสั่งหน้าจอ') };
        }
    }

    // ========================================================================
    // 5. ระบบประมวลผลเสียงพูดสองทาง (16kHz Mic Input + 24kHz Gapless Output + Barge-in)
    // ========================================================================
    function pcmInt16ToBase64(int16Arr) {
        const bytes = new Uint8Array(int16Arr.buffer, int16Arr.byteOffset, int16Arr.byteLength);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(bin);
    }

    function base64ToInt16Array(b64) {
        const bin = atob(b64);
        const len = bin.length - (bin.length % 2);
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return new Int16Array(bytes.buffer);
    }

    function downsampleFloat32To16kInt16(float32Buf, inputRate) {
        if (inputRate === 16000) {
            const out = new Int16Array(float32Buf.length);
            for (let i = 0; i < float32Buf.length; i++) {
                const s = Math.max(-1, Math.min(1, float32Buf[i]));
                out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            return out;
        }
        const ratio = inputRate / 16000;
        const newLen = Math.max(1, Math.round(float32Buf.length / ratio));
        const out = new Int16Array(newLen);
        let offsetResult = 0;
        let offsetBuffer = 0;
        while (offsetResult < newLen) {
            const nextOffsetBuffer = Math.min(float32Buf.length, Math.round((offsetResult + 1) * ratio));
            let accum = 0, count = 0;
            for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
                accum += float32Buf[i];
                count++;
            }
            const sample = count > 0 ? Math.max(-1, Math.min(1, accum / count)) : 0;
            out[offsetResult] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            offsetResult++;
            offsetBuffer = nextOffsetBuffer;
        }
        return out;
    }

        function ensureOutputAudioContext() {
        if (!outputAudioCtx || outputAudioCtx.state === 'closed') {
            const AC = window.AudioContext || window.webkitAudioContext;
            try {
                outputAudioCtx = new AC({ sampleRate: 24000 });
            } catch (e) {
                outputAudioCtx = new AC();
            }
            nextPlayTimeSec = 0;
        }
        if (outputAudioCtx.state === 'suspended' || outputAudioCtx.state === 'interrupted') {
            outputAudioCtx.resume().catch(() => {});
        }
        return outputAudioCtx;
    }

    function stopAiAudioPlaybackImmediately() {
        activePlaybackSources.forEach(src => {
            try { src.onended = null; src.stop(0); src.disconnect(); } catch (e) {}
        });
        activePlaybackSources.clear();
        if (outputAudioCtx) {
            nextPlayTimeSec = outputAudioCtx.currentTime;
        } else {
            nextPlayTimeSec = 0;
        }
        isAiSpeakingNow = false;
        serverTurnCompletedWhilePlaying = false;
        if (playbackIdleWatchdogTimer) {
            clearTimeout(playbackIdleWatchdogTimer);
            playbackIdleWatchdogTimer = null;
        }
        updateVoiceDockStatusUI();
    }

    function scheduleAiPcmChunk(base64Pcm, sampleRate = 24000) {
        if (!isUserSessionActive || Date.now() < bargeInHoldUntilMs) return;
        const ctx = ensureOutputAudioContext();
        const int16 = base64ToInt16Array(base64Pcm);
        if (!int16.length) return;

        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768.0;
        }

        const audioBuf = ctx.createBuffer(1, float32.length, sampleRate);
        audioBuf.getChannelData(0).set(float32);

        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(ctx.destination);

        const now = ctx.currentTime;
        if (nextPlayTimeSec < now + 0.015) {
            nextPlayTimeSec = now + 0.03;
        }
        src.start(nextPlayTimeSec);
        nextPlayTimeSec += audioBuf.duration;

        activePlaybackSources.add(src);
        if (!isAiSpeakingNow) {
            isAiSpeakingNow = true;
            updateVoiceDockStatusUI();
        }

        src.onended = () => {
            activePlaybackSources.delete(src);
            if (activePlaybackSources.size === 0) {
                if (playbackIdleWatchdogTimer) clearTimeout(playbackIdleWatchdogTimer);
                playbackIdleWatchdogTimer = setTimeout(() => {
                    if (activePlaybackSources.size === 0 && !isServerTurnGenerating) {
                        isAiSpeakingNow = false;
                        serverTurnCompletedWhilePlaying = false;
                        updateVoiceDockStatusUI();
                        maybePerformPendingGoAwaySwap();
                    }
                }, 140);
            }
        };
    }

    async function initMicrophonePipeline() {
        if (micInitPromise) return micInitPromise;
        micInitPromise = (async () => {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('เบราว์เซอร์นี้ไม่รองรับการเปิดไมโครโฟนผ่านเว็บ (ต้องเปิดผ่าน HTTPS หรือ localhost)');
            }
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1
                }
            });

            micStream.getAudioTracks().forEach(track => {
                track.onended = () => {
                    if (isUserSessionActive && Date.now() - lastTrackRecoveryAtMs > 2500) {
                        lastTrackRecoveryAtMs = Date.now();
                        teardownMicrophonePipeline();
                        initMicrophonePipeline().catch(() => {});
                    }
                };
            });

            const AC = window.AudioContext || window.webkitAudioContext;
            inputAudioCtx = new AC();
            if (inputAudioCtx.state === 'suspended') {
                await inputAudioCtx.resume().catch(() => {});
            }

            micSourceNode = inputAudioCtx.createMediaStreamSource(micStream);
            micProcessorNode = inputAudioCtx.createScriptProcessor(2048, 1, 1);

            micProcessorNode.onaudioprocess = (ev) => {
                if (!isUserSessionActive || isMicMuted) {
                    currentMicLevel = 0;
                    return;
                }
                const inputData = ev.inputBuffer.getChannelData(0);
                let sumSq = 0;
                for (let i = 0; i < inputData.length; i++) {
                    sumSq += inputData[i] * inputData[i];
                }
                const rms = Math.sqrt(sumSq / inputData.length);
                currentMicLevel = Math.min(1, rms * 7.5);

                const chunkDurationMs = (inputData.length / inputAudioCtx.sampleRate) * 1000;
                const echoThreshold = isAiSpeakingNow ? SPEAKER_ECHO_GATE_RMS : 0.014;

                if (rms >= echoThreshold) {
                    lastUserSpeechAtMs = Date.now();
                    if (isAiSpeakingNow) {
                        bargeInSpeechMs += chunkDurationMs;
                        if (bargeInSpeechMs >= BARGE_IN_MIN_MS) {
                            bargeInSpeechMs = 0;
                            bargeInHoldUntilMs = Date.now() + 260;
                            stopAiAudioPlaybackImmediately();
                            stopVoiceAutoScroll();
                        }
                    }
                } else {
                    bargeInSpeechMs = Math.max(0, bargeInSpeechMs - chunkDurationMs * 0.5);
                }

                const pcm16 = downsampleFloat32To16kInt16(inputData, inputAudioCtx.sampleRate);
                const b64 = pcmInt16ToBase64(pcm16);
                const realtimeBody = isLegacy20LiveModel(activeConnectedModel)
                    ? { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: b64 }] }
                    : { audio: { mimeType: 'audio/pcm;rate=16000', data: b64 } };
                const payload = JSON.stringify({ realtimeInput: realtimeBody });

                if (liveWs && liveWs.readyState === WebSocket.OPEN && isLiveConnected) {
                    try { liveWs.send(payload); } catch (e) {}
                } else if (isReconnecting || isLiveConnecting) {
                    handoverAudioRingBuffer.push(payload);
                    if (handoverAudioRingBuffer.length > 18) handoverAudioRingBuffer.shift();
                }
            };

            const muteGain = inputAudioCtx.createGain();
            muteGain.gain.value = 0;
            micSourceNode.connect(micProcessorNode);
            micProcessorNode.connect(muteGain);
            muteGain.connect(inputAudioCtx.destination);
        })();

        try {
            await micInitPromise;
        } finally {
            micInitPromise = null;
        }
    }

    function teardownMicrophonePipeline() {
        currentMicLevel = 0;
        try { micProcessorNode?.disconnect(); } catch (e) {}
        try { micSourceNode?.disconnect(); } catch (e) {}
        micProcessorNode = null;
        micSourceNode = null;
        if (micStream) {
            micStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
            micStream = null;
        }
        if (inputAudioCtx && inputAudioCtx.state !== 'closed') {
            try { inputAudioCtx.close(); } catch (e) {}
        }
        inputAudioCtx = null;
    }

    // ========================================================================
    // 6. การเชื่อมต่อ Gemini Live WebSocket, Auto-Failover & Seamless Resumption
    // ========================================================================
    function maybePerformPendingGoAwaySwap() {
        if (!pendingGoAwayReconnect || !isUserSessionActive) return;
        if (pendingToolCallCount > 0 || isAiSpeakingNow || isServerTurnGenerating) return;
        pendingGoAwayReconnect = false;
        seamlessRenewCount++;
        reconnectLiveSessionSeamlessly('goaway_idle_swap');
    }

    function sendClientTextPrompt(promptText) {
        const clean = String(promptText || '').trim();
        if (!clean) return;
        if (!liveWs || liveWs.readyState !== WebSocket.OPEN || !isLiveConnected) {
            pendingTopicCueAfterConnect = clean;
            return;
        }
        textCueSeq++;
        stopAiAudioPlaybackImmediately();
        try {
            liveWs.send(JSON.stringify({
                clientContent: {
                    turns: [{ role: 'user', parts: [{ text: clean }] }],
                    turnComplete: true
                }
            }));
        } catch (e) {}
    }

    function buildAutoFullPresentationPrompt() {
        const grp = getActiveVoiceGroup();
        return [
            `สวัสดีค่ะน้องพีอา ช่วยพรีเซนต์สาธิตระบบเครื่องมือจัดการงานไฟฟ้าของ "${grp}" แบบครบวงจรให้ผู้บริหารและทีมงานชมหน่อยค่ะ`,
            `ให้เรียกเครื่องมือสลับหน้าจอและสาธิตทีละส่วนดังนี้:`,
            `1) ดึงข้อมูลจริงด้วย getBranchLiveSummary แล้วทักทายเปิดงานอย่างน่าประทับใจ`,
            `2) เปิดแท็บ 1 รายงานเหตุ TR/TL ด้วย navigateAppScreen("fault_form") อธิบายการเก็บกระแสลัดวงจร พิกัด GPS และเรดาร์น้ำฝน Rain Alarm`,
            `3) เปิดแท็บ 2 รับแจ้งขัดข้อง ด้วย navigateAppScreen("outage_form") อธิบายผู้ช่วยแชตบอท AI และระบบวางข้อมูลเช็กเลข CA 12 หลักค้างจ่ายอัตโนมัติ`,
            `4) สาธิตแท็บ 3 คำนวณฟิวส์เมน 22kV ด้วย demoCalculate22kVFuse(160)`,
            `5) เปิดแท็บ 4 แดชบอร์ดสถิติกราฟ ด้วย navigateAppScreen("dashboard_stats")`,
            `6) สาธิตค้นหาจุดฟอลต์บนผังสกาด้าจำลอง demoScadaFaultSearch(ระยะ 4.2 กม. กระแส 1850 แอมป์)`,
            `7) สาธิตสับสวิตช์จำลองตัดตอนและจ่ายไฟย้อนด้วย demoScadaSwitchSimulation("open_switch") และ ("close_switch")`,
            `8) ปิดท้ายด้วยแผนงาน PM และเปิดหน้าเว็บเรดาร์ตรวจสอบไฟดับสำหรับประชาชน demoPmOutageRadarStep("open_public_radar")`
        ].join(' ');
    }

    async function handleIncomingWsMessage(rawData, myEpoch, wsRef) {
        if (myEpoch !== sessionEpoch || wsRef._peaDisposed) return;
        let textJson = '';
        if (typeof rawData === 'string') {
            textJson = rawData;
        } else if (rawData instanceof Blob) {
            const buf = await rawData.arrayBuffer();
            textJson = utf8Decoder ? utf8Decoder.decode(buf) : String.fromCharCode.apply(null, new Uint8Array(buf));
        } else if (rawData instanceof ArrayBuffer) {
            textJson = utf8Decoder ? utf8Decoder.decode(rawData) : String.fromCharCode.apply(null, new Uint8Array(rawData));
        }
        if (!textJson) return;

        let msg = null;
        try { msg = JSON.parse(textJson); } catch (e) { return; }
        if (!msg || myEpoch !== sessionEpoch) return;

        if (msg.setupComplete !== undefined) {
            isLiveConnected = true;
            isLiveConnecting = false;
            isReconnecting = false;
            reconnectAttemptCount = 0;
            updateVoiceDockStatusUI();

            while (handoverAudioRingBuffer.length > 0 && liveWs?.readyState === WebSocket.OPEN) {
                try { liveWs.send(handoverAudioRingBuffer.shift()); } catch (e) { break; }
            }

            if (pendingAutoPresentAfterConnect) {
                pendingAutoPresentAfterConnect = false;
                pendingTopicCueAfterConnect = '';
                setDockMinimized(true);
                setTimeout(() => sendClientTextPrompt(buildAutoFullPresentationPrompt()), 220);
            } else if (pendingTopicCueAfterConnect) {
                const cue = pendingTopicCueAfterConnect;
                pendingTopicCueAfterConnect = '';
                setTimeout(() => sendClientTextPrompt(cue), 200);
            } else if (seamlessRenewCount === 0 && !loadValidResumptionState(activeConnectedModel)) {
                setTimeout(() => {
                    if (isLiveConnected && myEpoch === sessionEpoch) {
                        sendClientTextPrompt(`ทักทายสั้นๆ แนะนำตัวว่าเป็นน้องพีอา ผู้ช่วย AI ประจำ ${getActiveVoiceGroup()} พร้อมช่วยบรรยายพรีเซนต์และสาธิตระบบค่ะ`);
                    }
                }, 220);
            }
            return;
        }

        if (msg.sessionResumptionUpdate) {
            const upd = msg.sessionResumptionUpdate;
            if (upd.newHandle && upd.resumable !== false) {
                saveResumptionHandleState(upd.newHandle, activeConnectedModel);
            }
        }

        if (msg.goAway) {
            pendingGoAwayReconnect = true;
            if (goAwaySwapTimer) clearTimeout(goAwaySwapTimer);
            goAwaySwapTimer = setTimeout(() => {
                if (pendingGoAwayReconnect && isUserSessionActive) {
                    pendingGoAwayReconnect = false;
                    reconnectLiveSessionSeamlessly('goaway_deadline');
                }
            }, 6500);
            maybePerformPendingGoAwaySwap();
        }

        if (msg.toolCallCancellation) {
            turnInterruptionSeq++;
        }

        if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
            const calls = msg.toolCall.functionCalls;
            const callInterruptSnapshot = turnInterruptionSeq;
            pendingToolCallCount += calls.length;
            updateVoiceDockStatusUI();

            toolCallChain = toolCallChain.then(async () => {
                const responses = [];
                try {
                    for (const fc of calls) {
                        if (myEpoch !== sessionEpoch) return;
                        if (PRESENTATION_SYNC_TOOLS.has(fc.name) && callInterruptSnapshot !== turnInterruptionSeq && Date.now() - lastUserSpeechAtMs < POST_TURN_BARGE_WINDOW_MS) {
                            responses.push({ id: fc.id, name: fc.name, result: { skipped: true, reason: 'user_interrupted' } });
                            continue;
                        }
                        const res = await executeVoiceToolCall(fc.name, fc.args || {});
                        responses.push({ id: fc.id, name: fc.name, result: res });
                    }
                    if (myEpoch === sessionEpoch && liveWs && liveWs.readyState === WebSocket.OPEN && responses.length > 0) {
                        liveWs.send(JSON.stringify({
                            toolResponse: {
                                functionResponses: responses.map(r => ({
                                    id: r.id,
                                    name: r.name,
                                    response: { result: r.result }
                                }))
                            }
                        }));
                    }
                } finally {
                    pendingToolCallCount = Math.max(0, pendingToolCallCount - calls.length);
                    updateVoiceDockStatusUI();
                    maybePerformPendingGoAwaySwap();
                }
            }).catch(() => {
                pendingToolCallCount = Math.max(0, pendingToolCallCount - calls.length);
            });
        }

        if (msg.serverContent) {
            const sc = msg.serverContent;
            if (sc.interrupted) {
                turnInterruptionSeq++;
                stopAiAudioPlaybackImmediately();
                stopVoiceAutoScroll();
                return;
            }
            if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
                isServerTurnGenerating = true;
                for (const part of sc.modelTurn.parts) {
                    const inl = part?.inlineData;
                    if (inl?.data && String(inl.mimeType || '').startsWith('audio/pcm')) {
                        const rateMatch = String(inl.mimeType || '').match(/rate=(\d+)/i);
                        const rate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
                        scheduleAiPcmChunk(inl.data, rate || 24000);
                    }
                }
            }
            if (sc.turnComplete) {
                isServerTurnGenerating = false;
                if (activePlaybackSources.size === 0) {
                    isAiSpeakingNow = false;
                    updateVoiceDockStatusUI();
                    maybePerformPendingGoAwaySwap();
                } else {
                    serverTurnCompletedWhilePlaying = true;
                }
            }
        }
    }

    function connectSingleModelAttempt(apiKey, modelName, myEpoch) {
        return new Promise((resolve, reject) => {
            const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;
            const ws = new WebSocket(wsUrl);
            let settled = false;

            const setupTimeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    disposeWebSocketCleanly(ws, 'setup_timeout');
                    reject(new Error(`หมดเวลาเชื่อมต่อโมเดล ${modelName}`));
                }
            }, 9000);

            ws.onopen = () => {
                if (myEpoch !== sessionEpoch || ws._peaDisposed) {
                    clearTimeout(setupTimeout);
                    disposeWebSocketCleanly(ws, 'stale_epoch');
                    return;
                }
                const setupObj = {
                    model: modelName,
                    generationConfig: {
                        responseModalities: ['AUDIO'],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: { voiceName: selectedFemaleVoice }
                            }
                        }
                    },
                    systemInstruction: {
                        parts: [{ text: buildPeaSystemInstruction() }]
                    },
                    tools: buildVoiceToolsDeclaration()
                };

                if (!isLegacy20LiveModel(modelName)) {
                    setupObj.contextWindowCompression = { slidingWindow: {} };
                    const resume = loadValidResumptionState(modelName);
                    setupObj.sessionResumption = resume?.handle ? { handle: resume.handle } : {};
                }

                try {
                    ws.send(JSON.stringify({ setup: setupObj }));
                } catch (err) {
                    clearTimeout(setupTimeout);
                    settled = true;
                    reject(err);
                }
            };

            ws.onmessage = async (ev) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(setupTimeout);
                    liveWs = ws;
                    activeConnectedModel = modelName;
                    resolve(ws);
                }
                await handleIncomingWsMessage(ev.data, myEpoch, ws);
            };

            ws.onerror = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(setupTimeout);
                    disposeWebSocketCleanly(ws, 'ws_error');
                    reject(new Error(`เชื่อมต่อ WebSocket ไม่สำเร็จ (${modelName})`));
                }
            };

            ws.onclose = (ev) => {
                clearTimeout(setupTimeout);
                const reasonStr = String(ev?.reason || '');
                if (!settled) {
                    settled = true;
                    const err = new Error(reasonStr || `ปิดการเชื่อมต่อ (${ev?.code || 0})`);
                    err.wsCloseCode = ev?.code;
                    err.wsReason = reasonStr;
                    reject(err);
                    return;
                }
                if (ws._peaDisposed || myEpoch !== sessionEpoch || !isUserSessionActive) return;

                isLiveConnected = false;
                updateVoiceDockStatusUI();

                const cls = classifyWsServerErrorReason(reasonStr);
                if (cls.isInvalidKey) {
                    stopPeaLiveVoiceSession(true);
                    safeToast('❌ Gemini API Key ไม่ถูกต้องหรือหมดอายุ กรุณาตรวจสอบคีย์ประจำกลุ่ม');
                    openKeySetupModalFallback();
                    return;
                }
                if (/session.*not.*found|invalid.*handle|resumption/i.test(reasonStr)) {
                    clearResumptionHandleState();
                }
                reconnectLiveSessionSeamlessly('unexpected_close');
            };
        });
    }

    function reconnectLiveSessionSeamlessly(reason = 'auto') {
        if (!isUserSessionActive) return;
        if (reconnectAttemptCount >= MAX_AUTO_RECONNECT_ATTEMPTS) {
            stopPeaLiveVoiceSession(true);
            safeToast('⚠️ สัญญาณเสียงสดขาดช่วงเกินกำหนด กรุณาแตะเริ่มคุยใหม่อีกครั้งค่ะ');
            return;
        }
        reconnectAttemptCount++;
        isReconnecting = true;
        isLiveConnected = false;
        updateVoiceDockStatusUI();

        if (reconnectTimer) clearTimeout(reconnectTimer);
        const delay = reason.startsWith('goaway') ? 120 : Math.min(4500, 500 * Math.pow(1.6, reconnectAttemptCount - 1));
        reconnectTimer = setTimeout(() => {
            if (!isUserSessionActive) return;
            openLiveSessionWithFailover(getGroupApiKey(), sessionEpoch).catch(() => {});
        }, delay);
    }

    async function openLiveSessionWithFailover(apiKey, myEpoch) {
        isLiveConnecting = true;
        updateVoiceDockStatusUI();

        const keyTag = String(apiKey || '').slice(-10);
        const candidates = await resolveLiveModelsForKey(apiKey);
        let lastErr = null;

        for (const modelName of candidates) {
            if (myEpoch !== sessionEpoch || !isUserSessionActive) return;
            try {
                if (liveWs) disposeWebSocketCleanly(liveWs, 'switching_model');
                await connectSingleModelAttempt(apiKey, modelName, myEpoch);
                return;
            } catch (err) {
                lastErr = err;
                const cls = classifyWsServerErrorReason(err?.wsReason || err?.message || '');
                if (cls.isInvalidKey || err?.isInvalidKey) {
                    stopPeaLiveVoiceSession(true);
                    safeToast('❌ Gemini API Key ไม่ถูกต้องหรือถูกจำกัดสิทธิ์');
                    openKeySetupModalFallback();
                    throw err;
                }
                if (cls.isModelNotFound) {
                    unsupportedLiveModels.add(`${keyTag}:${modelName}`);
                    continue;
                }
                if (/resumption|handle/i.test(String(err?.wsReason || ''))) {
                    clearResumptionHandleState();
                    try {
                        await connectSingleModelAttempt(apiKey, modelName, myEpoch);
                        return;
                    } catch (e2) {
                        lastErr = e2;
                    }
                }
            }
        }

        isLiveConnecting = false;
        updateVoiceDockStatusUI();
        throw lastErr || new Error('ไม่พบโมเดล Gemini Live ที่พร้อมใช้งานในขณะนี้');
    }

    // ========================================================================
    // 7. ฟังก์ชันควบคุมหลัก & UI Floating Dock (ซ่อนอัตโนมัติทั้งหน้า Login หลักและช่าง)
    // ========================================================================
    async function startPeaLiveVoiceSession(options = {}) {
        const apiKey = getGroupApiKey();
        if (!apiKey) {
            safeToast(`🔑 กรุณาตั้งค่า Gemini API Key ประจำกลุ่ม (${getActiveVoiceGroup()}) ก่อนเริ่มคุยสดค่ะ`);
            openKeySetupModalFallback();
            return;
        }

        lastKnownGroupApiKey = apiKey;
        if (options.autoFullPresent) {
            pendingAutoPresentAfterConnect = true;
        } else if (options.initialTopic) {
            pendingTopicCueAfterConnect = String(options.initialTopic);
        }

        if (isUserSessionActive && (isLiveConnected || isLiveConnecting)) {
            if (pendingAutoPresentAfterConnect) {
                pendingAutoPresentAfterConnect = false;
                setDockMinimized(true);
                sendClientTextPrompt(buildAutoFullPresentationPrompt());
            } else if (pendingTopicCueAfterConnect) {
                const t = pendingTopicCueAfterConnect;
                pendingTopicCueAfterConnect = '';
                sendClientTextPrompt(t);
            }
            return;
        }

        sessionEpoch++;
        const myEpoch = sessionEpoch;
        isUserSessionActive = true;
        isMicMuted = false;
        reconnectAttemptCount = 0;
        seamlessRenewCount = 0;
        ensureOutputAudioContext();
        updateVoiceDockStatusUI();

        try {
            await initMicrophonePipeline();
            if (myEpoch !== sessionEpoch || !isUserSessionActive) return;
            await openLiveSessionWithFailover(apiKey, myEpoch);
            startVisualizerLoop();
        } catch (err) {
            if (myEpoch === sessionEpoch) {
                stopPeaLiveVoiceSession(true);
                if (!err?.isInvalidKey) {
                    safeToast(`⚠️ เริ่มระบบเสียงสดไม่สำเร็จ: ${err?.message || 'กรุณาลองใหม่อีกครั้ง'}`);
                }
            }
        }
    }

    function stopPeaLiveVoiceSession(silent = false) {
        sessionEpoch++;
        isUserSessionActive = false;
        isLiveConnected = false;
        isLiveConnecting = false;
        isReconnecting = false;
        pendingGoAwayReconnect = false;
        pendingAutoPresentAfterConnect = false;
        pendingTopicCueAfterConnect = '';
        pendingToolCallCount = 0;
        isServerTurnGenerating = false;
        handoverAudioRingBuffer.length = 0;

        [reconnectTimer, restartSessionTimer, goAwaySwapTimer, playbackIdleWatchdogTimer, frozenAudioCheckTimer].forEach(t => {
            if (t) clearTimeout(t);
        });
        reconnectTimer = restartSessionTimer = goAwaySwapTimer = playbackIdleWatchdogTimer = frozenAudioCheckTimer = null;

        stopVoiceAutoScroll();
        stopAiAudioPlaybackImmediately();
        teardownMicrophonePipeline();

        if (liveWs) {
            disposeWebSocketCleanly(liveWs, 'user_stopped');
            liveWs = null;
        }
        if (visualizerAnimId) {
            cancelAnimationFrame(visualizerAnimId);
            visualizerAnimId = null;
        }

        exitVoiceActivatedSimModeIfNeeded();
        restoreTab1DemoBackupIfNeeded();
        closeVoiceOpenedPmDraftOnly();

        updateVoiceDockStatusUI();
        if (!silent) safeToast('🛑 จบการสนทนาเสียงสดและคืนค่าหน้าจอเรียบร้อยแล้วค่ะ');
    }

    function togglePeaLiveMicMute() {
        if (!isUserSessionActive) {
            startPeaLiveVoiceSession();
            return;
        }
        isMicMuted = !isMicMuted;
        if (isMicMuted && liveWs && liveWs.readyState === WebSocket.OPEN && isLiveConnected && !isLegacy20LiveModel(activeConnectedModel)) {
            try { liveWs.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch (e) {}
        }
        updateVoiceDockStatusUI();
        safeToast(isMicMuted ? '🔇 ปิดไมค์ชั่วคราว (น้องพีอายังบรรยายต่อได้ค่ะ)' : '🎙️ เปิดไมค์รับเสียงพูดแล้วค่ะ');
    }

    function switchPeaFemaleVoice(voiceId) {
        if (!FEMALE_VOICE_PROFILES[voiceId] || voiceId === selectedFemaleVoice) return;
        selectedFemaleVoice = voiceId;
        try { localStorage.setItem(VOICE_PREF_STORAGE_KEY, voiceId); } catch (e) {}
        clearResumptionHandleState();
        updateVoiceDockStatusUI();

        if (isUserSessionActive) {
            safeToast(`🌸 สลับเป็นเสียง ${FEMALE_VOICE_PROFILES[voiceId].label} กำลังเชื่อมต่อใหม่...`);
            if (liveWs) disposeWebSocketCleanly(liveWs, 'switch_voice');
            isLiveConnected = false;
            openLiveSessionWithFailover(getGroupApiKey(), sessionEpoch).catch(() => {});
        }
    }

    function sendPeaVoiceQuickTopic(topicPrompt, minimizeAfter = true) {
        if (minimizeAfter) setDockMinimized(true);
        if (!isUserSessionActive) {
            startPeaLiveVoiceSession({ initialTopic: topicPrompt });
            return;
        }
        sendClientTextPrompt(topicPrompt);
    }

    function startPeaAutoFullPresentation() {
        setDockMinimized(true);
        if (!isUserSessionActive) {
            startPeaLiveVoiceSession({ autoFullPresent: true });
            return;
        }
        sendClientTextPrompt(buildAutoFullPresentationPrompt());
    }

    function clearPeaVoiceConversationMemory() {
        clearResumptionHandleState();
        safeToast('🧹 ล้างความจำบทสนทนาเดิมเรียบร้อยแล้วค่ะ');
    }

    function setDockMinimized(minimized) {
        isDockMinimized = Boolean(minimized);
        const panel = document.getElementById('peaVoiceExpandedCard');
        const fabWrap = document.getElementById('peaVoiceFloatingBar');
        if (panel) panel.classList.toggle('hidden', isDockMinimized);
        if (fabWrap) fabWrap.classList.toggle('hidden', !isDockMinimized);
        updateVoiceDockStatusUI();
    }

    function togglePeaLiveVoiceDock() {
        setDockMinimized(!isDockMinimized);
    }

    function updateMemoryBadgeUI() {
        const el = document.getElementById('peaVoiceMemBadge');
        if (!el) return;
        const hasMem = Boolean(loadValidResumptionState());
        el.textContent = hasMem ? '🧠 จำบทสนทนาต่อเนื่อง' : '✨ เซสชันใหม่';
    }

    function startVisualizerLoop() {
        if (visualizerAnimId) cancelAnimationFrame(visualizerAnimId);
        const tick = () => {
            if (!isUserSessionActive) return;
            const bars = document.querySelectorAll('.pea-voice-wave-bar');
            const activeLvl = isAiSpeakingNow ? (0.35 + Math.random() * 0.6) : currentMicLevel;
            bars.forEach((b, idx) => {
                const h = Math.max(4, Math.min(22, Math.round(4 + activeLvl * 18 * ((idx % 3 + 1) / 2.2))));
                b.style.height = `${h}px`;
            });
            visualizerAnimId = requestAnimationFrame(tick);
        };
        visualizerAnimId = requestAnimationFrame(tick);
    }

    function updateVoiceDockStatusUI() {
        const grpEl = document.getElementById('peaVoiceGroupLabel');
        if (grpEl) grpEl.textContent = getActiveVoiceGroup();

        const statusBadge = document.getElementById('peaVoiceStatusText');
        const miniStatus = document.getElementById('peaVoiceMiniStatusText');
        const mainBtn = document.getElementById('peaVoiceMainActionBtn');
        const muteBtn = document.getElementById('peaVoiceMuteBtn');
        const miniStopBtn = document.getElementById('peaVoiceMiniStopBtn');
        const miniMuteBtn = document.getElementById('peaVoiceMiniMuteBtn');
        const dotEl = document.getElementById('peaVoiceLiveDot');

        let statusStr = 'พร้อมเป็นผู้ช่วยบรรยาย & สาธิตระบบ';
        let miniStr = '🎙️ ผู้ช่วย AI พรีเซนต์';
        if (isLiveConnecting || isReconnecting) {
            statusStr = isReconnecting ? '🔄 กำลังต่อสัญญาณเสียงอัตโนมัติ...' : '⏳ กำลังเชื่อมต่อน้องพีอา...';
            miniStr = '⏳ กำลังเชื่อมต่อ...';
        } else if (isLiveConnected) {
            if (pendingToolCallCount > 0) {
                statusStr = '⚡ กำลังสลับหน้าจอ & เลื่อนโชว์ข้อมูล...';
                miniStr = '⚡ กำลังบังคับหน้าจอ...';
            } else if (isAiSpeakingNow) {
                statusStr = '🌸 น้องพีอากำลังบรรยาย (พูดแทรกได้ทันที)';
                miniStr = '🌸 กำลังบรรยายสด...';
            } else if (isMicMuted) {
                statusStr = '🔇 ปิดไมค์ชั่วคราว';
                miniStr = '🔇 ปิดไมค์อยู่';
            } else {
                statusStr = '🎤 กำลังฟังคุณอยู่ค่ะ พูดสั่งงานได้เลย';
                miniStr = '🎤 กำลังฟัง...';
            }
        }

        if (statusBadge) statusBadge.textContent = statusStr;
        if (miniStatus) miniStatus.textContent = miniStr;

        if (dotEl) {
            dotEl.className = isLiveConnected
                ? 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping shrink-0'
                : (isLiveConnecting ? 'w-2.5 h-2.5 rounded-full bg-amber-300 animate-pulse shrink-0' : 'w-2.5 h-2.5 rounded-full bg-rose-200 shrink-0');
        }

        if (mainBtn) {
            if (isUserSessionActive) {
                mainBtn.textContent = '⏹️ จบการสนทนา / คืนค่าหน้าจอ';
                mainBtn.className = 'w-full py-2.5 px-4 rounded-2xl font-extrabold text-xs sm:text-sm text-white bg-rose-600 hover:bg-rose-700 shadow-lg transition';
                mainBtn.onclick = () => stopPeaLiveVoiceSession(false);
            } else {
                mainBtn.textContent = '🎙️ เริ่มคุยสดกับน้องพีอา (Gemini Live)';
                mainBtn.className = 'w-full py-2.5 px-4 rounded-2xl font-extrabold text-xs sm:text-sm text-slate-950 bg-gradient-to-r from-amber-300 via-yellow-300 to-amber-400 hover:brightness-105 shadow-lg transition';
                mainBtn.onclick = () => startPeaLiveVoiceSession();
            }
        }

        if (muteBtn) {
            muteBtn.classList.toggle('hidden', !isUserSessionActive);
            muteBtn.textContent = isMicMuted ? '🔇 เปิดไมค์' : '🎙️ ปิดไมค์';
        }
        if (miniStopBtn) miniStopBtn.classList.toggle('hidden', !isUserSessionActive);
        if (miniMuteBtn) {
            miniMuteBtn.classList.toggle('hidden', !isUserSessionActive);
            miniMuteBtn.textContent = isMicMuted ? '🔇' : '🎙️';
        }

        document.querySelectorAll('[data-pea-voice-opt]').forEach(btn => {
            const active = btn.getAttribute('data-pea-voice-opt') === selectedFemaleVoice;
            btn.className = active
                ? 'flex-1 py-1.5 px-2 rounded-xl text-[11px] font-extrabold bg-pink-500 text-white shadow border border-pink-300'
                : 'flex-1 py-1.5 px-2 rounded-xl text-[11px] font-bold bg-white/10 text-slate-200 hover:bg-white/20 border border-white/15';
        });

        updateMemoryBadgeUI();
    }

    function injectPeaLiveVoiceDockUI() {
        if (document.getElementById('peaLiveVoiceDock')) return;
        isDockMinimized = true;

        // ซ่อนปุ่มลอยอัตโนมัติระหว่างหน้า Splash สายฟ้าสีทองและหน้า Login ทั้งใน index.html และ page2.html
        if (!document.getElementById('peaLiveVoiceGuardStyle')) {
            const st = document.createElement('style');
            st.id = 'peaLiveVoiceGuardStyle';
            st.textContent = `
                body:has(#loginScreen:not(.hidden)) #peaLiveVoiceDock,
                body:has(#techLoginScreen:not(.hidden)) #peaLiveVoiceDock,
                body:has(#peaBootSplash:not(.splash-hide)) #peaLiveVoiceDock {
                    display: none !important;
                }
            `;
            document.head.appendChild(st);
        }

        const dock = document.createElement('div');
        dock.id = 'peaLiveVoiceDock';
        dock.className = 'fixed bottom-3 right-3 z-[1460] max-w-[calc(100vw-1.25rem)] select-none';
        dock.innerHTML = `
            <div id="peaVoiceFloatingBar" class="flex items-center gap-1.5 bg-gradient-to-r from-fuchsia-700 via-rose-600 to-indigo-800 text-white px-3 py-2 rounded-full shadow-2xl border-2 border-white/40 backdrop-blur-md">
                <button type="button" onclick="togglePeaLiveVoiceDock()" class="flex items-center gap-2 text-left min-w-0">
                    <span id="peaVoiceLiveDot" class="w-2.5 h-2.5 rounded-full bg-rose-200 shrink-0"></span>
                    <span id="peaVoiceMiniStatusText" class="text-xs font-extrabold truncate max-w-[165px]">🎙️ ผู้ช่วย AI พรีเซนต์</span>
                    <span class="flex items-end gap-0.5 h-4 px-0.5">
                        <span class="pea-voice-wave-bar w-1 bg-amber-300 rounded-full transition-all" style="height:5px"></span>
                        <span class="pea-voice-wave-bar w-1 bg-pink-200 rounded-full transition-all" style="height:8px"></span>
                        <span class="pea-voice-wave-bar w-1 bg-amber-300 rounded-full transition-all" style="height:5px"></span>
                    </span>
                </button>
                <button id="peaVoiceMiniMuteBtn" type="button" onclick="togglePeaLiveMicMute()" title="สลับไมค์" class="hidden w-7 h-7 rounded-full bg-white/20 hover:bg-white/30 text-xs font-extrabold flex items-center justify-center">🎙️</button>
                <button id="peaVoiceMiniStopBtn" type="button" onclick="stopPeaLiveVoiceSession(false)" title="จบการสนทนา" class="hidden px-2 py-1 rounded-full bg-rose-950/80 hover:bg-rose-900 text-[10px] font-extrabold border border-rose-300/50">หยุด</button>
            </div>

            <div id="peaVoiceExpandedCard" class="hidden w-[340px] sm:w-[370px] max-w-[calc(100vw-1.25rem)] bg-slate-900/95 text-white rounded-3xl shadow-2xl border-2 border-pink-400/60 backdrop-blur-xl overflow-hidden">
                <div class="px-4 py-3 bg-gradient-to-r from-fuchsia-700 via-pink-600 to-indigo-800 flex items-center justify-between gap-2">
                    <div class="min-w-0">
                        <div class="flex items-center gap-1.5">
                            <span class="text-sm font-extrabold truncate">🌸 น้องพีอา AI Presenter</span>
                            <span id="peaVoiceGroupLabel" class="text-[10px] font-extrabold bg-black/30 text-amber-300 px-2 py-0.5 rounded-full shrink-0">${safeEsc(getActiveVoiceGroup())}</span>
                        </div>
                        <div id="peaVoiceStatusText" class="text-[11px] text-pink-100 truncate mt-0.5">พร้อมเป็นผู้ช่วยบรรยาย & สาธิตระบบ</div>
                    </div>
                    <button type="button" onclick="setDockMinimized(true)" class="px-2.5 py-1 rounded-xl bg-black/25 hover:bg-black/40 text-xs font-extrabold border border-white/25 shrink-0">ย่อลง ▾</button>
                </div>

                <div class="p-3.5 space-y-2.5 text-xs">
                    <div class="flex items-center gap-1.5">
                        <button type="button" data-pea-voice-opt="Aoede" onclick="switchPeaFemaleVoice('Aoede')">🌸 นุ่มนวล (Aoede)</button>
                        <button type="button" data-pea-voice-opt="Kore" onclick="switchPeaFemaleVoice('Kore')">✨ สดใส (Kore)</button>
                    </div>

                    <div class="flex gap-1.5">
                        <button id="peaVoiceMainActionBtn" type="button" class="w-full py-2.5 px-4 rounded-2xl font-extrabold text-xs sm:text-sm text-slate-950 bg-gradient-to-r from-amber-300 via-yellow-300 to-amber-400 shadow-lg">🎙️ เริ่มคุยสดกับน้องพีอา (Gemini Live)</button>
                        <button id="peaVoiceMuteBtn" type="button" onclick="togglePeaLiveMicMute()" class="hidden shrink-0 px-3 py-2 rounded-2xl font-extrabold text-xs bg-slate-700 hover:bg-slate-600 border border-white/20">🎙️ ปิดไมค์</button>
                    </div>

                    <button type="button" onclick="startPeaAutoFullPresentation()" class="w-full py-2 px-3 rounded-2xl font-extrabold text-xs bg-gradient-to-r from-emerald-500 to-teal-600 hover:brightness-110 text-white shadow flex items-center justify-center gap-1.5 border border-emerald-300/40">
                        <span>🎬 พรีเซนต์อัตโนมัติครบทุกฟีเจอร์ (Auto-Scroll)</span>
                    </button>

                    <div class="grid grid-cols-2 gap-1.5 pt-0.5">
                        <button type="button" onclick="sendPeaVoiceQuickTopic('ช่วยสาธิตการวิเคราะห์หาจุดฟอลต์บนแผนที่ผังสกาด้าจำลองให้ดูหน่อยค่ะ')" class="py-1.5 px-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-left font-bold text-[11px] border border-white/10 truncate">⚡ สาธิตหาพิกัดฟอลต์</button>
                        <button type="button" onclick="sendPeaVoiceQuickTopic('ช่วยสาธิตสับสวิตช์จำลองตัดตอนและจ่ายไฟย้อน Tie Switch บนผังสกาด้าให้ดูหน่อยค่ะ')" class="py-1.5 px-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-left font-bold text-[11px] border border-white/10 truncate">🔀 สาธิตสับสวิตช์จำลอง</button>
                        <button type="button" onclick="sendPeaVoiceQuickTopic('ช่วยสาธิตคำนวณขนาดฟิวส์เมน 22kV หม้อแปลง 160 kVA ในแท็บ 3 ให้ดูหน่อยค่ะ')" class="py-1.5 px-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-left font-bold text-[11px] border border-white/10 truncate">🧮 คำนวณฟิวส์ 22kV</button>
                        <button type="button" onclick="sendPeaVoiceQuickTopic('ช่วยเปิดสาธิตปฏิทินแผนดับไฟ PM และหน้าเว็บเรดาร์ตรวจสอบไฟดับสำหรับประชาชนให้ดูหน่อยค่ะ')" class="py-1.5 px-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-left font-bold text-[11px] border border-white/10 truncate">📡 เรดาร์ไฟดับประชาชน</button>
                    </div>

                    <div class="flex items-center justify-between pt-1 border-t border-white/10 text-[10px] text-slate-300">
                        <span id="peaVoiceMemBadge">✨ เซสชันใหม่</span>
                        <div class="flex items-center gap-2">
                            <button type="button" onclick="clearPeaVoiceConversationMemory()" class="hover:text-white underline">ล้างความจำ</button>
                            <button type="button" onclick="openKeySetupModalFallback()" class="text-amber-300 hover:text-amber-200 font-bold">🔑 ตั้งค่าคีย์</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(dock);
        updateVoiceDockStatusUI();
    }

            window.togglePeaLiveVoiceDock = togglePeaLiveVoiceDock;
    window.setPeaLiveDockMinimized = setDockMinimized;
    window.setDockMinimized = setDockMinimized;
    window.startPeaLiveVoiceSession = startPeaLiveVoiceSession;
    window.stopPeaLiveVoiceSession = stopPeaLiveVoiceSession;
    window.togglePeaLiveMicMute = togglePeaLiveMicMute;
    window.switchPeaFemaleVoice = switchPeaFemaleVoice;
    window.sendPeaVoiceQuickTopic = sendPeaVoiceQuickTopic;
    window.startPeaAutoFullPresentation = startPeaAutoFullPresentation;
    window.clearPeaVoiceConversationMemory = clearPeaVoiceConversationMemory;
    window.openKeySetupModalFallback = openKeySetupModalFallback;
    window.copyPeaLivePublicRadarLink = copyPeaLivePublicRadarLink;
    window.openPeaLivePublicRadarPreview = openPeaLivePublicRadarPreview;
    window.closePeaLivePublicRadarPreview = closePeaLivePublicRadarPreview;

    window.addEventListener('storage', (ev) => {
        if (!ev.key) return;
        if (ev.key === 'elec_app_current_group' || ev.key === 'gemini_api_key' || ev.key.startsWith(SHARED_GROUP_AI_KEY_PREFIX)) {
            const latestKey = getGroupApiKey();
            updateVoiceDockStatusUI();
            if (isUserSessionActive && latestKey && latestKey !== lastKnownGroupApiKey) {
                lastKnownGroupApiKey = latestKey;
                if (liveWs) disposeWebSocketCleanly(liveWs, 'api_key_updated');
                openLiveSessionWithFailover(latestKey, sessionEpoch).catch(() => {});
            }
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            injectPeaLiveVoiceDockUI();
            ensureTab1ManualEditGuardBound();
        });
    } else {
        injectPeaLiveVoiceDockUI();
        ensureTab1ManualEditGuardBound();
    }
})();
// ==================== จบพาทที่ 2 / 2 (pea-live-voice.js v2.9 ครบสมบูรณ์ 100%) ====================