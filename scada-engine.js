// ============================================================================
// ⚡🗺️ PEA SMART GRID — UNIFIED SCADA, AUTOCAD & EQUIPMENT MAP ENGINE v6.0 (scada-engine.js)
// รวมระบบแผนที่อุปกรณ์ ผังวงจร SCADA 9 สัญลักษณ์ ดัดสาย/ย้ายหมุด ซ่อนป้าย T-Tap ลดกระตุก Canvas และโหมดซ้อมสับ-ปลด
// พาทที่ 1 / 4 : Constants, State, Master Styles, UI/Modal Injector, Storage & T-Tap Auto-Heal
// ============================================================================
(function () {
    'use strict';

    const Core = window.PeaCore;
    const STORAGE_KEY_LABELS = 'elec_labeled_places_list';
    const STORAGE_KEY_DELETED_LABELS = 'elec_deleted_labeled_places_map';
    const STORAGE_KEY_DELETED_AUDIT_LOGS = 'elec_deleted_equip_audit_logs';
    const RECENT_COLORS_KEY = 'elec_scada_recent_custom_colors';
    const LOD_MODE_KEY = 'elec_scada_lod_mode';
    const SCADA_BRIDGE_CHANNEL = 'pea_scada_form_bridge_v1';

    const MAX_DELETED_EQUIP_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const AUTO_LABEL_MIN_ZOOM = 15;
    const CARD_PAGE_BATCH = 40;
    const ADAPTIVE_LOD_MIN_PINS = 100;

    const SCADA_LOCK_MSG = '🔒 เฉพาะ "ผู้ใช้งานทั่วไป" และ "แอดมิน" เท่านั้นที่แก้ไขผัง SCADA ได้';
    const SIM_LOCK_MSG = '🧪 ขณะนี้อยู่ในโหมดซ้อมสับ-ปลด กรุณาปิดโหมดซ้อมก่อนแก้ไขข้อมูลผังจริง';
    const VIEWER_LOCK_MSG = '🔒 สิทธิ์ผู้สำรวจ: ดูข้อมูลอย่างเดียว ไม่สามารถเพิ่ม แก้ไข หรือลบข้อมูลได้';

    const ALL_PIN_COLOR_KEYS = ['green', 'yellow', 'orange', 'red', 'blue', 'purple', 'brown'];
    const PIN_KEY_TO_HEX = {
        green: '#10b981', yellow: '#eab308', orange: '#f97316',
        red: '#ef4444', blue: '#0ea5e9', purple: '#8b5cf6', brown: '#a16207'
    };

    const PIN_COLOR_THEMES = {
        green: { key: 'green', name: 'สีเขียว', dot: '🟢', gradient: 'linear-gradient(135deg,#10b981,#047857)', badgeClass: 'bg-emerald-50 text-emerald-800 border-emerald-300', activeBtnClass: 'border-emerald-600 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-500/30 shadow-sm' },
        yellow: { key: 'yellow', name: 'สีเหลือง', dot: '🟡', gradient: 'linear-gradient(135deg,#facc15,#ca8a04)', badgeClass: 'bg-amber-50 text-amber-800 border-amber-300', activeBtnClass: 'border-amber-500 bg-amber-50 text-amber-900 ring-2 ring-amber-400/40 shadow-sm' },
        orange: { key: 'orange', name: 'สีส้ม', dot: '🟠', gradient: 'linear-gradient(135deg,#fb923c,#ea580c)', badgeClass: 'bg-orange-50 text-orange-800 border-orange-300', activeBtnClass: 'border-orange-500 bg-orange-50 text-orange-900 ring-2 ring-orange-400/40 shadow-sm' },
        red: { key: 'red', name: 'สีแดง', dot: '🔴', gradient: 'linear-gradient(135deg,#ef4444,#b91c1c)', badgeClass: 'bg-rose-50 text-rose-800 border-rose-300', activeBtnClass: 'border-rose-600 bg-rose-50 text-rose-900 ring-2 ring-rose-500/30 shadow-sm' },
        blue: { key: 'blue', name: 'สีฟ้า', dot: '🔵', gradient: 'linear-gradient(135deg,#38bdf8,#0284c7)', badgeClass: 'bg-sky-50 text-sky-800 border-sky-300', activeBtnClass: 'border-sky-600 bg-sky-50 text-sky-900 ring-2 ring-sky-500/30 shadow-sm' },
        purple: { key: 'purple', name: 'สีม่วง', dot: '🟣', gradient: 'linear-gradient(135deg,#c084fc,#7e22ce)', badgeClass: 'bg-purple-50 text-purple-800 border-purple-300', activeBtnClass: 'border-purple-600 bg-purple-50 text-purple-900 ring-2 ring-purple-500/30 shadow-sm' },
        brown: { key: 'brown', name: 'สีน้ำตาล', dot: '🟤', gradient: 'linear-gradient(135deg,#a16207,#713f12)', badgeClass: 'bg-amber-100/80 text-amber-950 border-amber-500', activeBtnClass: 'border-amber-800 bg-amber-100/70 text-amber-950 ring-2 ring-amber-700/30 shadow-sm' }
    };

    const QUICK_BAR_COLORS = [
        '#10b981', '#00e676', '#06b6d4', '#0ea5e9', '#2563eb', '#6366f1', '#8b5cf6',
        '#d946ef', '#ec4899', '#ef4444', '#f97316', '#eab308', '#a16207', '#64748b'
    ];

    const CAD_PRESET_PALETTE = [
        { hex: '#10b981', name: 'เขียวมรกต' }, { hex: '#22c55e', name: 'เขียวสด' },
        { hex: '#00e676', name: 'เขียวนีออน CAD' }, { hex: '#84cc16', name: 'เขียวตอง' },
        { hex: '#15803d', name: 'เขียวเข้ม' }, { hex: '#14b8a6', name: 'เขียวมิ้นต์' },
        { hex: '#06b6d4', name: 'ฟ้าไซอัน CAD' }, { hex: '#0ea5e9', name: 'ฟ้าสว่าง' },
        { hex: '#3b82f6', name: 'น้ำเงินสด' }, { hex: '#1d4ed8', name: 'น้ำเงินเข้ม' },
        { hex: '#6366f1', name: 'ครามอินดิโก้' }, { hex: '#8b5cf6', name: 'ม่วงไวโอเล็ต' },
        { hex: '#a855f7', name: 'ม่วงอเมทิสต์' }, { hex: '#7e22ce', name: 'ม่วงเข้ม' },
        { hex: '#d946ef', name: 'บานเย็น CAD' }, { hex: '#ec4899', name: 'ชมพูสด' },
        { hex: '#f43f5e', name: 'ชมพูโรส' }, { hex: '#ef4444', name: 'แดงสด CAD' },
        { hex: '#dc2626', name: 'แดงเข้ม' }, { hex: '#991b1b', name: 'แดงเลือดหมู' },
        { hex: '#f97316', name: 'ส้มสด' }, { hex: '#ea580c', name: 'ส้มอิฐ' },
        { hex: '#f59e0b', name: 'ส้มอำพัน' }, { hex: '#eab308', name: 'เหลืองทอง' },
        { hex: '#facc15', name: 'เหลืองสว่าง CAD' }, { hex: '#a16207', name: 'น้ำตาลทอง' },
        { hex: '#78350f', name: 'น้ำตาลเข้ม' }, { hex: '#475569', name: 'เทาเข้ม CAD' }
    ];

    let scadaBroadcast = null;
    try { if ('BroadcastChannel' in window) scadaBroadcast = new BroadcastChannel(SCADA_BRIDGE_CHANNEL); } catch (e) {}

    // ตัวแปรสถานะหลักของแผนที่และเอนจิน SCADA
    let labeledPlaces = [];
    let deletedLabeledMap = {};
    let deletedEquipAuditLogs = [];
    let clearedAuditLogsTimestamp = parseInt(localStorage.getItem('elec_cleared_audit_logs_ts') || '0', 10);
    let restoredAuditLogIds = new Set(JSON.parse(localStorage.getItem('elec_restored_audit_log_ids') || '[]'));

    let leafletMap = null;
    let scadaCanvasRenderer = null;
    let markersLayer = null;
    let unifiedLinesLayer = null;
    let routeLineLayer = null;
    let drawPreviewLayer = null;
    let jumperPreviewLayer = null;
    let grabLinesLayer = null;
    let gripsLayer = null;
    let liveDragLayer = null;
    let pinMovePreviewLayer = null;
    let pinSelectionLayer = null;
    let techSelfMarker = null;
    let tempLongPressMarker = null;

    const lodPinPool = new Map();
    let markerMapById = {};
    let hiddenByLodCount = 0;
    let lodMode = localStorage.getItem(LOD_MODE_KEY) || 'auto';

    let showAllPinLabels = true;
    let editingEquipPinId = null;
    let currentActiveMainTab = 'jobs';
    let currentPinColorFilter = 'all';
    let isMapFullscreen = false;
    let currentlyOpenPopupPinId = null;
    let lastCheckedDateIsoForSchedule = '';
    let lastRenderedMarkersSig = '';

    let activeMapNav = null;
    let mapNavWatchId = null;
    let mapNavTimerId = null;
    let lastMapRouteCalcMs = 0;

    let cachedTopology = null;
    const renderedEdgePathsMap = new Map();
    let cachedUnderPolylinesPx = [];
    let lastEdgeSnapshotMap = new Map();
    const pinScadaSnapshotCache = new Map();
    let pendingDeletePinId = null;

    let renderTimer = null;
    let grabRebuildTimer = null;
    let syncMarkersRafId = null;
    let zoomAnimClearTimer = null;
    let searchInputDebounceTimer = null;
    let lastMarkerClickTs = 0;
    let lastPinDragEndMs = 0;

    let lazyCardsQueue = [];
    let lazyTotalCount = 0;
    let lazyMountedCount = 0;
    let lazyScrollObserver = null;

    let paletteCtx = { mode: 'toolbar', fromPinId: null, edgeIdx: null, scope: 'connected' };
    let tempPickedHex = localStorage.getItem('elec_scada_last_color') || '#10b981';

    const scadaSettings = {
        showLines: true,
        lineWeight: parseFloat(localStorage.getItem('elec_scada_line_weight') || '1.8'),
        feederFilter: 'ALL',
        antiOverlap: localStorage.getItem('elec_scada_anti_overlap') !== 'false',
        autoJumper: localStorage.getItem('elec_scada_auto_jumper') !== 'false',
        jumperScale: parseFloat(localStorage.getItem('elec_scada_jumper_scale') || '1.0'),
        drawActive: false,
        routeMode: localStorage.getItem('elec_scada_draw_mode') || 'road',
        lineStyle: 'oh',
        sideOffset: parseInt(localStorage.getItem('elec_scada_side_offset') || '0', 10),
        activeFeeder: localStorage.getItem('elec_scada_last_feeder') || 'F1',
        activeColor: localStorage.getItem('elec_scada_last_color') || '#10b981',
        activeSpec: localStorage.getItem('elec_scada_last_spec') || '185 SAC',
        fromPinId: null,
        tempWaypoints: []
    };

    const drawTracker = { undoStack: [], redoStack: [] };
    const moveState = { active: false, subMode: 'grip', orthoSnap: false, selectedRef: null, undoStack: [], dragging: null };
    const pinMoveState = { active: false, snapToWire: true, tapToPlace: true, selectedPinId: null, undoStack: [], dragging: null };
    const simState = { active: false, basePins: [], workingPins: [], steps: [], baseTopo: null, curTopo: null, lastDiff: null, expandedImpactTab: null };

    // ========================================================================
    // 1. สไตล์ชีตหลักของแผนที่อุปกรณ์, สัญลักษณ์ SCADA, โหมดแก้ไข & โหมดซ้อม
    // ========================================================================
    function injectScadaMasterStyles() {
        if (document.getElementById('peaScadaEngineMasterCss')) return;
        const st = document.createElement('style');
        st.id = 'peaScadaEngineMasterCss';
        st.textContent = `
            .labeled-pin-tooltip { background: rgba(15,23,42,0.92); color: #fff; border: 1.5px solid #10b981; border-radius: 0.5rem; padding: 2px 7px; font-family: 'Prompt',sans-serif; font-size: 11px; font-weight: 600; box-shadow: 0 2px 6px rgba(0,0,0,0.25); white-space: nowrap; transition: opacity 0.15s ease; }
            .labeled-pin-tooltip::before { border-top-color: rgba(15,23,42,0.92) !important; }
            #labeledInteractiveMap.hide-pin-tooltips .labeled-pin-tooltip { display: none !important; opacity: 0 !important; pointer-events: none !important; }
            #labeledInteractiveMap.scada-zoom-animating .labeled-pin-tooltip { opacity: 0 !important; transition: none !important; }
            #customAlertModal, #customConfirmModal { z-index: 1450 !important; }
            #toast { z-index: 1500 !important; }

            @media (min-width: 1024px) {
                #techMainApp { max-width: 96vw !important; width: 96vw !important; transition: max-width 0.25s ease, width 0.25s ease; }
                #jobCardsContainer { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 0.85rem !important; max-height: 72vh !important; align-items: stretch !important; }
                #jobCardsContainer > * { margin-top: 0 !important; }
                #jobCardsContainer > button, #jobCardsContainer > div.sticky, #jobCardsContainer > div.text-center { grid-column: 1 / -1 !important; }
                #jobCardsContainer > div.rounded-2xl { display: flex !important; flex-direction: column !important; height: 100% !important; }
                #jobCardsContainer > div.rounded-2xl > div:last-child { margin-top: auto !important; padding-top: 0.65rem !important; }
                #techMainApp #labeledInteractiveMap { height: 76vh !important; min-height: 620px !important; }
            }

            #mapFullscreenContainer.map-is-fullscreen { position: fixed !important; inset: 0 !important; z-index: 900 !important; background: #0f172a !important; padding: 0.75rem !important; display: flex !important; flex-direction: column !important; overflow: hidden !important; }
            #mapFullscreenContainer.map-is-fullscreen > #scadaControlToolbar { flex: 0 0 auto !important; max-height: 38dvh !important; overflow-y: auto !important; }
            #mapFullscreenContainer.map-is-fullscreen > div:not(#scadaControlToolbar) { flex: 1 1 0% !important; min-height: 0 !important; display: flex !important; flex-direction: column !important; }
            #mapFullscreenContainer.map-is-fullscreen #labeledInteractiveMap { flex: 1 1 0% !important; height: 100% !important; min-height: 0 !important; border-radius: 1rem !important; }

            #labeledInteractiveMap .leaflet-popup-pane { z-index: 650 !important; }
            #labeledInteractiveMap .leaflet-popup-content-wrapper { border-radius: 1rem !important; padding: 2px !important; overflow: hidden !important; box-shadow: 0 10px 28px rgba(15,23,42,0.45) !important; }
            #labeledInteractiveMap .leaflet-popup-content { margin: 10px 8px 10px 12px !important; max-height: 215px !important; overflow-y: auto !important; overflow-x: hidden !important; -webkit-overflow-scrolling: touch !important; touch-action: pan-y !important; overscroll-behavior: contain !important; padding-right: 6px !important; }
            #mapFullscreenContainer.map-is-fullscreen #labeledInteractiveMap .leaflet-popup-content { max-height: 62dvh !important; }

            .scada-sym-wrap { position: relative; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; }
            .scada-sym-diamond { width: 17px; height: 17px; transform: rotate(45deg); border-radius: 3px; box-shadow: 0 2px 6px rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
            .scada-sym-circle { width: 19px; height: 19px; border-radius: 9999px; box-shadow: 0 2px 6px rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800; }
            .scada-sym-breaker { width: 22px; height: 22px; border-radius: 5px; box-shadow: 0 0 0 2px rgba(15,23,42,0.75), 0 3px 8px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; font-size: 9.5px; font-weight: 900; letter-spacing: -0.3px; }
            .scada-sym-vb { width: 20px; height: 20px; border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; font-size: 8.5px; font-weight: 900; letter-spacing: -0.3px; }
            .scada-sym-fuse { width: 20px; height: 20px; border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 900; line-height: 1; }
            .scada-sym-knife-wrap { position: relative; width: 32px; height: 22px; display: flex; align-items: center; justify-content: center; }
            .scada-sym-knife { width: 30px; height: 19px; border-radius: 5px; box-shadow: 0 2px 6px rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
            .scada-sym-tap-wrap { position: relative; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; }
            .scada-sym-tap-dot { width: 11px; height: 11px; border-radius: 9999px; box-shadow: 0 0 0 1px rgba(15,23,42,0.45), 0 1px 4px rgba(0,0,0,0.45); transition: transform 0.12s ease; }
            .scada-sym-tap-wrap:hover .scada-sym-tap-dot { transform: scale(1.25); }
            .scada-warn-dot { position: absolute; top: -4px; right: -5px; width: 13px; height: 13px; border-radius: 9999px; background: #f59e0b; color: #0f172a; border: 1.5px solid #fff; font-size: 8px; font-weight: 900; display: flex; align-items: center; justify-content: center; z-index: 5; }
            .scada-tie-badge { position: absolute; bottom: -5px; left: -6px; padding: 0 3px; height: 13px; border-radius: 9999px; background: #0f172a; color: #fde047; border: 1.5px solid #fff; font-size: 8px; font-weight: 900; display: flex; align-items: center; justify-content: center; z-index: 6; }
            .scada-deenergized-pin { opacity: 0.94; }

            #labeledInteractiveMap.scada-draw-cursor, #labeledInteractiveMap.scada-move-pin-selected { cursor: crosshair !important; }
            #labeledInteractiveMap.scada-move-wire-active, #labeledInteractiveMap.scada-move-pin-active .leaflet-marker-icon { cursor: grab !important; touch-action: none !important; }
            #labeledInteractiveMap.scada-move-wire-dragging, #labeledInteractiveMap.scada-move-pin-dragging, #labeledInteractiveMap.scada-move-pin-dragging .leaflet-marker-icon { cursor: grabbing !important; touch-action: none !important; }
            #labeledInteractiveMap .scada-wire-grab-handle { pointer-events: stroke !important; cursor: grab !important; touch-action: none !important; }
            #labeledInteractiveMap.scada-draw-cursor .leaflet-scadaUnifiedLinesPane-pane *, #labeledInteractiveMap.scada-move-wire-active .leaflet-scadaUnifiedLinesPane-pane *, #labeledInteractiveMap.scada-move-wire-active .leaflet-marker-pane *, #labeledInteractiveMap.scada-move-pin-active .leaflet-scadaUnifiedLinesPane-pane * { pointer-events: none !important; }

            .scada-cad-grip-vertex { width: 14px; height: 14px; background: #facc15; border: 2px solid #0f172a; border-radius: 3px; box-shadow: 0 0 0 1.5px #fff, 0 2px 6px rgba(0,0,0,0.55); cursor: move; touch-action: none !important; }
            .scada-cad-grip-vertex.delete-mode { background: #ef4444 !important; border-color: #fff !important; cursor: pointer !important; }
            .scada-cad-grip-mid { width: 14px; height: 14px; background: #0ea5e9; color: #fff; border: 1.5px solid #fff; border-radius: 9999px; box-shadow: 0 2px 6px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 900; cursor: grab; touch-action: none !important; }
            @keyframes scadaPinSelectPulse { 0%, 100% { transform: scale(1); opacity: 0.95; } 50% { transform: scale(1.22); opacity: 0.45; } }
            .scada-pin-selected-ring { width: 38px; height: 38px; border-radius: 9999px; border: 2.5px dashed #22d3ee; background: rgba(34,211,238,0.16); box-shadow: 0 0 12px rgba(34,211,238,0.75); animation: scadaPinSelectPulse 1.3s infinite ease-in-out; pointer-events: none !important; }

            #labeledInteractiveMap.scada-sim-mode-map { box-shadow: inset 0 0 0 3.5px #a855f7, 0 0 18px rgba(168,85,247,0.45) !important; border-radius: 1rem; }
            @keyframes scadaSimPulseGlow { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.72; transform: scale(1.03); } }
            .scada-sim-live-pill { animation: scadaSimPulseGlow 1.8s infinite ease-in-out; }
            .scada-sim-float-badge { pointer-events: none; position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 440; background: linear-gradient(135deg,rgba(88,28,135,0.94),rgba(126,34,206,0.94)); color: #fff; border: 1.5px solid #e9d5ff; padding: 4px 12px; border-radius: 9999px; font-size: 11px; font-weight: 800; box-shadow: 0 4px 14px rgba(88,28,135,0.55); white-space: nowrap; }

            body.role-viewer-readonly .scada-edit-only, body.role-scada-readonly .scada-edit-only, body.scada-sim-active .scada-edit-only,
            body.role-scada-readonly #btnTogglePinMoveMode, body.role-scada-readonly #btnToggleWireMoveMode, body.role-scada-readonly #btnToggleScadaDrawMode,
            body.scada-sim-active #btnTogglePinMoveMode, body.scada-sim-active #btnToggleWireMoveMode, body.scada-sim-active #btnToggleScadaDrawMode,
            body.role-scada-readonly #mapLongPressHintBadge, body.scada-sim-active #mapLongPressHintBadge,
            body.role-scada-readonly #adminBulkPinColorBar, body.scada-sim-active #adminBulkPinColorBar,
            body.role-scada-readonly .equip-real-edit-btn, body.scada-sim-active .equip-real-edit-btn,
            body.role-viewer-readonly .equip-color-quick-row, body.role-scada-readonly .equip-color-quick-row, body.scada-sim-active .equip-color-quick-row { display: none !important; }
        `;
        document.head.appendChild(st);
    }

    // ========================================================================
    // 2. สร้างโครงสร้างแท็บแผนที่อุปกรณ์, แถบเครื่องมือ SCADA & หน้าต่างป๊อปอัปอัตโนมัติ
    // ========================================================================
    function injectScadaModalsAndTabUI() {
        const mainApp = document.getElementById('techMainApp');
        if (mainApp && !document.getElementById('mainViewSwitcher')) {
            const headerEl = mainApp.querySelector('.bg-gradient-to-r');
            const footerEl = mainApp.lastElementChild;
            const jobsWrapper = document.createElement('div');
            jobsWrapper.id = 'jobsMainViewWrapper';
            Array.from(mainApp.children).forEach(ch => { if (ch !== headerEl && ch !== footerEl) jobsWrapper.appendChild(ch); });

            const switcherBar = document.createElement('div');
            switcherBar.id = 'mainViewSwitcher';
            switcherBar.className = 'grid grid-cols-2 gap-2 p-2.5 bg-slate-100 border-b border-slate-200';
            switcherBar.innerHTML = `
                <button type="button" id="mainTabBtn-jobs" onclick="switchTechMainTab('jobs')"><span>📋 รายการใบงานซ่อม</span></button>
                <button type="button" id="mainTabBtn-map" onclick="switchTechMainTab('map')"><span>⚡ แผนที่ อุปกรณ์ ไฟฟ้า</span><span id="mapTabPinCountBadge">0</span></button>`;

            const filterLabels = { all: 'รวม', green: '🟢เขียว', yellow: '🟡เหลือง', orange: '🟠ส้ม', red: '🔴แดง', blue: '🔵ฟ้า', purple: '🟣ม่วง', brown: '🟤น้ำตาล' };
            const filterPillsHtml = ['all', ...ALL_PIN_COLOR_KEYS].map(k =>
                `<button type="button" id="colorFilterBtn-${k}" onclick="selectEquipPinColorFilter('${k}')"><span class="whitespace-nowrap">${filterLabels[k]}</span><span class="text-[10px] opacity-95 whitespace-nowrap">(<span id="countPinColor-${k}">0</span>)</span></button>`
            ).join('');

            const bulkColorBtns = [
                ['green','bg-emerald-600','เขียว'], ['yellow','bg-amber-500','เหลือง'], ['orange','bg-orange-500','ส้ม'],
                ['red','bg-rose-600','แดง'], ['blue','bg-sky-600','ฟ้า'], ['purple','bg-purple-600','ม่วง'], ['brown','bg-amber-800','น้ำตาล']
            ].map(([k, cls, lbl]) => `<button type="button" onclick="bulkChangeAllPinsColor('${k}')" class="${cls} hover:opacity-90 text-white px-2 py-1 rounded-lg text-[10px] font-bold shadow-sm">⚡ ${lbl}</button>`).join('');

            const mapSection = document.createElement('div');
            mapSection.id = 'labeledMapViewWrapper';
            mapSection.className = 'hidden flex-col lg:grid-cols-12 lg:items-start';
            mapSection.innerHTML = `
                <div class="p-3.5 bg-slate-50 border-b border-slate-200 space-y-2.5 lg:col-span-4 lg:col-start-9 lg:row-start-1 lg:border-l lg:border-slate-200">
                    <div class="flex items-center justify-between bg-teal-50/90 border border-teal-200 px-3 py-1.5 rounded-xl text-[11px]">
                        <span class="font-bold text-teal-900 flex items-center gap-1"><span>⚡ แผนที่ อุปกรณ์ ไฟฟ้า</span><span id="currentEquipGroupHeaderBadge" class="bg-teal-700 text-white px-2 py-0.5 rounded-md text-[10px] font-extrabold">-</span></span>
                        <span class="text-[10px] text-teal-700 font-semibold">🔒 เห็นเฉพาะกลุ่มสังกัด</span>
                    </div>
                    <div class="flex gap-1.5 relative">
                        <div class="relative flex-1" id="searchEquipAutocompleteBox">
                            <input type="text" id="searchLabeledPinInput" autocomplete="off" oninput="onSearchEquipInputChange(this.value)" onfocus="onSearchEquipInputChange(this.value)" onkeydown="onSearchEquipKeyDown(event)" placeholder="🔍 พิมพ์ค้นหาชื่อรหัส, อุปกรณ์ไฟฟ้า..." class="w-full px-3.5 py-2 pr-8 text-xs bg-white font-medium">
                            <button type="button" onclick="clearSearchEquipInput()" class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-sm font-bold">&times;</button>
                            <div id="searchEquipDropdown" class="hidden absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-2xl max-h-60 overflow-y-auto z-[600] divide-y divide-slate-100"></div>
                        </div>
                        <button type="button" onclick="focusMapOnSearchMatch()" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-xl text-xs font-bold shadow-sm whitespace-nowrap">🗺️ ค้นหาดู Map</button>
                    </div>
                    <div class="space-y-1">
                        <div class="text-[10px] font-bold text-slate-500 flex items-center justify-between px-0.5"><span>🎨 ตัวกรองแสดงตามสีหมุดสายฟ้า (7 สี):</span><button type="button" onclick="selectEquipPinColorFilter('all')" class="text-teal-700 hover:underline font-bold">แสดงทุกสี</button></div>
                        <div class="grid grid-cols-4 sm:grid-cols-8 lg:grid-cols-4 gap-1" id="equipColorFilterPills">${filterPillsHtml}</div>
                    </div>
                    <div class="flex flex-wrap items-center justify-between gap-1.5">
                        <div class="flex flex-wrap gap-1.5">
                            <button type="button" onclick="openEquipPinModal(null)" class="equip-real-edit-btn bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 rounded-xl text-[11px] font-bold shadow-sm">➕ เพิ่มป้ายกำกับ</button>
                            <button type="button" onclick="document.getElementById('importLabelsFileInput').click()" class="equip-real-edit-btn bg-white hover:bg-slate-100 text-teal-700 border border-teal-300 px-2.5 py-1.5 rounded-xl text-[11px] font-bold">📂 นำเข้าไฟล์</button>
                            <input type="file" id="importLabelsFileInput" accept=".json,.geojson,.kml,.csv" class="hidden" onchange="handleImportLabeledFile(event)">
                            <button type="button" onclick="exportLabeledPinsToExcel()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1.5 rounded-xl text-[11px] font-bold shadow-sm">📊 ส่งออก Excel</button>
                            <button type="button" onclick="exportLabeledPinsToJson()" class="bg-sky-600 hover:bg-sky-700 text-white px-2.5 py-1.5 rounded-xl text-[11px] font-bold shadow-sm">📥 ส่งออก JSON</button>
                        </div>
                        <div class="flex items-center gap-1">
                            <button type="button" id="togglePinNamesBtn" onclick="toggleShowAllPinNames()" class="bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 px-2 py-1.5 rounded-xl text-[11px] font-semibold">🏷️ ชื่อรหัส: อัตโนมัติ (ซูม ≥15)</button>
                            <button type="button" onclick="centerMapOnMyGps()" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2.5 py-1.5 rounded-xl text-[11px] font-bold">📍 พิกัดฉัน</button>
                        </div>
                    </div>
                    <div id="adminBulkPinColorBar" class="hidden flex-col gap-2 p-2.5 bg-amber-50/90 border border-amber-300 rounded-xl text-[11px]">
                        <div class="flex flex-wrap items-center justify-between gap-1.5">
                            <span class="font-extrabold text-amber-900">👑 เครื่องมือแอดมิน (Admin):</span>
                            <button type="button" onclick="openDeletedEquipAuditModal()" class="bg-rose-700 hover:bg-rose-800 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold shadow-sm">📜 ประวัติผู้ลบหมุด (<span id="adminDeletedAuditCountBadge">0</span>)</button>
                        </div>
                        <div class="flex flex-wrap items-center gap-1 pt-1 border-t border-amber-200/80"><span class="text-[10px] font-bold text-amber-800 mr-0.5">เปลี่ยนสีทั้งหมด:</span>${bulkColorBtns}</div>
                    </div>
                </div>
                <div class="lg:col-span-8 lg:col-start-1 lg:row-start-1 lg:row-span-2 flex flex-col">
                    <div id="mapActiveNavContainer" class="hidden px-3.5 pt-3">
                        <div class="p-3 bg-blue-50/95 border-2 border-blue-400 rounded-2xl shadow-sm space-y-2 text-xs text-blue-950">
                            <div id="mapActiveNavBody"></div>
                            <div class="flex flex-wrap items-center justify-between gap-1.5 pt-1.5 border-t border-blue-200">
                                <div class="flex flex-wrap gap-1.5">
                                    <button type="button" onclick="openExternalGoogleMapsForActiveNav()" class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1.5 rounded-xl text-[11px] font-bold shadow-sm">🗺️ เปิด Google Maps</button>
                                    <button type="button" onclick="copyActiveNavPinToClipboard()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-2.5 py-1.5 rounded-xl text-[11px] font-bold shadow-sm">📋 คัดลอก</button>
                                    <button type="button" onclick="shareActiveNavPinToLine()" class="bg-[#00B900] hover:bg-[#009900] text-white px-2.5 py-1.5 rounded-xl text-[11px] font-bold shadow-sm">💬 แชร์ LINE</button>
                                    <button type="button" onclick="zoomToActiveNavRoute()" class="bg-white hover:bg-blue-100 text-blue-700 border border-blue-300 px-2.5 py-1.5 rounded-xl text-[11px] font-bold">🔍 ดูเส้นทาง</button>
                                </div>
                                <button type="button" onclick="stopLabeledPlaceNavigation()" class="bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 px-2.5 py-1.5 rounded-xl text-[11px] font-bold">❌ ยกเลิก</button>
                            </div>
                        </div>
                    </div>
                    <div id="mapFullscreenContainer" class="p-3.5 pb-2 lg:p-4 isolate z-10">
                        <div class="relative isolate rounded-2xl overflow-hidden border-2 border-slate-200 shadow-inner bg-slate-100">
                            <div id="labeledInteractiveMap" class="w-full h-[350px] sm:h-[420px] z-0 hide-pin-tooltips"></div>
                            <div id="mapFloatingActionBtns" class="absolute bottom-3 left-3 z-[400] flex flex-wrap items-center gap-1.5">
                                <button type="button" onclick="fitAllLabeledPinsOnMap()" class="bg-white/95 hover:bg-white text-slate-800 border border-slate-300 px-2.5 py-1.5 rounded-xl text-[11px] font-bold shadow-md">🌐 ดูหมุดทั้งหมดในกลุ่ม</button>
                                <button type="button" id="toggleFullscreenMapBtn" onclick="toggleMapFullscreenMode()" class="bg-slate-900/90 hover:bg-slate-900 text-white border border-slate-700 px-2.5 py-1.5 rounded-xl text-[11px] font-bold shadow-md">⛶ ขยายแผนที่เต็มจอ</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="lg:col-span-4 lg:col-start-9 lg:row-start-2 lg:border-l lg:border-slate-200 flex flex-col">
                    <div class="px-4 py-2 bg-white border-b border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span id="labeledListSummaryText" class="font-bold text-teal-800">⚡ อุปกรณ์ไฟฟ้าในกลุ่ม (0)</span>
                        <div class="flex items-center gap-1.5">
                            <select id="sortLabeledPinsSelect" onchange="renderLabeledPlacesList(false)" class="px-2 py-1 text-[11px] font-bold text-slate-700 bg-white border border-slate-300 rounded-lg">
                                <option value="nearest">📏 เรียงตามระยะใกล้ฉันที่สุด</option>
                                <option value="name_asc">🔤 เรียงตามชื่อรหัส ก ➔ ฮ</option>
                            </select>
                            <button type="button" onclick="openClearEquipModal()" class="equip-real-edit-btn bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 px-2.5 py-1 rounded-lg text-[11px] font-bold">🗑️ ล้างข้อมูล</button>
                        </div>
                    </div>
                    <div id="labeledPlacesCardsContainer" class="p-3.5 pt-2 space-y-2.5 max-h-[42vh] lg:max-h-[46vh] overflow-y-auto"></div>
                </div>`;

            mainApp.insertBefore(switcherBar, footerEl);
            mainApp.insertBefore(jobsWrapper, footerEl);
            mainApp.insertBefore(mapSection, footerEl);
        }

        // สร้างหน้าต่างป๊อปอัปทั้งหมดอัตโนมัติ (กรณีไม่ได้เขียนฝังไว้ในไฟล์ HTML)
        const modalColorBtns = [
            ['green','from-emerald-500 to-teal-700','เขียว'], ['yellow','from-amber-400 to-yellow-600','เหลือง'],
            ['orange','from-orange-400 to-orange-600','ส้ม'], ['red','from-rose-500 to-red-700','แดง'],
            ['blue','from-sky-400 to-blue-600','ฟ้า'], ['purple','from-purple-500 to-purple-800','ม่วง'],
            ['brown','from-amber-700 to-yellow-950','น้ำตาล']
        ].map(([k, g, lbl]) => `<button type="button" id="pinColorBtn-${k}" onclick="selectModalPinColor('${k}')" class="py-2 px-1.5 rounded-xl border-2 font-bold text-[11px] flex flex-col items-center gap-1 transition"><span class="w-6 h-6 rounded-full bg-gradient-to-br ${g} text-white flex items-center justify-center shadow-sm text-xs">⚡</span><span>${lbl}</span></button>`).join('');

        const modalsHtml = [
            ['equipPinModal', `<div id="equipPinModal" class="fixed inset-0 bg-slate-900/65 hidden z-[1100] flex items-center justify-center p-3 backdrop-blur-sm"><div class="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90dvh] overflow-hidden flex flex-col"><div class="px-4 py-3 bg-gradient-to-r from-teal-700 to-emerald-600 text-white flex justify-between items-center"><h3 id="equipPinModalTitle" class="font-bold text-sm">⚡ เพิ่มข้อมูลอุปกรณ์ไฟฟ้า</h3><button type="button" onclick="closeEquipPinModal()" class="text-white/80 hover:text-white text-xl font-bold leading-none">&times;</button></div><div class="p-4 space-y-3.5 text-xs overflow-y-auto flex-1"><div class="p-2.5 bg-teal-50 border border-teal-200 rounded-xl text-teal-900 flex items-center justify-between"><span class="font-bold">🏢 กลุ่มผู้ใช้งานที่มีสิทธิ์เห็นข้อมูลนี้:</span><span id="equipModalGroupBadge" class="bg-teal-700 text-white font-extrabold px-2.5 py-0.5 rounded-lg text-[11px]">-</span></div><div><label class="block font-bold text-slate-700 mb-1">🏷️ ชื่อรหัส / ชื่ออุปกรณ์ไฟฟ้า <span class="text-rose-500">*</span></label><input type="text" id="equipCodeNameInput" placeholder="เช่น BNF05VS-107, TR-0125..." class="w-full px-3.5 py-2 text-sm font-semibold text-slate-800"></div><div><div class="flex items-center justify-between mb-1"><label class="block font-bold text-slate-700">📍 พิกัด หรือ ลิงก์ GPS <span class="text-rose-500">*</span></label><button type="button" onclick="fillEquipCurrentGps()" class="text-[11px] bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 px-2.5 py-1 rounded-lg font-bold">📍 ดึงพิกัดมือถือปัจจุบัน</button></div><input type="text" id="equipCoordInput" placeholder="วางพิกัด เช่น 13.1361, 101.0322 หรือลิงก์ maps.app.goo.gl..." class="w-full px-3.5 py-2 text-xs font-medium text-slate-800"><p id="equipShortLinkStatus" class="text-[10px] text-slate-400 mt-1">รองรับทั้งพิกัดตัวเลข ลิงก์เต็ม และลิงก์สั้น maps.app.goo.gl</p></div><div><label class="block font-bold text-slate-700 mb-1.5">🎨 เลือกสีหมุดสายฟ้าเริ่มต้น (7 สี)</label><input type="hidden" id="equipPinColorInput" value="green"><div class="grid grid-cols-4 sm:grid-cols-7 gap-1.5">${modalColorBtns}</div></div><div><label class="block font-bold text-slate-700 mb-1">📝 รายละเอียดเพิ่มเติม / บริเวณ</label><input type="text" id="equipNoteInput" placeholder="เช่น ขนาด 160 kVA, เสาต้นที่ 12..." class="w-full px-3.5 py-2 text-xs text-slate-700"></div><div class="p-3 bg-amber-50/90 border border-amber-200 rounded-xl space-y-2"><div class="flex items-center justify-between"><label class="font-bold text-amber-900 text-xs">⏰ ตั้งวันที่เปลี่ยนสีหมุดอัตโนมัติ (ถ้ามี)</label><button type="button" onclick="document.getElementById('equipDueDateInput').value='';" class="text-[10px] text-rose-600 hover:underline font-bold">✖ ล้างวันที่กำหนด</button></div><div class="grid grid-cols-2 gap-2"><div><label class="block text-[10px] font-semibold text-slate-600 mb-0.5">📅 เมื่อถึงวันที่</label><input type="date" id="equipDueDateInput" class="w-full px-2.5 py-1.5 text-xs bg-white font-semibold text-slate-800"></div><div><label class="block text-[10px] font-semibold text-slate-600 mb-0.5">🎨 ให้เปลี่ยนเป็น</label><select id="equipDueColorInput" class="w-full px-2.5 py-1.5 text-xs bg-white font-bold text-slate-800"><option value="red">🔴 สีแดง</option><option value="orange">🟠 สีส้ม</option><option value="yellow">🟡 สีเหลือง</option><option value="blue">🔵 สีฟ้า</option><option value="purple">🟣 สีม่วง</option><option value="brown">🟤 สีน้ำตาล</option><option value="green">🟢 สีเขียว</option></select></div></div></div></div><div class="p-3 bg-slate-50 border-t flex items-center gap-2"><button type="button" id="deleteEquipPinInModalBtn" onclick="deleteEquipPinFromModal()" class="hidden px-3.5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs shadow">🗑️ ลบหมุด</button><button type="button" onclick="closeEquipPinModal()" class="px-3.5 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl text-xs">ยกเลิก</button><button type="button" id="saveEquipPinSubmitBtn" onclick="saveEquipPinModal()" class="flex-1 bg-teal-600 hover:bg-teal-700 text-white font-bold py-2.5 rounded-xl shadow text-xs sm:text-sm">💾 บันทึกข้อมูล</button></div></div></div>`],
            ['deletedEquipAuditModal', `<div id="deletedEquipAuditModal" class="fixed inset-0 bg-slate-900/65 hidden z-[1100] flex items-center justify-center p-3 backdrop-blur-sm"><div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[88dvh] overflow-hidden flex flex-col"><div class="px-4 py-3 bg-gradient-to-r from-rose-700 to-slate-900 text-white flex justify-between items-center"><h3 class="font-bold text-sm">📜 ประวัติการลบหมุดอุปกรณ์ไฟฟ้า (เฉพาะ Admin)</h3><button type="button" onclick="closeDeletedEquipAuditModal()" class="text-white/80 hover:text-white text-xl font-bold leading-none">&times;</button></div><div class="px-4 py-2 bg-rose-50 border-b border-rose-200 flex justify-between items-center text-[11px] text-rose-900 font-semibold"><span id="deletedEquipAuditSummaryText">รายการที่ถูกลบทั้งหมด 0 รายการ</span><button type="button" onclick="clearDeletedEquipAuditLogs()" class="text-rose-700 hover:underline font-bold">🗑️ ล้างประวัติการลบ</button></div><div id="deletedEquipAuditListContainer" class="p-3.5 overflow-y-auto space-y-2 flex-1 bg-slate-50 text-xs"></div><div class="p-3 bg-white border-t flex justify-end"><button type="button" onclick="closeDeletedEquipAuditModal()" class="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl text-xs font-bold">ปิดหน้าต่าง</button></div></div></div>`],
            ['clearEquipPasswordModal', `<div id="clearEquipPasswordModal" class="fixed inset-0 bg-slate-900/65 hidden z-[1100] flex items-center justify-center p-3 backdrop-blur-sm"><div class="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col"><div class="px-4 py-3 bg-gradient-to-r from-rose-600 to-red-700 text-white flex justify-between items-center"><h3 class="font-bold text-sm">🗑️ ยืนยันการล้างข้อมูลอุปกรณ์ไฟฟ้า</h3><button type="button" onclick="closeClearEquipModal()" class="text-white/80 hover:text-white text-xl font-bold leading-none">&times;</button></div><div class="p-4 space-y-3 text-xs"><p id="clearEquipWarningText" class="text-slate-600 leading-relaxed font-medium"></p><div><label class="block font-bold text-slate-700 mb-1">🔑 รหัสผ่านเข้าใช้งานของคุณ</label><input type="password" id="clearEquipPasswordInput" placeholder="กรอกรหัสผ่าน..." class="w-full px-3.5 py-2 text-center text-base font-extrabold tracking-widest text-rose-700" onkeypress="if(event.key==='Enter') confirmClearAllEquipPins()"></div></div><div class="p-3 bg-slate-50 border-t flex gap-2"><button type="button" onclick="closeClearEquipModal()" class="flex-1 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl text-xs">ยกเลิก</button><button type="button" onclick="confirmClearAllEquipPins()" class="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-bold py-2 rounded-xl shadow text-xs">🗑️ ยืนยันล้างข้อมูล</button></div></div></div>`],
            ['scadaNodeConfigModal', `<div id="scadaNodeConfigModal" class="fixed inset-0 bg-slate-900/70 hidden z-[1250] flex items-center justify-center p-3 backdrop-blur-sm"><div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90dvh]"><div class="px-4 py-3 bg-gradient-to-r from-slate-900 to-teal-800 text-white flex justify-between items-center"><h3 class="font-bold text-sm">⚡ ตั้งค่าสัญลักษณ์และข้อมูล SCADA</h3><button type="button" onclick="closeScadaNodeModal()" class="text-white/80 hover:text-white text-xl font-bold leading-none">&times;</button></div><div class="p-4 space-y-3 text-xs overflow-y-auto flex-1"><div class="flex items-center justify-between gap-2 p-2.5 bg-slate-100 rounded-xl border border-slate-200"><div id="scadaModalPinTitle" class="font-bold text-slate-800 text-sm truncate"></div><button type="button" onclick="autoDetectScadaFieldsFromTitle()" class="shrink-0 bg-teal-600 hover:bg-teal-700 text-white px-2.5 py-1 rounded-lg text-[10px] font-bold">✨ ดึงค่าจากชื่อรหัส</button></div><input type="hidden" id="scadaModalPinId" value=""><div class="grid grid-cols-2 gap-2.5"><div><label class="block font-bold text-slate-700 mb-1">🔣 ประเภทสัญลักษณ์ผัง</label><select id="scadaModalEquipType" class="w-full px-3 py-2 font-bold text-slate-800 bg-white"><option value="PIN">⚡ หมุดสายฟ้า (ทั่วไป)</option><option value="TAP">• หมุดแทปกลมเล็ก (T-Tap)</option><option value="VS">◆ สวิตช์ SCADA (VS / LBS)</option><option value="VSC">● สวิตช์ SCADA (VS / LBS)</option><option value="S">_/  _ สวิตช์ใบมีด Manual (S)</option><option value="DF">&amp; ดร็อปเอาต์ฟิวส์ (DF / FCO)</option><option value="RC">■ เบรกเกอร์ต้นทาง (CB / RC)</option><option value="VB">▣ เบรกเกอร์กลางสาย (VB)</option><option value="GEN">Ⓖ ผู้ผลิตไฟฟ้ารายเล็ก (GEN)</option></select></div><div><label class="block font-bold text-slate-700 mb-1">📟 เลข SCADA ID</label><input type="text" id="scadaModalIdInput" placeholder="เช่น 3419, 513" class="w-full px-3 py-2 font-mono font-bold text-slate-800 bg-white"></div></div><div class="grid grid-cols-2 gap-2.5"><div><label class="block font-bold text-slate-700 mb-1">🚦 สถานะสวิตช์ปัจจุบัน</label><select id="scadaModalStateSelect" class="w-full px-3 py-2 font-bold text-slate-800 bg-white"><option value="C">🟢 สับจ่ายไฟปกติ (NC)</option><option value="O">⚪ ปลด / จุดแบ่งเขต (N.O.)</option><option value="F">🔴 ทริป / ชำรุดห้ามสับ</option></select></div><div><label class="block font-bold text-slate-700 mb-1">🔌 รหัสวงจร / ฟีดเดอร์</label><input type="text" id="scadaModalFeederInput" placeholder="เช่น BNG6, BNF06" class="w-full px-3 py-2 font-bold text-slate-800 bg-white uppercase"></div></div><div><label class="block font-bold text-slate-700 mb-1.5">🎨 สีประจำสัญลักษณ์และวงจร</label><div class="flex flex-wrap items-center gap-2" id="scadaModalColorSwatches"></div><input type="hidden" id="scadaModalColorInput" value="#10b981"></div><div><label class="block font-bold text-rose-700 mb-1">⚠️ คำเตือน Interlock / สภาพชำรุดหน้างาน</label><input type="text" id="scadaModalWarnInput" placeholder="เช่น OFF 87L ก่อนสับขนาน, ใบมีดชำรุดเฟส A" class="w-full px-3 py-2 text-rose-800 font-semibold bg-rose-50/60 border-rose-200"></div></div><div class="p-3 bg-slate-50 border-t flex items-center justify-between gap-2"><button type="button" onclick="resetScadaNodeToDefaultPin()" class="px-3 py-2 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 font-bold rounded-xl text-xs">รีเซ็ตเป็นหมุดปกติ</button><div class="flex gap-2"><button type="button" onclick="closeScadaNodeModal()" class="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded-xl text-xs">ยกเลิก</button><button type="button" onclick="saveScadaNodeModal()" class="px-5 py-2 bg-teal-600 hover:bg-teal-700 text-white font-bold rounded-xl text-xs shadow">💾 บันทึก</button></div></div></div></div>`],
            ['scadaColorPaletteModal', `<div id="scadaColorPaletteModal" class="fixed inset-0 bg-slate-950/75 hidden z-[1350] flex items-center justify-center p-3 backdrop-blur-sm"><div class="bg-slate-900 text-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden border border-slate-700 flex flex-col max-h-[90dvh]"><div class="px-4 py-3 bg-gradient-to-r from-slate-800 to-teal-900 border-b border-slate-700 flex justify-between items-center"><h3 class="font-bold text-sm">🎨 เลือกสีวงจร / อุปกรณ์ SCADA</h3><button type="button" onclick="closeScadaColorPaletteModal()" class="text-slate-300 hover:text-white text-xl font-bold leading-none">&times;</button></div><div class="p-4 space-y-4 text-xs overflow-y-auto flex-1"><div id="scadaV3ScopeSelectorBox" class="hidden p-3 bg-slate-800/95 rounded-xl border border-teal-500/40 space-y-1.5"><div class="text-[11px] font-extrabold text-teal-300">🔗 เลือกขอบเขตการเปลี่ยนสีระบบสายไฟ:</div><div class="grid grid-cols-3 gap-1.5"><button type="button" id="scadaV3ScopeBtn-connected" onclick="setScadaEdgeRecolorScopeV3('connected')">🔗 ทั้งระบบที่เชื่อมต่อ</button><button type="button" id="scadaV3ScopeBtn-all_thru" onclick="setScadaEdgeRecolorScopeV3('all_thru')">🌐 ทะลุจุดปลด N.O.</button><button type="button" id="scadaV3ScopeBtn-single" onclick="setScadaEdgeRecolorScopeV3('single')">📍 เฉพาะท่อนนี้</button></div></div><div class="p-3 bg-slate-800/90 rounded-xl border border-slate-700 space-y-2.5"><div class="flex items-center justify-between gap-2"><span class="font-bold text-slate-300">🌈 ผสมสีเองอิสระ:</span><div class="flex items-center gap-2"><input type="color" id="scadaCustomColorWheel" value="#10b981" oninput="onScadaWheelColorInput(this.value)" class="w-9 h-8 rounded cursor-pointer bg-transparent border-0 p-0"><input type="text" id="scadaCustomHexInput" value="#10B981" maxlength="7" oninput="onScadaHexTextInput(this.value)" class="w-24 px-2.5 py-1.5 rounded-lg bg-slate-950 text-amber-300 border border-slate-600 font-mono font-bold text-xs uppercase text-center"></div></div><div class="flex items-center gap-2.5 pt-1"><span class="text-[11px] text-slate-400 shrink-0">ตัวอย่างเส้น:</span><div class="flex-1 h-6 bg-slate-950 rounded-lg border border-slate-700 flex items-center px-3"><div id="scadaPalettePreviewLine" class="w-full rounded-full" style="height:3px;background:#10b981;"></div></div></div></div><div><div class="font-bold text-slate-300 mb-2 flex items-center justify-between"><span>⚡ สีมาตรฐานผังวงจร &amp; AutoCAD (28 เฉดสี)</span><span id="scadaSelectedColorNameLabel" class="text-[11px] text-teal-300 font-semibold"></span></div><div id="scadaPresetColorsGrid" class="grid grid-cols-7 gap-2"></div></div><div id="scadaRecentColorsSection" class="hidden"><div class="font-bold text-slate-400 mb-1.5 flex items-center justify-between text-[11px]"><span>🕒 สีที่ผสมเอง / ใช้ล่าสุด</span><button type="button" onclick="clearScadaRecentColors()" class="text-rose-400 hover:underline">ล้างถาดสีล่าสุด</button></div><div id="scadaRecentColorsGrid" class="flex flex-wrap gap-2"></div></div></div><div class="p-3 bg-slate-800 border-t border-slate-700 flex justify-end gap-2"><button type="button" onclick="closeScadaColorPaletteModal()" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 font-bold rounded-xl text-xs">ยกเลิก</button><button type="button" onclick="confirmScadaPaletteSelection()" class="px-5 py-2 bg-teal-500 hover:bg-teal-400 text-slate-950 font-extrabold rounded-xl text-xs shadow">✅ ใช้สีนี้</button></div></div></div>`],
            ['scadaSimPlanModal', `<div id="scadaSimPlanModal" class="fixed inset-0 bg-slate-950/75 hidden z-[1380] flex items-center justify-center p-3 backdrop-blur-sm"><div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90dvh] border border-purple-300"><div class="px-4 py-3 bg-gradient-to-r from-purple-900 via-fuchsia-900 to-indigo-900 text-white flex justify-between items-center"><h3 class="font-bold text-sm">📋 แผนลำดับการสับ-ปลดสวิตช์ (Switching Order)</h3><button type="button" onclick="closeScadaSimPlanModal()" class="text-purple-200 hover:text-white text-xl font-bold leading-none">&times;</button></div><div class="p-4 space-y-3 text-xs overflow-y-auto flex-1 bg-slate-50"><div><label class="block font-bold text-slate-700 mb-1">🏷️ หัวข้อแผนปฏิบัติงาน / วงจร</label><input type="text" id="scadaSimPlanTitleInput" oninput="rebuildScadaSimPlanText()" placeholder="เช่น แผนสับเปลี่ยนภาระไฟ วงจร BNF06" class="w-full px-3 py-2 text-xs font-bold text-slate-800 bg-white border border-slate-300 rounded-xl"></div><div class="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2.5 bg-purple-50 border border-purple-200 rounded-xl text-[11px] font-semibold text-purple-950"><label class="flex items-center gap-2 cursor-pointer select-none"><input type="checkbox" id="scadaSimIncludeGpsChk" onchange="rebuildScadaSimPlanText()" class="w-4 h-4 accent-purple-600 rounded"><span>📍 แนบลิงก์ GPS รายจุดสวิตช์</span></label><label class="flex items-center gap-2 cursor-pointer select-none"><input type="checkbox" id="scadaSimIncludeImpactChk" checked onchange="rebuildScadaSimPlanText()" class="w-4 h-4 accent-purple-600 rounded"><span>⚡ แนบสรุปผลกระทบผังไฟหลังซ้อม</span></label></div><div><div class="flex items-center justify-between mb-1"><label class="font-bold text-slate-700">📝 ข้อความสำหรับส่ง LINE (พิมพ์แก้ไขเพิ่มเติมได้)</label><button type="button" onclick="rebuildScadaSimPlanText()" class="text-[11px] text-purple-700 hover:underline font-bold">🔄 รีเซ็ตข้อความ</button></div><textarea id="scadaSimPlanPreviewText" rows="10" class="w-full p-3 text-xs font-mono bg-white border border-slate-300 rounded-xl text-slate-800 leading-relaxed focus:outline-none"></textarea></div></div><div class="p-3 bg-white border-t flex flex-wrap items-center justify-between gap-2"><button type="button" onclick="closeScadaSimPlanModal()" class="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs">ปิดหน้าต่าง</button><div class="flex items-center gap-2"><button type="button" onclick="copyScadaSimPlanToClipboard()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold rounded-xl text-xs shadow">📋 คัดลอกแผน</button><button type="button" onclick="shareScadaSimPlanToLine()" class="px-4 py-2 bg-[#00B900] hover:bg-[#009900] text-white font-extrabold rounded-xl text-xs shadow">💬 ส่งเข้า LINE</button></div></div></div></div>`]
        ];
        modalsHtml.forEach(([id, html]) => {
            if (!document.getElementById(id)) document.body.insertAdjacentHTML('beforeend', html);
        });
    }

    // ========================================================================
    // 3. ระบบสิทธิ์แก้ไขผัง, คลังข้อมูลหมุด, ประวัติลบ (Audit) & T-Tap Auto-Heal
    // ========================================================================
    function normHex(str) { const s = String(str || '').trim(); return /^#[0-9A-Fa-f]{6}$/.test(s) ? s.toLowerCase() : null; }
    function normFd(fd) { return String(fd || '').trim().toUpperCase().replace(/\s+/g, ''); }
    function isBreakerType(eqType) { return eqType === 'RC' || eqType === 'CB'; }
    function getPinColorTheme(colorKey) { return PIN_COLOR_THEMES[colorKey] || PIN_COLOR_THEMES.green; }
    function getTodayLocalIso() { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; }
    function formatThaiDateShort(iso) { if (!iso || !String(iso).includes('-')) return ''; const [y, m, d] = String(iso).split('-'); return `${d}/${m}/${parseInt(y, 10) + 543}`; }

    function clearTempLongPressMarker() {
        if (tempLongPressMarker && leafletMap) {
            try { leafletMap.removeLayer(tempLongPressMarker); } catch (e) {}
            tempLongPressMarker = null;
        }
    }

    function guardRealScadaEdit() {
        if (simState.active) { clearTempLongPressMarker(); showToast(SIM_LOCK_MSG); return false; }
        if (isViewerRole()) { clearTempLongPressMarker(); showToast(VIEWER_LOCK_MSG); return false; }
        if (!canCurrentUserEditScada()) { clearTempLongPressMarker(); showToast(SCADA_LOCK_MSG); return false; }
        return true;
    }

    function normScadaGrp(raw) {
        if (typeof window.normalizePeaGroupName === 'function') {
            return window.normalizePeaGroupName(raw) || 'กฟส.บึง';
        }
        return String(raw || '').trim().replace(/\s+/g, ' ').replace(/^(กฟ[สฟจตอ])\.?\s+/, '$1.').replace(/^(กฟ[สฟจตอ])(?![.\s])/, '$1.') || 'กฟส.บึง';
    }

    function getActiveEquipUserGroup() {
        return normScadaGrp(getCurrentUserGroup() || localStorage.getItem('elec_app_current_group') || 'กฟส.บึง');
    }

    function getPinOwnerGroup(pin) {
        if (pin?.ownerGroup && String(pin.ownerGroup).trim()) return normScadaGrp(pin.ownerGroup);
        if (pin?.ownerUser) { const g = getUserGroupName(pin.ownerUser); if (g) return normScadaGrp(g); }
        return 'กฟส.บึง';
    }

    function canCurrentUserSeeEquipPin(pin) {
        if (!pin || !pin.id || Core.ramIndex.delPinsObj[pin.id] || deletedLabeledMap[pin.id]) return false;
        const curRole = localStorage.getItem('elec_app_current_role') || 'user';
        if (curRole === 'admin' && !getCurrentUserGroup()) return true;
        return getActiveEquipUserGroup() === getPinOwnerGroup(pin);
    }

    function getPinSavedColorHex(pin) {
        return normHex(pin?.scadaNode?.col) || PIN_KEY_TO_HEX[pin?.pinColor] || '#10b981';
    }

    function getEffectivePinColorKey(pin) {
        if (!pin) return 'green';
        if (pin.dueDate && pin.dueColor && PIN_COLOR_THEMES[pin.dueColor] && getTodayLocalIso() >= pin.dueDate) {
            return pin.dueColor;
        }
        return (pin.pinColor && PIN_COLOR_THEMES[pin.pinColor]) ? pin.pinColor : 'green';
    }

    function buildDueScheduleBadgeHtml(pin) {
        if (!pin?.dueDate) return '';
        const thaiDate = formatThaiDateShort(pin.dueDate);
        const tTheme = getPinColorTheme(pin.dueColor || 'red');
        return getTodayLocalIso() >= pin.dueDate
            ? `<span class="bg-rose-100 text-rose-800 border border-rose-300 text-[10px] font-extrabold px-1.5 py-0.5 rounded animate-pulse">⏰ ครบกำหนด: ${thaiDate} (${tTheme.dot}${tTheme.name})</span>`
            : `<span class="bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-bold px-1.5 py-0.5 rounded">📅 รอเปลี่ยนเป็น${tTheme.dot}: ${thaiDate}</span>`;
    }

    // ตรวจจับหมุด T-Tap แม่นยำทุกรูปแบบ (รองรับการซ่อนป้ายชื่อถาวร และการอัปเกรดเป็นสวิตช์จริง)
    function isPinTTap(pin, allPins) {
        if (!pin) return false;
        const explicitType = pin.scadaNode?.t;
        if (explicitType && explicitType !== 'TAP' && explicitType !== 'PIN') return false;
        if (explicitType === 'TAP' || pin.isTTap === true) return true;
        if (/^(?:•\s*)?t-tap\b|จุดแทป|แทปสาย|แทปกลางสาย|หมุดแทป/i.test(`${pin.name || ''} ${pin.note || ''}`)) return true;
        if (Array.isArray(pin.scadaLines) && pin.scadaLines.some(l => l && (l._ttapTrunk || l._ttapFromId))) return true;
        if (Array.isArray(allPins)) {
            return allPins.some(p => p && p.id !== pin.id && Array.isArray(p.scadaLines) && p.scadaLines.some(l => l && l.to === pin.id && l._ttapId));
        }
        return false;
    }

    function pruneDeletedLabeledMap(rawMap) {
        if (!rawMap || typeof rawMap !== 'object') return {};
        const now = Date.now();
        const entries = Object.entries(rawMap).filter(([id, iso]) => {
            if (!id) return false;
            const t = new Date(iso).getTime();
            return isNaN(t) || (now - t <= MAX_DELETED_EQUIP_AGE_MS);
        });
        entries.sort((a, b) => (new Date(b[1] || 0).getTime() || 0) - (new Date(a[1] || 0).getTime() || 0));
        return Object.fromEntries(entries.slice(0, 2000));
    }

    function deduplicateAuditLogs(logsArr) {
        if (!Array.isArray(logsArr)) return [];
        const map = new Map();
        logsArr.forEach(it => {
            if (!it?.logId || restoredAuditLogIds.has(it.logId)) return;
            const dMs = new Date(it.deletedAt || 0).getTime() || 0;
            if (clearedAuditLogsTimestamp > 0 && dMs <= clearedAuditLogsTimestamp) return;
            map.set(it.logId, it);
        });
        return Array.from(map.values())
            .sort((a, b) => (new Date(b.deletedAt || 0).getTime() || 0) - (new Date(a.deletedAt || 0).getTime() || 0))
            .slice(0, 50);
    }

        function deduplicateEquipPins(rawList) {
        if (!Array.isArray(rawList)) return [];
        const byId = new Map();
        rawList.forEach(pin => {
            if (!pin || !pin.id || isNaN(parseFloat(pin.lat)) || isNaN(parseFloat(pin.lon))) return;
            if (deletedLabeledMap[pin.id]) {
                const delMs = new Date(deletedLabeledMap[pin.id]).getTime() || 0;
                const pinMs = new Date(pin.updatedAt || 0).getTime() || 0;
                if (pinMs > delMs) delete deletedLabeledMap[pin.id];
                else return;
            }
            const ex = byId.get(pin.id);
            if (!ex || (new Date(pin.updatedAt || 0).getTime() || 0) >= (new Date(ex.updatedAt || 0).getTime() || 0)) {
                byId.set(pin.id, pin);
            }
        });
        return Array.from(byId.values());
    }

    function loadStoredLabeledPlaces() {
        try { deletedLabeledMap = pruneDeletedLabeledMap(JSON.parse(localStorage.getItem(STORAGE_KEY_DELETED_LABELS) || '{}')); } catch (e) { deletedLabeledMap = {}; }
        try { deletedEquipAuditLogs = deduplicateAuditLogs(JSON.parse(localStorage.getItem(STORAGE_KEY_DELETED_AUDIT_LOGS) || '[]')); } catch (e) { deletedEquipAuditLogs = []; }
        try { labeledPlaces = deduplicateEquipPins(JSON.parse(localStorage.getItem(STORAGE_KEY_LABELS) || '[]')); } catch (e) { labeledPlaces = []; }
    }

    async function saveLabeledPlaces(syncCloud = true) {
        labeledPlaces = deduplicateEquipPins(labeledPlaces);
        deletedLabeledMap = pruneDeletedLabeledMap(deletedLabeledMap);
        deletedEquipAuditLogs = deduplicateAuditLogs(deletedEquipAuditLogs);

        if (!simState.active) {
            localStorage.setItem(STORAGE_KEY_DELETED_LABELS, JSON.stringify(deletedLabeledMap));
            localStorage.setItem(STORAGE_KEY_DELETED_AUDIT_LOGS, JSON.stringify(deletedEquipAuditLogs));
        }
        localStorage.setItem(STORAGE_KEY_LABELS, JSON.stringify(labeledPlaces));
        updateAdminAuditCountBadge();

        if (syncCloud && !simState.active && typeof window.pushAllJobsToCloud === 'function') {
            Core.unlockCloudWrite(20000);
            window.pushAllJobsToCloud(true);
        }
    }

    async function commitPinsUpdate(mutatorFn, toastMsg = null) {
        if (!guardRealScadaEdit()) return false;
        loadStoredLabeledPlaces();
        const didChange = mutatorFn(labeledPlaces);
        if (!didChange) return false;

        Core.unlockCloudWrite(20000);
        localStorage.setItem(STORAGE_KEY_LABELS, JSON.stringify(labeledPlaces));
        renderLabeledPlacesList(true);
        scheduleUnifiedScadaRefresh();
        if (toastMsg) showToast(toastMsg);
        if (typeof window.pushAllJobsToCloud === 'function') window.pushAllJobsToCloud(true);
        return true;
    }

    function recordPinDeletionAuditLog(pinObj, actionNote = 'ลบรายจุด') {
        if (!pinObj || simState.active) return;
        const curUser = (localStorage.getItem('elec_app_current_user') || 'ไม่ระบุชื่อ').trim();
        const isTap = isPinTTap(pinObj, labeledPlaces);
        const logEntry = {
            logId: 'del_' + (pinObj.id || Date.now()) + '_' + Date.now(),
            pinId: pinObj.id || ('eqp_' + Date.now()),
            pinName: pinObj.name || '-',
            pinColor: pinObj.pinColor || 'green',
            dueDate: pinObj.dueDate || undefined,
            dueColor: pinObj.dueColor || undefined,
            note: pinObj.note || '',
            lat: pinObj.lat,
            lon: pinObj.lon,
            ownerGroup: getPinOwnerGroup(pinObj),
            deletedByUsername: curUser,
            deletedByDisplay: formatTechDisplayName(curUser),
            actionType: actionNote,
            deletedAt: new Date().toISOString(),
            ...(pinObj.scadaNode ? { scadaNode: JSON.parse(JSON.stringify(pinObj.scadaNode)) } : {}),
            ...(!isTap && Array.isArray(pinObj.scadaLines) ? { scadaLines: JSON.parse(JSON.stringify(pinObj.scadaLines)) } : {})
        };
        deletedEquipAuditLogs = deduplicateAuditLogs([logEntry, ...deletedEquipAuditLogs]);
        localStorage.setItem(STORAGE_KEY_DELETED_AUDIT_LOGS, JSON.stringify(deletedEquipAuditLogs));
        updateAdminAuditCountBadge();
    }

    // สมานสายหลักคืนอัตโนมัติเมื่อลบจุด T-Tap หรือตัดสายที่ชี้มาหาหมุดที่ถูกลบ
    function healTTapConnectionsInList(pins, deletedPinId) {
        const targetPin = pins.find(p => p && p.id === deletedPinId);
        if (!targetPin) return 0;
        const pinById = new Map(pins.filter(p => p && p.id && p.id !== deletedPinId && !deletedLabeledMap[p.id]).map(p => [p.id, p]));
        const shouldHeal = isPinTTap(targetPin, pins);
        const nowIso = new Date().toISOString();
        let reconnectedCount = 0;

        if (shouldHeal) {
            const validOut = (Array.isArray(targetPin.scadaLines) ? targetPin.scadaLines : [])
                .map((e, idx) => ({ outEdge: e, outIdx: idx }))
                .filter(({ outEdge }) => outEdge?.to && outEdge.to !== deletedPinId && pinById.has(outEdge.to));
            const usedOut = new Set();

            pins.forEach(srcPin => {
                if (!srcPin || srcPin.id === deletedPinId || !Array.isArray(srcPin.scadaLines)) return;
                const nextLines = [];
                let touched = false;

                srcPin.scadaLines.forEach(inEdge => {
                    if (!inEdge || inEdge.to !== deletedPinId) { nextLines.push(inEdge); return; }
                    touched = true;
                    let best = null, bestScore = -Infinity;

                    validOut.forEach(({ outEdge, outIdx }) => {
                        if (usedOut.has(outIdx) || outEdge.to === srcPin.id) return;
                        const dstPin = pinById.get(outEdge.to);
                        if (!dstPin) return;
                        if (inEdge._ttapId && outEdge._ttapFromId && inEdge._ttapId === outEdge._ttapFromId) {
                            bestScore = 100000; best = { outEdge, outIdx, cosVal: 1 }; return;
                        }
                        const pPt = (inEdge.w?.length > 0) ? inEdge.w[inEdge.w.length - 1] : [srcPin.lat, srcPin.lon];
                        const nPt = (outEdge.w?.length > 0) ? outEdge.w[0] : [dstPin.lat, dstPin.lon];
                        const v1x = Number(targetPin.lat) - Number(pPt[0]), v1y = Number(targetPin.lon) - Number(pPt[1]);
                        const v2x = Number(nPt[0]) - Number(targetPin.lat), v2y = Number(nPt[1]) - Number(targetPin.lon);
                        const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
                        const cosVal = (l1 > 1e-9 && l2 > 1e-9) ? ((v1x * v2x + v1y * v2y) / (l1 * l2)) : 0;

                        let score = cosVal * 80 + (outEdge._ttapTrunk ? 1000 : 0) + (normFd(outEdge.fd) === normFd(inEdge.fd) ? 200 : 0) + (outIdx === 0 ? 120 : 0);
                        if (score > bestScore) { bestScore = score; best = { outEdge, outIdx, cosVal }; }
                    });

                    if (best) {
                        usedOut.add(best.outIdx);
                        const w1 = Array.isArray(inEdge.w) ? inEdge.w : [];
                        const w2 = Array.isArray(best.outEdge.w) ? best.outEdge.w : [];
                        const mergedW = (!inEdge._ttapId && w1.length === 0 && w2.length === 0 && best.cosVal < 0.978)
                            ? [[Number(Number(targetPin.lat).toFixed(5)), Number(Number(targetPin.lon).toFixed(5))]]
                            : [...w1, ...w2];
                        if (!nextLines.some(l => l && l.to === best.outEdge.to && normFd(l.fd) === normFd(inEdge.fd))) {
                            const healed = { ...inEdge, to: best.outEdge.to };
                            if (inEdge.off || best.outEdge.off) healed.off = 1; else delete healed.off;
                            if (mergedW.length > 0) healed.w = mergedW; else delete healed.w;
                            if (best.outEdge._ttapId) healed._ttapId = best.outEdge._ttapId; else delete healed._ttapId;
                            nextLines.push(healed);
                        }
                        reconnectedCount++;
                    }
                });
                if (touched) { srcPin.scadaLines = nextLines; srcPin.updatedAt = nowIso; }
            });
            targetPin.scadaLines = [];
        } else {
            pins.forEach(srcPin => {
                if (!srcPin || srcPin.id === deletedPinId || !Array.isArray(srcPin.scadaLines)) return;
                const before = srcPin.scadaLines.length;
                srcPin.scadaLines = srcPin.scadaLines.filter(l => l && l.to !== deletedPinId);
                if (srcPin.scadaLines.length !== before) srcPin.updatedAt = nowIso;
            });
        }
        return reconnectedCount;
    }

    // เชื่อมรับข้อมูลหมุดอุปกรณ์และประวัติการลบที่ดึงมาจาก Google Sheets ผ่าน tech-jobs.js
    window.__mergeCloudEquipRegistry = function (locReg) {
        if (!locReg || simState.active) return;
        loadStoredLabeledPlaces();
        if (locReg.clearedAuditLogsTimestamp && locReg.clearedAuditLogsTimestamp > clearedAuditLogsTimestamp) {
            clearedAuditLogsTimestamp = locReg.clearedAuditLogsTimestamp;
            localStorage.setItem('elec_cleared_audit_logs_ts', String(clearedAuditLogsTimestamp));
        }
        if (locReg.deletedElectricEquipmentMap && typeof locReg.deletedElectricEquipmentMap === 'object') {
            Object.assign(deletedLabeledMap, locReg.deletedElectricEquipmentMap);
            deletedLabeledMap = pruneDeletedLabeledMap(deletedLabeledMap);
            localStorage.setItem(STORAGE_KEY_DELETED_LABELS, JSON.stringify(deletedLabeledMap));
        }
        if (Array.isArray(locReg.deletedEquipAuditLogs)) {
            deletedEquipAuditLogs = deduplicateAuditLogs([...deletedEquipAuditLogs, ...locReg.deletedEquipAuditLogs]);
            localStorage.setItem(STORAGE_KEY_DELETED_AUDIT_LOGS, JSON.stringify(deletedEquipAuditLogs));
            updateAdminAuditCountBadge();
        }
        if (Array.isArray(locReg.electricEquipmentPins)) {
            const beforeSig = JSON.stringify(labeledPlaces);
            labeledPlaces = deduplicateEquipPins([...labeledPlaces, ...locReg.electricEquipmentPins]);
            localStorage.setItem(STORAGE_KEY_LABELS, JSON.stringify(labeledPlaces));
            if (JSON.stringify(labeledPlaces) !== beforeSig) renderLabeledPlacesList(true);
        }
    };
    // ===== จบพาทที่ 1 / 4 ของไฟล์ scada-engine.js (นำพาทที่ 2 / 4 มาวางต่อจากบรรทัดนี้ได้เลยครับ) =====
    // ===== เริ่มพาทที่ 2 / 4 ของไฟล์ scada-engine.js (วางต่อจากพาทที่ 1 / 4) =====

    // ========================================================================
    // 4. ระบบประวัติผู้ลบหมุดและกู้คืนหมุดพร้อมสายไฟสำหรับ Admin
    // ========================================================================
    function updateAdminAuditCountBadge() {
        const badge = document.getElementById('adminDeletedAuditCountBadge');
        if (badge) badge.textContent = String(deletedEquipAuditLogs.length);
    }

    function openDeletedEquipAuditModal() {
        if (!isCurrentUserAdmin()) {
            showCustomAlert('⛔ เฉพาะแอดมิน (ผู้ดูแลระบบ) เท่านั้นที่สามารถดูประวัติผู้ลบหมุดได้', '🔒 จำกัดสิทธิ์เฉพาะ Admin');
            return;
        }
        renderDeletedEquipAuditModalList();
        document.getElementById('deletedEquipAuditModal')?.classList.remove('hidden');
    }

    function closeDeletedEquipAuditModal() {
        document.getElementById('deletedEquipAuditModal')?.classList.add('hidden');
    }

    function renderDeletedEquipAuditModalList() {
        const container = document.getElementById('deletedEquipAuditListContainer');
        const summaryEl = document.getElementById('deletedEquipAuditSummaryText');
        if (!container) return;

        deletedEquipAuditLogs = deduplicateAuditLogs(deletedEquipAuditLogs);
        if (summaryEl) summaryEl.textContent = `📜 ประวัติการลบหมุดทั้งหมด ${deletedEquipAuditLogs.length} รายการ`;
        if (deletedEquipAuditLogs.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400">ยังไม่มีประวัติการลบหมุดอุปกรณ์ไฟฟ้าในระบบ</div>';
            return;
        }

        container.innerHTML = deletedEquipAuditLogs.map(log => {
            const theme = getPinColorTheme(getEffectivePinColorKey(log));
            const timeStr = log.deletedAt ? new Date(log.deletedAt).toLocaleString('th-TH') : '-';
            const latStr = !isNaN(parseFloat(log.lat)) ? Number(log.lat).toFixed(6) : '-';
            const lonStr = !isNaN(parseFloat(log.lon)) ? Number(log.lon).toFixed(6) : '-';
            return `
                <div class="p-3 bg-white rounded-xl border border-rose-200 shadow-sm space-y-1.5">
                    <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-1.5 flex-wrap">
                                <span class="bg-teal-50 text-teal-800 border border-teal-200 text-[10px] font-bold px-1.5 py-0.5 rounded">🏢 ${escapeHtmlStr(log.ownerGroup || '-')}</span>
                                <span class="border text-[10px] font-bold px-1.5 py-0.5 rounded ${theme.badgeClass}">${theme.dot} ${theme.name}</span>
                                <span class="font-bold text-slate-900 text-xs sm:text-sm break-words">⚡ ${escapeHtmlStr(log.pinName)}</span>
                            </div>
                            ${log.note ? `<div class="text-[11px] text-slate-500 mt-0.5">📝 ${escapeHtmlStr(log.note)}</div>` : ''}
                            <div class="text-[10px] text-slate-400 mt-0.5">📍 พิกัด: ${latStr}, ${lonStr}</div>
                        </div>
                        <button type="button" onclick="restoreDeletedPinFromAudit('${log.logId}')" class="shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1.5 rounded-lg text-[10px] font-bold shadow-sm">♻️ กู้คืนหมุด</button>
                    </div>
                    <div class="pt-1.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-1 text-[11px]">
                        <span class="font-bold text-rose-700">🗑️ ผู้ลบ: ${escapeHtmlStr(log.deletedByDisplay || log.deletedByUsername || '-')} <span class="font-normal text-slate-500">(${escapeHtmlStr(log.actionType || 'ลบหมุด')})</span></span>
                        <span class="text-[10px] text-slate-500">🕒 ${escapeHtmlStr(timeStr)}</span>
                    </div>
                </div>`;
        }).join('');
    }

    async function restoreDeletedPinFromAudit(logId) {
        if (!isCurrentUserAdmin() || !guardRealScadaEdit()) return;
        loadStoredLabeledPlaces();
        const logItem = deletedEquipAuditLogs.find(l => l.logId === logId);
        if (!logItem) return;

        delete deletedLabeledMap[logItem.pinId];
        restoredAuditLogIds.add(logId);
        localStorage.setItem('elec_restored_audit_log_ids', JSON.stringify(Array.from(restoredAuditLogIds).slice(-200)));

        const restoredPin = {
            id: logItem.pinId || ('eqp_' + Date.now()),
            name: logItem.pinName,
            note: logItem.note || '',
            lat: parseFloat(logItem.lat),
            lon: parseFloat(logItem.lon),
            pinColor: logItem.pinColor || 'green',
            dueDate: logItem.dueDate || undefined,
            dueColor: logItem.dueColor || undefined,
            ownerGroup: logItem.ownerGroup || getActiveEquipUserGroup(),
            ownerUser: logItem.deletedByUsername || 'admin',
            ...(logItem.scadaNode ? { scadaNode: logItem.scadaNode } : {}),
            ...(logItem.scadaLines ? { scadaLines: logItem.scadaLines } : {}),
            ...(logItem.scadaNode?.t === 'TAP' ? { isTTap: true } : {}),
            updatedAt: new Date().toISOString()
        };

        labeledPlaces.unshift(restoredPin);
        deletedEquipAuditLogs = deletedEquipAuditLogs.filter(l => l.logId !== logId);
        await saveLabeledPlaces(true);
        renderDeletedEquipAuditModalList();
        renderLabeledPlacesList(true);
        scheduleUnifiedScadaRefresh();
        showToast(`♻️ กู้คืนหมุด "${restoredPin.name}" กลับสู่แผนที่แล้ว!`);
    }

    function clearDeletedEquipAuditLogs() {
        if (!isCurrentUserAdmin() || !guardRealScadaEdit()) return;
        if (deletedEquipAuditLogs.length === 0) { showToast('⚠️ ไม่มีประวัติการลบให้ล้าง'); return; }
        showCustomConfirm('ต้องการล้างประวัติการลบหมุดทั้งหมดใช่หรือไม่?', async function () {
            clearedAuditLogsTimestamp = Date.now();
            localStorage.setItem('elec_cleared_audit_logs_ts', String(clearedAuditLogsTimestamp));
            deletedEquipAuditLogs = [];
            await saveLabeledPlaces(true);
            renderDeletedEquipAuditModalList();
            showToast('🗑️ ล้างประวัติการลบหมุดเรียบร้อยแล้ว');
        }, '🗑️ ยืนยันการล้างประวัติการลบ');
    }

    // ========================================================================
    // 5. แถบสลับหน้าหลัก, ตัวกรองสี 7 สี, ค้นหา Autocomplete & แชร์พิกัดลง LINE
    // ========================================================================
    function updateMainSwitcherButtonsStyle() {
        const btnJobs = document.getElementById('mainTabBtn-jobs');
        const btnMap = document.getElementById('mainTabBtn-map');
        const countBadge = document.getElementById('mapTabPinCountBadge');
        if (!btnJobs || !btnMap) return;

        const activeCls = 'py-2.5 px-3 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center gap-1.5 bg-gradient-to-r from-teal-700 to-emerald-600 text-white border-2 border-amber-300 shadow-md ring-2 ring-teal-500/25';
        const idleCls = 'py-2.5 px-3 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center gap-1.5 bg-teal-50/90 text-teal-900 border-2 border-teal-500 shadow-sm hover:bg-teal-100';

        btnMap.className = currentActiveMainTab === 'map' ? activeCls : idleCls;
        btnJobs.className = currentActiveMainTab === 'jobs' ? activeCls : idleCls;
        if (countBadge) {
            countBadge.className = currentActiveMainTab === 'map'
                ? 'bg-white text-teal-800 text-[10px] px-2 py-0.5 rounded-full font-extrabold shadow-sm'
                : 'bg-teal-700 text-white text-[10px] px-2 py-0.5 rounded-full font-extrabold shadow-sm';
        }
    }

    function updateAdminBulkColorBarVisibility() {
        const adminBar = document.getElementById('adminBulkPinColorBar');
        if (!adminBar) return;
        updateAdminAuditCountBadge();
        const show = isCurrentUserAdmin() && !simState.active;
        adminBar.classList.toggle('hidden', !show);
        adminBar.classList.toggle('flex', show);
    }

    function updateEquipColorFilterPillsUI() {
        const base = 'py-1.5 px-0.5 rounded-xl text-[10px] sm:text-[11px] leading-tight transition flex flex-col items-center justify-center gap-0.5 ';
        const mapStyles = {
            all: ['bg-slate-800 text-white border-amber-300', 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'],
            green: ['bg-emerald-600 text-white border-amber-300', 'bg-emerald-50/70 text-emerald-800 border-emerald-300 hover:bg-emerald-100'],
            yellow: ['bg-amber-500 text-white border-slate-900', 'bg-amber-50/70 text-amber-800 border-amber-300 hover:bg-amber-100'],
            orange: ['bg-orange-500 text-white border-amber-300', 'bg-orange-50/70 text-orange-800 border-orange-300 hover:bg-orange-100'],
            red: ['bg-rose-600 text-white border-amber-300', 'bg-rose-50/70 text-rose-800 border-rose-300 hover:bg-rose-100'],
            blue: ['bg-sky-600 text-white border-amber-300', 'bg-sky-50/70 text-sky-800 border-sky-300 hover:bg-sky-100'],
            purple: ['bg-purple-600 text-white border-amber-300', 'bg-purple-50/70 text-purple-800 border-purple-300 hover:bg-purple-100'],
            brown: ['bg-amber-800 text-white border-amber-300', 'bg-amber-100/70 text-amber-950 border-amber-400 hover:bg-amber-200/70']
        };
        ['all', ...ALL_PIN_COLOR_KEYS].forEach(k => {
            const btn = document.getElementById('colorFilterBtn-' + k);
            if (!btn) return;
            btn.className = currentPinColorFilter === k
                ? `${base}font-extrabold border-2 shadow-md ${mapStyles[k][0]}`
                : `${base}font-bold border ${mapStyles[k][1]}`;
        });
    }

    function selectEquipPinColorFilter(colorKey) {
        currentPinColorFilter = colorKey || 'all';
        updateEquipColorFilterPillsUI();
        renderLabeledPlacesList(true);
        if (currentPinColorFilter === 'all') showToast('🎨 แสดงหมุดอุปกรณ์ไฟฟ้าทุกสี');
        else { const t = getPinColorTheme(currentPinColorFilter); showToast(`${t.dot} กรองเฉพาะหมุด${t.name}`); }
    }

    function switchTechMainTab(tabName) {
        const jobsWrap = document.getElementById('jobsMainViewWrapper');
        const mapWrap = document.getElementById('labeledMapViewWrapper');
        if (!jobsWrap || !mapWrap) return;

        currentActiveMainTab = tabName === 'map' ? 'map' : 'jobs';
        updateMainSwitcherButtonsStyle();
        updateAdminBulkColorBarVisibility();

        if (currentActiveMainTab === 'map') {
            jobsWrap.classList.add('hidden');
            mapWrap.classList.remove('hidden');
            mapWrap.classList.add('flex', 'lg:grid');
            initLabeledLeafletMap();
            setTimeout(() => {
                leafletMap?.invalidateSize();
                updatePinTooltipsVisibilityByZoom();
                renderLabeledPlacesList(true);
                scheduleUnifiedScadaRefresh();
            }, 140);
            setTimeout(() => leafletMap?.invalidateSize(), 350);
        } else {
            if (isMapFullscreen) toggleMapFullscreenMode();
            hideSearchEquipDropdown();
            mapWrap.classList.add('hidden');
            mapWrap.classList.remove('flex', 'lg:grid');
            jobsWrap.classList.remove('hidden');
            if (typeof window.renderRepairJobsMapMarkers === 'function') {
                setTimeout(() => window.renderRepairJobsMapMarkers(false), 120);
            }
        }
    }

    function highlightKeywordHtml(text, kw) {
        const safe = escapeHtmlStr(text || '');
        if (!kw) return safe;
        return safe.replace(new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<span class="bg-amber-200 text-slate-900 font-extrabold px-0.5 rounded">$1</span>');
    }

    function hideSearchEquipDropdown() { document.getElementById('searchEquipDropdown')?.classList.add('hidden'); }

    function onSearchEquipInputChange(rawValue) {
        if (searchInputDebounceTimer) clearTimeout(searchInputDebounceTimer);
        searchInputDebounceTimer = setTimeout(() => {
            renderSearchEquipDropdown(rawValue);
            renderLabeledPlacesList(true);
        }, 140);
    }

    function onSearchEquipKeyDown(e) {
        if (e.key === 'Escape') hideSearchEquipDropdown();
        else if (e.key === 'Enter') { e.preventDefault(); hideSearchEquipDropdown(); focusMapOnSearchMatch(); }
    }

    function clearSearchEquipInput() {
        const inp = document.getElementById('searchLabeledPinInput');
        if (inp) inp.value = '';
        hideSearchEquipDropdown();
        renderLabeledPlacesList(true);
    }

    function renderSearchEquipDropdown(rawVal) {
        const dd = document.getElementById('searchEquipDropdown');
        if (!dd) return;
        const kw = String(rawVal || '').trim().toLowerCase();
        const visible = labeledPlaces.filter(p => canCurrentUserSeeEquipPin(p) && (currentPinColorFilter === 'all' || getEffectivePinColorKey(p) === currentPinColorFilter));
        if (!kw || visible.length === 0) { dd.classList.add('hidden'); dd.innerHTML = ''; return; }

        const startCoord = (window.isGpsTrackingEnabled && window.lastKnownTechCoords) ? window.lastKnownTechCoords : null;
        const matched = visible.map(p => {
            const nm = String(p.name || ''), nt = String(p.note || ''), cd = `${Number(p.lat).toFixed(5)}, ${Number(p.lon).toFixed(5)}`;
            const inN = nm.toLowerCase().includes(kw), inNt = nt.toLowerCase().includes(kw), inC = cd.includes(kw);
            if (!inN && !inNt && !inC) return null;
            const roadKm = startCoord ? Math.max(0.1, calcHaversineKm(startCoord.lat, startCoord.lon, p.lat, p.lon) * 1.35) : null;
            return { ...p, roadKm, score: nm.toLowerCase().startsWith(kw) ? 1 : (inN ? 2 : 3) };
        }).filter(Boolean).sort((a, b) => (a.score - b.score) || ((a.roadKm !== null && b.roadKm !== null) ? (a.roadKm - b.roadKm) : String(a.name || '').localeCompare(String(b.name || ''), 'th'))).slice(0, 12);

        if (matched.length === 0) {
            dd.innerHTML = `<div class="px-3.5 py-2.5 text-xs text-slate-400 text-center">ไม่พบชื่อรหัสที่ตรงกับ "${escapeHtmlStr(rawVal)}"</div>`;
        } else {
            dd.innerHTML = matched.map(it => {
                const th = getPinColorTheme(getEffectivePinColorKey(it));
                return `<button type="button" onclick="selectSearchEquipSuggestion('${it.id}')" class="w-full text-left px-3.5 py-2.5 hover:bg-teal-50/90 transition block"><div class="text-xs sm:text-sm font-bold text-slate-800 break-words">${th.dot} ⚡ ${highlightKeywordHtml(it.name, kw)}</div>${it.note ? `<div class="text-[11px] text-slate-500 break-words mt-0.5">📝 ${highlightKeywordHtml(it.note, kw)}</div>` : ''}</button>`;
            }).join('');
        }
        dd.classList.remove('hidden');
    }

    function selectSearchEquipSuggestion(placeId) {
        const target = labeledPlaces.find(p => p.id === placeId && canCurrentUserSeeEquipPin(p));
        if (!target) return;
        const inp = document.getElementById('searchLabeledPinInput');
        if (inp) inp.value = target.name;
        hideSearchEquipDropdown();
        renderLabeledPlacesList(true);
        focusSinglePinOnMap(target.id);
        showToast(`🎯 เลือกอุปกรณ์: ${target.name}`);
    }

    function buildEquipPinShareText(place) {
        const lat = Number(place.lat).toFixed(6), lon = Number(place.lon).toFixed(6);
        const th = getPinColorTheme(getEffectivePinColorKey(place));
        const lines = [`${th.dot} ⚡ พิกัดอุปกรณ์ไฟฟ้า (${getPinOwnerGroup(place)})`, `🏷️ ป้ายชื่อ/รหัส : ${place.name}`];
        if (place.note && String(place.note).trim()) lines.push(`📝 รายละเอียด : ${place.note}`);
        if (place.dueDate) lines.push(`⏰ กำหนดการ : ${formatThaiDateShort(place.dueDate)}`);
        lines.push(`📍 พิกัด : ${lat}, ${lon}`, `🗺️ แผนที่นำทาง : https://www.google.com/maps?q=${lat},${lon}`);
        return lines.join('\n');
    }

    function copyEquipPinToClipboard(placeId) {
        const p = labeledPlaces.find(x => x.id === placeId && canCurrentUserSeeEquipPin(x));
        if (p) copyTechText(buildEquipPinShareText(p), `📋 คัดลอกข้อมูล "${p.name}" แล้ว!`);
    }

    function shareEquipPinToLine(placeId) {
        const p = labeledPlaces.find(x => x.id === placeId && canCurrentUserSeeEquipPin(x));
        if (!p) return;
        const txt = buildEquipPinShareText(p);
        copyTechText(txt, `💬 คัดลอกและกำลังเปิด LINE เพื่อแชร์ "${p.name}"...`);
        window.open('https://line.me/R/share?text=' + encodeURIComponent(txt), '_blank');
    }
    function copyActiveNavPinToClipboard() { if (activeMapNav?.placeId) copyEquipPinToClipboard(activeMapNav.placeId); }
    function shareActiveNavPinToLine() { if (activeMapNav?.placeId) shareEquipPinToLine(activeMapNav.placeId); }

    // ========================================================================
    // 6. หน้าต่างเพิ่ม/แก้ไข/ลบหมุด, เปลี่ยนสี, นำเข้า/ส่งออกไฟล์ & นำทางไปหมุด
    // ========================================================================
    function selectModalPinColor(colorKey) {
        const th = getPinColorTheme(colorKey);
        const inp = document.getElementById('equipPinColorInput');
        if (inp) inp.value = th.key;
        ALL_PIN_COLOR_KEYS.forEach(k => {
            const btn = document.getElementById('pinColorBtn-' + k);
            if (!btn) return;
            btn.className = k === th.key
                ? `py-2 px-1.5 rounded-xl border-2 font-extrabold text-[11px] flex flex-col items-center gap-1 transition ${PIN_COLOR_THEMES[k].activeBtnClass}`
                : 'py-2 px-1.5 rounded-xl border-2 border-slate-200 bg-white text-slate-500 hover:bg-slate-50 font-semibold text-[11px] flex flex-col items-center gap-1 transition opacity-75';
        });
    }

    async function quickChangeSinglePinColor(placeId, colorKey) {
        if (!guardRealScadaEdit()) return;
        loadStoredLabeledPlaces();
        const idx = labeledPlaces.findIndex(p => p.id === placeId && canCurrentUserSeeEquipPin(p));
        if (idx === -1) return;

        const th = getPinColorTheme(colorKey);
        const newHex = PIN_KEY_TO_HEX[th.key] || '#10b981';
        const isAlreadyDue = Boolean(labeledPlaces[idx].dueDate && getTodayLocalIso() >= labeledPlaces[idx].dueDate);
        const curUser = (localStorage.getItem('elec_app_current_user') || '').trim();

        labeledPlaces[idx] = {
            ...labeledPlaces[idx],
            pinColor: th.key,
            dueDate: isAlreadyDue ? undefined : labeledPlaces[idx].dueDate,
            dueColor: isAlreadyDue ? undefined : labeledPlaces[idx].dueColor,
            updatedBy: curUser,
            updatedAt: new Date().toISOString()
        };
        propagateColorToConnectedSystem(labeledPlaces, [placeId], newHex, { crossOpenSwitches: false });
        setScadaDrawColor(newHex);
        await saveLabeledPlaces(true);
        renderLabeledPlacesList(true);
        scheduleUnifiedScadaRefresh();
        showToast(`${th.dot} เปลี่ยนสีหมุด "${labeledPlaces[idx].name}" เป็น${th.name}แล้ว`);
    }

    function bulkChangeAllPinsColor(colorKey) {
        if (!isCurrentUserAdmin()) { showCustomAlert('⛔ เฉพาะแอดมินเท่านั้นที่เปลี่ยนสีหมุดทั้งหมดพร้อมกันได้', '🔒 จำกัดสิทธิ์เฉพาะ Admin'); return; }
        if (!guardRealScadaEdit()) return;
        loadStoredLabeledPlaces();
        const visible = labeledPlaces.filter(canCurrentUserSeeEquipPin);
        if (visible.length === 0) { showToast('⚠️ ยังไม่มีหมุดอุปกรณ์ไฟฟ้าในกลุ่มนี้'); return; }

        const th = getPinColorTheme(colorKey);
        const newHex = PIN_KEY_TO_HEX[th.key] || '#10b981';
        const myGroup = getActiveEquipUserGroup();
        showCustomConfirm(`👑 ยืนยันการเปลี่ยนสีหมุดทั้งหมดในกลุ่ม "${myGroup}" (${visible.length} จุด) เป็น "${th.dot} ${th.name}" หรือไม่?`, async function () {
            const nowIso = new Date().toISOString(), todayIso = getTodayLocalIso();
            const curUser = (localStorage.getItem('elec_app_current_user') || 'admin').trim();
            labeledPlaces = labeledPlaces.map(p => {
                if (!canCurrentUserSeeEquipPin(p)) return p;
                const dueDone = Boolean(p.dueDate && todayIso >= p.dueDate);
                const copy = { ...p, pinColor: th.key, dueDate: dueDone ? undefined : p.dueDate, dueColor: dueDone ? undefined : p.dueColor, updatedBy: curUser, updatedAt: nowIso };
                if (copy.scadaNode) copy.scadaNode.col = newHex;
                if (Array.isArray(copy.scadaLines)) copy.scadaLines.forEach(l => { if (l) l.col = newHex; });
                return copy;
            });
            if (currentPinColorFilter !== 'all' && currentPinColorFilter !== th.key) currentPinColorFilter = th.key;
            await saveLabeledPlaces(true);
            renderLabeledPlacesList(true);
            scheduleUnifiedScadaRefresh();
            showToast(`👑 เปลี่ยนสีหมุดทั้งหมด (${visible.length} จุด) เป็น${th.name}เรียบร้อยแล้ว!`);
        }, '👑 ยืนยันการเปลี่ยนสีหมุดทั้งหมด');
    }

    function normalizeThaiLatLon(valA, valB) {
        const a = parseFloat(valA), b = parseFloat(valB);
        if (isNaN(a) || isNaN(b)) return null;
        if (a >= 95 && a <= 108 && b >= 4 && b <= 23) return { lat: b, lon: a };
        if (a >= -90 && a <= 90 && b >= -180 && b <= 180) return { lat: a, lon: b };
        return null;
    }

    function parseCoordsFromEquipString(rawStr) {
        if (!rawStr) return null;
        const dp = deepParseCoords(rawStr, false);
        if (dp) return normalizeThaiLatLon(dp.lat, dp.lon);
        const nums = String(rawStr).match(/-?\d+\.\d+/g);
        return (nums && nums.length >= 2) ? normalizeThaiLatLon(nums[0], nums[1]) : null;
    }

    function openEquipPinModal(pinId = null, presetLat = null, presetLon = null) {
        if ((scadaSettings.drawActive || moveState.active || pinMoveState.active) && !pinId && presetLat != null) {
            clearTempLongPressMarker();
            showToast('⚠️ กรุณากดปุ่ม "✅ เสร็จสิ้น" ออกจากโหมดแก้ไขผังก่อนปักหมุดใหม่');
            return;
        }
        if (!guardRealScadaEdit()) return;

        loadStoredLabeledPlaces();
        editingEquipPinId = pinId;
        const modal = document.getElementById('equipPinModal');
        if (!modal) return;
        document.getElementById('mapFloatingActionBtns')?.classList.add('hidden');
        leafletMap?.closePopup();

        const hint = document.getElementById('equipShortLinkStatus');
        if (hint) { hint.textContent = 'รองรับทั้งพิกัดตัวเลข ลิงก์เต็ม และลิงก์สั้น maps.app.goo.gl'; hint.className = 'text-[10px] text-slate-400 mt-1'; }

        const myGroup = getActiveEquipUserGroup();
        const hasPreset = (presetLat != null && presetLon != null && !isNaN(parseFloat(presetLat)) && !isNaN(parseFloat(presetLon)));
        const delBtn = document.getElementById('deleteEquipPinInModalBtn');

        if (pinId) {
            clearTempLongPressMarker();
            const target = labeledPlaces.find(p => p.id === pinId);
            if (!target) return;
            document.getElementById('equipPinModalTitle').innerHTML = '✏️ แก้ไขป้ายกำกับ / อุปกรณ์ไฟฟ้า';
            document.getElementById('equipModalGroupBadge').textContent = getPinOwnerGroup(target) || myGroup;
            document.getElementById('equipCodeNameInput').value = target.name || '';
            document.getElementById('equipCoordInput').value = target.rawGpsLink || `${Number(target.lat).toFixed(6)}, ${Number(target.lon).toFixed(6)}`;
            document.getElementById('equipNoteInput').value = target.note || '';
            document.getElementById('equipDueDateInput').value = target.dueDate || '';
            document.getElementById('equipDueColorInput').value = target.dueColor || 'red';
            selectModalPinColor(target.pinColor || 'green');
            delBtn?.classList.remove('hidden');
            delBtn?.classList.add('inline-flex');
        } else {
            if (!hasPreset) clearTempLongPressMarker();
            document.getElementById('equipPinModalTitle').innerHTML = hasPreset ? '📍 ปักหมุดอุปกรณ์ไฟฟ้า (จากจุดที่กดค้าง)' : '➕ เพิ่มป้ายกำกับ / อุปกรณ์ไฟฟ้า';
            document.getElementById('equipModalGroupBadge').textContent = myGroup;
            document.getElementById('equipCodeNameInput').value = '';
            document.getElementById('equipCoordInput').value = hasPreset
                ? `${parseFloat(presetLat).toFixed(6)}, ${parseFloat(presetLon).toFixed(6)}`
                : (window.lastKnownTechCoords ? `${window.lastKnownTechCoords.lat.toFixed(6)}, ${window.lastKnownTechCoords.lon.toFixed(6)}` : '');
            document.getElementById('equipNoteInput').value = '';
            document.getElementById('equipDueDateInput').value = '';
            document.getElementById('equipDueColorInput').value = 'red';
            selectModalPinColor(currentPinColorFilter !== 'all' ? currentPinColorFilter : 'green');
            delBtn?.classList.add('hidden');
            delBtn?.classList.remove('inline-flex');
        }

        if (hasPreset) { modal.style.pointerEvents = 'none'; setTimeout(() => { modal.style.pointerEvents = ''; }, 350); }
        modal.classList.remove('hidden');
        setTimeout(() => document.getElementById('equipCodeNameInput')?.focus(), 120);
    }

    function closeEquipPinModal() {
        clearTempLongPressMarker();
        document.getElementById('equipPinModal')?.classList.add('hidden');
        document.getElementById('mapFloatingActionBtns')?.classList.remove('hidden');
        editingEquipPinId = null;
    }

    function fillEquipCurrentGps() {
        const coordInput = document.getElementById('equipCoordInput');
        if (!navigator.geolocation) { showToast('⚠️ เบราว์เซอร์ไม่รองรับ GPS'); return; }
        showToast('⏳ กำลังดึงพิกัดมือถือปัจจุบัน...');
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = pos.coords.latitude.toFixed(6), lon = pos.coords.longitude.toFixed(6);
                if (typeof window.recordCurrentTechGpsLocation === 'function') window.recordCurrentTechGpsLocation(pos.coords.latitude, pos.coords.longitude);
                if (coordInput) coordInput.value = `${lat}, ${lon}`;
                showToast(`📍 ดึงพิกัดสำเร็จ (${lat}, ${lon})`);
            },
            () => {
                if (window.lastKnownTechCoords && coordInput) {
                    coordInput.value = `${window.lastKnownTechCoords.lat.toFixed(6)}, ${window.lastKnownTechCoords.lon.toFixed(6)}`;
                    showToast('📍 ใช้พิกัดล่าสุดของเครื่อง');
                } else showToast('❌ ไม่สามารถดึงพิกัดได้ กรุณาเปิด Location ในมือถือ');
            },
            { enableHighAccuracy: true, timeout: 8000 }
        );
    }

    async function saveEquipPinModal() {
        if (!guardRealScadaEdit()) return;
        const codeName = (document.getElementById('equipCodeNameInput')?.value || '').trim();
        const rawCoord = (document.getElementById('equipCoordInput')?.value || '').trim();
        const note = (document.getElementById('equipNoteInput')?.value || '').trim();
        const pinColor = (document.getElementById('equipPinColorInput')?.value || 'green').trim();
        const dueDate = (document.getElementById('equipDueDateInput')?.value || '').trim();
        const dueColor = (document.getElementById('equipDueColorInput')?.value || 'red').trim();
        const saveBtn = document.getElementById('saveEquipPinSubmitBtn');

        if (!codeName) { showToast("⚠️ กรุณากรอก 'ชื่อรหัส' หรือชื่ออุปกรณ์ไฟฟ้า"); return; }
        if (!rawCoord) { showToast("⚠️ กรุณากรอก 'พิกัด' หรือวาง 'ลิงก์ GPS'"); return; }

        let pair = parseCoordsFromEquipString(rawCoord);
        if (!pair && /(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(rawCoord)) {
            if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ กำลังคลายลิงก์สั้น...'; }
            const resolved = await resolveGoogleShortLinkUniversal(rawCoord);
            if (resolved) pair = normalizeThaiLatLon(resolved.lat, resolved.lon);
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 บันทึกข้อมูล'; }
        }
        if (!pair) { showToast('❌ รูปแบบพิกัดหรือลิงก์ GPS ไม่ถูกต้อง'); return; }

        loadStoredLabeledPlaces();
        const myGroup = getActiveEquipUserGroup();
        const curUser = (localStorage.getItem('elec_app_current_user') || '').trim();
        const nowIso = new Date().toISOString();
        const fullMapsLink = `https://www.google.com/maps?q=${pair.lat.toFixed(6)},${pair.lon.toFixed(6)}`;

        if (editingEquipPinId) {
            const idx = labeledPlaces.findIndex(p => p.id === editingEquipPinId);
            if (idx !== -1) {
                const prevColor = labeledPlaces[idx].pinColor;
                labeledPlaces[idx] = {
                    ...labeledPlaces[idx],
                    name: codeName, note, lat: pair.lat, lon: pair.lon, pinColor,
                    dueDate: dueDate || undefined, dueColor: dueDate ? dueColor : undefined,
                    rawGpsLink: rawCoord.startsWith('http') ? fullMapsLink : undefined,
                    ownerGroup: labeledPlaces[idx].ownerGroup || myGroup,
                    updatedBy: curUser, updatedAt: nowIso
                };
                if (pinColor !== prevColor && PIN_KEY_TO_HEX[pinColor]) {
                    propagateColorToConnectedSystem(labeledPlaces, [editingEquipPinId], PIN_KEY_TO_HEX[pinColor], { crossOpenSwitches: false });
                }
                const savedId = editingEquipPinId;
                await saveLabeledPlaces(true);
                closeEquipPinModal();
                renderLabeledPlacesList(true);
                scheduleUnifiedScadaRefresh();
                focusSinglePinOnMap(savedId);
                showToast(`✅ แก้ไขข้อมูล "${codeName}" เรียบร้อยแล้ว`);
                return;
            }
        }

        const newPin = {
            id: 'eqp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            name: codeName, note, lat: pair.lat, lon: pair.lon, pinColor,
            dueDate: dueDate || undefined, dueColor: dueDate ? dueColor : undefined,
            rawGpsLink: rawCoord.startsWith('http') ? fullMapsLink : undefined,
            ownerGroup: myGroup, ownerUser: curUser, updatedAt: nowIso
        };
        labeledPlaces.unshift(newPin);
        await saveLabeledPlaces(true);
        closeEquipPinModal();
        renderLabeledPlacesList(true);
        scheduleUnifiedScadaRefresh();
        focusSinglePinOnMap(newPin.id);
        showToast(`✅ เพิ่ม "${codeName}" สำหรับกลุ่ม ${myGroup} เรียบร้อยแล้ว`);
    }

    function executePinDeletionWithHeal(placeId, actionSourceNote, closeEditModalAfter = false) {
        if (placeId === '__unlock_write_quota__') { Core.unlockCloudWrite(20000); return; }
        if (!guardRealScadaEdit()) return;
        loadStoredLabeledPlaces();
        const target = labeledPlaces.find(p => p.id === placeId && canCurrentUserSeeEquipPin(p));
        if (!target) return;

        const isTap = isPinTTap(target, labeledPlaces);
        const msg = isTap
            ? `ต้องการลบหมุดแทปสาย "${target.name}" ใช่หรือไม่?\n(ระบบจะเชื่อมเส้นสายไฟหลักเข้าหากันคืนให้อัตโนมัติ)`
            : `ต้องการลบอุปกรณ์ "${target.name}" ออกจากแผนที่ใช่หรือไม่?`;

        showCustomConfirm(msg, async function () {
            if (scadaSettings.drawActive) toggleScadaDrawMode(false);
            recordPinDeletionAuditLog(target, actionSourceNote);
            const healedCount = healTTapConnectionsInList(labeledPlaces, placeId);
            deletedLabeledMap[placeId] = new Date().toISOString();
            labeledPlaces = labeledPlaces.filter(p => p.id !== placeId);
            if (activeMapNav?.placeId === placeId) stopLabeledPlaceNavigation(true);
            if (closeEditModalAfter) closeEquipPinModal();

            await saveLabeledPlaces(true);
            renderLabeledPlacesList(true);
            scheduleUnifiedScadaRefresh();
            showToast(healedCount > 0 ? '🔗 ลบจุด T-Tap และเชื่อมเส้นสายไฟหลักคืนเรียบร้อยแล้ว!' : `🗑️ ลบหมุด "${target.name}" เรียบร้อยแล้ว`);
        }, '🗑️ ยืนยันการลบหมุดอุปกรณ์ไฟฟ้า');
    }

    function deleteEquipPinFromModal() { if (editingEquipPinId) executePinDeletionWithHeal(editingEquipPinId, 'ลบจากหน้าต่างแก้ไขหมุด', true); }
    function deleteSingleLabeledPin(placeId) { executePinDeletionWithHeal(placeId, 'ลบจากรายการการ์ด', false); }

    function openClearEquipModal() {
        if (!guardRealScadaEdit()) return;
        loadStoredLabeledPlaces();
        const visible = labeledPlaces.filter(canCurrentUserSeeEquipPin);
        if (visible.length === 0) { showToast('⚠️ ไม่มีข้อมูลอุปกรณ์ไฟฟ้าให้ล้างในกลุ่มของคุณ'); return; }
        const warnEl = document.getElementById('clearEquipWarningText');
        if (warnEl) warnEl.innerHTML = `คุณกำลังจะล้างข้อมูลอุปกรณ์ไฟฟ้าทั้งหมดของกลุ่ม <b>${escapeHtmlStr(getActiveEquipUserGroup())}</b> จำนวน <b>${visible.length} จุด</b> กรุณาใส่รหัสผ่านเข้าใช้งานเพื่อยืนยัน`;
        const inp = document.getElementById('clearEquipPasswordInput');
        if (inp) inp.value = '';
        document.getElementById('clearEquipPasswordModal')?.classList.remove('hidden');
        setTimeout(() => inp?.focus(), 100);
    }

    function closeClearEquipModal() { document.getElementById('clearEquipPasswordModal')?.classList.add('hidden'); }

    async function confirmClearAllEquipPins() {
        if (!guardRealScadaEdit()) return;
        const typedPass = (document.getElementById('clearEquipPasswordInput')?.value || '').trim();
        if (!typedPass) { showToast('⚠️ กรุณากรอกรหัสผ่านเข้าใช้งานของคุณเพื่อยืนยัน'); return; }

        showToast('⏳ กำลังตรวจสอบรหัสผ่านกับเซิร์ฟเวอร์...');
        try {
            const verified = await Core.verifyPasswordOnServer(typedPass);
            if (!verified) { showToast('❌ รหัสผ่านไม่ถูกต้อง! กรุณาใช้รหัสผ่านบัญชีของคุณหรือรหัสแอดมิน'); return; }
        } catch (e) {
            showToast('⚠️ ไม่สามารถตรวจสอบรหัสผ่านกับเซิร์ฟเวอร์ได้');
            return;
        }

        loadStoredLabeledPlaces();
        const nowIso = new Date().toISOString();
        const remaining = [];
        labeledPlaces.forEach(p => {
            if (canCurrentUserSeeEquipPin(p)) {
                deletedLabeledMap[p.id] = nowIso;
                recordPinDeletionAuditLog(p, 'ล้างข้อมูลทั้งหมดในกลุ่ม');
            } else remaining.push(p);
        });
        labeledPlaces = remaining;
        stopLabeledPlaceNavigation(true);
        closeClearEquipModal();
        await saveLabeledPlaces(true);
        renderLabeledPlacesList(true);
        scheduleUnifiedScadaRefresh();
        showToast('🗑️ ล้างข้อมูลอุปกรณ์ไฟฟ้าทั้งหมดเรียบร้อยแล้ว');
    }

    // นำเข้า/ส่งออกไฟล์ JSON, Excel, KML, CSV & ระบบนำทางไปหมุดอุปกรณ์
    function exportLabeledPinsToJson() {
        loadStoredLabeledPlaces();
        const visible = labeledPlaces.filter(canCurrentUserSeeEquipPin).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'th'));
        if (visible.length === 0) { showToast('⚠️ ไม่มีข้อมูลหมุดอุปกรณ์ไฟฟ้าในกลุ่มสำหรับส่งออก'); return; }
        const fn = `Equipment_Pins_${getActiveEquipUserGroup().replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.json`;
        const a = document.createElement('a');
        a.href = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(visible, null, 2));
        a.download = fn;
        document.body.appendChild(a); a.click(); a.remove();
        showToast(`📥 ส่งออกไฟล์ JSON (${visible.length} จุด) สำเร็จ!`);
    }

    async function exportLabeledPinsToExcel() {
        loadStoredLabeledPlaces();
        const visible = labeledPlaces.filter(canCurrentUserSeeEquipPin).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'th'));
        if (visible.length === 0) { showToast('⚠️ ไม่มีข้อมูลหมุดอุปกรณ์ไฟฟ้าในกลุ่มสำหรับส่งออก'); return; }
        const myGrp = getActiveEquipUserGroup();
        const headers = ['ลำดับ', 'กลุ่มสังกัด', 'ชื่อรหัส / อุปกรณ์ไฟฟ้า', 'ประเภท SCADA', 'สีหมุดปัจจุบัน', 'วันที่กำหนดเปลี่ยนสี', 'รายละเอียด / บริเวณ', 'ละติจูด (Lat)', 'ลองจิจูด (Lon)', 'ลิงก์นำทาง Google Maps', 'ผู้บันทึก/อัปเดต', 'วันเวลาที่อัปเดต'];
        const rows = visible.map((p, idx) => {
            const lat = Number(p.lat).toFixed(6), lon = Number(p.lon).toFixed(6);
            return [String(idx + 1), getPinOwnerGroup(p) || myGrp, String(p.name || '-'), String(p.scadaNode?.t || 'PIN'), getPinColorTheme(getEffectivePinColorKey(p)).name, p.dueDate ? formatThaiDateShort(p.dueDate) : '-', String(p.note || ''), lat, lon, `https://www.google.com/maps?q=${lat},${lon}`, String(p.updatedBy || p.ownerUser || '-'), p.updatedAt ? new Date(p.updatedAt).toLocaleString('th-TH') : '-'];
        });
        const fn = `Equipment_Pins_${myGrp.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;
        if ((await ensureTechXlsxLoaded()) && typeof XLSX !== 'undefined') {
            const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
            XLSX.utils.book_append_sheet(wb, ws, `อุปกรณ์_${myGrp}`.replace(/[:\\/?*[\]]/g, '_').substring(0, 30));
            XLSX.writeFile(wb, fn);
            showToast(`📊 ส่งออกไฟล์ Excel (${visible.length} จุด) สำเร็จ!`);
        } else {
            Core.downloadCsvFallback(headers, rows, fn);
            showToast(`📊 ส่งออกไฟล์ตาราง .csv (${visible.length} จุด) สำเร็จ!`);
        }
    }

    function handleImportLabeledFile(event) {
        if (!guardRealScadaEdit()) { event.target.value = ''; return; }
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async function (e) {
            const text = String(e.target.result || ''), fName = file.name.toLowerCase();
            let imported = [];
            try {
                if (fName.endsWith('.json') || fName.endsWith('.geojson') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
                    const obj = JSON.parse(text);
                    const arr = Array.isArray(obj.features) ? obj.features : (Array.isArray(obj) ? obj : []);
                    arr.forEach((f, i) => {
                        const props = f?.properties || f || {};
                        const coords = f?.geometry?.coordinates;
                        const pair = (Array.isArray(coords) && coords.length >= 2) ? normalizeThaiLatLon(coords[1], coords[0]) : normalizeThaiLatLon(props.lat, props.lon);
                        if (!pair) return;
                        imported.push({
                            id: (typeof props.id === 'string' && props.id.startsWith('eqp_')) ? props.id : ('eqp_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substring(2, 6)),
                            name: String(props.name || props.title || props.Name || props.label || `รหัสอุปกรณ์ #${i + 1}`).trim(),
                            note: String(props.address || props.description || props.note || '').trim(),
                            pinColor: PIN_COLOR_THEMES[props.pinColor] ? props.pinColor : 'green',
                            dueDate: props.dueDate ? String(props.dueDate).trim() : undefined,
                            dueColor: props.dueDate ? (PIN_COLOR_THEMES[props.dueColor] ? props.dueColor : 'red') : undefined,
                            lat: pair.lat, lon: pair.lon,
                            ...(props.scadaNode ? { scadaNode: props.scadaNode } : {}),
                            ...(Array.isArray(props.scadaLines) ? { scadaLines: props.scadaLines } : {}),
                            ...(props.isTTap ? { isTTap: true } : {})
                        });
                    });
                } else if (fName.endsWith('.kml') || text.includes('<kml')) {
                    const xml = new DOMParser().parseFromString(text, 'text/xml');
                    Array.from(xml.getElementsByTagName('Placemark')).forEach((pm, i) => {
                        const rawC = String(pm.getElementsByTagName('coordinates')[0]?.textContent || '').trim().split(/\s+/)[0].split(',');
                        const pair = rawC.length >= 2 ? normalizeThaiLatLon(rawC[1], rawC[0]) : null;
                        if (!pair) return;
                        imported.push({
                            id: 'eqp_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substring(2, 6),
                            name: String(pm.getElementsByTagName('name')[0]?.textContent || `รหัสอุปกรณ์ #${i + 1}`).trim(),
                            note: String(pm.getElementsByTagName('description')[0]?.textContent || '').replace(/<[^>]+>/g, ' ').trim(),
                            pinColor: 'green', lat: pair.lat, lon: pair.lon
                        });
                    });
                } else {
                    text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach((line, i) => {
                        if (i === 0 && /lat|lon|name|ชื่อ/i.test(line)) return;
                        const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
                        const nIdx = cols.map((c, idx) => /^-?\d+\.\d+$/.test(c) ? idx : -1).filter(idx => idx !== -1);
                        const pair = nIdx.length >= 2 ? normalizeThaiLatLon(cols[nIdx[0]], cols[nIdx[1]]) : null;
                        if (!pair) return;
                        const txtCols = cols.filter((v, idx) => v && idx !== nIdx[0] && idx !== nIdx[1]);
                        imported.push({ id: 'eqp_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substring(2, 6), name: txtCols[0] || `รหัสอุปกรณ์ #${i + 1}`, note: txtCols.slice(1).join(' '), pinColor: 'green', lat: pair.lat, lon: pair.lon });
                    });
                }
            } catch (err) { showToast('❌ รูปแบบไฟล์ไม่ถูกต้อง กรุณาใช้ไฟล์ .json, .kml หรือ .csv'); return; }

            if (imported.length === 0) { showToast('⚠️ ไม่พบข้อมูลพิกัดในไฟล์ที่เลือก'); return; }
            loadStoredLabeledPlaces();
            const myGrp = getActiveEquipUserGroup(), curUser = (localStorage.getItem('elec_app_current_user') || '').trim(), nowIso = new Date().toISOString();
            imported.forEach(p => {
                delete deletedLabeledMap[p.id];
                const existIdx = labeledPlaces.findIndex(ex => ex.id === p.id);
                const fullPin = { ...p, ownerGroup: myGrp, ownerUser: curUser, updatedAt: nowIso };
                if (existIdx !== -1) labeledPlaces[existIdx] = fullPin; else labeledPlaces.push(fullPin);
            });
            await saveLabeledPlaces(true);
            renderLabeledPlacesList(true);
            scheduleUnifiedScadaRefresh();
            fitAllLabeledPinsOnMap();
            showToast(`🎉 นำเข้าอุปกรณ์ไฟฟ้าสำหรับกลุ่ม ${myGrp} สำเร็จ ${imported.length} จุด`);
        };
        reader.readAsText(file, 'UTF-8');
        event.target.value = '';
    }
    // ===== จบพาทที่ 2 / 4 ของไฟล์ scada-engine.js (นำพาทที่ 3 / 4 มาวางต่อจากบรรทัดนี้ได้เลยครับ) =====
    // ===== เริ่มพาทที่ 3 / 4 ของไฟล์ scada-engine.js (วางต่อจากพาทที่ 2 / 4) =====

    // ========================================================================
    // 7. ระบบนำทางเรียลไทม์ไปยังหมุดอุปกรณ์ไฟฟ้าบนแผนที่
    // ========================================================================
    async function startLabeledPlaceNavigation(placeId, openExternalGoogleMaps = false) {
        loadStoredLabeledPlaces();
        const place = labeledPlaces.find(p => p.id === placeId && canCurrentUserSeeEquipPin(p));
        if (!place) return;

        if (isViewerRole()) {
            if (openExternalGoogleMaps) {
                window.open(`https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lon}&travelmode=driving`, '_blank');
                showToast(`🗺️ เปิด Google Maps นำทางไป "${place.name}" (โหมดผู้สำรวจ)`);
            } else {
                showToast(VIEWER_LOCK_MSG);
            }
            return;
        }

        const loggedInUser = (localStorage.getItem('elec_app_current_user') || 'ช่างหน้างาน').trim();
        const startCoord = window.lastKnownTechCoords || { lat: 13.1361, lon: 101.0322 };
        const destCoord = { lat: parseFloat(place.lat), lon: parseFloat(place.lon) };
        const now = new Date(), nowMs = now.getTime();
        const departTimeStr = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')} น.`;

        const instantRoute = typeof window.calculateInstantRouteFallback === 'function'
            ? window.calculateInstantRouteFallback(startCoord, destCoord)
            : { distanceKm: '2.0', durationMin: 5, isArrived: false };

        const etaMs = nowMs + (instantRoute.durationMin * 60000);
        const etaDate = new Date(etaMs);
        const etaTimeStr = `${String(etaDate.getHours()).padStart(2, '0')}.${String(etaDate.getMinutes()).padStart(2, '0')} น.`;

        activeMapNav = {
            placeId: place.id, placeName: place.name, destLat: destCoord.lat, destLon: destCoord.lon,
            durationMin: instantRoute.durationMin, initialDurationMin: instantRoute.durationMin,
            distanceKm: instantRoute.distanceKm, initialDistanceKm: instantRoute.distanceKm,
            departTime: departTimeStr, departTimestamp: nowMs,
            etaTime: instantRoute.isArrived ? 'ถึงจุดหมายแล้ว' : etaTimeStr, etaTimestamp: etaMs,
            isArrived: instantRoute.isArrived, techName: loggedInUser, updatedAt: now.toISOString()
        };

        if (typeof window.recordEquipmentNavStart === 'function') {
            window.recordEquipmentNavStart(place, instantRoute);
        }
        // เปิด Google Maps ทันทีในจังหวะคลิกก่อนรอคำนวณเส้นทาง ป้องกันเบราว์เซอร์มือถือบล็อกหน้าต่างใหม่
        if (openExternalGoogleMaps) {
            openExternalGoogleMapsForActiveNav();
        } else {
            showToast(`🚗 เริ่มเดินทางไป "${place.name}" (ถึงประมาณ ${activeMapNav.etaTime})`);
        }

        document.getElementById('mapActiveNavContainer')?.classList.remove('hidden');
        renderActiveMapNavBox();
        renderLabeledPlacesList(false);
        await drawAndRefreshRouteToLabeledPin(startCoord, destCoord, true);
        startMapNavRealtimeWatch();
    }

    async function drawAndRefreshRouteToLabeledPin(startCoord, destCoord, fitRoute = false) {
        if (!activeMapNav) return;
        try {
            const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${startCoord.lon},${startCoord.lat};${destCoord.lon},${destCoord.lat}?overview=full&geometries=geojson`);
            if (!res.ok) return;
            const route = (await res.json())?.routes?.[0];
            if (!route) return;

            const distKm = Math.max(0.1, route.distance / 1000);
            const durMin = Math.max(1, Math.round((route.duration / 60) * 1.15));
            const isArrived = distKm <= 0.12;
            const etaMs = Date.now() + (durMin * 60000), etaD = new Date(etaMs);
            const etaStr = `${String(etaD.getHours()).padStart(2, '0')}.${String(etaD.getMinutes()).padStart(2, '0')} น.`;

            activeMapNav.distanceKm = distKm.toFixed(1);
            if (!activeMapNav.initialDistanceKm) activeMapNav.initialDistanceKm = distKm.toFixed(1);
            activeMapNav.durationMin = durMin;
            activeMapNav.etaTimestamp = etaMs;
            activeMapNav.etaTime = isArrived ? 'ถึงจุดหมายแล้ว' : etaStr;
            activeMapNav.isArrived = isArrived;
            activeMapNav.updatedAt = new Date().toISOString();

            if (typeof window.updateEquipmentNavRouteInfo === 'function') {
                window.updateEquipmentNavRouteInfo(activeMapNav);
            }
            if (leafletMap && routeLineLayer && route.geometry) {
                routeLineLayer.clearLayers();
                const poly = L.polyline(route.geometry.coordinates.map(c => [c[1], c[0]]), { color: '#2563eb', weight: 5, opacity: 0.85 }).addTo(routeLineLayer);
                if (fitRoute) leafletMap.fitBounds(poly.getBounds(), { padding: [40, 40] });
            }
            renderActiveMapNavBox();
        } catch (e) {}
    }

    function startMapNavRealtimeWatch() {
        if (mapNavWatchId !== null && navigator.geolocation) { navigator.geolocation.clearWatch(mapNavWatchId); mapNavWatchId = null; }
        if (mapNavTimerId) clearInterval(mapNavTimerId);
        mapNavTimerId = setInterval(renderActiveMapNavBox, 1000);

        if (!navigator.geolocation || !window.isGpsTrackingEnabled) return;
        if (typeof window.requestScreenWakeLock === 'function') window.requestScreenWakeLock();

        mapNavWatchId = navigator.geolocation.watchPosition(
            async (pos) => {
                if (!activeMapNav) return;
                if (typeof window.recordCurrentTechGpsLocation === 'function') window.recordCurrentTechGpsLocation(pos.coords.latitude, pos.coords.longitude);
                updateMyGpsMarkerOnLeaflet();
                const nowMs = Date.now();
                if (nowMs - lastMapRouteCalcMs < 7000) return;
                lastMapRouteCalcMs = nowMs;
                await drawAndRefreshRouteToLabeledPin({ lat: pos.coords.latitude, lon: pos.coords.longitude }, { lat: activeMapNav.destLat, lon: activeMapNav.destLon }, false);
                if (activeMapNav?.isArrived) showToast(`📍 คุณเดินทางถึง "${activeMapNav.placeName}" แล้ว!`);
            },
            () => {},
            { enableHighAccuracy: true, maximumAge: 4000, timeout: 10000 }
        );
    }

    function renderActiveMapNavBox() {
        const bodyEl = document.getElementById('mapActiveNavBody');
        if (!bodyEl || !activeMapNav) return;
        const navHtml = typeof window.formatRealtimeNavHtml === 'function'
            ? window.formatRealtimeNavHtml(activeMapNav)
            : `<div class="font-bold text-blue-700">🚗 กำลังเดินทาง: ถึงประมาณ ${escapeHtmlStr(activeMapNav.etaTime)}</div>`;
        bodyEl.innerHTML = `<div class="font-extrabold text-indigo-950 text-xs sm:text-sm flex items-center gap-1.5 pb-1"><span>⚡ กำลังเดินทางไปอุปกรณ์:</span><span class="text-blue-700 underline">${escapeHtmlStr(activeMapNav.placeName)}</span></div>${navHtml}`;
    }

    function openExternalGoogleMapsForActiveNav() {
        if (activeMapNav) window.open(`https://www.google.com/maps/dir/?api=1&destination=${activeMapNav.destLat},${activeMapNav.destLon}&travelmode=driving`, '_blank');
    }

    function zoomToActiveNavRoute() {
        if (!activeMapNav || !leafletMap) return;
        const bounds = [[activeMapNav.destLat, activeMapNav.destLon]];
        if (window.lastKnownTechCoords) bounds.push([window.lastKnownTechCoords.lat, window.lastKnownTechCoords.lon]);
        leafletMap.fitBounds(bounds, { padding: [45, 45], maxZoom: 16 });
    }

    function clearLocalMapRouteOnly() {
        activeMapNav = null;
        if (mapNavWatchId !== null && navigator.geolocation) { navigator.geolocation.clearWatch(mapNavWatchId); mapNavWatchId = null; }
        if (mapNavTimerId) { clearInterval(mapNavTimerId); mapNavTimerId = null; }
        routeLineLayer?.clearLayers();
        document.getElementById('mapActiveNavContainer')?.classList.add('hidden');
        renderLabeledPlacesList(false);
    }
    window.__stopScadaMapRoute = clearLocalMapRouteOnly;

    function stopLabeledPlaceNavigation(silent = false) {
        const wasNav = Boolean(activeMapNav);
        clearLocalMapRouteOnly();
        if (!silent && typeof window.finishMyEquipmentNavigation === 'function') {
            window.finishMyEquipmentNavigation(false);
        } else if (wasNav && !silent) {
            showToast('↩️ ยกเลิกการนำทางไปยังอุปกรณ์ไฟฟ้าแล้ว');
        }
    }

    // ========================================================================
    // 8. แผนที่ Leaflet, Canvas Renderer, Smart LOD, ซ่อนป้าย T-Tap & Lazy Cards
    // ========================================================================
    function isAnyEditModeActive() {
        return Boolean(scadaSettings.drawActive || moveState.active || pinMoveState.active);
    }

    function updatePinTooltipsVisibilityByZoom() {
        const mapEl = document.getElementById('labeledInteractiveMap');
        const btn = document.getElementById('togglePinNamesBtn');
        if (!mapEl) return;
        if (!showAllPinLabels) {
            mapEl.classList.add('hide-pin-tooltips');
            if (btn) btn.textContent = '🏷️ ชื่อรหัส: ปิด';
            return;
        }
        const curZoom = leafletMap ? leafletMap.getZoom() : 12;
        mapEl.classList.toggle('hide-pin-tooltips', curZoom < AUTO_LABEL_MIN_ZOOM);
        if (btn) btn.textContent = curZoom >= AUTO_LABEL_MIN_ZOOM ? `🏷️ ชื่อรหัส: แสดง (ซูม ${curZoom})` : '🏷️ ชื่อรหัส: อัตโนมัติ (ซูม ≥15)';
    }

    function toggleShowAllPinNames() {
        showAllPinLabels = !showAllPinLabels;
        updatePinTooltipsVisibilityByZoom();
        if (showAllPinLabels && leafletMap && leafletMap.getZoom() < AUTO_LABEL_MIN_ZOOM) {
            showToast(`🏷️ เปิดแสดงชื่อรหัสอัตโนมัติ (ซูมเข้าใกล้ระดับ ${AUTO_LABEL_MIN_ZOOM} ขึ้นไปเพื่อดูชื่อ)`);
        }
    }

    function toggleMapFullscreenMode() {
        const container = document.getElementById('mapFullscreenContainer');
        const btn = document.getElementById('toggleFullscreenMapBtn');
        if (!container) return;
        isMapFullscreen = !isMapFullscreen;
        container.classList.toggle('map-is-fullscreen', isMapFullscreen);
        if (btn) btn.innerHTML = isMapFullscreen ? '✖️ ย่อกลับขนาดปกติ' : '⛶ ขยายแผนที่เต็มจอ';
        setTimeout(() => leafletMap?.invalidateSize(), 150);
    }

    function toggleScadaSmartLodMode() {
        lodMode = (lodMode === 'auto') ? 'all' : 'auto';
        localStorage.setItem(LOD_MODE_KEY, lodMode);
        syncLodAndViewportMarkersNow();
        showToast(lodMode === 'auto' ? '🚀 โหมดลดกระตุกอัตโนมัติ: ซ่อนจุดย่อยเมื่อซูมมุมสูง (<13)' : '👁️ แสดงหมุดครบทุกชนิดในทุกระดับซูม');
    }

    function updateLodToolbarButtonUI() {
        const btn = document.getElementById('btnToggleScadaSmartLod');
        if (!btn) return;
        if (lodMode === 'auto') {
            btn.textContent = hiddenByLodCount > 0 ? `🚀 ลดกระตุก (ย่อ ${hiddenByLodCount})` : '🚀 ลดกระตุก: อัตโนมัติ';
            btn.className = 'bg-slate-800 hover:bg-slate-700 text-teal-300 border border-teal-500/50 px-2.5 py-1 rounded-xl text-[11px] font-bold transition';
        } else {
            btn.textContent = '👁️ หมุด: แสดงครบ';
            btn.className = 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-600 px-2.5 py-1 rounded-xl text-[11px] font-bold transition';
        }
    }

    function evaluatePinVisibility(pin, marker, zoom, paddedBounds, totalPins, editModeOn, hasSearchKw) {
        if (!marker || !pin) return { mount: false, hiddenByLod: false };
        if (marker.isPopupOpen?.()) return { mount: true, hiddenByLod: false };
        if (paddedBounds && !paddedBounds.contains(marker.getLatLng())) return { mount: false, hiddenByLod: false };
        if (lodMode === 'all' || hasSearchKw || simState.active || totalPins < ADAPTIVE_LOD_MIN_PINS) return { mount: true, hiddenByLod: false };
        if (editModeOn && zoom >= 13) return { mount: true, hiddenByLod: false };

        const eqType = pin.scadaNode?.t || (isPinTTap(pin, labeledPlaces) ? 'TAP' : 'PIN');
        const st = pin.scadaNode?.st || 'C';
        if (['RC', 'CB', 'VB', 'VS', 'VSC', 'S', 'GEN'].includes(eqType) || st === 'F') return { mount: true, hiddenByLod: false };
        const isTap = isPinTTap(pin, labeledPlaces);
        if (zoom < 13) return (!Core.ramIndex.hasBackboneSwitches && eqType === 'PIN' && !isTap) ? { mount: true, hiddenByLod: false } : { mount: false, hiddenByLod: true };
        if (zoom < 14 && isTap) return { mount: false, hiddenByLod: true };
        return { mount: true, hiddenByLod: false };
    }

    function syncLodAndViewportMarkersNow() {
        if (!leafletMap || !markersLayer || lodPinPool.size === 0) {
            hiddenByLodCount = 0;
            updateLodToolbarButtonUI();
            return;
        }
        const zoom = leafletMap.getZoom() ?? 12;
        const paddedBounds = leafletMap.getBounds ? leafletMap.getBounds().pad(0.28) : null;
        const totalPins = lodPinPool.size;
        const editOn = isAnyEditModeActive();
        const hasKw = Boolean((document.getElementById('searchLabeledPinInput')?.value || '').trim());
        let skipped = 0;

        lodPinPool.forEach((entry) => {
            const res = evaluatePinVisibility(entry.place, entry.marker, zoom, paddedBounds, totalPins, editOn, hasKw);
            if (res.hiddenByLod) skipped++;
            const mounted = markersLayer.hasLayer(entry.marker);
            if (res.mount && !mounted) {
                markersLayer.addLayer(entry.marker);
                bindPinDragEventsOnMarker(entry.place.id, entry.marker);
            } else if (!res.mount && mounted) {
                markersLayer.removeLayer(entry.marker);
            }
        });
        hiddenByLodCount = skipped;
        updateLodToolbarButtonUI();
    }

    function scheduleLodViewportSync() {
        if (syncMarkersRafId) return;
        syncMarkersRafId = requestAnimationFrame(() => { syncMarkersRafId = null; syncLodAndViewportMarkersNow(); });
    }

    function initLabeledLeafletMap() {
        if (leafletMap || typeof L === 'undefined') return;
        const mapContainer = document.getElementById('labeledInteractiveMap');
        if (!mapContainer) return;

        if (L.Popup) {
            L.Popup.prototype.options.autoPanPaddingTopLeft = [10, 64];
            L.Popup.prototype.options.autoPanPaddingBottomRight = [10, 16];
        }

        const defCenter = window.lastKnownTechCoords ? [window.lastKnownTechCoords.lat, window.lastKnownTechCoords.lon] : [13.095, 101.125];
        leafletMap = L.map('labeledInteractiveMap').setView(defCenter, 12);

        const gStreets = L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' }).addTo(leafletMap);
        const gHybrid = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: '© Google Maps' });
        const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
        L.control.layers({ '🗺️ แผนที่ถนน (Google)': gStreets, '🛰️ ดาวเทียม+ชื่อถนน (Google)': gHybrid, '🌐 OpenStreetMap': osm }, null, { position: 'topright' }).addTo(leafletMap);

        [['scadaUnifiedLinesPane', 389, false], ['scadaPreviewPane', 392, true], ['scadaWireGrabPane', 415, false], ['scadaWireMovePreviewPane', 420, true], ['scadaPinMovePreviewPane', 422, true], ['scadaWireGripsPane', 625, false]]
            .forEach(([name, z, noPtr]) => {
                const p = leafletMap.createPane(name);
                p.style.zIndex = String(z);
                if (noPtr) p.style.pointerEvents = 'none';
            });

        scadaCanvasRenderer = L.canvas({ pane: 'scadaUnifiedLinesPane', padding: 0.35 });
        const origFillStroke = scadaCanvasRenderer._fillStroke;
        scadaCanvasRenderer._fillStroke = function (ctx, layer) {
            if (layer?.options && layer.options.opacity === 0 && !layer.options.fill) return;
            return origFillStroke.call(this, ctx, layer);
        };
        ['Click', 'MouseMove'].forEach(evName => {
            const fnKey = '_on' + evName, orig = scadaCanvasRenderer[fnKey];
            if (typeof orig === 'function') scadaCanvasRenderer[fnKey] = function (e) { if (!isAnyEditModeActive()) return orig.call(this, e); };
        });

        unifiedLinesLayer = L.layerGroup().addTo(leafletMap);
        routeLineLayer = L.layerGroup().addTo(leafletMap);
        markersLayer = L.layerGroup().addTo(leafletMap);
        drawPreviewLayer = L.layerGroup().addTo(leafletMap);
        jumperPreviewLayer = L.layerGroup().addTo(leafletMap);
        grabLinesLayer = L.layerGroup().addTo(leafletMap);
        liveDragLayer = L.layerGroup().addTo(leafletMap);
        pinMovePreviewLayer = L.layerGroup().addTo(leafletMap);
        pinSelectionLayer = L.layerGroup().addTo(leafletMap);
        gripsLayer = L.layerGroup().addTo(leafletMap);

        if (mapContainer.parentElement && !document.getElementById('mapLongPressHintBadge')) {
            const hint = document.createElement('div');
            hint.id = 'mapLongPressHintBadge';
            hint.className = 'pointer-events-none absolute top-3 left-14 z-[400] bg-slate-900/80 text-white text-[10px] sm:text-[11px] font-bold px-2.5 py-1 rounded-full shadow-md border border-white/20 flex items-center gap-1';
            hint.innerHTML = '<span>👆 กดค้างบนแผนที่ เพื่อปักหมุดอุปกรณ์ใหม่</span>';
            mapContainer.parentElement.appendChild(hint);
        }

        // กดค้างบนแผนที่เพื่อปักหมุดใหม่ (ปิดอัตโนมัติในโหมดแก้ไขสาย/ซ้อม/สิทธิ์ดูอย่างเดียว)
        let lpTimer = null, lpStart = null, lastLpMs = 0;
        const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } lpStart = null; };
        const isMapInteractiveEl = (el) => Boolean(el?.closest?.('.leaflet-marker-icon, .leaflet-popup, .leaflet-control, button, a'));
        const triggerLongPressAt = (latlng) => {
            if (!latlng || isAnyEditModeActive() || simState.active || !canCurrentUserEditScada()) return;
            if (Date.now() - lastLpMs < 900) return;
            lastLpMs = Date.now();
            if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
            clearTempLongPressMarker();
            const ic = L.divIcon({ className: '', html: '<div style="width:32px;height:32px;border-radius:9999px;background:rgba(16,185,129,0.25);border:2px dashed #059669;display:flex;align-items:center;justify-content:center;"><span style="font-size:18px;">📍</span></div>', iconSize: [32, 32], iconAnchor: [16, 16] });
            tempLongPressMarker = L.marker([latlng.lat, latlng.lng], { icon: ic, zIndexOffset: 1000 }).addTo(leafletMap);
            openEquipPinModal(null, latlng.lat, latlng.lng);
        };

        leafletMap.on('contextmenu', (e) => { if (!isMapInteractiveEl(e.originalEvent?.target)) { cancelLp(); triggerLongPressAt(e.latlng); } });
        mapContainer.addEventListener('touchstart', (e) => {
            if (e.touches?.length !== 1 || isMapInteractiveEl(e.target)) return cancelLp();
            lpStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            lpTimer = setTimeout(() => {
                if (!lpStart || !leafletMap) return;
                const r = mapContainer.getBoundingClientRect();
                const ll = leafletMap.containerPointToLatLng(L.point(lpStart.x - r.left, lpStart.y - r.top));
                lpStart = null; triggerLongPressAt(ll);
            }, 600);
        }, { passive: true });
        mapContainer.addEventListener('touchmove', (e) => { if (lpStart && e.touches?.[0] && Math.hypot(e.touches[0].clientX - lpStart.x, e.touches[0].clientY - lpStart.y) > 12) cancelLp(); }, { passive: true });
        ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(ev => mapContainer.addEventListener(ev, cancelLp, { passive: true }));
        mapContainer.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || isMapInteractiveEl(e.target)) return;
            lpStart = { x: e.clientX, y: e.clientY };
            lpTimer = setTimeout(() => {
                if (!lpStart || !leafletMap) return;
                const r = mapContainer.getBoundingClientRect();
                const ll = leafletMap.containerPointToLatLng(L.point(lpStart.x - r.left, lpStart.y - r.top));
                lpStart = null; triggerLongPressAt(ll);
            }, 600);
        });
        mapContainer.addEventListener('mousemove', (e) => { if (lpStart && Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 12) cancelLp(); });

        leafletMap.on('movestart zoomstart dragstart popupopen', cancelLp);
        leafletMap.on('zoomstart', () => { if (zoomAnimClearTimer) clearTimeout(zoomAnimClearTimer); mapContainer.classList.add('scada-zoom-animating'); });
        leafletMap.on('zoomend', () => {
            jumperPreviewLayer?.clearLayers();
            updatePinTooltipsVisibilityByZoom();
            syncLodAndViewportMarkersNow();
            scheduleUnifiedScadaRefresh();
            zoomAnimClearTimer = setTimeout(() => mapContainer.classList.remove('scada-zoom-animating'), 80);
        });
        leafletMap.on('moveend', scheduleLodViewportSync);
        leafletMap.on('mousemove', (e) => renderLiveDrawCrossoverPreview(e.latlng));
        leafletMap.on('click', (e) => handleMapClickForScada(e));

        leafletMap.on('popupopen', (e) => {
            const pEl = e.popup?.getElement?.()?.querySelector('.leaflet-popup-content');
            if (pEl && !pEl.__scrollFixed) {
                pEl.__scrollFixed = true;
                L.DomEvent.disableScrollPropagation(pEl);
                L.DomEvent.disableClickPropagation(pEl);
                ['touchstart', 'touchmove', 'touchend', 'wheel', 'mousedown'].forEach(ev => pEl.addEventListener(ev, s => s.stopPropagation(), { passive: true }));
            }
            const fBtns = document.getElementById('mapFloatingActionBtns'), hBdg = document.getElementById('mapLongPressHintBadge');
            if (fBtns) { fBtns.style.opacity = '0.12'; fBtns.style.pointerEvents = 'none'; }
            if (hBdg) hBdg.style.opacity = '0';
            setTimeout(() => {
                enhanceOpenedPopup(e.popup);
                const wrap = mapContainer.querySelector('.leaflet-popup-content-wrapper');
                if (wrap && leafletMap) {
                    const gap = wrap.getBoundingClientRect().top - mapContainer.getBoundingClientRect().top;
                    if (gap < 62) leafletMap.panBy([0, -Math.round(62 - gap)], { animate: true, duration: 0.22 });
                }
            }, 30);
        });
        leafletMap.on('popupclose', () => {
            const fBtns = document.getElementById('mapFloatingActionBtns'), hBdg = document.getElementById('mapLongPressHintBadge');
            if (fBtns) { fBtns.style.opacity = '1'; fBtns.style.pointerEvents = 'auto'; }
            if (hBdg) hBdg.style.opacity = '1';
        });

        injectScadaToolbarUI();
        updateMyGpsMarkerOnLeaflet();
        renderLabeledPlacesList(true);
        scheduleUnifiedScadaRefresh();
    }

    function updateMyGpsMarkerOnLeaflet() {
        if (!leafletMap || typeof L === 'undefined') return;
        if (!window.lastKnownTechCoords || !window.isGpsTrackingEnabled) {
            if (techSelfMarker) { leafletMap.removeLayer(techSelfMarker); techSelfMarker = null; }
            return;
        }
        const ll = [window.lastKnownTechCoords.lat, window.lastKnownTechCoords.lon];
        if (!techSelfMarker) {
            const ic = L.divIcon({ className: '', html: '<div style="width:26px;height:26px;border-radius:9999px;background:#2563eb;border:3px solid #fff;box-shadow:0 0 10px rgba(37,99,235,0.8);display:flex;align-items:center;justify-content:center;font-size:13px;">🚗</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
            techSelfMarker = L.marker(ll, { icon: ic, zIndexOffset: 900 }).addTo(leafletMap).bindPopup('<b>🚗 ตำแหน่งปัจจุบันของคุณ</b>');
        } else techSelfMarker.setLatLng(ll);
    }

    function centerMapOnMyGps() {
        if (!navigator.geolocation) return;
        showToast('⏳ กำลังค้นหาพิกัดปัจจุบันของคุณ...');
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                if (typeof window.recordCurrentTechGpsLocation === 'function') window.recordCurrentTechGpsLocation(pos.coords.latitude, pos.coords.longitude);
                updateMyGpsMarkerOnLeaflet();
                leafletMap?.setView([pos.coords.latitude, pos.coords.longitude], 16);
                renderLabeledPlacesList(false);
                showToast('📍 ซูมไปยังตำแหน่งปัจจุบันแล้ว');
            },
            () => { if (window.lastKnownTechCoords && leafletMap) leafletMap.setView([window.lastKnownTechCoords.lat, window.lastKnownTechCoords.lon], 15); else showToast('⚠️ ไม่สามารถดึงพิกัด GPS ได้'); },
            { enableHighAccuracy: true, timeout: 7000 }
        );
    }

    function renderMarkersOnMap(filteredItems, autoFit = false, forceRedraw = false) {
        if (!leafletMap || !markersLayer) return;
        const list = Array.isArray(filteredItems) ? filteredItems : labeledPlaces.filter(canCurrentUserSeeEquipPin);
        const newSig = list.map(p => `${p.id}:${p.name}:${Number(p.lat).toFixed(6)}:${Number(p.lon).toFixed(6)}:${getEffectivePinColorKey(p)}:${p.note || ''}:${JSON.stringify(p.scadaNode || null)}`).join('|');

        if (!forceRedraw && !autoFit && newSig === lastRenderedMarkersSig) {
            updatePinTooltipsVisibilityByZoom();
            syncLodAndViewportMarkersNow();
            return;
        }
        lastRenderedMarkersSig = newSig;
        if (!cachedTopology) cachedTopology = computeUnifiedTopology(labeledPlaces.filter(canCurrentUserSeeEquipPin));

        const savedPopupId = currentlyOpenPopupPinId;
        markersLayer.clearLayers();
        lodPinPool.clear();
        markerMapById = {};
        const bounds = [];

        list.forEach(place => {
            const lat = parseFloat(place.lat), lon = parseFloat(place.lon);
            if (isNaN(lat) || isNaN(lon)) return;
            bounds.push([lat, lon]);

            const nState = cachedTopology?.nodeStates?.get(place.id);
            const icon = buildUnifiedNodeIcon(place, nState);
            const marker = L.marker([lat, lon], { icon });

            // ถอดป้ายชื่อลอยของหมุด T-Tap ออกถาวรทุกระดับซูม
            if (!isPinTTap(place, labeledPlaces)) {
                marker.bindTooltip(buildUnifiedTooltipHtml(place, nState), { permanent: true, direction: 'top', offset: [0, -26], className: 'labeled-pin-tooltip' });
            }

            const th = getPinColorTheme(getEffectivePinColorKey(place));
            const dueHtml = buildDueScheduleBadgeHtml(place);
            const quickColors = ALL_PIN_COLOR_KEYS.map(k => `<button type="button" onclick="quickChangeSinglePinColor('${place.id}', '${k}')" class="text-sm leading-none hover:scale-125 transition">${PIN_COLOR_THEMES[k].dot}</button>`).join('');

            marker.bindPopup(`
                <div style="font-family:'Prompt',sans-serif;min-width:240px;" class="space-y-1.5 text-xs">
                    <div class="flex items-center justify-between gap-1">
                        <span class="bg-teal-100 text-teal-800 text-[10px] font-bold px-2 py-0.5 rounded">🏢 ${escapeHtmlStr(getPinOwnerGroup(place))}</span>
                        <div class="flex items-center gap-2">
                            <button type="button" onclick="copyEquipPinToClipboard('${place.id}')" style="color:#4f46e5;font-weight:700;font-size:11px;">📋 คัดลอก</button>
                            <button type="button" onclick="shareEquipPinToLine('${place.id}')" style="color:#00B900;font-weight:700;font-size:11px;">💬 แชร์ LINE</button>
                            <button type="button" onclick="openEquipPinModal('${place.id}')" class="equip-real-edit-btn" style="color:#0f766e;font-weight:700;font-size:11px;">✏️ แก้ไข</button>
                        </div>
                    </div>
                    <div class="font-bold text-slate-900 text-sm break-words">${th.dot} ⚡ ${escapeHtmlStr(place.name)}</div>
                    ${dueHtml ? `<div>${dueHtml}</div>` : ''}
                    ${place.note ? `<div class="text-slate-600 text-[11px] break-words">${escapeHtmlStr(place.note)}</div>` : ''}
                    <div class="text-[10px] text-slate-400">${lat.toFixed(6)}, ${lon.toFixed(6)}</div>
                    <div class="equip-color-quick-row flex items-center justify-between bg-slate-100 px-2 py-1 rounded-lg"><span class="text-[10px] font-bold text-slate-600">🎨 สีหมุด:</span><div class="flex items-center gap-1">${quickColors}</div></div>
                    <div class="pt-1 flex gap-1">
                        <button type="button" onclick="startLabeledPlaceNavigation('${place.id}', false)" style="background:#0d9488;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;flex:1;">🚗 เริ่มเดินทาง</button>
                        <button type="button" onclick="startLabeledPlaceNavigation('${place.id}', true)" style="background:#2563eb;color:#fff;padding:5px 8px;border-radius:8px;font-weight:700;font-size:11px;flex:1;">🗺️ นำทาง Maps</button>
                    </div>
                </div>`);

            marker.on('click', () => {
                if (scadaSettings.drawActive) { leafletMap.closePopup(); handlePinClickedInDrawMode(place.id); }
            });
            marker.on('popupopen', () => { currentlyOpenPopupPinId = place.id; });
            marker.on('popupclose', () => { if (currentlyOpenPopupPinId === place.id) currentlyOpenPopupPinId = null; });

            markerMapById[place.id] = marker;
            lodPinPool.set(place.id, { place, marker });
        });

        syncLodAndViewportMarkersNow();
        updatePinTooltipsVisibilityByZoom();
        if (savedPopupId && markerMapById[savedPopupId]) {
            if (!markersLayer.hasLayer(markerMapById[savedPopupId])) markersLayer.addLayer(markerMapById[savedPopupId]);
            markerMapById[savedPopupId].openPopup();
        }
        if (autoFit && bounds.length > 0) leafletMap.fitBounds(bounds, { padding: [35, 35], maxZoom: 16 });
    }

    function fitAllLabeledPinsOnMap() {
        const visible = labeledPlaces.filter(p => canCurrentUserSeeEquipPin(p) && (currentPinColorFilter === 'all' || getEffectivePinColorKey(p) === currentPinColorFilter));
        if (!leafletMap || visible.length === 0) { showToast('⚠️ ไม่มีหมุดอุปกรณ์ไฟฟ้าในหมวดที่เลือก'); return; }
        const bounds = visible.map(p => [p.lat, p.lon]);
        if (window.lastKnownTechCoords && window.isGpsTrackingEnabled) bounds.push([window.lastKnownTechCoords.lat, window.lastKnownTechCoords.lon]);
        leafletMap.fitBounds(bounds, { padding: [35, 35], maxZoom: 16 });
    }

    function focusSinglePinOnMap(placeId) {
        const place = labeledPlaces.find(p => p.id === placeId && canCurrentUserSeeEquipPin(p));
        if (!place || !leafletMap) return;
        if (window.innerWidth < 1024 && !isMapFullscreen) document.getElementById('labeledInteractiveMap')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        leafletMap.setView([place.lat, place.lon], 17);
        const m = markerMapById[placeId];
        if (m) {
            if (!markersLayer.hasLayer(m)) markersLayer.addLayer(m);
            m.openPopup();
        }
    }

    function focusMapOnSearchMatch() {
        hideSearchEquipDropdown();
        const kw = (document.getElementById('searchLabeledPinInput')?.value || '').trim().toLowerCase();
        const matches = labeledPlaces.filter(p => canCurrentUserSeeEquipPin(p) && (currentPinColorFilter === 'all' || getEffectivePinColorKey(p) === currentPinColorFilter) && (!kw || String(p.name || '').toLowerCase().includes(kw) || String(p.note || '').toLowerCase().includes(kw) || `${p.lat},${p.lon}`.includes(kw)));
        if (matches.length === 0) { showToast('⚠️ ไม่พบรหัสอุปกรณ์ไฟฟ้าที่ค้นหาในหมวดนี้'); return; }
        if (window.innerWidth < 1024 && !isMapFullscreen) document.getElementById('labeledInteractiveMap')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (matches.length === 1) { focusSinglePinOnMap(matches[0].id); showToast(`🎯 พบอุปกรณ์: ${matches[0].name}`); }
        else { renderMarkersOnMap(matches, true, true); showToast(`🗺️ แสดงผลการค้นหาบนแผนที่ ${matches.length} จุด`); }
    }

    function buildSingleEquipCardElement(item) {
        const isCurNav = activeMapNav && activeMapNav.placeId === item.id;
        const th = getPinColorTheme(item.effectiveColor);
        const distBadge = item.roadKm !== null
            ? `<span class="bg-purple-50 text-purple-700 border border-purple-200 text-[10px] font-bold px-2 py-0.5 rounded-full">📍 ห่าง ~${item.roadKm.toFixed(1)} กม. (~${item.estMin} นาที)</span>`
            : `<span class="bg-slate-100 text-slate-500 text-[10px] px-2 py-0.5 rounded-full">${Number(item.lat).toFixed(5)}, ${Number(item.lon).toFixed(5)}</span>`;
        const colorBtns = ALL_PIN_COLOR_KEYS.map(k => `<button type="button" onclick="quickChangeSinglePinColor('${item.id}', '${k}')" class="text-xs leading-none hover:scale-125 transition ${th.key === k ? 'ring-1 ring-slate-700 rounded-full' : 'opacity-60 hover:opacity-100'}">${PIN_COLOR_THEMES[k].dot}</button>`).join('');

        const card = document.createElement('div');
        card.className = `p-3 rounded-2xl border bg-white shadow-sm space-y-2 transition ${isCurNav ? 'border-blue-500 ring-2 ring-blue-100 bg-blue-50/30' : 'border-slate-200 hover:border-teal-300'}`;
        card.innerHTML = `
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0 flex-1 space-y-0.5">
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="bg-teal-50 text-teal-800 border border-teal-200 text-[10px] font-bold px-1.5 py-0.5 rounded">🏢 ${escapeHtmlStr(getPinOwnerGroup(item))}</span>
                        <span class="border text-[10px] font-bold px-1.5 py-0.5 rounded ${th.badgeClass}">${th.dot} ${th.name}</span>
                        ${buildDueScheduleBadgeHtml(item)}
                        <span class="font-bold text-slate-800 text-xs sm:text-sm break-words">⚡ ${escapeHtmlStr(item.name)}</span>
                    </div>
                    ${item.note ? `<div class="text-[11px] text-slate-500 break-words">📝 ${escapeHtmlStr(item.note)}</div>` : ''}
                    <div class="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                        <span class="text-[10px] text-slate-400">📍 พิกัด: ${Number(item.lat).toFixed(6)}, ${Number(item.lon).toFixed(6)}</span>
                        <div class="equip-color-quick-row flex items-center gap-1 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded-lg"><span class="text-[9px] text-slate-500 font-semibold">สีหมุด:</span>${colorBtns}</div>
                    </div>
                </div>
                <div class="shrink-0 flex items-center gap-1">${distBadge}<button type="button" onclick="deleteSingleLabeledPin('${item.id}')" class="equip-real-edit-btn text-slate-300 hover:text-rose-500 px-1 text-sm font-bold">&times;</button></div>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-1.5 pt-1.5 border-t border-slate-100">
                <div class="flex flex-wrap gap-1.5">
                    <button type="button" onclick="focusSinglePinOnMap('${item.id}')" class="bg-slate-100 hover:bg-slate-200 text-slate-700 px-2.5 py-1.5 rounded-xl text-[11px] font-bold">🎯 ดูบนแมพ</button>
                    <button type="button" onclick="openEquipPinModal('${item.id}')" class="equip-real-edit-btn bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 px-2.5 py-1.5 rounded-xl text-[11px] font-bold">✏️ แก้ไข</button>
                    <button type="button" onclick="copyEquipPinToClipboard('${item.id}')" class="bg-indigo-600 hover:bg-indigo-700 text-white px-2.5 py-1.5 rounded-xl text-[11px] font-bold shadow-sm">📋 คัดลอก</button>
                    <button type="button" onclick="shareEquipPinToLine('${item.id}')" class="bg-[#00B900] hover:bg-[#009900] text-white px-2.5 py-1.5 rounded-xl text-[11px] font-bold shadow-sm">💬 แชร์ LINE</button>
                </div>
                <div class="flex gap-1.5">
                    ${!isViewerRole() ? `<button type="button" onclick="startLabeledPlaceNavigation('${item.id}', false)" class="bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 px-2.5 py-1.5 rounded-xl text-[11px] font-bold">🚗 ${isCurNav ? 'อัปเดตเวลา' : 'กดออกเดินทาง'}</button>` : ''}
                    <button type="button" onclick="startLabeledPlaceNavigation('${item.id}', true)" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-xl text-[11px] font-bold shadow-sm">🗺️ นำทาง Maps</button>
                </div>
            </div>`;
        return card;
    }

    function appendNextEquipCardsBatch() {
        const container = document.getElementById('labeledPlacesCardsContainer');
        if (!container || lazyCardsQueue.length === 0) return;
        document.getElementById('equipLazyLoadSentinelBtn')?.remove();

        const nextBatch = lazyCardsQueue.splice(0, CARD_PAGE_BATCH);
        const frag = document.createDocumentFragment();
        nextBatch.forEach(item => frag.appendChild(buildSingleEquipCardElement(item)));
        container.appendChild(frag);
        lazyMountedCount += nextBatch.length;

        if (lazyCardsQueue.length > 0) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'equipLazyLoadSentinelBtn';
            btn.onclick = appendNextEquipCardsBatch;
            btn.className = 'w-full py-2.5 px-4 bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-300 rounded-xl text-xs font-extrabold transition shadow-sm';
            btn.textContent = `⬇️ แสดงเพิ่มอีก ${Math.min(CARD_PAGE_BATCH, lazyCardsQueue.length)} รายการ (แสดงแล้ว ${lazyMountedCount} จาก ${lazyTotalCount} จุด)`;
            container.appendChild(btn);

            if ('IntersectionObserver' in window) {
                lazyScrollObserver?.disconnect();
                lazyScrollObserver = new IntersectionObserver((entries) => { if (entries.some(e => e.isIntersecting)) appendNextEquipCardsBatch(); }, { rootMargin: '260px' });
                lazyScrollObserver.observe(btn);
            }
        } else {
            lazyScrollObserver?.disconnect();
            lazyScrollObserver = null;
        }
    }

    function renderLabeledPlacesList(updateMapMarkers = false) {
        loadStoredLabeledPlaces();
        updateMainSwitcherButtonsStyle();
        updateAdminBulkColorBarVisibility();
        updateEquipColorFilterPillsUI();

        const myGroup = getActiveEquipUserGroup();
        const grpBadge = document.getElementById('currentEquipGroupHeaderBadge');
        if (grpBadge) grpBadge.textContent = `🏢 ${myGroup}`;

        const visiblePins = labeledPlaces.filter(canCurrentUserSeeEquipPin);
        const countBadge = document.getElementById('mapTabPinCountBadge');
        if (countBadge) countBadge.textContent = String(visiblePins.length);

        const container = document.getElementById('labeledPlacesCardsContainer');
        const summaryEl = document.getElementById('labeledListSummaryText');
        if (!container) return;

        const kw = (document.getElementById('searchLabeledPinInput')?.value || '').trim().toLowerCase();
        const sortBy = document.getElementById('sortLabeledPinsSelect')?.value || 'nearest';
        const startCoord = (window.isGpsTrackingEnabled && window.lastKnownTechCoords) ? window.lastKnownTechCoords : null;

        const kwFiltered = visiblePins.map(p => {
            const roadKm = startCoord ? Math.max(0.1, calcHaversineKm(startCoord.lat, startCoord.lon, p.lat, p.lon) * 1.35) : null;
            return { ...p, effectiveColor: getEffectivePinColorKey(p), roadKm, estMin: roadKm !== null ? Math.max(1, Math.round((roadKm / 45) * 60)) : null };
        }).filter(p => !kw || String(p.name || '').toLowerCase().includes(kw) || String(p.note || '').toLowerCase().includes(kw) || `${p.lat},${p.lon}`.includes(kw));

        const counts = { all: kwFiltered.length, green: 0, yellow: 0, orange: 0, red: 0, blue: 0, purple: 0, brown: 0 };
        kwFiltered.forEach(p => { if (counts[p.effectiveColor] !== undefined) counts[p.effectiveColor]++; });
        ['all', ...ALL_PIN_COLOR_KEYS].forEach(k => { const el = document.getElementById('countPinColor-' + k); if (el) el.textContent = String(counts[k]); });

        const filtered = kwFiltered.filter(p => currentPinColorFilter === 'all' || p.effectiveColor === currentPinColorFilter);
        if (sortBy === 'nearest' && startCoord) filtered.sort((a, b) => (a.roadKm ?? 99999) - (b.roadKm ?? 99999));
        else filtered.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'th'));

        if (summaryEl) {
            const cTag = currentPinColorFilter === 'all' ? '' : ` • เฉพาะ${getPinColorTheme(currentPinColorFilter).dot}${getPinColorTheme(currentPinColorFilter).name}`;
            summaryEl.textContent = (kw || currentPinColorFilter !== 'all') ? `🔍 แสดง ${filtered.length} จุด${cTag} (จาก ${visiblePins.length} จุด)` : `⚡ อุปกรณ์ไฟฟ้าใน ${myGroup} (${visiblePins.length} จุด)`;
        }
        if (updateMapMarkers) renderMarkersOnMap(filtered, false, false);

        lazyScrollObserver?.disconnect();
        container.innerHTML = '';
        if (filtered.length === 0) {
            container.innerHTML = `<div class="text-center py-8 px-4 bg-slate-50 rounded-2xl border border-dashed border-slate-300 text-xs text-slate-500 space-y-2"><div class="text-base font-bold text-slate-600">⚡ ไม่พบรายการอุปกรณ์ไฟฟ้า</div>${currentPinColorFilter !== 'all' ? `<div><button type="button" onclick="selectEquipPinColorFilter('all')" class="bg-teal-600 text-white px-3 py-1.5 rounded-xl font-bold text-xs shadow-sm">🔄 แสดงหมุดทุกสี (${kwFiltered.length} จุด)</button></div>` : ''}</div>`;
            return;
        }
        lazyCardsQueue = [...filtered];
        lazyTotalCount = filtered.length;
        lazyMountedCount = 0;
        appendNextEquipCardsBatch();
    }

    // ========================================================================
    // 9. เอนจินคำนวณการไหลของไฟ (BFS Topology), แยกสายขนาน & โค้งข้ามสายบน Canvas
    // ========================================================================
    function propagateColorToConnectedSystem(allPins, startNodeIds, newHex, options = {}) {
        const cleanHex = normHex(newHex);
        if (!cleanHex || !Array.isArray(allPins)) return 0;
        const nearestKey = hexToClosestPinColorKey(cleanHex);
        const crossOpen = Boolean(options.crossOpenSwitches);
        const nowIso = new Date(Date.now() + 25).toISOString();

        const pinById = new Map(), undirAdj = new Map();
        allPins.forEach(p => { if (p?.id && canCurrentUserSeeEquipPin(p)) { pinById.set(p.id, p); undirAdj.set(p.id, []); } });
        pinById.forEach(p => {
            (p.scadaLines || []).forEach((lineObj, edgeIdx) => {
                if (!lineObj || !pinById.has(lineObj.to)) return;
                undirAdj.get(p.id).push({ neighborId: lineObj.to, ownerPin: p, lineObj, edgeIdx });
                undirAdj.get(lineObj.to).push({ neighborId: p.id, ownerPin: p, lineObj, edgeIdx });
            });
        });

        const validStarts = (Array.isArray(startNodeIds) ? startNodeIds : [startNodeIds]).filter(id => pinById.has(id));
        if (validStarts.length === 0) return 0;

        const startSet = new Set(validStarts), visited = new Set(validStarts), queue = [...validStarts];
        let primBrkId = null, primBrkFd = '', touchedEdges = 0;
        validStarts.forEach(id => { const p = pinById.get(id); if (p && isBreakerType(p.scadaNode?.t)) { primBrkId = p.id; primBrkFd = normFd(p.scadaNode?.fd); } });

        if (options.directFromPinId && options.directEdgeIdx != null) {
            const dOwner = pinById.get(options.directFromPinId), dEdge = dOwner?.scadaLines?.[options.directEdgeIdx];
            if (dEdge) { dEdge.col = cleanHex; delete dEdge.customSingleCol; delete dEdge.customOwnerBrk; dOwner.updatedAt = nowIso; touchedEdges++; }
        }

        let head = 0;
        while (head < queue.length) {
            const curId = queue[head++], curPin = pinById.get(curId);
            if (!curPin) continue;
            const eqT = curPin.scadaNode?.t || 'PIN', st = (curPin.scadaNode?.st === 'O' || curPin.scadaNode?.st === 'F') ? curPin.scadaNode.st : 'C';
            const isBrk = isBreakerType(eqT);
            if (isBrk) {
                const fd = normFd(curPin.scadaNode?.fd);
                if (!primBrkId) { primBrkId = curPin.id; primBrkFd = fd; }
                else if (primBrkId !== curPin.id && primBrkFd && fd && primBrkFd !== fd) continue;
            }
            curPin.pinColor = nearestKey;
            if (curPin.scadaNode) curPin.scadaNode.col = cleanHex;
            curPin.updatedAt = nowIso;
            if (!crossOpen && st !== 'C' && !(startSet.has(curId) && isBrk)) continue;

            (undirAdj.get(curId) || []).forEach(({ neighborId, ownerPin, lineObj }) => {
                if (!crossOpen && lineObj.off) return;
                const nb = pinById.get(neighborId);
                if (!nb) return;
                if (isBreakerType(nb.scadaNode?.t) && primBrkId && primBrkId !== neighborId && primBrkFd && normFd(nb.scadaNode?.fd) && primBrkFd !== normFd(nb.scadaNode?.fd)) return;
                lineObj.col = cleanHex; delete lineObj.customSingleCol; delete lineObj.customOwnerBrk; ownerPin.updatedAt = nowIso; touchedEdges++;
                if (!visited.has(neighborId)) { visited.add(neighborId); queue.push(neighborId); }
            });
        }
        return touchedEdges;
    }

    window.__scadaSanitizePinsHook = function (pinsArr) {
        if (!Array.isArray(pinsArr) || pinsArr.length === 0) return;
        const pinSet = new Set(pinsArr.map(p => p?.id).filter(Boolean));
        const seenUndir = new Set();
        pinsArr.forEach(p => {
            if (!p || !Array.isArray(p.scadaLines)) return;
            p.scadaLines = p.scadaLines.filter(edge => {
                if (!edge?.to || edge.to === p.id || !pinSet.has(edge.to)) return false;
                const pair = p.id < edge.to ? `${p.id}__${edge.to}` : `${edge.to}__${p.id}`;
                const dk = `${pair}|${normFd(edge.fd)}|${normHex(edge.col) || '#10b981'}|${edge.st || 'oh'}`;
                if (seenUndir.has(dk)) return false;
                seenUndir.add(dk);
                return true;
            });
        });
    };

        function computeUnifiedTopology(pinsInput) {
        const pins = Array.isArray(pinsInput) ? pinsInput : labeledPlaces.filter(canCurrentUserSeeEquipPin);
        const pinMap = new Map(pins.map(p => [p.id, p])), adjMap = new Map(), edgesList = [], feedersSet = new Set();
        pins.forEach(p => { adjMap.set(p.id, []); if (p.scadaNode?.fd) feedersSet.add(p.scadaNode.fd); });

        pins.forEach((fromPin, pIdx) => {
            (fromPin.scadaLines || []).forEach((edge, edgeIdx) => {
                const toPin = pinMap.get(edge?.to);
                if (!toPin) return;
                if (edge.fd) feedersSet.add(edge.fd);
                const jp = edge.jp !== undefined ? Number(edge.jp) : (edge.st === 'ug' ? -1 : 0);
                const entry = { edgeKey: `${fromPin.id}__${edgeIdx}`, fromId: fromPin.id, toId: toPin.id, fromPin, toPin, edgeIdx, edge, off: Boolean(edge.off), orderScore: (jp * 1e15) + (edge.cat || ((pins.length - pIdx) * 100 + edgeIdx)), sourcesMap: new Map(), physDistByBrk: new Map() };
                edgesList.push(entry);
                adjMap.get(fromPin.id).push({ neighborId: toPin.id, entry });
                adjMap.get(toPin.id).push({ neighborId: fromPin.id, entry });
            });
        });

        const rawNodes = new Map(), allBreakers = [], closedBreakers = [];
        pins.forEach(p => {
            const eqType = p?.scadaNode?.t || (isPinTTap(p, pins) ? 'TAP' : 'PIN');
            const st = (p?.scadaNode?.st === 'O' || p?.scadaNode?.st === 'F') ? p.scadaNode.st : 'C';
            rawNodes.set(p.id, { pin: p, eqType, st, conductingMap: new Map(), terminalMap: new Map() });
            if (isBreakerType(eqType)) {
                const fd = normFd(p.scadaNode?.fd);
                const brk = { breakerId: p.id, name: p.name || 'CB', feeder: fd, color: getPinSavedColorHex(p), st, fullTitle: fd ? `${p.name || 'CB'} (${fd})` : (p.name || 'CB') };
                allBreakers.push(brk);
                if (st === 'C') closedBreakers.push(brk);
            }
        });

        allBreakers.forEach(brk => {
            const vis = new Map([[brk.breakerId, 0]]), q = [{ id: brk.breakerId, d: 0 }];
            for (let h = 0; h < q.length; h++) {
                const { id, d } = q[h];
                (adjMap.get(id) || []).forEach(({ neighborId, entry }) => {
                    if ((entry.physDistByBrk.get(brk.breakerId) ?? Infinity) > d + 1) entry.physDistByBrk.set(brk.breakerId, d + 1);
                    const nb = rawNodes.get(neighborId);
                    if (nb && !isBreakerType(nb.eqType) && !vis.has(neighborId)) { vis.set(neighborId, d + 1); q.push({ id: neighborId, d: d + 1 }); }
                });
            }
        });

        closedBreakers.forEach(brk => {
            const vis = new Map([[brk.breakerId, 0]]), q = [{ id: brk.breakerId, d: 0 }];
            rawNodes.get(brk.breakerId)?.conductingMap.set(brk.breakerId, { ...brk, dist: 0 });
            for (let h = 0; h < q.length; h++) {
                const { id, d } = q[h];
                (adjMap.get(id) || []).forEach(({ neighborId, entry }) => {
                    if (entry.off) return;
                    if ((entry.sourcesMap.get(brk.breakerId)?.dist ?? Infinity) > d + 1) entry.sourcesMap.set(brk.breakerId, { ...brk, dist: d + 1 });
                    const nb = rawNodes.get(neighborId);
                    if (!nb) return;
                    if (nb.st === 'C') { if (!vis.has(neighborId)) { vis.set(neighborId, d + 1); nb.conductingMap.set(brk.breakerId, { ...brk, dist: d + 1 }); q.push({ id: neighborId, d: d + 1 }); } }
                    else if ((nb.terminalMap.get(brk.breakerId)?.dist ?? Infinity) > d + 1) nb.terminalMap.set(brk.breakerId, { ...brk, dist: d + 1 });
                });
            }
        });

        // ตัดกิ่งแยกปลายสายที่มีไฟจ่ายเข้าฝั่งเดียวออกจากการนับเป็นสายขนาน 2 CB
        const anchorBrkMap = new Map(closedBreakers.map(b => [b.breakerId, b]));
        const condAdj = new Map(), trimmedNodes = new Set(), trimmedEdges = new Set();

        if (closedBreakers.length > 1) {
            rawNodes.forEach((tr, id) => { if (tr.st === 'C') condAdj.set(id, []); });
            edgesList.forEach(entry => {
                if (!entry.off && condAdj.has(entry.fromId) && condAdj.has(entry.toId)) {
                    condAdj.get(entry.fromId).push({ neighborId: entry.toId, edgeKey: entry.edgeKey });
                    condAdj.get(entry.toId).push({ neighborId: entry.fromId, edgeKey: entry.edgeKey });
                }
            });
            const deg = new Map(), trimQ = [];
            condAdj.forEach((list, id) => {
                deg.set(id, list.length);
                if (!anchorBrkMap.has(id) && list.length <= 1) trimQ.push(id);
            });
            for (let h = 0; h < trimQ.length; h++) {
                const u = trimQ[h];
                if (trimmedNodes.has(u)) continue;
                trimmedNodes.add(u);
                (condAdj.get(u) || []).forEach(({ neighborId, edgeKey }) => {
                    if (trimmedEdges.has(edgeKey)) return;
                    trimmedEdges.add(edgeKey);
                    if (!anchorBrkMap.has(neighborId) && !trimmedNodes.has(neighborId)) {
                        const nextDeg = (deg.get(neighborId) || 0) - 1;
                        deg.set(neighborId, nextDeg);
                        if (nextDeg <= 1) trimQ.push(neighborId);
                    }
                });
            }
        }

        const reachBrksWithout = (startId, blockedNodeId, blockedEdgeKey) => {
            const found = new Set();
            if (!condAdj.has(startId) || startId === blockedNodeId) return found;
            const vis = new Set([startId]), q = [startId];
            if (blockedNodeId) vis.add(blockedNodeId);
            for (let h = 0; h < q.length; h++) {
                const cur = q[h];
                if (anchorBrkMap.has(cur)) found.add(cur);
                (condAdj.get(cur) || []).forEach(({ neighborId, edgeKey }) => {
                    if (edgeKey === blockedEdgeKey || trimmedEdges.has(edgeKey) || vis.has(neighborId)) return;
                    vis.add(neighborId);
                    q.push(neighborId);
                });
            }
            return found;
        };

        const hasDistinctBrkPair = (setA, setB) => {
            if (!setA.size || !setB.size) return false;
            for (const a of setA) {
                for (const b of setB) { if (a !== b) return true; }
            }
            return false;
        };

        const edgeStates = new Map(), liveColsAtNode = new Map(pins.map(p => [p.id, []]));
        edgesList.forEach(entry => {
            const sources = Array.from(entry.sourcesMap.values()).sort((a, b) => a.dist - b.dist);
            const savedCol = normHex(entry.edge.col) || '#10b981';
            if (entry.off || sources.length === 0) {
                edgeStates.set(entry.edgeKey, { ...entry, energized: false, color: '#ffffff', savedColor: savedCol, primarySource: null, sources: [], isBackfeed: false, isParallel: false });
                return;
            }
            const prim = sources[0], eFd = normFd(entry.edge.fd), pDist = entry.physDistByBrk.get(prim.breakerId) ?? 999999;
            const isBackfeed = Boolean((eFd && prim.feeder && eFd !== prim.feeder && allBreakers.some(b => b.breakerId !== prim.breakerId && b.feeder === eFd && !entry.sourcesMap.has(b.breakerId))) || allBreakers.some(b => b.breakerId !== prim.breakerId && !entry.sourcesMap.has(b.breakerId) && !(eFd && prim.feeder && eFd === prim.feeder) && (entry.physDistByBrk.get(b.breakerId) ?? Infinity) < pDist));

            let isEdgeParallel = false;
            if (sources.length > 1 && !trimmedEdges.has(entry.edgeKey) && condAdj.has(entry.fromId) && condAdj.has(entry.toId)) {
                const sideFrom = reachBrksWithout(entry.fromId, entry.toId, entry.edgeKey);
                const sideTo = reachBrksWithout(entry.toId, entry.fromId, entry.edgeKey);
                isEdgeParallel = hasDistinctBrkPair(sideFrom, sideTo);
            }

            const dispCol = (entry.edge.customSingleCol && !isBackfeed && (!entry.edge.customOwnerBrk || entry.edge.customOwnerBrk === prim.breakerId)) ? savedCol : prim.color;
            liveColsAtNode.get(entry.fromId)?.push(dispCol);
            liveColsAtNode.get(entry.toId)?.push(dispCol);
            edgeStates.set(entry.edgeKey, { ...entry, energized: true, color: dispCol, savedColor: savedCol, primarySource: prim, sources: isEdgeParallel ? sources : [prim], isBackfeed, isParallel: isEdgeParallel });
        });

        const nodeStates = new Map();
        let energizedNodes = 0, deenergizedNodes = 0;
        rawNodes.forEach((tr, pinId) => {
            const cond = Array.from(tr.conductingMap.values()).sort((a, b) => a.dist - b.dist);
            const term = Array.from(tr.terminalMap.values()).sort((a, b) => a.dist - b.dist);
            if (isBreakerType(tr.eqType)) {
                if (tr.st === 'C') energizedNodes++; else deenergizedNodes++;
                nodeStates.set(pinId, { eqType: tr.eqType, st: tr.st, energized: tr.st === 'C', hasStandbyPower: false, primaryColor: getPinSavedColorHex(tr.pin), secondaryColor: term[0]?.color || null, primarySource: cond[0] || null, conductingSources: cond, terminalSources: term, isParallel: cond.length > 1, isTieTwoSources: false, isBackfeed: false });
            } else if (cond.length > 0) {
                energizedNodes++;
                const prim = cond[0], nFd = normFd(tr.pin.scadaNode?.fd);
                const isBf = Boolean(nFd && prim.feeder && nFd !== prim.feeder && allBreakers.some(b => b.breakerId !== prim.breakerId && b.feeder === nFd && !tr.conductingMap.has(b.breakerId)));

                let isNodeParallel = false, secCol = null;
                if (cond.length > 1 && !trimmedNodes.has(pinId) && condAdj.has(pinId)) {
                    const branchSets = [];
                    (condAdj.get(pinId) || []).forEach(({ neighborId, edgeKey }) => {
                        if (trimmedEdges.has(edgeKey)) return;
                        const bs = reachBrksWithout(neighborId, pinId, edgeKey);
                        if (bs.size > 0) branchSets.push(bs);
                    });
                    for (let i = 0; i < branchSets.length && !isNodeParallel; i++) {
                        for (let j = i + 1; j < branchSets.length; j++) {
                            if (hasDistinctBrkPair(branchSets[i], branchSets[j])) {
                                isNodeParallel = true;
                                break;
                            }
                        }
                    }
                    if (isNodeParallel) {
                        const secondBrk = cond.find(c => c.breakerId !== prim.breakerId);
                        secCol = secondBrk?.color || null;
                    }
                }

                nodeStates.set(pinId, { eqType: tr.eqType, st: tr.st, energized: true, hasStandbyPower: false, primaryColor: liveColsAtNode.get(pinId)?.[0] || prim.color, secondaryColor: secCol, primarySource: prim, conductingSources: isNodeParallel ? cond : [prim], terminalSources: term, isParallel: isNodeParallel, isTieTwoSources: false, isBackfeed: isBf });
            } else if (term.length > 0) {
                energizedNodes++;
                const liveNeighborBrkSets = new Map();
                (adjMap.get(pinId) || []).forEach(({ neighborId, entry }) => {
                    if (entry.off || liveNeighborBrkSets.has(neighborId)) return;
                    const nb = rawNodes.get(neighborId);
                    if (nb && nb.st === 'C' && nb.conductingMap.size > 0) {
                        liveNeighborBrkSets.set(neighborId, new Set(nb.conductingMap.keys()));
                    }
                });
                const sideSets = Array.from(liveNeighborBrkSets.values());
                let isRealTieTwoSources = false;
                if (term.length >= 2 && sideSets.length >= 2) {
                    for (let i = 0; i < sideSets.length && !isRealTieTwoSources; i++) {
                        for (let j = i + 1; j < sideSets.length; j++) {
                            if (hasDistinctBrkPair(sideSets[i], sideSets[j])) {
                                isRealTieTwoSources = true;
                                break;
                            }
                        }
                    }
                }
                const dispTerms = isRealTieTwoSources ? term : [term[0]];
                const secTermCol = isRealTieTwoSources ? (term.find(t => t.breakerId !== term[0].breakerId)?.color || null) : null;
                nodeStates.set(pinId, { eqType: tr.eqType, st: tr.st, energized: false, hasStandbyPower: true, primaryColor: term[0].color, secondaryColor: secTermCol, primarySource: term[0], conductingSources: [], terminalSources: dispTerms, isParallel: false, isTieTwoSources: isRealTieTwoSources, isBackfeed: false });
            } else {

                deenergizedNodes++;
                nodeStates.set(pinId, { eqType: tr.eqType, st: tr.st, energized: false, hasStandbyPower: false, primaryColor: '#334155', secondaryColor: null, primarySource: null, conductingSources: [], terminalSources: [], isParallel: false, isTieTwoSources: false, isBackfeed: false });
            }
        });
        return { pinMap, nodeStates, edgeStates, edgesList, feedersSet, stats: { totalBreakers: allBreakers.length, closedBreakers: closedBreakers.length, totalEdges: edgesList.length, energizedNodes, deenergizedNodes } };
    }

    function buildUnifiedNodeIcon(pin, nState) {
        const nd = pin?.scadaNode || {}, eqType = nState?.eqType || nd.t || (isPinTTap(pin, labeledPlaces) ? 'TAP' : 'PIN');
        const st = nState?.st || ((nd.st === 'O' || nd.st === 'F') ? nd.st : 'C');
        const warnDot = nd.lk ? `<div class="scada-warn-dot" title="${escapeHtmlStr(nd.lk)}">!</div>` : '';
        const tieBadge = nState?.isTieTwoSources ? `<div class="scada-tie-badge">⚡${nState.terminalSources.length}</div>` : '';

        if (isBreakerType(eqType)) {
            const ownCol = nState?.primaryColor || getPinSavedColorHex(pin), isC = st === 'C', isF = st === 'F';
            const bg = isF ? '#ef4444' : (isC ? ownCol : '#ffffff'), brd = isF ? '2.5px solid #fde047' : (isC ? '2.5px solid #ffffff' : `3px solid ${ownCol}`);
            const rev = (!isC && nState?.terminalSources?.length > 0 && !nd.lk) ? '<div class="scada-warn-dot">⚡</div>' : warnDot;
            return L.divIcon({ className: '', html: `<div class="scada-sym-wrap"><div class="scada-sym-breaker" style="background:${bg};border:${brd};color:${(isC || isF) ? '#fff' : '#0f172a'};">CB</div>${rev}</div>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -14] });
        }

        const isEn = Boolean(nState?.energized), hasSb = Boolean(nState?.hasStandbyPower), pCol = nState?.primaryColor || '#334155', sCol = nState?.secondaryColor;
        const bg = isEn ? pCol : (hasSb && st === 'F' ? '#fef2f2' : '#ffffff');
        const brd = isEn ? '2px solid #ffffff' : (hasSb ? (st === 'F' ? '2.5px solid #ef4444' : `3px solid ${pCol}`) : '2.5px solid #334155');
        const fg = isEn ? '#ffffff' : (hasSb && st === 'F' ? '#dc2626' : (hasSb ? '#0f172a' : '#334155'));
        const shd = sCol && (isEn || hasSb) ? `box-shadow:0 0 0 2.5px ${sCol},0 2px 6px rgba(0,0,0,0.45);` : '';
        const wCls = (isEn || hasSb) ? '' : 'scada-deenergized-pin';

        if (eqType === 'TAP') return L.divIcon({ className: wCls, html: `<div class="scada-sym-tap-wrap"><div class="scada-sym-tap-dot" style="background:${bg};border:${isEn ? '2px solid #fff' : (hasSb ? `2px solid ${st === 'F' ? '#ef4444' : pCol}` : '2px solid #334155')};${shd}"></div>${warnDot}${tieBadge}</div>`, iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -10] });
        if (eqType === 'PIN') return L.divIcon({ className: wCls, html: `<div style="position:relative;width:28px;height:28px;"><div style="width:28px;height:28px;border-radius:9999px 9999px 9999px 2px;transform:rotate(-45deg);background:${isEn ? pCol : '#fff'};border:${brd};box-shadow:0 3px 8px rgba(0,0,0,0.38);display:flex;align-items:center;justify-content:center;"><span style="transform:rotate(45deg);${isEn ? 'font-size:13px;' : 'font-size:12px;filter:grayscale(1);opacity:0.75;'}">⚡</span></div>${warnDot}${tieBadge}</div>`, iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -26] });
        if (eqType === 'S') return L.divIcon({ className: wCls, html: `<div class="scada-sym-knife-wrap"><div class="scada-sym-knife" style="background:${bg};border:${brd};${shd}"><svg width="24" height="13" viewBox="0 0 28 16"><path d="${st === 'C' ? 'M2 10 H26' : 'M2 12 H9.5 L16.5 3.5 M19 12 H26'}" fill="none" stroke="${fg}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9.5" cy="${st === 'C' ? 10 : 12}" r="1.7" fill="${fg}"/><circle cx="18.5" cy="${st === 'C' ? 10 : 12}" r="1.7" fill="${fg}"/></svg></div>${warnDot}${tieBadge}</div>`, iconSize: [32, 22], iconAnchor: [16, 11], popupAnchor: [0, -13] });

        const shape = eqType === 'VS' ? `<div class="scada-sym-diamond" style="background:${bg};border:${brd};${shd}"></div>`
            : (eqType === 'VSC' ? `<div class="scada-sym-circle" style="background:${bg};border:${brd};${shd}"></div>`
            : (eqType === 'DF' ? `<div class="scada-sym-fuse" style="background:${bg};border:${brd};color:${fg};${shd}">&amp;</div>`
            : (eqType === 'VB' ? `<div class="scada-sym-vb" style="background:${bg};border:${brd};color:${fg};${shd}">VB</div>`
            : `<div class="scada-sym-circle" style="background:${bg};border:${brd};color:${fg};${shd}">G</div>`)));
        return L.divIcon({ className: wCls, html: `<div class="scada-sym-wrap">${shape}${warnDot}${tieBadge}</div>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -14] });
    }

    function buildUnifiedTooltipHtml(pin, nState) {
        const nd = pin?.scadaNode || {}, eqType = nState?.eqType || nd.t || 'PIN', st = nState?.st || nd.st || 'C';
        const sym = { CB: '■', RC: '■', VB: '▣', VS: '◆', VSC: st === 'O' ? '○' : '●', S: '_/&nbsp;&nbsp;_', DF: '&amp;', GEN: 'Ⓖ', PIN: '⚡' }[eqType] || '⚡';
        const tail = isBreakerType(eqType) ? (st === 'C' ? ' (CB จ่ายไฟ)' : (st === 'F' ? ' (CB ทริป!)' : ' (CB ปลด)'))
            : (nState?.energized ? (nState.isBackfeed && nState.primarySource ? ` (ไฟย้อน: ${escapeHtmlStr(nState.primarySource.name)})` : (nState.isParallel ? ' (ขนานไฟ 2 CB)' : ''))
            : (nState?.hasStandbyPower ? (nState.isTieTwoSources ? ` (N.O. ชนไฟ: ${escapeHtmlStr(nState.terminalSources[0]?.name || 'CB1')} ↔ ${escapeHtmlStr(nState.terminalSources[1]?.name || 'CB2')})` : ` (N.O. รอไฟ: ${escapeHtmlStr(nState.primarySource?.name || 'CB')})`)
            : (st === 'O' ? ' (ปลด • ไม่มีไฟ)' : (st === 'F' && eqType === 'DF' ? ' (ฟิวส์ขาด)' : ' (⚪ ไม่มีไฟ)'))));
        return `${sym} ${escapeHtmlStr(pin.name)}${nd.id ? ` [ID ${escapeHtmlStr(nd.id)}]` : ''}${tail}`;
    }

    // คำนวณระยะเส้นสะสม แยกช่องเดินสายคู่ขนาน และสร้างโค้งสะพานข้ามสาย ⌒
    function buildCumLengths(pts) { const c = [0]; for (let i = 0; i < pts.length - 1; i++) c.push(c[i] + Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)); return c; }
    function getPointAtArcLength(pts, cum, s) {
        const tot = cum[cum.length - 1] || 0;
        if (s <= 0 || pts.length < 2) return { x: pts[0].x, y: pts[0].y, idx: 0 };
        if (s >= tot) return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, idx: pts.length - 2 };
        for (let i = 0; i < cum.length - 1; i++) {
            if (s >= cum[i] && s <= cum[i + 1]) {
                const t = (cum[i + 1] - cum[i]) > 1e-6 ? (s - cum[i]) / (cum[i + 1] - cum[i]) : 0;
                return { x: pts[i].x + t * (pts[i + 1].x - pts[i].x), y: pts[i].y + t * (pts[i + 1].y - pts[i].y), idx: i };
            }
        }
        return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, idx: pts.length - 2 };
    }
    function slicePolylineByArc(pts, cum, s1, s2) {
        if (s2 <= s1 + 0.05) return [];
        const p1 = getPointAtArcLength(pts, cum, s1), p2 = getPointAtArcLength(pts, cum, s2), out = [{ x: p1.x, y: p1.y }];
        for (let i = p1.idx + 1; i <= p2.idx; i++) if (cum[i] > s1 + 0.05 && cum[i] < s2 - 0.05) out.push({ x: pts[i].x, y: pts[i].y });
        out.push({ x: p2.x, y: p2.y }); return out;
    }

    function applyPixelLaneOffset(pxPts, offsetPx) {
        if (!pxPts || pxPts.length < 2 || Math.abs(offsetPx) < 0.25) return pxPts.slice();
        const cum = buildCumLengths(pxPts), tot = cum[cum.length - 1];
        if (tot < 8) return pxPts.slice();
        const eff = tot < 26 ? offsetPx * (tot / 26) : offsetPx, lead = Math.min(11, tot * 0.22);
        const core = slicePolylineByArc(pxPts, cum, lead, Math.max(lead + 0.5, tot - lead));
        if (core.length < 2) return pxPts.slice();
        const norms = [];
        for (let i = 0; i < core.length - 1; i++) {
            const dx = core[i + 1].x - core[i].x, dy = core[i + 1].y - core[i].y, l = Math.hypot(dx, dy);
            norms.push(l < 1e-5 ? (norms[norms.length - 1] || { x: 0, y: -1 }) : { x: -dy / l, y: dx / l });
        }
        const shifted = core.map((pt, idx) => {
            const n1 = norms[Math.max(0, idx - 1)], n2 = norms[Math.min(norms.length - 1, idx)];
            let bx = n1.x + n2.x, by = n1.y + n2.y, bl = Math.hypot(bx, by);
            if (bl < 1e-5) { bx = n1.x; by = n1.y; } else { bx /= bl; by /= bl; }
            const m = Math.min(1.55, 1 / Math.max(0.55, bx * n1.x + by * n1.y));
            return { x: pt.x + bx * eff * m, y: pt.y + by * eff * m };
        });
        return [pxPts[0], ...shifted, pxPts[pxPts.length - 1]];
    }

    function computeLaneOffsetsPx(items, gap) {
        const n = items.length, offsets = new Array(n).fill(0);
        if (!scadaSettings.antiOverlap) { for (let i = 0; i < n; i++) offsets[i] = (items[i].entry.edge.side || 0) * gap; return offsets; }
        const adj = Array.from({ length: n }, () => []);
        for (let i = 0; i < n; i++) {
            const A = items[i], pA = A.entry.fromId < A.entry.toId ? `${A.entry.fromId}_${A.entry.toId}` : `${A.entry.toId}_${A.entry.fromId}`;
            for (let j = i + 1; j < n; j++) {
                const B = items[j], pB = B.entry.fromId < B.entry.toId ? `${B.entry.fromId}_${B.entry.toId}` : `${B.entry.toId}_${B.entry.fromId}`;
                if (pA === pB) { adj[i].push(j); adj[j].push(i); }
            }
        }
        const vis = new Array(n).fill(false);
        for (let i = 0; i < n; i++) {
            if (vis[i]) continue;
            if (adj[i].length === 0) { offsets[i] = (items[i].entry.edge.side || 0) * gap; vis[i] = true; continue; }
            const comp = [], q = [i]; vis[i] = true;
            while (q.length) { const u = q.shift(); comp.push(u); adj[u].forEach(v => { if (!vis[v]) { vis[v] = true; q.push(v); } }); }
            comp.sort((a, b) => ((items[a].entry.edge.side || 0) - (items[b].entry.edge.side || 0)) || normFd(items[a].entry.edge.fd).localeCompare(normFd(items[b].entry.edge.fd)));
            const ref = items[comp[0]].basePxPts, rvx = ref[ref.length - 1].x - ref[0].x, rvy = ref[ref.length - 1].y - ref[0].y;
            comp.forEach((idx, rnk) => {
                const p = items[idx].basePxPts, sgn = ((p[p.length - 1].x - p[0].x) * rvx + (p[p.length - 1].y - p[0].y) * rvy) >= 0 ? 1 : -1;
                offsets[idx] = (rnk - (comp.length - 1) / 2) * gap * sgn;
            });
        }
        return offsets;
    }

    function buildWholePolylineJumperArcs(myPts, myMeta, underItems, radPx, flipDir) {
        if (!scadaSettings.autoJumper || !underItems?.length || !myPts || myPts.length < 2) return { segments: [myPts], bridges: [], jointDots: [] };
        const cum = buildCumLengths(myPts), tot = cum[cum.length - 1];
        if (tot < radPx * 2.4) return { segments: [myPts], bridges: [], jointDots: [] };
        const hits = [];
        for (let i = 0; i < myPts.length - 1; i++) {
            const A1 = myPts[i], A2 = myPts[i + 1], ax = A2.x - A1.x, ay = A2.y - A1.y, lA = cum[i + 1] - cum[i];
            if (lA < 0.5) continue;
            underItems.forEach(un => {
                for (let k = 0; k < un.pxPts.length - 1; k++) {
                    const B1 = un.pxPts[k], B2 = un.pxPts[k + 1], bx = B2.x - B1.x, by = B2.y - B1.y, lB = Math.hypot(bx, by);
                    const den = ax * by - ay * bx;
                    if (lB < 0.5 || Math.abs(den) < 1e-5 || Math.abs(den) / (lA * lB) < 0.17) continue;
                    const ta = ((B1.x - A1.x) * by - (B1.y - A1.y) * bx) / den, tb = ((B1.x - A1.x) * ay - (B1.y - A1.y) * ax) / den;
                    if (ta < -0.002 || ta > 1.002 || tb < -0.002 || tb > 1.002) continue;
                    const s = cum[i] + Math.max(0, Math.min(1, ta)) * lA;
                    if (s < radPx + 3.5 || s > tot - (radPx + 3.5)) continue;
                    if (myMeta && un.meta && (((myMeta.fromId === un.meta.fromId || myMeta.fromId === un.meta.toId) && s < 16) || ((myMeta.toId === un.meta.fromId || myMeta.toId === un.meta.toId) && (tot - s) < 16))) continue;
                    if (!hits.some(p => Math.abs(p - s) < 3.2)) hits.push(s);
                }
            });
        }
        if (!hits.length) return { segments: [myPts], bridges: [], jointDots: [] };
        hits.sort((a, b) => a - b);
        const spans = [];
        hits.forEach(s => {
            const st = Math.max(2.5, s - radPx), en = Math.min(tot - 2.5, s + radPx), lst = spans[spans.length - 1];
            if (lst && st <= lst.end + radPx * 0.85) lst.end = Math.min(tot - 2.5, Math.max(lst.end, en)); else spans.push({ start: st, end: en });
        });
        const cont = [], bridges = [], dots = [], fSgn = flipDir ? -1 : 1;
        let cur = 0;
        spans.forEach(sp => {
            if (sp.start > cur + 0.1) slicePolylineByArc(myPts, cum, cur, sp.start).forEach((p, idx) => { if (!cont.length || idx > 0) cont.push(p); });
            const pS = getPointAtArcLength(myPts, cum, sp.start), pE = getPointAtArcLength(myPts, cum, sp.end);
            const cx = pE.x - pS.x, cy = pE.y - pS.y, chL = Math.hypot(cx, cy);
            if (chL >= 2.5) {
                const ux = cx / chL, uy = cy / chL;
                let nx = -uy, ny = ux; if (ny > 0 || (Math.abs(ny) < 1e-4 && nx < 0)) { nx = -nx; ny = -ny; }
                nx *= fSgn; ny *= fSgn;
                const mx = (pS.x + pE.x) * 0.5, my = (pS.y + pE.y) * 0.5, hc = chL * 0.5, ah = Math.min(radPx * 1.55, Math.max(radPx * 1.08, hc * 0.88)), arc = [];
                for (let k = 0; k <= 14; k++) {
                    const th = Math.PI * (1 - k / 14), pt = { x: mx + Math.cos(th) * hc * ux + Math.sin(th) * ah * nx, y: my + Math.sin(th) * ah * ny + Math.cos(th) * hc * uy };
                    arc.push(pt); if (k > 0 || !cont.length) cont.push(pt);
                }
                bridges.push(arc); dots.push({ x: pS.x, y: pS.y }, { x: pE.x, y: pE.y });
            } else cont.push({ x: pE.x, y: pE.y });
            cur = sp.end;
        });
        if (cur < tot - 0.1) slicePolylineByArc(myPts, cum, cur, tot).forEach((p, idx) => { if (!cont.length || idx > 0) cont.push(p); });
        return { segments: [cont], bridges, jointDots: dots };
    }

    function scheduleUnifiedScadaRefresh() {
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = setTimeout(refreshUnifiedScadaAll, 22);
    }
    // ===== จบพาทที่ 3 / 4 ของไฟล์ scada-engine.js (นำพาทที่ 4 / 4 มาวางต่อจากบรรทัดนี้ได้เลยครับ) =====
    // ===== เริ่มพาทที่ 4 / 4 ของไฟล์ scada-engine.js (วางต่อจากพาทที่ 3 / 4 จนจบไฟล์) =====

    // ========================================================================
    // 10. เรนเดอร์เส้นสายส่งลง Canvas, อัปเดตสัญลักษณ์หมุด & แถบเครื่องมือ SCADA
    // ========================================================================
    function renderUnifiedScadaMap() {
        loadStoredLabeledPlaces();
        const pins = labeledPlaces.filter(canCurrentUserSeeEquipPin);
        cachedTopology = computeUnifiedTopology(pins);

        const st = cachedTopology.stats, statsBadge = document.getElementById('scadaBreakerLiveStatsBadge');
        if (statsBadge) {
            statsBadge.innerHTML = (st.totalBreakers === 0 && st.totalEdges > 0)
                ? '<span class="text-amber-300">⚠️ ยังไม่ได้ตั้งหมุด ■ CB ต้นทาง (สายแสดงสีขาว)</span>'
                : `■ CB จ่ายไฟ: <b class="text-emerald-400">${st.closedBreakers}/${st.totalBreakers}</b> • ⚡ มีไฟ: <b class="text-sky-300">${st.energizedNodes}</b> • ⚪ ดับ: <b class="text-slate-400">${st.deenergizedNodes}</b>`;
        }
        const filterSel = document.getElementById('scadaFeederFilterSelect');
        if (filterSel) {
            const cur = scadaSettings.feederFilter;
            filterSel.innerHTML = [`<option value="ALL" ${cur === 'ALL' ? 'selected' : ''}>🔌 แสดงทุกวงจร</option>`]
                .concat(Array.from(cachedTopology.feedersSet).sort().map(fd => `<option value="${escapeHtmlStr(fd)}" ${cur === fd ? 'selected' : ''}>⚡ เฉพาะวงจร ${escapeHtmlStr(fd)}</option>`)).join('');
        }
        if (!leafletMap || !unifiedLinesLayer) return;

        // อัปเดตสัญลักษณ์สวิตช์และซ่อนป้าย T-Tap ถาวร (คืนป้ายทันทีหากเปลี่ยนเป็นสวิตช์ปกติ)
        pins.forEach(pin => {
            const mk = markerMapById[pin.id];
            if (!mk) return;
            const nState = cachedTopology.nodeStates.get(pin.id);
            const icon = buildUnifiedNodeIcon(pin, nState);
            const sig = `${icon.options.className || ''}::${icon.options.html || ''}`;
            if (mk.__uniIconSig !== sig) {
                mk.__uniIconSig = sig; mk.options.icon = icon;
                if (mk._map) { mk._initIcon(); mk.update(); bindPinDragEventsOnMarker(pin.id, mk); }
            }
            if (isPinTTap(pin, pins)) {
                if (mk.getTooltip()) mk.unbindTooltip();
            } else {
                const tip = buildUnifiedTooltipHtml(pin, nState);
                if (mk.getTooltip()) { if (mk.__uniTipSig !== tip) { mk.__uniTipSig = tip; mk.setTooltipContent(tip); } }
                else { mk.__uniTipSig = tip; mk.bindTooltip(tip, { permanent: true, direction: 'top', offset: [0, -26], className: 'labeled-pin-tooltip' }); }
            }
        });

        unifiedLinesLayer.clearLayers();
        renderedEdgePathsMap.clear();
        cachedUnderPolylinesPx = [];
        if (!scadaSettings.showLines) return;

        const zoom = leafletMap.getZoom(), baseW = scadaSettings.lineWeight, items = [];
        cachedTopology.edgesList.forEach(entry => {
            const eState = cachedTopology.edgeStates.get(entry.edgeKey);
            if (!eState) return;
            if (scadaSettings.feederFilter !== 'ALL' && (entry.edge.fd || '') !== scadaSettings.feederFilter && eState.primarySource?.feeder !== normFd(scadaSettings.feederFilter)) return;
            const rawLL = [[Number(entry.fromPin.lat), Number(entry.fromPin.lon)], ...(entry.edge.w || []), [Number(entry.toPin.lat), Number(entry.toPin.lon)]];
            const basePxPts = rawLL.map(c => leafletMap.project(L.latLng(c[0], c[1]), zoom));
            items.push({ entry, eState, basePxPts });
        });

        const laneOffsets = computeLaneOffsetsPx(items, Math.max(5.8, baseW * 3.1));
        items.forEach((it, idx) => {
            it.laneOffset = laneOffsets[idx];
            it.offsetPxPts = applyPixelLaneOffset(it.basePxPts, laneOffsets[idx]);
            renderedEdgePathsMap.set(it.entry.edgeKey, it.offsetPxPts.map(pt => { const ll = leafletMap.unproject(L.point(pt.x, pt.y), zoom); return [ll.lat, ll.lng]; }));
        });
        items.sort((a, b) => a.entry.orderScore - b.entry.orderScore);

        const bridgeRad = Math.max(6.8, baseW * 3.6) * scadaSettings.jumperScale * (zoom >= 16 ? 1.15 : (zoom <= 13 ? 0.85 : 1.0));
        const underPolys = [], rOpt = scadaCanvasRenderer ? { renderer: scadaCanvasRenderer } : {};

        items.forEach(({ entry, eState, offsetPxPts, laneOffset }) => {
            const { fromPin, toPin, edge, edgeIdx } = entry;
            const jumped = buildWholePolylineJumperArcs(offsetPxPts, { fromId: entry.fromId, toId: entry.toId }, underPolys, bridgeRad, Boolean(edge.jf));
            underPolys.push({ pxPts: offsetPxPts, meta: { fromId: entry.fromId, toId: entry.toId } });

            const finalLL = (jumped.segments[0] || offsetPxPts).map(pt => { const ll = leafletMap.unproject(L.point(pt.x, pt.y), zoom); return [ll.lat, ll.lng]; });
            const isUg = edge.st === 'ug', dash = isUg ? '6, 5' : (entry.off ? '4, 6' : null);

            jumped.bridges.forEach(arcPx => {
                const arcLL = arcPx.map(pt => { const ll = leafletMap.unproject(L.point(pt.x, pt.y), zoom); return [ll.lat, ll.lng]; });
                L.polyline(arcLL, { ...rOpt, pane: 'scadaUnifiedLinesPane', color: '#ffffff', weight: baseW + 6.4, opacity: 0.92, lineCap: 'butt', interactive: false }).addTo(unifiedLinesLayer);
                L.polyline(arcLL, { ...rOpt, pane: 'scadaUnifiedLinesPane', color: '#0f172a', weight: baseW + 3.6, opacity: 0.92, lineCap: 'round', interactive: false }).addTo(unifiedLinesLayer);
            });

            if (!eState.energized) {
                L.polyline(finalLL, { ...rOpt, pane: 'scadaUnifiedLinesPane', color: '#334155', weight: baseW + 2.6, opacity: 0.95, dashArray: dash, interactive: false }).addTo(unifiedLinesLayer);
                L.polyline(finalLL, { ...rOpt, pane: 'scadaUnifiedLinesPane', color: '#ffffff', weight: baseW + 0.4, opacity: 1, dashArray: dash, interactive: false }).addTo(unifiedLinesLayer);
            } else {
                const lw = (eState.isBackfeed || eState.isParallel) ? baseW + 0.5 : baseW;
                if (eState.isBackfeed || eState.isParallel) L.polyline(finalLL, { ...rOpt, pane: 'scadaUnifiedLinesPane', color: '#1e293b', weight: lw + 2.2, opacity: 0.88, interactive: false }).addTo(unifiedLinesLayer);
                L.polyline(finalLL, { ...rOpt, pane: 'scadaUnifiedLinesPane', color: eState.color, weight: lw, opacity: 1, dashArray: dash, interactive: false }).addTo(unifiedLinesLayer);
            }
            if (jumped.jointDots.length > 0 && zoom >= 14) {
                jumped.jointDots.forEach(pt => {
                    const ll = leafletMap.unproject(L.point(pt.x, pt.y), zoom);
                    L.circleMarker([ll.lat, ll.lng], { ...rOpt, pane: 'scadaUnifiedLinesPane', radius: Math.max(1.8, baseW * 0.85), color: '#0f172a', weight: 1, fillColor: eState.energized ? eState.color : '#334155', fillOpacity: 1, interactive: false }).addTo(unifiedLinesLayer);
                });
            }

            const hit = L.polyline(finalLL, { ...rOpt, pane: 'scadaUnifiedLinesPane', color: '#000', weight: 18, opacity: 0, interactive: true }).addTo(unifiedLinesLayer);
            hit.on('click', ev => { window.__scadaLastLineClickLat = ev.latlng.lat; window.__scadaLastLineClickLon = ev.latlng.lng; });

            const stBdg = entry.off ? '<span class="bg-slate-200 text-slate-800 px-1.5 py-0.5 rounded text-[10px] font-bold">🔌 จำลองปลดสาย</span>' : (!eState.energized ? '<span class="bg-slate-100 text-slate-800 border border-slate-300 px-1.5 py-0.5 rounded text-[10px] font-extrabold">⚪ ไม่มีไฟ</span>' : (eState.isParallel ? '<span class="bg-amber-100 text-amber-900 border border-amber-300 px-1.5 py-0.5 rounded text-[10px] font-extrabold">⚡ ขนานเบรกเกอร์</span>' : (eState.isBackfeed ? '<span class="bg-indigo-100 text-indigo-800 border border-indigo-300 px-1.5 py-0.5 rounded text-[10px] font-extrabold">🔄 รับไฟย้อน</span>' : '<span class="bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded text-[10px] font-extrabold">🟢 มีไฟปกติ</span>')));
            const srcTxt = entry.off ? '<div class="text-[11px] text-rose-600 font-bold">⚪ ไม่มีไฟ (ปลดสายช่วงนี้)</div>' : (!eState.energized ? '<div class="text-[11px] text-slate-600 font-semibold">⚪ ยังไม่ได้รับไฟจาก ■ CB</div>' : (eState.isParallel ? `<div class="text-[11px] text-amber-800 font-bold">⚡ รับไฟขนานจาก: ${escapeHtmlStr(eState.sources.map(s => s.name).join(' + '))}</div>` : `<div class="text-[11px] ${eState.isBackfeed ? 'text-indigo-700' : 'text-emerald-700'} font-bold">${eState.isBackfeed ? '🔄 รับไฟย้อนจาก:' : '⚡ รับไฟจาก:'} ${escapeHtmlStr(eState.primarySource.fullTitle)}</div>`));
            const lMode = edge.jp === 1 ? 'โค้งบน' : (edge.jp === -1 ? 'ลอดล่าง' : 'อัตโนมัติ');

            hit.bindPopup(`<div style="font-family:'Prompt',sans-serif;min-width:245px;" class="space-y-1.5 text-xs"><div class="flex justify-between gap-1"><span class="px-2 py-0.5 rounded font-extrabold text-white text-[10px]" style="background:${escapeHtmlStr(eState.energized ? eState.color : eState.savedColor)}">⚡ วงจร ${escapeHtmlStr(edge.fd || '-')}</span>${stBdg}</div><div class="font-bold text-slate-800">${escapeHtmlStr(fromPin.name)} ➔ ${escapeHtmlStr(toPin.name)}</div>${srcTxt}<div class="text-[11px] text-slate-500">${isUg ? '╍ UG.' : '⎯ OH'} ${edge.lb ? `• <b>${escapeHtmlStr(edge.lb)}</b>` : ''} (${Math.abs(laneOffset) > 0.3 ? `ขนาน ${laneOffset.toFixed(1)}px` : 'แนวกลาง'})</div><div class="scada-edit-only pt-1.5 border-t border-slate-200 grid grid-cols-2 gap-1"><button type="button" onclick="startInteractiveWireMove('${fromPin.id}', ${edgeIdx})" class="col-span-2 bg-gradient-to-r from-sky-600 to-cyan-600 text-white py-1.5 px-2 rounded-lg font-extrabold text-[10px]">✋ จับขยับ / ดัดแนวสายไฟเส้นนี้</button><button type="button" onclick="openScadaColorPaletteModal('edge', '${fromPin.id}', ${edgeIdx})" class="col-span-2 bg-gradient-to-r from-indigo-600 to-purple-600 text-white py-1.5 px-2 rounded-lg font-extrabold text-[10px]">🎨 เปลี่ยนสีสายไฟ (ทั้งระบบที่เชื่อมต่อ)</button><button type="button" onclick="cycleScadaEdgeJumpLayer('${fromPin.id}', ${edgeIdx})" class="bg-teal-50 text-teal-800 border border-teal-200 py-1 px-2 rounded-lg font-bold text-[10px]">⌒ ชั้น: ${lMode}</button><button type="button" onclick="flipScadaEdgeJumpDir('${fromPin.id}', ${edgeIdx})" class="bg-teal-50 text-teal-800 border border-teal-200 py-1 px-2 rounded-lg font-bold text-[10px]">🔄 กลับโค้ง</button><button type="button" onclick="createTTapOnScadaEdge('${fromPin.id}', ${edgeIdx})" class="col-span-2 bg-indigo-50 text-indigo-700 border border-indigo-200 py-1 px-2 rounded-lg font-bold text-[10px]">✂️ แทปสาย (T-Tap) / แยกวงจรตรงนี้</button><button type="button" onclick="toggleScadaEdgePower('${fromPin.id}', ${edgeIdx})" class="bg-slate-100 text-slate-800 py-1 px-2 rounded-lg font-bold text-[10px]">${entry.off ? '⚡ ต่อสายคืน' : '🔌 จำลองปลดสาย'}</button><button type="button" onclick="toggleScadaEdgeUgStyle('${fromPin.id}', ${edgeIdx})" class="bg-sky-50 text-sky-800 py-1 px-2 rounded-lg font-bold text-[10px]">🔄 OH / UG.</button><button type="button" onclick="cycleScadaEdgeSide('${fromPin.id}', ${edgeIdx})" class="bg-emerald-50 text-emerald-800 py-1 px-2 rounded-lg font-bold text-[10px]">↔️ สลับฝั่งขนาน</button><button type="button" onclick="straightenScadaEdge('${fromPin.id}', ${edgeIdx})" class="bg-amber-50 text-amber-800 py-1 px-2 rounded-lg font-bold text-[10px]">📐 เส้นตรง</button><button type="button" onclick="deleteScadaEdge('${fromPin.id}', ${edgeIdx})" class="col-span-2 bg-rose-50 text-rose-600 py-1 px-2 rounded-lg font-bold text-[10px]">🗑️ ลบเส้นสายไฟช่วงนี้</button></div></div>`, { autoPan: true });
        });
        cachedUnderPolylinesPx = underPolys;
        if (moveState.active) scheduleRebuildGrabHandles();
    }

    function refreshUnifiedScadaAll() {
        injectScadaToolbarUI();
        renderUnifiedScadaMap();
        renderScadaDrawPreview();
    }

    function renderQuickToolbarColorButtons(activeHex) {
        const wrap = document.getElementById('scadaQuickColorRowWrap');
        if (!wrap) return;
        const clean = (normHex(activeHex) || '#10b981').toLowerCase();
        const inQuick = QUICK_BAR_COLORS.some(h => h.toLowerCase() === clean);
        wrap.innerHTML = `<span class="text-[10px] text-slate-300 font-bold mr-0.5">สีวงจร:</span>` +
            QUICK_BAR_COLORS.map(h => `<button type="button" onclick="setScadaDrawColor('${h}')" class="w-5 h-5 rounded-full border-2 transition shrink-0" style="background:${h};border-color:${h.toLowerCase() === clean ? '#fff' : 'transparent'};"></button>`).join('') +
            (!inQuick ? `<button type="button" onclick="openScadaColorPaletteModal('toolbar')" class="w-5 h-5 rounded-full border-2 border-white shrink-0" style="background:${clean};"></button>` : '') +
            `<button type="button" onclick="openScadaColorPaletteModal('toolbar')" class="ml-auto bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 text-white px-2.5 py-1 rounded-lg text-[10px] font-extrabold shadow shrink-0">🎨 จานสี+</button>`;
    }

    function updateToolbarToggleButtonsUI() {
        const setBtn = (id, on, txtOn, txtOff, clsOn) => {
            const b = document.getElementById(id);
            if (!b) return;
            b.textContent = on ? txtOn : txtOff;
            b.className = `bg-slate-800 hover:bg-slate-700 px-2.5 py-1 rounded-xl text-[11px] font-bold transition border ${on ? clsOn : 'text-slate-400 border-slate-600'}`;
        };
        setBtn('btnToggleScadaLines', scadaSettings.showLines, '👁️ เส้นไฟ: เปิด', '🚫 เส้นไฟ: ซ่อน', 'text-emerald-300 border-slate-600');
        setBtn('btnToggleAutoJumper', scadaSettings.autoJumper, '⌒ โค้งข้ามสาย: เปิด', '⌒ โค้งข้ามสาย: ปิด', 'text-amber-300 border-amber-400/60');
        setBtn('btnToggleAntiOverlap', scadaSettings.antiOverlap, '∥ กันสายทับ: เปิด', '∥ กันสายทับ: ปิด', 'text-sky-300 border-sky-500/50');
        updateLodToolbarButtonUI();
        updateSimVisualChrome();
        const roBadge = document.getElementById('scadaRoleReadOnlyBadge');
        if (roBadge) roBadge.classList.toggle('hidden', canCurrentUserEditScada());
    }

    function injectScadaToolbarUI() {
        const mapBox = document.getElementById('mapFullscreenContainer');
        if (mapBox && !document.getElementById('scadaControlToolbar')) {
            const bar = document.createElement('div');
            bar.id = 'scadaControlToolbar';
            bar.className = 'mb-2 p-2.5 bg-slate-900 text-white rounded-2xl shadow-md border border-slate-700 space-y-2 text-xs';
            bar.innerHTML = `
                <div class="flex flex-wrap items-center justify-between gap-1.5">
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="bg-teal-500/20 border border-teal-400/40 text-teal-300 px-2 py-0.5 rounded-lg font-extrabold text-[11px]">⚡ ผังวงจร SCADA</span>
                        <select id="scadaFeederFilterSelect" onchange="onScadaFeederFilterChange(this.value)" class="px-2 py-1 rounded-lg bg-slate-800 text-white border border-slate-600 text-[11px] font-bold"><option value="ALL">🔌 แสดงทุกวงจร</option></select>
                        <select id="scadaLineWeightSelect" onchange="onScadaLineWeightChange(this.value)" class="px-2 py-1 rounded-lg bg-slate-800 text-slate-200 border border-slate-600 text-[11px] font-semibold"><option value="1.2" ${scadaSettings.lineWeight === 1.2 ? 'selected' : ''}>เส้นบาง (1.2px)</option><option value="1.8" ${scadaSettings.lineWeight === 1.8 ? 'selected' : ''}>มาตรฐาน CAD (1.8px)</option><option value="2.6" ${scadaSettings.lineWeight === 2.6 ? 'selected' : ''}>เส้นคมชัด (2.6px)</option></select>
                        <span id="scadaBreakerLiveStatsBadge" class="bg-slate-800 border border-slate-600 text-[10px] font-bold px-2 py-0.5 rounded-lg text-slate-200"></span>
                    </div>
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <button type="button" id="btnToggleScadaSimMode" onclick="toggleScadaSimMode()">🧪 ซ้อมสับ-ปลด</button>
                        <button type="button" id="btnToggleAutoJumper" onclick="toggleScadaAutoJumperMode()"></button>
                        <button type="button" id="btnToggleAntiOverlap" onclick="toggleScadaAntiOverlapMode()"></button>
                        <button type="button" id="btnToggleScadaSmartLod" onclick="toggleScadaSmartLodMode()"></button>
                        <button type="button" id="btnToggleScadaLines" onclick="toggleScadaLinesVisibility()"></button>
                        <button type="button" id="btnTogglePinMoveMode" onclick="toggleScadaPinMoveMode()" class="scada-edit-only bg-teal-700 hover:bg-teal-600 text-white border border-teal-400/50 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow">📍 ขยับหมุด</button>
                        <button type="button" id="btnToggleWireMoveMode" onclick="toggleScadaWireMoveMode()" class="scada-edit-only bg-sky-600 hover:bg-sky-500 text-white px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow">✋ ขยับสาย</button>
                        <button type="button" id="btnToggleScadaDrawMode" onclick="toggleScadaDrawMode()" class="scada-edit-only bg-amber-500 hover:bg-amber-400 text-slate-950 px-3 py-1 rounded-xl text-[11px] font-extrabold shadow">✏️ วาดเส้นสายไฟ</button>
                        <span id="scadaRoleReadOnlyBadge" class="hidden bg-slate-800 text-amber-300 border border-amber-400/40 px-2.5 py-1 rounded-xl text-[10px] font-bold">🔒 ดูผังอย่างเดียว</span>
                    </div>
                </div>
                <div id="scadaDrawActivePanel" class="hidden pt-2 border-t border-slate-700 space-y-2">
                    <div class="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                        <input type="text" id="scadaActiveFeederInput" value="${escapeHtmlStr(scadaSettings.activeFeeder)}" oninput="onScadaActiveFeederInput(this.value)" placeholder="วงจร เช่น BNG6" class="px-2.5 py-1.5 rounded-lg bg-slate-800 text-amber-300 border border-slate-600 text-xs font-bold uppercase">
                        <input type="text" id="scadaActiveSpecInput" value="${escapeHtmlStr(scadaSettings.activeSpec)}" oninput="onScadaActiveSpecInput(this.value)" placeholder="สาย เช่น 185 SAC" class="px-2.5 py-1.5 rounded-lg bg-slate-800 text-white border border-slate-600 text-xs">
                        <select id="scadaActiveStyleSelect" onchange="onScadaActiveStyleChange(this.value)" class="px-2 py-1.5 rounded-lg bg-slate-800 text-white border border-slate-600 text-[11px] font-bold"><option value="oh">⎯ สายอากาศ (OH)</option><option value="ug">╍ เคเบิลใต้ดิน (UG.)</option></select>
                        <select id="scadaActiveRouteModeSelect" onchange="onScadaRouteModeChange(this.value)" class="px-2 py-1.5 rounded-lg bg-slate-800 text-sky-300 border border-slate-600 text-[11px] font-bold"><option value="road" ${scadaSettings.routeMode === 'road' ? 'selected' : ''}>🛣️ เกาะถนน (สวนเลนได้)</option><option value="cad" ${scadaSettings.routeMode === 'cad' ? 'selected' : ''}>📐 เส้นตรง / ดัดมุม CAD</option></select>
                        <select id="scadaActiveSideSelect" onchange="onScadaSideOffsetChange(this.value)" class="col-span-2 sm:col-span-1 px-2 py-1.5 rounded-lg bg-slate-800 text-emerald-300 border border-slate-600 text-[11px] font-bold"><option value="0">↕️ แนวกลางถนน</option><option value="-1">⬅️ ฝั่งซ้ายถนน</option><option value="1">➡️ ฝั่งขวาถนน</option></select>
                    </div>
                    <div class="bg-slate-800/90 px-2.5 py-2 rounded-xl border border-slate-700 space-y-2">
                        <div id="scadaQuickColorRowWrap" class="flex items-center gap-1.5 flex-wrap w-full pb-1.5 border-b border-slate-700/80"></div>
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <div id="scadaDrawStatusHint" class="text-[11px] font-bold text-amber-300 truncate">👆 จิ้มหมุดต้นทาง เพื่อเริ่มลากสายไฟ</div>
                            <div class="flex items-center gap-1"><button type="button" id="btnToolbarUndoOnePoint" onclick="undoScadaDrawOnePoint()">↩️ ย้อนกลับ (0)</button><button type="button" id="btnToolbarRedoOnePoint" onclick="redoScadaDrawOnePoint()" class="hidden bg-slate-700 text-white px-2 py-1 rounded-lg text-[10px] font-bold">↪️</button><button type="button" onclick="resetScadaDrawSource()" class="bg-sky-600 text-white px-2 py-1 rounded-lg text-[10px] font-bold">✂️ จุดแยกใหม่</button></div>
                        </div>
                    </div>
                </div>
                <div id="scadaMoveWirePanel" class="hidden pt-2 border-t border-slate-700 space-y-2">
                    <div class="flex flex-wrap items-center justify-between gap-1.5">
                        <div class="flex flex-wrap items-center gap-1"><button type="button" id="btnWireSubMode-grip" onclick="setScadaWireMoveSubMode('grip')">👆 ดึงดัดสาย</button><button type="button" id="btnWireSubMode-shift" onclick="setScadaWireMoveSubMode('shift')">↔️ เลื่อนทั้งเส้น</button><button type="button" id="btnWireSubMode-delete_vertex" onclick="setScadaWireMoveSubMode('delete_vertex')">🗑️ แตะลบมุม</button></div>
                        <div class="flex flex-wrap items-center gap-1"><button type="button" id="btnWireOrthoToggle" onclick="toggleScadaWireOrthoSnap()">📐 มุมฉาก: ปิด</button><button type="button" onclick="straightenSelectedWire()" class="px-2 py-1 rounded-lg text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-400/40">📏 ดึงตึง</button><button type="button" id="btnWireUndoMove" onclick="undoScadaWireMove()" class="px-2 py-1 rounded-lg text-[10px] font-bold bg-slate-700 text-white">↩️ ย้อนกลับ (0)</button></div>
                    </div>
                    <div id="scadaMoveWireHintText" class="text-[11px] font-bold text-cyan-300 bg-slate-800/90 px-2.5 py-1.5 rounded-xl border border-slate-700"></div>
                </div>
                <div id="scadaMovePinPanel" class="hidden pt-2 border-t border-slate-700 space-y-2">
                    <div class="flex flex-wrap items-center justify-between gap-1.5">
                        <div class="flex flex-wrap items-center gap-1"><button type="button" id="btnPinMoveSnapToggle" onclick="togglePinMoveWireSnap()">🧲 ดูดเข้าสายไฟ: เปิด</button><button type="button" id="btnPinMoveTapPlaceToggle" onclick="togglePinMoveTapToPlace()">🎯 แตะแมพเพื่อวาง: เปิด</button></div>
                        <div class="flex flex-wrap items-center gap-1"><button type="button" onclick="openSelectedPinModalFromMoveBar()" class="px-2 py-1 rounded-lg text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-400/40">⌨️ แก้พิกัดตัวเลข</button><button type="button" id="btnPinMoveUndo" onclick="undoScadaPinMove()" class="px-2 py-1 rounded-lg text-[10px] font-bold bg-slate-700 text-white">↩️ ย้อนกลับ (0)</button></div>
                    </div>
                    <div id="scadaMovePinHintText" class="text-[11px] font-bold text-teal-300 bg-slate-800/90 px-2.5 py-1.5 rounded-xl border border-slate-700"></div>
                </div>`;
            mapBox.insertBefore(bar, mapBox.firstChild);
            renderQuickToolbarColorButtons(scadaSettings.activeColor);
            updateToolbarToggleButtonsUI();
            updateMovePanelButtonsUI();
            updatePinMoveToolbarUI();
            updateDrawUndoButtonsUI();
        }
        const mapEl = document.getElementById('labeledInteractiveMap');
        if (mapEl?.parentElement && !document.getElementById('scadaFloatingDrawUndoBar')) {
            const fb = document.createElement('div');
            fb.id = 'scadaFloatingDrawUndoBar';
            fb.className = 'hidden absolute bottom-6 right-2.5 z-[450] items-center gap-1.5 bg-slate-900/95 text-white p-1.5 rounded-2xl shadow-2xl border border-amber-400/50';
            fb.innerHTML = `<button type="button" id="btnFloatUndoOnePoint" onclick="undoScadaDrawOnePoint()">↩️ ย้อนกลับ</button><button type="button" id="btnFloatRedoOnePoint" onclick="redoScadaDrawOnePoint()" class="hidden bg-slate-700 text-amber-300 px-2.5 py-1.5 rounded-xl text-[11px] font-extrabold">↪️</button><button type="button" onclick="toggleScadaDrawMode(false)" class="bg-emerald-500 text-slate-950 px-2.5 py-1.5 rounded-xl text-[11px] font-extrabold">✅ เสร็จ</button>`;
            if (typeof L !== 'undefined' && L.DomEvent) { L.DomEvent.disableClickPropagation(fb); L.DomEvent.disableScrollPropagation(fb); }
            mapEl.parentElement.appendChild(fb);
        }
    }

    function onScadaActiveFeederInput(v) { scadaSettings.activeFeeder = String(v || '').trim().toUpperCase(); localStorage.setItem('elec_scada_last_feeder', scadaSettings.activeFeeder); }
    function onScadaActiveSpecInput(v) { scadaSettings.activeSpec = String(v || '').trim(); localStorage.setItem('elec_scada_last_spec', scadaSettings.activeSpec); }
    function onScadaActiveStyleChange(v) { scadaSettings.lineStyle = v === 'ug' ? 'ug' : 'oh'; }
    function onScadaRouteModeChange(v) { scadaSettings.routeMode = v === 'cad' ? 'cad' : 'road'; localStorage.setItem('elec_scada_draw_mode', scadaSettings.routeMode); updateDrawHintText(); }
    function onScadaSideOffsetChange(v) { scadaSettings.sideOffset = parseInt(v, 10) || 0; localStorage.setItem('elec_scada_side_offset', String(scadaSettings.sideOffset)); }
    function setScadaDrawColor(hex) { scadaSettings.activeColor = normHex(hex) || '#10b981'; localStorage.setItem('elec_scada_last_color', scadaSettings.activeColor); renderQuickToolbarColorButtons(scadaSettings.activeColor); renderScadaDrawPreview(); }
    function onScadaLineWeightChange(v) { scadaSettings.lineWeight = parseFloat(v) || 1.8; localStorage.setItem('elec_scada_line_weight', String(scadaSettings.lineWeight)); scheduleUnifiedScadaRefresh(); }
    function onScadaFeederFilterChange(v) { scadaSettings.feederFilter = v || 'ALL'; scheduleUnifiedScadaRefresh(); }
    function toggleScadaLinesVisibility() { scadaSettings.showLines = !scadaSettings.showLines; updateToolbarToggleButtonsUI(); scheduleUnifiedScadaRefresh(); }
    function toggleScadaAutoJumperMode() { scadaSettings.autoJumper = !scadaSettings.autoJumper; localStorage.setItem('elec_scada_auto_jumper', String(scadaSettings.autoJumper)); updateToolbarToggleButtonsUI(); scheduleUnifiedScadaRefresh(); }
    function toggleScadaAntiOverlapMode() { scadaSettings.antiOverlap = !scadaSettings.antiOverlap; localStorage.setItem('elec_scada_anti_overlap', String(scadaSettings.antiOverlap)); updateToolbarToggleButtonsUI(); scheduleUnifiedScadaRefresh(); }

    // ========================================================================
    // 11. โหมดวาดสายไฟ, แทปสาย T-Tap, ดัดสาย CAD Grip & ย้ายหมุดดูดเข้าสายไฟ
    // ========================================================================
    function simplifyCoordsDP(pts, tol) {
        if (!pts || pts.length <= 2) return pts || [];
        let maxD = 0, idx = 0; const s = pts[0], e = pts[pts.length - 1], dx = e[0] - s[0], dy = e[1] - s[1], lSq = dx * dx + dy * dy;
        for (let i = 1; i < pts.length - 1; i++) {
            const t = lSq > 0 ? Math.max(0, Math.min(1, ((pts[i][0] - s[0]) * dx + (pts[i][1] - s[1]) * dy) / lSq)) : 0;
            const d = Math.hypot(pts[i][0] - (s[0] + t * dx), pts[i][1] - (s[1] + t * dy));
            if (d > maxD) { maxD = d; idx = i; }
        }
        return maxD > tol ? simplifyCoordsDP(pts.slice(0, idx + 1), tol).slice(0, -1).concat(simplifyCoordsDP(pts.slice(idx), tol)) : [s, e];
    }

    async function fetchRoadCounterFlowSafeWaypoints(lat1, lon1, lat2, lon2) {
        for (const u of [`https://routing.openstreetmap.de/routed-foot/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson`, `https://router.project-osrm.org/route/v1/foot/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson`]) {
            try {
                const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), 3000);
                const res = await fetch(u, { signal: ctrl.signal }); clearTimeout(tm);
                const coords = res.ok ? (await res.json())?.routes?.[0]?.geometry?.coordinates : null;
                if (coords?.length > 2) {
                    const ll = coords.map(c => [Number(c[1].toFixed(5)), Number(c[0].toFixed(5))]);
                    const simp = simplifyCoordsDP(ll, 0.00007);
                    return (simp.length > 16 ? simplifyCoordsDP(ll, 0.00016) : simp).slice(1, -1).slice(0, 14);
                }
            } catch (e) {}
        }
        return [];
    }

    function updateDrawHintText() {
        const el = document.getElementById('scadaDrawStatusHint'); if (!el) return;
        if (!scadaSettings.fromPinId) { el.textContent = '👆 จิ้มหมุดต้นทาง เพื่อเริ่มลากสายไฟ'; return; }
        const src = labeledPlaces.find(p => p?.id === scadaSettings.fromPinId);
        el.textContent = `📍 จาก "${src ? src.name : 'ต้นทาง'}" ${scadaSettings.tempWaypoints.length ? `[${scadaSettings.tempWaypoints.length} มุม] ` : ''}${scadaSettings.routeMode === 'cad' ? '(จิ้มแมพดัดมุม หรือจิ้มปลายทาง)' : '➔ จิ้มหมุดปลายทาง'}`;
    }

    function updateDrawUndoButtonsUI() {
        const act = scadaSettings.drawActive && canCurrentUserEditScada() && !simState.active;
        const uCnt = drawTracker.undoStack.length, rCnt = drawTracker.redoStack.length;
        const hBdg = document.getElementById('mapLongPressHintBadge'); if (hBdg) hBdg.style.display = isAnyEditModeActive() ? 'none' : '';
        const tbU = document.getElementById('btnToolbarUndoOnePoint'), flU = document.getElementById('btnFloatUndoOnePoint');
        if (tbU) { tbU.innerHTML = `↩️ ย้อนกลับ (${uCnt})`; tbU.disabled = !uCnt; tbU.className = uCnt ? 'bg-amber-500 text-slate-950 px-2.5 py-1 rounded-lg text-[10px] font-extrabold' : 'bg-slate-700 text-slate-400 px-2.5 py-1 rounded-lg text-[10px] opacity-50'; }
        if (flU) { flU.innerHTML = uCnt ? `↩️ ย้อนกลับ (${uCnt})` : '↩️ ย้อนกลับ'; flU.disabled = !uCnt; flU.className = uCnt ? 'bg-amber-400 text-slate-950 px-3 py-1.5 rounded-xl text-[11px] font-extrabold' : 'bg-slate-800 text-slate-500 px-3 py-1.5 rounded-xl text-[11px] opacity-60'; }
        document.getElementById('btnToolbarRedoOnePoint')?.classList.toggle('hidden', !rCnt);
        document.getElementById('btnFloatRedoOnePoint')?.classList.toggle('hidden', !rCnt);
        const fb = document.getElementById('scadaFloatingDrawUndoBar'); if (fb) { fb.classList.toggle('hidden', !act); fb.classList.toggle('flex', act); }
    }

    function renderScadaDrawPreview() {
        drawPreviewLayer?.clearLayers(); jumperPreviewLayer?.clearLayers();
        if (!scadaSettings.drawActive || !scadaSettings.fromPinId || !drawPreviewLayer) return;
        const src = labeledPlaces.find(p => p?.id === scadaSettings.fromPinId); if (!src) return;
        L.circleMarker([src.lat, src.lon], { pane: 'scadaPreviewPane', radius: 11, color: '#facc15', weight: 2.5, fillColor: scadaSettings.activeColor, fillOpacity: 0.3, interactive: false }).addTo(drawPreviewLayer);
        if (scadaSettings.tempWaypoints.length) {
            L.polyline([[src.lat, src.lon], ...scadaSettings.tempWaypoints], { pane: 'scadaPreviewPane', color: scadaSettings.activeColor, weight: scadaSettings.lineWeight, dashArray: '4, 4', interactive: false }).addTo(drawPreviewLayer);
            scadaSettings.tempWaypoints.forEach(wp => L.circleMarker(wp, { pane: 'scadaPreviewPane', radius: 4, color: '#fff', weight: 1.5, fillColor: '#f59e0b', fillOpacity: 1, interactive: false }).addTo(drawPreviewLayer));
        }
    }

    function renderLiveDrawCrossoverPreview(cursorLL) {
        jumperPreviewLayer?.clearLayers();
        if (!leafletMap || !jumperPreviewLayer || !scadaSettings.drawActive || !scadaSettings.fromPinId || !scadaSettings.autoJumper || !cachedUnderPolylinesPx.length) return;
        const src = labeledPlaces.find(p => p?.id === scadaSettings.fromPinId); if (!src) return;
        const pathLL = [L.latLng(src.lat, src.lon), ...scadaSettings.tempWaypoints.map(w => L.latLng(w[0], w[1])), ...(cursorLL ? [cursorLL] : [])];
        if (pathLL.length < 2) return;
        const z = leafletMap.getZoom(), pj = buildWholePolylineJumperArcs(pathLL.map(ll => leafletMap.project(ll, z)), { fromId: src.id, toId: '' }, cachedUnderPolylinesPx, Math.max(6.8, scadaSettings.lineWeight * 3.6) * scadaSettings.jumperScale, false);
        pj.bridges.forEach(arc => {
            const ll = arc.map(pt => { const u = leafletMap.unproject(L.point(pt.x, pt.y), z); return [u.lat, u.lng]; });
            L.polyline(ll, { pane: 'scadaPreviewPane', color: '#0f172a', weight: scadaSettings.lineWeight + 3.8, opacity: 0.9, interactive: false }).addTo(jumperPreviewLayer);
            L.polyline(ll, { pane: 'scadaPreviewPane', color: scadaSettings.activeColor, weight: scadaSettings.lineWeight + 0.8, opacity: 1, interactive: false }).addTo(jumperPreviewLayer);
        });
    }

    function toggleScadaDrawMode(forceState) {
        const next = typeof forceState === 'boolean' ? forceState : !scadaSettings.drawActive;
        if (next && !guardRealScadaEdit()) return false;
        if (next) { if (moveState.active) toggleScadaWireMoveMode(false); if (pinMoveState.active) toggleScadaPinMoveMode(false); }
        scadaSettings.drawActive = next; scadaSettings.fromPinId = null; scadaSettings.tempWaypoints = []; drawTracker.undoStack = []; drawTracker.redoStack = [];
        document.getElementById('scadaDrawActivePanel')?.classList.toggle('hidden', !next);
        document.getElementById('labeledInteractiveMap')?.classList.toggle('scada-draw-cursor', next);
        const btn = document.getElementById('btnToggleScadaDrawMode');
        if (btn) { btn.innerHTML = next ? '✅ เสร็จสิ้นการวาด' : '✏️ วาดเส้นสายไฟ'; btn.className = `scada-edit-only ${next ? 'bg-emerald-500' : 'bg-amber-500'} text-slate-950 px-3 py-1 rounded-xl text-[11px] font-extrabold shadow transition`; }
        leafletMap?.closePopup(); updateDrawHintText(); updateDrawUndoButtonsUI(); renderScadaDrawPreview(); syncLodAndViewportMarkersNow();
        setTimeout(() => leafletMap?.invalidateSize(), 60);
    }

    function resetScadaDrawSource() {
        if (scadaSettings.fromPinId) { drawTracker.undoStack.push({ type: 'reset_source', prevPinId: scadaSettings.fromPinId, prevWaypoints: JSON.parse(JSON.stringify(scadaSettings.tempWaypoints)) }); drawTracker.redoStack = []; }
        scadaSettings.fromPinId = null; scadaSettings.tempWaypoints = []; updateDrawHintText(); updateDrawUndoButtonsUI(); renderScadaDrawPreview();
    }

    function startDrawFromPopupPin(pinId) {
        if (!pinId || !guardRealScadaEdit()) return;
        toggleScadaDrawMode(true);
        scadaSettings.fromPinId = pinId; drawTracker.undoStack = [{ type: 'select_start', pinId }];
        const target = labeledPlaces.find(p => p?.id === pinId);
        if (target) {
            let fd = target.scadaNode?.fd || '', col = target.scadaNode?.col || '';
            if (!fd || !col) labeledPlaces.some(p => (p?.scadaLines || []).some(l => { if (l?.to === pinId) { fd = fd || l.fd || ''; col = col || l.col || ''; return true; } return false; }));
            if (fd) { const inp = document.getElementById('scadaActiveFeederInput'); if (inp) inp.value = fd.toUpperCase(); onScadaActiveFeederInput(fd); }
            if (col) setScadaDrawColor(col);
        }
        updateDrawHintText(); updateDrawUndoButtonsUI(); renderScadaDrawPreview();
    }

    async function handlePinClickedInDrawMode(targetPinId) {
        lastMarkerClickTs = Date.now();
        if (!scadaSettings.fromPinId) { scadaSettings.fromPinId = targetPinId; scadaSettings.tempWaypoints = []; drawTracker.undoStack.push({ type: 'select_start', pinId: targetPinId }); drawTracker.redoStack = []; updateDrawHintText(); updateDrawUndoButtonsUI(); renderScadaDrawPreview(); return; }
        if (scadaSettings.fromPinId === targetPinId) return resetScadaDrawSource();
        const fromPin = labeledPlaces.find(p => p?.id === scadaSettings.fromPinId), toPin = labeledPlaces.find(p => p?.id === targetPinId);
        if (!fromPin || !toPin) return;

        const prevW = JSON.parse(JSON.stringify(scadaSettings.tempWaypoints)), prevLines = JSON.parse(JSON.stringify(fromPin.scadaLines || []));
        let finalW = [...scadaSettings.tempWaypoints];
        if (scadaSettings.routeMode === 'road' && !finalW.length) { showToast('⏳ กำลังคำนวณแนวสายไฟตามถนน...'); finalW = await fetchRoadCounterFlowSafeWaypoints(fromPin.lat, fromPin.lon, toPin.lat, toPin.lon); }
        const fd = (scadaSettings.activeFeeder || 'F1').trim().toUpperCase();
        let afterLines = null;

        await commitPinsUpdate(pins => {
            const p = pins.find(x => x?.id === fromPin.id); if (!p) return false;
            const lines = Array.isArray(p.scadaLines) ? p.scadaLines : [], exIdx = lines.findIndex(l => l.to === toPin.id && (l.fd || '') === fd);
            const obj = { to: toPin.id, fd, col: scadaSettings.activeColor || '#10b981', st: scadaSettings.lineStyle || 'oh', cat: Date.now(), ...(scadaSettings.activeSpec ? { lb: scadaSettings.activeSpec } : {}), ...(scadaSettings.sideOffset ? { side: scadaSettings.sideOffset } : {}), ...(finalW.length ? { w: finalW } : {}) };
            if (exIdx !== -1) lines[exIdx] = obj; else lines.push(obj);
            p.scadaLines = lines; p.updatedAt = new Date().toISOString(); afterLines = JSON.parse(JSON.stringify(lines)); return true;
        }, `⚡ เชื่อมสาย ${fromPin.name} ➔ ${toPin.name} แล้ว`);

        if (afterLines) { drawTracker.undoStack.push({ type: 'connect_pin', fromPinId: fromPin.id, toPinId: toPin.id, prevWaypoints: prevW, prevLines, afterLines }); drawTracker.redoStack = []; }
        scadaSettings.fromPinId = toPin.id; scadaSettings.tempWaypoints = []; updateDrawHintText(); updateDrawUndoButtonsUI(); renderScadaDrawPreview();
    }

    async function undoScadaDrawOnePoint() {
        if (!scadaSettings.drawActive || !drawTracker.undoStack.length || !guardRealScadaEdit()) return;
        const st = drawTracker.undoStack.pop(); drawTracker.redoStack.push(st);
        if (st.type === 'select_start') { scadaSettings.fromPinId = null; scadaSettings.tempWaypoints = []; }
        else if (st.type === 'add_waypoint') scadaSettings.tempWaypoints.pop();
        else if (st.type === 'reset_source') { scadaSettings.fromPinId = st.prevPinId; scadaSettings.tempWaypoints = JSON.parse(JSON.stringify(st.prevWaypoints)); }
        else if (st.type === 'connect_pin') { await commitPinsUpdate(pins => { const p = pins.find(i => i?.id === st.fromPinId); if (!p) return false; p.scadaLines = JSON.parse(JSON.stringify(st.prevLines)); p.updatedAt = new Date().toISOString(); return true; }); scadaSettings.fromPinId = st.fromPinId; scadaSettings.tempWaypoints = JSON.parse(JSON.stringify(st.prevWaypoints)); }
        updateDrawHintText(); updateDrawUndoButtonsUI(); renderScadaDrawPreview();
    }

    async function redoScadaDrawOnePoint() {
        if (!scadaSettings.drawActive || !drawTracker.redoStack.length || !guardRealScadaEdit()) return;
        const st = drawTracker.redoStack.pop(); drawTracker.undoStack.push(st);
        if (st.type === 'select_start') { scadaSettings.fromPinId = st.pinId; scadaSettings.tempWaypoints = []; }
        else if (st.type === 'add_waypoint') { scadaSettings.fromPinId = st.pinId; scadaSettings.tempWaypoints.push([...st.wp]); }
        else if (st.type === 'reset_source') { scadaSettings.fromPinId = null; scadaSettings.tempWaypoints = []; }
        else if (st.type === 'connect_pin') { await commitPinsUpdate(pins => { const p = pins.find(i => i?.id === st.fromPinId); if (!p) return false; p.scadaLines = JSON.parse(JSON.stringify(st.afterLines)); p.updatedAt = new Date().toISOString(); return true; }); scadaSettings.fromPinId = st.toPinId; scadaSettings.tempWaypoints = []; }
        updateDrawHintText(); updateDrawUndoButtonsUI(); renderScadaDrawPreview();
    }

    async function createTTapOnScadaEdge(fromPinId, edgeIdx) {
        if (!guardRealScadaEdit()) return;
        const cLat = window.__scadaLastLineClickLat, cLon = window.__scadaLastLineClickLon;
        if (!cLat || !cLon) return showToast('⚠️ กรุณาจิ้มที่เส้นสายไฟใหม่อีกครั้ง');
        leafletMap?.closePopup();
        let newId = '';
        const ok = await commitPinsUpdate(pins => {
            const pF = pins.find(i => i?.id === fromPinId), e = pF?.scadaLines?.[edgeIdx], pT = e ? pins.find(i => i?.id === e.to) : null;
            if (!pF || !e || !pT) return false;
            const raw = [[Number(pF.lat), Number(pF.lon)], ...(e.w || []), [Number(pT.lat), Number(pT.lon)]], cos = Math.cos((cLat * Math.PI) / 180) || 1;
            let bD = Infinity, bLat = cLat, bLon = cLon, bSeg = 0;
            for (let i = 0; i < raw.length - 1; i++) {
                const dx = (raw[i + 1][1] - raw[i][1]) * cos, dy = raw[i + 1][0] - raw[i][0], lSq = dx * dx + dy * dy;
                const t = Math.max(0.02, Math.min(0.98, lSq > 1e-14 ? (((cLon - raw[i][1]) * cos * dx + (cLat - raw[i][0]) * dy) / lSq) : 0.5));
                const la = raw[i][0] + t * dy, lo = raw[i][1] + t * (raw[i + 1][1] - raw[i][1]), d = ((cLon - lo) * cos) ** 2 + (cLat - la) ** 2;
                if (d < bD) { bD = d; bLat = Number(la.toFixed(6)); bLon = Number(lo.toFixed(6)); bSeg = i; }
            }
            const w1 = raw.slice(1, bSeg + 1), w2 = raw.slice(bSeg + 1, -1), nowIso = new Date().toISOString(), chId = 'ttc_' + Date.now();
            newId = 'eqp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            const cont = { to: e.to, fd: e.fd, col: e.col, st: e.st || 'oh', ...(e.lb ? { lb: e.lb } : {}), ...(e.off ? { off: e.off } : {}), ...(w2.length ? { w: w2 } : {}), ...(e._ttapId ? { _ttapId: e._ttapId } : {}), _ttapFromId: chId, _ttapTrunk: true };
            pins.unshift({ id: newId, name: `T-Tap (${e.fd || 'Line'})`, note: 'จุดแทปกลางสาย', isTTap: true, lat: bLat, lon: bLon, pinColor: hexToClosestPinColorKey(e.col || '#10b981'), ownerGroup: pF.ownerGroup || getActiveEquipUserGroup(), ownerUser: localStorage.getItem('elec_app_current_user') || 'admin', scadaNode: { t: 'TAP', st: 'C', col: e.col || '#10b981', fd: e.fd || '' }, scadaLines: [cont], updatedAt: nowIso });
            e.to = newId; e._ttapId = chId; if (w1.length) e.w = w1; else delete e.w; pF.updatedAt = nowIso; return true;
        }, '✂️ สร้างจุด T-Tap สำเร็จ! ลากสายแยกออกไปได้เลย');
        if (ok && newId) setTimeout(() => startDrawFromPopupPin(newId), 200);
    }

    function quickDeleteTTapFromPopup(pinId) { leafletMap?.closePopup(); deleteSingleLabeledPin(pinId); }
    function mutateSingleEdge(fId, idx, fn, msg) { leafletMap?.closePopup(); return commitPinsUpdate(pins => { const p = pins.find(i => i?.id === fId); if (!p?.scadaLines?.[idx]) return false; fn(p.scadaLines[idx]); p.updatedAt = new Date().toISOString(); return true; }, msg); }
    function toggleScadaEdgePower(fId, idx) { return simState.active ? simulateEdgePowerToggle(fId, idx) : mutateSingleEdge(fId, idx, e => { e.off = e.off ? 0 : 1; }); }
    function toggleScadaEdgeUgStyle(fId, idx) { return mutateSingleEdge(fId, idx, e => { e.st = e.st === 'ug' ? 'oh' : 'ug'; }); }
    function cycleScadaEdgeSide(fId, idx) { return mutateSingleEdge(fId, idx, e => { e.side = (e.side || 0) === 0 ? -1 : ((e.side || 0) === -1 ? 1 : 0); }); }
    function straightenScadaEdge(fId, idx) { return mutateSingleEdge(fId, idx, e => { delete e.w; }, '📐 ปรับเป็นเส้นตรงแล้ว'); }
    function cycleScadaEdgeJumpLayer(fId, idx) { return mutateSingleEdge(fId, idx, e => { e.jp = (e.jp || 0) === 0 ? 1 : ((e.jp || 0) === 1 ? -1 : 0); if (!e.jp) delete e.jp; }, '⌒ สลับชั้นการโค้งข้ามสายแล้ว'); }
    function flipScadaEdgeJumpDir(fId, idx) { return mutateSingleEdge(fId, idx, e => { if (e.jf) delete e.jf; else e.jf = 1; }, '🔄 กลับทิศทางโค้งสะพานแล้ว'); }
        function deleteScadaEdge(fId, idx) {
        if (!guardRealScadaEdit()) return;
        showCustomConfirm('ต้องการลบเส้นวงจรจ่ายไฟช่วงนี้ใช่หรือไม่?', () => {
            leafletMap?.closePopup();
            commitPinsUpdate(pins => {
                const p = pins.find(i => i?.id === fId);
                if (!p?.scadaLines?.[idx]) return false;
                p.scadaLines.splice(idx, 1);
                p.updatedAt = new Date().toISOString();
                return true;
            }, '🗑️ ลบเส้นวงจรแล้ว');
        }, '🗑️ ยืนยันลบเส้นวงจร');
    }

    // โหมดดัดสาย (CAD Grip) & โหมดขยับหมุด (Draggable Pin)
    const getClientXY = ev => { const t = ev.touches?.[0] || ev.changedTouches?.[0] || ev; return { x: t.clientX, y: t.clientY }; };
    const xyToLL = (x, y) => { const r = leafletMap.getContainer().getBoundingClientRect(); return leafletMap.containerPointToLatLng(L.point(x - r.left, y - r.top)); };

    async function commitWireWaypoints(fromId, edgeIdx, newW, recUndo = true, snap = null) {
        const ok = await commitPinsUpdate(pins => {
            const p = pins.find(x => x?.id === fromId), e = p?.scadaLines?.[edgeIdx]; if (!p || !e) return false;
            if (recUndo) { moveState.undoStack.push({ fromId, edgeIdx, w: snap ? snap.w : (e.w ? JSON.parse(JSON.stringify(e.w)) : null), side: snap ? snap.side : (e.side || 0) }); if (moveState.undoStack.length > 25) moveState.undoStack.shift(); }
            const cl = (newW || []).slice(0, 35).map(pt => [Number(Number(pt[0]).toFixed(6)), Number(Number(pt[1]).toFixed(6))]);
            if (cl.length) e.w = cl; else delete e.w; delete e.side; p.updatedAt = new Date().toISOString(); return true;
        });
        updateMovePanelButtonsUI(); scheduleRebuildGrabHandles(); return ok;
    }

    function beginWireDragGesture(ev, ref, action, tIdx) {
        if (!moveState.active || !guardRealScadaEdit() || !leafletMap || (ev.type === 'mousedown' && ev.button !== 0)) return;
        if (ev.cancelable) ev.preventDefault(); ev.stopPropagation();
        const fP = cachedTopology?.pinMap.get(ref.fromId), e = fP?.scadaLines?.[ref.edgeIdx], tP = e ? cachedTopology.pinMap.get(e.to) : null;
        if (!fP || !e || !tP) return;
        const xy = getClientXY(ev), sLL = xyToLL(xy.x, xy.y), p0 = [Number(fP.lat), Number(fP.lon)], pn = [Number(tP.lat), Number(tP.lon)], origW = (e.w || []).map(c => [Number(c[0]), Number(c[1])]), full = [p0, ...origW, pn];

        if (moveState.subMode === 'delete_vertex' && action === 'vertex') return commitWireWaypoints(ref.fromId, ref.edgeIdx, origW.filter((_, i) => i !== tIdx), true, { w: origW, side: e.side || 0 });
        if (action === 'wire_body') {
            if (moveState.subMode === 'shift') action = 'shift_whole';
            else {
                const pC = leafletMap.latLngToLayerPoint(sLL); let vIdx = -1, bSeg = 0, bD = Infinity;
                for (let i = 1; i < full.length - 1; i++) if (pC.distanceTo(leafletMap.latLngToLayerPoint(full[i])) <= 14) { vIdx = i - 1; break; }
                for (let i = 0; i < full.length - 1; i++) { const A = leafletMap.latLngToLayerPoint(full[i]), B = leafletMap.latLngToLayerPoint(full[i + 1]), dx = B.x - A.x, dy = B.y - A.y, lS = dx * dx + dy * dy, t = Math.max(0, Math.min(1, lS > 1e-4 ? ((pC.x - A.x) * dx + (pC.y - A.y) * dy) / lS : 0.5)), d = Math.hypot(pC.x - (A.x + t * dx), pC.y - (A.y + t * dy)); if (d < bD) { bD = d; bSeg = i; } }
                if (moveState.subMode === 'delete_vertex') return vIdx !== -1 ? commitWireWaypoints(ref.fromId, ref.edgeIdx, origW.filter((_, i) => i !== vIdx), true, { w: origW, side: e.side || 0 }) : (moveState.selectedRef = { ...ref }, scheduleRebuildGrabHandles());
                action = vIdx !== -1 ? 'vertex' : 'insert_stretch'; tIdx = vIdx !== -1 ? vIdx : bSeg;
            }
        }
        leafletMap.dragging.disable();
        const st = { ref: { ...ref }, action, idx: tIdx, startX: xy.x, startY: xy.y, sLL, p0, pn, origW, origSide: e.side || 0, workW: origW.map(c => [...c]), ins: false, moved: false, col: e.col || '#10b981' };
        const onMove = mEv => {
            if (mEv.cancelable) mEv.preventDefault(); const mXY = getClientXY(mEv);
            if (!st.moved && Math.hypot(mXY.x - st.startX, mXY.y - st.startY) < 4) return; st.moved = true;
            const cLL = xyToLL(mXY.x, mXY.y);
            if (st.action === 'shift_whole') { const dLa = cLL.lat - st.sLL.lat, dLo = cLL.lng - st.sLL.lng; st.workW = st.origW.length ? st.origW.map(p => [p[0] + dLa, p[1] + dLo]) : [[st.p0[0] + (st.pn[0] - st.p0[0]) * 0.2 + dLa, st.p0[1] + (st.pn[1] - st.p0[1]) * 0.2 + dLo], [st.p0[0] + (st.pn[0] - st.p0[0]) * 0.8 + dLa, st.p0[1] + (st.pn[1] - st.p0[1]) * 0.8 + dLo]]; }
            else {
                if (st.action === 'insert_stretch' && !st.ins) { st.workW.splice(st.idx, 0, [cLL.lat, cLL.lng]); st.ins = true; }
                let fLL = [cLL.lat, cLL.lng];
                if (moveState.orthoSnap) { const cP = leafletMap.latLngToLayerPoint(cLL); let sx = cP.x, sy = cP.y; [st.idx === 0 ? st.p0 : st.workW[st.idx - 1], st.idx === st.workW.length - 1 ? st.pn : st.workW[st.idx + 1]].forEach(nb => { const nP = leafletMap.latLngToLayerPoint(nb); if (Math.abs(cP.x - nP.x) <= 12) sx = nP.x; if (Math.abs(cP.y - nP.y) <= 12) sy = nP.y; }); const oL = leafletMap.layerPointToLatLng(L.point(sx, sy)); fLL = [oL.lat, oL.lng]; }
                st.workW[st.idx] = fLL;
            }
            liveDragLayer.clearLayers(); L.polyline([st.p0, ...st.workW, st.pn], { pane: 'scadaWireMovePreviewPane', color: st.col, weight: 3.4 }).addTo(liveDragLayer);
        };
        const onEnd = async () => {
            ['mousemove', 'touchmove'].forEach(k => window.removeEventListener(k, onMove)); ['mouseup', 'touchend', 'touchcancel'].forEach(k => window.removeEventListener(k, onEnd));
            leafletMap.dragging.enable(); liveDragLayer.clearLayers(); moveState.selectedRef = { ...st.ref };
            if (st.moved) await commitWireWaypoints(st.ref.fromId, st.ref.edgeIdx, st.workW, true, { w: st.origW, side: st.origSide }); else { updateMovePanelButtonsUI(); scheduleRebuildGrabHandles(); }
        };
        ['mousemove', 'touchmove'].forEach(k => window.addEventListener(k, onMove, { passive: false })); ['mouseup', 'touchend', 'touchcancel'].forEach(k => window.addEventListener(k, onEnd, { passive: false }));
    }

    function rebuildGrabHandlesAndGrips() {
        grabLinesLayer?.clearLayers(); gripsLayer?.clearLayers();
        if (!leafletMap || !grabLinesLayer || !moveState.active || !canCurrentUserEditScada()) return;
        cachedTopology?.pinMap.forEach(fP => {
            (fP.scadaLines || []).forEach((e, eIdx) => {
                const tP = cachedTopology.pinMap.get(e.to); if (!tP) return;
                const ek = `${fP.id}__${eIdx}`, wPts = (e.w || []).map(c => [Number(c[0]), Number(c[1])]), full = [[Number(fP.lat), Number(fP.lon)], ...wPts, [Number(tP.lat), Number(tP.lon)]], vis = renderedEdgePathsMap.get(ek) || full;
                const isSel = moveState.selectedRef?.fromId === fP.id && moveState.selectedRef?.edgeIdx === eIdx, ref = { fromId: fP.id, edgeIdx: eIdx };
                if (isSel) L.polyline(vis, { pane: 'scadaWireMovePreviewPane', color: '#38bdf8', weight: 5.5, opacity: 0.55, dashArray: '6, 5', interactive: false }).addTo(grabLinesLayer);
                const gp = L.polyline(vis, { pane: 'scadaWireGrabPane', color: '#000', weight: 22, opacity: 0.002, className: 'scada-wire-grab-handle' }).addTo(grabLinesLayer);
                gp.on('mousedown', ev => ev.originalEvent && beginWireDragGesture(ev.originalEvent, ref, 'wire_body', -1));
                setTimeout(() => gp.getElement()?.addEventListener('touchstart', tev => beginWireDragGesture(tev, ref, 'wire_body', -1), { passive: false }), 15);
                if (isSel) {
                    const isDel = moveState.subMode === 'delete_vertex';
                    wPts.forEach((wp, wI) => {
                        const vm = L.marker(wp, { icon: L.divIcon({ className: '', html: `<div class="scada-cad-grip-vertex ${isDel ? 'delete-mode' : ''}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }), pane: 'scadaWireGripsPane' }).addTo(gripsLayer);
                        vm.getElement()?.addEventListener('mousedown', ev => beginWireDragGesture(ev, ref, 'vertex', wI));
                        vm.getElement()?.addEventListener('touchstart', ev => beginWireDragGesture(ev, ref, 'vertex', wI), { passive: false });
                    });
                }
            });
        });
        updateMovePanelButtonsUI();
    }
    function scheduleRebuildGrabHandles() { clearTimeout(grabRebuildTimer); grabRebuildTimer = setTimeout(rebuildGrabHandlesAndGrips, 25); }
    function updateMovePanelButtonsUI() {
        ['grip', 'shift', 'delete_vertex'].forEach(m => { const b = document.getElementById('btnWireSubMode-' + m); if (b) b.className = moveState.subMode === m ? `px-2.5 py-1 rounded-lg text-[11px] font-extrabold border ${m === 'delete_vertex' ? 'bg-rose-600 text-white border-rose-400' : 'bg-cyan-500 text-slate-950 border-white'}` : 'px-2.5 py-1 rounded-lg text-[11px] font-bold border border-slate-600 bg-slate-800 text-slate-300'; });
        const oB = document.getElementById('btnWireOrthoToggle'); if (oB) { oB.textContent = moveState.orthoSnap ? '📐 มุมฉาก: เปิด' : '📐 มุมฉาก: ปิด'; oB.className = moveState.orthoSnap ? 'px-2.5 py-1 rounded-lg text-[10px] font-extrabold bg-indigo-500 text-white border border-indigo-300' : 'px-2.5 py-1 rounded-lg text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-600'; }
        const uB = document.getElementById('btnWireUndoMove'); if (uB) { uB.textContent = `↩️ ย้อนกลับ (${moveState.undoStack.length})`; uB.disabled = !moveState.undoStack.length; }
        const h = document.getElementById('scadaMoveWireHintText'); if (h) h.textContent = moveState.subMode === 'shift' ? '↔️ แตะค้างที่ตัวเส้นสายไฟแล้วลากเพื่อเลื่อนทั้งเส้น' : (moveState.subMode === 'delete_vertex' ? '🗑️ แตะที่จุดมุมสีแดง (■) เพื่อลบมุมหักออก' : '👆 จับดึงที่เส้นสายไฟเพื่อดัดแนวได้ทันที • ลาก ■ ย้ายมุม');
    }
    function toggleScadaWireMoveMode(forceState, preRef = null) {
        const next = typeof forceState === 'boolean' ? forceState : !moveState.active;
        if (next && !guardRealScadaEdit()) return false;
        if (next) { if (scadaSettings.drawActive) toggleScadaDrawMode(false); if (pinMoveState.active) toggleScadaPinMoveMode(false); }
        moveState.active = next; moveState.selectedRef = preRef || (next ? moveState.selectedRef : null);
        document.getElementById('labeledInteractiveMap')?.classList.toggle('scada-move-wire-active', next);
        document.getElementById('scadaMoveWirePanel')?.classList.toggle('hidden', !next);
        const btn = document.getElementById('btnToggleWireMoveMode'); if (btn) { btn.innerHTML = next ? '✅ เสร็จสิ้นขยับสาย' : '✋ ขยับสาย'; btn.className = `scada-edit-only ${next ? 'bg-cyan-400 text-slate-950' : 'bg-sky-600 text-white'} px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow transition`; }
        leafletMap?.closePopup(); updateDrawUndoButtonsUI(); updateMovePanelButtonsUI(); scheduleRebuildGrabHandles(); syncLodAndViewportMarkersNow(); setTimeout(() => leafletMap?.invalidateSize(), 60);
    }
    function setScadaWireMoveSubMode(m) { moveState.subMode = m || 'grip'; updateMovePanelButtonsUI(); scheduleRebuildGrabHandles(); }
    function toggleScadaWireOrthoSnap() { moveState.orthoSnap = !moveState.orthoSnap; updateMovePanelButtonsUI(); }
    function startInteractiveWireMove(fId, idx) { toggleScadaWireMoveMode(true, { fromId: fId, edgeIdx: Number(idx) }); }
    async function undoScadaWireMove() { if (!moveState.undoStack.length || !guardRealScadaEdit()) return; const l = moveState.undoStack.pop(); moveState.selectedRef = { fromId: l.fromId, edgeIdx: l.edgeIdx }; await commitPinsUpdate(pins => { const p = pins.find(x => x?.id === l.fromId), e = p?.scadaLines?.[l.edgeIdx]; if (!e) return false; if (l.w?.length) e.w = l.w; else delete e.w; if (l.side) e.side = l.side; else delete e.side; p.updatedAt = new Date().toISOString(); return true; }, '↩️ ย้อนแนวสายไฟแล้ว'); updateMovePanelButtonsUI(); scheduleRebuildGrabHandles(); }
    function straightenSelectedWire() { if (moveState.selectedRef) commitWireWaypoints(moveState.selectedRef.fromId, moveState.selectedRef.edgeIdx, [], true); }

    // โหมดขยับหมุดอุปกรณ์ (Draggable Pin + Wire Snap)
    function snapLLToWire(rawLL, movId) {
        if (!pinMoveState.snapToWire || !leafletMap) return { lat: rawLL.lat, lon: rawLL.lng, snapped: false };
        const pCur = leafletMap.latLngToLayerPoint(rawLL); let bD = 14, bPt = null;
        cachedTopology?.pinMap.forEach(fP => {
            if (fP.id === movId) return;
            (fP.scadaLines || []).forEach(e => {
                if (!e || e.to === movId) return; const tP = cachedTopology.pinMap.get(e.to); if (!tP) return;
                const pts = [[Number(fP.lat), Number(fP.lon)], ...(e.w || []), [Number(tP.lat), Number(tP.lon)]];
                for (let i = 0; i < pts.length - 1; i++) {
                    const A = leafletMap.latLngToLayerPoint(pts[i]), B = leafletMap.latLngToLayerPoint(pts[i + 1]), dx = B.x - A.x, dy = B.y - A.y, lS = dx * dx + dy * dy;
                    if (lS < 4) continue; const t = Math.max(0.03, Math.min(0.97, ((pCur.x - A.x) * dx + (pCur.y - A.y) * dy) / lS)), d = Math.hypot(pCur.x - (A.x + t * dx), pCur.y - (A.y + t * dy));
                    if (d < bD) { bD = d; bPt = L.point(A.x + t * dx, A.y + t * dy); }
                }
            });
        });
        if (!bPt) return { lat: rawLL.lat, lon: rawLL.lng, snapped: false };
        const ll = leafletMap.layerPointToLatLng(bPt); return { lat: ll.lat, lon: ll.lng, snapped: true };
    }

    async function commitPinNewLocation(pinId, newLat, newLon, recUndo = true) {
        return commitPinsUpdate(pins => {
            const t = pins.find(p => p?.id === pinId); if (!t) return false;
            if (recUndo) { pinMoveState.undoStack.push({ pinId, name: t.name, lat: Number(t.lat), lon: Number(t.lon), rawGpsLink: t.rawGpsLink }); if (pinMoveState.undoStack.length > 25) pinMoveState.undoStack.shift(); }
            t.lat = Number(Number(newLat).toFixed(6)); t.lon = Number(Number(newLon).toFixed(6));
            if (t.rawGpsLink) t.rawGpsLink = `https://www.google.com/maps?q=${t.lat.toFixed(6)},${t.lon.toFixed(6)}`;
            t.updatedAt = new Date().toISOString(); return true;
        });
    }

    function renderSelectedPinRing() {
        pinSelectionLayer?.clearLayers();
        if (!pinMoveState.active || !pinMoveState.selectedPinId || !pinSelectionLayer) return;
        const t = labeledPlaces.find(p => p?.id === pinMoveState.selectedPinId);
        if (t) L.marker([Number(t.lat), Number(t.lon)], { icon: L.divIcon({ className: '', html: '<div class="scada-pin-selected-ring"></div>', iconSize: [38, 38], iconAnchor: [19, 19] }), pane: 'scadaPinMovePreviewPane', interactive: false }).addTo(pinSelectionLayer);
    }

    function bindPinDragEventsOnMarker(pinId, mk) {
        const el = mk?.getElement?.(); if (!el || el.__dragId === pinId) return; el.__dragId = pinId;
        const startDrag = ev => {
            if (!pinMoveState.active || !guardRealScadaEdit() || (ev.type === 'mousedown' && ev.button !== 0)) return;
            if (ev.cancelable) ev.preventDefault(); ev.stopPropagation();
            const pin = labeledPlaces.find(p => p?.id === pinId); if (!pin) return;
            const xy = getClientXY(ev); leafletMap.closePopup(); leafletMap.dragging.disable();
            let curLa = Number(pin.lat), curLo = Number(pin.lon), moved = false;
            const onMv = mEv => {
                if (mEv.cancelable) mEv.preventDefault(); const mXY = getClientXY(mEv);
                if (!moved && Math.hypot(mXY.x - xy.x, mXY.y - xy.y) < 4) return; moved = true;
                const sn = snapLLToWire(xyToLL(mXY.x, mXY.y), pinId); curLa = sn.lat; curLo = sn.lon; mk.setLatLng([curLa, curLo]);
                pinMovePreviewLayer.clearLayers(); L.circleMarker([curLa, curLo], { pane: 'scadaPinMovePreviewPane', radius: 16, color: sn.snapped ? '#10b981' : '#22d3ee', weight: 2.5, interactive: false }).addTo(pinMovePreviewLayer);
            };
            const onUp = async () => {
                ['mousemove', 'touchmove'].forEach(k => window.removeEventListener(k, onMv)); ['mouseup', 'touchend', 'touchcancel'].forEach(k => window.removeEventListener(k, onUp));
                leafletMap.dragging.enable(); pinMovePreviewLayer.clearLayers(); lastPinDragEndMs = Date.now(); pinMoveState.selectedPinId = pinId;
                if (moved) { await commitPinNewLocation(pinId, curLa, curLo, true); showToast(`📍 ย้ายตำแหน่ง "${pin.name}" แล้ว`); }
                renderSelectedPinRing(); updatePinMoveToolbarUI();
            };
            ['mousemove', 'touchmove'].forEach(k => window.addEventListener(k, onMv, { passive: false })); ['mouseup', 'touchend', 'touchcancel'].forEach(k => window.addEventListener(k, onUp, { passive: false }));
        };
        el.addEventListener('mousedown', startDrag); el.addEventListener('touchstart', startDrag, { passive: false });
        el.addEventListener('click', ev => { if (pinMoveState.active) { ev.stopPropagation(); ev.preventDefault(); } }, true);
    }

    function updatePinMoveToolbarUI() {
        const sB = document.getElementById('btnPinMoveSnapToggle'); if (sB) { sB.textContent = pinMoveState.snapToWire ? '🧲 ดูดเข้าสายไฟ: เปิด' : '🧲 ดูดเข้าสายไฟ: ปิด'; sB.className = `px-2.5 py-1 rounded-lg text-[10px] font-bold border ${pinMoveState.snapToWire ? 'bg-emerald-600 text-white border-emerald-300' : 'bg-slate-800 text-slate-300 border-slate-600'}`; }
        const tB = document.getElementById('btnPinMoveTapPlaceToggle'); if (tB) { tB.textContent = pinMoveState.tapToPlace ? '🎯 แตะแมพเพื่อวาง: เปิด' : '🎯 แตะแมพเพื่อวาง: ปิด'; tB.className = `px-2.5 py-1 rounded-lg text-[10px] font-bold border ${pinMoveState.tapToPlace ? 'bg-cyan-600 text-white border-cyan-300' : 'bg-slate-800 text-slate-300 border-slate-600'}`; }
        const uB = document.getElementById('btnPinMoveUndo'); if (uB) { uB.textContent = `↩️ ย้อนกลับ (${pinMoveState.undoStack.length})`; uB.disabled = !pinMoveState.undoStack.length; }
        const h = document.getElementById('scadaMovePinHintText'), sel = pinMoveState.selectedPinId ? labeledPlaces.find(p => p?.id === pinMoveState.selectedPinId) : null;
        if (h) h.textContent = sel ? `🎯 เลือก "${sel.name}" • ลากหมุดนี้ หรือจิ้มจุดใหม่บนแผนที่เพื่อวาง` : '👆 แตะค้างที่หมุดแล้วลากย้ายได้ทันที (สายไฟจะดึงตามอัตโนมัติ)';
    }

    function toggleScadaPinMoveMode(forceState, prePinId = null) {
        const next = typeof forceState === 'boolean' ? forceState : !pinMoveState.active;
        if (next && !guardRealScadaEdit()) return false;
        if (next) { if (scadaSettings.drawActive) toggleScadaDrawMode(false); if (moveState.active) toggleScadaWireMoveMode(false); }
        pinMoveState.active = next; pinMoveState.selectedPinId = next ? (prePinId || pinMoveState.selectedPinId) : null;
        document.getElementById('labeledInteractiveMap')?.classList.toggle('scada-move-pin-active', next);
        document.getElementById('scadaMovePinPanel')?.classList.toggle('hidden', !next);
        const btn = document.getElementById('btnTogglePinMoveMode'); if (btn) { btn.innerHTML = next ? '✅ เสร็จสิ้นย้ายหมุด' : '📍 ขยับหมุด'; btn.className = `scada-edit-only ${next ? 'bg-teal-400 text-slate-950' : 'bg-teal-700 text-white border border-teal-400/50'} px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow transition`; }
        leafletMap?.closePopup(); updateDrawUndoButtonsUI(); renderSelectedPinRing(); updatePinMoveToolbarUI(); syncLodAndViewportMarkersNow(); setTimeout(() => leafletMap?.invalidateSize(), 60);
    }
    function startSinglePinMoveFromPopup(id) { toggleScadaPinMoveMode(true, id); }
    function togglePinMoveWireSnap() { pinMoveState.snapToWire = !pinMoveState.snapToWire; updatePinMoveToolbarUI(); }
    function togglePinMoveTapToPlace() { pinMoveState.tapToPlace = !pinMoveState.tapToPlace; updatePinMoveToolbarUI(); }
    function openSelectedPinModalFromMoveBar() { if (!pinMoveState.selectedPinId) return showToast('👆 กรุณาแตะเลือกหมุดก่อนครับ'); const id = pinMoveState.selectedPinId; toggleScadaPinMoveMode(false); openEquipPinModal(id); }
    async function undoScadaPinMove() { if (!pinMoveState.undoStack.length || !guardRealScadaEdit()) return; const l = pinMoveState.undoStack.pop(); pinMoveState.selectedPinId = l.pinId; await commitPinNewLocation(l.pinId, l.lat, l.lon, false); renderSelectedPinRing(); updatePinMoveToolbarUI(); showToast(`↩️ ย้อนหมุด "${l.name}" กลับที่เดิมแล้ว`); }

    async function handleMapClickForScada(e) {
        if (scadaSettings.drawActive && scadaSettings.fromPinId && scadaSettings.routeMode === 'cad' && Date.now() - lastMarkerClickTs >= 250 && e.latlng) {
            const wp = [Number(e.latlng.lat.toFixed(5)), Number(e.latlng.lng.toFixed(5))];
            scadaSettings.tempWaypoints.push(wp); drawTracker.undoStack.push({ type: 'add_waypoint', pinId: scadaSettings.fromPinId, wp: [...wp] }); drawTracker.redoStack = [];
            updateDrawHintText(); updateDrawUndoButtonsUI(); renderScadaDrawPreview(); return;
        }
        if (pinMoveState.active && pinMoveState.tapToPlace && pinMoveState.selectedPinId && Date.now() - lastPinDragEndMs >= 280 && e.latlng) {
            const sn = snapLLToWire(e.latlng, pinMoveState.selectedPinId);
            await commitPinNewLocation(pinMoveState.selectedPinId, sn.lat, sn.lon, true);
            renderSelectedPinRing(); updatePinMoveToolbarUI();
        }
    }

    // ========================================================================
    // 12. บอลลูน SCADA, ตั้งค่าโหนด, จานสี 28 เฉด & โหมดซ้อมสับ-ปลด (Simulation)
    // ========================================================================
    function enhanceOpenedPopup(popup) {
        const el = popup?.getElement?.(), html = popup?.getContent?.();
        if (!el || typeof html !== 'string') return;
        const pinM = html.match(/openEquipPinModal\('([^']+)'\)/);
        if (pinM && !el.querySelector('.scada-popup-panel')) {
            const pinId = pinM[1], pin = labeledPlaces.find(p => p?.id === pinId); if (!pin) return;
            const nd = pin.scadaNode || {}, nState = cachedTopology?.nodeStates?.get(pinId) || { eqType: nd.t || 'PIN', st: nd.st || 'C', energized: false, conductingSources: [], terminalSources: [] };
            const eqT = nState.eqType, st = nState.st, isBrk = isBreakerType(eqT), isDf = eqT === 'DF';
            const stBdg = st === 'C' ? `<span class="bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-bold text-[10px]">🟢 ${isDf ? 'สับฟิวส์' : 'สับ (NC)'}</span>` : (st === 'O' ? `<span class="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold text-[10px]">⚪ ${isDf ? 'ปลดดร็อป' : 'ปลด (N.O.)'}</span>` : `<span class="bg-rose-100 text-rose-800 px-1.5 py-0.5 rounded font-bold text-[10px]">🔴 ${isDf ? 'ฟิวส์ขาด' : 'ทริป/ชำรุด'}</span>`);
            const flowTxt = isBrk ? (st === 'C' ? '■ <b>ต้นทางจ่ายไฟหลัก (CB):</b> กำลังจ่ายไฟเข้าสู่ระบบ' : '⚪ <b>เบรกเกอร์ปลดอยู่</b>') : (nState.energized ? (nState.isParallel ? `⚡ <b>ขนานไฟ:</b> ${escapeHtmlStr(nState.conductingSources.map(s => s.fullTitle).join(' + '))}` : `🟢 <b>${nState.isBackfeed ? 'รับไฟย้อนจาก' : 'รับไฟจาก'}:</b> ${escapeHtmlStr(nState.primarySource.fullTitle)}`) : (nState.hasStandbyPower ? `🟡 <b>ไฟมารอหัวสวิตช์จาก:</b> ${escapeHtmlStr(nState.terminalSources.map(s => s.fullTitle).join(' ↔ '))}` : '⚪ <b>ไม่มีไฟ</b>'));
            const simHtml = simState.active ? `<div class="p-2 rounded-xl bg-purple-950 text-white border border-purple-400 space-y-1.5"><div class="text-[10px] font-extrabold text-purple-200 flex justify-between"><span>🧪 โหมดซ้อมสับ-ปลด</span><span>ขั้นที่ ${simState.steps.length + 1}</span></div><div class="grid grid-cols-3 gap-1"><button type="button" onclick="simulateSwitchStateChange('${pinId}','C')" class="bg-emerald-500 text-slate-950 py-1.5 rounded-lg font-extrabold text-[10px]">🟢 ซ้อมสับ</button><button type="button" onclick="simulateSwitchStateChange('${pinId}','O')" class="bg-amber-400 text-slate-950 py-1.5 rounded-lg font-extrabold text-[10px]">⚪ ซ้อมปลด</button><button type="button" onclick="simulateSwitchStateChange('${pinId}','F')" class="bg-rose-500 text-white py-1.5 rounded-lg font-extrabold text-[10px]">🔴 ซ้อมทริป</button></div></div>` : '';
            const pnl = document.createElement('div'); pnl.className = 'scada-popup-panel mt-2 pt-2 border-t border-slate-200 space-y-1.5 text-[11px]';
            pnl.innerHTML = `${simHtml}<button type="button" onclick="startSinglePinMoveFromPopup('${pinId}')" class="scada-edit-only w-full bg-gradient-to-r from-teal-600 to-cyan-600 text-white py-1.5 px-2.5 rounded-lg font-extrabold text-[10px]">📍 ขยับ / ย้ายตำแหน่งหมุดนี้บนแผนที่</button><div class="flex justify-between gap-1 bg-slate-900 text-white px-2 py-1 rounded-lg"><span class="font-bold truncate">⚡ ${escapeHtmlStr(eqT)} ${nd.id ? `• ID ${escapeHtmlStr(nd.id)}` : ''} ${nd.fd ? `(${escapeHtmlStr(nd.fd)})` : ''}</span>${stBdg}</div><div class="p-2 rounded-lg border bg-slate-50 border-slate-300 text-slate-800 text-[10px]">${flowTxt}</div>${nd.lk ? `<div class="p-1.5 bg-rose-50 border border-rose-300 text-rose-800 rounded-lg font-bold text-[10px]">⚠️ ${escapeHtmlStr(nd.lk)}</div>` : ''}<div class="scada-edit-only grid grid-cols-3 gap-1"><button type="button" onclick="quickSwitchScadaState('${pinId}','C')" class="bg-emerald-600 text-white py-1 rounded font-bold text-[10px]">🟢 สับ</button><button type="button" onclick="quickSwitchScadaState('${pinId}','O')" class="bg-amber-500 text-white py-1 rounded font-bold text-[10px]">⚪ ปลด</button><button type="button" onclick="quickSwitchScadaState('${pinId}','F')" class="bg-rose-600 text-white py-1 rounded font-bold text-[10px]">🔴 ทริป</button></div><div class="scada-edit-only grid grid-cols-2 gap-1"><button type="button" onclick="openScadaNodeModal('${pinId}')" class="bg-slate-100 text-slate-800 border border-slate-300 py-1 px-1.5 rounded font-bold text-[10px]">⚙️ ตั้งค่า SCADA</button><button type="button" onclick="startDrawFromPopupPin('${pinId}')" class="bg-amber-100 text-amber-900 border border-amber-300 py-1 px-1.5 rounded font-bold text-[10px]">✏️ ลากสายต่อ</button></div>${canCurrentUserEditScada() ? `<div class="grid grid-cols-3 gap-1"><button type="button" onclick="sendEquipToMainFaultForm('${pinId}','device')" class="bg-indigo-50 text-indigo-700 border border-indigo-200 py-1 rounded font-bold text-[9px]">📟 เห็นฟอลต์</button><button type="button" onclick="sendEquipToMainFaultForm('${pinId}','disconnect')" class="bg-indigo-50 text-indigo-700 border border-indigo-200 py-1 rounded font-bold text-[9px]">🔌 ปลดจุดนี้</button><button type="button" onclick="sendEquipToMainFaultForm('${pinId}','powerup')" class="bg-indigo-50 text-indigo-700 border border-indigo-200 py-1 rounded font-bold text-[9px]">⚡ ชนจุดนี้</button></div>` : ''}${isPinTTap(pin, labeledPlaces) ? `<button type="button" onclick="quickDeleteTTapFromPopup('${pinId}')" class="scada-edit-only w-full bg-rose-50 text-rose-700 border border-rose-300 py-1.5 px-2 rounded-lg font-extrabold text-[10px]">🗑️ ลบจุด T-Tap (สมานสายหลักคืนอัตโนมัติ)</button>` : ''}`;
            (el.querySelector('.leaflet-popup-content > div') || el.querySelector('.leaflet-popup-content'))?.appendChild(pnl);
            return;
        }
        const edgeM = html.match(/toggleScadaEdgePower\('([^']+)',\s*(\d+)\)/);
        if (edgeM && simState.active && !el.querySelector('.scada-sim-edge-btn')) {
            const fId = edgeM[1], eIdx = parseInt(edgeM[2], 10), edge = simState.workingPins.find(p => p?.id === fId)?.scadaLines?.[eIdx];
            if (edge) { const d = document.createElement('div'); d.className = 'scada-sim-edge-btn mt-2 p-2 rounded-xl bg-purple-950 border border-purple-400'; d.innerHTML = `<button type="button" onclick="simulateEdgePowerToggle('${fId}',${eIdx})" class="w-full py-1.5 px-2.5 rounded-lg font-extrabold text-[11px] ${edge.off ? 'bg-emerald-500 text-slate-950' : 'bg-amber-400 text-slate-950'}">🧪 ${edge.off ? 'ซ้อมต่อสายไฟช่วงนี้คืน' : 'ซ้อมปลด/ตัดสายไฟช่วงนี้'}</button>`; (el.querySelector('.leaflet-popup-content > div') || el.querySelector('.leaflet-popup-content'))?.appendChild(d); }
        }
    }

    function quickSwitchScadaState(pinId, nextState) {
        if (simState.active) return simulateSwitchStateChange(pinId, nextState);
        if (!guardRealScadaEdit()) return;
        const pin = labeledPlaces.find(p => p?.id === pinId); if (!pin) return;
        const nState = cachedTopology?.nodeStates?.get(pinId), warn = pin.scadaNode?.lk || '';
        const run = () => { leafletMap?.closePopup(); commitPinsUpdate(pins => { const t = pins.find(i => i?.id === pinId); if (!t) return false; t.scadaNode = t.scadaNode || { t: 'VS', col: getPinSavedColorHex(t) }; t.scadaNode.st = nextState; if (!isBreakerType(t.scadaNode.t)) t.pinColor = nextState === 'C' ? hexToClosestPinColorKey(t.scadaNode.col || '#10b981') : (nextState === 'O' ? 'yellow' : 'red'); t.updatedAt = new Date().toISOString(); return true; }, `⚡ ${pin.name}: อัปเดตสถานะแล้ว`); };
        if (warn) showCustomConfirm(`⚠️ คำเตือนประจำจุด ${pin.name}:\n"${warn}"\n\nยืนยันการเปลี่ยนสถานะใช่หรือไม่?`, run, '🚨 ตรวจสอบเงื่อนไข Interlock');
        else if (nextState === 'C' && nState?.isTieTwoSources) showCustomConfirm(`⚠️ จุดสับขนาน (${pin.name}) มีไฟมารอจาก 2 เบรกเกอร์:\n${nState.terminalSources.map((s, i) => `${i + 1}) ${s.fullTitle}`).join('\n')}\n\nยืนยันสับขนานหรือไม่?`, run, '⚡ แจ้งเตือนชนไฟ 2 แหล่งจ่าย');
        else run();
    }

    function sendEquipToMainFaultForm(pinId, fieldRole) {
        if (!canCurrentUserEditScada()) return showToast(SCADA_LOCK_MSG);
        const pin = labeledPlaces.find(p => p?.id === pinId); if (!pin) return;
        const code = `${pin.name}${pin.scadaNode?.id ? ` (ID ${pin.scadaNode.id})` : ''}`, pkt = { type: 'SCADA_FILL_FAULT_FORM', fieldRole, code, feeder: pin.scadaNode?.fd || '', gps: `https://www.google.com/maps?q=${Number(pin.lat).toFixed(6)},${Number(pin.lon).toFixed(6)}`, ts: Date.now() };
        try { if (window.parent && window.parent !== window) window.parent.postMessage(pkt, '*'); if (window.opener && !window.opener.closed) window.opener.postMessage(pkt, '*'); scadaBroadcast?.postMessage(pkt); localStorage.setItem('elec_scada_form_bridge_pkt', JSON.stringify(pkt)); } catch (e) {}
        showToast(`⚡ ส่งรหัส "${code}" เข้าฟอร์มรายงานเหตุ TR/TL แล้ว!`);
    }

    function selectScadaModalSwatch(hex) {
        const cl = (normHex(hex) || '#10b981').toLowerCase(); document.getElementById('scadaModalColorInput').value = cl;
        const w = document.getElementById('scadaModalColorSwatches'); if (!w) return;
        w.innerHTML = QUICK_BAR_COLORS.map(h => `<button type="button" onclick="selectScadaModalSwatch('${h}')" class="w-6 h-6 rounded-full border-2 text-white text-[10px] font-bold" style="background:${h};border-color:${h.toLowerCase() === cl ? '#0f172a' : 'transparent'};">${h.toLowerCase() === cl ? '✓' : ''}</button>`).join('') + `<button type="button" onclick="openScadaColorPaletteModal('nodeModal')" class="px-2.5 py-1 rounded-lg bg-slate-800 text-white text-[10px] font-bold">🎨 เลือกเฉดสีเพิ่ม</button>`;
    }
    function autoDetectScadaFieldsFromTitle() {
        const p = labeledPlaces.find(x => x?.id === document.getElementById('scadaModalPinId')?.value); if (!p) return;
        const txt = `${p.name || ''} ${p.note || ''}`;
        document.getElementById('scadaModalEquipType').value = isPinTTap(p, labeledPlaces) ? 'TAP' : (/(?:\bCB\b|BREAKER|\bRC\b)/i.test(txt) ? 'RC' : (/(?:\bVB\b|\bYB\b|RECLOSER)/i.test(txt) ? 'VB' : (/(?:\bDF|\bFCO|ดร็อป|ดรอป|ฟิวส์|&)/i.test(txt) ? 'DF' : (/VS\s*-?\s*\d+/i.test(txt) ? 'VS' : (/\bG\b|SPP|VSPP/i.test(txt) ? 'GEN' : (/S\s*-?\s*\d+/i.test(txt) ? 'S' : 'VS'))))));
        const idM = txt.match(/ID\s*[:=]?\s*(\d{3,6})/i), fdM = String(p.name || '').match(/^([A-Z]{3}\s*0?\d{1,2})/i);
        if (idM) document.getElementById('scadaModalIdInput').value = idM[1];
        if (fdM) document.getElementById('scadaModalFeederInput').value = fdM[1].replace(/\s+/g, '').toUpperCase();
    }
    function openScadaNodeModal(pinId) {
        if (!guardRealScadaEdit()) return; const pin = labeledPlaces.find(p => p?.id === pinId); if (!pin) return; leafletMap?.closePopup();
        const nd = pin.scadaNode || {}; document.getElementById('scadaModalPinId').value = pin.id; document.getElementById('scadaModalPinTitle').textContent = `⚡ ${pin.name}`;
        document.getElementById('scadaModalEquipType').value = nd.t || (isPinTTap(pin, labeledPlaces) ? 'TAP' : 'VS'); document.getElementById('scadaModalIdInput').value = nd.id || ''; document.getElementById('scadaModalStateSelect').value = nd.st || 'C'; document.getElementById('scadaModalFeederInput').value = nd.fd || scadaSettings.activeFeeder || ''; document.getElementById('scadaModalWarnInput').value = nd.lk || '';
        selectScadaModalSwatch(nd.col || getPinSavedColorHex(pin)); if (!pin.scadaNode) autoDetectScadaFieldsFromTitle(); document.getElementById('scadaNodeConfigModal')?.classList.remove('hidden');
    }
    function closeScadaNodeModal() { document.getElementById('scadaNodeConfigModal')?.classList.add('hidden'); }
    async function saveScadaNodeModal() {
        const pinId = document.getElementById('scadaModalPinId')?.value; if (!pinId) return;
        const t = document.getElementById('scadaModalEquipType').value, id = document.getElementById('scadaModalIdInput').value.trim(), st = document.getElementById('scadaModalStateSelect').value, fd = document.getElementById('scadaModalFeederInput').value.trim().toUpperCase(), col = normHex(document.getElementById('scadaModalColorInput').value) || '#10b981', lk = document.getElementById('scadaModalWarnInput').value.trim();
        await commitPinsUpdate(pins => {
            const tg = pins.find(p => p?.id === pinId); if (!tg) return false; const oldH = getPinSavedColorHex(tg);
            if (t === 'PIN' && !id && !lk) { delete tg.scadaNode; delete tg.isTTap; }
            else { tg.scadaNode = { t, st, col, ...(id ? { id } : {}), ...(fd ? { fd } : {}), ...(lk ? { lk } : {}) }; if (t === 'TAP') tg.isTTap = true; }
            if (t !== 'TAP') {
                delete tg.isTTap; if (tg.note === 'จุดแทปกลางสาย') tg.note = '';
                if (/^T-Tap\s*\(/i.test(tg.name || '')) tg.name = tg.name.replace(/^T-Tap/i, t === 'RC' ? 'CB' : t);
                (tg.scadaLines || []).forEach(l => { if (l) { delete l._ttapTrunk; delete l._ttapFromId; } });
                pins.forEach(p => (p?.scadaLines || []).forEach(l => { if (l?.to === pinId) delete l._ttapId; }));
            }
            tg.pinColor = hexToClosestPinColorKey(col);
            if (col !== oldH || isBreakerType(t)) propagateColorToConnectedSystem(pins, [pinId], col, { crossOpenSwitches: false });
            tg.updatedAt = new Date().toISOString(); return true;
        }, '✅ บันทึกข้อมูลสวิตช์ SCADA เรียบร้อยแล้ว');
        closeScadaNodeModal();
    }
    async function resetScadaNodeToDefaultPin() { const id = document.getElementById('scadaModalPinId')?.value; if (id) await commitPinsUpdate(pins => { const t = pins.find(p => p?.id === id); if (!t) return false; delete t.scadaNode; delete t.isTTap; t.updatedAt = new Date().toISOString(); return true; }, '🔄 รีเซ็ตเป็นหมุดปกติแล้ว'); closeScadaNodeModal(); }

    // จานสี 28 เฉดสี
    function syncPaletteUI(hex) {
        tempPickedHex = normHex(hex) || '#10b981';
        document.getElementById('scadaCustomColorWheel').value = tempPickedHex; document.getElementById('scadaCustomHexInput').value = tempPickedHex.toUpperCase(); document.getElementById('scadaPalettePreviewLine').style.background = tempPickedHex;
        const m = CAD_PRESET_PALETTE.find(c => c.hex.toLowerCase() === tempPickedHex); document.getElementById('scadaSelectedColorNameLabel').textContent = m ? `${m.name} (${tempPickedHex.toUpperCase()})` : tempPickedHex.toUpperCase();
        document.getElementById('scadaPresetColorsGrid').innerHTML = CAD_PRESET_PALETTE.map(c => `<button type="button" onclick="pickScadaPresetHex('${c.hex}')" class="h-8 rounded-xl border-2 text-white text-xs font-extrabold" style="background:${c.hex};border-color:${c.hex.toLowerCase() === tempPickedHex ? '#fff' : 'rgba(255,255,255,0.12)'};">${c.hex.toLowerCase() === tempPickedHex ? '✓' : ''}</button>`).join('');
        const rec = (JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) || '[]') || []).filter(normHex);
        document.getElementById('scadaRecentColorsSection')?.classList.toggle('hidden', !rec.length);
        document.getElementById('scadaRecentColorsGrid').innerHTML = rec.map(h => `<button type="button" onclick="pickScadaPresetHex('${h}')" class="w-7 h-7 rounded-lg border-2 text-white text-[10px] font-bold" style="background:${h};border-color:${h === tempPickedHex ? '#fff' : 'transparent'};">${h === tempPickedHex ? '✓' : ''}</button>`).join('');
    }
    function setScadaEdgeRecolorScopeV3(sc) { paletteCtx.scope = sc || 'connected'; ['connected', 'all_thru', 'single'].forEach(k => { const b = document.getElementById('scadaV3ScopeBtn-' + k); if (b) b.className = k === paletteCtx.scope ? 'py-1.5 px-2 rounded-xl text-[10px] font-extrabold border-2 border-teal-400 bg-teal-500/25 text-teal-200' : 'py-1.5 px-2 rounded-xl text-[10px] font-bold border border-slate-600 bg-slate-900 text-slate-400'; }); }
    function openScadaColorPaletteModal(mode, fromId = null, eIdx = null) { if (!guardRealScadaEdit()) return; paletteCtx = { mode: mode || 'toolbar', fromPinId: fromId, edgeIdx: eIdx, scope: 'connected' }; document.getElementById('scadaV3ScopeSelectorBox')?.classList.toggle('hidden', mode !== 'edge'); if (mode === 'edge') setScadaEdgeRecolorScopeV3('connected'); syncPaletteUI(mode === 'nodeModal' ? document.getElementById('scadaModalColorInput')?.value : (mode === 'edge' ? labeledPlaces.find(i => i?.id === fromId)?.scadaLines?.[eIdx]?.col : scadaSettings.activeColor)); document.getElementById('scadaColorPaletteModal')?.classList.remove('hidden'); }
    function closeScadaColorPaletteModal() { document.getElementById('scadaColorPaletteModal')?.classList.add('hidden'); }
    function onScadaWheelColorInput(v) { syncPaletteUI(v); }
    function onScadaHexTextInput(v) { const s = String(v || '').trim(); const h = s.startsWith('#') ? s : '#' + s; if (normHex(h)) syncPaletteUI(h); }
    function pickScadaPresetHex(h) { syncPaletteUI(h); }
    function clearScadaRecentColors() { localStorage.removeItem(RECENT_COLORS_KEY); syncPaletteUI(tempPickedHex); }
    async function confirmScadaPaletteSelection() {
        const h = normHex(tempPickedHex) || '#10b981';
        if (!CAD_PRESET_PALETTE.some(c => c.hex.toLowerCase() === h)) localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify([h, ...(JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) || '[]') || []).filter(c => c !== h)].slice(0, 12)));
        closeScadaColorPaletteModal();
        if (paletteCtx.mode === 'nodeModal') selectScadaModalSwatch(h);
        else if (paletteCtx.mode === 'edge' && paletteCtx.fromPinId) { leafletMap?.closePopup(); await commitPinsUpdate(pins => { const pF = pins.find(p => p?.id === paletteCtx.fromPinId), eg = pF?.scadaLines?.[paletteCtx.edgeIdx]; if (!eg) return false; if (paletteCtx.scope === 'single') { eg.col = h; eg.customSingleCol = 1; eg.customOwnerBrk = cachedTopology?.edgeStates?.get(`${paletteCtx.fromPinId}__${paletteCtx.edgeIdx}`)?.primarySource?.breakerId || ''; pF.updatedAt = new Date().toISOString(); } else { propagateColorToConnectedSystem(pins, [paletteCtx.fromPinId, eg.to], h, { crossOpenSwitches: paletteCtx.scope === 'all_thru', directFromPinId: paletteCtx.fromPinId, directEdgeIdx: paletteCtx.edgeIdx }); setScadaDrawColor(h); } return true; }, '🎨 เปลี่ยนสีสายไฟเรียบร้อยแล้ว'); }
        else setScadaDrawColor(h);
    }

    // โหมดซ้อมสับ-ปลด (Virtual Simulation & Switching Order)
    function computeSimDiff() {
        if (!simState.baseTopo) simState.baseTopo = computeUnifiedTopology(simState.basePins.filter(canCurrentUserSeeEquipPin));
        simState.curTopo = computeUnifiedTopology(simState.workingPins.filter(canCurrentUserSeeEquipPin));
        const out = [], res = [], bf = [], par = [];
        simState.curTopo.nodeStates.forEach((cur, id) => {
            const base = simState.baseTopo.nodeStates.get(id), pin = simState.curTopo.pinMap.get(id); if (!base || !pin) return;
            const isTap = isPinTTap(pin, simState.workingPins);
            if (cur.isParallel) par.push({ id, name: pin.name, detail: cur.conductingSources.map(s => s.name).join(' + ') });
            if (base.energized && !cur.energized) out.push({ id, name: pin.name, isTTap: isTap, detail: base.primarySource?.name || 'ไฟดับ' });
            else if (!base.energized && cur.energized) res.push({ id, name: pin.name, isTTap: isTap, detail: cur.primarySource?.fullTitle || 'มีไฟ' });
            else if (base.energized && cur.energized && ((base.primarySource?.breakerId !== cur.primarySource?.breakerId) || (!base.isBackfeed && cur.isBackfeed))) bf.push({ id, name: pin.name, isTTap: isTap, detail: `${base.primarySource?.name || '-'} ➔ ${cur.primarySource?.fullTitle || '-'}` });
        });
        simState.lastDiff = { newlyOutage: out, newlyRestored: res, transferredOrBackfeed: bf, parallelNodes: par };
        return simState.lastDiff;
    }

    function updateSimVisualChrome() {
        const mapEl = document.getElementById('labeledInteractiveMap'), btn = document.getElementById('btnToggleScadaSimMode');
        document.body.classList.toggle('scada-sim-active', simState.active);
        if (mapEl) {
            mapEl.classList.toggle('scada-sim-mode-map', simState.active);
            let bdg = document.getElementById('scadaSimFloatingMapBadge');
            if (simState.active && !bdg && mapEl.parentElement) { bdg = document.createElement('div'); bdg.id = 'scadaSimFloatingMapBadge'; bdg.className = 'scada-sim-float-badge scada-sim-live-pill'; bdg.textContent = '🧪 โหมดซ้อมสับ-ปลด (ไม่กระทบผังจริง)'; mapEl.parentElement.appendChild(bdg); }
            else if (!simState.active && bdg) bdg.remove();
        }
        if (btn) {
            btn.style.display = (!isViewerRole() && localStorage.getItem('elec_app_logged_in') === 'true') ? '' : 'none';
            btn.innerHTML = simState.active ? '🟣 ปิดโหมดซ้อม' : '🧪 ซ้อมสับ-ปลด';
            btn.className = simState.active ? 'scada-sim-live-pill bg-purple-500 text-white border border-purple-200 px-3 py-1 rounded-xl text-[11px] font-extrabold shadow-md' : 'bg-purple-800/90 hover:bg-purple-700 text-purple-100 border border-purple-400/50 px-2.5 py-1 rounded-xl text-[11px] font-extrabold shadow';
        }
    }

    function renderSimToolbarPanel() {
        const tb = document.getElementById('scadaControlToolbar'); if (!tb) return;
        let pnl = document.getElementById('scadaSimDashboardPanel');
        if (!simState.active) { pnl?.remove(); return; }
        if (!pnl) { pnl = document.createElement('div'); pnl.id = 'scadaSimDashboardPanel'; pnl.className = 'pt-2.5 border-t border-purple-500/50 space-y-2 text-xs'; tb.appendChild(pnl); }
        const d = simState.lastDiff || computeSimDiff();
        const cnt = arr => arr.filter(x => !x.isTTap).length || arr.length;
        const tabMap = { outage: ['🔴 ไฟดับเพิ่ม', d.newlyOutage], restored: ['🟢 จ่ายไฟคืน', d.newlyRestored], backfeed: ['🔄 ไฟย้อน/ย้ายแหล่ง', d.transferredOrBackfeed], parallel: ['⚡ ขนาน 2 CB', d.parallelNodes] };
        const selTab = simState.expandedImpactTab ? tabMap[simState.expandedImpactTab] : null;
        const detHtml = selTab ? `<div class="p-2 rounded-xl border border-purple-400/40 bg-slate-950/70 space-y-1"><div class="flex justify-between font-bold text-[11px]"><span>${selTab[0]} (${selTab[1].length})</span><button type="button" onclick="toggleSimImpactDetailTab(null)">&times;</button></div><div class="flex flex-wrap gap-1 max-h-20 overflow-y-auto">${selTab[1].length ? selTab[1].slice(0, 24).map(x => `<button type="button" onclick="focusSinglePinOnMap('${x.id}')" class="px-2 py-0.5 rounded bg-slate-800 text-[10px] font-bold text-white">🎯 ${escapeHtmlStr(x.name)} (${escapeHtmlStr(x.detail)})</button>`).join('') : '<span class="text-slate-400 text-[11px]">ไม่มีรายการ</span>'}</div></div>` : '';
        const stHtml = simState.steps.length ? `<div class="flex flex-col gap-1 max-h-24 overflow-y-auto">${simState.steps.map((s, i) => `<div class="flex justify-between bg-slate-900 px-2.5 py-1 rounded-lg border border-purple-500/30 text-[11px]"><span class="truncate"><b class="text-purple-300">#${i + 1}</b> ${escapeHtmlStr(s.actionLabel)} ➔ <b class="text-amber-300">${escapeHtmlStr(s.codeName)}</b></span><button type="button" onclick="focusSinglePinOnMap('${s.pinId}')" class="text-[10px] text-sky-300 font-bold">🎯 ดูจุด</button></div>`).join('')}</div>` : '<div class="text-[11px] text-purple-200">👆 แตะสวิตช์หรือเส้นสายไฟบนแผนที่เพื่อเริ่มซ้อมสับ-ปลดได้เลย</div>';
        pnl.innerHTML = `<div class="p-2.5 rounded-xl bg-gradient-to-r from-purple-950/90 via-slate-900 to-indigo-950/90 border border-purple-400/50 space-y-2"><div class="flex flex-wrap justify-between gap-1.5"><div class="flex flex-wrap gap-1"><span class="bg-purple-600 text-white px-2 py-0.5 rounded text-[10px] font-extrabold">🧪 ซ้อม ${simState.steps.length} ขั้น</span><button type="button" onclick="toggleSimImpactDetailTab('outage')" class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 border border-rose-400/50 text-rose-200">🔴 ดับเพิ่ม: ${cnt(d.newlyOutage)}</button><button type="button" onclick="toggleSimImpactDetailTab('restored')" class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 border border-emerald-400/50 text-emerald-200">🟢 จ่ายคืน: ${cnt(d.newlyRestored)}</button><button type="button" onclick="toggleSimImpactDetailTab('backfeed')" class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 border border-indigo-400/50 text-indigo-200">🔄 ไฟย้อน: ${cnt(d.transferredOrBackfeed)}</button>${d.parallelNodes.length ? `<button type="button" onclick="toggleSimImpactDetailTab('parallel')" class="scada-sim-live-pill px-2 py-0.5 rounded text-[10px] font-extrabold bg-amber-500 text-slate-950">⚡ ขนาน 2 CB: ${d.parallelNodes.length}</button>` : ''}</div><div class="flex flex-wrap gap-1"><button type="button" onclick="undoScadaSimStep()" ${!simState.steps.length ? 'disabled' : ''} class="px-2 py-1 rounded-lg text-[10px] font-bold bg-slate-800 text-slate-200 border border-slate-600 disabled:opacity-40">↩️ ย้อนขั้น</button><button type="button" onclick="resetScadaSimAll()" ${!simState.steps.length ? 'disabled' : ''} class="px-2 py-1 rounded-lg text-[10px] font-bold bg-slate-800 text-amber-300 border border-slate-600 disabled:opacity-40">🔄 เริ่มใหม่</button><button type="button" onclick="openScadaSimPlanModal()" class="px-2.5 py-1 rounded-lg text-[10px] font-extrabold bg-[#00B900] text-white">💬 สรุปส่ง LINE (${simState.steps.length})</button>${(canCurrentUserEditScada() && simState.steps.length) ? `<button type="button" onclick="applySimulatedStateToRealGrid()" class="px-2.5 py-1 rounded-lg text-[10px] font-extrabold bg-amber-400 text-slate-950">⚡ นำไปใช้จริง</button>` : ''}</div></div>${detHtml}${stHtml}</div>`;
    }

    function toggleScadaSimMode(forceState, silent = false) {
        if (isViewerRole() || localStorage.getItem('elec_app_logged_in') !== 'true') return !silent && showToast(VIEWER_LOCK_MSG);
        const next = typeof forceState === 'boolean' ? forceState : !simState.active;
        if (next === simState.active) return;
        if (next) {
            if (scadaSettings.drawActive) toggleScadaDrawMode(false); if (moveState.active) toggleScadaWireMoveMode(false); if (pinMoveState.active) toggleScadaPinMoveMode(false);
            simState.basePins = JSON.parse(Core.rawStorageGet(STORAGE_KEY_LABELS) || '[]');
            simState.workingPins = JSON.parse(JSON.stringify(simState.basePins));
            simState.steps = []; simState.baseTopo = null; simState.expandedImpactTab = null; simState.active = true;
            Core.enterSimSandbox(simState.workingPins); computeSimDiff();
            if (!silent) showToast('🧪 เปิดโหมดซ้อมสับ-ปลดแล้ว (ไม่กระทบผังจริงบน Cloud)');
        } else {
            simState.active = false; simState.steps = []; Core.exitSimSandbox(null); closeScadaSimPlanModal();
            if (!silent) showToast('🔄 ปิดโหมดซ้อมและคืนค่าผังวงจรจริงแล้ว');
        }
        leafletMap?.closePopup(); updateSimVisualChrome(); renderSimToolbarPanel(); renderLabeledPlacesList(true); scheduleUnifiedScadaRefresh();
    }

    function simulateSwitchStateChange(pinId, nextSt) {
        if (!simState.active) return;
        const tg = simState.workingPins.find(p => p?.id === pinId); if (!tg) return;
        const eqT = tg.scadaNode?.t || 'VS', prev = tg.scadaNode?.st || 'C', warn = tg.scadaNode?.lk || '';
        if (prev === nextSt) return leafletMap?.closePopup();
        const preN = (simState.curTopo || computeSimDiff(), simState.curTopo?.nodeStates?.get(pinId));
        const actLbl = nextSt === 'C' ? '🟢 สับจ่ายไฟ (CLOSE)' : (nextSt === 'O' ? '⚪ ปลดสวิตช์ (OPEN)' : '🔴 จำลองทริป (TRIP)');
        const applyStep = () => {
            leafletMap?.closePopup(); const snap = JSON.stringify(simState.workingPins);
            tg.scadaNode = tg.scadaNode || { t: eqT, col: getPinSavedColorHex(tg) }; tg.scadaNode.st = nextSt;
            if (!isBreakerType(eqT)) tg.pinColor = nextSt === 'C' ? hexToClosestPinColorKey(tg.scadaNode.col || '#10b981') : (nextSt === 'O' ? 'yellow' : 'red');
            localStorage.setItem(STORAGE_KEY_LABELS, JSON.stringify(simState.workingPins));
            simState.steps.push({ pinId: tg.id, codeName: tg.name, scadaId: tg.scadaNode.id || '', feeder: tg.scadaNode.fd || '', eqType: eqT, actionLabel: actLbl, interlockNote: warn, tieNote: (nextSt === 'C' && preN?.isTieTwoSources) ? `สับขนาน ${preN.terminalSources.map(s => s.name).join(' ↔ ')}` : '', lat: tg.lat, lon: tg.lon, snapshotBefore: snap });
            computeSimDiff(); renderSimToolbarPanel(); renderLabeledPlacesList(true); scheduleUnifiedScadaRefresh();
        };
        if (warn) showCustomConfirm(`⚠️ คำเตือน Interlock (${tg.name}):\n"${warn}"\n\nซ้อมขั้นตอนนี้ต่อหรือไม่?`, applyStep, '🧪 ตรวจสอบ Interlock');
        else if (nextSt === 'C' && preN?.isTieTwoSources) showCustomConfirm(`⚡ จุดปลด (${tg.name}) ชนไฟ 2 เบรกเกอร์ ยืนยันซ้อมสับขนานหรือไม่?`, applyStep, '⚡ ซ้อมสับขนาน 2 แหล่งจ่าย');
        else applyStep();
    }

    function simulateEdgePowerToggle(fId, eIdx) {
        if (!simState.active) return;
        const fP = simState.workingPins.find(p => p?.id === fId), eg = fP?.scadaLines?.[eIdx]; if (!eg) return;
        const tP = simState.workingPins.find(p => p?.id === eg.to), snap = JSON.stringify(simState.workingPins);
        leafletMap?.closePopup(); eg.off = eg.off ? 0 : 1;
        localStorage.setItem(STORAGE_KEY_LABELS, JSON.stringify(simState.workingPins));
        simState.steps.push({ pinId: fP.id, codeName: `สายช่วง ${fP.name} ➔ ${tP ? tP.name : ''}`, scadaId: '', feeder: eg.fd || '', eqType: 'LINE', actionLabel: eg.off ? '🔌 จำลองปลดสายไฟ' : '⚡ จำลองต่อสายคืน', interlockNote: '', tieNote: '', lat: fP.lat, lon: fP.lon, snapshotBefore: snap });
        computeSimDiff(); renderSimToolbarPanel(); renderLabeledPlacesList(true); scheduleUnifiedScadaRefresh();
    }

    function undoScadaSimStep() { if (!simState.active || !simState.steps.length) return; const l = simState.steps.pop(); simState.workingPins = JSON.parse(l.snapshotBefore); localStorage.setItem(STORAGE_KEY_LABELS, JSON.stringify(simState.workingPins)); computeSimDiff(); renderSimToolbarPanel(); renderLabeledPlacesList(true); scheduleUnifiedScadaRefresh(); }
    function resetScadaSimAll() { if (!simState.active) return; simState.workingPins = JSON.parse(JSON.stringify(simState.basePins)); simState.steps = []; localStorage.setItem(STORAGE_KEY_LABELS, JSON.stringify(simState.workingPins)); computeSimDiff(); renderSimToolbarPanel(); renderLabeledPlacesList(true); scheduleUnifiedScadaRefresh(); }
    function toggleSimImpactDetailTab(k) { simState.expandedImpactTab = simState.expandedImpactTab === k ? null : k; renderSimToolbarPanel(); }
    function applySimulatedStateToRealGrid() {
        if (!simState.active || !canCurrentUserEditScada() || !simState.steps.length) return;
        showCustomConfirm(`ยืนยันนำสถานะที่ซ้อมไว้ (${simState.steps.length} ขั้นตอน) ไปอัปเดตลง "ผังวงจรจริง" และซิงค์ Cloud ทันทีหรือไม่?`, async () => {
            const finalPins = JSON.parse(JSON.stringify(simState.workingPins)), nowIso = new Date().toISOString(), ids = new Set(simState.steps.map(s => s.pinId));
            finalPins.forEach(p => { if (p && ids.has(p.id)) p.updatedAt = nowIso; });
            simState.active = false; simState.steps = []; Core.exitSimSandbox(finalPins);
            updateSimVisualChrome(); renderSimToolbarPanel(); renderLabeledPlacesList(true); scheduleUnifiedScadaRefresh();
            if (typeof window.pushAllJobsToCloud === 'function') await window.pushAllJobsToCloud(true);
            showToast('✅ อัปเดตผลซ้อมลงผังวงจรจริงเรียบร้อยแล้ว!');
        }, '⚡ ยืนยันนำผลซ้อมไปใช้จริง');
    }

    function buildSimPlanText() {
        const title = document.getElementById('scadaSimPlanTitleInput')?.value.trim() || `แผนสับ-ปลดสวิตช์ (${getActiveEquipUserGroup()})`;
        const incGps = document.getElementById('scadaSimIncludeGpsChk')?.checked, incImp = document.getElementById('scadaSimIncludeImpactChk')?.checked, now = new Date();
        const lines = [`📋 ${title}`, `🏢 พื้นที่: ${getActiveEquipUserGroup()} • 📅 ${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()+543}`, '━━━━━━━━━━━━━━━━━━'];
        if (!simState.steps.length) lines.push('(ยังไม่ได้กดจำลองสับ-ปลดสวิตช์)');
        simState.steps.forEach((s, i) => { lines.push(`${i + 1}. ${s.actionLabel}`, `   ➔ ${s.codeName}${s.scadaId ? ` [ID ${s.scadaId}]` : ''}${s.feeder ? ` (วงจร ${s.feeder})` : ''}`); if (s.tieNote) lines.push(`   ⚡ ${s.tieNote}`); if (s.interlockNote) lines.push(`   ⚠️ ข้อควรระวัง: ${s.interlockNote}`); if (incGps && s.lat && s.lon) lines.push(`   📍 https://www.google.com/maps?q=${Number(s.lat).toFixed(6)},${Number(s.lon).toFixed(6)}`); });
        if (incImp && simState.lastDiff) { const d = simState.lastDiff; lines.push('━━━━━━━━━━━━━━━━━━', '📊 สรุปผลกระทบผังไฟหลังซ้อม:', `• 🔴 ไฟดับเพิ่ม: ${d.newlyOutage.filter(x=>!x.isTTap).length} จุด`, `• 🟢 จ่ายไฟคืน: ${d.newlyRestored.filter(x=>!x.isTTap).length} จุด`, `• 🔄 ไฟย้อน/ย้ายแหล่ง: ${d.transferredOrBackfeed.filter(x=>!x.isTTap).length} จุด`); }
        return lines.join('\n');
    }
    function openScadaSimPlanModal() { if (!simState.active) return; computeSimDiff(); rebuildScadaSimPlanText(); document.getElementById('scadaSimPlanModal')?.classList.remove('hidden'); }
    function closeScadaSimPlanModal() { document.getElementById('scadaSimPlanModal')?.classList.add('hidden'); }
    function rebuildScadaSimPlanText() { const el = document.getElementById('scadaSimPlanPreviewText'); if (el) el.value = buildSimPlanText(); }
    function copyScadaSimPlanToClipboard() { copyTechText(document.getElementById('scadaSimPlanPreviewText')?.value || buildSimPlanText(), '📋 คัดลอกแผนสับ-ปลดแล้ว!'); }
    function shareScadaSimPlanToLine() { const t = document.getElementById('scadaSimPlanPreviewText')?.value || buildSimPlanText(); copyTechText(t, '💬 กำลังเปิดแอป LINE...'); window.open('https://line.me/R/share?text=' + encodeURIComponent(t), '_blank'); }

    // เชื่อมเหตุการณ์ระบบ, คีย์ลัด & ส่งออกฟังก์ชันทั้งหมด
    window.__onScadaRoleUpdated = () => { if (!canCurrentUserEditScada()) { if (scadaSettings.drawActive) toggleScadaDrawMode(false); if (moveState.active) toggleScadaWireMoveMode(false); if (pinMoveState.active) toggleScadaPinMoveMode(false); } updateToolbarToggleButtonsUI(); renderLabeledPlacesList(true); };
    window.__onTechGpsUpdated = updateMyGpsMarkerOnLeaflet;
    Core.onRealtimeChange(keys => { if (keys.some(k => k.includes('labeled') || k.includes('audit'))) { renderLabeledPlacesList(true); scheduleUnifiedScadaRefresh(); } });
    document.addEventListener('click', e => { const b = document.getElementById('searchEquipAutocompleteBox'); if (b && !b.contains(e.target)) hideSearchEquipDropdown(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { if (!document.getElementById('scadaSimPlanModal')?.classList.contains('hidden')) return closeScadaSimPlanModal(); if (isMapFullscreen) return toggleMapFullscreenMode(); }
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target?.tagName || '').toUpperCase())) return;
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); if (simState.active) undoScadaSimStep(); else if (scadaSettings.drawActive) undoScadaDrawOnePoint(); else if (moveState.active) undoScadaWireMove(); else if (pinMoveState.active) undoScadaPinMove(); }
        else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z')) && scadaSettings.drawActive) { e.preventDefault(); redoScadaDrawOnePoint(); }
    });

    Object.assign(window, {
        openDeletedEquipAuditModal, closeDeletedEquipAuditModal, restoreDeletedPinFromAudit, clearDeletedEquipAuditLogs,
        selectEquipPinColorFilter, switchTechMainTab, onSearchEquipInputChange, onSearchEquipKeyDown, clearSearchEquipInput, selectSearchEquipSuggestion,
        copyEquipPinToClipboard, shareEquipPinToLine, copyActiveNavPinToClipboard, shareActiveNavPinToLine,
        selectModalPinColor, quickChangeSinglePinColor, bulkChangeAllPinsColor, openEquipPinModal, closeEquipPinModal, fillEquipCurrentGps, saveEquipPinModal,
        deleteEquipPinFromModal, deleteSingleLabeledPin, openClearEquipModal, closeClearEquipModal, confirmClearAllEquipPins,
        exportLabeledPinsToJson, exportLabeledPinsToExcel, handleImportLabeledFile,
        startLabeledPlaceNavigation, openExternalGoogleMapsForActiveNav, zoomToActiveNavRoute, stopLabeledPlaceNavigation,
        toggleShowAllPinNames, toggleMapFullscreenMode, toggleScadaSmartLodMode, centerMapOnMyGps, fitAllLabeledPinsOnMap, focusSinglePinOnMap, focusMapOnSearchMatch, appendNextEquipCardsBatch, renderLabeledPlacesList,
        onScadaActiveFeederInput, onScadaActiveSpecInput, onScadaActiveStyleChange, onScadaRouteModeChange, onScadaSideOffsetChange, setScadaDrawColor, onScadaLineWeightChange, onScadaFeederFilterChange, toggleScadaLinesVisibility, toggleScadaAutoJumperMode, toggleScadaAntiOverlapMode,
        toggleScadaDrawMode, resetScadaDrawSource, startDrawFromPopupPin, undoScadaDrawOnePoint, redoScadaDrawOnePoint,
        createTTapOnScadaEdge, quickDeleteTTapFromPopup, toggleScadaEdgePower, toggleScadaEdgeUgStyle, cycleScadaEdgeSide, straightenScadaEdge, cycleScadaEdgeJumpLayer, flipScadaEdgeJumpDir, deleteScadaEdge,
        toggleScadaWireMoveMode, setScadaWireMoveSubMode, toggleScadaWireOrthoSnap, startInteractiveWireMove, undoScadaWireMove, straightenSelectedWire,
        toggleScadaPinMoveMode, startSinglePinMoveFromPopup, togglePinMoveWireSnap, togglePinMoveTapToPlace, openSelectedPinModalFromMoveBar, undoScadaPinMove,
        quickSwitchScadaState, sendEquipToMainFaultForm, selectScadaModalSwatch, autoDetectScadaFieldsFromTitle, openScadaNodeModal, closeScadaNodeModal, saveScadaNodeModal, resetScadaNodeToDefaultPin,
        setScadaEdgeRecolorScopeV3, openScadaColorPaletteModal, closeScadaColorPaletteModal, onScadaWheelColorInput, onScadaHexTextInput, pickScadaPresetHex, clearScadaRecentColors, confirmScadaPaletteSelection,
        toggleScadaSimMode, simulateSwitchStateChange, simulateEdgePowerToggle, undoScadaSimStep, resetScadaSimAll, toggleSimImpactDetailTab, applySimulatedStateToRealGrid,
        openScadaSimPlanModal, closeScadaSimPlanModal, rebuildScadaSimPlanText, copyScadaSimPlanToClipboard, shareScadaSimPlanToLine
    });

    window.addEventListener('DOMContentLoaded', () => {
        injectScadaMasterStyles();
        injectScadaModalsAndTabUI();
        loadStoredLabeledPlaces();
        lastCheckedDateIsoForSchedule = getTodayLocalIso();
        renderLabeledPlacesList(false);
        if (new URLSearchParams(window.location.search).get('tab') === 'map') setTimeout(() => switchTechMainTab('map'), 220);
        setInterval(() => { if (!document.hidden && currentActiveMainTab === 'map' && getTodayLocalIso() !== lastCheckedDateIsoForSchedule) { lastCheckedDateIsoForSchedule = getTodayLocalIso(); renderLabeledPlacesList(true); } }, 60000);
    });
})();
// ==================== จบไฟล์ scada-engine.js ====================
