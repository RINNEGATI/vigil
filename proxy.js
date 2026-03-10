// ATLAS flight proxy — handles OpenSky OAuth2 from server side to avoid CORS
// Usage: node proxy.js
// Runs on http://localhost:3000

const https = require('https');
const http  = require('http');
const WebSocket = require('ws');
const fs    = require('fs');
const path  = require('path');

// ── DISK CACHE ────────────────────────────────────────────────────────────────
// Heavy/static datasets are written to disk so they survive proxy restarts.
// On startup these are read back into memory instantly.
const CACHE_DIR = path.join(__dirname, '.atlas-cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function diskCacheRead(key) {
  try {
    const metaPath = path.join(CACHE_DIR, key + '.meta.json');
    const dataPath = path.join(CACHE_DIR, key + '.dat');
    if (!fs.existsSync(metaPath) || !fs.existsSync(dataPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (Date.now() > meta.expires) return null;
    const data = fs.readFileSync(dataPath, 'utf8');
    console.log(`[cache] HIT ${key} (${Math.round(data.length/1024)}KB, expires ${new Date(meta.expires).toISOString()})`);
    return data;
  } catch(e) { return null; }
}

function diskCacheWrite(key, data, ttlMs) {
  try {
    const meta = { expires: Date.now() + ttlMs, written: new Date().toISOString(), size: data.length };
    fs.writeFileSync(path.join(CACHE_DIR, key + '.meta.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(CACHE_DIR, key + '.dat'), data, 'utf8');
    console.log(`[cache] WRITE ${key} (${Math.round(data.length/1024)}KB, ttl ${Math.round(ttlMs/3600000)}h)`);
  } catch(e) { console.warn('[cache] write error:', e.message); }
}

// ── IN-MEMORY CACHE ───────────────────────────────────────────────────────────
const memCache = {
  firms:       { data: null, ts: 0, ttl: 30 * 60 * 1000 },   // 30 min (fires update hourly)
  quakes:      { data: null, ts: 0, ttl: 10 * 60 * 1000 },   // 10 min
  datacenters: { data: null, ts: 0, ttl: 60 * 60 * 1000 },   // 1 hour
  buoys:       { data: null, ts: 0, ttl: 30 * 60 * 1000 },   // 30 min
};

// Legacy aliases kept for existing code
const cache = {
  datacenters:  memCache.datacenters,
  powerplants:  { data: null, ts: 0, ttl: 24 * 60 * 60 * 1000 },
};
let buoyCache = memCache.buoys;
const BUOY_TTL = memCache.buoys.ttl;

const CLIENT_ID     = process.env.OPENSKY_CLIENT_ID;
const CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;
const gdeltCache = {};

function httpsRequest(options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(timeoutMs || 20000, () => {
      req.destroy();
      reject(new Error('Timed out after ' + (timeoutMs || 20000) + 'ms'));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30000) {
    console.log('Using cached token');
    return cachedToken;
  }
  console.log('Fetching OAuth2 token...');
  const body = 'grant_type=client_credentials'
    + '&client_id='     + encodeURIComponent(CLIENT_ID)
    + '&client_secret=' + encodeURIComponent(CLIENT_SECRET);

  const res = await httpsRequest({
    hostname: 'auth.opensky-network.org',
    path: '/auth/realms/opensky-network/protocol/openid-connect/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body, 10000);

  console.log('Token status:', res.status);
  if (res.status !== 200) { console.error('Token body:', res.body); throw new Error('Token HTTP ' + res.status); }

  const data = JSON.parse(res.body);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  console.log('Token acquired, expires in', data.expires_in, 's');
  return cachedToken;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (!req.url.startsWith('/weather/') && !req.url.startsWith('/flights')) {
    console.log('[REQ]', req.url);
  }

  // Proxy weather radar tiles — /weather/* → tilecache.rainviewer.com/*
  if (req.url.startsWith('/weather/')) {
    const tilePath = req.url.replace('/weather', '');
    const tileReq = https.request({
      hostname: 'tilecache.rainviewer.com',
      path: tilePath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.rainviewer.com/',
        'Origin': 'https://www.rainviewer.com',
      },
    }, tileRes => {
      res.writeHead(tileRes.statusCode, {
        'Content-Type': tileRes.headers['content-type'] || 'image/png',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      });
      tileRes.pipe(res);
    });
    tileReq.on('error', e => { res.writeHead(500); res.end(); });
    tileReq.end();
    return;
  }

  // Proxy RainViewer API JSON
  if (req.url === '/rainviewer') {
    const apiReq = https.request({
      hostname: 'api.rainviewer.com',
      path: '/public/weather-maps.json',
      method: 'GET',
    }, apiRes => {
      let d = '';
      apiRes.on('data', c => d += c);
      apiRes.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
      });
    });
    apiReq.on('error', e => { res.writeHead(500); res.end(); });
    apiReq.end();
    return;
  }

  // ── RADIO BROWSER — stations with geo info, disk cached 1h ──────────────────
  if (req.url === '/radio') {
    const cacheKey = 'radio_stations';
    const cached = diskCacheRead(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' });
      res.end(cached);
      return;
    }
    console.log('[Radio] fetching stations with geo info...');
    const radioPath = '/json/stations/search?has_geo_info=true&lastcheckok=1&limit=5000&hidebroken=true&order=votes&reverse=true';
    const r = https.request({
      hostname: 'de1.api.radio-browser.info',
      path: radioPath, method: 'GET',
      headers: { 'User-Agent': 'Vigil/1.0', 'Content-Type': 'application/json' },
    }, upstream => {
      let d = '';
      upstream.on('data', c => d += c);
      upstream.on('end', () => {
        console.log(`[Radio] HTTP ${upstream.statusCode}, ${Math.round(d.length/1024)}KB`);
        if (upstream.statusCode === 200) diskCacheWrite(cacheKey, d, 60 * 60 * 1000);
        res.writeHead(upstream.statusCode === 200 ? 200 : 502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
      });
    });
    r.setTimeout(15000, () => { r.destroy(); res.writeHead(504); res.end('timeout'); });
    r.on('error', e => { res.writeHead(502); res.end(e.message); });
    r.end();
    return;
  }

  // ── OPENFLIGHTS STATIC DATA — airports + routes, disk cached 30 days ────────
  if (req.url === '/openflights/airports' || req.url === '/openflights/routes') {
    const isAirports = req.url === '/openflights/airports';
    const cacheKey   = isAirports ? 'openflights_airports' : 'openflights_routes';
    const ghPath     = isAirports
      ? '/jpatokal/openflights/master/data/airports.dat'
      : '/jpatokal/openflights/master/data/routes.dat';

    const cached = diskCacheRead(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' });
      res.end(cached);
      return;
    }
    console.log(`[OpenFlights] fetching ${isAirports ? 'airports' : 'routes'}...`);
    const r = https.request({
      hostname: 'raw.githubusercontent.com', path: ghPath, method: 'GET',
      headers: { 'User-Agent': 'ATLAS/1.0' },
    }, upstream => {
      let d = '';
      upstream.on('data', c => d += c);
      upstream.on('end', () => {
        console.log(`[OpenFlights] ${isAirports ? 'airports' : 'routes'}: ${Math.round(d.length/1024)}KB, HTTP ${upstream.statusCode}`);
        if (upstream.statusCode === 200) diskCacheWrite(cacheKey, d, 30 * 24 * 60 * 60 * 1000);
        res.writeHead(upstream.statusCode === 200 ? 200 : 502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
      });
    });
    r.setTimeout(15000, () => { r.destroy(); res.writeHead(504); res.end('timeout'); });
    r.on('error', e => { res.writeHead(502); res.end(e.message); });
    r.end();
    return;
  }

  // Proxy Celestrak TLE data — disk cached 6h (TLEs update ~daily)
  if (req.url.startsWith('/celestrak/')) {
    const group = req.url.replace('/celestrak/', '').split('?')[0];
    const cacheKey = 'tle_' + group;
    const cached = diskCacheRead(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' });
      res.end(cached);
      return;
    }
    const tlePath = `/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
    console.log('Fetching TLEs:', tlePath);
    const tleReq = https.request({
      hostname: 'celestrak.org', path: tlePath, method: 'GET',
      headers: { 'User-Agent': 'ATLAS/1.0', 'Accept': 'text/plain' },
    }, tleRes => {
      let d = '';
      tleRes.on('data', c => d += c);
      tleRes.on('end', () => {
        console.log('Celestrak status:', tleRes.statusCode, '| bytes:', d.length);
        if (tleRes.statusCode === 200) diskCacheWrite(cacheKey, d, 6 * 60 * 60 * 1000);
        res.writeHead(tleRes.statusCode, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
      });
    });
    tleReq.setTimeout(15000, () => { tleReq.destroy(); res.writeHead(504); res.end('TLE timeout'); });
    tleReq.on('error', e => { console.error('TLE error:', e.message); res.writeHead(500); res.end(e.message); });
    tleReq.end();
    return;
  }

  // GDELT DOC 2.0 API — news articles by keyword, cached 15 min to avoid rate limits
  if (req.url.startsWith('/gdelt')) {
    const query = decodeURIComponent((req.url.split('query=')[1] || 'disaster').split('&')[0]);

    // Serve from cache if fresh
    const cacheKey = 'gdelt:' + query;
    const cached = gdeltCache[cacheKey];
    if (cached && Date.now() - cached.ts < 15 * 60 * 1000) {
      console.log('GDELT cache hit:', query);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(cached.data);
      return;
    }

    // v1 GKG GeoJSON — use GDELT theme codes for reliable results, last 6 hours
    const gdeltPath = '/api/v1/gkg_geojson?QUERY=' + encodeURIComponent(query)
      + '&TIMESPAN=360';
    console.log('GDELT fetch:', query);
    const gdeltReq = https.request({
      hostname: 'api.gdeltproject.org',
      path: gdeltPath,
      method: 'GET',
      headers: { 'User-Agent': 'ATLAS/1.0', 'Accept': 'application/json' },
    }, gdeltRes => {
      let d = '';
      gdeltRes.on('data', c => d += c);
      gdeltRes.on('end', () => {
        console.log('GDELT', query, 'status:', gdeltRes.statusCode, '| bytes:', d.length);
        if (gdeltRes.statusCode === 200) gdeltCache[cacheKey] = { ts: Date.now(), data: d };
        res.writeHead(gdeltRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=900',
        });
        res.end(d);
      });
    });
    gdeltReq.setTimeout(15000, () => { gdeltReq.destroy(); res.writeHead(504); res.end('GDELT timeout'); });
    gdeltReq.on('error', e => { console.error('GDELT error:', e.message); res.writeHead(500); res.end(e.message); });
    gdeltReq.end();
    return;
  }

  // ── WINDY WEBCAMS (curated) ────────────────────────────────────────────────
  if (req.url.startsWith('/webcams')) {
    const WINDY_KEY = process.env.WINDY_API_KEY;

    // Single-cam lookup (for live player re-fetch)
    const singleMatch = req.url.match(/^\/webcams\/api\/v3\/webcams\/(\d+)(\?.*)?$/);
    if (singleMatch) {
      const windyPath = '/webcams/api/v3/webcams/' + singleMatch[1] + (singleMatch[2] || '?include=player');
      console.log('[Windy] single cam fetch:', windyPath);
      const windyReq = https.request({
        hostname: 'api.windy.com', path: windyPath, method: 'GET',
        headers: { 'x-windy-api-key': WINDY_KEY, 'User-Agent': 'ATLAS/1.0', 'Accept': 'application/json' },
      }, windyRes => {
        let d = '';
        windyRes.on('data', c => d += c);
        windyRes.on('end', () => {
          res.writeHead(windyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
          res.end(d);
        });
      });
      windyReq.setTimeout(15000, () => { windyReq.destroy(); res.writeHead(504); res.end('timeout'); });
      windyReq.on('error', e => { res.writeHead(500); res.end(e.message); });
      windyReq.end();
      return;
    }

    // Curated multi-query: Ottawa (priority) + major city landmarks
    // nearby=lat,lon,radius_km  sortKey=popularity  limit=10 each
    const QUERIES = [
      // Ottawa — generous radius to catch all city cams
      { label: 'Ottawa',        nearby: '45.4215,-75.6972,20',  limit: 15 },
      // Major world landmark cities
      { label: 'New York',      nearby: '40.7128,-74.0060,8',   limit: 4 },
      { label: 'London',        nearby: '51.5074,-0.1278,8',    limit: 4 },
      { label: 'Paris',         nearby: '48.8566,2.3522,8',     limit: 3 },
      { label: 'Tokyo',         nearby: '35.6762,139.6503,8',   limit: 3 },
      { label: 'Sydney',        nearby: '-33.8688,151.2093,8',  limit: 3 },
      { label: 'Dubai',         nearby: '25.2048,55.2708,8',    limit: 2 },
      { label: 'Rome',          nearby: '41.9028,12.4964,8',    limit: 2 },
      { label: 'Barcelona',     nearby: '41.3851,2.1734,8',     limit: 2 },
      { label: 'NYC Times Sq',  nearby: '40.7580,-73.9855,3',   limit: 2 },
      { label: 'San Francisco', nearby: '37.7749,-122.4194,8',  limit: 2 },
      { label: 'Chicago',       nearby: '41.8781,-87.6298,8',   limit: 2 },
      { label: 'Toronto',       nearby: '43.6532,-79.3832,8',   limit: 2 },
      { label: 'Amsterdam',     nearby: '52.3676,4.9041,8',     limit: 2 },
      { label: 'Singapore',     nearby: '1.3521,103.8198,8',    limit: 2 },
    ];

    // Helper: fetch one nearby query from Windy
    function windyFetch(label, nearby, limit) {
      return new Promise((resolve) => {
        const path = `/webcams/api/v3/webcams?nearby=${nearby}&limit=${limit}&sortKey=popularity&sortDirection=desc&include=location,player,categories`;
        console.log(`[Windy] querying ${label}: ${path}`);
        const r = https.request({
          hostname: 'api.windy.com', path, method: 'GET',
          headers: { 'x-windy-api-key': WINDY_KEY, 'User-Agent': 'ATLAS/1.0', 'Accept': 'application/json' },
        }, windyRes => {
          let d = '';
          windyRes.on('data', c => d += c);
          windyRes.on('end', () => {
            console.log(`[Windy] ${label} → HTTP ${windyRes.statusCode}, ${d.length} bytes`);
            if (windyRes.statusCode !== 200) {
              console.log(`[Windy] ${label} error body:`, d.slice(0, 200));
              resolve([]);
              return;
            }
            try {
              const json = JSON.parse(d);
              console.log(`[Windy] ${label} → ${(json.webcams||[]).length} cams`);
              resolve(json.webcams || []);
            } catch(e) {
              console.log(`[Windy] ${label} JSON parse error:`, e.message);
              resolve([]);
            }
          });
        });
        r.setTimeout(12000, () => { console.log(`[Windy] ${label} timed out`); r.destroy(); resolve([]); });
        r.on('error', e => { console.log(`[Windy] ${label} error:`, e.message); resolve([]); });
        r.end();
      });
    }

    // Run sequentially with small delay to avoid rate limiting
    async function fetchAll() {
      const results = [];
      for (const q of QUERIES) {
        const cams = await windyFetch(q.label, q.nearby, q.limit);
        results.push(cams);
        await new Promise(r => setTimeout(r, 150)); // 150ms between requests
      }
      return results;
    }

    fetchAll().then(results => {
      // Log first cam structure to diagnose field names
      const firstBatch = results.find(b => b.length > 0);
      if (firstBatch) {
        const sample = firstBatch[0];
        console.log('[Windy] sample cam keys:', Object.keys(sample).join(', '));
        console.log('[Windy] sample cam id fields:', JSON.stringify({ id: sample.id, webcamId: sample.webcamId, title: sample.title }));
        console.log('[Windy] sample location:', JSON.stringify(sample.location));
      }

      // Flatten, deduplicate — v3 uses webcamId as the unique key
      const seen = new Set();
      const cams = [];
      for (const batch of results) {
        for (const cam of batch) {
          const uid = cam.webcamId || cam.id || cam.title;
          if (uid && !seen.has(uid)) {
            seen.add(uid);
            cams.push(cam);
          }
        }
      }
      // Only filter out cams with absolutely no location data
      const filtered = cams.filter(c => c.location);
      console.log(`[Windy] curated: ${filtered.length} cams after dedup (raw total: ${results.reduce((s,b)=>s+b.length,0)})`);
      const out = JSON.stringify({ webcams: filtered.slice(0, 50) });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(out);
    }).catch(e => {
      console.error('[Windy] curated fetch error:', e.message);
      res.writeHead(500); res.end('error');
    });
    return;
  }

  // GPSJam.org — daily CSV of GPS jamming zones from ADS-B data
  if (req.url.startsWith('/gpsjam')) {
    const date = (req.url.split('date=')[1] || new Date().toISOString().slice(0,10)).split('&')[0];
    console.log('GPSJam fetch for date:', date);
    const jamReq = https.request({
      hostname: 'gpsjam.org',
      path: '/data/' + date + '.csv',
      method: 'GET',
      headers: { 'User-Agent': 'ATLAS/1.0' },
    }, jamRes => {
      let d = '';
      jamRes.on('data', c => d += c);
      jamRes.on('end', () => {
        console.log('GPSJam status:', jamRes.statusCode, '| bytes:', d.length);
        res.writeHead(jamRes.statusCode, {
          'Content-Type': 'text/csv',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=21600', // 6h cache — data is daily
        });
        res.end(d);
      });
    });
    jamReq.setTimeout(15000, () => { jamReq.destroy(); res.writeHead(504); res.end('GPSJam timeout'); });
    jamReq.on('error', e => { console.error('GPSJam error:', e.message); res.writeHead(500); res.end(e.message); });
    jamReq.end();
    return;
  }

  // Submarine cable data — cables and landing points from TeleGeography
  if (req.url === '/cables' || req.url === '/landing-points') {
    const path = req.url === '/cables'
      ? '/api/v3/cable/cable-geo.json'
      : '/api/v3/landing-point/landing-point-geo.json';
    const cableReq = https.request({
      hostname: 'www.submarinecablemap.com',
      path,
      method: 'GET',
      headers: { 'User-Agent': 'ATLAS/1.0' },
    }, cableRes => {
      let d = '';
      cableRes.on('data', c => d += c);
      cableRes.on('end', () => {
        console.log('Cables', req.url, 'status:', cableRes.statusCode, '| bytes:', d.length);
        res.writeHead(cableRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400', // cables change rarely — cache 24h
        });
        res.end(d);
      });
    });
    cableReq.setTimeout(15000, () => { cableReq.destroy(); res.writeHead(504); res.end('Cable timeout'); });
    cableReq.on('error', e => { console.error('Cable error:', e.message); res.writeHead(500); res.end(e.message); });
    cableReq.end();
    return;
  }

  // Data Centers — curated static dataset of major global facilities
  if (req.url === '/datacenters') {
    const elements = [
      // ── United States ──
      {id:1,lat:38.9354,lon:-77.4752,tags:{name:'Ashburn Data Center Campus',operator:'Equinix',telecom:'data_center'}},
      {id:2,lat:38.8816,lon:-77.4429,tags:{name:'Digital Loudoun County',operator:'Digital Realty',telecom:'data_center'}},
      {id:3,lat:38.9073,lon:-77.4294,tags:{name:'Equinix DC1-DC15 Ashburn',operator:'Equinix',telecom:'data_center'}},
      {id:4,lat:37.3382,lon:-121.8863,tags:{name:'Equinix SV1 San Jose',operator:'Equinix',telecom:'data_center'}},
      {id:5,lat:37.7749,lon:-122.4194,tags:{name:'Equinix SV5 San Jose',operator:'Equinix',telecom:'data_center'}},
      {id:6,lat:40.7128,lon:-74.0060,tags:{name:'Equinix NY2 New York',operator:'Equinix',telecom:'data_center'}},
      {id:7,lat:41.8781,lon:-87.6298,tags:{name:'Equinix CH1 Chicago',operator:'Equinix',telecom:'data_center'}},
      {id:8,lat:33.4484,lon:-112.0740,tags:{name:'CyrusOne Phoenix',operator:'CyrusOne',telecom:'data_center'}},
      {id:9,lat:47.6062,lon:-122.3321,tags:{name:'Equinix SE2 Seattle',operator:'Equinix',telecom:'data_center'}},
      {id:10,lat:33.7490,lon:-84.3880,tags:{name:'Equinix AT1 Atlanta',operator:'Equinix',telecom:'data_center'}},
      {id:11,lat:30.2672,lon:-97.7431,tags:{name:'Equinix DA1 Dallas',operator:'Equinix',telecom:'data_center'}},
      {id:12,lat:25.7617,lon:-80.1918,tags:{name:'NAP of the Americas Miami',operator:'Equinix',telecom:'data_center'}},
      {id:13,lat:34.0522,lon:-118.2437,tags:{name:'Equinix LA1 Los Angeles',operator:'Equinix',telecom:'data_center'}},
      {id:14,lat:39.9526,lon:-75.1652,tags:{name:'Equinix PH1 Philadelphia',operator:'Equinix',telecom:'data_center'}},
      {id:15,lat:42.3601,lon:-71.0589,tags:{name:'Equinix BO1 Boston',operator:'Equinix',telecom:'data_center'}},
      {id:16,lat:36.1699,lon:-115.1398,tags:{name:'Switch SUPERNAP Las Vegas',operator:'Switch',telecom:'data_center'}},
      {id:17,lat:45.5051,lon:-122.6750,tags:{name:'Pittock Block Portland',operator:'Flexential',telecom:'data_center'}},
      {id:18,lat:39.7392,lon:-104.9903,tags:{name:'Zayo Denver',operator:'Zayo',telecom:'data_center'}},
      {id:19,lat:32.7767,lon:-96.7970,tags:{name:'CyrusOne Dallas',operator:'CyrusOne',telecom:'data_center'}},
      {id:20,lat:29.7604,lon:-95.3698,tags:{name:'CyrusOne Houston',operator:'CyrusOne',telecom:'data_center'}},
      // AWS regions
      {id:21,lat:39.0458,lon:-77.4875,tags:{name:'AWS us-east-1 (N. Virginia)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:22,lat:45.5234,lon:-122.6762,tags:{name:'AWS us-west-2 (Oregon)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:23,lat:37.4419,lon:-122.1430,tags:{name:'AWS us-west-1 (N. California)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:24,lat:33.7490,lon:-84.3880,tags:{name:'AWS us-east-2 (Ohio)',operator:'Amazon Web Services',telecom:'data_center'}},
      // Google
      {id:25,lat:41.2619,lon:-95.8608,tags:{name:'Google Council Bluffs',operator:'Google',telecom:'data_center'}},
      {id:26,lat:33.1581,lon:-97.1409,tags:{name:'Google Midlothian',operator:'Google',telecom:'data_center'}},
      {id:27,lat:32.8140,lon:-96.9489,tags:{name:'Google Dallas',operator:'Google',telecom:'data_center'}},
      {id:28,lat:45.5946,lon:-121.1787,tags:{name:'Google The Dalles',operator:'Google',telecom:'data_center'}},
      {id:29,lat:37.4220,lon:-122.0841,tags:{name:'Google Mountain View',operator:'Google',telecom:'data_center'}},
      // Microsoft Azure
      {id:30,lat:47.6740,lon:-122.1215,tags:{name:'Microsoft Azure West US',operator:'Microsoft',telecom:'data_center'}},
      {id:31,lat:41.8781,lon:-87.6298,tags:{name:'Microsoft Azure North Central US',operator:'Microsoft',telecom:'data_center'}},
      {id:32,lat:38.9072,lon:-77.0369,tags:{name:'Microsoft Azure East US',operator:'Microsoft',telecom:'data_center'}},
      // ── Europe ──
      {id:50,lat:52.3676,lon:4.9041,tags:{name:'AMS-IX Amsterdam',operator:'AMS-IX',telecom:'data_center'}},
      {id:51,lat:52.3105,lon:4.7683,tags:{name:'Equinix AM1 Amsterdam',operator:'Equinix',telecom:'data_center'}},
      {id:52,lat:50.1109,lon:8.6821,tags:{name:'Equinix FR2 Frankfurt',operator:'Equinix',telecom:'data_center'}},
      {id:53,lat:50.1155,lon:8.7003,tags:{name:'DE-CIX Frankfurt',operator:'DE-CIX',telecom:'data_center'}},
      {id:54,lat:51.5074,lon:-0.1278,tags:{name:'Equinix LD4 London Slough',operator:'Equinix',telecom:'data_center'}},
      {id:55,lat:51.4600,lon:-0.5250,tags:{name:'Telehouse West London',operator:'Telehouse',telecom:'data_center'}},
      {id:56,lat:48.8566,lon:2.3522,tags:{name:'Equinix PA2 Paris',operator:'Equinix',telecom:'data_center'}},
      {id:57,lat:59.3293,lon:18.0686,tags:{name:'Equinix SK1 Stockholm',operator:'Equinix',telecom:'data_center'}},
      {id:58,lat:55.6761,lon:12.5683,tags:{name:'Equinix CO1 Copenhagen',operator:'Equinix',telecom:'data_center'}},
      {id:59,lat:53.3498,lon:-6.2603,tags:{name:'Equinix DB1 Dublin',operator:'Equinix',telecom:'data_center'}},
      {id:60,lat:41.3851,lon:2.1734,tags:{name:'Equinix MD2 Madrid',operator:'Equinix',telecom:'data_center'}},
      {id:61,lat:45.4654,lon:9.1859,tags:{name:'Equinix ML1 Milan',operator:'Equinix',telecom:'data_center'}},
      {id:62,lat:52.2297,lon:21.0122,tags:{name:'Equinix WA1 Warsaw',operator:'Equinix',telecom:'data_center'}},
      {id:63,lat:48.2082,lon:16.3738,tags:{name:'Interxion VIE1 Vienna',operator:'Interxion',telecom:'data_center'}},
      {id:64,lat:47.3769,lon:8.5417,tags:{name:'Equinix ZH1 Zurich',operator:'Equinix',telecom:'data_center'}},
      {id:65,lat:60.1699,lon:24.9384,tags:{name:'Hetzner Helsinki',operator:'Hetzner',telecom:'data_center'}},
      {id:66,lat:49.0069,lon:8.4037,tags:{name:'Hetzner Karlsruhe',operator:'Hetzner',telecom:'data_center'}},
      {id:67,lat:48.1351,lon:11.5820,tags:{name:'Equinix MU1 Munich',operator:'Equinix',telecom:'data_center'}},
      {id:68,lat:51.2217,lon:4.4025,tags:{name:'LCL Antwerp',operator:'LCL',telecom:'data_center'}},
      {id:69,lat:50.8503,lon:4.3517,tags:{name:'Interxion BRU1 Brussels',operator:'Interxion',telecom:'data_center'}},
      // AWS Europe
      {id:70,lat:53.3498,lon:-6.2603,tags:{name:'AWS eu-west-1 (Ireland)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:71,lat:50.1109,lon:8.6821,tags:{name:'AWS eu-central-1 (Frankfurt)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:72,lat:51.5074,lon:-0.1278,tags:{name:'AWS eu-west-2 (London)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:73,lat:48.8566,lon:2.3522,tags:{name:'AWS eu-west-3 (Paris)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:74,lat:59.3293,lon:18.0686,tags:{name:'AWS eu-north-1 (Stockholm)',operator:'Amazon Web Services',telecom:'data_center'}},
      // ── Asia Pacific ──
      {id:100,lat:1.3521,lon:103.8198,tags:{name:'Equinix SG1 Singapore',operator:'Equinix',telecom:'data_center'}},
      {id:101,lat:1.2966,lon:103.8006,tags:{name:'Global Switch Singapore',operator:'Global Switch',telecom:'data_center'}},
      {id:102,lat:35.6762,lon:139.6503,tags:{name:'Equinix TY1 Tokyo',operator:'Equinix',telecom:'data_center'}},
      {id:103,lat:35.6762,lon:139.6503,tags:{name:'NTT Tokyo Data Center',operator:'NTT',telecom:'data_center'}},
      {id:104,lat:37.5665,lon:126.9780,tags:{name:'KT IDC Seoul',operator:'KT',telecom:'data_center'}},
      {id:105,lat:22.3193,lon:114.1694,tags:{name:'Equinix HK1 Hong Kong',operator:'Equinix',telecom:'data_center'}},
      {id:106,lat:25.0330,lon:121.5654,tags:{name:'Equinix TP1 Taipei',operator:'Equinix',telecom:'data_center'}},
      {id:107,lat:19.0760,lon:72.8777,tags:{name:'Equinix MB1 Mumbai',operator:'Equinix',telecom:'data_center'}},
      {id:108,lat:12.9716,lon:77.5946,tags:{name:'Equinix BL1 Bangalore',operator:'Equinix',telecom:'data_center'}},
      {id:109,lat:-33.8688,lon:151.2093,tags:{name:'Equinix SY1 Sydney',operator:'Equinix',telecom:'data_center'}},
      {id:110,lat:-37.8136,lon:144.9631,tags:{name:'Equinix ME1 Melbourne',operator:'Equinix',telecom:'data_center'}},
      {id:111,lat:13.7563,lon:100.5018,tags:{name:'AIS Datacenter Bangkok',operator:'AIS',telecom:'data_center'}},
      {id:112,lat:3.1390,lon:101.6869,tags:{name:'CX1 Kuala Lumpur',operator:'CX',telecom:'data_center'}},
      {id:113,lat:31.2304,lon:121.4737,tags:{name:'Equinix SH2 Shanghai',operator:'Equinix',telecom:'data_center'}},
      {id:114,lat:39.9042,lon:116.4074,tags:{name:'GDS Beijing Data Center',operator:'GDS',telecom:'data_center'}},
      {id:115,lat:22.5431,lon:114.0579,tags:{name:'GDS Shenzhen',operator:'GDS',telecom:'data_center'}},
      {id:116,lat:34.6937,lon:135.5023,tags:{name:'Equinix OS1 Osaka',operator:'Equinix',telecom:'data_center'}},
      // AWS APAC
      {id:117,lat:1.3521,lon:103.8198,tags:{name:'AWS ap-southeast-1 (Singapore)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:118,lat:35.6762,lon:139.6503,tags:{name:'AWS ap-northeast-1 (Tokyo)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:119,lat:37.5665,lon:126.9780,tags:{name:'AWS ap-northeast-2 (Seoul)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:120,lat:-33.8688,lon:151.2093,tags:{name:'AWS ap-southeast-2 (Sydney)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:121,lat:19.0760,lon:72.8777,tags:{name:'AWS ap-south-1 (Mumbai)',operator:'Amazon Web Services',telecom:'data_center'}},
      // ── Middle East & Africa ──
      {id:150,lat:25.2048,lon:55.2708,tags:{name:'Equinix DX1 Dubai',operator:'Equinix',telecom:'data_center'}},
      {id:151,lat:24.7136,lon:46.6753,tags:{name:'STC Cloud Riyadh',operator:'STC',telecom:'data_center'}},
      {id:152,lat:30.0444,lon:31.2357,tags:{name:'Equinix CA1 Cairo',operator:'Equinix',telecom:'data_center'}},
      {id:153,lat:-26.2041,lon:28.0473,tags:{name:'Teraco JB1 Johannesburg',operator:'Teraco',telecom:'data_center'}},
      {id:154,lat:-33.9249,lon:18.4241,tags:{name:'Teraco CT1 Cape Town',operator:'Teraco',telecom:'data_center'}},
      {id:155,lat:32.0853,lon:34.7818,tags:{name:'Equinix TA1 Tel Aviv',operator:'Equinix',telecom:'data_center'}},
      {id:156,lat:26.0667,lon:50.5577,tags:{name:'Batelco Bahrain',operator:'Batelco',telecom:'data_center'}},
      // ── South America ──
      {id:170,lat:-23.5505,lon:-46.6333,tags:{name:'Equinix SP1 Sao Paulo',operator:'Equinix',telecom:'data_center'}},
      {id:171,lat:-22.9068,lon:-43.1729,tags:{name:'Equinix RJ1 Rio de Janeiro',operator:'Equinix',telecom:'data_center'}},
      {id:172,lat:-34.6037,lon:-58.3816,tags:{name:'NAP Argentina Buenos Aires',operator:'NAP',telecom:'data_center'}},
      {id:173,lat:-33.4489,lon:-70.6693,tags:{name:'Entel Santiago',operator:'Entel',telecom:'data_center'}},
      {id:174,lat:4.7110,lon:-74.0721,tags:{name:'ETB Bogota',operator:'ETB',telecom:'data_center'}},
      // AWS South America
      {id:175,lat:-23.5505,lon:-46.6333,tags:{name:'AWS sa-east-1 (Sao Paulo)',operator:'Amazon Web Services',telecom:'data_center'}},
      // ── Canada ──
      {id:180,lat:43.6532,lon:-79.3832,tags:{name:'Equinix TR1 Toronto',operator:'Equinix',telecom:'data_center'}},
      {id:181,lat:45.5017,lon:-73.5673,tags:{name:'Equinix MR1 Montreal',operator:'Equinix',telecom:'data_center'}},
      {id:182,lat:49.2827,lon:-123.1207,tags:{name:'Cologix VAN1 Vancouver',operator:'Cologix',telecom:'data_center'}},
      {id:183,lat:51.0447,lon:-114.0719,tags:{name:'Shaw Calgary',operator:'Shaw',telecom:'data_center'}},
      // ── More US ──
      {id:200,lat:38.9072,lon:-77.0369,tags:{name:'Equinix DC2 Washington DC',operator:'Equinix',telecom:'data_center'}},
      {id:201,lat:38.8048,lon:-77.0469,tags:{name:'CyrusOne Northern Virginia',operator:'CyrusOne',telecom:'data_center'}},
      {id:202,lat:38.9687,lon:-77.3411,tags:{name:'Iron Mountain Manassas',operator:'Iron Mountain',telecom:'data_center'}},
      {id:203,lat:39.0183,lon:-77.5388,tags:{name:'DLR Ashburn campus',operator:'Digital Realty',telecom:'data_center'}},
      {id:204,lat:37.6879,lon:-97.3376,tags:{name:'ViaWest Wichita',operator:'ViaWest',telecom:'data_center'}},
      {id:205,lat:35.2271,lon:-80.8431,tags:{name:'Peak 10 Charlotte',operator:'Peak 10',telecom:'data_center'}},
      {id:206,lat:36.1627,lon:-86.7816,tags:{name:'Lifeline Nashville',operator:'Lifeline',telecom:'data_center'}},
      {id:207,lat:39.9612,lon:-82.9988,tags:{name:'Cologix COL1 Columbus',operator:'Cologix',telecom:'data_center'}},
      {id:208,lat:43.0481,lon:-76.1474,tags:{name:'Expedient Syracuse',operator:'Expedient',telecom:'data_center'}},
      {id:209,lat:44.9778,lon:-93.2650,tags:{name:'Databank MSP1 Minneapolis',operator:'DataBank',telecom:'data_center'}},
      {id:210,lat:29.9511,lon:-90.0715,tags:{name:'Navisite New Orleans',operator:'Navisite',telecom:'data_center'}},
      {id:211,lat:35.4676,lon:-97.5164,tags:{name:'Databank OKC1 Oklahoma City',operator:'DataBank',telecom:'data_center'}},
      {id:212,lat:32.2226,lon:-110.9747,tags:{name:'IO Tucson',operator:'IO',telecom:'data_center'}},
      {id:213,lat:40.7608,lon:-111.8910,tags:{name:'Novva Salt Lake City',operator:'Novva',telecom:'data_center'}},
      {id:214,lat:39.7392,lon:-104.9903,tags:{name:'Flexential Denver',operator:'Flexential',telecom:'data_center'}},
      {id:215,lat:35.7796,lon:-78.6382,tags:{name:'Flexential Raleigh',operator:'Flexential',telecom:'data_center'}},
      {id:216,lat:30.3322,lon:-81.6557,tags:{name:'Datasite Jacksonville',operator:'Datasite',telecom:'data_center'}},
      {id:217,lat:27.9506,lon:-82.4572,tags:{name:'Databank TPA1 Tampa',operator:'DataBank',telecom:'data_center'}},
      {id:218,lat:26.1224,lon:-80.1373,tags:{name:'Equinix MI1 Miami',operator:'Equinix',telecom:'data_center'}},
      {id:219,lat:21.3069,lon:-157.8583,tags:{name:'Paniolo Cable Honolulu',operator:'Paniolo',telecom:'data_center'}},
      {id:220,lat:61.2181,lon:-149.9003,tags:{name:'GCI Anchorage',operator:'GCI',telecom:'data_center'}},
      // Google extra
      {id:221,lat:33.0198,lon:-97.2888,tags:{name:'Google Fort Worth',operator:'Google',telecom:'data_center'}},
      {id:222,lat:34.0195,lon:-84.4829,tags:{name:'Google Clarksville',operator:'Google',telecom:'data_center'}},
      {id:223,lat:41.5868,lon:-93.6250,tags:{name:'Google Altoona',operator:'Google',telecom:'data_center'}},
      {id:224,lat:43.0481,lon:-89.4012,tags:{name:'Google Madison',operator:'Google',telecom:'data_center'}},
      {id:225,lat:35.0456,lon:-85.3097,tags:{name:'Google Bridgeport',operator:'Google',telecom:'data_center'}},
      {id:226,lat:39.5501,lon:-105.7821,tags:{name:'Google Henderson',operator:'Google',telecom:'data_center'}},
      // Microsoft Azure extra
      {id:230,lat:37.3382,lon:-121.8863,tags:{name:'Microsoft Azure West US 2',operator:'Microsoft',telecom:'data_center'}},
      {id:231,lat:29.7604,lon:-95.3698,tags:{name:'Microsoft Azure South Central US',operator:'Microsoft',telecom:'data_center'}},
      {id:232,lat:35.2271,lon:-80.8431,tags:{name:'Microsoft Azure East US 2',operator:'Microsoft',telecom:'data_center'}},
      {id:233,lat:44.9778,lon:-93.2650,tags:{name:'Microsoft Azure North Central US 2',operator:'Microsoft',telecom:'data_center'}},
      // ── More Europe ──
      {id:250,lat:53.4808,lon:-2.2426,tags:{name:'Equinix MA1 Manchester',operator:'Equinix',telecom:'data_center'}},
      {id:251,lat:55.8642,lon:-4.2518,tags:{name:'Equinix GL1 Glasgow',operator:'Equinix',telecom:'data_center'}},
      {id:252,lat:51.4545,lon:-2.5879,tags:{name:'Vantage Bristol',operator:'Vantage',telecom:'data_center'}},
      {id:253,lat:53.8008,lon:-1.5491,tags:{name:'Node4 Leeds',operator:'Node4',telecom:'data_center'}},
      {id:254,lat:52.4862,lon:-1.8904,tags:{name:'Pulsant Birmingham',operator:'Pulsant',telecom:'data_center'}},
      {id:255,lat:50.8229,lon:12.9242,tags:{name:'Telehouse Leipzig',operator:'Telehouse',telecom:'data_center'}},
      {id:256,lat:53.5753,lon:10.0153,tags:{name:'Interxion HAM1 Hamburg',operator:'Interxion',telecom:'data_center'}},
      {id:257,lat:51.0504,lon:13.7373,tags:{name:'Interxion DRS1 Dresden',operator:'Interxion',telecom:'data_center'}},
      {id:258,lat:48.5734,lon:7.7521,tags:{name:'Interxion STR1 Strasbourg',operator:'Interxion',telecom:'data_center'}},
      {id:259,lat:43.2965,lon:5.3698,tags:{name:'Interxion MRS1 Marseille',operator:'Interxion',telecom:'data_center'}},
      {id:260,lat:45.7640,lon:4.8357,tags:{name:'Interxion LYO1 Lyon',operator:'Interxion',telecom:'data_center'}},
      {id:261,lat:44.8378,lon:-0.5792,tags:{name:'SFR Bordeaux',operator:'SFR',telecom:'data_center'}},
      {id:262,lat:40.4168,lon:-3.7038,tags:{name:'Interxion MAD2 Madrid',operator:'Interxion',telecom:'data_center'}},
      {id:263,lat:41.1579,lon:-8.6291,tags:{name:'Equinix LS1 Lisbon',operator:'Equinix',telecom:'data_center'}},
      {id:264,lat:40.6401,lon:22.9444,tags:{name:'Lamda Helix Athens',operator:'Lamda Helix',telecom:'data_center'}},
      {id:265,lat:44.4268,lon:26.1025,tags:{name:'M247 Bucharest',operator:'M247',telecom:'data_center'}},
      {id:266,lat:42.6977,lon:23.3219,tags:{name:'Telepoint Sofia',operator:'Telepoint',telecom:'data_center'}},
      {id:267,lat:47.4979,lon:19.0402,tags:{name:'Equinix BU1 Budapest',operator:'Equinix',telecom:'data_center'}},
      {id:268,lat:50.0755,lon:14.4378,tags:{name:'Sify Prague',operator:'Sify',telecom:'data_center'}},
      {id:269,lat:59.9139,lon:10.7522,tags:{name:'Green Mountain NO1 Oslo',operator:'Green Mountain',telecom:'data_center'}},
      {id:270,lat:60.1674,lon:24.9427,tags:{name:'Equinix HE1 Helsinki',operator:'Equinix',telecom:'data_center'}},
      {id:271,lat:56.9496,lon:24.1052,tags:{name:'Tet Riga',operator:'Tet',telecom:'data_center'}},
      {id:272,lat:54.6872,lon:25.2797,tags:{name:'Data Logistics Center Vilnius',operator:'DLC',telecom:'data_center'}},
      {id:273,lat:59.4370,lon:24.7536,tags:{name:'Telia Tallinn',operator:'Telia',telecom:'data_center'}},
      {id:274,lat:52.2297,lon:21.0122,tags:{name:'Comarch Warsaw',operator:'Comarch',telecom:'data_center'}},
      {id:275,lat:50.0647,lon:19.9450,tags:{name:'Atman Krakow',operator:'Atman',telecom:'data_center'}},
      {id:276,lat:46.9480,lon:7.4474,tags:{name:'Safe Host Bern',operator:'Safe Host',telecom:'data_center'}},
      {id:277,lat:46.2044,lon:6.1432,tags:{name:'Equinix GV1 Geneva',operator:'Equinix',telecom:'data_center'}},
      {id:278,lat:45.4654,lon:9.1859,tags:{name:'Irideos Milan',operator:'Irideos',telecom:'data_center'}},
      {id:279,lat:41.9028,lon:12.4964,tags:{name:'Equinix RO1 Rome',operator:'Equinix',telecom:'data_center'}},
      // AWS Europe extra
      {id:280,lat:40.4168,lon:-3.7038,tags:{name:'AWS eu-south-1 (Milan)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:281,lat:50.0647,lon:19.9450,tags:{name:'AWS eu-central-2 (Zurich)',operator:'Amazon Web Services',telecom:'data_center'}},
      // ── More Asia ──
      {id:300,lat:22.3964,lon:114.1095,tags:{name:'SUNeVision iAdvantage Hong Kong',operator:'SUNeVision',telecom:'data_center'}},
      {id:301,lat:22.5431,lon:114.0579,tags:{name:'Equinix SZ1 Shenzhen',operator:'Equinix',telecom:'data_center'}},
      {id:302,lat:23.1291,lon:113.2644,tags:{name:'GDS Guangzhou',operator:'GDS',telecom:'data_center'}},
      {id:303,lat:30.2741,lon:120.1551,tags:{name:'Alibaba Hangzhou',operator:'Alibaba',telecom:'data_center'}},
      {id:304,lat:31.8639,lon:117.2808,tags:{name:'Alibaba Hefei',operator:'Alibaba',telecom:'data_center'}},
      {id:305,lat:40.0853,lon:116.6580,tags:{name:'Baidu Yangfang Beijing',operator:'Baidu',telecom:'data_center'}},
      {id:306,lat:36.6512,lon:117.1201,tags:{name:'Inspur Jinan',operator:'Inspur',telecom:'data_center'}},
      {id:307,lat:43.8378,lon:87.6177,tags:{name:'Alibaba Urumqi',operator:'Alibaba',telecom:'data_center'}},
      {id:308,lat:26.0745,lon:119.2965,tags:{name:'Tencent Fuzhou',operator:'Tencent',telecom:'data_center'}},
      {id:309,lat:22.3964,lon:114.1095,tags:{name:'Tencent Hong Kong',operator:'Tencent',telecom:'data_center'}},
      {id:310,lat:35.6762,lon:139.6503,tags:{name:'NTT Tokyo 3',operator:'NTT',telecom:'data_center'}},
      {id:311,lat:35.4437,lon:139.6380,tags:{name:'Fujitsu Kawasaki',operator:'Fujitsu',telecom:'data_center'}},
      {id:312,lat:34.6937,lon:135.5023,tags:{name:'Osaka Data Center',operator:'IDC Frontier',telecom:'data_center'}},
      {id:313,lat:43.0618,lon:141.3545,tags:{name:'Softbank Sapporo',operator:'Softbank',telecom:'data_center'}},
      {id:314,lat:35.1815,lon:136.9066,tags:{name:'NTT Nagoya',operator:'NTT',telecom:'data_center'}},
      {id:315,lat:37.4563,lon:126.7052,tags:{name:'LG CNS Incheon',operator:'LG CNS',telecom:'data_center'}},
      {id:316,lat:35.1796,lon:129.0756,tags:{name:'KT Busan IDC',operator:'KT',telecom:'data_center'}},
      {id:317,lat:10.8231,lon:106.6297,tags:{name:'Viettel IDC Ho Chi Minh',operator:'Viettel',telecom:'data_center'}},
      {id:318,lat:21.0278,lon:105.8342,tags:{name:'VNPT Hanoi',operator:'VNPT',telecom:'data_center'}},
      {id:319,lat:13.7563,lon:100.5018,tags:{name:'DTAC Bangkok',operator:'DTAC',telecom:'data_center'}},
      {id:320,lat:6.9271,lon:79.8612,tags:{name:'Dialog Colombo',operator:'Dialog',telecom:'data_center'}},
      {id:321,lat:23.8103,lon:90.4125,tags:{name:'BDCOM Dhaka',operator:'BDCOM',telecom:'data_center'}},
      {id:322,lat:33.6844,lon:73.0479,tags:{name:'PTCL Islamabad',operator:'PTCL',telecom:'data_center'}},
      {id:323,lat:24.8607,lon:67.0011,tags:{name:'TechAccess Karachi',operator:'TechAccess',telecom:'data_center'}},
      {id:324,lat:28.6139,lon:77.2090,tags:{name:'Yotta Delhi',operator:'Yotta',telecom:'data_center'}},
      {id:325,lat:13.0827,lon:80.2707,tags:{name:'Equinix CH1 Chennai',operator:'Equinix',telecom:'data_center'}},
      {id:326,lat:17.3850,lon:78.4867,tags:{name:'CtrlS Hyderabad',operator:'CtrlS',telecom:'data_center'}},
      // AWS APAC extra
      {id:327,lat:22.3193,lon:114.1694,tags:{name:'AWS ap-east-1 (Hong Kong)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:328,lat:34.6937,lon:135.5023,tags:{name:'AWS ap-northeast-3 (Osaka)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:329,lat:13.7563,lon:100.5018,tags:{name:'AWS ap-southeast-2 (Bangkok)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:330,lat:-6.2088,lon:106.8456,tags:{name:'AWS ap-southeast-3 (Jakarta)',operator:'Amazon Web Services',telecom:'data_center'}},
      // ── Oceania extra ──
      {id:340,lat:-27.4698,lon:153.0251,tags:{name:'Equinix BN1 Brisbane',operator:'Equinix',telecom:'data_center'}},
      {id:341,lat:-31.9505,lon:115.8605,tags:{name:'Equinix PE1 Perth',operator:'Equinix',telecom:'data_center'}},
      {id:342,lat:-36.8485,lon:174.7633,tags:{name:'Spark Auckland',operator:'Spark',telecom:'data_center'}},
      {id:343,lat:-41.2865,lon:174.7762,tags:{name:'Kordia Wellington',operator:'Kordia',telecom:'data_center'}},
      // ── Africa extra ──
      {id:350,lat:6.5244,lon:3.3792,tags:{name:'MainOne Lagos',operator:'MainOne',telecom:'data_center'}},
      {id:351,lat:-1.2921,lon:36.8219,tags:{name:'EADC Nairobi',operator:'EADC',telecom:'data_center'}},
      {id:352,lat:5.5600,lon:-0.1969,tags:{name:'Vodafone Ghana Accra',operator:'Vodafone',telecom:'data_center'}},
      {id:353,lat:15.5007,lon:32.5599,tags:{name:'Sudatel Khartoum',operator:'Sudatel',telecom:'data_center'}},
      {id:354,lat:-25.7479,lon:28.2293,tags:{name:'Teraco PTA1 Pretoria',operator:'Teraco',telecom:'data_center'}},
      // ── Middle East extra ──
      {id:360,lat:29.3759,lon:47.9774,tags:{name:'Ooredoo Kuwait City',operator:'Ooredoo',telecom:'data_center'}},
      {id:361,lat:33.8938,lon:35.5018,tags:{name:'IDM Beirut',operator:'IDM',telecom:'data_center'}},
      {id:362,lat:30.0444,lon:31.2357,tags:{name:'Raya Cairo',operator:'Raya',telecom:'data_center'}},
      {id:363,lat:36.8065,lon:10.1815,tags:{name:'DataVoice Tunis',operator:'DataVoice',telecom:'data_center'}},
      {id:364,lat:33.9716,lon:-6.8498,tags:{name:'Maroc Telecom Rabat',operator:'Maroc Telecom',telecom:'data_center'}},
      {id:365,lat:23.5880,lon:58.3829,tags:{name:'Oman Data Park Muscat',operator:'Oman Data Park',telecom:'data_center'}},
      {id:366,lat:25.2854,lon:51.5310,tags:{name:'Ooredoo Qatar Doha',operator:'Ooredoo',telecom:'data_center'}},
      {id:367,lat:26.2235,lon:50.5876,tags:{name:'AWS me-south-1 (Bahrain)',operator:'Amazon Web Services',telecom:'data_center'}},
      {id:368,lat:24.4539,lon:54.3773,tags:{name:'AWS me-central-1 (UAE)',operator:'Amazon Web Services',telecom:'data_center'}},
    ];
    const out = JSON.stringify({ elements });
    console.log('Datacenters: serving', elements.length, 'curated facilities');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(out);
    return;
  }

  // NASA FIRMS — active fire data past 24h, cached 30min
  if (req.url === '/firms') {
    const mc = memCache.firms;
    if (mc.data && (Date.now() - mc.ts) < mc.ttl) {
      console.log('FIRMS: serving from cache');
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' });
      res.end(mc.data);
      return;
    }
    const MAP_KEY = process.env.FIRMS_MAP_KEY;
    const firmsReq = https.request({
      hostname: 'firms.modaps.eosdis.nasa.gov',
      path: '/api/area/csv/' + MAP_KEY + '/VIIRS_NOAA20_NRT/world/1',
      method: 'GET',
      family: 4,
      headers: { 'User-Agent': 'VIGIL/1.0' },
    }, firmsRes => {
      let d = '';
      firmsRes.on('data', c => d += c);
      firmsRes.on('end', () => {
        console.log('FIRMS status:', firmsRes.statusCode, '| bytes:', d.length);
        if (firmsRes.statusCode === 200) { mc.data = d; mc.ts = Date.now(); }
        res.writeHead(firmsRes.statusCode, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
      });
    });
    firmsReq.setTimeout(20000, () => { firmsReq.destroy(); res.writeHead(504); res.end('FIRMS timeout'); });
    firmsReq.on('error', e => { console.error('FIRMS error:', e.message); res.writeHead(500); res.end(e.message); });
    firmsReq.end();
    return;
  }

  // USGS Earthquakes — past 7 days, M2.5+, cached 10min
  if (req.url === '/quakes') {
    const mc = memCache.quakes;
    if (mc.data && (Date.now() - mc.ts) < mc.ttl) {
      console.log('Quakes: serving from cache');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' });
      res.end(mc.data);
      return;
    }
    const quakeReq = https.request({
      hostname: 'earthquake.usgs.gov',
      path: '/fdsnws/event/1/query?format=geojson&starttime=-7days&minmagnitude=2.5&orderby=magnitude',
      method: 'GET',
      headers: { 'User-Agent': 'ATLAS/1.0' },
    }, quakeRes => {
      let d = '';
      quakeRes.on('data', c => d += c);
      quakeRes.on('end', () => {
        console.log('USGS quakes status:', quakeRes.statusCode, '| bytes:', d.length);
        if (quakeRes.statusCode === 200) { mc.data = d; mc.ts = Date.now(); }
        res.writeHead(quakeRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
      });
    });
    quakeReq.setTimeout(15000, () => { quakeReq.destroy(); res.writeHead(504); res.end('USGS timeout'); });
    quakeReq.on('error', e => { console.error('USGS error:', e.message); res.writeHead(500); res.end(e.message); });
    quakeReq.end();
    return;
  }

  // Power Plants — WRI Global Power Plant Database, disk cached 24h
  if (req.url === '/powerplants') {
    const cached = diskCacheRead('powerplants');
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' });
      res.end(cached);
      return;
    }
    console.log('Powerplants: fetching from WRI GitHub...');
    const ppReq = https.request({
      hostname: 'raw.githubusercontent.com',
      path: '/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv',
      method: 'GET',
      headers: { 'User-Agent': 'ATLAS/1.0' },
    }, ppRes => {
      let d = '';
      ppRes.on('data', c => d += c);
      ppRes.on('end', () => {
        console.log('Powerplants: fetched', Math.round(d.length/1024), 'KB, status', ppRes.statusCode);
        if (ppRes.statusCode === 200) diskCacheWrite('powerplants', d, 24 * 60 * 60 * 1000);
        res.writeHead(ppRes.statusCode === 200 ? 200 : 502, { 'Content-Type': 'text/csv', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
      });
    });
    ppReq.setTimeout(20000, () => { ppReq.destroy(); res.writeHead(504, {'Access-Control-Allow-Origin':'*'}); res.end('timeout'); });
    ppReq.on('error', e => { res.writeHead(502, {'Access-Control-Allow-Origin':'*'}); res.end(e.message); });
    ppReq.end();
    return;
  }

  // ── NDBC BUOYS ─────────────────────────────────────────────────────────────
  if (req.url === '/buoys') {
    const now = Date.now();
    if (buoyCache.data && now - buoyCache.ts < BUOY_TTL) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(buoyCache.data);
      return;
    }
    const buoyReq = https.request({
      hostname: 'www.ndbc.noaa.gov',
      path: '/data/latest_obs/latest_obs.txt',
      method: 'GET',
      headers: { 'User-Agent': 'ATLAS/1.0 (educational visualization)' },
    }, buoyRes => {
      let d = '';
      buoyRes.on('data', c => d += c);
      buoyRes.on('end', () => {
        try {
          const lines = d.split('\n');
          // Line 0: headers (prefixed with #), Line 1: units, Line 2+: data
          const headers = lines[0].replace(/^#\s*/, '').trim().split(/\s+/);
          console.log('NDBC headers:', headers.join(', '));
          const idx = {};
          headers.forEach((h, i) => idx[h.toUpperCase()] = i);

          const isMM = v => !v || v === 'MM' || v === '999' || v === '9999' || v === '99' || v === '999.0' || v === '9999.0' || v === '99.00';
          const getNum = (cols, key, minVal, maxVal) => {
            const v = cols[idx[key]];
            if (!v || isMM(v)) return null;
            const n = parseFloat(v);
            if (isNaN(n)) return null;
            if (minVal !== undefined && n < minVal) return null;
            if (maxVal !== undefined && n > maxVal) return null;
            return n.toFixed(1);
          };
          const getRaw = (cols, key) => {
            const v = cols[idx[key]];
            return (!v || isMM(v)) ? null : v;
          };

          const buoys = [];
          for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = line.split(/\s+/);
            if (cols.length < 5) continue;

            const lat = parseFloat(cols[idx['LAT']]);
            const lon = parseFloat(cols[idx['LON']]);
            if (isNaN(lat) || isNaN(lon)) continue;

            buoys.push({
              id:   cols[idx['STN']] || cols[0],
              lat, lon,
              wdir: getRaw(cols, 'WDIR'),
              wspd: getNum(cols, 'WSPD', 0, 90),
              wvht: getNum(cols, 'WVHT', 0, 25),
              dpd:  getNum(cols, 'DPD',  1, 30),
              atmp: getNum(cols, 'ATMP', -50, 55),
              wtmp: getNum(cols, 'WTMP', -5, 40),
              pres: getNum(cols, 'PRES', 850, 1060),
            });
          }
          console.log(`NDBC buoys loaded: ${buoys.length}`);
          const json = JSON.stringify(buoys);
          buoyCache = { data: json, ts: Date.now() };
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=1800' });
          res.end(json);
        } catch(e) {
          console.error('Buoy parse error:', e.message);
          res.writeHead(500); res.end(e.message);
        }
      });
    });
    buoyReq.setTimeout(15000, () => { buoyReq.destroy(); res.writeHead(504); res.end('NDBC timeout'); });
    buoyReq.on('error', e => { console.error('NDBC error:', e.message); res.writeHead(500); res.end(e.message); });
    buoyReq.end();
    return;
  }

  // ── FAULT LINES — GEM Global Active Faults, disk cached 7 days ──────────────
  if (req.url === '/faults') {
    const cached = diskCacheRead('faults');
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' });
      res.end(cached);
      return;
    }
    console.log('Faults: fetching from GitHub...');
    const faultReq = https.request({
      hostname: 'raw.githubusercontent.com',
      path: '/cossatot/gem-global-active-faults/master/geojson/gem_active_faults.geojson',
      method: 'GET',
      headers: { 'User-Agent': 'ATLAS/1.0' },
    }, faultRes => {
      let d = '';
      faultRes.on('data', c => d += c);
      faultRes.on('end', () => {
        console.log('Faults: fetched', Math.round(d.length/1024), 'KB, status', faultRes.statusCode);
        if (faultRes.statusCode === 200) diskCacheWrite('faults', d, 7 * 24 * 60 * 60 * 1000);
        res.writeHead(faultRes.statusCode === 200 ? 200 : 502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
      });
    });
    faultReq.setTimeout(20000, () => { faultReq.destroy(); res.writeHead(504); res.end('faults timeout'); });
    faultReq.on('error', e => { res.writeHead(502); res.end(e.message); });
    faultReq.end();
    return;
  }

  // ── NUCLEAR PLANTS — GeoNuclearData, disk cached 7 days ──────────────────────
  if (req.url === '/nuclear') {
    const cached = diskCacheRead('nuclear');
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' });
      res.end(cached);
      return;
    }
    console.log('Nuclear: fetching from GitHub...');
    const nucReq = https.request({
      hostname: 'raw.githubusercontent.com',
      path: '/cristianst85/GeoNuclearData/master/data/json/denormalized/nuclear_power_plants.json',
      method: 'GET',
      headers: { 'User-Agent': 'ATLAS/1.0' },
    }, nucRes => {
      let d = '';
      nucRes.on('data', c => d += c);
      nucRes.on('end', () => {
        console.log('Nuclear: fetched', Math.round(d.length/1024), 'KB, status', nucRes.statusCode);
        if (nucRes.statusCode === 200) diskCacheWrite('nuclear', d, 7 * 24 * 60 * 60 * 1000);
        res.writeHead(nucRes.statusCode === 200 ? 200 : 502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(d);
      });
    });
    nucReq.setTimeout(15000, () => { nucReq.destroy(); res.writeHead(504); res.end('nuclear timeout'); });
    nucReq.on('error', e => { res.writeHead(502); res.end(e.message); });
    nucReq.end();
    return;
  }

  if (req.url !== '/flights') { res.writeHead(404); res.end('use /flights'); return; }

  console.log('\n[' + new Date().toISOString() + '] Flight request');
  try {
    const token = await getToken();
    console.log('Calling OpenSky API...');
    const api = await httpsRequest({
      hostname: 'opensky-network.org',
      path: '/api/states/all',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token },
    }, null, 25000);

    console.log('OpenSky status:', api.status, '| bytes:', api.body.length);
    res.writeHead(api.status, { 'Content-Type': 'application/json' });
    res.end(api.body);
  } catch(e) {
    console.error('ERROR:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});


server.listen(3000, () => {
  console.log('================================');
  console.log('ATLAS proxy → http://localhost:3000');
  console.log('================================');

  // ── STARTUP PRE-FETCH ────────────────────────────────────────────────────────
  // Warm the disk cache for heavy datasets so the first browser load is instant.
  // Each check: if disk cache is valid, skip. Otherwise fetch in background.
  function warmCache(label, cacheKey, hostname, path, ttlMs, contentType) {
    const cached = diskCacheRead(cacheKey);
    if (cached) {
      console.log(`[warm] ${label}: disk cache valid, skipping fetch`);
      return;
    }
    console.log(`[warm] ${label}: pre-fetching...`);
    const req = https.request({ hostname, path, method: 'GET', headers: { 'User-Agent': 'ATLAS/1.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          diskCacheWrite(cacheKey, d, ttlMs);
          console.log(`[warm] ${label}: done (${Math.round(d.length/1024)}KB)`);
        } else {
          console.warn(`[warm] ${label}: HTTP ${res.statusCode}`);
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); console.warn(`[warm] ${label}: timeout`); });
    req.on('error', e => console.warn(`[warm] ${label}: error`, e.message));
    req.end();
  }

  // Stagger fetches by 2s each to avoid hammering GitHub on startup
  setTimeout(() => warmCache('Power Plants', 'powerplants', 'raw.githubusercontent.com',
    '/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv',
    24 * 60 * 60 * 1000), 1000);

  setTimeout(() => warmCache('Celestrak active', 'tle_active', 'celestrak.org',
    '/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
    6 * 60 * 60 * 1000), 3000);

  setTimeout(() => warmCache('Celestrak stations', 'tle_stations', 'celestrak.org',
    '/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
    6 * 60 * 60 * 1000), 5000);

  setTimeout(() => warmCache('Fault Lines', 'faults', 'raw.githubusercontent.com',
    '/cossatot/gem-global-active-faults/master/geojson/gem_active_faults.geojson',
    7 * 24 * 60 * 60 * 1000), 7000);

  setTimeout(() => warmCache('Nuclear Plants', 'nuclear', 'raw.githubusercontent.com',
    '/cristianst85/GeoNuclearData/master/data/json/denormalized/nuclear_power_plants.json',
    7 * 24 * 60 * 60 * 1000), 9000);

  setTimeout(() => warmCache('OpenFlights airports', 'openflights_airports', 'raw.githubusercontent.com',
    '/jpatokal/openflights/master/data/airports.dat',
    30 * 24 * 60 * 60 * 1000), 11000);

  setTimeout(() => warmCache('OpenFlights routes', 'openflights_routes', 'raw.githubusercontent.com',
    '/jpatokal/openflights/master/data/routes.dat',
    30 * 24 * 60 * 60 * 1000), 13000);
});

// ── AIS WEBSOCKET RELAY ───────────────────────────────────────────────────────
// Relays browser WebSocket connections to aisstream.io server-side,
// keeping the API key off the open internet and avoiding direct-connection 503s.
const AIS_API_KEY = process.env.AIS_API_KEY;
const wss = new WebSocket.Server({ port: 3001 });

wss.on('connection', (clientWs) => {
  console.log('AIS relay: browser connected');

  const upstream = new WebSocket('wss://stream.aisstream.io/v0/stream');

  upstream.on('open', () => {
    console.log('AIS relay: upstream connected');
    // Send subscription immediately on open
    upstream.send(JSON.stringify({
      APIKey: AIS_API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ['PositionReport'],
    }));
  });

  // Forward upstream → browser
  upstream.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
  });

  upstream.on('close', (code, reason) => {
    console.log('AIS relay: upstream closed', code);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  upstream.on('error', (e) => console.warn('AIS relay upstream error:', e.message));

  // Forward browser → upstream (e.g. custom subscription overrides)
  clientWs.on('message', (data) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
  });

  clientWs.on('close', () => {
    console.log('AIS relay: browser disconnected');
    upstream.close();
  });
});

console.log('AIS WebSocket relay → ws://localhost:3001');

