// ============================================================
// UNIFIED CRYPTO ARBITRAGE SCANNER
// Strategy 1: CEX-to-CEX (same token, different exchange prices)
// Strategy 2: CEX-to-DEX (centralized vs decentralized price)
// Strategy 3: Triangular arb (3-pair cycle within one exchange)
// Strategy 4: Funding Rate arb (spot hedge against perp funding)
// ============================================================

const fetch = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api');

// ─── CONFIG (set these in Railway environment variables) ──────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Which strategies to enable (default all on)
const ENABLE_CEX_CEX       = process.env.ENABLE_CEX_CEX       !== 'false';
const ENABLE_CEX_DEX       = process.env.ENABLE_CEX_DEX       !== 'false';
const ENABLE_TRIANGULAR    = process.env.ENABLE_TRIANGULAR     !== 'false';
const ENABLE_FUNDING_RATE  = process.env.ENABLE_FUNDING_RATE   !== 'false';

// Thresholds
const CEX_CEX_MIN_PCT      = parseFloat(process.env.CEX_CEX_MIN_PCT      || '0.5');  // min % spread after fees
const CEX_DEX_MIN_PCT      = parseFloat(process.env.CEX_DEX_MIN_PCT      || '1.0');  // DEX slippage is higher
const TRI_MIN_PCT          = parseFloat(process.env.TRI_MIN_PCT          || '0.3');  // triangular
const FUNDING_MIN_APR      = parseFloat(process.env.FUNDING_MIN_APR      || '20');   // annualised % to bother

// Cooldown per alert (minutes)
const ALERT_COOLDOWN_MIN   = parseInt(process.env.ALERT_COOLDOWN_MIN     || '15');

// Poll intervals (seconds)
const CEX_POLL_SECONDS     = parseInt(process.env.CEX_POLL_SECONDS       || '30');
const DEX_POLL_SECONDS     = parseInt(process.env.DEX_POLL_SECONDS       || '60');
const TRI_POLL_SECONDS     = parseInt(process.env.TRI_POLL_SECONDS       || '30');
const FUNDING_POLL_SECONDS = parseInt(process.env.FUNDING_POLL_SECONDS   || '300');  // 5 min, rates change slowly

// ─── CEX fees (taker) used for net-of-fee profit calc ────────────────────────
const FEES = {
  binance:  0.001,   // 0.10%
  bybit:    0.001,
  okx:      0.001,
  kucoin:   0.001,
  mexc:     0.002,   // 0.20%
  kraken:   0.0026,
  gate:     0.002,
  htx:      0.002,
};

// ─── Tokens to watch for CEX-CEX arb ─────────────────────────────────────────
// Add/remove pairs as you like.  Format: [symbol, [exchange1, exchange2, ...]]
const CEX_WATCH = [
  ['BTC',  ['binance','bybit','okx','kraken','kucoin']],
  ['ETH',  ['binance','bybit','okx','kraken','kucoin']],
  ['SOL',  ['binance','bybit','okx','kucoin','mexc']],
  ['XRP',  ['binance','bybit','okx','kucoin','mexc']],
  ['BNB',  ['binance','bybit','okx','kucoin']],
  ['DOGE', ['binance','bybit','kucoin','mexc']],
  ['ADA',  ['binance','bybit','kucoin','mexc']],
  ['AVAX', ['binance','bybit','kucoin','mexc']],
  ['MATIC',['binance','kucoin','mexc','gate']],
  ['LINK', ['binance','bybit','kucoin','mexc']],
  ['DOT',  ['binance','bybit','kucoin','kraken']],
  ['UNI',  ['binance','kucoin','mexc','gate']],
  ['LTC',  ['binance','bybit','kraken','mexc']],
  ['ATOM', ['binance','kucoin','kraken']],
  ['INJ',  ['binance','bybit','kucoin','mexc']],
  ['NEAR', ['binance','kucoin','mexc']],
  ['ARB',  ['binance','bybit','kucoin','mexc']],
  ['OP',   ['binance','bybit','kucoin','mexc']],
  ['SUI',  ['bybit','kucoin','mexc','gate']],
  ['TIA',  ['bybit','kucoin','mexc']],
];

// ─── Triangular arb paths (within Binance, all USDT-anchored) ─────────────────
// cycle: [A/USDT, B/USDT, A/B]  — buy A with USDT, buy B with A, sell B for USDT
const TRI_PATHS = [
  { label:'BTC→ETH→USDT', legs:['BTC','ETH','ETHBTC'] },
  { label:'BTC→BNB→USDT', legs:['BTC','BNB','BNBBTC'] },
  { label:'ETH→BNB→USDT', legs:['ETH','BNB','BNBETH'] },
  { label:'BNB→SOL→USDT', legs:['BNB','SOL','SOLBNB'] },
  { label:'BTC→SOL→USDT', legs:['BTC','SOL','SOLBTC'] },
];

// ─── Funding rate assets to monitor ──────────────────────────────────────────
const FUNDING_ASSETS = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA'];

// ─── CEX-to-DEX pairs (token on CEX vs GeckoTerminal pool) ───────────────────
// The DEX price is fetched from GeckoTerminal free API (no key needed)
const CEX_DEX_WATCH = [
  { symbol:'UNI',    network:'eth',  pool_addr:'0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801' }, // UNI/WETH Uniswap
  { symbol:'ARB',    network:'arbitrum', pool_addr:'0xa0c67b8d4a4b4a6c61b2f49a8abc9a0b82c65a0d' },
  { symbol:'PEPE',   network:'eth',  pool_addr:'0x11950d141ecb863f01007add7d1a342041227b58' },
  { symbol:'WIF',    network:'solana', pool_addr:'EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx' },
];

// ─── Telegram setup ───────────────────────────────────────────────────────────
let bot;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
}

async function sendTelegram(msg) {
  if (!bot) { console.log('[TG]', msg); return; }
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode:'Markdown' });
  } catch(e) {
    console.error('Telegram error:', e.message);
  }
}

// ─── Alert cooldown ───────────────────────────────────────────────────────────
const recentAlerts = new Map(); // key → timestamp

function canAlert(key) {
  const last = recentAlerts.get(key);
  if (!last) return true;
  return (Date.now() - last) > ALERT_COOLDOWN_MIN * 60 * 1000;
}
function markAlerted(key) { recentAlerts.set(key, Date.now()); }

// ─── Helper: simple GET with timeout ─────────────────────────────────────────
async function getJSON(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY 1: CEX-to-CEX
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchCEXPrice(exchange, symbol) {
  const pair = symbol + 'USDT';
  try {
    switch(exchange) {
      case 'binance': {
        const d = await getJSON(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
        return parseFloat(d.price);
      }
      case 'bybit': {
        const d = await getJSON(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair}`);
        return parseFloat(d.result.list[0].lastPrice);
      }
      case 'okx': {
        const instId = symbol + '-USDT';
        const d = await getJSON(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`);
        return parseFloat(d.data[0].last);
      }
      case 'kucoin': {
        const d = await getJSON(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${symbol}-USDT`);
        return parseFloat(d.data.price);
      }
      case 'mexc': {
        const d = await getJSON(`https://api.mexc.com/api/v3/ticker/price?symbol=${pair}`);
        return parseFloat(d.price);
      }
      case 'kraken': {
        const kPair = symbol === 'BTC' ? 'XXBTZUSDT' : symbol === 'ETH' ? 'XETHZUSDT' : symbol + 'USDT';
        const d = await getJSON(`https://api.kraken.com/0/public/Ticker?pair=${kPair}`);
        const key = Object.keys(d.result)[0];
        return parseFloat(d.result[key].c[0]);
      }
      case 'gate': {
        const d = await getJSON(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${symbol}_USDT`);
        return parseFloat(d[0].last);
      }
      case 'htx': {
        const d = await getJSON(`https://api.huobi.pro/market/detail/merged?symbol=${symbol.toLowerCase()}usdt`);
        return parseFloat(d.tick.close);
      }
      default: return null;
    }
  } catch(e) {
    return null;
  }
}

async function runCEXCEX() {
  for (const [symbol, exchanges] of CEX_WATCH) {
    try {
      const prices = {};
      await Promise.all(exchanges.map(async ex => {
        const p = await fetchCEXPrice(ex, symbol);
        if (p && p > 0) prices[ex] = p;
      }));

      const exList = Object.keys(prices);
      if (exList.length < 2) continue;

      // find best buy (lowest) and best sell (highest)
      let minEx = exList[0], maxEx = exList[0];
      for (const ex of exList) {
        if (prices[ex] < prices[minEx]) minEx = ex;
        if (prices[ex] > prices[maxEx]) maxEx = ex;
      }
      if (minEx === maxEx) continue;

      const buyPrice  = prices[minEx];
      const sellPrice = prices[maxEx];
      const grossPct  = (sellPrice - buyPrice) / buyPrice * 100;

      // subtract fees: buy fee + sell fee
      const feePct = (FEES[minEx] || 0.002) * 100 + (FEES[maxEx] || 0.002) * 100;
      const netPct = grossPct - feePct;

      if (netPct >= CEX_CEX_MIN_PCT) {
        const key = `cex-cex-${symbol}`;
        if (canAlert(key)) {
          markAlerted(key);
          const msg =
            `🔄 *CEX-CEX ARB: ${symbol}*\n` +
            `Buy on *${minEx.toUpperCase()}* @ $${buyPrice.toFixed(4)}\n` +
            `Sell on *${maxEx.toUpperCase()}* @ $${sellPrice.toFixed(4)}\n` +
            `Gross spread: +${grossPct.toFixed(3)}%\n` +
            `Est. net (after fees): *+${netPct.toFixed(3)}%*\n` +
            `⚠️ Act fast — window often seconds. Check withdrawal limits & times.`;
          await sendTelegram(msg);
          console.log(`[CEX-CEX] ${symbol} ${minEx}→${maxEx} net ${netPct.toFixed(3)}%`);
        }
      }
    } catch(e) {
      // silent
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY 2: CEX-to-DEX
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchGeckoTerminalPrice(network, poolAddr) {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddr}`;
    const d = await getJSON(url, { headers:{ 'Accept':'application/json' } });
    return parseFloat(d.data.attributes.base_token_price_usd);
  } catch(e) {
    return null;
  }
}

async function runCEXDEX() {
  for (const { symbol, network, pool_addr } of CEX_DEX_WATCH) {
    try {
      const [cexPrice, dexPrice] = await Promise.all([
        fetchCEXPrice('binance', symbol).then(p => p || fetchCEXPrice('kucoin', symbol)),
        fetchGeckoTerminalPrice(network, pool_addr),
      ]);

      if (!cexPrice || !dexPrice) continue;

      const spreadPct = Math.abs(cexPrice - dexPrice) / Math.min(cexPrice, dexPrice) * 100;
      const cheaper = cexPrice < dexPrice ? 'CEX (Binance)' : 'DEX';
      const pricier  = cexPrice < dexPrice ? 'DEX' : 'CEX (Binance)';

      if (spreadPct >= CEX_DEX_MIN_PCT) {
        const key = `cex-dex-${symbol}`;
        if (canAlert(key)) {
          markAlerted(key);
          const msg =
            `🌉 *CEX-DEX ARB: ${symbol}*\n` +
            `CEX price: $${cexPrice.toFixed(6)}\n` +
            `DEX price: $${dexPrice.toFixed(6)}\n` +
            `Spread: *${spreadPct.toFixed(2)}%*\n` +
            `Buy on ${cheaper}, sell on ${pricier}\n` +
            `⚠️ Account for gas + bridge time + slippage before executing.`;
          await sendTelegram(msg);
          console.log(`[CEX-DEX] ${symbol} spread ${spreadPct.toFixed(2)}%`);
        }
      }
    } catch(e) {
      // silent
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY 3: TRIANGULAR ARB (within Binance)
// ═══════════════════════════════════════════════════════════════════════════════

const binancePrices = {};

async function refreshBinancePrices() {
  try {
    const data = await getJSON('https://api.binance.com/api/v3/ticker/price');
    for (const { symbol, price } of data) {
      binancePrices[symbol] = parseFloat(price);
    }
  } catch(e) {
    // keep stale prices
  }
}

function checkTriPath({ label, legs }) {
  // legs = [BASE1, BASE2, CROSS_PAIR_SYMBOL]
  // e.g. ['BTC','ETH','ETHBTC']
  // Cycle: USDT → BTC (buy BTC/USDT) → ETH (buy ETH/BTC) → USDT (sell ETH/USDT)
  const [b1, b2, cross] = legs;
  const p1 = binancePrices[b1 + 'USDT']; // USDT cost per B1
  const p2 = binancePrices[b2 + 'USDT']; // USDT value per B2
  const pc = binancePrices[cross];         // B2 per B1

  if (!p1 || !p2 || !pc) return null;

  // Start with 1 USDT
  const step1 = 1 / p1;          // units of B1 bought
  const step2 = step1 * pc;      // units of B2 from B1
  const step3 = step2 * p2;      // USDT back from selling B2

  const grossReturn = (step3 - 1) * 100;
  const feePct = 0.1 * 3;        // 3 trades × 0.10% taker on Binance
  const netReturn = grossReturn - feePct;

  return { label, netReturn, grossReturn };
}

async function runTriangular() {
  await refreshBinancePrices();
  for (const path of TRI_PATHS) {
    const result = checkTriPath(path);
    if (!result) continue;
    if (result.netReturn >= TRI_MIN_PCT) {
      const key = `tri-${path.label}`;
      if (canAlert(key)) {
        markAlerted(key);
        const msg =
          `🔺 *TRIANGULAR ARB: ${result.label}*\n` +
          `Gross return: +${result.grossReturn.toFixed(4)}%\n` +
          `Net (after 3×0.1% Binance fees): *+${result.netReturn.toFixed(4)}%*\n` +
          `All trades within Binance — no withdrawal needed.\n` +
          `⚠️ Execute all 3 legs simultaneously or use limit orders. Window is seconds.`;
        await sendTelegram(msg);
        console.log(`[TRI] ${result.label} net ${result.netReturn.toFixed(4)}%`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY 4: FUNDING RATE ARB
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchFundingRates() {
  const results = {};

  // Binance perpetuals
  try {
    const data = await getJSON('https://fapi.binance.com/fapi/v1/premiumIndex');
    for (const item of data) {
      if (!item.symbol.endsWith('USDT')) continue;
      const asset = item.symbol.replace('USDT','');
      if (!FUNDING_ASSETS.includes(asset)) continue;
      const rate = parseFloat(item.lastFundingRate);
      if (!results[asset]) results[asset] = {};
      results[asset].binance = rate;
    }
  } catch(e) {}

  // Bybit perpetuals
  try {
    const data = await getJSON('https://api.bybit.com/v5/market/tickers?category=linear');
    for (const item of (data.result?.list || [])) {
      if (!item.symbol.endsWith('USDT')) continue;
      const asset = item.symbol.replace('USDT','');
      if (!FUNDING_ASSETS.includes(asset)) continue;
      const rate = parseFloat(item.fundingRate);
      if (!results[asset]) results[asset] = {};
      results[asset].bybit = rate;
    }
  } catch(e) {}

  // OKX perpetuals
  try {
    for (const asset of FUNDING_ASSETS) {
      try {
        const d = await getJSON(`https://www.okx.com/api/v5/public/funding-rate?instId=${asset}-USDT-SWAP`);
        const rate = parseFloat(d.data[0].fundingRate);
        if (!results[asset]) results[asset] = {};
        results[asset].okx = rate;
      } catch(e) {}
    }
  } catch(e) {}

  return results;
}

async function runFundingRate() {
  const rates = await fetchFundingRates();

  for (const [asset, exchangeRates] of Object.entries(rates)) {
    for (const [ex, rate] of Object.entries(exchangeRates)) {
      // Funding rate is paid every 8h, so annualise: rate × 3 × 365
      const aprPct = rate * 3 * 365 * 100;

      if (Math.abs(aprPct) >= FUNDING_MIN_APR) {
        const key = `funding-${asset}-${ex}`;
        if (canAlert(key)) {
          markAlerted(key);

          const direction = rate > 0 ? 'LONGS pay shorts' : 'SHORTS pay longs';
          const action = rate > 0
            ? `Buy spot ${asset} + Short ${asset}-USDT perp on ${ex.toUpperCase()}`
            : `Short spot ${asset} (borrow) + Long ${asset}-USDT perp on ${ex.toUpperCase()}`;

          const msg =
            `💰 *FUNDING RATE ARB: ${asset} on ${ex.toUpperCase()}*\n` +
            `Current funding rate: ${(rate * 100).toFixed(4)}% per 8h\n` +
            `Annualised: *${aprPct.toFixed(1)}% APR*\n` +
            `Direction: ${direction}\n` +
            `\nStrategy: ${action}\n` +
            `→ Delta-neutral position earns the funding rate.\n` +
            `⚠️ Risk: rate can flip anytime. Liquidation risk if hedge imperfect.`;
          await sendTelegram(msg);
          console.log(`[FUNDING] ${asset} ${ex} ${aprPct.toFixed(1)}% APR`);
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP BANNER
// ═══════════════════════════════════════════════════════════════════════════════

async function sendStartupMessage() {
  const strategies = [
    ENABLE_CEX_CEX      ? `✅ CEX-CEX arb (≥${CEX_CEX_MIN_PCT}% net, ${CEX_POLL_SECONDS}s poll)` : '❌ CEX-CEX disabled',
    ENABLE_CEX_DEX      ? `✅ CEX-DEX arb (≥${CEX_DEX_MIN_PCT}% spread, ${DEX_POLL_SECONDS}s poll)` : '❌ CEX-DEX disabled',
    ENABLE_TRIANGULAR   ? `✅ Triangular arb (≥${TRI_MIN_PCT}% net, ${TRI_POLL_SECONDS}s poll)` : '❌ Triangular disabled',
    ENABLE_FUNDING_RATE ? `✅ Funding rate arb (≥${FUNDING_MIN_APR}% APR, ${FUNDING_POLL_SECONDS}s poll)` : '❌ Funding rate disabled',
  ].join('\n');

  const msg =
    `🚀 *Unified Arb Scanner — ONLINE*\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `${strategies}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `Alert cooldown: ${ALERT_COOLDOWN_MIN} min per opportunity\n` +
    `📊 Watching ${CEX_WATCH.length} tokens across up to 8 CEXs`;
  await sendTelegram(msg);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST MODES
// ═══════════════════════════════════════════════════════════════════════════════

async function testMode() {
  console.log('=== TEST MODE ===');

  console.log('\n[1] CEX-CEX: fetching BTC prices...');
  const btcPrices = {};
  await Promise.all(['binance','bybit','okx','kucoin','mexc'].map(async ex => {
    const p = await fetchCEXPrice(ex, 'BTC');
    if (p) { btcPrices[ex] = p; console.log(`  ${ex}: $${p.toFixed(2)}`); }
    else console.log(`  ${ex}: failed`);
  }));

  console.log('\n[2] Triangular: refreshing Binance prices...');
  await refreshBinancePrices();
  const priceFetched = Object.keys(binancePrices).length;
  console.log(`  Loaded ${priceFetched} Binance pairs`);
  for (const path of TRI_PATHS) {
    const r = checkTriPath(path);
    if (r) console.log(`  ${r.label}: net ${r.netReturn.toFixed(4)}%`);
    else console.log(`  ${path.label}: missing prices`);
  }

  console.log('\n[3] Funding rates...');
  const rates = await fetchFundingRates();
  for (const [asset, exRates] of Object.entries(rates)) {
    for (const [ex, rate] of Object.entries(exRates)) {
      const apr = rate * 3 * 365 * 100;
      console.log(`  ${asset} on ${ex}: ${(rate*100).toFixed(4)}%/8h = ${apr.toFixed(1)}% APR`);
    }
  }

  console.log('\n[4] CEX-DEX: checking PEPE pool...');
  const dexP = await fetchGeckoTerminalPrice('eth', '0x11950d141ecb863f01007add7d1a342041227b58');
  const cexP = await fetchCEXPrice('binance', 'PEPE');
  console.log(`  Binance PEPE: $${cexP}`);
  console.log(`  GeckoTerminal PEPE pool: $${dexP}`);

  console.log('\n✅ Test complete. Sending Telegram test alert...');
  await sendTelegram(
    `🧪 *Arb Scanner Test*\n` +
    `BTC prices fetched from ${Object.keys(btcPrices).length} exchanges\n` +
    `Binance pairs loaded: ${priceFetched}\n` +
    `Funding rate assets: ${Object.keys(rates).length}\n` +
    `CEX-DEX PEPE: CEX $${cexP?.toFixed(8)} | DEX $${dexP?.toFixed(8)}\n` +
    `All systems operational ✅`
  );
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--test')) return await testMode();

  console.log('🚀 Unified Arb Scanner starting...');
  console.log(`CEX-CEX: ${ENABLE_CEX_CEX} | CEX-DEX: ${ENABLE_CEX_DEX} | Triangular: ${ENABLE_TRIANGULAR} | Funding: ${ENABLE_FUNDING_RATE}`);

  await sendStartupMessage();

  // Schedule each strategy independently
  if (ENABLE_CEX_CEX) {
    runCEXCEX().catch(console.error);
    setInterval(() => runCEXCEX().catch(console.error), CEX_POLL_SECONDS * 1000);
  }

  if (ENABLE_CEX_DEX) {
    setTimeout(() => {
      runCEXDEX().catch(console.error);
      setInterval(() => runCEXDEX().catch(console.error), DEX_POLL_SECONDS * 1000);
    }, 5000); // slight stagger
  }

  if (ENABLE_TRIANGULAR) {
    setTimeout(() => {
      runTriangular().catch(console.error);
      setInterval(() => runTriangular().catch(console.error), TRI_POLL_SECONDS * 1000);
    }, 10000);
  }

  if (ENABLE_FUNDING_RATE) {
    setTimeout(() => {
      runFundingRate().catch(console.error);
      setInterval(() => runFundingRate().catch(console.error), FUNDING_POLL_SECONDS * 1000);
    }, 15000);
  }

  console.log('✅ All strategies running. Watching for opportunities...');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
