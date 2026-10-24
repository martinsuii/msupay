const $ = (sel) => document.querySelector(sel);

const step1 = $('#step1');
const step2 = $('#step2');
const bar1 = $('#bar1');
const bar2 = $('#bar2');
const error1 = $('#error1');
const error2 = $('#error2');

function showError(el, msg) {
  el.textContent = msg;
  el.classList.add('show');
}
function clearError(el) {
  el.textContent = '';
  el.classList.remove('show');
}

function goStep2() {
  step1.classList.remove('active');
  step2.classList.add('active');
  bar2.classList.add('on');
}

$('#nextBtn').addEventListener('click', async () => {
  clearError(error1);
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const password2 = $('#password2').value;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return showError(error1, 'Please enter a valid email.');
  }
  if (!password || password.length < 6) {
    return showError(error1, 'Password must be at least 6 characters.');
  }
  if (password !== password2) {
    return showError(error1, 'Passwords do not match.');
  }

  const btn = $('#nextBtn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      showError(error1, data.error || 'Registration failed.');
      return;
    }
    localStorage.setItem('nesppay_token', data.token);
    goStep2();
  } catch {
    showError(error1, 'Connection error. Please try again later.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Continue';
  }
});

$('#finishBtn').addEventListener('click', async () => {
  clearError(error2);
  const companyName = $('#companyName').value.trim();
  if (!companyName) {
    return showError(error2, 'Please enter a company name.');
  }

  const btn = $('#finishBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/company', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('nesppay_token')}`,
      },
      body: JSON.stringify({
        companyName,
        companyDescription: $('#companyDescription').value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showError(error2, data.error || 'Could not save company info.');
      return;
    }
    window.location.href = '/dashboard';
  } catch {
    showError(error2, 'Connection error. Please try again later.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Finish';
  }
});
