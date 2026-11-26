// ============================================================================
// 🎙️🌸 PEA SMART GRID — GEMINI LIVE VOICE PR PRESENTER & ASSISTANT v2.7 (pea-live-voice.js)
// ระบบผู้ช่วยเสียงพูดสดสองทาง (WebSocket BidiGenerateContent + Function Calling)
// รองรับคีย์ AIza & AQ. + สาธิตสกาด้าจำลอง (คืนค่าฟอร์มอัตโนมัติ) + แผน PM ถึงเรดาร์ผู้ใช้ไฟ
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

    // ป้องกัน Service Worker รีโหลดหน้าเว็บอัตโนมัติตัดบทพูดกลางคันขณะเปิดใช้งานเสียงสด
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

    // ปลดล็อกลำโพงอัตโนมัติทันทีที่ผู้ใช้แตะหน้าจอ (ครอบคลุม touchend/click สำหรับ iOS Safari WebKit)
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
    // 1. Helpers กลุ่มสังกัด, สำรอง/คืนค่าฟอร์ม, โมดอลเรดาร์ประชาชน & Resumption
    // ========================================================================
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

    function getGroupApiKey() {
        const grp = getActiveVoiceGroup();
        const k = `${SHARED_GROUP_AI_KEY_PREFIX}${grp}`;
        let val = '';
        try { val = localStorage.getItem(k) || ''; } catch (e) {}
        return String(val || rawGet(k) || '').replace(/[^\x21-\x7E]/g, '').trim();
    }

    function openKeySetupModalFallback() {
        if (typeof window.openApiKeyModal === 'function') {
            window.openApiKeyModal();
            const mainKeyModal = document.getElementById('apiKeyModal');
            if (mainKeyModal) mainKeyModal.style.zIndex = '1475';
            return;
        }
        if (typeof window.openPmAiKeyModal === 'function') {
            window.openPmAiKeyModal(false);
            const pmKeyModal = document.getElementById('pmAiKeyConfigModal');
            if (pmKeyModal) pmKeyModal.style.zIndex = '1475';
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

    // สำรองและคืนค่าฟอร์มแท็บ 1 อัตโนมัติเมื่อจบการสาธิตหากระแสฟอลต์ (ไม่ให้ค่าสมมติค้างทับงานจริง)
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
            `⏰ เวลา : 09.00-15.00 น. (โดยประมาณ)`,
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

    // ค้นหาหน้าต่างแผนที่ SCADA แม้ผู้ใช้พับเก็บกรอบซ้ายไปแล้ว เพื่อล้างวงกลมและปิด Sandbox ได้ครบ 100%
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
        exitVoiceActivatedSimModeIfNeeded();
        restoreTab1DemoBackupIfNeeded();
        if (window.innerWidth < 1024 || openedLeftDockByVoice) {
            openedLeftDockByVoice = false;
            window.closeLeftWebBrowser?.();
        }
    }

    // เปิดหน้าจอผังระบบสกาด้าจำลองโดยสลับแท็บเพียงครั้งเดียว ไม่สั่งซ้ำรัวๆ ระหว่างรอแผนที่พร้อม
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
        if (scadaWin?.labeledPlaceMarkersMap?.[pin.id]) return scadaWin.labeledPlaceMarkersMap[pin.id];
        if (scadaWin?.scadaMarkersById?.[pin.id]) return scadaWin.scadaMarkersById[pin.id];

        let exactById = null;
        let nearestMarker = null;
        let minDist = Infinity;
        const pLat = parseFloat(pin.lat), pLon = parseFloat(pin.lon);

        map.eachLayer(layer => {
            if (exactById || typeof layer?.getLatLng !== 'function' || typeof layer?.openPopup !== 'function') return;
            const popHtml = String(layer.getPopup?.()?.getContent?.() || '');
            const iconHtml = String(layer.options?.icon?.options?.html || '');
            // ข้ามหมุดแผนงาน PM เพื่อไม่ให้หยิบผิดตัวเมื่อปักทับพิกัดเดียวกัน
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

    // ========================================================================
    // 3. ข้อมูลสถิติสด & เครื่องมือควบคุมหน้าจอ (รวมสาธิตสกาด้าจำลอง + แผน PM ถึงเรดาร์ผู้ใช้ไฟ)
    // ========================================================================
    function collectLiveSystemSnapshot() {
        const isMainPage = Boolean(document.getElementById('mainAppContent'));
        const grp = getActiveVoiceGroup();
        const rawUser = (rawGet('elec_app_current_user') || '').trim();
        const userDisplay = typeof window.formatTechDisplayName === 'function' ? window.formatTechDisplayName(rawUser) : (rawUser || 'ผู้ใช้งาน');

        let scadaPinsCount = 0, pmPendingCount = 0, pmDoneCount = 0, pmPublicRadarCount = 0;
        const sampleSwitchNames = [];
        const sampleFeeders = new Set();
        try {
            const delPins = JSON.parse(rawGet('elec_deleted_labeled_places_map') || '{}');
            const pins = JSON.parse(rawGet('elec_labeled_places_list') || '[]');
            pins.forEach(p => {
                if (!p?.id || delPins[p.id] || normGroup(p.ownerGroup || 'กฟส.บึง') !== grp) return;
                scadaPinsCount++;
                if (p.scadaNode) {
                    if (p.scadaNode.fd) sampleFeeders.add(p.scadaNode.fd);
                    if (sampleSwitchNames.length < 6 && ['VS', 'VSC', 'RC', 'CB', 'S', 'VB', 'DF'].includes(p.scadaNode.t)) {
                        sampleSwitchNames.push(`${p.name}(${p.scadaNode.st || 'C'})`);
                    }
                }
            });
        } catch (e) {}
        try {
            const plans = JSON.parse(rawGet('elec_pm_calendar_plans_v1') || '[]');
            plans.forEach(p => {
                if (!p || p.pmDeleted || normGroup(p.ownerGroup || 'กฟส.บึง') !== grp) return;
                if (p.status === 'done') pmDoneCount++;
                else {
                    pmPendingCount++;
                    if (p.pub && p.oz) pmPublicRadarCount++;
                }
            });
        } catch (e) {}

        const commonInfo = {
            branchGroup: grp,
            loggedInUser: userDisplay,
            scadaEquipmentPins: scadaPinsCount,
            availableFeeders: Array.from(sampleFeeders).slice(0, 8),
            sampleSwitches: sampleSwitchNames,
            pmPendingPlans: pmPendingCount,
            pmPublicOutageZones: pmPublicRadarCount,
            publicOutageRadarUrl: getPublicOutageRadarUrl(false)
        };

        if (!isMainPage) {
            return {
                currentPage: 'page2_technician_workspace',
                ...commonInfo,
                pendingJobs: document.getElementById('countPendingJobs')?.textContent || '0',
                travelingJobs: document.getElementById('countTravelingJobs')?.textContent || '0',
                doneJobs: document.getElementById('countDoneJobs')?.textContent || '0'
            };
        }

        return {
            currentPage: 'main_dispatch_workspace',
            ...commonInfo,
            currentShift: document.getElementById('shift')?.value || '-',
            nextJobNo: document.getElementById('jobNo')?.value || '1',
            faultTotal: document.getElementById('statFaultTotal')?.textContent || '0',
            fault22kV: document.getElementById('statFault22kV')?.textContent || '0',
            fault115kV: document.getElementById('statFault115kV')?.textContent || '0',
            outageTotal: document.getElementById('statOutageTotal')?.textContent || '0',
            outageToday: document.getElementById('statOutageToday')?.textContent || '0',
            overdueCaDatabaseCount: document.getElementById('caCountBadge')?.textContent || '0',
            weatherStatus: (document.getElementById('liveWeatherStatus')?.textContent || '').trim(),
            pmCompletedPlans: pmDoneCount
        };
    }

    function buildSystemInstructionText() {
        const snap = collectLiveSystemSnapshot();
        const isMain = snap.currentPage === 'main_dispatch_workspace';
        return [
            'คุณคือผู้ช่วยประชาสัมพันธ์และผู้ช่วยปฏิบัติการอัจฉริยะ (ผู้หญิง) ประจำ "ระบบเครื่องมือจัดการงานไฟฟ้า (PEA Smart Grid Operations)" ของการไฟฟ้าส่วนภูมิภาค (กฟภ.) พัฒนาโดย คุณศุภเรศ ศรีคชา (SamSrikacha)',
            `ปัจจุบันคุณกำลังดูแลพื้นที่สังกัด: "${snap.branchGroup}" ผู้ใช้งานคือ "${snap.loggedInUser}"`,
            '',
            'บุคลิก น้ำเสียง และข้อกำหนดสำคัญเรื่องระบบสกาด้าจำลอง:',
            '- ใช้เสียงผู้หญิงที่นุ่มนวล อบอุ่น สุภาพ ชัดถ้อยชัดคำ น่าเชื่อถือแบบนักประชาสัมพันธ์มืออาชีพ ลงท้ายด้วย "ค่ะ" หรือ "นะคะ" เสมอ',
            '- อ่านคำย่อทางวิศวกรรมไฟฟ้าให้เป็นธรรมชาติและฟังง่าย เช่น "กฟภ." อ่านว่า "การไฟฟ้าส่วนภูมิภาค", "22kV" อ่านว่า "ยี่สิบสองเควี", "115kV" อ่านว่า "หนึ่งร้อยสิบห้าเควี", "TR/TL" อ่านว่า "ทีอาร์ ทับ ทีแอล", "SCADA" อ่านว่า "สกาด้า", "LOTO" อ่านว่า "โลโต้", "CA" อ่านว่า "ซีเอ", "PM" อ่านว่า "พีเอ็ม"',
            '- กฎเหล็กสำคัญมาก: ทุกครั้งที่พูดถึงผังวงจร SCADA ต้องเรียกว่า "ระบบสกาด้าจำลอง" เสมอ และต้องชี้แจงให้ชัดเจนว่า "เป็นการจำลองการจ่ายไฟและจำลองสถานะสวิตช์บนแผนที่เพื่อช่วยวางแผนและวิเคราะห์งานเท่านั้น ไม่ใช่งานโอเปอเรทสั่งสับปลดจ่ายไฟจริงในสนาม และไม่กระทบข้อมูลจริง"',
            '',
            'ความสามารถในการลงมือสาธิตจริงบนหน้าจอ (ห้ามส่งคำสั่งเปิดหลายหน้าจอพร้อมกันในรอบเดียว ต้องเปิด 1 หน้า พูดอธิบายให้จบ 2-3 ประโยคก่อน แล้วจึงเรียกขั้นถัดไป):',
            '- ระบบสกาด้าจำลอง: ใช้ demoScadaFaultSearch กรอกกระแสฟอลต์ชี้เป้าจุดเสีย และใช้ demoScadaSwitchSimulation เปิดโหมดจำลอง Sandbox เพื่อจำลองปลด-สับสวิตช์',
            '- ระบบแผนงาน PM จนถึงแผนที่เรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟ: ใช้ demoPmOutageRadarStep พาชมทีละขั้นตามลำดับ:',
            '  1) step="calendar_overview": ตารางปฏิทินแผนงาน PM แนบรูปหน้างานสูงสุด 3 รูปส่งเข้า LINE และการตั้งเวลาแจ้งเตือนล่วงหน้า',
            '  2) step="radar_zone_draft": สาธิตการตั้งค่าแผนดับไฟ วาดวงเรดาร์พื้นที่ไฟดับสีแดงบนแผนที่ และใช้ AI ดูดป้ายชื่อสถานที่ หอพัก หมู่บ้าน โรงงาน ในกรอบไฟดับอัตโนมัติ',
            '  3) step="announce_post": สาธิตการสร้างข้อความประกาศแจ้งดับไฟสำหรับโพสต์เพจ Facebook และส่งกลุ่ม LINE พร้อมแนบลิงก์เรดาร์ให้ประชาชน',
            '  4) step="public_radar_map": เปิดหน้าเว็บจริง "แผนที่เรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟ (outage-map.html)" อธิบายว่าผู้ใช้ไฟเปิดจากลิงก์ได้ทันทีโดยไม่ต้องล็อกอิน กดปุ่มเช็กพิกัด GPS ปัจจุบันจากมือถือ หรือเลื่อนหมุดตรวจสอบว่าบ้านหรือโรงงานอยู่ในเขตแผนดับไฟสีแดงหรือไม่ พร้อมดูวันเวลาและสาเหตุได้ด้วยตนเองตลอด 24 ชั่วโมง',
            '  5) step="close_public_radar": ปิดหน้าต่างตัวอย่างเรดาร์เมื่อต้องการไปนำเสนอหน้าจออื่นต่อ',
            '',
            'กฎการทำงานเมื่อได้รับคำสั่ง "แนะนำระบบ" หรือ "พรีเซนต์ระบบ":',
            isMain
                ? [
                    '1. กล่าวต้อนรับผู้บริหารหรือผู้รับฟังอย่างนุ่มนวล แนะนำชื่อระบบเครื่องมือจัดการงานไฟฟ้าแบบครบวงจรสำหรับศูนย์สั่งการและช่างภาคสนาม พัฒนาโดยคุณศุภเรศ ศรีคชา',
                    '2. พาชมทีละหน้าจอโดยเรียกเครื่องมือครั้งละ 1 คำสั่งควบคู่ไปกับการอธิบายจุดเด่นทีละส่วนอย่างต่อเนื่อง:',
                    '   - ขั้นที่ 1: เรียก navigateAppScreen("tab1_fault") อธิบายฟอร์มรายงานเหตุสถานี 22kV/115kV เชื่อมเรดาร์น้ำฝน Rain Alarm อัตโนมัติ และตรวจเตือนป้ายห้ามสับไฟ LOTO',
                    '   - ขั้นที่ 2: เรียก demoScadaFaultSearch(1850, 4.2) เปิดผัง "ระบบสกาด้าจำลอง" สาธิตกรอกกระแสฟอลต์ชี้เป้าจุดเสีย จากนั้นเรียก demoScadaSwitchSimulation("toggle") สาธิตจำลองปลด-สับสวิตช์โดยย้ำว่าเป็นการจำลองการจ่ายไฟเพื่อวางแผน ไม่ใช่งานโอเปอเรทจริง แล้วเรียก navigateAppScreen("close_scada_split")',
                    '   - ขั้นที่ 3: เรียก navigateAppScreen("tab2_outage") อธิบายระบบรับแจ้งไฟฟ้าขัดข้อง คัดกรองข้อมูลลูกค้า แจ้งเตือนเลข CA ค้างจ่าย 12 หลัก แนะนำช่างใกล้จุดเกิดเหตุด้วย GPS สด และสร้างลิงก์ใบสับเปลี่ยนมิเตอร์ชำรุดอัตโนมัติ',
                    '   - ขั้นที่ 4: สาธิตแผนงาน PM จนถึงเรดาร์ผู้ใช้ไฟทีละขั้น: เรียก demoPmOutageRadarStep("calendar_overview") -> อธิบายจบจึงเรียก demoPmOutageRadarStep("radar_zone_draft") -> อธิบายจบจึงเรียก demoPmOutageRadarStep("announce_post") -> อธิบายจบจึงเรียก demoPmOutageRadarStep("public_radar_map") โชว์หน้าเว็บเรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟ -> อธิบายจบจึงเรียก demoPmOutageRadarStep("close_public_radar")',
                    '   - ขั้นที่ 5: เรียก demoCalculate22kVFuse(160, 1, 1.5) เปิดแท็บ 3 สาธิตคำนวณขนาดฟิวส์เมนแรงสูง 22kV ของหม้อแปลง 160 เควีเอ',
                    '   - ขั้นที่ 6: เรียก navigateAppScreen("tab4_analytics") เปิดแท็บ 4 แดชบอร์ดกราฟสถิติ สรุปจำนวนข้อมูลจริงของสาขา แล้วกล่าวปิดท้ายเปิดโอกาสให้ซักถามค่ะ'
                ].join('\n')
                : 'คุณกำลังอยู่บนหน้าปฏิบัติงานช่างภาคสนาม (Page 2) สามารถเรียก navigateAppScreen, demoScadaFaultSearch, demoScadaSwitchSimulation และ demoPmOutageRadarStep เพื่อสาธิตทั้ง "ระบบสกาด้าจำลอง" (จำลองการจ่ายไฟ ไม่ใช่งานโอเปอเรทจริง) และระบบแผนงาน PM จนถึงหน้าเว็บแผนที่เรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟได้ครบทุกขั้นตอนค่ะ',
            '',
            'กฎการทำงานขณะช่วยปฏิบัติงานจริง:',
            '- หากผู้ใช้แจ้งรายละเอียดไฟฟ้าขัดข้องของชาวบ้าน ให้เรียก fillOutageReportByVoice เพื่อกรอกลงฟอร์มแท็บ 2 ทันที (หากข้อมูลใดไม่ได้ระบุให้ส่งค่าว่าง "" ห้ามเดาเอง)',
            '- หากผู้ใช้แจ้งเหตุเบรกเกอร์ทริป TR/TL ในสถานี ให้เรียก fillFaultReportByVoice เพื่อกรอกลงฟอร์มแท็บ 1',
            '- หากผู้ฟังถามหรือสั่งเปิดดูแผนงาน PM หรือเรดาร์ตรวจสอบไฟดับของผู้ใช้ไฟ ให้เรียก demoPmOutageRadarStep ตามขั้นตอนที่เกี่ยวข้องทันทีค่ะ'
        ].join('\n');
    }

    function getToolDeclarations(requireNonBlocking = false) {
        const baseTools = [
            {
                name: 'navigateAppScreen',
                description: 'เปิดหรือสลับหน้าจอในแอปพลิเคชันเพื่อแสดงให้ผู้ชมดูประกอบการบรรยาย หรือตามคำสั่งเสียงของผู้ใช้',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        target: {
                            type: 'STRING',
                            description: 'รหัสหน้าจอที่ต้องการเปิด ได้แก่: tab1_fault, scada_split (ผังระบบสกาด้าจำลองคู่หน้าฟอร์ม), close_scada_split, tab2_outage, pm_calendar_grid, pm_calendar_map, close_pm_calendar, tab3_fuse, tab4_analytics, tech_jobs_list, tech_scada_map (แผนที่ระบบสกาด้าจำลอง)'
                        }
                    },
                    required: ['target']
                }
            },
            {
                name: 'demoPmOutageRadarStep',
                description: 'สาธิตระบบแผนงานบำรุงรักษา (PM) ทีละขั้น ตั้งแต่ปฏิทินแผนงาน การวาดโซนเรดาร์ไฟดับและดูดชื่อสถานที่ การสร้างโพสต์แจ้งเตือน Facebook/LINE จนถึงการเปิดหน้าเว็บแผนที่เรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟ (outage-map.html)',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        step: {
                            type: 'STRING',
                            description: 'ขั้นตอนการสาธิต (เรียกทีละ 1 ขั้นตอน) ได้แก่: calendar_overview, radar_zone_draft, announce_post, public_radar_map, close_public_radar'
                        },
                        radiusMeters: {
                            type: 'NUMBER',
                            description: 'รัศมีวงเรดาร์แจ้งดับไฟหน่วยเมตรสำหรับขั้น radar_zone_draft (ค่าเริ่มต้น 350)'
                        },
                        postStyle: {
                            type: 'STRING',
                            description: 'รูปแบบประกาศสำหรับขั้น announce_post ได้แก่ facebook หรือ line (ค่าเริ่มต้น facebook)'
                        }
                    },
                    required: ['step']
                }
            },
            {
                name: 'demoScadaFaultSearch',
                description: 'สาธิตการกรอกข้อมูลกระแสฟอลต์ (แอมแปร์) และระยะทาง (กม.) ลงในช่องค้นหาฟอลต์และฟอร์มแท็บ 1 พร้อมเปิดผังระบบสกาด้าจำลองเพื่อซูมชี้เป้าจุดคาดการณ์เกิดฟอลต์บนแผนที่',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        faultAmp: { type: 'NUMBER', description: 'ค่ากระแสฟอลต์หน่วยแอมแปร์ (A) เช่น 1850 (ค่าเริ่มต้น 1850)' },
                        distanceKm: { type: 'NUMBER', description: 'ระยะทางจุดเกิดฟอลต์หน่วยกิโลเมตร (km) เช่น 4.2 (ค่าเริ่มต้น 4.2)' },
                        feeder: { type: 'STRING', description: 'ชื่อวงจรหรือฟีดเดอร์ เช่น F6 หรือ BNF06 (ถ้าไม่ระบุระบบจะเลือกวงจรที่มีอยู่ในสาขาให้อัตโนมัติ)' },
                        phase: { type: 'STRING', description: 'เฟสที่เกิดฟอลต์ เช่น A-G, B-G, C-G, A-B-C (ค่าเริ่มต้น A-G)' },
                        station: { type: 'STRING', description: 'ชื่อสถานีไฟฟ้า เช่น บึง1 (ถ้ามี)' }
                    }
                }
            },
            {
                name: 'demoScadaSwitchSimulation',
                description: 'เปิดโหมดจำลอง (Sandbox) บนแผนที่ระบบสกาด้าจำลอง แล้วสาธิตการจำลองปลด (open) สับจ่ายไฟ (close) จำลองฟอลต์ (fault) หรือออกจากโหมดจำลอง (exit_sim) โดยไม่กระทบข้อมูลจริง',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        action: {
                            type: 'STRING',
                            description: 'คำสั่งจำลอง ได้แก่: open (จำลองปลดสวิตช์), close (จำลองสับสวิตช์), toggle (สลับสถานะปลด/สับ), fault (จำลองทริป/ฟอลต์), exit_sim (ปิดโหมดจำลองคืนค่าผังปกติ)'
                        },
                        equipCode: {
                            type: 'STRING',
                            description: 'รหัสสวิตช์หรืออุปกรณ์ที่ต้องการจำลองปลด-สับ เช่น VS-01, BNF06VS-01 (หากไม่ระบุ ระบบจะเลือกสวิตช์ตัวอย่างในสาขาให้อัตโนมัติ)'
                        }
                    },
                    required: ['action']
                }
            },
            {
                name: 'getLiveSystemStats',
                description: 'ดึงตัวเลขสถิติใบงานจริง กะปัจจุบัน สภาพอากาศ รายชื่อฟีดเดอร์/สวิตช์ตัวอย่างในระบบสกาด้าจำลอง และแผนงาน PM ล่าสุดในระบบ',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        scope: { type: 'STRING', description: 'ระบุ all เพื่อดึงข้อมูลภาพรวมทั้งหมด' }
                    }
                }
            },
            {
                name: 'demoCalculate22kVFuse',
                description: 'เปิดแท็บ 3 และคำนวณขนาดฟิวส์แรงสูง 22kV (Type K) จากขนาดหม้อแปลง kVA จำนวนลูก และตัวคูณเผื่อกระแส',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        kva: { type: 'NUMBER', description: 'ขนาดหม้อแปลง (kVA) เช่น 30, 50, 100, 160, 250, 315, 400, 500, 630, 800, 1000' },
                        qty: { type: 'NUMBER', description: 'จำนวนลูก (ค่าเริ่มต้น 1)' },
                        multiplier: { type: 'NUMBER', description: 'ตัวคูณเผื่อกระแส (ค่าเริ่มต้น 1.5)' }
                    },
                    required: ['kva']
                }
            },
            {
                name: 'fillOutageReportByVoice',
                description: 'กรอกข้อมูลรับแจ้งไฟฟ้าขัดข้องลงในฟอร์มแท็บ 2 อัตโนมัติตามข้อมูลที่ผู้ใช้พูดแจ้ง',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        issueType: { type: 'STRING', description: 'ลักษณะอาการขัดข้อง เช่น ไฟดับ, ไฟตก, หม้อแปลงระเบิด, สายไฟขาด, มิเตอร์ชำรุด' },
                        workerName: { type: 'STRING', description: 'ชื่อช่างผู้ปฏิบัติงาน หรือผู้รับแจ้ง' },
                        area: { type: 'STRING', description: 'บริเวณหรือจุดสังเกตเกิดเหตุ' },
                        address: { type: 'STRING', description: 'บ้านเลขที่ หมู่ ซอย ถนน ตำบล' },
                        phone: { type: 'STRING', description: 'เบอร์โทรศัพท์ติดต่อ' },
                        gps: { type: 'STRING', description: 'เฉพาะตัวเลขพิกัดละติจูด,ลองจิจูด หรือลิงก์ Google Maps เท่านั้น' },
                        caNo: { type: 'STRING', description: 'หมายเลขผู้ใช้ไฟ CA 12 หลัก (ถ้ามี)' },
                        peaNo: { type: 'STRING', description: 'หมายเลขมิเตอร์ PEA No. (ถ้ามี)' }
                    }
                }
            },
            {
                name: 'fillFaultReportByVoice',
                description: 'กรอกข้อมูลเหตุไฟฟ้าขัดข้องระดับสถานี TR/TL ลงในฟอร์มแท็บ 1 อัตโนมัติ',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        system: { type: 'STRING', description: 'ระบบแรงดัน 22kV หรือ 115kV' },
                        circuit: { type: 'STRING', description: 'ชื่อวงจร เช่น F1 ถึง F15 หรือ LINE 1' },
                        station: { type: 'STRING', description: 'ชื่อสถานีไฟฟ้า เช่น บึง1, บ่อวิน1, ปิ่นทอง1' },
                        cause: { type: 'STRING', description: 'สาเหตุเหตุการณ์ เช่น Trip, Lockout, Fault หรือ อื่นๆ' },
                        tlStatus: { type: 'STRING', description: 'สถานะรีโคลส ได้แก่ T/R หรือ T/L (ถ้ามี)' },
                        count: { type: 'STRING', description: 'จำนวนครั้ง เช่น 1, 2, 3' },
                        phase: { type: 'STRING', description: 'เฟสที่โชว์ เช่น A-G, B-G, C-G, A-B-C' },
                        device: { type: 'STRING', description: 'รหัสอุปกรณ์ที่เห็นฟอลต์' },
                        disconnectDevice: { type: 'STRING', description: 'รหัสอุปกรณ์ที่ปลด' },
                        reporter: { type: 'STRING', description: 'สาเหตุเบื้องต้นหรือผู้แจ้ง' }
                    }
                }
            }
        ];

        return requireNonBlocking
            ? baseTools.map(fn => ({ ...fn, behavior: 'NON_BLOCKING' }))
            : baseTools;
    }

    function isCleanupPresentationCall(fc) {
        if (!fc) return false;
        if (fc.name === 'navigateAppScreen') {
            const t = String(fc.args?.target || '').trim();
            return t === 'close_scada_split' || t === 'close_pm_calendar';
        }
        if (fc.name === 'demoPmOutageRadarStep') {
            return /^close/i.test(String(fc.args?.step || '').trim());
        }
        if (fc.name === 'demoScadaSwitchSimulation') {
            return /^(?:exit_sim|exit|reset)$/i.test(String(fc.args?.action || '').trim());
        }
        return false;
    }

    function hideFormFloatingMenus(ids) {
        ids.forEach(id => document.getElementById(id)?.classList.add('hidden'));
    }

    // รอจนเสียงบรรยายท่อนก่อนหน้าพูดจบประโยคก่อนสลับหน้าจอหรือรันการสาธิตบนจอ
    async function waitForQueuedAudioBeforeUiTool(ws, targetPlayTimeSec, fnCalls, cancelledSet, startInterruptSeq) {
        const shouldSyncWithSpeech = fnCalls.some(fc => fc && PRESENTATION_SYNC_TOOLS.has(fc.name));
        if (!shouldSyncWithSpeech || !outputAudioCtx || outputAudioCtx.state === 'closed') return;
        const startedWaitMs = Date.now();
        while (activePlaybackSources.size > 0 && isUserSessionActive && !ws._peaDisposed && ws.readyState === WebSocket.OPEN) {
            if (turnInterruptionSeq !== startInterruptSeq || fnCalls.every(fc => cancelledSet.has(fc.id))) return;
            if (outputAudioCtx.state === 'suspended' || outputAudioCtx.state === 'interrupted') {
                outputAudioCtx.resume().catch(() => {});
            }
            const remainSec = targetPlayTimeSec - outputAudioCtx.currentTime;
            if (remainSec <= 0.12 || (Date.now() - startedWaitMs) > 25000) break;
            await new Promise(r => setTimeout(r, Math.min(90, Math.max(30, Math.round(remainSec * 250)))));
        }
    }

    function isLikelyValidGpsOrMapUrl(rawStr) {
        const s = String(rawStr || '').trim();
        if (!s) return false;
        if (/^(?:https?:\/\/|maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.|maps\.)?google\.[a-z.]+\/maps)/i.test(s)) return true;
        if (typeof window.deepParseCoords === 'function') {
            try {
                const c = window.deepParseCoords(s, false);
                if (c && !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lon))) return true;
            } catch (e) {}
        }
        return /(-?\d{1,3}\.\d{3,})\s*(?:,|\s+)\s*\+?(-?\d{1,3}\.\d{3,})/.test(s);
    }

    async function executeVoiceToolCall(name, args = {}) {
        const cleanVal = v => {
            const s = String(v ?? '').trim();
            return (!s || /^(?:-|none|null|undefined|n\/a|ไม่ระบุ|ไม่มี|ไม่ทราบ)$/i.test(s)) ? '' : s;
        };
        const normToken = s => String(s || '').toUpperCase().replace(/[\s\-/,._()[\]]+/g, '');

        if (name === 'getLiveSystemStats') {
            setLiveActionSubtext('📊 กำลังอ่านข้อมูลสถิติจริงในระบบ...');
            return collectLiveSystemSnapshot();
        }

        if (name === 'navigateAppScreen') {
            const target = String(args.target || '').trim();
            const isMainPage = Boolean(document.getElementById('mainAppContent'));

            if (target === 'pm_calendar_grid') {
                closePeaLivePublicRadarPreview();
                closeVoiceOpenedPmDraftOnly();
                closeVoiceOpenedLeftDockIfNeeded();
                setDockMinimized(true);
                setLiveActionSubtext('📅 เปิดตารางปฏิทินแผนงาน PM');
                window.openPmCalendarModal?.();
                await new Promise(r => setTimeout(r, 180));
                window.switchCalendarLeftViewMode?.('grid');
            } else if (target === 'pm_calendar_map') {
                closePeaLivePublicRadarPreview();
                closeVoiceOpenedPmDraftOnly();
                closeVoiceOpenedLeftDockIfNeeded();
                setDockMinimized(true);
                setLiveActionSubtext('📡 เปิดแผนที่หมุด PM & โซนเรดาร์ประชาชน');
                const calModal = document.getElementById('pmCalendarModal');
                const wasHidden = !calModal || calModal.classList.contains('hidden');
                if (wasHidden) {
                    window.openPmCalendarModal?.();
                    await new Promise(r => setTimeout(r, 180));
                }
                await window.switchCalendarLeftViewMode?.('map');
            } else if (target === 'close_pm_calendar') {
                setLiveActionSubtext('✕ ปิดหน้าต่างปฏิทิน PM และเรดาร์');
                closeVoiceOpenedPmAndRadarModals();
            } else if (!isMainPage) {
                closeVoiceOpenedPmAndRadarModals();
                if (target === 'tech_scada_map' || target === 'scada_split') {
                    setDockMinimized(true);
                    setLiveActionSubtext('⚡ สลับไปหน้าผังระบบสกาด้าจำลอง');
                    window.switchTechMainTab?.('map');
                } else {
                    exitVoiceActivatedSimModeIfNeeded(window);
                    setLiveActionSubtext('🛠️ สลับไปหน้ารายการใบงานช่าง');
                    window.switchTechMainTab?.('jobs');
                }
            } else {
                closeVoiceOpenedPmAndRadarModals();
                if (target === 'scada_split') {
                    const leftDockEl = document.getElementById('leftBrowserDock');
                    if (!leftDockEl || leftDockEl.classList.contains('hidden')) {
                        openedLeftDockByVoice = true;
                    }
                    setDockMinimized(true);
                    setLiveActionSubtext('⚡ เปิดผังระบบสกาด้าจำลองคู่หน้าฟอร์ม');
                    window.switchTab?.('tab1');
                    window.openScadaDiagramWorkspace?.();
                } else if (target === 'close_scada_split') {
                    exitVoiceActivatedSimModeIfNeeded();
                    restoreTab1DemoBackupIfNeeded();
                    openedLeftDockByVoice = false;
                    setLiveActionSubtext('✕ ปิดหน้าต่างผังสกาด้าจำลองฝั่งซ้าย');
                    window.closeLeftWebBrowser?.();
                } else {
                    closeVoiceOpenedLeftDockIfNeeded();
                    const tabMap = {
                        tab1_fault: ['tab1', '🚨 เปิดแท็บ 1: รายงานเหตุ TR/TL'],
                        tab2_outage: ['tab2', '📞 เปิดแท็บ 2: รับแจ้งไฟฟ้าขัดข้อง'],
                        tab3_fuse: ['tab3', '🧮 เปิดแท็บ 3: คำนวณฟิวส์เมน 22kV'],
                        tab4_analytics: ['tab4', '📊 เปิดแท็บ 4: แดชบอร์ดสถิติกราฟ']
                    }[target];
                    if (tabMap) {
                        setLiveActionSubtext(tabMap[1]);
                        window.switchTab?.(tabMap[0]);
                        window.scrollTo?.({ top: 0, behavior: 'smooth' });
                    }
                }
            }
            return { ok: true, openedScreen: target, liveStats: collectLiveSystemSnapshot() };
        }

        // ====================================================================
        // 📅📡 เครื่องมือสาธิตแผนงาน PM -> ตีกรอบเรดาร์ -> โพสต์แจ้งเตือน -> แมพเรดาร์ผู้ใช้ไฟ
        // ====================================================================
        if (name === 'demoPmOutageRadarStep') {
            const step = String(args.step || 'calendar_overview').toLowerCase().trim();
            const grp = getActiveVoiceGroup();
            const snap = collectLiveSystemSnapshot();

            if (step === 'close_public_radar' || step === 'close_all' || step === 'close') {
                closeVoiceOpenedPmAndRadarModals();
                setLiveActionSubtext('✕ ปิดหน้าต่างสาธิตแผนงาน PM และเรดาร์ผู้ใช้ไฟ');
                return { ok: true, step: 'closed' };
            }

            closeVoiceOpenedLeftDockIfNeeded();
            setDockMinimized(true);

            if (step === 'calendar_overview') {
                closePeaLivePublicRadarPreview();
                closeVoiceOpenedPmDraftOnly();
                window.openPmCalendarModal?.();
                await new Promise(r => setTimeout(r, 180));
                window.switchCalendarLeftViewMode?.('grid');
                setLiveActionSubtext(`📅 เปิดตารางปฏิทินแผนงาน PM (${grp})`);
                return {
                    ok: true,
                    step: 'calendar_overview',
                    branchGroup: grp,
                    pmPendingPlans: snap.pmPendingPlans,
                    pmPublicOutageZones: snap.pmPublicOutageZones,
                    highlights: [
                        'วางแผนตัดรอนกิ่งไม้ บำรุงรักษาหม้อแปลง ส่องกล้องความร้อน และงาน HOTLINE',
                        'แนบรูปภาพหน้างานสูงสุด 3 รูป ส่งไฟล์รูปจริงพร้อมข้อความเข้า LINE',
                        'ระบบแจ้งเตือนเสียงอัตโนมัติรอบเที่ยงคืน รอบเจ็ดโมงเช้า และเวลาพิเศษรายแผนงาน'
                    ]
                };
            }

            if (step === 'radar_zone_draft') {
                closePeaLivePublicRadarPreview();
                exitVoiceActivatedSimModeIfNeeded();
                const coord = pickRepresentativeBranchCoord();
                const radius = Math.max(100, Math.min(2000, Math.round(Number(args.radiusMeters) || 350)));
                const d = new Date();
                const todayIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

                const calModal = document.getElementById('pmCalendarModal');
                if (!calModal || calModal.classList.contains('hidden')) {
                    window.openPmCalendarModal?.();
                    await new Promise(r => setTimeout(r, 160));
                }

                const existingFormModal = document.getElementById('pmPlanFormModal');
                const userEditingRealPlan = Boolean(
                    existingFormModal &&
                    !existingFormModal.classList.contains('hidden') &&
                    existingFormModal.dataset.voiceDemoDraft !== '1'
                );

                if (!userEditingRealPlan && canEditPmAndScadaSafe() && typeof window.openPmPlanFormModal === 'function') {
                    window.openPmPlanFormModal(null, todayIso, coord.lat, coord.lon);
                    const formModal = document.getElementById('pmPlanFormModal');
                    if (formModal && !formModal.classList.contains('hidden')) {
                        formModal.dataset.voiceDemoDraft = '1';
                        openedPmDraftByVoice = true;

                        const titleEl = document.getElementById('pmTitleInput');
                        const catEl = document.getElementById('pmCategorySelect');
                        const slotEl = document.getElementById('pmTimeSlotInput');
                        if (titleEl) titleEl.value = DEMO_PM_DRAFT_TITLE;
                        if (catEl) catEl.value = 'patrol';
                        if (slotEl) slotEl.value = '09.00-15.00';

                        await window.onTogglePmPublicOutage?.(true);
                        // รอจนกว่าแผนที่ย่อย Leaflet โหลดสำเร็จจริงบนเน็ตมือถือก่อนสั่งวาดวงเรดาร์
                        for (let i = 0; i < 25; i++) {
                            if (document.querySelector('#pmFormMiniLeafletMap.leaflet-container')) break;
                            await new Promise(r => setTimeout(r, 140));
                        }
                        await new Promise(r => setTimeout(r, 120));
                        window.onPmCircleRadiusInput?.(radius);

                        const pubNoteEl = document.getElementById('pmPubOutageNoteInput');
                        if (pubNoteEl) pubNoteEl.value = 'ปรับปรุงสายแรงสูง 22kV และตัดรอนกิ่งไม้ใกล้แนวสายเพื่อป้องกันกระแสไฟฟ้าขัดข้อง';
                        window.clearAllTempPubPlaces?.();
                        window.addManualTempPubPlace?.(`ชุมชนและสถานประกอบการในรัศมีเรดาร์ ${radius} เมตร, หอพักและหมู่บ้านริมแนวสายส่ง (${grp})`);

                        document.getElementById('pmPubOutagePanel')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
                        setLiveActionSubtext(`📡 สาธิตตีกรอบเรดาร์ไฟดับรัศมี ${radius} ม. & ดูดชื่อสถานที่`);
                        return {
                            ok: true,
                            step: 'radar_zone_draft',
                            draftOnlyUntouchedRealData: true,
                            radarRadiusMeters: radius,
                            supportedDrawModes: ['วงกลมเรดาร์ปรับรัศมีได้', 'ปักมุมหลายเหลี่ยม', 'ลากนิ้วตีกรอบอิสระตามแนวสายส่ง'],
                            aiPlaceScanFeature: 'มีปุ่ม AI กวาดอ่านป้ายชื่อหอพัก หมู่บ้าน โรงงาน ร้านค้า และซอยในกรอบสีแดงบนแผนที่อัตโนมัติ'
                        };
                    }
                }

                // กรณีบัญชีผู้สำรวจ/ช่าง หรือผู้ใช้กำลังเปิดฟอร์มแผนงานจริงค้างไว้ ให้สลับโชว์แผนที่หมุดและโซนเรดาร์ในปฏิทินแทน
                await window.switchCalendarLeftViewMode?.('map');
                setLiveActionSubtext('🗺️ แสดงแผนที่หมุด PM และเขตโซนเรดาร์แจ้งดับไฟ');
                return {
                    ok: true,
                    step: 'radar_zone_draft',
                    viewerMapMode: true,
                    pmPublicOutageZones: snap.pmPublicOutageZones,
                    note: 'แสดงแผนที่โซนเรดาร์บนปฏิทินอย่างปลอดภัยโดยไม่กระทบฟอร์มงานจริง'
                };
            }

            if (step === 'announce_post') {
                closePeaLivePublicRadarPreview();
                const styleMode = String(args.postStyle || 'facebook').toLowerCase() === 'line' ? 'line' : 'facebook';
                const formModal = document.getElementById('pmPlanFormModal');
                const isDemoFormOpen = Boolean(formModal && !formModal.classList.contains('hidden') && formModal.dataset.voiceDemoDraft === '1');

                let openedViaNative = false;
                if (isDemoFormOpen && typeof window.openPmPublicAnnounceModal === 'function') {
                    window.openPmPublicAnnounceModal('__FORM_DRAFT__');
                    window.switchPmAnnounceStyle?.(styleMode);
                    openedViaNative = true;
                } else {
                    let activePubPlanId = '';
                    try {
                        const plans = JSON.parse(rawGet('elec_pm_calendar_plans_v1') || '[]');
                        const found = plans.find(p => p && !p.pmDeleted && normGroup(p.ownerGroup || 'กฟส.บึง') === grp && p.pub && p.oz);
                        if (found?.id) activePubPlanId = found.id;
                    } catch (e) {}

                    if (activePubPlanId && typeof window.openPmPublicAnnounceModal === 'function') {
                        window.openPmPublicAnnounceModal(activePubPlanId);
                        window.switchPmAnnounceStyle?.(styleMode);
                        openedViaNative = true;
                    } else if (typeof window.openPmPublicAnnounceModal === 'function') {
                        // สร้าง DOM ของหน้าต่างโพสต์ผ่าน pm-calendar.js แล้วเติมข้อความตัวอย่างพร้อมลิงก์เรดาร์จริงของสาขา
                        window.openPmPublicAnnounceModal('__INIT_DOM_ONLY__');
                    }
                }

                const annModal = document.getElementById('pmPublicAnnounceModal');
                if (annModal) {
                    if (!openedViaNative) {
                        annModal.dataset.voiceDemoFallback = '1';
                        const area = document.getElementById('pmPublicAnnounceTextarea');
                        if (area) area.value = buildSampleAnnouncementTextForVoice(grp, styleMode);
                        const fbBtn = document.getElementById('pmAnnStyleBtn-facebook');
                        const lnBtn = document.getElementById('pmAnnStyleBtn-line');
                        const applyDemoStyleBtns = (m) => {
                            if (fbBtn) fbBtn.className = m === 'facebook' ? 'flex-1 py-1.5 rounded-lg bg-blue-600 text-white font-extrabold text-xs shadow' : 'flex-1 py-1.5 rounded-lg text-slate-600 hover:bg-slate-200 font-bold text-xs';
                            if (lnBtn) lnBtn.className = m === 'line' ? 'flex-1 py-1.5 rounded-lg bg-[#00B900] text-white font-extrabold text-xs shadow' : 'flex-1 py-1.5 rounded-lg text-slate-600 hover:bg-slate-200 font-bold text-xs';
                        };
                        applyDemoStyleBtns(styleMode);
                        if (fbBtn && !fbBtn.__voiceFallbackHooked) {
                            fbBtn.__voiceFallbackHooked = true;
                            fbBtn.addEventListener('click', () => {
                                if (annModal.dataset.voiceDemoFallback === '1' && area) {
                                    area.value = buildSampleAnnouncementTextForVoice(getActiveVoiceGroup(), 'facebook');
                                    applyDemoStyleBtns('facebook');
                                }
                            });
                        }
                        if (lnBtn && !lnBtn.__voiceFallbackHooked) {
                            lnBtn.__voiceFallbackHooked = true;
                            lnBtn.addEventListener('click', () => {
                                if (annModal.dataset.voiceDemoFallback === '1' && area) {
                                    area.value = buildSampleAnnouncementTextForVoice(getActiveVoiceGroup(), 'line');
                                    applyDemoStyleBtns('line');
                                }
                            });
                        }
                        annModal.classList.remove('hidden');
                    } else {
                        delete annModal.dataset.voiceDemoFallback;
                    }
                    annModal.style.zIndex = '1465';
                }

                setLiveActionSubtext('📢 สร้างโพสต์ประกาศแจ้งไฟดับ Facebook / LINE พร้อมลิงก์เรดาร์');
                return {
                    ok: true,
                    step: 'announce_post',
                    styleMode,
                    publicOutageRadarUrl: getPublicOutageRadarUrl(false),
                    highlights: [
                        'เรียบเรียงวันที่ ช่วงเวลา สาเหตุ และรายชื่อสถานที่ได้รับผลกระทบให้อัตโนมัติ',
                        'ตัดรหัสสวิตช์และโน้ตภายในของช่างออกเพื่อความปลอดภัย',
                        'แนบลิงก์แผนที่เรดาร์ท้ายโพสต์ให้ประชาชนคลิกตรวจสอบพิกัดบ้านตนเองได้ทันที'
                    ]
                };
            }

            if (step === 'public_radar_map') {
                closeVoiceOpenedPmDraftOnly();
                window.closePmCalendarModal?.();
                openPeaLivePublicRadarPreview(Number(snap.pmPublicOutageZones) || 0);
                setLiveActionSubtext('📡 เปิดหน้าเว็บเรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟ (outage-map.html)');
                return {
                    ok: true,
                    step: 'public_radar_map',
                    branchGroup: grp,
                    publicOutageRadarUrl: getPublicOutageRadarUrl(false),
                    activePublicOutageZones: Number(snap.pmPublicOutageZones) || 0,
                    citizenUsageFeatures: [
                        'ผู้ใช้ไฟเปิดผ่านลิงก์จากเพจ Facebook หรือ LINE ได้ทันทีโดยไม่ต้องล็อกอิน',
                        'กดปุ่มตรวจสอบพิกัด GPS ปัจจุบันจากสมาร์ทโฟน หรือเลื่อนหมุดไปยังตำแหน่งบ้านและสถานประกอบการของตนเอง',
                        'ระบบเรดาร์คำนวณทันทีว่าจุดติดตั้งมิเตอร์อยู่ในเขตพื้นที่ไฟดับสีแดงหรือไม่ พร้อมบอกวัน เวลา และสาเหตุการปฏิบัติงานชัดเจน'
                    ]
                };
            }

            return { ok: false, error: 'ไม่รู้จักขั้นตอน step ที่ระบุ' };
        }

        // ====================================================================
        // 🎯 เครื่องมือสาธิตหากระแสฟอลต์ & ชี้เป้าจุดเกิดฟอลต์ (สำรองและคืนค่าฟอร์มจริงอัตโนมัติ)
        // ====================================================================
        if (name === 'demoScadaFaultSearch') {
            const scadaWin = await ensureScadaMapWindowReady();
            const branchPins = getBranchScadaPinsFromWin(scadaWin);

            const reqAmp = Math.max(50, Math.round(Number(args.faultAmp) || 1850));
            const reqKm = Number((Math.max(0.2, Number(args.distanceKm) || 4.2)).toFixed(2));
            const reqPhase = cleanVal(args.phase) || 'A-G';

            let chosenFeeder = cleanVal(args.feeder).toUpperCase();
            if (!chosenFeeder) {
                const pinWithFd = branchPins.find(p => p.scadaNode?.fd);
                chosenFeeder = pinWithFd?.scadaNode?.fd || 'F1';
            }
            const fdNumMatch = chosenFeeder.match(/F0*(\d{1,2})$/i) || chosenFeeder.match(/^(\d{1,2})$/);
            const circuitForTab1 = fdNumMatch ? `F${parseInt(fdNumMatch[1], 10)}` : (/^F\d+$/i.test(chosenFeeder) ? chosenFeeder : 'F1');
            const fdRegex = fdNumMatch ? new RegExp(`F0*${parseInt(fdNumMatch[1], 10)}(?!\\d)`, 'i') : null;

            const feederPins = branchPins.filter(p => {
                const pFd = String(p.scadaNode?.fd || '');
                return (pFd && normToken(pFd) === normToken(chosenFeeder)) || (fdRegex && fdRegex.test(pFd));
            });
            const candidatePool = feederPins.length > 0 ? feederPins : branchPins;
            const targetPin = candidatePool.length > 0
                ? candidatePool[Math.min(candidatePool.length - 1, Math.max(0, Math.floor(candidatePool.length * 0.45)))]
                : null;

            let clickedNativeSearchBtn = false;
            const isEditingRealFault = Boolean(rawGet('elec_editing_fault_id'));

            if (document.getElementById('sortable-tab1') && !isViewer() && !isEditingRealFault) {
                snapshotTab1BeforeDemo();
                window.switchTab?.('tab1');
                isApplyingTab1DemoFill = true;
                try {
                    const sysEl = document.getElementById('systemSelect');
                    if (sysEl) { sysEl.value = '22kV'; window.updateCircuitDropdown?.(); }

                    const cirEl = document.getElementById('circuitSelect');
                    if (cirEl) { cirEl.value = circuitForTab1; cirEl.dispatchEvent(new Event('change', { bubbles: true })); }

                    const rawStation = cleanVal(args.station);
                    if (rawStation) {
                        window.selectStation?.(rawStation);
                    } else if (!document.getElementById('stationValue')?.value) {
                        const firstSt = document.querySelector('#stationSortableList [data-value]')?.getAttribute('data-value');
                        if (firstSt) window.selectStation?.(firstSt);
                    }

                    const setIfEl = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
                    setIfEl('causeSelect', 'Trip');
                    setIfEl('countSelect', '1');
                    setIfEl('tlSelect', 'T/R');
                    setIfEl('phaseSelect', reqPhase);
                    setIfEl('currA', /A/i.test(reqPhase) ? String(reqAmp) : '');
                    setIfEl('currB', /B/i.test(reqPhase) ? String(reqAmp) : '');
                    setIfEl('currC', /C/i.test(reqPhase) ? String(reqAmp) : '');
                    setIfEl('currG', /G/i.test(reqPhase) ? String(Math.round(reqAmp * 0.65)) : '');
                    setIfEl('distanceInput', `${reqKm} กม.`);
                    if (targetPin?.name) setIfEl('deviceInput', targetPin.name);

                    const kmInp = document.getElementById('tab1QuickFaultKmInput');
                    const ampInp = document.getElementById('tab1QuickFaultAmpInput');
                    if (kmInp) {
                        kmInp.value = String(reqKm);
                        kmInp.dispatchEvent(new Event('input', { bubbles: true }));
                        kmInp.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (ampInp) {
                        ampInp.value = String(reqAmp);
                        ampInp.dispatchEvent(new Event('input', { bubbles: true }));
                        ampInp.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                } finally {
                    isApplyingTab1DemoFill = false;
                }
                hideFormFloatingMenus(['suggest-device', 'suggest-disconnect', 'suggest-powerup', 'stationDropdownMenu', 'tambonDropdownMenu']);

                const mapRef = scadaWin?.__labeledLeafletMap;
                const prevCenter = mapRef?.getCenter?.();
                const prevZoom = mapRef?.getZoom?.();

                // ไต่ขึ้นจาก parentElement เพื่อไม่ให้ .closest() จับโดนตัวช่อง <input> เอง
                const anchorInp = document.getElementById('tab1QuickFaultAmpInput') || document.getElementById('tab1QuickFaultKmInput');
                const quickBox = anchorInp?.parentElement?.closest('[data-id], .rounded-2xl, .rounded-xl') || anchorInp?.parentElement?.parentElement;
                if (quickBox) {
                    quickBox.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
                    const btns = Array.from(quickBox.querySelectorAll('button')).filter(b => {
                        const txt = `${b.textContent || ''} ${b.getAttribute('onclick') || ''}`;
                        return !/ล้าง|ยกเลิก|ตั้งค่า|calib|reset|clear/i.test(txt) &&
                               /ชี้เป้า|ค้นหา|คำนวณ|ฟอลต์|fault|scada|locate|amp|กม/i.test(txt);
                    });
                    const bestBtn = btns.find(b => /amp|กระแส/i.test(`${b.textContent} ${b.getAttribute('onclick')}`)) || btns[0];
                    if (bestBtn) {
                        const origMainAlert = window.showCustomAlert;
                        const origScadaAlert = scadaWin && scadaWin !== window ? scadaWin.showCustomAlert : null;
                        let suppressedAlert = false;
                        if (typeof origMainAlert === 'function') window.showCustomAlert = () => { suppressedAlert = true; };
                        if (scadaWin && scadaWin !== window && typeof origScadaAlert === 'function') scadaWin.showCustomAlert = () => { suppressedAlert = true; };
                        try {
                            bestBtn.click();
                            clickedNativeSearchBtn = true;
                            await new Promise(r => setTimeout(r, 420));
                        } finally {
                            if (typeof origMainAlert === 'function') window.showCustomAlert = origMainAlert;
                            if (scadaWin && scadaWin !== window && typeof origScadaAlert === 'function') scadaWin.showCustomAlert = origScadaAlert;
                            if (suppressedAlert) {
                                document.getElementById('customAlertModal')?.classList.add('hidden');
                                scadaWin?.document?.getElementById('customAlertModal')?.classList.add('hidden');
                            }
                        }
                    }
                }

                const afterCenter = mapRef?.getCenter?.();
                const afterZoom = mapRef?.getZoom?.();
                const nativeMapMoved = Boolean(
                    prevCenter && afterCenter &&
                    (Math.hypot(prevCenter.lat - afterCenter.lat, prevCenter.lng - afterCenter.lng) > 0.0002 || prevZoom !== afterZoom)
                );
                if (nativeMapMoved) {
                    clearDemoFaultHighlightLayer(scadaWin);
                    setLiveActionSubtext(`🎯 ชี้เป้ากระแสฟอลต์จำลอง ${reqAmp} A (~${reqKm} กม.) สำเร็จ`);
                    return {
                        ok: true,
                        simulationOnly: true,
                        feeder: chosenFeeder,
                        circuit: circuitForTab1,
                        faultAmp: reqAmp,
                        estimatedDistanceKm: reqKm,
                        phase: reqPhase,
                        nearEquipment: targetPin?.name || '-',
                        locatedByNativeEngine: true,
                        note: 'เป็นการจำลองคำนวณระยะทางและชี้เป้าจุดเสียบนระบบสกาด้าจำลองเท่านั้น ไม่ใช่งานโอเปอเรทจริง'
                    };
                }
            }

            const map = scadaWin?.__labeledLeafletMap;
            const LRef = scadaWin?.L;
            if (map && LRef && targetPin && !isNaN(parseFloat(targetPin.lat)) && !isNaN(parseFloat(targetPin.lon))) {
                clearDemoFaultHighlightLayer(scadaWin);
                const tLat = parseFloat(targetPin.lat), tLon = parseFloat(targetPin.lon);
                map.invalidateSize?.();
                map.setView([tLat, tLon], 16);

                const ring = LRef.circle([tLat, tLon], {
                    radius: 180,
                    color: '#ef4444',
                    weight: 3,
                    dashArray: '6 4',
                    fillColor: '#f43f5e',
                    fillOpacity: 0.28
                }).addTo(map);
                ring.bindPopup(
                    `<div style="font-family:'Prompt',sans-serif;min-width:210px;" class="text-xs space-y-1">` +
                    `<div class="font-extrabold text-rose-600">🎯 ชี้เป้าจุดเกิดฟอลต์ (ระบบสกาด้าจำลอง)</div>` +
                    `<div>⚡ <b>วงจร:</b> ${safeEsc(chosenFeeder)} (${safeEsc(reqPhase)})</div>` +
                    `<div>💥 <b>กระแสฟอลต์จำลอง:</b> ${reqAmp.toLocaleString('en-US')} A (~${reqKm} กม.)</div>` +
                    `<div>📟 <b>ใกล้หมุดอุปกรณ์:</b> ${safeEsc(targetPin.name)}</div>` +
                    `<div class="text-[10px] text-slate-500 pt-0.5">*จำลองวิเคราะห์จุดเสียเพื่อวางแผนเท่านั้น ไม่ใช่งานโอเปอเรทจริง</div>` +
                    `</div>`
                ).openPopup();
                demoFaultHighlightLayer = ring;
            }

            setLiveActionSubtext(`🎯 สาธิตหากระแสฟอลต์ ${reqAmp} A (~${reqKm} กม.) วงจร ${chosenFeeder}`);
            return {
                ok: true,
                simulationOnly: true,
                feeder: chosenFeeder,
                circuit: circuitForTab1,
                faultAmp: reqAmp,
                estimatedDistanceKm: reqKm,
                phase: reqPhase,
                nearEquipment: targetPin?.name || 'จุดจำลองบนแนวสายส่ง',
                filledTab1Form: Boolean(document.getElementById('sortable-tab1') && !isEditingRealFault),
                triggeredSearchButton: clickedNativeSearchBtn,
                note: 'เป็นการจำลองคำนวณชี้เป้าจุดเกิดฟอลต์บนระบบสกาด้าจำลองเท่านั้น ไม่ใช่งานโอเปอเรทจริง'
            };
        }

        // ====================================================================
        // 🔀 เครื่องมือสาธิตจำลองปลด-สับสวิตช์ในโหมด Sandbox (ไม่กระทบข้อมูลจริง 100%)
        // ====================================================================
        if (name === 'demoScadaSwitchSimulation') {
            const rawAction = String(args.action || 'toggle').toLowerCase().trim();

            if (rawAction === 'exit_sim' || rawAction === 'reset' || rawAction === 'exit') {
                activatedSimByVoice = true;
                exitVoiceActivatedSimModeIfNeeded();
                setLiveActionSubtext('↩️ ออกจากโหมดจำลอง คืนค่าผังปกติเรียบร้อย');
                return { ok: true, simulationActive: false, message: 'ออกจากโหมดจำลองและคืนค่าผังสกาด้ากลับสู่สถานะปกติแล้วค่ะ' };
            }

            const scadaWin = await ensureScadaMapWindowReady();
            if (!scadaWin || !scadaWin.document) {
                return { ok: false, error: 'ไม่สามารถเปิดหน้าต่างแผนที่ระบบสกาด้าจำลองได้ในขณะนี้ค่ะ' };
            }

            const checkSimOn = () => Boolean(
                scadaWin.PeaCore?.simSandbox?.active ||
                scadaWin.document?.body?.classList.contains('scada-sim-active')
            );
            if (!checkSimOn()) {
                if (typeof scadaWin.toggleScadaSimMode === 'function') {
                    scadaWin.toggleScadaSimMode(true);
                } else {
                    scadaWin.document.getElementById('btnToggleScadaSimMode')?.click();
                }
                activatedSimByVoice = true;
                await new Promise(r => setTimeout(r, 260));
            }
            if (!checkSimOn()) {
                return {
                    ok: false,
                    error: 'ไม่สามารถเปิดโหมดจำลอง (Sandbox) ได้ ระบบจึงระงับการสลับสถานะสวิตช์เพื่อป้องกันไม่ให้กระทบข้อมูลจริงค่ะ'
                };
            }

            const switchTypes = ['VS', 'VSC', 'RC', 'CB', 'S', 'VB', 'DF'];
            const allPins = getBranchScadaPinsFromWin(scadaWin);
            const switchPins = allPins.filter(p => switchTypes.includes(String(p.scadaNode?.t || '').toUpperCase()));

            if (switchPins.length === 0) {
                setLiveActionSubtext('⚡ เปิดโหมดจำลองสกาด้าแล้ว (สาขานี้ยังไม่มีหมุดสวิตช์)');
                return {
                    ok: true,
                    simulationActive: true,
                    noSwitchPinsYet: true,
                    message: 'เปิดโหมดจำลองในระบบสกาด้าจำลองแล้วค่ะ แต่สาขานี้ยังไม่ได้ปักหมุดสวิตช์ลงบนแผนที่ สามารถกดปุ่มปลดหรือสับหลังจากเพิ่มหมุดสวิตช์ได้ค่ะ'
                };
            }

            const reqCode = cleanVal(args.equipCode);
            let targetPin = null;
            if (reqCode) {
                const qNorm = normToken(reqCode);
                targetPin = switchPins.find(p => normToken(p.name) === qNorm || normToken(p.scadaNode?.id) === qNorm) ||
                            switchPins.find(p => normToken(p.name).includes(qNorm) || qNorm.includes(normToken(p.name)));
            }
            if (!targetPin) {
                if (rawAction === 'close') {
                    targetPin = switchPins.find(p => p.scadaNode?.st === 'O' && !p.scadaNode?.loto) || switchPins.find(p => !p.scadaNode?.loto) || switchPins[0];
                } else {
                    targetPin = switchPins.find(p => p.scadaNode?.st === 'C' && !p.scadaNode?.loto) || switchPins.find(p => !p.scadaNode?.loto) || switchPins[0];
                }
            }

            const prevState = String(targetPin.scadaNode?.st || 'C').toUpperCase();
            let desiredState = prevState === 'O' ? 'C' : 'O';
            if (rawAction === 'open') desiredState = 'O';
            else if (rawAction === 'close') desiredState = 'C';
            else if (rawAction === 'fault') desiredState = 'F';

            const map = scadaWin.__labeledLeafletMap;
            const pLat = parseFloat(targetPin.lat), pLon = parseFloat(targetPin.lon);
            if (map && !isNaN(pLat) && !isNaN(pLon)) {
                map.invalidateSize?.();
                map.setView([pLat, pLon], 16);
            }

            if (desiredState === 'C' && targetPin.scadaNode?.loto) {
                const lotoMarker = findLeafletMarkerForPin(scadaWin, map, targetPin);
                lotoMarker?.openPopup?.();
                setLiveActionSubtext(`🔒 แจ้งเตือน LOTO ห้ามสับ "${targetPin.name}"`);
                return {
                    ok: false,
                    lotoBlocked: true,
                    equipCode: targetPin.name,
                    lotoReason: targetPin.scadaNode.loto,
                    message: `สวิตช์ ${targetPin.name} ติดป้ายห้ามสับไฟ LOTO (${targetPin.scadaNode.loto}) ระบบสกาด้าจำลองจึงบล็อกการจำลองสับจ่ายไฟเพื่อความปลอดภัยค่ะ`
                };
            }

            const readCurrentSimSt = () => {
                const fresh = getBranchScadaPinsFromWin(scadaWin).find(p => p.id === targetPin.id);
                return String(fresh?.scadaNode?.st || prevState).toUpperCase();
            };

            const marker = findLeafletMarkerForPin(scadaWin, map, targetPin);
            if (marker) {
                marker.openPopup?.();
                await new Promise(r => setTimeout(r, 180));

                const popupRoot = scadaWin.document.querySelector('.leaflet-popup-content');
                if (popupRoot) {
                    // กรองปุ่มส่งรหัสเข้าฟอร์มแท็บ 1 ออกอย่างเข้มงวด ป้องกันการคลิกผิดปุ่ม
                    const popupBtns = Array.from(popupRoot.querySelectorAll('button')).filter(b => {
                        const sig = `${b.textContent || ''} ${b.getAttribute('onclick') || ''}`;
                        return !/openEquipPinModal|startLabeledPlaceNavigation|SCADA_FILL|sendScada|fillFault|ส่งเป็น|ส่งรหัส|เข้าฟอร์ม|pm-create|ลบ|แก้ไข|นำทาง|คัดลอก|loto/i.test(sig);
                    });
                    const stateRegex = desiredState === 'O'
                        ? /ปลดสวิตช์|จำลองปลด|\bOPEN\b|['"](?:O|open)['"]/i
                        : (desiredState === 'C'
                            ? /สับสวิตช์|จำลองสับ|สับจ่าย|ต่อไฟ|\bCLOSE\b|['"](?:C|close)['"]/i
                            : /จำลองฟอลต์|ทริป|\bFAULT\b|['"](?:F|fault)['"]/i);
                    const matchedBtn = popupBtns.find(b => stateRegex.test(`${b.textContent || ''} ${b.getAttribute('onclick') || ''}`)) ||
                                       popupBtns.find(b => /สลับสถานะ|toggle.*sim|sim.*toggle/i.test(`${b.textContent || ''} ${b.getAttribute('onclick') || ''}`));
                    if (matchedBtn) {
                        matchedBtn.click();
                        await new Promise(r => setTimeout(r, 220));
                    }
                }
            }

            // อัปเดตสถานะใน RAM Sandbox และสั่งคำนวณสีแนวสายส่งใหม่ทันทีหากยังไม่ได้เปลี่ยนสถานะ
            if (readCurrentSimSt() !== desiredState && scadaWin.PeaCore?.simSandbox?.active) {
                try {
                    const simList = JSON.parse(scadaWin.localStorage.getItem('elec_labeled_places_list') || '[]');
                    const idx = simList.findIndex(p => p && p.id === targetPin.id);
                    if (idx !== -1 && simList[idx].scadaNode) {
                        simList[idx].scadaNode.st = desiredState;
                        simList[idx].scadaNode.col = desiredState === 'F' ? '#ef4444' : (desiredState === 'O' ? '#eab308' : '#10b981');
                        simList[idx].pinColor = desiredState === 'F' ? 'red' : (desiredState === 'O' ? 'yellow' : 'green');
                        scadaWin.localStorage.setItem('elec_labeled_places_list', JSON.stringify(simList));
                        scadaWin.loadLabeledPlacesFromStorage?.();
                        scadaWin.PeaCore?.emitRealtimeChange?.(['elec_labeled_places_list']);
                        scadaWin.renderLabeledPlacesOnMap?.();
                        scadaWin.refreshScadaTopology?.();
                        await new Promise(r => setTimeout(r, 120));
                        const refreshedMarker = findLeafletMarkerForPin(scadaWin, map, targetPin);
                        refreshedMarker?.openPopup?.();
                    }
                } catch (e) {}
            }

            const finalState = readCurrentSimSt();
            const stateThai = { C: 'สับจ่ายไฟจำลอง (Closed)', O: 'ปลดสวิตช์จำลอง (Open)', F: 'ทริป/ฟอลต์จำลอง (Fault)' }[finalState] || finalState;
            setLiveActionSubtext(`🔀 จำลอง${finalState === 'O' ? 'ปลด' : (finalState === 'C' ? 'สับ' : 'ฟอลต์')} "${targetPin.name}" (โหมดสกาด้าจำลอง)`);

            return {
                ok: true,
                simulationSandboxActive: true,
                realDataUntouched: true,
                equipCode: targetPin.name,
                feeder: targetPin.scadaNode?.fd || '-',
                previousState: prevState,
                simulatedState: finalState,
                simulatedStateLabel: stateThai,
                note: 'ดำเนินการในโหมดจำลอง (Sandbox) ของระบบสกาด้าจำลองเท่านั้น ไม่ใช่งานโอเปอเรทสั่งการจริง และไม่กระทบข้อมูลจริงบนคลาวด์'
            };
        }

        if (name === 'demoCalculate22kVFuse') {
            const sel = document.querySelector('#transformer-list select.tx-input');
            const domKvaList = sel
                ? Array.from(sel.options).map(o => parseFloat(o.value)).filter(n => !isNaN(n) && n > 0)
                : [];
            const allowedKva = domKvaList.length > 0
                ? domKvaList
                : [30, 50, 100, 160, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000];
            const reqKva = Number(args.kva) || 160;
            const nearestKva = allowedKva.reduce((prev, curr) => Math.abs(curr - reqKva) < Math.abs(prev - reqKva) ? curr : prev, allowedKva[0]);
            const qty = Math.max(1, Math.round(Number(args.qty) || 1));
            const mult = Math.max(1, Number(args.multiplier) || 1.5);

            const totalKvaNum = nearestKva * qty;
            const ratedAmpNum = nearestKva === 30 ? (totalKvaNum / 22) : (totalKvaNum / (1.73205 * 22));
            const inrushAmpNum = ratedAmpNum * mult;
            const stdFuse = [2, 3, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 65, 80, 100, 140, 200].find(f => f >= inrushAmpNum);

            if (sel && document.getElementById('mainAppContent')) {
                closeVoiceOpenedPmAndRadarModals();
                closeVoiceOpenedLeftDockIfNeeded();
                window.switchTab?.('tab3');

                const rows = document.querySelectorAll('#transformer-list > .flex');
                rows.forEach((row, idx) => { if (idx > 0) row.remove(); });

                const qtyInp = document.querySelector('#transformer-list input.tx-qty');
                const multInp = document.getElementById('multiplier-input');
                const exactOpt = Array.from(sel.options).find(o => parseFloat(o.value) === nearestKva);
                sel.value = exactOpt ? exactOpt.value : String(nearestKva);
                if (qtyInp) qtyInp.value = String(qty);
                if (multInp) multInp.value = String(mult);
                window.calculateFuseCalc?.();
            }

            setLiveActionSubtext(`🧮 คำนวณฟิวส์หม้อแปลง ${nearestKva} kVA x ${qty} ลูก`);
            const inrushSpan = document.querySelector('#res-inrush-label span');
            return {
                ok: true,
                transformerKva: nearestKva,
                quantity: qty,
                multiplier: mult,
                totalKvaText: (document.getElementById('res-kva')?.textContent || '').trim() || `${totalKvaNum.toLocaleString('en-US')} kVA`,
                ratedAmpText: (document.getElementById('res-amp')?.textContent || '').trim() || `${ratedAmpNum.toFixed(2)} A`,
                inrushAmpText: (inrushSpan?.textContent || document.getElementById('res-inrush')?.textContent || '').trim() || `${inrushAmpNum.toFixed(2)} A`,
                recommendedFuseTypeK: (document.getElementById('res-fuse')?.textContent || '').replace(/\s+/g, ' ').trim() || `${stdFuse || 'มากกว่า 200'} A`
            };
        }

        if (name === 'fillOutageReportByVoice') {
            if (isViewer()) return { ok: false, error: 'บัญชีผู้สำรวจไม่สามารถกรอกแก้ไขข้อมูลได้ค่ะ' };
            if (!document.getElementById('sortable-tab2')) return { ok: false, error: 'กรุณาเปิดหน้าหลัก (index.html) เพื่อกรอกฟอร์มรับแจ้งค่ะ' };
            closeVoiceOpenedPmAndRadarModals();
            closeVoiceOpenedLeftDockIfNeeded();
            window.switchTab?.('tab2');

            let filledCount = 0;
            let cleanPhone = cleanVal(args.phone).replace(/[^\d+]/g, '');
            if (/^\+?66\d{8,9}$/.test(cleanPhone)) {
                cleanPhone = '0' + cleanPhone.replace(/^\+?66/, '');
            }
            cleanPhone = cleanPhone.replace(/\D/g, '');

            [['issueType', args.issueType], ['workerName', args.workerName], ['area', args.area], ['phone', cleanPhone || args.phone]].forEach(([id, raw]) => {
                const val = cleanVal(raw);
                const el = document.getElementById(id);
                if (val && el) {
                    el.value = val;
                    filledCount++;
                }
            });

            const addr = cleanVal(args.address);
            const ca = cleanVal(args.caNo).replace(/\D/g, '');
            const pea = cleanVal(args.peaNo);
            if (addr || ca || pea) {
                const addrEl = document.getElementById('address');
                if (addrEl) {
                    const prevLines = String(addrEl.value || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                    const prevStreetLines = prevLines.filter(l => !/^(?:CA|มิเตอร์\s*-\s*PEA\s*No\.)\s*:/i.test(l));
                    const prevCaLine = prevLines.find(l => /^CA\s*:/i.test(l)) || '';
                    const prevPeaLine = prevLines.find(l => /^มิเตอร์\s*-\s*PEA\s*No\.\s*:/i.test(l)) || '';

                    const streetPart = addr || prevStreetLines.join('\n');
                    const finalParts = streetPart ? [streetPart] : [];
                    const finalCaLine = ca ? `CA : ${ca}` : prevCaLine;
                    const finalPeaLine = pea ? `มิเตอร์ - PEA No. : ${pea}` : prevPeaLine;

                    const streetHasCa = ca && streetPart.includes(ca);
                    const escPea = pea ? pea.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
                    const streetHasPea = pea && new RegExp(`(?:PEA\\s*No\\.?|มิเตอร์)\\s*[:：=]?\\s*${escPea}(?!\\w)`, 'i').test(streetPart);

                    if (finalCaLine && !streetHasCa) finalParts.push(finalCaLine);
                    if (finalPeaLine && !streetHasPea) finalParts.push(finalPeaLine);

                    addrEl.value = finalParts.join('\n');
                    addrEl.style.height = 'auto';
                    addrEl.style.height = addrEl.scrollHeight + 'px';
                    addrEl.dispatchEvent(new Event('input', { bubbles: true }));
                    filledCount++;
                }
            }

            const gps = cleanVal(args.gps);
            if (gps) {
                if (isLikelyValidGpsOrMapUrl(gps)) {
                    const gpsEl = document.getElementById('gps');
                    if (gpsEl) { gpsEl.value = gps; gpsEl.dispatchEvent(new Event('input', { bubbles: true })); filledCount++; }
                } else {
                    const areaEl = document.getElementById('area');
                    if (areaEl && !areaEl.value.trim()) {
                        areaEl.value = gps;
                        filledCount++;
                    }
                }
            }

            hideFormFloatingMenus(['suggest-issue', 'suggest-worker', 'suggest-area', 'issueDropdownMenu']);
            window.autoFillJobNo?.(false);
            window.checkCaOverdueEnhanced?.(false);
            window.saveOutageDraft?.();
            document.getElementById('sortable-tab2')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setLiveActionSubtext('✍️ กรอกข้อมูลลงฟอร์มรับแจ้งแท็บ 2 เรียบร้อย');

            const isCaOverdue = !document.getElementById('caOverdueBanner')?.classList.contains('hidden');
            return {
                ok: true,
                filledFields: filledCount,
                assignedJobNo: document.getElementById('jobNo')?.value || '-',
                shift: document.getElementById('shift')?.value || '-',
                caOverdueDetected: isCaOverdue
            };
        }

        if (name === 'fillFaultReportByVoice') {
            if (isViewer()) return { ok: false, error: 'บัญชีผู้สำรวจไม่สามารถกรอกแก้ไขข้อมูลได้ค่ะ' };
            if (!document.getElementById('sortable-tab1')) return { ok: false, error: 'กรุณาเปิดหน้าหลัก (index.html) เพื่อกรอกฟอร์ม TR/TL ค่ะ' };
            // ล้างตัวสำรองโหมดสาธิตทันทีเมื่อผู้ใช้สั่งกรอกข้อมูลเหตุจริงลงฟอร์มแท็บ 1
            restoreTab1DemoBackupIfNeeded();
            discardTab1DemoBackup();
            closeVoiceOpenedPmAndRadarModals();
            if (window.innerWidth < 1024) closeVoiceOpenedLeftDockIfNeeded();
            window.switchTab?.('tab1');

            const setSelectSmart = (el, val) => {
                if (!el || !val || el.tagName !== 'SELECT') return false;
                el.value = val;
                if (el.value !== val) {
                    const targetNorm = normToken(val);
                    const matched = Array.from(el.options).find(o => o.value && (normToken(o.value) === targetNorm || normToken(o.text) === targetNorm));
                    if (matched) el.value = matched.value;
                }
                if (el.value) {
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
                return false;
            };

            let sys = cleanVal(args.system);
            let cir = cleanVal(args.circuit).toUpperCase().replace(/\s+/g, ' ').trim();
            if (/^LINE\s*(\d+)$/i.test(cir)) {
                cir = cir.replace(/^LINE\s*(\d+)$/i, 'LINE $1');
            } else if (/^\d{1,2}$/.test(cir)) {
                cir = sys.includes('115') ? `LINE ${cir}` : `F${cir}`;
            }

            if (!sys && cir) {
                if (cir.startsWith('LINE')) sys = '115kV';
                else if (/^F\d+$/i.test(cir)) sys = '22kV';
            }

            const sysEl = document.getElementById('systemSelect');
            if (sys && (sys.includes('115') || sys.includes('22'))) {
                if (sysEl) { sysEl.value = sys.includes('115') ? '115kV' : '22kV'; window.updateCircuitDropdown?.(); }
            } else if (sysEl && !sysEl.value) {
                sysEl.value = '22kV';
                window.updateCircuitDropdown?.();
            }

            if (cir) setSelectSmart(document.getElementById('circuitSelect'), cir);

            const rawStation = cleanVal(args.station)
                .replace(/^สถานี(?:ไฟฟ้า)?\s*/i, '')
                .replace(/หนึ่ง$/, '1').replace(/สอง$/, '2').replace(/สาม$/, '3').replace(/สี่$/, '4')
                .replace(/\s+(\d+)/g, '$1').trim();
            if (rawStation) {
                const stItems = Array.from(document.querySelectorAll('#stationSortableList [data-value]')).map(li => li.getAttribute('data-value')).filter(Boolean);
                const stMatched = stItems.find(stName => normToken(stName) === normToken(rawStation));
                window.selectStation?.(stMatched || rawStation);
            }

            let rawCause = cleanVal(args.cause);
            let rawTl = cleanVal(args.tlStatus);
            if (/^T\/?[RL]$/i.test(rawCause) && !rawTl) {
                rawTl = /^T\/?R$/i.test(rawCause) ? 'T/R' : 'T/L';
                rawCause = '';
            } else if (/^TR$/i.test(rawTl)) {
                rawTl = 'T/R';
            } else if (/^TL$/i.test(rawTl)) {
                rawTl = 'T/L';
            }

            if (rawCause) setSelectSmart(document.getElementById('causeSelect'), rawCause);
            if (rawTl) {
                const tlMatched = setSelectSmart(document.getElementById('tlSelect'), rawTl);
                if (!tlMatched && !rawCause) setSelectSmart(document.getElementById('causeSelect'), rawTl);
            }
            const cleanCount = cleanVal(args.count).replace(/[^\d]/g, '');
            const cleanPhase = cleanVal(args.phase).replace(/^(?:โชว์)?เฟส\s*/i, '').trim();
            if (cleanCount) setSelectSmart(document.getElementById('countSelect'), cleanCount);
            if (cleanPhase) setSelectSmart(document.getElementById('phaseSelect'), cleanPhase);

            [['deviceInput', args.device], ['disconnectDeviceInput', args.disconnectDevice], ['reporterInput', args.reporter]].forEach(([id, raw]) => {
                const val = cleanVal(raw);
                const el = document.getElementById(id);
                if (val && el) {
                    el.value = val;
                    if (id !== 'reporterInput') el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });

            hideFormFloatingMenus(['suggest-device', 'suggest-disconnect', 'suggest-powerup', 'stationDropdownMenu', 'tambonDropdownMenu']);
            window.saveFaultDraft?.();
            setLiveActionSubtext('⚡ กรอกฟอร์มรายงานเหตุสถานี (TR/TL) เรียบร้อย');
            return { ok: true };
        }

        return { ok: false, error: 'ไม่รู้จักคำสั่งนี้' };
    }
// ===== จบพาทที่ 1 / 2 ของไฟล์ pea-live-voice.js (v2.7) — ตอบรับเพื่อรับพาทที่ 2 ต่อด้านล่าง =====
    // ==================== เริ่มพาทที่ 2 / 2 (วางต่อจากพาทที่ 1 จนจบไฟล์) ====================
    // ========================================================================
    // 4. ระบบประมวลผลเสียง PCM 16kHz (พร้อม Mic Singleton Lock & Async Audio Guard)
    // ========================================================================
    let hasAudioArrivedSinceLastMajorUiStep = true;
    let lastMajorUiStepAtMs = 0;

    function unlockOutputAudioContextOnGesture() {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!outputAudioCtx || outputAudioCtx.state === 'closed') {
            try { outputAudioCtx = new AudioCtx({ sampleRate: 24000 }); }
            catch (e) { outputAudioCtx = new AudioCtx(); }
        }
        if (outputAudioCtx.state === 'suspended' || outputAudioCtx.state === 'interrupted') {
            outputAudioCtx.resume().catch(() => {});
        }
        try {
            const silentBuf = outputAudioCtx.createBuffer(1, 1, 22050);
            const src = outputAudioCtx.createBufferSource();
            src.buffer = silentBuf;
            src.connect(outputAudioCtx.destination);
            src.start(0);
        } catch (e) {}
    }

    function int16ToBase64(int16Arr) {
        const bytes = new Uint8Array(int16Arr.buffer, int16Arr.byteOffset, int16Arr.byteLength);
        const len = bytes.length;
        const parts = [];
        const chunk = 4096;
        for (let i = 0; i < len; i += chunk) {
            parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(len, i + chunk))));
        }
        return btoa(parts.join(''));
    }

    function base64ToFloat32Pcm(b64Str) {
        try {
            let cleanB64 = String(b64Str || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
            if (!cleanB64) return new Float32Array(0);
            const mod = cleanB64.length % 4;
            if (mod > 0) cleanB64 += '='.repeat(4 - mod);
            const bin = atob(cleanB64);
            const byteLen = bin.length - (bin.length % 2);
            if (byteLen <= 0) return new Float32Array(0);
            const buf = new ArrayBuffer(byteLen);
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < byteLen; i++) bytes[i] = bin.charCodeAt(i);
            const view = new DataView(buf);
            const samples = byteLen / 2;
            const float32 = new Float32Array(samples);
            for (let i = 0; i < samples; i++) {
                float32[i] = view.getInt16(i * 2, true) / 32768.0;
            }
            return float32;
        } catch (e) {
            return new Float32Array(0);
        }
    }

    function downsampleFloat32(buffer, inRate, outRate) {
        if (inRate === outRate) return buffer;
        const ratio = inRate / outRate;
        const newLen = Math.round(buffer.length / ratio);
        const result = new Float32Array(newLen);
        let offsetRes = 0, offsetBuf = 0;
        while (offsetRes < result.length) {
            const nextOffsetBuf = Math.min(buffer.length, Math.round((offsetRes + 1) * ratio));
            let accum = 0, count = 0;
            for (let i = offsetBuf; i < nextOffsetBuf; i++) {
                accum += buffer[i];
                count++;
            }
            result[offsetRes] = count > 0 ? (accum / count) : 0;
            offsetRes++;
            offsetBuf = nextOffsetBuf;
        }
        return result;
    }

    function sendPcmBase64ToActiveSocket(b64Pcm) {
        if (!liveWs || liveWs._peaDisposed || liveWs.readyState !== WebSocket.OPEN) return;
        const payload = isLegacy20LiveModel(activeConnectedModel)
            ? { realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: b64Pcm }] } }
            : { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: b64Pcm } } };
        try { liveWs.send(JSON.stringify(payload)); } catch (e) {}
    }

    function flushMicStreamOnMute() {
        if (!isLiveConnected || !liveWs || liveWs._peaDisposed || liveWs.readyState !== WebSocket.OPEN) return;
        if (isLegacy20LiveModel(activeConnectedModel)) {
            const silentB64 = int16ToBase64(new Int16Array(1600));
            for (let i = 0; i < 8; i++) sendPcmBase64ToActiveSocket(silentB64);
        } else {
            try { liveWs.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch (e) {}
        }
    }

    function flushHandoverAudioBuffer() {
        if (!handoverAudioRingBuffer.length || !isLiveConnected) return;
        while (handoverAudioRingBuffer.length > 0) {
            sendPcmBase64ToActiveSocket(handoverAudioRingBuffer.shift());
        }
    }

    function clearPlaybackIdleWatchdog() {
        if (playbackIdleWatchdogTimer) {
            clearTimeout(playbackIdleWatchdogTimer);
            playbackIdleWatchdogTimer = null;
        }
    }

    function clearFrozenAudioCheckTimer() {
        if (frozenAudioCheckTimer) {
            clearTimeout(frozenAudioCheckTimer);
            frozenAudioCheckTimer = null;
        }
    }

    function armPlaybackIdleWatchdog(delayMs = 1500) {
        clearPlaybackIdleWatchdog();
        playbackIdleWatchdogTimer = setTimeout(() => {
            playbackIdleWatchdogTimer = null;
            if (activePlaybackSources.size === 0 && isServerTurnGenerating && pendingToolCallCount === 0) {
                isServerTurnGenerating = false;
                checkAndFinalizeAiSpeechTurn();
            }
        }, delayMs);
    }

    function armFrozenAudioClockGuard() {
        if (frozenAudioCheckTimer || !outputAudioCtx) return;
        const snapshotTime = outputAudioCtx.currentTime;
        frozenAudioCheckTimer = setTimeout(async () => {
            frozenAudioCheckTimer = null;
            if (!isUserSessionActive || activePlaybackSources.size === 0 || !outputAudioCtx || outputAudioCtx.state === 'closed') return;
            if (outputAudioCtx.state !== 'running' && Math.abs(outputAudioCtx.currentTime - snapshotTime) < 0.01) {
                try { await outputAudioCtx.resume(); } catch (e) {}
                await new Promise(r => setTimeout(r, 150));
                if (!isUserSessionActive || activePlaybackSources.size === 0 || !outputAudioCtx || outputAudioCtx.state === 'closed') return;
                if (outputAudioCtx.state !== 'running' && Math.abs(outputAudioCtx.currentTime - snapshotTime) < 0.01) {
                    stopAllAiPlaybackImmediately();
                    checkAndFinalizeAiSpeechTurn();
                    setLiveActionSubtext('🔊 ลำโพงถูกพักชั่วคราว แตะหน้าจอ 1 ครั้งเพื่อเปิดเสียงค่ะ');
                }
            }
        }, 2200);
    }

    function checkAndFinalizeAiSpeechTurn() {
        if (activePlaybackSources.size > 0) return;
        if (isServerTurnGenerating) {
            armPlaybackIdleWatchdog(1500);
            return;
        }
        clearPlaybackIdleWatchdog();
        clearFrozenAudioCheckTimer();
        isAiSpeakingNow = false;
        serverTurnCompletedWhilePlaying = false;
        bargeInSpeechMs = 0;
        lastUserSpeechAtMs = 0;
        if (pendingGoAwayReconnect && pendingToolCallCount === 0 && isUserSessionActive && !isReconnecting) {
            pendingGoAwayReconnect = false;
            if (goAwaySwapTimer) { clearTimeout(goAwaySwapTimer); goAwaySwapTimer = null; }
            performSeamlessSessionReconnect('goAway_after_turn');
            return;
        }
        if (isLiveConnected) {
            updateLiveDockStatusUI(
                isMicMuted ? '🔇 ปิดไมค์ชั่วคราว (แตะเปิดไมค์เพื่อถามได้ค่ะ)' : '🟢 กำลังรับฟังค่ะ พูดคุยได้เลย...',
                'listening'
            );
        }
    }

    function enqueuePcmPlayback(b64Data, sampleRate = 24000) {
        if (!outputAudioCtx || outputAudioCtx.state === 'closed') return;
        if (outputAudioCtx.state === 'suspended' || outputAudioCtx.state === 'interrupted') {
            outputAudioCtx.resume().catch(() => {});
        }
        const float32 = base64ToFloat32Pcm(b64Data);
        if (!float32.length) return;

        clearPlaybackIdleWatchdog();

        const audioBuf = outputAudioCtx.createBuffer(1, float32.length, sampleRate);
        audioBuf.getChannelData(0).set(float32);

        const src = outputAudioCtx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(outputAudioCtx.destination);

        const now = outputAudioCtx.currentTime;
        if (nextPlayTimeSec < now) nextPlayTimeSec = now + 0.025;

        src.start(nextPlayTimeSec);
        nextPlayTimeSec += audioBuf.duration;
        activePlaybackSources.add(src);
        if (!isAiSpeakingNow) {
            isAiSpeakingNow = true;
            updateLiveDockStatusUI('🌸 กำลังพูดแนะนำค่ะ...', 'speaking');
        }
        if (outputAudioCtx.state !== 'running') {
            armFrozenAudioClockGuard();
        }

        src.onended = () => {
            activePlaybackSources.delete(src);
            checkAndFinalizeAiSpeechTurn();
        };
    }

    function stopAllAiPlaybackImmediately() {
        turnInterruptionSeq++;
        hasAudioArrivedSinceLastMajorUiStep = true;
        lastMajorUiStepAtMs = 0;
        clearPlaybackIdleWatchdog();
        clearFrozenAudioCheckTimer();
        activePlaybackSources.forEach(src => {
            try { src.onended = null; src.stop(0); src.disconnect(); } catch (e) {}
        });
        activePlaybackSources.clear();
        nextPlayTimeSec = 0;
        isAiSpeakingNow = false;
        isServerTurnGenerating = false;
        serverTurnCompletedWhilePlaying = false;
        bargeInSpeechMs = 0;
        lastUserSpeechAtMs = 0;
    }

    function resetWaveBarsToIdle() {
        for (let i = 0; i < 5; i++) {
            const b = document.getElementById(`peaVoiceWaveBar-${i}`);
            if (b) {
                b.style.height = '6px';
                b.style.background = '#94a3b8';
            }
        }
    }

    function cleanupMicHardwareOnly() {
        if (micProcessorNode) {
            try {
                if (micProcessorNode.port) micProcessorNode.port.onmessage = null;
                if ('onaudioprocess' in micProcessorNode) micProcessorNode.onaudioprocess = null;
                micProcessorNode.disconnect();
            } catch (e) {}
            micProcessorNode = null;
        }
        if (micSourceNode) {
            try { micSourceNode.disconnect(); } catch (e) {}
            micSourceNode = null;
        }
        if (micStream) {
            micStream.getTracks().forEach(t => {
                try { t.onended = null; t.stop(); } catch (e) {}
            });
            micStream = null;
        }
        if (inputAudioCtx && inputAudioCtx.state !== 'closed') {
            inputAudioCtx.close().catch(() => {});
            inputAudioCtx = null;
        }
    }

    function syncMuteButtonVisualState(isPausedIdle = false) {
        const btn = document.getElementById('peaLiveMuteBtn');
        if (!btn) return;
        if (isPausedIdle) {
            btn.textContent = '🔄 แตะต่อสายคุยต่อ';
            btn.className = 'flex-1 py-2 px-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-[11px] shadow transition';
            return;
        }
        btn.textContent = isMicMuted ? '🔇 ไมค์: ปิดกันเสียงแทรก' : '🎙️ ไมค์: เปิดรับฟัง';
        btn.className = isMicMuted
            ? 'flex-1 py-2 px-2 rounded-xl bg-amber-400 text-slate-950 font-extrabold text-[11px] shadow transition'
            : 'flex-1 py-2 px-2 rounded-xl bg-white/15 hover:bg-white/25 text-white font-bold text-[11px] border border-white/20 transition';
    }

    async function ensureMicrophoneStreamingActive() {
        const hasLiveTracks = Boolean(
            micStream &&
            micStream.active &&
            micStream.getAudioTracks().length > 0 &&
            micStream.getAudioTracks().every(t => t.readyState === 'live')
        );
        if (hasLiveTracks && inputAudioCtx && inputAudioCtx.state !== 'closed') {
            if (inputAudioCtx.state === 'suspended' || inputAudioCtx.state === 'interrupted') {
                await inputAudioCtx.resume().catch(() => {});
            }
            if (outputAudioCtx && (outputAudioCtx.state === 'suspended' || outputAudioCtx.state === 'interrupted')) {
                await outputAudioCtx.resume().catch(() => {});
            }
            return;
        }

        if (micInitPromise) return micInitPromise;

        micInitPromise = (async () => {
            cleanupMicHardwareOnly();

            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('เบราว์เซอร์ไม่รองรับการเปิดไมโครโฟน (ต้องเปิดผ่าน HTTPS)');
            }
            const acquiredStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            if (!isUserSessionActive) {
                acquiredStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
                throw new Error('ยกเลิกการเชื่อมต่อ');
            }
            micStream = acquiredStream;

            acquiredStream.getAudioTracks().forEach(track => {
                track.onended = () => {
                    if (!isUserSessionActive || document.hidden) return;
                    const nowMs = Date.now();
                    if (nowMs - lastTrackRecoveryAtMs < 1500) return;
                    lastTrackRecoveryAtMs = nowMs;
                    if (isLiveConnected || isReconnecting) {
                        ensureMicrophoneStreamingActive().catch(() => {});
                    }
                };
            });

            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            try { inputAudioCtx = new AudioCtx({ sampleRate: 16000 }); }
            catch (e) { inputAudioCtx = new AudioCtx(); }
            if (inputAudioCtx.state === 'suspended' || inputAudioCtx.state === 'interrupted') {
                await inputAudioCtx.resume().catch(() => {});
            }
            if (outputAudioCtx && (outputAudioCtx.state === 'suspended' || outputAudioCtx.state === 'interrupted')) {
                await outputAudioCtx.resume().catch(() => {});
            }

            if (!isUserSessionActive || !micStream) {
                cleanupMicHardwareOnly();
                throw new Error('ยกเลิกการเชื่อมต่อ');
            }

            const actualRate = inputAudioCtx.sampleRate || 48000;
            micSourceNode = inputAudioCtx.createMediaStreamSource(micStream);

            let pcmAccum = [];
            const TARGET_CHUNK_SAMPLES = 1600;

            const handleRawFloatChunk = (floatChunk) => {
                if (!isUserSessionActive || isMicMuted || (!isLiveConnected && !isReconnecting)) {
                    pcmAccum.length = 0;
                    currentMicLevel = 0;
                    bargeInSpeechMs = 0;
                    return;
                }

                let sumSq = 0;
                for (let i = 0; i < floatChunk.length; i += 4) sumSq += floatChunk[i] * floatChunk[i];
                const rms = Math.sqrt(sumSq / Math.max(1, floatChunk.length / 4));
                currentMicLevel = Math.min(1, rms * 5.5);

                const chunkDurationMs = (floatChunk.length / actualRate) * 1000;
                let suppressSpeakerEcho = false;
                if (isAiSpeakingNow) {
                    if (rms >= SPEAKER_ECHO_GATE_RMS) {
                        bargeInSpeechMs += chunkDurationMs;
                        bargeInHoldUntilMs = Date.now() + 450;
                        if (bargeInSpeechMs >= BARGE_IN_MIN_MS) {
                            lastUserSpeechAtMs = Date.now();
                            hasAudioArrivedSinceLastMajorUiStep = true;
                            lastMajorUiStepAtMs = 0;
                        }
                    } else {
                        bargeInSpeechMs = 0;
                        if (Date.now() > bargeInHoldUntilMs) {
                            suppressSpeakerEcho = true;
                            currentMicLevel = 0;
                        }
                    }
                } else {
                    bargeInSpeechMs = 0;
                    if (rms >= SPEAKER_ECHO_GATE_RMS) {
                        hasAudioArrivedSinceLastMajorUiStep = true;
                        lastMajorUiStepAtMs = 0;
                    }
                }

                const down = downsampleFloat32(floatChunk, actualRate, 16000);
                for (let i = 0; i < down.length; i++) {
                    if (suppressSpeakerEcho) {
                        pcmAccum.push(0);
                    } else {
                        const s = Math.max(-1, Math.min(1, down[i]));
                        pcmAccum.push(s < 0 ? s * 0x8000 : s * 0x7FFF);
                    }
                }

                while (pcmAccum.length >= TARGET_CHUNK_SAMPLES) {
                    const slice = new Int16Array(pcmAccum.splice(0, TARGET_CHUNK_SAMPLES));
                    const b64 = int16ToBase64(slice);
                    if (isLiveConnected && liveWs && !liveWs._peaDisposed && liveWs.readyState === WebSocket.OPEN) {
                        sendPcmBase64ToActiveSocket(b64);
                    } else if (isReconnecting) {
                        if (handoverAudioRingBuffer.length >= 15) handoverAudioRingBuffer.shift();
                        handoverAudioRingBuffer.push(b64);
                    }
                }
            };

            let workletReady = false;
            if (inputAudioCtx.audioWorklet) {
                const workletCode = `
                    class PeaMicCaptureProcessor extends AudioWorkletProcessor {
                        constructor() {
                            super();
                            this._buf = new Float32Array(960);
                            this._len = 0;
                        }
                        process(inputs) {
                            const ch = inputs[0] && inputs[0][0];
                            if (ch && ch.length) {
                                let offset = 0;
                                while (offset < ch.length) {
                                    const copyCount = Math.min(this._buf.length - this._len, ch.length - offset);
                                    this._buf.set(ch.subarray(offset, offset + copyCount), this._len);
                                    this._len += copyCount;
                                    offset += copyCount;
                                    if (this._len >= this._buf.length) {
                                        const out = this._buf.slice(0);
                                        this.port.postMessage(out, [out.buffer]);
                                        this._len = 0;
                                    }
                                }
                            }
                            return true;
                        }
                    }
                    registerProcessor('pea-mic-capture', PeaMicCaptureProcessor);
                `;
                const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
                try {
                    await inputAudioCtx.audioWorklet.addModule(blobUrl);
                    if (!isUserSessionActive || !inputAudioCtx || inputAudioCtx.state === 'closed' || !micSourceNode) {
                        cleanupMicHardwareOnly();
                        throw new Error('ยกเลิกการเชื่อมต่อ');
                    }
                    const wNode = new AudioWorkletNode(inputAudioCtx, 'pea-mic-capture');
                    wNode.port.onmessage = ev => { if (ev.data) handleRawFloatChunk(ev.data); };
                    micSourceNode.connect(wNode);
                    micProcessorNode = wNode;
                    workletReady = true;
                } catch (e) {
                    if (!isUserSessionActive) throw e;
                    workletReady = false;
                } finally {
                    URL.revokeObjectURL(blobUrl);
                }
            }

            if (!workletReady) {
                if (!isUserSessionActive || !inputAudioCtx || inputAudioCtx.state === 'closed' || !micSourceNode) {
                    cleanupMicHardwareOnly();
                    throw new Error('ยกเลิกการเชื่อมต่อ');
                }
                const spNode = inputAudioCtx.createScriptProcessor(2048, 1, 1);
                const muteGain = inputAudioCtx.createGain();
                muteGain.gain.value = 0;
                spNode.onaudioprocess = ev => { handleRawFloatChunk(ev.inputBuffer.getChannelData(0)); };
                micSourceNode.connect(spNode);
                spNode.connect(muteGain);
                muteGain.connect(inputAudioCtx.destination);
                micProcessorNode = spNode;
            }
        })();

        try {
            await micInitPromise;
        } finally {
            micInitPromise = null;
        }
    }

    // ========================================================================
    // 5. WebSocket (กั้นคิวไม่ให้สลับหลายหน้าจอก่อนพูดจบ) + Compression + Resumption
    // ========================================================================
    async function sendTextCueToLiveSession(promptText) {
        if (!isLiveConnected || !liveWs || liveWs._peaDisposed || liveWs.readyState !== WebSocket.OPEN) return;
        const myCueSeq = ++textCueSeq;
        const targetWs = liveWs;
        const cueModel = activeConnectedModel;
        if (outputAudioCtx && (outputAudioCtx.state === 'suspended' || outputAudioCtx.state === 'interrupted')) {
            outputAudioCtx.resume().catch(() => {});
        }
        stopAllAiPlaybackImmediately();
        if (pendingToolCallCount > 0) {
            try { await toolCallChain; } catch (e) {}
        }
        if (myCueSeq !== textCueSeq || !isLiveConnected || liveWs !== targetWs || targetWs._peaDisposed || liveWs.readyState !== WebSocket.OPEN) return;
        hasAudioArrivedSinceLastMajorUiStep = true;
        lastMajorUiStepAtMs = 0;
        try {
            if (isGemini3OrNewerLiveModel(cueModel)) {
                liveWs.send(JSON.stringify({ realtimeInput: { text: promptText } }));
            } else {
                liveWs.send(JSON.stringify({
                    clientContent: {
                        turns: [{ role: 'user', parts: [{ text: promptText }] }],
                        turnComplete: true
                    }
                }));
            }
            isServerTurnGenerating = true;
            armPlaybackIdleWatchdog(6500);
        } catch (e) {}
    }

    function parseDurationSeconds(durStr) {
        if (!durStr) return 5;
        const m = String(durStr).match(/(\d+(?:\.\d+)?)/);
        return m ? parseFloat(m[1]) : 5;
    }

    function openSingleModelLiveSocket(apiKey, modelName, opts = {}) {
        const {
            enableCompression = true,
            enableResumption = true,
            resumeHandle = ''
        } = opts;
        const useExtendedThinking = isExtendedThinkingLiveModel(modelName);
        const socketEpoch = sessionEpoch;

        return new Promise((resolve, reject) => {
            const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;
            let settled = false;
            let errorFallbackTimer = null;
            let lastWsServerError = '';
            const cancelledToolCallIds = new Set();
            const ws = new WebSocket(wsUrl);
            ws.binaryType = 'arraybuffer';

            const clearSocketTimers = () => {
                clearTimeout(handshakeTimer);
                if (errorFallbackTimer) { clearTimeout(errorFallbackTimer); errorFallbackTimer = null; }
            };

            const handshakeTimer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    clearSocketTimers();
                    disposeWebSocketCleanly(ws, 'handshake_timeout');
                    const tErr = new Error('หมดเวลาเชื่อมต่อโมเดล ' + modelName);
                    tErr.isTimeout = true;
                    reject(tErr);
                }
            }, 8000);

            ws.onopen = () => {
                if (ws._peaDisposed) return;
                const generationConfig = {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: selectedFemaleVoice
                            }
                        }
                    }
                };
                if (useExtendedThinking) {
                    generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
                }

                const setupPayload = {
                    model: modelName,
                    generationConfig,
                    systemInstruction: {
                        parts: [{ text: buildSystemInstructionText() }]
                    },
                    tools: [{
                        functionDeclarations: getToolDeclarations(useExtendedThinking)
                    }]
                };

                if (enableCompression) {
                    setupPayload.contextWindowCompression = { slidingWindow: {} };
                }
                if (enableResumption) {
                    setupPayload.sessionResumption = resumeHandle ? { handle: resumeHandle } : {};
                }

                try {
                    ws.send(JSON.stringify({ setup: setupPayload }));
                } catch (sendErr) {
                    if (!settled) {
                        settled = true;
                        clearSocketTimers();
                        disposeWebSocketCleanly(ws, 'setup_send_failed');
                        reject(sendErr);
                    }
                }
            };

            ws.onmessage = async (event) => {
                if (ws._peaDisposed || socketEpoch !== sessionEpoch) return;
                let rawText = '';
                try {
                    if (typeof event.data === 'string') {
                        rawText = event.data;
                    } else if (event.data instanceof ArrayBuffer && utf8Decoder) {
                        rawText = utf8Decoder.decode(event.data);
                    } else if (event.data instanceof Blob) {
                        rawText = await event.data.text();
                    }
                } catch (e) { return; }
                if (!rawText || ws._peaDisposed || socketEpoch !== sessionEpoch) return;

                let msg = null;
                try { msg = JSON.parse(rawText); } catch (e) { return; }
                if (!msg) return;

                if (msg.error) {
                    lastWsServerError = String(msg.error.message || msg.error.status || 'WebSocket Setup Error');
                    const errFlags = classifyWsServerErrorReason(lastWsServerError);
                    if (!settled) {
                        settled = true;
                        clearSocketTimers();
                        disposeWebSocketCleanly(ws, 'setup_error');
                        const err = new Error(lastWsServerError);
                        Object.assign(err, errFlags);
                        reject(err);
                        return;
                    }
                    if (errFlags.isInvalidKey && liveWs === ws) {
                        stopPeaLiveVoiceSession(true);
                        safeToast('❌ API Key ไม่ถูกต้องหรือหมดอายุ กรุณาตั้งค่าคีย์ใหม่ค่ะ');
                        openKeySetupModalFallback();
                        return;
                    }
                }

                if ((msg.setupComplete !== undefined || msg.setup_complete !== undefined) && !settled) {
                    settled = true;
                    isServerTurnGenerating = false;
                    serverTurnCompletedWhilePlaying = false;
                    lastUserSpeechAtMs = 0;
                    hasAudioArrivedSinceLastMajorUiStep = true;
                    lastMajorUiStepAtMs = 0;
                    clearSocketTimers();
                    resolve(ws);
                    return;
                }

                const resUpd = msg.sessionResumptionUpdate || msg.session_resumption_update;
                if (resUpd && resUpd.resumable !== false && !ws._peaDisposed && socketEpoch === sessionEpoch) {
                    const nextHandle = resUpd.newHandle || resUpd.new_handle || '';
                    if (typeof nextHandle === 'string' && nextHandle.trim()) {
                        saveResumptionHandleState(nextHandle.trim(), modelName);
                    }
                }

                const cancelNotice = msg.toolCallCancellation || msg.tool_call_cancellation;
                if (cancelNotice && Array.isArray(cancelNotice.ids)) {
                    cancelNotice.ids.forEach(id => cancelledToolCallIds.add(id));
                }

                const goAway = msg.goAway || msg.go_away;
                if (goAway && !ws._peaDisposed && socketEpoch === sessionEpoch && isUserSessionActive && !isReconnecting) {
                    const secLeft = parseDurationSeconds(goAway.timeLeft || goAway.time_left);
                    if ((!isAiSpeakingNow && !isServerTurnGenerating && pendingToolCallCount === 0) || secLeft <= 2.0) {
                        performSeamlessSessionReconnect('goAway_immediate');
                    } else {
                        pendingGoAwayReconnect = true;
                        if (goAwaySwapTimer) clearTimeout(goAwaySwapTimer);
                        goAwaySwapTimer = setTimeout(() => {
                            if (pendingGoAwayReconnect && isUserSessionActive && !isReconnecting) {
                                pendingGoAwayReconnect = false;
                                performSeamlessSessionReconnect('goAway_deadline');
                            }
                        }, Math.max(400, (secLeft - 1.5) * 1000));
                    }
                }

                const srvContent = msg.serverContent || msg.server_content;
                if (srvContent && !ws._peaDisposed && socketEpoch === sessionEpoch) {
                    const interStatus = srvContent.interactionStatus || srvContent.interaction_status || '';
                    if (srvContent.interrupted) {
                        stopAllAiPlaybackImmediately();
                        checkAndFinalizeAiSpeechTurn();
                    } else {
                        const mTurn = srvContent.modelTurn || srvContent.model_turn;
                        const parts = mTurn?.parts || [];
                        const audioParts = parts.filter(pt => {
                            const inl = pt?.inlineData || pt?.inline_data;
                            const mType = String(inl?.mimeType || inl?.mime_type || '');
                            return inl?.data && mType.includes('audio/pcm');
                        });

                        const recentUserBargeIn = lastUserSpeechAtMs > 0 && (Date.now() - lastUserSpeechAtMs < POST_TURN_BARGE_WINDOW_MS);
                        if ((audioParts.length > 0 || parts.length > 0 || interStatus === 'IN_PROGRESS') && serverTurnCompletedWhilePlaying && recentUserBargeIn && activePlaybackSources.size > 0) {
                            stopAllAiPlaybackImmediately();
                        }

                        if (parts.length > 0 || interStatus === 'IN_PROGRESS') {
                            serverTurnCompletedWhilePlaying = false;
                            isServerTurnGenerating = true;
                        }

                        if (audioParts.length > 0) {
                            hasAudioArrivedSinceLastMajorUiStep = true;
                        }

                        audioParts.forEach(pt => {
                            const inl = pt.inlineData || pt.inline_data;
                            const mType = String(inl.mimeType || inl.mime_type || '');
                            const rateMatch = mType.match(/rate=(\d+)/i);
                            const rate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
                            enqueuePcmPlayback(inl.data, rate);
                        });

                        const isGenDone = Boolean(srvContent.generationComplete || srvContent.generation_complete);
                        const isTurnDone = Boolean(
                            srvContent.turnComplete ||
                            srvContent.turn_complete ||
                            interStatus === 'IDLE'
                        );
                        if (isTurnDone) {
                            isServerTurnGenerating = false;
                            if (activePlaybackSources.size > 0) {
                                serverTurnCompletedWhilePlaying = true;
                            }
                            checkAndFinalizeAiSpeechTurn();
                        } else if (isGenDone && activePlaybackSources.size === 0) {
                            checkAndFinalizeAiSpeechTurn();
                        }
                    }
                }

                const tCall = msg.toolCall || msg.tool_call;
                const fnCalls = tCall?.functionCalls || tCall?.function_calls;
                if (Array.isArray(fnCalls) && fnCalls.length > 0 && !ws._peaDisposed && socketEpoch === sessionEpoch) {
                    const scheduledSwitchTimeSec = outputAudioCtx ? nextPlayTimeSec : 0;
                    const callInterruptSeq = turnInterruptionSeq;
                    const callEpoch = sessionEpoch;
                    pendingToolCallCount++;

                    toolCallChain = toolCallChain.then(async () => {
                        try {
                            if (ws._peaDisposed || callEpoch !== sessionEpoch || !isUserSessionActive) return;
                            await waitForQueuedAudioBeforeUiTool(ws, scheduledSwitchTimeSec, fnCalls, cancelledToolCallIds, callInterruptSeq);
                            if (turnInterruptionSeq !== callInterruptSeq) {
                                await new Promise(r => setTimeout(r, 90));
                            }
                            const functionResponses = [];
                            let executedMajorInBatch = false;

                            for (const fc of fnCalls) {
                                if (cancelledToolCallIds.has(fc.id) || ws._peaDisposed || callEpoch !== sessionEpoch || !isUserSessionActive) continue;
                                const isPresentationUiFn = PRESENTATION_SYNC_TOOLS.has(fc.name);
                                const isCleanupFn = isCleanupPresentationCall(fc);

                                if (turnInterruptionSeq !== callInterruptSeq && isPresentationUiFn) {
                                    functionResponses.push({
                                        id: fc.id,
                                        name: fc.name,
                                        response: { result: { ok: false, skippedDueToInterruption: true } }
                                    });
                                    continue;
                                }

                                // กั้นคิวป้องกัน AI มัดรวมหลายขั้นตอนเปลี่ยนหน้าจอทับกันโดยยังไม่ทันพูดอธิบายหน้าจอที่เพิ่งเปิด
                                const rushedWithoutNarration = !isCleanupFn && !hasAudioArrivedSinceLastMajorUiStep && (Date.now() - lastMajorUiStepAtMs < 2500);
                                if (isPresentationUiFn && (executedMajorInBatch || rushedWithoutNarration)) {
                                    functionResponses.push({
                                        id: fc.id,
                                        name: fc.name,
                                        response: {
                                            result: {
                                                ok: false,
                                                deferredUntilNarrated: true,
                                                instruction: 'หน้าจอก่อนหน้าเพิ่งเปิดขึ้นแสดงผล กรุณาพูดอธิบายจุดเด่นของหน้าจอปัจจุบันให้ผู้ฟังเข้าใจ 2-3 ประโยคให้จบก่อน แล้วจึงเรียกคำสั่งเปิดหน้าถัดไปทีละ 1 ขั้นตอนค่ะ'
                                            }
                                        }
                                    });
                                    continue;
                                }

                                let resObj = {};
                                try {
                                    resObj = await executeVoiceToolCall(fc.name, fc.args || {});
                                    if (isPresentationUiFn && !isCleanupFn && resObj?.ok !== false) {
                                        executedMajorInBatch = true;
                                        hasAudioArrivedSinceLastMajorUiStep = false;
                                        lastMajorUiStepAtMs = Date.now();
                                    }
                                } catch (err) {
                                    resObj = { ok: false, error: String(err?.message || err) };
                                }
                                if (!cancelledToolCallIds.has(fc.id)) {
                                    functionResponses.push({
                                        id: fc.id,
                                        name: fc.name,
                                        response: { result: resObj }
                                    });
                                }
                            }
                            if (!ws._peaDisposed && callEpoch === sessionEpoch && ws.readyState === WebSocket.OPEN && functionResponses.length > 0) {
                                try {
                                    ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
                                    serverTurnCompletedWhilePlaying = false;
                                    lastUserSpeechAtMs = 0;
                                    isServerTurnGenerating = true;
                                    if (activePlaybackSources.size === 0) {
                                        armPlaybackIdleWatchdog(6000);
                                    }
                                } catch (e) {}
                            }
                        } finally {
                            if (callEpoch === sessionEpoch) {
                                pendingToolCallCount = Math.max(0, pendingToolCallCount - 1);
                                if (pendingToolCallCount === 0 && !isAiSpeakingNow && !isServerTurnGenerating) {
                                    checkAndFinalizeAiSpeechTurn();
                                }
                            }
                        }
                    }).catch(() => {});
                }
            };

            ws.onerror = () => {
                if (ws._peaDisposed) return;
                if (!settled && !errorFallbackTimer) {
                    errorFallbackTimer = setTimeout(() => {
                        if (!settled) {
                            settled = true;
                            clearSocketTimers();
                            disposeWebSocketCleanly(ws, 'socket_error');
                            reject(new Error('เชื่อมต่อโมเดล ' + modelName + ' ไม่สำเร็จ'));
                        }
                    }, 180);
                }
            };

            ws.onclose = (ev) => {
                clearSocketTimers();
                if (ws._peaDisposed) return;
                const reason = [lastWsServerError, String(ev?.reason || '')].filter(Boolean).join(' | ');
                const errFlags = classifyWsServerErrorReason(reason);
                if (!settled) {
                    settled = true;
                    const err = new Error(reason || `WebSocket ปิดการเชื่อมต่อ (${ev?.code || 0})`);
                    Object.assign(err, errFlags);
                    reject(err);
                    return;
                }
                if (liveWs === ws) {
                    isLiveConnected = false;
                    isServerTurnGenerating = false;
                    liveWs = null;
                    if (errFlags.isInvalidKey) {
                        stopPeaLiveVoiceSession(true);
                        safeToast('❌ API Key ไม่ถูกต้องหรือหมดอายุ กรุณาตั้งค่าคีย์ใหม่ค่ะ');
                        openKeySetupModalFallback();
                        return;
                    }
                    if (isUserSessionActive && !isReconnecting) {
                        performSeamlessSessionReconnect('unexpected_close');
                    }
                }
            };
        });
    }

    async function connectModelWithResumptionFallback(apiKey, modelName) {
        const savedState = loadValidResumptionState(modelName);
        const initialHandle = savedState?.handle || '';

        try {
            const ws = await openSingleModelLiveSocket(apiKey, modelName, {
                enableCompression: true,
                enableResumption: true,
                resumeHandle: initialHandle
            });
            return { ws, resumedFromHandle: Boolean(initialHandle) };
        } catch (err1) {
            if (err1?.isInvalidKey || err1?.isQuota || err1?.isModelNotFound || err1?.isTimeout || !isUserSessionActive) throw err1;

            if (initialHandle) {
                clearResumptionHandleState();
                try {
                    const wsFresh = await openSingleModelLiveSocket(apiKey, modelName, {
                        enableCompression: true,
                        enableResumption: true,
                        resumeHandle: ''
                    });
                    return { ws: wsFresh, resumedFromHandle: false };
                } catch (err2) {
                    if (err2?.isInvalidKey || err2?.isQuota || err2?.isModelNotFound || err2?.isTimeout || !isUserSessionActive) throw err2;
                }
            }
            const wsBasic = await openSingleModelLiveSocket(apiKey, modelName, {
                enableCompression: false,
                enableResumption: false,
                resumeHandle: ''
            });
            return { ws: wsBasic, resumedFromHandle: false };
        }
    }

    async function establishBestLiveConnection(apiKey) {
        const keyTag = apiKey.slice(-10);
        const models = await resolveLiveModelsForKey(apiKey);
        const savedState = loadValidResumptionState('');

        const prioritized = [...models];
        if (savedState?.modelName && prioritized.includes(savedState.modelName)) {
            prioritized.splice(prioritized.indexOf(savedState.modelName), 1);
            prioritized.unshift(savedState.modelName);
        }

        let lastErr = null;
        for (const mName of prioritized) {
            if (!isUserSessionActive) throw new Error('ยกเลิกการเชื่อมต่อ');
            try {
                const { ws, resumedFromHandle } = await connectModelWithResumptionFallback(apiKey, mName);
                activeConnectedModel = mName;
                return { ws, modelName: mName, resumedFromHandle };
            } catch (err) {
                lastErr = err;
                if (err?.isInvalidKey || !isUserSessionActive) throw err;
                if (!err?.isQuota && !err?.isTimeout) unsupportedLiveModels.add(`${keyTag}:${mName}`);
            }
        }
        throw lastErr || new Error('ไม่พบโมเดลเสียงสดที่พร้อมใช้งานในขณะนี้');
    }

    async function performSeamlessSessionReconnect(reason = 'auto') {
        if (!isUserSessionActive || isReconnecting) return;
        const myEpoch = ++sessionEpoch;
        toolCallChain = Promise.resolve();
        isReconnecting = true;
        pendingGoAwayReconnect = false;
        isServerTurnGenerating = false;
        pendingToolCallCount = 0;
        if (goAwaySwapTimer) { clearTimeout(goAwaySwapTimer); goAwaySwapTimer = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

        const prevWs = liveWs;
        liveWs = null;
        isLiveConnected = false;
        disposeWebSocketCleanly(prevWs, 'seamless_swap');

        if (!getGroupApiKey()) {
            isReconnecting = false;
            stopPeaLiveVoiceSession(true);
            return;
        }

        const attemptLoop = async () => {
            if (!isUserSessionActive || myEpoch !== sessionEpoch) { isReconnecting = false; return; }
            const freshApiKey = getGroupApiKey();
            if (!freshApiKey) {
                isReconnecting = false;
                stopPeaLiveVoiceSession(true);
                return;
            }
            lastKnownGroupApiKey = freshApiKey;
            reconnectAttemptCount++;
            updateLiveDockStatusUI(`🔄 กำลังต่อสายอัตโนมัติ (จำบทสนทนาเดิม #${reconnectAttemptCount})...`, 'connecting');

            if (!navigator.onLine) {
                if (reconnectAttemptCount <= MAX_AUTO_RECONNECT_ATTEMPTS) {
                    reconnectTimer = setTimeout(attemptLoop, 2500);
                } else {
                    isReconnecting = false;
                    stopPeaLiveVoiceSession(false);
                    safeToast('⚠️ อินเทอร์เน็ตขาดหายชั่วคราว แตะปุ่มต่อสายบนแถบเพื่อคุยต่อจากเดิมได้เลยค่ะ');
                }
                return;
            }

            try {
                await ensureMicrophoneStreamingActive();
                if (!isUserSessionActive || myEpoch !== sessionEpoch) {
                    cleanupMicHardwareOnly();
                    isReconnecting = false;
                    return;
                }
                const { ws, resumedFromHandle } = await establishBestLiveConnection(freshApiKey);
                if (!isUserSessionActive || myEpoch !== sessionEpoch) {
                    disposeWebSocketCleanly(ws, 'session_ended');
                    cleanupMicHardwareOnly();
                    isReconnecting = false;
                    return;
                }
                liveWs = ws;
                isLiveConnected = true;
                isReconnecting = false;
                reconnectAttemptCount = 0;
                seamlessRenewCount++;
                syncMuteButtonVisualState(false);
                startVisualizerLoop();
                flushHandoverAudioBuffer();
                updateHeaderLiveButtonsUI();
                updateMemoryBadgeUI();
                updateLiveDockStatusUI(
                    isMicMuted ? '🔇 ต่อสายใหม่สำเร็จ (ไมค์ปิดอยู่)' : '🟢 ต่อสายต่อเนื่องสำเร็จ พูดคุยต่อได้เลยค่ะ...',
                    'listening'
                );

                const queuedAuto = pendingAutoPresentAfterConnect;
                const queuedTopic = pendingTopicCueAfterConnect;
                pendingAutoPresentAfterConnect = false;
                pendingTopicCueAfterConnect = '';

                if (queuedAuto) {
                    triggerAutoPresentationCue();
                } else if (queuedTopic) {
                    triggerSpecificTopicDemo(queuedTopic);
                } else {
                    setLiveActionSubtext(
                        resumedFromHandle
                            ? `♾️ เชื่อมต่อความจำเดิมต่อเนื่องอัตโนมัติ (รอบที่ ${seamlessRenewCount + 1})`
                            : `🔄 เปิดช่องสัญญาณเสียงใหม่เรียบร้อย (${reason})`
                    );
                }
            } catch (err) {
                if (!isUserSessionActive || myEpoch !== sessionEpoch) {
                    cleanupMicHardwareOnly();
                    isReconnecting = false;
                    return;
                }
                if (err?.isInvalidKey) {
                    isReconnecting = false;
                    stopPeaLiveVoiceSession(true);
                    safeToast('❌ API Key ไม่ถูกต้องหรือหมดอายุ');
                    return;
                }
                if (reconnectAttemptCount < MAX_AUTO_RECONNECT_ATTEMPTS && isUserSessionActive) {
                    const delayMs = Math.min(7000, 450 * Math.pow(1.85, reconnectAttemptCount - 1));
                    reconnectTimer = setTimeout(attemptLoop, delayMs);
                } else {
                    isReconnecting = false;
                    handoverAudioRingBuffer.length = 0;
                    stopPeaLiveVoiceSession(false);
                    safeToast('⚠️ สัญญาณเสียงขาดช่วง แตะปุ่มต่อสายบนแถบเพื่อคุยต่อจากเดิมได้เลยค่ะ (จำข้อมูลไว้ 2 ชม.)');
                }
            }
        };

        await attemptLoop();
    }

    async function startPeaLiveVoiceSession(autoPresentSystem = false) {
        if (!isLoggedIn()) {
            safeToast('🔐 กรุณาเข้าสู่ระบบก่อนใช้งานผู้ช่วยเสียงสดค่ะ');
            return;
        }
        unlockOutputAudioContextOnGesture();
        if (autoPresentSystem) {
            pendingAutoPresentAfterConnect = true;
            pendingTopicCueAfterConnect = '';
        }

        if (isLiveConnecting || isReconnecting) {
            setDockMinimized(false);
            document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden');
            if (pendingAutoPresentAfterConnect) {
                setLiveActionSubtext('🎬 เตรียมเริ่มโหมดนำเสนอระบบอัตโนมัติทันทีที่เชื่อมต่อเสร็จค่ะ...');
            }
            return;
        }
        if (isLiveConnected) {
            setDockMinimized(false);
            document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden');
            if (pendingAutoPresentAfterConnect) {
                pendingAutoPresentAfterConnect = false;
                triggerAutoPresentationCue();
            } else if (pendingTopicCueAfterConnect) {
                const topic = pendingTopicCueAfterConnect;
                pendingTopicCueAfterConnect = '';
                triggerSpecificTopicDemo(topic);
            }
            return;
        }

        const apiKey = getGroupApiKey();
        if (!apiKey) {
            pendingAutoPresentAfterConnect = false;
            pendingTopicCueAfterConnect = '';
            safeToast(`🔑 กรุณาตั้งค่า API Key ประจำกลุ่ม "${getActiveVoiceGroup()}" ก่อนเริ่มคุยสดค่ะ`);
            openKeySetupModalFallback();
            return;
        }
        lastKnownGroupApiKey = apiKey;

        if (restartSessionTimer) { clearTimeout(restartSessionTimer); restartSessionTimer = null; }
        const myEpoch = ++sessionEpoch;
        toolCallChain = Promise.resolve();
        isLiveConnecting = true;
        isUserSessionActive = true;
        isMicMuted = false;
        reconnectAttemptCount = 0;
        seamlessRenewCount = 0;
        pendingToolCallCount = 0;
        handoverAudioRingBuffer.length = 0;

        setDockMinimized(false);
        injectLiveVoiceUI();
        document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden');
        syncMuteButtonVisualState(false);
        updateHeaderLiveButtonsUI();
        updateMemoryBadgeUI();

        const hasPriorMemory = Boolean(loadValidResumptionState(''));
        updateLiveDockStatusUI(
            hasPriorMemory ? '⏳ กำลังเชื่อมต่อและดึงความจำบทสนทนาเดิม...' : '⏳ กำลังเตรียมไมโครโฟนและเชื่อมต่อเสียงผู้ช่วยสาว...',
            'connecting'
        );
        setLiveActionSubtext(`🏢 สังกัด: ${getActiveVoiceGroup()} • เสียง: ${FEMALE_VOICE_PROFILES[selectedFemaleVoice].label}`);

        try {
            await ensureMicrophoneStreamingActive();
            if (!isUserSessionActive || myEpoch !== sessionEpoch) {
                cleanupMicHardwareOnly();
                return;
            }

            const { ws, resumedFromHandle } = await establishBestLiveConnection(apiKey);
            if (!isUserSessionActive || myEpoch !== sessionEpoch) {
                disposeWebSocketCleanly(ws, 'cancelled_during_connect');
                cleanupMicHardwareOnly();
                return;
            }

            liveWs = ws;
            isLiveConnected = true;
            isLiveConnecting = false;
            syncMuteButtonVisualState(false);
            startVisualizerLoop();
            updateHeaderLiveButtonsUI();
            updateMemoryBadgeUI();
            updateLiveDockStatusUI('🟢 เชื่อมต่อสำเร็จ กำลังรับฟังค่ะ...', 'listening');

            const shouldAutoPresent = pendingAutoPresentAfterConnect;
            const queuedTopic = pendingTopicCueAfterConnect;
            pendingAutoPresentAfterConnect = false;
            pendingTopicCueAfterConnect = '';

            if (shouldAutoPresent) {
                triggerAutoPresentationCue();
            } else if (queuedTopic) {
                triggerSpecificTopicDemo(queuedTopic);
            } else if (resumedFromHandle) {
                setLiveActionSubtext('♾️ กู้คืนความจำบทสนทนาเดิมสำเร็จ คุยต่อจากเรื่องเดิมได้เลยค่ะ');
                safeToast('🌸 เชื่อมต่อพร้อมความจำบทสนทนาเดิมเรียบร้อยค่ะ');
            } else {
                setLiveActionSubtext('💡 พูดคุยสั่งงานได้เลย หรือกดปุ่มลัดด้านล่างเพื่อให้แนะนำระบบค่ะ');
                sendTextCueToLiveSession('กล่าวทักทายสั้นๆ 1 ประโยคอย่างนุ่มนวลว่าพร้อมเป็นผู้ช่วยรับแจ้งเหตุ สาธิตระบบสกาด้าจำลอง และสาธิตแผนงาน PM ถึงเรดาร์ไฟดับผู้ใช้ไฟแล้วค่ะ');
            }
        } catch (err) {
            if (myEpoch !== sessionEpoch) return;
            pendingAutoPresentAfterConnect = false;
            pendingTopicCueAfterConnect = '';
            isLiveConnecting = false;
            isUserSessionActive = false;
            stopPeaLiveVoiceSession(true);
            if (err?.isInvalidKey) {
                safeToast('❌ API Key ไม่ถูกต้องหรือหมดอายุ กรุณาตั้งค่าคีย์ใหม่ค่ะ');
                openKeySetupModalFallback();
            } else {
                safeToast(`❌ เปิดใช้งานเสียงสดไม่สำเร็จ: ${err?.message || 'กรุณาตรวจสอบไมโครโฟนและอินเทอร์เน็ต'}`);
            }
        }
    }

    function stopPeaLiveVoiceSession(hideDock = true) {
        sessionEpoch++;
        textCueSeq++;
        toolCallChain = Promise.resolve();
        pendingAutoPresentAfterConnect = false;
        pendingTopicCueAfterConnect = '';
        isUserSessionActive = false;
        isLiveConnected = false;
        isLiveConnecting = false;
        isReconnecting = false;
        pendingGoAwayReconnect = false;
        isServerTurnGenerating = false;
        serverTurnCompletedWhilePlaying = false;
        pendingToolCallCount = 0;
        bargeInSpeechMs = 0;
        lastUserSpeechAtMs = 0;
        isMicMuted = false;
        currentMicLevel = 0;
        handoverAudioRingBuffer.length = 0;

        if (restartSessionTimer) { clearTimeout(restartSessionTimer); restartSessionTimer = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (goAwaySwapTimer) { clearTimeout(goAwaySwapTimer); goAwaySwapTimer = null; }
        stopAllAiPlaybackImmediately();

        if (visualizerAnimId) {
            cancelAnimationFrame(visualizerAnimId);
            visualizerAnimId = null;
        }
        resetWaveBarsToIdle();

        if (liveWs) {
            const ws = liveWs;
            liveWs = null;
            disposeWebSocketCleanly(ws, 'client_hangup');
        }
        cleanupMicHardwareOnly();

        if (hideDock) {
            closeVoiceOpenedPmAndRadarModals();
            exitVoiceActivatedSimModeIfNeeded();
            restoreTab1DemoBackupIfNeeded();
            openedLeftDockByVoice = false;
            if (outputAudioCtx && outputAudioCtx.state !== 'closed') {
                outputAudioCtx.close().catch(() => {});
                outputAudioCtx = null;
            }
            document.getElementById('peaLiveVoiceDock')?.classList.add('hidden');
            syncMuteButtonVisualState(false);
        } else {
            updateLiveDockStatusUI('⚪ พักสายชั่วคราว (จำบทสนทนาไว้ 2 ชม.)', 'idle');
            syncMuteButtonVisualState(true);
        }
        updateHeaderLiveButtonsUI();
        updateMemoryBadgeUI();
    }

    function resetPeaLiveVoiceMemory() {
        unlockOutputAudioContextOnGesture();
        closeVoiceOpenedPmAndRadarModals();
        exitVoiceActivatedSimModeIfNeeded();
        restoreTab1DemoBackupIfNeeded();
        clearResumptionHandleState();
        seamlessRenewCount = 0;
        const dockVisible = !document.getElementById('peaLiveVoiceDock')?.classList.contains('hidden');
        if (isLiveConnected || isReconnecting || isLiveConnecting || dockVisible) {
            stopPeaLiveVoiceSession(false);
            clearResumptionHandleState();
            safeToast('♻️ ล้างความจำเดิมและกำลังเริ่มสายสนทนาใหม่...');
            restartSessionTimer = setTimeout(() => {
                restartSessionTimer = null;
                startPeaLiveVoiceSession(false);
            }, 250);
        } else {
            safeToast('♻️ ล้างความจำบทสนทนาเดิมเรียบร้อยแล้วค่ะ');
        }
    }

    function togglePeaLiveMicMute() {
        unlockOutputAudioContextOnGesture();
        if (!isLiveConnected && !isReconnecting && !isLiveConnecting) {
            startPeaLiveVoiceSession(false);
            return;
        }
        if (!isLiveConnected && !isReconnecting) return;
        isMicMuted = !isMicMuted;
        if (isMicMuted) {
            flushMicStreamOnMute();
        }
        syncMuteButtonVisualState(false);
        if (!isAiSpeakingNow && isLiveConnected) {
            updateLiveDockStatusUI(isMicMuted ? '🔇 ปิดไมค์ชั่วคราว (กันเสียงลำโพงสะท้อน)' : '🟢 กำลังรับฟังค่ะ พูดคุยได้เลย...', 'listening');
        }
    }

    async function onSelectFemaleVoiceProfile(newVoice) {
        if (!FEMALE_VOICE_PROFILES[newVoice]) return;
        unlockOutputAudioContextOnGesture();
        selectedFemaleVoice = newVoice;
        try { localStorage.setItem(VOICE_PREF_STORAGE_KEY, newVoice); } catch (e) {}
        clearResumptionHandleState();
        if (isLiveConnected || isReconnecting || isLiveConnecting) {
            stopPeaLiveVoiceSession(false);
            clearResumptionHandleState();
            safeToast(`🌸 สลับเป็นเสียง "${FEMALE_VOICE_PROFILES[newVoice].label}" กำลังเชื่อมต่อเสียงใหม่...`);
            restartSessionTimer = setTimeout(() => {
                restartSessionTimer = null;
                startPeaLiveVoiceSession(false);
            }, 250);
        } else {
            setLiveActionSubtext(`🏢 สังกัด: ${getActiveVoiceGroup()} • เสียง: ${FEMALE_VOICE_PROFILES[selectedFemaleVoice].label}`);
        }
    }

    function triggerAutoPresentationCue() {
        unlockOutputAudioContextOnGesture();
        if (!isLiveConnected) {
            startPeaLiveVoiceSession(true);
            return;
        }
        setDockMinimized(true);
        setLiveActionSubtext('🎬 เริ่มโหมดวิทยากรนำเสนอระบบอัตโนมัติ...');
        sendTextCueToLiveSession(
            'เริ่มทำหน้าที่วิทยากรประชาสัมพันธ์แนะนำระบบเครื่องมือจัดการงานไฟฟ้า (PEA Smart Grid) ให้ผู้บริหารและทีมงานฟังได้เลยค่ะ โดยเรียกเครื่องมือทีละ 1 ขั้นตอน รอพูดอธิบายแต่ละหน้าจอให้จบก่อนไปขั้นถัดไป: ทั้งระบบสกาด้าจำลอง (ย้ำว่าเป็นการจำลองการจ่ายไฟเพื่อวางแผน ไม่ใช่งานโอเปอเรทจริง) และเมื่อถึงส่วนแผนงาน PM ให้ใช้ demoPmOutageRadarStep พาชมทีละขั้นตั้งแต่ปฏิทิน PM การตีกรอบเรดาร์ดูดชื่อสถานที่ โพสต์แจ้งเตือน Facebook/LINE ไปจนถึงเปิดหน้าเว็บแผนที่เรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟ (public_radar_map) แล้วปิดหน้าต่างเรดาร์ก่อนสรุปแท็บคำนวณฟิวส์และกราฟสถิติค่ะ'
        );
    }

    function triggerSpecificTopicDemo(topicCode) {
        unlockOutputAudioContextOnGesture();
        const prompts = {
            scada: 'ช่วยเปิดหน้าผังวงจรระบบสกาด้าจำลอง แล้วเรียกใช้ demoScadaFaultSearch อธิบายการกรอกกระแสฟอลต์ชี้เป้าจุดเสียให้จบก่อน จากนั้นจึงเรียก demoScadaSwitchSimulation เพื่อสาธิตการจำลองปลด-สับสวิตช์ในโหมดจำลองให้ชมค่ะ โดยย้ำชัดเจนว่าเป็น "ระบบสกาด้าจำลอง" สำหรับวางแผนการจ่ายไฟ ไม่ใช่งานโอเปอเรทจริงค่ะ',
            scada_fault: 'ช่วยเรียกใช้เครื่องมือ demoScadaFaultSearch เพื่อสาธิตการกรอกค่ากระแสฟอลต์และระยะทางลงในฟอร์ม แล้วชี้เป้าบริเวณจุดเกิดฟอลต์บนแผนที่ระบบสกาด้าจำลองให้ดูหน่อยค่ะ พร้อมอธิบายว่าเป็นการคำนวณจำลองเพื่อช่วยค้นหาจุดเสีย ไม่ใช่งานโอเปอเรทจริงค่ะ',
            scada_switch: 'ช่วยเรียกใช้เครื่องมือ demoScadaSwitchSimulation(action="toggle") เพื่อเปิดโหมดจำลอง Sandbox แล้วสาธิตการจำลองปลดหรือสับสวิตช์บนแผนที่ระบบสกาด้าจำลองให้ดูหน่อยค่ะ พร้อมย้ำว่าเป็นการจำลองการจ่ายไฟและสับเปลี่ยนโหลดบนหน้าจอเท่านั้น ไม่ใช่งานโอเปอเรทสั่งการจริงค่ะ',
            pm: 'ช่วยสาธิตระบบแผนงาน PM แบบครบวงจรจนถึงแผนที่เรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟ โดยเรียก demoPmOutageRadarStep ทีละ 1 ขั้นตอน (พูดอธิบายให้จบทีละหน้าก่อนแล้วจึงเรียกขั้นถัดไป): เริ่มจาก 1) calendar_overview ตารางปฏิทินและแนบรูปส่ง LINE 2) radar_zone_draft ตีกรอบวงเรดาร์พื้นที่ไฟดับสีแดงและ AI ดูดชื่อสถานที่ในกรอบ 3) announce_post สร้างโพสต์ประกาศ Facebook/LINE และ 4) จบที่ public_radar_map เปิดหน้าเว็บแผนที่เรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟค้างไว้บนหน้าจอ พร้อมอธิบายวิธีที่ประชาชนกดเช็กพิกัด GPS บ้านของตนเองค่ะ',
            public_radar: 'ช่วยเรียก demoPmOutageRadarStep(step="public_radar_map") เพื่อเปิดหน้าเว็บแผนที่เรดาร์ตรวจสอบไฟดับสำหรับผู้ใช้ไฟ (outage-map.html) ขึ้นมาแสดงบนหน้าจอ แล้วอธิบายจุดเด่นและวิธีที่ผู้ใช้ไฟหรือประชาชนกดตรวจสอบพิกัด GPS บ้านและโรงงานของตนเองว่าอยู่ในเขตแผนดับไฟหรือไม่ให้ฟังหน่อยค่ะ',
            dispatch: 'สลับมาหน้าฟอร์มรับแจ้งไฟฟ้าขัดข้อง แท็บ 2 แล้วเตรียมพร้อมช่วยรับแจ้งเหตุและกรอกฟอร์มตามที่ฉันกำลังจะพูดแจ้งต่อไปนี้ค่ะ'
        };
        if (!prompts[topicCode]) return;
        if (!isLiveConnected) {
            pendingAutoPresentAfterConnect = false;
            pendingTopicCueAfterConnect = topicCode;
            if (isLiveConnecting || isReconnecting) {
                setLiveActionSubtext('⏳ เตรียมเปิดหัวข้อสาธิตทันทีที่เชื่อมต่อเสร็จค่ะ...');
                return;
            }
            startPeaLiveVoiceSession(false);
            return;
        }
        if (topicCode.startsWith('scada') || topicCode === 'pm' || topicCode === 'public_radar') {
            setDockMinimized(true);
        }
        sendTextCueToLiveSession(prompts[topicCode]);
    }

    // ========================================================================
    // 6. สร้างปุ่มลัดบน Header, กล่องแชทแท็บ 2 (กันปุ่มซ้อน 100%) & แผงควบคุม Live Studio
    // ========================================================================
    function setDockMinimized(minState) {
        isDockMinimized = Boolean(minState);
        document.getElementById('peaLiveDockFullBody')?.classList.toggle('hidden', isDockMinimized);
        const minBtn = document.getElementById('peaLiveMinToggleBtn');
        if (minBtn) minBtn.textContent = isDockMinimized ? '🔼 ขยาย' : '🔽 ย่อแถบ';
    }

    function updateMemoryBadgeUI() {
        const badge = document.getElementById('peaLiveMemoryBadge');
        if (!badge) return;
        const hasHandle = Boolean(loadValidResumptionState(''));
        const nextText = hasHandle
            ? (seamlessRenewCount > 0
                ? `♾️ คุยต่อเนื่องไม่จำกัดเวลา • ต่อสายอัตโนมัติแล้ว ${seamlessRenewCount} ครั้ง`
                : '♾️ คุยต่อเนื่องไม่จำกัดเวลา • บันทึกความจำอัตโนมัติ (2 ชม.)')
            : '♾️ โหมดบีบอัดความจำอัตโนมัติ (คุยยาวเกิน 15 นาทีได้ไม่ตัดสาย)';
        const nextCls = hasHandle
            ? 'text-[10px] font-bold text-emerald-300 flex items-center justify-between gap-1 px-1'
            : 'text-[10px] font-semibold text-slate-400 flex items-center justify-between gap-1 px-1';
        if (badge.textContent !== nextText) badge.textContent = nextText;
        if (badge.className !== nextCls) badge.className = nextCls;
    }

    function updateLiveDockStatusUI(statusTxt, mode = 'listening') {
        const txtEl = document.getElementById('peaLiveStatusText');
        const dotEl = document.getElementById('peaLiveStatusDot');
        if (txtEl && txtEl.textContent !== statusTxt) txtEl.textContent = statusTxt;
        if (dotEl) {
            dotEl.className = mode === 'speaking'
                ? 'w-2.5 h-2.5 rounded-full bg-pink-400 animate-ping shrink-0'
                : (mode === 'connecting' ? 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0'
                : (mode === 'idle' ? 'w-2.5 h-2.5 rounded-full bg-slate-400 shrink-0' : 'w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0'));
        }
    }

    function setLiveActionSubtext(subTxt) {
        const el = document.getElementById('peaLiveActionSubtext');
        if (el && el.textContent !== subTxt) el.textContent = subTxt;
    }

    function startVisualizerLoop() {
        if (visualizerAnimId) cancelAnimationFrame(visualizerAnimId);
        const bars = [0, 1, 2, 3, 4].map(i => document.getElementById(`peaVoiceWaveBar-${i}`));
        const tick = (t) => {
            if (!isUserSessionActive) return;
            bars.forEach((b, idx) => {
                if (!b) return;
                let h = 6;
                if (isAiSpeakingNow) {
                    h = 8 + Math.abs(Math.sin((t / 130) + idx * 0.9)) * 20;
                } else if (isReconnecting) {
                    h = 6 + Math.abs(Math.sin((t / 200) + idx * 0.6)) * 8;
                } else if (!isMicMuted && currentMicLevel > 0.03) {
                    h = 6 + Math.min(22, currentMicLevel * 26 * (0.6 + ((idx % 3) * 0.25)));
                }
                b.style.height = `${Math.round(h)}px`;
                b.style.background = isAiSpeakingNow
                    ? 'linear-gradient(to top, #ec4899, #f9a8d4)'
                    : (isReconnecting ? '#fbbf24' : '#34d399');
            });
            visualizerAnimId = requestAnimationFrame(tick);
        };
        visualizerAnimId = requestAnimationFrame(tick);
    }

    function updateHeaderLiveButtonsUI() {
        const activeSession = isLiveConnected || isReconnecting || isLiveConnecting;
        const stateKey = activeSession ? 'active' : 'idle';
        const activeCls = 'bg-gradient-to-r from-pink-600 to-rose-500 text-white px-2.5 py-1.5 rounded-xl text-xs font-extrabold shadow-md flex items-center gap-1 border border-pink-200 animate-pulse';
        const idleMainCls = 'bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-500 hover:to-pink-500 text-white px-2.5 py-1.5 rounded-xl text-xs transition shadow-sm flex items-center gap-1 font-semibold border border-pink-300/40';

        ['peaMainHeaderLiveBtn', 'peaTechHeaderLiveBtn'].forEach(id => {
            const btn = document.getElementById(id);
            if (!btn || btn.dataset.liveState === stateKey) return;
            btn.dataset.liveState = stateKey;
            btn.className = activeSession ? activeCls : idleMainCls;
            btn.innerHTML = activeSession ? '🌸 <span>กำลังคุยสด</span>' : '🎙️ <span>AI พูดสด</span>';
        });

        const chatBtn = document.getElementById('peaChatbotLiveVoiceBtn');
        if (chatBtn && chatBtn.dataset.liveState !== stateKey) {
            chatBtn.dataset.liveState = stateKey;
            chatBtn.className = activeSession
                ? 'shrink-0 bg-pink-500 text-white px-2.5 py-1 rounded-full text-[11px] font-extrabold flex items-center gap-1 shadow animate-pulse'
                : 'shrink-0 bg-pink-500/90 hover:bg-pink-500 text-white px-2.5 py-1 rounded-full text-[11px] font-extrabold flex items-center gap-1 shadow transition';
            chatBtn.innerHTML = activeSession ? '🌸 กำลังคุยสด' : '🎙️ คุยสด';
        }
    }

    function injectLiveVoiceUI() {
        ensureTab1ManualEditGuardBound();
        const mainHdr = document.querySelector('#mainAppContent .bg-gradient-to-r .flex.items-center.gap-1\\.5.shrink-0');
        if (mainHdr && !document.getElementById('peaMainHeaderLiveBtn')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'peaMainHeaderLiveBtn';
            btn.onclick = () => (isLiveConnected || isReconnecting || isLiveConnecting) ? (unlockOutputAudioContextOnGesture(), setDockMinimized(false), document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden')) : startPeaLiveVoiceSession(false);
            const pmBtn = document.getElementById('pmMainHeaderBtn') || mainHdr.querySelector('button[onclick="openBackupModal()"]');
            if (pmBtn) mainHdr.insertBefore(btn, pmBtn); else mainHdr.appendChild(btn);
        }

        const techHdr = document.querySelector('#techMainApp .bg-gradient-to-r .flex.flex-wrap.items-center.gap-1\\.5');
        if (techHdr && !document.getElementById('peaTechHeaderLiveBtn')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'peaTechHeaderLiveBtn';
            btn.onclick = () => (isLiveConnected || isReconnecting || isLiveConnecting) ? (unlockOutputAudioContextOnGesture(), setDockMinimized(false), document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden')) : startPeaLiveVoiceSession(false);
            techHdr.insertBefore(btn, techHdr.firstChild);
        }

        const chatHdrBar = document.querySelector('#geminiChatbot .bg-gradient-to-r');
        if (chatHdrBar && !document.getElementById('peaChatbotLiveVoiceBtn')) {
            const apiKeyBtn = chatHdrBar.querySelector('button[onclick*="openApiKeyModal"]');
            if (apiKeyBtn) {
                let btnWrap = apiKeyBtn.parentElement;
                if (!btnWrap || btnWrap === chatHdrBar || btnWrap.tagName === 'BUTTON') {
                    btnWrap = document.createElement('div');
                    btnWrap.className = 'flex flex-wrap items-center justify-end gap-1.5';
                    chatHdrBar.insertBefore(btnWrap, apiKeyBtn);
                    btnWrap.appendChild(apiKeyBtn);
                }
                const liveBtn = document.createElement('button');
                liveBtn.type = 'button';
                liveBtn.id = 'peaChatbotLiveVoiceBtn';
                liveBtn.title = 'เปิดโหมดคุยสดสองทางด้วยเสียงผู้หญิง (Gemini Live)';
                liveBtn.onclick = () => (isLiveConnected || isReconnecting || isLiveConnecting)
                    ? (unlockOutputAudioContextOnGesture(), setDockMinimized(false), document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden'))
                    : startPeaLiveVoiceSession(false);
                btnWrap.insertBefore(liveBtn, btnWrap.firstChild);
            }
        }

        if (!document.getElementById('peaLiveVoiceDock')) {
            const voiceOpts = Object.values(FEMALE_VOICE_PROFILES).map(v =>
                `<option value="${v.id}" ${v.id === selectedFemaleVoice ? 'selected' : ''}>${safeEsc(v.label)}</option>`
            ).join('');

            document.body.insertAdjacentHTML('beforeend', `
                <div id="peaLiveVoiceDock" class="hidden fixed bottom-3 right-3 left-3 sm:left-auto sm:w-[380px] z-[1470] rounded-3xl overflow-hidden shadow-2xl border-2 border-pink-400/80 bg-slate-950/95 text-white backdrop-blur-md transition-all">
                    <div class="px-3.5 py-2.5 bg-gradient-to-r from-purple-900 via-fuchsia-800 to-pink-700 flex items-center justify-between gap-2">
                        <div class="flex items-center gap-2 min-w-0 flex-1">
                            <span id="peaLiveStatusDot" class="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0"></span>
                            <div class="flex items-end gap-0.5 h-6 px-1 shrink-0">
                                <span id="peaVoiceWaveBar-0" class="w-1 rounded-full bg-pink-400 transition-all duration-75" style="height:6px"></span>
                                <span id="peaVoiceWaveBar-1" class="w-1 rounded-full bg-pink-400 transition-all duration-75" style="height:10px"></span>
                                <span id="peaVoiceWaveBar-2" class="w-1 rounded-full bg-pink-400 transition-all duration-75" style="height:14px"></span>
                                <span id="peaVoiceWaveBar-3" class="w-1 rounded-full bg-pink-400 transition-all duration-75" style="height:10px"></span>
                                <span id="peaVoiceWaveBar-4" class="w-1 rounded-full bg-pink-400 transition-all duration-75" style="height:6px"></span>
                            </div>
                            <span id="peaLiveStatusText" class="text-xs font-extrabold truncate">🟢 กำลังรับฟังค่ะ...</span>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                            <button type="button" id="peaLiveMinToggleBtn" onclick="togglePeaLiveDockMinimize()" class="bg-white/15 hover:bg-white/25 text-white px-2 py-1 rounded-lg text-[10px] font-bold">🔽 ย่อแถบ</button>
                            <button type="button" onclick="stopPeaLiveVoiceSession(true)" class="bg-rose-600 hover:bg-rose-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-extrabold shadow">⏹️ วางสาย</button>
                        </div>
                    </div>
                    <div id="peaLiveDockFullBody" class="p-3.5 space-y-2.5 text-xs">
                        <div id="peaLiveActionSubtext" class="text-[11px] text-pink-200 bg-white/5 border border-white/10 rounded-xl px-2.5 py-1.5 truncate">🌸 ผู้ช่วยประชาสัมพันธ์ PEA Smart Grid พร้อมดูแลค่ะ</div>
                        <div id="peaLiveMemoryBadge" class="text-[10px] font-semibold text-slate-400 flex items-center justify-between gap-1 px-1">♾️ โหมดบีบอัดความจำอัตโนมัติ (คุยยาวเกิน 15 นาทีได้ไม่ตัดสาย)</div>
                        <div class="grid grid-cols-2 gap-1.5">
                            <button type="button" onclick="triggerAutoPresentationCue()" class="col-span-2 py-2 px-3 rounded-xl bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-400 hover:brightness-105 text-slate-950 font-extrabold text-xs shadow-md flex items-center justify-center gap-1.5">🎬 ให้ผู้ช่วยสาวนำเสนอระบบทั้งหมด (Auto-Demo)</button>
                            <button type="button" onclick="triggerSpecificTopicDemo('scada_fault')" class="py-1.5 px-2 rounded-xl bg-rose-600/85 hover:bg-rose-600 text-white font-bold text-[11px] border border-rose-400/40">🎯 สาธิตหากระแสฟอลต์</button>
                            <button type="button" onclick="triggerSpecificTopicDemo('scada_switch')" class="py-1.5 px-2 rounded-xl bg-amber-600/85 hover:bg-amber-600 text-white font-bold text-[11px] border border-amber-400/40">🔀 สาธิตจำลองปลด-สับ</button>
                            <button type="button" onclick="triggerSpecificTopicDemo('pm')" class="py-1.5 px-2 rounded-xl bg-indigo-600/85 hover:bg-indigo-600 text-white font-bold text-[11px] border border-indigo-400/40">📅 สาธิตแผน PM ครบวงจร</button>
                            <button type="button" onclick="triggerSpecificTopicDemo('public_radar')" class="py-1.5 px-2 rounded-xl bg-pink-600/85 hover:bg-pink-600 text-white font-bold text-[11px] border border-pink-400/40">📡 เรดาร์ไฟดับผู้ใช้ไฟ</button>
                        </div>
                        <div class="flex items-center gap-1.5 pt-1 border-t border-white/10">
                            <button type="button" id="peaLiveMuteBtn" onclick="togglePeaLiveMicMute()" class="flex-1 py-2 px-2 rounded-xl bg-white/15 hover:bg-white/25 text-white font-bold text-[11px] border border-white/20 transition">🎙️ ไมค์: เปิดรับฟัง</button>
                            <button type="button" onclick="resetPeaLiveVoiceMemory()" title="ล้างความจำบทสนทนาเดิมเพื่อเริ่มหัวข้อใหม่" class="py-2 px-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-400/30 text-[11px] font-bold shrink-0">♻️ เริ่มใหม่</button>
                            <button type="button" onclick="openPeaLiveKeyConfig()" title="ตั้งค่า API Key ประจำกลุ่ม" class="py-2 px-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-400/30 text-[11px] font-bold shrink-0">🔑</button>
                            <select onchange="onSelectFemaleVoiceProfile(this.value)" title="เลือกโทนเสียงผู้หญิง" class="py-2 px-1.5 rounded-xl bg-slate-900 text-pink-200 border border-pink-400/40 text-[11px] font-bold focus:outline-none max-w-[118px]">${voiceOpts}</select>
                        </div>
                    </div>
                </div>
            `);
        }
        updateHeaderLiveButtonsUI();
        updateMemoryBadgeUI();
    }

    function togglePeaLiveDockMinimize() {
        unlockOutputAudioContextOnGesture();
        setDockMinimized(!isDockMinimized);
    }

    function openPeaLiveKeyConfig() {
        openKeySetupModalFallback();
    }

    window.addEventListener('storage', (e) => {
        if (e.key && e.key.startsWith(SHARED_GROUP_AI_KEY_PREFIX)) {
            const activeStorageKey = `${SHARED_GROUP_AI_KEY_PREFIX}${getActiveVoiceGroup()}`;
            if (e.key === activeStorageKey) {
                const nextKey = getGroupApiKey();
                if (nextKey === lastKnownGroupApiKey) return;
                lastKnownGroupApiKey = nextKey;
                resolvedLiveModelsCache.clear();
                unsupportedLiveModels.clear();
                clearResumptionHandleState();

                if (!nextKey && (isLiveConnected || isReconnecting || isLiveConnecting)) {
                    stopPeaLiveVoiceSession(true);
                } else if (nextKey && (isLiveConnected || isReconnecting || isLiveConnecting)) {
                    stopPeaLiveVoiceSession(false);
                    restartSessionTimer = setTimeout(() => {
                        restartSessionTimer = null;
                        startPeaLiveVoiceSession(false);
                    }, 200);
                }
            } else {
                resolvedLiveModelsCache.clear();
                unsupportedLiveModels.clear();
            }
        }
    });

    document.addEventListener('visibilitychange', async () => {
        if (document.hidden || !isUserSessionActive) return;
        if (outputAudioCtx && (outputAudioCtx.state === 'suspended' || outputAudioCtx.state === 'interrupted')) {
            outputAudioCtx.resume().catch(() => {});
        }
        if (inputAudioCtx && (inputAudioCtx.state === 'suspended' || inputAudioCtx.state === 'interrupted')) {
            inputAudioCtx.resume().catch(() => {});
        }
        const trackEnded = !micStream || !micStream.active || micStream.getAudioTracks().some(t => t.readyState !== 'live');
        if (trackEnded && (isLiveConnected || isReconnecting)) {
            try { await ensureMicrophoneStreamingActive(); } catch (e) {}
        }
    });

    ['pagehide', 'beforeunload'].forEach(evName => {
        window.addEventListener(evName, () => {
            if (isUserSessionActive || liveWs || tab1DemoBackup) stopPeaLiveVoiceSession(true);
        });
    });

    window.addEventListener('online', () => {
        if (isUserSessionActive && !isLiveConnected && !isLiveConnecting && !isReconnecting) {
            reconnectAttemptCount = 0;
            performSeamlessSessionReconnect('network_online');
        }
    });

    let prevLogged = isLoggedIn();
    let prevGroup = getActiveVoiceGroup();
    lastKnownGroupApiKey = getGroupApiKey();
    setInterval(() => {
        injectLiveVoiceUI();
        const curLogged = isLoggedIn();
        const curGrp = getActiveVoiceGroup();
        if (!curLogged && prevLogged) {
            clearResumptionHandleState(prevGroup);
            stopPeaLiveVoiceSession(true);
        } else if ((isLiveConnected || isReconnecting || isLiveConnecting) && curGrp !== prevGroup) {
            stopPeaLiveVoiceSession(true);
        }
        if (curGrp !== prevGroup) {
            lastKnownGroupApiKey = getGroupApiKey();
        }
        prevLogged = curLogged;
        prevGroup = curGrp;
    }, 1500);

    Object.assign(window, {
        startPeaLiveVoiceSession,
        stopPeaLiveVoiceSession,
        resetPeaLiveVoiceMemory,
        togglePeaLiveMicMute,
        togglePeaLiveDockMinimize,
        openPeaLiveKeyConfig,
        triggerAutoPresentationCue,
        triggerSpecificTopicDemo,
        onSelectFemaleVoiceProfile,
        closePeaLivePublicRadarPreview,
        copyPeaLivePublicRadarLink
    });

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', injectLiveVoiceUI);
    } else {
        injectLiveVoiceUI();
    }
})();
// ==================== จบไฟล์ pea-live-voice.js (v2.7) ====================