// ============================================================================
// 🎙️🌸 PEA SMART GRID — GEMINI LIVE VOICE PR PRESENTER & ASSISTANT v2.4 (pea-live-voice.js)
// ระบบผู้ช่วยเสียงพูดสดสองทาง (WebSocket BidiGenerateContent + Function Calling)
// รองรับคีย์ AIza & AQ. + พรีเซนต์ "ระบบสกาด้าจำลอง" (จำลองการจ่ายไฟ ไม่ใช่งานโอเปอเรทจริง)
// ============================================================================
(function () {
    'use strict';

    // ป้องกันการสร้างปุ่มซ้อนทับเมื่อ page2.html ถูกเปิดฝังอยู่ใน Iframe ฝั่งซ้ายของ index.html
    if (window.self !== window.top) return;

    const Core = window.PeaCore;
    const SHARED_GROUP_AI_KEY_PREFIX = 'elec_pm_ai_vision_key_v1__';
    const VOICE_PREF_STORAGE_KEY = 'elec_live_voice_name_v1';
    const RESUME_STATE_STORAGE_PREFIX = 'elec_live_resume_v2__';
    const RESUME_HANDLE_TTL_MS = 2 * 60 * 60 * 1000;
    const MAX_AUTO_RECONNECT_ATTEMPTS = 6;
    const SPEAKER_ECHO_GATE_RMS = 0.045;
    const BARGE_IN_MIN_MS = 120; // ต้องมีเสียงพูดต่อเนื่อง >= 120ms ป้องกันเสียงเคาะจอตัดบทพูด
    const POST_TURN_BARGE_WINDOW_MS = 4500;

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
    // 1. Helpers กลุ่มสังกัด, API Key ประจำกลุ่ม & จัดการ Resumption Handle (จำบทสนทนา 2 ชม.)
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
            // อยู่หน้าแผงคุยสด (1470) แต่อยู่หลังป๊อปอัปแจ้งเตือน (1480) และ Toast (1500)
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

    function closeVoiceOpenedLeftDockIfNeeded() {
        if (window.innerWidth < 1024 || openedLeftDockByVoice) {
            openedLeftDockByVoice = false;
            window.closeLeftWebBrowser?.();
        }
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
    // 3. ข้อมูลสถิติสด & เครื่องมือควบคุมหน้าจอ (ซิงค์จังหวะสลับหน้าจอกับคิวเสียงพูดจริง)
    // ========================================================================
    function collectLiveSystemSnapshot() {
        const isMainPage = Boolean(document.getElementById('mainAppContent'));
        const grp = getActiveVoiceGroup();
        const rawUser = (rawGet('elec_app_current_user') || '').trim();
        const userDisplay = typeof window.formatTechDisplayName === 'function' ? window.formatTechDisplayName(rawUser) : (rawUser || 'ผู้ใช้งาน');

        let scadaPinsCount = 0, pmPendingCount = 0, pmDoneCount = 0, pmPublicRadarCount = 0;
        try {
            const delPins = JSON.parse(rawGet('elec_deleted_labeled_places_map') || '{}');
            const pins = JSON.parse(rawGet('elec_labeled_places_list') || '[]');
            scadaPinsCount = pins.filter(p => p?.id && !delPins[p.id] && normGroup(p.ownerGroup || 'กฟส.บึง') === grp).length;
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

        if (!isMainPage) {
            return {
                currentPage: 'page2_technician_workspace',
                branchGroup: grp,
                loggedInUser: userDisplay,
                pendingJobs: document.getElementById('countPendingJobs')?.textContent || '0',
                travelingJobs: document.getElementById('countTravelingJobs')?.textContent || '0',
                doneJobs: document.getElementById('countDoneJobs')?.textContent || '0',
                scadaEquipmentPins: scadaPinsCount,
                pmPendingPlans: pmPendingCount,
                pmPublicOutageZones: pmPublicRadarCount
            };
        }

        return {
            currentPage: 'main_dispatch_workspace',
            branchGroup: grp,
            loggedInUser: userDisplay,
            currentShift: document.getElementById('shift')?.value || '-',
            nextJobNo: document.getElementById('jobNo')?.value || '1',
            faultTotal: document.getElementById('statFaultTotal')?.textContent || '0',
            fault22kV: document.getElementById('statFault22kV')?.textContent || '0',
            fault115kV: document.getElementById('statFault115kV')?.textContent || '0',
            outageTotal: document.getElementById('statOutageTotal')?.textContent || '0',
            outageToday: document.getElementById('statOutageToday')?.textContent || '0',
            overdueCaDatabaseCount: document.getElementById('caCountBadge')?.textContent || '0',
            weatherStatus: (document.getElementById('liveWeatherStatus')?.textContent || '').trim(),
            scadaEquipmentPins: scadaPinsCount,
            pmPendingPlans: pmPendingCount,
            pmCompletedPlans: pmDoneCount,
            pmPublicOutageZones: pmPublicRadarCount
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
            '- กฎเหล็กสำคัญมาก: ทุกครั้งที่พูดถึงผังวงจร SCADA ต้องเรียกว่า "ระบบสกาด้าจำลอง" เสมอ และต้องชี้แจงให้ชัดเจนว่า "เป็นการจำลองการจ่ายไฟและจำลองสถานะสวิตช์บนแผนที่เพื่อช่วยวางแผนและวิเคราะห์งานเท่านั้น ไม่ใช่งานโอเปอเรทสั่งสับปลดจ่ายไฟจริงในสนาม" ห้ามพูดให้เข้าใจผิดว่าเป็นการสั่งการอุปกรณ์ไฟฟ้าจริงเด็ดขาด',
            '',
            'กฎการทำงานเมื่อได้รับคำสั่ง "แนะนำระบบ" หรือ "พรีเซนต์ระบบ":',
            isMain
                ? [
                    '1. กล่าวต้อนรับผู้บริหารหรือผู้รับฟังอย่างนุ่มนวล แนะนำชื่อระบบเครื่องมือจัดการงานไฟฟ้าแบบครบวงจรสำหรับศูนย์สั่งการและช่างภาคสนาม พัฒนาโดยคุณศุภเรศ ศรีคชา',
                    '2. พาชมทีละหน้าจอโดยเรียกใช้เครื่องมือ navigateAppScreen ครั้งละ 1 คำสั่งควบคู่ไปกับการอธิบายจุดเด่นทีละส่วนอย่างต่อเนื่อง (ห้ามส่งคำสั่งเปิดหลายหน้าจอพร้อมกันในรอบเดียว ให้เปิด 1 หน้า อธิบายหน้านั้น 2-3 ประโยคให้ชัดเจน แล้วจึงเรียกเปิดหน้าถัดไป):',
                    '   - ขั้นที่ 1: เรียก navigateAppScreen("tab1_fault") อธิบายฟอร์มรายงานเหตุสถานี 22kV/115kV เชื่อมเรดาร์น้ำฝน Rain Alarm อัตโนมัติ และตรวจเตือนป้ายห้ามสับไฟ LOTO',
                    '   - ขั้นที่ 2: เรียก navigateAppScreen("scada_split") โชว์ "ระบบสกาด้าจำลอง" คู่หน้าฟอร์ม โดยย้ำชัดเจนว่าเป็นระบบสกาด้าจำลองสำหรับการจ่ายไฟและจำลองสับเปลี่ยนภาระโหลดบนหน้าจอ ไม่ใช่งานโอเปอเรทจริง ช่วยให้คลิกสวิตช์ส่งรหัสเข้าฟอร์มและคำนวณจุดเกิดฟอลต์ได้อย่างปลอดภัย แล้วเรียก navigateAppScreen("close_scada_split") เมื่ออธิบายจบ',
                    '   - ขั้นที่ 3: เรียก navigateAppScreen("tab2_outage") อธิบายระบบรับแจ้งไฟฟ้าขัดข้อง คัดกรองข้อมูลลูกค้า แจ้งเตือนเลข CA ค้างจ่าย 12 หลัก แนะนำช่างที่อยู่ใกล้จุดเกิดเหตุที่สุดด้วย GPS สด และสร้างลิงก์ใบสับเปลี่ยนมิเตอร์ชำรุดอัตโนมัติ',
                    '   - ขั้นที่ 4: เรียก navigateAppScreen("pm_calendar_grid") อธิบายตารางปฏิทินแผนงานบำรุงรักษา PM และแนบรูปส่ง LINE จากนั้นจึงเรียก navigateAppScreen("pm_calendar_map") โชว์แผนที่หมุด PM โซนเรดาร์แจ้งดับไฟประชาชน พร้อม AI อ่านป้ายชื่อสถานที่สร้างโพสต์ Facebook/LINE แล้วเรียก navigateAppScreen("close_pm_calendar")',
                    '   - ขั้นที่ 5: เรียก demoCalculate22kVFuse(160, 1, 1.5) เพื่อเปิดแท็บ 3 สาธิตคำนวณขนาดฟิวส์เมนแรงสูง 22kV ของหม้อแปลง 160 เควีเอ โชว์ผลลัพธ์จริงบนหน้าจอ',
                    '   - ขั้นที่ 6: เรียก navigateAppScreen("tab4_analytics") เปิดแท็บ 4 แดชบอร์ดกราฟสถิติ สรุปจำนวนข้อมูลจริงของสาขาจากผลลัพธ์ที่ได้ แล้วกล่าวปิดท้ายเปิดโอกาสให้ผู้ฟังซักถามเพิ่มเติมด้วยรอยยิ้มในน้ำเสียงค่ะ'
                ].join('\n')
                : 'คุณกำลังอยู่บนหน้าปฏิบัติงานช่างภาคสนาม (Page 2) สามารถเรียก navigateAppScreen เพื่อสลับดูรายการใบงานช่าง แผนที่ผังวงจร "ระบบสกาด้าจำลอง" (ย้ำว่าเป็นการจำลองการจ่ายไฟเพื่อวางแผน ไม่ใช่งานโอเปอเรทจริง) และปฏิทินแผนงาน PM พร้อมรายงานยอดงานค้างและงานกำลังเดินทางจากข้อมูลจริงได้ค่ะ',
            '',
            'กฎการทำงานขณะช่วยปฏิบัติงานจริง:',
            '- หากผู้ใช้แจ้งรายละเอียดไฟฟ้าขัดข้องของชาวบ้าน ให้เรียก fillOutageReportByVoice เพื่อกรอกลงฟอร์มแท็บ 2 ทันที (หากข้อมูลใดไม่ได้ระบุให้ส่งค่าว่าง "" ห้ามเดาเอง)',
            '- หากผู้ใช้แจ้งเหตุเบรกเกอร์ทริป TR/TL ในสถานี ให้เรียก fillFaultReportByVoice เพื่อกรอกลงฟอร์มแท็บ 1',
            '- หากผู้ฟังพูดแทรกถามคำถามระหว่างการนำเสนอ ให้ตอบคำถามนั้นอย่างชัดเจนและสุภาพทันทีค่ะ'
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
                name: 'getLiveSystemStats',
                description: 'ดึงตัวเลขสถิติใบงานจริง กะปัจจุบัน สภาพอากาศ จำนวนหมุดอุปกรณ์ในระบบสกาด้าจำลอง และแผนงาน PM ล่าสุดในระบบ',
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

    function hideFormFloatingMenus(ids) {
        ids.forEach(id => document.getElementById(id)?.classList.add('hidden'));
    }

    // รอจนเสียงบรรยายท่อนก่อนหน้าพูดจบประโยคก่อนสลับหน้าจอหรือเปิดแท็บคำนวณฟิวส์ (ยกเลิกทันทีหากพูดแทรก)
    async function waitForQueuedAudioBeforeUiTool(ws, targetPlayTimeSec, fnCalls, cancelledSet, startInterruptSeq) {
        const shouldSyncWithSpeech = fnCalls.some(fc => fc && (fc.name === 'navigateAppScreen' || fc.name === 'demoCalculate22kVFuse'));
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

        if (name === 'getLiveSystemStats') {
            setLiveActionSubtext('📊 กำลังอ่านข้อมูลสถิติจริงในระบบ...');
            return collectLiveSystemSnapshot();
        }

        if (name === 'navigateAppScreen') {
            const target = String(args.target || '').trim();
            const isMainPage = Boolean(document.getElementById('mainAppContent'));

            if (target === 'pm_calendar_grid') {
                closeVoiceOpenedLeftDockIfNeeded();
                setDockMinimized(true);
                setLiveActionSubtext('📅 เปิดตารางปฏิทินแผนงาน PM');
                window.openPmCalendarModal?.();
                await new Promise(r => setTimeout(r, 180));
                window.switchCalendarLeftViewMode?.('grid');
            } else if (target === 'pm_calendar_map') {
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
                setLiveActionSubtext('✕ ปิดหน้าต่างปฏิทิน PM');
                window.closePmCalendarModal?.();
            } else if (!isMainPage) {
                window.closePmCalendarModal?.();
                if (target === 'tech_scada_map' || target === 'scada_split') {
                    setDockMinimized(true);
                    setLiveActionSubtext('⚡ สลับไปหน้าผังระบบสกาด้าจำลอง');
                    window.switchTechMainTab?.('map');
                } else {
                    setLiveActionSubtext('🛠️ สลับไปหน้ารายการใบงานช่าง');
                    window.switchTechMainTab?.('jobs');
                }
            } else {
                window.closePmCalendarModal?.();
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
                window.closePmCalendarModal?.();
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
            window.closePmCalendarModal?.();
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
            window.closePmCalendarModal?.();
            if (window.innerWidth < 1024) closeVoiceOpenedLeftDockIfNeeded();
            window.switchTab?.('tab1');

            const normToken = s => String(s || '').toUpperCase().replace(/[\s\-/,._]+/g, '');
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

    // ========================================================================
    // 4. ระบบประมวลผลเสียง PCM 16kHz (พร้อม Mic Singleton Lock & Async Audio Guard)
    // ========================================================================
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

            // กู้คืนไมโครโฟนในเครื่องอัตโนมัติหากหูฟังบลูทูธหลุดกลางคันขณะเปิดหน้าจออยู่
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
    // 5. WebSocket (Sync ArrayBuffer FIFO) + Compression + Resumption & Auto-Reconnect
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
                            let executedUiCount = 0;
                            for (const fc of fnCalls) {
                                if (cancelledToolCallIds.has(fc.id) || ws._peaDisposed || callEpoch !== sessionEpoch || !isUserSessionActive) continue;
                                const isPresentationUiFn = (fc.name === 'navigateAppScreen' || fc.name === 'demoCalculate22kVFuse');
                                if (turnInterruptionSeq !== callInterruptSeq && isPresentationUiFn) {
                                    functionResponses.push({
                                        id: fc.id,
                                        name: fc.name,
                                        response: { result: { ok: false, skippedDueToInterruption: true } }
                                    });
                                    continue;
                                }
                                if (executedUiCount > 0 && isPresentationUiFn) {
                                    await new Promise(r => setTimeout(r, 900));
                                    if (cancelledToolCallIds.has(fc.id) || ws._peaDisposed || callEpoch !== sessionEpoch || !isUserSessionActive) continue;
                                    if (turnInterruptionSeq !== callInterruptSeq) {
                                        functionResponses.push({
                                            id: fc.id,
                                            name: fc.name,
                                            response: { result: { ok: false, skippedDueToInterruption: true } }
                                        });
                                        continue;
                                    }
                                }
                                let resObj = {};
                                try {
                                    resObj = await executeVoiceToolCall(fc.name, fc.args || {});
                                    if (fc.name !== 'getLiveSystemStats') executedUiCount++;
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
                sendTextCueToLiveSession('กล่าวทักทายสั้นๆ 1 ประโยคอย่างนุ่มนวลว่าพร้อมเป็นผู้ช่วยรับแจ้งเหตุและแนะนำระบบแล้วค่ะ');
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
            'เริ่มทำหน้าที่วิทยากรประชาสัมพันธ์แนะนำระบบเครื่องมือจัดการงานไฟฟ้า (PEA Smart Grid) ให้ผู้บริหารและทีมงานฟังได้เลยค่ะ โดยเรียกใช้เครื่องมือเปิดหน้าจอจริงโชว์ทีละส่วนตามลำดับพร้อมอธิบายจุดเด่นอย่างนุ่มนวลชัดเจน ทั้งนี้เมื่อถึงส่วนผังวงจรให้เรียกว่า "ระบบสกาด้าจำลอง" และย้ำว่าเป็นการจำลองการจ่ายไฟเพื่อวางแผน ไม่ใช่งานโอเปอเรทจริง พร้อมดึงตัวเลขจริงของสาขามาประกอบการบรรยายด้วยค่ะ'
        );
    }

    function triggerSpecificTopicDemo(topicCode) {
        unlockOutputAudioContextOnGesture();
        const prompts = {
            scada: 'ช่วยเปิดหน้าผังวงจรระบบสกาด้าจำลองคู่หน้าฟอร์ม แล้วอธิบายจุดเด่นของ "ระบบสกาด้าจำลอง" โดยย้ำชัดเจนว่าเป็นการจำลองการจ่ายไฟและสับเปลี่ยนโหลดบนแผนที่เพื่อช่วยวางแผน ไม่ใช่งานโอเปอเรทสั่งสับปลดจริง พร้อมอธิบายการตรวจเตือนป้าย LOTO และการชี้เป้าฟอลต์ให้ฟังหน่อยค่ะ',
            pm: 'ช่วยเปิดหน้าปฏิทินและแผนที่หมุดแผนงาน PM โชว์โซนเรดาร์แจ้งดับไฟประชาชนและการใช้ AI อ่านป้ายชื่อสถานที่สร้างโพสต์ Facebook/LINE ให้ฟังหน่อยค่ะ',
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
        if (topicCode === 'scada' || topicCode === 'pm') setDockMinimized(true);
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

        // อัปเดต DOM เฉพาะเมื่อสถานะเปลี่ยนจริง ป้องกันการสร้าง span ใหม่ทับจังหวะแตะปุ่มบนมือถือ
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
                            <button type="button" onclick="triggerSpecificTopicDemo('scada')" class="py-1.5 px-2 rounded-xl bg-teal-600/80 hover:bg-teal-600 text-white font-bold text-[11px] border border-teal-400/40">⚡ สาธิตสกาด้าจำลอง</button>
                            <button type="button" onclick="triggerSpecificTopicDemo('pm')" class="py-1.5 px-2 rounded-xl bg-indigo-600/80 hover:bg-indigo-600 text-white font-bold text-[11px] border border-indigo-400/40">📅 สาธิตแผน PM/เรดาร์</button>
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
            if (isUserSessionActive || liveWs) stopPeaLiveVoiceSession(true);
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
        onSelectFemaleVoiceProfile
    });

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', injectLiveVoiceUI);
    } else {
        injectLiveVoiceUI();
    }
})();
// ==================== จบไฟล์ pea-live-voice.js (v2.4) ====================