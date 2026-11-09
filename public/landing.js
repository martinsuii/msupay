const nav = document.querySelector('.nav');

window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 8);
});

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12 },
);

document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));

// Show logged-in state in the nav if a token exists.
async function initAuthNav() {
  const token = localStorage.getItem('msupay_token');
  if (!token) return;
  try {
    const res = await fetch('/api/account', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const { account } = await res.json();
      document.getElementById('authLinks').classList.add('hidden');
      document.getElementById('loggedIn').classList.remove('hidden');
      document.getElementById('userBadge').textContent = account.companyName || account.email;
    } else if (res.status === 401) {
      localStorage.removeItem('msupay_token');
    }
  } catch {
    /* offline — leave nav as-is */
  }
}

initAuthNav();
