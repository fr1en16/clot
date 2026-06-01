const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const { processPaths, walk } = require('./processor');
const { processVideos } = require('./videoProcessor');

// Supported extensions for mode detection
const PHOTO_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif|tiff?|raw|cr2|nef|arw|dng)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|mov|mkv|avi|mxf|mts|m2ts|wmv)$/i;

/**
 * Detects whether the provided paths contain photo or video files.
 * Returns 'photo', 'video', or null if undetermined.
 * 
 * @param {string[]} paths Array of paths (directories or files)
 * @returns {Promise<string|null>}
 */
async function detectModeForPaths(paths) {
  for (const p of paths) {
    try {
      const stat = await fs.promises.stat(p);
      if (stat.isFile()) {
        if (VIDEO_EXTENSIONS.test(p)) return 'video';
        if (PHOTO_EXTENSIONS.test(p)) return 'photo';
      } else if (stat.isDirectory()) {
        const fileGenerator = walk(p);
        let nextVal = await fileGenerator.next();
        while (!nextVal.done) {
          const filePath = nextVal.value;
          if (VIDEO_EXTENSIONS.test(filePath)) return 'video';
          if (PHOTO_EXTENSIONS.test(filePath)) return 'photo';
          nextVal = await fileGenerator.next();
        }
      }
    } catch (e) {
      // Ignore individual path read errors
    }
  }
  return null;
}

// Keep track of active cancellation state
let activeJob = null;

/**
 * Registers all ipcMain event handlers for communication with the renderer process.
 * 
 * @param {import('electron').BrowserWindow} mainWindow Reference to the main window
 */
function registerIpcHandlers(mainWindow) {
  
  // Detect active mode (returns 'photo', 'video', or null)
  ipcMain.handle('detect-mode', async (event, paths) => {
    return await detectModeForPaths(paths);
  });
  
  // Verify if a path is a directory (used for drag and drop validation)
  ipcMain.handle('check-directory', async (event, dirPath) => {
    try {
      const stat = await fs.promises.stat(dirPath);
      return stat.isDirectory();
    } catch (e) {
      return false;
    }
  });

  // Check system resources (RAM & CPU) for warning warnings
  ipcMain.handle('check-system-resources', async () => {
    const freeMemBytes = os.freemem();
    const freeMemGb = freeMemBytes / (1024 * 1024 * 1024);
    const cpuCount = os.cpus().length;
    return {
      freeMemGb: parseFloat(freeMemGb.toFixed(2)),
      cpus: cpuCount
    };
  });

  // Select Folder Dialog
  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Folder for Image/Video Optimization',
      properties: ['openDirectory', 'createDirectory']
    });
    
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // Helper function to safely send events to the window if it hasn't been closed
  const sendEvent = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  };

  // Start Batch Image/Video Processing
  ipcMain.handle('start-processing', async (event, { paths, quality, format, mode, interpolationFps, compressVideo }) => {
    if (activeJob) {
      return { success: false, error: 'Optimization process is already in progress.' };
    }

    const cancellationState = { cancelled: false, kill: null };
    activeJob = cancellationState;

    let processedCount = 0;
    let errorCount = 0;
    let totalOriginalBytes = 0;
    let totalCompressedBytes = 0;

    // Run the processing asynchronously so we don't block the main IPC return
    (async () => {
      try {
        sendEvent('processing-started', { paths, mode });

        if (mode === 'video') {
          // Video processing via FFmpeg
          await processVideos(paths, {
            format,
            interpolationFps,
            compressVideo,
            cancellationState,
            onLog: (filePath, message) => {
              sendEvent('processing-file-log', {
                filePath,
                message
              });
            },
            onProgress: (filePath, result) => {
              processedCount++;
              totalOriginalBytes += result.originalSize;
              totalCompressedBytes += result.compressedSize;

              sendEvent('processing-progress', {
                filePath,
                processedCount,
                errorCount,
                originalSize: result.originalSize,
                compressedSize: result.compressedSize,
                fellBack: result.fellBack,
                totalOriginalBytes,
                totalCompressedBytes,
                savedBytes: Math.max(0, totalOriginalBytes - totalCompressedBytes)
              });
            },
            onFileProgress: (filePath, percent) => {
              sendEvent('processing-video-progress', {
                filePath,
                percent
              });
            },
            onFileError: (filePath, error) => {
              errorCount++;
              sendEvent('processing-file-error', {
                filePath: filePath || 'FFmpeg Scan',
                error: error.message || String(error)
              });

              sendEvent('processing-progress', {
                filePath: filePath || 'FFmpeg Scan',
                processedCount,
                errorCount,
                totalOriginalBytes,
                totalCompressedBytes,
                savedBytes: Math.max(0, totalOriginalBytes - totalCompressedBytes)
              });
            }
          });
        } else {
          // Photo processing via Sharp
          await processPaths(paths, {
            quality: quality || 80,
            format: format || 'webp',
            cancellationState,
            onProgress: (filePath, result) => {
              processedCount++;
              totalOriginalBytes += result.originalSize;
              totalCompressedBytes += result.compressedSize;

              sendEvent('processing-progress', {
                filePath,
                processedCount,
                errorCount,
                originalSize: result.originalSize,
                compressedSize: result.compressedSize,
                fellBack: result.fellBack,
                totalOriginalBytes,
                totalCompressedBytes,
                savedBytes: Math.max(0, totalOriginalBytes - totalCompressedBytes)
              });
            },
            onFileError: (filePath, error) => {
              errorCount++;
              sendEvent('processing-file-error', {
                filePath: filePath || 'System File Scan',
                error: error.message || String(error)
              });

              sendEvent('processing-progress', {
                filePath: filePath || 'System File Scan',
                processedCount,
                errorCount,
                totalOriginalBytes,
                totalCompressedBytes,
                savedBytes: Math.max(0, totalOriginalBytes - totalCompressedBytes)
              });
            }
          });
        }

        if (cancellationState.cancelled) {
          sendEvent('processing-cancelled', {
            processedCount,
            errorCount,
            savedBytes: Math.max(0, totalOriginalBytes - totalCompressedBytes)
          });
        } else {
          sendEvent('processing-complete', {
            processedCount,
            errorCount,
            savedBytes: Math.max(0, totalOriginalBytes - totalCompressedBytes)
          });
        }
      } catch (err) {
        sendEvent('processing-error', {
          error: err.message || String(err)
        });
      } finally {
        activeJob = null;
      }
    })();

    return { success: true };
  });

  // Cancel Image/Video Processing
  ipcMain.handle('cancel-processing', async () => {
    if (activeJob) {
      activeJob.cancelled = true;
      if (activeJob.kill) {
        try {
          activeJob.kill();
        } catch (e) {
          // Ignore process kill errors
        }
      }
      return { success: true };
    }
    return { success: false, error: 'No active optimization job running.' };
  });

  // Pause Processing
  ipcMain.handle('pause-processing', async () => {
    if (activeJob) {
      activeJob.paused = true;
      if (activeJob.pause) {
        try {
          activeJob.pause();
        } catch (e) {
          // Ignore
        }
      }
      return { success: true };
    }
    return { success: false, error: 'No active optimization job running.' };
  });

  // Resume Processing
  ipcMain.handle('resume-processing', async () => {
    if (activeJob) {
      activeJob.paused = false;
      if (activeJob.resume) {
        try {
          activeJob.resume();
        } catch (e) {
          // Ignore
        }
      }
      return { success: true };
    }
    return { success: false, error: 'No active optimization job running.' };
  });

  // Read local image as base64 (safely bypassing webSecurity constraints)
  ipcMain.handle('read-image-base64', async (event, filePath) => {
    try {
      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      let mime = 'image/png';
      if (ext === '.webp') mime = 'image/webp';
      else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.gif') mime = 'image/gif';
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch (e) {
      return null;
    }
  });
}

module.exports = {
  registerIpcHandlers
};
