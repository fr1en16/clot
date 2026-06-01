const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');

// Disable Sharp cache to keep memory usage minimal during batch operations
sharp.cache(false);

const SUPPORTED_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif|tiff?|raw|cr2|nef|arw|dng)$/i;
const COMPRESSED_PREFIX = 'clot-';

/**
 * Recursively walks a directory lazily using fs.promises.opendir.
 * Yields file paths one by one to avoid loading all files into RAM.
 * 
 * @param {string} dir Path to the directory
 * @yields {string} Full path of the file
 */
async function* walk(dir) {
  let dirp;
  try {
    dirp = await fs.promises.opendir(dir);
  } catch (err) {
    // If directory can't be read, propagate the error up
    throw new Error(`Failed to open directory ${dir}: ${err.message}`);
  }

  try {
    for await (const entry of dirp) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walk(fullPath);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  } catch (err) {
    throw new Error(`Error during directory walk in ${dir}: ${err.message}`);
  }
}

/**
 * Checks if a file is a supported image type (JPEG/PNG) and hasn't been compressed yet.
 * 
 * @param {string} filePath 
 * @returns {boolean}
 */
function shouldProcess(filePath) {
  const ext = path.extname(filePath);
  if (!SUPPORTED_EXTENSIONS.test(ext)) {
    return false;
  }
  
  // Exclude files that are already compressed to prevent double processing
  const baseName = path.basename(filePath);
  if (baseName.startsWith(COMPRESSED_PREFIX)) {
    return false;
  }

  return true;
}

/**
 * Compresses an image file and saves it in WebP format with quality 80.
 * 
 * @param {string} filePath 
 * @param {number} quality WebP quality setting (0-100)
 * @returns {Promise<{ destPath: string, originalSize: number, compressedSize: number }>}
 */
/**
 * Compresses an image file and saves it in the specified format and quality.
 * 
 * @param {string} filePath 
 * @param {number} quality quality setting (0-100)
 * @param {string} format output format ('webp' | 'jpeg' | 'png')
 * @returns {Promise<{ destPath: string, originalSize: number, compressedSize: number, fellBack: boolean }>}
 */
async function compressImage(filePath, quality = 80, format = 'webp') {
  const ext = path.extname(filePath);
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, ext);

  // Set appropriate extension for target format
  const outExt = format === 'jpeg' ? '.jpg' : `.${format}`;
  const destPath = path.join(dir, `${COMPRESSED_PREFIX}${baseName}${outExt}`);

  const stat = await fs.promises.stat(filePath);
  const originalSize = stat.size;

  // Process image based on target format
  let transformer = sharp(filePath);
  if (format === 'webp') {
    transformer = transformer.webp({ quality });
  } else if (format === 'jpeg') {
    transformer = transformer.jpeg({ quality });
  } else if (format === 'png') {
    transformer = transformer.png({ palette: true, quality: quality || 80, compressionLevel: 9 });
  }

  await transformer.toFile(destPath);

  const destStat = await fs.promises.stat(destPath);
  let compressedSize = destStat.size;
  let finalDestPath = destPath;
  let fellBack = false;

  // Safety fallback: if target format is larger than or equal to original, delete and copy original format
  if (compressedSize >= originalSize) {
    try {
      await fs.promises.unlink(destPath);
      finalDestPath = path.join(dir, `${COMPRESSED_PREFIX}${baseName}${ext}`);
      await fs.promises.copyFile(filePath, finalDestPath);
      compressedSize = originalSize;
      fellBack = true;
    } catch (err) {
      // If rollback fails, keep the converted file
    }
  }

  return {
    destPath: finalDestPath,
    originalSize,
    compressedSize,
    fellBack
  };
}

/**
 * Lazily walks multiple target paths. If path is a folder, walks it recursively.
 * If path is a file, yields it directly.
 * 
 * @param {string[]} paths Array of paths (directories or files)
 * @yields {string} Full path of the file
 */
async function* walkTargets(paths) {
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
 * Recursively scans and processes images across multiple files and folders with controlled concurrency.
 * 
 * @param {string[]} paths Target paths to process
 * @param {object} options Options
 * @param {number} options.quality WebP quality
 * @param {number} options.concurrency Concurrency limit
 * @param {object} options.cancellationState Reference to cancel state { cancelled: boolean }
 * @param {function} options.onProgress Callback for successful compression (filePath, result)
 * @param {function} options.onFileError Callback for errors on individual files (filePath, error)
 * @returns {Promise<void>}
 */
async function processPaths(paths, options = {}) {
  const {
    quality = 80,
    format = 'webp',
    concurrency = Math.max(1, os.cpus().length),
    cancellationState = { cancelled: false },
    onProgress = () => {},
    onFileError = () => {}
  } = options;

  // Create generator for all target files
  const fileGenerator = walkTargets(paths);

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

      // Filter file
      if (!shouldProcess(filePath)) {
        // Skip file, fetch next immediately
        next();
        return;
      }

      activeCount++;

      compressImage(filePath, quality, format)
        .then((result) => {
          onProgress(filePath, result);
        })
        .catch((err) => {
          onFileError(filePath, err);
        })
        .finally(() => {
          activeCount--;
          if (cancellationState.cancelled) {
            done = true;
          }
          if (done && activeCount === 0) {
            resolve();
          } else {
            next();
          }
        });
    }

    // Spawn initial worker queue
    for (let i = 0; i < concurrency; i++) {
      next();
    }
  });
}

module.exports = {
  processPaths,
  shouldProcess,
  compressImage,
  walk,
  walkTargets
};
