// ============================================================================
// 🎙️🌸 PEA SMART GRID — GEMINI LIVE VOICE PR PRESENTER & ASSISTANT v1.3 (pea-live-voice.js)
// ระบบผู้ช่วยเสียงพูดสดสองทาง (WebSocket BidiGenerateContent + Function Calling)
// รองรับ Context Compression + Session Resumption + audioStreamEnd + Safe DOM & Thinking Fallback
// ============================================================================
(function () {
    'use strict';

    // ป้องกันการสร้างปุ่มซ้อนทับเมื่อ page2.html ถูกเปิดฝังอยู่ใน Iframe ฝั่งซ้ายของ index.html
    if (window.self !== window.top) return;

    const Core = window.PeaCore;
    const SHARED_GROUP_AI_KEY_PREFIX = 'elec_pm_ai_vision_key_v1__';
    const VOICE_PREF_STORAGE_KEY = 'elec_live_voice_name_v1';
    const RESUME_STATE_STORAGE_PREFIX = 'elec_live_resume_v1__';
    const RESUME_HANDLE_TTL_MS = 2 * 60 * 60 * 1000;
    const MAX_AUTO_RECONNECT_ATTEMPTS = 6;
    const SPEAKER_ECHO_GATE_RMS = 0.042;

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

    const resolvedLiveModelsCache = new Map();
    const unsupportedLiveModels = new Set();

    let liveWs = null;
    let activeConnectedModel = '';
    let isLiveConnected = false;
    let isLiveConnecting = false;
    let isUserSessionActive = false;
    let isReconnecting = false;
    let reconnectAttemptCount = 0;
    let seamlessRenewCount = 0;
    let reconnectTimer = null;
    let goAwaySwapTimer = null;
    let pendingGoAwayReconnect = false;
    let isServerTurnGenerating = false;

    let isMicMuted = false;
    let isDockMinimized = false;
    let selectedFemaleVoice = localStorage.getItem(VOICE_PREF_STORAGE_KEY) || 'Aoede';
    if (!FEMALE_VOICE_PROFILES[selectedFemaleVoice]) selectedFemaleVoice = 'Aoede';

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

    // ========================================================================
    // 1. Helpers กลุ่มสังกัด, API Key ประจำกลุ่ม & จัดการ Resumption Handle (จำบทสนทนา 2 ชม.)
    // ========================================================================
    function rawGet(key) {
        return Core && typeof Core.rawStorageGet === 'function' ? Core.rawStorageGet(key) : localStorage.getItem(key);
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
        return String(raw || '').trim().replace(/\s+/g, ' ')
            .replace(/^(กฟ[สฟจตอ])\.?\s+/, '$1.')
            .replace(/^(กฟ[สฟจตอ])(?![.\s])/, '$1.');
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
        return String(val || rawGet(k) || '').trim();
    }

    function openKeySetupModalFallback() {
        if (typeof window.openApiKeyModal === 'function') return window.openApiKeyModal();
        if (typeof window.openPmAiKeyModal === 'function') return window.openPmAiKeyModal(false);
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

    // ========================================================================
    // 2. ตรวจสอบคุณสมบัติรายโมเดล & ค้นหาโมเดล Gemini Live อัตโนมัติ
    // ========================================================================
    function isLegacy20LiveModel(modelName) {
        return /gemini-2\.0-/i.test(String(modelName || ''));
    }

    function isExtendedThinkingLiveModel(modelName) {
        return /extended-thinking/i.test(String(modelName || ''));
    }

    function isPreview31LiveModel(modelName) {
        return /gemini-3\.1-flash-live/i.test(String(modelName || ''));
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
            const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(apiKey)}`;
            const res = await fetch(url, { signal: ctrl ? ctrl.signal : undefined });
            const data = await res.json().catch(() => null);
            if (res.status === 400 || res.status === 403) {
                const msg = String(data?.error?.message || '');
                if (/API_KEY_INVALID|API key not valid|key expired|PERMISSION_DENIED|API_KEY_HTTP_REFERRER_BLOCKED/i.test(msg)) {
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
                    if (lower.includes('translate')) return;
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
    // 3. ข้อมูลสถิติสด & เครื่องมือควบคุมหน้าจอ (รองรับทั้ง BLOCKING และ NON_BLOCKING)
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
            'บุคลิกและน้ำเสียงการพูด:',
            '- ใช้เสียงผู้หญิงที่นุ่มนวล อบอุ่น สุภาพ ชัดถ้อยชัดคำ น่าเชื่อถือแบบนักประชาสัมพันธ์มืออาชีพ ลงท้ายด้วย "ค่ะ" หรือ "นะคะ" เสมอ',
            '- อ่านคำย่อทางวิศวกรรมไฟฟ้าให้เป็นธรรมชาติและฟังง่าย เช่น "กฟภ." อ่านว่า "การไฟฟ้าส่วนภูมิภาค", "22kV" อ่านว่า "ยี่สิบสองเควี", "115kV" อ่านว่า "หนึ่งร้อยสิบห้าเควี", "TR/TL" อ่านว่า "ทีอาร์ ทับ ทีแอล", "SCADA" อ่านว่า "สกาด้า", "CA" อ่านว่า "ซีเอ", "PM" อ่านว่า "พีเอ็ม"',
            '',
            'กฎการทำงานเมื่อได้รับคำสั่ง "แนะนำระบบ" หรือ "พรีเซนต์ระบบ":',
            isMain
                ? [
                    '1. กล่าวต้อนรับผู้บริหารหรือผู้รับฟังอย่างนุ่มนวล แนะนำชื่อระบบเครื่องมือจัดการงานไฟฟ้าแบบครบวงจรสำหรับศูนย์สั่งการและช่างภาคสนาม พัฒนาโดยคุณศุภเรศ ศรีคชา',
                    '2. พาชมทีละหน้าจอโดยเรียกใช้เครื่องมือ navigateAppScreen ควบคู่ไปกับการอธิบายจุดเด่นทีละส่วนอย่างต่อเนื่อง (ห้ามกดรวดเดียวครบทุกหน้าก่อนพูด ให้กดเปิดทีละหน้า อธิบายหน้านั้น 2-3 ประโยคให้ชัดเจน แล้วจึงกดเปิดหน้าถัดไป):',
                    '   - ขั้นที่ 1: เรียก navigateAppScreen("tab1_fault") อธิบายฟอร์มรายงานเหตุสถานี 22kV/115kV เชื่อมเรดาร์น้ำฝน Rain Alarm อัตโนมัติ และตรวจเตือนป้ายห้ามสับไฟ LOTO',
                    '   - ขั้นที่ 2: เรียก navigateAppScreen("scada_split") โชว์ผังวงจรไฟฟ้า SCADA อัจฉริยะคู่หน้าฟอร์ม คลิกสวิตช์ส่งรหัสเข้าฟอร์ม คำนวณจุดเกิดฟอลต์ และจำลองสับเปลี่ยนภาระโหลดได้ แล้วเรียก navigateAppScreen("close_scada_split") เมื่ออธิบายจบ',
                    '   - ขั้นที่ 3: เรียก navigateAppScreen("tab2_outage") อธิบายระบบรับแจ้งไฟฟ้าขัดข้อง คัดกรองข้อมูลลูกค้า แจ้งเตือนเลข CA ค้างจ่าย 12 หลัก แนะนำช่างที่อยู่ใกล้จุดเกิดเหตุที่สุดด้วย GPS สด และสร้างลิงก์ใบสับเปลี่ยนมิเตอร์ชำรุดอัตโนมัติ',
                    '   - ขั้นที่ 4: เรียก navigateAppScreen("pm_calendar_grid") และตามด้วย navigateAppScreen("pm_calendar_map") โชว์ปฏิทินและหมุดแผนงานบำรุงรักษา PM แนบรูปส่ง LINE วาดโซนเรดาร์แจ้งดับไฟประชาชน พร้อม AI อ่านป้ายชื่อหอพักและบริษัทในกรอบสีแดงเพื่อร่างโพสต์เพจ Facebook และ LINE อัตโนมัติ จากนั้นเรียก navigateAppScreen("close_pm_calendar")',
                    '   - ขั้นที่ 5: เรียก demoCalculate22kVFuse(160, 1, 1.5) เพื่อเปิดแท็บ 3 สาธิตคำนวณขนาดฟิวส์เมนแรงสูง 22kV ของหม้อแปลง 160 เควีเอ โชว์ผลลัพธ์จริงบนหน้าจอ',
                    '   - ขั้นที่ 6: เรียก navigateAppScreen("tab4_analytics") เปิดแท็บ 4 แดชบอร์ดกราฟสถิติ สรุปจำนวนข้อมูลจริงของสาขาจากผลลัพธ์ที่ได้ แล้วกล่าวปิดท้ายเปิดโอกาสให้ผู้ฟังซักถามเพิ่มเติมด้วยรอยยิ้มในน้ำเสียงค่ะ'
                ].join('\n')
                : 'คุณกำลังอยู่บนหน้าปฏิบัติงานช่างภาคสนาม (Page 2) สามารถเรียก navigateAppScreen เพื่อสลับดูรายการใบงานช่าง แผนที่ผังวงจร SCADA และปฏิทินแผนงาน PM พร้อมรายงานยอดงานค้างและงานกำลังเดินทางจากข้อมูลจริงได้ค่ะ',
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
                            description: 'รหัสหน้าจอที่ต้องการเปิด ได้แก่: tab1_fault, scada_split, close_scada_split, tab2_outage, pm_calendar_grid, pm_calendar_map, close_pm_calendar, tab3_fuse, tab4_analytics, tech_jobs_list, tech_scada_map'
                        }
                    },
                    required: ['target']
                }
            },
            {
                name: 'getLiveSystemStats',
                description: 'ดึงตัวเลขสถิติใบงานจริง กะปัจจุบัน สภาพอากาศ จำนวนหมุดอุปกรณ์ SCADA และแผนงาน PM ล่าสุดในระบบ',
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
                        gps: { type: 'STRING', description: 'ตัวเลขพิกัดละติจูด,ลองจิจูด หรือลิงก์ Google Maps เท่านั้น' },
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
                        cause: { type: 'STRING', description: 'สาเหตุทริป ได้แก่ T/R, T/L, Fault หรือ อื่นๆ' },
                        count: { type: 'STRING', description: 'จำนวนครั้ง เช่น 1, 2, 3' },
                        phase: { type: 'STRING', description: 'เฟสที่โชว์ เช่น A-G, B-G, C-G, A-B-C' },
                        device: { type: 'STRING', description: 'รหัสอุปกรณ์ที่เห็นฟอลต์' },
                        disconnectDevice: { type: 'STRING', description: 'รหัสอุปกรณ์ที่ปลด' },
                        reporter: { type: 'STRING', description: 'สาเหตุเบื้องต้นหรือผู้แจ้ง' }
                    }
                }
            }
        ];

        // โมเดลตระกูล extended-thinking บังคับตั้ง behavior: NON_BLOCKING ทุกฟังก์ชัน
        return requireNonBlocking
            ? baseTools.map(fn => ({ ...fn, behavior: 'NON_BLOCKING' }))
            : baseTools;
    }

    async function executeVoiceToolCall(name, args = {}) {
        const cleanVal = v => {
            const s = String(v ?? '').trim();
            return (!s || /^(?:-|none|null|undefined|n\/a|ไม่ระบุ|ไม่มี)$/i.test(s)) ? '' : s;
        };

        if (name === 'getLiveSystemStats') {
            setLiveActionSubtext('📊 กำลังอ่านข้อมูลสถิติจริงในระบบ...');
            return collectLiveSystemSnapshot();
        }

        if (name === 'navigateAppScreen') {
            const target = String(args.target || '').trim();
            const isMainPage = Boolean(document.getElementById('mainAppContent'));

            if (target === 'pm_calendar_grid') {
                setDockMinimized(true);
                setLiveActionSubtext('📅 เปิดตารางปฏิทินแผนงาน PM');
                window.openPmCalendarModal?.();
                await new Promise(r => setTimeout(r, 180));
                window.switchCalendarLeftViewMode?.('grid');
            } else if (target === 'pm_calendar_map') {
                setDockMinimized(true);
                setLiveActionSubtext('📡 เปิดแผนที่หมุด PM & โซนเรดาร์ประชาชน');
                if (document.getElementById('pmCalendarModal')?.classList.contains('hidden')) {
                    window.openPmCalendarModal?.();
                }
                await window.switchCalendarLeftViewMode?.('map');
            } else if (target === 'close_pm_calendar') {
                setLiveActionSubtext('✕ ปิดหน้าต่างปฏิทิน PM');
                window.closePmCalendarModal?.();
            } else if (!isMainPage) {
                window.closePmCalendarModal?.();
                if (target === 'tech_scada_map' || target === 'scada_split') {
                    setDockMinimized(true);
                    setLiveActionSubtext('⚡ สลับไปหน้าผังวงจร SCADA');
                    window.switchTechMainTab?.('map');
                } else {
                    setLiveActionSubtext('🛠️ สลับไปหน้ารายการใบงานช่าง');
                    window.switchTechMainTab?.('jobs');
                }
            } else {
                window.closePmCalendarModal?.();
                if (target === 'scada_split') {
                    setDockMinimized(true);
                    setLiveActionSubtext('⚡ เปิดผังวงจร SCADA คู่หน้าฟอร์ม');
                    window.switchTab?.('tab1');
                    window.openScadaDiagramWorkspace?.();
                } else if (target === 'close_scada_split') {
                    setLiveActionSubtext('✕ ปิดหน้าต่างผัง SCADA ฝั่งซ้าย');
                    window.closeLeftWebBrowser?.();
                } else {
                    if (window.innerWidth < 1024) window.closeLeftWebBrowser?.();
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
            window.closePmCalendarModal?.();
            if (window.innerWidth < 1024) window.closeLeftWebBrowser?.();
            window.switchTab?.('tab3');
            const allowedKva = [30, 50, 75, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500];
            const reqKva = Number(args.kva) || 160;
            const nearestKva = allowedKva.reduce((prev, curr) => Math.abs(curr - reqKva) < Math.abs(prev - reqKva) ? curr : prev, 160);
            const qty = Math.max(1, Math.round(Number(args.qty) || 1));
            const mult = Math.max(1, Number(args.multiplier) || 1.5);

            // ล้างแถวหม้อแปลงส่วนเกินออกก่อนสาธิต เพื่อให้ค่า kVA ตรงกับที่พูดบรรยาย
            const rows = document.querySelectorAll('#transformer-list > .flex');
            rows.forEach((row, idx) => { if (idx > 0) row.remove(); });

            const sel = document.querySelector('#transformer-list select.tx-input');
            const qtyInp = document.querySelector('#transformer-list input.tx-qty');
            const multInp = document.getElementById('multiplier-input');
            if (sel) sel.value = String(nearestKva);
            if (qtyInp) qtyInp.value = String(qty);
            if (multInp) multInp.value = String(mult);
            window.calculateFuseCalc?.();
            setLiveActionSubtext(`🧮 คำนวณฟิวส์หม้อแปลง ${nearestKva} kVA x ${qty} ลูก`);

            const inrushSpan = document.querySelector('#res-inrush-label span');
            return {
                ok: true,
                transformerKva: nearestKva,
                quantity: qty,
                multiplier: mult,
                totalKvaText: (document.getElementById('res-kva')?.textContent || '').trim(),
                ratedAmpText: (document.getElementById('res-amp')?.textContent || '').trim(),
                inrushAmpText: (inrushSpan?.textContent || document.getElementById('res-inrush')?.textContent || '').trim(),
                recommendedFuseTypeK: (document.getElementById('res-fuse')?.textContent || '').replace(/\s+/g, ' ').trim()
            };
        }

        if (name === 'fillOutageReportByVoice') {
            if (isViewer()) return { ok: false, error: 'บัญชีผู้สำรวจไม่สามารถกรอกแก้ไขข้อมูลได้ค่ะ' };
            if (!document.getElementById('sortable-tab2')) return { ok: false, error: 'กรุณาเปิดหน้าหลัก (index.html) เพื่อกรอกฟอร์มรับแจ้งค่ะ' };
            window.closePmCalendarModal?.();
            window.switchTab?.('tab2');

            let filledCount = 0;
            [['issueType', args.issueType], ['workerName', args.workerName], ['area', args.area], ['phone', args.phone]].forEach(([id, raw]) => {
                const val = cleanVal(raw);
                const el = document.getElementById(id);
                if (val && el) { el.value = val; filledCount++; }
            });

            const addr = cleanVal(args.address);
            const ca = cleanVal(args.caNo).replace(/\D/g, '');
            const pea = cleanVal(args.peaNo);
            if (addr || ca || pea) {
                const addrEl = document.getElementById('address');
                if (addrEl) {
                    const base = addr || String(addrEl.value || '').trim();
                    const parts = base ? [base] : [];
                    if (ca && !parts.join(' ').includes(ca)) parts.push(`CA : ${ca}`);
                    if (pea && !parts.join(' ').includes(pea)) parts.push(`มิเตอร์ - PEA No. : ${pea}`);
                    addrEl.value = parts.join('\n');
                    addrEl.style.height = 'auto';
                    addrEl.style.height = addrEl.scrollHeight + 'px';
                    addrEl.dispatchEvent(new Event('input', { bubbles: true }));
                    filledCount++;
                }
            }

            const gps = cleanVal(args.gps);
            if (gps) {
                const gpsEl = document.getElementById('gps');
                if (gpsEl) { gpsEl.value = gps; gpsEl.dispatchEvent(new Event('input', { bubbles: true })); filledCount++; }
            }

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
            window.switchTab?.('tab1');

            const sys = cleanVal(args.system);
            if (sys && (sys.includes('115') || sys.includes('22'))) {
                const sysEl = document.getElementById('systemSelect');
                if (sysEl) { sysEl.value = sys.includes('115') ? '115kV' : '22kV'; window.updateCircuitDropdown?.(); }
            }
            const cir = cleanVal(args.circuit).toUpperCase();
            if (cir && document.getElementById('circuitSelect')) document.getElementById('circuitSelect').value = cir;
            const st = cleanVal(args.station);
            if (st) window.selectStation?.(st);

            [['causeSelect', args.cause], ['countSelect', args.count], ['phaseSelect', args.phase], ['deviceInput', args.device], ['disconnectDeviceInput', args.disconnectDevice], ['reporterInput', args.reporter]].forEach(([id, raw]) => {
                const val = cleanVal(raw);
                const el = document.getElementById(id);
                if (val && el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
            });
            window.saveFaultDraft?.();
            setLiveActionSubtext('⚡ กรอกฟอร์มรายงานเหตุสถานี (TR/TL) เรียบร้อย');
            return { ok: true };
        }

        return { ok: false, error: 'ไม่รู้จักคำสั่งนี้' };
    }

    // ========================================================================
    // 4. ระบบประมวลผลเสียง PCM 16kHz (พร้อม Echo Gate & audioStreamEnd) และเล่นเสียง 24kHz
    // ========================================================================
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
        const bin = atob(String(b64Str || '').replace(/\s+/g, ''));
        const byteLen = bin.length - (bin.length % 2);
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
        if (!liveWs || liveWs.readyState !== WebSocket.OPEN) return;
        const payload = isLegacy20LiveModel(activeConnectedModel)
            ? { realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: b64Pcm }] } }
            : { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: b64Pcm } } };
        try { liveWs.send(JSON.stringify(payload)); } catch (e) {}
    }

    // แจ้งเซิร์ฟเวอร์ด้วยสัญญาณมาตรฐาน audioStreamEnd ทันทีที่กดปิดไมค์ เพื่อไม่ให้ VAD ค้างรอเสียง
    function flushMicStreamOnMute() {
        if (!isLiveConnected || !liveWs || liveWs.readyState !== WebSocket.OPEN) return;
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

    function checkAndFinalizeAiSpeechTurn() {
        if (activePlaybackSources.size > 0 || isServerTurnGenerating) return;
        isAiSpeakingNow = false;
        if (pendingGoAwayReconnect && isUserSessionActive && !isReconnecting) {
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
        if (outputAudioCtx.state === 'suspended') outputAudioCtx.resume().catch(() => {});

        const float32 = base64ToFloat32Pcm(b64Data);
        if (!float32.length) return;

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

        src.onended = () => {
            activePlaybackSources.delete(src);
            checkAndFinalizeAiSpeechTurn();
        };
    }

    function stopAllAiPlaybackImmediately() {
        activePlaybackSources.forEach(src => {
            try { src.stop(0); src.disconnect(); } catch (e) {}
        });
        activePlaybackSources.clear();
        nextPlayTimeSec = 0;
        isAiSpeakingNow = false;
        isServerTurnGenerating = false;
    }

    async function ensureMicrophoneStreamingActive() {
        if (micStream && micStream.active && inputAudioCtx && inputAudioCtx.state !== 'closed') {
            if (inputAudioCtx.state === 'suspended') await inputAudioCtx.resume().catch(() => {});
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('เบราว์เซอร์ไม่รองรับการเปิดไมโครโฟน (ต้องเปิดผ่าน HTTPS)');
        }
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: 16000,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        inputAudioCtx = new AudioCtx();
        if (inputAudioCtx.state === 'suspended') await inputAudioCtx.resume();

        const actualRate = inputAudioCtx.sampleRate || 48000;
        micSourceNode = inputAudioCtx.createMediaStreamSource(micStream);

        let pcmAccum = [];
        const TARGET_CHUNK_SAMPLES = 1600;

        const handleRawFloatChunk = (floatChunk) => {
            if (!isUserSessionActive || isMicMuted || (!isLiveConnected && !isReconnecting)) {
                pcmAccum.length = 0; // ล้างเศษเสียงค้างทันทีที่ปิดไมค์ ไม่ให้หลุดออกไปตอนเปิดไมค์รอบถัดไป
                currentMicLevel = 0;
                return;
            }

            let sumSq = 0;
            for (let i = 0; i < floatChunk.length; i += 4) sumSq += floatChunk[i] * floatChunk[i];
            const rms = Math.sqrt(sumSq / Math.max(1, floatChunk.length / 4));
            currentMicLevel = Math.min(1, rms * 5.5);

            let suppressSpeakerEcho = false;
            if (isAiSpeakingNow) {
                if (rms >= SPEAKER_ECHO_GATE_RMS) {
                    bargeInHoldUntilMs = Date.now() + 450;
                } else if (Date.now() > bargeInHoldUntilMs) {
                    suppressSpeakerEcho = true;
                    currentMicLevel = 0;
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
                if (isLiveConnected && liveWs && liveWs.readyState === WebSocket.OPEN) {
                    sendPcmBase64ToActiveSocket(b64);
                } else if (isReconnecting) {
                    if (handoverAudioRingBuffer.length >= 15) handoverAudioRingBuffer.shift();
                    handoverAudioRingBuffer.push(b64);
                }
            }
        };

        let workletReady = false;
        if (inputAudioCtx.audioWorklet) {
            try {
                const workletCode = `
                    class PeaMicCaptureProcessor extends AudioWorkletProcessor {
                        process(inputs) {
                            const ch = inputs[0] && inputs[0][0];
                            if (ch && ch.length) this.port.postMessage(ch);
                            return true;
                        }
                    }
                    registerProcessor('pea-mic-capture', PeaMicCaptureProcessor);
                `;
                const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
                await inputAudioCtx.audioWorklet.addModule(blobUrl);
                URL.revokeObjectURL(blobUrl);
                const wNode = new AudioWorkletNode(inputAudioCtx, 'pea-mic-capture');
                wNode.port.onmessage = ev => { if (ev.data) handleRawFloatChunk(ev.data); };
                micSourceNode.connect(wNode);
                micProcessorNode = wNode;
                workletReady = true;
            } catch (e) { workletReady = false; }
        }

        if (!workletReady) {
            const spNode = inputAudioCtx.createScriptProcessor(4096, 1, 1);
            const muteGain = inputAudioCtx.createGain();
            muteGain.gain.value = 0;
            spNode.onaudioprocess = ev => { handleRawFloatChunk(ev.inputBuffer.getChannelData(0)); };
            micSourceNode.connect(spNode);
            spNode.connect(muteGain);
            muteGain.connect(inputAudioCtx.destination);
            micProcessorNode = spNode;
        }
    }

    // ========================================================================
    // 5. WebSocket + Context Window Compression + Session Resumption & Auto-Reconnect
    // ========================================================================
    function sendTextCueToLiveSession(promptText) {
        if (!isLiveConnected || !liveWs || liveWs.readyState !== WebSocket.OPEN) return;
        stopAllAiPlaybackImmediately();
        // ใช้ clientContent + turnComplete: true สำหรับ 3.8 Live และ 2.5 เพื่อตัดจังหวะเสียงเก่าบนเซิร์ฟเวอร์ทันที
        if (isPreview31LiveModel(activeConnectedModel)) {
            liveWs.send(JSON.stringify({ realtimeInput: { text: promptText } }));
        } else {
            liveWs.send(JSON.stringify({
                clientContent: {
                    turns: [{ role: 'user', parts: [{ text: promptText }] }],
                    turnComplete: true
                }
            }));
        }
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

        return new Promise((resolve, reject) => {
            const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;
            let settled = false;
            const cancelledToolCallIds = new Set();
            const ws = new WebSocket(wsUrl);

            const handshakeTimer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try { ws.close(1000, 'handshake_timeout'); } catch (e) {}
                    reject(new Error('หมดเวลาเชื่อมต่อโมเดล ' + modelName));
                }
            }, 8000);

            ws.onopen = () => {
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

                ws.send(JSON.stringify({ setup: setupPayload }));
            };

            ws.onmessage = async (event) => {
                let rawText = '';
                try {
                    rawText = event.data instanceof Blob ? await event.data.text() : String(event.data || '');
                } catch (e) { return; }
                if (!rawText) return;

                let msg = null;
                try { msg = JSON.parse(rawText); } catch (e) { return; }
                if (!msg) return;

                if (msg.setupComplete !== undefined && !settled) {
                    settled = true;
                    isServerTurnGenerating = false;
                    clearTimeout(handshakeTimer);
                    resolve(ws);
                    return;
                }

                const resUpd = msg.sessionResumptionUpdate || msg.session_resumption_update;
                if (resUpd && resUpd.resumable !== false) {
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
                if (goAway && ws === liveWs && isUserSessionActive && !isReconnecting) {
                    const secLeft = parseDurationSeconds(goAway.timeLeft || goAway.time_left);
                    if ((!isAiSpeakingNow && !isServerTurnGenerating) || secLeft <= 2.0) {
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

                if (msg.serverContent) {
                    const interStatus = msg.serverContent.interactionStatus || msg.serverContent.interaction_status || '';
                    if (msg.serverContent.interrupted) {
                        stopAllAiPlaybackImmediately();
                        checkAndFinalizeAiSpeechTurn();
                    } else {
                        const parts = msg.serverContent.modelTurn?.parts || [];
                        if (parts.length > 0 || interStatus === 'IN_PROGRESS') {
                            isServerTurnGenerating = true;
                        }
                        parts.forEach(pt => {
                            if (pt?.inlineData?.data && String(pt.inlineData.mimeType || '').includes('audio/pcm')) {
                                const rateMatch = String(pt.inlineData.mimeType).match(/rate=(\d+)/i);
                                const rate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
                                enqueuePcmPlayback(pt.inlineData.data, rate);
                            }
                        });

                        if (interStatus === 'IDLE' || (!useExtendedThinking && msg.serverContent.turnComplete) || (useExtendedThinking && msg.serverContent.turnComplete && !interStatus)) {
                            isServerTurnGenerating = false;
                            checkAndFinalizeAiSpeechTurn();
                        }
                    }
                }

                if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
                    const functionResponses = [];
                    for (const fc of msg.toolCall.functionCalls) {
                        if (cancelledToolCallIds.has(fc.id) || ws !== liveWs) continue;
                        let resObj = {};
                        try {
                            resObj = await executeVoiceToolCall(fc.name, fc.args || {});
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
                    if (ws === liveWs && ws.readyState === WebSocket.OPEN && functionResponses.length > 0) {
                        ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
                    }
                }
            };

            ws.onerror = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(handshakeTimer);
                    reject(new Error('เชื่อมต่อโมเดล ' + modelName + ' ไม่สำเร็จ'));
                }
            };

            ws.onclose = (ev) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(handshakeTimer);
                    const reason = String(ev?.reason || '');
                    const err = new Error(reason || `WebSocket ปิดการเชื่อมต่อ (${ev?.code || 0})`);
                    if (/API_KEY_INVALID|API key not valid|key expired/i.test(reason)) err.isInvalidKey = true;
                    if (/quota|429|RESOURCE_EXHAUSTED/i.test(reason)) err.isQuota = true;
                    if (ev?.code === 1008 || /not found|not supported for bidi/i.test(reason)) err.isModelNotFound = true;
                    reject(err);
                    return;
                }
                if (liveWs === ws) {
                    isLiveConnected = false;
                    isServerTurnGenerating = false;
                    liveWs = null;
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
            if (err1?.isInvalidKey || err1?.isQuota || err1?.isModelNotFound) throw err1;

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
                    if (err2?.isInvalidKey || err2?.isQuota || err2?.isModelNotFound) throw err2;
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
            try {
                const { ws, resumedFromHandle } = await connectModelWithResumptionFallback(apiKey, mName);
                activeConnectedModel = mName;
                return { ws, modelName: mName, resumedFromHandle };
            } catch (err) {
                lastErr = err;
                if (err?.isInvalidKey) throw err;
                if (!err?.isQuota) unsupportedLiveModels.add(`${keyTag}:${mName}`);
            }
        }
        throw lastErr || new Error('ไม่พบโมเดลเสียงสดที่พร้อมใช้งานในขณะนี้');
    }

    async function performSeamlessSessionReconnect(reason = 'auto') {
        if (!isUserSessionActive || isReconnecting) return;
        isReconnecting = true;
        pendingGoAwayReconnect = false;
        isServerTurnGenerating = false;
        if (goAwaySwapTimer) { clearTimeout(goAwaySwapTimer); goAwaySwapTimer = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

        const prevWs = liveWs;
        liveWs = null;
        isLiveConnected = false;
        if (prevWs) {
            try { prevWs.close(1000, 'seamless_swap'); } catch (e) {}
        }

        const apiKey = getGroupApiKey();
        if (!apiKey) {
            isReconnecting = false;
            stopPeaLiveVoiceSession(true);
            return;
        }

        const attemptLoop = async () => {
            if (!isUserSessionActive) { isReconnecting = false; return; }
            reconnectAttemptCount++;
            updateLiveDockStatusUI(`🔄 กำลังต่อสายอัตโนมัติ (จำบทสนทนาเดิม #${reconnectAttemptCount})...`, 'connecting');

            if (!navigator.onLine) {
                if (reconnectAttemptCount <= MAX_AUTO_RECONNECT_ATTEMPTS) {
                    reconnectTimer = setTimeout(attemptLoop, 2500);
                } else {
                    isReconnecting = false;
                    stopPeaLiveVoiceSession(false);
                    safeToast('⚠️ อินเทอร์เน็ตขาดหายชั่วคราว แตะปุ่มคุยสดเพื่อเชื่อมต่อไปยังบทสนทนาเดิมได้ค่ะ');
                }
                return;
            }

            try {
                await ensureMicrophoneStreamingActive();
                const { ws, resumedFromHandle } = await establishBestLiveConnection(apiKey);
                if (!isUserSessionActive) {
                    try { ws.close(1000, 'session_ended'); } catch (e) {}
                    isReconnecting = false;
                    return;
                }
                liveWs = ws;
                isLiveConnected = true;
                isReconnecting = false;
                reconnectAttemptCount = 0;
                seamlessRenewCount++;
                flushHandoverAudioBuffer();
                updateHeaderLiveButtonsUI();
                updateMemoryBadgeUI();
                updateLiveDockStatusUI(
                    isMicMuted ? '🔇 ต่อสายใหม่สำเร็จ (ไมค์ปิดอยู่)' : '🟢 ต่อสายต่อเนื่องสำเร็จ พูดคุยต่อได้เลยค่ะ...',
                    'listening'
                );
                setLiveActionSubtext(
                    resumedFromHandle
                        ? `♾️ เชื่อมต่อความจำเดิมต่อเนื่องอัตโนมัติ (รอบที่ ${seamlessRenewCount + 1})`
                        : `🔄 เปิดช่องสัญญาณเสียงใหม่เรียบร้อย (${reason})`
                );
            } catch (err) {
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
                    safeToast('⚠️ สัญญาณเสียงขาดช่วง แตะปุ่มคุยสดเพื่อกลับมาคุยต่อจากเดิมได้เลยค่ะ (จำข้อมูลไว้ 2 ชม.)');
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
        if (isLiveConnecting || isReconnecting) {
            setDockMinimized(false);
            document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden');
            return;
        }
        if (isLiveConnected) {
            setDockMinimized(false);
            document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden');
            if (autoPresentSystem) triggerAutoPresentationCue();
            return;
        }

        const apiKey = getGroupApiKey();
        if (!apiKey) {
            safeToast(`🔑 กรุณาตั้งค่า API Key ประจำกลุ่ม "${getActiveVoiceGroup()}" ก่อนเริ่มคุยสดค่ะ`);
            openKeySetupModalFallback();
            return;
        }

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!outputAudioCtx || outputAudioCtx.state === 'closed') {
            try { outputAudioCtx = new AudioCtx({ sampleRate: 24000 }); }
            catch (e) { outputAudioCtx = new AudioCtx(); }
        }
        if (outputAudioCtx.state === 'suspended') outputAudioCtx.resume().catch(() => {});

        isLiveConnecting = true;
        isUserSessionActive = true;
        isMicMuted = false;
        reconnectAttemptCount = 0;
        seamlessRenewCount = 0;
        handoverAudioRingBuffer.length = 0;

        setDockMinimized(false);
        injectLiveVoiceUI();
        document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden');
        const muteBtn = document.getElementById('peaLiveMuteBtn');
        if (muteBtn) {
            muteBtn.textContent = '🎙️ ไมค์: เปิดรับฟัง';
            muteBtn.className = 'flex-1 py-2 px-2 rounded-xl bg-white/15 hover:bg-white/25 text-white font-bold text-[11px] border border-white/20 transition';
        }
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
            const { ws, resumedFromHandle } = await establishBestLiveConnection(apiKey);

            liveWs = ws;
            isLiveConnected = true;
            isLiveConnecting = false;
            startVisualizerLoop();
            updateHeaderLiveButtonsUI();
            updateMemoryBadgeUI();
            updateLiveDockStatusUI('🟢 เชื่อมต่อสำเร็จ กำลังรับฟังค่ะ...', 'listening');

            if (autoPresentSystem) {
                triggerAutoPresentationCue();
            } else if (resumedFromHandle) {
                setLiveActionSubtext('♾️ กู้คืนความจำบทสนทนาเดิมสำเร็จ คุยต่อจากเรื่องเดิมได้เลยค่ะ');
                safeToast('🌸 เชื่อมต่อพร้อมความจำบทสนทนาเดิมเรียบร้อยค่ะ');
            } else {
                setLiveActionSubtext('💡 พูดคุยสั่งงานได้เลย หรือกดปุ่มลัดด้านล่างเพื่อให้แนะนำระบบค่ะ');
                sendTextCueToLiveSession('กล่าวทักทายสั้นๆ 1 ประโยคอย่างนุ่มนวลว่าพร้อมเป็นผู้ช่วยรับแจ้งเหตุและแนะนำระบบแล้วค่ะ');
            }
        } catch (err) {
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
        isUserSessionActive = false;
        isLiveConnected = false;
        isLiveConnecting = false;
        isReconnecting = false;
        pendingGoAwayReconnect = false;
        isServerTurnGenerating = false;
        isMicMuted = false;
        currentMicLevel = 0;
        handoverAudioRingBuffer.length = 0;

        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (goAwaySwapTimer) { clearTimeout(goAwaySwapTimer); goAwaySwapTimer = null; }
        stopAllAiPlaybackImmediately();

        if (visualizerAnimId) {
            cancelAnimationFrame(visualizerAnimId);
            visualizerAnimId = null;
        }
        if (liveWs) {
            const ws = liveWs;
            liveWs = null;
            try { ws.close(1000, 'client_hangup'); } catch (e) {}
        }
        if (micProcessorNode) {
            try { micProcessorNode.disconnect(); } catch (e) {}
            micProcessorNode = null;
        }
        if (micSourceNode) {
            try { micSourceNode.disconnect(); } catch (e) {}
            micSourceNode = null;
        }
        if (micStream) {
            micStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
            micStream = null;
        }
        if (inputAudioCtx && inputAudioCtx.state !== 'closed') {
            inputAudioCtx.close().catch(() => {});
            inputAudioCtx = null;
        }
        if (outputAudioCtx && outputAudioCtx.state !== 'closed') {
            outputAudioCtx.close().catch(() => {});
            outputAudioCtx = null;
        }
        if (hideDock) {
            document.getElementById('peaLiveVoiceDock')?.classList.add('hidden');
        } else {
            updateLiveDockStatusUI('⚪ พักสายชั่วคราว (จำบทสนทนาไว้ 2 ชม.)', 'idle');
        }
        updateHeaderLiveButtonsUI();
        updateMemoryBadgeUI();
    }

    function resetPeaLiveVoiceMemory() {
        clearResumptionHandleState();
        seamlessRenewCount = 0;
        if (isLiveConnected || isReconnecting) {
            safeToast('♻️ ล้างความจำเดิมและกำลังเริ่มสายสนทนาใหม่...');
            stopPeaLiveVoiceSession(false);
            setTimeout(() => startPeaLiveVoiceSession(false), 300);
        } else {
            safeToast('♻️ ล้างความจำบทสนทนาเดิมเรียบร้อยแล้วค่ะ');
        }
    }

    function togglePeaLiveMicMute() {
        if (!isLiveConnected && !isReconnecting) return;
        isMicMuted = !isMicMuted;
        if (isMicMuted) {
            flushMicStreamOnMute();
        }
        const btn = document.getElementById('peaLiveMuteBtn');
        if (btn) {
            btn.textContent = isMicMuted ? '🔇 ไมค์: ปิดกันเสียงแทรก' : '🎙️ ไมค์: เปิดรับฟัง';
            btn.className = isMicMuted
                ? 'flex-1 py-2 px-2 rounded-xl bg-amber-400 text-slate-950 font-extrabold text-[11px] shadow transition'
                : 'flex-1 py-2 px-2 rounded-xl bg-white/15 hover:bg-white/25 text-white font-bold text-[11px] border border-white/20 transition';
        }
        if (!isAiSpeakingNow && isLiveConnected) {
            updateLiveDockStatusUI(isMicMuted ? '🔇 ปิดไมค์ชั่วคราว (กันเสียงลำโพงสะท้อน)' : '🟢 กำลังรับฟังค่ะ พูดคุยได้เลย...', 'listening');
        }
    }

    async function onSelectFemaleVoiceProfile(newVoice) {
        if (!FEMALE_VOICE_PROFILES[newVoice]) return;
        selectedFemaleVoice = newVoice;
        localStorage.setItem(VOICE_PREF_STORAGE_KEY, newVoice);
        clearResumptionHandleState();
        if (isLiveConnected || isReconnecting) {
            safeToast(`🌸 สลับเป็นเสียง "${FEMALE_VOICE_PROFILES[newVoice].label}" กำลังเชื่อมต่อเสียงใหม่...`);
            stopPeaLiveVoiceSession(false);
            setTimeout(() => startPeaLiveVoiceSession(false), 300);
        }
    }

    function triggerAutoPresentationCue() {
        if (!isLiveConnected) {
            startPeaLiveVoiceSession(true);
            return;
        }
        setDockMinimized(true);
        setLiveActionSubtext('🎬 เริ่มโหมดวิทยากรนำเสนอระบบอัตโนมัติ...');
        sendTextCueToLiveSession(
            'เริ่มทำหน้าที่วิทยากรประชาสัมพันธ์แนะนำระบบเครื่องมือจัดการงานไฟฟ้า (PEA Smart Grid) ให้ผู้บริหารและทีมงานฟังได้เลยค่ะ โดยเรียกใช้เครื่องมือเปิดหน้าจอจริงโชว์ทีละส่วนตามลำดับพร้อมอธิบายจุดเด่นอย่างนุ่มนวลชัดเจน และดึงตัวเลขจริงของสาขามาประกอบการบรรยายด้วยค่ะ'
        );
    }

    function triggerSpecificTopicDemo(topicCode) {
        if (!isLiveConnected) return;
        const prompts = {
            scada: 'ช่วยเปิดหน้าผังวงจร SCADA คู่หน้าฟอร์ม แล้วอธิบายจุดเด่นของระบบผังวงจรไฟฟ้า การตรวจเตือนป้าย LOTO และการชี้เป้าฟอลต์ให้ฟังหน่อยค่ะ',
            pm: 'ช่วยเปิดหน้าปฏิทินและแผนที่หมุดแผนงาน PM โชว์โซนเรดาร์แจ้งดับไฟประชาชนและการใช้ AI อ่านป้ายชื่อสถานที่สร้างโพสต์ Facebook/LINE ให้ฟังหน่อยค่ะ',
            dispatch: 'สลับมาหน้าฟอร์มรับแจ้งไฟฟ้าขัดข้อง แท็บ 2 แล้วเตรียมพร้อมช่วยรับแจ้งเหตุและกรอกฟอร์มตามที่ฉันกำลังจะพูดแจ้งต่อไปนี้ค่ะ'
        };
        if (prompts[topicCode]) sendTextCueToLiveSession(prompts[topicCode]);
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
        if (hasHandle) {
            badge.textContent = seamlessRenewCount > 0
                ? `♾️ คุยต่อเนื่องไม่จำกัดเวลา • ต่อสายอัตโนมัติแล้ว ${seamlessRenewCount} ครั้ง`
                : '♾️ คุยต่อเนื่องไม่จำกัดเวลา • บันทึกความจำอัตโนมัติ (2 ชม.)';
            badge.className = 'text-[10px] font-bold text-emerald-300 flex items-center justify-between gap-1 px-1';
        } else {
            badge.textContent = '♾️ โหมดบีบอัดความจำอัตโนมัติ (คุยยาวเกิน 15 นาทีได้ไม่ตัดสาย)';
            badge.className = 'text-[10px] font-semibold text-slate-400 flex items-center justify-between gap-1 px-1';
        }
    }

    function updateLiveDockStatusUI(statusTxt, mode = 'listening') {
        const txtEl = document.getElementById('peaLiveStatusText');
        const dotEl = document.getElementById('peaLiveStatusDot');
        if (txtEl) txtEl.textContent = statusTxt;
        if (dotEl) {
            dotEl.className = mode === 'speaking'
                ? 'w-2.5 h-2.5 rounded-full bg-pink-400 animate-ping shrink-0'
                : (mode === 'connecting' ? 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0'
                : (mode === 'idle' ? 'w-2.5 h-2.5 rounded-full bg-slate-400 shrink-0' : 'w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0'));
        }
    }

    function setLiveActionSubtext(subTxt) {
        const el = document.getElementById('peaLiveActionSubtext');
        if (el) el.textContent = subTxt;
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
        const activeSession = isLiveConnected || isReconnecting;
        const activeCls = 'bg-gradient-to-r from-pink-600 to-rose-500 text-white px-2.5 py-1.5 rounded-xl text-xs font-extrabold shadow-md flex items-center gap-1 border border-pink-200 animate-pulse';
        const idleMainCls = 'bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-500 hover:to-pink-500 text-white px-2.5 py-1.5 rounded-xl text-xs transition shadow-sm flex items-center gap-1 font-semibold border border-pink-300/40';

        ['peaMainHeaderLiveBtn', 'peaTechHeaderLiveBtn'].forEach(id => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.className = activeSession ? activeCls : idleMainCls;
            btn.innerHTML = activeSession ? '🌸 <span>กำลังคุยสด</span>' : '🎙️ <span>AI พูดสด</span>';
        });

        const chatBtn = document.getElementById('peaChatbotLiveVoiceBtn');
        if (chatBtn) {
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
            btn.onclick = () => (isLiveConnected || isReconnecting) ? (setDockMinimized(false), document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden')) : startPeaLiveVoiceSession(false);
            const pmBtn = document.getElementById('pmMainHeaderBtn') || mainHdr.querySelector('button[onclick="openBackupModal()"]');
            if (pmBtn) mainHdr.insertBefore(btn, pmBtn); else mainHdr.appendChild(btn);
        }

        const techHdr = document.querySelector('#techMainApp .bg-gradient-to-r .flex.flex-wrap.items-center.gap-1\\.5');
        if (techHdr && !document.getElementById('peaTechHeaderLiveBtn')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'peaTechHeaderLiveBtn';
            btn.onclick = () => (isLiveConnected || isReconnecting) ? (setDockMinimized(false), document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden')) : startPeaLiveVoiceSession(false);
            techHdr.insertBefore(btn, techHdr.firstChild);
        }

        // สร้างกล่อง div ครอบปุ่มบนหัวแชทก่อนแทรกเสมอ ป้องกันบั๊กปุ่มซ้อนในปุ่มตอนก่อนล็อกอิน
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
                liveBtn.onclick = () => (isLiveConnected || isReconnecting)
                    ? (setDockMinimized(false), document.getElementById('peaLiveVoiceDock')?.classList.remove('hidden'))
                    : startPeaLiveVoiceSession(false);
                btnWrap.insertBefore(liveBtn, btnWrap.firstChild);
            }
        }

        if (!document.getElementById('peaLiveVoiceDock')) {
            const voiceOpts = Object.values(FEMALE_VOICE_PROFILES).map(v =>
                `<option value="${v.id}" ${v.id === selectedFemaleVoice ? 'selected' : ''}>${safeEsc(v.label)}</option>`
            ).join('');

            document.body.insertAdjacentHTML('beforeend', `
                <div id="peaLiveVoiceDock" class="hidden fixed bottom-3 right-3 left-3 sm:left-auto sm:w-[375px] z-[1470] rounded-3xl overflow-hidden shadow-2xl border-2 border-pink-400/80 bg-slate-950/95 text-white backdrop-blur-md transition-all">
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
                            <button type="button" onclick="triggerSpecificTopicDemo('scada')" class="py-1.5 px-2 rounded-xl bg-teal-600/80 hover:bg-teal-600 text-white font-bold text-[11px] border border-teal-400/40">⚡ สาธิตผัง SCADA</button>
                            <button type="button" onclick="triggerSpecificTopicDemo('pm')" class="py-1.5 px-2 rounded-xl bg-indigo-600/80 hover:bg-indigo-600 text-white font-bold text-[11px] border border-indigo-400/40">📅 สาธิตแผน PM/เรดาร์</button>
                        </div>
                        <div class="flex items-center gap-1.5 pt-1 border-t border-white/10">
                            <button type="button" id="peaLiveMuteBtn" onclick="togglePeaLiveMicMute()" class="flex-1 py-2 px-2 rounded-xl bg-white/15 hover:bg-white/25 text-white font-bold text-[11px] border border-white/20 transition">🎙️ ไมค์: เปิดรับฟัง</button>
                            <button type="button" onclick="resetPeaLiveVoiceMemory()" title="ล้างความจำบทสนทนาเดิมเพื่อเริ่มหัวข้อใหม่" class="py-2 px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-400/30 text-[11px] font-bold shrink-0">♻️ เริ่มใหม่</button>
                            <select onchange="onSelectFemaleVoiceProfile(this.value)" title="เลือกโทนเสียงผู้หญิง" class="py-2 px-1.5 rounded-xl bg-slate-900 text-pink-200 border border-pink-400/40 text-[11px] font-bold focus:outline-none max-w-[125px]">${voiceOpts}</select>
                        </div>
                    </div>
                </div>
            `);
        }
        updateHeaderLiveButtonsUI();
        updateMemoryBadgeUI();
    }

    function togglePeaLiveDockMinimize() {
        setDockMinimized(!isDockMinimized);
    }

    ['pagehide', 'beforeunload'].forEach(evName => {
        window.addEventListener(evName, () => {
            if (isUserSessionActive || liveWs) stopPeaLiveVoiceSession(true);
        });
    });

    window.addEventListener('online', () => {
        if (isUserSessionActive && !isLiveConnected && !isLiveConnecting) {
            reconnectAttemptCount = 0;
            performSeamlessSessionReconnect('network_online');
        }
    });

    let prevLogged = isLoggedIn();
    let prevGroup = getActiveVoiceGroup();
    setInterval(() => {
        injectLiveVoiceUI();
        const curLogged = isLoggedIn();
        const curGrp = getActiveVoiceGroup();
        if (!curLogged && prevLogged) {
            clearResumptionHandleState(prevGroup);
            stopPeaLiveVoiceSession(true);
        } else if ((isLiveConnected || isReconnecting) && curGrp !== prevGroup) {
            stopPeaLiveVoiceSession(true);
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
// ==================== จบไฟล์ pea-live-voice.js (v1.3) ====================