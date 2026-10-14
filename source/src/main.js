const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const https = require('https');
const childProcess = require('child_process');
// Keep the original spawn for RoseClient's own short-lived utility commands.
const { spawn } = childProcess;
const { pipeline } = require('stream/promises');
const { inflateRawSync } = require('zlib');

const startingInstances = new Set();
const launchRecords = new Map();
let activeLaunchInstanceId = null;
// minecraft-launcher-core creates the Java process internally. Wrap spawn before
// requiring it so RoseClient can track and stop the actual game process.
const originalChildSpawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const command = String(args[0] || '');
  // Hide Windows console windows for Java and helper processes while preserving
  // the visible, themed RoseClient log window opened by Start Minecraft.
  if (process.platform === 'win32') {
    const optionsIndex = 2;
    const options = args[optionsIndex];
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      args[optionsIndex] = { ...options, windowsHide: true };
    } else if (typeof options === 'string' || options == null) {
      args[optionsIndex] = { windowsHide: true };
    }
  }
  const child = originalChildSpawn.apply(this, args);
  if (/javaw?(?:\.exe)?$/i.test(path.basename(command))) {
    const record = activeLaunchInstanceId ? launchRecords.get(activeLaunchInstanceId) : null;
    if (record) {
      record.child = child;
      record.pid = child.pid || null;
      if (record.cancelRequested) {
        record.state = 'stopping';
        try { child.kill(); } catch {}
      } else {
        record.state = 'starting';
        record.message = 'Java process created; waiting for Minecraft to initialize…';
      }
      child.once('error', error => {
        record.state = 'failed';
        record.message = `Minecraft process error: ${error.message}`;
        record.error = error.message;
      });
      child.once('close', code => {
        record.exitCode = code;
        record.state = record.cancelRequested ? 'stopped' : (code === 0 ? 'stopped' : 'failed');
        record.message = record.cancelRequested ? 'Minecraft was stopped.' : `Minecraft exited with code ${code}.`;
        record.endedAt = Date.now();
        record.child = null;
        record.pid = null;
      });
    }
  }
  return child;
};
const { Client: MinecraftLauncher } = require('minecraft-launcher-core');
const { Auth, tokenUtils } = require('msmc');

const DATA_DIR = path.join(app.getPath('appData'), 'RoseClient');
const INSTANCES_DIR = path.join(DATA_DIR, 'instances');
const LOGIN_DIR = path.join(DATA_DIR, 'login');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const AUTH_TOKEN_FILE = path.join(LOGIN_DIR, 'microsoft-auth.enc');
const AUTH_PROFILE_FILE = path.join(LOGIN_DIR, 'profile.json');

const LOG_FILE = path.join(DATA_DIR, 'logs', 'roseclient.log');
let logWindow = null;
const logBuffer = [];
function publishLog(level, args) {
  const message = args.map(value => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }).join(' ');
  const entry = { time: new Date().toISOString(), level, message };
  logBuffer.push(entry);
  if (logBuffer.length > 1200) logBuffer.splice(0, logBuffer.length - 1200);
  if (logWindow && !logWindow.isDestroyed()) logWindow.webContents.send('logs:entry', entry);
  fs.mkdir(path.dirname(LOG_FILE), { recursive: true })
    .then(() => fs.appendFile(LOG_FILE, `[${entry.time}] [${level.toUpperCase()}] ${message}\n`, 'utf8'))
    .catch(() => {});
}
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => { original(...args); publishLog(level, args); };
}

// RoseClient's in-game mod is built for Fabric 26.1.2 only. Never install it into another loader/version.
const ROSECLIENT_ARTIFACTS = Object.freeze({
  'fabric|26.1.2': 'roseclient-fabric-26.1.2.jar'
});
const BUNDLED_MODS_DIR = app.isPackaged
  ? path.join(app.getAppPath(), 'resources', 'mods')
  : path.join(__dirname, '..', 'resources', 'mods');
function artifactFor(instance) {
  if (!instance) return null;
  return ROSECLIENT_ARTIFACTS[`${String(instance.loader).toLowerCase()}|${String(instance.minecraftVersion)}`] || null;
}
function roseClientCompatibility(instance) {
  const artifact = artifactFor(instance);
  if (!artifact) return { supported: false, reason: `No RoseClient build is registered for Minecraft ${instance?.minecraftVersion || 'unknown'} on ${instance?.loader || 'unknown'}.` };
  return { supported: true, artifact, reason: '' };
}
function bundledModFor(instance) {
  const artifact = artifactFor(instance);
  return artifact ? path.join(BUNDLED_MODS_DIR, artifact) : null;
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'RoseClient/1.0.0 (launcher)', ...headers } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Request failed (${res.statusCode}): ${data.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, destination) {
  const fetchToFile = (currentUrl, redirects = 0) => new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects while downloading a file.'));
    https.get(currentUrl, { headers: { 'User-Agent': 'RoseClient/1.0.0 (launcher)' } }, async res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return fetchToFile(new URL(res.headers.location, currentUrl).toString(), redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed (${res.statusCode}) for ${new URL(currentUrl).hostname}`));
      }
      const temp = `${destination}.download`;
      try {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await pipeline(res, require('fs').createWriteStream(temp));
        await fs.rm(destination, { force: true });
        await fs.rename(temp, destination);
        resolve(destination);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        reject(error);
      }
    }).on('error', reject);
  });
  return fetchToFile(url);
}

async function ensureRoseClientMod(instance) {
  if (!instance || !instance.gameDir) return { installed: false, supported: false, reason: 'No instance selected.' };
  const modsDir = path.join(instance.gameDir, 'mods');
  const compatibility = roseClientCompatibility(instance);
  await fs.mkdir(modsDir, { recursive: true });
  // Never leave a previous RoseClient build in place if the selected loader/version
  // does not have a matching artifact. That could crash Minecraft during mod loading.
  for (const oldName of [...Object.values(ROSECLIENT_ARTIFACTS), 'roseclient-mod.jar', 'roseclient-quilt-26.1.2.jar', 'roseclient-neoforge-26.1.2.jar', 'roseclient-forge-1.20.1.jar']) {
    if (!compatibility.supported || oldName !== compatibility.artifact) {
      await fs.rm(path.join(modsDir, oldName), { force: true }).catch(() => {});
    }
  }
  if (!compatibility.supported) return { installed: false, supported: false, reason: compatibility.reason };
  const bundled = bundledModFor(instance);
  const target = path.join(modsDir, compatibility.artifact);
  if (!bundled) return { installed: false, supported: false, reason: compatibility.reason };
  try { await fs.access(bundled); }
  catch {
    return { installed: false, supported: false, reason: `The ${compatibility.artifact} build is missing. Run BUILD-ROSECLIENT.bat and confirm the Fabric 26.1.2 build succeeds.` };
  }
  let needsCopy = false;
  try {
    const [srcStat, dstStat] = await Promise.all([fs.stat(bundled), fs.stat(target)]);
    needsCopy = srcStat.size !== dstStat.size || srcStat.mtimeMs > dstStat.mtimeMs;
  } catch { needsCopy = true; }
  if (needsCopy) await fs.copyFile(bundled, target);
  return { installed: true, supported: true, repaired: needsCopy, path: target, artifact: compatibility.artifact };
}

async function ensureFolders() {
  await fs.mkdir(INSTANCES_DIR, { recursive: true });
  await fs.mkdir(LOGIN_DIR, { recursive: true });
  try { await fs.access(SETTINGS_FILE); }
  catch { await fs.writeFile(SETTINGS_FILE, JSON.stringify({ selectedInstance: null }, null, 2)); }
  // Microsoft credentials are stored encrypted using Electron's OS-backed secure storage.
  await fs.writeFile(path.join(LOGIN_DIR, 'README.txt'),
    'RoseClient stores Microsoft refresh credentials encrypted with OS-backed secure storage. Do not share this folder.\n',
    { flag: 'w' });
}


async function saveAuthToken(minecraftToken) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable, so RoseClient cannot safely save this login.');
  const serialized = minecraftToken.mclc(true);
  await fs.writeFile(AUTH_TOKEN_FILE, safeStorage.encryptString(JSON.stringify(serialized)));
  await fs.writeFile(AUTH_PROFILE_FILE, JSON.stringify({
    username: minecraftToken.profile?.name || serialized?.name || 'Microsoft account',
    uuid: minecraftToken.profile?.id || serialized?.uuid || '',
    savedAt: new Date().toISOString()
  }, null, 2), 'utf8');
}
async function loadAuthToken() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try { return JSON.parse(safeStorage.decryptString(await fs.readFile(AUTH_TOKEN_FILE))); }
  catch { return null; }
}
async function clearSavedLogin() {
  await Promise.all([AUTH_TOKEN_FILE, AUTH_PROFILE_FILE].map(file => fs.rm(file, { force: true })));
}
async function getSavedAccountInfo() {
  try { return JSON.parse(await fs.readFile(AUTH_PROFILE_FILE, 'utf8')); } catch { return null; }
}
async function getMinecraftAuthToken() {
  const auth = new Auth('select_account');
  const saved = await loadAuthToken();
  if (saved && tokenUtils?.fromMclcToken) {
    try {
      let minecraftToken = tokenUtils.fromMclcToken(auth, saved);
      minecraftToken = await minecraftToken.refresh(false);
      if (!minecraftToken || !minecraftToken.validate()) throw new Error('Saved login is expired.');
      await saveAuthToken(minecraftToken);
      return minecraftToken;
    } catch (error) {
      console.warn('[RoseClient] Saved login could not be refreshed; requesting sign-in again:', error.message);
      await clearSavedLogin();
    }
  }
  const xboxManager = await auth.launch('electron');
  const minecraftToken = await xboxManager.getMinecraft();
  if (!minecraftToken || !minecraftToken.mclc) throw new Error('Microsoft sign-in did not return a Minecraft Java profile. Make sure this account owns Minecraft: Java Edition.');
  try { await saveAuthToken(minecraftToken); }
  catch (error) { console.warn('[RoseClient] Login succeeded but could not be saved securely:', error.message); }
  return minecraftToken;
}

async function getSettings() {
  try { return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')); }
  catch { return { selectedInstance: null }; }
}
async function saveSettings(settings) {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function installedManifestPath(instance) {
  return path.join(instance.gameDir, 'roseclient-installed-mods.json');
}
function normalizedFileKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
async function isModInstalled(instance, project) {
  const modsDir = path.join(instance.gameDir, 'mods');
  const key = String(project.projectId || '');
  try {
    const manifest = JSON.parse(await fs.readFile(installedManifestPath(instance), 'utf8'));
    const entry = manifest[key];
    if (entry && entry.filename) {
      try { await fs.access(path.join(modsDir, entry.filename)); return true; } catch {}
    }
  } catch {}
  // Best-effort detection for mods copied in manually: compare JAR names to the
  // Modrinth project ID, slug and title. Launcher-installed mods use the manifest above.
  let files = [];
  try { files = await fs.readdir(modsDir); } catch { return false; }
  const candidates = [key, project.slug, project.title].map(normalizedFileKey).filter(Boolean);
  return files.some(name => {
    if (!name.toLowerCase().endsWith('.jar')) return false;
    const base = normalizedFileKey(name.replace(/\.jar$/i, ''));
    return candidates.some(candidate => base === candidate || (candidate.length > 5 && base.includes(candidate)));
  });
}
async function writeInstalledManifest(instance, projectId, details) {
  const file = installedManifestPath(instance);
  let manifest = {};
  try { manifest = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  manifest[String(projectId)] = { ...details, installedAt: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(manifest, null, 2));
}


// Read a single small metadata file from a JAR (ZIP) without adding a native dependency.
function readZipEntry(jarBuffer, targetName) {
  const min = Math.max(0, jarBuffer.length - 65557);
  let eocd = -1;
  for (let i = jarBuffer.length - 22; i >= min; i--) {
    if (jarBuffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entryCount = jarBuffer.readUInt16LE(eocd + 10);
  let cursor = jarBuffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount && cursor + 46 <= jarBuffer.length; n++) {
    if (jarBuffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = jarBuffer.readUInt16LE(cursor + 10);
    const compressedSize = jarBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = jarBuffer.readUInt32LE(cursor + 24);
    const nameLength = jarBuffer.readUInt16LE(cursor + 28);
    const extraLength = jarBuffer.readUInt16LE(cursor + 30);
    const commentLength = jarBuffer.readUInt16LE(cursor + 32);
    const localOffset = jarBuffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const name = jarBuffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    if (name === targetName) {
      if (uncompressedSize > 2 * 1024 * 1024 || localOffset + 30 > jarBuffer.length) return null;
      if (jarBuffer.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const localNameLength = jarBuffer.readUInt16LE(localOffset + 26);
      const localExtraLength = jarBuffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = jarBuffer.subarray(dataStart, dataStart + compressedSize);
      try {
        if (method === 0) return compressed;
        if (method === 8) return inflateRawSync(compressed, { maxOutputLength: 2 * 1024 * 1024 });
      } catch { return null; }
      return null;
    }
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return null;
}

function stringField(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => typeof v === 'string' ? v : v?.name || '').filter(Boolean).join(', ');
  return '';
}

function metadataFromJar(jarBuffer, filename) {
  for (const metadataPath of ['fabric.mod.json', 'quilt.mod.json']) {
    const bytes = readZipEntry(jarBuffer, metadataPath);
    if (!bytes) continue;
    try {
      const json = JSON.parse(bytes.toString('utf8'));
      const quilt = metadataPath === 'quilt.mod.json';
      const loader = quilt ? (json.quilt_loader || {}) : json;
      const meta = quilt ? (loader.metadata || json.metadata || {}) : json;
      const id = loader.id || json.id || '';
      return {
        filename, id, name: meta.name || json.name || id || filename,
        version: String(loader.version || json.version || meta.version || 'unknown'),
        description: String(meta.description || json.description || ''),
        authors: stringField(meta.contributors || meta.authors || json.authors),
        environment: String(json.environment || '*'),
        metadata: metadataPath, detected: true
      };
    } catch {}
  }
  for (const metadataPath of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
    const bytes = readZipEntry(jarBuffer, metadataPath);
    if (!bytes) continue;
    const text = bytes.toString('utf8');
    const modId = text.match(/\bmodId\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    const name = text.match(/\bdisplayName\s*=\s*["']([^"']+)["']/i)?.[1] || modId || filename;
    const version = text.match(/\bversion\s*=\s*["']([^"']+)["']/i)?.[1] || 'unknown';
    const description = text.match(/\bdescription\s*=\s*["']([^"']*)["']/i)?.[1] || '';
    return { filename, id: modId, name, version, description, authors: '', environment: 'unknown', metadata: metadataPath, detected: true };
  }
  const legacy = readZipEntry(jarBuffer, 'mcmod.info');
  if (legacy) {
    try {
      const json = JSON.parse(legacy.toString('utf8'));
      const item = Array.isArray(json) ? json[0] : (json.modList || [])[0];
      if (item) return { filename, id: item.modid || '', name: item.name || item.modid || filename, version: String(item.version || 'unknown'), description: String(item.description || ''), authors: stringField(item.authorList || item.authors), environment: 'unknown', metadata: 'mcmod.info', detected: true };
    } catch {}
  }
  return { filename, id: '', name: filename.replace(/\.jar$/i, ''), version: 'unknown', description: 'No recognized mod metadata found in this JAR.', authors: '', environment: 'unknown', metadata: '', detected: false };
}

async function scanInstanceMods(instanceId) {
  const all = await listInstances();
  const instance = all.find(item => item.id === instanceId);
  if (!instance) throw new Error('Choose an instance first.');
  const modsDir = path.join(instance.gameDir, 'mods');
  await fs.mkdir(modsDir, { recursive: true });
  const entries = await fs.readdir(modsDir, { withFileTypes: true });
  const jarNames = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).map(entry => entry.name).sort((a,b) => a.localeCompare(b));
  const mods = [];
  for (const filename of jarNames) {
    const fullPath = path.join(modsDir, filename);
    try {
      const stat = await fs.stat(fullPath);
      const buffer = await fs.readFile(fullPath);
      mods.push({ ...metadataFromJar(buffer, filename), sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch (error) {
      mods.push({ filename, id: '', name: filename.replace(/\.jar$/i, ''), version: 'unknown', description: `Could not inspect this JAR: ${error.message}`, authors: '', environment: 'unknown', metadata: '', detected: false, sizeBytes: 0, modifiedAt: '' });
    }
  }
  return { instanceId, instanceName: instance.name, modsDir, totalJars: jarNames.length, mods };
}

async function listInstances() {
  await fs.mkdir(INSTANCES_DIR, { recursive: true });
  const names = await fs.readdir(INSTANCES_DIR, { withFileTypes: true });
  const result = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(INSTANCES_DIR, entry.name);
    let meta = {};
    try { meta = JSON.parse(await fs.readFile(path.join(dir, 'rose-instance.json'), 'utf8')); } catch {}
    const instanceInfo = {
      id: entry.name,
      name: meta.name || entry.name,
      minecraftVersion: meta.minecraftVersion || '26.1.2',
      loader: meta.loader || 'fabric',
      gameDir: dir
    };
    // Repair/restore RoseClient's own mod only when a matching built artifact exists.
    const roseStatus = await ensureRoseClientMod(instanceInfo);
    result.push({
      id: entry.name,
      name: meta.name || entry.name,
      minecraftVersion: meta.minecraftVersion || '26.1.2',
      loader: meta.loader || 'fabric',
      gameDir: dir,
      roseClientSupported: Boolean(roseStatus.supported),
      roseClientInstalled: Boolean(roseStatus.installed),
      roseClientReason: roseStatus.reason || ''
    });
  }
  return result;
}

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  dataDir: DATA_DIR,
  instancesDir: INSTANCES_DIR,
  loginDir: LOGIN_DIR,
  account: await getSavedAccountInfo()
}));
ipcMain.handle('auth:status', async () => ({ saved: Boolean(await loadAuthToken()), profile: await getSavedAccountInfo(), secureStorage: safeStorage.isEncryptionAvailable() }));
ipcMain.handle('auth:logout', async () => { await clearSavedLogin(); return { signedOut: true }; });

function readZipEntries(buffer, maxEntryBytes = 512 * 1024 * 1024) {
  const entries = new Map();
  const min = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not a valid ZIP/.mrpack file.');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && cursor + 46 <= buffer.length; n++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10), compressedSize = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28), extraLen = buffer.readUInt16LE(cursor + 30), commentLen = buffer.readUInt16LE(cursor + 32), localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    if (name && !name.endsWith('/')) {
      if (size > maxEntryBytes) throw new Error(`Archive entry is too large: ${name}`);
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid archive entry: ${name}`);
      const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      let bytes;
      if (method === 0) bytes = Buffer.from(compressed);
      else if (method === 8) bytes = inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
      else throw new Error(`Unsupported ZIP compression method for ${name}`);
      if (bytes.length !== size) throw new Error(`Corrupt archive entry: ${name}`);
      entries.set(name, bytes);
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function safeRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').some(part => part === '..' || part === '.')) return null;
  return normalized;
}
async function createImportedInstance(name, minecraftVersion, loader = 'fabric') {
  if (loader !== 'fabric') throw new Error(`This RoseClient build can import Fabric packs only; this pack uses ${loader}.`);
  if (!/^\d+\.\d+(\.\d+)?$/.test(String(minecraftVersion || ''))) throw new Error('The pack does not specify a valid Minecraft version.');
  const id = `${String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'imported'}-${Date.now().toString(36)}`;
  const dir = path.join(INSTANCES_DIR, id);
  await fs.mkdir(path.join(dir, 'mods'), { recursive: true });
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(path.join(dir, 'rose-instance.json'), JSON.stringify({ id, name: String(name).slice(0, 48), minecraftVersion: String(minecraftVersion), loader, createdAt: new Date().toISOString(), imported: true }, null, 2));
  const settings = await getSettings(); settings.selectedInstance = id; await saveSettings(settings);
  return { id, name: String(name).slice(0, 48), minecraftVersion: String(minecraftVersion), loader, gameDir: dir };
}
ipcMain.handle('instances:importMrpack', async () => {
  const picked = await dialog.showOpenDialog({ title: 'Import a Modrinth modpack', properties: ['openFile'], filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }, { name: 'ZIP archive', extensions: ['zip'] }] });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
  const packPath = picked.filePaths[0];
  const stat = await fs.stat(packPath);
  if (stat.size > 1024 * 1024 * 1024) throw new Error('The modpack archive is larger than 1 GB.');
  const entries = readZipEntries(await fs.readFile(packPath));
  const indexBytes = entries.get('modrinth.index.json');
  if (!indexBytes) throw new Error('This archive is missing modrinth.index.json. Choose a Modrinth .mrpack file.');
  const index = JSON.parse(indexBytes.toString('utf8'));
  if (index.formatVersion !== 1 || !index.dependencies?.minecraft) throw new Error('Unsupported or invalid Modrinth modpack manifest.');
  const dependencies = index.dependencies;
  if (dependencies['fabric-loader'] == null) throw new Error('This pack does not specify Fabric Loader. RoseClient currently supports Fabric packs only.');
  const instance = await createImportedInstance(index.name || path.basename(packPath, path.extname(packPath)), dependencies.minecraft, 'fabric');
  const base = path.resolve(instance.gameDir);
  try {
    for (const file of (index.files || [])) {
      if (file.env && file.env.client === 'unsupported') continue;
      const rel = safeRelativePath(file.path);
      if (!rel || !rel.startsWith('mods/')) continue;
      const dest = path.resolve(base, rel);
      if (!dest.startsWith(base + path.sep)) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      if (file.downloads?.length) {
        let lastError;
        for (const url of file.downloads) { try { await downloadFile(url, dest); lastError = null; break; } catch (e) { lastError = e; } }
        if (lastError) throw new Error(`Could not download ${path.basename(rel)}: ${lastError.message}`);
      } else if (file.path && Number.isFinite(file.fileSize) && file.fileSize === 0) {
        await fs.writeFile(dest, Buffer.alloc(0));
      }
    }
    for (const [archivePath, bytes] of entries) {
      if (!archivePath.startsWith('overrides/')) continue;
      const rel = safeRelativePath(archivePath.slice('overrides/'.length));
      if (!rel) continue;
      const dest = path.resolve(base, rel);
      if (!dest.startsWith(base + path.sep)) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, bytes);
    }
    await ensureRoseClientMod(instance);
  } catch (error) {
    console.error('Modpack import failed:', error);
    throw new Error(`Instance was created, but pack import did not finish: ${error.message}. You can remove the incomplete instance folder and try again.`);
  }
  console.info(`[Modrinth] Imported modpack “${instance.name}” with ${index.files?.length || 0} indexed files.`);
  return { canceled: false, instance };
});
ipcMain.handle('instances:importModrinthProfiles', async () => {
  const candidates = [
    path.join(app.getPath('appData'), 'com.modrinth.theseus', 'profiles'),
    path.join(app.getPath('appData'), 'ModrinthApp', 'profiles'),
    path.join(app.getPath('appData'), 'Modrinth', 'profiles')
  ];
  const found = [];
  for (const root of candidates) {
    try {
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const profileDir = path.join(root, entry.name);
        let profile = null;
        for (const file of ['profile.json', 'instance.json', 'mrpack.json']) {
          try { profile = JSON.parse(await fs.readFile(path.join(profileDir, file), 'utf8')); break; } catch {}
        }
        if (!profile) continue;
        const gameVersion = profile.gameVersion || profile.game_version || profile.minecraftVersion || profile.minecraft_version || profile.dependencies?.minecraft;
        const loaderValue = profile.loader || profile.modLoader || profile.mod_loader || (profile.dependencies?.['fabric-loader'] ? 'fabric' : 'unknown');
        const loader = String(loaderValue).toLowerCase();
        if (gameVersion && loader === 'fabric') found.push({ name: profile.name || entry.name, gameVersion: String(gameVersion), sourceDir: profileDir });
      }
    } catch {}
  }
  if (!found.length) return { imported: 0, message: 'No readable Fabric profiles were found in the common Modrinth App profile folders. Export a profile as .mrpack from Modrinth and use Import .mrpack instead.' };
  let imported = 0;
  for (const profile of found) {
    const instance = await createImportedInstance(profile.name, profile.gameVersion, 'fabric');
    for (const folder of ['mods', 'config', 'resourcepacks', 'shaderpacks', 'options.txt']) {
      const src = path.join(profile.sourceDir, folder);
      const dst = path.join(instance.gameDir, folder);
      try {
        const st = await fs.stat(src);
        if (st.isDirectory()) await fs.cp(src, dst, { recursive: true, force: true });
        else if (st.isFile()) await fs.copyFile(src, dst);
      } catch {}
    }
    await ensureRoseClientMod(instance);
    imported++;
  }
  return { imported, message: `Imported ${imported} readable Fabric profile(s).` };
});

ipcMain.handle('instances:list', listInstances);

ipcMain.handle('instances:create', async (_event, input) => {
  const name = String(input?.name || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').slice(0, 48);
  const minecraftVersion = String(input?.minecraftVersion || '26.1.2').trim();
  const loader = String(input?.loader || 'fabric').toLowerCase();
  if (!name) throw new Error('Enter an instance name.');
  if (!/^\d+\.\d+(\.\d+)?$/.test(minecraftVersion)) throw new Error('Invalid Minecraft version.');
  if (loader !== 'fabric') throw new Error('RoseClient supports Fabric instances only. Select Fabric to create this instance.');
  const id = `${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${Date.now().toString(36)}`;
  const dir = path.join(INSTANCES_DIR, id);
  await fs.mkdir(path.join(dir, 'mods'), { recursive: true });
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  // Always bundle the RoseClient in-game mod into each new instance when built.
  try {
    const bundled = bundledModFor({ minecraftVersion, loader });
    if (!bundled) throw new Error('No compatible RoseClient artifact is registered.');
    await fs.access(bundled);
    await fs.copyFile(bundled, path.join(dir, 'mods', path.basename(bundled)));
  } catch {
    // In development before BUILD-ROSECLIENT.bat runs, the mod may not exist yet.
  }
  await fs.writeFile(path.join(dir, 'rose-instance.json'), JSON.stringify({
    id, name, minecraftVersion, loader, createdAt: new Date().toISOString()
  }, null, 2));
  const settings = await getSettings();
  settings.selectedInstance = id;
  await saveSettings(settings);
  return { id, name, minecraftVersion, loader, gameDir: dir };
});

ipcMain.handle('instances:repairRoseMod', async (_event, id) => {
  const all = await listInstances();
  const instance = all.find(x => x.id === id);
  if (!instance) throw new Error('Instance not found.');
  return ensureRoseClientMod(instance);
});

ipcMain.handle('instances:select', async (_event, id) => {
  const all = await listInstances();
  if (!all.some(x => x.id === id)) throw new Error('Instance not found.');
  const settings = await getSettings();
  settings.selectedInstance = id;
  await saveSettings(settings);
  return { selectedInstance: id };
});

ipcMain.handle('mods:list', async (_event, instanceId) => scanInstanceMods(instanceId));

ipcMain.handle('modrinth:search', async (_event, query) => {
  const q = String(query?.query || '').trim();
  const version = String(query?.minecraftVersion || '26.1.2');
  const loader = String(query?.loader || 'fabric').toLowerCase();
  const facets = [
    ['project_type:mod'],
    [`versions:${version}`],
    [`categories:${loader}`]
  ];
  const params = new URLSearchParams({
    query: q,
    limit: '24',
    index: 'relevance',
    facets: JSON.stringify(facets)
  });
  const data = await requestJson(`https://api.modrinth.com/v2/search?${params}`);
  const instance = query?.instanceId ? (await listInstances()).find(x => x.id === query.instanceId) : null;
  return Promise.all((data.hits || []).map(async hit => {
    const project = {
      projectId: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      iconUrl: hit.icon_url,
      downloads: hit.downloads,
      follows: hit.follows,
      categories: hit.categories || [],
      latestVersion: hit.latest_version
    };
    project.installed = instance ? await isModInstalled(instance, project) : false;
    return project;
  }));
});

async function findCompatibleModVersion(instance, projectId) {
  const params = new URLSearchParams({
    game_versions: JSON.stringify([instance.minecraftVersion]),
    loaders: JSON.stringify([instance.loader])
  });
  const versions = await requestJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?${params}`);
  return versions.find(v => (v.files || []).some(f => String(f.filename || f.url).toLowerCase().split('?')[0].endsWith('.jar')))
    || null;
}

async function installModVersion(instance, projectId, version, seen = new Set()) {
  const id = String(projectId || version.project_id || '');
  if (!id) throw new Error(`Modrinth returned a version without a project ID (${version.name || version.id || 'unknown mod'}).`);
  if (seen.has(id)) return [];
  seen.add(id);

  if (!(version.game_versions || []).includes(instance.minecraftVersion) || !(version.loaders || []).includes(instance.loader)) {
    throw new Error(`A required dependency (${version.name || id}) has no compatible ${instance.loader} build for Minecraft ${instance.minecraftVersion}.`);
  }

  const installedFiles = [];
  for (const dependency of (version.dependencies || []).filter(d => d.dependency_type === 'required')) {
    let depVersion = null;
    let depProjectId = dependency.project_id || null;
    if (dependency.version_id) {
      depVersion = await requestJson(`https://api.modrinth.com/v2/version/${encodeURIComponent(dependency.version_id)}`);
      depProjectId = depProjectId || depVersion.project_id;
    } else if (depProjectId) {
      depVersion = await findCompatibleModVersion(instance, depProjectId);
    }
    if (!depVersion || !depProjectId) {
      throw new Error(`Could not find a compatible required dependency for ${version.name || id}.`);
    }
    if (!await isModInstalled(instance, { projectId: depProjectId })) {
      installedFiles.push(...await installModVersion(instance, depProjectId, depVersion, seen));
    }
  }

  const jarFile = (version.files || []).find(f => String(f.filename || f.url).toLowerCase().split('?')[0].endsWith('.jar'));
  if (!jarFile) throw new Error(`No JAR file was available for ${version.name || id}.`);
  const modsDir = path.join(instance.gameDir, 'mods');
  await fs.mkdir(modsDir, { recursive: true });
  const safeName = path.basename(jarFile.filename || `${id}.jar`).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const destination = path.join(modsDir, safeName);
  await downloadFile(jarFile.url, destination);
  await writeInstalledManifest(instance, id, {
    filename: safeName,
    version: version.version_number,
    project: version.name || id
  });
  installedFiles.push({ filename: safeName, path: destination, version: version.version_number, project: version.name || id });
  return installedFiles;
}

ipcMain.handle('modrinth:install', async (_event, input) => {
  const { projectId, instanceId } = input || {};
  if (!projectId) throw new Error('Choose a Modrinth mod to install.');
  const all = await listInstances();
  const instance = all.find(x => x.id === instanceId);
  if (!instance) throw new Error('Choose an instance first.');
  await ensureRoseClientMod(instance);
  if (await isModInstalled(instance, { projectId })) throw new Error('This mod is already installed in the selected instance.');

  const compatible = await findCompatibleModVersion(instance, projectId);
  if (!compatible) {
    throw new Error(`No compatible ${instance.loader} build was found for Minecraft ${instance.minecraftVersion}.`);
  }
  const installed = await installModVersion(instance, projectId, compatible);
  const primary = installed.find(f => f.project === compatible.name) || installed[installed.length - 1];
  return {
    filename: primary?.filename || compatible.name,
    path: primary?.path || instance.gameDir,
    version: compatible.version_number,
    project: compatible.name,
    installedCount: installed.length,
    installedFiles: installed.map(f => f.filename)
  };
});

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Installer exited with code ${code}. ${stderr.slice(-1500)}`)));
  });
}

async function findJava() {
  const isWindows = process.platform === 'win32';
  const javaExe = isWindows ? 'java.exe' : 'java';
  const candidates = [];
  const addCandidate = value => {
    if (!value) return;
    const clean = String(value).trim().replace(/^"|"$/g, '');
    if (!clean) return;
    candidates.push(clean);
  };

  // Prefer JAVA_HOME, but do not trust it blindly: it may point at an older JRE.
  if (process.env.JAVA_HOME) addCandidate(path.join(process.env.JAVA_HOME.replace(/^"|"$/g, ''), 'bin', javaExe));

  // Discover every Java executable visible on PATH (Windows can have multiple).
  if (isWindows) {
    try {
      const whereOutput = await new Promise(resolve => {
        const child = spawn('where.exe', ['java'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        child.stdout?.on('data', chunk => output += chunk.toString());
        child.once('error', () => resolve(''));
        child.once('close', () => resolve(output));
      });
      for (const line of whereOutput.split(/\r?\n/)) addCandidate(line);
    } catch {}

    // Check common vendor install roots, including versioned JDK 25 directories.
    for (const root of [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eclipse Adoptium'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Java')
    ]) {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries) if (entry.isDirectory()) addCandidate(path.join(root, entry.name, 'bin', javaExe));
      } catch {}
    }
  }
  addCandidate('java');

  const checked = new Set();
  const rejected = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (checked.has(key)) continue;
    checked.add(key);
    try {
      const versionText = await new Promise((resolve, reject) => {
        const child = spawn(candidate, ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout?.on('data', chunk => output += chunk.toString());
        child.stderr?.on('data', chunk => output += chunk.toString());
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`exit code ${code}`)));
      });
      // Oracle Java prints `java version "25.0.4.1"`; OpenJDK commonly prints
      // `openjdk version "25..."`. Match the version token rather than the first number.
      const match = versionText.match(/\bversion\s+["']?(\d+)/i)
        || versionText.match(/\bopenjdk\s+(\d+)/i);
      const major = match ? Number(match[1]) : 0;
      if (major >= 25) return candidate;
      rejected.push(`${candidate}: detected Java ${major || 'unknown'}`);
    } catch (error) {
      rejected.push(`${candidate}: could not run (${error.message})`);
    }
  }
  throw new Error(`RoseClient needs Java 25 or newer for Minecraft 26.1.2, but could not find a compatible runtime. Your Command Prompt may use a different Java than RoseClient. Detected candidates: ${rejected.slice(0, 5).join('; ') || 'none'}. Set JAVA_HOME to your Java 25 JDK folder (the folder containing bin\\java.exe), then fully close and reopen RoseClient.`);
}

async function installFabricForInstance(instance) {
  if (String(instance.loader).toLowerCase() !== 'fabric') {
    throw new Error(`Direct launching currently supports Fabric instances only. This instance uses ${instance.loader}; create a Fabric instance to launch it from RoseClient.`);
  }
  const java = await findJava();
  const minecraftVersion = String(instance.minecraftVersion);
  const loaderVersions = await requestJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraftVersion)}`);
  if (!Array.isArray(loaderVersions) || !loaderVersions.length) {
    throw new Error(`Fabric does not currently list a loader for Minecraft ${minecraftVersion}.`);
  }
  const loaderVersion = (loaderVersions.find(v => v.loader?.stable) || loaderVersions[0])?.loader?.version;
  if (!loaderVersion) throw new Error('Could not determine a compatible Fabric Loader version.');

  // Use Fabric's version-profile metadata directly instead of running the Fabric
  // Installer CLI. The CLI expects a normal Mojang launcher_profiles.json file,
  // which isolated RoseClient instances intentionally do not have.
  const profileId = `fabric-loader-${loaderVersion}-${minecraftVersion}`;
  const versionsDir = path.join(instance.gameDir, 'versions', profileId);
  const profileFile = path.join(versionsDir, `${profileId}.json`);
  let profileIsValid = false;
  try {
    const existing = JSON.parse(await fs.readFile(profileFile, 'utf8'));
    profileIsValid = existing.id === profileId && existing.inheritsFrom === minecraftVersion && Array.isArray(existing.libraries);
  } catch {}

  let installed = false;
  if (!profileIsValid) {
    const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraftVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
    const profile = await requestJson(profileUrl);
    if (!profile || !Array.isArray(profile.libraries) || profile.inheritsFrom !== minecraftVersion) {
      throw new Error(`Fabric returned an invalid launcher profile for Minecraft ${minecraftVersion}.`);
    }
    // Keep the canonical ID so minecraft-launcher-core can select it with `custom`.
    profile.id = profileId;
    await fs.mkdir(versionsDir, { recursive: true });
    const tempProfile = `${profileFile}.tmp`;
    await fs.writeFile(tempProfile, JSON.stringify(profile, null, 2), 'utf8');
    await fs.rename(tempProfile, profileFile);
    installed = true;
  }
  return { java, profileId, loaderVersion, installed };
}

ipcMain.handle('game:start', async (_event, instanceId) => {
  // Open the cute live console only when the user explicitly starts a Minecraft instance.
  createLogWindow();
  console.info(`[Minecraft] Start requested for instance ${instanceId}.`);
  const previous = launchRecords.get(instanceId);
  if (previous && ['preparing', 'authenticating', 'starting', 'running', 'stopping'].includes(previous.state)) {
    throw new Error(`This instance is already ${previous.state}.`);
  }
  if (activeLaunchInstanceId && [...launchRecords.values()].some(r => r.instanceId !== instanceId && ['preparing', 'authenticating', 'starting', 'running', 'stopping'].includes(r.state))) {
    throw new Error('Another Minecraft instance is already launching or running. Stop it before starting a different instance.');
  }
  const record = { instanceId, state: 'preparing', message: 'Preparing the instance…', child: null, pid: null, cancelRequested: false, startedAt: Date.now(), endedAt: null };
  launchRecords.set(instanceId, record);
  startingInstances.add(instanceId);
  try {
    const all = await listInstances();
    const instance = all.find(x => x.id === instanceId);
    if (!instance) throw new Error('Choose an instance first.');
    if (String(instance.loader).toLowerCase() !== 'fabric') {
      throw new Error(`Direct launch currently supports Fabric only. This instance uses ${instance.loader}.`);
    }
    const clientMod = await ensureRoseClientMod(instance);
    if (!clientMod.installed) throw new Error(clientMod.reason || 'RoseClient mod could not be installed into this instance.');
    if (record.cancelRequested) throw new Error('Launch cancelled.');

    record.message = 'Checking Java and preparing Fabric…';
    const setup = await installFabricForInstance(instance);
    if (record.cancelRequested) throw new Error('Launch cancelled.');
    record.state = 'authenticating';
    record.message = 'Checking saved Microsoft login…';
    const token = await getMinecraftAuthToken();
    if (!token || !token.mclc) throw new Error('Microsoft sign-in did not return a Minecraft Java profile. Make sure this account owns Minecraft: Java Edition.');
    if (record.cancelRequested) throw new Error('Launch cancelled.');

    const launcher = new MinecraftLauncher();
    record.launcher = launcher;
    launcher.on('debug', message => console.log('[RoseClient/Minecraft]', String(message)));
    launcher.on('data', message => {
      console.log('[RoseClient/Minecraft]', String(message));
      if (record.state === 'starting' && !record.cancelRequested) {
        record.state = 'running';
        record.message = 'Minecraft process is running.';
        record.lastOutputAt = Date.now();
      }
    });
    launcher.on('close', code => console.log(`[RoseClient] Minecraft process exited with code ${code}`));
    const memoryMax = String((await getSettings()).memoryMax || '4G');
    const memoryMin = String((await getSettings()).memoryMin || '1G');
    if (record.cancelRequested) throw new Error('Launch cancelled.');
    activeLaunchInstanceId = instanceId;
    record.state = 'starting';
    record.message = 'Starting Java and Minecraft…';
    await launcher.launch({
      authorization: token.mclc(),
      root: instance.gameDir,
      version: { number: instance.minecraftVersion, type: 'release', custom: setup.profileId },
      memory: { max: memoryMax, min: memoryMin },
      javaPath: setup.java
    });
    // A resolved launcher call is not enough by itself: verify a real Java child exists.
    if (!record.child || !record.pid) {
      throw new Error('The launcher finished its setup but did not create a Java process. Check the Minecraft launch log for the underlying error.');
    }
    if (record.cancelRequested) {
      try { record.child.kill(); } catch {}
      record.state = 'stopping';
      record.message = 'Stopping Minecraft…';
      return { opened: false, message: 'Launch was cancelled.' };
    }
    record.state = 'running';
    record.message = `Minecraft is running (PID ${record.pid}).`;
    return {
      opened: true,
      pid: record.pid,
      message: `Minecraft started for ${instance.name} (PID ${record.pid}) with Fabric ${setup.loaderVersion} and this instance's mods. ${setup.installed ? 'Fabric was installed. ' : ''}First launch downloads may take a few minutes.`
    };
  } catch (error) {
    record.state = record.cancelRequested ? 'stopped' : 'failed';
    record.message = record.cancelRequested ? 'Launch cancelled.' : error.message;
    record.error = record.cancelRequested ? null : error.message;
    if (!record.cancelRequested) throw new Error(`Could not launch this instance: ${error.message}`);
    return { opened: false, message: 'Launch cancelled.' };
  } finally {
    startingInstances.delete(instanceId);
    if (activeLaunchInstanceId === instanceId) activeLaunchInstanceId = null;
  }
});

ipcMain.handle('game:status', async (_event, instanceId) => {
  const record = launchRecords.get(instanceId);
  if (!record) return { instanceId, state: 'stopped', message: 'Minecraft is not running.', running: false, canStop: false };
  if (record.child && record.child.exitCode == null && !record.child.killed && record.state === 'starting' && Date.now() - record.startedAt > 15000) {
    record.state = 'running';
    record.message = `Minecraft Java process is alive (PID ${record.pid}).`;
  }
  const running = Boolean(record.child && record.child.exitCode == null && !record.child.killed);
  return { instanceId, state: record.state, message: record.message, pid: record.pid, running, canStop: running || ['preparing', 'authenticating', 'starting'].includes(record.state), error: record.error || null };
});

ipcMain.handle('game:stop', async (_event, instanceId) => {
  const record = launchRecords.get(instanceId);
  if (!record || !['preparing', 'authenticating', 'starting', 'running', 'stopping'].includes(record.state)) {
    return { stopped: false, message: 'Minecraft is not starting or running for this instance.' };
  }
  record.cancelRequested = true;
  record.state = 'stopping';
  record.message = record.child ? 'Stopping Minecraft…' : 'Cancelling launch; waiting for any starting process…';
  if (record.child && record.child.exitCode == null) {
    const child = record.child;
    try { child.kill(); } catch {}
    if (process.platform === 'win32' && child.pid) {
      // Kill the process tree as well, so child Java processes do not remain behind.
      await new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', resolve);
        killer.once('close', resolve);
        setTimeout(resolve, 3000).unref();
      });
    }
  }
  return { stopped: true, message: record.message };
});

ipcMain.handle('logs:get', async () => logBuffer.slice(-1200));
ipcMain.handle('logs:clear', async () => {
  logBuffer.length = 0;
  await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
  await fs.writeFile(LOG_FILE, '', 'utf8');
  if (logWindow && !logWindow.isDestroyed()) logWindow.webContents.send('logs:cleared');
  return { cleared: true };
});
ipcMain.handle('logs:openFile', async () => shell.openPath(LOG_FILE));

ipcMain.handle('shell:openPath', async (_event, target) => {
  const allowed = [DATA_DIR, INSTANCES_DIR, LOGIN_DIR];
  const resolved = path.resolve(String(target || ''));
  if (!allowed.some(p => resolved === p || resolved.startsWith(p + path.sep))) throw new Error('Path is not allowed.');
  return shell.openPath(resolved);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 620,
    backgroundColor: '#120e15',
    title: 'RoseClient',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

function createLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) { logWindow.show(); logWindow.focus(); return logWindow; }
  logWindow = new BrowserWindow({
    width: 760, height: 640, minWidth: 560, minHeight: 420,
    title: 'RoseClient · Console', backgroundColor: '#140f18',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  logWindow.loadFile(path.join(__dirname, 'logs.html'));
  logWindow.on('closed', () => { logWindow = null; });
  return logWindow;
}

app.whenReady().then(async () => {
  await ensureFolders();
  createWindow();
  console.info('[RoseClient] Launcher initialized. The live console opens when Minecraft is started.');
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });