(() => {
  const TOKEN_KEY = 'pdfshelf_token';
  const USER_KEY = 'pdfshelf_user';

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function getStoredUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } }
  function setAuth(token, user) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); }
  function clearAuth() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }

  async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (getToken()) headers.set('Authorization', `Bearer ${getToken()}`);
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { ...options, headers, cache: 'no-store' });
    let data = null;
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.message || `Request failed (${response.status})`);
      error.status = response.status;
      error.code = data?.error;
      error.data = data;
      throw error;
    }
    return data;
  }

  function toast(message, type = 'info', title) {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.innerHTML = `<span class="dot"></span><div><strong>${escapeHtml(title || (type === 'error' ? 'Something went wrong' : type === 'success' ? 'Done' : 'Notice'))}</strong><span>${escapeHtml(message)}</span></div>`;
    stack.appendChild(item);
    setTimeout(() => { item.style.opacity = '0'; item.style.transform = 'translateY(8px)'; setTimeout(() => item.remove(), 220); }, 3600);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
  }

  function initials(name) {
    return String(name || 'U').trim().split(/\s+/).slice(0,2).map((x) => x[0] || '').join('').toUpperCase() || 'U';
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }

  function formatDate(value) {
    try { return new Intl.DateTimeFormat(undefined, { day:'2-digit', month:'short', year:'numeric' }).format(new Date(value)); } catch { return '—'; }
  }

  async function logout(redirect = true) {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    clearAuth();
    if (redirect) location.href = '/';
  }

  async function requireSession(role) {
    if (!getToken()) { location.replace('/'); return null; }
    try {
      const data = await api('/api/me');
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      if (role && data.user.role !== role) {
        location.replace(data.user.role === 'ADMIN' ? '/admin' : '/library');
        return null;
      }
      return data.user;
    } catch {
      clearAuth(); location.replace('/'); return null;
    }
  }

  function startSessionHeartbeat({ onRevoked, interval = 5000 } = {}) {
    let stopped = false;
    const check = async () => {
      if (stopped || !getToken()) return;
      try { await api('/api/me'); }
      catch (error) {
        if (error.status === 401) {
          clearAuth();
          if (onRevoked) onRevoked(error); else location.replace('/?reason=session');
        }
      }
    };
    const timer = setInterval(check, interval);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    return () => { stopped = true; clearInterval(timer); };
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  window.Shelf = { api, getToken, getStoredUser, setAuth, clearAuth, toast, escapeHtml, initials, formatBytes, formatDate, logout, requireSession, startSessionHeartbeat };
})();
