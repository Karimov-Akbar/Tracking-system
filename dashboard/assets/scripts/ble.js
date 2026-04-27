function parseLoc(dv) {
    if (dv.byteLength < 12) return null;
    const lat = dv.getFloat32(0, true), lon = dv.getFloat32(4, true), alt = dv.getFloat32(8, true);
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt)) return null;
    return { lat, lon, alt };
}

function parseSts(dv) {
    if (dv.byteLength < 4) return null;
    return { fix: dv.getUint8(0), qual: dv.getUint8(1), sat: dv.getUint8(2), spd: dv.getUint8(3) };
}

function onLocFor(deviceId) {
    return function (e) {
        const d = devices.get(deviceId);
        if (!d) return;
        d.nCount++;
        const loc = parseLoc(e.target.value);
        if (!loc) return;
        d.alt = loc.alt;
        
        if (loc.lat === 0 && loc.lon === 0) {
            return;
        }
        
        updateDevicePosition(deviceId, loc.lat, loc.lon);
        const loader = document.getElementById('gpsLoader');
        if (loader) loader.style.display = 'none';
        
        renderDeviceList();
    };
}

function onStsFor(deviceId) {
    return function (dv) {
        const d = devices.get(deviceId);
        if (!d) return;
        const s = (dv.target) ? parseSts(dv.target.value) : parseSts(dv);
        if (!s) return;

        const currentFix = !!s.fix;
        if (!currentFix && d.fix) {
            d._fixLostTime = d._fixLostTime || Date.now();
            if (Date.now() - d._fixLostTime > 4000) {
                d.fix = false;
            }
        } else {
            d._fixLostTime = null;
            d.fix = currentFix;
        }

        d.lastSpeed = s.spd;
        d.lastSat = s.sat;
        d.sat = s.sat;
        d.spd = (s.sat < 5 && s.spd <= 3) ? 0 : s.spd;
        const act = classifyMotion(d.spd);
        d.activity = act.label;
        d.activityIcon = act.icon;
        const loader = document.getElementById('gpsLoader');
        if (loader && !d.isNearby && currentMode !== 'indoor') {
            const hasLastLoc = (d.lastLat && d.lastLon && (d.lastLat !== 0 || d.lastLon !== 0));
            loader.style.display = (d.fix || hasLastLoc) ? 'none' : 'flex';
        }
        renderDeviceList();
    };
}



function parseScan(dv) {
    const result = [];
    if (dv.byteLength < 1) return result;
    const count = dv.getUint8(0);
    let pos = 1;
    for (let i = 0; i < count && pos < dv.byteLength - 9; i++) {
        const mac = [];
        for (let j = 5; j >= 0; j--) mac.push(dv.getUint8(pos + j).toString(16).padStart(2, '0'));
        pos += 6;
        const rssi = dv.getInt8(pos++);
        const type = dv.getUint8(pos++);
        const nameLen = dv.getUint8(pos++);
        let name = '';
        for (let j = 0; j < nameLen && pos < dv.byteLength; j++) name += String.fromCharCode(dv.getUint8(pos++));
        result.push({ mac: mac.join(':'), rssi, type, name: name || 'Unknown' });
    }
    return result;
}

const DEV_ICONS = {
    0: 'bluetooth',
    1: 'smartphone',
    2: 'computer',
    3: 'devices_wearables',
    4: 'headphones',
    5: 'speaker',
    6: 'tv',
    7: 'sell',
    8: 'cell_tower',
};
function deviceIcon(type) {
    const icon = DEV_ICONS[type] || 'bluetooth';
    return `<span class="material-symbols-outlined nearby-icon">${icon}</span>`;
}

function brandIcon(name) {
    const n = name.toLowerCase();
    if (n.startsWith('iphone') || n.startsWith('ipad') || n.startsWith('device') ||
        n.startsWith('airpods') || n.startsWith('iwatch') || n.startsWith('apple') ||
        n.startsWith('homepod') || n.startsWith('appletv'))
        return '<i class="fab fa-apple" style="font-size:16px;color:#aaa"></i>';
    if (n.startsWith('samsung') || n.startsWith('android') || n.startsWith('huawei') ||
        n.startsWith('xiaomi') || n.startsWith('oppo') || n.startsWith('realme') ||
        n.startsWith('vivo') || n.startsWith('honor') || n.startsWith('pixel'))
        return '<i class="fab fa-android" style="font-size:16px;color:#3ddc84"></i>';
    return deviceIcon(0);
}

function onScanFor(deviceId) {
    return function (e) {
        const list = parseScan(e.target.value);
        nearbyDevices = list;

        const now = Date.now();
        list.forEach(nd => {
            const d = devices.get('nearby_' + nd.mac);
            if (d) d.lastSeen = now;
        });

        renderNearbyDevices();
    };
}

async function refreshNearbyList() {
    const btn = document.querySelector('.btn-scan-refresh');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    log('Сканирование устройств…', 'inf');

    let found = false;
    for (const [id, d] of devices) {
        if (d.chrScan) {
            try {
                const val = await d.chrScan.readValue();
                const list = parseScan(val);
                nearbyDevices = list;
                renderNearbyDevices();
                log(`Найдено ${list.length} устройств`, 'ok');
                found = true;
            } catch (e) {
                log('Ошибка чтения: ' + e.message, 'err');
            }
        }
    }

    if (!found) log('Подключите трекер для сканирования', 'err');
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
}

async function readStsFor(deviceId) {
    const d = devices.get(deviceId);
    if (!d || !d.chrSts) return;
    try {
        const v = await d.chrSts.readValue();
        onStsFor(deviceId)(v);
    } catch (e) {
        if (d.dev && d.dev.gatt.connected && currentMode !== 'indoor') log(`${d.name}: read err`, 'err');
    }
}

async function connectDevice() {
    log('Поиск устройства…', 'inf');

    try {
        const btDev = await navigator.bluetooth.requestDevice({
            filters: [
                { services: [SVC] },
                { namePrefix: 'GPS' }
            ],
            optionalServices: [SVC]
        });

        const deviceId = btDev.id || btDev.name || ('dev_' + Date.now());
        const deviceName = btDev.name || 'Устройство';

        if (devices.has(deviceId)) {
            log(`${deviceName} уже подключён`, 'inf');
            return;
        }

        const color = getNextColor();
        const state = createDeviceState(deviceId, deviceName, color);
        state.dev = btDev;
        devices.set(deviceId, state);

        log(`Найдено: ${deviceName}`, 'ok');
        const loader = document.getElementById('gpsLoader');
        if (loader) loader.style.display = 'flex';
        btDev.addEventListener('gattserverdisconnected', () => onDeviceDisconnect(deviceId));

        const server = await btDev.gatt.connect();
        await new Promise(r => setTimeout(r, 600));
        
        state.srv = server;
        const svc = await server.getPrimaryService(SVC);

        state.chrLoc = await svc.getCharacteristic(CHR_LOC);
        await state.chrLoc.startNotifications();
        state.chrLoc.addEventListener('characteristicvaluechanged', onLocFor(deviceId));
        log(`${deviceName}: Location ✓`, 'ok');

        state.chrSts = await svc.getCharacteristic(CHR_STS);
        log(`${deviceName}: Status ✓`, 'ok');

        try {
            state.chrScan = await svc.getCharacteristic(CHR_SCAN);
            await state.chrScan.startNotifications();
            state.chrScan.addEventListener('characteristicvaluechanged', onScanFor(deviceId));
            log(`${deviceName}: Scan ✓`, 'ok');
        } catch (e) { log(`${deviceName}: Scan не поддерживается`, 'inf'); }

        if (btDev.watchAdvertisements) {
            try {
                await btDev.watchAdvertisements();
                btDev.addEventListener('advertisementreceived', (e) => {
                    state.rssi = e.rssi;
                });
            } catch (e) { }
        }

        await readStsFor(deviceId);
        state.interval = setInterval(() => readStsFor(deviceId), 2000);

        if (mapOk) addDeviceToMap(state);
        if (!selectedDeviceId) selectedDeviceId = deviceId;

        renderDeviceList();
        updateDeviceCount();
        log(`${deviceName} подключён ✓`, 'ok');

        if (devices.size === 1) showModeModal();

    } catch (e) {
        log('Ошибка: ' + e.message, 'err');
        for (const [id, d] of devices.entries()) {
            if (d.dev && (!d.chrSts || !d.chrLoc)) {
                devices.delete(id);
                renderDeviceList();
                updateDeviceCount();
            }
        }
    }
}

function disconnectDevice(deviceId) {
    const d = devices.get(deviceId);
    if (!d) return;
    if (d.interval) clearInterval(d.interval);
    if (d.marker) d.marker.remove();
    if (d.track) d.track.remove();
    if (d.dev && d.dev.gatt.connected) d.dev.gatt.disconnect();
    devices.delete(deviceId);
    if (selectedDeviceId === deviceId) {
        selectedDeviceId = devices.size > 0 ? devices.keys().next().value : null;
    }
    renderDeviceList();
    updateDeviceCount();
    log(`Устройство отключено`, 'inf');
}

function onDeviceDisconnect(deviceId) {
    const d = devices.get(deviceId);
    if (!d) return;
    if (d._reconnecting) return;
    d._reconnecting = true;
    if (d.interval) clearInterval(d.interval);

    log(`${d.name} отключён — переподключение…`, 'err');
    attemptReconnect(deviceId);
}

async function attemptReconnect(deviceId) {
    const d = devices.get(deviceId);
    if (!d) return;

    for (let attempt = 1; attempt <= 3; attempt++) {
        log(`Попытка ${attempt}/3…`, 'inf');
        await new Promise(r => setTimeout(r, 2000 * attempt));

        try {
            if (!d.dev || !d.dev.gatt) throw new Error('no gatt');
            const server = await d.dev.gatt.connect();
            const svc = await server.getPrimaryService(SVC);

            try {
                d.chrLoc = await svc.getCharacteristic(CHR_LOC);
                await d.chrLoc.startNotifications();
                d.chrLoc.addEventListener('characteristicvaluechanged', onLocFor(deviceId));
                log(`${d.name}: Location ✓`, 'ok');
            } catch (e) { }

            try {
                d.chrSts = await svc.getCharacteristic(CHR_STS);
                /* CHR_STS is a READ characteristic, no notifications */
                log(`${d.name}: Status ✓`, 'ok');
            } catch (e) { }

            try {
                d.chrScan = await svc.getCharacteristic(CHR_SCAN);
                await d.chrScan.startNotifications();
                d.chrScan.addEventListener('characteristicvaluechanged', onScanFor(deviceId));
                log(`${d.name}: Scan ✓`, 'ok');
            } catch (e) { }

            d.interval = setInterval(() => readStsFor(deviceId), 2000);
            d._reconnecting = false;
            log(`${d.name} переподключён ✓`, 'ok');
            renderDeviceList();
            return; /* success */
        } catch (e) {
            log(`Реконнект ${attempt}/3 не удался: ${e.message}`, 'err');
        }
    }

    /* All attempts failed — remove device */
    d._reconnecting = false;
    if (d.marker) d.marker.remove();
    if (d.track) d.track.remove();
    sendToServer('/api/disconnect', { deviceName: d.name });
    devices.delete(deviceId);
    if (selectedDeviceId === deviceId) {
        selectedDeviceId = devices.size > 0 ? devices.keys().next().value : null;
    }
    renderDeviceList();
    updateDeviceCount();
    log(`${d.name}: все попытки исчерпаны`, 'err');
}

function updateDeviceCount() {
    const el = document.getElementById('deviceCount');
    if (el) el.textContent = devices.size;
}

function renderDeviceList() {
    const list = document.getElementById('deviceList');
    if (!list) return;

    list.innerHTML = '';
    devices.forEach((d, id) => {
        const card = document.createElement('div');
        card.className = 'device-card' + (id === selectedDeviceId ? ' active' : '');
        card.onclick = () => focusDevice(id);

        if (d.isNearby) {
            const nd = nearbyDevices.find(n => n.mac === d.nearbyMac);
            const rssi = nd ? nd.rssi : d.nearbyRssi;
            const dist = estimateDistance(rssi);
            const icon = brandIcon(d.name);
            card.innerHTML = `
                <div class="device-header">
                    <div class="device-color" style="background:${d.color}"></div>
                    <div class="device-name" ondblclick="event.stopPropagation();renameDevice('${id}')" title="Двойной клик — переименовать">${icon} ${d.name}</div>
                    <button class="device-rename" onclick="event.stopPropagation();renameDevice('${id}')" title="Переименовать">
                        <span class="material-symbols-outlined" style="font-size:14px">edit</span>
                    </button>
                    <button class="device-disconnect" onclick="event.stopPropagation();disconnectDevice('${id}')" title="Убрать">✕</button>
                </div>
                <div class="device-stats">
                    <span>${rssi}dBm</span>
                    <span>~${dist}м</span>
                </div>
            `;
        } else {
            const dotColor = (d.fix || currentMode === 'indoor') ? '#22c55e' : '#eab308';
            const statusDot = `<span class="material-symbols-outlined" style="font-size:16px;color:${dotColor}">circle</span>`;
            
            let statsHtml = '';
            if (currentMode === 'indoor') {
                statsHtml = `<span>🏢 В помещении</span>`;
            } else {
                statsHtml = `
                    <span>${d.fix ? 'Fix' : 'No Fix'}</span>
                    <span><span class="material-symbols-outlined" style="font-size:13px">satellite_alt</span> ${d.sat}</span>
                `;
            }

            card.innerHTML = `
                <div class="device-header">
                    <div class="device-color" style="background:${d.color}"></div>
                    <div class="device-name">${statusDot} ${d.name}</div>
                    <button class="device-disconnect" onclick="event.stopPropagation();disconnectDevice('${id}')" title="Отключить">✕</button>
                </div>
                <div class="device-stats">
                    ${statsHtml}
                </div>
            `;
        }
        list.appendChild(card);
    });

    if (devices.size === 0) {
        list.innerHTML = '<div class="no-devices">Нет подключённых устройств</div>';
    }
}

function toggleMenu() {
    document.getElementById('burger').classList.toggle('open');
    document.getElementById('panel').classList.toggle('open');
    document.getElementById('overlay').classList.toggle('show');
}

function toggleNearby() {
    const wrap = document.getElementById('nearbyWrap');
    const arrow = document.getElementById('nearbyArrow');
    wrap.classList.toggle('collapsed');
    arrow.textContent = wrap.classList.contains('collapsed') ? 'expand_more' : 'expand_less';
}

function renderNearbyDevices() {
    const el = document.getElementById('nearbyList');
    if (!el) return;

    const ALLOWED_TYPES = [1, 3, 4];
    const EXCLUDED_NAMES = ['mac', 'windows', 'ibeacon', 'appletv', 'homepod', 'ble_', 'wbb'];
    const MIN_RSSI = -100;
    const filtered = nearbyDevices
        .filter(nd => !devices.has('nearby_' + nd.mac))
        .filter(nd => ALLOWED_TYPES.includes(nd.type))
        .filter(nd => nd.rssi > MIN_RSSI)
        .filter(nd => !EXCLUDED_NAMES.some(ex => nd.name.toLowerCase().startsWith(ex)));

    if (filtered.length === 0) {
        el.innerHTML = '<div class="no-devices">Нет устройств рядом</div>';
    } else {
        el.innerHTML = filtered.map(nd => {
            const dist = estimateDistance(nd.rssi);
            const bars = nd.rssi > -50 ? '▓▓▓▓' : nd.rssi > -70 ? '▓▓▓░' : nd.rssi > -85 ? '▓▓░░' : '▓░░░';
            return `<div class="nearby-card">
                <div class="nearby-name">${brandIcon(nd.name)} ${nd.name}</div>
                <div class="nearby-info">
                    <span class="nearby-signal">${bars} ${nd.rssi}dBm</span>
                    <span class="nearby-dist">~${dist}м</span>
                    <button class="nearby-btn" onclick="trackNearbyDevice('${nd.mac}','${nd.name.replace(/'/g, '')}',${nd.rssi},${nd.type})">+</button>
                </div>
            </div>`;
        }).join('');
    }
    const countEl = document.getElementById('nearbyCount');
    if (countEl) countEl.textContent = filtered.length;
    updateTrackedNearbyPositions();
    checkNearbyTimeouts();
}

function checkNearbyTimeouts() {
    const now = Date.now();
    devices.forEach((d, id) => {
        if (d.isNearby) {
            if (!d.lastSeen) d.lastSeen = now;
            if (now - d.lastSeen > 120000) {
                log(`Устройство ${d.name} потеряно`, 'err');
                sendToServer('/api/track', { deviceName: d.name, action: 'lost' });
                disconnectDevice(id);
                renderNearbyDevices();
            }
        }
    });
}

function trackNearbyDevice(mac, name, rssi, type) {
    const deviceId = 'nearby_' + mac;
    if (devices.has(deviceId)) return;
    let baseLat = 0, baseLon = 0;
    devices.forEach(d => {
        if (d.lastLat && !d.id.startsWith('nearby_')) {
            baseLat = d.lastLat;
            baseLon = d.lastLon;
        }
    });

    if (!baseLat && currentMode !== 'indoor') {
        log('Нет GPS — позиция трекера неизвестна', 'err');
        return;
    }

    const color = getNextColor();
    const state = createDeviceState(deviceId, name, color);
    state.lastLat = baseLat || 0;
    state.lastLon = baseLon || 0;
    state.isNearby = true;
    state.nearbyMac = mac;
    state.nearbyRssi = rssi;
    state.nearbyType = type != null ? type : 0;

    const saved = getSavedName(mac);
    if (saved) state.name = saved;

    devices.set(deviceId, state);

    if (currentMode !== 'indoor' && baseLat) {
        if (mapOk) addDeviceToMap(state);
        updateDevicePosition(deviceId, baseLat, baseLon);
    }

    renderDeviceList();
    renderNearbyDevices();
    updateDeviceCount();
    if (currentMode === 'indoor') renderRadar();
    log(`${state.name} добавлен`, 'ok');
    if (!state.name.startsWith('GPS')) {
        sendToServer('/api/track', { deviceName: state.name, action: 'add' });
    }
}

function untrackNearbyDevice(mac) {
    const did = 'nearby_' + mac;
    const d = devices.get(did);
    if (d && !d.name.startsWith('GPS')) {
        sendToServer('/api/track', { deviceName: d.name, action: 'remove' });
    }
    disconnectDevice(did);
    renderNearbyDevices();
}

function updateTrackedNearbyPositions() {
    let baseLat = 0, baseLon = 0;
    devices.forEach(d => {
        if (d.lastLat && !d.id.startsWith('nearby_')) {
            baseLat = d.lastLat;
            baseLon = d.lastLon;
        }
    });
    if (!baseLat && currentMode !== 'indoor') return;
    if (!baseLat && typeof mapOk !== 'undefined' && mapOk) {
        const c = map.getCenter();
        baseLat = c.lat;
        baseLon = c.lng;
    }

    nearbyDevices.forEach(nd => {
        const did = 'nearby_' + nd.mac;
        const d = devices.get(did);
        if (!d) return;
        d.nearbyRssi = nd.rssi;

        const distNum = parseFloat(estimateDistance(nd.rssi)) || 1;
        const angle = d._angle || (Math.random() * Math.PI * 2);
        d._angle = angle + 0.1;

        let curLat = baseLat || 0;
        let curLon = baseLon || 0;

        if (baseLat !== null) {
            const dLat = (distNum / 111320) * Math.cos(angle);
            const dLon = (distNum / (111320 * Math.cos(baseLat * Math.PI / 180))) * Math.sin(angle);
            curLat = baseLat + dLat;
            curLon = baseLon + dLon;
        }

        if (currentMode === 'indoor') {
            sendToServer('/api/location', {
                deviceId: did,
                deviceName: d.name,
                lat: baseLat || 0,
                lon: baseLon || 0,
                sat: 0, spd: 0, fix: 1,
                mode: 'indoor',
                isNearby: true,
                dist: Math.round(distNum)
            });
            if (typeof checkGeofences === 'function') checkGeofences(did, curLat, curLon);
        } else {
            updateDevicePosition(did, curLat, curLon);
        }
    });
}

function estimateDistance(rssi) {
    const d = Math.pow(10, (RSSI_TX_POWER - rssi) / (10 * RSSI_N));
    return d < 1 ? '<1' : Math.round(d).toString();
}

function getSavedName(mac) {
    try {
        const map = JSON.parse(localStorage.getItem('deviceNames') || '{}');
        return map[mac] || null;
    } catch (e) { return null; }
}

function saveName(mac, name) {
    try {
        const map = JSON.parse(localStorage.getItem('deviceNames') || '{}');
        map[mac] = name;
        localStorage.setItem('deviceNames', JSON.stringify(map));
    } catch (e) { }
}

function renameDevice(deviceId) {
    const d = devices.get(deviceId);
    if (!d) return;
    const newName = prompt('Новое имя устройства:', d.name);
    if (!newName || !newName.trim()) return;
    const trimmed = newName.trim();
    const oldName = d.name;
    d.name = trimmed;

    if (d.nearbyMac) saveName(d.nearbyMac, trimmed);

    if (d.marker && mapOk) {
        d.marker.remove();
        addDeviceToMap(d);
        if (d.lastLat) d.marker.setLatLng([d.lastLat, d.lastLon]);
    }

    renderDeviceList();
    log(`${oldName} → ${trimmed}`, 'ok');

    if (!trimmed.startsWith('GPS')) {
        sendToServer('/api/track', { deviceName: trimmed, action: 'rename', oldName });
    }
}

let currentMode = localStorage.getItem('trackerMode') || 'outdoor';

function showModeModal() {
    document.getElementById('modeModal').classList.add('show');
}

function setMode(mode) {
    currentMode = mode;
    localStorage.setItem('trackerMode', mode);
    document.getElementById('modeModal').classList.remove('show');

    const loader = document.getElementById('gpsLoader');
    const radar = document.getElementById('radarView');
    const welcome = document.getElementById('welcomeScreen');
    const mapInfo = document.querySelector('.map-tag');

    if (mode === 'indoor') {
        if (loader) loader.style.display = 'none';
        if (welcome) welcome.style.display = 'none';
        if (mapInfo) mapInfo.style.display = 'none';
        if (radar) radar.style.display = 'flex';
        renderRadar();
        log('Режим помещения включён', 'ok');
    } else {
        if (radar) radar.style.display = 'none';
        if (mapInfo) mapInfo.style.display = '';
        log('Режим улицы включён', 'ok');
    }
}

function renderRadar() {
    if (currentMode !== 'indoor') return;
    const dotsEl = document.getElementById('radarDots');
    if (!dotsEl) return;

    const RING_R = 150;

    const items = [];
    devices.forEach((d, id) => {
        if (d.isNearby) {
            const nd = nearbyDevices.find(n => n.mac === d.nearbyMac);
            const rssi = nd ? nd.rssi : d.nearbyRssi;
            items.push({ name: d.name, rssi, color: d.color });
        }
    });
    nearbyDevices.forEach(nd => {
        if (!devices.has('nearby_' + nd.mac)) {
            const ALLOWED = [1, 3, 4];
            const EXCL = ['mac', 'windows', 'ibeacon', 'appletv', 'homepod', 'ble_', 'wbb'];
            if (ALLOWED.includes(nd.type) && nd.rssi > -100 &&
                !EXCL.some(ex => nd.name.toLowerCase().startsWith(ex))) {
                items.push({ name: nd.name, rssi: nd.rssi, color: '#4e7cff' });
            }
        }
    });

    dotsEl.innerHTML = '';
    items.forEach((item, i) => {
        const distM = Math.pow(10, (RSSI_TX_POWER - item.rssi) / (10 * RSSI_N));
        const norm = Math.min(distM / 30, 1);
        const r = 20 + norm * (RING_R - 20);

        const angle = (i / Math.max(items.length, 1)) * Math.PI * 2 - Math.PI / 2;
        const x = 160 + Math.cos(angle) * r;
        const y = 160 + Math.sin(angle) * r;

        const dot = document.createElement('div');
        dot.className = 'radar-dot';
        dot.style.cssText = `left:${x}px;top:${y}px;background:${item.color};box-shadow:0 0 8px ${item.color}80`;
        dot.innerHTML = `<div class="radar-dot-label">${item.name}</div>`;
        dot.title = `${item.name} · ${item.rssi}dBm · ~${distM < 1 ? '<1' : Math.round(distM)}м`;
        dotsEl.appendChild(dot);
    });
}

setInterval(() => {
    if (currentMode === 'indoor') renderRadar();
}, 2000);

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(() => console.log('SW registered')).catch(() => { });
}
