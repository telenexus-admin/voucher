const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
  token: sessionStorage.getItem('vq_admin_token') || '',
  user: JSON.parse(sessionStorage.getItem('vq_admin_user') || 'null'),
  campaigns: [],
  selectedCampaignId: null,
  selectedQr: null,
  screen: 'dashboard'
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]));
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(url, { ...options, headers });
  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    if (response.status === 401 && state.token) logout(false);
    throw new Error(body?.error || body || `Request failed (${response.status})`);
  }
  return body;
}

function toast(message, type = 'ok') {
  const node = $('#toast');
  node.textContent = message;
  node.classList.remove('hidden', 'error');
  if (type === 'error') node.classList.add('error');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add('hidden'), 3200);
}

function showLoggedIn() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#adminName').textContent = state.user?.display_name || '';
  $('#adminEmail').textContent = state.user?.email || '';
  $('#usersNav').classList.toggle('hidden', state.user?.role !== 'admin');
  loadAll();
}

function showLogin() {
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
}

function logout(showMessage = true) {
  state.token = '';
  state.user = null;
  state.campaigns = [];
  sessionStorage.removeItem('vq_admin_token');
  sessionStorage.removeItem('vq_admin_user');
  showLogin();
  if (showMessage) toast('Signed out');
}

async function loadAll() {
  try {
    const [overview, campaignData] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/campaigns')
    ]);

    state.campaigns = campaignData.campaigns || [];
    $('#statCampaigns').textContent = overview.campaigns;
    $('#statTotal').textContent = overview.vouchers_total;
    $('#statAvailable').textContent = overview.vouchers_available;
    $('#statAssigned').textContent = overview.vouchers_assigned;

    renderCampaignCards();
    renderCampaignList();

    if (state.selectedCampaignId) {
      const exists = state.campaigns.some((item) => item.id === state.selectedCampaignId);
      if (exists) await openCampaign(state.selectedCampaignId, false);
    }

    if (state.screen === 'users' && state.user?.role === 'admin') {
      await loadUsers();
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

function ownerLine(campaign) {
  if (state.user?.role !== 'admin' || !campaign.owner_email) return '';
  return `<div class="muted small-text">Owner: ${escapeHtml(campaign.owner_name || campaign.owner_email)}</div>`;
}

function renderCampaignCards() {
  const root = $('#campaignCards');
  const empty = $('#emptyCampaigns');

  if (!state.campaigns.length) {
    root.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  root.innerHTML = state.campaigns.slice(0, 6).map((campaign) => `
    <article class="campaign-card" data-campaign-card="${campaign.id}">
      <div class="section-head">
        <h4>${escapeHtml(campaign.name)}</h4>
        <span class="pill ${campaign.status === 'paused' ? 'paused' : ''}">${escapeHtml(campaign.status)}</span>
      </div>
      <div class="muted small-text">${escapeHtml(campaign.hotspot_login_url)}</div>
      ${ownerLine(campaign)}
      <div class="metric-row">
        <div class="mini-metric"><strong>${campaign.available}</strong><span>Available</span></div>
        <div class="mini-metric"><strong>${campaign.assigned}</strong><span>Assigned</span></div>
        <div class="mini-metric"><strong>${campaign.total}</strong><span>Total</span></div>
      </div>
    </article>
  `).join('');

  $$('[data-campaign-card]').forEach((card) => {
    card.addEventListener('click', () => {
      switchScreen('campaigns');
      openCampaign(Number(card.dataset.campaignCard));
    });
  });
}

function renderCampaignList() {
  const root = $('#campaignList');
  if (!state.campaigns.length) {
    root.innerHTML = '<div class="empty-state"><span>No QR campaigns yet.</span></div>';
    return;
  }

  root.innerHTML = state.campaigns.map((campaign) => `
    <button data-campaign-list="${campaign.id}" class="${state.selectedCampaignId === campaign.id ? 'active' : ''}">
      <strong>${escapeHtml(campaign.name)}</strong>
      <span>${campaign.available} available · ${campaign.assigned} assigned</span>
    </button>
  `).join('');

  $$('[data-campaign-list]').forEach((button) => {
    button.addEventListener('click', () => openCampaign(Number(button.dataset.campaignList)));
  });
}

async function openCampaign(id, refreshList = true) {
  state.selectedCampaignId = id;
  if (refreshList) renderCampaignList();

  const campaign = state.campaigns.find((item) => item.id === id);
  if (!campaign) return;

  const detail = $('#campaignDetail');
  detail.innerHTML = '<div class="empty-state"><strong>Loading campaign…</strong></div>';

  try {
    const [voucherData, qrData] = await Promise.all([
      api(`/api/admin/campaigns/${id}/vouchers`),
      api(`/api/admin/campaigns/${id}/qr`, { method: 'POST' })
    ]);

    state.selectedQr = qrData;
    const vouchers = voucherData.vouchers || [];

    detail.innerHTML = `
      <div class="section-head">
        <div>
          <div class="eyebrow">${escapeHtml(campaign.status)}</div>
          <h3>${escapeHtml(campaign.name)}</h3>
          ${ownerLine(campaign)}
        </div>
        <button id="reloadVoucherBtn" class="btn primary">+ Reload vouchers</button>
      </div>
      <div class="detail-grid">
        <div>
          <div class="qr-box" id="qrPreview">${qrData.svg}</div>
          <div class="url-box">${escapeHtml(qrData.target)}</div>
          <div class="detail-actions">
            <button class="btn ghost" id="downloadQrBtn">Download QR</button>
            <button class="btn ghost" id="copyQrBtn">Copy QR link</button>
          </div>
        </div>
        <div>
          <div class="eyebrow">VOUCHER POOL</div>
          <div class="voucher-stats">
            <div class="voucher-stat"><strong>${campaign.available}</strong><span>Available</span></div>
            <div class="voucher-stat"><strong>${campaign.assigned}</strong><span>Assigned</span></div>
            <div class="voucher-stat"><strong>${campaign.total}</strong><span>Total</span></div>
          </div>
          <div class="voucher-table-wrap">
            <table>
              <thead><tr><th>Voucher</th><th>Status</th><th>Device</th><th>Assigned</th></tr></thead>
              <tbody>
                ${vouchers.length ? vouchers.map((voucher) => `
                  <tr>
                    <td class="code">${escapeHtml(voucher.code)}</td>
                    <td><span class="status-dot ${voucher.status === 'assigned' ? 'assigned' : ''}"></span>${escapeHtml(voucher.status)}</td>
                    <td>${escapeHtml(voucher.assigned_device_key || '—')}</td>
                    <td>${escapeHtml(voucher.assigned_at ? new Date(voucher.assigned_at).toLocaleString() : '—')}</td>
                  </tr>
                `).join('') : '<tr><td colspan="4" class="muted">No vouchers loaded yet.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    $('#reloadVoucherBtn').addEventListener('click', () => $('#voucherDialog').showModal());
    $('#downloadQrBtn').addEventListener('click', downloadQr);
    $('#copyQrBtn').addEventListener('click', async () => {
      await navigator.clipboard.writeText(qrData.target);
      toast('QR link copied');
    });
  } catch (error) {
    detail.innerHTML = `
      <div class="empty-state">
        <strong>Unable to load campaign</strong>
        <span>${escapeHtml(error.message)}</span>
      </div>
    `;
  }
}

function downloadQr() {
  if (!state.selectedQr?.svg) return;
  const campaign = state.campaigns.find((item) => item.id === state.selectedCampaignId);
  const blob = new Blob([state.selectedQr.svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${campaign?.slug || 'voucher'}-qr.svg`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadUsers() {
  if (state.user?.role !== 'admin') return;
  try {
    const result = await api('/api/admin/users');
    const users = result.users || [];
    $('#usersTable').innerHTML = users.length ? users.map((user) => `
      <tr>
        <td>${escapeHtml(user.display_name)}</td>
        <td>${escapeHtml(user.email)}</td>
        <td>${escapeHtml(user.role)}</td>
        <td>${escapeHtml(new Date(user.created_at).toLocaleString())}</td>
      </tr>
    `).join('') : '<tr><td colspan="4" class="muted">No users yet.</td></tr>';
  } catch (error) {
    toast(error.message, 'error');
  }
}

function switchScreen(screen) {
  if (screen === 'users' && state.user?.role !== 'admin') screen = 'dashboard';
  state.screen = screen;

  $('#dashboardScreen').classList.toggle('hidden', screen !== 'dashboard');
  $('#campaignsScreen').classList.toggle('hidden', screen !== 'campaigns');
  $('#usersScreen').classList.toggle('hidden', screen !== 'users');
  $('#pageTitle').textContent = screen === 'dashboard' ? 'Overview' : screen === 'campaigns' ? 'QR Campaigns' : 'Portal Users';
  $('#newCampaignBtn').classList.toggle('hidden', screen === 'users');

  $$('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.screen === screen);
  });

  if (screen === 'users') loadUsers();
}

function parseVoucherText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const values = [];
  for (const line of lines) {
    const clean = line.trim();
    if (!clean) continue;
    const first = clean.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (!first) continue;
    if (/^(voucher|code|voucher_code)$/i.test(first) && values.length === 0) continue;
    values.push(first);
  }
  return [...new Set(values)];
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    const result = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('#loginEmail').value,
        password: $('#loginPassword').value
      })
    });
    state.token = result.token;
    state.user = result.user;
    sessionStorage.setItem('vq_admin_token', result.token);
    sessionStorage.setItem('vq_admin_user', JSON.stringify(result.user));
    showLoggedIn();
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#campaignForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#campaignError').textContent = '';
  try {
    const result = await api('/api/admin/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#campaignName').value,
        hotspot_login_url: $('#hotspotUrl').value
      })
    });
    $('#campaignDialog').close();
    $('#campaignForm').reset();
    await loadAll();
    switchScreen('campaigns');
    await openCampaign(result.campaign.id);
    toast('QR campaign created');
  } catch (error) {
    $('#campaignError').textContent = error.message;
  }
});

$('#voucherForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#voucherError').textContent = '';
  if (!state.selectedCampaignId) return;

  try {
    let text = $('#voucherText').value;
    const file = $('#voucherFile').files?.[0];
    if (file) text += `\n${await file.text()}`;
    const vouchers = parseVoucherText(text);
    if (!vouchers.length) throw new Error('Paste vouchers or choose a TXT/CSV file.');

    const result = await api(`/api/admin/campaigns/${state.selectedCampaignId}/vouchers`, {
      method: 'POST',
      body: JSON.stringify({ vouchers })
    });

    $('#voucherDialog').close();
    $('#voucherForm').reset();
    await loadAll();
    await openCampaign(state.selectedCampaignId, false);
    toast(`${result.added} vouchers added${result.skipped ? ` · ${result.skipped} duplicates skipped` : ''}`);
  } catch (error) {
    $('#voucherError').textContent = error.message;
  }
});

$('#userForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#userError').textContent = '';
  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        display_name: $('#userName').value,
        email: $('#userEmail').value,
        password: $('#userPassword').value,
        role: $('#userRole').value
      })
    });
    $('#userForm').reset();
    await loadUsers();
    toast('Portal user created');
  } catch (error) {
    $('#userError').textContent = error.message;
  }
});

$('#newCampaignBtn').addEventListener('click', () => $('#campaignDialog').showModal());
$('#logoutBtn').addEventListener('click', () => logout());
$('#refreshBtn').addEventListener('click', () => loadAll());
$$('.nav-item').forEach((item) => item.addEventListener('click', () => switchScreen(item.dataset.screen)));
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $('#campaignDialog').close()));
$$('[data-close-voucher]').forEach((button) => button.addEventListener('click', () => $('#voucherDialog').close()));

if (state.token && state.user) showLoggedIn();
else showLogin();
