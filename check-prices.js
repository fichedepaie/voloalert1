// ═══════════════════════════════════════════════
// VoLoAlert — GitHub Actions Price Checker
// Controlla prezzi voli con SerpApi e notifica Telegram
// ═══════════════════════════════════════════════

const https = require('https');
const fs = require('fs');

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SERPAPI_KEY     = process.env.SERPAPI_KEY;

const SYMS = {EUR:'€', USD:'$', GBP:'£', CHF:'Fr', MAD:'MAD', DZD:'DZD'};

// ═══════════════════════════════════════════════
// LEGGI ALERTS
// ═══════════════════════════════════════════════
let alerts = [];
try {
  alerts = JSON.parse(fs.readFileSync('alerts.json', 'utf8'));
  console.log(`✅ Caricati ${alerts.length} alert da alerts.json`);
} catch(e) {
  console.error('❌ alerts.json non trovato o non valido:', e.message);
  process.exit(1);
}

if (!alerts.length) {
  console.log('ℹ️ Nessun alert da controllare.');
  process.exit(0);
}

// ═══════════════════════════════════════════════
// FETCH HELPER
// ═══════════════════════════════════════════════
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ═══════════════════════════════════════════════
// INVIA MESSAGGIO TELEGRAM
// ═══════════════════════════════════════════════
function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) { console.log('✅ Telegram: messaggio inviato!'); resolve(true); }
          else { console.error('❌ Telegram error:', result.description); resolve(false); }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════
// CONTROLLA PREZZO CON SERPAPI
// ═══════════════════════════════════════════════
async function checkWithSerpApi(alert) {
  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: alert.o,
    arrival_id: alert.d,
    outbound_date: alert.dep,
    currency: alert.cur || 'EUR',
    hl: 'it',
    api_key: SERPAPI_KEY,
    type: alert.tripType === 'rt' ? '1' : '2'
  });
  if (alert.ret && alert.tripType === 'rt') {
    params.set('return_date', alert.ret);
  }

  const url = `https://serpapi.com/search.json?${params}`;
  console.log(`  🔍 SerpApi: ${alert.o} → ${alert.d} (${alert.dep})`);

  try {
    const data = await fetchJSON(url);
    if (data.error) {
      console.error('  ❌ SerpApi error:', data.error);
      return null;
    }
    const flights = [...(data.best_flights || []), ...(data.other_flights || [])];
    if (!flights.length) {
      console.log('  ℹ️ Nessun volo trovato.');
      return null;
    }
    const prices = flights
      .map(f => ({
        price: f.price,
        airline: (f.flights || [{}])[0].airline || 'N/D',
        stops: (f.flights || []).length - 1
      }))
      .filter(f => f.price)
      .sort((a, b) => a.price - b.price);

    return prices.length ? prices[0] : null;
  } catch(e) {
    console.error('  ❌ Errore fetch SerpApi:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════
// COSTRUISCI LINK GOOGLE FLIGHTS
// ═══════════════════════════════════════════════
function buildGFLink(a) {
  let url = `https://www.google.com/travel/flights#flt=${a.o}.${a.d}.${a.dep}`;
  if (a.ret && a.tripType === 'rt') url += `*${a.d}.${a.o}.${a.ret}`;
  url += `;c:EUR;e:1;sd:1;t:h`;
  return url;
}

// ═══════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════
async function main() {
  const now = new Date().toLocaleString('it-IT', {timeZone: 'Europe/Rome'});
  console.log(`\n🚀 VoLoAlert — Controllo del ${now}`);
  console.log(`📋 ${alerts.length} alert da controllare\n`);

  // Invia messaggio di avvio (opzionale, commentalo se vuoi meno notifiche)
  // await sendTelegram(`🔍 VoLoAlert sta controllando ${alerts.length} alert...`);

  let foundCount = 0;

  for (const alert of alerts) {
    const sym = SYMS[alert.cur] || alert.cur || '€';
    console.log(`\n📍 Alert: ${alert.o} → ${alert.d} | Soglia: ${sym}${alert.maxPrice}`);

    const result = await checkWithSerpApi(alert);

    if (!result) {
      console.log(`  ⚠️ Nessun risultato per ${alert.o} → ${alert.d}`);
      continue;
    }

    console.log(`  💰 Prezzo più basso: ${sym}${result.price} (${result.airline}, ${result.stops === 0 ? 'diretto' : result.stops + ' scalo/i'})`);

    if (result.price <= alert.maxPrice) {
      const risparmio = alert.maxPrice - result.price;
      const stopsText = result.stops === 0 ? '✈️ Volo diretto' : `🔄 ${result.stops} scalo/i`;
      const gfl = buildGFLink(alert);

      console.log(`  🎉 TROVATO SOTTO SOGLIA! Risparmio: ${sym}${risparmio}`);

      const msg =
        `🚨 <b>VOLO TROVATO SOTTO SOGLIA!</b>\n\n` +
        `✈️ <b>${alert.o} → ${alert.d}</b>\n` +
        `📅 Andata: ${alert.dep}\n` +
        (alert.ret ? `📅 Ritorno: ${alert.ret}\n` : '') +
        `💰 Prezzo trovato: <b>${sym}${result.price}</b>\n` +
        `🎯 Tua soglia: ${sym}${alert.maxPrice}\n` +
        `💚 Risparmi: <b>${sym}${risparmio}!</b>\n` +
        `🛫 Compagnia: ${result.airline}\n` +
        `${stopsText}\n` +
        (alert.note ? `📝 ${alert.note}\n` : '') +
        `\n👉 <a href="${gfl}">Prenota su Google Flights</a>\n\n` +
        `⏰ ${now}`;

      await sendTelegram(msg);
      foundCount++;
    } else {
      console.log(`  ℹ️ Prezzo ${sym}${result.price} ancora sopra soglia ${sym}${alert.maxPrice}`);
    }

    // Pausa tra le ricerche per non sovraccaricare l'API
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n✅ Controllo completato. Trovati: ${foundCount} voli sotto soglia.`);

  if (foundCount === 0) {
    console.log('ℹ️ Nessun volo sotto soglia al momento.');
  }
}

main().catch(e => {
  console.error('❌ Errore fatale:', e);
  process.exit(1);
});
