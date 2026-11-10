const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('--- Preparing Sultrix Mobile Web Assets (www/) ---');

// Clean and recreate www/
if (fs.existsSync(WWW)) {
  fs.rmSync(WWW, { recursive: true, force: true });
}
fs.mkdirSync(WWW, { recursive: true });

// Files to copy
const filesToCopy = ['app.js', 'styles.css', 'manifest.json', 'sw.js'];
for (const file of filesToCopy) {
  const src = path.join(ROOT, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(WWW, file));
    console.log(`Copied: ${file}`);
  }
}

// Copy assets
const assetsSrc = path.join(ROOT, 'assets');
if (fs.existsSync(assetsSrc)) {
  copyDirRecursive(assetsSrc, path.join(WWW, 'assets'));
  console.log('Copied: assets/ directory');
}

// Process index.html: make asset paths relative so they work inside Capacitor WebView
const indexPath = path.join(ROOT, 'index.html');
if (fs.existsSync(indexPath)) {
  let indexContent = fs.readFileSync(indexPath, 'utf8');
  indexContent = indexContent
    .replace(/href="\/manifest\.json"/g, 'href="manifest.json"')
    .replace(/href="\/assets\//g, 'href="assets/')
    .replace(/src="\/assets\//g, 'src="assets/')
    .replace(/href="\/styles\.css"/g, 'href="styles.css"')
    .replace(/src="\/app\.js"/g, 'src="app.js"');
  fs.writeFileSync(path.join(WWW, 'index.html'), indexContent, 'utf8');
  console.log('Copied and normalized: index.html');
}

console.log('Mobile assets preparation complete in www/');
