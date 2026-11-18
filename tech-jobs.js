// ============================================================================
// 🛠️⚡ PEA SMART GRID — TECH WORKFORCE & REPAIR JOBS ENGINE v6.5 (tech-jobs.js)
// ระบบจัดการใบงานซ่อม นำทางเรียลไทม์ สั่งปิดงานด้วยเสียง และส่งค่าเข้าใบมิเตอร์อัตโนมัติ (page2.html)
// พาทที่ 1 / 2 : Global State, Meter Form Bridge, Auth, Sound, GPS, Nav & Cloud Merge
// ============================================================================
(function () {
    'use strict';

    const Core = window.PeaCore;
    const VIEWER_LOCK_MSG = '🔒 สิทธิ์ผู้สำรวจ: ดูข้อมูลอย่างเดียว ไม่สามารถเพิ่ม แก้ไข หรือลบข้อมูลได้';
    const LEGACY_GOOGLE_METER_LINK = 'https://docs.google.com/forms/d/e/1FAIpQLSfBsBdIcZRKR5N9I4rCuBLEhIIWIuKCsiUbsa83DmKnNUPZZQ/viewform?pli=1&pli=1';
    const SHORT_URL_COORD_CACHE_KEY = 'elec_job_shortlink_coords_cache_v1';
    const SHORTLINK_MASTER_CACHE_KEY = 'elec_resolved_shortlinks_cache_v2';
    const EQUIP_NAV_STORAGE_KEY = 'elec_active_equip_nav_map_v2';
    const CANCELLED_JOB_NAV_KEY = 'elec_cancelled_job_nav_map';
    const CANCELLED_EQUIP_NAV_KEY = 'elec_cancelled_equip_nav_map';
    const PM_LOC_PREFIX = '__PM_SCHEDULE__';
    const MAX_CANCEL_NAV_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const MAX_EQUIP_NAV_AGE_MS = 6 * 60 * 60 * 1000;

    const EXTENDED_AREA_COORDS = {
        'บึง': { lat: 13.1361, lon: 101.0322 }, 'บ่อวิน': { lat: 13.0645, lon: 101.1611 },
        'เขาคันทรง': { lat: 13.1165, lon: 101.2144 }, 'หนองขาม': { lat: 13.1189, lon: 100.9856 },
        'สุรศักดิ์': { lat: 13.1592, lon: 100.9581 }, 'ศรีราชา': { lat: 13.1737, lon: 100.9311 },
        'แหลมฉบัง': { lat: 13.0825, lon: 100.9167 }, 'ทุ่งสุขลา': { lat: 13.1058, lon: 100.9242 },
        'บางพระ': { lat: 13.2142, lon: 100.9461 }, 'มาบปู': { lat: 13.0519, lon: 101.1558 },
        'ปลวกแดง': { lat: 12.9736, lon: 101.2153 }, 'มาบยางพร': { lat: 12.9906, lon: 101.1481 },
        'ตาสิทธิ์': { lat: 13.0561, lon: 101.2169 }, 'ละหาร': { lat: 12.9869, lon: 101.2597 }
    };

    // ประกาศตัวแปรสถานะทั้งหมดไว้ต้น IIFE ป้องกัน Temporal Dead Zone (TDZ) 100%
    let lastTechLoginTimestamp = 0;
    let currentEditingJobKey = null;
    let currentEditingJobType = 'outage';
    let cachedCloudJobs = [];
    let hasLoadedCloudBaseline = false;
    let isSyncingNow = false;
    let syncTickCounter = 0;
    let lastIdleHeartbeatWriteMs = 0;
    let lastRenderedCardsSignature = '';

    let sharedTechAudioCtx = null;
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
    const shortLinkAttemptMap = new Map();

    let isStoppingEquipNavInternal = false;
    let lastLocalEquipNavStartMs = 0;
    let activeVoiceRecognition = null;
    let autoSubmitVoiceTimer = null;
    let isSubmittingTechReport = false;
    let hasBootstrappedTechJobs = false;

    let repairJobsMap = null;
    let repairJobsMarkersLayer = null;
    let repairTechSelfMarker = null;
    let repairMapResizeObserver = null;
    let repairJobMarkersByKey = {};
    let currentlyOpenRepairPopupKey = null;
    let isRepairMapCollapsed = false;
    let isRepairMapFullscreen = false;
    let showRepairJobTooltips = true;
    let lastRepairJobsSignature = '';
    let lastAutoFittedCoordsSig = '';
    let suppressMapAutoFitUntilMs = 0;
    let isUpgradingShortLinks = false;

    function normTechGrp(raw) {
        if (typeof window.normalizePeaGroupName === 'function') return window.normalizePeaGroupName(raw);
        return String(raw || '').trim().replace(/\s+/g, ' ').replace(/^(กฟ[สฟจตอ])\.?\s+/, '$1.').replace(/^(กฟ[สฟจตอ])(?![.\s])/, '$1.');
    }

    function isSysRegistryLoc(k, loc) {
        return !k || k === Core.REGISTRY_LOC_KEY || String(k).startsWith(PM_LOC_PREFIX) || Boolean(loc && loc.isSystemRegistry);
    }

    function escJsAttr(s) {
        return escapeHtmlStr(
            String(s ?? '')
                .replace(/\\/g, '\\\\')
                .replace(/'/g, "\\'")
                .replace(/\r/g, '\\r')
                .replace(/\n/g, '\\n')
                .replace(/\u2028/g, '\\u2028')
                .replace(/\u2029/g, '\\u2029')
        );
    }

    function normalizeThaiDateStr(rawStr) {
        const s = String(rawStr || '').trim();
        if (!s || s === '-') return '';
        const firstToken = s.split(/\s+/)[0];
        const slashParts = firstToken.split('/');
        if (slashParts.length === 3) {
            const d = parseInt(slashParts[0], 10), m = parseInt(slashParts[1], 10);
            let y = parseInt(slashParts[2], 10);
            if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y > 0) {
                if (y < 100) y += 2500;
                else if (y < 2400) y += 543;
                return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
            }
        }
        const isoMatch = firstToken.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (isoMatch) {
            let y = parseInt(isoMatch[1], 10);
            const m = parseInt(isoMatch[2], 10), d = parseInt(isoMatch[3], 10);
            if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
                if (y < 2400) y += 543;
                return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
            }
        }
        return firstToken;
    }

    // ========================================================================
    // 📄 เอนจินส่งข้อมูลใบงานช่างเข้าใบรายงานมิเตอร์ชำรุดอัตโนมัติ (meter-form.html)
    // ========================================================================
    function getTechMeterFormBaseUrl() {
        try {
            const saved = String(localStorage.getItem('meter_form_link') || '').trim();
            if (saved && saved !== LEGACY_GOOGLE_METER_LINK && !/^(?:\.\/|\/)?meter-form(?:\.html)?$/i.test(saved)) {
                return saved;
            }
            if (/^https?:$/i.test(window.location.protocol)) {
                const baseDir = window.location.pathname.replace(/[^/]*$/, '');
                return `${window.location.origin}${baseDir}meter-form.html`;
            }
        } catch (e) {}
        return 'meter-form.html';
    }

    function encodeTechBase64UrlJson(obj) {
        try {
            const cleanObj = {};
            Object.entries(obj || {}).forEach(([k, v]) => {
                if (v !== undefined && v !== null) {
                    const s = String(v).trim();
                    if (s && s !== '-') cleanObj[k] = s;
                }
            });
            if (Object.keys(cleanObj).length === 0) return '';
            const bytes = new TextEncoder().encode(JSON.stringify(cleanObj));
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        } catch (e) {
            return '';
        }
    }

    function extractTechMeterMetaFromText(rawStr) {
        if (!rawStr || !String(rawStr).trim()) return { customerName: '', peaNo: '', caNo: '' };
        const s = String(rawStr);
        const mPea = s.match(/(?:มิเตอร์\s*-\s*PEA\s*No\.?|PEA\s*No\.?|หมายเลขมิเตอร์|เลขมิเตอร์|เครื่องวัด)\s*[:：=]?\s*([A-Za-z0-9-]{4,20})/i);
        const mCa = s.match(/(?:หมายเลขผู้ใช้ไฟ(?:ฟ้า)?\s*\(?CA\)?|CA\s*(?:No\.?)?)\s*[:：=]?\s*(\d{9,15})/i) || s.match(/(?:^|[^\d])(02\d{10})(?!\d)/);
        const mCust = s.match(/(?:👤\s*)?(?:ชื่อผู้ใช้ไฟ(?:ฟ้า)?|ชื่อลูกค้า|ผู้ใช้ไฟ(?:ฟ้า)?|ชื่อผู้แจ้ง)\s*[:：=]?\s*([^\r\n]+)/i);
        return {
            peaNo: mPea ? mPea[1].trim() : '',
            caNo: mCa ? mCa[1].trim() : '',
            customerName: mCust ? mCust[1].trim() : ''
        };
    }

        function makeTechShortJobId(dateTimeSaved) {
        const s = String(dateTimeSaved || '').trim();
        if (!s || s === '-') return '';
        const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})[:.](\d{1,2})(?:[:.](\d{1,2}))?(?:\.(\d+))?$/);
        if (m) {
            const numStr = m[1].padStart(2, '0') + m[2].padStart(2, '0') + m[3] +
                m[4].padStart(2, '0') + m[5].padStart(2, '0') + (m[6] || '00').padStart(2, '0');
            const b36 = Number(numStr).toString(36);
            return m[7] ? `${b36}_${Number(m[7]).toString(36)}` : b36;
        }
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return 'k' + (h >>> 0).toString(36);
    }
    
    function buildTechMeterFormUrl(item, jobKey, liveOverrides = null, forExternalLine = false) {
        const baseUrl = getTechMeterFormBaseUrl();
        if (!baseUrl || /docs\.google\.com\/forms/i.test(baseUrl)) return baseUrl || 'meter-form.html';
        const cleanBase = baseUrl.split('?')[0];
        const shortId = makeTechShortJobId(jobKey || item?.dateTimeSaved);
        const grp = normTechGrp(getJobGroupName(item) || getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
        
        let grpParam = '';
        if (grp !== 'กฟส.บึง') {
            try {
                const bytes = new TextEncoder().encode(grp);
                let bin = '';
                for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                grpParam = '&grp=' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            } catch (e) {}
        }
        
        if (liveOverrides && Object.values(liveOverrides).some(v => v && String(v).trim())) {
            const effRep = getEffectiveJobReport(item, jobKey, readClosedReg()) || {};
            const addrMeta = extractTechMeterMetaFromText(item?.address || '');
            const shiftStr = getEffectiveJobShift(item);
            const jobNoStr = (item?.jobNo && item.jobNo !== '-') ? String(item.jobNo).trim() : '';
            let bestGps = liveOverrides.fieldGps || effRep.fieldGps || item?.gps || '';
            if ((!bestGps || bestGps === '-') && isGpsTrackingEnabled && lastKnownTechCoords) {
                bestGps = `https://www.google.com/maps?q=${lastKnownTechCoords.lat.toFixed(6)},${lastKnownTechCoords.lon.toFixed(6)}`;
            }
            const draftObj = {
                office: grp,
                jobLabel: jobNoStr ? `งานที่ ${jobNoStr}${(shiftStr && shiftStr !== 'ไม่ระบุ') ? ' กะ ' + shiftStr : ''}` : '',
                reportDate: getJobDateDisplay(item),
                shift: ['1', '2', '3'].includes(shiftStr) ? shiftStr : '',
                oldPea: item?.peaMeterNo || addrMeta.peaNo || '',
                ca: item?.caNo || addrMeta.caNo || '',
                address: item?.address || '',
                area: item?.area || '',
                phone: item?.phone || '',
                gps: normalizeCoordPairToMapsUrl(bestGps),
                issue: item?.issueType || '',
                realCause: liveOverrides.realCause || effRep.realCause || '',
                actionTaken: liveOverrides.actionTaken || effRep.actionTaken || '',
                customerName: item?.customerName || addrMeta.customerName || '',
                workerName: liveOverrides.inspector || formatTechDisplayName(localStorage.getItem('elec_app_current_user') || '')
            };
            try { localStorage.setItem('pea_meter_live_draft', JSON.stringify(draftObj)); } catch (e) {}
            return shortId ? `${cleanBase}?i=${shortId}${grpParam}&draft=1` : `${cleanBase}?draft=1`;
        }
                const extParam = forExternalLine ? '&openExternalBrowser=1' : '';
        return shortId ? `${cleanBase}?i=${shortId}${grpParam}${extParam}` : cleanBase;
    }
    
    function openTechMeterFormByKey(key, jobType = 'outage') {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        const sk = jobType === 'fault' ? 'fault_reports_all' : 'elecReportsComplete_all';
        const item = JSON.parse(localStorage.getItem(sk) || '[]').find(i => (jobType === 'fault' ? i?.timestamp : i?.dateTimeSaved) === key);
        if (!item) { showToast('⚠️ ไม่พบข้อมูลใบงานนี้'); return; }
        window.open(buildTechMeterFormUrl(item, key, null), '_blank');
    }
    
    function openTechMeterFormFromModal() {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        const sk = currentEditingJobType === 'fault' ? 'fault_reports_all' : 'elecReportsComplete_all';
        const item = JSON.parse(localStorage.getItem(sk) || '[]').find(i => (currentEditingJobType === 'fault' ? i?.timestamp : i?.dateTimeSaved) === currentEditingJobKey) || {};
        const liveOverrides = {
            realCause: (document.getElementById('techCauseInput')?.value || '').trim(),
            actionTaken: (document.getElementById('techActionInput')?.value || '').trim(),
            fieldGps: (document.getElementById('techGpsInput')?.value || '').trim(),
            inspector: (document.getElementById('techInspectorInput')?.value || '').trim()
        };
        window.open(buildTechMeterFormUrl(item, currentEditingJobKey, liveOverrides), '_blank');
    }
    
    function pruneNavCancelMap(rawObj, keepIso = false) {
        if (!rawObj || typeof rawObj !== 'object') return {};
        const now = Date.now();
        const entries = Object.entries(rawObj)
            .map(([k, v]) => {
                const ms = typeof v === 'number' ? v : (/^\d+$/.test(String(v || '')) ? Number(v) : (new Date(v || 0).getTime() || 0));
                return [k, v, ms];
            })
            .filter(([k, , ms]) => Boolean(k) && ms > 0 && (now - ms <= MAX_CANCEL_NAV_AGE_MS))
            .sort((a, b) => b[2] - a[2])
            .slice(0, 150)
            .map(([k, v, ms]) => [k, keepIso ? (typeof v === 'string' && v.includes('T') ? v : new Date(ms).toISOString()) : ms]);
        return Object.fromEntries(entries);
    }

    function extractDialablePhone(rawPhone) {
        const s = String(rawPhone || '').trim();
        if (!s || s === '-') return '';
        const thaiMatch = s.match(/(?:\+66|0)(?:[\s-]*\d){8,9}/);
        if (thaiMatch) return thaiMatch[0].replace(/[^\d+]/g, '');
        const hotlineMatch = s.match(/(?:^|\D)(1\d{3})(?!\d)/);
        if (hotlineMatch) return hotlineMatch[1];
        const fallbackMatch = s.match(/\+?\d(?:[\s-]*\d){6,14}/);
        return fallbackMatch ? fallbackMatch[0].replace(/[^\d+]/g, '') : '';
    }

    function normalizeCoordPairToMapsUrl(rawVal) {
        const s = String(rawVal || '').trim();
        if (!s || s === '-') return s;
        if (/^https?:\/\//i.test(s)) return s;
        if (/^(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.|maps\.)?google\.[a-z.]+\/maps)/i.test(s)) {
            return 'https://' + s;
        }
        const m = s.match(/^(-?\d{1,3}\.\d{3,})\s*,\s*\+?(-?\d{1,3}\.\d{3,})$/);
        if (m) {
            const a = parseFloat(m[1]), b = parseFloat(m[2]);
            const lat = (a >= 95 && a <= 108 && b >= 4 && b <= 23) ? b : a;
            const lon = (a >= 95 && a <= 108 && b >= 4 && b <= 23) ? a : b;
            if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
        }
        return s;
    }

    function getEffectiveJobReport(item, jobKey, closedReg) {
        if (item?.techReport && !isAutoGeneratedFakeClosure(item.techReport)) return item.techReport;
        const cRep = jobKey ? closedReg[jobKey] : null;
        if (cRep && !isAutoGeneratedFakeClosure(cRep) && (!item?.reopenedAt || (cRep.updatedAt && cRep.updatedAt > item.reopenedAt))) {
            return cRep;
        }
        return null;
    }

    function matchesJobSearchKeyword(item, rep, keyword) {
        if (!keyword) return true;
        const extraNames = [
            formatTechDisplayName(item?.workerName || ''),
            formatTechDisplayName(item?.ownerUser || ''),
            formatTechDisplayName(item?.techNav?.techName || ''),
            formatTechDisplayName(rep?.inspector || ''),
            getJobDateDisplay(item)
        ].join(' ');
        const haystack = `${JSON.stringify(item || {})} ${rep ? JSON.stringify(rep) : ''} ${extraNames}`.toLowerCase();
        return haystack.includes(keyword);
    }

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
        const isLogged = localStorage.getItem('elec_app_logged_in') === 'true';
        if (loginEl) {
            loginEl.classList.toggle('hidden', isLogged);
            loginEl.style.display = isLogged ? 'none' : 'flex';
        }
        if (!isLogged) {
            const eqBanner = document.getElementById('pea-equip-nav-banner');
            if (eqBanner) eqBanner.style.display = 'none';
        } else if (repairJobsMap) {
            setTimeout(() => repairJobsMap.invalidateSize(), 120);
        }
    }

    function checkTechAuth() {
        syncTechLoginVisibility();
        updateRoleNavigationUI();
        if (typeof updateEquipNavFloatingBanner === 'function') updateEquipNavFloatingBanner();
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
        const myGroup = normTechGrp(getCurrentUserGroup());
        const isViewer = isViewerRole();
        const canEditScada = canCurrentUserEditScada();

        if (localStorage.getItem('elec_app_logged_in') === 'true' && currentRole !== 'admin' && myGroup) {
            if (localStorage.getItem('elec_app_current_group') !== myGroup) localStorage.setItem('elec_app_current_group', myGroup);
        }

        document.body.classList.toggle('role-viewer-readonly', isViewer);
        document.body.classList.toggle('role-scada-readonly', !canEditScada);

        const backBtn = document.getElementById('backToMainBtn');
        if (backBtn) {
            if (currentRole === 'tech' || Core.isEmbeddedIframe) {
                backBtn.classList.add('hidden'); backBtn.classList.remove('flex');
                if (Core.isEmbeddedIframe) backBtn.style.display = 'none';
            } else {
                backBtn.classList.remove('hidden'); backBtn.classList.add('flex');
            }
        }

        const userBadge = document.getElementById('loggedUserDisplayBadge');
        if (userBadge) {
            if (!currentUser) {
                userBadge.textContent = '';
            } else {
                const matchedAcc = getParsedUserAccounts().find(a => isUsernameMatchingAccount(currentUser, a.username));
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
        if (typeof window.__onScadaRoleUpdated === 'function') window.__onScadaRoleUpdated();
    }

    function injectTechOnlineButton() {
        const headerRight = document.querySelector('#techMainApp .bg-gradient-to-r .flex.flex-wrap.items-center.gap-1\\.5');
        if (!headerRight) return;
        let btn = document.getElementById('techOnlineUsersBtn');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button'; btn.id = 'techOnlineUsersBtn'; btn.onclick = openTechOnlineModal;
            btn.className = 'hidden bg-emerald-500/90 hover:bg-emerald-600 text-white px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm items-center gap-1';
            btn.title = 'ดูรายชื่อผู้ที่กำลังออนไลน์ (เฉพาะแอดมิน)';
            btn.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-200 animate-ping"></span><span>ออนไลน์ (<span id="techOnlineCountBadge">1</span>)</span>`;
            headerRight.insertBefore(btn, headerRight.firstChild);
        }
        const isAdmin = isCurrentUserAdmin();
        btn.classList.toggle('hidden', !isAdmin); btn.classList.toggle('flex', isAdmin);
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
            modal = document.createElement('div'); modal.id = 'techOnlineModal';
            modal.className = 'fixed inset-0 bg-slate-900/60 hidden z-[190] flex items-center justify-center p-3 backdrop-blur-sm';
            modal.innerHTML = `<div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[85vh]"><div class="px-4 py-3 bg-gradient-to-r from-teal-700 to-emerald-600 text-white flex justify-between items-center"><h3 class="font-bold text-sm flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full bg-emerald-300 animate-ping"></span><span>สถานะผู้ใช้งานออนไลน์ (เฉพาะ Admin)</span></h3><button type="button" onclick="document.getElementById('techOnlineModal').classList.add('hidden')" class="text-white/80 hover:text-white text-xl font-bold leading-none">&times;</button></div><div class="px-4 py-2 bg-emerald-50 border-b border-emerald-100 flex justify-between items-center text-[11px] text-emerald-800 font-semibold"><span id="techOnlineSummaryText">กำลังตรวจสอบ...</span><button type="button" onclick="syncJobsFromCloud(false)" class="text-teal-700 hover:underline font-bold">🔄 ซิงค์สถานะ</button></div><div id="techOnlineListContainer" class="p-3.5 overflow-y-auto space-y-2 flex-1 bg-slate-50"></div><div class="p-3 bg-white border-t flex justify-end"><button type="button" onclick="document.getElementById('techOnlineModal').classList.add('hidden')" class="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition">ปิดหน้าต่าง</button></div></div>`;
            document.body.appendChild(modal);
        }
        renderTechOnlineModalList();
        modal.classList.remove('hidden');
    }

    function renderTechOnlineModalList(precomputedList) {
        if (!isCurrentUserAdmin()) return;
        const container = document.getElementById('techOnlineListContainer'), summaryEl = document.getElementById('techOnlineSummaryText');
        if (!container) return;
        const list = precomputedList || Core.getAccountsOnlineStatusList('📱 หน้าช่าง', Boolean(isGpsTrackingEnabled && lastKnownTechCoords));
        if (summaryEl) summaryEl.textContent = `🟢 ออนไลน์ขณะนี้ ${list.filter(i => i.isOnline).length} คน (ทั้งหมด ${list.length} บัญชี)`;
        container.innerHTML = list.map(item => {
            const roleIcon = item.role === 'admin' ? '👑' : (item.role === 'tech' ? '🛠️' : (item.role === 'viewer' ? '👁️' : '👷'));
            const statusBadge = item.isOnline
                ? `<span class="inline-flex items-center gap-1 bg-emerald-100 text-emerald-700 border border-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>ออนไลน์</span>`
                : `<span class="inline-flex items-center gap-1 bg-slate-100 text-slate-500 border border-slate-200 text-[10px] font-semibold px-2 py-0.5 rounded-full">⚪ ออฟไลน์</span>`;
            const mins = item.lastSeenMs ? Math.max(1, Math.floor(item.diffMs / 60000)) : 0;
            const timeLabel = item.isOnline ? 'ออนไลน์ขณะนี้' : (!item.lastSeenMs ? 'ยังไม่เคยออนไลน์' : (mins < 60 ? `ออฟไลน์เมื่อ ${mins} นาทีที่แล้ว` : (mins < 1440 ? `ออฟไลน์เมื่อ ${Math.floor(mins / 60)} ชม. ที่แล้ว` : `ออนไลน์ล่าสุด ${new Date(item.lastSeenMs).toLocaleDateString('th-TH')}`)));
            return `<div class="p-3 rounded-xl border bg-white shadow-sm flex items-center justify-between gap-2 ${item.isOnline ? 'border-emerald-300 border-l-4 border-l-emerald-500' : 'border-slate-200 opacity-75'}"><div class="min-w-0 flex-1 space-y-0.5"><div class="flex items-center gap-1.5 flex-wrap"><span class="font-bold text-slate-800 text-xs truncate">${roleIcon} ${escapeHtmlStr(item.displayName)}</span>${item.isMe ? `<span class="bg-teal-100 text-teal-800 text-[9px] font-bold px-1.5 py-0.5 rounded">คุณ</span>` : ''}</div><div class="text-[10px] text-slate-500 flex items-center gap-2">${item.isOnline ? `<span class="text-teal-700 font-semibold">${escapeHtmlStr(item.currentPage)}</span>` : ''}${item.role === 'tech' ? `<span>• ${item.hasGps ? '📍 เปิด GPS' : '🚫 ปิด GPS'}</span>` : ''}</div><div class="text-[10px] ${item.isOnline ? 'text-emerald-600 font-semibold' : 'text-slate-400'}">🕒 ${timeLabel}</div></div><div class="shrink-0">${statusBadge}</div></div>`;
        }).join('');
    }

    let authSessionEpoch = 0;

    async function handleTechLogin() {
        const u = document.getElementById('techUsername')?.value.trim() || '';
        const p = document.getElementById('techPassword')?.value.trim() || '';
        const btn = document.getElementById('techLoginBtn');
        if (!u || !p) { showToast('⚠️ กรุณากรอกรหัสพนักงานและรหัสผ่าน'); return; }
        if (btn) { btn.disabled = true; btn.textContent = '⏳ กำลังตรวจสอบรหัสผ่านที่เซิร์ฟเวอร์...'; }
        try {
            ensureTechAudioUnlocked();
            authSessionEpoch++;
            isSyncingNow = false;
            const data = await Core.verifyLoginOnServer(u, p);
            if (data?.status === 'ok' && data.authenticated && data.user) {
                lastTechLoginTimestamp = Date.now();
                if (document.getElementById('techUsername')) document.getElementById('techUsername').value = '';
                if (document.getElementById('techPassword')) document.getElementById('techPassword').value = '';
                cachedCloudJobs = [];
                hasLoadedCloudBaseline = false;
                lastRenderedCardsSignature = '';
                lastRepairJobsSignature = '';
                lastAutoFittedCoordsSig = '';
                knownPendingJobKeys.clear();
                hasInitializedPendingBaseline = false;
                checkTechAuth();
                await syncJobsFromCloud(false);
                initTechGpsTracker();
                renderJobCards();
                setTimeout(upgradeRepairJobsShortLinks, 800);
                showToast(`🔓 ยินดีต้อนรับคุณ ${formatTechDisplayName(data.user.username)}`);
            } else {
                showToast('❌ รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง');
            }
        } catch (err) {
            showToast('⚠️ ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ตรวจสอบรหัสผ่านได้');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ'; }
        }
    }

    function handleTechLogout() {
        authSessionEpoch++;
        if (typeof window.toggleScadaSimMode === 'function' && Core.simSandbox.active) window.toggleScadaSimMode(false, true);
        if (isRepairMapFullscreen && typeof toggleRepairJobsMapFullscreen === 'function') toggleRepairJobsMapFullscreen();
        if (typeof window.__stopScadaMapRoute === 'function') { try { window.__stopScadaMapRoute(true); } catch (e) {} }
        const curUser = (localStorage.getItem('elec_app_current_user') || '').trim();
        const curGrp = normTechGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
        const wasRole = localStorage.getItem('elec_app_current_role') || 'user';
        const wasViewer = isViewerRole();

        stopActiveVoiceSession();
        stopRealtimeGpsWatch();
        releaseScreenWakeLockIfIdle(true);
        if (techGpsIntervalId) { clearInterval(techGpsIntervalId); techGpsIntervalId = null; }

        ['elec_app_logged_in', 'elec_app_current_user', 'elec_app_current_group', 'elec_app_current_role', 'elec_app_session_token', 'elec_app_last_active'].forEach(k => localStorage.removeItem(k));
        lastKnownTechCoords = null;
        cachedCloudJobs = [];
        hasLoadedCloudBaseline = false;
        knownPendingJobKeys.clear();
        hasInitializedPendingBaseline = false;
        lastRenderedCardsSignature = '';
        lastRepairJobsSignature = '';
        lastAutoFittedCoordsSig = '';

        let snapshotLocs = null;
        if (curUser) {
            const locMap = getTechLocationsMap(), nowIso = new Date().toISOString();
            Object.keys(locMap).forEach(k => {
                if (!isSysRegistryLoc(k, locMap[k]) && (isSameTechPerson(k, curUser) || isSameTechPerson(locMap[k]?.username, curUser))) {
                    locMap[k] = { ...locMap[k], isOnline: false, gpsDisabled: true, lat: null, lon: null, lastSeenAt: nowIso, updatedAt: nowIso };
                }
            });
            localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
            snapshotLocs = locMap;
        }

        if (typeof updateMyTechMarkerOnRepairMap === 'function') updateMyTechMarkerOnRepairMap();
        checkTechAuth();
        showToast('🔒 ออกจากระบบเรียบร้อยแล้ว');

        if (curUser && snapshotLocs && navigator.onLine && !wasViewer) {
            const nowIso = new Date().toISOString();
            const targetUrl = `${getActiveCloudApiUrl()}?group=${encodeURIComponent(curGrp)}&role=${encodeURIComponent(wasRole)}`;
            Core.unlockCloudWrite(15000);
            fetch(targetUrl, {
                method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({
                    action: 'patchDelta', group: curGrp, upsertedJobs: [], removedJobKeys: [],
                    techLocDelta: { id: 'TECH_LOC_REGISTRY', jobType: 'tech_loc', dateTimeSaved: 'TECH_LOC_REGISTRY', techLocations: snapshotLocs, _keepBackups: true, _keepPins: true, _keepDelPins: true, _keepAuditLogs: true, updatedAt: nowIso }
                })
            }).catch(() => {});
        }
    }

    // ========================================================================
    // 2. ระบบเสียงแจ้งเตือนแบบ Shared AudioContext (กันเตือนหลอกจังหวะล็อกอิน & เตือนข้ามหมวด)
    // ========================================================================
    function ensureTechAudioUnlocked() {
        if (Core.isEmbeddedIframe) return null;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return null;
            if (!sharedTechAudioCtx || sharedTechAudioCtx.state === 'closed') sharedTechAudioCtx = new AudioCtx();
            if (sharedTechAudioCtx.state === 'suspended') sharedTechAudioCtx.resume().catch(() => {});
            if (sharedTechAudioCtx.state === 'running') ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(ev => window.removeEventListener(ev, ensureTechAudioUnlocked));
            return sharedTechAudioCtx;
        } catch (e) { return null; }
    }
    if (!Core.isEmbeddedIframe) ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(ev => window.addEventListener(ev, ensureTechAudioUnlocked, { passive: true }));

    function updateSoundToggleButtonUI() {
        const btn = document.getElementById('soundAlertToggleBtn');
        if (!btn) return;
        btn.textContent = isSoundAlertEnabled ? '🔔 เสียง: เปิด' : '🔕 เสียง: ปิด';
        btn.className = isSoundAlertEnabled ? 'bg-white/20 hover:bg-white/30 text-white px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm' : 'bg-slate-800/50 hover:bg-slate-800/70 text-slate-200 px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm';
    }

    function toggleSoundAlert() {
        ensureTechAudioUnlocked();
        isSoundAlertEnabled = !isSoundAlertEnabled;
        localStorage.setItem('elec_tech_sound_enabled', isSoundAlertEnabled ? 'true' : 'false');
        updateSoundToggleButtonUI();
        if (isSoundAlertEnabled) { playNewJobAlertSound(false); showToast('🔔 เปิดเสียงแจ้งเตือนใบงานใหม่แล้ว'); }
        else showToast('🔕 ปิดเสียงแจ้งเตือนใบงานใหม่แล้ว');
    }

    function playNewJobAlertSound(isCritical = false) {
        if (!isSoundAlertEnabled || Core.isEmbeddedIframe) return;
        try {
            if (navigator.vibrate) navigator.vibrate(isCritical ? [300, 120, 300, 120, 400] : [200, 100, 200]);
            const ctx = ensureTechAudioUnlocked();
            if (!ctx) return;
            const baseT = ctx.currentTime + 0.02;
            const playTone = (freq, startSec, durSec) => {
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = isCritical ? 'sawtooth' : 'sine';
                osc.frequency.setValueAtTime(freq, baseT + startSec);
                gain.gain.setValueAtTime(0.18, baseT + startSec);
                gain.gain.exponentialRampToValueAtTime(0.001, baseT + startSec + durSec);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch (e) {} };
                osc.start(baseT + startSec); osc.stop(baseT + startSec + durSec);
            };
            if (isCritical) { playTone(880, 0, 0.18); playTone(1174, 0.20, 0.18); playTone(880, 0.40, 0.18); playTone(1318, 0.60, 0.35); }
            else { playTone(659.25, 0, 0.16); playTone(880, 0.18, 0.30); }
        } catch (e) {}
    }

    function checkNewIncomingPendingJobs() {
        if (localStorage.getItem('elec_app_logged_in') !== 'true') return;
        if (!hasInitializedPendingBaseline && !hasLoadedCloudBaseline && navigator.onLine) return;

        const delReg = getDeletedJobsRegistry(), closedReg = readClosedReg();
        const outages = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]');
        const faults = JSON.parse(localStorage.getItem('fault_reports_all') || '[]');
        const currentKeys = new Set();
        let foundNewOutage = false, foundNewFault = false, foundCritical = false;

        outages.forEach(item => {
            const jk = item?.dateTimeSaved;
            if (!jk || delReg[jk] || !canCurrentUserSeeJob(item)) return;
            const rep = getEffectiveJobReport(item, jk, closedReg);
            if (rep && String(rep.status || '').includes('เสร็จสิ้น')) return;
            const k = 'O_' + jk; currentKeys.add(k);
            if (hasInitializedPendingBaseline && !knownPendingJobKeys.has(k)) {
                foundNewOutage = true;
                if (item.priorityLevel === 'critical') foundCritical = true;
            }
        });
        faults.forEach(item => {
            const jk = item?.timestamp;
            if (!jk || delReg[jk] || !canCurrentUserSeeJob(item)) return;
            const rep = getEffectiveJobReport(item, jk, closedReg);
            if (rep && String(rep.status || '').includes('เสร็จสิ้น')) return;
            const k = 'F_' + jk; currentKeys.add(k);
            if (hasInitializedPendingBaseline && !knownPendingJobKeys.has(k)) {
                foundNewFault = true;
                foundCritical = true;
            }
        });

        knownPendingJobKeys = currentKeys;
        if (!hasInitializedPendingBaseline) { hasInitializedPendingBaseline = true; return; }
        if (foundNewOutage || foundNewFault) {
            playNewJobAlertSound(foundCritical);
            const curViewType = document.getElementById('filterJobType')?.value || 'outage';
            if (foundNewFault && curViewType !== 'fault') {
                showToast('🚨 มีใบงานสายส่ง/สถานี (Fault) เข้าใหม่! แตะแถบแจ้งเตือนบนสุดเพื่อดู');
            } else if (foundNewOutage && curViewType !== 'outage') {
                showToast('🔔 มีใบงานไฟดับทั่วไปเข้าใหม่! แตะแถบแจ้งเตือนบนสุดเพื่อดู');
            } else {
                showToast(foundCritical ? '🚨 มีใบงานด่วน/วิกฤต เข้ามาใหม่!' : '🔔 มีใบงานแจ้งซ่อมเข้ามาใหม่!');
            }
        }
    }

    // ========================================================================
    // 3. ระบบติดตามพิกัด GPS, คืนสิทธิ์พักหน้าจอ (WakeLock) & แนะนำช่างใกล้สุด
    // ========================================================================
    function updateGpsToggleButtonUI() {
        const btn = document.getElementById('gpsToggleBtn');
        if (!btn) return;
        btn.textContent = isGpsTrackingEnabled ? '📍 GPS: เปิด' : '🚫 GPS: ปิด';
        btn.className = isGpsTrackingEnabled ? 'bg-white/20 hover:bg-white/30 text-white px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm' : 'bg-slate-800/50 hover:bg-slate-800/70 text-slate-200 px-2.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm';
    }

    function clearMyGpsFromLocationsMap() { Core.updateUserOnlineHeartbeat('📱 หน้าช่าง', null, false); }

    function hasAnyActiveMyNavigation() {
        return activeNavWatchId !== null || (typeof getActiveEquipmentNavItems === 'function' && getActiveEquipmentNavItems().some(it => canUserControlNavigation(it.techName)));
    }

    async function requestScreenWakeLock() {
        try {
            if ('wakeLock' in navigator && !screenWakeLock && !document.hidden) {
                screenWakeLock = await navigator.wakeLock.request('screen');
                screenWakeLock.addEventListener('release', () => { screenWakeLock = null; });
            }
        } catch (e) {}
    }

    function releaseScreenWakeLockIfIdle(force = false) {
        if (!screenWakeLock) return;
        if (force || !hasAnyActiveMyNavigation()) {
            const lock = screenWakeLock;
            screenWakeLock = null;
            try { lock.release().catch(() => {}); } catch (e) {}
        }
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
            releaseScreenWakeLockIfIdle(true);
            if (techGpsIntervalId) { clearInterval(techGpsIntervalId); techGpsIntervalId = null; }
            lastKnownTechCoords = null;
            clearMyGpsFromLocationsMap();
            if (typeof updateMyTechMarkerOnRepairMap === 'function') updateMyTechMarkerOnRepairMap();
            if (typeof window.__onTechGpsUpdated === 'function') window.__onTechGpsUpdated();
            renderJobCards();
            showToast('🚫 ปิดการแชร์พิกัด GPS และล้างตำแหน่งค้างเรียบร้อยแล้ว');
            localStorage.setItem('elec_tech_has_pending_push', 'true');
            Core.unlockCloudWrite(15000);
            await pushAllJobsToCloud(true);
        }
    }

    function recordCurrentTechGpsLocation(lat, lon) {
        const role = localStorage.getItem('elec_app_current_role') || 'user';
        if (!isGpsTrackingEnabled || Core.isEmbeddedIframe || role === 'viewer') return;
        let la = parseFloat(lat), lo = parseFloat(lon);
        if (isNaN(la) || isNaN(lo)) return;
        if (la >= 95 && la <= 108 && lo >= 4 && lo <= 23) { const tmp = la; la = lo; lo = tmp; }
        if (la < 4 || la > 23 || lo < 95 || lo > 108) return;
        lastKnownTechCoords = { lat: la, lon: lo };
        if (role !== 'admin') Core.updateUserOnlineHeartbeat('📱 หน้าช่าง', lastKnownTechCoords, true);
        if (typeof updateMyTechMarkerOnRepairMap === 'function') updateMyTechMarkerOnRepairMap();
        if (typeof window.__onTechGpsUpdated === 'function') window.__onTechGpsUpdated();
    }

    function initTechGpsTracker(showFeedback = false) {
        updateGpsToggleButtonUI();
        if (!isGpsTrackingEnabled || Core.isEmbeddedIframe || isViewerRole()) {
            clearMyGpsFromLocationsMap(); renderJobCards(); return;
        }
        if (!navigator.geolocation) { if (showFeedback) showToast('⚠️ เบราว์เซอร์ของคุณไม่รองรับ GPS'); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                recordCurrentTechGpsLocation(pos.coords.latitude, pos.coords.longitude);
                resumeMyActiveJobNavWatchIfNeeded();
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
            navigator.geolocation.getCurrentPosition((pos) => recordCurrentTechGpsLocation(pos.coords.latitude, pos.coords.longitude), () => {}, { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 });
        }, 30000);
        resumeMyActiveJobNavWatchIfNeeded();
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
                } else showToast('❌ ไม่สามารถดึงพิกัดได้ กรุณาเปิด Location ในมือถือ');
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
        );
    }

    function extractCoordsFromJob(item, jobKeyOpt) {
        if (!item) return null;
        const jk = jobKeyOpt || item.dateTimeSaved || item.timestamp || '';
        if (jk) {
            try {
                const jobShortCache = JSON.parse(localStorage.getItem(SHORT_URL_COORD_CACHE_KEY) || '{}');
                if (jobShortCache[jk]?.lat && jobShortCache[jk]?.lon) {
                    return { lat: parseFloat(jobShortCache[jk].lat), lon: parseFloat(jobShortCache[jk].lon), isApproxTambon: false };
                }
            } catch (e) {}
        }
        const textBlob = `${item.techReport?.fieldGps || ''} ${item.gps || ''} ${item.address || ''} ${item.area || ''} ${item.weather || ''}`.trim();
        if (!textBlob) return null;
        const direct = deepParseCoords(textBlob, false);
        if (direct) return { lat: parseFloat(direct.lat), lon: parseFloat(direct.lon), isApproxTambon: false };

        const shortMatch = textBlob.match(/(?:https?:\/\/)?(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/[A-Za-z0-9_-]+/i);
        if (shortMatch) {
            try {
                const cleanShort = (/^https?:\/\//i.test(shortMatch[0]) ? shortMatch[0] : 'https://' + shortMatch[0]).split('?')[0];
                const masterCache = JSON.parse(localStorage.getItem(SHORTLINK_MASTER_CACHE_KEY) || '{}');
                if (masterCache[cleanShort]?.lat && masterCache[cleanShort]?.lon) {
                    return { lat: parseFloat(masterCache[cleanShort].lat), lon: parseFloat(masterCache[cleanShort].lon), isApproxTambon: false };
                }
            } catch (e) {}
        }
        for (const [tbName, tbCoord] of Object.entries(EXTENDED_AREA_COORDS)) {
            if (textBlob.includes(tbName)) return { lat: tbCoord.lat, lon: tbCoord.lon, isApproxTambon: true };
        }
        return null;
    }

    function findNearestTechForJob(item) {
        const destCoord = extractCoordsFromJob(item);
        if (!destCoord) return null;
        const jobGroup = normTechGrp(getJobGroupName(item)), locMap = { ...getTechLocationsMap() }, accounts = getParsedUserAccounts();
        const curUser = normalizeUsernameFormat(localStorage.getItem('elec_app_current_user') || ''), curRole = localStorage.getItem('elec_app_current_role') || 'user', nowMs = Date.now();

        if (isGpsTrackingEnabled && lastKnownTechCoords && curUser && curRole !== 'admin' && curRole !== 'viewer' && !Core.isEmbeddedIframe) {
            Object.keys(locMap).forEach(k => {
                if (!isSysRegistryLoc(k, locMap[k]) && (isSameTechPerson(k, curUser) || isSameTechPerson(locMap[k]?.username, curUser))) delete locMap[k];
            });
            locMap[curUser] = { username: curUser, role: curRole, group: normTechGrp(getCurrentUserGroup()), lat: lastKnownTechCoords.lat, lon: lastKnownTechCoords.lon, gpsDisabled: false, isOnline: true, lastSeenAt: new Date().toISOString() };
        }

        const candidates = [];
        Object.entries(locMap).forEach(([k, loc]) => {
            if (isSysRegistryLoc(k, loc) || !loc || loc.isOnline === false || loc.gpsDisabled || isNaN(parseFloat(loc.lat)) || isNaN(parseFloat(loc.lon)) || !loc.username) return;
            if (!isGpsTrackingEnabled && curUser && isSameTechPerson(loc.username, curUser)) return;
            const seenMs = new Date(loc.lastSeenAt || loc.updatedAt || 0).getTime() || 0;
            if (seenMs <= 0 || (nowMs - seenMs) > 180000) return;
            const accMatch = accounts.find(a => isUsernameMatchingAccount(loc.username, a.username));
            const effRole = accMatch ? accMatch.role : (loc.role || 'tech');
            if (effRole === 'viewer' || effRole === 'admin') return;
            const effGroup = normTechGrp(getUserGroupName(loc.username) || loc.group || '');
            if (jobGroup && effGroup && jobGroup !== effGroup) return;
            const roadKm = Math.max(0.2, calcHaversineKm(parseFloat(loc.lat), parseFloat(loc.lon), destCoord.lat, destCoord.lon) * 1.35);
            candidates.push({ username: accMatch ? accMatch.username : loc.username, roadKm, estMin: Math.max(1, Math.round((roadKm / 45) * 60)), isTechRole: effRole === 'tech' });
        });

        const techOnly = candidates.filter(c => c.isTechRole), pool = techOnly.length > 0 ? techOnly : candidates;
        if (pool.length === 0) return null;
        pool.sort((a, b) => a.roadKm - b.roadKm);
        const best = pool[0];
        return { techName: best.username, distanceKm: best.roadKm.toFixed(1), durationMin: best.estMin, hasGps: true, isMe: Boolean(curUser && isSameTechPerson(best.username, curUser)) };
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
            const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 1800);
            const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${startCoord.lon},${startCoord.lat};${destCoord.lon},${destCoord.lat}?overview=false`, { signal: ctrl.signal });
            clearTimeout(timer);
            if (res.ok) {
                const route = (await res.json())?.routes?.[0];
                if (route) return { distanceKm: Math.max(0.1, route.distance / 1000).toFixed(1), durationMin: Math.max(1, Math.round((route.duration / 60) * 1.15)), isArrived: false };
            }
        } catch (e) {}
        return calculateInstantRouteFallback(startCoord, destCoord);
    }

    function stopRealtimeGpsWatch(onlyIfJobKey = null) {
        if (onlyIfJobKey && activeNavJobKey && activeNavJobKey !== onlyIfJobKey) return;
        if (activeNavWatchId !== null && navigator.geolocation) {
            navigator.geolocation.clearWatch(activeNavWatchId);
            activeNavWatchId = null;
        }
        activeNavJobKey = null;
        releaseScreenWakeLockIfIdle();
    }

    function verifyActiveJobNavWatchStillValid() {
        if (!activeNavJobKey) return;
        if (localStorage.getItem('elec_app_logged_in') !== 'true' || !isGpsTrackingEnabled) {
            stopRealtimeGpsWatch();
            return;
        }
        const delReg = getDeletedJobsRegistry();
        if (delReg[activeNavJobKey]) { stopRealtimeGpsWatch(); return; }
        const storageKey = activeNavJobType === 'fault' ? 'fault_reports_all' : 'elecReportsComplete_all';
        const item = JSON.parse(localStorage.getItem(storageKey) || '[]').find(i => (activeNavJobType === 'fault' ? i?.timestamp : i?.dateTimeSaved) === activeNavJobKey);
        if (!item) { stopRealtimeGpsWatch(); return; }
        const rep = getEffectiveJobReport(item, activeNavJobKey, readClosedReg());
        const cancelIso = getCancelledJobNavMap()[activeNavJobKey] || item.navCancelledAt || '';
        if (!item.techNav || (rep && String(rep.status || '').includes('เสร็จสิ้น')) || (cancelIso && cancelIso >= (item.techNav.updatedAt || ''))) {
            stopRealtimeGpsWatch();
        }
    }

    function resumeMyActiveJobNavWatchIfNeeded() {
        if (!isGpsTrackingEnabled || Core.isEmbeddedIframe || isViewerRole() || localStorage.getItem('elec_app_logged_in') !== 'true') return;
        if (typeof getActiveEquipmentNavItems === 'function' && getActiveEquipmentNavItems().some(it => canUserControlNavigation(it.techName))) {
            requestScreenWakeLock();
        }
        verifyActiveJobNavWatchStillValid();
        if (activeNavWatchId !== null) return;
        const curUser = (localStorage.getItem('elec_app_current_user') || '').trim();
        if (!curUser) return;
        const delReg = getDeletedJobsRegistry(), closedReg = readClosedReg(), now = Date.now();
        for (const [sk, jType] of [['elecReportsComplete_all', 'outage'], ['fault_reports_all', 'fault']]) {
            const list = JSON.parse(localStorage.getItem(sk) || '[]');
            for (const item of list) {
                const jk = jType === 'fault' ? item?.timestamp : item?.dateTimeSaved;
                if (!jk || delReg[jk] || !canCurrentUserSeeJob(item)) continue;
                const rep = getEffectiveJobReport(item, jk, closedReg);
                if (rep && String(rep.status || '').includes('เสร็จสิ้น')) continue;
                if (item.techNav && !item.techNav.isArrived && isSameTechPerson(curUser, item.techNav.techName)) {
                    const depMs = Number(item.techNav.departTimestamp || 0);
                    if (depMs > 0 && (now - depMs > MAX_EQUIP_NAV_AGE_MS)) continue;
                    const dest = extractCoordsFromJob(item, jk);
                    if (dest) { startRealtimeGpsWatch(jk, jType, dest); return; }
                }
            }
        }
    }

    // ========================================================================
    // 4. ระบบนำทางใบงานซ่อมเรียลไทม์ (กัน Clock Skew + Race Condition + ซิงค์ครบ)
    // ========================================================================
    function readClosedReg() {
        if (typeof getClosedReportsRegistry === 'function') return getClosedReportsRegistry();
        if (typeof getClosedJobsRegistry === 'function') return getClosedJobsRegistry();
        try { return JSON.parse(localStorage.getItem('elec_closed_jobs_registry') || '{}'); } catch (e) { return {}; }
    }
    function writeClosedReg(mapObj) {
        if (typeof saveClosedReportsRegistry === 'function') return saveClosedReportsRegistry(mapObj);
        if (typeof syncClosedRegistryObject === 'function') return syncClosedRegistryObject(mapObj);
        localStorage.setItem('elec_closed_jobs_registry', JSON.stringify(mapObj || {}));
    }
    function getCancelledJobNavMap() {
        try { return pruneNavCancelMap(JSON.parse(localStorage.getItem(CANCELLED_JOB_NAV_KEY) || '{}'), true); } catch (e) { return {}; }
    }
    function saveCancelledJobNavMap(m) {
        localStorage.setItem(CANCELLED_JOB_NAV_KEY, JSON.stringify(pruneNavCancelMap(m, true)));
    }

    function clearSyncedFlagsInLocalJobs(pushedSyncMeta) {
        if (!pushedSyncMeta || pushedSyncMeta.size === 0) return;
        ['elecReportsComplete_all', 'fault_reports_all'].forEach(sk => {
            const isF = (sk === 'fault_reports_all'), list = JSON.parse(localStorage.getItem(sk) || '[]');
            let dirty = false;
            list.forEach(it => {
                if (!it) return;
                const snap = pushedSyncMeta.get((isF ? 'F_' : 'O_') + (isF ? it.timestamp : it.dateTimeSaved));
                if (!snap) return;
                if (it.pendingInitialUpload) { delete it.pendingInitialUpload; dirty = true; }
                if (it.techReport?.needsMainSync && (it.techReport.updatedAt || '') === snap.repUpd) { delete it.techReport.needsMainSync; dirty = true; }
                if (it.techNav?.needsMainSync && (it.techNav.updatedAt || '') === snap.navUpd) { delete it.techNav.needsMainSync; dirty = true; }
            });
            if (dirty) localStorage.setItem(sk, JSON.stringify(list));
        });
    }

    function startRealtimeGpsWatch(key, jobType, destCoord) {
        stopRealtimeGpsWatch();
        if (!isGpsTrackingEnabled || !navigator.geolocation || !destCoord) return;
        activeNavJobKey = key; activeNavJobType = jobType;
        requestScreenWakeLock();

        activeNavWatchId = navigator.geolocation.watchPosition(
            async (pos) => {
                if (!isGpsTrackingEnabled || activeNavJobKey !== key) { stopRealtimeGpsWatch(key); return; }
                recordCurrentTechGpsLocation(pos.coords.latitude, pos.coords.longitude);
                const nowMs = Date.now();
                if (!lastKnownTechCoords || nowMs - lastNavCloudPushTime < 8000) return;
                lastNavCloudPushTime = nowMs;

                const routeInfo = await calculateDrivingRoute(lastKnownTechCoords, destCoord);
                if (!isGpsTrackingEnabled || activeNavJobKey !== key) return;

                const storageKey = jobType === 'outage' ? 'elecReportsComplete_all' : 'fault_reports_all';
                const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
                const idx = list.findIndex(i => (jobType === 'outage' ? i.dateTimeSaved : i.timestamp) === key);
                if (idx === -1) { stopRealtimeGpsWatch(key); return; }

                const item = list[idx], closedReg = readClosedReg(), cancelMap = getCancelledJobNavMap();
                const rep = getEffectiveJobReport(item, key, closedReg);
                const cancelIso = cancelMap[key] || item.navCancelledAt || '';
                if (!item.techNav || (rep && String(rep.status || '').includes('เสร็จสิ้น')) || (cancelIso && cancelIso >= (item.techNav.updatedAt || ''))) {
                    stopRealtimeGpsWatch(key);
                    return;
                }

                const prevNav = item.techNav, prevNavMs = prevNav.updatedAt ? (new Date(prevNav.updatedAt).getTime() || 0) : 0;
                const finishNowMs = Math.max(Date.now(), prevNavMs + 500);
                const etaMs = finishNowMs + (routeInfo.durationMin * 60000), etaDate = new Date(etaMs);
                const etaTimeStr = `${String(etaDate.getHours()).padStart(2, '0')}.${String(etaDate.getMinutes()).padStart(2, '0')} น.`;

                item.techNav = {
                    ...prevNav, durationMin: routeInfo.durationMin, distanceKm: routeInfo.distanceKm,
                    initialDistanceKm: prevNav.initialDistanceKm || routeInfo.distanceKm, departTimestamp: prevNav.departTimestamp || finishNowMs,
                    etaTimestamp: etaMs, etaTime: routeInfo.isArrived ? 'ถึงจุดเกิดเหตุแล้ว' : etaTimeStr, isArrived: routeInfo.isArrived,
                    techLat: lastKnownTechCoords.lat, techLon: lastKnownTechCoords.lon,
                    statusText: routeInfo.isArrived ? '📍 ถึงจุดเกิดเหตุแล้ว (กำลังตรวจสอบ)' : `อีกประมาณ ${routeInfo.durationMin} นาทีถึง (ถึง ~${etaTimeStr})`,
                    updatedAt: new Date(finishNowMs).toISOString(), needsMainSync: true
                };
                localStorage.setItem(storageKey, JSON.stringify(list));
                localStorage.setItem('elec_tech_has_pending_push', 'true');
                updateLiveNavDomElements();
                Core.unlockCloudWrite(25000);
                if (routeInfo.isArrived) { showToast('📍 คุณเดินทางถึงจุดเกิดเหตุแล้ว!'); stopRealtimeGpsWatch(key); }
                await pushAllJobsToCloud(true);
            },
            () => {},
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
        );
    }

    async function handleStartNavigation(key, jobType, gpsLink) {
        const cleanLink = normalizeCoordPairToMapsUrl(gpsLink);
        if (isViewerRole()) {
            if (cleanLink && /^https?:\/\//i.test(cleanLink)) { window.open(cleanLink, '_blank'); showToast('🗺️ เปิดแผนที่ Google Maps (โหมดผู้สำรวจ)'); }
            else showToast(VIEWER_LOCK_MSG);
            return;
        }
        if (isRepairMapFullscreen && typeof toggleRepairJobsMapFullscreen === 'function') toggleRepairJobsMapFullscreen();
        Core.unlockCloudWrite(25000);
        recentlyCancelledNavKeys.delete(key);

        const cancelJobMap = getCancelledJobNavMap();
        const prevCancelIso = cancelJobMap[key] || '';
        if (cancelJobMap[key]) { delete cancelJobMap[key]; saveCancelledJobNavMap(cancelJobMap); }
        const locMap = getTechLocationsMap();
        if (locMap[Core.REGISTRY_LOC_KEY]?.jobCancelMap?.[key]) {
            delete locMap[Core.REGISTRY_LOC_KEY].jobCancelMap[key];
            localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
        }

        const storageKey = jobType === 'outage' ? 'elecReportsComplete_all' : 'fault_reports_all';
        const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const idx = list.findIndex(i => (jobType === 'outage' ? i.dateTimeSaved : i.timestamp) === key);
        if (idx === -1) { if (cleanLink && /^https?:\/\//i.test(cleanLink)) window.open(cleanLink, '_blank'); return; }

        const item = list[idx];
        const maxPrevRefMs = Math.max(
            prevCancelIso ? (new Date(prevCancelIso).getTime() || 0) : 0,
            item.navCancelledAt ? (new Date(item.navCancelledAt).getTime() || 0) : 0,
            item.techNav?.updatedAt ? (new Date(item.techNav.updatedAt).getTime() || 0) : 0,
            item.techReport?.updatedAt ? (new Date(item.techReport.updatedAt).getTime() || 0) : 0,
            item.reopenedAt ? (new Date(item.reopenedAt).getTime() || 0) : 0
        );
        cachedCloudJobs.forEach(cj => { if ((cj.jobType === 'fault' ? cj.timestamp : cj.dateTimeSaved) === key) delete cj.navCancelledAt; });

        const loggedInUser = normalizeUsernameFormat(localStorage.getItem('elec_app_current_user') || '') || 'ช่างหน้างาน';
        const myGroup = normTechGrp(getCurrentUserGroup()), now = new Date();
        const safeStartMs = Math.max(now.getTime(), maxPrevRefMs > 0 ? maxPrevRefMs + 2000 : 0);
        const departTimeStr = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')} น.`;
        const destCoord = extractCoordsFromJob(item, key);
        const hasRealTechGps = Boolean(isGpsTrackingEnabled && lastKnownTechCoords);
        let route = (hasRealTechGps && destCoord)
            ? calculateInstantRouteFallback(lastKnownTechCoords, destCoord)
            : { distanceKm: '5.0', durationMin: 15, isArrived: false };
        if (route.isArrived && (!hasRealTechGps || destCoord?.isApproxTambon)) {
            route = { distanceKm: '1.5', durationMin: 5, isArrived: false };
        }
        const etaMs = safeStartMs + (route.durationMin * 60000), etaDate = new Date(etaMs);
        const etaTimeStr = `${String(etaDate.getHours()).padStart(2, '0')}.${String(etaDate.getMinutes()).padStart(2, '0')} น.`;

        item.techNav = {
            durationMin: route.durationMin, initialDurationMin: route.durationMin, distanceKm: route.distanceKm, initialDistanceKm: route.distanceKm,
            departTime: departTimeStr, departTimestamp: safeStartMs, etaTime: etaTimeStr, etaTimestamp: etaMs,
            isArrived: route.isArrived, techName: loggedInUser,
            statusText: route.isArrived ? '📍 ถึงจุดเกิดเหตุแล้ว (กำลังตรวจสอบ)' : `อีกประมาณ ${route.durationMin} นาทีถึง (ถึง ~${etaTimeStr})`,
            updatedAt: new Date(safeStartMs).toISOString(), needsMainSync: true
        };
        delete item.navCancelledAt;
        item.ownerGroup = normTechGrp(getJobGroupName(item) || myGroup || 'กฟส.บึง') || 'กฟส.บึง';

        localStorage.setItem(storageKey, JSON.stringify(list));
        localStorage.setItem('elec_tech_has_pending_push', 'true');
        switchStatusTab('traveling');
        const hasValidUrl = Boolean(cleanLink && /^https?:\/\//i.test(cleanLink));
        showToast(hasValidUrl ? '🚗 บันทึกสถานะเดินทางและกำลังเปิด Google Maps...' : '🚗 บันทึกสถานะกำลังเดินทางไปหน้างานแล้ว!');
        if (destCoord && isGpsTrackingEnabled && !route.isArrived) startRealtimeGpsWatch(key, jobType, destCoord);
        if (hasValidUrl) window.open(cleanLink, '_blank');
        await pushAllJobsToCloud(true);
    }

    async function handleCancelNavigation(key, jobType) {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        stopRealtimeGpsWatch(key);
        Core.unlockCloudWrite(25000);

        const storageKey = jobType === 'outage' ? 'elecReportsComplete_all' : 'fault_reports_all';
        const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const idx = list.findIndex(i => (jobType === 'outage' ? i.dateTimeSaved : i.timestamp) === key);
        if (idx === -1) return;

        const prevNavMs = list[idx]?.techNav?.updatedAt ? (new Date(list[idx].techNav.updatedAt).getTime() || 0) : 0;
        const safeCancelIso = new Date(Math.max(Date.now(), prevNavMs > 0 ? prevNavMs + 2000 : 0)).toISOString();
        recentlyCancelledNavKeys.set(key, { ts: Date.now(), iso: safeCancelIso });

        const cancelMap = getCancelledJobNavMap();
        cancelMap[key] = safeCancelIso;
        saveCancelledJobNavMap(cancelMap);

        delete list[idx].techNav;
        list[idx].navCancelledAt = safeCancelIso;
        localStorage.setItem(storageKey, JSON.stringify(list));
        localStorage.setItem('elec_tech_has_pending_push', 'true');

        switchStatusTab('pending');
        showToast("↩️ ยกเลิกการเดินทางแล้ว ย้ายงานกลับไปช่อง 'รอแก้ไข'");
        await pushAllJobsToCloud(true);
    }

    function formatRealtimeNavHtml(nav) {
        if (!nav) return '';
        const nowMs = Date.now(), isGpsFresh = nav.updatedAt && (nowMs - new Date(nav.updatedAt).getTime() < 45000);
        const liveBadge = isGpsFresh
            ? `<span class="inline-flex items-center gap-1 bg-emerald-100 text-emerald-700 text-[9px] font-bold px-1.5 py-0.5 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>GPS สด</span>`
            : `<span class="inline-flex items-center gap-1 bg-blue-100 text-blue-700 text-[9px] font-bold px-1.5 py-0.5 rounded-full">⏱️ เรียลไทม์</span>`;
        const friendlyTech = escapeHtmlStr(formatTechDisplayName(nav.techName || '-'));

        if (nav.isArrived) return `<div class="flex justify-between items-center"><div class="font-bold text-emerald-700">📍 ถึงจุดเกิดเหตุแล้ว (กำลังตรวจสอบหน้างาน)</div>${liveBadge}</div><div class="w-full bg-emerald-200 h-2 rounded-full overflow-hidden my-1"><div class="bg-emerald-600 h-full w-full"></div></div><div class="text-[10px] text-emerald-800">👷 ช่าง: ${friendlyTech} (ออกเดินทาง ${escapeHtmlStr(nav.departTime || '-')})</div>`;
        if (nav.etaTimestamp && nav.departTimestamp) {
            const remainSec = Math.max(0, Math.floor((nav.etaTimestamp - nowMs) / 1000));
            const totalDurSec = Math.max(60, Math.floor((nav.etaTimestamp - nav.departTimestamp) / 1000));
            const elapsedRatio = Math.min(1, Math.max(0.05, 1 - (remainSec / totalDurSec))), progressPct = Math.round(elapsedRatio * 100);
            const initDist = parseFloat(nav.initialDistanceKm || nav.distanceKm || 0), curDist = parseFloat(nav.distanceKm || 0);
            const estRemainDist = isGpsFresh ? curDist.toFixed(1) : Math.max(0.1, initDist * (1 - elapsedRatio * 0.95)).toFixed(1);
            if (remainSec <= 0) return `<div class="flex justify-between items-center"><div class="font-bold text-emerald-700">📍 คาดว่าถึงจุดเกิดเหตุแล้ว (ครบกำหนดเวลา ${escapeHtmlStr(nav.etaTime || '')})</div>${liveBadge}</div><div class="w-full bg-emerald-200 h-2 rounded-full overflow-hidden my-1"><div class="bg-emerald-600 h-full w-full"></div></div><div class="text-[10px] text-blue-800">👷 ช่าง: ${friendlyTech} (ออกเดินทาง ${escapeHtmlStr(nav.departTime || '-')})</div>`;
            return `<div class="flex justify-between items-center gap-1"><div class="font-bold text-blue-700">🚗 กำลังเดินทาง: อีก ${Math.floor(remainSec / 60)} นาที ${String(remainSec % 60).padStart(2, '0')} วินาที (ถึง ~${escapeHtmlStr(nav.etaTime || '-')})</div>${liveBadge}</div><div class="relative w-full bg-blue-200/80 h-2 rounded-full overflow-hidden my-1.5"><div class="bg-gradient-to-r from-blue-500 to-indigo-600 h-full transition-all duration-700" style="width:${progressPct}%"></div></div><div class="flex justify-between items-center text-[10px] text-blue-800"><span>📏 ระยะทางเหลือ: ~${estRemainDist} กม. (${progressPct}%)</span><span>👷 ${friendlyTech} (ออก ${escapeHtmlStr(nav.departTime || '-')})</span></div>`;
        }
        return `<div class="font-bold text-blue-700">🚗 ${escapeHtmlStr(nav.statusText || 'กำลังเดินทาง')}</div><div class="text-[10px] text-blue-800">👷 ช่าง: ${friendlyTech} (ออกเดินทาง ${escapeHtmlStr(nav.departTime || '-')})</div>`;
    }

    function updateLiveNavDomElements() {
        document.querySelectorAll('.realtime-nav-box').forEach(box => {
            const key = box.getAttribute('data-job-key'), jType = box.getAttribute('data-job-type');
            const list = JSON.parse(localStorage.getItem(jType === 'outage' ? 'elecReportsComplete_all' : 'fault_reports_all') || '[]');
            const item = list.find(i => (jType === 'outage' ? i.dateTimeSaved : i.timestamp) === key);
            if (item?.techNav && !(item.techReport && String(item.techReport.status || '').includes('เสร็จสิ้น'))) box.innerHTML = formatRealtimeNavHtml(item.techNav);
        });
    }

    // ========================================================================
    // 5. ระบบซิงค์ใบงานกับ Google Sheets (รองรับวันที่เลขหลักเดียว + เทียบเวลาพิกัดแม่นยำ)
    // ========================================================================
    function getShiftCycleTodayIso() {
        const cyc = new Date();
        if (cyc.getHours() * 60 + cyc.getMinutes() < 30) cyc.setDate(cyc.getDate() - 1);
        return `${cyc.getFullYear()}-${String(cyc.getMonth() + 1).padStart(2, '0')}-${String(cyc.getDate()).padStart(2, '0')}`;
    }

    function getJobCreatedTimeMs(item) {
        if (!item) return 0;
        if (item.createdAtMs) return Number(item.createdAtMs) || 0;
        if (item.timestamp) { const t = new Date(item.timestamp).getTime(); if (!isNaN(t)) return t; }
        if (item.dateTimeSaved) {
            const parts = String(item.dateTimeSaved).trim().split(/\s+/), dp = (parts[0] || '').split('/');
            if (dp.length === 3) {
                let yr = parseInt(dp[2], 10) || 2569; if (yr > 2400) yr -= 543;
                const tp = (parts[1] || '00:00:00').split(/[:.]/);
                return new Date(yr, (parseInt(dp[1], 10) || 1) - 1, parseInt(dp[0], 10) || 1, parseInt(tp[0], 10) || 0, parseInt(tp[1], 10) || 0, parseInt(tp[2], 10) || 0).getTime() || 0;
            }
        }
        return 0;
    }

    function rescueFalselyClosedRecentJobs() {
        const cyc = new Date(); if (cyc.getHours() * 60 + cyc.getMinutes() < 30) cyc.setDate(cyc.getDate() - 1);
        const cycleThai = `${String(cyc.getDate()).padStart(2, '0')}/${String(cyc.getMonth() + 1).padStart(2, '0')}/${cyc.getFullYear() + 543}`;
        const now = new Date(), calThai = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear() + 543}`;
        const closedMap = readClosedReg();
        let mapChanged = false, outagesChanged = false;
        const localOutages = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]');
        localOutages.forEach(item => {
            const dStr = normalizeThaiDateStr((item.reportDate && item.reportDate !== '-') ? item.reportDate : (item.dateTimeSaved || ''));
            if ((dStr === cycleThai || dStr === calThai) && isAutoGeneratedFakeClosure(item.techReport)) {
                delete item.techReport; outagesChanged = true;
                if (closedMap[item.dateTimeSaved] && isAutoGeneratedFakeClosure(closedMap[item.dateTimeSaved])) { delete closedMap[item.dateTimeSaved]; mapChanged = true; }
            }
        });
        Object.keys(closedMap).forEach(k => {
            const normKDate = normalizeThaiDateStr(k);
            if ((normKDate === cycleThai || normKDate === calThai) && isAutoGeneratedFakeClosure(closedMap[k])) { delete closedMap[k]; mapChanged = true; }
        });
        if (outagesChanged) localStorage.setItem('elecReportsComplete_all', JSON.stringify(localOutages));
        if (mapChanged) writeClosedReg(closedMap);
    }

    function getNormalizedReportPhotos(tr) {
        if (!tr || typeof tr !== 'object') return [];
        if (Array.isArray(tr.photos) && tr.photos.length > 0) return tr.photos.filter(p => p && (p.viewUrl || p.thumbUrl || p.pendingDataUrl));
        if (Array.isArray(tr.photoUrls) && tr.photoUrls.length > 0) {
            return tr.photoUrls.filter(Boolean).map(u => {
                const idM = String(u).match(/\/d\/([A-Za-z0-9_-]{15,})|[?&]id=([A-Za-z0-9_-]{15,})/);
                const fid = idM ? (idM[1] || idM[2]) : '';
                return { id: fid, viewUrl: u, thumbUrl: fid ? `https://drive.google.com/thumbnail?id=${fid}&sz=w1000` : u };
            });
        }
        return [];
    }

    function formatTechPhotosTextLines(tr) {
        const urls = getNormalizedReportPhotos(tr).map(p => p.viewUrl).filter(Boolean);
        if (urls.length === 0) return '';
        if (urls.length === 1) return `\n📷 ภาพหน้างาน : ${urls[0]}`;
        return urls.map((u, idx) => `\n📷 ภาพหน้างาน (${idx + 1}) : ${u}`).join('');
    }

    function normalizeJobGpsAndReportText(storageKey, isFault) {
        try {
            const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
            let changed = false;
            list.forEach(item => {
                if (!item) return;
                const cleanGrp = normTechGrp(getJobGroupName(item) || 'กฟส.บึง') || 'กฟส.บึง';
                if (item.ownerGroup !== cleanGrp) { item.ownerGroup = cleanGrp; changed = true; }
                const normGps = normalizeCoordPairToMapsUrl(item.gps);
                if (normGps && normGps !== item.gps) { item.gps = normGps; changed = true; }
                const tr = item.techReport;
                if (tr?.status && tr.status !== 'รอแก้ไข') {
                    if (tr.fieldGps && tr.fieldGps !== '-') {
                        const normFieldGps = normalizeCoordPairToMapsUrl(tr.fieldGps);
                        if (normFieldGps !== tr.fieldGps) { tr.fieldGps = normFieldGps; changed = true; }
                        const edMs = item.editedAt ? (new Date(item.editedAt).getTime() || 0) : 0;
                        const trMs = tr.updatedAt ? (new Date(tr.updatedAt).getTime() || 0) : 0;
                        if ((!item.gps || item.gps === '-' || trMs >= edMs) && item.gps !== tr.fieldGps) {
                            item.gps = tr.fieldGps; changed = true;
                        }
                    }
                    const urg = getJobUrgencyInfo(item, isFault ? 'fault' : 'outage');
                    const hdr = !isFault ? `${urg.dot} งานที่ ${item.jobNo || '-'} กะ ${item.shift || '-'} (${item.issueType || '-'})` : `${urg.dot} วงจร ${item.circuit || '-'} สถานี${item.station || '-'} (${item.system || '-'})`;
                    const gpsLine = tr.fieldGps ? `\n📍 พิกัดหน้างาน : ${tr.fieldGps}` : '';
                    const photoLines = formatTechPhotosTextLines(tr);
                    const techText = `--- 🛠️ ผลตรวจสอบหน้างาน ---\n${hdr}\n🚦 สถานะ : ${tr.status}\n🔍 สาเหตุจริง : ${tr.realCause || '-'}\n🛠️ การแก้ไข : ${tr.actionTaken || '-'}\n⏰ เวลาเสร็จ : ${tr.finishTime || '-'}\n👷 ผู้ตรวจสอบ : ${tr.inspector || '-'}${gpsLine}${photoLines}`;
                    const baseText = (item.formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0];
                    const full = `${baseText}\n\n${techText}`;
                    if (item.formattedText !== full) { item.formattedText = full; changed = true; }
                } else if (item.formattedText && item.formattedText.includes('--- 🛠️ ผลตรวจสอบหน้างาน ---')) {
                    item.formattedText = item.formattedText.split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0]; changed = true;
                }
            });
            if (changed) localStorage.setItem(storageKey, JSON.stringify(list));
        } catch (e) {}
    }

    function mergeCloudJobsToLocal(cloudJobs, pruneStale = false) {
        Core.cleanReopenedAndCancelledJobsInStorage();
        rescueFalselyClosedRecentJobs();
        const delReg = getDeletedJobsRegistry(), closedMap = readClosedReg(), localJobCancelMap = getCancelledJobNavMap();
        const now = Date.now(), isAdmin = isCurrentUserAdmin();

        const mergeItem = (existing, cJob) => {
            const normCloud = { ...cJob, ownerGroup: normTechGrp(getJobGroupName(cJob) || 'กฟส.บึง') || 'กฟส.บึง' };
            if (normCloud.techReport && isAutoGeneratedFakeClosure(normCloud.techReport)) delete normCloud.techReport;
            if (!existing) {
                const jk0 = normCloud.jobType === 'fault' ? normCloud.timestamp : normCloud.dateTimeSaved;
                const cIso0 = (jk0 && localJobCancelMap[jk0]) || normCloud.navCancelledAt || '';
                if (cIso0 && normCloud.techNav && (!normCloud.techNav.updatedAt || cIso0 >= normCloud.techNav.updatedAt)) { delete normCloud.techNav; normCloud.navCancelledAt = cIso0; }
                if (normCloud.techReport) delete normCloud.techReport.needsMainSync;
                if (normCloud.techNav) delete normCloud.techNav.needsMainSync;
                delete normCloud.pendingInitialUpload;
                return normCloud;
            }
            if (existing.techReport && isAutoGeneratedFakeClosure(existing.techReport)) delete existing.techReport;

            const jobKey = normCloud.jobType === 'fault' ? normCloud.timestamp : normCloud.dateTimeSaved;
            const cRepNewerOrEq = (normCloud.techReport?.updatedAt || '') >= (existing.techReport?.updatedAt || '');
            let bestReport = cRepNewerOrEq ? (normCloud.techReport ? { ...normCloud.techReport } : existing.techReport) : existing.techReport;
            if (cRepNewerOrEq && normCloud.techReport && bestReport) delete bestReport.needsMainSync;
            if (!bestReport && jobKey && closedMap[jobKey] && !isAutoGeneratedFakeClosure(closedMap[jobKey])) bestReport = closedMap[jobKey];

            const latestReopen = (normCloud.reopenedAt || '') >= (existing.reopenedAt || '') ? (normCloud.reopenedAt || '') : (existing.reopenedAt || '');
            if (latestReopen && (!bestReport?.updatedAt || latestReopen > bestReport.updatedAt)) { bestReport = undefined; if (jobKey) delete closedMap[jobKey]; }

            const recentCancel = jobKey ? recentlyCancelledNavKeys.get(jobKey) : null;
            const regCancelIso = jobKey ? (localJobCancelMap[jobKey] || '') : '';
            let latestCancel = [normCloud.navCancelledAt || '', existing.navCancelledAt || '', regCancelIso].sort().pop() || '';
            if (recentCancel && (now - recentCancel.ts < 8000) && recentCancel.iso > latestCancel) latestCancel = recentCancel.iso;

            const cNavNewerOrEq = (normCloud.techNav?.updatedAt || '') >= (existing.techNav?.updatedAt || '');
            let bestNav = cNavNewerOrEq ? (normCloud.techNav ? { ...normCloud.techNav } : existing.techNav) : existing.techNav;
            if (cNavNewerOrEq && normCloud.techNav && bestNav) delete bestNav.needsMainSync;

            const isNowDone = Boolean(bestReport && String(bestReport.status || '').includes('เสร็จสิ้น'));
            if (!isNowDone && bestReport && jobKey && closedMap[jobKey] && (!closedMap[jobKey].updatedAt || (bestReport.updatedAt || '') >= closedMap[jobKey].updatedAt)) {
                delete closedMap[jobKey];
            }
            if (isNowDone || (latestCancel && (!bestNav?.updatedAt || latestCancel >= bestNav.updatedAt)) || (bestReport?.updatedAt && (!bestNav?.updatedAt || bestReport.updatedAt >= bestNav.updatedAt))) {
                bestNav = undefined;
                if (jobKey && activeNavJobKey === jobKey) stopRealtimeGpsWatch(jobKey);
            }
            if (isNowDone && jobKey) closedMap[jobKey] = bestReport;

            const baseCore = (existing.editedAt || '') > (normCloud.editedAt || '') ? { ...normCloud, ...existing } : { ...existing, ...normCloud };
            const merged = { ...baseCore, ownerGroup: normTechGrp(getJobGroupName(baseCore) || 'กฟส.บึง') || 'กฟส.บึง', techReport: bestReport, reopenedAt: latestReopen || undefined, navCancelledAt: latestCancel || undefined };
            delete merged.pendingInitialUpload;
            if (!bestReport) delete merged.techReport;
            if (bestNav) merged.techNav = bestNav; else delete merged.techNav;
            return merged;
        };

        const outageMap = new Map(), faultMap = new Map();
        JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]').forEach(i => { if (i?.dateTimeSaved && !delReg[i.dateTimeSaved]) outageMap.set(i.dateTimeSaved, i); });
        JSON.parse(localStorage.getItem('fault_reports_all') || '[]').forEach(i => { if (i?.timestamp && !delReg[i.timestamp]) faultMap.set(i.timestamp, i); });

        const cloudOutKeys = new Set(), cloudFltKeys = new Set();
        (cloudJobs || []).forEach(cj => {
            if (!cj || cj.jobType === 'tech_loc' || !canCurrentUserSeeJob(cj)) return;
            if (cj.jobType === 'fault' && cj.timestamp && !delReg[cj.timestamp]) { cloudFltKeys.add(cj.timestamp); faultMap.set(cj.timestamp, mergeItem(faultMap.get(cj.timestamp), cj)); }
            else if (cj.jobType !== 'fault' && cj.dateTimeSaved && !delReg[cj.dateTimeSaved]) { cloudOutKeys.add(cj.dateTimeSaved); outageMap.set(cj.dateTimeSaved, mergeItem(outageMap.get(cj.dateTimeSaved), cj)); }
        });

        let outages = Array.from(outageMap.values()), faults = Array.from(faultMap.values());
        if (pruneStale) {
            const hasPendingPush = localStorage.getItem('elec_tech_has_pending_push') === 'true';
            outages = outages.filter(o => (isAdmin || canCurrentUserSeeJob(o)) && (cloudOutKeys.has(o.dateTimeSaved) || Boolean(o.pendingInitialUpload || (hasPendingPush && (o.techReport?.needsMainSync || o.techNav?.needsMainSync)) || (now - getJobCreatedTimeMs(o) < 120000))));
            faults = faults.filter(f => (isAdmin || canCurrentUserSeeJob(f)) && (cloudFltKeys.has(f.timestamp) || Boolean(f.pendingInitialUpload || (hasPendingPush && (f.techReport?.needsMainSync || f.techNav?.needsMainSync)) || (now - getJobCreatedTimeMs(f) < 120000))));
        }

        outages.sort((a, b) => getJobCreatedTimeMs(b) - getJobCreatedTimeMs(a));
        faults.sort((a, b) => getJobCreatedTimeMs(b) - getJobCreatedTimeMs(a));
        writeClosedReg(closedMap);
        localStorage.setItem('elecReportsComplete_all', JSON.stringify(outages.slice(0, 300)));
        localStorage.setItem('fault_reports_all', JSON.stringify(faults.slice(0, 300)));
        Core.cleanReopenedAndCancelledJobsInStorage();
        normalizeJobGpsAndReportText('elecReportsComplete_all', false);
        normalizeJobGpsAndReportText('fault_reports_all', true);
        verifyActiveJobNavWatchStillValid();
    }
    // ===== จบพาทที่ 1 / 2 ของไฟล์ tech-jobs.js =====
        // ===== เริ่มพาทที่ 2 / 3 ของไฟล์ tech-jobs.js (วางต่อจากพาทที่ 1) =====
    let lastPushedPinsSignature = '';
    const dirtyJobKeysForDelta = new Set();

    function markJobDirtyForPush(rawKey) {
        if (rawKey) dirtyJobKeysForDelta.add(String(rawKey));
        localStorage.setItem('elec_tech_has_pending_push', 'true');
    }

    function computeLocalPinsSignature() {
        return [
            localStorage.getItem('elec_labeled_places_list') || '[]',
            localStorage.getItem('elec_deleted_labeled_places_map') || '{}',
            localStorage.getItem('elec_deleted_equip_audit_logs') || '[]',
            localStorage.getItem('elec_cleared_audit_logs_ts') || '0'
        ].join('||');
    }

    const pushAllJobsToCloud = Core.createTrailingAsyncQueue(async function (forceWrite = false) {
        if (localStorage.getItem('elec_app_logged_in') !== 'true' || isViewerRole()) return false;
        const apiUrl = getActiveCloudApiUrl();
        if (!apiUrl || !navigator.onLine) return false;
        const myEpoch = authSessionEpoch;
        const myGrp = normTechGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';

        try {
            Core.cleanReopenedAndCancelledJobsInStorage();
            normalizeJobGpsAndReportText('elecReportsComplete_all', false);
            normalizeJobGpsAndReportText('fault_reports_all', true);

            const delReg = getDeletedJobsRegistry();
            const closedReg = readClosedReg();
            const jobCancelMap = getCancelledJobNavMap();
            const equipCancelMap = getEquipCancelMap();
            const nowIso = new Date().toISOString();

            const locMap = getTechLocationsMap();
            locMap[Core.REGISTRY_LOC_KEY] = {
                ...(locMap[Core.REGISTRY_LOC_KEY] || {}),
                isSystemRegistry: true,
                jobCancelMap: { ...(locMap[Core.REGISTRY_LOC_KEY]?.jobCancelMap || {}), ...jobCancelMap },
                equipCancelMap: { ...(locMap[Core.REGISTRY_LOC_KEY]?.equipCancelMap || {}), ...equipCancelMap },
                updatedAt: nowIso
            };
            localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));

            const upsertedJobs = [];
            const pushedSyncMeta = new Map();
            const collectDirty = (storageKey, jType) => {
                const kf = jType === 'fault' ? 'timestamp' : 'dateTimeSaved';
                const arr = JSON.parse(localStorage.getItem(storageKey) || '[]');
                arr.forEach(it => {
                    const rk = it?.[kf];
                    if (!rk || delReg[rk] || !canCurrentUserSeeJob(it)) return;
                    const isDirty = Boolean(
                        it.pendingInitialUpload ||
                        it.techReport?.needsMainSync ||
                        it.techNav?.needsMainSync ||
                        dirtyJobKeysForDelta.has(rk)
                    );
                    if (!isDirty) return;
                    const uk = (jType === 'fault' ? 'F_' : 'O_') + rk;
                    pushedSyncMeta.set(uk, {
                        rk,
                        repUpd: it.techReport?.updatedAt || '',
                        navUpd: it.techNav?.updatedAt || ''
                    });
                    const cleanCopy = {
                        ...it,
                        jobType: jType,
                        ownerGroup: normTechGrp(getJobGroupName(it) || myGrp) || myGrp
                    };
                    delete cleanCopy.pendingInitialUpload;
                    if (cleanCopy.techReport) {
                        cleanCopy.techReport = { ...cleanCopy.techReport };
                        delete cleanCopy.techReport.needsMainSync;
                    }
                    if (cleanCopy.techNav) {
                        cleanCopy.techNav = { ...cleanCopy.techNav };
                        delete cleanCopy.techNav.needsMainSync;
                    }
                    upsertedJobs.push(cleanCopy);
                });
            };
            collectDirty('elecReportsComplete_all', 'outage');
            collectDirty('fault_reports_all', 'fault');

            const canPushPins = canCurrentUserEditScada() && !Core.simSandbox?.active;
            const curPinsSig = canPushPins ? computeLocalPinsSignature() : '';
            const pinsChanged = Boolean(canPushPins && lastPushedPinsSignature && curPinsSig !== lastPushedPinsSignature);
            const explicitPinsDirty = localStorage.getItem('elec_scada_pins_dirty') === 'true';
            const shouldSendPins = Boolean(canPushPins && (pinsChanged || explicitPinsDirty));

            const techLocDelta = {
                id: 'TECH_LOC_REGISTRY',
                jobType: 'tech_loc',
                dateTimeSaved: 'TECH_LOC_REGISTRY',
                techLocations: locMap,
                closedJobsMap: closedReg,
                closedReports: closedReg,
                deletedJobsMap: delReg,
                _keepPins: !shouldSendPins,
                _keepDelPins: !shouldSendPins,
                _keepAuditLogs: !shouldSendPins,
                _keepBackups: true,
                updatedAt: nowIso
            };

            if (shouldSendPins) {
                techLocDelta.electricEquipmentPins = JSON.parse(localStorage.getItem('elec_labeled_places_list') || '[]');
                techLocDelta.deletedElectricEquipmentMap = JSON.parse(localStorage.getItem('elec_deleted_labeled_places_map') || '{}');
                techLocDelta.deletedEquipAuditLogs = JSON.parse(localStorage.getItem('elec_deleted_equip_audit_logs') || '[]');
                techLocDelta.clearedAuditLogsTimestamp = parseInt(localStorage.getItem('elec_cleared_audit_logs_ts') || '0', 10) || 0;
            }
                        const isPureHeartbeat = !forceWrite && upsertedJobs.length === 0 && !shouldSendPins && localStorage.getItem('elec_tech_has_pending_push') !== 'true';
            if (forceWrite || upsertedJobs.length > 0 || shouldSendPins) Core.unlockCloudWrite(20000);
            
            const bodyPayloadStr = JSON.stringify({
                action: 'patchDelta',
                group: isCurrentUserAdmin() ? (normTechGrp(localStorage.getItem('elec_app_current_group') || '') || '') : myGrp,
                ramOnly: isPureHeartbeat,
                forceSheetWrite: Boolean(forceWrite && (upsertedJobs.length > 0 || shouldSendPins)),
                upsertedJobs,
                removedJobKeys: Object.keys(delReg),
                techLocDelta
            });
            const useKeepalive = Boolean(!shouldSendPins && upsertedJobs.length <= 3 && new Blob([bodyPayloadStr]).size < 55000);
            
            const res = await fetch(apiUrl, {
                method: 'POST',
                keepalive: useKeepalive,
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: bodyPayloadStr
            });
            const data = await res.json();
            if (myEpoch === authSessionEpoch && data?.status === 'ok' && !data?.skippedBusyRam && data?.patched !== false) {
                clearSyncedFlagsInLocalJobs(pushedSyncMeta);
                pushedSyncMeta.forEach(meta => dirtyJobKeysForDelta.delete(meta.rk));
                if (shouldSendPins) {
                    lastPushedPinsSignature = curPinsSig;
                    localStorage.removeItem('elec_scada_pins_dirty');
                }
                if (dirtyJobKeysForDelta.size === 0) {
                    localStorage.removeItem('elec_tech_has_pending_push');
                }
                return true;
            }
            return false;
        } catch (err) {
            return false;
        }
    });

    async function syncJobsFromCloud(isSilent = true) {
        if (isSyncingNow || localStorage.getItem('elec_app_logged_in') !== 'true') return false;
        const apiUrl = getActiveCloudApiUrl();
        if (!apiUrl) return false;

        const statusEl = document.getElementById('cloudStatusText');
        if (!isSilent && statusEl) statusEl.textContent = '⏳ กำลังซิงค์ข้อมูลใบงานล่าสุด...';
        if (!isSilent) Core.forceCloudRead();

        isSyncingNow = true;
        const myEpoch = authSessionEpoch;
        try {
            const res = await fetch(apiUrl + (apiUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
            const data = await res.json();
            if (myEpoch !== authSessionEpoch || localStorage.getItem('elec_app_logged_in') !== 'true') return false;

            if (Array.isArray(data?.users) && data.users.length > 0) {
                localStorage.setItem('elec_user_accounts', JSON.stringify(data.users.map(parseAccountRecord)));
                updateRoleNavigationUI();
            }

            if (Array.isArray(data?.jobs)) {
                cachedCloudJobs = data.jobs;
                hasLoadedCloudBaseline = true;
                const locEntry = data.jobs.find(j => j && (j.jobType === 'tech_loc' || j.dateTimeSaved === 'TECH_LOC_REGISTRY'));

                if (locEntry) {
                    const cloudJobCancel = locEntry.techLocations?.[Core.REGISTRY_LOC_KEY]?.jobCancelMap;
                    if (cloudJobCancel && typeof cloudJobCancel === 'object') {
                        const mergedJC = { ...getCancelledJobNavMap() };
                        Object.entries(cloudJobCancel).forEach(([jk, iso]) => {
                            if (iso && (!mergedJC[jk] || String(iso) > String(mergedJC[jk]))) mergedJC[jk] = iso;
                        });
                        saveCancelledJobNavMap(mergedJC);
                    }
                    const cloudEqCancel = locEntry.techLocations?.[Core.REGISTRY_LOC_KEY]?.equipCancelMap;
                    if (cloudEqCancel && typeof cloudEqCancel === 'object') {
                        const mergedEC = { ...getEquipCancelMap() };
                        Object.entries(cloudEqCancel).forEach(([ek, ts]) => {
                            const nTs = Number(ts || 0);
                            if (nTs > Number(mergedEC[ek] || 0)) mergedEC[ek] = nTs;
                        });
                        saveEquipCancelMap(mergedEC);
                    }

                    if (locEntry.techLocations) {
                        mergeTechLocationsMap(locEntry.techLocations);
                        syncEquipNavFromTechLocations(locEntry.techLocations);
                    }
                    if (locEntry.closedJobsMap || locEntry.closedReports) {
                        writeClosedReg({ ...readClosedReg(), ...(locEntry.closedJobsMap || {}), ...(locEntry.closedReports || {}) });
                    }
                    if (locEntry.deletedJobsMap && typeof locEntry.deletedJobsMap === 'object') {
                        const delReg = { ...getDeletedJobsRegistry(), ...locEntry.deletedJobsMap };
                        Core.rawStorageSet('elec_deleted_jobs_registry', JSON.stringify(delReg));
                    }
                    if (locEntry.cloudGroupBackups && typeof locEntry.cloudGroupBackups === 'object') {
                        const prevBk = JSON.parse(localStorage.getItem('elec_cloud_group_backups_map') || '{}');
                        localStorage.setItem('elec_cloud_group_backups_map', JSON.stringify({ ...prevBk, ...locEntry.cloudGroupBackups }));
                    }

                    if (!Core.simSandbox?.active) {
                        const cloudClearedTs = Number(locEntry.clearedAuditLogsTimestamp || 0);
                        const localClearedTs = parseInt(localStorage.getItem('elec_cleared_audit_logs_ts') || '0', 10) || 0;
                        const effClearedTs = Math.max(cloudClearedTs, localClearedTs);
                        if (effClearedTs > localClearedTs) localStorage.setItem('elec_cleared_audit_logs_ts', String(effClearedTs));

                        if (Array.isArray(locEntry.electricEquipmentPins)) {
                            const prevPinsStr = localStorage.getItem('elec_labeled_places_list') || '[]';
                            const delEq = {
                                ...JSON.parse(localStorage.getItem('elec_deleted_labeled_places_map') || '{}'),
                                ...(locEntry.deletedElectricEquipmentMap || {})
                            };
                            localStorage.setItem('elec_deleted_labeled_places_map', JSON.stringify(delEq));

                            const pMap = new Map();
                            JSON.parse(prevPinsStr).forEach(p => {
                                if (p?.id && !(delEq[p.id] && (new Date(p.updatedAt || 0).getTime() || 0) <= (new Date(delEq[p.id]).getTime() || 0))) {
                                    pMap.set(p.id, p);
                                }
                            });
                            locEntry.electricEquipmentPins.forEach(cp => {
                                if (!cp?.id || (delEq[cp.id] && (new Date(cp.updatedAt || 0).getTime() || 0) <= (new Date(delEq[cp.id]).getTime() || 0))) return;
                                const ex = pMap.get(cp.id);
                                if (!ex || (cp.updatedAt || '') > (ex.updatedAt || '') || ((cp.updatedAt || '') === (ex.updatedAt || '') && JSON.stringify(cp) !== JSON.stringify(ex))) {
                                    pMap.set(cp.id, cp);
                                }
                            });
                            const nextPinsStr = JSON.stringify(Array.from(pMap.values()));
                            if (nextPinsStr !== prevPinsStr) {
                                localStorage.setItem('elec_labeled_places_list', nextPinsStr);
                                if (typeof window.__onScadaPinsSynced === 'function') window.__onScadaPinsSynced();
                            }
                            if (!lastPushedPinsSignature && canCurrentUserEditScada()) {
                                lastPushedPinsSignature = computeLocalPinsSignature();
                            }
                        }

                        if (Array.isArray(locEntry.deletedEquipAuditLogs)) {
                            const logMap = new Map();
                            [...JSON.parse(localStorage.getItem('elec_deleted_equip_audit_logs') || '[]'), ...locEntry.deletedEquipAuditLogs].forEach(l => {
                                if (l?.logId && !(effClearedTs > 0 && (new Date(l.deletedAt || 0).getTime() || 0) <= effClearedTs)) {
                                    logMap.set(l.logId, l);
                                }
                            });
                            localStorage.setItem('elec_deleted_equip_audit_logs', JSON.stringify(Array.from(logMap.values())));
                        }
                    }
                }

                mergeCloudJobsToLocal(data.jobs, true);
                checkNewIncomingPendingJobs();
                renderJobCards();
                updateEquipNavFloatingBanner();
                updateTechOnlineCountUI();
                setTimeout(upgradeRepairJobsShortLinks, 400);

                if (statusEl) {
                    const tNow = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
                    statusEl.textContent = `🟢 ซิงค์ข้อมูลล่าสุดเรียบร้อย (${tNow} น.)`;
                }
                if (!isSilent) showToast('🔄 ซิงค์ใบงานและสถานะล่าสุดสำเร็จ!');

                if (localStorage.getItem('elec_tech_has_pending_push') === 'true' && !isViewerRole()) {
                    setTimeout(() => pushAllJobsToCloud(true), 250);
                }
                return true;
            }
        } catch (err) {
            if (statusEl && !isSilent) statusEl.textContent = '⚠️ ออฟไลน์ / เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (แสดงข้อมูลในเครื่อง)';
            if (!isSilent) showToast('⚠️ ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ในขณะนี้');
        } finally {
            isSyncingNow = false;
        }
        return false;
    }

    // ========================================================================
    // 6. ระบบนำทางไปหมุดอุปกรณ์ไฟฟ้า (Equipment Navigation Sync หน้าช่าง <-> หน้าหลัก)
    // ========================================================================
    function normalizeEquipTechKey(name, grpOpt) {
        const b = getUserBaseId(name);
        const g = normTechGrp(grpOpt || getUserGroupName(name) || getCurrentUserGroup() || 'กฟส.บึง').replace(/\s+/g, '_');
        return b ? `equip_nav_${g}_${b.replace(/\s+/g, '_')}` : `equip_nav_${g}_guest`;
    }

    function getEquipCancelMap() {
        try { return pruneNavCancelMap(JSON.parse(localStorage.getItem(CANCELLED_EQUIP_NAV_KEY) || '{}'), false); } catch (e) { return {}; }
    }
    function saveEquipCancelMap(m) {
        localStorage.setItem(CANCELLED_EQUIP_NAV_KEY, JSON.stringify(pruneNavCancelMap(m, false)));
    }

    function getNavStampMs(nv) {
        if (!nv) return 0;
        return Math.max(Number(nv.departTimestamp || 0) || 0, new Date(nv.updatedAt || 0).getTime() || 0, Number(nv.cancelledAtMs || 0) || 0);
    }

    function syncEquipNavFromTechLocations(locsObj) {
        if (!locsObj || typeof locsObj !== 'object' || isStoppingEquipNavInternal) return;
        if (Date.now() - lastLocalEquipNavStartMs < 4000) return;
        const navMap = JSON.parse(localStorage.getItem(EQUIP_NAV_STORAGE_KEY) || '{}');
        const cancelMap = getEquipCancelMap();
        let changed = false;

        Object.entries(locsObj).forEach(([uK, loc]) => {
            if (isSysRegistryLoc(uK, loc) || !loc?.activeEquipNav) return;
            const incNav = loc.activeEquipNav;
            const nk = incNav.id || normalizeEquipTechKey(incNav.techName || uK, incNav.ownerGroup || loc.group);
            const exNav = navMap[nk];
            const incMs = getNavStampMs(incNav);
            const exMs = getNavStampMs(exNav);
            const cMs = Math.max(Number(cancelMap[nk] || 0), Number(cancelMap[incNav.techName] || 0), Number(incNav.cancelledAtMs || 0));

            if (incNav.isTraveling === false || cMs >= incMs) {
                if (navMap[nk]) { delete navMap[nk]; changed = true; }
                if (cMs > Number(cancelMap[nk] || 0)) { cancelMap[nk] = cMs; saveEquipCancelMap(cancelMap); }
            } else if (!exNav || incMs >= exMs) {
                navMap[nk] = { ...incNav, id: nk };
                changed = true;
            }
        });
        if (changed) localStorage.setItem(EQUIP_NAV_STORAGE_KEY, JSON.stringify(navMap));
    }

    function canUserControlNavigation(techName) {
        if (isViewerRole()) return false;
        if (isCurrentUserAdmin()) return true;
        const curUser = localStorage.getItem('elec_app_current_user') || '';
        return Boolean(curUser && techName && isSameTechPerson(curUser, techName));
    }

    function getActiveEquipmentNavItems() {
        const locMap = getTechLocationsMap();
        const navMap = JSON.parse(localStorage.getItem(EQUIP_NAV_STORAGE_KEY) || '{}');
        const cancelMap = { ...getEquipCancelMap(), ...(locMap[Core.REGISTRY_LOC_KEY]?.equipCancelMap || {}) };
        const myGrp = normTechGrp(getCurrentUserGroup() || 'กฟส.บึง');
        const admin = isCurrentUserAdmin();
        const now = Date.now();

        Object.entries(locMap).forEach(([uK, obj]) => {
            if (!isSysRegistryLoc(uK, obj) && obj?.activeEquipNav?.isTraveling) {
                const nk = obj.activeEquipNav.id || normalizeEquipTechKey(obj.activeEquipNav.techName || uK, obj.activeEquipNav.ownerGroup || obj.group);
                if (!navMap[nk] || getNavStampMs(obj.activeEquipNav) >= getNavStampMs(navMap[nk])) {
                    navMap[nk] = { ...obj.activeEquipNav, id: nk };
                }
            }
        });

        return Object.values(navMap).filter(n => {
            if (!n || !n.isTraveling) return false;
            const legacyKey = 'equip_nav_' + (getUserBaseId(n.techName || '') || 'guest').replace(/\s+/g, '_');
            const tMs = getNavStampMs(n);
            const cMs = Math.max(Number(cancelMap[n.id] || 0), Number(cancelMap[legacyKey] || 0), Number(cancelMap[n.techName] || 0), Number(n.cancelledAtMs || 0));
            if (cMs >= tMs || (now - tMs > MAX_EQUIP_NAV_AGE_MS)) return false;
            return admin || !myGrp || !n.ownerGroup || myGrp === normTechGrp(n.ownerGroup);
        });
    }

    async function startEquipmentNavigation(pinOrId, placeTitleOpt, latOpt, lonOpt, gpsUrlOpt) {
        let placeId = '', placeTitle = '', destLat = NaN, destLon = NaN, extUrl = '', ownerGrp = '';
        if (pinOrId && typeof pinOrId === 'object') {
            placeId = pinOrId.id || '';
            placeTitle = pinOrId.name || pinOrId.placeTitle || 'หมุดอุปกรณ์ไฟฟ้า';
            destLat = parseFloat(pinOrId.lat);
            destLon = parseFloat(pinOrId.lon);
            ownerGrp = pinOrId.ownerGroup || '';
            extUrl = pinOrId.gpsUrl || (!isNaN(destLat) && !isNaN(destLon) ? `https://www.google.com/maps?q=${destLat.toFixed(6)},${destLon.toFixed(6)}` : '');
        } else {
            placeId = String(pinOrId || '');
            placeTitle = String(placeTitleOpt || 'หมุดอุปกรณ์ไฟฟ้า');
            destLat = parseFloat(latOpt);
            destLon = parseFloat(lonOpt);
            extUrl = gpsUrlOpt || (!isNaN(destLat) && !isNaN(destLon) ? `https://www.google.com/maps?q=${destLat.toFixed(6)},${destLon.toFixed(6)}` : '');
        }

        if (isViewerRole()) {
            if (extUrl) window.open(extUrl, '_blank');
            else showToast(VIEWER_LOCK_MSG);
            return;
        }

        lastLocalEquipNavStartMs = Date.now();
        Core.unlockCloudWrite(20000);
        const curUser = normalizeUsernameFormat(localStorage.getItem('elec_app_current_user') || 'ช่างหน้างาน');
        const grp = normTechGrp(ownerGrp || getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
        const scopedKey = normalizeEquipTechKey(curUser, grp);
        const legacyKey = 'equip_nav_' + (getUserBaseId(curUser) || 'guest').replace(/\s+/g, '_');

        const cancelMap = getEquipCancelMap();
        const prevCancelMs = Math.max(Number(cancelMap[scopedKey] || 0), Number(cancelMap[legacyKey] || 0), Number(cancelMap[curUser] || 0));
        [scopedKey, legacyKey, curUser].forEach(k => delete cancelMap[k]);
        saveEquipCancelMap(cancelMap);

        const now = new Date();
        const safeStartMs = Math.max(now.getTime(), prevCancelMs + 2000);
        const departStr = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')} น.`;
        let route = { distanceKm: '4.0', durationMin: 10, isArrived: false };
        if (isGpsTrackingEnabled && lastKnownTechCoords && !isNaN(destLat) && !isNaN(destLon)) {
            route = calculateInstantRouteFallback(lastKnownTechCoords, { lat: destLat, lon: destLon });
            if (route.isArrived) route = { distanceKm: '0.5', durationMin: 2, isArrived: false };
        }
        const etaMs = safeStartMs + route.durationMin * 60000, etaD = new Date(etaMs);
        const etaStr = `${String(etaD.getHours()).padStart(2, '0')}.${String(etaD.getMinutes()).padStart(2, '0')} น.`;

        const navObj = {
            id: scopedKey,
            placeId,
            placeTitle,
            placeName: placeTitle,
            techName: curUser,
            ownerGroup: grp,
            isTraveling: true,
            destLat: !isNaN(destLat) ? destLat : null,
            destLon: !isNaN(destLon) ? destLon : null,
            distanceKm: route.distanceKm,
            initialDistanceKm: route.distanceKm,
            durationMin: route.durationMin,
            departTime: departStr,
            departTimestamp: safeStartMs,
            etaTime: etaStr,
            etaTimestamp: etaMs,
            isArrived: false,
            updatedAt: new Date(safeStartMs).toISOString()
        };

        const navMap = JSON.parse(localStorage.getItem(EQUIP_NAV_STORAGE_KEY) || '{}');
        navMap[scopedKey] = navObj;
        localStorage.setItem(EQUIP_NAV_STORAGE_KEY, JSON.stringify(navMap));

        const locMap = getTechLocationsMap();
        if (!locMap[curUser]) locMap[curUser] = { username: curUser, group: grp, isOnline: true };
        locMap[curUser].activeEquipNav = navObj;
        locMap[curUser].updatedAt = navObj.updatedAt;
        if (locMap[Core.REGISTRY_LOC_KEY]?.equipCancelMap) {
            [scopedKey, legacyKey, curUser].forEach(k => delete locMap[Core.REGISTRY_LOC_KEY].equipCancelMap[k]);
        }
        localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
        localStorage.setItem('elec_tech_has_pending_push', 'true');

        requestScreenWakeLock();
        updateEquipNavFloatingBanner();
        if (extUrl) window.open(extUrl, '_blank');
        showToast(`🚗 เริ่มเดินทางไปอุปกรณ์: ${placeTitle}`);
        await pushAllJobsToCloud(true);
    }

    async function stopEquipmentNavigation(targetKeyOpt, isArrived = true) {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        isStoppingEquipNavInternal = true;
        try {
            Core.unlockCloudWrite(20000);
            const curUser = normalizeUsernameFormat(localStorage.getItem('elec_app_current_user') || '');
            const navMap = JSON.parse(localStorage.getItem(EQUIP_NAV_STORAGE_KEY) || '{}');
            const cancelMap = getEquipCancelMap();
            const locMap = getTechLocationsMap();

            const matched = (targetKeyOpt && navMap[targetKeyOpt]) ||
                Object.values(navMap).find(n => n && ((targetKeyOpt && (n.id === targetKeyOpt || isSameTechPerson(n.techName, targetKeyOpt))) || (!targetKeyOpt && isSameTechPerson(n.techName, curUser))));
            const techName = normalizeUsernameFormat(matched?.techName || (targetKeyOpt && !String(targetKeyOpt).startsWith('equip_nav_') ? targetKeyOpt : curUser));
            const grp = normTechGrp(matched?.ownerGroup || getUserGroupName(techName) || getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
            const scopedKey = (targetKeyOpt && String(targetKeyOpt).startsWith('equip_nav_')) ? targetKeyOpt : normalizeEquipTechKey(techName, grp);
            const legacyKey = techName ? ('equip_nav_' + (getUserBaseId(techName) || 'guest').replace(/\s+/g, '_')) : '';

            const prevMs = getNavStampMs(matched);
            const safeMs = Math.max(Date.now() + 1000, prevMs + 1000);
            const safeIso = new Date(safeMs).toISOString();

            [targetKeyOpt, techName, scopedKey, legacyKey].filter(Boolean).forEach(k => {
                cancelMap[k] = safeMs;
                delete navMap[k];
            });
            Object.keys(navMap).forEach(k => {
                if (techName && isSameTechPerson(navMap[k]?.techName, techName)) {
                    cancelMap[k] = safeMs;
                    delete navMap[k];
                }
            });

            Object.keys(locMap).forEach(uK => {
                if (isSysRegistryLoc(uK, locMap[uK])) return;
                if ((techName && isSameTechPerson(uK, techName)) || locMap[uK]?.activeEquipNav?.id === scopedKey) {
                    locMap[uK].activeEquipNav = {
                        id: scopedKey,
                        techName: techName || uK,
                        ownerGroup: grp,
                        isTraveling: false,
                        status: isArrived ? 'arrived' : 'cancelled',
                        cancelledAtMs: safeMs,
                        updatedAt: safeIso
                    };
                    locMap[uK].updatedAt = safeIso;
                }
            });
            locMap[Core.REGISTRY_LOC_KEY] = {
                ...(locMap[Core.REGISTRY_LOC_KEY] || {}),
                isSystemRegistry: true,
                equipCancelMap: { ...(locMap[Core.REGISTRY_LOC_KEY]?.equipCancelMap || {}), ...cancelMap },
                updatedAt: safeIso
            };

            saveEquipCancelMap(cancelMap);
            localStorage.setItem(EQUIP_NAV_STORAGE_KEY, JSON.stringify(navMap));
            localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
            localStorage.setItem('elec_tech_has_pending_push', 'true');

            releaseScreenWakeLockIfIdle();
            updateEquipNavFloatingBanner();
            showToast(isArrived ? '✅ ถึงจุดติดตั้งอุปกรณ์เรียบร้อยแล้ว' : '↩️ ยกเลิกการเดินทางไปอุปกรณ์แล้ว');
            await pushAllJobsToCloud(true);
        } finally {
            isStoppingEquipNavInternal = false;
        }
    }

    function updateEquipNavFloatingBanner() {
        let banner = document.getElementById('pea-equip-nav-banner');
        if (localStorage.getItem('elec_app_logged_in') !== 'true') {
            if (banner) banner.style.display = 'none';
            return;
        }
        const activeList = getActiveEquipmentNavItems();
        if (activeList.length === 0) {
            if (banner) banner.style.display = 'none';
            return;
        }
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'pea-equip-nav-banner';
            banner.className = 'mx-3.5 sm:mx-4 mt-2.5 space-y-2';
            const anchor = document.getElementById('jobCardsContainer');
            if (anchor?.parentElement) anchor.parentElement.insertBefore(banner, anchor);
        }
        banner.style.display = 'block';
        banner.innerHTML = activeList.map(n => {
            const safeId = escJsAttr(n.id || n.techName || '');
            const canCtrl = canUserControlNavigation(n.techName);
            return `<div class="p-3 rounded-xl border-2 border-sky-400 bg-sky-50 shadow-sm text-xs space-y-1.5">
                <div class="flex justify-between items-center gap-2 font-bold text-sky-950">
                    <span class="truncate">⚡ เดินทางไปอุปกรณ์: ${escapeHtmlStr(n.placeTitle || n.placeName || 'อุปกรณ์ไฟฟ้า')}</span>
                    <span class="text-[10px] bg-sky-200/80 text-sky-900 px-2 py-0.5 rounded shrink-0">ถึง ~${escapeHtmlStr(n.etaTime || '-')}</span>
                </div>
                <div class="p-2 bg-white border border-sky-200 rounded-lg text-[11px]">${formatRealtimeNavHtml(n)}</div>
                ${canCtrl ? `<div class="flex justify-end gap-1.5 pt-0.5">
                    <button type="button" onclick="stopEquipmentNavigation('${safeId}', false)" class="bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 px-2.5 py-1 rounded-lg text-[11px] font-bold">❌ ยกเลิกเดินทาง</button>
                    <button type="button" onclick="stopEquipmentNavigation('${safeId}', true)" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1 rounded-lg text-[11px] font-bold shadow-sm">✅ ถึงอุปกรณ์แล้ว</button>
                </div>` : ''}
            </div>`;
        }).join('');
    }

    // ========================================================================
    // 7. แผนที่รวมจุดงานซ่อม (Repair Jobs Map) & คลายลิงก์สั้นอัตโนมัติ
    // ========================================================================
    function ensureRepairJobsMapBox() {
        if (Core.isEmbeddedIframe) return null;
        let wrap = document.getElementById('repairJobsMapWrapper');
        if (wrap) return wrap;
        const cardsBox = document.getElementById('jobCardsContainer');
        if (!cardsBox || !cardsBox.parentElement) return null;

        wrap = document.createElement('div');
        wrap.id = 'repairJobsMapWrapper';
        wrap.className = 'mx-3.5 sm:mx-4 mt-2 mb-1 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden';
        wrap.innerHTML = `
            <div class="px-3 py-2 bg-slate-800 text-white flex flex-wrap items-center justify-between gap-1.5 text-xs">
                <div class="font-bold flex items-center gap-1.5">
                    <span>🗺️ แผนที่จุดเกิดเหตุใบงาน</span>
                    <span id="repairMapPinCountBadge" class="bg-teal-500/30 border border-teal-400/40 text-teal-200 text-[10px] px-2 py-0.5 rounded-full">0 จุด</span>
                </div>
                <div class="flex items-center gap-1">
                    <button type="button" id="toggleRepairTooltipsBtn" onclick="toggleRepairJobTooltips()" class="bg-slate-700 hover:bg-slate-600 text-slate-100 px-2 py-1 rounded-lg text-[10px] font-bold">🏷️ ป้ายชื่อ</button>
                    <button type="button" id="toggleRepairMapFullBtn" onclick="toggleRepairJobsMapFullscreen()" class="bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded-lg text-[10px] font-bold">⛶ ขยายเต็มจอ</button>
                    <button type="button" id="toggleRepairMapCollapseBtn" onclick="toggleRepairJobsMapCollapse()" class="bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1 rounded-lg text-[10px] font-bold">🔼 ย่อแผนที่</button>
                </div>
            </div>
            <div id="repairJobsMapCanvas" class="w-full h-56 sm:h-64 bg-slate-100 relative z-10"></div>`;
        cardsBox.parentElement.insertBefore(wrap, cardsBox);
        return wrap;
    }

    function initRepairJobsMap() {
        if (Core.isEmbeddedIframe || typeof L === 'undefined') return null;
        if (repairJobsMap) return repairJobsMap;
        const wrap = ensureRepairJobsMapBox();
        const canvasEl = document.getElementById('repairJobsMapCanvas');
        if (!wrap || !canvasEl) return null;

        isRepairMapCollapsed = localStorage.getItem('elec_repair_map_collapsed') === 'true';
        canvasEl.classList.toggle('hidden', isRepairMapCollapsed);
        const colBtn = document.getElementById('toggleRepairMapCollapseBtn');
        if (colBtn) colBtn.textContent = isRepairMapCollapsed ? '🔽 เปิดแผนที่' : '🔼 ย่อแผนที่';

        repairJobsMap = L.map(canvasEl, { zoomControl: true, attributionControl: false }).setView([13.116, 101.095], 12);
        const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 });
        const sat = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20 });
        street.addTo(repairJobsMap);
        L.control.layers({ '🗺️ แผนที่ถนน': street, '🛰️ ดาวเทียม': sat }, null, { position: 'topright' }).addTo(repairJobsMap);
        repairJobsMarkersLayer = L.layerGroup().addTo(repairJobsMap);

        if (typeof ResizeObserver !== 'undefined') {
            repairMapResizeObserver = new ResizeObserver(() => {
                if (repairJobsMap && !isRepairMapCollapsed) repairJobsMap.invalidateSize();
            });
            repairMapResizeObserver.observe(canvasEl);
        }
        updateMyTechMarkerOnRepairMap();
        return repairJobsMap;
    }

    function toggleRepairJobsMapCollapse() {
        isRepairMapCollapsed = !isRepairMapCollapsed;
        localStorage.setItem('elec_repair_map_collapsed', isRepairMapCollapsed ? 'true' : 'false');
        const canvasEl = document.getElementById('repairJobsMapCanvas');
        const btn = document.getElementById('toggleRepairMapCollapseBtn');
        if (canvasEl) canvasEl.classList.toggle('hidden', isRepairMapCollapsed);
        if (btn) btn.textContent = isRepairMapCollapsed ? '🔽 เปิดแผนที่' : '🔼 ย่อแผนที่';
        if (!isRepairMapCollapsed && repairJobsMap) {
            setTimeout(() => { repairJobsMap.invalidateSize(); renderJobCards(true); }, 120);
        }
    }

    function toggleRepairJobsMapFullscreen() {
        const wrap = document.getElementById('repairJobsMapWrapper');
        const canvasEl = document.getElementById('repairJobsMapCanvas');
        const btn = document.getElementById('toggleRepairMapFullBtn');
        if (!wrap || !canvasEl) return;
        if (isRepairMapCollapsed) toggleRepairJobsMapCollapse();

        isRepairMapFullscreen = !isRepairMapFullscreen;
        if (isRepairMapFullscreen) {
            wrap.className = 'fixed inset-0 z-[1050] bg-white flex flex-col m-0 rounded-none';
            canvasEl.className = 'w-full flex-1 bg-slate-100 relative z-10';
            if (btn) btn.textContent = '✕ ย่อกลับ';
        } else {
            wrap.className = 'mx-3.5 sm:mx-4 mt-2 mb-1 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden';
            canvasEl.className = 'w-full h-56 sm:h-64 bg-slate-100 relative z-10';
            if (btn) btn.textContent = '⛶ ขยายเต็มจอ';
        }
        if (repairJobsMap) setTimeout(() => repairJobsMap.invalidateSize(), 150);
    }

    function toggleRepairJobTooltips() {
        showRepairJobTooltips = !showRepairJobTooltips;
        lastRepairJobsSignature = '';
        renderJobCards(true);
    }

    function updateMyTechMarkerOnRepairMap() {
        if (!repairJobsMap || typeof L === 'undefined') return;
        if (!isGpsTrackingEnabled || !lastKnownTechCoords) {
            if (repairTechSelfMarker) { repairJobsMap.removeLayer(repairTechSelfMarker); repairTechSelfMarker = null; }
            return;
        }
        const latlng = [lastKnownTechCoords.lat, lastKnownTechCoords.lon];
        if (!repairTechSelfMarker) {
            const icon = L.divIcon({
                className: '',
                html: `<div style="width:22px;height:22px;border-radius:9999px;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 4px rgba(37,99,235,0.32);"></div>`,
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            });
            repairTechSelfMarker = L.marker(latlng, { icon, zIndexOffset: 900 }).addTo(repairJobsMap).bindTooltip('📍 ตำแหน่งของคุณ', { direction: 'top' });
        } else {
            repairTechSelfMarker.setLatLng(latlng);
        }
    }

    function renderRepairJobsOnMap(filteredItems, jobType, closedReg) {
        if (Core.isEmbeddedIframe || typeof L === 'undefined') return;
        const map = initRepairJobsMap();
        if (!map || !repairJobsMarkersLayer || isRepairMapCollapsed) return;

        const sig = JSON.stringify(filteredItems.map(it => {
            const jk = jobType === 'fault' ? it.timestamp : it.dateTimeSaved;
            const rep = getEffectiveJobReport(it, jk, closedReg);
            return [jk, it.gps, rep?.status || '', Boolean(it.techNav), showRepairJobTooltips];
        }));
        if (sig === lastRepairJobsSignature) return;
        lastRepairJobsSignature = sig;

        repairJobsMarkersLayer.clearLayers();
        repairJobMarkersByKey = {};
        const boundsPts = [];
        let pinCount = 0;

        filteredItems.forEach(item => {
            const jk = jobType === 'fault' ? item.timestamp : item.dateTimeSaved;
            const coord = extractCoordsFromJob(item, jk);
            if (!coord || isNaN(coord.lat) || isNaN(coord.lon)) return;
            pinCount++;
            boundsPts.push([coord.lat, coord.lon]);

            const rep = getEffectiveJobReport(item, jk, closedReg);
            const isDone = Boolean(rep && String(rep.status || '').includes('เสร็จสิ้น'));
            const isTrav = !isDone && Boolean(item.techNav);
            const urg = getJobUrgencyInfo(item, jobType);
            const bgHex = isDone ? '#10b981' : (isTrav ? '#2563eb' : (urg.level === 'critical' ? '#ef4444' : (urg.level === 'urgent' ? '#f59e0b' : '#0d9488')));
            const shortLbl = jobType === 'outage' ? `#${item.jobNo || '-'}` : (item.circuit || 'TR');
            const safeKey = escJsAttr(jk);
            const navUrl = escJsAttr(rep?.fieldGps || item.gps || `https://www.google.com/maps?q=${coord.lat},${coord.lon}`);

            const icon = L.divIcon({
                className: '',
                html: `<div style="background:${bgHex};color:#fff;font-weight:800;font-size:10px;padding:2px 6px;border-radius:999px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.35);white-space:nowrap;text-align:center;">${escapeHtmlStr(shortLbl)}</div>`,
                iconSize: [38, 22],
                iconAnchor: [19, 11]
            });

            const marker = L.marker([coord.lat, coord.lon], { icon });
            if (showRepairJobTooltips) {
                const tipTxt = jobType === 'outage' ? `งาน ${item.jobNo || '-'} (กะ ${getEffectiveJobShift(item)}): ${item.issueType || '-'}` : `${item.circuit || '-'} (${item.station || '-'})`;
                marker.bindTooltip(escapeHtmlStr(tipTxt), { direction: 'top', offset: [0, -10] });
            }
            const meterBtnPopup = jobType === 'outage'
                ? `<button type="button" onclick="openTechMeterFormByKey('${safeKey}','outage')" style="background:#f3e8ff;color:#6b21a8;border:1px solid #d8b4fe;padding:4px 8px;border-radius:6px;font-weight:700;font-size:11px;cursor:pointer;">📄 ใบมิเตอร์</button>`
                : '';
            marker.bindPopup(`<div style="font-family:'Prompt',sans-serif;font-size:12px;min-width:190px;line-height:1.45;">
                <div style="font-weight:700;color:#0f172a;">${escapeHtmlStr(jobType === 'outage' ? `งานที่ ${item.jobNo || '-'} (กะ ${getEffectiveJobShift(item)})` : `${item.circuit || '-'} สถานี${item.station || '-'}`)}</div>
                <div style="color:#475569;font-size:11px;margin:2px 0 6px;">${escapeHtmlStr(jobType === 'outage' ? `${item.issueType || '-'} • ${item.area || '-'}` : `${item.cause || '-'} • ${item.reporter || '-'}`)}</div>
                <div style="display:flex;flex-wrap:wrap;gap:4px;">
                    <button type="button" onclick="handleStartNavigation('${safeKey}','${jobType}','${navUrl}')" style="background:#2563eb;color:#fff;border:0;padding:4px 8px;border-radius:6px;font-weight:700;font-size:11px;cursor:pointer;">🚗 นำทาง</button>
                    <button type="button" onclick="openInspectModal('${safeKey}','${jobType}')" style="background:#0d9488;color:#fff;border:0;padding:4px 8px;border-radius:6px;font-weight:700;font-size:11px;cursor:pointer;">🛠️ แจ้งผล</button>
                    ${meterBtnPopup}
                </div>
            </div>`);
            marker.on('popupopen', () => { currentlyOpenRepairPopupKey = jk; });
            repairJobsMarkersLayer.addLayer(marker);
            repairJobMarkersByKey[jk] = marker;
        });

        const badge = document.getElementById('repairMapPinCountBadge');
        if (badge) badge.textContent = `${pinCount} จุด`;

        const coordsSig = JSON.stringify(boundsPts);
        if (boundsPts.length > 0 && coordsSig !== lastAutoFittedCoordsSig && Date.now() > suppressMapAutoFitUntilMs) {
            lastAutoFittedCoordsSig = coordsSig;
            try { map.fitBounds(boundsPts, { padding: [28, 28], maxZoom: 15 }); } catch (e) {}
        }
    }

    function focusJobOnRepairMap(jobKey) {
        if (!jobKey) return;
        if (isRepairMapCollapsed) toggleRepairJobsMapCollapse();
        const marker = repairJobMarkersByKey[jobKey];
        if (repairJobsMap && marker) {
            suppressMapAutoFitUntilMs = Date.now() + 15000;
            document.getElementById('repairJobsMapWrapper')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            repairJobsMap.setView(marker.getLatLng(), Math.max(repairJobsMap.getZoom(), 16));
            marker.openPopup();
        } else {
            showToast('⚠️ ใบงานนี้ยังไม่มีพิกัดตัวเลขบนแผนที่');
        }
    }

    async function upgradeRepairJobsShortLinks() {
        if (isUpgradingShortLinks || !navigator.onLine || typeof resolveGoogleShortLinkUniversal !== 'function') return;
        isUpgradingShortLinks = true;
        try {
            const jobShortCache = JSON.parse(localStorage.getItem(SHORT_URL_COORD_CACHE_KEY) || '{}');
            let cacheDirty = false;
            const allPairs = [
                ...JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]').slice(0, 40).map(i => [i?.dateTimeSaved, i]),
                ...JSON.parse(localStorage.getItem('fault_reports_all') || '[]').slice(0, 20).map(i => [i?.timestamp, i])
            ];
            for (const [jk, item] of allPairs) {
                if (!jk || !item || jobShortCache[jk]) continue;
                const raw = `${item.gps || ''} ${item.address || ''}`;
                if (deepParseCoords(raw, false)) continue;
                const m = raw.match(/(?:https?:\/\/)?(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/[A-Za-z0-9_-]+/i);
                if (!m) continue;
                const lastTry = shortLinkAttemptMap.get(jk) || 0;
                if (Date.now() - lastTry < 120000) continue;
                shortLinkAttemptMap.set(jk, Date.now());
                const resolved = await resolveGoogleShortLinkUniversal(m[0]);
                if (resolved?.lat && resolved?.lon) {
                    jobShortCache[jk] = { lat: Number(resolved.lat), lon: Number(resolved.lon), updatedAt: Date.now() };
                    cacheDirty = true;
                }
            }
            if (cacheDirty) {
                localStorage.setItem(SHORT_URL_COORD_CACHE_KEY, JSON.stringify(jobShortCache));
                lastRepairJobsSignature = '';
                renderJobCards(true);
            }
        } catch (e) {
        } finally {
            isUpgradingShortLinks = false;
        }
    }
    // ===== จบพาทที่ 2 / 3 ของไฟล์ tech-jobs.js =====
        // ===== เริ่มพาทที่ 3 / 3 ของไฟล์ tech-jobs.js (วางต่อจากพาทที่ 2 จนจบไฟล์) =====
    // ========================================================================
    // 8. ตัวกรองกะ/วันที่, การ์ดใบงาน, อัปโหลดรูป Google Drive & ส่งค่าเข้าใบมิเตอร์
    // ========================================================================
    let modalStagedPhotos = [];

    function getJobDateDisplay(item) {
        if (!item) return '-';
        if (item.reportDate && item.reportDate !== '-') {
            return normalizeThaiDateStr(item.reportDate) || item.reportDate;
        }
        if (item.dateTimeSaved && item.dateTimeSaved !== 'TECH_LOC_REGISTRY') {
            return normalizeThaiDateStr(item.dateTimeSaved) || String(item.dateTimeSaved).split(' ')[0];
        }
        if (item.timestamp) {
            const d = new Date(item.timestamp);
            if (!isNaN(d.getTime())) {
                return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear() + 543}`;
            }
        }
        return '-';
    }

    function getEffectiveJobShift(item) {
        if (!item) return 'ไม่ระบุ';
        const rawShift = String(item.shift || '').trim();
        if (['1', '2', '3'].includes(rawShift)) return rawShift;

        const timeStr = String(item.time || (item.dateTimeSaved ? String(item.dateTimeSaved).split(/\s+/)[1] : '') || '').trim();
        const tm = timeStr.match(/(\d{1,2})[:.](\d{2})/);
        if (tm) {
            const mins = parseInt(tm[1], 10) * 60 + parseInt(tm[2], 10);
            if (mins >= 30 && mins < 510) return '1';
            if (mins >= 510 && mins < 990) return '2';
            return '3';
        }
        if (item.timestamp) {
            const d = new Date(item.timestamp);
            if (!isNaN(d.getTime())) {
                const mins = d.getHours() * 60 + d.getMinutes();
                if (mins >= 30 && mins < 510) return '1';
                if (mins >= 510 && mins < 990) return '2';
                return '3';
            }
        }
        return 'ไม่ระบุ';
    }

    function getJobUrgencyInfo(item, jobType) {
        if (jobType === 'fault') {
            return { level: 'critical', dot: '🔴', label: 'เหตุสถานี/สายส่ง', borderCls: 'border-l-rose-500', badgeCls: 'bg-rose-100 text-rose-700 border-rose-200' };
        }
        const p = item?.priorityLevel || '';
        const txt = String(item?.issueType || '').toLowerCase().replace(/เเ/g, 'แ');
        const isCrit = p === 'critical' || ['เสาหัก', 'เสาล้ม', 'ระเบิด', 'ช็อต', 'ช๊อต', 'ประกายไฟ', 'รถชน', 'สายขาด', 'ไหม้', 'หลายหลัง', 'อันตราย', 'ไฟรั่ว', 'ฟิวส์แรงสูง', 'ต้นไม้ล้ม', 'แรงสูง'].some(k => txt.includes(k));
        if (isCrit) return { level: 'critical', dot: '🔴', label: 'วิกฤต/อันตราย', borderCls: 'border-l-rose-500', badgeCls: 'bg-rose-100 text-rose-700 border-rose-200' };
        const isUrg = p === 'urgent' || ['ไฟดับ', 'ไฟตก', 'เสียงดัง', 'กระพริบ', 'กะพริบ', 'สายหย่อน'].some(k => txt.includes(k));
        if (isUrg) return { level: 'urgent', dot: '🟡', label: 'เร่งด่วน', borderCls: 'border-l-amber-500', badgeCls: 'bg-amber-100 text-amber-800 border-amber-200' };
        return { level: 'normal', dot: '🟢', label: 'ปกติ', borderCls: 'border-l-emerald-500', badgeCls: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
    }

    function syncDateFilterButtonsUI() {
        const inp = document.getElementById('filterJobDate');
        const btnToday = document.getElementById('dateBtnToday');
        const btnAll = document.getElementById('dateBtnAll');
        const val = inp?.value || '';
        const isToday = Boolean(val && val === getShiftCycleTodayIso());
        const isAll = !val;
        if (btnToday) {
            btnToday.className = isToday
                ? 'px-3 py-1.5 rounded-xl text-xs font-bold border border-teal-600 bg-teal-600 text-white shadow-sm transition whitespace-nowrap'
                : 'px-3 py-1.5 rounded-xl text-xs font-bold border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 transition whitespace-nowrap';
        }
        if (btnAll) {
            btnAll.className = isAll
                ? 'px-3 py-1.5 rounded-xl text-xs font-bold border border-teal-600 bg-teal-600 text-white shadow-sm transition whitespace-nowrap'
                : 'px-3 py-1.5 rounded-xl text-xs font-bold border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 transition whitespace-nowrap';
        }
    }

    function onTechDateInputChanged() {
        syncDateFilterButtonsUI();
        renderJobCards(true);
    }

    function setTechDateFilterToday() {
        const inp = document.getElementById('filterJobDate');
        if (inp) inp.value = getShiftCycleTodayIso();
        syncDateFilterButtonsUI();
        renderJobCards(true);
    }

    function clearTechDateFilter() {
        const inp = document.getElementById('filterJobDate');
        if (inp) inp.value = '';
        syncDateFilterButtonsUI();
        renderJobCards(true);
    }

    function selectShiftFilter(shiftVal) {
        const v = String(shiftVal || 'all');
        const sel = document.getElementById('filterJobShift');
        if (sel && sel.value !== v) sel.value = v;
        ['all', '1', '2', '3'].forEach(k => {
            const pill = document.getElementById('shiftPill-' + k);
            if (!pill) return;
            pill.className = (k === v)
                ? 'py-1.5 px-2 rounded-xl text-[11px] font-bold border transition bg-teal-600 text-white border-teal-600 shadow-sm'
                : 'py-1.5 px-2 rounded-xl text-[11px] font-bold border transition bg-white text-slate-600 border-slate-200 hover:bg-slate-100';
        });
        renderJobCards(true);
    }

    function switchStatusTab(statusVal) {
        const v = String(statusVal || 'pending');
        const sel = document.getElementById('filterJobStatus');
        if (sel && sel.value !== v) sel.value = v;

        const tabMeta = {
            all: { badge: '📋 กำลังแสดง: งานทั้งหมด', cls: 'text-xs font-bold text-slate-700 bg-slate-100 border border-slate-300 px-3 py-1 rounded-full' },
            pending: { badge: '⏳ กำลังแสดง: งานรอแก้ไข', cls: 'text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-3 py-1 rounded-full' },
            traveling: { badge: '🚗 กำลังแสดง: กำลังเดินทาง', cls: 'text-xs font-bold text-blue-700 bg-blue-50 border border-blue-200 px-3 py-1 rounded-full' },
            done: { badge: '✅ กำลังแสดง: แก้ไขเสร็จสิ้นแล้ว', cls: 'text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full' }
        };
        const curBadge = document.getElementById('currentViewBadge');
        if (curBadge && tabMeta[v]) {
            curBadge.textContent = tabMeta[v].badge;
            curBadge.className = tabMeta[v].cls;
        }

        const baseBoxCls = {
            all: 'bg-white/15 hover:bg-white/25 backdrop-blur-sm rounded-xl p-2 transition border-2',
            pending: 'bg-rose-500/40 hover:bg-rose-500/50 rounded-xl p-2 transition border-2',
            traveling: 'bg-blue-600/40 hover:bg-blue-600/55 rounded-xl p-2 transition border-2',
            done: 'bg-emerald-900/30 hover:bg-emerald-900/50 rounded-xl p-2 transition border-2'
        };
        ['all', 'pending', 'traveling', 'done'].forEach(k => {
            const box = document.getElementById('tabBox-' + k);
            if (!box) return;
            box.className = `${baseBoxCls[k]} ${k === v ? 'border-amber-300 shadow-md ring-2 ring-amber-300/40' : 'border-transparent'}`;
        });
        renderJobCards(true);
    }

    function switchJobTypeAndPending(targetType) {
        const sel = document.getElementById('filterJobType');
        if (sel) sel.value = targetType;
        switchStatusTab('pending');
    }

    function openTechPhotoLightbox(imgSrc, driveUrl = '') {
        if (!imgSrc && !driveUrl) return;
        let m = document.getElementById('peaTechPhotoLightbox');
        if (!m) {
            m = document.createElement('div');
            m.id = 'peaTechPhotoLightbox';
            m.className = 'fixed inset-0 z-[1490] hidden bg-slate-950/90 backdrop-blur-sm flex flex-col items-center justify-center p-3';
            m.onclick = e => { if (e.target === m) m.classList.add('hidden'); };
            document.body.appendChild(m);
        }
        const drvBtn = driveUrl ? `<a href="${escapeHtmlStr(driveUrl)}" target="_blank" rel="noopener noreferrer" class="bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-2 rounded-xl text-xs font-extrabold shadow">🔗 เปิดไฟล์เต็มใน Google Drive ↗</a>` : '';
        m.innerHTML = `<div class="max-w-3xl w-full flex flex-col items-center gap-3"><img src="${escapeHtmlStr(imgSrc || driveUrl)}" class="max-h-[78dvh] w-auto max-w-full rounded-2xl shadow-2xl border border-white/20 object-contain bg-slate-900"><div class="flex items-center gap-2">${drvBtn}<button type="button" onclick="document.getElementById('peaTechPhotoLightbox').classList.add('hidden')" class="bg-rose-600 hover:bg-rose-700 text-white px-4 py-2 rounded-xl text-xs font-extrabold shadow">✕ ปิดรูปภาพ</button></div></div>`;
        m.classList.remove('hidden');
    }

    function buildCardPhotoStripHtml(rep) {
        const photos = getNormalizedReportPhotos(rep);
        if (!photos.length) return '';
        const thumbs = photos.map((p, idx) => {
            const src = p.thumbUrl || p.directUrl || p.viewUrl;
            const alt = escJsAttr(p.directUrl || '');
            return `<button type="button" onclick="openTechPhotoLightbox('${escJsAttr(src)}','${escJsAttr(p.viewUrl || '')}')" class="relative w-14 h-14 rounded-lg overflow-hidden border border-teal-300 shadow-sm shrink-0 bg-slate-900 hover:opacity-90 transition"><img src="${escapeHtmlStr(src)}" onerror="if(!this.dataset.fb&&'${alt}'){this.dataset.fb='1';this.src='${alt}';}" class="w-full h-full object-cover"><span class="absolute bottom-0 right-0 bg-slate-900/80 text-white text-[9px] font-bold px-1 rounded-tl">#${idx + 1}</span></button>`;
        }).join('');
        return `<div class="p-2 bg-teal-50/80 border border-teal-200 rounded-xl space-y-1"><div class="text-[10px] font-bold text-teal-800">📷 ภาพถ่ายหน้างาน (${photos.length} รูป):</div><div class="flex items-center gap-1.5 overflow-x-auto">${thumbs}</div></div>`;
    }

    function renderCrossTypePendingBanner(otherType, count) {
        let bar = document.getElementById('crossTypePendingAlertBanner');
        if (count <= 0) {
            if (bar) bar.remove();
            return;
        }
        const cardsContainer = document.getElementById('jobCardsContainer');
        if (!cardsContainer?.parentElement) return;
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'crossTypePendingAlertBanner';
            bar.className = 'mx-3.5 sm:mx-4 mt-2';
            cardsContainer.parentElement.insertBefore(bar, cardsContainer);
        }
        const label = otherType === 'fault' ? `🚨 มีงานเหตุสถานี/สายส่ง (TR/TL) รอแก้ไข ${count} รายการ!` : `📞 มีงานรับแจ้งไฟขัดข้องรอแก้ไข ${count} รายการ!`;
        bar.innerHTML = `<button type="button" onclick="switchJobTypeAndPending('${otherType}')" class="w-full p-2.5 rounded-xl bg-gradient-to-r from-rose-600 to-amber-600 text-white text-xs font-bold shadow flex items-center justify-between gap-2"><span>${label}</span><span class="bg-white/20 px-2.5 py-0.5 rounded-lg text-[11px] shrink-0">สลับไปดู ➔</span></button>`;
    }

    function renderJobCards(forceRender = false) {
        const container = document.getElementById('jobCardsContainer');
        if (!container) return;

        const jobType = document.getElementById('filterJobType')?.value || 'outage';
        const statusFilter = document.getElementById('filterJobStatus')?.value || 'pending';
        const shiftFilter = document.getElementById('filterJobShift')?.value || 'all';
        const sortOrder = document.getElementById('sortJobOrder')?.value || 'shift_job_asc';
        const selIsoDate = document.getElementById('filterJobDate')?.value || '';
        const keyword = (document.getElementById('searchJobKeyword')?.value || '').toLowerCase().trim();
        const isViewer = isViewerRole();
        const isAdmin = isCurrentUserAdmin();

        let filterThaiDate = '';
        if (selIsoDate) {
            const [y, m, d] = selIsoDate.split('-');
            if (y && m && d) filterThaiDate = `${d}/${m}/${parseInt(y, 10) + 543}`;
        }

        const delReg = getDeletedJobsRegistry();
        const closedReg = readClosedReg();
        const rawOutages = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]').filter(i => i?.dateTimeSaved && !delReg[i.dateTimeSaved] && canCurrentUserSeeJob(i));
        const rawFaults = JSON.parse(localStorage.getItem('fault_reports_all') || '[]').filter(i => i?.timestamp && !delReg[i.timestamp] && canCurrentUserSeeJob(i));

        const otherList = jobType === 'outage' ? rawFaults : rawOutages;
        const otherKf = jobType === 'outage' ? 'timestamp' : 'dateTimeSaved';
        const otherPendingCount = otherList.filter(it => {
            const r = getEffectiveJobReport(it, it[otherKf], closedReg);
            return !(r && String(r.status || '').includes('เสร็จสิ้น'));
        }).length;
        renderCrossTypePendingBanner(jobType === 'outage' ? 'fault' : 'outage', otherPendingCount);

        const sourceList = jobType === 'fault' ? rawFaults : rawOutages;
        const kf = jobType === 'fault' ? 'timestamp' : 'dateTimeSaved';

        // กรองตามวันที่และคำค้นหาก่อนนำไปนับยอดกล่องสถานะและปุ่มกะ
        const dateAndKwMatched = sourceList.filter(item => {
            if (filterThaiDate && getJobDateDisplay(item) !== filterThaiDate) return false;
            const rep = getEffectiveJobReport(item, item[kf], closedReg);
            return matchesJobSearchKeyword(item, rep, keyword);
        });

        let cAll = 0, cPending = 0, cTraveling = 0, cDone = 0;
        const shiftCounts = { all: 0, '1': 0, '2': '0', '3': 0 };
        shiftCounts['2'] = 0;

        dateAndKwMatched.forEach(item => {
            const sh = getEffectiveJobShift(item);
            const rep = getEffectiveJobReport(item, item[kf], closedReg);
            const isDone = Boolean(rep && String(rep.status || '').includes('เสร็จสิ้น'));
            const isTraveling = !isDone && Boolean(item.techNav);
            const stCode = isDone ? 'done' : (isTraveling ? 'traveling' : 'pending');

            if (statusFilter === 'all' || statusFilter === stCode) {
                shiftCounts.all++;
                if (shiftCounts[sh] !== undefined) shiftCounts[sh]++;
            }
            if (shiftFilter === 'all' || sh === shiftFilter) {
                cAll++;
                if (isDone) cDone++;
                else if (isTraveling) cTraveling++;
                else cPending++;
            }
        });

        const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
        setTxt('countAllJobs', cAll);
        setTxt('countPendingJobs', cPending);
        setTxt('countTravelingJobs', cTraveling);
        setTxt('countDoneJobs', cDone);
        setTxt('countShiftAll', shiftCounts.all);
        setTxt('countShift1', shiftCounts['1']);
        setTxt('countShift2', shiftCounts['2']);
        setTxt('countShift3', shiftCounts['3']);

        const filtered = dateAndKwMatched.filter(item => {
            const sh = getEffectiveJobShift(item);
            if (shiftFilter !== 'all' && sh !== shiftFilter) return false;
            const rep = getEffectiveJobReport(item, item[kf], closedReg);
            const isDone = Boolean(rep && String(rep.status || '').includes('เสร็จสิ้น'));
            const isTraveling = !isDone && Boolean(item.techNav);
            if (statusFilter === 'pending') return !isDone && !isTraveling;
            if (statusFilter === 'traveling') return isTraveling;
            if (statusFilter === 'done') return isDone;
            return true;
        });

        const parseThaiDateSortNum = dStr => {
            const sp = String(dStr || '').split('/');
            if (sp.length !== 3) return 0;
            return (parseInt(sp[2], 10) || 0) * 10000 + (parseInt(sp[1], 10) || 0) * 100 + (parseInt(sp[0], 10) || 0);
        };

        filtered.sort((a, b) => {
            if (sortOrder === 'time_desc') return getJobCreatedTimeMs(b) - getJobCreatedTimeMs(a);
            if (sortOrder === 'time_asc') return getJobCreatedTimeMs(a) - getJobCreatedTimeMs(b);
            if (sortOrder === 'job_asc') return (parseInt(a.jobNo, 10) || 999999) - (parseInt(b.jobNo, 10) || 999999);
            if (sortOrder === 'job_desc') return (parseInt(b.jobNo, 10) || 0) - (parseInt(a.jobNo, 10) || 0);

            const dDiff = parseThaiDateSortNum(getJobDateDisplay(b)) - parseThaiDateSortNum(getJobDateDisplay(a));
            if (dDiff !== 0) return dDiff;
            const sA = parseInt(getEffectiveJobShift(a), 10) || 9, sB = parseInt(getEffectiveJobShift(b), 10) || 9;
            if (sortOrder === 'shift_job_desc') {
                if (sB !== sA) return sB - sA;
                return (parseInt(b.jobNo, 10) || 0) - (parseInt(a.jobNo, 10) || 0);
            }
            if (sA !== sB) return sA - sB;
            return (parseInt(a.jobNo, 10) || 999999) - (parseInt(b.jobNo, 10) || 999999);
        });

        renderRepairJobsOnMap(filtered, jobType, closedReg);

        const renderSig = JSON.stringify({
            jobType, statusFilter, shiftFilter, sortOrder, selIsoDate, keyword, isViewer, isAdmin,
            gpsOn: Boolean(isGpsTrackingEnabled && lastKnownTechCoords),
            items: filtered.map(it => {
                const jk = it[kf], rep = getEffectiveJobReport(it, jk, closedReg);
                return [jk, it.editedAt || '', rep?.updatedAt || '', it.techNav?.updatedAt || '', it.gps || '', getNormalizedReportPhotos(rep).length];
            })
        });
        if (!forceRender && renderSig === lastRenderedCardsSignature) {
            updateLiveNavDomElements();
            return;
        }
        lastRenderedCardsSignature = renderSig;

        if (filtered.length === 0) {
            container.innerHTML = `<div class="text-center py-10 bg-slate-50 rounded-2xl border border-dashed border-slate-300 text-slate-500 text-xs space-y-1"><div class="text-2xl">📭</div><div class="font-bold">ไม่พบรายการใบงานในหมวดที่เลือก</div></div>`;
            return;
        }

        container.innerHTML = filtered.map(item => {
            const jk = item[kf];
            const safeKey = escJsAttr(jk);
            const rep = getEffectiveJobReport(item, jk, closedReg);
            const isDone = Boolean(rep && String(rep.status || '').includes('เสร็จสิ้น'));
            const isTraveling = !isDone && Boolean(item.techNav);
            const urg = getJobUrgencyInfo(item, jobType);
            const sh = getEffectiveJobShift(item);
            const dateDisp = getJobDateDisplay(item);
            const grpBadge = isAdmin ? `<span class="text-[10px] bg-indigo-100 text-indigo-800 px-1.5 py-0.5 rounded font-bold">🏢 ${escapeHtmlStr(normTechGrp(getJobGroupName(item) || 'กฟส.บึง'))}</span>` : '';

            const coord = extractCoordsFromJob(item, jk);
            const rawGpsUrl = normalizeCoordPairToMapsUrl(rep?.fieldGps || item.gps || (coord ? `https://www.google.com/maps?q=${coord.lat},${coord.lon}` : ''));
            const safeGpsAttr = escJsAttr(rawGpsUrl);
            const dialPhone = jobType === 'outage' ? extractDialablePhone(item.phone) : '';

            const titleHtml = jobType === 'outage'
                ? `${urg.dot} งานที่ ${escapeHtmlStr(item.jobNo || '-')} (กะ ${escapeHtmlStr(sh)}) — ${escapeHtmlStr(item.issueType || '-')}`
                : `${urg.dot} วงจร ${escapeHtmlStr(item.circuit || '-')} สถานี${escapeHtmlStr(item.station || '-')} (${escapeHtmlStr(item.system || '-')})`;

            const nearTech = (!isDone && !isTraveling) ? findNearestTechForJob(item) : null;
            const nearBanner = nearTech
                ? `<div class="p-2 rounded-xl bg-purple-50 border border-purple-200 text-[11px] text-purple-900 font-semibold flex justify-between items-center"><span>🎯 ช่างใกล้จุดเกิดเหตุ: <b>${escapeHtmlStr(formatTechDisplayName(nearTech.techName))}</b>${nearTech.isMe ? ' (คุณ)' : ''}</span><span class="text-[10px] text-purple-700">~${nearTech.distanceKm} กม. (~${nearTech.durationMin} นาที)</span></div>`
                : '';

            const navBanner = isTraveling
                ? `<div class="realtime-nav-box p-2.5 bg-blue-50 border border-blue-200 rounded-xl text-[11px] space-y-1" data-job-key="${escapeHtmlStr(jk)}" data-job-type="${jobType}">${formatRealtimeNavHtml(item.techNav)}</div>`
                : '';

            const doneBanner = rep
                ? `<div class="p-2.5 rounded-xl border ${isDone ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-amber-50 border-amber-200 text-amber-900'} text-[11px] space-y-0.5">
                    <div class="font-bold flex justify-between items-center"><span>${isDone ? '✅' : '🔧'} ${escapeHtmlStr(rep.status)}</span><span class="text-[10px]">⏰ ${escapeHtmlStr(rep.finishTime || '-')}</span></div>
                    <div>🔍 สาเหตุจริง: <b>${escapeHtmlStr(rep.realCause || '-')}</b></div>
                    <div>🛠️ การแก้ไข: ${escapeHtmlStr(rep.actionTaken || '-')}</div>
                    <div class="text-[10px] opacity-80">👷 ผู้ตรวจสอบ: ${escapeHtmlStr(formatTechDisplayName(rep.inspector || '-'))}</div>
                </div>`
                : '';

            const photoStripHtml = buildCardPhotoStripHtml(rep);

            const callBtn = dialPhone
                ? `<a href="tel:${escapeHtmlStr(dialPhone)}" class="bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 px-2.5 py-1.5 rounded-xl text-[11px] font-bold flex items-center gap-1">📞 โทร ${escapeHtmlStr(dialPhone)}</a>`
                : '';

            const mapPinBtn = coord
                ? `<button type="button" onclick="focusJobOnRepairMap('${safeKey}')" class="bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 px-2.5 py-1.5 rounded-xl text-[11px] font-bold">📍 ดูจุดบนแผนที่</button>`
                : '';

            const meterBtn = (!isViewer && jobType === 'outage')
                ? `<button type="button" onclick="openTechMeterFormByKey('${safeKey}','outage')" class="bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 px-2.5 py-1.5 rounded-xl text-[11px] font-bold flex items-center gap-1 shadow-sm" title="เปิดใบรายงานมิเตอร์ชำรุดพร้อมกรอกข้อมูลอัตโนมัติ">📄 ใบมิเตอร์</button>`
                : '';

            let navActionBtns = '';
            if (!isDone) {
                if (isTraveling) {
                    const extOpen = (rawGpsUrl && /^https?:\/\//i.test(rawGpsUrl))
                        ? `<a href="${escapeHtmlStr(rawGpsUrl)}" target="_blank" rel="noopener noreferrer" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 px-3 rounded-xl text-xs font-bold text-center shadow-sm">🗺️ เปิด Maps นำทาง</a>`
                        : '';
                    const cancelBtn = !isViewer
                        ? `<button type="button" onclick="handleCancelNavigation('${safeKey}','${jobType}')" class="bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 py-2 px-3 rounded-xl text-xs font-bold">↩️ ยกเลิกเดินทาง</button>`
                        : '';
                    navActionBtns = `${extOpen}${cancelBtn}`;
                } else {
                    navActionBtns = `<button type="button" onclick="handleStartNavigation('${safeKey}','${jobType}','${safeGpsAttr}')" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 px-3 rounded-xl text-xs font-bold shadow-sm">${isViewer ? '🗺️ เปิดแผนที่' : '🚗 เริ่มเดินทาง & นำทาง'}</button>`;
                }
            }

            const inspectBtn = !isViewer
                ? `<button type="button" onclick="openInspectModal('${safeKey}','${jobType}')" class="flex-1 ${isDone ? 'bg-amber-500 hover:bg-amber-600' : 'bg-teal-600 hover:bg-teal-700'} text-white py-2 px-3 rounded-xl text-xs font-bold shadow-sm">${isDone ? '✏️ แก้ไขผลตรวจ' : '🛠️ แจ้งผลตรวจสอบ'}</button>`
                : '';

                        const voiceQuickBtn = (!isDone && !isViewer)
                ? `<button type="button" onclick="quickVoiceCloseJob('${safeKey}','${jobType}', this)" class="bg-rose-600 hover:bg-rose-700 text-white py-2 px-3 rounded-xl text-xs font-bold shadow-sm flex items-center justify-center gap-1 transition">🎙️ พูดปิดงาน</button>`
                : '';

            const reopenBtn = (isDone && !isViewer)
                ? `<button type="button" onclick="reopenClosedJob('${safeKey}','${jobType}')" class="bg-slate-100 hover:bg-rose-50 text-rose-600 border border-rose-200 py-2 px-2.5 rounded-xl text-xs font-bold" title="ย้ายกลับไปงานรอแก้ไข">🔄 เปิดซ้ำ</button>`
                : '';

            return `<div class="bg-white rounded-2xl border border-slate-200 border-l-4 ${urg.borderCls} p-3.5 shadow-sm space-y-2.5">
                <div class="flex justify-between items-start gap-2">
                    <div class="font-bold text-slate-800 text-xs sm:text-sm leading-snug min-w-0 break-words">${titleHtml}</div>
                    <div class="flex items-center gap-1 shrink-0">${grpBadge}<span class="text-[10px] font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md whitespace-nowrap">📅 ${escapeHtmlStr(dateDisp)}</span></div>
                </div>
                <div class="text-xs text-slate-700 whitespace-pre-line break-words [overflow-wrap:anywhere] font-mono bg-slate-50 p-2.5 rounded-xl border border-slate-100">${escapeHtmlStr((item.formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0])}</div>
                ${nearBanner}
                ${navBanner}
                ${doneBanner}
                ${photoStripHtml}
                <div class="flex flex-wrap items-center gap-1.5 pt-0.5">
                    ${callBtn}
                    ${mapPinBtn}
                    ${meterBtn}
                    <button type="button" onclick="copyJobTextFromTech('${safeKey}','${jobType}')" class="bg-slate-100 hover:bg-slate-200 text-slate-700 px-2.5 py-1.5 rounded-xl text-[11px] font-bold ml-auto">📋 คัดลอก</button>
                </div>
                <div class="flex flex-wrap gap-2 pt-1 border-t border-slate-100">
                    ${voiceQuickBtn}
                    ${navActionBtns}
                    ${inspectBtn}
                    ${reopenBtn}
                </div>
            </div>`;
        }).join('');
    }

    function copyJobTextFromTech(key, jobType) {
        const sk = jobType === 'fault' ? 'fault_reports_all' : 'elecReportsComplete_all';
        const item = JSON.parse(localStorage.getItem(sk) || '[]').find(i => (jobType === 'fault' ? i?.timestamp : i?.dateTimeSaved) === key);
        if (item?.formattedText) copyTextToClipboard(item.formattedText, '📋 คัดลอกรายละเอียดใบงานแล้ว!');
    }

    // ========================================================================
    // 9. โมดอลบันทึกผลตรวจสอบ, ย่อ/อัปโหลดรูปหน้างานขึ้น Google Drive & พิมพ์ด้วยเสียง
    // ========================================================================
    function ensureInspectModalExtrasInjected() {
        const modalBody = document.querySelector('#inspectModal .p-4.overflow-y-auto');
        if (!modalBody) return;

        if (!document.getElementById('modalPhotoUploadSection')) {
            const photoWrap = document.createElement('div');
            photoWrap.id = 'modalPhotoUploadSection';
            photoWrap.className = 'p-3 bg-teal-50/70 border border-teal-200 rounded-xl space-y-2';
            photoWrap.innerHTML = `
                <div class="flex items-center justify-between gap-2">
                    <label class="font-bold text-teal-900 text-xs">📷 รูปถ่ายหน้างาน (บันทึกลง Google Drive)</label>
                    <span id="modalPhotoCountHint" class="text-[10px] text-teal-700 font-semibold">สูงสุด 4 รูป</span>
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <label class="cursor-pointer bg-teal-600 hover:bg-teal-700 text-white py-2 px-3 rounded-xl text-xs font-bold text-center shadow-sm transition">
                        📷 ถ่ายรูปหน้างาน
                        <input type="file" id="techCameraPhotoInput" accept="image/*" capture="environment" class="hidden">
                    </label>
                    <label class="cursor-pointer bg-white hover:bg-teal-50 text-teal-800 border border-teal-300 py-2 px-3 rounded-xl text-xs font-bold text-center shadow-sm transition">
                        🖼️ เลือกจากอัลบั้ม
                        <input type="file" id="techGalleryPhotoInput" accept="image/*" multiple class="hidden">
                    </label>
                </div>
                <div id="modalPhotoPreviewStrip" class="flex items-center gap-2 overflow-x-auto pt-1"></div>`;
            modalBody.appendChild(photoWrap);

            document.getElementById('techCameraPhotoInput')?.addEventListener('change', handleModalPhotoFilesSelected);
            document.getElementById('techGalleryPhotoInput')?.addEventListener('change', handleModalPhotoFilesSelected);
        }

        if (!document.getElementById('modalMeterFormQuickBox')) {
            const meterWrap = document.createElement('div');
            meterWrap.id = 'modalMeterFormQuickBox';
            meterWrap.className = 'pt-1';
            meterWrap.innerHTML = `
                <button type="button" onclick="openTechMeterFormFromModal()" class="w-full bg-purple-50 hover:bg-purple-100 text-purple-800 border-2 border-purple-300 py-2.5 px-3 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 shadow-sm transition">
                    📄 สร้างใบรายงานมิเตอร์ชำรุด (ดึงเลข CA + ที่อยู่ + GPS ให้ลูกค้าเซ็นชื่อ/แชร์ PDF)
                </button>`;
            modalBody.appendChild(meterWrap);
        }
    }

    function compressImageFileToJpegBase64(file, maxDim = 1280, quality = 0.80) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('Read file failed'));
            reader.onload = ev => {
                const img = new Image();
                img.onerror = () => reject(new Error('Invalid image'));
                img.onload = () => {
                    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
                    if (w > maxDim || h > maxDim) {
                        if (w >= h) { h = Math.round((h * maxDim) / w); w = maxDim; }
                        else { w = Math.round((w * maxDim) / h); h = maxDim; }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, w, h);
                    ctx.drawImage(img, 0, 0, w, h);
                    const dataUrl = canvas.toDataURL('image/jpeg', quality);
                    resolve({ dataUrl, rawBase64: dataUrl.split(',')[1] || '' });
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    function renderModalPhotoPreviewStrip() {
        const strip = document.getElementById('modalPhotoPreviewStrip');
        const hint = document.getElementById('modalPhotoCountHint');
        if (hint) hint.textContent = `${modalStagedPhotos.length} / 4 รูป`;
        if (!strip) return;
        if (!modalStagedPhotos.length) {
            strip.innerHTML = '';
            return;
        }
        strip.innerHTML = modalStagedPhotos.map(p => {
            const src = p.previewSrc || p.thumbUrl || p.directUrl || p.viewUrl;
            const statusPill = p.uploading
                ? `<span class="bg-amber-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">⏳ อัปโหลด...</span>`
                : (p.error
                    ? `<button type="button" onclick="retryModalPhotoUpload('${escJsAttr(p.localId)}')" class="bg-rose-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">🔄 ลองใหม่</button>`
                    : `<span class="bg-emerald-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">✅ Drive</span>`);
            return `<div class="relative w-20 h-20 rounded-xl overflow-hidden border border-teal-300 bg-slate-900 shrink-0 shadow-sm">
                <img src="${escapeHtmlStr(src)}" onclick="openTechPhotoLightbox('${escJsAttr(src)}','${escJsAttr(p.viewUrl || '')}')" class="w-full h-full object-cover cursor-pointer">
                <button type="button" onclick="removeModalPendingPhoto('${escJsAttr(p.localId)}')" class="absolute top-0.5 right-0.5 bg-slate-900/85 hover:bg-rose-600 text-white w-5 h-5 rounded-full text-[11px] font-bold leading-none">✕</button>
                <div class="absolute bottom-0.5 left-0.5">${statusPill}</div>
            </div>`;
        }).join('');
    }

    async function uploadSingleStagedPhoto(photoEntry) {
        if (!photoEntry || !photoEntry.rawBase64) return;
        photoEntry.uploading = true;
        photoEntry.error = false;
        renderModalPhotoPreviewStrip();
        try {
            Core.unlockCloudWrite(25000);
            const myGrp = normTechGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
            const res = await fetch(getActiveCloudApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({
                    action: 'uploadJobPhoto',
                    group: myGrp,
                    jobLabel: photoEntry.jobLabel || 'Job',
                    mimeType: 'image/jpeg',
                    base64Data: photoEntry.rawBase64
                })
            });
            const data = await res.json();
            if (data?.status === 'ok' && data.viewUrl) {
                photoEntry.id = data.fileId || '';
                photoEntry.viewUrl = data.viewUrl;
                photoEntry.thumbUrl = data.thumbUrl || data.viewUrl;
                photoEntry.directUrl = data.directUrl || '';
                photoEntry.uploading = false;
                photoEntry.error = false;
                delete photoEntry.rawBase64;
            } else {
                throw new Error(data?.message || 'Upload failed');
            }
        } catch (err) {
            photoEntry.uploading = false;
            photoEntry.error = true;
            showToast('⚠️ อัปโหลดรูปไม่สำเร็จ กดปุ่ม 🔄 บนรูปเพื่อลองใหม่');
        }
        renderModalPhotoPreviewStrip();
    }

    async function handleModalPhotoFilesSelected(event) {
        const files = Array.from(event.target?.files || []);
        if (event.target) event.target.value = '';
        if (!files.length) return;

        const remain = 4 - modalStagedPhotos.length;
        if (remain <= 0) {
            showToast('⚠️ แนบรูปได้สูงสุด 4 รูปต่อใบงาน');
            return;
        }
        const selected = files.slice(0, remain);
        const sk = currentEditingJobType === 'fault' ? 'fault_reports_all' : 'elecReportsComplete_all';
        const item = JSON.parse(localStorage.getItem(sk) || '[]').find(i => (currentEditingJobType === 'fault' ? i?.timestamp : i?.dateTimeSaved) === currentEditingJobKey);
        const jobLbl = currentEditingJobType === 'fault'
            ? `${item?.circuit || 'TR'}_${item?.station || ''}`
            : `Job${item?.jobNo || '1'}_S${getEffectiveJobShift(item)}`;

        for (const f of selected) {
            try {
                const compressed = await compressImageFileToJpegBase64(f);
                const entry = {
                    localId: 'ph_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                    previewSrc: compressed.dataUrl,
                    rawBase64: compressed.rawBase64,
                    jobLabel: jobLbl,
                    uploading: true,
                    error: false
                };
                modalStagedPhotos.push(entry);
                renderModalPhotoPreviewStrip();
                uploadSingleStagedPhoto(entry);
            } catch (e) {
                showToast('❌ ไม่สามารถอ่านไฟล์รูปภาพนี้ได้');
            }
        }
    }

    function removeModalPendingPhoto(localId) {
        modalStagedPhotos = modalStagedPhotos.filter(p => p.localId !== localId);
        renderModalPhotoPreviewStrip();
    }

    function retryModalPhotoUpload(localId) {
        const target = modalStagedPhotos.find(p => p.localId === localId);
        if (target && target.rawBase64) uploadSingleStagedPhoto(target);
    }

    function openInspectModal(key, jobType = 'outage') {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        if (isRepairMapFullscreen && typeof toggleRepairJobsMapFullscreen === 'function') toggleRepairJobsMapFullscreen();
        ensureInspectModalExtrasInjected();

        currentEditingJobKey = key;
        currentEditingJobType = jobType;
        const sk = jobType === 'fault' ? 'fault_reports_all' : 'elecReportsComplete_all';
        const item = JSON.parse(localStorage.getItem(sk) || '[]').find(i => (jobType === 'fault' ? i?.timestamp : i?.dateTimeSaved) === key);
        if (!item) return;

        const meterBox = document.getElementById('modalMeterFormQuickBox');
        if (meterBox) meterBox.classList.toggle('hidden', jobType !== 'outage');

        const summaryEl = document.getElementById('modalJobSummary');
        if (summaryEl) {
            summaryEl.innerHTML = jobType === 'outage'
                ? `<div class="font-bold text-slate-800">📋 งานที่ ${escapeHtmlStr(item.jobNo || '-')} (กะ ${escapeHtmlStr(getEffectiveJobShift(item))}) • วันที่ ${escapeHtmlStr(getJobDateDisplay(item))}</div><div>⚡ อาการรับแจ้ง: ${escapeHtmlStr(item.issueType || '-')}</div><div>🗺️ บริเวณ/ที่อยู่: ${escapeHtmlStr(item.area || '-')} ${escapeHtmlStr(item.address || '')}</div>`
                : `<div class="font-bold text-slate-800">⚡ วงจร ${escapeHtmlStr(item.circuit || '-')} สถานี${escapeHtmlStr(item.station || '-')} (${escapeHtmlStr(item.system || '-')})</div><div>🚨 เหตุ: ${escapeHtmlStr(item.cause || '-')} • โชว์เฟส: ${escapeHtmlStr(item.phase || '-')}</div>`;
        }

        const rep = getEffectiveJobReport(item, key, readClosedReg());
        const now = new Date();
        const nowStr = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')} น.`;
        const defaultInspector = formatTechDisplayName(localStorage.getItem('elec_app_current_user') || '');

        document.getElementById('techStatusInput').value = rep?.status || 'แก้ไขเสร็จสิ้น (จ่ายไฟคืนแล้ว)';
        document.getElementById('techCauseInput').value = (rep?.realCause && rep.realCause !== '-') ? rep.realCause : '';
        document.getElementById('techActionInput').value = (rep?.actionTaken && rep.actionTaken !== '-') ? rep.actionTaken : '';
        document.getElementById('techFinishTimeInput').value = (rep?.finishTime && rep.finishTime !== '-') ? rep.finishTime : nowStr;
        document.getElementById('techInspectorInput').value = (rep?.inspector && rep.inspector !== '-') ? formatTechDisplayName(rep.inspector) : defaultInspector;

        let defaultGps = (rep?.fieldGps && rep.fieldGps !== '-') ? rep.fieldGps : ((item.gps && item.gps !== '-') ? item.gps : '');
        if (!defaultGps && isGpsTrackingEnabled && lastKnownTechCoords) {
            defaultGps = `https://www.google.com/maps?q=${lastKnownTechCoords.lat.toFixed(6)},${lastKnownTechCoords.lon.toFixed(6)}`;
        }
        document.getElementById('techGpsInput').value = defaultGps;

        modalStagedPhotos = getNormalizedReportPhotos(rep).map((p, idx) => ({
            localId: 'existing_' + idx + '_' + Date.now(),
            id: p.id || '',
            viewUrl: p.viewUrl || '',
            thumbUrl: p.thumbUrl || p.viewUrl || '',
            directUrl: p.directUrl || '',
            previewSrc: p.thumbUrl || p.directUrl || p.viewUrl || '',
            uploading: false,
            error: false
        }));
        renderModalPhotoPreviewStrip();

        document.getElementById('inspectModal')?.classList.remove('hidden');
    }

    function closeInspectModal() {
        stopActiveVoiceSession();
        document.getElementById('inspectModal')?.classList.add('hidden');
        currentEditingJobKey = null;
    }

    async function submitTechReport(sendToLine = false) {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        if (isSubmittingTechReport || !currentEditingJobKey) return;
        if (modalStagedPhotos.some(p => p.uploading)) {
            showToast('⏳ กรุณารออัปโหลดรูปภาพขึ้น Google Drive สักครู่...');
            return;
        }

        isSubmittingTechReport = true;
        try {
            Core.unlockCloudWrite(25000);
            const key = currentEditingJobKey;
            const jobType = currentEditingJobType;
            const sk = jobType === 'fault' ? 'fault_reports_all' : 'elecReportsComplete_all';
            const list = JSON.parse(localStorage.getItem(sk) || '[]');
            const idx = list.findIndex(i => (jobType === 'fault' ? i?.timestamp : i?.dateTimeSaved) === key);
            if (idx === -1) { closeInspectModal(); return; }

            const status = (document.getElementById('techStatusInput')?.value || 'แก้ไขเสร็จสิ้น (จ่ายไฟคืนแล้ว)').trim();
            const realCause = (document.getElementById('techCauseInput')?.value || '').trim() || 'ตรวจสอบแล้วกระแสไฟปกติ';
            const actionTaken = (document.getElementById('techActionInput')?.value || '').trim() || 'ดำเนินการแก้ไขและจ่ายไฟคืนเรียบร้อย';
            const fieldGps = normalizeCoordPairToMapsUrl((document.getElementById('techGpsInput')?.value || '').trim());
            const now = new Date();
            const finishTime = (document.getElementById('techFinishTimeInput')?.value || '').trim() || `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')} น.`;
            const inspector = (document.getElementById('techInspectorInput')?.value || '').trim() || formatTechDisplayName(localStorage.getItem('elec_app_current_user') || 'ช่างหน้างาน');

            const item = list[idx];
            const prevMaxMs = Math.max(
                item.techReport?.updatedAt ? (new Date(item.techReport.updatedAt).getTime() || 0) : 0,
                item.techNav?.updatedAt ? (new Date(item.techNav.updatedAt).getTime() || 0) : 0,
                item.reopenedAt ? (new Date(item.reopenedAt).getTime() || 0) : 0
            );
            const safeIso = new Date(Math.max(Date.now(), prevMaxMs > 0 ? prevMaxMs + 1000 : 0)).toISOString();

            const validPhotos = modalStagedPhotos
                .filter(p => !p.error && p.viewUrl)
                .map(p => ({ id: p.id || '', viewUrl: p.viewUrl, thumbUrl: p.thumbUrl || p.viewUrl, directUrl: p.directUrl || '' }));

            const rep = {
                status,
                realCause,
                actionTaken,
                fieldGps: fieldGps || item.gps || '',
                finishTime,
                inspector,
                ...(validPhotos.length > 0 ? { photos: validPhotos, photoUrls: validPhotos.map(p => p.viewUrl) } : {}),
                updatedAt: safeIso,
                needsMainSync: true
            };

            const isDone = status.includes('เสร็จสิ้น');
            item.techReport = rep;
            if (fieldGps && fieldGps !== '-') item.gps = fieldGps;

            if (isDone) {
                stopRealtimeGpsWatch(key);
                delete item.techNav;
                delete item.reopenedAt;
                item.navCancelledAt = safeIso;
                const cancelMap = getCancelledJobNavMap();
                cancelMap[key] = safeIso;
                saveCancelledJobNavMap(cancelMap);
                const closedReg = readClosedReg();
                closedReg[key] = { ...rep };
                delete closedReg[key].needsMainSync;
                writeClosedReg(closedReg);
            } else {
                const closedReg = readClosedReg();
                if (closedReg[key]) { delete closedReg[key]; writeClosedReg(closedReg); }
            }

            // หากเป็นงานสับเปลี่ยนมิเตอร์ที่เพิ่งตรวจพบหน้างาน ให้แนบลิงก์ใบมิเตอร์พร้อมข้อมูลอัตโนมัติไว้ท้ายข้อความต้นฉบับด้วย
                                    let baseText = (item.formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0];
            if (jobType === 'outage') {
                const shortMeterLink = buildTechMeterFormUrl(item, key, null, true);
                if (baseText.includes('meter-form.html?')) {
                    baseText = baseText.replace(/https?:\/\/[^\s]+meter-form\.html\?[^\s]+/g, shortMeterLink);
                } else if (!baseText.includes('ใบแจ้งสับเปลี่ยนมิเตอร์')) {
                    const checkMeterBlob = `${item.issueType || ''} ${realCause} ${actionTaken}`.toLowerCase().replace(/\s+/g, '');
                    if (checkMeterBlob.includes('มิเตอร์') && !['ต่อสายมิเตอร์', 'ต่อมิเตอร์', 'ต่อกลับมิเตอร์', 'ติดมิเตอร์', 'ใส่มิเตอร์'].some(kw => checkMeterBlob.includes(kw))) {
                        baseText += `\n\n📄***ใบแจ้งสับเปลี่ยนมิเตอร์ชำรุดมิเตอร์***   \n${shortMeterLink}`;
                    }
                }
            }
            const urg = getJobUrgencyInfo(item, jobType);
            const hdr = jobType === 'outage'
                ? `${urg.dot} งานที่ ${item.jobNo || '-'} กะ ${getEffectiveJobShift(item)} (${item.issueType || '-'})`
                : `${urg.dot} วงจร ${item.circuit || '-'} สถานี${item.station || '-'} (${item.system || '-'})`;
            const gpsLine = rep.fieldGps && rep.fieldGps !== '-' ? `\n📍 พิกัดหน้างาน : ${rep.fieldGps}` : '';
            const photoLines = formatTechPhotosTextLines(rep);
            const fullText = `${baseText}\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---\n${hdr}\n🚦 สถานะ : ${status}\n🔍 สาเหตุจริง : ${realCause}\n🛠️ การแก้ไข : ${actionTaken}\n⏰ เวลาเสร็จ : ${finishTime}\n👷 ผู้ตรวจสอบ : ${inspector}${gpsLine}${photoLines}`;
            item.formattedText = fullText;

            localStorage.setItem(sk, JSON.stringify(list));
            markJobDirtyForPush(key);
            closeInspectModal();

            if (isDone) switchStatusTab('done');
            else renderJobCards(true);

            copyTextToClipboard(fullText, '✅ บันทึกผลตรวจสอบและคัดลอกข้อความสำเร็จ!');
            if (sendToLine) {
                window.open('https://line.me/R/share?text=' + encodeURIComponent(fullText), '_blank');
            }
            await pushAllJobsToCloud(true);
        } finally {
            isSubmittingTechReport = false;
        }
    }

    async function reopenClosedJob(key, jobType = 'outage') {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        showCustomConfirm('ต้องการเปิดใบงานนี้ซ้ำและย้ายกลับไปยังช่อง "รอแก้ไข" ใช่หรือไม่?', async () => {
            Core.unlockCloudWrite(25000);
            const sk = jobType === 'fault' ? 'fault_reports_all' : 'elecReportsComplete_all';
            const list = JSON.parse(localStorage.getItem(sk) || '[]');
            const idx = list.findIndex(i => (jobType === 'fault' ? i?.timestamp : i?.dateTimeSaved) === key);
            if (idx === -1) return;

            const item = list[idx];
            const prevRepMs = item.techReport?.updatedAt ? (new Date(item.techReport.updatedAt).getTime() || 0) : 0;
            const reopenIso = new Date(Math.max(Date.now(), prevRepMs > 0 ? prevRepMs + 2000 : 0)).toISOString();

            delete item.techReport;
            delete item.techNav;
            item.reopenedAt = reopenIso;
            item.formattedText = (item.formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0];
            localStorage.setItem(sk, JSON.stringify(list));

            const closedReg = readClosedReg();
            if (closedReg[key]) { delete closedReg[key]; writeClosedReg(closedReg); }

            markJobDirtyForPush(key);
            switchStatusTab('pending');
            showToast('🔄 ย้ายใบงานกลับไปช่อง "รอแก้ไข" เรียบร้อยแล้ว');
            await pushAllJobsToCloud(true);
        }, '🔄 ยืนยันการเปิดใบงานซ้ำ');
    }

        function stopActiveVoiceSession() {
        if (autoSubmitVoiceTimer) { clearTimeout(autoSubmitVoiceTimer);
            autoSubmitVoiceTimer = null; }
        document.getElementById('voiceAutoSaveBanner')?.remove();
        if (activeVoiceRecognition) {
            try { activeVoiceRecognition.stop(); } catch (e) {}
            activeVoiceRecognition = null;
        }
    }
    
    function startVoice(inputId) {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { showToast('⚠️ เบราว์เซอร์นี้ไม่รองรับการพิมพ์ด้วยเสียง'); return; }
        const el = document.getElementById(inputId);
        if (!el) return;

        stopActiveVoiceSession();
        const rec = new SR();
        activeVoiceRecognition = rec;
        rec.lang = 'th-TH';
        rec.onstart = () => showToast('🎙️ กำลังฟัง... พูดได้เลยครับ');
        rec.onresult = e => {
            const txt = e.results[0][0].transcript;
            el.value = el.value ? `${el.value} ${txt}` : txt;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        rec.onerror = () => showToast('❌ รับเสียงไม่สำเร็จ กรุณาลองใหม่');
        rec.onend = () => { if (activeVoiceRecognition === rec) activeVoiceRecognition = null; };
        rec.start();
    }
    function cancelVoiceAutoSubmit() {
        if (autoSubmitVoiceTimer) {
            clearTimeout(autoSubmitVoiceTimer);
            autoSubmitVoiceTimer = null;
        }
        const bar = document.getElementById('voiceAutoSaveBanner');
        if (bar) bar.remove();
    }

    function parseSpokenRepairSummary(spokenText) {
        const clean = String(spokenText || '').trim();
        const presetCauses = [
            [/ฟิวส์แรงต่ำขาด|ฟิวส์ขาด/, 'ฟิวส์แรงต่ำขาด'],
            [/ฟิวส์แรงสูงขาด|ดรอปเอาท์|ดรอปฟิวส์/, 'ฟิวส์แรงสูงขาด (Drop Out Fuse)'],
            [/กิ่งไม้|ต้นไม้/, 'กิ่งไม้แตะสายไฟ / ต้นไม้ล้มทับสาย'],
            [/กระรอก|นก|งู|สัตว์/, 'สัตว์เลื้อยคลาน / นก / กระรอก'],
            [/สายเมน.*หลวม|จุดต่อ.*ช็อต|ขั้วหลวม/, 'สายเมนเข้าบ้านหลวม / ช็อตที่จุดต่อ'],
            [/มิเตอร์ชำรุด|ขั้วมิเตอร์ไหม้|มิเตอร์ไหม้/, 'มิเตอร์ชำรุด / ขั้วมิเตอร์ไหม้'],
            [/เบรกเกอร์|ภายในบ้าน/, 'เบรกเกอร์/อุปกรณ์ภายในบ้านผู้ใช้ไฟชำรุด'],
            [/ไฟปกติ|กระแสไฟปกติ/, 'ตรวจสอบแล้วกระแสไฟปกติ']
        ];

        const actionMatch = clean.match(/(เปลี่ยน|ดำเนินการ|แก้ไข|ตัดกิ่งไม้|ริดกิ่งไม้|สับเปลี่ยน|ต่อสาย|ขันแน่น|พันเทป|ยกเบรกเกอร์|จ่ายไฟ).*/);
        let cause = '';
        let action = '';

        for (const [re, label] of presetCauses) {
            if (re.test(clean)) { cause = label; break; }
        }
        if (actionMatch) {
            action = actionMatch[0].trim();
            if (!cause) cause = clean.slice(0, actionMatch.index).trim();
        }
        if (!cause) cause = clean;
        if (!action) action = `${clean} (ดำเนินการแก้ไขและจ่ายไฟคืนปกติ)`;
        return { cause, action };
    }

    function quickVoiceCloseJob(key, jobType = 'outage', btnEl = null) {
        if (isViewerRole()) { showToast(VIEWER_LOCK_MSG); return; }
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            openInspectModal(key, jobType);
            showToast('⚠️ เบราว์เซอร์ไม่รองรับคำสั่งเสียง กรุณากดไมค์บนแป้นพิมพ์');
            return;
        }

        ensureTechAudioUnlocked();
        stopActiveVoiceSession();
        const origHtml = btnEl ? btnEl.innerHTML : '';
        if (btnEl) {
            btnEl.innerHTML = '🎙️ กำลังฟัง...';
            btnEl.classList.add('animate-pulse', 'ring-2', 'ring-amber-300');
        }

        const rec = new SR();
        activeVoiceRecognition = rec;
        rec.lang = 'th-TH';
        showToast('🎙️ พูดสาเหตุและการแก้ไขได้เลย เช่น "ฟิวส์แรงต่ำขาด เปลี่ยนฟิวส์ 30A จ่ายไฟปกติ"');

        const restoreBtn = () => {
            if (btnEl) {
                btnEl.innerHTML = origHtml || '🎙️ พูดปิดงาน';
                btnEl.classList.remove('animate-pulse', 'ring-2', 'ring-amber-300');
            }
        };

        rec.onresult = e => {
            restoreBtn();
            const transcript = (e.results?.[0]?.[0]?.transcript || '').trim();
            if (!transcript) return;

            openInspectModal(key, jobType);
            const parsed = parseSpokenRepairSummary(transcript);
            const statusEl = document.getElementById('techStatusInput');
            const causeEl = document.getElementById('techCauseInput');
            const actionEl = document.getElementById('techActionInput');
            if (statusEl) statusEl.value = 'แก้ไขเสร็จสิ้น (จ่ายไฟคืนแล้ว)';
            if (causeEl) causeEl.value = parsed.cause;
            if (actionEl) actionEl.value = parsed.action;

            cancelVoiceAutoSubmit();
            const modalBody = document.querySelector('#inspectModal .p-4.overflow-y-auto');
            if (modalBody) {
                const bar = document.createElement('div');
                bar.id = 'voiceAutoSaveBanner';
                bar.className = 'p-2.5 bg-amber-50 border-2 border-amber-400 rounded-xl text-amber-950 text-xs font-bold flex items-center justify-between gap-2';
                bar.innerHTML = `<span class="min-w-0 truncate">🎙️ "${escapeHtmlStr(transcript)}" — ปิดงานอัตโนมัติใน 3 วิ</span><button type="button" onclick="cancelVoiceAutoSubmit()" class="bg-amber-600 text-white px-2.5 py-1 rounded-lg text-[11px] shrink-0">⏸️ แก้ไข/แนบรูป</button>`;
                modalBody.insertBefore(bar, modalBody.firstChild);
                modalBody.querySelectorAll('input, textarea, select, label').forEach(inp => {
                    inp.addEventListener('pointerdown', cancelVoiceAutoSubmit, { once: true });
                    inp.addEventListener('focus', cancelVoiceAutoSubmit, { once: true });
                });
            }

            autoSubmitVoiceTimer = setTimeout(() => {
                cancelVoiceAutoSubmit();
                submitTechReport(false);
            }, 3200);
        };
        rec.onerror = () => { restoreBtn(); showToast('❌ ไม่ได้ยินเสียงพูด กรุณาแตะลองใหม่อีกครั้ง'); };
        rec.onend = () => { restoreBtn(); if (activeVoiceRecognition === rec) activeVoiceRecognition = null; };
        rec.start();
    }

    // ========================================================================
    // 10. ส่งออกฟังก์ชันสู่ Global & เริ่มต้นระบบหน้าช่างอัตโนมัติ
    // ========================================================================
        Object.assign(window, {
        handleTechLogin, handleTechLogout, checkTechAuth, goBackToMainPage, updateRoleNavigationUI,
        openTechOnlineModal, toggleGpsTracking, toggleSoundAlert, captureCurrentTechGpsForModal,
        syncJobsFromCloud, pushAllJobsToCloud,
        switchStatusTab, selectShiftFilter, switchJobTypeAndPending,
        onTechDateInputChanged, setTechDateFilterToday, clearTechDateFilter,
        renderJobCards, copyJobTextFromTech,
        handleStartNavigation, handleCancelNavigation,
        startEquipmentNavigation, stopEquipmentNavigation, getActiveEquipmentNavItems, updateEquipNavFloatingBanner,
        toggleRepairJobsMapCollapse, toggleRepairJobsMapFullscreen, toggleRepairJobTooltips, focusJobOnRepairMap, extractCoordsFromJob,
        openInspectModal, closeInspectModal, submitTechReport, reopenClosedJob, startVoice,
        quickVoiceCloseJob, cancelVoiceAutoSubmit,
        openTechPhotoLightbox, removeModalPendingPhoto, retryModalPhotoUpload,
        openTechMeterFormByKey, openTechMeterFormFromModal, buildTechMeterFormUrl
    });

    Core.onRealtimeChange(keys => {
        if (keys.some(k => k === 'elecReportsComplete_all' || k === 'fault_reports_all' || k.includes('jobs_registry') || k.includes('cancelled'))) {
            renderJobCards();
        }
        if (keys.some(k => k === 'elec_tech_locations_map' || k.includes('equip_nav'))) {
            updateEquipNavFloatingBanner();
            updateTechOnlineCountUI();
        }
        if (keys.includes('elec_user_accounts') || keys.includes('elec_app_current_role')) {
            updateRoleNavigationUI();
        }
    });

    function bootstrapTechWorkspace() {
        if (hasBootstrappedTechJobs) return;
        hasBootstrappedTechJobs = true;

        if (localStorage.getItem('meter_form_link') === LEGACY_GOOGLE_METER_LINK) {
            localStorage.setItem('meter_form_link', getTechMeterFormBaseUrl());
        }

        updateSoundToggleButtonUI();
        updateGpsToggleButtonUI();
        syncDateFilterButtonsUI();
        checkTechAuth();
        ensureInspectModalExtrasInjected();
        renderJobCards(true);

        if (localStorage.getItem('elec_app_logged_in') === 'true') {
            initTechGpsTracker(false);
            syncJobsFromCloud(true).then(() => {
                setTimeout(upgradeRepairJobsShortLinks, 600);
            });
        }

        setInterval(() => {
            updateLiveNavDomElements();
            if (document.getElementById('pea-equip-nav-banner')?.style.display === 'block') {
                updateEquipNavFloatingBanner();
            }
        }, 1000);

        setInterval(() => {
            if (document.hidden || localStorage.getItem('elec_app_logged_in') !== 'true') return;
            syncTickCounter++;
            if (!Core.isEmbeddedIframe) {
                Core.updateUserOnlineHeartbeat('📱 หน้าช่าง', isGpsTrackingEnabled ? lastKnownTechCoords : null, isGpsTrackingEnabled);
            }
            syncJobsFromCloud(true);
            if (!Core.isEmbeddedIframe && !isViewerRole() && (Date.now() - lastIdleHeartbeatWriteMs >= 45000)) {
                lastIdleHeartbeatWriteMs = Date.now();
                pushAllJobsToCloud(false);
            }
        }, 6000);
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', bootstrapTechWorkspace);
    } else {
        bootstrapTechWorkspace();
    }
})();
// ==================== จบไฟล์ tech-jobs.js (v6.5) ====================
