const $ = (sel) => document.querySelector(sel);

const MENU = {
  coffee: { id: 'coffee', name: 'Black Coffee', eur: 2.5 },
  cookie: { id: 'cookie', name: 'Cookie', eur: 1.5 },
};

const modal = $('#modal');
const modalTitle = $('#modalTitle');
const modalPrice = $('#modalPrice');
const modalPriceEth = $('#modalPriceEth');
const nameInput = $('#nameInput');
const payBtn = $('#payBtn');
const closeBtn = $('#closeBtn');

let nesppayUrl = 'http://localhost:3000';
let companyCode = 'NESPCFE';
let currentItem = null;
let ethEurRate = null;

function strToB64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function ethForEur(eur) {
  const rate = ethEurRate || 2000; // fallback if the rate hasn't loaded yet
  return (eur / rate).toFixed(8).replace(/\.?0+$/, '');
}

function renderPrices() {
  $('#coffeeEth').textContent = `≈ ${ethForEur(MENU.coffee.eur)} ETH`;
  $('#cookieEth').textContent = `≈ ${ethForEur(MENU.cookie.eur)} ETH`;
  if (currentItem) modalPriceEth.textContent = `≈ ${ethForEur(currentItem.eur)} ETH`;
}

async function loadRate() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur');
    const data = await res.json();
    if (data && data.ethereum && data.ethereum.eur) ethEurRate = data.ethereum.eur;
  } catch {
    /* keep fallback rate */
  }
  renderPrices();
}

function openModal(id) {
  currentItem = MENU[id];
  modalTitle.textContent = currentItem.name;
  modalPrice.textContent = `€${currentItem.eur.toFixed(2)}`;
  modalPriceEth.textContent = `≈ ${ethForEur(currentItem.eur)} ETH`;
  modal.classList.remove('hidden');
  setTimeout(() => nameInput.focus(), 120);
}

function closeModal() {
  modal.classList.add('hidden');
  currentItem = null;
}

async function pay() {
  if (!currentItem) return;
  const customerName = nameInput.value.trim() || 'Guest';
  const orderNo = Math.floor(1000 + Math.random() * 9000);

  // Get a server-signed payinfo (price in EUR) so the amount can't be tampered
  // with. The customer picks the payment coin on the payment page.
  const signRes = await fetch('/api/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyCode,
      product: currentItem.name,
      customerName,
      customerInfo: `Order #${orderNo}`,
      eur: currentItem.eur.toFixed(2),
    }),
  });
  const signed = await signRes.json();
  if (!signRes.ok || !signed.payinfo) {
    modalTitle.textContent = 'Payment error';
    modalPrice.textContent = 'Could not create a payment link. Please try again.';
    return;
  }
  const payinfo = signed.payinfo;

  const origin = window.location.origin;
  const q = new URLSearchParams({
    item: currentItem.id,
    name: customerName,
    order: orderNo,
    eur: currentItem.eur.toFixed(2),
  }).toString();
  const returns = strToB64url(`${origin}/success.html?${q}`);
  const returnf = strToB64url(`${origin}/cancelled.html`);

  window.location.href = `${nesppayUrl}/pay?payinfo=${payinfo}&returns=${returns}&returnf=${returnf}`;
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg.nesppayUrl) nesppayUrl = cfg.nesppayUrl;
    if (cfg.companyCode) companyCode = cfg.companyCode;
  } catch {
    /* keep default */
  }
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
}
function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved ?? (prefersDark ? 'dark' : 'light'));
}

document.querySelectorAll('.order-btn').forEach((btn) => {
  btn.addEventListener('click', () => openModal(btn.dataset.item));
});
payBtn.addEventListener('click', pay);
closeBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
$('#themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
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

initTheme();
loadConfig();
loadRate();
