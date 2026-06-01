const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
  // We only run this on macOS build
  if (context.electronPlatformName !== 'darwin') {
    return;
  }
  
  const appOutDir = context.appOutDir;
  const appName = context.packager.appInfo.productFilename + '.app';
  const ffmpegPath = path.join(appOutDir, appName, 'Contents', 'Resources', 'bin', 'ffmpeg');

  console.log(`Setting executable permissions (chmod +x) for FFmpeg at: ${ffmpegPath}`);
  
  if (fs.existsSync(ffmpegPath)) {
    try {
      fs.chmodSync(ffmpegPath, '755');
      console.log('Successfully set chmod +x/755 for ffmpeg binary');
    } catch (err) {
      console.error(`Failed to set permissions for ffmpeg binary: ${err.message}`);
    }
  } else {
    console.warn(`ffmpeg binary not found at: ${ffmpegPath}`);
  }

  const rifePath = path.join(appOutDir, appName, 'Contents', 'Resources', 'bin', 'rife', 'rife-ncnn-vulkan');
  console.log(`Setting executable permissions (chmod +x) for RIFE at: ${rifePath}`);
  
  if (fs.existsSync(rifePath)) {
    try {
      fs.chmodSync(rifePath, '755');
      console.log('Successfully set chmod +x/755 for rife binary');
    } catch (err) {
      console.error(`Failed to set permissions for rife binary: ${err.message}`);
    }
  } else {
    console.warn(`rife binary not found at: ${rifePath}`);
  }
};
