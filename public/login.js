const $ = (sel) => document.querySelector(sel);

const error = $('#error');

$('#loginBtn').addEventListener('click', async () => {
  error.classList.remove('show');
  const email = $('#email').value.trim();
  const password = $('#password').value;

  const btn = $('#loginBtn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      error.textContent = data.error || 'Sign in failed.';
      error.classList.add('show');
      return;
    }
    localStorage.setItem('nesppay_token', data.token);
    window.location.href = '/dashboard';
  } catch {
    error.textContent = 'Connection error. Please try again later.';
    error.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
