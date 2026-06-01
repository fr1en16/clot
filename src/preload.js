const { contextBridge, ipcRenderer } = require('electron');

// We use an object to track registered listeners for cleanup
const listenersMap = new Map();

contextBridge.exposeInMainWorld('api', {
  /**
   * Triggers the native folder selection dialog.
   * @returns {Promise<string|null>} Path of the selected folder
   */
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  /**
   * Checks if a path is a directory on disk.
   * @param {string} dirPath 
   * @returns {Promise<boolean>}
   */
  checkDirectory: (dirPath) => ipcRenderer.invoke('check-directory', dirPath),

  /**
   * Checks RAM & CPU resources.
   * @returns {Promise<{freeMemGb: number, cpus: number}>}
   */
  checkSystemResources: () => ipcRenderer.invoke('check-system-resources'),

  /**
   * Detects the mode ('photo' or 'video') of given file or folder paths.
   * @param {string[]} paths Array of file/folder paths
   * @returns {Promise<string|null>}
   */
  detectMode: (paths) => ipcRenderer.invoke('detect-mode', paths),

  /**
   * Starts processing images/videos.
   * @param {object} args
   * @param {string} args.dirPath
   * @param {number} args.quality
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  startProcessing: (args) => ipcRenderer.invoke('start-processing', args),

  /**
   * Cancels the active processing job.
   */
  cancelProcessing: () => ipcRenderer.invoke('cancel-processing'),

  /**
   * Pauses the active processing job.
   */
  pauseProcessing: () => ipcRenderer.invoke('pause-processing'),

  /**
   * Resumes the active processing job.
   */
  resumeProcessing: () => ipcRenderer.invoke('resume-processing'),

  /**
   * Reads a local image file and returns its Base64 data URL.
   */
  readImageBase64: (filePath) => ipcRenderer.invoke('read-image-base64', filePath),

  /**
   * Event listeners for main-process updates
   */
  onStarted: (callback) => {
    const fn = (event, data) => callback(data);
    ipcRenderer.on('processing-started', fn);
    listenersMap.set('started', fn);
  },

  onProgress: (callback) => {
    const fn = (event, data) => callback(data);
    ipcRenderer.on('processing-progress', fn);
    listenersMap.set('progress', fn);
  },

  onFileError: (callback) => {
    const fn = (event, data) => callback(data);
    ipcRenderer.on('processing-file-error', fn);
    listenersMap.set('file-error', fn);
  },

  onComplete: (callback) => {
    const fn = (event, data) => callback(data);
    ipcRenderer.on('processing-complete', fn);
    listenersMap.set('complete', fn);
  },

  onCancelled: (callback) => {
    const fn = (event, data) => callback(data);
    ipcRenderer.on('processing-cancelled', fn);
    listenersMap.set('cancelled', fn);
  },

  onError: (callback) => {
    const fn = (event, data) => callback(data);
    ipcRenderer.on('processing-error', fn);
    listenersMap.set('error', fn);
  },

  onVideoProgress: (callback) => {
    const fn = (event, data) => callback(data);
    ipcRenderer.on('processing-video-progress', fn);
    listenersMap.set('video-progress', fn);
  },

  onLog: (callback) => {
    const fn = (event, data) => callback(data);
    ipcRenderer.on('processing-file-log', fn);
    listenersMap.set('file-log', fn);
  },

  /**
   * Clean up all registered IPC listeners to prevent memory leaks.
   */
  removeListeners: () => {
    ipcRenderer.removeAllListeners('processing-started');
    ipcRenderer.removeAllListeners('processing-progress');
    ipcRenderer.removeAllListeners('processing-file-error');
    ipcRenderer.removeAllListeners('processing-complete');
    ipcRenderer.removeAllListeners('processing-cancelled');
    ipcRenderer.removeAllListeners('processing-error');
    ipcRenderer.removeAllListeners('processing-video-progress');
    ipcRenderer.removeAllListeners('processing-file-log');
    listenersMap.clear();
  }
});
