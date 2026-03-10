# VIGIL 🌍

A live Earth intelligence globe. Real-time flights, satellites, ships, wildfires, earthquakes, submarine cables, fault lines, radio stations, and more — rendered on an interactive 3D globe.

**Live at [vigil.earth](https://vigil.earth)**

![VIGIL Globe](https://vigil.earth/preview.png](https://github.com/RINNEGATI/vigil/blob/main/preview.png)

---

## Data Layers

| Layer | Source | Refresh |
|---|---|---|
| ✈️ Flights (~8,000) | OpenSky Network | 60s |
| 🛰️ Satellites (~300) | CelesTrak TLE | 6h |
| 🚢 Ships | AISStream.io | Live WebSocket |
| 🔥 Wildfires | NASA FIRMS VIIRS | 30min |
| 🌊 Earthquakes | USGS | 10min |
| 📡 Radio Stations (~5,000) | Radio Browser API | 1h |
| 📷 Webcams (~50) | Windy Webcams V3 | 9min |
| 🌊 Ocean Buoys | NOAA NDBC | 30min |
| ⚡ Power Plants | OpenStreetMap | 24h |
| ☢️ Nuclear Sites | OpenStreetMap | 7 days |
| 🌐 Submarine Cables | TeleGeography | 7 days |
| 〰️ Fault Lines | GEM Global | 7 days |
| 📰 News Events | GDELT | 15min |
| 🏢 Data Centers | Curated | Static |
| 🌧️ Weather Radar | RainViewer | Live |
| 🛣️ Roads | OpenStreetMap | Static |

---

## Architecture

```
vigil.html        — Single-file frontend (CesiumJS 3D globe)
proxy.js          — Node.js API proxy (handles keys, CORS, caching)
```

The frontend talks exclusively to the proxy. The proxy handles all external API calls, caches responses, and keeps API keys server-side.

---

## Self-Hosting

### Requirements

- Node.js 18+
- A VPS or server (tested on Hetzner CPX11, ~$5/mo)
- A domain with DNS pointed at your server
- Nginx + Certbot for SSL

### 1. Clone

```bash
git clone https://github.com/rinnegati/vigil.git
cd vigil
```

### 2. Get API Keys

All free:

| Key | Where to get it |
|---|---|
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | [opensky-network.org](https://opensky-network.org) — create a free account |
| `WINDY_API_KEY` | [api.windy.com](https://api.windy.com) — free Webcams API key |
| `FIRMS_MAP_KEY` | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/area/) — free MAP_KEY |
| `AIS_API_KEY` | [aisstream.io](https://aisstream.io) — free API key |
| Cesium Ion token | [ion.cesium.com](https://ion.cesium.com) — free account, paste into `vigil.html` |

### 3. Configure

```bash
cp .env.example .env
nano .env   # fill in your keys
```

In `vigil.html`, replace `YOUR_CESIUM_ION_TOKEN` with your token from [ion.cesium.com](https://ion.cesium.com).

Replace all instances of `https://vigil.earth` in `vigil.html` with your own domain.

### 4. Install & Run the Proxy

```bash
npm install ws dotenv
node proxy.js
```

Or with PM2 to keep it running:

```bash
npm install -g pm2
pm2 start proxy.js --name vigil-proxy
pm2 save
pm2 startup
```

### 5. Deploy the Frontend

```bash
sudo mkdir -p /var/www/vigil
sudo cp vigil.html /var/www/vigil/
```

### 6. Configure Nginx

```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/vigil
sudo nano /etc/nginx/sites-available/vigil   # replace your.domain.com
sudo ln -s /etc/nginx/sites-available/vigil /etc/nginx/sites-enabled/
sudo nginx -t && sudo nginx -s reload
```

### 7. SSL via Certbot

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

---

## Development / Local Testing

```bash
# Terminal 1 — run the proxy
node proxy.js

# Terminal 2 — serve the frontend
python -m http.server 8080
```

Open `http://localhost:8080/vigil.html`. The proxy listens on `localhost:3000`.

> Make sure `vigil.html` has `http://localhost:3000` URLs (not your production domain) when testing locally.

---

## Stack

- **[CesiumJS](https://cesium.com/cesiumjs/)** — 3D globe rendering
- **[satellite.js](https://github.com/shashwatak/satellite-js)** — TLE orbital propagation
- **Node.js** — API proxy server
- **Nginx** — reverse proxy + SSL termination
- **[PM2](https://pm2.keymetrics.io/)** — process management

---

## License

MIT — do whatever you want with it.
