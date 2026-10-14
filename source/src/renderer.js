const $ = id => document.getElementById(id);
let appInfo = null;
let instances = [];
let selectedPage = 'home';
const gameStatuses = new Map();
let statusPollTimer = null;

function showNotice(message, type = 'info') {
  const n = $('notice');
  n.textContent = message;
  n.className = `notice ${type}`;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => n.classList.add('hidden'), 6500);
}
function setPage(page) {
  selectedPage = page;
  document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
  $(`${page}Page`).classList.remove('hidden');
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  const titles = { home: 'Welcome to RoseClient', instances: 'Manage instances', mods: 'Modrinth mod browser', settings: 'Settings & folders' };
  $('pageTitle').textContent = titles[page];
  if (page === 'mods') { searchMods(); scanInstalledMods(); }
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function activeInstance() {
  const id = $('targetInstance').value;
  return instances.find(i => i.id === id) || instances[0] || null;
}
async function loadInstances() {
  instances = await window.rose.listInstances();
  $('instanceCount').textContent = instances.length;
  renderInstances();
  const old = $('targetInstance').value;
  $('targetInstance').innerHTML = instances.map(i => `<option value="${esc(i.id)}">${esc(i.name)} · ${esc(i.minecraftVersion)} · ${esc(i.loader)}</option>`).join('');
  if (instances.some(i => i.id === old)) $('targetInstance').value = old;
  if (!instances.length) $('targetInstance').innerHTML = '<option value="">Create an instance first</option>';
  updateCompatLabel();
  if (selectedPage === 'mods') scanInstalledMods();
}
function renderInstances() {
  $('instancesList').innerHTML = instances.map(i => `<article class="instance-card">
    <div class="instance-mark">✿</div>
    <div class="instance-main"><h4>${esc(i.name)}</h4><p>Minecraft ${esc(i.minecraftVersion)} · ${esc(i.loader)}</p><code title="${esc(i.gameDir)}">${esc(i.gameDir)}</code></div>
    <div class="instance-actions">
      <button class="ghost repair-instance" data-id="${esc(i.id)}">Repair client mod</button>
      <button class="ghost view-mods-instance" data-id="${esc(i.id)}">View mods</button>
      <button class="ghost select-instance" data-id="${esc(i.id)}">Use instance</button>
      <button class="primary start-instance" data-id="${esc(i.id)}">▶ Start Minecraft</button>
      <button class="danger stop-instance" data-id="${esc(i.id)}" disabled>■ Stop</button>
    </div>
    <div class="instance-game-status" id="gameStatus-${esc(i.id)}" role="status">Checking game status…</div></article>`).join('');
  $('instancesEmpty').classList.toggle('hidden', instances.length > 0);
  $('instancesList').classList.toggle('hidden', instances.length === 0);
  document.querySelectorAll('.view-mods-instance').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await window.rose.selectInstance(btn.dataset.id);
      $('targetInstance').value = btn.dataset.id;
      updateCompatLabel();
      setPage('mods');
      showNotice('Scanning the selected instance’s mods folder.', 'info');
    } catch (e) { showNotice(e.message, 'error'); }
  }));
  document.querySelectorAll('.select-instance').forEach(btn => btn.addEventListener('click', async () => {
    try { await window.rose.selectInstance(btn.dataset.id); $('targetInstance').value = btn.dataset.id; updateCompatLabel(); showNotice('Active instance updated.', 'success'); }
    catch (e) { showNotice(e.message, 'error'); }
  }));
  document.querySelectorAll('.repair-instance').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const result = await window.rose.repairRoseMod(btn.dataset.id);
      showNotice(result.installed ? (result.repaired ? 'RoseClient mod restored.' : 'RoseClient mod is already installed.') : result.reason, result.installed ? 'success' : 'error');
    } catch (e) { showNotice(e.message, 'error'); }
    finally { btn.disabled = false; }
  }));
  document.querySelectorAll('.start-instance').forEach(btn => btn.addEventListener('click', () => startInstance(btn.dataset.id, btn)));
  document.querySelectorAll('.stop-instance').forEach(btn => btn.addEventListener('click', () => stopInstance(btn.dataset.id, btn)));
  refreshGameStatuses();
}
async function startInstance(instanceId, button = null) {
  const targetButton = button;
  if (targetButton) { targetButton.disabled = true; targetButton.textContent = 'Preparing…'; }
  const poll = setInterval(() => refreshGameStatuses(), 800);
  try {
    const result = await window.rose.startGame(instanceId);
    showNotice(result.message, result.opened ? 'success' : 'info');
  } catch (e) {
    showNotice(e.message, 'error');
  } finally {
    clearInterval(poll);
    await refreshGameStatuses();
    if (targetButton) targetButton.textContent = '▶ Start Minecraft';
  }
}
async function stopInstance(instanceId, button = null) {
  if (button) { button.disabled = true; button.textContent = 'Stopping…'; }
  try {
    const result = await window.rose.stopGame(instanceId);
    showNotice(result.message, result.stopped ? 'info' : 'error');
  } catch (e) { showNotice(`Could not stop Minecraft: ${e.message}`, 'error'); }
  await refreshGameStatuses();
}
async function refreshGameStatuses() {
  if (!instances.length) {
    $('heroStop').disabled = true;
    $('heroGameStatus').textContent = 'Minecraft is not running.';
    return;
  }
  await Promise.all(instances.map(async instance => {
    try {
      const status = await window.rose.gameStatus(instance.id);
      gameStatuses.set(instance.id, status);
      const active = ['preparing', 'authenticating', 'starting', 'running', 'stopping'].includes(status.state);
      const startButtons = [...document.querySelectorAll('.start-instance')].filter(b => b.dataset.id === instance.id);
      const stopButtons = [...document.querySelectorAll('.stop-instance')].filter(b => b.dataset.id === instance.id);
      for (const b of startButtons) {
        b.disabled = active;
        if (!b.matches(':focus')) b.textContent = status.state === 'preparing' ? 'Preparing…' : status.state === 'authenticating' ? 'Waiting for sign-in…' : status.state === 'starting' ? 'Starting…' : status.state === 'running' ? 'Minecraft Running' : '▶ Start Minecraft';
      }
      for (const b of stopButtons) {
        b.disabled = !active;
        b.textContent = status.state === 'stopping' ? 'Stopping…' : '■ Stop';
      }
      const line = document.getElementById(`gameStatus-${instance.id}`);
      if (line) {
        line.textContent = `${status.state.toUpperCase()} · ${status.message || ''}${status.pid ? ` · PID ${status.pid}` : ''}`;
        line.dataset.state = status.state;
      }
    } catch (error) { console.warn('Could not read game status', error); }
  }));
  const chosen = activeInstance();
  const heroStatus = chosen ? gameStatuses.get(chosen.id) : null;
  const active = heroStatus && ['preparing', 'authenticating', 'starting', 'running', 'stopping'].includes(heroStatus.state);
  $('heroStop').disabled = !active || heroStatus.state === 'stopping';
  $('heroStop').textContent = heroStatus?.state === 'stopping' ? 'Stopping…' : '■ Stop Minecraft';
  $('heroStart').disabled = Boolean(active);
  $('heroStart').textContent = heroStatus?.state === 'preparing' ? 'Preparing…' : heroStatus?.state === 'authenticating' ? 'Waiting for sign-in…' : heroStatus?.state === 'starting' ? 'Starting…' : heroStatus?.state === 'running' ? 'Minecraft Running' : '▶ Start Minecraft';
  $('heroGameStatus').textContent = heroStatus?.message || 'Minecraft is not running.';
  $('heroGameStatus').dataset.state = heroStatus?.state || 'stopped';
}
function updateCompatLabel() {
  const i = activeInstance();
  $('compatLabel').textContent = i ? `Minecraft ${i.minecraftVersion} · ${i.loader}` : 'Create an instance to install mods';
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Size unknown';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
async function scanInstalledMods() {
  const instance = activeInstance();
  const grid = $('installedModsGrid');
  const empty = $('installedModsEmpty');
  if (!instance) {
    $('installedModsCount').textContent = '0';
    $('installedModsPath').textContent = 'Create an instance to scan its mods folder.';
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  grid.innerHTML = '<div class="loading">Scanning JAR files and reading mod metadata…</div>';
  empty.classList.add('hidden');
  try {
    const result = await window.rose.listMods(instance.id);
    $('installedModsCount').textContent = result.totalJars;
    $('installedModsPath').textContent = result.modsDir;
    if (!result.mods.length) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    grid.innerHTML = result.mods.map(mod => `<article class="installed-mod-card">
      <div class="installed-mod-icon">${mod.detected ? '✓' : '?'}</div>
      <div class="installed-mod-content"><div class="installed-mod-title"><h4>${esc(mod.name)}</h4><span class="mod-version">${esc(mod.version || 'unknown')}</span></div>
      <p>${esc(mod.description || 'No description in mod metadata.')}</p>
      <div class="installed-mod-meta"><span>ID: ${esc(mod.id || 'not detected')}</span><span>${esc(formatBytes(mod.sizeBytes))}</span><span>${mod.detected ? `Metadata: ${esc(mod.metadata)}` : 'Metadata not recognized'}</span></div>
      <code title="${esc(mod.filename)}">${esc(mod.filename)}</code></div>
    </article>`).join('');
  } catch (error) {
    grid.innerHTML = '';
    showNotice(`Could not scan this mods folder: ${error.message}`, 'error');
  }
}

async function searchMods() {
  const instance = activeInstance();
  if (!instance) {
    $('modsGrid').innerHTML = '';
    $('modsEmpty').classList.remove('hidden');
    $('modsEmpty').querySelector('h3').textContent = 'Create an instance first';
    $('modsEmpty').querySelector('p').textContent = 'Modrinth results are filtered by your selected instance.';
    return;
  }
  const query = $('modSearch').value.trim();
  $('modsGrid').innerHTML = '<div class="loading">Searching Modrinth…</div>';
  $('modsEmpty').classList.add('hidden');
  updateCompatLabel();
  try {
    const mods = await window.rose.searchMods({ query, minecraftVersion: instance.minecraftVersion, loader: instance.loader, instanceId: instance.id });
    if (!mods.length) {
      $('modsGrid').innerHTML = '';
      $('modsEmpty').classList.remove('hidden');
      $('modsEmpty').querySelector('h3').textContent = 'No matching mods found';
      $('modsEmpty').querySelector('p').textContent = 'Try another search or check the selected version and loader.';
      return;
    }
    $('modsGrid').innerHTML = mods.map(m => `<article class="mod-card">
      <div class="mod-top">${m.iconUrl ? `<img class="mod-icon" src="${esc(m.iconUrl)}" alt="">` : '<div class="mod-icon fallback">✧</div>'}<div class="mod-title"><h4>${esc(m.title)}</h4><span>${Number(m.downloads || 0).toLocaleString()} downloads</span></div></div>
      <p>${esc(m.description || 'No description provided.')}</p><div class="mod-bottom"><span class="tag">Modrinth</span><button class="primary install-btn ${m.installed ? 'installed' : ''}" data-project="${esc(m.projectId)}" data-slug="${esc(m.slug)}" data-title="${esc(m.title)}" ${m.installed ? 'disabled' : ''}>${m.installed ? 'Installed ✓' : 'Install'}</button></div>
    </article>`).join('');
    document.querySelectorAll('.install-btn').forEach(btn => btn.addEventListener('click', async () => {
      const inst = activeInstance();
      if (!inst) return showNotice('Create an instance first.', 'error');
      btn.disabled = true; btn.textContent = 'Installing…';
      try {
        const result = await window.rose.installMod({ projectId: btn.dataset.project, instanceId: inst.id });
        btn.textContent = 'Installed ✓'; btn.classList.add('installed');
        showNotice(`Installed ${result.project || result.filename} and ${Math.max(0, (result.installedCount || 1) - 1)} required dependency/dependencies into ${inst.name}.`, 'success');
        scanInstalledMods();
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Install';
        showNotice(e.message, 'error');
      }
    }));
  } catch (e) {
    $('modsGrid').innerHTML = '';
    showNotice(`Could not reach Modrinth: ${e.message}`, 'error');
  }
}
async function init() {
  try {
    appInfo = await window.rose.appInfo();
    $('dataPath').textContent = appInfo.dataDir;
    $('instancesPath').textContent = appInfo.instancesDir;
    $('loginPath').textContent = appInfo.loginDir;
    await refreshAccountStatus();
    await loadInstances();
    if (statusPollTimer) clearInterval(statusPollTimer);
    statusPollTimer = setInterval(refreshGameStatuses, 1500);
  } catch (e) { showNotice(`Startup error: ${e.message}`, 'error'); }
}
document.querySelectorAll('.nav').forEach(b => b.addEventListener('click', () => setPage(b.dataset.page)));
$('heroBrowse').addEventListener('click', () => setPage('mods'));
$('heroStop').addEventListener('click', async () => {
  const instance = activeInstance();
  if (!instance) return;
  await stopInstance(instance.id, $('heroStop'));
});
$('heroStart').addEventListener('click', async () => {
  const instance = activeInstance();
  if (!instance) { setPage('instances'); showNotice('Create a Fabric instance first, then press Start Minecraft.', 'info'); return; }
  await startInstance(instance.id, $('heroStart'));
});
$('refreshBtn').addEventListener('click', async () => { await loadInstances(); if (selectedPage === 'mods') searchMods(); showNotice('RoseClient refreshed.', 'success'); });
$('searchBtn').addEventListener('click', searchMods);
$('modSearch').addEventListener('keydown', e => { if (e.key === 'Enter') searchMods(); });
$('targetInstance').addEventListener('change', () => { updateCompatLabel(); searchMods(); scanInstalledMods(); });
$('refreshInstalledMods').addEventListener('click', scanInstalledMods);
$('importMrpackBtn').addEventListener('click', async () => {
  const button = $('importMrpackBtn'); button.disabled = true; button.textContent = 'Importing pack…';
  try {
    const result = await window.rose.importMrpack();
    if (result.canceled) return;
    await loadInstances(); $('targetInstance').value = result.instance.id; updateCompatLabel();
    showNotice(`Imported “${result.instance.name}”. Its Fabric mods and overrides are ready in the new instance.`, 'success');
    setPage('instances');
  } catch (error) { showNotice(`Could not import modpack: ${error.message}`, 'error'); }
  finally { button.disabled = false; button.textContent = '✿ Import .mrpack'; }
});
$('importModrinthProfilesBtn').addEventListener('click', async () => {
  const button = $('importModrinthProfilesBtn'); button.disabled = true; button.textContent = 'Looking for profiles…';
  try {
    const result = await window.rose.importModrinthProfiles();
    await loadInstances();
    showNotice(result.message, result.imported ? 'success' : 'info');
  } catch (error) { showNotice(`Could not import Modrinth profiles: ${error.message}`, 'error'); }
  finally { button.disabled = false; button.textContent = '↗ Import Modrinth instances'; }
});
$('createInstanceBtn').addEventListener('click', () => $('instanceDialog').showModal());
$('emptyCreateBtn').addEventListener('click', () => $('instanceDialog').showModal());
$('instanceForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const instance = await window.rose.createInstance({
      name: $('instanceName').value,
      minecraftVersion: $('mcVersion').value,
      loader: $('loader').value
    });
    $('instanceDialog').close();
    $('instanceName').value = '';
    await loadInstances();
    $('targetInstance').value = instance.id;
    updateCompatLabel();
    showNotice(`Created ${instance.name}. RoseClient will install Fabric and download required game files when you press Start.`, 'success');
    setPage('instances');
  } catch (err) { showNotice(err.message, 'error'); }
});
document.querySelectorAll('[data-open]').forEach(btn => btn.addEventListener('click', async () => {
  const target = { data: appInfo.dataDir, instances: appInfo.instancesDir, login: appInfo.loginDir }[btn.dataset.open];
  try { const error = await window.rose.openPath(target); if (error) showNotice(error, 'error'); }
  catch (e) { showNotice(e.message, 'error'); }
}));
init();

async function refreshAccountStatus() {
  const status = await window.rose.authStatus();
  $('accountStatus').textContent = !status.secureStorage ? 'Secure storage unavailable' : status.saved ? `Signed in${status.profile?.username ? ` as ${status.profile.username}` : ''}` : 'No saved account';
  $('accountHelp').textContent = !status.secureStorage
    ? 'RoseClient will ask you to sign in each time rather than save credentials insecurely.'
    : status.saved
      ? 'Your encrypted login will be reused on future launches while its refresh token remains valid.'
      : 'Click Start Minecraft and complete Microsoft sign-in. RoseClient will save the login securely.';
  $('forgetLogin').disabled = !status.saved;
}
$('forgetLogin')?.addEventListener('click', async () => {
  try { await window.rose.authLogout(); await refreshAccountStatus(); showNotice('Saved Microsoft login removed.', 'success'); }
  catch (e) { showNotice(`Could not remove saved login: ${e.message}`, 'error'); }
});
