const $ = (sel) => document.querySelector(sel);

function strToB64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const fields = ['companyCode', 'product', 'customerName', 'customerInfo', 'price', 'returns', 'returnf'];

async function generate() {
  const companyCode = $('#companyCode').value.trim();
  const product = $('#product').value.trim();
  const customerName = $('#customerName').value.trim();
  const customerInfo = $('#customerInfo').value.trim();
  const price = $('#price').value.trim();
  const returns = $('#returns').value.trim();
  const returnf = $('#returnf').value.trim();

  const hint = $('#hint');
  hint.textContent = '';

  if (!companyCode) {
    $('#url').textContent = '…';
    hint.textContent = 'Add a company code to generate a valid link.';
    return;
  } else if (!price || isNaN(Number(price))) {
    $('#url').textContent = '…';
    hint.textContent = 'Enter a valid price.';
    return;
  }

  const body = { companyCode, eur: price };
  if (product) body.product = product;
  if (customerName) body.customerName = customerName;
  if (customerInfo) body.customerInfo = customerInfo;

  const token = localStorage.getItem('nesppay_token');
  if (!token) {
    $('#url').textContent = '…';
    hint.textContent = 'Log in to your merchant dashboard to sign payment links.';
    return;
  }

  let payinfo;
  try {
    const res = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.payinfo) throw new Error();
    payinfo = data.payinfo;
  } catch {
    $('#url').textContent = '…';
    hint.textContent = 'Could not sign the payment link.';
    return;
  }

  let url = `${window.location.origin}/pay?payinfo=${payinfo}`;
  if (returns) url += `&returns=${strToB64url(returns)}`;
  if (returnf) url += `&returnf=${strToB64url(returnf)}`;

  $('#url').textContent = url;
  $('#openBtn').href = url;
}

fields.forEach((id) => {
  $(`#${id}`).addEventListener('input', generate);
});

$('#copyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('#url').textContent);
  const btn = $('#copyBtn');
  btn.textContent = 'Copied!';
  setTimeout(() => (btn.textContent = 'Copy'), 1500);
});

generate();
