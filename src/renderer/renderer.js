// UI DOM Elements
const folderPathInput = document.getElementById('folder-path');
const btnBrowse = document.getElementById('btn-browse');
const btnStart = document.getElementById('btn-start');
const btnPause = document.getElementById('btn-pause');
const btnClearLog = document.getElementById('btn-clear-log');
const qualityRange = document.getElementById('quality-range');
const qualityVal = document.getElementById('quality-val');
const formatSelect = document.getElementById('format-select');
const qualityGroup = document.getElementById('quality-group');
const interpolationGroup = document.getElementById('interpolation-group');
const interpolationSelect = document.getElementById('interpolation-select');
const videoCompressGroup = document.getElementById('video-compress-group');
const videoCompressCheckbox = document.getElementById('video-compress-checkbox');

// Mode toggle buttons
const btnModePhoto = document.getElementById('btn-mode-photo');
const btnModeVideo = document.getElementById('btn-mode-video');

// Stat Elements
const statProcessed = document.getElementById('stat-processed');
const statErrors = document.getElementById('stat-errors');
const statOriginal = document.getElementById('stat-original');
const statCompressed = document.getElementById('stat-compressed');
const statSaved = document.getElementById('stat-saved');

// Progress Elements
const progressBarContainer = document.getElementById('progress-bar-container');
const progressBarFill = document.getElementById('progress-bar-fill');
const progressStatusText = document.getElementById('progress-status-text');

// Log Console
const consoleLog = document.getElementById('console-log');

let selectedPaths = [];
let currentMode = 'photo';
let maxDroppedFileSize = 0;
let isProcessing = false;

const PHOTO_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif|tiff?|raw|cr2|nef|arw|dng)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|mov|mkv|avi|mxf|mts|m2ts|wmv)$/i;

// Update Quality Slider Label
qualityRange.addEventListener('input', (e) => {
  qualityVal.textContent = e.target.value;
});

// Update Quality slider state based on Output Format selection
formatSelect.addEventListener('change', () => {
  if (currentMode === 'video') return;
  const format = formatSelect.value;
  
  if (format === 'png') {
    qualityGroup.style.opacity = '0.3';
    qualityGroup.style.pointerEvents = 'none';
  } else {
    qualityGroup.style.opacity = '1';
    qualityGroup.style.pointerEvents = 'all';
    
    const uppercaseFormat = format === 'jpeg' ? 'JPEG' : 'WebP';
    const label = qualityGroup.querySelector('label');
    if (label && label.childNodes[0]) {
      label.childNodes[0].textContent = `Качество ${uppercaseFormat}: `;
    }
  }
});

// Mode Toggle Event Listeners
btnModePhoto.addEventListener('click', () => {
  if (currentMode === 'photo') return;
  currentMode = 'photo';
  btnModePhoto.classList.add('active');
  btnModeVideo.classList.remove('active');
  updateModeUi();
});

btnModeVideo.addEventListener('click', () => {
  if (currentMode === 'video') return;
  currentMode = 'video';
  btnModeVideo.classList.add('active');
  btnModePhoto.classList.remove('active');
  updateModeUi();
});

const PHOTO_FORMATS = [
  { value: 'webp', text: 'WebP' },
  { value: 'jpeg', text: 'JPEG' },
  { value: 'png', text: 'PNG' }
];

const VIDEO_FORMATS = [
  { value: 'mp4_h265', text: 'MP4 (H.265)' },
  { value: 'mp4_h264', text: 'MP4 (H.264)' },
  { value: 'mkv_h265', text: 'MKV (H.265)' },
  { value: 'mov_h265', text: 'MOV (H.265)' }
];

function populateFormats() {
  formatSelect.innerHTML = '';
  const formats = currentMode === 'photo' ? PHOTO_FORMATS : VIDEO_FORMATS;
  formats.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.value;
    opt.textContent = f.text;
    formatSelect.appendChild(opt);
  });
}

function updateModeUi() {
  const formatGroup = formatSelect.closest('.input-group');
  
  // Clear selection to avoid cross-mode mixing
  selectedPaths = [];
  maxDroppedFileSize = 0;
  folderPathInput.value = '';
  btnStart.setAttribute('disabled', 'true');
  
  // Re-populate format list
  populateFormats();

  if (currentMode === 'video') {
    // Keep format interactive for video conversion
    formatGroup.style.opacity = '1';
    formatGroup.style.pointerEvents = 'all';
    
    // Show interpolation selector, show video compress group, hide quality slider
    qualityGroup.style.display = 'none';
    interpolationGroup.style.display = 'flex';
    videoCompressGroup.style.display = 'flex';
    addLog('Режим переключен: Видео (Кодирование/Конвертация)', 'system');
  } else {
    formatGroup.style.opacity = '1';
    formatGroup.style.pointerEvents = 'all';
    
    // Show quality slider, hide interpolation selector and video compress group
    qualityGroup.style.display = 'flex';
    interpolationGroup.style.display = 'none';
    videoCompressGroup.style.display = 'none';

    if (formatSelect.value !== 'png') {
      qualityGroup.style.opacity = '1';
      qualityGroup.style.pointerEvents = 'all';
    } else {
      qualityGroup.style.opacity = '0.3';
      qualityGroup.style.pointerEvents = 'none';
    }
    addLog('Режим переключен: Фото (Конвертация в WebP/JPEG/PNG)', 'system');
  }
}

// Initial formats populate
populateFormats();

// Browse Folder Dialog
btnBrowse.addEventListener('click', async () => {
  try {
    const dirPath = await window.api.selectFolder();
    if (dirPath) {
      // Auto-detect mode based on the selected directory
      const detectedMode = await window.api.detectMode([dirPath]);
      if (detectedMode && detectedMode !== currentMode) {
        currentMode = detectedMode;
        if (currentMode === 'photo') {
          btnModePhoto.classList.add('active');
          btnModeVideo.classList.remove('active');
        } else {
          btnModeVideo.classList.add('active');
          btnModePhoto.classList.remove('active');
        }
        updateModeUi();
      }

      selectedPaths = [dirPath];
      folderPathInput.value = dirPath;
      btnStart.removeAttribute('disabled');
      addLog(`Выбрана папка: ${dirPath}`, 'system');
    }
  } catch (err) {
    addLog(`Ошибка выбора папки: ${err.message}`, 'error');
  }
});

// Start Processing or Stop Processing
btnStart.addEventListener('click', async () => {
  if (isProcessing) {
    // Stop active processing job
    btnStart.setAttribute('disabled', 'true');
    btnPause.setAttribute('disabled', 'true');
    progressStatusText.textContent = 'Остановка процесса...';
    try {
      await window.api.cancelProcessing();
    } catch (err) {
      addLog(`Ошибка остановки: ${err.message}`, 'error');
    }
    return;
  }

  if (selectedPaths.length === 0) return;

  // System Resource Warning for heavy HEVC/H.265 video encoding
  if (currentMode === 'video' && maxDroppedFileSize > 500 * 1024 * 1024) {
    try {
      const resources = await window.api.checkSystemResources();
      if (resources.freeMemGb < 2.0 || resources.cpus < 4) {
        const proceed = confirm(
          `Внимание: Выбран тяжелый файл видео (>500 МБ).\n\n` +
          `Сжатие HEVC (H.265) при свободной памяти ${resources.freeMemGb} ГБ и ${resources.cpus} CPU ` +
          `может перегрузить компьютер и занять много времени.\n\n` +
          `Вы действительно хотите продолжить?`
        );
        if (!proceed) return;
      }
    } catch (err) {
      console.error('System resources check failed:', err);
    }
  }

  const quality = parseInt(qualityRange.value, 10);
  const format = formatSelect.value;
  const interpolationFps = interpolationSelect.value;
  const compressVideo = videoCompressCheckbox.checked;
  
  isProcessing = true;

  // Update UI state to Running Mode (Start changes to Stop, Pause is shown)
  btnStart.textContent = 'Стоп';
  btnStart.classList.remove('btn-primary');
  btnStart.classList.add('btn-danger');
  btnStart.removeAttribute('disabled');

  btnBrowse.setAttribute('disabled', 'true');
  qualityRange.setAttribute('disabled', 'true');
  formatSelect.setAttribute('disabled', 'true');
  interpolationSelect.setAttribute('disabled', 'true');
  videoCompressCheckbox.setAttribute('disabled', 'true');
  
  btnModePhoto.setAttribute('disabled', 'true');
  btnModeVideo.setAttribute('disabled', 'true');
  btnModePhoto.style.pointerEvents = 'none';
  btnModeVideo.style.pointerEvents = 'none';
  
  btnPause.textContent = 'Пауза';
  btnPause.classList.remove('hidden');
  btnPause.removeAttribute('disabled');
  
  progressBarContainer.classList.remove('hidden');
  progressBarFill.style.width = '0%';
  progressStatusText.textContent = 'Инициализация обхода...';

  // Clear previous session stats in UI
  resetStats();

  try {
    const res = await window.api.startProcessing({ 
      paths: selectedPaths, 
      quality, 
      format, 
      mode: currentMode,
      interpolationFps,
      compressVideo
    });
    if (!res.success) {
      addLog(`Не удалось запустить процесс: ${res.error}`, 'error');
      restoreUi();
    }
  } catch (err) {
    addLog(`Критическая ошибка запуска: ${err.message}`, 'error');
    restoreUi();
  }
});

// Pause / Resume Processing
btnPause.addEventListener('click', async () => {
  if (btnPause.textContent === 'Пауза') {
    btnPause.textContent = 'Продолжить';
    btnPause.classList.remove('btn-secondary');
    btnPause.classList.add('btn-primary'); // Highlight resume
    progressStatusText.textContent = 'Приостановлено';
    addLog('Оптимизация приостановлена', 'system');
    try {
      await window.api.pauseProcessing();
    } catch (err) {
      addLog(`Ошибка приостановки: ${err.message}`, 'error');
    }
  } else {
    btnPause.textContent = 'Пауза';
    btnPause.classList.remove('btn-primary');
    btnPause.classList.add('btn-secondary');
    progressStatusText.textContent = 'Возобновление...';
    addLog('Оптимизация возобновлена', 'system');
    try {
      await window.api.resumeProcessing();
    } catch (err) {
      addLog(`Ошибка возобновления: ${err.message}`, 'error');
    }
  }
});

// Clear Log Console
btnClearLog.addEventListener('click', () => {
  consoleLog.innerHTML = '';
});

// Format bytes helper
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0.00 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Reset stats UI
function resetStats() {
  statProcessed.textContent = '0';
  statErrors.textContent = '0';
  statOriginal.textContent = '0.00 MB';
  statCompressed.textContent = '0.00 MB';
  statSaved.textContent = '0.00 MB (0%)';
}

// Restore UI controls after processing is done
function restoreUi() {
  isProcessing = false;
  
  // Reset Start Button to original state
  btnStart.textContent = 'Старт';
  btnStart.classList.remove('btn-danger');
  btnStart.classList.add('btn-primary');
  btnStart.removeAttribute('disabled');
  
  btnBrowse.removeAttribute('disabled');
  
  const format = formatSelect.value;
  if (currentMode === 'photo' && format !== 'png') {
    qualityRange.removeAttribute('disabled');
  }
  
  formatSelect.removeAttribute('disabled');
  interpolationSelect.removeAttribute('disabled');
  videoCompressCheckbox.removeAttribute('disabled');
  
  btnModePhoto.removeAttribute('disabled');
  btnModeVideo.removeAttribute('disabled');
  btnModePhoto.style.pointerEvents = 'all';
  btnModeVideo.style.pointerEvents = 'all';
  
  // Reset Pause Button
  btnPause.textContent = 'Пауза';
  btnPause.classList.remove('btn-primary');
  btnPause.classList.add('btn-secondary');
  btnPause.setAttribute('disabled', 'true');
  btnPause.classList.add('hidden');
  
  progressBarContainer.classList.add('hidden');
}

// Add logs helper
function addLog(message, type = 'system') {
  const timestamp = new Date().toLocaleTimeString();
  
  const logRow = document.createElement('div');
  logRow.className = `log-line ${type}-line`;
  
  const timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = `[${timestamp}]`;
  
  const textNode = document.createTextNode(message);
  
  logRow.appendChild(timeSpan);
  logRow.appendChild(textNode);
  
  consoleLog.appendChild(logRow);
  
  // Auto-scroll to bottom of console
  const parent = consoleLog.parentElement;
  parent.scrollTop = parent.scrollHeight;
}

// Add image preview log helper
async function addImgLog(src) {
  const timestamp = new Date().toLocaleTimeString();
  
  const logRow = document.createElement('div');
  logRow.className = 'log-line system-line';
  
  const timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = `[${timestamp}]`;
  logRow.appendChild(timeSpan);
  
  const labelSpan = document.createElement('span');
  labelSpan.textContent = ' 📷 Результат: ';
  logRow.appendChild(labelSpan);
  
  try {
    const base64Data = await window.api.readImageBase64(src);
    if (base64Data) {
      const img = document.createElement('img');
      img.src = base64Data;
      img.style.height = '180px';
      img.style.display = 'inline-block';
      img.style.verticalAlign = 'top';
      img.style.margin = '0 4px';
      img.style.border = 'none';
      img.style.borderRadius = '0';
      logRow.appendChild(img);
    }
  } catch (err) {
    console.error('Failed to load image for log:', err);
  }
  
  const suffixSpan = document.createElement('span');
  suffixSpan.textContent = 't-яшаэдишен.webp';
  logRow.appendChild(suffixSpan);
  
  consoleLog.appendChild(logRow);
  
  // Auto-scroll to bottom of console
  const parent = consoleLog.parentElement;
  parent.scrollTop = parent.scrollHeight;
}

// Register IPC progress update listeners
window.api.onStarted(({ paths, mode }) => {
  const typeText = mode === 'video' ? 'видео' : 'изображений';
  addLog(`Старт оптимизации для ${paths.length} ${typeText}`, 'system');
  progressStatusText.textContent = 'Сканирование и сжатие файлов...';
  progressBarFill.style.width = '15%'; // Indeterminate start push
});

window.api.onVideoProgress(({ filePath, percent }) => {
  const filename = filePath.split(/[/\\]/).pop();
  progressBarFill.style.width = `${percent}%`;
  progressStatusText.textContent = `Обработка: ${filename} - ${percent}%`;
});

window.api.onLog(({ filePath, message }) => {
  const filename = filePath ? filePath.split(/[/\\]/).pop() : '';
  addLog(`[${filename}] ${message}`, 'system');
  progressStatusText.textContent = message;
});

window.api.onProgress((data) => {
  // Update stats
  statProcessed.textContent = data.processedCount;
  statErrors.textContent = data.errorCount;
  statOriginal.textContent = formatBytes(data.totalOriginalBytes);
  statCompressed.textContent = formatBytes(data.totalCompressedBytes);
  
  const percentage = data.totalOriginalBytes > 0 
    ? Math.round((data.savedBytes / data.totalOriginalBytes) * 100) 
    : 0;
  statSaved.textContent = `${formatBytes(data.savedBytes)} (${percentage}%)`;

  // Display log for successful files
  if (data.filePath && data.originalSize !== undefined) {
    const filename = data.filePath.split(/[/\\]/).pop();
    if (data.fellBack) {
      const activeFormat = formatSelect.value.toUpperCase();
      addLog(`ℹ️ [Сохранен оригинал] ${filename} (${formatBytes(data.originalSize)} - ${activeFormat} весил бы больше)`, 'system');
    } else {
      const ratio = Math.round(((data.originalSize - data.compressedSize) / data.originalSize) * 100);
      addLog(`🟢 Сжато: ${filename} (${formatBytes(data.originalSize)} -> ${formatBytes(data.compressedSize)}, -${ratio}%)`, 'success');
    }
  }

  // Set visual progress (since total is unknown due to lazy traverse, we simulate an expanding indeterminate progress line)
  const simulatedProgress = Math.min(95, 15 + (data.processedCount * 2));
  progressBarFill.style.width = `${simulatedProgress}%`;
  progressStatusText.textContent = `Обработано: ${data.processedCount} | Ошибок: ${data.errorCount}`;
});

window.api.onFileError((data) => {
  const filename = data.filePath ? data.filePath.split(/[/\\]/).pop() : 'Система обхода';
  addLog(`🔴 Ошибка: ${filename} - ${data.error}`, 'error');
});

window.api.onComplete((data) => {
  progressBarFill.style.width = '100%';
  progressStatusText.textContent = `Завершено! Успешно обработано: ${data.processedCount}`;
  addLog(`🎉 Сжатие завершено! Сэкономлено: ${formatBytes(data.savedBytes)}. Ошибок: ${data.errorCount}`, 'success');
  restoreUi();
});

window.api.onCancelled((data) => {
  addLog(`⚠️ Процесс отменен пользователем. Сжато: ${data.processedCount}, сэкономлено: ${formatBytes(data.savedBytes)}`, 'system');
  progressStatusText.textContent = 'Отменено';
  restoreUi();
});

window.api.onError((data) => {
  addLog(`🔴 Критическая ошибка: ${data.error}`, 'error');
  progressStatusText.textContent = 'Ошибка выполнения';
  restoreUi();
});

// ==========================================
// Drag & Drop Handling (Drop folder on window)
// ==========================================
const dragOverlay = document.getElementById('drag-overlay');

// Prevent browser defaults for drag/drop on window
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

// Show overlay when folder is dragged over body (only if we're not currently processing)
document.body.addEventListener('dragenter', (e) => {
  e.preventDefault();
  e.stopPropagation();
  
  if (!isProcessing && e.dataTransfer.types.includes('Files')) {
    dragOverlay.classList.add('active');
  }
});

dragOverlay.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

dragOverlay.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragOverlay.classList.remove('active');
});

dragOverlay.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragOverlay.classList.remove('active');

  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    const rawPaths = Array.from(files).map(f => f.path).filter(Boolean);
    if (rawPaths.length > 0) {
      // Auto-detect mode based on dropped objects
      const detectedMode = await window.api.detectMode(rawPaths);
      if (detectedMode && detectedMode !== currentMode) {
        currentMode = detectedMode;
        if (currentMode === 'photo') {
          btnModePhoto.classList.add('active');
          btnModeVideo.classList.remove('active');
        } else {
          btnModeVideo.classList.add('active');
          btnModePhoto.classList.remove('active');
        }
        updateModeUi();
      }

      // Filter files based on current mode
      const filteredFiles = Array.from(files).filter(f => {
        if (f.path) {
          const isFile = f.type || f.name.includes('.');
          if (isFile) {
            const regex = currentMode === 'photo' ? PHOTO_EXTENSIONS : VIDEO_EXTENSIONS;
            return regex.test(f.name);
          }
          return true; // Folders are always accepted
        }
        return false;
      });

      if (filteredFiles.length === 0) {
        addLog(`Предупреждение: Ни один из файлов не подходит для режима ${currentMode === 'photo' ? 'Фото' : 'Видео'}.`, 'error');
        return;
      }

      // Save max file size for video warnings
      maxDroppedFileSize = filteredFiles.reduce((max, f) => Math.max(max, f.size || 0), 0);

      const paths = filteredFiles.map(f => f.path).filter(Boolean);
      if (paths.length > 0) {
        selectedPaths = paths;
        
        if (paths.length === 1) {
          const singlePath = paths[0];
          try {
            const isDir = await window.api.checkDirectory(singlePath);
            if (isDir) {
              folderPathInput.value = singlePath;
              addLog(`Папка выбрана перетаскиванием: ${singlePath}`, 'system');
            } else {
              const filename = singlePath.split(/[/\\]/).pop();
              folderPathInput.value = filename;
              addLog(`Файл выбран перетаскиванием: ${filename}`, 'system');
            }
          } catch (err) {
            folderPathInput.value = singlePath;
            addLog(`Объект выбран перетаскиванием: ${singlePath}`, 'system');
          }
        } else {
          folderPathInput.value = `Выбрано объектов: ${paths.length}`;
          addLog(`Выбрано объектов перетаскиванием: ${paths.length}`, 'system');
        }
        
        btnStart.removeAttribute('disabled');
      }
    }
  }
});

