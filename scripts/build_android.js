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
  console.warn('To build locally on Windows, install OpenJDK 17 or 21 (e.g. `winget install Microsoft.OpenJDK.17`).');
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

const buildResult = spawnSync(gradlewPath, [target], { cwd: ANDROID_DIR, stdio: 'inherit', shell: true });
if (buildResult.status === 0) {
  console.log('\n[SUCCESS] Android build completed!');
  const apkDir = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk');
  console.log(`APKs available in: ${apkDir}`);
} else {
  console.error('\n[ERROR] Gradle build failed with code ' + buildResult.status);
  process.exit(buildResult.status);
}
