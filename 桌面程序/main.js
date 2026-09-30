const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const DEFAULT_ROOT = 'E:\\软件开发\\洗衣管家会员导出';
let ROOT = fs.existsSync(DEFAULT_ROOT) ? DEFAULT_ROOT : path.resolve(__dirname, '..');
const PORT = 8791;
const BASE = 'http://127.0.0.1:' + PORT;
let token = '';
try { token = fs.readFileSync(path.join(ROOT, '.console_token.txt'), 'utf8').trim(); } catch (e) {}

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1200, () => { s.destroy(); resolve(false); });
  });
}
async function waitServer(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await portOpen()) return true; await new Promise((r) => setTimeout(r, 400)); }
  return false;
}
function startServer() {
  let node = 'D:\\node.js\\node.exe';
  if (!fs.existsSync(node)) node = 'node';
  const child = spawn(node, [path.join(ROOT, 'app', 'orders_server.mjs')], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  return child.pid;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  let win = null;
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    if (!(await portOpen())) {
      const pid = startServer();
      fs.appendFileSync(path.join(ROOT, '.dev', 'desktop.log'), new Date().toISOString() + ' spawned server pid=' + pid + '\n');
      await waitServer(20000);
    }
    const smoke = process.argv.includes('--smoke');
    win = new BrowserWindow({
      width: 1340, height: 880,
      show: !smoke,
      backgroundColor: '#0F1725',
      autoHideMenuBar: true,
      title: '洗衣管家工具箱',
      icon: path.join(__dirname, 'icon.ico'),
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    win.loadURL(BASE + '/home/?token=' + encodeURIComponent(token));
    const BASE_HOST = 'http://127.0.0.1:' + PORT;
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(BASE_HOST)) {
        const w = new BrowserWindow({ width: 1100, height: 820, autoHideMenuBar: true, backgroundColor: '#F7F8FA', title: '洗衣管家工具箱' });
        w.loadURL(url);
        return { action: 'deny' };
      }
      shell.openExternal(url);
      return { action: 'deny' };
    });
    win.on('closed', () => { win = null; });
    if (smoke) {
      setTimeout(() => {
        const ok = win && !win.isDestroyed();
        try { fs.writeFileSync(path.join(ROOT, '.dev', 'desktop_smoke.txt'), (ok ? 'OK ' : 'WIN_FAIL ') + new Date().toISOString()); } catch (e) {}
        app.exit(0);
      }, 6000);
    }
  });
  app.on('window-all-closed', () => { app.quit(); });
}