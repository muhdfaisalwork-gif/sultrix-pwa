#!/usr/bin/env node
/**
 * Sultrix Mobile — Local Android Build Automation
 * Runs Gradle wrapper to assemble debug / release APK.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const IS_WINDOWS = process.platform === 'win32';
const GRADLE_CMD = IS_WINDOWS ? 'gradlew.bat' : './gradlew';

// JDK 21 must come from JAVA_HOME or PATH (no machine-specific path is baked in).

console.log('=== Sultrix Mobile: Android Build ===');

// 1. Ensure www/ is prepared and synced
console.log('[1/3] Syncing web assets to native container...');
const syncResult = spawnSync('npm', ['run', 'cap:sync'], { cwd: ROOT, stdio: 'inherit', shell: true });
if (syncResult.status !== 0) {
  console.error('ERROR: cap:sync failed');
  process.exit(1);
}

// 2. Check Java availability
console.log('[2/3] Checking Java environment...');
const javaCheck = spawnSync('java', ['-version'], { shell: true });
if (javaCheck.status !== 0) {
  console.warn('\n[NOTE] Java JDK is not found in your local PATH.');
  console.warn('To build locally on Windows, install OpenJDK 21 (e.g. `winget install Microsoft.OpenJDK.21`).');
  console.warn('The automated GitHub Actions workflow will compile the APK and IPA on cloud runners automatically.\n');
  process.exit(0);
}

// 3. Run Gradle assembleDebug
const target = process.argv.includes('--release') ? 'assembleRelease' : 'assembleDebug';
console.log(`[3/3] Running ${GRADLE_CMD} ${target}...`);

const gradlewPath = path.join(ANDROID_DIR, GRADLE_CMD);
if (!fs.existsSync(gradlewPath)) {
  console.error(`ERROR: Gradle wrapper not found at ${gradlewPath}`);
  process.exit(1);
}

const buildResult = spawnSync(IS_WINDOWS ? `call .\\${GRADLE_CMD}` : GRADLE_CMD, [target], { cwd: ANDROID_DIR, stdio: 'inherit', shell: true });
if (buildResult.status === 0) {
  console.log('\n[SUCCESS] Android build completed!');
  const apkSrc = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const relDir = path.join(ROOT, 'releases');
  if (fs.existsSync(apkSrc)) {
    if (!fs.existsSync(relDir)) fs.mkdirSync(relDir, { recursive: true });
    const apkDst = path.join(relDir, 'Sultrix-v2.2.54.apk');
    fs.copyFileSync(apkSrc, apkDst);
    console.log(`Standalone APK ready: ${apkDst} (${(fs.statSync(apkDst).size / 1024 / 1024).toFixed(2)} MB)`);
  }
} else {
  console.error('\n[ERROR] Gradle build failed with code ' + buildResult.status);
  process.exit(buildResult.status);
}
