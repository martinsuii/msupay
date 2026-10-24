let cache = { at: 0, data: null };

const IDS = ['ethereum', 'bitcoin', 'litecoin'];
const MAP = { ETH: 'ethereum', BTC: 'bitcoin', LTC: 'litecoin' };

// Returns EUR price per coin ({ ETH, BTC, LTC }), cached for 60s with a stale
// fallback so a transient API failure doesn't break payment creation.
export async function getEurRates() {
  if (cache.data && Date.now() - cache.at < 60000) return cache.data;
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${IDS.join(',')}&vs_currencies=eur`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      const rates = { ETH: data.ethereum?.eur, BTC: data.bitcoin?.eur, LTC: data.litecoin?.eur };
      if (rates.ETH && rates.BTC && rates.LTC) {
        cache = { at: Date.now(), data: rates };
        return rates;
      }
    }
  } catch {
    /* fall through to cache */
  }
  if (cache.data) return cache.data;
  throw new Error('exchange rates unavailable');
}
