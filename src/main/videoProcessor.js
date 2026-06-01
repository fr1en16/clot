const { app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec, execFile, spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const { walk } = require('./processor');

// Configure path to FFmpeg and RIFE binaries based on environment
const isDev = !app.isPackaged;
const binPath = isDev 
  ? path.join(app.getAppPath(), 'resources', 'bin') 
  : path.join(process.resourcesPath, 'bin');

const ffmpegPath = path.join(binPath, 'ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const rifeDir = path.join(binPath, 'rife');
const rifePath = path.join(rifeDir, 'rife-ncnn-vulkan');

const VIDEO_EXTENSIONS = /\.(mp4|mov|mkv|avi|mxf|mts|m2ts|wmv)$/i;
const COMPRESSED_SUFFIX = '_compressed';

/**
 * Checks if a file is a supported video format and hasn't been compressed yet.
 * 
 * @param {string} filePath 
 * @returns {boolean}
 */
function shouldProcessVideo(filePath) {
  const ext = path.extname(filePath);
  if (!VIDEO_EXTENSIONS.test(ext)) {
    return false;
  }
  
  // Exclude files that are already compressed to prevent double processing
  const baseName = path.basename(filePath, ext);
  if (baseName.endsWith(COMPRESSED_SUFFIX)) {
    return false;
  }

  return true;
}

/**
 * Compresses a video file to H.265 (HEVC) MP4.
 * 
 * @param {string} filePath 
 * @param {object} options
 * @param {number} options.quality (unused for video, using CRF 23)
 * @param {object} options.cancellationState Object to handle job cancellation
 * @param {function} options.onFileProgress Callback for file progress percent (0-100)
 * @returns {Promise<{ destPath: string, originalSize: number, compressedSize: number, fellBack: boolean }>}
 */
/**
 * Checks if a compatible GPU (Metal/Vulkan) is available on macOS.
 * @returns {Promise<{ hasGPU: boolean, details: string }>}
 */
function checkGPU() {
  return new Promise((resolve) => {
    exec('system_profiler SPDisplaysDataType', (err, stdout) => {
      if (err) {
        resolve({ hasGPU: false, details: 'Unknown' });
        return;
      }
      const hasMetal = stdout.toLowerCase().includes('metal');
      const hasApple = stdout.toLowerCase().includes('apple');
      const hasIntel = stdout.toLowerCase().includes('intel');
      const hasAMD = stdout.toLowerCase().includes('amd');
      const hasNvidia = stdout.toLowerCase().includes('nvidia');

      const details = [];
      if (hasApple) details.push('Apple GPU');
      if (hasIntel) details.push('Intel GPU');
      if (hasAMD) details.push('AMD GPU');
      if (hasNvidia) details.push('Nvidia GPU');

      if (hasMetal || details.length > 0) {
        resolve({
          hasGPU: true,
          details: details.join(', ') || 'Compatible GPU'
        });
      } else {
        resolve({ hasGPU: false, details: 'CPU Only' });
      }
    });
  });
}

/**
 * Parses video metadata (FPS and Duration) using the packaged ffmpeg binary.
 * @param {string} filePath 
 * @returns {Promise<{ fps: number, duration: number }>}
 */
function getVideoMetadata(filePath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-i', filePath], (err, stdout, stderr) => {
      const info = stderr || stdout;
      const fpsMatch = info.match(/(\d+(?:\.\d+)?)\s*fps/);
      const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;

      const durationMatch = info.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      let durationSec = 0;
      if (durationMatch) {
        const hours = parseInt(durationMatch[1], 10);
        const minutes = parseInt(durationMatch[2], 10);
        const seconds = parseInt(durationMatch[3], 10);
        const centiseconds = parseInt(durationMatch[4], 10);
        durationSec = hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
      } else {
        const altDurationMatch = info.match(/Duration:\s*(\d+(\.\d+)?)/);
        if (altDurationMatch) {
          durationSec = parseFloat(altDurationMatch[1]);
        }
      }

      resolve({ fps, duration: durationSec });
    });
  });
}

/**
 * Runs the RIFE motion interpolation pipeline on a video file.
 * Extracts frames/audio, runs RIFE, re-encodes, and overwrites the input file.
 */
async function interpolateVideo(compressedPath, destPath, targetFps, options = {}) {
  const {
    videoCodec = 'libx265',
    outOpts = [],
    outExt = '.mp4',
    cancellationState = null,
    onFileProgress = () => {},
    onLog = () => {}
  } = options;

  const tempDir = path.join(os.tmpdir(), `clot-rife-${Date.now()}`);
  const inputFramesDir = path.join(tempDir, 'in');
  const outputFramesDir = path.join(tempDir, 'out');
  const tempAudioPath = path.join(tempDir, 'audio.aac');
  const finalTempPath = path.join(tempDir, `final_${Date.now()}${outExt}`);

  await fs.promises.mkdir(tempDir, { recursive: true });
  await fs.promises.mkdir(inputFramesDir, { recursive: true });
  await fs.promises.mkdir(outputFramesDir, { recursive: true });

  try {
    // 1. Extract audio
    onLog('Извлечение аудиодорожки...');
    let hasAudio = false;
    await new Promise((resolve) => {
      let cmd = ffmpeg(compressedPath)
        .output(tempAudioPath)
        .noVideo()
        .audioCodec('copy');

      if (cancellationState) {
        cancellationState.kill = () => {
          cmd.kill();
        };
        cmd.on('spawn', (proc) => {
          cancellationState.pause = () => proc.kill('SIGSTOP');
          cancellationState.resume = () => proc.kill('SIGCONT');
        });
      }

      cmd.on('end', () => {
        hasAudio = true;
        resolve();
      });
      cmd.on('error', () => {
        // Ignored if there's no audio track
        resolve();
      });
      cmd.run();
    });

    // 2. Extract frames
    onLog('Экспорт видеокадров...');
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(compressedPath)
        .output(path.join(inputFramesDir, '%08d.png'))
        .outputOptions('-vsync 0');

      if (cancellationState) {
        cancellationState.kill = () => {
          cmd.kill();
        };
        cmd.on('spawn', (proc) => {
          cancellationState.pause = () => proc.kill('SIGSTOP');
          cancellationState.resume = () => proc.kill('SIGCONT');
        });
      }

      cmd.on('end', () => resolve());
      cmd.on('error', (err) => reject(err));
      cmd.run();
    });

    // 3. Read metadata and count frames
    const meta = await getVideoMetadata(compressedPath);
    const files = await fs.promises.readdir(inputFramesDir);
    const originalFrameCount = files.filter(f => f.endsWith('.png')).length;
    const originalFps = meta.fps;

    if (originalFrameCount === 0) {
      throw new Error('Не удалось извлечь кадры из видео.');
    }

    const multiplier = targetFps / originalFps;
    if (multiplier <= 1.05) {
      onLog(`Пропуск: Исходный FPS (${originalFps.toFixed(1)}) равен или выше целевого (${targetFps})`);
      // Copy compressedPath to destPath and exit
      if (compressedPath !== destPath) {
        await fs.promises.copyFile(compressedPath, destPath);
      }
      return;
    }

    const targetFrameCount = Math.round(originalFrameCount * multiplier);
    onLog(`Интерполяция кадров (${originalFps.toFixed(1)} FPS -> ${targetFps} FPS)...`);

    // 4. Run RIFE process
    await new Promise((resolve, reject) => {
      const args = [
        '-i', inputFramesDir,
        '-o', outputFramesDir,
        '-n', targetFrameCount.toString(),
        '-m', path.join(rifeDir, 'rife-v4')
      ];

      const rifeProcess = spawn(rifePath, args);

      if (cancellationState) {
        cancellationState.kill = () => {
          rifeProcess.kill();
        };
        cancellationState.pause = () => {
          rifeProcess.kill('SIGSTOP');
        };
        cancellationState.resume = () => {
          rifeProcess.kill('SIGCONT');
        };
      }

      rifeProcess.stderr.on('data', (data) => {
        const str = data.toString();
        const match = str.match(/(\d+(?:\.\d+)?)%/);
        if (match && onFileProgress) {
          const percent = parseFloat(match[1]);
          onFileProgress(Math.round(percent));
        }
      });

      rifeProcess.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Процесс RIFE завершился с кодом ошибки ${code}`));
      });

      rifeProcess.on('error', (err) => reject(err));
    });

    // 5. Reassemble frames + audio
    onLog('Сборка финального видеофайла...');
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg()
        .input(path.join(outputFramesDir, '%08d.png'))
        .inputFPS(targetFps);

      const hasAudioFile = hasAudio && fs.existsSync(tempAudioPath) && fs.statSync(tempAudioPath).size > 0;
      if (hasAudioFile) {
        cmd = cmd.input(tempAudioPath);
      }

      cmd = cmd.videoCodec(videoCodec)
        .outputOptions(outOpts);

      if (hasAudioFile) {
        cmd = cmd.outputOptions('-map 0:v:0', '-map 1:a:0?', '-c:a copy');
      }

      cmd = cmd.output(finalTempPath);

      if (cancellationState) {
        cancellationState.kill = () => {
          cmd.kill();
        };
        cmd.on('spawn', (proc) => {
          cancellationState.pause = () => proc.kill('SIGSTOP');
          cancellationState.resume = () => proc.kill('SIGCONT');
        });
      }

      cmd.on('end', () => resolve());
      cmd.on('error', (err) => reject(err));
      cmd.run();
    });

    // Overwrite destPath with finalTempPath
    if (fs.existsSync(destPath)) {
      await fs.promises.unlink(destPath);
    }
    await fs.promises.rename(finalTempPath, destPath);

  } finally {
    // 6. Clean up temp workspace
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignored
    }
  }
}

/**
 * Core encoding processor function for compression and/or interpolation.
 */
function compressVideoWithEncoding(filePath, destPath, videoCodec, outOpts, originalSize, options = {}) {
  const isInterpolating = options.interpolationFps && options.interpolationFps !== 'off';
  const ext = path.extname(filePath);
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, ext);
  const outExt = path.extname(destPath);

  const encodePath = isInterpolating ? destPath + '.tmp' + outExt : destPath;

  return new Promise((resolve, reject) => {
    let command = ffmpeg(filePath)
      .inputOptions([
        '-probesize 100M',
        '-analyzeduration 100M'
      ])
      .videoCodec(videoCodec)
      .outputOptions(outOpts)
      .videoFilters('scale=min(iw\\,1920):-2')
      .output(encodePath);

    if (options.cancellationState) {
      options.cancellationState.kill = () => {
        command.kill();
      };
      command.on('spawn', (proc) => {
        options.cancellationState.pause = () => proc.kill('SIGSTOP');
        options.cancellationState.resume = () => proc.kill('SIGCONT');
      });
    }

    command.on('progress', (progress) => {
      if (options.onFileProgress && progress.percent !== undefined) {
        const basePercent = isInterpolating ? Math.round(progress.percent * 0.5) : Math.round(progress.percent);
        options.onFileProgress(basePercent);
      }
    });

    command.on('end', async () => {
      try {
        let finalPath = destPath;
        let fellBack = false;

        if (isInterpolating) {
          try {
            const gpu = await checkGPU();
            if (gpu.hasGPU) {
              options.onLog(`GPU Вулкан активен: ${gpu.details}`);
            } else {
              options.onLog('Внимание: Ускорение GPU недоступно. Работа на CPU (будет медленно).');
            }

            const targetFps = parseInt(options.interpolationFps, 10);
            
            // Run RIFE pipeline
            await interpolateVideo(encodePath, destPath, targetFps, {
              videoCodec,
              outOpts,
              outExt,
              cancellationState: options.cancellationState,
              onFileProgress: (percent) => {
                if (options.onFileProgress) {
                  options.onFileProgress(50 + Math.round(percent * 0.5));
                }
              },
              onLog: options.onLog
            });

            // Delete temporary compressed file
            await fs.promises.unlink(encodePath);

          } catch (err) {
            options.onLog(`Ошибка интерполяции: ${err.message}. Сохранение сжатой версии.`);
            if (fs.existsSync(encodePath)) {
              if (fs.existsSync(destPath)) {
                await fs.promises.unlink(destPath);
              }
              await fs.promises.rename(encodePath, destPath);
            }
          }
        }

        const destStat = await fs.promises.stat(destPath);
        let compressedSize = destStat.size;

        // Safety fallback: if output is larger than or equal to original, delete and copy original format
        if (compressedSize >= originalSize) {
          try {
            await fs.promises.unlink(destPath);
            finalPath = path.join(dir, `${baseName}${COMPRESSED_SUFFIX}${ext}`);
            await fs.promises.copyFile(filePath, finalPath);
            compressedSize = originalSize;
            fellBack = true;
            options.onLog('Сжатый файл превысил оригинал. Восстановлена копия оригинала.');
          } catch (err) {
            // Keep what we have if copy fails
          }
        }

        resolve({
          destPath: finalPath,
          originalSize,
          compressedSize,
          fellBack
        });
      } catch (err) {
        reject(err);
      }
    });

    command.on('error', (err) => {
      reject(err);
    });

    command.run();
  });
}

/**
 * Compresses a video file and optionally runs motion interpolation.
 */
async function compressVideo(filePath, options = {}) {
  const ext = path.extname(filePath);
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, ext);
  
  const format = options.format || 'mp4_h265';
  let outExt = '.mp4';
  let videoCodec = 'libx265';
  let outOpts = [
    '-crf 23',
    '-preset medium',
    '-map_metadata 0',
    '-pix_fmt yuv420p'
  ];

  if (format === 'mp4_h264') {
    outExt = '.mp4';
    videoCodec = 'libx264';
  } else if (format === 'mkv_h265') {
    outExt = '.mkv';
    videoCodec = 'libx265';
  } else if (format === 'mov_h265') {
    outExt = '.mov';
    videoCodec = 'libx265';
    outOpts.push('-tag:v hvc1');
  } else {
    outExt = '.mp4';
    videoCodec = 'libx265';
    outOpts.push('-tag:v hvc1');
  }
  
  const destPath = path.join(dir, `${baseName}${COMPRESSED_SUFFIX}${outExt}`);

  const stat = await fs.promises.stat(filePath);
  const originalSize = stat.size;

  const isInterpolating = options.interpolationFps && options.interpolationFps !== 'off';
  const shouldCompress = options.compressVideo !== false;

  if (!shouldCompress) {
    if (isInterpolating) {
      return new Promise(async (resolve, reject) => {
        try {
          const gpu = await checkGPU();
          if (gpu.hasGPU) {
            options.onLog(`GPU Вулкан активен: ${gpu.details}`);
          } else {
            options.onLog('Внимание: Ускорение GPU недоступно. Работа на CPU (будет медленно).');
          }

          const targetFps = parseInt(options.interpolationFps, 10);
          
          // Run RIFE pipeline directly on original file
          await interpolateVideo(filePath, destPath, targetFps, {
            videoCodec,
            outOpts,
            outExt,
            cancellationState: options.cancellationState,
            onFileProgress: (percent) => {
              if (options.onFileProgress) {
                options.onFileProgress(Math.round(percent));
              }
            },
            onLog: options.onLog
          });

          const destStat = await fs.promises.stat(destPath);
          resolve({
            destPath,
            originalSize,
            compressedSize: destStat.size,
            fellBack: false
          });
        } catch (err) {
          reject(err);
        }
      });
    } else {
      // Direct copy/remux container conversion (extremely fast)
      return new Promise((resolve, reject) => {
        options.onLog('Сжатие отключено. Попытка прямого копирования потоков (remux)...');
        let command = ffmpeg(filePath)
          .outputOptions('-map 0', '-c copy')
          .output(destPath);

        if (options.cancellationState) {
          options.cancellationState.kill = () => {
            command.kill();
          };
          command.on('spawn', (proc) => {
            options.cancellationState.pause = () => proc.kill('SIGSTOP');
            options.cancellationState.resume = () => proc.kill('SIGCONT');
          });
        }

        command.on('progress', (progress) => {
          if (options.onFileProgress && progress.percent !== undefined) {
            options.onFileProgress(Math.round(progress.percent));
          }
        });

        command.on('end', async () => {
          try {
            const destStat = await fs.promises.stat(destPath);
            options.onLog('Копирование потоков завершено успешно.');
            resolve({
              destPath,
              originalSize,
              compressedSize: destStat.size,
              fellBack: false
            });
          } catch (err) {
            reject(err);
          }
        });

        command.on('error', async (err) => {
          options.onLog(`Прямое копирование не удалось: ${err.message}. Выполняется кодирование...`);
          // If direct copy fails, fall back to encoding with compression
          try {
            const encodeResult = await compressVideoWithEncoding(filePath, destPath, videoCodec, outOpts, originalSize, options);
            resolve(encodeResult);
          } catch (fallbackErr) {
            reject(fallbackErr);
          }
        });

        command.run();
      });
    }
  }

  return compressVideoWithEncoding(filePath, destPath, videoCodec, outOpts, originalSize, options);
}

/**
 * Lazily walks multiple target paths. If path is a folder, walks it recursively.
 * If path is a file, yields it directly.
 * 
 * @param {string[]} paths Array of paths (directories or files)
 * @yields {string} Full path of the file
 */
async function* walkVideoTargets(paths) {
  for (const p of paths) {
    try {
      const stat = await fs.promises.stat(p);
      if (stat.isDirectory()) {
        yield* walk(p);
      } else if (stat.isFile()) {
        yield p;
      }
    } catch (err) {
      throw new Error(`Failed to read path ${p}: ${err.message}`);
    }
  }
}

/**
 * Recursively scans and processes videos across multiple files and folders with controlled concurrency.
 * 
 * @param {string[]} paths Target paths to process
 * @param {object} options Options
 * @param {number} options.concurrency Concurrency limit (default 1 for FFmpeg)
 * @param {object} options.cancellationState Reference to cancel state { cancelled: boolean }
 * @param {function} options.onProgress Callback for successful compression (filePath, result)
 * @param {function} options.onFileProgress Callback for progress updates within a single file (filePath, percent)
 * @param {function} options.onFileError Callback for errors on individual files (filePath, error)
 * @returns {Promise<void>}
 */
async function processVideos(paths, options = {}) {
  const {
    concurrency = 1, // Default to 1 to avoid CPU core overloading
    cancellationState = { cancelled: false },
    onProgress = () => {},
    onFileProgress = () => {},
    onFileError = () => {},
    format = 'mp4_h265',
    interpolationFps = 'off',
    compressVideo = true,
    onLog = () => {}
  } = options;

  const fileGenerator = walkVideoTargets(paths);

  let activeCount = 0;
  let done = false;

  return new Promise((resolve, reject) => {
    async function next() {
      if (cancellationState.paused) {
        setTimeout(next, 500);
        return;
      }

      if (done || cancellationState.cancelled) {
        done = true;
        if (activeCount === 0) resolve();
        return;
      }

      let nextVal;
      try {
        nextVal = await fileGenerator.next();
      } catch (err) {
        onFileError(null, err);
        done = true;
        if (activeCount === 0) resolve();
        return;
      }

      if (nextVal.done) {
        done = true;
        if (activeCount === 0) resolve();
        return;
      }

      const filePath = nextVal.value;

      // Filter video file
      if (!shouldProcessVideo(filePath)) {
        next();
        return;
      }

      activeCount++;

      // Create file-specific cancellation handle that wraps global state
      const fileCancelState = { cancelled: false, kill: null };

      compressVideo(filePath, {
        format,
        interpolationFps,
        compressVideo,
        onLog: (msg) => onLog(filePath, msg),
        cancellationState: fileCancelState,
        onFileProgress: (percent) => {
          onFileProgress(filePath, percent);
        }
      })
        .then((result) => {
          onProgress(filePath, result);
        })
        .catch((err) => {
          // If globally cancelled, ignore error
          if (cancellationState.cancelled) return;
          onFileError(filePath, err);
        })
        .finally(() => {
          activeCount--;
          if (cancellationState.cancelled) {
            if (fileCancelState.kill) fileCancelState.kill();
            done = true;
          }
          if (done && activeCount === 0) {
            resolve();
          } else {
            next();
          }
        });
        
      // If globally cancelled, trigger active command kill
      if (cancellationState.cancelled) {
        if (fileCancelState.kill) fileCancelState.kill();
      }
    }

    // Spawn initial worker queue
    for (let i = 0; i < concurrency; i++) {
      next();
    }
  });
}

module.exports = {
  processVideos,
  shouldProcessVideo,
  compressVideo
};
