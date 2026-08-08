(async () => {
  const { api, requireSession, initials, formatBytes, escapeHtml, logout, startSessionHeartbeat, toast } = window.Shelf;
  const user = await requireSession();
  if (!user) return;

  document.getElementById('userName').textContent = user.name;
  document.getElementById('userId').textContent = `@${user.username}`;
  document.getElementById('userInitial').textContent = initials(user.name);
  document.getElementById('welcomeTitle').textContent = `Welcome, ${user.name.split(' ')[0]}.`;
  if (user.role === 'ADMIN') document.getElementById('adminLink').classList.remove('hidden');
  document.getElementById('logoutButton').addEventListener('click', () => logout());
  startSessionHeartbeat();

  const grid = document.getElementById('bookGrid');
  const count = document.getElementById('bookCount');
  const search = document.getElementById('bookSearch');
  let books = [];

  function render(query = '') {
    const q = query.trim().toLowerCase();
    const visible = books.filter((b) => `${b.title} ${b.description}`.toLowerCase().includes(q));
    count.textContent = `${visible.length} ${visible.length === 1 ? 'book' : 'books'} available to this account`;
    if (!visible.length) {
      grid.innerHTML = `<div class="empty-state glass"><div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 19a2 2 0 0 1 2-2h12V4H7a2 2 0 0 0-2 2v13Z"/><path d="M7 17h12v3H7a2 2 0 0 1 0-4"/></svg><h3>${q ? 'No matching books' : 'No books assigned yet'}</h3><p>${q ? 'Try a different search term.' : 'Once the administrator assigns a purchased PDF, it will appear here automatically.'}</p></div></div>`;
      return;
    }
    grid.innerHTML = visible.map((book, i) => `
      <article class="book-card glass" style="animation-delay:${Math.min(i * 45, 240)}ms">
        <div class="book-cover"><div class="book-icon"></div></div>
        <div class="book-title">${escapeHtml(book.title)}</div>
        <div class="book-desc">${escapeHtml(book.description || 'Private document')}</div>
        <div class="book-footer"><span class="file-size">${formatBytes(book.size)}</span><a class="btn btn-primary btn-sm" href="/reader?id=${encodeURIComponent(book.id)}">Read now →</a></div>
      </article>`).join('');
  }

  try {
    const data = await api('/api/library');
    books = data.items || [];
    render();
  } catch (error) {
    toast(error.message, 'error');
    render();
  }
  search.addEventListener('input', () => render(search.value));
})();
