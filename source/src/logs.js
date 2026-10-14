const logRoot = document.getElementById('logs');
const search = document.getElementById('search');
const count = document.getElementById('count');
const auto = document.getElementById('autoscroll');
let entries = [];
let level = 'all';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render() {
  const q = search.value.trim().toLowerCase();
  const shown = entries.filter(e => (level === 'all' || e.level === level) && (!q || e.message.toLowerCase().includes(q)));
  count.textContent = `${shown.length} ${shown.length === 1 ? 'entry' : 'entries'}`;
  if (!shown.length) { logRoot.innerHTML = '<div class="empty"><span>🌷</span><h2>Nothing to show just yet</h2><p>Try another filter, or wait for new events.</p></div>'; return; }
  logRoot.innerHTML = shown.map(e => {
    const time = new Date(e.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const kind = ['info','warn','error','debug','log'].includes(e.level) ? e.level : 'log';
    return `<article class="entry ${kind}"><time class="time">${esc(time)}</time><span class="badge ${kind}">${esc(kind)}</span><div class="message">${esc(e.message)}</div></article>`;
  }).join('');
  if (auto.checked) logRoot.scrollTop = logRoot.scrollHeight;
}
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('.filter').forEach(b => b.classList.remove('active')); button.classList.add('active'); level = button.dataset.level; render(); }));
search.addEventListener('input', render);
window.rose.getLogs().then(initial => { entries = initial || []; render(); });
window.rose.onLogEntry(entry => { entries.push(entry); if (entries.length > 1200) entries.shift(); render(); });
window.rose.onLogsCleared(() => { entries = []; render(); });
document.getElementById('clear').addEventListener('click', async () => { await window.rose.clearLogs(); });
document.getElementById('open-file').addEventListener('click', () => window.rose.openLogFile());
