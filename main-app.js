// ============================================================================
// ⚡🏢 PEA SMART GRID — MAIN WORKSPACE & DISPATCH ENGINE v6.5 (main-app.js)
// ระบบหน้าหลักสำหรับ index.html (ซิงค์ยอดใบงาน + ส่งค่าเข้าใบมิเตอร์ชำรุดอัตโนมัติ)
// พาทที่ 1 / 2 : State, Meter Form URL Encoder, Auth, RBAC, Stations & AI Chat
// ============================================================================
(function() {
    'use strict';

    const Core = window.PeaCore;
    const VIEWER_LOCK_MSG = '🔒 บัญชีผู้สำรวจ (ดูอย่างเดียว) ไม่สามารถเพิ่ม แก้ไข หรือลบข้อมูลได้';
    const LEGACY_GOOGLE_METER_LINK = 'https://docs.google.com/forms/d/e/1FAIpQLSfBsBdIcZRKR5N9I4rCuBLEhIIWIuKCsiUbsa83DmKnNUPZZQ/viewform?pli=1&pli=1';
    const DRAFT_KEY_TAB1 = 'elec_draft_tab1_fault';
    const DRAFT_KEY_TAB2 = 'elec_draft_tab2_outage';
    const CLOUD_BACKUP_STORAGE_KEY = 'elec_cloud_group_backups_map';
    const SCADA_BRIDGE_CHANNEL = 'pea_scada_form_bridge_v1';
    const LAST_SHIFT_STATE_KEY = 'elec_last_shift_state';
    const RESET_LOCK_KEY = 'elec_shift_job_reset_lock';

    const DEFAULT_USER_ACCOUNTS = [
        { username: 'admin', password: '1234', role: 'admin', sessionToken: '', displayName: '' }
    ];

    const DEFAULT_LEFT_BOOKMARKS = [
        { name: '🛠️ หน้าช่าง (Page 2)', url: 'page2.html' },
        { name: '📄 ใบมิเตอร์ชำรุด', url: 'meter-form.html' },
        { name: '🌧️ เรดาร์ฝน Windy', url: 'https://embed.windy.com/embed2.html?lat=13.116&lon=101.095&zoom=10&level=surface&overlay=rain' },
        { name: '🗺️ Google Maps', url: 'https://www.google.com/maps?q=13.1361,101.0322&hl=th&z=13&output=embed' }
    ];

    let userAccountsList = [];
    let isSavingUsersToCloud = false;
    let lastCloudSaveTimestamp = 0;
    let collapsedUserGroups = new Set();

    let leftPopupWindowRef = null;
    let isExplicitLeftBrowserAction = false;

    let editingFaultId = null;
    let editingOutageId = null;
    let isTimeManuallyEdited = false;
    let isWeatherLockedByUser = false;
    let weatherStreamInterval = null;
    let isManualShiftOverride = false;
    let isManualJobNoOverride = false;

    let issueBarChartInstance = null;
    let systemDoughnutChartInstance = null;
    let currentFilteredFaults = [];
    let currentFilteredOutages = [];
    let cachedCloudJobs = [];
    let isUploadingFromMain = false;

    // เก็บข้อมูลลูกค้า/เลขมิเตอร์/เลข CA เบื้องหลังจากช่องวางข้อมูลผู้ใช้ไฟ เพื่อส่งเข้าใบมิเตอร์โดยไม่แสดงชื่อลูกค้าใน LINE
    let lastPastedCustomerMeta = { customerName: '', peaNo: '', caNo: '' };

    window.cloudEditedJobsOverrideMap = window.cloudEditedJobsOverrideMap || {};

    let authSessionEpochMain = 0;

    function normGrp(raw) {
        if (typeof window.normalizePeaGroupName === 'function') return window.normalizePeaGroupName(raw);
        let g = String(raw || '').trim().replace(/\s+/g, ' ');
        g = g.replace(/^(กฟ[ก-ฮ]{1,2})\.\s+/, '$1.').replace(/^(กฟ[สฟจตอยภผกนฉ])\s+/, '$1.').replace(/^(กฟ[สฟจตอยภผกนฉ])(?![.\s]|[ก-ฮ]\.|$)/, '$1.');
        return g.trim();
    }

    function escJsAttr(s) {
        return escapeHtmlStr(String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
    }

        const PM_LOC_PREFIX = '__PM_SCHEDULE__';
    const CALIB_LOC_PREFIX = '__FAULT_CALIB__';

    function isMainSysRegistryLoc(k, loc) {
        return !k || k === Core.REGISTRY_LOC_KEY || String(k).startsWith(PM_LOC_PREFIX) || String(k).startsWith(CALIB_LOC_PREFIX) || Boolean(loc && loc.isSystemRegistry);
    }

    function parseMainDateMs(rawStr) {
        if (!rawStr) return 0;
        if (typeof rawStr === 'number') return isNaN(rawStr) ? 0 : rawStr;
        const s = String(rawStr).trim();
        if (!s || s === '-') return 0;
        const th = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2})[:.](\d{1,2})(?:[:.](\d{1,2}))?)?/);
        if (th) {
            let yr = parseInt(th[3], 10) || 2569;
            if (yr > 2400) yr -= 543;
            const ms = new Date(
                yr, (parseInt(th[2], 10) || 1) - 1, parseInt(th[1], 10) || 1,
                parseInt(th[4] || '0', 10), parseInt(th[5] || '0', 10), parseInt(th[6] || '0', 10)
            ).getTime();
            if (!isNaN(ms) && ms > 0) return ms;
        }
        const t = new Date(s).getTime();
        return isNaN(t) ? 0 : t;
    }

    function normalizeThaiDateMain(rawStr) {
        const tok = String(rawStr || '').trim().split(/\s+/)[0];
        if (!tok || tok === '-') return '';
        const sp = tok.split('/');
        if (sp.length === 3) {
            const d = parseInt(sp[0], 10), m = parseInt(sp[1], 10);
            let y = parseInt(sp[2], 10);
            if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y > 0) {
                if (y < 100) y += 2500; else if (y < 2400) y += 543;
                return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
            }
        }
        return tok;
    }

    // ========================================================================
    // 📄 เอนจินสร้างลิงก์ใบรายงานมิเตอร์ชำรุดพร้อมฝังข้อมูลอัตโนมัติ (Base64URL UTF-8)
    // ========================================================================
    function getBuiltInMeterFormBaseUrl() {
        try {
            if (/^https?:$/i.test(window.location.protocol)) {
                const baseDir = window.location.pathname.replace(/[^/]*$/, '');
                return `${window.location.origin}${baseDir}meter-form.html`;
            }
        } catch (e) {}
        return 'meter-form.html';
    }

    function getConfiguredMeterFormBaseUrl() {
        const saved = String(Core.rawStorageGet('meter_form_link') || '').trim();
        if (!saved || saved === LEGACY_GOOGLE_METER_LINK || /^(?:\.\/|\/)?meter-form(?:\.html)?$/i.test(saved)) {
            return getBuiltInMeterFormBaseUrl();
        }
        return saved;
    }

    function encodeBase64UrlJson(obj) {
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

    function extractMeterMetaFromText(rawStr) {
        if (!rawStr || !String(rawStr).trim()) return { customerName: '', peaNo: '', caNo: '' };
        const s = String(rawStr).replace(
            /^(\s*(?:ชื่อผู้ใช้ไฟ(?:ฟ้า)?|ชื่อลูกค้า|ผู้ใช้ไฟ(?:ฟ้า)?|ชื่อผู้แจ้ง|มิเตอร์\s*-\s*PEA\s*No\.?|PEA\s*No\.?|หมายเลขมิเตอร์|หมายเลขผู้ใช้ไฟ(?:ฟ้า)?\s*\(?CA\)?|CA\s*(?:No\.?)?)\s*)\r?\n+\s*/gim,
            '$1 : '
        );

        let peaNo = '';
        const mPea = s.match(/(?:มิเตอร์\s*-\s*PEA\s*No\.?|PEA\s*No\.?|หมายเลขมิเตอร์|เลขมิเตอร์|เครื่องวัด)\s*[:：=]?\s*([A-Za-z0-9-]{4,20})/i);
        if (mPea) peaNo = mPea[1].trim();

        let caNo = '';
        const mCa = s.match(/(?:หมายเลขผู้ใช้ไฟ(?:ฟ้า)?\s*\(?CA\)?|CA\s*(?:No\.?)?)\s*[:：=]?\s*(\d{9,15})/i) ||
                    s.match(/(?:^|[^\d])(02\d{10})(?!\d)/);
        if (mCa) caNo = mCa[1].trim();

        let customerName = '';
        const mCust = s.match(/(?:👤\s*)?(?:ชื่อผู้ใช้ไฟ(?:ฟ้า)?|ชื่อลูกค้า|ผู้ใช้ไฟ(?:ฟ้า)?|ชื่อผู้แจ้ง|ชื่อ-นามสกุล|ชื่อ-สกุล)\s*[:：=]?\s*([^\r\n]+)/i);
        if (mCust && mCust[1]) {
            let rawName = mCust[1].trim();
            const addrTail = rawName.match(/\s+\d+(?:\/\d+)?\s*(?:ม\.|หมู่|ต\.|ตำบล|ซ\.|ซอย|ถ\.|ถนน).*$/);
            if (addrTail) rawName = rawName.slice(0, addrTail.index).trim();
            if (rawName && rawName !== '-') customerName = rawName;
        }
        if (!customerName) {
            const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            for (const ln of lines) {
                if (/^(?:(?:คุณ|นาย|นาง|น\.ส\.|นางสาว)\s*)[ก-๙]{2,25}(?:\s+[ก-๙]{2,30})?$/.test(ln) &&
                    !/(?:ม\.|หมู่|ต\.|ตำบล|ซอย|ถนน|บ้าน|ไฟ|มิเตอร์|ผู้ปฏิบัติงาน)/.test(ln)) {
                    customerName = ln.trim();
                    break;
                }
            }
        }
        return { customerName, peaNo, caNo };
    }

        function makeShortJobId(dateTimeSaved) {
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

    function encodeUtf8Base64Url(str) {
        try {
            const bytes = new TextEncoder().encode(String(str || '').trim());
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        } catch (e) { return ''; }
    }

            function generateRandomMeterKey() {
        const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
        const arr = new Uint8Array(6);
        if (window.crypto?.getRandomValues) window.crypto.getRandomValues(arr);
        else
            for (let i = 0; i < 6; i++) arr[i] = Math.floor(Math.random() * 256);
        return Array.from(arr, b => chars[b % chars.length]).join('');
    }
    
    function buildShortMeterUrl(dateTimeSaved, ownerGroup, forExternalLine = false, meterKey = '') {
        const baseUrl = getConfiguredMeterFormBaseUrl();
        if (!baseUrl || /docs\.google\.com\/forms/i.test(baseUrl)) return baseUrl;
        const cleanBase = baseUrl.split('?')[0];
        const shortId = makeShortJobId(dateTimeSaved);
        if (!shortId) return cleanBase;
        const grp = normGrp(ownerGroup || getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
        const grpParam = (grp !== 'กฟส.บึง') ? `&grp=${encodeUtf8Base64Url(grp)}` : '';
        const keyParam = meterKey ? `&k=${encodeURIComponent(meterKey)}` : '';
        const extParam = forExternalLine ? '&openExternalBrowser=1' : '';
        return `${cleanBase}?i=${shortId}${keyParam}${grpParam}${extParam}`;
    }
    
    function buildMeterFormUrlFromData(info) {
        if (info?.dateTimeSaved) {
            return buildShortMeterUrl(info.dateTimeSaved, info.ownerGroup, false, info.meterKey || '');
        }
        const baseUrl = getConfiguredMeterFormBaseUrl();
        if (!baseUrl || /docs\.google\.com\/forms/i.test(baseUrl)) return baseUrl || 'meter-form.html';
        const addrMeta = extractMeterMetaFromText(info.address || '');
        const tr = info.techReport || {};
        const draftObj = {
            office: normGrp(info.ownerGroup || getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง',
            jobLabel: (info.jobNo && info.jobNo !== '-') ? `งานที่ ${info.jobNo}${(info.shift && info.shift !== '-') ? ' กะ ' + info.shift : ''}` : '',
            reportDate: info.reportDate || '',
            shift: info.shift || '',
            oldPea: info.peaMeterNo || addrMeta.peaNo || '',
            ca: info.caNo || addrMeta.caNo || '',
            address: info.address || '',
            area: info.area || '',
            phone: info.phone || '',
            gps: (tr.fieldGps && tr.fieldGps !== '-') ? tr.fieldGps : (info.gps || ''),
            issue: info.issueType || '',
            realCause: tr.realCause || info.realCause || '',
            actionTaken: tr.actionTaken || info.actionTaken || '',
            customerName: info.customerName || addrMeta.customerName || '',
            workerName: (tr.inspector && tr.inspector !== '-') ? formatTechDisplayName(tr.inspector) : ((info.workerName && info.workerName !== '-') ? formatTechDisplayName(info.workerName) : formatTechDisplayName(Core.rawStorageGet('elec_app_current_user') || ''))
        };
        try { localStorage.setItem('pea_meter_live_draft', JSON.stringify(draftObj)); } catch (e) {}
        return `${baseUrl.split('?')[0]}?draft=1`;
    }

    // วาดไอคอนเหรียญตราสายฟ้าสีทอง 512x512 (ไม่เขียนทับหากลิงก์ชี้ไปที่ไฟล์ .png แท้แล้ว)
    function renderMainHomeIconPng() {
        try {
            const fav = document.getElementById('favIconPng') || document.getElementById('mainFavIconPng');
            const touch = document.getElementById('appleTouchIconPng') || document.getElementById('mainAppleTouchIconPng');
            if (!fav && !touch) return;
            const curHref = (fav?.getAttribute('href') || touch?.getAttribute('href') || '');
            if (/\.png(?:\?|$)/i.test(curHref)) return;

            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 512;
            const ctx = canvas.getContext('2d');

            const bgGrad = ctx.createRadialGradient(180, 140, 20, 256, 256, 380);
            bgGrad.addColorStop(0, '#1e3a8a');
            bgGrad.addColorStop(0.55, '#0f172a');
            bgGrad.addColorStop(1, '#060913');

            const r = 112;
            ctx.beginPath();
            ctx.moveTo(r, 0); ctx.lineTo(512 - r, 0); ctx.quadraticCurveTo(512, 0, 512, r);
            ctx.lineTo(512, 512 - r); ctx.quadraticCurveTo(512, 512, 512 - r, 512);
            ctx.lineTo(r, 512); ctx.quadraticCurveTo(0, 512, 0, 512 - r);
            ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
            ctx.closePath();
            ctx.fillStyle = bgGrad;
            ctx.fill();

            ctx.save();
            ctx.strokeStyle = 'rgba(250, 204, 21, 0.42)';
            ctx.lineWidth = 6;
            ctx.setLineDash([22, 14]);
            ctx.beginPath();
            ctx.arc(256, 256, 196, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();

            const glow = ctx.createRadialGradient(256, 256, 10, 256, 256, 170);
            glow.addColorStop(0, 'rgba(245, 158, 11, 0.45)');
            glow.addColorStop(1, 'rgba(245, 158, 11, 0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(256, 256, 170, 0, Math.PI * 2);
            ctx.fill();

            const boltGrad = ctx.createLinearGradient(140, 76, 370, 436);
            boltGrad.addColorStop(0, '#fef9c3');
            boltGrad.addColorStop(0.32, '#fde047');
            boltGrad.addColorStop(0.68, '#f59e0b');
            boltGrad.addColorStop(1, '#b45309');

            ctx.save();
            ctx.shadowColor = 'rgba(2, 6, 23, 0.65)';
            ctx.shadowBlur = 14;
            ctx.shadowOffsetX = 6;
            ctx.shadowOffsetY = 12;
            ctx.beginPath();
            ctx.moveTo(298, 76); ctx.lineTo(136, 282); ctx.lineTo(244, 282);
            ctx.lineTo(214, 436); ctx.lineTo(376, 230); ctx.lineTo(268, 230);
            ctx.closePath();
            ctx.fillStyle = boltGrad;
            ctx.fill();
            ctx.lineWidth = 5;
            ctx.lineJoin = 'round';
            ctx.strokeStyle = '#fef08a';
            ctx.stroke();
            ctx.restore();

            const pngUrl = canvas.toDataURL('image/png');
            if (fav) fav.href = pngUrl;
            if (touch) touch.href = pngUrl;
        } catch (e) {}
    }

    function guardNotViewer() {
        if (isViewerRole()) {
            showToast(VIEWER_LOCK_MSG);
            return false;
        }
        return true;
    }

    // ========================================================================
    // 1. ระบบเว็บเบราว์เซอร์ชิดขอบซ้ายจอ & เปิดผังวงจร SCADA คู่หน้าหลัก
    // ========================================================================
    function getLeftBrowserBookmarks() {
        try {
            const saved = Core.rawStorageGet('elec_left_browser_bookmarks');
            if (saved) return JSON.parse(saved);
        } catch (e) {}
        return DEFAULT_LEFT_BOOKMARKS;
    }

    function renderLeftBrowserBookmarks() {
        const bar = document.getElementById('leftBrowserBookmarksBar');
        if (!bar) return;
        const list = getLeftBrowserBookmarks();
        bar.innerHTML = `<span class="text-slate-400 font-semibold shrink-0">📌 ลิงก์ด่วน:</span>`;

        const scadaBtn = document.createElement('button');
        scadaBtn.type = 'button';
        scadaBtn.id = 'leftBmScadaQuickBtn';
        scadaBtn.onclick = openScadaDiagramWorkspace;
        scadaBtn.className = 'px-2.5 py-0.5 bg-teal-600 hover:bg-teal-500 text-white rounded-md font-bold shrink-0 border border-teal-400 shadow-sm transition';
        scadaBtn.innerHTML = '⚡ ผังวงจร SCADA';
        bar.appendChild(scadaBtn);

        list.forEach((bm, idx) => {
            const wrap = document.createElement('div');
            wrap.className = 'inline-flex items-center bg-slate-700/80 hover:bg-slate-600 text-slate-100 rounded-md overflow-hidden shrink-0 border border-slate-600 transition';
            const safeUrl = escJsAttr(bm.url || '');
            wrap.innerHTML = `
                <button type="button" onclick="loadLeftBrowserUrl('${safeUrl}', true)" class="px-2 py-0.5 font-medium truncate max-w-[160px]">${escapeHtmlStr(bm.name)}</button>
                <button type="button" onclick="removeLeftBrowserBookmark(${idx})" class="px-1.5 py-0.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 leading-none" title="ลบลิงก์นี้">&times;</button>
            `;
            bar.appendChild(wrap);
        });
    }

    function formatLeftBrowserUrl(rawUrl) {
        let u = String(rawUrl || '').trim();
        if (!u) return 'about:blank';
        if (u.startsWith('page2.html') || u.startsWith('meter-form.html') || u.startsWith('./') || u.startsWith('/')) return u;
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u;

        const ytMatch = u.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
        if (ytMatch) {
            const timeMatch = u.match(/[?&](?:t|start)=(\d+)/i);
            const startQuery = timeMatch ? `?start=${timeMatch[1]}&autoplay=1` : '?autoplay=1';
            return `https://www.youtube.com/embed/${ytMatch[1]}${startQuery}`;
        }
        return u;
    }

    function addLeftBrowserBookmark() {
        const url = (document.getElementById('leftBrowserUrlInput')?.value || '').trim();
        if (!url) {
            showToast('⚠️ กรุณาวางลิงก์ในช่องก่อนกดเก็บลิงก์');
            return;
        }
        showCustomPrompt('ตั้งชื่อปุ่มลิงก์ด่วน:', 'เว็บงานไฟฟ้า', function(name) {
            if (!name || !name.trim()) return;
            const list = getLeftBrowserBookmarks();
            list.push({ name: name.trim(), url: formatLeftBrowserUrl(url) });
            localStorage.setItem('elec_left_browser_bookmarks', JSON.stringify(list));
            renderLeftBrowserBookmarks();
            showToast('⭐ บันทึกลิงก์ด่วนเรียบร้อยแล้ว');
        }, '⭐ บันทึกลิงก์ด่วน');
    }

    function removeLeftBrowserBookmark(index) {
        const list = getLeftBrowserBookmarks();
        list.splice(index, 1);
        localStorage.setItem('elec_left_browser_bookmarks', JSON.stringify(list));
        renderLeftBrowserBookmarks();
    }

    async function pasteClipboardToLeftBrowser() {
        try {
            const text = await navigator.clipboard.readText();
            if (text && text.trim()) {
                loadLeftBrowserUrl(text.trim(), true);
                showToast('📋 ดึงลิงก์เข้าเบราว์เซอร์ฝั่งซ้ายแล้ว!');
            } else {
                showToast('⚠️ ไม่พบลิงก์ในคลิปบอร์ด');
            }
        } catch (e) {
            showToast('⚠️ กรุณากด Ctrl+V ในช่องลิงก์แล้วกด Enter');
        }
    }

    function openLeftWebBrowser() {
        const logoPanel = document.getElementById('leftLogoPanel');
        const dock = document.getElementById('leftBrowserDock');
        const mainApp = document.getElementById('mainAppContent');
        const savedWidth = Core.rawStorageGet('elec_left_browser_width') || '55vw';
        const isDesktop = window.innerWidth >= 1024;

        if (logoPanel) {
            logoPanel.classList.remove('lg:flex');
            logoPanel.classList.add('hidden');
        }
        if (dock) {
            dock.style.width = isDesktop ? savedWidth : '100vw';
            dock.classList.remove('hidden');
            dock.classList.add('flex', 'mobile-force-open');
        }
        if (mainApp) {
            mainApp.classList.remove('lg:grid-cols-2', 'max-w-7xl');
            mainApp.classList.add('lg:grid-cols-1', 'max-w-full');
            mainApp.style.paddingLeft = isDesktop ? savedWidth : '';
        }

        renderLeftBrowserBookmarks();
        const lastUrl = Core.rawStorageGet('elec_left_browser_last_url') || 'page2.html';
        loadLeftBrowserUrl(lastUrl, true);
        localStorage.setItem('elec_left_browser_open', 'true');
    }

    function closeLeftWebBrowser() {
        const logoPanel = document.getElementById('leftLogoPanel');
        const dock = document.getElementById('leftBrowserDock');
        const mainApp = document.getElementById('mainAppContent');
        const iframe = document.getElementById('leftBrowserIframe');
        const mobBar = document.getElementById('mobileScadaReturnBar');

        if (mobBar) {
            mobBar.classList.add('hidden');
            mobBar.classList.remove('flex');
        }
        if (iframe) iframe.src = 'about:blank';
        if (dock) {
            dock.classList.add('hidden');
            dock.classList.remove('flex', 'mobile-force-open');
        }
        if (logoPanel) logoPanel.classList.add('lg:flex');
        if (mainApp) {
            mainApp.classList.add('lg:grid-cols-2', 'max-w-7xl');
            mainApp.classList.remove('lg:grid-cols-1', 'max-w-full');
            mainApp.style.paddingLeft = '';
        }
        if (leftPopupWindowRef && !leftPopupWindowRef.closed) {
            leftPopupWindowRef.close();
        }
        localStorage.setItem('elec_left_browser_open', 'false');
    }

    function setLeftBrowserWidth(widthVal) {
        const dock = document.getElementById('leftBrowserDock');
        const mainApp = document.getElementById('mainAppContent');
        const isDesktop = window.innerWidth >= 1024;
        if (dock) dock.style.width = isDesktop ? widthVal : '100vw';
        if (mainApp) mainApp.style.paddingLeft = isDesktop ? widthVal : '';
        localStorage.setItem('elec_left_browser_width', widthVal);
    }

    function loadLeftBrowserUrl(rawUrl, isExplicit = false) {
        const dock = document.getElementById('leftBrowserDock');
        const iframe = document.getElementById('leftBrowserIframe');
        const inputEl = document.getElementById('leftBrowserUrlInput');
        const rawTrimmed = String(rawUrl || '').trim();

        if (!isExplicit && !isExplicitLeftBrowserAction && dock && !dock.classList.contains('hidden')) {
            const curSrc = iframe ? (iframe.getAttribute('src') || '') : '';
            if (curSrc.includes('page2.html') && rawTrimmed.includes('output=embed')) {
                return;
            }
        }

        if (/^(?:https?:\/\/)?(?:www\.)?youtube\.com\/?$/i.test(rawTrimmed)) {
            openLeftBrowserPopup('https://www.youtube.com');
            return;
        }

        const formatted = formatLeftBrowserUrl(rawUrl);
        if (inputEl) inputEl.value = rawTrimmed || formatted;
        if (iframe) iframe.src = formatted;
        localStorage.setItem('elec_left_browser_last_url', formatted);
    }

    function navigateLeftBrowser() {
        const inputEl = document.getElementById('leftBrowserUrlInput');
        if (inputEl) loadLeftBrowserUrl(inputEl.value, true);
    }

    function reloadLeftBrowser() {
        const iframe = document.getElementById('leftBrowserIframe');
        const inputEl = document.getElementById('leftBrowserUrlInput');
        if (iframe) {
            iframe.src = formatLeftBrowserUrl(inputEl?.value || iframe.src);
            showToast('🔄 รีเฟรชหน้าเว็บฝั่งซ้ายแล้ว');
        }
    }

    function openLeftBrowserPopup(overrideUrl) {
        const inputEl = document.getElementById('leftBrowserUrlInput');
        let url = String(overrideUrl || inputEl?.value || 'https://www.google.com').trim();
        if (!/^https?:\/\//i.test(url) && !url.startsWith('page2.html') && !url.startsWith('meter-form.html')) url = 'https://' + url;
        const w = Math.floor(window.screen.availWidth * 0.54);
        const h = window.screen.availHeight;
        leftPopupWindowRef = window.open(
            url,
            'LeftSideWebPopup',
            `width=${w},height=${h},left=0,top=0,resizable=yes,scrollbars=yes,toolbar=yes,location=yes`
        );
        showToast('🪟 เปิดหน้าต่างลอยชิดซ้ายแล้ว');
    }

    function openScadaDiagramWorkspace() {
        isExplicitLeftBrowserAction = true;
        localStorage.setItem('elec_left_browser_last_url', 'page2.html?tab=map');
        openLeftWebBrowser();

        const iframe = document.getElementById('leftBrowserIframe');
        if (iframe) {
            if (!(iframe.getAttribute('src') || '').includes('page2.html')) {
                iframe.src = 'page2.html?tab=map';
            }
            let attempts = 0;
            const switchTimer = setInterval(() => {
                attempts++;
                try {
                    if (iframe.contentWindow && typeof iframe.contentWindow.switchTechMainTab === 'function') {
                        iframe.contentWindow.switchTechMainTab('map');
                        clearInterval(switchTimer);
                    }
                } catch (e) {}
                if (attempts >= 25) clearInterval(switchTimer);
            }, 160);
        }

        if (window.innerWidth < 1024) {
            const mobBar = document.getElementById('mobileScadaReturnBar');
            if (mobBar) {
                mobBar.classList.remove('hidden');
                mobBar.classList.add('flex');
            }
        }
        setTimeout(() => { isExplicitLeftBrowserAction = false; }, 350);
        showToast('⚡ เปิดผังวงจร SCADA แล้ว (คลิกสวิตช์เพื่อส่งรหัสเข้าฟอร์มได้เลย)');
    }

    // ========================================================================
    // 2. ระบบล็อกอินหลังบ้าน (Level 2 Auth) & จัดมาตรฐานกลุ่มสังกัดให้ตรงกันทุกบัญชี
    // ========================================================================
    function initUserAccounts() {
        const saved = Core.rawStorageGet('elec_user_accounts');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                userAccountsList = (Array.isArray(parsed) && parsed.length > 0)
                    ? parsed.map(parseAccountRecord)
                    : [...DEFAULT_USER_ACCOUNTS];
            } catch (e) {
                userAccountsList = [...DEFAULT_USER_ACCOUNTS];
            }
        } else {
            userAccountsList = [...DEFAULT_USER_ACCOUNTS];
            localStorage.setItem('elec_user_accounts', JSON.stringify(userAccountsList));
        }
    }

    async function fetchUserAccountsFromCloud(silent = true, forceFetch = false) {
        if (!forceFetch && (isSavingUsersToCloud || (Date.now() - lastCloudSaveTimestamp < 6000))) {
            return true;
        }
        const statusEl = document.getElementById('cloudSyncStatusText');
        if (statusEl && !silent) statusEl.textContent = '⏳ กำลังดึงข้อมูลบัญชีจากชีตหลัก...';

        try {
            if (!silent || forceFetch) Core.forceCloudRead();
            const res = await fetch(getActiveCloudApiUrl() + '?t=' + Date.now(), { method: 'GET', cache: 'no-store' });
            const data = await res.json();
            if (data?.status === 'ok' && Array.isArray(data.users) && data.users.length > 0) {
                userAccountsList = data.users.map(parseAccountRecord);
                localStorage.setItem('elec_user_accounts', JSON.stringify(userAccountsList));
                if (statusEl) statusEl.textContent = `🟢 ซิงค์บัญชีจากชีตหลักล่าสุดแล้ว (${userAccountsList.length} บัญชี)`;
                const modal = document.getElementById('userManageModal');
                if (modal && !modal.classList.contains('hidden')) {
                    renderUserAccountList();
                }
                verifyActiveSessionRole();
                return true;
            }
        } catch (err) {
            if (statusEl && !silent) statusEl.textContent = '⚠️ ไม่สามารถเชื่อมต่อชีตหลัก (ใช้ข้อมูลในเครื่อง)';
        }
        return false;
    }

    async function saveUserAccounts() {
        localStorage.setItem('elec_user_accounts', JSON.stringify(userAccountsList));
        if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot();

        isSavingUsersToCloud = true;
        lastCloudSaveTimestamp = Date.now();
        const statusEl = document.getElementById('cloudSyncStatusText');
        if (statusEl) statusEl.textContent = '⏳ กำลังบันทึกบัญชีและสร้างชีตประจำ กฟส. อัตโนมัติ...';

        try {
            Core.unlockCloudWrite(20000);
            const payloadUsers = userAccountsList.map(u => ({
                username: normalizeUsernameFormat(u.username),
                password: u.password,
                role: `${u.role || 'user'}::${u.sessionToken || ''}::${(u.displayName || '').replace(/::/g, ' ').trim()}`
            }));
            const res = await fetch(getActiveCloudApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({ action: 'saveUsers', users: payloadUsers })
            });
            const data = await res.json();
            isSavingUsersToCloud = false;
            lastCloudSaveTimestamp = Date.now();
            if (data?.status === 'ok') {
                if (statusEl) statusEl.textContent = '🟢 บันทึกบัญชีสำเร็จ (เข้ารหัส SHA-256 & เชื่อมชีต กฟส. อัตโนมัติแล้ว)';
                return true;
            }
        } catch (err) {
            isSavingUsersToCloud = false;
            if (statusEl) statusEl.textContent = '⚠️ เกิดข้อผิดพลาดในการส่งข้อมูลขึ้น Google Sheets';
        }
        return false;
    }

    function applyViewerReadOnlyBannerUI() {
        const viewer = isViewerRole();
        document.body.classList.toggle('role-viewer-readonly', viewer);
        let banner = document.getElementById('viewerReadOnlyBanner');
        if (viewer) {
            if (!banner) {
                const header = document.querySelector('#mainAppContent .bg-gradient-to-r');
                if (header) {
                    banner = document.createElement('div');
                    banner.id = 'viewerReadOnlyBanner';
                    banner.className = 'mt-3 bg-cyan-950/80 border border-cyan-400/50 text-cyan-100 px-3 py-1.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 shadow-inner';
                    banner.innerHTML = '<span>👁️ โหมดผู้สำรวจ: ดูข้อมูลและแผนที่อย่างเดียว (ไม่สามารถเพิ่ม/แก้ไข/ลบข้อมูลได้)</span>';
                    header.appendChild(banner);
                }
            }
        } else if (banner) {
            banner.remove();
        }
    }

    function verifyActiveSessionRole() {
        if (Core.rawStorageGet('elec_app_logged_in') !== 'true') return;
        const loggedUser = Core.rawStorageGet('elec_app_current_user') || '';
        const verifiedAcc = userAccountsList.find(a => isUsernameMatchingAccount(loggedUser, a.username));
        if (!verifiedAcc) return;

        const prevGrp = normGrp(Core.rawStorageGet('elec_app_current_group') || '');
        const fullCanonicalName = normalizeUsernameFormat(verifiedAcc.username);
        const realRole = verifiedAcc.role || 'user';
        const resolvedGrp = normGrp(getUserGroupName(fullCanonicalName)) ||
            (realRole !== 'admin' ? (prevGrp || normGrp(getCurrentUserGroup()) || 'กฟส.บึง') : '');

        localStorage.setItem('elec_app_current_user', fullCanonicalName);
        localStorage.setItem('elec_app_current_group', resolvedGrp);
        localStorage.setItem('elec_app_current_role', realRole);

        if (realRole === 'tech') {
            window.location.href = 'page2.html';
            return;
        }
        const adminBtn = document.getElementById('adminUserManageBtn');
        if (adminBtn) {
            adminBtn.classList.toggle('hidden', realRole !== 'admin');
            adminBtn.classList.toggle('flex', realRole === 'admin');
        }
        applyViewerReadOnlyBannerUI();
        if (typeof injectOnlineHeaderButton === 'function') injectOnlineHeaderButton();
        if (typeof injectCloudManagerHeaderButton === 'function') injectCloudManagerHeaderButton();
        if (prevGrp !== resolvedGrp) {
            if (typeof loadOutageHistory === 'function') loadOutageHistory();
            if (typeof loadFaultHistory === 'function') loadFaultHistory();
            if (typeof autoFillJobNo === 'function') autoFillJobNo(true);
        }
    }

    function checkLoginStatus() {
        initUserAccounts();
        const isLoggedIn = Core.rawStorageGet('elec_app_logged_in') === 'true';
        const loginScreen = document.getElementById('loginScreen');
        const mainContent = document.getElementById('mainAppContent');
        const adminBtn = document.getElementById('adminUserManageBtn');

        if (isLoggedIn) {
            const currentRole = Core.rawStorageGet('elec_app_current_role') || 'user';
            if (currentRole === 'tech') {
                window.location.href = 'page2.html';
                return;
            }
            if (currentRole !== 'admin') {
                const ensuredGrp = normGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
                if (Core.rawStorageGet('elec_app_current_group') !== ensuredGrp) {
                    localStorage.setItem('elec_app_current_group', ensuredGrp);
                }
            }
            if (adminBtn) {
                adminBtn.classList.toggle('hidden', currentRole !== 'admin');
                adminBtn.classList.toggle('flex', currentRole === 'admin');
            }
            if (loginScreen) {
                loginScreen.classList.add('hidden');
                loginScreen.style.display = 'none';
            }
            if (mainContent) {
                mainContent.classList.remove('hidden');
                mainContent.classList.add('grid');
                mainContent.style.display = '';
            }
            Core.updateUserOnlineHeartbeat('💻 หน้าหลัก', null, false);
        } else {
            if (typeof clearStuckEditModes === 'function') clearStuckEditModes();
            if (adminBtn) {
                adminBtn.classList.add('hidden');
                adminBtn.classList.remove('flex');
            }
            if (loginScreen) {
                loginScreen.classList.remove('hidden');
                loginScreen.style.display = 'flex';
            }
            if (mainContent) {
                mainContent.classList.remove('grid');
                mainContent.classList.add('hidden');
                mainContent.style.display = 'none';
            }
        }
        applyViewerReadOnlyBannerUI();
        if (typeof injectOnlineHeaderButton === 'function') injectOnlineHeaderButton();
        if (typeof injectCloudManagerHeaderButton === 'function') injectCloudManagerHeaderButton();
    }

    async function handleLogin() {
        const userInput = document.getElementById('loginUsername');
        const passInput = document.getElementById('loginPassword');
        const username = (userInput?.value || '').trim();
        const pass = (passInput?.value || '').trim();

        if (!username || !pass) {
            showCustomAlert('⚠️ กรุณากรอกรหัสพนักงานและรหัสผ่านให้ครบถ้วน', '⚡ ระบบจัดการงานไฟฟ้า');
            return;
        }

        const loginBtn = document.querySelector('#loginScreen button[onclick="handleLogin()"]');
        const origText = loginBtn ? loginBtn.textContent : 'เข้าสู่ระบบ';
        if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = '⏳ กำลังตรวจสอบรหัสผ่านที่เซิร์ฟเวอร์...'; }

        try {
            authSessionEpochMain++;
            const data = await Core.verifyLoginOnServer(username, pass);
            if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = origText; }
            if (data?.status === 'ok' && data.authenticated && data.user) {
                cachedCloudJobs = [];
                initUserAccounts();
                localStorage.removeItem(RESET_LOCK_KEY);
                isManualShiftOverride = false;
                isManualJobNoOverride = false;
                if (userInput) userInput.value = '';
                if (passInput) passInput.value = '';

                if ((data.user.role || 'user') === 'tech') { window.location.href = 'page2.html'; return; }
                if (typeof clearStuckEditModes === 'function') clearStuckEditModes();
                checkLoginStatus();
                if (typeof checkShiftTransition === 'function') checkShiftTransition(true);
                if (typeof loadOutageHistory === 'function') loadOutageHistory();
                if (typeof loadFaultHistory === 'function') loadFaultHistory();
                if (typeof autoFillJobNo === 'function') autoFillJobNo(true);
                if (typeof pullFieldReportsFromCloud === 'function') pullFieldReportsFromCloud(true);
                showToast(`🔓 ยินดีต้อนรับคุณ ${formatTechDisplayName(data.user.username)}`);
            } else {
                showCustomAlert('❌ รหัสพนักงาน หรือ รหัสผ่านไม่ถูกต้อง กรุณาลองอีกครั้ง', '⚡ ระบบจัดการงานไฟฟ้า');
                if (passInput) { passInput.value = ''; passInput.focus(); }
            }
        } catch (err) {
            if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = origText; }
            showCustomAlert('⚠️ ไม่สามารถติดต่อเซิร์ฟเวอร์ตรวจสอบรหัสผ่านได้ กรุณาตรวจสอบอินเทอร์เน็ต', '⚡ ระบบจัดการงานไฟฟ้า');
        }
    }

    function executeSignOutCleanup() {
        authSessionEpochMain++;
        const curUser = (Core.rawStorageGet('elec_app_current_user') || '').trim();
        const curGrp = normGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
        const wasRole = Core.rawStorageGet('elec_app_current_role') || 'user';
        const wasViewer = isViewerRole();

        ['elec_app_logged_in', 'elec_app_current_user', 'elec_app_current_group', 'elec_app_current_role', 'elec_app_session_token', 'elec_app_last_active']
            .forEach(k => localStorage.removeItem(k));
        cachedCloudJobs = [];

        let snapshotLocs = null;
        if (curUser) {
            const locMap = getTechLocationsMap(), nowIso = new Date().toISOString();
            Object.keys(locMap).forEach(k => {
if (!isMainSysRegistryLoc(k, locMap[k]) && (isSameTechPerson(k, curUser) || isSameTechPerson(locMap[k]?.username, curUser))) {

                    locMap[k] = { ...locMap[k], isOnline: false, lastSeenAt: nowIso, updatedAt: nowIso };
                }
            });
            localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
            snapshotLocs = locMap;
        }
        closeUserManageModal();
        checkLoginStatus();

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

    function handleLogout() {
        const currentUser = Core.rawStorageGet('elec_app_current_user') || '';
        showCustomConfirm(`คุณต้องการออกจากระบบบัญชี "${formatTechDisplayName(currentUser)}" ใช่หรือไม่?`, function () {
            executeSignOutCleanup();
            showToast('🔒 ออกจากระบบเรียบร้อยแล้ว');
        }, '🚪 ยืนยันการออกจากระบบ');
    }

    function triggerAutoLogout() {
        executeSignOutCleanup();
        showCustomAlert('⏳ ระบบได้ออกจากระบบอัตโนมัติ เนื่องจากไม่มีการใช้งานเกิน 1 ชั่วโมง', '🔒 หมดเวลาการเชื่อมต่อ');
    }

    // ========================================================================
    // 3. ระบบจัดการบัญชีผู้ใช้และจัดกลุ่มตาม กฟส. สำหรับ Admin (รองรับ SHA-256 & Viewer)
    // ========================================================================
    function getAllUserAccountGroups() {
        const groups = new Set();
        (userAccountsList || []).forEach(acc => {
            const g = normGrp(getUserGroupName(acc.username));
            if (g) groups.add(g);
        });
        return Array.from(groups).sort((a, b) => a.localeCompare(b, 'th'));
    }

    function ensureUserManageModalExists() {
        let modal = document.getElementById('userManageModal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'userManageModal';
        modal.className = 'fixed inset-0 bg-slate-900/50 hidden z-[65] flex items-center justify-center p-4 backdrop-blur-sm transition-opacity';
        modal.innerHTML = `
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
                <div class="px-4 py-3 border-b flex justify-between items-center bg-gradient-to-r from-amber-500 to-orange-600 text-white">
                    <h3 class="font-bold text-sm flex items-center gap-2">👤 จัดการบัญชีผู้ใช้และชื่อช่าง (Admin)</h3>
                    <button type="button" onclick="closeUserManageModal()" class="text-amber-100 hover:text-white text-xl font-bold leading-none">&times;</button>
                </div>
                <div class="px-4 py-2 bg-amber-50 border-b border-amber-100 flex items-center justify-between gap-2 text-[11px]">
                    <span id="cloudSyncStatusText" class="text-amber-800 font-semibold truncate">☁️ ซิงค์ชีตหลัก (เข้ารหัส SHA-256 อัตโนมัติ)</span>
                    <button type="button" onclick="fetchUserAccountsFromCloud(false, true)" class="text-blue-600 hover:underline font-bold shrink-0">🔄 ซิงค์ล่าสุด</button>
                </div>
                <div class="p-4 bg-white border-b space-y-2.5">
                    <div class="flex items-center justify-between">
                        <span class="text-xs font-bold text-slate-700">➕ เพิ่มบัญชีผู้ใช้งานใหม่</span>
                        <span class="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md font-semibold">รหัส + กลุ่มสังกัด</span>
                    </div>
                    <div class="grid grid-cols-2 gap-2">
                        <input type="text" id="newAccountUsername" placeholder="รหัสพนักงาน เช่น 502775" class="px-3 py-2 border border-slate-300 rounded-lg text-xs focus:outline-none">
                        <input type="text" id="newAccountPassword" placeholder="ตั้งรหัสผ่าน" class="px-3 py-2 border border-slate-300 rounded-lg text-xs font-mono focus:outline-none">
                        <div class="col-span-2 flex gap-1.5 items-center">
                            <select id="newAccountGroupSelect" onchange="onNewAccountGroupSelectChange(this.value)" class="w-1/2 px-2.5 py-2 border border-slate-300 rounded-lg text-xs font-semibold text-indigo-800 bg-indigo-50/60 focus:outline-none">
                                <option value="">🏢 เลือกกลุ่มที่มีอยู่...</option>
                            </select>
                            <input type="text" id="newAccountCustomGroupInput" placeholder="หรือพิมพ์กลุ่มใหม่ (เช่น กฟส.บึง)" class="w-1/2 px-3 py-2 border border-slate-300 rounded-lg text-xs focus:outline-none">
                        </div>
                    </div>
                    <input type="text" id="newAccountDisplayName" placeholder="🏷️ ชื่อช่างที่ต้องการแสดงผล (เช่น ช่างบอย / นายสมชาย)" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs focus:outline-none">
                    <div class="flex gap-2">
                        <select id="newAccountRole" class="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 bg-slate-50 focus:outline-none">
                            <option value="user">👷 สิทธิ์: ผู้ใช้งานทั่วไป (เข้าได้ 2 หน้า)</option>
                            <option value="tech">🛠️ สิทธิ์: ผู้ใช้งานช่าง (เฉพาะหน้าช่าง)</option>
                            <option value="viewer">👁️ สิทธิ์: ผู้สำรวจ (ดูอย่างเดียว ห้ามแก้ไข)</option>
                            <option value="admin">👑 สิทธิ์: แอดมิน (ผู้ดูแลระบบ)</option>
                        </select>
                        <button type="button" onclick="addUserAccount()" class="bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-lg text-xs font-bold shadow-sm transition whitespace-nowrap">➕ เพิ่มผู้ใช้</button>
                    </div>
                </div>
                <div class="px-4 py-2 bg-slate-100 border-b border-slate-200 space-y-1.5">
                    <div class="grid grid-cols-2 gap-1.5">
                        <select id="filterUserGroupSelect" onchange="renderUserAccountList()" class="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 bg-white focus:outline-none">
                            <option value="all">🏢 ทุกกลุ่มสังกัด</option>
                        </select>
                        <select id="filterUserRoleSelect" onchange="renderUserAccountList()" class="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 bg-white focus:outline-none">
                            <option value="all">👥 ทุกสิทธิ์การใช้งาน</option>
                            <option value="admin">👑 เฉพาะแอดมิน</option>
                            <option value="user">👷 เฉพาะผู้ใช้ทั่วไป</option>
                            <option value="tech">🛠️ เฉพาะช่างหน้างาน</option>
                            <option value="viewer">👁️ เฉพาะผู้สำรวจ</option>
                        </select>
                    </div>
                    <div class="flex gap-1.5 items-center">
                        <input type="text" id="searchUserAccountInput" oninput="renderUserAccountList()" placeholder="🔍 ค้นหารหัสพนักงาน, ชื่อช่าง, หรือกลุ่ม..." class="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-xs bg-white focus:outline-none">
                        <button type="button" onclick="toggleCollapseAllUserGroups()" class="shrink-0 bg-white hover:bg-slate-50 text-slate-600 border border-slate-300 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition">📂 ย่อ/ขยาย</button>
                    </div>
                </div>
                <div class="px-4 pt-2 pb-1 bg-slate-50 text-[11px] font-bold text-slate-500 flex justify-between items-center">
                    <span>รายชื่อบัญชีในระบบ</span>
                    <span id="userAccountCountBadge" class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">1 บัญชี</span>
                </div>
                <div class="p-4 pt-2 flex-1 overflow-y-auto space-y-2 bg-slate-50" id="userAccountListContainer"></div>
                <div class="p-3 border-t bg-white flex justify-end">
                    <button type="button" onclick="closeUserManageModal()" class="px-4 py-1.5 text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 rounded-lg transition">ปิดหน้าต่าง</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        return modal;
    }

    function onNewAccountGroupSelectChange(val) {
        const customInp = document.getElementById('newAccountCustomGroupInput');
        if (customInp && val) customInp.value = val;
    }

    function refreshUserGroupSelectOptions() {
        const groups = getAllUserAccountGroups();
        const newGrpSelect = document.getElementById('newAccountGroupSelect');
        if (newGrpSelect) {
            const curVal = newGrpSelect.value;
            newGrpSelect.innerHTML = `<option value="">🏢 เลือกกลุ่มที่มีอยู่...</option>` +
                groups.map(g => `<option value="${escapeHtmlStr(g)}" ${curVal === g ? 'selected' : ''}>🏢 ${escapeHtmlStr(g)}</option>`).join('');
        }
        const filterGrpSelect = document.getElementById('filterUserGroupSelect');
        if (filterGrpSelect) {
            const curFilter = filterGrpSelect.value || 'all';
            filterGrpSelect.innerHTML = `
                <option value="all" ${curFilter === 'all' ? 'selected' : ''}>🏢 ทุกกลุ่มสังกัด (${groups.length} กลุ่ม)</option>
                ${groups.map(g => `<option value="${escapeHtmlStr(g)}" ${curFilter === g ? 'selected' : ''}>🏢 กลุ่ม: ${escapeHtmlStr(g)}</option>`).join('')}
                <option value="__ADMIN_CENTRAL__" ${curFilter === '__ADMIN_CENTRAL__' ? 'selected' : ''}>👑 ผู้ดูแลระบบส่วนกลาง</option>
                <option value="__UNGROUPED__" ${curFilter === '__UNGROUPED__' ? 'selected' : ''}>📂 ไม่ระบุกลุ่มสังกัด</option>`;
        }
    }

    function openUserManageModal() {
        if (!isCurrentUserAdmin()) {
            showCustomAlert('⛔ เฉพาะแอดมิน (ผู้ดูแลระบบ) เท่านั้นที่สามารถจัดการบัญชีผู้ใช้ได้', '🔒 จำกัดสิทธิ์การเข้าถึง');
            return;
        }
        initUserAccounts();
        const modal = ensureUserManageModalExists();
        refreshUserGroupSelectOptions();
        renderUserAccountList();
        modal.classList.remove('hidden');
        fetchUserAccountsFromCloud(false, true);
    }

    function closeUserManageModal() {
        document.getElementById('userManageModal')?.classList.add('hidden');
    }

    function toggleUserGroupSection(groupKey) {
        if (collapsedUserGroups.has(groupKey)) collapsedUserGroups.delete(groupKey);
        else collapsedUserGroups.add(groupKey);
        renderUserAccountList();
    }

    function toggleCollapseAllUserGroups() {
        const allKeys = Array.from(document.querySelectorAll('[data-user-group-key]')).map(el => el.getAttribute('data-user-group-key'));
        if (collapsedUserGroups.size < allKeys.length) allKeys.forEach(k => collapsedUserGroups.add(k));
        else collapsedUserGroups.clear();
        renderUserAccountList();
    }

    function prefillGroupForNewAccount(groupName) {
        const grpSelect = document.getElementById('newAccountGroupSelect');
        const grpCustom = document.getElementById('newAccountCustomGroupInput');
        const userInp = document.getElementById('newAccountUsername');
        if (grpSelect) grpSelect.value = groupName;
        if (grpCustom) grpCustom.value = groupName;
        if (userInp) {
            userInp.focus();
            showToast(`🏢 เลือกกลุ่ม "${groupName}" แล้ว กรอกรหัสพนักงานได้เลย`);
        }
    }

    function renameEntireUserGroup(oldGroupName) {
        if (!oldGroupName) return;
        showCustomPrompt(`เปลี่ยนชื่อกลุ่ม "${oldGroupName}" สำหรับทุกบัญชีในกลุ่มนี้เป็น:`, oldGroupName, function (newGroupRaw) {
            const newGrp = normGrp(newGroupRaw || '');
            if (!newGrp || newGrp === oldGroupName) return;
            let updatedCount = 0;
            userAccountsList.forEach(acc => {
                if (normGrp(getUserGroupName(acc.username)) === normGrp(oldGroupName)) {
                    acc.username = normalizeUsernameFormat(`${getUserBaseId(acc.username)} ${newGrp}`);
                    updatedCount++;
                }
            });
            if (updatedCount > 0) {
                saveUserAccounts();
                refreshUserGroupSelectOptions();
                renderUserAccountList();
                showToast(`✅ เปลี่ยนชื่อกลุ่มเป็น "${newGrp}" (${updatedCount} บัญชี) สำเร็จ!`);
            }
        }, '✏️ เปลี่ยนชื่อกลุ่มสังกัด');
    }

    function renderUserAccountList() {
        const container = document.getElementById('userAccountListContainer');
        const badge = document.getElementById('userAccountCountBadge');
        if (!container) return;

        refreshUserGroupSelectOptions();
        const groupFilter = document.getElementById('filterUserGroupSelect')?.value || 'all';
        const roleFilter = document.getElementById('filterUserRoleSelect')?.value || 'all';
        const searchQ = (document.getElementById('searchUserAccountInput')?.value || '').toLowerCase().trim();
        const currentLoggedUser = Core.rawStorageGet('elec_app_current_user') || '';

        const indexed = (userAccountsList || []).map((acc, idx) => {
            const grp = normGrp(getUserGroupName(acc.username));
            return { ...acc, _origIdx: idx, _groupName: grp, _groupKey: grp || (acc.role === 'admin' ? '__ADMIN_CENTRAL__' : '__UNGROUPED__') };
        });

        const filtered = indexed.filter(it => {
            if (groupFilter !== 'all' && it._groupKey !== groupFilter) return false;
            if (roleFilter !== 'all' && (it.role || 'user') !== roleFilter) return false;
            if (searchQ && !`${it.username || ''} ${it.displayName || ''} ${it._groupName || ''}`.toLowerCase().includes(searchQ)) return false;
            return true;
        });

        if (badge) {
            badge.textContent = filtered.length === userAccountsList.length
                ? `${userAccountsList.length} บัญชี`
                : `แสดง ${filtered.length} / ${userAccountsList.length} บัญชี`;
        }

        container.innerHTML = '';
        if (filtered.length === 0) {
            container.innerHTML = '<div class="text-center text-slate-400 text-xs py-8 bg-white rounded-xl border border-dashed border-slate-300">ไม่พบบัญชีผู้ใช้ที่ตรงกับเงื่อนไขการค้นหา</div>';
            return;
        }

        const groupedMap = new Map();
        filtered.forEach(it => {
            if (!groupedMap.has(it._groupKey)) groupedMap.set(it._groupKey, []);
            groupedMap.get(it._groupKey).push(it);
        });

        Array.from(groupedMap.keys()).sort((a, b) => {
            if (a === '__ADMIN_CENTRAL__') return -1;
            if (b === '__ADMIN_CENTRAL__') return 1;
            if (a === '__UNGROUPED__') return 1;
            if (b === '__UNGROUPED__') return -1;
            return a.localeCompare(b, 'th');
        }).forEach(gKey => {
            const members = groupedMap.get(gKey);
            const isCollapsed = collapsedUserGroups.has(gKey) && !searchQ;
            const isNamed = gKey !== '__ADMIN_CENTRAL__' && gKey !== '__UNGROUPED__';
            const groupTitle = gKey === '__ADMIN_CENTRAL__' ? '👑 ผู้ดูแลระบบส่วนกลาง (Admin)' : (gKey === '__UNGROUPED__' ? '📂 ไม่ระบุกลุ่มสังกัด' : `🏢 กลุ่มสังกัด: ${escapeHtmlStr(gKey)}`);
            const hdrBg = gKey === '__ADMIN_CENTRAL__' ? 'from-purple-600 to-indigo-700' : (gKey === '__UNGROUPED__' ? 'from-slate-600 to-slate-700' : 'from-indigo-600 to-blue-700');
            const safeGKey = escJsAttr(gKey);

            const section = document.createElement('div');
            section.className = 'rounded-xl border border-slate-200 overflow-hidden bg-slate-100/80 shadow-sm mb-3';
            section.setAttribute('data-user-group-key', gKey);

            const headerEl = document.createElement('div');
            headerEl.className = `bg-gradient-to-r ${hdrBg} text-white px-3 py-2 flex items-center justify-between gap-2 select-none`;
            headerEl.innerHTML = `
                <div onclick="toggleUserGroupSection('${safeGKey}')" class="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                    <span class="text-xs font-bold">${isCollapsed ? '▶' : '▼'}</span>
                    <span class="font-bold text-xs truncate">${groupTitle}</span>
                    <span class="bg-black/25 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0">${members.length} คน</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    ${isNamed ? `<button type="button" onclick="prefillGroupForNewAccount('${safeGKey}')" class="bg-white/20 hover:bg-white/30 text-white text-[10px] font-bold px-2 py-1 rounded-md">➕ เพิ่มคน</button><button type="button" onclick="renameEntireUserGroup('${safeGKey}')" class="bg-white/20 hover:bg-white/30 text-white text-[10px] font-bold px-1.5 py-1 rounded-md">✏️</button>` : ''}
                </div>`;
            section.appendChild(headerEl);

            const bodyEl = document.createElement('div');
            bodyEl.className = isCollapsed ? 'hidden' : 'p-2 space-y-1.5';
            members.forEach(acc => {
                const idx = acc._origIdx;
                const isMe = isUsernameMatchingAccount(currentLoggedUser, acc.username);
                const role = acc.role || 'user';
                const roleMeta = {
                    admin: ['👑', 'แอดมิน', 'bg-purple-100 text-purple-700'],
                    tech: ['🛠️', 'ผู้ใช้งานช่าง', 'bg-teal-100 text-teal-800'],
                    viewer: ['👁️', 'ผู้สำรวจ (ดูอย่างเดียว)', 'bg-cyan-100 text-cyan-800 border border-cyan-300'],
                    user: ['👷', 'ผู้ใช้ทั่วไป', 'bg-blue-50 text-blue-600']
                }[role] || ['👷', 'ผู้ใช้ทั่วไป', 'bg-blue-50 text-blue-600'];

                const card = document.createElement('div');
                card.className = 'flex items-center justify-between bg-white border border-slate-200 rounded-xl p-2.5 shadow-sm text-xs hover:border-indigo-300 transition';
                card.innerHTML = `
                    <div class="flex-1 pr-2 overflow-hidden space-y-1">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="font-bold text-slate-800 truncate text-xs sm:text-sm">${roleMeta[0]} ${escapeHtmlStr(getUserBaseId(acc.username) || acc.username)}</span>
                            ${acc.displayName ? `<span class="text-[10px] bg-amber-100 text-amber-900 border border-amber-300 px-1.5 py-0.5 rounded font-bold">🏷️ ${escapeHtmlStr(acc.displayName)}</span>` : ''}
                            <span class="text-[10px] px-1.5 py-0.5 rounded font-semibold ${roleMeta[2]}">${roleMeta[1]}</span>
                            ${isMe ? '<span class="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-semibold">เครื่องนี้</span>' : ''}
                        </div>
                        <div class="text-[11px] text-slate-500">
                            <span class="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded font-semibold">🔒 เข้ารหัส SHA-256</span>
                        </div>
                    </div>
                    <div class="flex gap-1 shrink-0">
                        <button type="button" onclick="editUserAccount(${idx})" class="text-amber-600 hover:bg-amber-50 px-2.5 py-1.5 rounded-lg border border-amber-200 font-semibold">✏️ แก้ไข</button>
                        <button type="button" onclick="deleteUserAccount(${idx})" class="text-rose-600 hover:bg-rose-50 px-2.5 py-1.5 rounded-lg border border-rose-200 font-semibold">🗑️ ลบ</button>
                    </div>`;
                bodyEl.appendChild(card);
            });
            section.appendChild(bodyEl);
            container.appendChild(section);
        });
    }

    function addUserAccount() {
        const userEl = document.getElementById('newAccountUsername');
        const passEl = document.getElementById('newAccountPassword');
        const dispEl = document.getElementById('newAccountDisplayName');
        const roleEl = document.getElementById('newAccountRole');
        const role = roleEl?.value || 'user';
        const chosenGrp = normGrp(document.getElementById('newAccountCustomGroupInput')?.value || document.getElementById('newAccountGroupSelect')?.value || '');

        let rawU = (userEl?.value || '').trim();
        if (rawU && !getUserGroupName(rawU) && rawU.toLowerCase() !== 'admin') {
            const fallbackGrp = chosenGrp || (role !== 'admin' ? (getAllUserAccountGroups()[0] || 'กฟส.บึง') : '');
            if (fallbackGrp) rawU = `${rawU} ${fallbackGrp}`;
        }
        const username = normalizeUsernameFormat(rawU);
        const password = (passEl?.value || '').trim();
        const displayName = (dispEl?.value || '').trim();

        if (!username || !password) {
            showCustomAlert('⚠️ กรุณากรอกทั้งรหัสพนักงานและรหัสผ่านให้ครบถ้วน', '👤 จัดการบัญชีผู้ใช้');
            return;
        }
        const newBaseId = getUserBaseId(username);
        if (userAccountsList.some(a => a.username.toLowerCase() === username.toLowerCase() || (newBaseId && getUserBaseId(a.username) === newBaseId))) {
            showCustomAlert(`❌ มีรหัสพนักงาน "${newBaseId || username}" อยู่ในระบบแล้ว`, '👤 จัดการบัญชีผู้ใช้');
            return;
        }

        userAccountsList.push({ username, password, role, sessionToken: '', displayName });
        saveUserAccounts();
        refreshUserGroupSelectOptions();
        renderUserAccountList();

        if (userEl) userEl.value = '';
        if (passEl) passEl.value = '';
        if (dispEl) dispEl.value = '';
        if (roleEl) roleEl.value = 'user';
        showToast(`✅ เพิ่มบัญชี "${displayName || username}" สำเร็จ`);
    }

    function editUserAccount(index) {
        const targetAcc = userAccountsList[index];
        if (!targetAcc) return;

        let modal = document.getElementById('customUserEditModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'customUserEditModal';
            modal.className = 'fixed inset-0 z-[210] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4 transition-opacity';
            modal.innerHTML = `
                <div class="bg-slate-800 text-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4 border border-slate-700">
                    <h3 class="text-lg font-bold text-amber-400">✏️ แก้ไขบัญชีและชื่อแสดงผล</h3>
                    <div class="space-y-3 text-xs">
                        <div><label class="block text-slate-300 mb-1 font-semibold">รหัสพนักงาน และกลุ่มสังกัด</label><input type="text" id="editAccUsernameInput" class="w-full px-3.5 py-2 text-slate-800 font-medium rounded-xl text-sm focus:outline-none"></div>
                        <div><label class="block text-amber-300 mb-1 font-semibold">🏷️ ชื่อช่าง / ชื่อแสดงผล</label><input type="text" id="editAccDisplayNameInput" class="w-full px-3.5 py-2 text-slate-800 font-bold rounded-xl text-sm focus:outline-none"></div>
                        <div><label class="block text-slate-300 mb-1 font-semibold">รหัสผ่าน</label><input type="text" id="editAccPasswordInput" placeholder="เว้นว่างไว้หากใช้รหัสผ่านเดิม (พิมพ์ใหม่เพื่อเปลี่ยน)" class="w-full px-3.5 py-2 text-slate-800 font-mono font-bold rounded-xl text-xs focus:outline-none"></div>
                        <div>
                            <label class="block text-slate-300 mb-1 font-semibold">ระดับสิทธิ์การใช้งาน</label>
                            <select id="editAccRoleSelect" class="w-full px-3.5 py-2 text-slate-800 font-semibold rounded-xl text-sm focus:outline-none">
                                <option value="user">👷 ผู้ใช้งานทั่วไป (เข้าได้ 2 หน้า)</option>
                                <option value="tech">🛠️ ผู้ใช้งานช่าง (เฉพาะหน้าช่าง)</option>
                                <option value="viewer">👁️ ผู้สำรวจ (ดูอย่างเดียว ห้ามแก้ไข)</option>
                                <option value="admin">👑 แอดมิน (Admin)</option>
                            </select>
                        </div>
                    </div>
                    <div class="flex justify-end gap-2 pt-2">
                        <button type="button" onclick="document.getElementById('customUserEditModal').classList.add('hidden')" class="text-slate-300 hover:text-white font-semibold text-sm px-4 py-2 rounded-xl hover:bg-slate-700/50">ยกเลิก</button>
                        <button type="button" id="editAccSaveBtn" class="bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-sm px-5 py-2 rounded-xl shadow">บันทึก</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }

        const uInput = document.getElementById('editAccUsernameInput');
        const dInput = document.getElementById('editAccDisplayNameInput');
        const pInput = document.getElementById('editAccPasswordInput');
        const rSelect = document.getElementById('editAccRoleSelect');

        uInput.value = targetAcc.username;
        dInput.value = targetAcc.displayName || '';
        pInput.value = '';
        rSelect.value = targetAcc.role || 'user';

        document.getElementById('editAccSaveBtn').onclick = function () {
            const newR = rSelect.value;
            let rawEditU = uInput.value.trim();
            if (rawEditU && newR !== 'admin' && !getUserGroupName(rawEditU) && rawEditU.toLowerCase() !== 'admin') {
                const keepGrp = normGrp(getUserGroupName(targetAcc.username)) || getAllUserAccountGroups()[0] || 'กฟส.บึง';
                rawEditU = `${rawEditU} ${keepGrp}`;
            }
            const newU = normalizeUsernameFormat(rawEditU);
            const newD = dInput.value.trim();
            const newP = pInput.value.trim() || 'UNCHANGED';

            if (!newU) { showCustomAlert('⚠️ กรุณากรอกรหัสผู้ใช้ให้ครบถ้วน', '✏️ แก้ไขบัญชี'); return; }
            const newBase = getUserBaseId(newU);
            if (userAccountsList.some((a, i) => i !== index && (a.username.toLowerCase() === newU.toLowerCase() || (newBase && getUserBaseId(a.username) === newBase)))) {
                showCustomAlert(`❌ รหัสพนักงาน "${newBase || newU}" ซ้ำกับบัญชีอื่น`, '✏️ แก้ไขบัญชี');
                return;
            }
            if (userAccountsList.filter((a, i) => (i === index ? newR === 'admin' : a.role === 'admin')).length === 0) {
                showCustomAlert('⚠️ ต้องมีแอดมินอย่างน้อย 1 บัญชีในระบบ', '✏️ แก้ไขบัญชี');
                return;
            }

            const curLogged = Core.rawStorageGet('elec_app_current_user') || '';
            const wasMe = isUsernameMatchingAccount(curLogged, targetAcc.username);
            userAccountsList[index] = {
                username: newU,
                password: newP,
                role: newR,
                sessionToken: wasMe ? (Core.rawStorageGet('elec_app_session_token') || targetAcc.sessionToken || '') : ('reset_' + Date.now()),
                displayName: newD
            };
            saveUserAccounts();

            if (wasMe) {
                localStorage.setItem('elec_app_current_user', newU);
                localStorage.setItem('elec_app_current_group', normGrp(getUserGroupName(newU)) || (newR !== 'admin' ? 'กฟส.บึง' : ''));
                localStorage.setItem('elec_app_current_role', newR);
                checkLoginStatus();
            }
            renderUserAccountList();
            if (typeof loadOutageHistory === 'function') loadOutageHistory();
            if (typeof loadFaultHistory === 'function') loadFaultHistory();
            modal.classList.add('hidden');
            showToast(`✅ บันทึกข้อมูล "${newD || newU}" สำเร็จ`);
        };
        modal.classList.remove('hidden');
    }

    function deleteUserAccount(index) {
        const targetAcc = userAccountsList[index];
        if (!targetAcc) return;
        if (userAccountsList.filter((a, i) => i !== index && a.role === 'admin').length === 0) {
            showCustomAlert('⚠️ ไม่สามารถลบบัญชีแอดมินคนสุดท้ายของระบบได้', '🗑️ ลบบัญชีผู้ใช้');
            return;
        }
        if (isUsernameMatchingAccount(Core.rawStorageGet('elec_app_current_user') || '', targetAcc.username)) {
            showCustomAlert('⚠️ ไม่สามารถลบบัญชีที่คุณกำลังล็อกอินใช้งานอยู่ได้', '🗑️ ลบบัญชีผู้ใช้');
            return;
        }
        showCustomConfirm(`คุณต้องการลบบัญชีผู้ใช้ "${targetAcc.username}" ใช่หรือไม่?`, function () {
            userAccountsList.splice(index, 1);
            saveUserAccounts();
            renderUserAccountList();
            showToast(`🗑️ ลบบัญชี "${targetAcc.username}" เรียบร้อยแล้ว`);
        }, '🗑️ ยืนยันการลบบัญชีผู้ใช้');
    }

    // ========================================================================
    // 4. ระบบตรวจสอบสถานะผู้ใช้งานออนไลน์เรียลไทม์ (เฉพาะ Admin)
    // ========================================================================
    function injectOnlineHeaderButton() {
        const headerBtnGroup = document.querySelector('#mainAppContent .bg-gradient-to-r .flex.items-center.gap-1\\.5.shrink-0');
        if (!headerBtnGroup) return;

        let btn = document.getElementById('onlineUsersBtn');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'onlineUsersBtn';
            btn.onclick = openOnlineUsersModal;
            btn.className = 'hidden bg-emerald-500/90 hover:bg-emerald-600 text-white px-2.5 py-1.5 rounded-xl text-xs transition shadow-sm items-center gap-1 font-semibold';
            btn.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-200 animate-ping"></span><span>ออนไลน์ (<span id="onlineCountBadge">1</span>)</span>`;
            headerBtnGroup.insertBefore(btn, headerBtnGroup.firstChild);
        }
        const admin = isCurrentUserAdmin();
        btn.classList.toggle('hidden', !admin);
        btn.classList.toggle('flex', admin);
        if (!admin) document.getElementById('onlineUsersModal')?.classList.add('hidden');
    }

    function updateOnlineCountUI() {
        injectOnlineHeaderButton();
        if (!isCurrentUserAdmin()) return;
        const list = Core.getAccountsOnlineStatusList('💻 หน้าหลัก', false);
        const badge = document.getElementById('onlineCountBadge');
        if (badge) badge.textContent = String(list.filter(i => i.isOnline).length);
        const modal = document.getElementById('onlineUsersModal');
        if (modal && !modal.classList.contains('hidden')) renderOnlineUsersModalList(list);
    }

    function openOnlineUsersModal() {
        if (!isCurrentUserAdmin()) {
            showCustomAlert('⛔ เฉพาะแอดมินเท่านั้นที่ดูสถานะออนไลน์ได้', '🔒 จำกัดสิทธิ์');
            return;
        }
        let modal = document.getElementById('onlineUsersModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'onlineUsersModal';
            modal.className = 'fixed inset-0 bg-slate-900/60 hidden z-[190] flex items-center justify-center p-4 backdrop-blur-sm';
            modal.innerHTML = `
                <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[85vh]">
                    <div class="px-4 py-3 bg-gradient-to-r from-emerald-600 to-teal-700 text-white flex justify-between items-center">
                        <h3 class="font-bold text-sm flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full bg-emerald-300 animate-ping"></span><span>สถานะผู้ใช้งานออนไลน์ (เฉพาะ Admin)</span></h3>
                        <button type="button" onclick="document.getElementById('onlineUsersModal').classList.add('hidden')" class="text-white/80 hover:text-white text-xl font-bold leading-none">&times;</button>
                    </div>
                    <div class="px-4 py-2 bg-emerald-50 border-b border-emerald-100 flex justify-between items-center text-[11px] text-emerald-800 font-semibold">
                        <span id="onlineModalSummaryText">กำลังตรวจสอบสถานะ...</span>
                        <button type="button" onclick="triggerManualPresenceSync()" class="text-teal-700 hover:underline font-bold">🔄 รีเฟรชสถานะ</button>
                    </div>
                    <div id="onlineUsersListContainer" class="p-4 overflow-y-auto space-y-2 flex-1 bg-slate-50"></div>
                    <div class="p-3 bg-white border-t flex justify-end"><button type="button" onclick="document.getElementById('onlineUsersModal').classList.add('hidden')" class="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold">ปิดหน้าต่าง</button></div>
                </div>`;
            document.body.appendChild(modal);
        }
        renderOnlineUsersModalList();
        modal.classList.remove('hidden');
        triggerManualPresenceSync();
    }

    async function triggerManualPresenceSync() {
        Core.forceCloudRead();
        Core.updateUserOnlineHeartbeat('💻 หน้าหลัก', null, false);
        if (typeof pullFieldReportsFromCloud === 'function') await pullFieldReportsFromCloud(true);
        if (typeof syncJobsWithFieldPage === 'function') await syncJobsWithFieldPage();
        renderOnlineUsersModalList();
        if (isCurrentUserAdmin()) showToast('🟢 อัปเดตสถานะผู้ใช้ออนไลน์ล่าสุดแล้ว');
    }

    function renderOnlineUsersModalList(preList) {
        if (!isCurrentUserAdmin()) return;
        const container = document.getElementById('onlineUsersListContainer');
        const summaryEl = document.getElementById('onlineModalSummaryText');
        if (!container) return;

        const list = preList || Core.getAccountsOnlineStatusList('💻 หน้าหลัก', false);
        const activeEquipNavs = typeof getVisibleActiveEquipNavsForMain === 'function' ? getVisibleActiveEquipNavsForMain() : [];
        if (summaryEl) summaryEl.textContent = `🟢 ออนไลน์ขณะนี้ ${list.filter(i => i.isOnline).length} คน (จากทั้งหมด ${list.length} บัญชี)`;

        container.innerHTML = list.map(item => {
            const roleMeta = { admin: ['👑', 'แอดมิน'], tech: ['🛠️', 'ช่างหน้างาน'], viewer: ['👁️', 'ผู้สำรวจ (ดูอย่างเดียว)'], user: ['👷', 'ผู้ใช้ทั่วไป'] }[item.role] || ['👷', 'ผู้ใช้ทั่วไป'];
            const statusBadge = item.isOnline
                ? `<span class="inline-flex items-center gap-1 bg-emerald-100 text-emerald-700 border border-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>ออนไลน์</span>`
                : `<span class="inline-flex items-center gap-1 bg-slate-100 text-slate-500 border border-slate-200 text-[10px] font-semibold px-2 py-0.5 rounded-full">⚪ ออฟไลน์</span>`;
            const mins = item.lastSeenMs ? Math.max(1, Math.floor(item.diffMs / 60000)) : 0;
            const timeLabel = item.isOnline ? 'ออนไลน์ขณะนี้' : (!item.lastSeenMs ? 'ยังไม่เคยออนไลน์' : (mins < 60 ? `ออฟไลน์เมื่อ ${mins} นาทีที่แล้ว` : (mins < 1440 ? `ออฟไลน์เมื่อ ${Math.floor(mins / 60)} ชม. ที่แล้ว` : `ออนไลน์ล่าสุด ${new Date(item.lastSeenMs).toLocaleDateString('th-TH')}`)));
            const eqNav = activeEquipNavs.find(n => isSameTechPerson(n.techName, item.username));
            const eqTag = eqNav ? `<div class="text-[10px] font-bold text-sky-700 bg-sky-50 border border-sky-200 px-2 py-0.5 rounded-md mt-1 inline-block">🚗 กำลังเดินทางไปอุปกรณ์: ⚡ ${escapeHtmlStr(eqNav.placeTitle || eqNav.placeName || 'อุปกรณ์')} (ถึง ~${escapeHtmlStr(eqNav.etaTime || '-')})</div>` : '';

            return `
                <div class="p-3 rounded-xl border bg-white shadow-sm flex items-center justify-between gap-2 ${item.isOnline ? 'border-emerald-300 border-l-4 border-l-emerald-500' : 'border-slate-200 opacity-75'}">
                    <div class="min-w-0 flex-1 space-y-0.5">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="font-bold text-slate-800 text-xs sm:text-sm truncate">${roleMeta[0]} ${escapeHtmlStr(item.displayName)}</span>
                            ${item.isMe ? '<span class="bg-blue-100 text-blue-700 text-[9px] font-bold px-1.5 py-0.5 rounded">คุณ</span>' : ''}
                        </div>
                        <div class="text-[11px] text-slate-500 flex flex-wrap items-center gap-2">
                            <span>สิทธิ์: ${roleMeta[1]}</span>
                            ${item.isOnline ? `<span class="text-teal-700 font-semibold">• ${escapeHtmlStr(item.currentPage)}</span>` : ''}
                            ${item.role === 'tech' ? `<span class="text-[10px] ${item.hasGps ? 'text-emerald-600 font-semibold' : 'text-slate-400'}">${item.hasGps ? '📍 เปิด GPS' : '🚫 ปิด GPS'}</span>` : ''}
                        </div>
                        <div class="text-[10px] ${item.isOnline ? 'text-emerald-600 font-semibold' : 'text-slate-400'}">🕒 ${timeLabel}</div>
                        ${eqTag}
                    </div>
                    <div class="shrink-0">${statusBadge}</div>
                </div>`;
        }).join('');
    }

    // ========================================================================
    // 5. ตำบล & เรดาร์น้ำฝน Open-Meteo, สถานี, ลักษณะอาการ & Autocomplete
    // ========================================================================
    const defaultTambonCoordinates = {
        'ตำบลบึง': { lat: 13.1361, lon: 101.0322 },
        'ตำบลบ่อวิน': { lat: 13.0645, lon: 101.1611 },
        'ตำบลเขาคันทรง': { lat: 13.1165, lon: 101.2144 }
    };
    let targetTambonCoordinates = {};

    const defaultStations = [
        'บึง1', 'บึง2', 'บึง3', 'บึง4ชั่วคราว', 'บ่อวิน1', 'บ่อวิน2', 'ปิ่นทอง1', 'ปิ่นทอง2',
        'ปิ่นทอง3', 'เหมราช1', 'เหมราช2', 'เขาไม้แก้ว', 'บ้านบึง1', 'ปลวกแดง1', 'ปลวกแดง2',
        'อีสเทิร์นซีบอร์ด3', 'อมตะซิตี้2'
    ];
    let stationsList = [];

    const defaultIssueTypes = [
        'ไฟดับ', 'ไฟตก', 'ไฟกระพริบ', 'สายไฟขาด / สายไฟหย่อน',
        'หม้อแปลงมีเสียงดัง / มีประกายไฟ / ระเบิด', 'เสาไฟฟ้าล้ม / เอียง',
        'ไฟช็อต / มีประกายไฟ', 'กิ่งไม้แตะสายไฟ', 'มิเตอร์ชำรุด',
        'ไฟดับหลายหลัง', 'ไฟดับ หลังเดียว เช็คเบรคเกอร์แล้ว',
        'สายสื่อสารขวางทาง', 'ช๊อตที่หัวเสาไฟแรงต่ำ', 'ไฟ2เส้นที่มิเตอร์',
        'ช๊อตตูดมิเตอร์', 'มิเตอร์ไหม้', 'LTมีประกายไฟ', 'ฟิวส์แรงสูงขาด',
        'ไฟตก หลายหลัง', 'รถชนเสาไฟ', 'มิเตอร์น้ำเข้า', 'ต้นไม้ล้มทับ/สายไฟ', 'อื่นๆ'
    ];
    let issueList = [];

    function setupTambonInputSync() {
        const hiddenInput = document.getElementById('tambonSelect');
        if (!hiddenInput || hiddenInput._isSynced) return;
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        Object.defineProperty(hiddenInput, 'value', {
            get: function () { return desc.get.call(this); },
            set: function (val) {
                desc.set.call(this, val);
                const display = document.getElementById('tambonTypeDisplay');
                if (display) {
                    const valid = Boolean(val && targetTambonCoordinates[val]);
                    display.textContent = valid ? val : '-- เลือกตำบล --';
                    display.classList.toggle('text-slate-400', !valid);
                    display.classList.toggle('text-slate-800', valid);
                }
            }
        });
        hiddenInput._isSynced = true;
    }

    function initTambonData() {
        setupTambonInputSync();
        ['newTambonLatInput', 'newTambonLonInput'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.type = 'text'; el.setAttribute('inputmode', 'decimal'); }
        });
        try {
            const saved = Core.rawStorageGet('tambonCoordinates_custom');
            targetTambonCoordinates = saved ? JSON.parse(saved) : { ...defaultTambonCoordinates };
        } catch (e) { targetTambonCoordinates = { ...defaultTambonCoordinates }; }
        renderTambonDropdown();
    }

    function toggleTambonDropdown() { document.getElementById('tambonDropdownMenu')?.classList.toggle('hidden'); }
    function selectTambon(tName) {
        const inp = document.getElementById('tambonSelect');
        if (inp) inp.value = tName;
        document.getElementById('tambonDropdownMenu')?.classList.add('hidden');
        onTambonChanged();
        if (typeof saveFaultDraft === 'function') saveFaultDraft();
    }

    function reorderTambonKeys(orderedKeys) {
        const next = {};
        orderedKeys.forEach(k => { if (targetTambonCoordinates[k]) next[k] = targetTambonCoordinates[k]; });
        targetTambonCoordinates = next;
        localStorage.setItem('tambonCoordinates_custom', JSON.stringify(targetTambonCoordinates));
        if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot();
    }

    function renderTambonDropdown() {
        const ul = document.getElementById('tambonSortableList');
        const hiddenInput = document.getElementById('tambonSelect');
        if (!ul || !hiddenInput) return;
        const curVal = hiddenInput.value;
        ul.innerHTML = '';

        Object.keys(targetTambonCoordinates).forEach(tName => {
            const li = document.createElement('li');
            li.className = 'flex items-center gap-2.5 px-3 py-2.5 hover:bg-blue-50 cursor-pointer text-sm text-slate-700 bg-white border-b border-slate-100 last:border-0';
            li.setAttribute('data-value', tName);
            li.innerHTML = `<span class="tambon-dd-drag-handle text-slate-400 hover:text-blue-500 cursor-move text-lg px-1.5 -ml-1 rounded shrink-0">≡</span><span class="item-label flex-1 truncate"></span>`;
            li.querySelector('.tambon-dd-drag-handle').onclick = e => e.stopPropagation();
            const lbl = li.querySelector('.item-label');
            lbl.textContent = tName;
            lbl.onclick = () => selectTambon(tName);
            ul.appendChild(li);
        });

        if (!ul.sortableInstance && typeof Sortable !== 'undefined') {
            ul.sortableInstance = new Sortable(ul, {
                handle: '.tambon-dd-drag-handle', animation: 150, ghostClass: 'issue-ghost',
                onEnd: () => { reorderTambonKeys(Array.from(ul.children).map(li => li.getAttribute('data-value'))); renderTambonModalList(); }
            });
        }
        hiddenInput.value = (curVal && targetTambonCoordinates[curVal]) ? curVal : '';
    }

    function applyWeatherSelectColor(wStr) {
        const sel = document.getElementById('weatherSelect');
        if (!sel) return;
        sel.className = 'w-full px-2 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white text-sm font-bold transition-colors truncate ';
        if (wStr === 'ปกติ') sel.classList.add('text-emerald-600');
        else if (wStr === 'ฝนตกเล็กน้อย') sel.classList.add('text-blue-500');
        else if (wStr === 'ฝนตกปานกลาง' || wStr === 'ลมกระโชกแรง') sel.classList.add('text-amber-500');
        else if (wStr === 'ฝนตกหนัก' || wStr === 'ฝนตกฟ้าคะนองรุนแรง') sel.classList.add('text-rose-600');
        else sel.classList.add('text-slate-600');
    }

    function onWeatherManualChange() {
        isWeatherLockedByUser = true;
        const sel = document.getElementById('weatherSelect');
        const stEl = document.getElementById('liveWeatherStatus');
        if (sel) applyWeatherSelectColor(sel.value);
        if (stEl && sel) {
            stEl.textContent = `🔒 ล็อกสภาพอากาศตามหน้างานจริง (${sel.value})`;
            stEl.className = 'flex items-center gap-1 font-medium text-amber-700 min-w-0 break-words leading-snug';
        }
        if (typeof saveFaultDraft === 'function') saveFaultDraft();
    }

    async function fetchLiveWeatherForTambon(tambonName, isSilent = true) {
        if ((isSilent && isWeatherLockedByUser) || !tambonName || !targetTambonCoordinates[tambonName]) return;
        let coord = targetTambonCoordinates[tambonName], label = tambonName;
        const exact = deepParseCoords(document.getElementById('gpsInput')?.value || '', false);
        if (exact?.lat && exact?.lon) { coord = { lat: exact.lat, lon: exact.lon }; label = `${tambonName} (พิกัด GPS จริง)`; }

        const weatherSelect = document.getElementById('weatherSelect');
        const statusEl = document.getElementById('liveWeatherStatus');
        if (!isSilent && weatherSelect && statusEl) {
            weatherSelect.disabled = true;
            statusEl.innerHTML = `<span class="animate-pulse">⏳ กำลังวัดปริมาณน้ำฝนจริง (${escapeHtmlStr(label)})...</span>`;
        }
        try {
            const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coord.lat}&longitude=${coord.lon}&current=precipitation,rain,showers,weather_code,cloud_cover,wind_gusts_10m&timezone=Asia%2FBangkok`);
            if (!res.ok) throw new Error('Weather API');
            const cur = (await res.json())?.current || {};
            const wmo = cur.weather_code ?? 0;
            const precipMm = Math.max(cur.precipitation || 0, (cur.rain || 0) + (cur.showers || 0));
            let weatherStr = 'ปกติ';
            if (precipMm >= 5.0) weatherStr = [95, 96, 99].includes(wmo) ? 'ฝนตกฟ้าคะนองรุนแรง' : 'ฝนตกหนัก';
            else if (precipMm >= 1.2) weatherStr = [95, 96, 99].includes(wmo) ? 'ฝนตกฟ้าคะนองรุนแรง' : 'ฝนตกปานกลาง';
            else if (precipMm >= 0.1) weatherStr = 'ฝนตกเล็กน้อย';
            else if ((cur.wind_gusts_10m || 0) >= 38) weatherStr = 'ลมกระโชกแรง';
            else if ([95, 96, 99, 80, 81, 82, 61, 63, 65].includes(wmo) || (cur.cloud_cover || 0) >= 85) weatherStr = 'ครึ้มฟ้าครึ้มฝน';

            if (weatherSelect) { weatherSelect.value = weatherStr; weatherSelect.disabled = false; applyWeatherSelectColor(weatherStr); }
            if (typeof saveFaultDraft === 'function') saveFaultDraft();
            if (statusEl) {
                statusEl.textContent = `🟢 ${label}: ฝน ${precipMm.toFixed(1)} มม. (${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น.)`;
                statusEl.className = 'flex items-center gap-1 font-medium text-emerald-700 min-w-0 break-words leading-snug';
            }
            if (!isSilent) showToast(`🌤️ ${label}: ${weatherStr} (ฝน ${precipMm.toFixed(1)} มม.)`);
        } catch (e) {
            if (weatherSelect) weatherSelect.disabled = false;
            if (statusEl) { statusEl.textContent = '🔴 ดึงข้อมูลอากาศไม่สำเร็จ (เลือกเองได้ตามหน้างาน)'; statusEl.className = 'flex items-center gap-1 font-medium text-rose-600 min-w-0 break-words leading-snug'; }
            if (!isSilent) showToast('❌ ไม่สามารถอัปเดตสภาพอากาศได้');
        }
    }

    function onTambonChanged() { isWeatherLockedByUser = false; const v = document.getElementById('tambonSelect')?.value; if (v) fetchLiveWeatherForTambon(v, false); }
    function manualRefreshWeather() { const v = document.getElementById('tambonSelect')?.value; if (!v) return showToast('⚠️ กรุณาเลือกตำบลก่อนรีเฟรชสภาพอากาศ'); isWeatherLockedByUser = false; fetchLiveWeatherForTambon(v, false); }
    function startRealtimeWeatherStream() { if (weatherStreamInterval) clearInterval(weatherStreamInterval); weatherStreamInterval = setInterval(() => { const v = document.getElementById('tambonSelect')?.value; if (v && !isWeatherLockedByUser) fetchLiveWeatherForTambon(v, true); }, 300000); }

    function openTambonManageModal() {
        if (!guardNotViewer()) return;
        renderTambonModalList();
        document.getElementById('tambonModal')?.classList.remove('hidden');
        const c = document.getElementById('tambonListContainer');
        if (c && !c.sortableInstance && typeof Sortable !== 'undefined') {
            c.sortableInstance = new Sortable(c, { handle: '.tambon-modal-drag-handle', animation: 150, onEnd: () => { reorderTambonKeys(Array.from(c.children).map(el => el.getAttribute('data-value')).filter(Boolean)); renderTambonDropdown(); } });
        }
    }
    function closeTambonManageModal() { document.getElementById('tambonModal')?.classList.add('hidden'); }
    function renderTambonModalList() {
        const c = document.getElementById('tambonListContainer'); if (!c) return;
        c.innerHTML = '';
        const keys = Object.keys(targetTambonCoordinates);
        if (!keys.length) { c.innerHTML = '<div class="text-center text-slate-500 text-sm py-4">ไม่มีข้อมูลตำบล</div>'; return; }
        keys.forEach(tName => {
            const coord = targetTambonCoordinates[tName], div = document.createElement('div');
            div.className = 'flex items-center justify-between bg-white border border-slate-200 rounded-lg p-2.5 shadow-sm text-xs';
            div.setAttribute('data-value', tName);
            div.innerHTML = `<div class="flex items-center flex-1 pr-2 overflow-hidden"><span class="tambon-modal-drag-handle text-slate-400 hover:text-emerald-600 cursor-move text-lg px-2 -ml-1 rounded shrink-0">≡</span><div class="truncate pl-1"><div class="font-bold text-slate-800 truncate">${escapeHtmlStr(tName)}</div><div class="text-[10px] text-slate-400">Lat: ${coord.lat}, Lon: ${coord.lon}</div></div></div><div class="flex gap-1 shrink-0"><button type="button" class="btn-edit text-amber-600 hover:bg-amber-50 px-2 py-1 rounded border border-amber-100">✏️ แก้ไข</button><button type="button" class="btn-del text-rose-600 hover:bg-rose-50 px-2 py-1 rounded border border-rose-100">🗑️ ลบ</button></div>`;
            div.querySelector('.btn-edit').onclick = () => editTambon(tName);
            div.querySelector('.btn-del').onclick = () => deleteTambon(tName);
            c.appendChild(div);
        });
    }

    function addTambon() {
        if (!guardNotViewer()) return;
        const nEl = document.getElementById('newTambonNameInput'), laEl = document.getElementById('newTambonLatInput'), loEl = document.getElementById('newTambonLonInput');
        const name = (nEl?.value || '').trim(), lat = parseFloat(laEl?.value), lon = parseFloat(loEl?.value);
        if (!name) return showCustomAlert('กรุณากรอกชื่อตำบล', '⚙️ จัดการตำบล');
        if (targetTambonCoordinates[name]) return showCustomAlert('มีชื่อตำบลนี้อยู่ในระบบแล้ว', '⚙️ จัดการตำบล');
        targetTambonCoordinates[name] = { lat: !isNaN(lat) ? lat : 13.1361, lon: !isNaN(lon) ? lon : 101.0322 };
        localStorage.setItem('tambonCoordinates_custom', JSON.stringify(targetTambonCoordinates));
        if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot();
        renderTambonDropdown(); renderTambonModalList();
        nEl.value = ''; laEl.value = ''; loEl.value = ''; showToast('✅ เพิ่มตำบลสำเร็จ');
    }
    function editTambon(oldName) {
        if (!guardNotViewer()) return;
        const cur = targetTambonCoordinates[oldName]; if (!cur) return;
        let modal = document.getElementById('customTambonEditModal');
        if (!modal) {
            modal = document.createElement('div'); modal.id = 'customTambonEditModal';
            modal.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4';
            modal.innerHTML = `<div class="bg-slate-800 text-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-4 border border-slate-700"><h3 class="text-lg font-bold text-amber-400">✏️ แก้ไขชื่อตำบลและพิกัด</h3><div class="space-y-3 text-xs"><div><label class="block text-slate-300 mb-1 font-semibold">ชื่อตำบล</label><input type="text" id="editTambonNameInput" class="w-full px-3.5 py-2 text-slate-800 font-medium rounded-xl text-sm focus:outline-none"></div><div class="grid grid-cols-2 gap-2"><div><label class="block text-slate-300 mb-1 font-semibold">ละติจูด (Lat)</label><input type="text" inputmode="decimal" id="editTambonLatInput" class="w-full px-3 py-2 text-slate-800 font-medium rounded-xl text-sm focus:outline-none"></div><div><label class="block text-slate-300 mb-1 font-semibold">ลองจิจูด (Lon)</label><input type="text" inputmode="decimal" id="editTambonLonInput" class="w-full px-3 py-2 text-slate-800 font-medium rounded-xl text-sm focus:outline-none"></div></div></div><div class="flex justify-end gap-2 pt-2"><button type="button" onclick="document.getElementById('customTambonEditModal').classList.add('hidden')" class="text-slate-300 px-4 py-2 rounded-xl text-sm font-semibold">ยกเลิก</button><button type="button" id="editTambonSaveBtn" class="bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-sm px-5 py-2 rounded-xl shadow">บันทึก</button></div></div>`;
            document.body.appendChild(modal);
        }
        document.getElementById('editTambonNameInput').value = oldName;
        document.getElementById('editTambonLatInput').value = cur.lat;
        document.getElementById('editTambonLonInput').value = cur.lon;
        document.getElementById('editTambonSaveBtn').onclick = () => {
            const nName = document.getElementById('editTambonNameInput').value.trim();
            const nLat = parseFloat(document.getElementById('editTambonLatInput').value), nLon = parseFloat(document.getElementById('editTambonLonInput').value);
            if (!nName || (nName !== oldName && targetTambonCoordinates[nName])) return showCustomAlert('ชื่อตำบลไม่ถูกต้องหรือซ้ำ', '⚙️ จัดการตำบล');
            const next = {};
            Object.keys(targetTambonCoordinates).forEach(k => { next[k === oldName ? nName : k] = k === oldName ? { lat: !isNaN(nLat) ? nLat : cur.lat, lon: !isNaN(nLon) ? nLon : cur.lon } : targetTambonCoordinates[k]; });
            targetTambonCoordinates = next;
            localStorage.setItem('tambonCoordinates_custom', JSON.stringify(targetTambonCoordinates));
            if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot();
            const hid = document.getElementById('tambonSelect'), wasSel = hid?.value === oldName;
            renderTambonDropdown(); renderTambonModalList();
            if (wasSel) { hid.value = nName; fetchLiveWeatherForTambon(nName, false); }
            modal.classList.add('hidden'); showToast('✅ แก้ไขข้อมูลตำบลสำเร็จ');
        };
        modal.classList.remove('hidden');
    }
    function deleteTambon(name) { if (!guardNotViewer()) return; showCustomConfirm(`ต้องการลบ "${name}" ใช่หรือไม่?`, () => { delete targetTambonCoordinates[name]; localStorage.setItem('tambonCoordinates_custom', JSON.stringify(targetTambonCoordinates)); renderTambonDropdown(); renderTambonModalList(); showToast('🗑️ ลบตำบลเรียบร้อยแล้ว'); }, '🗑️ ยืนยันการลบตำบล'); }

    function initStations() {
        try { const s = JSON.parse(Core.rawStorageGet('stationList_custom') || '[]'); stationsList = s.length ? s : [...defaultStations]; } catch (e) { stationsList = [...defaultStations]; }
        renderStationDropdown();
    }
    function saveStations() { localStorage.setItem('stationList_custom', JSON.stringify(stationsList)); if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot(); renderStationDropdown(); renderStationModalList(); }
    function toggleStationDropdown() { document.getElementById('stationDropdownMenu')?.classList.toggle('hidden'); }
    function selectStation(val) {
        document.getElementById('stationValue').value = val;
        const disp = document.getElementById('stationTypeDisplay');
        if (disp) { disp.textContent = val; disp.classList.remove('text-slate-400'); disp.classList.add('text-slate-800'); }
        document.getElementById('stationDropdownMenu')?.classList.add('hidden');
        if (typeof saveFaultDraft === 'function') saveFaultDraft();
    }
    function renderStationDropdown() {
        const ul = document.getElementById('stationSortableList'); if (!ul) return; ul.innerHTML = '';
        stationsList.forEach(st => {
            const li = document.createElement('li'); li.className = 'flex items-center gap-3 px-4 py-2.5 hover:bg-blue-50 cursor-pointer text-sm text-slate-700 bg-white border-b border-slate-100 last:border-0'; li.setAttribute('data-value', st);
            li.innerHTML = `<span class="station-dd-drag-handle text-slate-400 hover:text-blue-500 cursor-move text-lg px-2 -ml-2 rounded shrink-0">≡</span><span class="item-label flex-1"></span>`;
            li.querySelector('.station-dd-drag-handle').onclick = e => e.stopPropagation();
            const lbl = li.querySelector('.item-label'); lbl.textContent = st; lbl.onclick = () => selectStation(st);
            ul.appendChild(li);
        });
        if (!ul.sortableInstance && typeof Sortable !== 'undefined') {
            ul.sortableInstance = new Sortable(ul, { handle: '.station-dd-drag-handle', animation: 150, ghostClass: 'issue-ghost', onEnd: () => { stationsList = Array.from(ul.children).map(li => li.getAttribute('data-value')); saveStations(); } });
        }
    }
    function openStationManageModal() { if (!guardNotViewer()) return; renderStationModalList(); document.getElementById('stationModal')?.classList.remove('hidden'); const c = document.getElementById('stationListContainer'); if (c && !c.sortableInstance && typeof Sortable !== 'undefined') c.sortableInstance = new Sortable(c, { handle: '.station-modal-drag-handle', animation: 150, onEnd: evt => { const m = stationsList.splice(evt.oldIndex, 1)[0]; stationsList.splice(evt.newIndex, 0, m); saveStations(); } }); }
    function closeStationManageModal() { document.getElementById('stationModal')?.classList.add('hidden'); }
    function renderStationModalList() {
        const c = document.getElementById('stationListContainer'); if (!c) return; c.innerHTML = stationsList.length ? '' : '<div class="text-center text-slate-500 text-sm py-4">ไม่มีข้อมูลสถานี</div>';
        stationsList.forEach(st => {
            const div = document.createElement('div'); div.className = 'flex items-center justify-between bg-white border border-slate-200 rounded-lg p-2 shadow-sm';
            div.innerHTML = `<div class="flex items-center flex-1 overflow-hidden"><span class="station-modal-drag-handle text-slate-400 cursor-move text-lg px-2 -ml-1">≡</span><span class="text-sm font-medium text-slate-700 truncate flex-1 pl-1">${escapeHtmlStr(st)}</span></div><div class="flex gap-1 ml-2 shrink-0"><button type="button" class="btn-edit text-amber-500 hover:bg-amber-50 px-2 py-1 rounded text-xs border border-amber-100">✏️ แก้ไข</button><button type="button" class="btn-del text-rose-500 hover:bg-rose-50 px-2 py-1 rounded text-xs border border-rose-100">🗑️ ลบ</button></div>`;
            div.querySelector('.btn-edit').onclick = () => editStation(st); div.querySelector('.btn-del').onclick = () => deleteStation(st); c.appendChild(div);
        });
    }
    function addStation() { if (!guardNotViewer()) return; const inp = document.getElementById('newStationInput'), v = (inp?.value || '').trim(); if (!v) return; if (stationsList.includes(v)) return showToast('มีชื่อสถานีนี้อยู่แล้ว'); stationsList.push(v); saveStations(); inp.value = ''; showToast('เพิ่มสถานีสำเร็จ'); }
    function editStation(oldN) { if (!guardNotViewer()) return; showCustomPrompt('แก้ไขชื่อสถานี:', oldN, nv => { const t = (nv || '').trim(); if (t && t !== oldN && !stationsList.includes(t)) { const i = stationsList.indexOf(oldN); if (i > -1) { stationsList[i] = t; saveStations(); showToast('แก้ไขชื่อสถานีสำเร็จ'); } } }, '✏️ แก้ไขชื่อสถานี'); }
    function deleteStation(n) { if (!guardNotViewer()) return; showCustomConfirm(`ต้องการลบสถานี "${n}" ใช่หรือไม่?`, () => { const i = stationsList.indexOf(n); if (i > -1) { stationsList.splice(i, 1); saveStations(); showToast('ลบสถานีสำเร็จ'); } }, '🗑️ ยืนยันการลบสถานี'); }

    function initIssues() { try { const s = JSON.parse(Core.rawStorageGet('issueList_custom') || '[]'); issueList = s.length ? s : [...defaultIssueTypes]; } catch (e) { issueList = [...defaultIssueTypes]; } renderIssueDropdown(); }
    function saveIssues() { localStorage.setItem('issueList_custom', JSON.stringify(issueList)); if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot(); renderIssueDropdown(); if (!document.getElementById('issueModal')?.classList.contains('hidden')) renderIssueModalList(); }
    function toggleIssueDropdown() { document.getElementById('issueDropdownMenu')?.classList.toggle('hidden'); }
    function selectIssueType(val) { document.getElementById('issueType').value = val; document.getElementById('issueDropdownMenu')?.classList.add('hidden'); document.getElementById('suggest-issue')?.classList.add('hidden'); if (typeof saveOutageDraft === 'function') saveOutageDraft(); }
    function renderIssueDropdown() {
        const ul = document.getElementById('issueSortableList'); if (!ul) return; ul.innerHTML = '';
        issueList.forEach(it => {
            const li = document.createElement('li'); li.className = 'flex items-center gap-3 px-4 py-2.5 hover:bg-blue-50 cursor-pointer text-sm text-slate-700 bg-white border-b border-slate-100 last:border-0'; li.setAttribute('data-value', it);
            li.innerHTML = `<span class="issue-dd-drag-handle text-slate-400 hover:text-blue-500 cursor-move text-lg px-2 -ml-2 rounded shrink-0">≡</span><span class="item-label flex-1"></span>`;
            li.querySelector('.issue-dd-drag-handle').onclick = e => e.stopPropagation();
            const lbl = li.querySelector('.item-label'); lbl.textContent = it; lbl.onclick = () => selectIssueType(it);
            ul.appendChild(li);
        });
        if (!ul.sortableInstance && typeof Sortable !== 'undefined') ul.sortableInstance = new Sortable(ul, { handle: '.issue-dd-drag-handle', animation: 150, ghostClass: 'issue-ghost', onEnd: () => { issueList = Array.from(ul.children).map(li => li.getAttribute('data-value')); saveIssues(); } });
    }
    function openIssueManageModal() { if (!guardNotViewer()) return; renderIssueModalList(); document.getElementById('issueModal')?.classList.remove('hidden'); const c = document.getElementById('issueListContainer'); if (c && !c.sortableInstance && typeof Sortable !== 'undefined') c.sortableInstance = new Sortable(c, { handle: '.issue-modal-drag-handle', animation: 150, onEnd: evt => { const m = issueList.splice(evt.oldIndex, 1)[0]; issueList.splice(evt.newIndex, 0, m); saveIssues(); } }); }
    function closeIssueManageModal() { document.getElementById('issueModal')?.classList.add('hidden'); }
    function renderIssueModalList() {
        const c = document.getElementById('issueListContainer'); if (!c) return; c.innerHTML = issueList.length ? '' : '<div class="text-center text-slate-500 text-sm py-4">ไม่มีข้อมูลลักษณะอาการ</div>';
        issueList.forEach(it => {
            const div = document.createElement('div'); div.className = 'flex items-center justify-between bg-white border border-slate-200 rounded-lg p-2 shadow-sm';
            div.innerHTML = `<div class="flex items-center flex-1 overflow-hidden"><span class="issue-modal-drag-handle text-slate-400 cursor-move text-lg px-2 -ml-1">≡</span><span class="text-sm font-medium text-slate-700 truncate flex-1 pl-1">${escapeHtmlStr(it)}</span></div><div class="flex gap-1 ml-2 shrink-0"><button type="button" class="btn-edit text-amber-500 hover:bg-amber-50 px-2 py-1 rounded text-xs border border-amber-100">✏️ แก้ไข</button><button type="button" class="btn-del text-rose-500 hover:bg-rose-50 px-2 py-1 rounded text-xs border border-rose-100">🗑️ ลบ</button></div>`;
            div.querySelector('.btn-edit').onclick = () => editIssueItem(it); div.querySelector('.btn-del').onclick = () => deleteIssueItem(it); c.appendChild(div);
        });
    }
    function addIssueItem() { if (!guardNotViewer()) return; const inp = document.getElementById('newIssueInput'), v = (inp?.value || '').trim(); if (!v) return; if (issueList.includes(v)) return showToast('มีอาการนี้อยู่แล้ว'); issueList.unshift(v); saveIssues(); inp.value = ''; showToast('เพิ่มลักษณะอาการสำเร็จ'); }
    function editIssueItem(oldN) { if (!guardNotViewer()) return; showCustomPrompt('แก้ไขลักษณะอาการ:', oldN, nv => { const t = (nv || '').trim(); if (t && t !== oldN && !issueList.includes(t)) { const i = issueList.indexOf(oldN); if (i > -1) { issueList[i] = t; saveIssues(); showToast('แก้ไขลักษณะอาการสำเร็จ'); } } }, '✏️ แก้ไขลักษณะอาการ'); }
    function deleteIssueItem(n) { if (!guardNotViewer()) return; showCustomConfirm(`ต้องการลบอาการ "${n}" ใช่หรือไม่?`, () => { const i = issueList.indexOf(n); if (i > -1) { issueList.splice(i, 1); saveIssues(); showToast('ลบลักษณะอาการสำเร็จ'); } }, '🗑️ ยืนยันการลบอาการ'); }
    function autoAddIssueType(it) { const t = String(it || '').trim(); if (t && t !== '-' && !issueList.includes(t)) { issueList.unshift(t); saveIssues(); } }

    function saveHistorySet(storageKey, items) {
        const list = JSON.parse(Core.rawStorageGet(storageKey) || '[]');
        let added = false;
        (items || []).forEach(raw => { const s = String(raw || '').trim(); if (s && s !== '-' && !list.includes(s)) { list.push(s); added = true; } });
        if (added) { localStorage.setItem(storageKey, JSON.stringify(list)); if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot(); }
    }
    function saveEquipmentHistory(items) { saveHistorySet('equipmentHistory', items); }
    function saveWorkerHistory(items) { saveHistorySet('workerHistory', items); }
    function saveAreaHistory(items) { saveHistorySet('areaHistory', items); }

    function showSuggestionsData(inputEl, dropdownId, dataType = 'equipment') {
        const dd = document.getElementById(dropdownId), query = (inputEl?.value || '').trim().toLowerCase();
        if (!dd || !query) { dd?.classList.add('hidden'); return; }
        if (dataType === 'issue') document.getElementById('issueDropdownMenu')?.classList.add('hidden');
        const src = dataType === 'issue' ? issueList : JSON.parse(Core.rawStorageGet(dataType === 'worker' ? 'workerHistory' : (dataType === 'area' ? 'areaHistory' : 'equipmentHistory')) || '[]');
        const matches = src.filter(it => String(it).toLowerCase().includes(query)).slice(0, 30);
        if (!matches.length) { dd.classList.add('hidden'); return; }

        const escapedQ = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        dd.innerHTML = '';
        matches.forEach(match => {
            const li = document.createElement('li');
            li.className = 'px-4 py-2 hover:bg-blue-50 cursor-pointer text-slate-700 border-b border-slate-100 last:border-0 truncate';
            li.innerHTML = escapeHtmlStr(match).replace(new RegExp(`(${escapedQ})`, 'gi'), '<mark class="bg-yellow-200 text-yellow-900 rounded px-0.5">$1</mark>');
            li.onmousedown = e => { e.preventDefault(); inputEl.value = match; inputEl.dispatchEvent(new Event('input', { bubbles: true })); dd.classList.add('hidden'); };
            dd.appendChild(li);
        });
        dd.classList.remove('hidden');
    }

    // ========================================================================
    // 6. ตั้งค่าลิงก์มิเตอร์ (กรอกข้อมูลอัตโนมัติ), ผู้ช่วย AI (Gemini) & ระบบพิมพ์ด้วยเสียง
    // ========================================================================
    let chatContext = [];

    Object.defineProperty(window, 'isTimeManuallyEdited', {
        get: () => isTimeManuallyEdited,
        set: (val) => { isTimeManuallyEdited = Boolean(val); },
        configurable: true
    });

    function openMeterLinkModal() {
        if (!guardNotViewer()) return;
        const inp = document.getElementById('meterLinkInput');
        if (inp) {
            inp.value = getConfiguredMeterFormBaseUrl();
            const bodyBox = inp.parentElement;
            if (bodyBox && !document.getElementById('resetBuiltInMeterLinkBtn')) {
                const helperBtn = document.createElement('button');
                helperBtn.type = 'button';
                helperBtn.id = 'resetBuiltInMeterLinkBtn';
                helperBtn.className = 'w-full mt-1.5 bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 py-1.5 px-2.5 rounded-lg text-[11px] font-bold transition';
                helperBtn.textContent = '🔄 ใช้ใบรายงานมิเตอร์ในระบบ (ส่งเลข CA + ที่อยู่ + GPS กรอกอัตโนมัติ)';
                helperBtn.onclick = () => {
                    inp.value = getBuiltInMeterFormBaseUrl();
                    showToast('✨ ตั้งเป็นลิงก์ใบรายงานมิเตอร์อัตโนมัติแล้ว กดปุ่มบันทึกได้เลย');
                };
                bodyBox.appendChild(helperBtn);
            }
        }
        document.getElementById('meterLinkModal')?.classList.remove('hidden');
    }
    function closeMeterLinkModal() { document.getElementById('meterLinkModal')?.classList.add('hidden'); }
    function saveMeterLink() {
        if (!guardNotViewer()) return;
        const link = (document.getElementById('meterLinkInput')?.value || '').trim() || getBuiltInMeterFormBaseUrl();
        localStorage.setItem('meter_form_link', link);
        if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot();
        showToast('✅ บันทึกลิงก์ฟอร์มมิเตอร์สำเร็จ');
        closeMeterLinkModal();
    }

    // ========================================================================
        // ========================================================================
    // ========================================================================
    // 6.2 ผู้ช่วย AI รับแจ้งเหตุ (แชร์คีย์แยกโควตารายกลุ่ม 100% ร่วมกับ pm-calendar.js + ค้นหาโมเดลอัตโนมัติ)
    // ========================================================================
    const SHARED_GROUP_AI_KEY_PREFIX = 'elec_pm_ai_vision_key_v1__';
    const VALID_GEMINI_KEY_REGEX = /(?:AIza[0-9A-Za-z_-]{25,80}|AQ\.[0-9A-Za-z._=-]{19,199}[0-9A-Za-z_=-])/;
    const FALLBACK_MAIN_GEMINI_MODELS = [
        'gemini-3.5-flash-lite',
        'gemini-3.6-flash',
        'gemini-3.8-flash',
        'gemini-4-hydrogen',
        'gemini-3.1-flash-lite',
        'gemini-2.5-flash-lite'
    ];
    const mainResolvedModelsCache = new Map();
    const mainUnsupportedModels = new Set();
    let isSendingAiChat = false;
    let pendingRetryChatMessage = '';
    let lastMainAiStateSig = '';

    function resetMainAiModelCaches() {
        mainResolvedModelsCache.clear();
        mainUnsupportedModels.clear();
    }

    function getActiveMainAiGroup() {
        const explicitGrp = normGrp(
            (typeof window.getCurrentUserGroup === 'function' ? window.getCurrentUserGroup() : '') ||
            Core.rawStorageGet('elec_app_current_group') ||
            ''
        );
        if (explicitGrp) return explicitGrp;
        try {
            const pmPlans = JSON.parse(Core.rawStorageGet('elec_pm_calendar_plans_v1') || '[]');
            const fromPm = normGrp(pmPlans.find(p => p && !p.pmDeleted && p.ownerGroup)?.ownerGroup || '');
            if (fromPm) return fromPm;
        } catch (e) {}
        return 'กฟส.บึง';
    }

    function getMainGroupAiStorageKey(groupName = getActiveMainAiGroup()) {
        const grp = normGrp(groupName || 'กฟส.บึง') || 'กฟส.บึง';
        return `${SHARED_GROUP_AI_KEY_PREFIX}${grp}`;
    }

    function migrateLegacyGlobalAiKeyOnce() {
        if (Core.rawStorageGet('elec_app_logged_in') !== 'true') return;
        let legacy = '';
        try { legacy = String(localStorage.getItem('gemini_api_key') || Core.rawStorageGet('gemini_api_key') || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim(); } catch (e) {}
        if (!legacy) return;
        const m = legacy.match(VALID_GEMINI_KEY_REGEX);
        const storageKey = getMainGroupAiStorageKey();
        try {
            if (m && !localStorage.getItem(storageKey)) {
                localStorage.setItem(storageKey, m[0]);
            }
            localStorage.removeItem('gemini_api_key');
        } catch (e) {}
    }

    function getCurrentGroupAiKeyMain() {
        migrateLegacyGlobalAiKeyOnce();
        const k = getMainGroupAiStorageKey();
        let val = '';
        try { val = localStorage.getItem(k) || ''; } catch (e) {}
        return String(val || Core.rawStorageGet(k) || '').replace(/[^\x21-\x7E]/g, '').trim();
    }

    function maskMainAiKey(rawKey) {
        const k = String(rawKey || '').trim();
        if (k.length < 12) return '';
        return `${k.slice(0, 8)}••••••••${k.slice(-4)}`;
    }

    function notifySharedAiKeyChanged(storageKey, newVal) {
        resetMainAiModelCaches();
        try {
            window.dispatchEvent(new StorageEvent('storage', { key: storageKey, newValue: newVal }));
        } catch (e) {}
    }

    function resetMainAiChatSession() {
        chatContext = [];
        pendingRetryChatMessage = '';
        const chatHistory = document.getElementById('chatHistory');
        if (chatHistory) {
            chatHistory.innerHTML = '<div class="flex justify-start"><div class="bg-purple-100 text-purple-800 p-2.5 rounded-xl rounded-tl-none max-w-[85%] shadow-sm">สวัสดีครับ แจ้งรายละเอียดเหตุไฟฟ้าขัดข้องมาได้เลยครับ ผมจะช่วยสรุปและกรอกลงฟอร์มให้อัตโนมัติ</div></div>';
        }
    }

    function updateMainChatbotKeyButtonUI() {
        const chatHdrBar = document.querySelector('#geminiChatbot .bg-gradient-to-r');
        const btn = document.querySelector('#geminiChatbot button[onclick*="openApiKeyModal"]');
        if (!btn) return;
        if (btn.parentElement && !document.getElementById('mainAiResetChatBtn')) {
            let targetWrap = btn.parentElement;
            if (targetWrap === chatHdrBar || targetWrap.tagName === 'BUTTON') {
                targetWrap = document.createElement('div');
                targetWrap.className = 'flex flex-wrap items-center justify-end gap-1.5';
                btn.parentElement.insertBefore(targetWrap, btn);
                targetWrap.appendChild(btn);
            }
            const clrBtn = document.createElement('button');
            clrBtn.type = 'button';
            clrBtn.id = 'mainAiResetChatBtn';
            clrBtn.onclick = () => {
                resetMainAiChatSession();
                showToast('🧹 เริ่มบทสนทนา AI ใหม่แล้ว');
            };
            clrBtn.title = 'ล้างประวัติบทสนทนา AI เพื่อเริ่มรับแจ้งเคสใหม่';
            clrBtn.className = 'shrink-0 bg-white/15 hover:bg-white/25 text-white px-2 py-1 rounded-full text-[11px] font-bold transition';
            clrBtn.textContent = '🧹 ล้างแชท';
            targetWrap.insertBefore(clrBtn, btn);
        }
        const grp = getActiveMainAiGroup();
        const hasKey = Boolean(getCurrentGroupAiKeyMain());
        btn.title = `ตั้งค่า Gemini API Key ประจำกลุ่ม ${grp} (ใช้ร่วมกับสแกนแผนที่ PM อัตโนมัติ)`;
        if (hasKey) {
            btn.className = 'shrink-0 bg-emerald-400/25 hover:bg-emerald-400/35 border border-emerald-200/60 text-white px-2.5 py-1 rounded-full text-[11px] font-extrabold flex items-center gap-1 transition';
            btn.innerHTML = '<span>🔑 AI: พร้อม</span><span>⚙️</span>';
        } else {
            btn.className = 'shrink-0 bg-amber-400 hover:bg-amber-300 text-slate-950 px-2.5 py-1 rounded-full text-[11px] font-extrabold flex items-center gap-1 shadow transition';
            btn.innerHTML = '<span>🔑 ตั้งคีย์ AI</span><span>⚙️</span>';
        }
    }

    function ensureMainAiKeyModalEnhanced() {
        const modal = document.getElementById('apiKeyModal');
        if (!modal || modal.dataset.groupUpgraded === '1') return modal;
                modal.dataset.groupUpgraded = '1';
        modal.style.zIndex = '1475';
        modal.onclick = e => { if (e.target === modal) closeApiKeyModal(); };
        modal.innerHTML = `
            <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border-2 border-purple-400 flex flex-col">
                <div class="px-4 py-3 bg-gradient-to-r from-purple-700 via-indigo-700 to-blue-700 text-white flex justify-between items-center">
                    <h3 class="font-extrabold text-sm">🔑 ตั้งค่า API Key AI ประจำกลุ่ม</h3>
                    <button type="button" onclick="closeApiKeyModal()" class="text-white/85 hover:text-white text-xl font-bold leading-none">&times;</button>
                </div>
                <div class="p-4 space-y-3 bg-slate-50 text-xs text-slate-700">
                    <div id="mainAiKeyGroupBadge" class="bg-indigo-950 text-amber-300 font-extrabold px-3 py-1.5 rounded-xl text-[11px] text-center shadow-sm">-</div>
                    <div id="mainAiKeyStatusBox" class="text-[11px] bg-white border border-slate-200 rounded-xl px-3 py-2"></div>
                    <div class="bg-purple-50 border border-purple-200 rounded-xl p-2.5 space-y-1.5 text-[11px]">
                        <div class="font-extrabold text-purple-950">✨ กรอกครั้งเดียว ใช้ได้ทั้งผู้ช่วยรับแจ้งเหตุ, เสียงสด &amp; สแกนป้ายแผนที่ PM:</div>
                        <div>1. ล็อกอินด้วย Gmail ประจำสาขา แล้วกด <b>Create API key</b> (แยกโปรเจกต์เพื่อแยกถังโควตา 100%)</div>
                        <div>2. คัดลอกรหัสที่ขึ้นต้นด้วย <code>AIza...</code> หรือ <code>AQ....</code> มาวางด้านล่าง</div>
                        <div class="pt-1">
                            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 bg-purple-600 hover:bg-purple-700 text-white font-extrabold px-3 py-1.5 rounded-lg text-[11px] shadow-sm">🔗 เปิดหน้าขอรับ API Key ฟรี (Google AI Studio)</a>
                        </div>
                    </div>
                    <div>
                        <label class="block font-extrabold text-slate-700 mb-1">วางรหัส Gemini API Key ของกลุ่มนี้:</label>
                        <input type="text" id="apiKeyInput" onkeydown="if(event.key==='Enter'){event.preventDefault();saveApiKey();}" placeholder="AIzaSy... หรือ AQ...." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" style="-webkit-text-security:disc;text-security:disc;" class="w-full px-3 py-2 rounded-xl bg-white border-2 border-slate-300 focus:border-purple-500 focus:outline-none font-mono text-xs text-slate-900">
                    </div>
                </div>
                <div class="p-3 border-t bg-white flex flex-wrap items-center gap-2">
                    <button type="button" id="mainAiKeyClearBtn" onclick="clearMainApiKey()" class="hidden bg-rose-100 hover:bg-rose-200 text-rose-700 font-bold py-2 px-3 rounded-xl text-xs">🗑️ ลบคีย์</button>
                    <button type="button" onclick="closeApiKeyModal()" class="bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold py-2 px-3.5 rounded-xl text-xs ml-auto">ยกเลิก</button>
                    <button type="button" onclick="saveApiKey()" class="bg-purple-600 hover:bg-purple-700 text-white font-extrabold py-2 px-4 rounded-xl text-xs shadow">💾 บันทึกคีย์ประจำกลุ่ม</button>
                </div>
            </div>`;
        return modal;
    }

    function openApiKeyModal() {
        if (!guardNotViewer()) return;
        const modal = ensureMainAiKeyModalEnhanced();
        if (!modal) return;
        const grp = getActiveMainAiGroup();
        const savedKey = getCurrentGroupAiKeyMain();
        const grpBadge = document.getElementById('mainAiKeyGroupBadge');
        const statusBox = document.getElementById('mainAiKeyStatusBox');
        const inp = document.getElementById('apiKeyInput');
        const clearBtn = document.getElementById('mainAiKeyClearBtn');

        if (grpBadge) grpBadge.textContent = `🏢 โควตาแยกเฉพาะกลุ่ม: ${grp} (เชื่อมกับแผน PM อัตโนมัติ)`;
        if (statusBox) {
            statusBox.innerHTML = savedKey
                ? `สถานะปัจจุบัน: <b class="text-emerald-700">ผูกคีย์แล้ว (${escapeHtmlStr(maskMainAiKey(savedKey))})</b>`
                : `สถานะปัจจุบัน: <b class="text-rose-600">ยังไม่ได้ตั้งค่าคีย์ AI สำหรับกลุ่ม ${escapeHtmlStr(grp)} ในเครื่องนี้</b>`;
        }
        if (inp) inp.value = savedKey;
        if (clearBtn) clearBtn.classList.toggle('hidden', !savedKey);
        modal.classList.remove('hidden');
        setTimeout(() => inp?.focus(), 60);
    }

    function closeApiKeyModal() {
        document.getElementById('apiKeyModal')?.classList.add('hidden');
    }

    function saveApiKey() {
        if (!guardNotViewer()) return;
        const inp = document.getElementById('apiKeyInput');
        const rawVal = String(inp?.value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        const m = rawVal.match(VALID_GEMINI_KEY_REGEX);
        const cleanKey = m ? m[0] : '';
        if (!cleanKey) {
            showCustomAlert('⚠️ รูปแบบ API Key ไม่ถูกต้อง (ต้องขึ้นต้นด้วย AIza... หรือ AQ....)', '🔑 ตั้งค่า API Key ประจำกลุ่ม');
            inp?.focus();
            return;
        }
        const grp = getActiveMainAiGroup();
        const storageKey = getMainGroupAiStorageKey(grp);
        try {
            localStorage.setItem(storageKey, cleanKey);
            localStorage.removeItem('gemini_api_key');
        } catch (e) {
            showToast('❌ พื้นที่เบราว์เซอร์เต็ม ไม่สามารถบันทึกคีย์ได้');
            return;
        }
        notifySharedAiKeyChanged(storageKey, cleanKey);
        updateMainChatbotKeyButtonUI();
        closeApiKeyModal();
        showToast(`✅ บันทึกคีย์ AI ประจำกลุ่ม "${grp}" แล้ว (ใช้ได้ทั้งแชท เสียงสด และสแกนแมพ PM)`);

        if (pendingRetryChatMessage) {
            const retryMsg = pendingRetryChatMessage;
            pendingRetryChatMessage = '';
            const chatInp = document.getElementById('chatInput');
            if (chatInp) {
                chatInp.value = retryMsg;
                sendChatMessage();
            }
        }
    }

    function clearMainApiKey() {
        if (!guardNotViewer()) return;
        const grp = getActiveMainAiGroup();
        const storageKey = getMainGroupAiStorageKey(grp);
        try {
            localStorage.removeItem(storageKey);
            localStorage.removeItem('gemini_api_key');
        } catch (e) {}
        const inp = document.getElementById('apiKeyInput');
        if (inp) inp.value = '';
        notifySharedAiKeyChanged(storageKey, null);
        updateMainChatbotKeyButtonUI();
        closeApiKeyModal();
        showToast(`🗑️ ลบคีย์ AI ของกลุ่ม "${grp}" ออกจากเครื่องนี้แล้ว`);
    }
    window.clearMainApiKey = clearMainApiKey;

    function appendChatMessage(text, sender, isLoading = false) {
        const chatHistory = document.getElementById('chatHistory');
        if (!chatHistory) return '';
        const msgDiv = document.createElement('div');
        const id = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
        msgDiv.id = id;
        msgDiv.className = `flex ${sender === 'user' ? 'justify-end' : 'justify-start'}`;
        const cls = sender === 'user'
            ? 'bg-blue-600 text-white p-2.5 rounded-xl rounded-tr-none max-w-[85%] shadow-sm whitespace-pre-wrap'
            : `bg-purple-100 text-purple-800 p-2.5 rounded-xl rounded-tl-none max-w-[85%] shadow-sm whitespace-pre-wrap${isLoading ? ' animate-pulse opacity-70' : ''}`;
        const inner = document.createElement('div');
        inner.className = cls;
        inner.textContent = text;
        msgDiv.appendChild(inner);
        chatHistory.appendChild(msgDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;
        return id;
    }

    async function resolveAvailableChatModelsMain(apiKey) {
        const keyTag = String(apiKey || '').slice(-10);
        const filterUnsupported = list => list.filter(m => !mainUnsupportedModels.has(`${keyTag}:${m}`));
        if (mainResolvedModelsCache.has(keyTag)) {
            const cached = filterUnsupported(mainResolvedModelsCache.get(keyTag));
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
                const errMsg = String(data?.error?.message || '');
                if (res.status === 401 || /API_KEY_INVALID|API key not valid|key expired|UNAUTHENTICATED|PERMISSION_DENIED|API_KEY_HTTP_REFERRER_BLOCKED|Requests from referer/i.test(errMsg)) {
                    const keyErr = new Error('Invalid API Key');
                    keyErr.isInvalidKey = true;
                    throw keyErr;
                }
            }
            if (res.ok && Array.isArray(data?.models)) {
                const candidates = [];
                data.models.forEach(m => {
                    if (!Array.isArray(m?.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent')) return;
                    const id = String(m.name || '').replace(/^models\//, '').trim();
                    const hydroMatch = id.match(/^gemini-(4)-hydrogen(-preview)?$/i);
                    const flashMatch = id.match(/^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(-preview)?$/i);
                    if (!hydroMatch && !flashMatch) return;
                    const ver = parseFloat((hydroMatch || flashMatch)[1]);
                    if (isNaN(ver) || ver < 2.5) return;
                    const isLite = Boolean(flashMatch && flashMatch[2]);
                    const isPreview = Boolean((hydroMatch && hydroMatch[2]) || (flashMatch && flashMatch[3]));
                    const retiringPenalty = id.toLowerCase() === 'gemini-2.5-flash' ? -25 : 0;
                    const fastChatBonus = id.toLowerCase() === 'gemini-3.5-flash-lite' ? 35 : 0;
                    const score = (ver >= 3 ? 1000 : 0) + (ver * 100) + (isPreview ? 0 : 25) + (isLite ? 5 : 15) + fastChatBonus + retiringPenalty;
                    candidates.push({ id, score });
                });
                candidates.sort((a, b) => b.score - a.score);
                const ordered = candidates.map(c => c.id);
                if (ordered.length > 0) {
                    mainResolvedModelsCache.set(keyTag, ordered);
                    return filterUnsupported(ordered);
                }
            }
        } catch (err) {
            if (err?.isInvalidKey) throw err;
        } finally {
            if (timer) clearTimeout(timer);
        }
        return filterUnsupported(FALLBACK_MAIN_GEMINI_MODELS);
    }

    async function fetchGeminiChat(userText, apiKey) {
        const keyTag = String(apiKey || '').slice(-10);
        const modelList = await resolveAvailableChatModelsMain(apiKey);
        if (!modelList.length) {
            throw new Error('ไม่พบโมเดล Gemini ที่เปิดใช้งานสำหรับคีย์นี้');
        }

        const systemInstruction = [
            'คุณคือผู้ช่วย AI รับแจ้งเหตุไฟฟ้าขัดข้องของการไฟฟ้าส่วนภูมิภาค (PEA)',
            'หน้าที่ของคุณ:',
            '1. ตอบรับผู้ใช้งานอย่างสุภาพ เป็นธรรมชาติ สั้นกระชับ ในฟิลด์ replyText',
            '2. วิเคราะห์ข้อความเพื่อสกัดข้อมูลลงฟิลด์ extractedData (หากข้อมูลใดไม่มีในข้อความ ให้ส่งค่า "" ว่างไว้ ห้ามเดาเอง):',
            '   - issueType: ลักษณะอาการขัดข้อง (เช่น ไฟดับ, ไฟตก, หม้อแปลงระเบิด, สายไฟขาด, มิเตอร์ชำรุด, กิ่งไม้แตะสายไฟ)',
            '   - workerName: ชื่อช่างผู้ปฏิบัติงาน หรือผู้รับแจ้ง (ถ้าระบุ)',
            '   - area: จุดสังเกตหรือบริเวณเกิดเหตุ (รวมถึงกรณีพูดว่า "พิกัดหน้าวัด/พิกัดซอย..." ที่เป็นชื่อสถานที่ ให้ใส่ใน area ไม่ใส่ใน gps)',
            '   - address: บ้านเลขที่ หมู่ ซอย ถนน ตำบล (ไม่ใส่ชื่อ-นามสกุลลูกค้าปนในช่องที่อยู่)',
            '   - phone: เบอร์โทรศัพท์ตัวเลขติดกัน (เช่น 0812345678)',
            '   - gps: เฉพาะตัวเลขพิกัดละติจูด,ลองจิจูด หรือลิงก์ Google Maps เท่านั้น (ถ้าไม่ใช่ตัวเลขพิกัดหรือลิงก์ ให้เว้น "")',
            '   - customerName: ชื่อ-นามสกุลผู้ใช้ไฟ (ถ้ามี)',
            '   - caNo: หมายเลขผู้ใช้ไฟ CA 12 หลัก (ถ้ามี)',
            '   - peaNo: หมายเลขมิเตอร์ PEA No. (ถ้ามี)',
            '3. ตอบกลับเป็น JSON Object ตามโครงสร้างที่กำหนดเท่านั้น'
        ].join('\n');

        const baseSchemaCfg = {
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'OBJECT',
                properties: {
                    replyText: { type: 'STRING' },
                    extractedData: {
                        type: 'OBJECT',
                        properties: {
                            issueType: { type: 'STRING' },
                            workerName: { type: 'STRING' },
                            area: { type: 'STRING' },
                            address: { type: 'STRING' },
                            phone: { type: 'STRING' },
                            gps: { type: 'STRING' },
                            customerName: { type: 'STRING' },
                            caNo: { type: 'STRING' },
                            peaNo: { type: 'STRING' }
                        }
                    }
                },
                required: ['replyText', 'extractedData']
            }
        };

        let lastErr = null;
        let sawQuota429 = false;

        for (const modelName of modelList) {
            if (mainUnsupportedModels.has(`${keyTag}:${modelName}`)) continue;
            const verMatch = modelName.match(/^gemini-(\d+(?:\.\d+)?)/i);
            const majorVer = verMatch ? parseFloat(verMatch[1]) : 2.5;
            const supportsMinimal = /flash-lite|gemini-3\.6-flash|gemini-3-flash/i.test(modelName);
            const primaryGenCfg = majorVer >= 3
                ? { ...baseSchemaCfg, thinkingConfig: { thinkingLevel: supportsMinimal ? 'MINIMAL' : 'LOW' } }
                : { ...baseSchemaCfg, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } };

            for (const cfgAttempt of [primaryGenCfg, baseSchemaCfg]) {
                const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
                const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
                try {
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': apiKey
                        },
                        body: JSON.stringify({
                            systemInstruction: { parts: [{ text: systemInstruction }] },
                            contents: [...chatContext, { role: 'user', parts: [{ text: userText }] }],
                            generationConfig: cfgAttempt
                        }),
                        signal: ctrl ? ctrl.signal : undefined
                    });

                    const data = await res.json().catch(() => null);
                    if (res.ok && data) {
                        const parts = data?.candidates?.[0]?.content?.parts || [];
                        const rawOut = parts
                            .filter(pt => !pt?.thought && typeof pt?.text === 'string')
                            .map(pt => pt.text)
                            .join('\n')
                            .replace(/```json\s*/gi, '')
                            .replace(/```\s*/g, '')
                            .trim();

                        let parsed = null;
                        try {
                            parsed = JSON.parse(rawOut);
                        } catch (e) {
                            const objMatch = rawOut.match(/\{[\s\S]*\}/);
                            if (objMatch) {
                                try { parsed = JSON.parse(objMatch[0]); } catch (e2) {}
                            }
                        }

                        if (parsed && typeof parsed === 'object') {
                            const reply = String(parsed.replyText || 'รับทราบครับ อัปเดตข้อมูลลงฟอร์มให้เรียบร้อยแล้วครับ').trim();
                            chatContext.push(
                                { role: 'user', parts: [{ text: userText }] },
                                { role: 'model', parts: [{ text: JSON.stringify({ replyText: reply, extractedData: parsed.extractedData || {} }) }] }
                            );
                            if (chatContext.length > 10) chatContext = chatContext.slice(-10);
                            return { text: reply, extractedData: parsed.extractedData || null };
                        }
                        return { text: rawOut || 'รับทราบครับ', extractedData: null };
                    }

                    const errMsg = String(data?.error?.message || `HTTP ${res.status}`);
                    if (res.status === 400 || res.status === 401 || res.status === 403) {
                        if (res.status === 401 || /API_KEY_INVALID|API key not valid|key expired|UNAUTHENTICATED|API_KEY_HTTP_REFERRER_BLOCKED|Requests from referer/i.test(errMsg)) {
                            const keyErr = new Error('Invalid API Key');
                            keyErr.isInvalidKey = true;
                            throw keyErr;
                        }
                        if (res.status === 400 && cfgAttempt === primaryGenCfg) continue;
                    }
                    if (res.status === 404 || res.status === 403 || (res.status === 429 && /\blimit:\s*0\b/i.test(errMsg))) {
                        mainUnsupportedModels.add(`${keyTag}:${modelName}`);
                    }
                    if (res.status === 429) sawQuota429 = true;
                    lastErr = new Error(errMsg);
                    break;
                } catch (err) {
                    if (err?.isInvalidKey) throw err;
                    lastErr = err;
                    break;
                } finally {
                    if (timer) clearTimeout(timer);
                }
            }
        }
        const finalErr = lastErr || new Error('API Request Failed');
        if (sawQuota429) finalErr.isQuotaExceeded = true;
        throw finalErr;
    }

        function fillFormWithData(data) {
        if (!data || typeof data !== 'object') return;
        const cleanAiVal = v => {
            const s = String(v ?? '').trim();
            return (!s || /^(?:-|none|null|undefined|n\/a|ไม่ระบุ|ไม่มี|ไม่ทราบ)$/i.test(s)) ? '' : s;
        };

        let filled = false;
        const newCust = cleanAiVal(data.customerName);
        const newCa = cleanAiVal(data.caNo).replace(/\D/g, '');
        const newPea = cleanAiVal(data.peaNo);
        const newAddr = cleanAiVal(data.address);

        let cleanPhone = cleanAiVal(data.phone).replace(/[^\d+]/g, '');
        if (/^\+?66\d{8,9}$/.test(cleanPhone)) cleanPhone = '0' + cleanPhone.replace(/^\+?66/, '');
        cleanPhone = cleanPhone.replace(/\D/g, '') || cleanAiVal(data.phone);

        if (newCust) lastPastedCustomerMeta.customerName = newCust;
        if (newCa) lastPastedCustomerMeta.caNo = newCa;
        if (newPea) lastPastedCustomerMeta.peaNo = newPea;

        [['issueType', data.issueType], ['workerName', data.workerName], ['area', data.area], ['phone', cleanPhone]].forEach(([k, rawV]) => {
            const val = cleanAiVal(rawV);
            if (val) {
                const el = document.getElementById(k);
                if (el) { el.value = val; filled = true; }
            }
        });

        if (newAddr || newCa || newPea) {
            const addrEl = document.getElementById('address');
            if (addrEl) {
                const prevLines = String(addrEl.value || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                const prevStreetLines = prevLines.filter(l => !/^(?:CA|มิเตอร์\s*-\s*PEA\s*No\.)\s*:/i.test(l));
                const prevCaLine = prevLines.find(l => /^CA\s*:/i.test(l)) || '';
                const prevPeaLine = prevLines.find(l => /^มิเตอร์\s*-\s*PEA\s*No\.\s*:/i.test(l)) || '';

                const streetPart = newAddr || prevStreetLines.join('\n');
                const addrParts = streetPart ? [streetPart] : [];
                const finalCaLine = newCa ? `CA : ${newCa}` : prevCaLine;
                const finalPeaLine = newPea ? `มิเตอร์ - PEA No. : ${newPea}` : prevPeaLine;

                const streetHasCa = newCa && streetPart.includes(newCa);
                const escPea = newPea ? newPea.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
                const streetHasPea = newPea && new RegExp(`(?:PEA\\s*No\\.?|มิเตอร์)\\s*[:：=]?\\s*${escPea}(?!\\w)`, 'i').test(streetPart);

                if (finalCaLine && !streetHasCa) addrParts.push(finalCaLine);
                if (finalPeaLine && !streetHasPea) addrParts.push(finalPeaLine);

                if (addrParts.length > 0) {
                    addrEl.value = addrParts.join('\n');
                    addrEl.style.height = 'auto';
                    addrEl.style.height = addrEl.scrollHeight + 'px';
                    addrEl.dispatchEvent(new Event('input', { bubbles: true }));
                    filled = true;
                }
            }
        }

        const newGps = cleanAiVal(data.gps);
        if (newGps) {
            const isRealGpsOrLink = /^(?:https?:\/\/|maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.|maps\.)?google\.[a-z.]+\/maps)/i.test(newGps) ||
                Boolean(extractCoordsFromInput(newGps));
            if (isRealGpsOrLink) {
                const gpsEl = document.getElementById('gps');
                if (gpsEl) {
                    gpsEl.value = newGps;
                    gpsEl.dispatchEvent(new Event('input', { bubbles: true }));
                    filled = true;
                }
            } else {
                const areaEl = document.getElementById('area');
                if (areaEl && !areaEl.value.trim()) {
                    areaEl.value = newGps;
                    filled = true;
                }
            }
        }

        if (filled) {
            ['suggest-issue', 'suggest-worker', 'suggest-area', 'issueDropdownMenu'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
            autoFillJobNo(false);
            if (typeof checkCaOverdueEnhanced === 'function') checkCaOverdueEnhanced(false);
            saveOutageDraft();
            showToast('✨ AI สรุปและกรอกข้อมูลลงฟอร์มแล้ว!');
        }
    }

    async function sendChatMessage() {
        if (!guardNotViewer() || isSendingAiChat) return;
        const inputEl = document.getElementById('chatInput');
        const message = (inputEl?.value || '').trim();
        if (!message) return;

        const apiKey = getCurrentGroupAiKeyMain();
        const grp = getActiveMainAiGroup();
        if (!apiKey) {
            pendingRetryChatMessage = message;
            inputEl.value = '';
            appendChatMessage(message, 'user');
            appendChatMessage(`⚠️ กลุ่ม "${grp}" ยังไม่ได้ตั้งค่าคีย์ AI ในเครื่องนี้ กรุณาวาง API Key ในหน้าต่างที่เด้งขึ้นมา แล้วระบบจะประมวลผลข้อความนี้ต่อให้ทันทีครับ`, 'bot');
            setTimeout(openApiKeyModal, 350);
            return;
        }

        appendChatMessage(message, 'user');
        inputEl.value = '';
        isSendingAiChat = true;
        const loadId = appendChatMessage('⏳ กำลังประมวลผล...', 'bot', true);

        try {
            const res = await fetchGeminiChat(message, apiKey);
            document.getElementById(loadId)?.remove();
            appendChatMessage(res.text, 'bot');
            if (res.extractedData) fillFormWithData(res.extractedData);
        } catch (err) {
            document.getElementById(loadId)?.remove();
            if (err?.isInvalidKey) {
                pendingRetryChatMessage = message;
                appendChatMessage(`❌ API Key ของกลุ่ม "${grp}" ไม่ถูกต้อง ถูกจำกัดสิทธิ์โดเมน หรือหมดอายุ กรุณาตั้งค่าคีย์ใหม่ครับ`, 'bot');
                setTimeout(openApiKeyModal, 500);
            } else if (err?.isQuotaExceeded) {
                appendChatMessage(`⚠️ โควตา AI ฟรีของกลุ่ม "${grp}" เต็มชั่วคราว กรุณารอสักครู่แล้วลองใหม่ หรือเปลี่ยนคีย์ที่ปุ่ม ⚙️ ครับ`, 'bot');
            } else {
                appendChatMessage(`❌ เชื่อมต่อ AI ขัดข้อง (${err?.message || 'กรุณาตรวจสอบอินเทอร์เน็ต'})`, 'bot');
            }
        } finally {
            isSendingAiChat = false;
        }
    }

    function watchMainAiGroupAndKeyState() {
        const isLogged = Core.rawStorageGet('elec_app_logged_in') === 'true';
        const grp = isLogged ? getActiveMainAiGroup() : '';
        const hasKey = isLogged ? Boolean(getCurrentGroupAiKeyMain()) : false;
        const nextSig = `${isLogged ? 1 : 0}|${grp}|${hasKey ? 1 : 0}`;
        if (nextSig !== lastMainAiStateSig) {
            const prevParts = lastMainAiStateSig.split('|');
            if (lastMainAiStateSig && (prevParts[0] !== (isLogged ? '1' : '0') || prevParts[1] !== grp)) {
                resetMainAiChatSession();
            }
            lastMainAiStateSig = nextSig;
            if (isLogged) updateMainChatbotKeyButtonUI();
        }
    }

    window.addEventListener('storage', e => {
        if (!e.key || e.key.startsWith(SHARED_GROUP_AI_KEY_PREFIX) || e.key === 'gemini_api_key' || e.key === 'elec_app_current_group') {
            if (!e.key || e.key.startsWith(SHARED_GROUP_AI_KEY_PREFIX) || e.key === 'gemini_api_key') {
                resetMainAiModelCaches();
            }
            watchMainAiGroupAndKeyState();
        }
    });
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', () => { ensureMainAiKeyModalEnhanced(); watchMainAiGroupAndKeyState(); });
    } else {
        ensureMainAiKeyModalEnhanced();
        watchMainAiGroupAndKeyState();
    }
    setInterval(watchMainAiGroupAndKeyState, 1200);
    // ===== จบพาทที่ 1 / 2 ของไฟล์ main-app.js =====
        // ===== เริ่มพาทที่ 2 / 3 ของไฟล์ main-app.js (วางต่อจากพาทที่ 1) =====
    function startChatVoiceInput() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return showToast('เบราว์เซอร์นี้ไม่รองรับการพิมพ์ด้วยเสียง');
        const rec = new SR();
        rec.lang = 'th-TH';
        rec.onstart = () => showToast('🎙️ กำลังฟัง... พูดได้เลยครับ');
        rec.onresult = e => { const el = document.getElementById('chatInput'); if (el) el.value += (el.value ? ' ' : '') + e.results[0][0].transcript; };
        rec.onerror = () => showToast('❌ รับเสียงไม่สำเร็จ');
        rec.start();
    }

    function startVoiceInput(inputId, btnElement) {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return showToast('เบราว์เซอร์นี้ไม่รองรับการพิมพ์ด้วยเสียง (แนะนำให้ใช้ Chrome)');
        const inputEl = document.getElementById(inputId);
        if (!inputEl) return;

        const rec = new SR();
        rec.lang = 'th-TH';
        rec.onstart = () => { btnElement?.classList.add('text-rose-500', 'animate-pulse', 'bg-rose-50'); showToast('🎙️ กำลังฟัง... พูดได้เลยครับ'); };
        rec.onresult = e => {
            const txt = e.results[0][0].transcript;
            if (inputEl.tagName === 'TEXTAREA') {
                inputEl.value += (inputEl.value ? ' ' : '') + txt;
                inputEl.style.height = 'auto'; inputEl.style.height = inputEl.scrollHeight + 'px';
            } else inputEl.value = txt;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        };
        rec.onerror = e => {
            btnElement?.classList.remove('text-rose-500', 'animate-pulse', 'bg-rose-50');
            if (e.error === 'not-allowed') showCustomAlert('⚠️ ไมโครโฟนถูกบล็อก! กรุณากดอนุญาตไมโครโฟนที่แถบ URL ของเบราว์เซอร์', '🎙️ การเข้าถึงไมโครโฟน');
            else showToast('❌ รับเสียงไม่สำเร็จ กรุณาลองใหม่');
        };
        rec.onend = () => btnElement?.classList.remove('text-rose-500', 'animate-pulse', 'bg-rose-50');
        rec.start();
    }

    // ========================================================================
    // 7. พิกัด GPS, พรีวิวแผนที่ Google Maps & ค้นหาชื่อสถานที่อัตโนมัติ
    // ========================================================================
    function getIssuePriority(issueText) {
        if (!issueText || !issueText.trim()) return { level: 'normal', label: 'ปกติ', color: 'text-emerald-600 bg-emerald-50 border-emerald-200', emoji: '🟢' };
        const lower = issueText.toLowerCase().trim().replace(/เเ/g, 'แ');
        const crit = ['เสาหัก', 'เสาล้ม', 'ระเบิด', 'ช็อต', 'ประกายไฟ', 'รถชน', 'รถชนเสา', 'สายขาด', 'ไหม้', 'หลายหลัง', 'อันตราย', 'ไฟรั่ว', 'ฟิวส์แรงสูงขาด', 'ฟิวส์ไลน์', 'ดร๊อปไลน์', 'ดร็อปไลน์', 'ดรอปไลน์', 'สายไฟแรงสูงขาด', 'ต้นไม้ทับสายไฟแรงสูง', 'ต้นไม้ล้มทับสายไฟแรงสูง', 'ทับสายไฟ', 'ต้นไม้ล้ม', 'แรงสูง'];
        const urg = ['ไฟดับ', 'ไฟตก', 'กระแสไฟตก', 'เสียงดัง', 'กระพริบ', 'กะพริบ', 'สายหย่อน', 'หย่อน'];
        if (crit.some(kw => lower.includes(kw))) return { level: 'critical', label: 'วิกฤต/อันตรายมาก', color: 'text-rose-600 bg-rose-50 border-rose-200', emoji: '🔴' };
        if (urg.some(kw => lower.includes(kw))) return { level: 'urgent', label: 'เร่งด่วน', color: 'text-amber-600 bg-amber-50 border-amber-200', emoji: '🟡' };
        return { level: 'normal', label: 'ปกติ', color: 'text-emerald-600 bg-emerald-50 border-emerald-200', emoji: '🟢' };
    }

        function extractCoordsFromInput(input) {
        if (!input) return null;
        const s = String(input).trim();
        if (!s || s === '-') return null;

        if (typeof deepParseCoords === 'function') {
            const d = deepParseCoords(s, false);
            if (d && !isNaN(parseFloat(d.lat)) && !isNaN(parseFloat(d.lon))) {
                return { lat: Number(parseFloat(d.lat).toFixed(6)), lon: Number(parseFloat(d.lon).toFixed(6)) };
            }
        }

        // รองรับรูปแบบ "Lat: 13.087838 Long: 100.987892" หรือ "ละติจูด ... ลองจิจูด ..."
        const mLabel = s.match(/(?:lat(?:itude)?|ละติจูด)\s*[:：=]?\s*(-?\d{1,3}\.\d{3,})[\s,;\/|]*(?:long(?:itude)?|lon|lng|ลองจิจูด)\s*[:：=]?\s*\+?(-?\d{1,3}\.\d{3,})/i) ||
                       s.match(/(?:long(?:itude)?|lon|lng|ลองจิจูด)\s*[:：=]?\s*\+?(-?\d{1,3}\.\d{3,})[\s,;\/|]*(?:lat(?:itude)?|ละติจูด)\s*[:：=]?\s*(-?\d{1,3}\.\d{3,})/i);
        if (mLabel) {
            const lonFirst = /^(?:long|lon|lng|ลองจิจูด)/i.test(mLabel[0]);
            let lat = parseFloat(lonFirst ? mLabel[2] : mLabel[1]);
            let lon = parseFloat(lonFirst ? mLabel[1] : mLabel[2]);
            if (lat >= 95 && lat <= 108 && lon >= 4 && lon <= 23) { const tmp = lat; lat = lon; lon = tmp; }
            if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
                return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
            }
        }

        // รองรับตัวเลขพิกัดคั่นด้วยเว้นวรรคหรือลูกน้ำ เช่น "13.087838 100.987892"
        const mPair = s.match(/(?:^|[^\d.])(-?\d{1,3}\.\d{4,})\s*(?:,|\s+)\s*\+?(-?\d{1,3}\.\d{4,})(?!\d)/);
        if (mPair) {
            let lat = parseFloat(mPair[1]), lon = parseFloat(mPair[2]);
            if (lat >= 95 && lat <= 108 && lon >= 4 && lon <= 23) { const tmp = lat; lat = lon; lon = tmp; }
            if (lat >= 4 && lat <= 23 && lon >= 95 && lon <= 108) {
                return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
            }
        }
        return null;
    }

    function formatGpsInput(inputVal) {
        if (!inputVal) return '-';
        const val = String(inputVal).trim();
        if (!val || val === '-') return '-';
        if (/^https?:\/\//i.test(val)) return val;
        if (/^(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.|maps\.)?google\.[a-z.]+\/maps)/i.test(val)) {
            return 'https://' + val;
        }
        const coords = extractCoordsFromInput(val);
        return (coords?.lat && coords?.lon) ? `https://www.google.com/maps?q=${coords.lat},${coords.lon}` : val;
    }
    async function fetchPlaceNameFromCoords(lat, lon) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=th`);
            if (!res.ok) return null;
            const data = await res.json(), a = data?.address || {};
            return a.village || a.suburb || a.town || a.city_district || a.county || (data?.display_name ? data.display_name.split(',')[0] : null);
        } catch (e) { return null; }
    }

    function handleAreaAutoFill(placeName) {
        if (!placeName) return;
        const areaInput = document.getElementById('area'), dd = document.getElementById('suggest-area');
        if (!areaInput || !dd) return;
        const cur = areaInput.value.trim();
        if (!cur) { areaInput.value = placeName; showToast(`📍 ค้นพบสถานที่: ${placeName}`); return; }

        dd.innerHTML = '';
        const li = document.createElement('li');
        li.className = 'px-4 py-2 bg-emerald-50 hover:bg-emerald-100 cursor-pointer text-emerald-700 border-b border-emerald-200 truncate font-bold flex justify-between items-center';
        li.innerHTML = `<span>📍 นำไปต่อท้ายข้อความเดิม</span><span class="text-xs font-normal bg-white px-2 py-0.5 rounded shadow-sm border border-emerald-100">${escapeHtmlStr(placeName)}</span>`;
        li.onmousedown = e => { e.preventDefault(); areaInput.value = cur + ' ' + placeName; dd.classList.add('hidden'); showToast('📍 เพิ่มชื่อสถานที่ต่อท้ายแล้ว'); };
        dd.appendChild(li);
        dd.classList.remove('hidden');
    }

    function renderMapIframePreview(coords, isTab1) {
        const container = document.getElementById(isTab1 ? 'mapPreviewContainerTab1' : 'mapPreviewContainer');
        const iframe = document.getElementById(isTab1 ? 'googleMapIframeTab1' : 'googleMapIframe');
        const label = document.getElementById(isTab1 ? 'mapCoordLabelTab1' : 'mapCoordLabel');
        const extLink = document.getElementById(isTab1 ? 'mapExternalLinkTab1' : 'mapExternalLink');
        if (!container || !iframe) return;

        if (coords?.lat && coords?.lon) {
            const embedUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lon}&hl=th&z=16&output=embed`;
            const directUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lon}`;
            if (label) label.textContent = `📍 พิกัด: ${coords.lat}, ${coords.lon}`;
            if (extLink) extLink.href = directUrl;
            container.classList.remove('hidden');
            if (iframe.getAttribute('data-loaded-url') !== embedUrl) {
                iframe.src = embedUrl;
                iframe.setAttribute('data-loaded-url', embedUrl);
            }
            const leftDock = document.getElementById('leftBrowserDock');
            if (leftDock && leftDock.classList.contains('hidden') && window.innerWidth >= 1024) {
                localStorage.setItem('elec_left_browser_last_url', embedUrl);
                openLeftWebBrowser();
            } else {
                loadLeftBrowserUrl(embedUrl, false);
            }
        } else {
            iframe.src = 'about:blank';
            iframe.removeAttribute('data-loaded-url');
            container.classList.add('hidden');
        }
    }

    function updateMapPreview(coords) { renderMapIframePreview(coords, false); }
    function updateMapPreviewTab1(coords) { renderMapIframePreview(coords, true); }

    // ========================================================================
    // 8. สลับแท็บ, เปลี่ยนกะอัตโนมัติ (ผูกกะ 3 ช่วง 00.00-00.29 น.) & รันเลขงานตรงกันทุกเครื่อง
    // ========================================================================
    function setTimeInputToNow(showMsg = false) {
        const timeEl = document.getElementById('timeInput');
        if (!timeEl) return;
        const now = new Date();
        const tStr = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')} น.`;
        timeEl.value = tStr;
        isTimeManuallyEdited = false;
        if (showMsg) showToast(`⏰ อัปเดตเวลาปัจจุบัน (${tStr}) แล้ว`);
    }

    function updateCircuitDropdown() {
        const system = document.getElementById('systemSelect')?.value || '';
        const circuitSelect = document.getElementById('circuitSelect');
        if (!circuitSelect) return;

        circuitSelect.innerHTML = '<option value="" disabled selected hidden>-- กรุณาเลือกวงจร --</option>';
        const prefix = system === '115kV' ? 'LINE ' : 'F';
        for (let i = 1; i <= 15; i++) {
            const opt = document.createElement('option');
            opt.value = `${prefix}${i}`; opt.textContent = `${prefix}${i}`;
            circuitSelect.appendChild(opt);
        }
        const is115 = (system === '115kV');
        document.getElementById('distanceZoneField')?.classList.toggle('hidden', !is115);
        ['deviceField', 'disconnectField', 'powerUpField', 'currentsField', 'presentCurrField'].forEach(id => {
            document.getElementById(id)?.classList.toggle('hidden', is115);
        });
    }

    function switchTab(tabId) {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('[id^="btn-tab"]').forEach(el => {
            el.classList.remove('bg-green-500', 'text-white', 'shadow');
            el.classList.add('bg-blue-800', 'text-white/80', 'hover:bg-blue-700');
        });
        document.getElementById(tabId)?.classList.add('active');
        const activeBtn = document.getElementById('btn-' + tabId);
        if (activeBtn) {
            activeBtn.classList.remove('bg-blue-800', 'text-white/80', 'hover:bg-blue-700');
            activeBtn.classList.add('bg-green-500', 'text-white', 'shadow');
        }
        localStorage.setItem('last_active_tab', tabId);
        if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot();

        if (tabId === 'tab2') {
            checkShiftTransition(false);
            autoFillJobNo(false);
        }
        if (tabId === 'tab1' || tabId === 'tab2') {
            const isT1 = (tabId === 'tab1');
            const rawVal = (document.getElementById(isT1 ? 'gpsInput' : 'gps')?.value || '').trim();
            renderMapIframePreview(extractCoordsFromInput(rawVal), isT1);
        } else if (tabId === 'tab4') {
            loadAnalyticsData();
        }
    }

    function getRealTimeShiftAndDate() {
        const now = new Date();
        const totalMin = now.getHours() * 60 + now.getMinutes();
        const shiftStr = (totalMin >= 30 && totalMin < 510) ? '1' : ((totalMin >= 510 && totalMin < 990) ? '2' : '3');
        const calendarDateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear() + 543}`;
        const cyc = new Date(now);
        if (totalMin < 30) cyc.setDate(cyc.getDate() - 1);
        const dateStr = `${String(cyc.getDate()).padStart(2, '0')}/${String(cyc.getMonth() + 1).padStart(2, '0')}/${cyc.getFullYear() + 543}`;
        const shiftStateId = `${dateStr}_S${shiftStr}`;
        return { shiftStr, dateStr, calendarDateStr, shiftStateId };
    }

    function tagUntaggedLocalJobsWithCurrentGroup() {
        const validGroups = getValidSystemGroupsSet();
        ['elecReportsComplete_all', 'fault_reports_all'].forEach(sk => {
            const list = JSON.parse(Core.rawStorageGet(sk) || '[]');
            let updated = false;
            list.forEach(it => {
                if (!it) return;
                const cleanG = normGrp(it.ownerGroup || '');
                if (cleanG && !validGroups.has(cleanG) && !/^กฟ/.test(cleanG)) { delete it.ownerGroup; updated = true; }
                const resolvedG = normGrp(getJobGroupName(it) || 'กฟส.บึง') || 'กฟส.บึง';
                if (it.ownerGroup !== resolvedG) { it.ownerGroup = resolvedG; updated = true; }
            });
            if (updated) localStorage.setItem(sk, JSON.stringify(list));
        });
    }

    function computeMaxJobNoForShift(curShift, curDate) {
        const sTrim = String(curShift || '').trim();
        const dNorm = normalizeThaiDateMain(curDate);
        if (!sTrim) return 0;
        tagUntaggedLocalJobsWithCurrentGroup();
        const delReg = getDeletedJobsRegistry();
        const myGrp = normGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
        const allItems = JSON.parse(Core.rawStorageGet('elecReportsComplete_all') || '[]');
        let maxNo = 0;

        allItems.forEach(it => {
            if (!it || (it.dateTimeSaved && delReg[it.dateTimeSaved])) return;
            if (!isCurrentUserAdmin() && normGrp(getJobGroupName(it)) !== myGrp) return;
            if (isCurrentUserAdmin()) {
                const adminGrp = normGrp(Core.rawStorageGet('elec_app_current_group') || '');
                if (adminGrp && normGrp(getJobGroupName(it)) !== adminGrp) return;
            }
            const itemDate = normalizeThaiDateMain((it.reportDate && it.reportDate !== '-') ? it.reportDate : (it.dateTimeSaved || ''));
            if (String(it.shift || '').trim() === sTrim && (!dNorm || itemDate === dNorm)) {
                const n = parseInt(it.jobNo, 10);
                if (!isNaN(n) && n > maxNo) maxNo = n;
            }
        });
        return maxNo;
    }

    function autoFillJobNo(forceRecalc = false) {
        if (editingOutageId) return;
        const shiftEl = document.getElementById('shift');
        const dateEl = document.getElementById('reportDate');
        const jobNoEl = document.getElementById('jobNo');
        if (!jobNoEl) return;

        const rt = getRealTimeShiftAndDate();
        if (dateEl && !String(dateEl.value || '').trim()) dateEl.value = rt.dateStr;
        if (shiftEl && !String(shiftEl.value || '').trim()) shiftEl.value = rt.shiftStr;

        const curShift = String(shiftEl?.value || rt.shiftStr).trim();
        const curDate = String(dateEl?.value || rt.dateStr).trim();
        const maxNo = computeMaxJobNoForShift(curShift, curDate);

        if (maxNo > 0 && Core.rawStorageGet(RESET_LOCK_KEY) === 'true') {
            localStorage.removeItem(RESET_LOCK_KEY);
        }
        if (!forceRecalc && isManualJobNoOverride && document.activeElement === jobNoEl) return;

        if (Core.rawStorageGet(RESET_LOCK_KEY) === 'true' && maxNo === 0) {
            jobNoEl.value = '1';
            return;
        }
        const curValNum = parseInt(jobNoEl.value, 10);
        if (forceRecalc || !isManualJobNoOverride || isNaN(curValNum) || curValNum <= maxNo) {
            jobNoEl.value = String(maxNo + 1);
        }
    }

    function checkShiftTransition(isInitialLoad = false) {
        const shiftEl = document.getElementById('shift'), dateEl = document.getElementById('reportDate'), jobNoEl = document.getElementById('jobNo');
        if (!shiftEl || !dateEl || !jobNoEl || editingOutageId) return;
        if (document.activeElement === shiftEl || document.activeElement === jobNoEl || document.activeElement === dateEl) return;

        const { shiftStr, dateStr, shiftStateId } = getRealTimeShiftAndDate();
        const lastStateId = Core.rawStorageGet(LAST_SHIFT_STATE_KEY);

        if (!lastStateId || lastStateId !== shiftStateId) {
            dateEl.value = dateStr;
            shiftEl.value = shiftStr;
            isManualShiftOverride = false;
            isManualJobNoOverride = false;
            localStorage.setItem(LAST_SHIFT_STATE_KEY, shiftStateId);
            const maxNo = computeMaxJobNoForShift(shiftStr, dateStr);
            if (maxNo === 0) {
                localStorage.setItem(RESET_LOCK_KEY, 'true');
                jobNoEl.value = '1';
            } else {
                localStorage.removeItem(RESET_LOCK_KEY);
                jobNoEl.value = String(maxNo + 1);
            }
            saveOutageDraft();
            if (!isInitialLoad && lastStateId) showToast(`🔄 เปลี่ยนเป็น กะ ${shiftStr} (เริ่มงานที่ ${jobNoEl.value})`);
            return;
        }

        if (!String(dateEl.value || '').trim() || (!isManualShiftOverride && dateEl.value.trim() !== dateStr)) {
            dateEl.value = dateStr;
        }
        if (!String(shiftEl.value || '').trim() || (!isManualShiftOverride && shiftEl.value.trim() !== shiftStr)) {
            shiftEl.value = shiftStr;
        }
        autoFillJobNo(false);
    }

    function setEditingFaultId(val) { editingFaultId = val; if (val) localStorage.setItem('elec_editing_fault_id', val); else localStorage.removeItem('elec_editing_fault_id'); }
    function setEditingOutageId(val) { editingOutageId = val; if (val) localStorage.setItem('elec_editing_outage_id', val); else localStorage.removeItem('elec_editing_outage_id'); }
    function clearStuckEditModes() { setEditingFaultId(null); setEditingOutageId(null); document.getElementById('activeEditBannerTab1')?.remove(); document.getElementById('activeEditBannerTab2')?.remove(); }

    function showActiveEditBanner(tabNum, labelText) {
        const bannerId = 'activeEditBannerTab' + tabNum;
        document.getElementById(bannerId)?.remove();
        const targetForm = document.getElementById('sortable-tab' + tabNum);
        if (!targetForm) return;
        const bar = document.createElement('div');
        bar.id = bannerId;
        bar.className = 'p-2.5 mb-3 bg-amber-50 border-2 border-amber-400 rounded-xl flex items-center justify-between gap-2 text-xs font-bold text-amber-900 shadow-sm';
        bar.innerHTML = `<span class="truncate">📝 กำลังแก้ไขรายการเดิม (${escapeHtmlStr(labelText)})</span><button type="button" onclick="${tabNum === 1 ? 'resetFaultForm()' : 'resetOutageForm()'}" class="shrink-0 bg-amber-600 hover:bg-amber-700 text-white px-2.5 py-1 rounded-lg text-[11px] font-extrabold">❌ ยกเลิกแก้ไข</button>`;
        targetForm.insertAdjacentElement('beforebegin', bar);
    }

    function saveFaultDraft() {
        const fields = ['timeInput', 'systemSelect', 'circuitSelect', 'stationValue', 'causeSelect', 'countSelect', 'tlSelect', 'phaseSelect', 'currA', 'currB', 'currC', 'currG', 'distanceInput', 'zoneInput', 'tambonSelect', 'weatherSelect', 'presentCurrInput', 'deviceInput', 'disconnectDeviceInput', 'powerUpToDeviceInput', 'powerUpTimeInput', 'reporterInput', 'gpsInput'];
        const draft = {};
        fields.forEach(k => { draft[k] = document.getElementById(k)?.value || ''; });
        localStorage.setItem(DRAFT_KEY_TAB1, JSON.stringify(draft));
    }

    function restoreFaultDraft() {
        const saved = Core.rawStorageGet(DRAFT_KEY_TAB1);
        if (!saved) return setTimeInputToNow(false);
        try {
            const d = JSON.parse(saved);
            setTimeInputToNow(false);
            if (!(d.systemSelect || d.circuitSelect || d.stationValue || d.causeSelect || d.deviceInput || d.reporterInput || d.gpsInput)) return;
            if (d.systemSelect) { document.getElementById('systemSelect').value = d.systemSelect; updateCircuitDropdown(); }
            if (d.stationValue) selectStation(d.stationValue);
            ['circuitSelect', 'causeSelect', 'countSelect', 'tlSelect', 'phaseSelect', 'currA', 'currB', 'currC', 'currG', 'distanceInput', 'zoneInput', 'tambonSelect', 'weatherSelect', 'presentCurrInput', 'deviceInput', 'disconnectDeviceInput', 'powerUpToDeviceInput', 'powerUpTimeInput', 'reporterInput', 'gpsInput'].forEach(k => {
                if (d[k] !== undefined && document.getElementById(k)) document.getElementById(k).value = d[k];
            });
            if (d.gpsInput) updateMapPreviewTab1(extractCoordsFromInput(d.gpsInput));
        } catch (e) {}
    }

    function saveOutageDraft() {
        const draft = { _meterMeta: lastPastedCustomerMeta };
        ['reportDate', 'jobNo', 'shift', 'issueType', 'workerName', 'area', 'address', 'phone', 'gps'].forEach(k => { draft[k] = document.getElementById(k)?.value || ''; });
        localStorage.setItem(DRAFT_KEY_TAB2, JSON.stringify(draft));
    }

    function restoreOutageDraft() {
        const saved = Core.rawStorageGet(DRAFT_KEY_TAB2);
        if (!saved) { autoFillJobNo(true); return; }
        try {
            const d = JSON.parse(saved);
            if (![d.issueType, d.workerName, d.area, d.address, d.phone, d.gps].some(v => v && String(v).trim())) {
                localStorage.removeItem(DRAFT_KEY_TAB2);
                autoFillJobNo(true);
                return;
            }
            if (d._meterMeta && typeof d._meterMeta === 'object') {
                lastPastedCustomerMeta = {
                    customerName: d._meterMeta.customerName || '',
                    peaNo: d._meterMeta.peaNo || '',
                    caNo: d._meterMeta.caNo || ''
                };
            }
            const rt = getRealTimeShiftAndDate();
            document.getElementById('reportDate').value = (d.reportDate === rt.dateStr && d.reportDate) ? d.reportDate : rt.dateStr;
            document.getElementById('shift').value = (d.reportDate === rt.dateStr && d.shift) ? d.shift : rt.shiftStr;
            ['issueType', 'workerName', 'area', 'phone', 'gps'].forEach(k => {
                if (d[k] !== undefined && document.getElementById(k)) document.getElementById(k).value = d[k];
            });
            if (d.address !== undefined) {
                const addrEl = document.getElementById('address');
                addrEl.value = d.address;
                setTimeout(() => { addrEl.style.height = 'auto'; addrEl.style.height = addrEl.scrollHeight + 'px'; }, 50);
            }
            if (d.gps) updateMapPreview(extractCoordsFromInput(d.gps));
            autoFillJobNo(true);
        } catch (e) { autoFillJobNo(true); }
    }

    // ========================================================================
    // 9. บันทึก / แก้ไข / ลบ / ส่งค่าเข้าใบมิเตอร์ชำรุดอัตโนมัติ (แท็บ 1 & แท็บ 2)
    // ========================================================================
    function resetFaultForm() {
        setEditingFaultId(null);
        document.getElementById('activeEditBannerTab1')?.remove();
        localStorage.removeItem(DRAFT_KEY_TAB1);
        ['systemSelect', 'stationValue', 'causeSelect', 'countSelect', 'tlSelect', 'phaseSelect', 'currA', 'currB', 'currC', 'currG', 'distanceInput', 'zoneInput', 'tambonSelect', 'presentCurrInput', 'deviceInput', 'disconnectDeviceInput', 'powerUpToDeviceInput', 'powerUpTimeInput', 'reporterInput', 'gpsInput', 'tab1QuickFaultKmInput', 'tab1QuickFaultAmpInput'].forEach(id => {
            const el = document.getElementById(id); if (el) el.value = '';
        });
        const stDisp = document.getElementById('stationTypeDisplay');
        if (stDisp) { stDisp.textContent = '-- กรุณาเลือกสถานี --'; stDisp.classList.add('text-slate-400'); stDisp.classList.remove('text-slate-800'); }
        const wSel = document.getElementById('weatherSelect');
        if (wSel) { wSel.value = ''; wSel.className = 'w-full px-2 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white text-slate-700 text-sm transition-colors truncate'; }
        updateCircuitDropdown();
        setTimeInputToNow(false);
        updateMapPreviewTab1(null);
        if (typeof checkAndRenderFormScadaWarnings === 'function') checkAndRenderFormScadaWarnings();
    }

    function resetOutageForm() {
        setEditingOutageId(null);
        isManualShiftOverride = false;
        isManualJobNoOverride = false;
        lastPastedCustomerMeta = { customerName: '', peaNo: '', caNo: '' };
        document.getElementById('activeEditBannerTab2')?.remove();
        localStorage.removeItem(DRAFT_KEY_TAB2);
        const { shiftStr, dateStr } = getRealTimeShiftAndDate();
        document.getElementById('reportDate').value = dateStr;
        document.getElementById('shift').value = shiftStr;
        ['issueType', 'workerName', 'area', 'address', 'phone', 'gps'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        const addrEl = document.getElementById('address'); if (addrEl) addrEl.style.height = 'auto';
        document.getElementById('caOverdueBanner')?.classList.add('hidden');
        if (typeof clearAutoFillPasteBox === 'function') clearAutoFillPasteBox(false);
                updateMapPreview(null);
        autoFillJobNo(true);
        resetMainAiChatSession();
    }

    function confirmResetFaultForm() { if (guardNotViewer()) showCustomConfirm('ต้องการล้างข้อมูลในฟอร์มรายงานเหตุ (TR/TL) ทั้งหมดใช่หรือไม่?', () => { resetFaultForm(); showToast('🗑️ ล้างข้อมูลเรียบร้อยแล้ว'); }, '🗑️ ยืนยันการล้างข้อมูล'); }
    function confirmResetOutageForm() { if (guardNotViewer()) showCustomConfirm('ต้องการล้างข้อมูลในฟอร์มรับแจ้งทั้งหมดใช่หรือไม่?', () => { resetOutageForm(); showToast('🗑️ ล้างข้อมูลเรียบร้อยแล้ว'); }, '🗑️ ยืนยันการล้างข้อมูล'); }

    function openLineAppWithFallback(text) {
        copyTextToClipboard(text, '✅ บันทึกและคัดลอกข้อความเตรียมส่ง LINE แล้ว!');
        window.open('https://line.me/R/share?text=' + encodeURIComponent(text), '_blank');
    }

    function openMeterFormFromCurrentTab2() {
        const rt = getRealTimeShiftAndDate();
        const reportDate = (document.getElementById('reportDate')?.value || '').trim() || rt.dateStr;
        const shift = (document.getElementById('shift')?.value || '').trim() || rt.shiftStr;
        const jobNo = (document.getElementById('jobNo')?.value || '').trim();
        const issueType = (document.getElementById('issueType')?.value || '').trim();
        const workerName = (document.getElementById('workerName')?.value || '').trim();
        const area = (document.getElementById('area')?.value || '').trim();
        const address = (document.getElementById('address')?.value || '').trim();
        const phone = (document.getElementById('phone')?.value || '').trim();
        const gps = formatGpsInput(document.getElementById('gps')?.value || '');
        const pasteMeta = extractMeterMetaFromText(document.getElementById('rawCustomerPasteInput')?.value || '');
        const addrMeta = extractMeterMetaFromText(address);

        const url = buildMeterFormUrlFromData({
            ownerGroup: normGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง',
            jobNo,
            shift,
            reportDate,
            issueType,
            workerName,
            area,
            address,
            phone,
            gps,
            customerName: pasteMeta.customerName || lastPastedCustomerMeta.customerName || addrMeta.customerName || '',
            peaMeterNo: addrMeta.peaNo || pasteMeta.peaNo || lastPastedCustomerMeta.peaNo || '',
            caNo: addrMeta.caNo || pasteMeta.caNo || lastPastedCustomerMeta.caNo || ''
        });
        window.open(url, '_blank');
    }

            function openMeterFormForOutageItem(dateTimeSaved) {
        const item = JSON.parse(Core.rawStorageGet('elecReportsComplete_all') || '[]').find(h => h.dateTimeSaved === dateTimeSaved);
        if (!item) return;
        window.open(buildShortMeterUrl(dateTimeSaved, getJobGroupName(item), false, item.meterKey || ''), '_blank');
    }

    function saveAndCopyFault(sendToLine = false) {
        if (!guardNotViewer()) return;
        Core.unlockCloudWrite(20000);
        const v = id => (document.getElementById(id)?.value || '').trim();
        const time = v('timeInput') || '-', system = v('systemSelect') || '-', circuit = v('circuitSelect') || '-', station = v('stationValue') || '-';
        const cause = v('causeSelect') || '-', count = v('countSelect') || '1', tlStatus = v('tlSelect'), phase = v('phaseSelect') || '-';
        const currA = v('currA'), currB = v('currB'), currC = v('currC'), currG = v('currG');
        const currentDisplay = [currA && `A=${currA}`, currB && `B=${currB}`, currC && `C=${currC}`, currG && `G=${currG}`].filter(Boolean).join(', ') || '-';
        const distance = v('distanceInput') || '-', zone = v('zoneInput') || '-';
        const tambonVal = v('tambonSelect'), rawW = v('weatherSelect') || '-';
        const weather = (tambonVal && rawW !== '-') ? `${tambonVal} ${rawW}` : (tambonVal || rawW);
        const presentCurr = v('presentCurrInput') || '-', device = v('deviceInput') || '-', disconnectDevice = v('disconnectDeviceInput') || '-';
        const rawPUp = v('powerUpToDeviceInput'), pUpTime = v('powerUpTimeInput');
        saveEquipmentHistory([device, disconnectDevice, rawPUp]);
        const powerUpToDevice = pUpTime ? `${rawPUp || ''} เวลา ${pUpTime}`.trim() : (rawPUp || '-');
        const reporter = v('reporterInput') || '-', gps = formatGpsInput(v('gpsInput'));
        const causeStr = `${cause} ${count} ครั้ง${tlStatus ? ' ' + tlStatus : ''}`;

        const textToCopy = system === '115kV'
            ? `⏰ เวลา : ${time}\n🔌 ระบบ : ${system}\n⚡ วงจร : ${circuit}\n🏭 สถานี : ${station}\n🌤️ สภาพอากาศ : ${weather}\n🚨 เหตุ : ${causeStr}\n🔴 โชว์เฟส : ${phase}\n📍 ระยะทาง : ${distance}\n🎯 โซน : ${zone}\n📞 สาเหตุ/เบื้องต้นมีรับแจ้งจาก : ${reporter}\n📍 พิกัด GPS : ${gps}`
            : `⏰ เวลา : ${time}\n🔌 ระบบ : ${system}\n⚡ วงจร : ${circuit}\n🏭 สถานี : ${station}\n🌤️ สภาพอากาศ : ${weather}\n🚨 เหตุ : ${causeStr}\n🔴 โชว์เฟส : ${phase}\n💥 กระแส : ${currentDisplay}\n🔄 ปัจจุบันกระแส : ${presentCurr}\n📟 อุปกรณ์เห็นฟอลต์ : ${device}\n🔌 ปัจจุบันปลดอุปกรณ์ : ${disconnectDevice}\n⚡ จ่ายไฟมาชนอุปกรณ์ : ${powerUpToDevice}\n📞 สาเหตุ/เบื้องต้นมีรับแจ้งจาก : ${reporter}\n📍 พิกัด GPS : ${gps}`;

        const history = JSON.parse(Core.rawStorageGet('fault_reports_all') || '[]');
        const curUser = (Core.rawStorageGet('elec_app_current_user') || '').trim();
        const curGroup = normGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
        const isEditing = Boolean(editingFaultId);
        const nowIso = new Date().toISOString();
        const baseFields = { time, system, circuit, station, cause, count, tlStatus, phase, currA, currB, currC, currG, distance, zone, weather, presentCurr, device, disconnectDevice, powerUpToDevice, reporter, gps };

        if (editingFaultId) {
            const idx = history.findIndex(h => h.timestamp === editingFaultId);
            if (idx !== -1) {
                const techBlk = (history[idx].formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[1];
                history[idx] = { ...history[idx], ...baseFields, ownerGroup: normGrp(getJobGroupName(history[idx]) || curGroup), formattedText: techBlk ? `${textToCopy}\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---${techBlk}` : textToCopy, editedAt: nowIso, pendingInitialUpload: true };
            }
            setEditingFaultId(null);
        } else {
            const newRec = { ...baseFields, formattedText: textToCopy, timestamp: nowIso, createdAtMs: Date.now(), ownerUser: curUser, ownerGroup: curGroup, pendingInitialUpload: true };
            newRec.recommendedTech = findNearestTechForMainPage(newRec);
            history.unshift(newRec);
        }

        localStorage.setItem('fault_reports_all', JSON.stringify(history));
        if (sendToLine) openLineAppWithFallback(textToCopy);
        else copyTextToClipboard(textToCopy, isEditing ? '✅ อัปเดตทับรายการเดิมและคัดลอกสำเร็จ!' : 'คัดลอกข้อความและบันทึกสำเร็จ!');
        if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot();
        loadFaultHistory();
        resetFaultForm();
        syncJobsWithFieldPage();
    }

    function generateOutageMessage(sendToLine = false) {
        if (!guardNotViewer()) return;
        const rt = getRealTimeShiftAndDate();
        const dateEl = document.getElementById('reportDate'), shiftEl = document.getElementById('shift'), jobNoEl = document.getElementById('jobNo');
        if (dateEl && !String(dateEl.value || '').trim()) dateEl.value = rt.dateStr;
        if (shiftEl && !String(shiftEl.value || '').trim()) shiftEl.value = rt.shiftStr;

        const reportDate = (dateEl?.value || '').trim() || rt.dateStr;
        const shift = (shiftEl?.value || '').trim() || rt.shiftStr;
        let jobNo = (jobNoEl?.value || '').trim();

        const allExistingOutages = JSON.parse(Core.rawStorageGet('elecReportsComplete_all') || '[]');
        const editingExistingItem = editingOutageId ? allExistingOutages.find(h => h.dateTimeSaved === editingOutageId) : null;

        if (!editingOutageId) {
            const maxExisting = computeMaxJobNoForShift(shift, reportDate);
            const parsedNo = parseInt(jobNo, 10);
            if (!jobNo || isNaN(parsedNo) || (!isManualJobNoOverride && parsedNo <= maxExisting)) {
                jobNo = String(maxExisting + 1);
                if (jobNoEl) jobNoEl.value = jobNo;
            }
        } else if (!jobNo) {
            jobNo = '-';
        }

        const v = id => (document.getElementById(id)?.value || '').trim() || '-';
        const issueType = v('issueType'), workerName = v('workerName'), area = v('area'), address = v('address'), phone = v('phone');
        const gps = formatGpsInput(document.getElementById('gps')?.value || '');
        const pInfo = getIssuePriority(issueType);
        const nowTimeStr = new Date().toLocaleTimeString('th-TH', { hour12: false });
        const existingKeys = new Set(allExistingOutages.map(x => x?.dateTimeSaved));
        let dateTimeSaved = `${reportDate} ${nowTimeStr}`;
        if (existingKeys.has(dateTimeSaved)) dateTimeSaved += `.${Date.now() % 1000}`;
        const finalJobKey = editingOutageId || dateTimeSaved;
        const ownerGrp = normGrp(editingExistingItem?.ownerGroup || getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
        const jobMeterKey = editingExistingItem?.meterKey || generateRandomMeterKey();

        const pasteMeta = extractMeterMetaFromText(document.getElementById('rawCustomerPasteInput')?.value || '');
        const addrMeta = extractMeterMetaFromText(address);
        const metaCustName = pasteMeta.customerName || lastPastedCustomerMeta.customerName || addrMeta.customerName || editingExistingItem?.customerName || '';
        const metaPeaNo = addrMeta.peaNo || pasteMeta.peaNo || lastPastedCustomerMeta.peaNo || editingExistingItem?.peaMeterNo || '';
        const metaCaNo = addrMeta.caNo || pasteMeta.caNo || lastPastedCustomerMeta.caNo || editingExistingItem?.caNo || '';

        let message = `${pInfo.emoji} งานที่${jobNo} กะ${shift}  รับแจ้งไฟฟ้าขัดข้อง วันที่${reportDate}\n🛠️***อย่าลืมทำ*** We safe \n⚡ลักษณะอาการ :  ${issueType}\n👷ผู้ปฏิบัติงาน ${workerName}\n🗺️ บริเวณ :  ${area}\n\n🏠ที่อยู่ : ${address}\n📞เบอร์โทร : ${phone}\n\n📌พิกัด  : ${gps}`;
        const normIssue = issueType.toLowerCase().replace(/\s+/g, '');
        if (normIssue.includes('มิเตอร์') && !['ต่อสายมิเตอร์', 'ต่อมิเตอร์', 'ต่อกลับมิเตอร์', 'ติดมิเตอร์', 'ใส่มิเตอร์'].some(kw => normIssue.includes(kw))) {
            const shortMeterUrl = buildShortMeterUrl(finalJobKey, ownerGrp, true, jobMeterKey);
            message += `\n\n📄***ใบแจ้งสับเปลี่ยนมิเตอร์ชำรุดมิเตอร์***   \n${shortMeterUrl}`;
        }

        const isEditing = Boolean(editingOutageId);
        saveOutageData(finalJobKey, reportDate, jobNo, shift, issueType, workerName, area, address, phone, gps, message, pInfo.level, {
            customerName: metaCustName,
            peaMeterNo: metaPeaNo,
            caNo: metaCaNo,
            meterKey: jobMeterKey
        });
        if (sendToLine) openLineAppWithFallback(message);
        else copyTextToClipboard(message, isEditing ? '✅ อัปเดตทับรายการเดิมและคัดลอกสำเร็จ!' : `บันทึกงานที่ ${jobNo} (กะ ${shift}) และคัดลอกสำเร็จ!`);
        resetOutageForm();
    }

    function saveOutageData(dateTimeSaved, reportDate, jobNo, shift, issueType, workerName, area, address, phone, gps, formattedText, priorityLevel, extraMeterMeta = {}) {
        if (!guardNotViewer()) return;
        Core.unlockCloudWrite(20000);
        saveWorkerHistory([workerName]);
        saveAreaHistory([area]);
        autoAddIssueType(issueType);

        const meterFields = {};
        if (extraMeterMeta?.customerName) meterFields.customerName = extraMeterMeta.customerName;
        if (extraMeterMeta?.peaMeterNo) meterFields.peaMeterNo = extraMeterMeta.peaMeterNo;
        if (extraMeterMeta?.caNo) meterFields.caNo = extraMeterMeta.caNo;
        if (extraMeterMeta?.meterKey) meterFields.meterKey = extraMeterMeta.meterKey;


        const history = JSON.parse(Core.rawStorageGet('elecReportsComplete_all') || '[]');
        const curUser = (Core.rawStorageGet('elec_app_current_user') || '').trim();
        const curGroup = normGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
        let savedRecordForQuickPush = null;

        if (editingOutageId) {
            const idx = history.findIndex(h => h.dateTimeSaved === editingOutageId);
            if (idx !== -1) {
                const techBlk = (history[idx].formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[1];
                history[idx] = {
                    ...history[idx],
                    reportDate, jobNo, shift, issueType, workerName, area, address, phone, gps,
                    ...meterFields,
                    ownerGroup: normGrp(getJobGroupName(history[idx]) || curGroup),
                    formattedText: techBlk ? `${formattedText}\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---${techBlk}` : formattedText,
                    priorityLevel,
                    editedAt: new Date().toISOString(),
                    pendingInitialUpload: true
                };
                savedRecordForQuickPush = history[idx];
            }
            setEditingOutageId(null);
        } else {
            localStorage.removeItem(RESET_LOCK_KEY);
            isManualShiftOverride = false;
            isManualJobNoOverride = false;
            const newRec = {
                dateTimeSaved, reportDate, jobNo, shift, issueType, workerName, area, address, phone, gps,
                ...meterFields,
                formattedText, priorityLevel, createdAtMs: Date.now(), ownerUser: curUser, ownerGroup: curGroup, pendingInitialUpload: true
            };
            newRec.recommendedTech = findNearestTechForMainPage(newRec);
            history.unshift(newRec);
            savedRecordForQuickPush = newRec;
        }

        localStorage.setItem('elecReportsComplete_all', JSON.stringify(history));
        if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot();
        loadOutageHistory();
        autoFillJobNo(true);

                // ยิงข้อมูลใบงานด่วนแบบ keepalive ขึ้นคลาวด์ทันทีโดยไม่ยิง syncJobsWithFieldPage ซ้อนชนคิว Lock
        if (savedRecordForQuickPush && navigator.onLine) {
            const apiUrl = getActiveCloudApiUrl();
            if (apiUrl) {
                const cleanJob = { ...savedRecordForQuickPush, jobType: 'outage' };
                delete cleanJob.pendingInitialUpload;
                const quickBodyStr = JSON.stringify({
                    action: 'patchDelta',
                    group: cleanJob.ownerGroup || curGroup,
                    forceSheetWrite: true,
                    upsertedJobs: [cleanJob],
                    removedJobKeys: []
                });
                if (new Blob([quickBodyStr]).size < 55000) {
                    fetch(apiUrl, {
                        method: 'POST',
                        keepalive: true,
                        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                        body: quickBodyStr
                    }).then(r => r.json()).then(resData => {
                        if (resData?.status === 'ok' && resData?.patched !== false && !resData?.skippedBusyRam) {
                            const curList = JSON.parse(Core.rawStorageGet('elecReportsComplete_all') || '[]');
                            let cleared = false;
                                                        curList.forEach(it => {
                                if (it && it.dateTimeSaved === cleanJob.dateTimeSaved && it.pendingInitialUpload && (it.editedAt || '') === (cleanJob.editedAt || '')) {
                                    delete it.pendingInitialUpload;
                                    cleared = true;
                                }
                            });
                            if (cleared) Core.rawStorageSet('elecReportsComplete_all', JSON.stringify(curList));
                            Core.invalidateSheetCaches?.();
                        } else {
                            syncJobsWithFieldPage();
                        }
                    }).catch(() => {
                        syncJobsWithFieldPage();
                    });
                    return;
                }
            }
        }
        syncJobsWithFieldPage();
    }
    function highlightMatch(text, query) {
        const safe = escapeHtmlStr(text || '');
        if (!query) return safe;
        return safe.replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark class="search-highlight">$1</mark>');
    }

    function parseOutageDateTimeToMs(item) {
        if (!item) return 0;
        if (item.createdAtMs) return Number(item.createdAtMs);
        if (!item.dateTimeSaved) return 0;
        const parts = String(item.dateTimeSaved).trim().split(/\s+/);
        const dp = (parts[0] || '').split('/');
        if (dp.length !== 3) return 0;
        let yr = parseInt(dp[2], 10) || 2569; if (yr > 2400) yr -= 543;
        const tp = (parts[1] || '00:00:00').split(/[:.]/);
        return new Date(yr, (parseInt(dp[1], 10) || 1) - 1, parseInt(dp[0], 10) || 1, parseInt(tp[0], 10) || 0, parseInt(tp[1], 10) || 0, parseInt(tp[2], 10) || 0).getTime() || 0;
    }

    function extractMainHistoryPhotos(item, jobKey) {
        const closedReg = getClosedJobsRegistry();
        const tr = item?.techReport || (jobKey ? closedReg[jobKey] : null);
        if (Array.isArray(tr?.photos) && tr.photos.length) return tr.photos.filter(p => p && (p.viewUrl || p.thumbUrl));
        if (Array.isArray(tr?.photoUrls) && tr.photoUrls.length) {
            return tr.photoUrls.filter(Boolean).map(u => {
                const m = String(u).match(/\/d\/([A-Za-z0-9_-]{15,})|[?&]id=([A-Za-z0-9_-]{15,})/);
                const id = m ? (m[1] || m[2]) : '';
                return { id, viewUrl: u, thumbUrl: id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1000` : u, directUrl: id ? `https://lh3.googleusercontent.com/d/${id}=w1000` : '' };
            });
        }
        return [];
    }

    function openMainPhotoLightbox(imgSrc, driveUrl = '') {
        if (!imgSrc && !driveUrl) return;
        let m = document.getElementById('peaMainPhotoLightbox');
        if (!m) {
            m = document.createElement('div'); m.id = 'peaMainPhotoLightbox';
            m.className = 'fixed inset-0 z-[1490] hidden bg-slate-950/90 backdrop-blur-sm flex flex-col items-center justify-center p-3';
            m.onclick = e => { if (e.target === m) m.classList.add('hidden'); };
            document.body.appendChild(m);
        }
        const drvBtn = driveUrl ? `<a href="${escapeHtmlStr(driveUrl)}" target="_blank" rel="noopener noreferrer" class="bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-2 rounded-xl text-xs font-extrabold shadow">🔗 เปิดไฟล์เต็มใน Google Drive ↗</a>` : '';
        m.innerHTML = `<div class="max-w-3xl w-full flex flex-col items-center gap-3"><img src="${escapeHtmlStr(imgSrc || driveUrl)}" class="max-h-[78dvh] w-auto max-w-full rounded-2xl shadow-2xl border border-white/20 object-contain bg-slate-900"><div class="flex items-center gap-2">${drvBtn}<button type="button" onclick="document.getElementById('peaMainPhotoLightbox').classList.add('hidden')" class="bg-rose-600 hover:bg-rose-700 text-white px-4 py-2 rounded-xl text-xs font-extrabold shadow">✕ ปิดรูปภาพ</button></div></div>`;
        m.classList.remove('hidden');
    }
    window.openMainPhotoLightbox = openMainPhotoLightbox;

    function buildMainHistoryPhotoStripHtml(item, jobKey) {
        const photos = extractMainHistoryPhotos(item, jobKey);
        if (!photos.length) return '';
        const thumbs = photos.map((p, idx) => {
            const src = p.thumbUrl || p.directUrl || p.viewUrl;
            const alt = escJsAttr(p.directUrl || '');
            return `<button type="button" onclick="openMainPhotoLightbox('${escJsAttr(src)}','${escJsAttr(p.viewUrl || '')}')" class="relative w-14 h-14 rounded-lg overflow-hidden border border-teal-300 shadow-sm shrink-0 bg-slate-900 hover:opacity-90 transition"><img src="${escapeHtmlStr(src)}" onerror="if(!this.dataset.fb&&'${alt}'){this.dataset.fb='1';this.src='${alt}';}" class="w-full h-full object-cover"><span class="absolute bottom-0 right-0 bg-slate-900/80 text-white text-[9px] font-bold px-1 rounded-tl">#${idx + 1}</span></button>`;
        }).join('');
        return `<div class="p-2 bg-teal-50/70 border border-teal-200 rounded-lg space-y-1"><div class="text-[10px] font-bold text-teal-800">📷 ภาพถ่ายหน้างาน (${photos.length} รูป):</div><div class="flex items-center gap-1.5 overflow-x-auto">${thumbs}</div></div>`;
    }

    function loadOutageHistory() {
        Core.cleanReopenedAndCancelledJobsInStorage();
        tagUntaggedLocalJobsWithCurrentGroup();
        const delReg = getDeletedJobsRegistry();
        Core.runWithGroupViewFilter(() => {
            const historyList = document.getElementById('historyListOutage');
            if (!historyList) return;
            const searchQ = (document.getElementById('searchOutageInput')?.value || '').toLowerCase().trim();
            const prioFilter = document.getElementById('filterPrioritySelect')?.value || 'all';
            const selDate = document.getElementById('exportDateTab2')?.value || '';
            const allHistory = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]')
                .filter(it => it && !(it.dateTimeSaved && delReg[it.dateTimeSaved]))
                .sort((a, b) => parseOutageDateTimeToMs(b) - parseOutageDateTimeToMs(a));
            const { dateStr: cycleDateStr, calendarDateStr } = getRealTimeShiftAndDate();
            let history = [...allHistory];
            if (selDate) {
    const [y, m, d] = selDate.split('-');
    const targetTh = `${d}/${m}/${parseInt(y, 10) + 543}`;
    history = history.filter(it => normalizeThaiDateMain(it.dateTimeSaved || it.reportDate) === targetTh);
}
            if (prioFilter !== 'all') history = history.filter(it => (it.priorityLevel || getIssuePriority(it.issueType).level) === prioFilter);
            if (searchQ) history = history.filter(it => JSON.stringify(it).toLowerCase().includes(searchQ));

            document.getElementById('statOutageTotal').textContent = String(allHistory.length);
            document.getElementById('statOutageToday').textContent = String(allHistory.filter(i => i.reportDate === cycleDateStr || i.reportDate === calendarDateStr).length);
            document.getElementById('statOutageFiltered').textContent = String(history.length);

            if (!history.length) { historyList.innerHTML = '<p class="text-sm text-slate-500 text-center py-4">ไม่พบประวัติการรับแจ้งที่ค้นหา</p>'; return; }
            historyList.innerHTML = '';
            history.forEach(item => {
                const pLevel = item.priorityLevel || getIssuePriority(item.issueType).level;
                const emoji = pLevel === 'critical' ? '🔴' : (pLevel === 'urgent' ? '🟡' : '🟢');
                const brd = pLevel === 'critical' ? 'border-l-rose-500' : (pLevel === 'urgent' ? 'border-l-amber-500' : 'border-l-emerald-500');
                const safeKey = escJsAttr(item.dateTimeSaved || '');
                const photoHtml = buildMainHistoryPhotoStripHtml(item, item.dateTimeSaved);
                const div = document.createElement('div');
                div.className = `bg-white p-3 rounded-xl border border-slate-200 shadow-sm text-xs space-y-1.5 overflow-hidden max-w-full border-l-4 ${brd}`;
                div.innerHTML = `<div class="flex justify-between items-start gap-2 font-bold text-slate-700"><span class="min-w-0 break-words">${emoji} งานที่ ${escapeHtmlStr(item.jobNo)} (กะ ${escapeHtmlStr(item.shift)}) - ${escapeHtmlStr(item.issueType)}</span><span class="text-slate-400 shrink-0 whitespace-nowrap">📅 ${escapeHtmlStr(item.reportDate)}</span></div><div class="text-slate-600 whitespace-pre-line break-all sm:break-words [overflow-wrap:anywhere] font-mono bg-slate-50 p-2.5 rounded-lg overflow-x-hidden max-w-full">${highlightMatch(item.formattedText, searchQ)}</div>${photoHtml}<div class="flex flex-wrap justify-between items-center pt-1.5 gap-1.5"><span class="text-[10px] text-slate-400 truncate">บันทึกเมื่อ: ${escapeHtmlStr(item.dateTimeSaved)}</span><div class="flex flex-wrap gap-1 shrink-0 ml-auto"><button type="button" onclick="openMeterFormForOutageItem('${safeKey}')" class="bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 px-2 py-1 rounded font-semibold" title="เปิดใบรายงานมิเตอร์ชำรุดพร้อมกรอกข้อมูลอัตโนมัติ">📄 ใบมิเตอร์</button><button type="button" onclick="editOutageItem('${safeKey}')" class="bg-amber-50 hover:bg-amber-100 text-amber-600 px-2 py-1 rounded font-medium">📝 แก้ไข</button><button type="button" onclick="copyOutageAgain('${safeKey}')" class="bg-emerald-50 hover:bg-emerald-100 text-emerald-600 px-2 py-1 rounded font-medium">📋 คัดลอก</button><button type="button" onclick="deleteOutageItem('${safeKey}')" class="bg-rose-50 hover:bg-rose-100 text-rose-600 px-2 py-1 rounded font-medium">🗑️ ลบ</button></div></div>`;
                historyList.appendChild(div);
            });
        }, null, []);
        if (typeof renderNavEtaBadgesInMainHistory === 'function') renderNavEtaBadgesInMainHistory();
    }

    function editOutageItem(dateTimeSaved) {
        if (!guardNotViewer()) return;
        const item = JSON.parse(Core.rawStorageGet('elecReportsComplete_all') || '[]').find(h => h.dateTimeSaved === dateTimeSaved);
        if (!item) return;
        setEditingOutageId(dateTimeSaved);
        const cl = v => (v && v !== '-') ? v : '';
        lastPastedCustomerMeta = {
            customerName: cl(item.customerName),
            peaNo: cl(item.peaMeterNo),
            caNo: cl(item.caNo)
        };
        ['reportDate', 'jobNo', 'shift', 'issueType', 'workerName', 'area', 'phone', 'gps'].forEach(k => { if (document.getElementById(k)) document.getElementById(k).value = cl(item[k]); });
        const addrEl = document.getElementById('address');
        addrEl.value = cl(item.address); addrEl.style.height = 'auto'; addrEl.style.height = addrEl.scrollHeight + 'px';
        updateMapPreview(extractCoordsFromInput(cl(item.gps)));
        saveOutageDraft();
        showActiveEditBanner(2, 'งานที่ ' + (item.jobNo || '-'));
        document.getElementById('sortable-tab2')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        showToast('📝 โหมดแก้ไข: เมื่อบันทึกจะทับลงในรายการเดิมทันที');
    }
    function copyOutageAgain(dt) { const it = JSON.parse(Core.rawStorageGet('elecReportsComplete_all') || '[]').find(h => h.dateTimeSaved === dt); if (it) copyTextToClipboard(it.formattedText, 'คัดลอกข้อความสำเร็จ!'); }
    function deleteOutageItem(dt) {
        if (!guardNotViewer()) return;
        showCustomConfirm('คุณต้องการลบรายการประวัตินี้ใช่หรือไม่?', () => {
            if (editingOutageId === dt) setEditingOutageId(null);
            recordDeletedJobToRegistry(dt);
            const list = JSON.parse(Core.rawStorageGet('elecReportsComplete_all') || '[]').filter(h => h.dateTimeSaved !== dt);
            localStorage.setItem('elecReportsComplete_all', JSON.stringify(list));
            loadOutageHistory(); autoFillJobNo(true); showToast('🗑️ ลบรายการประวัติเรียบร้อยแล้ว');
            setTimeout(syncJobsWithFieldPage, 200);
        }, '🗑️ ยืนยันการลบประวัติ');
    }

        function loadFaultHistory() {
        Core.cleanReopenedAndCancelledJobsInStorage();
        tagUntaggedLocalJobsWithCurrentGroup();
        const delReg = getDeletedJobsRegistry();
        Core.runWithGroupViewFilter(() => {
            const historyList = document.getElementById('historyListFault');
            if (!historyList) return;
            const searchQ = (document.getElementById('searchFaultInput')?.value || '').toLowerCase().trim();
            const selDate = document.getElementById('exportDateTab1')?.value || '';
            const allHistory = JSON.parse(localStorage.getItem('fault_reports_all') || '[]')
                .filter(it => it && !(it.timestamp && delReg[it.timestamp]))
                .sort((a, b) => parseMainDateMs(b.timestamp) - parseMainDateMs(a.timestamp));
            document.getElementById('statFaultTotal').textContent = String(allHistory.length);
            document.getElementById('statFault22kV').textContent = String(allHistory.filter(i => i.system === '22kV').length);
            document.getElementById('statFault115kV').textContent = String(allHistory.filter(i => i.system === '115kV').length);
            
            let history = [...allHistory];
            if (selDate) history = history.filter(it => {
                const ms = parseMainDateMs(it.timestamp);
                if (!ms) return false;
                const d = new Date(ms);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === selDate;
            });
            if (searchQ) history = history.filter(it => JSON.stringify(it).toLowerCase().includes(searchQ));
            
            if (!history.length) { historyList.innerHTML = '<p class="text-sm text-slate-500 text-center py-4">ไม่พบประวัติการบันทึกที่ค้นหา</p>'; return; }
            historyList.innerHTML = '';
            history.forEach(item => {
                const safeKey = escJsAttr(item.timestamp || '');
                const photoHtml = buildMainHistoryPhotoStripHtml(item, item.timestamp);
                const tsMs = parseMainDateMs(item.timestamp);
                const tsLabel = tsMs > 0 ? new Date(tsMs).toLocaleString('th-TH') : String(item.timestamp || '-');
                const div = document.createElement('div');
                div.className = 'bg-white p-3 rounded-xl border border-slate-200 shadow-sm text-xs space-y-1.5 overflow-hidden max-w-full';
                div.innerHTML = `<div class="flex justify-between items-start gap-2 font-bold text-slate-700"><span class="min-w-0 break-words">⚡ ${escapeHtmlStr(item.circuit)} - 🏭 ${escapeHtmlStr(item.station)} (${escapeHtmlStr(item.system)})</span><span class="text-slate-400 shrink-0 whitespace-nowrap">⏰ ${escapeHtmlStr(item.time)}</span></div><div class="text-slate-600 whitespace-pre-line break-all sm:break-words [overflow-wrap:anywhere] font-mono bg-slate-50 p-2.5 rounded-lg overflow-x-hidden max-w-full">${highlightMatch(item.formattedText, searchQ)}</div>${photoHtml}<div class="flex flex-wrap justify-between items-center pt-1.5 gap-1.5"><span class="text-[10px] text-slate-400 truncate">${escapeHtmlStr(tsLabel)}</span><div class="flex gap-1 shrink-0 ml-auto"><button type="button" onclick="editFaultItem('${safeKey}')" class="bg-amber-50 hover:bg-amber-100 text-amber-600 px-2 py-1 rounded font-medium">📝 แก้ไข</button><button type="button" onclick="copyFaultAgain('${safeKey}')" class="bg-blue-50 hover:bg-blue-100 text-blue-600 px-2 py-1 rounded font-medium">📋 คัดลอก</button><button type="button" onclick="deleteFaultItem('${safeKey}')" class="bg-rose-50 hover:bg-rose-100 text-rose-600 px-2 py-1 rounded font-medium">🗑️ ลบ</button></div></div>`;
                historyList.appendChild(div);
            });
        }, null, []);
        if (typeof renderNavEtaBadgesInMainHistory === 'function') renderNavEtaBadgesInMainHistory();
    }
    function editFaultItem(ts) {
        if (!guardNotViewer()) return;
        const item = JSON.parse(Core.rawStorageGet('fault_reports_all') || '[]').find(h => h.timestamp === ts);
        if (!item) return;
        setEditingFaultId(ts);
        const cl = v => (v && v !== '-') ? v : '';
        document.getElementById('timeInput').value = cl(item.time); isTimeManuallyEdited = true;
        document.getElementById('systemSelect').value = cl(item.system); updateCircuitDropdown();
        document.getElementById('circuitSelect').value = cl(item.circuit);
        if (cl(item.station)) selectStation(cl(item.station));
        ['causeSelect', 'countSelect', 'phaseSelect', 'currA', 'currB', 'currC', 'currG', 'distanceInput', 'zoneInput', 'presentCurrInput', 'deviceInput', 'disconnectDeviceInput', 'reporterInput', 'gpsInput'].forEach(id => {
            const mapK = { causeSelect: 'cause', countSelect: 'count', phaseSelect: 'phase', distanceInput: 'distance', zoneInput: 'zone', presentCurrInput: 'presentCurr', deviceInput: 'device', disconnectDeviceInput: 'disconnectDevice', reporterInput: 'reporter', gpsInput: 'gps' }[id] || id;
            if (document.getElementById(id)) document.getElementById(id).value = cl(item[mapK]);
        });
        document.getElementById('tlSelect').value = item.tlStatus || '';
        let tb = '', w = cl(item.weather);
        Object.keys(targetTambonCoordinates).forEach(t => { if (w.startsWith(t)) { tb = t; w = w.replace(t, '').trim(); } });
        document.getElementById('tambonSelect').value = tb; document.getElementById('weatherSelect').value = w;
        if (w) { isWeatherLockedByUser = true; applyWeatherSelectColor(w); }
        const rawP = cl(item.powerUpToDevice), sp = rawP.split(' เวลา ');
        document.getElementById('powerUpToDeviceInput').value = sp[0] || '';
        document.getElementById('powerUpTimeInput').value = sp.slice(1).join(' เวลา ') || '';
        updateMapPreviewTab1(extractCoordsFromInput(cl(item.gps)));
        saveFaultDraft();
        showActiveEditBanner(1, item.circuit || 'TR/TL');
        document.getElementById('sortable-tab1')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        showToast('📝 โหมดแก้ไข: เมื่อบันทึกจะทับลงในรายการเดิมทันที');
    }
    function copyFaultAgain(ts) { const it = JSON.parse(Core.rawStorageGet('fault_reports_all') || '[]').find(h => h.timestamp === ts); if (it) copyTextToClipboard(it.formattedText, 'คัดลอกข้อความสำเร็จ!'); }
    function deleteFaultItem(ts) {
        if (!guardNotViewer()) return;
        showCustomConfirm('คุณต้องการลบรายการนี้ใช่หรือไม่?', () => {
            if (editingFaultId === ts) setEditingFaultId(null);
            recordDeletedJobToRegistry(ts);
            const list = JSON.parse(Core.rawStorageGet('fault_reports_all') || '[]').filter(h => h.timestamp !== ts);
            localStorage.setItem('fault_reports_all', JSON.stringify(list));
            loadFaultHistory(); showToast('🗑️ ลบรายการเรียบร้อยแล้ว');
            setTimeout(syncJobsWithFieldPage, 200);
        }, '🗑️ ยืนยันการลบประวัติ');
    }

    async function quickCloseJobFromMainHistory(jobKey, jobType) {
        if (!guardNotViewer()) return;
        Core.unlockCloudWrite(20000);
        const sk = jobType === 'fault' ? 'fault_reports_all' : 'elecReportsComplete_all', kf = jobType === 'fault' ? 'timestamp' : 'dateTimeSaved';
        const list = JSON.parse(Core.rawStorageGet(sk) || '[]'), idx = list.findIndex(i => i[kf] === jobKey);
        if (idx === -1) return;
        const item = list[idx], now = new Date(), finStr = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')} น.`;
        const prevMaxMs = Math.max(
            item.techReport?.updatedAt ? (new Date(item.techReport.updatedAt).getTime() || 0) : 0,
            item.techNav?.updatedAt ? (new Date(item.techNav.updatedAt).getTime() || 0) : 0,
            item.reopenedAt ? (new Date(item.reopenedAt).getTime() || 0) : 0
        );
        const safeIso = new Date(Math.max(now.getTime(), prevMaxMs > 0 ? prevMaxMs + 1000 : 0)).toISOString();
        const insp = formatTechDisplayName(Core.rawStorageGet('elec_app_current_user') || 'ผู้ใช้งานทั่วไป');
        const rep = {
            status: 'แก้ไขเสร็จสิ้น (จ่ายไฟคืนแล้ว)',
            realCause: item.techReport?.realCause || 'ตรวจสอบแล้วเหตุการณ์ปกติ',
            actionTaken: item.techReport?.actionTaken || 'ปิดงานเรียบร้อย',
            fieldGps: item.techReport?.fieldGps || item.gps || '',
            finishTime: finStr,
            inspector: insp,
            ...(item.techReport?.photos ? { photos: item.techReport.photos } : {}),
            ...(item.techReport?.photoUrls ? { photoUrls: item.techReport.photoUrls } : {}),
            updatedAt: safeIso,
            needsMainSync: true
        };
        const hdr = jobType === 'outage' ? `📋 งานที่ ${item.jobNo || '-'} กะ ${item.shift || '-'}` : `📋 วงจร ${item.circuit || '-'} สถานี${item.station || '-'} (${item.system || '-'})`;
        item.formattedText = `${(item.formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0]}\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---\n${hdr}\n🚦 สถานะ : ${rep.status}\n🔍 สาเหตุจริง : ${rep.realCause}\n🛠️ การแก้ไข : ${rep.actionTaken}\n⏰ เวลาเสร็จ : ${finStr}\n👷 ผู้ตรวจสอบ : ${insp}`;
        item.techReport = rep;
        item.navCancelledAt = safeIso;
        item.pendingInitialUpload = true;
        delete item.techNav;
        delete item.reopenedAt;
        try {
            const cNavMap = JSON.parse(Core.rawStorageGet('elec_cancelled_job_nav_map') || '{}');
            cNavMap[jobKey] = safeIso;
            localStorage.setItem('elec_cancelled_job_nav_map', JSON.stringify(cNavMap));
        } catch (e) {}
        localStorage.setItem(sk, JSON.stringify(list));
        saveClosedJobToRegistry(jobKey, rep);
        if (jobType === 'fault') loadFaultHistory(); else loadOutageHistory();
        showToast('✅ ปิดงานเรียบร้อยแล้ว (ซิงค์แจ้งหน้าช่างอัตโนมัติ)');
        await syncJobsWithFieldPage();
    }

    // ========================================================================
    // 10. คำนวณฟิวส์ 22kV (แท็บ 3), กราฟสถิติ (แท็บ 4) & ส่งออกไฟล์ Excel
    // ========================================================================
    function saveMultiplierSetting(val) { localStorage.setItem('fuse_multiplier', val); if (typeof performAutoBackupSnapshot === 'function') performAutoBackupSnapshot(); }
    function addTxRow() {
        const firstSel = document.querySelector('#transformer-list select.tx-input');
        const div = document.createElement('div'); div.className = 'flex gap-2 items-center';
        div.innerHTML = `<select class="tx-input w-2/3 p-2 border rounded text-sm bg-white focus:outline-none">${firstSel ? firstSel.innerHTML : ''}</select><input type="number" class="tx-qty w-1/4 p-2 border rounded text-sm text-center" min="1" value="1"><button type="button" class="btn-del bg-rose-100 text-rose-600 p-2 rounded text-xs" onclick="this.parentElement.remove()">✕</button>`;
        div.querySelector('select').value = '';
        document.getElementById('transformer-list')?.appendChild(div);
    }

    function calculateFuseCalc() {
        let kva1 = 0, kva3 = 0, mult = parseFloat(document.getElementById('multiplier-input')?.value);
        if (isNaN(mult) || mult < 1) { mult = 1.5; document.getElementById('multiplier-input').value = 1.5; }
        document.querySelectorAll('#transformer-list .flex').forEach(g => {
            const sel = g.querySelector('.tx-input'), kva = parseFloat(sel?.value), qty = Math.max(1, parseInt(g.querySelector('.tx-qty')?.value, 10) || 1);
            if (!isNaN(kva) && kva > 0) { if (kva === 30 || sel.options[sel.selectedIndex]?.parentElement?.label?.includes('1 เฟส')) kva1 += kva * qty; else kva3 += kva * qty; }
        });
        if (kva1 + kva3 === 0) return showCustomAlert('กรุณาเลือกขนาดหม้อแปลงอย่างน้อย 1 ลูก', '🧮 คำนวณขนาดฟิวส์ 22kV');
        const cur1 = kva1 / 22, cur3 = kva3 / (1.73205 * 22), totCur = cur1 + cur3, inrush = totCur * mult;
        const fuse = [2, 3, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 65, 80, 100, 140, 200].find(f => f >= inrush);
        const fmt = n => new Intl.NumberFormat('en-US').format(n);
        document.getElementById('res-kva').innerHTML = `${fmt(kva1 + kva3)} kVA`;
        document.getElementById('res-amp').innerHTML = `${totCur.toFixed(2)} A`;
        document.getElementById('res-inrush-label').innerHTML = `เผื่อกระแส (x${mult}): <span class="font-bold text-slate-800">${inrush.toFixed(2)} A</span>`;
        document.getElementById('res-fuse').innerHTML = `${fuse || 'มากกว่า 200'} <span class="text-sm text-slate-500">A</span>`;
        document.getElementById('result-box-fuse').style.display = 'block';
    }

    function toggleCustomDateFilter() {
        const custom = document.getElementById('dashboardDateFilter')?.value === 'custom';
        const el = document.getElementById('customDateRange');
        if (el) { el.classList.toggle('hidden', !custom); el.classList.toggle('grid', custom); }
    }

    function loadAnalyticsData() {
        tagUntaggedLocalJobsWithCurrentGroup();
        const delReg = getDeletedJobsRegistry();
        Core.runWithGroupViewFilter(() => {
            const faults = JSON.parse(localStorage.getItem('fault_reports_all') || '[]').filter(f => f && !(f.timestamp && delReg[f.timestamp]));
            const outages = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]').filter(o => o && !(o.dateTimeSaved && delReg[o.dateTimeSaved]));
            const dF = document.getElementById('dashboardDateFilter')?.value || 'all', sysF = document.getElementById('dashboardSystemFilter')?.value || 'all', shF = document.getElementById('dashboardShiftFilter')?.value || 'all';
            let sDate = null, eDate = null; const today = new Date(); today.setHours(0, 0, 0, 0);
            if (dF === 'today') { sDate = new Date(today); eDate = new Date(today); eDate.setHours(23, 59, 59, 999); }
            else if (dF === '7days') { sDate = new Date(today); sDate.setDate(today.getDate() - 6); eDate = new Date(today); eDate.setHours(23, 59, 59, 999); }
            else if (dF === 'thisMonth') { sDate = new Date(today.getFullYear(), today.getMonth(), 1); eDate = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999); }
            else if (dF === 'lastMonth') { sDate = new Date(today.getFullYear(), today.getMonth() - 1, 1); eDate = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59, 999); }
            else if (dF === 'custom') { const sv = document.getElementById('dashStartDate')?.value, ev = document.getElementById('dashEndDate')?.value; if (sv) { sDate = new Date(sv); sDate.setHours(0, 0, 0, 0); } if (ev) { eDate = new Date(ev); eDate.setHours(23, 59, 59, 999); } }

            const inRange = ms => (!sDate || ms >= sDate.getTime()) && (!eDate || ms <= eDate.getTime());
            currentFilteredFaults = faults.filter(i => inRange(parseMainDateMs(i.timestamp)) && (sysF === 'all' || i.system === sysF));
            currentFilteredOutages = outages.filter(i => inRange(parseOutageDateTimeToMs(i)) && (shF === 'all' || String(i.shift) === shF));

            document.getElementById('analyticsFaultCount').textContent = `${currentFilteredFaults.length} รายการ`;
            document.getElementById('analyticsOutageCount').textContent = `${currentFilteredOutages.length} รายการ`;

            const counts = {}; currentFilteredOutages.forEach(i => { const k = i.issueType || 'อื่นๆ'; counts[k] = (counts[k] || 0) + 1; });
            const top5 = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
            if (typeof Chart !== 'undefined') {
                const bCtx = document.getElementById('issueBarChart')?.getContext('2d');
                if (bCtx) { if (issueBarChartInstance) issueBarChartInstance.destroy(); issueBarChartInstance = new Chart(bCtx, { type: 'bar', data: { labels: top5.length ? top5.map(x => x[0]) : ['ยังไม่มีข้อมูล'], datasets: [{ label: 'จำนวนครั้ง', data: top5.length ? top5.map(x => x[1]) : [0], backgroundColor: 'rgba(37,99,235,0.8)', borderRadius: 6 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } } }); }
                const c22 = currentFilteredFaults.filter(i => i.system === '22kV').length, c115 = currentFilteredFaults.filter(i => i.system === '115kV').length;
                const dCtx = document.getElementById('systemDoughnutChart')?.getContext('2d');
                if (dCtx) { if (systemDoughnutChartInstance) systemDoughnutChartInstance.destroy(); systemDoughnutChartInstance = new Chart(dCtx, { type: 'doughnut', data: { labels: (c22 || c115) ? ['ระบบ 22kV', 'ระบบ 115kV'] : ['ไม่มีข้อมูล'], datasets: [{ data: (c22 || c115) ? [c22, c115] : [1], backgroundColor: (c22 || c115) ? ['rgba(79,70,229,0.85)', 'rgba(147,51,234,0.85)'] : ['#e2e8f0'] }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } } }); }
            }
        }, null, []);
    }

    async function exportData(type) {
        tagUntaggedLocalJobsWithCurrentGroup();
        const delReg = getDeletedJobsRegistry();
        await Core.runWithGroupViewFilter(async () => {
            const closedReg = getClosedJobsRegistry();
            let headers = [], rows = [], filename = '', sheetName = '';
            if (type === 'fault') {
                const sd = document.getElementById('exportDateTab1')?.value || '';
                let list = JSON.parse(localStorage.getItem('fault_reports_all') || '[]').filter(f => f && !(f.timestamp && delReg[f.timestamp]));
                if (sd) list = list.filter(i => { const d = new Date(parseMainDateMs(i.timestamp)) ; return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === sd; });
                if (!list.length) return showToast('ไม่มีข้อมูลสำหรับวันที่เลือก');
                headers = ['วันที่บันทึก', 'เวลา', 'ระบบ', 'วงจร', 'สถานี', 'สภาพอากาศ', 'เหตุ', 'จำนวนครั้ง', 'T/L', 'โชว์เฟส', 'กระแส A', 'กระแส B', 'กระแส C', 'กระแส G', 'ระยะทาง', 'โซน', 'ปัจจุบันกระแส', 'อุปกรณ์เห็นฟอลต์', 'ปลดอุปกรณ์', 'จ่ายไฟชนอุปกรณ์', 'ผู้แจ้ง', 'พิกัด GPS', 'สถานะหน้างาน', 'สาเหตุจริง', 'การแก้ไข', 'เวลาเสร็จ', 'ช่างผู้ตรวจสอบ', 'รูปถ่ายหน้างาน (Drive)'];
                rows = list.map(i => { const tr = i.techReport || closedReg[i.timestamp]; const pics = extractMainHistoryPhotos(i, i.timestamp).map(p => p.viewUrl).filter(Boolean).join('\n') || '-'; return [(parseMainDateMs(i.timestamp) ? new Date(parseMainDateMs(i.timestamp)).toLocaleDateString('th-TH') : String(i.timestamp || '-')), i.time, i.system, i.circuit, i.station, i.weather, i.cause, i.count, i.tlStatus, i.phase, i.currA, i.currB, i.currC, i.currG, i.distance, i.zone, i.presentCurr, i.device, i.disconnectDevice, i.powerUpToDevice, i.reporter, tr?.fieldGps || i.gps || '-', tr?.status || (i.techNav ? 'กำลังเดินทาง' : 'รอแก้ไข'), tr?.realCause || '-', tr?.actionTaken || '-', tr?.finishTime || '-', formatTechDisplayName(tr?.inspector || '-'), pics].map(c => String(c ?? '')); });
                filename = `Fault_Report_${sd || 'All'}.xlsx`; sheetName = 'รายงานเหตุ_TR_TL';
            } else {
                const sd = document.getElementById('exportDateTab2')?.value || '';
                let list = JSON.parse(localStorage.getItem('elecReportsComplete_all') || '[]').filter(o => o && !(o.dateTimeSaved && delReg[o.dateTimeSaved]));
                if (sd) {
    const [y, m, d] = sd.split('-');
    const targetTh = `${d}/${m}/${parseInt(y, 10) + 543}`;
    list = list.filter(i => normalizeThaiDateMain(i.dateTimeSaved || i.reportDate) === targetTh);
}
                if (!list.length) return showToast('ไม่มีข้อมูลสำหรับวันที่เลือก');
                headers = ['วันที่บันทึก', 'วันที่แจ้ง', 'งานที่', 'กะ', 'ลักษณะอาการ', 'ผู้ปฏิบัติงาน', 'บริเวณ', 'ที่อยู่', 'เบอร์โทรศัพท์', 'พิกัด GPS', 'สถานะหน้างาน', 'สาเหตุจริง', 'การแก้ไข', 'เวลาเสร็จ', 'ช่างผู้ตรวจสอบ', 'รูปถ่ายหน้างาน (Drive)'];
                rows = list.map(i => { const tr = i.techReport || closedReg[i.dateTimeSaved]; const pics = extractMainHistoryPhotos(i, i.dateTimeSaved).map(p => p.viewUrl).filter(Boolean).join('\n') || '-'; return [i.dateTimeSaved?.split(' ')[0] || '', i.reportDate, i.jobNo, i.shift, i.issueType, i.workerName, i.area, i.address, i.phone, tr?.fieldGps || i.gps || '-', tr?.status || (i.techNav ? 'กำลังเดินทาง' : 'รอแก้ไข'), tr?.realCause || '-', tr?.actionTaken || '-', tr?.finishTime || '-', formatTechDisplayName(tr?.inspector || '-'), pics].map(c => String(c ?? '')); });
                filename = `Outage_Report_${sd || 'All'}.xlsx`; sheetName = 'ประวัติรับแจ้ง';
            }
            if ((await ensureXlsxLoaded()) && typeof XLSX !== 'undefined') { const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet([headers, ...rows]); XLSX.utils.book_append_sheet(wb, ws, sheetName); XLSX.writeFile(wb, filename); showToast('📊 ส่งออกไฟล์ Excel (.xlsx) สำเร็จ!'); }
            else Core.downloadCsvFallback(headers, rows, filename);
        }, null, []);
    }
    async function exportAnalyticsToExcel() {
        if (!currentFilteredFaults.length && !currentFilteredOutages.length) return showToast('⚠️ ไม่มีข้อมูลสถิติสำหรับส่งออก');
        const counts = {}; currentFilteredOutages.forEach(i => { const k = i.issueType || 'อื่นๆ'; counts[k] = (counts[k] || 0) + 1; });
        const rows = [['รายงานเหตุ (TR/TL)', String(currentFilteredFaults.length)], ['รับแจ้งไฟฟ้าขัดข้อง', String(currentFilteredOutages.length)], ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)])];
        const fn = `Analytics_Summary_${new Date().toISOString().split('T')[0]}.xlsx`;
        if ((await ensureXlsxLoaded()) && typeof XLSX !== 'undefined') { const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet([['รายการ', 'จำนวน'], ...rows]); XLSX.utils.book_append_sheet(wb, ws, 'สรุปสถิติ'); XLSX.writeFile(wb, fn); showToast('📊 ส่งออกสรุปสถิติสำเร็จ!'); }
        else Core.downloadCsvFallback(['รายการ', 'จำนวน'], rows, fn);
    }
    // ===== จบพาทที่ 2 / 3 ของไฟล์ main-app.js =====
        // ===== เริ่มพาทที่ 3 / 3 ของไฟล์ main-app.js (วางต่อจากพาทที่ 2 จนจบไฟล์) =====
    // ========================================================================
    // 11. ฐานข้อมูล CA ค้างจ่าย (12 หลัก / 02...) & ช่องวางข้อมูลผู้ใช้ไฟตัดคำอัตโนมัติ
    // ========================================================================
    const STRIP_WORDS_KEY = 'elec_paste_strip_words';
    const STRIP_LINE_MODE_KEY = 'elec_paste_strip_whole_line';
    const STRIP_RULES_KEY = 'elec_paste_strip_rules';
    const DEFAULT_STRIP_WORDS = ['ข้อมูลผู้ใช้ไฟฟ้า', 'รายละเอียดผู้แจ้ง'];
    const DEFAULT_STRIP_RULES = { stripCustomerName: true, stripPhoneTextAndNum: false, stripStandaloneNumbers: false, stripAllDigits: false };

    let overdueCaList = [], lastAlertedCaNumber = '', stripWordsList = [], stripRules = { ...DEFAULT_STRIP_RULES };

    function reloadOverdueCaFromStorage() {
        try {
            const raw = localStorage.getItem('overdue_ca_list') || Core.rawStorageGet('overdue_ca_list') || '[]';
            overdueCaList = JSON.parse(raw);
            if (!Array.isArray(overdueCaList)) overdueCaList = [];
        } catch (e) {
            overdueCaList = [];
        }
        syncCaAndStripBadges();
    }

    function initOverdueCaAndStripSettings() {
        reloadOverdueCaFromStorage();
        try { const sw = Core.rawStorageGet(STRIP_WORDS_KEY); stripWordsList = sw ? JSON.parse(sw) : [...DEFAULT_STRIP_WORDS]; } catch (e) { stripWordsList = [...DEFAULT_STRIP_WORDS]; }
        try { const sr = Core.rawStorageGet(STRIP_RULES_KEY); stripRules = sr ? { ...DEFAULT_STRIP_RULES, ...JSON.parse(sr) } : { ...DEFAULT_STRIP_RULES }; } catch (e) { stripRules = { ...DEFAULT_STRIP_RULES }; }
        syncCaAndStripBadges();
    }

    function syncCaAndStripBadges() {
        document.querySelectorAll('#caCountBadge').forEach(el => { el.textContent = String(overdueCaList.length); });
        const sBadge = document.getElementById('stripWordsCountBadge');
        if (sBadge) sBadge.textContent = String(stripWordsList.length + Object.values(stripRules).filter(Boolean).length);
    }

    function openCaManageModal() { if (!guardNotViewer()) return; renderCaModalList(); document.getElementById('caModal')?.classList.remove('hidden'); }
    function closeCaManageModal() { document.getElementById('caModal')?.classList.add('hidden'); }

    function addCaNumber() {
        if (!guardNotViewer()) return;
        const inp = document.getElementById('newCaInput'), matches = String(inp?.value || '').match(/\d{12}/g);
        if (!matches) return showCustomAlert('⚠️ กรุณากรอกตัวเลข 0-9 ให้ครบ 12 หลัก', '💳 รูปแบบเลข CA ไม่ถูกต้อง');
        let added = 0;
        matches.forEach(ca => { if (!overdueCaList.includes(ca)) { overdueCaList.unshift(ca); added++; } });
        if (added > 0) {
            localStorage.setItem('overdue_ca_list', JSON.stringify(overdueCaList));
            syncCaAndStripBadges(); renderCaModalList(); performAutoBackupSnapshot();
            inp.value = ''; checkCaOverdueEnhanced(false);
            showToast(`✅ เพิ่มเลข CA สำเร็จ (${added} หมายเลข)`);
        } else showToast('⚠️ เลข CA นี้อยู่ในฐานข้อมูลแล้ว');
    }

    function deleteCaNumber(ca) {
        if (!guardNotViewer()) return;
        overdueCaList = overdueCaList.filter(x => x !== ca);
        localStorage.setItem('overdue_ca_list', JSON.stringify(overdueCaList));
        syncCaAndStripBadges(); renderCaModalList(); checkCaOverdueEnhanced(false);
        showToast(`🗑️ ลบ CA: ${ca} แล้ว`);
    }

    function clearAllCaNumbers() {
        if (!guardNotViewer()) return;
        showCustomConfirm('คุณต้องการลบฐานข้อมูลเลข CA ทั้งหมดใช่หรือไม่?', () => {
            overdueCaList = []; localStorage.setItem('overdue_ca_list', '[]');
            syncCaAndStripBadges(); renderCaModalList(); checkCaOverdueEnhanced(true);
            showToast('🗑️ ล้างฐานข้อมูล CA ทั้งหมดแล้ว');
        }, '💳 ยืนยันการล้างข้อมูล');
    }

    function renderCaModalList() {
        const container = document.getElementById('caListContainer'), q = (document.getElementById('searchCaInput')?.value || '').trim();
        if (!container) return;
        const list = q ? overdueCaList.filter(c => c.includes(q)) : overdueCaList;
        container.innerHTML = list.length ? list.map(ca => `<div class="flex items-center justify-between bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-sm text-xs"><span class="font-mono font-bold text-slate-700 tracking-wider">💳 ${escapeHtmlStr(ca)}</span><button type="button" onclick="deleteCaNumber('${escapeHtmlStr(ca)}')" class="text-rose-500 hover:bg-rose-50 px-2 py-1 rounded border border-rose-100">🗑️ ลบ</button></div>`).join('') : '<div class="text-center text-slate-400 text-xs py-6">ยังไม่มีหมายเลข CA ในฐานข้อมูล</div>';
    }

    function checkCaOverdueEnhanced(silentAlert = false) {
        const blob = `${document.getElementById('rawCustomerPasteInput')?.value || ''}\n${document.getElementById('address')?.value || ''}`, found = new Set();
        for (const m of blob.matchAll(/CA\s*(?:No\.?)?\s*[:：=]?\s*(\d{12})/gi)) if (m[1]) found.add(m[1]);
        for (const m of blob.matchAll(/(?:^|[^\d])(02\d{10})(?!\d)/g)) if (m[1]) found.add(m[1]);
        const matched = Array.from(found).find(ca => overdueCaList.includes(ca));
        const banner = document.getElementById('caOverdueBanner'), txtEl = document.getElementById('caOverdueText');
        if (matched) {
            if (banner && txtEl) { txtEl.textContent = `🚨 มียอดค่าบริการค้างจ่าย (CA: ${matched})`; banner.classList.remove('hidden'); }
            if (!silentAlert && lastAlertedCaNumber !== matched) { lastAlertedCaNumber = matched; showCustomAlert(`หมายเลข CA : ${matched}\nมียอดค่าบริการค้างจ่ายในระบบ`, '🚨 มียอดค่าบริการค้างจ่าย'); }
        } else { banner?.classList.add('hidden'); lastAlertedCaNumber = ''; }
    }

    function extractAndRemoveGoogleMapLinks(rawStr) {
        if (!rawStr) return { cleanedText: '', extractedUrl: '' };
        let foundUrl = '';
        const pat = /(?:(?:📌|📍)\s*)?(?:(?:Google\s*Maps?|Maps?|แผนที่|พิกัด(?:\s*GPS)?|GPS(?:\s*Link)?)\s*[:：=]?\s*)*(https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.[a-z.]+|(?:www\.)?google\.[a-z.]+\/maps)[^\s"'<>]+)/gi;
        const cleaned = String(rawStr).replace(pat, (_, url) => { if (!foundUrl && url) foundUrl = url.trim(); return ''; }).replace(/(?:📌|📍)?\s*(?:Google\s*Maps?)\s*[:：=]?/gi, '');
        return { cleanedText: cleaned, extractedUrl: foundUrl };
    }

    function processCustomerPasteData(rawText) {
        if (!rawText || !rawText.trim()) return;
        // สกัดเก็บชื่อลูกค้า เลขมิเตอร์ และเลข CA ไว้เบื้องหลังก่อนถูกตัดออกตามกฎตัดคำ
        const preMeta = extractMeterMetaFromText(rawText);
        lastPastedCustomerMeta = {
            customerName: preMeta.customerName || '',
            peaNo: preMeta.peaNo || '',
            caNo: preMeta.caNo || ''
        };

        const wholeLine = Core.rawStorageGet(STRIP_LINE_MODE_KEY) === 'true', mapRes = extractAndRemoveGoogleMapLinks(rawText);
        let text = mapRes.cleanedText, extractedGps = mapRes.extractedUrl;

        text = text.replace(/([:：])\s*\r?\n+\s*(?![^\n]*?(?:มิเตอร์|PEA\s*No|CA\s*[:：]|ชื่อผู้ใช้ไฟ|ที่อยู่|เบอร์โทร|พิกัด|Google\s*Maps?|Lat\s*:))/gi, '$1 ')
            .replace(/^(\s*(?:ชื่อผู้ใช้ไฟ(?:ฟ้า)?|ชื่อลูกค้า|ผู้ใช้ไฟ(?:ฟ้า)?|ชื่อผู้แจ้ง|เบอร์โทร(?:ศัพท์)?|ที่อยู่)\s*)\r?\n+\s*/gim, '$1 : ')
            .replace(/([^\n])\s+(มิเตอร์\s*-\s*PEA\s*No\.?\s*[:：=])/gi, '$1\n$2')
            .replace(/([^\n])\s+((?:หมายเลขผู้ใช้ไฟ(?:ฟ้า)?\s*\(?CA\)?|CA\s*(?:No\.?)?)\s*[:：=])/gi, '$1\n$2')
            .replace(/([^\n:：=])\s+\b(02\d{10})\b/g, '$1\n$2')
            .replace(/([^\n])\s+((?:ชื่อผู้ใช้ไฟ(?:ฟ้า)?|ชื่อลูกค้า|ชื่อผู้แจ้ง|ที่อยู่|เบอร์โทร(?:ศัพท์)?|ลักษณะอาการ|บริเวณ)\s*[:：=])/gi, '$1\n$2');

        if (stripRules.stripCustomerName) {
            text = text.replace(/^(?:👤\s*)?(?:ชื่อผู้ใช้ไฟ(?:ฟ้า)?|ชื่อลูกค้า|ผู้ใช้ไฟ(?:ฟ้า)?|ชื่อผู้แจ้ง|ชื่อ-นามสกุล|ชื่อ-สกุล)\s*[:：=]?\s*([^\n]*)$/gim, (_, np) => {
                const tail = (np || '').match(/(\d+(?:\/\d+)?\s*(?:ม\.|หมู่(?:ที่)?|ต\.|ตำบล|ซ\.|ซอย|ถ\.|ถนน).*)$/);
                return tail ? `ที่อยู่ : ${tail[1].trim()}` : '';
            });
        }
        stripWordsList.forEach(w => {
            const cw = String(w || '').trim(); if (!cw) return;
            const esc = cw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            text = wholeLine ? text.replace(new RegExp(`^.*${esc}.*(?:\\r?\\n|$)`, 'gim'), '') : text.replace(new RegExp(esc, 'gi'), '');
        });
        if (stripRules.stripPhoneTextAndNum) {
            text = text.replace(/(?:📞\s*)?(?:เบอร์โทร(?:ศัพท์)?|โทร(?:ศัพท์)?|เบอร์ติดต่อ|ติดต่อ|Tel\.?)\s*[:：=]?\s*[0-9\-\s,\/()]{8,}/gi, '').replace(/\b0[2689]\d[\-\s]?\d{3,4}[\-\s]?\d{3,4}\b/g, '');
            const pEl = document.getElementById('phone'); if (pEl) pEl.value = '';
        }
        if (stripRules.stripAllDigits) text = text.replace(/\d+/g, '');

        const mLL = text.match(/(?:พิกัด\s*[:：=]?\s*)?Lat[\s:=]*(-?\d+\.\d+)[\s,]*Long?[\s:=]*(-?\d+\.\d+)/i) || text.match(/\(\s*Lat\s*,\s*Long?\s*\)\s*[:：=]?\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/i);
        if (mLL) { if (!extractedGps) extractedGps = `${mLL[1]}, ${mLL[2]}`; text = text.replace(mLL[0], ''); }

        let exPhone = '', exIssue = '', exArea = '', exWorker = '';
        const houseLines = [], custLines = [], caLines = [], meterLines = [], otherLines = [];
        text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
            let wl = line;
            const mCoord = wl.match(/^(-?\d{1,2}\.\d{4,}\s*,\s*-?\d{2,3}\.\d{4,})$/); if (mCoord) { if (!extractedGps) extractedGps = mCoord[1]; return; }
            const mPea = wl.match(/^(?:📟\s*)?(?:มิเตอร์\s*-\s*PEA\s*No\.?|PEA\s*No\.?|หมายเลขมิเตอร์|มิเตอร์)\s*[:：=]?\s*(.+)$/i); if (mPea) { meterLines.push(`มิเตอร์ - PEA No. : ${mPea[1].trim()}`); return; }
            const mCa = wl.match(/^(?:💳\s*)?(?:(?:หมายเลขผู้ใช้ไฟ(?:ฟ้า)?\s*\(?CA\)?|CA\s*(?:No\.?)?)\s*[:：=]?\s*(\d{9,15}.*)|(02\d{10}))$/i); if (mCa) { caLines.push(`CA : ${(mCa[1] || mCa[2]).trim()}`); return; }
            const mCust = wl.match(/^(?:👤\s*)?(?:ชื่อผู้ใช้ไฟ(?:ฟ้า)?|ชื่อลูกค้า|ชื่อผู้แจ้ง)\s*[:：=]?\s*(.*)$/i); if (mCust) { if (!stripRules.stripCustomerName && mCust[1].trim()) custLines.push(`ชื่อผู้ใช้ไฟฟ้า : ${mCust[1].trim()}`); return; }
            if (!stripRules.stripPhoneTextAndNum) {
                const mPh = wl.match(/^(?:📞\s*)?(?:เบอร์โทร(?:ศัพท์)?|โทร(?:ศัพท์)?|ติดต่อ)\s*[:：=]?\s*([0-9\-\s]{9,})$/i) || wl.match(/^(0[2689]\d[\-\s]?\d{3,4}[\-\s]?\d{3,4})$/);
                if (mPh) { if (!exPhone) exPhone = mPh[1].replace(/[\-\s]/g, ''); return; }
            }
            const mIss = wl.match(/^(?:ลักษณะอาการ|อาการ(?:เสีย|ขัดข้อง)?)\s*[:：=]\s*(.+)$/i); if (mIss) { exIssue = exIssue || mIss[1].trim(); return; }
            const mAr = wl.match(/^(?:บริเวณ|จุดเกิดเหตุ)\s*[:：=]\s*(.+)$/i); if (mAr) { exArea = exArea || mAr[1].trim(); return; }
            const mWk = wl.match(/^(?:ผู้ปฏิบัติงาน|ผู้รับแจ้ง)\s*[:：=]\s*(.+)$/i); if (mWk) { exWorker = exWorker || mWk[1].trim(); return; }
            const mAd = wl.match(/^(?:ที่อยู่|สถานที่ใช้ไฟ(?:ฟ้า)?|บ้านเลขที่)\s*[:：=]?\s*(.+)$/i); if (mAd) { houseLines.push(mAd[1].trim()); return; }
            if (stripRules.stripCustomerName && /^(?:(?:คุณ|นาย|นาง|น\.ส\.|นางสาว)\s*)?[ก-๙]{2,25}\s+[ก-๙]{2,30}$/.test(wl) && !/(?:ม\.|หมู่|ต\.|ตำบล|ซอย|ถนน|บ้าน|ไฟ|มิเตอร์)/.test(wl)) return;
            if (stripRules.stripStandaloneNumbers) wl = wl.replace(/\b\d{4,}\b/g, '').trim();
            if (wl && !/^[:：=\-\s]+$/.test(wl)) otherLines.push(wl);
        });

        if (exIssue) document.getElementById('issueType').value = exIssue;
        if (exWorker) document.getElementById('workerName').value = exWorker;
        if (exArea) document.getElementById('area').value = exArea;
        if (exPhone && !stripRules.stripPhoneTextAndNum) document.getElementById('phone').value = exPhone;
        if (extractedGps) { const gEl = document.getElementById('gps'); gEl.value = extractedGps; gEl.dispatchEvent(new Event('input', { bubbles: true })); }
        const addrEl = document.getElementById('address');
        if (addrEl) { addrEl.value = [...houseLines, ...otherLines, ...custLines, ...caLines, ...meterLines].filter(Boolean).join('\n'); addrEl.style.height = 'auto'; addrEl.style.height = addrEl.scrollHeight + 'px'; }
        autoFillJobNo(false); checkCaOverdueEnhanced(false); saveOutageDraft();
    }

    function clearAutoFillPasteBox(notify = false) {
        const el = document.getElementById('rawCustomerPasteInput'); if (el) { el.value = ''; el.style.height = 'auto'; }
        checkCaOverdueEnhanced(true); if (notify) showToast('🧹 ล้างช่องวางข้อมูลอัตโนมัติแล้ว');
    }

    function openStripWordsModal() {
        if (!guardNotViewer()) return;
        let modal = document.getElementById('stripWordsModal');
        if (!modal) {
            modal = document.createElement('div'); modal.id = 'stripWordsModal'; modal.className = 'fixed inset-0 bg-slate-900/55 hidden z-[175] flex items-center justify-center p-4 backdrop-blur-sm';
            modal.innerHTML = `<div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]"><div class="px-4 py-3 bg-gradient-to-r from-blue-600 to-indigo-700 text-white flex justify-between items-center"><h3 class="font-bold text-sm">✂️ ตั้งค่าตัดข้อความออกอัตโนมัติ</h3><button type="button" onclick="closeStripWordsModal()" class="text-xl font-bold">&times;</button></div><div class="p-3.5 bg-white border-b space-y-2 text-xs"><label class="flex items-center gap-2"><input type="checkbox" id="ruleStripCustName" onchange="onChangeStripRule('stripCustomerName',this.checked)"><span>ตัด "ชื่อผู้ใช้ไฟฟ้า" และชื่อคนออก</span></label><label class="flex items-center gap-2"><input type="checkbox" id="ruleStripPhone" onchange="onChangeStripRule('stripPhoneTextAndNum',this.checked)"><span>ตัดเบอร์โทรออก</span></label><label class="flex items-center gap-2"><input type="checkbox" id="ruleStripStandaloneNum" onchange="onChangeStripRule('stripStandaloneNumbers',this.checked)"><span>ตัดตัวเลขลอยๆ ที่ไม่เกี่ยวข้องออก</span></label><label class="flex items-center gap-2 text-rose-700"><input type="checkbox" id="ruleStripAllDigits" onchange="onChangeStripRule('stripAllDigits',this.checked)"><span>ตัดตัวเลข 0-9 ทั้งหมด</span></label><div class="flex gap-2 pt-1"><input type="text" id="newStripWordInput" placeholder="พิมพ์คำที่ต้องการตัดออก..." onkeypress="if(event.key==='Enter')addStripWordItem()" class="flex-1 px-3 py-1.5 border rounded-lg"><button type="button" onclick="addStripWordItem()" class="bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold">เพิ่มคำ</button></div><div class="flex justify-between items-center pt-1"><label class="flex items-center gap-1.5 text-[11px]"><input type="checkbox" id="stripWholeLineToggle" onchange="toggleStripWholeLineMode(this.checked)"><span>ตัดทั้งบรรทัดเมื่อพบคำ</span></label><input type="text" id="searchStripWordInput" oninput="renderStripWordsList()" placeholder="🔍 ค้นหาคำ..." class="w-28 px-2 py-1 border rounded text-[11px]"></div></div><div id="stripWordsListContainer" class="p-3 flex-1 overflow-y-auto space-y-1.5 bg-slate-50"></div><div class="p-3 border-t bg-white flex justify-between"><button type="button" onclick="clearAllStripWords()" class="text-xs text-rose-600 font-semibold">🗑️ ล้างคำทั้งหมด</button><button type="button" onclick="closeStripWordsModal()" class="px-4 py-1.5 text-xs font-bold bg-slate-100 rounded-lg">ปิดหน้าต่าง</button></div></div>`;
            document.body.appendChild(modal);
        }
        document.getElementById('stripWholeLineToggle').checked = Core.rawStorageGet(STRIP_LINE_MODE_KEY) === 'true';
        document.getElementById('ruleStripCustName').checked = !!stripRules.stripCustomerName;
        document.getElementById('ruleStripPhone').checked = !!stripRules.stripPhoneTextAndNum;
        document.getElementById('ruleStripStandaloneNum').checked = !!stripRules.stripStandaloneNumbers;
        document.getElementById('ruleStripAllDigits').checked = !!stripRules.stripAllDigits;
        renderStripWordsList(); modal.classList.remove('hidden');
    }
    function closeStripWordsModal() { document.getElementById('stripWordsModal')?.classList.add('hidden'); }
    function onChangeStripRule(k, v) { stripRules[k] = !!v; localStorage.setItem(STRIP_RULES_KEY, JSON.stringify(stripRules)); syncCaAndStripBadges(); processCustomerPasteData(document.getElementById('rawCustomerPasteInput')?.value || ''); }
    function toggleStripWholeLineMode(v) { localStorage.setItem(STRIP_LINE_MODE_KEY, String(!!v)); processCustomerPasteData(document.getElementById('rawCustomerPasteInput')?.value || ''); }
    function renderStripWordsList() {
        const c = document.getElementById('stripWordsListContainer'), q = (document.getElementById('searchStripWordInput')?.value || '').toLowerCase().trim();
        if (!c) return;
        const items = stripWordsList.map((w, idx) => ({ w, idx })).filter(x => !q || x.w.toLowerCase().includes(q));
        c.innerHTML = items.length ? items.map(({ w, idx }) => `<div class="flex justify-between items-center bg-white border rounded-lg px-3 py-2 text-xs"><span class="truncate pr-2">✂️ "${escapeHtmlStr(w)}"</span><div class="flex gap-1 shrink-0"><button type="button" onclick="editStripWordItem(${idx})" class="text-amber-600 px-2 py-1 border rounded">✏️</button><button type="button" onclick="deleteStripWordItem(${idx})" class="text-rose-600 px-2 py-1 border rounded">🗑️</button></div></div>`).join('') : '<div class="text-center text-slate-400 text-xs py-6">ไม่มีรายการคำตัดออก</div>';
    }
    function addStripWordItem() { const inp = document.getElementById('newStripWordInput'), v = (inp?.value || '').trim(); if (v && !stripWordsList.includes(v)) { stripWordsList.unshift(v); localStorage.setItem(STRIP_WORDS_KEY, JSON.stringify(stripWordsList)); syncCaAndStripBadges(); renderStripWordsList(); inp.value = ''; } }
    function editStripWordItem(idx) { showCustomPrompt('แก้ไขคำตัดออก:', stripWordsList[idx], nv => { if (nv?.trim()) { stripWordsList[idx] = nv.trim(); localStorage.setItem(STRIP_WORDS_KEY, JSON.stringify(stripWordsList)); renderStripWordsList(); } }); }
    function deleteStripWordItem(idx) { stripWordsList.splice(idx, 1); localStorage.setItem(STRIP_WORDS_KEY, JSON.stringify(stripWordsList)); syncCaAndStripBadges(); renderStripWordsList(); }
    function clearAllStripWords() { showCustomConfirm('ล้างคำตัดออกทั้งหมด?', () => { stripWordsList = []; localStorage.setItem(STRIP_WORDS_KEY, '[]'); syncCaAndStripBadges(); renderStripWordsList(); }); }

    // ========================================================================
    // 12. ซิงค์ใบงาน หน้า 1 <-> หน้า 2 ให้รายการและยอดรวมเท่ากันทุกคน 100%
    // ========================================================================
    function findNearestTechForMainPage(item, preloadedLocMap = null) {
        const jobGroup = normGrp(getJobGroupName(item)), locMap = preloadedLocMap || getTechLocationsMap();
        const raw = `${item?.gps || ''} ${item?.address || ''} ${item?.area || ''} ${item?.weather || ''}`;
        let coords = extractCoordsFromInput(raw);
        if (!coords) {
            for (const [tb, cd] of Object.entries(targetTambonCoordinates)) {
                const cl = tb.replace('ตำบล', '').trim(); if (cl && raw.includes(cl)) { coords = cd; break; }
            }
        }
        if (!coords?.lat || !coords?.lon) return null;
        const now = Date.now(), cands = [];
        Object.entries(locMap).forEach(([k, loc]) => {
            if (isMainSysRegistryLoc(k, loc) || !loc || loc.isOnline === false || loc.gpsDisabled || isNaN(parseFloat(loc.lat)) || isNaN(parseFloat(loc.lon)) || !loc.username) return;
            const seen = new Date(loc.lastSeenAt || loc.updatedAt || 0).getTime() || 0;
            if (!seen || (now - seen) > 180000) return;
            const tGrp = normGrp(getUserGroupName(loc.username) || loc.group || '');
            if (jobGroup && tGrp && jobGroup !== tGrp) return;
            const roadKm = Math.max(0.2, calcHaversineKm(parseFloat(loc.lat), parseFloat(loc.lon), parseFloat(coords.lat), parseFloat(coords.lon)) * 1.35);
            cands.push({ techName: loc.username, distanceKm: roadKm.toFixed(1), durationMin: Math.max(1, Math.round((roadKm / 45) * 60)), hasGps: true });
        });
        cands.sort((a, b) => parseFloat(a.distanceKm) - parseFloat(b.distanceKm));
        return cands[0] || null;
    }

    function buildMainRealtimeNavHtml(nav) {
        if (!nav) return '';
        const now = Date.now(), fresh = nav.updatedAt && (now - new Date(nav.updatedAt).getTime() < 45000);
        const bdg = fresh ? '<span class="bg-emerald-100 text-emerald-700 text-[9px] font-bold px-1.5 py-0.5 rounded-full">🟢 GPS สด</span>' : '<span class="bg-blue-100 text-blue-700 text-[9px] font-bold px-1.5 py-0.5 rounded-full">⏱️ เรียลไทม์</span>';
        const tech = escapeHtmlStr(formatTechDisplayName(nav.techName || '-'));
        if (nav.isArrived || (nav.etaTimestamp && nav.etaTimestamp <= now)) {
            return `<div class="flex justify-between items-center"><div class="font-bold text-emerald-700">📍 ช่างถึงจุดเกิดเหตุแล้ว</div>${bdg}</div><div class="text-[10px] text-emerald-800">👷 ช่าง: ${tech} (ออก ${escapeHtmlStr(nav.departTime || '-')})</div>`;
        }
        if (nav.etaTimestamp && nav.departTimestamp) {
            const rem = Math.max(0, Math.floor((nav.etaTimestamp - now) / 1000)), tot = Math.max(60, Math.floor((nav.etaTimestamp - nav.departTimestamp) / 1000));
            const pct = Math.round(Math.min(1, Math.max(0.05, 1 - rem / tot)) * 100);
            const dist = fresh ? parseFloat(nav.distanceKm || 0).toFixed(1) : Math.max(0.1, parseFloat(nav.initialDistanceKm || nav.distanceKm || 0) * (1 - (pct / 100) * 0.95)).toFixed(1);
            return `<div class="flex justify-between items-center gap-1"><div class="font-bold text-blue-700">🚗 กำลังเดินทาง: อีก ${Math.floor(rem / 60)} นาที ${String(rem % 60).padStart(2, '0')} วิ (ถึง ~${escapeHtmlStr(nav.etaTime || '-')})</div>${bdg}</div><div class="w-full bg-blue-200/80 h-1.5 rounded-full overflow-hidden my-1"><div class="bg-blue-600 h-full" style="width:${pct}%"></div></div><div class="flex justify-between text-[10px] text-blue-800"><span>📏 เหลือ ~${dist} กม. (${pct}%)</span><span>👷 ${tech}</span></div>`;
        }
        return `<div class="font-bold text-blue-700">🚗 ช่างกำลังเดินทาง (${tech})</div>`;
    }

    function normalizeMainEquipTechKey(name, grpOpt) {
        const b = getUserBaseId(name), g = normGrp(grpOpt || getUserGroupName(name) || getCurrentUserGroup() || 'กฟส.บึง').replace(/\s+/g, '_');
        return b ? `equip_nav_${g}_${b.replace(/\s+/g, '_')}` : `equip_nav_${g}_guest`;
    }

    function getVisibleActiveEquipNavsForMain(preloadedLocMap = null) {
        const locMap = preloadedLocMap || getTechLocationsMap(), navMap = JSON.parse(Core.rawStorageGet('elec_active_equip_nav_map_v2') || '{}');
        const cancelMap = { ...JSON.parse(Core.rawStorageGet('elec_cancelled_equip_nav_map') || '{}'), ...(locMap[Core.REGISTRY_LOC_KEY]?.equipCancelMap || {}) };
        const getNavMs = (nv) => !nv ? 0 : Math.max(Number(nv.departTimestamp || 0), new Date(nv.updatedAt || 0).getTime() || 0, Number(nv.cancelledAtMs || 0));
        Object.entries(locMap).forEach(([uK, obj]) => {
            if (!isMainSysRegistryLoc(uK, obj) && obj?.activeEquipNav) {
                const nk = obj.activeEquipNav.id || normalizeMainEquipTechKey(obj.activeEquipNav.techName || uK, obj.activeEquipNav.ownerGroup || obj.group);
                if (!navMap[nk] || getNavMs(obj.activeEquipNav) >= getNavMs(navMap[nk])) navMap[nk] = { ...obj.activeEquipNav, id: nk };
            }
        });
        const myGrp = normGrp(getCurrentUserGroup() || 'กฟส.บึง'), admin = isCurrentUserAdmin();
        return Object.values(navMap).filter(n => {
            if (!n?.isTraveling) return false;
            const legacyKey = 'equip_nav_' + (getUserBaseId(n.techName || '') || 'guest').replace(/\s+/g, '_');
            const tMs = getNavMs(n);
            const cMs = Math.max(Number(cancelMap[n.id] || 0), Number(cancelMap[legacyKey] || 0), Number(cancelMap[n.techName] || 0), Number(n.cancelledAtMs || 0));
            if (cMs >= tMs || (Date.now() - tMs > 21600000)) return false;
            return admin || !myGrp || !n.ownerGroup || myGrp === normGrp(n.ownerGroup);
        });
    }

    async function stopEquipNavFromMainPage(techUserKey, isArrived = true) {
        if (!techUserKey) { Core.unlockCloudWrite(20000); return; }
        if (!guardNotViewer()) return;
        Core.unlockCloudWrite(20000);
        const navMap = JSON.parse(Core.rawStorageGet('elec_active_equip_nav_map_v2') || '{}');
        const cancelMap = JSON.parse(Core.rawStorageGet('elec_cancelled_equip_nav_map') || '{}');
        const locMap = getTechLocationsMap();

        const matchedNav = navMap[techUserKey] || Object.values(navMap).find(n => n && (n.id === techUserKey || isSameTechPerson(n.techName, techUserKey)));
        const realTechName = normalizeUsernameFormat(matchedNav?.techName || (techUserKey.startsWith('equip_nav_') ? '' : techUserKey));
        const ownerGrp = normGrp(matchedNav?.ownerGroup || getUserGroupName(realTechName) || getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
        const scopedKey = techUserKey.startsWith('equip_nav_') ? techUserKey : normalizeMainEquipTechKey(realTechName || techUserKey, ownerGrp);
        const legacyKey = realTechName ? ('equip_nav_' + (getUserBaseId(realTechName) || 'guest').replace(/\s+/g, '_')) : '';
        const prevMs = Math.max(Number(matchedNav?.departTimestamp || 0), new Date(matchedNav?.updatedAt || 0).getTime() || 0);
        const safeMs = Math.max(Date.now() + 1000, prevMs + 1000), safeIso = new Date(safeMs).toISOString();

        [techUserKey, realTechName, scopedKey, legacyKey].filter(Boolean).forEach(k => { cancelMap[k] = safeMs; delete navMap[k]; });
        Object.keys(navMap).forEach(k => {
            if (realTechName && isSameTechPerson(navMap[k]?.techName, realTechName)) { cancelMap[k] = safeMs; delete navMap[k]; }
        });
        if (realTechName && !locMap[realTechName]) locMap[realTechName] = { username: realTechName, group: ownerGrp, isOnline: true };
        Object.keys(locMap).forEach(uK => {
            if (isMainSysRegistryLoc(uK, locMap[uK])) return;
            if ((realTechName && isSameTechPerson(uK, realTechName)) || locMap[uK]?.activeEquipNav?.id === scopedKey) {
                locMap[uK].group = locMap[uK].group || ownerGrp;
                locMap[uK].activeEquipNav = { id: scopedKey, techName: realTechName || uK, ownerGroup: ownerGrp, isTraveling: false, status: isArrived ? 'arrived' : 'cancelled', cancelledAtMs: safeMs, updatedAt: safeIso };
                locMap[uK].updatedAt = safeIso;
            }
        });
        locMap[Core.REGISTRY_LOC_KEY] = { ...(locMap[Core.REGISTRY_LOC_KEY] || {}), isSystemRegistry: true, equipCancelMap: { ...(locMap[Core.REGISTRY_LOC_KEY]?.equipCancelMap || {}), ...cancelMap }, updatedAt: safeIso };

        localStorage.setItem('elec_cancelled_equip_nav_map', JSON.stringify(cancelMap));
        localStorage.setItem('elec_active_equip_nav_map_v2', JSON.stringify(navMap));
        localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
        renderNavEtaBadgesInMainHistory();
        showToast(isArrived ? '✅ บันทึกถึงที่หมายเรียบร้อยแล้ว' : '↩️ ยกเลิกการเดินทางไปอุปกรณ์แล้ว');
        await syncJobsWithFieldPage();
    }

    function renderNavEtaBadgesInMainHistory() {
        const closedReg = getClosedJobsRegistry(), locMap = getTechLocationsMap(), isViewer = isViewerRole();
        const decorate = (sel, arr, kf, jType) => {
            const map = new Map(arr.map(o => [o?.[kf], o]));
            document.querySelectorAll(sel).forEach(card => {
                const m = card.querySelector('button[onclick^="edit"]')?.getAttribute('onclick')?.match(/'((?:\\.|[^'])*)'/);
                if (!m) return;
                const jk = m[1].replace(/\\'/g, "'"), safeJk = escJsAttr(jk), item = map.get(jk);
                if (!item) return;
                let banner = card.querySelector('.tech-nav-eta-banner');
                if (!banner) { banner = document.createElement('div'); card.insertBefore(banner, card.lastElementChild); }
                const tr = (item.techReport && !isAutoGeneratedFakeClosure(item.techReport)) ? item.techReport : closedReg[jk];
                const isDone = Boolean((tr && String(tr.status || '').includes('เสร็จสิ้น') && !isAutoGeneratedFakeClosure(tr)) || item.formattedText?.includes('แก้ไขเสร็จสิ้น'));
                let nextCls = '', nextHtml = '';
                if (isDone) {
                    nextCls = 'tech-nav-eta-banner p-2 bg-emerald-50 border border-emerald-200 rounded-xl text-[11px] text-emerald-900 flex flex-wrap justify-between items-center gap-1 mt-1';
                    nextHtml = `<span class="font-bold text-emerald-700">✅ ปิดงานเสร็จสิ้น (${escapeHtmlStr(tr?.actionTaken || tr?.realCause || 'จ่ายไฟคืนปกติ')})</span><span class="text-[10px] text-emerald-600">👷 ${escapeHtmlStr(formatTechDisplayName(tr?.inspector || '-'))}</span>`;
                } else if (item.techNav) {
                    nextCls = 'tech-nav-eta-banner p-2.5 bg-blue-50 border border-blue-200 rounded-xl text-[11px] text-blue-900 space-y-1 mt-1';
                    nextHtml = buildMainRealtimeNavHtml(item.techNav);
                } else {
                    const rec = findNearestTechForMainPage(item, locMap);
                    const closeBtn = !isViewer ? `<button type="button" onclick="quickCloseJobFromMainHistory('${safeJk}','${jType}')" class="bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold px-2 py-0.5 rounded shadow-sm">✅ ปิดงาน</button>` : '';
                    nextCls = `tech-nav-eta-banner p-2 ${rec ? 'bg-purple-50 border-purple-200 text-purple-900' : 'bg-slate-100 border-slate-200 text-slate-600'} border rounded-xl text-[11px] flex flex-wrap justify-between items-center gap-1 mt-1`;
                    nextHtml = rec ? `<span class="font-bold text-purple-800">🎯 แนะนำช่างใกล้สุด: ${escapeHtmlStr(formatTechDisplayName(rec.techName))} (~${rec.distanceKm} กม.)</span>${closeBtn}` : `<span class="font-semibold text-slate-500">⏳ รอช่างออนไลน์ / เปิดพิกัด GPS</span>${closeBtn}`;
                }
                if (banner.className !== nextCls) banner.className = nextCls;
                if (banner.__lastHtml !== nextHtml) { banner.innerHTML = nextHtml; banner.__lastHtml = nextHtml; }
            });
        };
        decorate('#historyListOutage > div', JSON.parse(Core.rawStorageGet('elecReportsComplete_all') || '[]'), 'dateTimeSaved', 'outage');
        decorate('#historyListFault > div', JSON.parse(Core.rawStorageGet('fault_reports_all') || '[]'), 'timestamp', 'fault');

        const activeEq = getVisibleActiveEquipNavsForMain(locMap);
        const eqKeysSig = activeEq.map(n => `${n.id || n.techName}:${n.placeTitle || ''}:${!isViewer}`).join('|');
        ['historyListFault', 'historyListOutage'].forEach(listId => {
            const hc = document.getElementById(listId); if (!hc?.parentElement) return;
            let wrap = document.getElementById('mainEquipNavBanner_' + listId);
            if (!activeEq.length) { wrap?.remove(); return; }
            if (!wrap) { wrap = document.createElement('div'); wrap.id = 'mainEquipNavBanner_' + listId; wrap.className = 'space-y-2 mb-2'; hc.parentElement.insertBefore(wrap, hc); }
            if (wrap.__keysSig !== eqKeysSig) {
                wrap.__keysSig = eqKeysSig;
                wrap.innerHTML = activeEq.map((n, idx) => {
                    const safeId = escJsAttr(n.id || n.techName || '');
                    return `<div class="p-3 rounded-xl border-2 border-sky-400 bg-sky-50/95 shadow-sm text-xs space-y-1.5"><div class="flex justify-between font-bold text-sky-950"><span>⚡ กำลังเดินทางไปอุปกรณ์: ${escapeHtmlStr(n.placeTitle || n.placeName || 'หมุดอุปกรณ์')}</span><span class="text-[10px] bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded">🏢 ${escapeHtmlStr(normGrp(n.ownerGroup || 'กฟส.บึง'))}</span></div><div class="main-eq-live-body p-2 bg-white border border-sky-200 rounded-lg text-[11px]" data-eq-idx="${idx}">${buildMainRealtimeNavHtml(n)}</div>${!isViewer ? `<div class="flex justify-end gap-1.5"><button type="button" onclick="stopEquipNavFromMainPage('${safeId}',false)" class="bg-rose-50 text-rose-600 border border-rose-200 px-2 py-1 rounded-lg text-[10px] font-bold">❌ ยกเลิก</button><button type="button" onclick="stopEquipNavFromMainPage('${safeId}',true)" class="bg-emerald-600 text-white px-2 py-1 rounded-lg text-[10px] font-bold">✅ ถึงที่หมายแล้ว</button></div>` : ''}</div>`;
                }).join('');
            } else {
                wrap.querySelectorAll('.main-eq-live-body').forEach(el => {
                    const n = activeEq[Number(el.getAttribute('data-eq-idx'))];
                    if (n) el.innerHTML = buildMainRealtimeNavHtml(n);
                });
            }
        });
    }

    function isRestoredAfterDelete(it, rk, delReg) {
        return Boolean(rk && delReg?.[rk] && Number(it?.restoredAtMs || 0) > Number(delReg[rk] || 0));
    }

    function dedupeJobsByKey(arr, kf, delReg) {
        const map = new Map();
        (arr || []).forEach(it => {
            const k = it?.[kf];
            if (!k) return;
            if (delReg?.[k]) {
                if (isRestoredAfterDelete(it, k, delReg)) delete delReg[k];
                else return;
            }
            const ex = map.get(k);
            if (!ex || (it.editedAt || '') >= (ex.editedAt || '')) {
                map.set(k, { ...(ex || {}), ...it, ownerGroup: normGrp(getJobGroupName(it)) });
            }
        });
        return Array.from(map.values());
    }

    function resolveUnifiedJobPair(it, cj, rk, closedReg, cancelJobMap) {
        const cRep = (cj?.techReport && !isAutoGeneratedFakeClosure(cj.techReport)) ? cj.techReport : null;
        const lRep = (it?.techReport && !isAutoGeneratedFakeClosure(it.techReport)) ? it.techReport : null;
        const regRep = (rk && closedReg?.[rk] && !isAutoGeneratedFakeClosure(closedReg[rk])) ? closedReg[rk] : null;

        let bestRep = (cRep?.updatedAt || '') >= (lRep?.updatedAt || '') ? (cRep || lRep) : (lRep || cRep);
        if (!bestRep && regRep) bestRep = regRep;

        const latestReopen = (cj?.reopenedAt || '') >= (it?.reopenedAt || '') ? (cj?.reopenedAt || '') : (it?.reopenedAt || '');
        if (latestReopen && (!bestRep?.updatedAt || latestReopen > bestRep.updatedAt)) {
            bestRep = undefined;
            if (rk && closedReg?.[rk] && (!closedReg[rk].updatedAt || latestReopen >= closedReg[rk].updatedAt)) delete closedReg[rk];
        }

        const regCancel = (rk && cancelJobMap?.[rk]) ? String(cancelJobMap[rk]) : '';
        const latestCancel = [cj?.navCancelledAt || '', it?.navCancelledAt || '', regCancel].sort().pop() || '';
        let bestNav = (cj?.techNav?.updatedAt || '') >= (it?.techNav?.updatedAt || '') ? (cj?.techNav || it?.techNav) : (it?.techNav || cj?.techNav);
        const isDone = Boolean(bestRep && String(bestRep.status || '').includes('เสร็จสิ้น'));
        if (!isDone && bestRep && rk && closedReg?.[rk] && (!closedReg[rk].updatedAt || (bestRep.updatedAt || '') >= closedReg[rk].updatedAt)) {
            delete closedReg[rk];
        }
        if (isDone || (latestCancel && (!bestNav?.updatedAt || latestCancel >= bestNav.updatedAt)) || (bestRep?.updatedAt && (!bestNav?.updatedAt || bestRep.updatedAt >= bestNav.updatedAt))) {
            bestNav = undefined;
        }

        const preferLocalCore = Boolean(it && (!cj || it.pendingInitialUpload || (it.editedAt || '') >= (cj.editedAt || '')));
        const baseCore = preferLocalCore ? { ...(cj || {}), ...it } : { ...(it || {}), ...(cj || {}) };
        if (bestRep?.fieldGps && bestRep.fieldGps !== '-' && (!baseCore.gps || baseCore.gps === '-' || (bestRep.updatedAt || '') >= (baseCore.editedAt || ''))) {
            baseCore.gps = bestRep.fieldGps;
        }

        const baseTxt = String(baseCore.formattedText || '').split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[0];
        if (!bestRep) {
            baseCore.formattedText = baseTxt;
        } else {
            const repSrcTxt = (bestRep === cRep ? cj?.formattedText : it?.formattedText) || baseCore.formattedText || '';
            const repBlk = String(repSrcTxt).split('\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---')[1];
            if (repBlk) baseCore.formattedText = `${baseTxt}\n\n--- 🛠️ ผลตรวจสอบหน้างาน ---${repBlk}`;
        }

        const merged = { ...baseCore, ownerGroup: normGrp(getJobGroupName(baseCore) || 'กฟส.บึง') || 'กฟส.บึง' };
        if (bestRep) merged.techReport = { ...bestRep }; else delete merged.techReport;
        if (bestNav) merged.techNav = { ...bestNav }; else delete merged.techNav;
        if (latestReopen) merged.reopenedAt = latestReopen; else delete merged.reopenedAt;
        if (latestCancel) merged.navCancelledAt = latestCancel; else delete merged.navCancelledAt;
        return merged;
    }

    const syncJobsWithFieldPage = Core.createTrailingAsyncQueue(async function (cloudSnapshot = null) {
        if (Core.rawStorageGet('elec_app_logged_in') !== 'true' || Core.rawStorageGet('elec_app_current_role') === 'tech' || isViewerRole()) return false;
        const apiUrl = getActiveCloudApiUrl(); if (!apiUrl) return false;
        const myEpoch = authSessionEpochMain;
        isUploadingFromMain = true;
        try {
            let baseCloud = Array.isArray(cloudSnapshot) ? cloudSnapshot : cachedCloudJobs;
            if (!Array.isArray(cloudSnapshot)) {
                try {
                    Core.forceCloudRead();
                    const preRes = await fetch(apiUrl + '?t=' + Date.now(), { cache: 'no-store' });
                    const preData = await preRes.json();
                    if (myEpoch !== authSessionEpochMain || Core.rawStorageGet('elec_app_logged_in') !== 'true') return false;
                    if (Array.isArray(preData?.jobs)) { baseCloud = preData.jobs; cachedCloudJobs = preData.jobs; }
                } catch (e) {}
            }
            if (myEpoch !== authSessionEpochMain || Core.rawStorageGet('elec_app_logged_in') !== 'true') return false;

            Core.cleanReopenedAndCancelledJobsInStorage();
            tagUntaggedLocalJobsWithCurrentGroup();
            Core.unlockCloudWrite(20000);
            const prevLocEntry = (baseCloud || []).find(j => j && j.jobType === 'tech_loc') || {};
            if (prevLocEntry.techLocations) mergeTechLocationsMap(prevLocEntry.techLocations);
            if (prevLocEntry.closedJobsMap || prevLocEntry.closedReports) syncClosedRegistryObject({ ...getClosedJobsRegistry(), ...(prevLocEntry.closedJobsMap || {}), ...(prevLocEntry.closedReports || {}) });

            const delReg = { ...getDeletedJobsRegistry(), ...(prevLocEntry.deletedJobsMap || {}) };
            const closedReg = getClosedJobsRegistry();
            const cancelJobMap = JSON.parse(Core.rawStorageGet('elec_cancelled_job_nav_map') || '{}');
            const myGrp = normGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง';
            const localOutList = dedupeJobsByKey(JSON.parse(Core.rawStorageGet('elecReportsComplete_all') || '[]'), 'dateTimeSaved', delReg);
            const localFltList = dedupeJobsByKey(JSON.parse(Core.rawStorageGet('fault_reports_all') || '[]'), 'timestamp', delReg);
            const combined = new Map(), pushedMeta = new Map();

            (baseCloud || []).forEach(cj => {
                if (!cj || cj.jobType === 'tech_loc') return;
                const rk = cj.jobType === 'fault' ? cj.timestamp : cj.dateTimeSaved;
                if (rk && !delReg[rk]) combined.set((cj.jobType === 'fault' ? 'F_' : 'O_') + rk, { ...cj, ownerGroup: normGrp(getJobGroupName(cj)) });
            });

            const pushLocal = (list, type) => {
                const kf = type === 'fault' ? 'timestamp' : 'dateTimeSaved';
                list.filter(i => canCurrentUserSeeJob(i)).slice(0, 300).forEach(it => {
                    const rk = it[kf], uk = (type === 'fault' ? 'F_' : 'O_') + rk;
                    pushedMeta.set(uk, { edAt: it.editedAt || '', repUpd: it.techReport?.updatedAt || '', navUpd: it.techNav?.updatedAt || '' });
                    const merged = resolveUnifiedJobPair(it, combined.get(uk), rk, closedReg, cancelJobMap);
                    merged.jobType = type;
                    merged.ownerGroup = normGrp(getJobGroupName(merged) || myGrp) || myGrp;
                    delete merged.pendingInitialUpload;
                    if (merged.techReport) delete merged.techReport.needsMainSync;
                    if (merged.techNav) delete merged.techNav.needsMainSync;
                    combined.set(uk, merged);
                });
            };
            pushLocal(localOutList, 'outage');
            pushLocal(localFltList, 'fault');

            Core.rawStorageSet('elec_deleted_jobs_registry', JSON.stringify(delReg));
            syncClosedRegistryObject(closedReg);

            const finalJobs = [
                ...Array.from(combined.values()),
                {
                    ...prevLocEntry,
                    jobType: 'tech_loc',
                    dateTimeSaved: 'TECH_LOC_REGISTRY',
                    techLocations: getTechLocationsMap(),
                    closedJobsMap: closedReg,
                    closedReports: closedReg,
                    deletedJobsMap: delReg,
                    updatedAt: new Date().toISOString()
                }
            ];
            cachedCloudJobs = finalJobs;
            const postRes = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'saveJobs', jobs: finalJobs }) });
            const postData = await postRes.json();
            if (myEpoch === authSessionEpochMain && postData?.status === 'ok' && postData?.ok !== false && !postData?.skippedQuota && !postData?.skippedBusyRam && postData?.patched !== false) {
                ['elecReportsComplete_all', 'fault_reports_all'].forEach(sk => {
                    const isF = (sk === 'fault_reports_all'), kf = isF ? 'timestamp' : 'dateTimeSaved';
                    const freshList = JSON.parse(Core.rawStorageGet(sk) || '[]');
                    let dirty = false;
                    freshList.forEach(item => {
                        const snap = item?.[kf] ? pushedMeta.get((isF ? 'F_' : 'O_') + item[kf]) : null;
                        if (!snap) return;
                        if (item.pendingInitialUpload && (item.editedAt || '') === snap.edAt) { delete item.pendingInitialUpload; delete item.restoredAtMs; dirty = true; }
                        if (item.techReport?.needsMainSync && (item.techReport.updatedAt || '') === snap.repUpd) { delete item.techReport.needsMainSync; dirty = true; }
                        if (item.techNav?.needsMainSync && (item.techNav.updatedAt || '') === snap.navUpd) { delete item.techNav.needsMainSync; dirty = true; }
                    });
                    if (dirty) Core.rawStorageSet(sk, JSON.stringify(freshList));
                });
                return true;
            }
            return false;
        } catch (e) { return false; } finally { isUploadingFromMain = false; }
    });

    let pullTickCounter = 0;
    async function pullFieldReportsFromCloud(forceNow = false) {
        if (isUploadingFromMain || Core.rawStorageGet('elec_app_logged_in') !== 'true' || Core.rawStorageGet('elec_app_current_role') === 'tech') return;
        pullTickCounter++;
        if (!forceNow && pullTickCounter !== 1 && pullTickCounter % 2 !== 0) {
            Core.cleanReopenedAndCancelledJobsInStorage();
            renderNavEtaBadgesInMainHistory();
            return;
        }
        const myEpoch = authSessionEpochMain;
        Core.forceCloudRead();
        try {
            const res = await fetch(getActiveCloudApiUrl() + '?t=' + Date.now(), { cache: 'no-store' });
            const data = await res.json();
            if (myEpoch !== authSessionEpochMain || Core.rawStorageGet('elec_app_logged_in') !== 'true' || !Array.isArray(data?.jobs)) return;
            cachedCloudJobs = data.jobs;

            const locEntry = data.jobs.find(j => j.jobType === 'tech_loc');
            if (locEntry) {
                const cloudJobCancel = locEntry.techLocations?.[Core.REGISTRY_LOC_KEY]?.jobCancelMap;
                if (cloudJobCancel && typeof cloudJobCancel === 'object') {
                    const curCancel = JSON.parse(Core.rawStorageGet('elec_cancelled_job_nav_map') || '{}');
                    let jcDirty = false;
                    Object.entries(cloudJobCancel).forEach(([jk, cIso]) => {
                        if (cIso && (!curCancel[jk] || String(cIso) > String(curCancel[jk]))) { curCancel[jk] = cIso; jcDirty = true; }
                    });
                    if (jcDirty) localStorage.setItem('elec_cancelled_job_nav_map', JSON.stringify(curCancel));
                }
                if (locEntry.techLocations) mergeTechLocationsMap(locEntry.techLocations);
                if (locEntry.closedJobsMap || locEntry.closedReports) syncClosedRegistryObject({ ...getClosedJobsRegistry(), ...(locEntry.closedJobsMap || {}), ...(locEntry.closedReports || {}) });
                if (locEntry.cloudGroupBackups) {
                    const prevBkStr = Core.rawStorageGet(CLOUD_BACKUP_STORAGE_KEY) || '{}';
                    const nextBkStr = JSON.stringify({ ...JSON.parse(prevBkStr), ...locEntry.cloudGroupBackups });
                    if (nextBkStr !== prevBkStr) localStorage.setItem(CLOUD_BACKUP_STORAGE_KEY, nextBkStr);
                }
                const cloudClearedTs = Number(locEntry.clearedAuditLogsTimestamp || 0);
                const localClearedTs = parseInt(Core.rawStorageGet('elec_cleared_audit_logs_ts') || '0', 10) || 0;
                const effClearedTs = Math.max(cloudClearedTs, localClearedTs);
                if (effClearedTs > localClearedTs) Core.rawStorageSet('elec_cleared_audit_logs_ts', String(effClearedTs));

                if (Array.isArray(locEntry.electricEquipmentPins)) {
                    const prevDelEqStr = Core.rawStorageGet('elec_deleted_labeled_places_map') || '{}';
                    const delEq = { ...JSON.parse(prevDelEqStr), ...(locEntry.deletedElectricEquipmentMap || {}) };
                    const nextDelEqStr = JSON.stringify(delEq);
                    if (nextDelEqStr !== prevDelEqStr) localStorage.setItem('elec_deleted_labeled_places_map', nextDelEqStr);

                    const prevPinsStr = Core.rawStorageGet('elec_labeled_places_list') || '[]';
                    const pMap = new Map();
                    JSON.parse(prevPinsStr).forEach(p => {
                        if (p?.id && !(delEq[p.id] && (new Date(p.updatedAt || 0).getTime() || 0) <= (new Date(delEq[p.id]).getTime() || 0))) pMap.set(p.id, p);
                    });
                    locEntry.electricEquipmentPins.forEach(cp => {
                        if (!cp?.id || (delEq[cp.id] && (new Date(cp.updatedAt || 0).getTime() || 0) <= (new Date(delEq[cp.id]).getTime() || 0))) return;
                        const ex = pMap.get(cp.id);
                        if (!ex || (cp.updatedAt || '') > (ex.updatedAt || '') || ((cp.updatedAt || '') === (ex.updatedAt || '') && JSON.stringify(cp) !== JSON.stringify(ex))) pMap.set(cp.id, cp);
                    });
                    const nextPinsStr = JSON.stringify(Array.from(pMap.values()));
                    if (nextPinsStr !== prevPinsStr) {
                        localStorage.setItem('elec_labeled_places_list', nextPinsStr);
                        syncScadaPinsIntoAutocomplete();
                    }
                }
                if (Array.isArray(locEntry.deletedEquipAuditLogs)) {
                    const prevAuditStr = Core.rawStorageGet('elec_deleted_equip_audit_logs') || '[]';
                    const logMap = new Map();
                    [...JSON.parse(prevAuditStr), ...locEntry.deletedEquipAuditLogs].forEach(l => {
                        if (l?.logId && !(effClearedTs > 0 && (new Date(l.deletedAt || 0).getTime() || 0) <= effClearedTs)) logMap.set(l.logId, l);
                    });
                    const nextAuditStr = JSON.stringify(Array.from(logMap.values()));
                    if (nextAuditStr !== prevAuditStr) localStorage.setItem('elec_deleted_equip_audit_logs', nextAuditStr);
                }
            }

            const delReg = { ...getDeletedJobsRegistry(), ...(locEntry?.deletedJobsMap || {}) };
            const closedReg = getClosedJobsRegistry();
            const cancelJobMap = JSON.parse(Core.rawStorageGet('elec_cancelled_job_nav_map') || '{}');
            const nowMs = Date.now(), isAdmin = isCurrentUserAdmin();
            const prevOutRaw = Core.rawStorageGet('elecReportsComplete_all') || '[]', prevFltRaw = Core.rawStorageGet('fault_reports_all') || '[]';
            let outages = dedupeJobsByKey(JSON.parse(prevOutRaw), 'dateTimeSaved', delReg);
            let faults = dedupeJobsByKey(JSON.parse(prevFltRaw), 'timestamp', delReg);
            Core.rawStorageSet('elec_deleted_jobs_registry', JSON.stringify(delReg));

            const cloudOutKeys = new Set(), cloudFltKeys = new Set();
            const mergeList = (arr, cJob, kf) => {
                const rk = cJob[kf], idx = arr.findIndex(x => x[kf] === rk);
                if (idx === -1) arr.push(resolveUnifiedJobPair(null, cJob, rk, closedReg, cancelJobMap));
                else arr[idx] = resolveUnifiedJobPair(arr[idx], cJob, rk, closedReg, cancelJobMap);
            };

            data.jobs.forEach(cj => {
                if (!cj || cj.jobType === 'tech_loc' || !canCurrentUserSeeJob(cj)) return;
                if (cj.jobType === 'fault' && cj.timestamp && !delReg[cj.timestamp]) { cloudFltKeys.add(cj.timestamp); mergeList(faults, cj, 'timestamp'); }
                else if (cj.jobType !== 'fault' && cj.dateTimeSaved && !delReg[cj.dateTimeSaved]) { cloudOutKeys.add(cj.dateTimeSaved); mergeList(outages, cj, 'dateTimeSaved'); }
            });
            syncClosedRegistryObject(closedReg);

            let hasPendingLocalPush = false;
            outages.forEach(o => { if (o?.pendingInitialUpload || o?.techReport?.needsMainSync || o?.techNav?.needsMainSync) hasPendingLocalPush = true; });
            faults.forEach(f => { if (f?.pendingInitialUpload || f?.techReport?.needsMainSync || f?.techNav?.needsMainSync) hasPendingLocalPush = true; });

            if (cloudOutKeys.size > 0 || locEntry) {
                outages = outages.filter(o => {
                    if (!isAdmin && !canCurrentUserSeeJob(o)) return false;
                    if (cloudOutKeys.has(o.dateTimeSaved)) return true;
                    if (o.pendingInitialUpload || o.techReport?.needsMainSync || o.techNav?.needsMainSync || (nowMs - (o.createdAtMs || 0) < 60000)) { hasPendingLocalPush = true; return true; }
                    return false;
                });
            }
            if (cloudFltKeys.size > 0 || locEntry) {
                faults = faults.filter(f => {
                    if (!isAdmin && !canCurrentUserSeeJob(f)) return false;
                    if (cloudFltKeys.has(f.timestamp)) return true;
                    if (f.pendingInitialUpload || f.techReport?.needsMainSync || f.techNav?.needsMainSync || (nowMs - (f.createdAtMs || 0) < 60000)) { hasPendingLocalPush = true; return true; }
                    return false;
                });
            }

            outages.sort((a, b) => parseOutageDateTimeToMs(b) - parseOutageDateTimeToMs(a));
            faults.sort((a, b) => parseMainDateMs(b.timestamp) - parseMainDateMs(a.timestamp));
            outages = outages.slice(0, 300);
            faults = faults.slice(0, 300);

            const nextOutStr = JSON.stringify(outages), nextFltStr = JSON.stringify(faults);
            if (nextOutStr !== prevOutRaw || nextFltStr !== prevFltRaw) {
                localStorage.setItem('elecReportsComplete_all', nextOutStr);
                localStorage.setItem('fault_reports_all', nextFltStr);
                loadOutageHistory(); loadFaultHistory(); autoFillJobNo(false);
            } else {
                autoFillJobNo(false);
            }
            const stEl = document.getElementById('topSyncText');
            if (stEl) stEl.textContent = `ซิงค์ข้อมูลประวัติและใบงานล่าสุดเรียบร้อย! (${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น.)`;
            if (hasPendingLocalPush && !isViewerRole()) setTimeout(() => syncJobsWithFieldPage(data.jobs), 300);

            Core.updateUserOnlineHeartbeat('💻 หน้าหลัก', null, false);
            updateOnlineCountUI();
            renderNavEtaBadgesInMainHistory();
        } catch (e) {}
    }

    // ========================================================================
    // 13. สำรอง/กู้คืนไฟล์ JSON (รวมแผนงาน PM ครบ 100%), จัดการคลาวด์ & เชื่อมผังวงจร SCADA
    // ========================================================================
    function performAutoBackupSnapshot() {
        try {
            const snap = {
                timestamp: new Date().toISOString(),
                fault_reports_all: Core.rawStorageGet('fault_reports_all') || '[]',
                elecReportsComplete_all: Core.rawStorageGet('elecReportsComplete_all') || '[]',
                overdue_ca_list: Core.rawStorageGet('overdue_ca_list') || '[]',
                elec_pm_calendar_plans_v1: Core.rawStorageGet('elec_pm_calendar_plans_v1') || '[]',
                stationList_custom: JSON.stringify(stationsList),
                tambonCoordinates_custom: JSON.stringify(targetTambonCoordinates),
                issueList_custom: JSON.stringify(issueList),
                fuse_multiplier: Core.rawStorageGet('fuse_multiplier') || '1.5',
                meter_form_link: getConfiguredMeterFormBaseUrl()
            };
            localStorage.setItem('elec_app_auto_backup_snapshot', JSON.stringify(snap));
            localStorage.setItem('last_auto_backup_time', String(Date.now()));
        } catch (e) {}
    }

    function openBackupModal() {
        document.getElementById('backupModal')?.classList.remove('hidden');
        const box = document.querySelector('#backupModal .p-5.space-y-4');
        if (box) {
            let m = document.getElementById('storageUsageMeterBox');
            if (!m) { m = document.createElement('div'); m.id = 'storageUsageMeterBox'; m.className = 'bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm space-y-2'; box.insertBefore(m, box.firstChild); }
            const st = Core.getStorageUsageStats();
            const idbTag = parseFloat(st.idbMb || '0') > 0 ? ` • IndexedDB ${st.idbMb} MB` : '';
            m.innerHTML = `<div class="flex justify-between text-xs font-bold"><span>📊 ความจำเบราว์เซอร์</span><span>${st.usedMb} / ${st.maxMb} MB (${st.pct}%)${idbTag}</span></div><div class="w-full bg-slate-200 h-2 rounded-full overflow-hidden"><div class="bg-emerald-500 h-full" style="width:${Math.max(3, st.pct)}%"></div></div><div class="flex justify-end"><button type="button" onclick="PeaCore.cleanTemporaryCacheSafe()" class="text-[11px] bg-slate-100 px-2.5 py-1 rounded-lg font-semibold">🧹 ล้างแคชชั่วคราว</button></div>`;
        }
    }
    function closeBackupModal() { document.getElementById('backupModal')?.classList.add('hidden'); }

    function exportBackupJson() {
        const data = {
            fault_reports_all: JSON.parse(Core.rawStorageGet('fault_reports_all') || '[]'),
            elecReportsComplete_all: JSON.parse(Core.rawStorageGet('elecReportsComplete_all') || '[]'),
            overdue_ca_list: overdueCaList,
            stationList_custom: stationsList,
            tambonCoordinates_custom: targetTambonCoordinates,
            issueList_custom: issueList,
            elec_labeled_places_list: JSON.parse(Core.rawStorageGet('elec_labeled_places_list') || '[]'),
            elec_deleted_labeled_places_map: JSON.parse(Core.rawStorageGet('elec_deleted_labeled_places_map') || '{}'),
            elec_deleted_equip_audit_logs: JSON.parse(Core.rawStorageGet('elec_deleted_equip_audit_logs') || '[]'),
            elec_pm_calendar_plans_v1: JSON.parse(Core.rawStorageGet('elec_pm_calendar_plans_v1') || '[]'),
            elec_paste_strip_words: stripWordsList,
            elec_paste_strip_rules: stripRules
        };
        const blobUrl = URL.createObjectURL(new Blob([JSON.stringify({ version: '6.5', exportDate: new Date().toISOString(), data }, null, 2)], { type: 'application/json;charset=utf-8' }));
        const a = document.createElement('a'); a.href = blobUrl; a.download = `Electrical_Tools_Backup_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 3000);
        showToast('📦 ดาวน์โหลดไฟล์สำรองสำเร็จ!');
    }

    function reviveRestoredBackupRecords(rawMap, isStringValues = false) {
        const nowMs = Date.now(), nowIso = new Date(nowMs).toISOString();
        const parseVal = (v) => { if (v === undefined || v === null) return null; if (!isStringValues) return v; try { return JSON.parse(v); } catch (e) { return null; } };
        const delJobs = getDeletedJobsRegistry();
        const outs = parseVal(rawMap.elecReportsComplete_all);
        if (Array.isArray(outs)) {
            outs.forEach(o => { if (o?.dateTimeSaved) { delete delJobs[o.dateTimeSaved]; o.pendingInitialUpload = true; o.restoredAtMs = nowMs; o.editedAt = nowIso; } });
            rawMap.elecReportsComplete_all = isStringValues ? JSON.stringify(outs) : outs;
        }
        const flts = parseVal(rawMap.fault_reports_all);
        if (Array.isArray(flts)) {
            flts.forEach(f => { if (f?.timestamp) { delete delJobs[f.timestamp]; f.pendingInitialUpload = true; f.restoredAtMs = nowMs; f.editedAt = nowIso; } });
            rawMap.fault_reports_all = isStringValues ? JSON.stringify(flts) : flts;
        }
        Core.rawStorageSet('elec_deleted_jobs_registry', JSON.stringify(delJobs));

        const pins = parseVal(rawMap.elec_labeled_places_list);
        if (Array.isArray(pins)) {
            const delPins = parseVal(rawMap.elec_deleted_labeled_places_map) || JSON.parse(Core.rawStorageGet('elec_deleted_labeled_places_map') || '{}');
            pins.forEach(p => { if (p?.id) { delete delPins[p.id]; p.updatedAt = nowIso; } });
            Core.rawStorageSet('elec_deleted_labeled_places_map', JSON.stringify(delPins));
            rawMap.elec_deleted_labeled_places_map = isStringValues ? JSON.stringify(delPins) : delPins;
            rawMap.elec_labeled_places_list = isStringValues ? JSON.stringify(pins) : pins;
        }

        const pmPlans = parseVal(rawMap.elec_pm_calendar_plans_v1);
        if (Array.isArray(pmPlans) && pmPlans.length > 0) {
            const myGrp = normGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง', pmKey = '__PM_SCHEDULE__' + myGrp;
            const locMap = getTechLocationsMap(), pmPlansMap = { ...(locMap[pmKey]?.pmPlansMap || {}) };
            pmPlans.forEach(p => { const pid = p?.id || p?.planId; if (pid) { p.id = pid; p.updatedAt = nowIso; pmPlansMap[pid] = p; } });
            locMap[pmKey] = { ...(locMap[pmKey] || {}), isSystemRegistry: true, group: myGrp, pmPlansMap, updatedAt: nowIso, lastSeenAt: nowIso };
            localStorage.setItem('elec_tech_locations_map', JSON.stringify(locMap));
            rawMap.elec_pm_calendar_plans_v1 = isStringValues ? JSON.stringify(pmPlans) : pmPlans;
        }
    }

    function importBackupJson(event) {
        if (!guardNotViewer()) return;
        const f = event.target.files?.[0]; if (!f) return;
        const r = new FileReader();
        r.onload = e => {
            try {
                const parsed = JSON.parse(e.target.result), d = parsed.data || parsed;
                showCustomConfirm('⚠️ ยืนยันการกู้คืนข้อมูลทับข้อมูลปัจจุบันหรือไม่?', async () => {
                    if (d.overdue_ca_list === undefined && d.elec_ca_overdue_list !== undefined) d.overdue_ca_list = d.elec_ca_overdue_list;
                    reviveRestoredBackupRecords(d, false);
                    ['elec_deleted_labeled_places_map', 'elec_labeled_places_list', 'elec_deleted_equip_audit_logs', 'elec_pm_calendar_plans_v1', 'fault_reports_all', 'elecReportsComplete_all', 'overdue_ca_list', 'stationList_custom', 'tambonCoordinates_custom', 'issueList_custom', 'elec_paste_strip_words', 'elec_paste_strip_rules'].forEach(k => {
                        if (d[k] !== undefined) localStorage.setItem(k, JSON.stringify(d[k]));
                    });
                    await syncJobsWithFieldPage(); setTimeout(() => location.reload(), 600);
                }, '📂 ยืนยันการกู้คืนข้อมูล');
            } catch (err) { showCustomAlert('❌ ไฟล์สำรองไม่ถูกต้อง'); }
            event.target.value = '';
        };
        r.readAsText(f);
    }

    function restoreFromAutoBackup() {
        if (!guardNotViewer()) return;
        const s = Core.rawStorageGet('elec_app_auto_backup_snapshot'); if (!s) return showCustomAlert('❌ ไม่พบข้อมูลสำรองอัตโนมัติ');
        const snap = JSON.parse(s);
        showCustomConfirm(`ยืนยันกู้คืนจากตัวสำรองอัตโนมัติ (${new Date(snap.timestamp).toLocaleString('th-TH')}) หรือไม่?`, async () => {
            reviveRestoredBackupRecords(snap, true);
            Object.entries(snap).forEach(([k, v]) => { if (k !== 'timestamp') localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); });
            await syncJobsWithFieldPage(); setTimeout(() => location.reload(), 600);
        });
    }

    function injectCloudManagerHeaderButton() {
        const hdr = document.querySelector('#mainAppContent .bg-gradient-to-r .flex.items-center.gap-1\\.5.shrink-0'); if (!hdr) return;
        let btn = document.getElementById('cloudDataManageBtn');
        if (!btn) {
            btn = document.createElement('button'); btn.type = 'button'; btn.id = 'cloudDataManageBtn'; btn.onclick = openBackupModal;
            btn.className = 'hidden bg-sky-500/90 hover:bg-sky-600 text-white px-2.5 py-1.5 rounded-xl text-xs transition shadow-sm items-center gap-1 font-semibold';
            btn.innerHTML = '☁️ <span>คลาวด์</span>';
            hdr.insertBefore(btn, hdr.querySelector('button[onclick="openBackupModal()"]'));
        }
        const ok = canCurrentUserEditScada(); btn.classList.toggle('hidden', !ok); btn.classList.toggle('flex', ok);
    }

    function getVisibleScadaPinsInMain() {
        const myGrp = normGrp(getCurrentUserGroup() || 'กฟส.บึง'), delMap = JSON.parse(Core.rawStorageGet('elec_deleted_labeled_places_map') || '{}');
        return JSON.parse(Core.rawStorageGet('elec_labeled_places_list') || '[]').filter(p => p?.id && !delMap[p.id] && (isCurrentUserAdmin() || normGrp(p.ownerGroup || 'กฟส.บึง') === myGrp));
    }
    function syncScadaPinsIntoAutocomplete() { const pins = getVisibleScadaPinsInMain(); if (pins.length) saveEquipmentHistory(pins.map(p => `${p.name}${p.scadaNode?.id ? ` (ID ${p.scadaNode.id})` : ''}`)); }

        function checkAndRenderFormScadaWarnings() {
        const box = document.getElementById('scadaFormLiveAlertBox'); if (!box) return;
        const inputs = [['อุปกรณ์เห็นฟอลต์', document.getElementById('deviceInput')?.value], ['ปลดอุปกรณ์', document.getElementById('disconnectDeviceInput')?.value], ['จ่ายไฟชนอุปกรณ์', document.getElementById('powerUpToDeviceInput')?.value]].filter(([, v]) => v && v.trim() && v.trim() !== '-');
        if (!inputs.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
        const pins = getVisibleScadaPinsInMain(), htmls = [];
        inputs.forEach(([role, val]) => {
            const q = val.replace(/(?:\(\s*ID\s*[^)]+\)|\[\s*ID\s*[^\]]+\])/i, '').trim().toLowerCase(), p = pins.find(x => String(x.name || '').trim().toLowerCase() === q);
            if (!p) return;
            const nd = p.scadaNode || {}, gpsUrl = `https://www.google.com/maps?q=${Number(p.lat).toFixed(6)},${Number(p.lon).toFixed(6)}`;
            const hasLoto = Boolean(nd.loto && String(nd.loto).trim());
            const boxCls = hasLoto ? 'bg-red-50 border-red-400 ring-1 ring-red-300' : ((nd.lk || nd.st === 'F') ? 'bg-rose-50 border-rose-300' : 'bg-teal-50/80 border-teal-200');
            const lotoHtml = hasLoto ? `<div class="text-red-700 font-extrabold">🔒 ติดป้ายห้ามสับไฟ (LOTO): "${escapeHtmlStr(nd.loto)}"${nd.lotoBy ? ` • 👷 ${escapeHtmlStr(nd.lotoBy)}` : ''}</div>` : '';
            htmls.push(`<div class="p-2.5 rounded-xl border ${boxCls} text-xs space-y-0.5"><div class="flex justify-between gap-2"><span class="font-bold text-slate-800">⚡ ${escapeHtmlStr(role)}: <b class="text-teal-800">${escapeHtmlStr(p.name)}</b> ${nd.id ? `[ID ${escapeHtmlStr(nd.id)}]` : ''}</span><button type="button" onclick="applyScadaSwitchGpsToTab1('${gpsUrl}')" class="bg-white text-blue-700 border border-blue-200 px-2 py-0.5 rounded-lg text-[10px] font-bold">📍 ใช้พิกัดจุดนี้</button></div>${lotoHtml}${nd.lk ? `<div class="text-rose-700 font-extrabold">🚨 คำเตือน Interlock: ${escapeHtmlStr(nd.lk)}</div>` : ''}</div>`);
        });
        box.innerHTML = htmls.join(''); box.classList.toggle('hidden', !htmls.length);
    }

    function applyScadaSwitchGpsToTab1(gpsUrl) { const el = document.getElementById('gpsInput'); if (el && gpsUrl) { el.value = gpsUrl; el.dispatchEvent(new Event('input', { bubbles: true })); saveFaultDraft(); showToast('📍 ดึงพิกัดสวิตช์ลงช่อง GPS แล้ว'); } }

    let lastScadaPktTs = 0;
    function handleIncomingScadaFormFill(pkt) {
        if (!pkt || pkt.type !== 'SCADA_FILL_FAULT_FORM' || isViewerRole() || (pkt.ts && pkt.ts === lastScadaPktTs)) return;
        lastScadaPktTs = pkt.ts || Date.now(); switchTab('tab1');
        const sys = document.getElementById('systemSelect'); if (sys && !sys.value) { sys.value = '22kV'; updateCircuitDropdown(); }
        const mapId = { device: 'deviceInput', disconnect: 'disconnectDeviceInput', powerup: 'powerUpToDeviceInput' }[pkt.fieldRole];
        const targetEl = mapId ? document.getElementById(mapId) : null;
        if (targetEl && pkt.code) {
            targetEl.value = pkt.code;
            const pUpEl = document.getElementById('powerUpToDeviceInput');
            const pTimeEl = document.getElementById('powerUpTimeInput');
            if (pkt.fieldRole === 'disconnect' && pUpEl) pUpEl.value = pkt.code;
            if (pkt.fieldRole === 'powerup' && pTimeEl && !pTimeEl.value.trim()) { const n = new Date(); pTimeEl.value = `${String(n.getHours()).padStart(2, '0')}.${String(n.getMinutes()).padStart(2, '0')} น.`; }
            saveEquipmentHistory([pkt.code]);
        }
        const gEl = document.getElementById('gpsInput'); if (gEl && pkt.gps && (pkt.fieldRole === 'device' || !gEl.value.trim())) { gEl.value = pkt.gps; gEl.dispatchEvent(new Event('input', { bubbles: true })); }
        checkAndRenderFormScadaWarnings(); saveFaultDraft(); showToast(`⚡ กรอก "${pkt.code}" ลงฟอร์มรายงานเหตุแล้ว!`);
    }

    function openScadaCadImportModal() { if (!guardNotViewer()) return; const b = document.getElementById('scadaCadImportGroupBadge'); if (b) b.textContent = normGrp(getCurrentUserGroup() || 'กฟส.บึง'); document.getElementById('scadaCadImportModal')?.classList.remove('hidden'); }
    function closeScadaCadImportModal() { document.getElementById('scadaCadImportModal')?.classList.add('hidden'); }
    async function processScadaCadBatchImport() {
        if (!guardNotViewer()) return;
        const raw = (document.getElementById('scadaCadRawTextInput')?.value || '').trim(); if (!raw) return showToast('⚠️ กรุณาวางข้อมูลตารางสวิตช์ก่อนกดนำเข้า');
        const myGrp = normGrp(getCurrentUserGroup() || 'กฟส.บึง') || 'กฟส.บึง', curUser = (Core.rawStorageGet('elec_app_current_user') || 'admin').trim(), nowIso = new Date().toISOString();
        const pins = JSON.parse(Core.rawStorageGet('elec_labeled_places_list') || '[]');
        const delMap = JSON.parse(Core.rawStorageGet('elec_deleted_labeled_places_map') || '{}');
        let added = 0, updated = 0, delChanged = false;

        raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach((line, idx) => {
            if (idx === 0 && /lat|lon|รหัส|name/i.test(line)) return;
            const cols = line.includes('\t') ? line.split('\t').map(c => c.trim()) : line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
            const code = cols[0];
            let lat = parseFloat(cols[1]), lon = parseFloat(cols[2]); if (!code || isNaN(lat) || isNaN(lon)) return;
            if (lat > 90 && lon < 90) { const t = lat; lat = lon; lon = t; }
            let eqT = (cols[3] || '').toUpperCase().trim();
            if (!['PIN', 'TAP', 'TR', 'VS', 'VSC', 'S', 'DF', 'RC', 'CB', 'VB', 'GEN'].includes(eqT)) {
                eqT = /\bCB\b|^CB|RC/i.test(code) ? 'RC' : (/VB/i.test(code) ? 'VB' : (/DF|FCO/i.test(code) ? 'DF' : (/\bTR\b|หม้อแปลง/i.test(code) ? 'TR' : (/VS-?\d+/i.test(code) ? 'VS' : (/S-?\d+/i.test(code) ? 'S' : 'VS')))));
            }
            if (eqT === 'CB') eqT = 'RC';

            const scId = (cols[4] || '').replace(/^ID\s*/i, '').trim(), fd = (cols[5] || '').toUpperCase().trim();
            const rawSt = (cols[6] || 'C').trim();
            const st = /^(?:F|FAULT|TRIP|ทริป)/i.test(rawSt) ? 'F' : (/^(?:O|OPEN|ปลด)/i.test(rawSt) ? 'O' : 'C');
            const pinColor = st === 'F' ? 'red' : (st === 'O' ? 'yellow' : 'green');
            const nodeHex = st === 'F' ? '#ef4444' : (st === 'O' ? '#eab308' : '#10b981');
            const lk = (cols.slice(7).join(', ') || '').trim();
            const scadaNode = { t: eqT, st, col: nodeHex, ...(scId ? { id: scId } : {}), ...(fd ? { fd } : {}), ...(lk ? { lk } : {}) };
            const exIdx = pins.findIndex(p => normGrp(p?.ownerGroup || 'กฟส.บึง') === myGrp && String(p?.name || '').toLowerCase() === code.toLowerCase());
            if (exIdx !== -1) {
                if (delMap[pins[exIdx].id]) { delete delMap[pins[exIdx].id]; delChanged = true; }
                const prevNd = pins[exIdx].scadaNode || {};
                const mergedNd = {
                    ...scadaNode,
                    ...(prevNd.loto ? { loto: prevNd.loto, ...(prevNd.lotoBy ? { lotoBy: prevNd.lotoBy } : {}), ...(prevNd.lotoAt ? { lotoAt: prevNd.lotoAt } : {}) } : {})
                };
                if (prevNd.loto && mergedNd.st === 'C') mergedNd.st = 'O';
                pins[exIdx] = { ...pins[exIdx], name: code, lat, lon, pinColor: prevNd.loto ? 'yellow' : pinColor, scadaNode: mergedNd, ownerGroup: myGrp, updatedAt: nowIso };
                updated++;
            } else {
                pins.unshift({ id: 'eqp_' + Date.now() + '_' + idx, name: code, note: lk, lat, lon, pinColor, scadaNode, ownerGroup: myGrp, ownerUser: curUser, updatedAt: nowIso });
                added++;
            }
        });
        if (!added && !updated) return showToast('❌ ไม่พบข้อมูลพิกัดที่ถูกต้อง');
        Core.unlockCloudWrite(20000);
        if (delChanged) localStorage.setItem('elec_deleted_labeled_places_map', JSON.stringify(delMap));
        localStorage.setItem('elec_labeled_places_list', JSON.stringify(pins));
        syncScadaPinsIntoAutocomplete(); closeScadaCadImportModal(); document.getElementById('scadaCadRawTextInput').value = '';
        await syncJobsWithFieldPage(); showToast(`✅ นำเข้าผัง SCADA สำเร็จ (ใหม่ ${added}, อัปเดต ${updated})`);
    }

    // ========================================================================
    // 14. ส่งออกฟังก์ชันสู่ Global & เริ่มต้นระบบเมื่อหน้าเว็บโหลดเสร็จสมบูรณ์
    // ========================================================================
    Object.assign(window, {
        handleLogin, handleLogout, triggerAutoLogout, checkLoginStatus, verifyActiveSessionRole,
        openLeftWebBrowser, closeLeftWebBrowser, navigateLeftBrowser, reloadLeftBrowser, pasteClipboardToLeftBrowser,
        addLeftBrowserBookmark, removeLeftBrowserBookmark, openLeftBrowserPopup, setLeftBrowserWidth, loadLeftBrowserUrl, openScadaDiagramWorkspace,
        openUserManageModal, closeUserManageModal, fetchUserAccountsFromCloud, saveUserAccounts, onNewAccountGroupSelectChange,
        addUserAccount, editUserAccount, deleteUserAccount, renderUserAccountList, toggleUserGroupSection, toggleCollapseAllUserGroups, prefillGroupForNewAccount, renameEntireUserGroup,
        openOnlineUsersModal, triggerManualPresenceSync, switchTab, setTimeInputToNow, updateCircuitDropdown,
        openStationManageModal, closeStationManageModal, toggleStationDropdown, selectStation, addStation, editStation, deleteStation,
        openTambonManageModal, closeTambonManageModal, toggleTambonDropdown, selectTambon, addTambon, editTambon, deleteTambon,
        onTambonChanged, onWeatherManualChange, manualRefreshWeather, fetchLiveWeatherForTambon,
        openIssueManageModal, closeIssueManageModal, toggleIssueDropdown, selectIssueType, addIssueItem, editIssueItem, deleteIssueItem,
        showSuggestionsData, startVoiceInput, saveAndCopyFault, confirmResetFaultForm, resetFaultForm, loadFaultHistory, editFaultItem, copyFaultAgain, deleteFaultItem,
        openMeterLinkModal, closeMeterLinkModal, saveMeterLink, openMeterFormFromCurrentTab2, openMeterFormForOutageItem, buildMeterFormUrlFromData, getConfiguredMeterFormBaseUrl,
        openApiKeyModal, closeApiKeyModal, saveApiKey, sendChatMessage, startChatVoiceInput,
        autoFillJobNo, generateOutageMessage, saveOutageData, confirmResetOutageForm, resetOutageForm, loadOutageHistory, editOutageItem, copyOutageAgain, deleteOutageItem,
        openCaManageModal, closeCaManageModal, addCaNumber, deleteCaNumber, clearAllCaNumbers, renderCaModalList, checkCaOverdueEnhanced, reloadOverdueCaFromStorage, syncCaAndStripBadges,
        openStripWordsModal, closeStripWordsModal, onChangeStripRule, toggleStripWholeLineMode, addStripWordItem, deleteStripWordItem, editStripWordItem, clearAllStripWords, renderStripWordsList, clearAutoFillPasteBox, processCustomerPasteData,
        addTxRow, saveMultiplierSetting, calculateFuseCalc, toggleCustomDateFilter, loadAnalyticsData, exportData, exportAnalyticsToExcel,
        openBackupModal, closeBackupModal, exportBackupJson, importBackupJson, restoreFromAutoBackup,
        quickCloseJobFromMainHistory, stopEquipNavFromMainPage, renderNavEtaBadgesInMainHistory, syncJobsWithFieldPage, pullFieldReportsFromCloud,
        openScadaCadImportModal, closeScadaCadImportModal, processScadaCadBatchImport, applyScadaSwitchGpsToTab1,
        updateMapPreview, updateMapPreviewTab1, fetchPlaceNameFromCoords, handleAreaAutoFill, saveFaultDraft, saveOutageDraft
    });

    Core.onRealtimeChange(keys => {
        if (keys.some(k => k === 'elecReportsComplete_all' || k.includes('jobs_registry'))) { loadOutageHistory(); autoFillJobNo(false); }
        if (keys.some(k => k === 'fault_reports_all' || k.includes('jobs_registry'))) loadFaultHistory();
        if (keys.some(k => k === 'elec_tech_locations_map' || k.includes('equip_nav') || k.includes('cancelled'))) renderNavEtaBadgesInMainHistory();
        if (keys.includes('elec_labeled_places_list')) { syncScadaPinsIntoAutocomplete(); checkAndRenderFormScadaWarnings(); }
        if (keys.includes('overdue_ca_list') || keys.includes('elec_ca_overdue_list')) { reloadOverdueCaFromStorage(); renderCaModalList(); checkCaOverdueEnhanced(true); }
    });

    window.addEventListener('message', e => { if (e.data?.type === 'SCADA_FILL_FAULT_FORM') handleIncomingScadaFormFill(e.data); });
    try { if ('BroadcastChannel' in window) new BroadcastChannel(SCADA_BRIDGE_CHANNEL).onmessage = e => { if (e.data?.type === 'SCADA_FILL_FAULT_FORM') handleIncomingScadaFormFill(e.data); }; } catch (e) {}

    window.addEventListener('DOMContentLoaded', () => {
        // อัปเกรดลิงก์ใบมิเตอร์จาก Google Forms เปล่าเดิม มาเป็นใบรายงานมิเตอร์ในระบบอัตโนมัติ
        if (Core.rawStorageGet('meter_form_link') === LEGACY_GOOGLE_METER_LINK) {
            localStorage.setItem('meter_form_link', getBuiltInMeterFormBaseUrl());
        }
        const meterCfgBtn = document.querySelector('button[onclick="openMeterLinkModal()"]');
        if (meterCfgBtn && !document.getElementById('quickOpenMeterFormTab2Btn')) {
            const qBtn = document.createElement('button');
            qBtn.type = 'button';
            qBtn.id = 'quickOpenMeterFormTab2Btn';
            qBtn.onclick = openMeterFormFromCurrentTab2;
            qBtn.className = 'text-xs bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 px-2 py-1 rounded font-semibold';
            qBtn.textContent = '📄 เปิดใบมิเตอร์';
            qBtn.title = 'เปิดใบรายงานมิเตอร์ชำรุดพร้อมกรอกข้อมูลจากฟอร์มปัจจุบัน';
            meterCfgBtn.insertAdjacentElement('beforebegin', qBtn);
        }

        renderMainHomeIconPng(); clearStuckEditModes();
        initStations(); initTambonData(); initIssues(); initOverdueCaAndStripSettings();
        checkLoginStatus();
if (Core.rawStorageGet('elec_app_logged_in') === 'true') fetchUserAccountsFromCloud(true);
 startRealtimeWeatherStream();

        const savedMult = Core.rawStorageGet('fuse_multiplier');
        if (savedMult && document.getElementById('multiplier-input')) document.getElementById('multiplier-input').value = savedMult;

        const pasteEl = document.getElementById('rawCustomerPasteInput');
        if (pasteEl) pasteEl.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.max(76, this.scrollHeight) + 'px'; processCustomerPasteData(this.value); });

        const addrEl = document.getElementById('address');
        if (addrEl) addrEl.addEventListener('input', function () {
            const r = extractAndRemoveGoogleMapLinks(this.value);
            if (r.extractedUrl) { const g = document.getElementById('gps'); g.value = r.extractedUrl; g.dispatchEvent(new Event('input', { bubbles: true })); this.value = r.cleanedText.trim(); }
            checkCaOverdueEnhanced(false); this.style.height = 'auto'; this.style.height = this.scrollHeight + 'px'; saveOutageDraft();
        });

        let gT2 = null, gT1 = null;
        document.getElementById('gps')?.addEventListener('input', function () { clearTimeout(gT2); const v = this.value.trim(); if (!v) return updateMapPreview(null); gT2 = setTimeout(async () => { const c = extractCoordsFromInput(v) || await resolveGoogleShortLinkUniversal(v); updateMapPreview(c); if (c) { const pl = await fetchPlaceNameFromCoords(c.lat, c.lon); if (pl) handleAreaAutoFill(pl); } }, 600); });
        document.getElementById('gpsInput')?.addEventListener('input', function () { clearTimeout(gT1); const v = this.value.trim(); if (!v) return updateMapPreviewTab1(null); gT1 = setTimeout(async () => updateMapPreviewTab1(extractCoordsFromInput(v) || await resolveGoogleShortLinkUniversal(v)), 500); });

        ['deviceInput', 'disconnectDeviceInput', 'powerUpToDeviceInput'].forEach(id => document.getElementById(id)?.addEventListener('input', checkAndRenderFormScadaWarnings));
        document.getElementById('timeInput')?.addEventListener('input', e => { if (e.isTrusted) isTimeManuallyEdited = true; });
        document.getElementById('reportDate')?.addEventListener('input', e => { if (e.isTrusted) { isManualShiftOverride = true; isManualJobNoOverride = false; localStorage.setItem(LAST_SHIFT_STATE_KEY, getRealTimeShiftAndDate().shiftStateId); autoFillJobNo(true); saveOutageDraft(); } });
        document.getElementById('shift')?.addEventListener('input', e => { if (e.isTrusted) { isManualShiftOverride = true; isManualJobNoOverride = false; localStorage.setItem(LAST_SHIFT_STATE_KEY, getRealTimeShiftAndDate().shiftStateId); autoFillJobNo(true); saveOutageDraft(); } });

        document.getElementById('jobNo')?.addEventListener('input', e => { if (e.isTrusted) { isManualJobNoOverride = Boolean(String(e.target.value || '').trim()); if (e.target.value) localStorage.removeItem(RESET_LOCK_KEY); saveOutageDraft(); } });
        document.getElementById('sortable-tab1')?.addEventListener('input', saveFaultDraft);
        document.getElementById('sortable-tab2')?.addEventListener('input', saveOutageDraft);

        document.addEventListener('click', ev => {
            [['issueDropdownMenu', 'issueTypeBtn', 'issueType'], ['stationDropdownMenu', 'stationTypeBtn', ''], ['tambonDropdownMenu', 'tambonTypeBtn', '']].forEach(([mId, bId, iId]) => {
                const m = document.getElementById(mId), b = document.getElementById(bId), inp = iId ? document.getElementById(iId) : null;
                if (m && !m.classList.contains('hidden') && !m.contains(ev.target) && !b?.contains(ev.target) && ev.target !== inp) m.classList.add('hidden');
            });
            [['deviceInput', 'suggest-device'], ['disconnectDeviceInput', 'suggest-disconnect'], ['powerUpToDeviceInput', 'suggest-powerup'], ['workerName', 'suggest-worker'], ['area', 'suggest-area'], ['issueType', 'suggest-issue']].forEach(([iId, dId]) => {
                const d = document.getElementById(dId), inp = document.getElementById(iId);
                if (d && !d.classList.contains('hidden') && !d.contains(ev.target) && ev.target !== inp) d.classList.add('hidden');
            });
        });

        if (typeof Sortable !== 'undefined') {
            ['tab1', 'tab2'].forEach(t => {
                const el = document.getElementById('sortable-' + t);
                if (el) new Sortable(el, { handle: '.drag-handle', animation: 150, ghostClass: 'sortable-ghost', dataIdAttr: 'data-id', store: { get: () => (Core.rawStorageGet(t + '-order') || '').split('|').filter(Boolean), set: s => localStorage.setItem(t + '-order', s.toArray().join('|')) } });
            });
        }

        checkShiftTransition(true); restoreFaultDraft(); restoreOutageDraft();
        switchTab(Core.rawStorageGet('last_active_tab') || 'tab1');
        loadFaultHistory(); loadOutageHistory(); autoFillJobNo(false); syncScadaPinsIntoAutocomplete(); pullFieldReportsFromCloud(true);

        const rawPkt = Core.rawStorageGet('elec_scada_form_bridge_pkt');
        if (rawPkt) { localStorage.removeItem('elec_scada_form_bridge_pkt'); try { const p = JSON.parse(rawPkt); if (Date.now() - Number(p.ts || 0) < 120000) handleIncomingScadaFormFill(p); } catch (e) {} }

        setInterval(() => { if (!isTimeManuallyEdited && !editingFaultId && document.activeElement !== document.getElementById('timeInput')) setTimeInputToNow(false); }, 5000);
        setInterval(() => { if (!document.hidden) { checkShiftTransition(false); pullFieldReportsFromCloud(false); } }, 5000);
        setInterval(renderNavEtaBadgesInMainHistory, 1000);
        setInterval(() => { if (!document.hidden && Core.rawStorageGet('elec_app_logged_in') === 'true') fetchUserAccountsFromCloud(true); }, 15000);
    });
})();
// ==================== จบไฟล์ main-app.js (v6.5) ====================