const { app, BrowserWindow, session } = require('electron');
const path = require('path');

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        title: "ระบบเครื่องมือจัดการงานไฟฟ้า (รวมระบบ)",
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: true
        }
    });

    // ขยายเต็มจออัตโนมัติเมื่อเปิดโปรแกรม
    mainWindow.maximize();

    // 🔓 1. ปลดล็อกการบล็อก iframe ทั้งหมด (แก้ปัญหา www.google.com / www.youtube.com ปฏิเสธการเชื่อมต่อ 100%)
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = Object.assign({}, details.responseHeaders);
        Object.keys(responseHeaders).forEach((header) => {
            const h = header.toLowerCase();
            if (h === 'x-frame-options' || h === 'content-security-policy' || h === 'x-content-security-policy') {
                delete responseHeaders[header];
            }
        });
        callback({ cancel: false, responseHeaders });
    });

    // 🔄 2. ดักจับเว็บที่ล็อกอินแล้วเด้ง "หน้าต่างที่ 2" แยกตัวออกมา
    mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
        // กรณีผู้ใช้กดแชร์ส่ง LINE หรือเปิด Google Maps แยก หรือกดปุ่มโหมดหน้าต่างลอยชิดซ้าย ให้เปิดตามปกติ
        if (url.includes('line.me') || frameName === 'LeftSideWebPopup') {
            const w = Math.floor(1440 * 0.55);
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: w,
                    height: 900,
                    x: 0,
                    y: 0,
                    autoHideMenuBar: true
                }
            };
        }

        // กรณีเว็บในกรอบฝั่งซ้ายล็อกอินเสร็จแล้วเด้งหน้า 2 เอง -> บังคับดึงหน้า 2 เข้ามาแสดงในกรอบฝั่งซ้ายทันที!
        mainWindow.webContents.executeJavaScript(`
            (function() {
                const iframe = document.getElementById('leftBrowserIframe');
                const input = document.getElementById('leftBrowserUrlInput');
                const dock = document.getElementById('leftBrowserDock');
                if (iframe && dock && !dock.classList.contains('hidden')) {
                    if (input) input.value = "${url}";
                    iframe.src = "${url}";
                    localStorage.setItem('elec_left_browser_last_url', "${url}");
                } else {
                    window.open("${url}", "LeftSideWebPopup");
                }
            })();
        `);
        return { action: 'deny' };
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
