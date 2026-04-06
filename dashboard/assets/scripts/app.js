const SVC  = '12340001-1234-5678-1234-56789abcdef0';
const CHR_LOC = '12340002-1234-5678-1234-56789abcdef0';
const CHR_STS = '12340003-1234-5678-1234-56789abcdef0';

let dev = null, srv = null, chrLoc = null, chrSts = null;
let map = null, marker = null, track = null;
let pts = [], mapOk = false, nCount = 0, startPos = null;
let lastValidLat = 0, lastValidLon = 0;

/* Minimum movement (meters) to count as real motion vs GPS drift */
const MIN_MOVE_M = 10;

/* Haversine distance between two points in meters */
function distM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
              Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
              Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function hex(dv) {
    const b = [];
    for (let i = 0; i < dv.byteLength; i++) b.push(dv.getUint8(i).toString(16).padStart(2,'0'));
    return b.join(' ');
}

function log(msg, cls = '') {
    const box = document.getElementById('logBox');
    const row = document.createElement('div');
    row.className = 'log-row ' + cls;
    const t = new Date().toLocaleTimeString('ru-RU');
    row.innerHTML = `<span class="t">${t}</span><span class="m">${msg}</span>`;
    box.prepend(row);
    while (box.children.length > 50) box.removeChild(box.lastChild);
}

function initMap(lat, lon) {
    if (mapOk) return;
    const w = document.getElementById('welcomeScreen');
    if (w) w.style.display = 'none';

    map = L.map('map', { zoomControl: false }).setView([lat, lon], 16);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap · CartoDB', maxZoom: 19
    }).addTo(map);

    const icon = L.divIcon({
        className: '',
        html: '<div style="width:18px;height:18px;background:#4e7cff;border:3px solid #fff;border-radius:50%;box-shadow:0 0 16px rgba(78,124,255,.6)"></div>',
        iconSize: [18,18], iconAnchor: [9,9]
    });
    marker = L.marker([lat, lon], { icon }).addTo(map);
    track = L.polyline([], { color: '#4e7cff', weight: 3, opacity: .7 }).addTo(map);
    mapOk = true;
}

function moveMap(lat, lon) {
    if (!mapOk) { initMap(lat, lon); lastValidLat = lat; lastValidLon = lon; return; }
    marker.setLatLng([lat, lon]);
    map.panTo([lat, lon], { animate: true, duration: .4 });

    /* Only add to track if moved more than MIN_MOVE_M meters (filters GPS drift) */
    const d = distM(lastValidLat, lastValidLon, lat, lon);
    if (d >= MIN_MOVE_M) {
        pts.push([lat, lon]);
        if (pts.length > 1000) pts.shift();
        track.setLatLngs(pts);
        lastValidLat = lat;
        lastValidLon = lon;
    }
}

function parseLoc(dv) {
    if (dv.byteLength < 12) { log('Location: ' + dv.byteLength + 'B < 12', 'err'); return null; }
    const lat = dv.getFloat32(0, true), lon = dv.getFloat32(4, true), alt = dv.getFloat32(8, true);
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt)) { log('Невалидные float', 'err'); return null; }
    return { lat, lon, alt };
}

function parseSts(dv) {
    if (dv.byteLength < 4) { log('Status: ' + dv.byteLength + 'B < 4', 'err'); return null; }
    return { fix: dv.getUint8(0), qual: dv.getUint8(1), sat: dv.getUint8(2), spd: dv.getUint8(3) };
}

function showLoc(d) {
    const c = (v) => v.toFixed(6) + '°';
    document.getElementById('latVal').textContent = c(d.lat);
    document.getElementById('lonVal').textContent = c(d.lon);
    document.getElementById('altVal').textContent = d.alt.toFixed(0);
    document.getElementById('altDetail').textContent = d.alt.toFixed(1) + ' м';
    document.getElementById('mapCoords').textContent = d.lat.toFixed(5) + ', ' + d.lon.toFixed(5);
    document.getElementById('curPos').textContent = d.lat.toFixed(6) + '°, ' + d.lon.toFixed(6) + '°';

    if (!startPos && (d.lat || d.lon)) {
        startPos = { lat: d.lat, lon: d.lon };
        document.getElementById('startPos').textContent = d.lat.toFixed(6) + '°, ' + d.lon.toFixed(6) + '°';
    }
    if (d.lat || d.lon) moveMap(d.lat, d.lon);
}

function showSts(s) {
    const fb = document.getElementById('fixBox');
    const fv = document.getElementById('fixVal');
    if (s.fix) { fb.className = 'stat s-fix'; fv.textContent = 'Есть'; }
    else       { fb.className = 'stat s-nofix'; fv.textContent = 'Нет'; }
    document.getElementById('satVal').textContent = s.sat;
    /* Show speed as 0 when satellites < 5 and reported speed is low (GPS drift) */
    const showSpd = (s.sat < 5 && s.spd <= 3) ? 0 : s.spd;
    document.getElementById('spdVal').textContent = showSpd;
    document.getElementById('qualVal').textContent = ['—','GPS','DGPS'][s.qual] || s.qual;
}

function onLoc(e) {
    const v = e.target.value;
    nCount++;
    if (nCount <= 3 || nCount % 10 === 0) log('Loc #' + nCount + ' [' + v.byteLength + 'B] ' + hex(v), 'inf');
    const d = parseLoc(v);
    if (d) showLoc(d);
}

async function readSts() {
    if (!chrSts) return;
    try {
        const v = await chrSts.readValue();
        log('Sts [' + v.byteLength + 'B] ' + hex(v));
        const s = parseSts(v);
        if (s) showSts(s);
    } catch (e) {
        if (dev && dev.gatt.connected) log('Read err: ' + e.message, 'err');
    }
}

async function connect() {
    const btn = document.getElementById('connectBtn');
    const txt = document.getElementById('connectText');
    btn.className = 'btn-connect wait'; txt.textContent = 'Подключение…';
    log('Поиск устройства…', 'inf');

    try {
        dev = await navigator.bluetooth.requestDevice({ filters: [{ name: 'GPS Tracker' }], optionalServices: [SVC] });
        log('Найдено: ' + dev.name, 'ok');
        dev.addEventListener('gattserverdisconnected', onDis);

        srv = await dev.gatt.connect();
        const svc = await srv.getPrimaryService(SVC);

        chrLoc = await svc.getCharacteristic(CHR_LOC);
        await chrLoc.startNotifications();
        chrLoc.addEventListener('characteristicvaluechanged', onLoc);
        log('Location notify ✓', 'ok');

        chrSts = await svc.getCharacteristic(CHR_STS);
        log('Status char ✓', 'ok');

        await readSts();
        window._si = setInterval(readSts, 2000);
        nCount = 0; startPos = null;

        btn.className = 'btn-connect on'; txt.textContent = 'Подключено';
        log('Ожидание GPS данных…', 'ok');
    } catch (e) {
        log('Ошибка: ' + e.message, 'err');
        btn.className = 'btn-connect off'; txt.textContent = 'Подключить';
    }
}

function disconnect() {
    if (window._si) clearInterval(window._si);
    if (dev && dev.gatt.connected) dev.gatt.disconnect();
}

function onDis() {
    const btn = document.getElementById('connectBtn');
    btn.className = 'btn-connect off';
    document.getElementById('connectText').textContent = 'Подключить';
    if (window._si) clearInterval(window._si);
    chrLoc = null; chrSts = null;
    log('Отключено', 'err');
}

function toggleConnection() {
    document.getElementById('connectBtn').classList.contains('on') ? disconnect() : connect();
}

function toggleMenu() {
    document.getElementById('burger').classList.toggle('open');
    document.getElementById('panel').classList.toggle('open');
    document.getElementById('overlay').classList.toggle('show');
}