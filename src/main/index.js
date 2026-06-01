const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const { registerIpcHandlers } = require('./ipc');

let mainWindow = null;

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 850,
    minHeight: 500,
    titleBarStyle: 'hidden', // Native macOS look
    trafficLightPosition: { x: 12, y: 16 }, // Align traffic lights nicely
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    backgroundColor: '#1E1E2E' // Matches the dark slate theme
  });

  // Load index.html
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open developer tools (optional for debug)
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
    if (process.platform === 'darwin') {
      try {
        const image = nativeImage.createFromPath(iconPath);
        app.dock.setIcon(image);
      } catch (err) {
        console.error('Failed to set dock icon:', err);
      }
    }

    createWindow();
    registerIpcHandlers(mainWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
