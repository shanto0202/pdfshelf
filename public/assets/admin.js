(async () => {
  const { api, requireSession, initials, escapeHtml, formatBytes, formatDate, toast, logout, startSessionHeartbeat } = window.Shelf;
  const user = await requireSession('ADMIN');
  if (!user) return;
  document.getElementById('adminName').textContent = user.name;
  document.getElementById('adminInitial').textContent = initials(user.name);
  document.getElementById('logoutButton').addEventListener('click', () => logout());
  startSessionHeartbeat();

  let state = { summary:{}, users:[], pdfs:[], grants:[] };
  const $ = (id) => document.getElementById(id);

  document.querySelectorAll('.nav-btn').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === button));
    document.querySelectorAll('.tab-view').forEach((view) => view.classList.remove('active'));
    $(`tab-${button.dataset.tab}`).classList.add('active');
  }));

  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModals() { document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden')); }
  document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));
  document.querySelectorAll('[data-open-user]').forEach((b) => b.addEventListener('click', () => openModal('userModal')));
  document.querySelectorAll('[data-open-pdf]').forEach((b) => b.addEventListener('click', () => openModal('pdfModal')));

  function renderStats() {
    const cards = [
      ['Customers', state.summary.users || 0, '👥'],
      ['Active accounts', state.summary.activeUsers || 0, '✓'],
      ['PDF catalogue', state.summary.pdfs || 0, '▤'],
      ['Access grants', state.summary.grants || 0, '🔑']
    ];
    $('statsGrid').innerHTML = cards.map(([label,value,icon],i) => `<div class="stat-card glass" style="animation-delay:${i*45}ms"><div class="stat-top"><span class="label">${label}</span><span class="stat-icon">${icon}</span></div><span class="value">${value}</span><span class="label">Live from your local database</span></div>`).join('');
  }

  function renderUsers() {
    $('usersTable').innerHTML = state.users.map((u) => `
      <tr>
        <td class="primary-cell"><strong>${escapeHtml(u.name)}</strong><span>@${escapeHtml(u.username)}</span></td>
        <td><span class="badge ${u.role === 'ADMIN' ? 'admin' : ''}">${u.role}</span></td>
        <td><span class="badge ${u.status === 'ACTIVE' ? 'active' : 'disabled'}">${u.status}</span></td>
        <td>${u.activeSessions ? '<span class="text-success">● Online</span>' : '<span class="muted">Offline</span>'}</td>
        <td>${formatDate(u.createdAt)}</td>
        <td><div class="action-row">
          <button class="btn btn-secondary btn-sm" data-reset="${u.id}" data-name="${escapeHtml(u.name)}">Reset pass</button>
          <button class="btn btn-secondary btn-sm" data-logout="${u.id}">Force logout</button>
          ${u.role === 'USER' ? `<button class="btn ${u.status === 'ACTIVE' ? 'btn-danger' : 'btn-success'} btn-sm" data-status="${u.id}" data-next="${u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'}">${u.status === 'ACTIVE' ? 'Disable' : 'Enable'}</button>` : ''}
        </div></td>
      </tr>`).join('');

    document.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/admin/users/${b.dataset.status}/status`, { method:'PATCH', body:JSON.stringify({status:b.dataset.next}) }); toast('Account status updated.', 'success'); await load(); } catch (e) { toast(e.message,'error'); }
    }));
    document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/admin/users/${b.dataset.logout}/logout`, { method:'POST' }); toast('Active session signed out.', 'success'); await load(); } catch (e) { toast(e.message,'error'); }
    }));
    document.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => {
      $('passwordUserId').value = b.dataset.reset; $('passwordModalCopy').textContent = `Set a new password for ${b.dataset.name}. Existing sessions will be signed out.`; $('resetPassword').value=''; openModal('passwordModal');
    }));
  }

  function renderPdfs() {
    $('pdfsTable').innerHTML = state.pdfs.filter((p) => p.status !== 'DELETED').map((p) => `
      <tr><td class="primary-cell"><strong>${escapeHtml(p.title)}</strong><span>${escapeHtml(p.originalName)}</span></td><td>${formatBytes(p.size)}</td><td>${p.accessCount}</td><td><span class="badge active">${p.status}</span></td><td>${formatDate(p.createdAt)}</td><td><div class="action-row"><a class="btn btn-secondary btn-sm" href="/reader?id=${encodeURIComponent(p.id)}">Open</a><button class="btn btn-danger btn-sm" data-delete-pdf="${p.id}">Delete</button></div></td></tr>`).join('');
    document.querySelectorAll('[data-delete-pdf]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this PDF and revoke all access to it?')) return;
      try { await api(`/api/admin/pdfs/${b.dataset.deletePdf}`, { method:'DELETE' }); toast('PDF deleted and access revoked.', 'success'); await load(); } catch (e) { toast(e.message,'error'); }
    }));
  }

  function renderAccess() {
    const users = state.users.filter((u) => u.role === 'USER' && u.status === 'ACTIVE');
    const pdfs = state.pdfs.filter((p) => p.status === 'ACTIVE');
    $('grantUser').innerHTML = users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)} (@${escapeHtml(u.username)})</option>`).join('');
    $('grantPdf').innerHTML = pdfs.map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');

    const active = state.grants;
    if (!active.length) { $('grantList').innerHTML = '<div class="muted" style="font-size:11px;padding:18px;text-align:center">No active access assignments yet.</div>'; return; }
    $('grantList').innerHTML = active.map((g) => {
      const u = state.users.find((x) => x.id === g.userId); const p = state.pdfs.find((x) => x.id === g.pdfId);
      if (!u || !p) return '';
      return `<div class="grant-item"><div><strong>${escapeHtml(p.title)}</strong><span>${escapeHtml(u.name)} · @${escapeHtml(u.username)}</span></div><button class="btn btn-danger btn-sm" data-revoke-user="${u.id}" data-revoke-pdf="${p.id}">Revoke</button></div>`;
    }).join('');
    document.querySelectorAll('[data-revoke-user]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/admin/grants?userId=${encodeURIComponent(b.dataset.revokeUser)}&pdfId=${encodeURIComponent(b.dataset.revokePdf)}`, { method:'DELETE' }); toast('PDF access revoked.', 'success'); await load(); } catch (e) { toast(e.message,'error'); }
    }));
  }

  async function load() {
    state = await api('/api/admin/dashboard');
    renderStats(); renderUsers(); renderPdfs(); renderAccess();
  }

  $('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/users', { method:'POST', body:JSON.stringify({ name:$('newName').value, username:$('newUsername').value, password:$('newPassword').value }) });
      toast('Customer account created.', 'success'); e.target.reset(); closeModals(); await load();
    } catch (err) { toast(err.message,'error'); }
  });

  $('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api(`/api/admin/users/${$('passwordUserId').value}/password`, { method:'PATCH', body:JSON.stringify({password:$('resetPassword').value}) }); toast('Password updated.', 'success'); closeModals(); if ($('passwordUserId').value === user.id) { window.Shelf.clearAuth(); setTimeout(() => location.replace('/'), 350); return; } await load(); } catch (err) { toast(err.message,'error'); }
  });

  $('pdfFile').addEventListener('change', () => { $('pdfFileLabel').textContent = $('pdfFile').files[0]?.name || 'Choose a PDF file'; });
  $('pdfForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('pdfFile').files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return toast('Choose a PDF smaller than 20 MB.', 'error');
    const button = $('uploadPdfButton'); button.disabled = true; button.textContent = 'Uploading…';
    try {
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      const base64 = String(dataUrl).split(',')[1] || '';
      await api('/api/admin/pdfs', { method:'POST', body:JSON.stringify({ title:$('pdfTitle').value, description:$('pdfDescription').value, fileName:file.name, dataBase64:base64 }) });
      toast('PDF uploaded successfully.', 'success'); e.target.reset(); $('pdfFileLabel').textContent='Choose a PDF file'; closeModals(); await load();
    } catch (err) { toast(err.message,'error'); }
    finally { button.disabled=false; button.textContent='Upload PDF'; }
  });

  $('grantForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/admin/grants', { method:'POST', body:JSON.stringify({ userId:$('grantUser').value, pdfId:$('grantPdf').value }) }); toast('PDF access granted.', 'success'); await load(); } catch (err) { toast(err.message,'error'); }
  });

  try { await load(); } catch (e) { toast(e.message,'error'); }
})();
