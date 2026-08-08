(async () => {
  const { api, setAuth, getToken, toast, clearAuth } = window.Shelf;
  if (getToken()) {
    try {
      const { user } = await api('/api/me');
      location.replace(user.role === 'ADMIN' ? '/admin' : '/library');
      return;
    } catch { clearAuth(); }
  }

  const params = new URLSearchParams(location.search);
  if (params.get('reason') === 'session') toast('Your previous session is no longer active. Sign in again to continue.', 'info', 'Session ended');

  const form = document.getElementById('loginForm');
  const button = document.getElementById('loginButton');
  const password = document.getElementById('password');
  document.getElementById('togglePassword').addEventListener('click', (e) => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    const oldText = button.innerHTML;
    button.textContent = 'Signing in…';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: form.username.value, password: form.password.value })
      });
      setAuth(data.token, data.user);
      toast('Login successful. Opening your workspace…', 'success');
      setTimeout(() => location.replace(data.user.role === 'ADMIN' ? '/admin' : '/library'), 280);
    } catch (error) {
      toast(error.message, 'error', 'Unable to sign in');
      password.select();
    } finally {
      button.disabled = false;
      button.innerHTML = oldText;
    }
  });
})();
