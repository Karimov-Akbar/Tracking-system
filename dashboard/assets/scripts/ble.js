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
    return function(e) {
        const d = devices.get(deviceId);
        if (!d) return;
        d.nCount++;
        const loc = parseLoc(e.target.value);
        if (!loc) return;
        d.alt = loc.alt;
        updateDevicePosition(deviceId, loc.lat, loc.lon);
        /* Hide GPS loader on first valid fix */
        if (loc.lat !== 0 || loc.lon !== 0) {
            const loader = document.getElementById('gpsLoader');
            if (loader) loader.style.display = 'none';
        }
        renderDeviceList();
    };
}

function onStsFor(deviceId) {
    return function(dv) {
        const d = devices.get(deviceId);
        if (!d) return;
        const s = (dv.target) ? parseSts(dv.target.value) : parseSts(dv);
        if (!s) return;
        d.fix = !!s.fix;
        d.lastSpeed = s.spd;
        d.lastSat = s.sat;
        d.sat = s.sat;
        d.spd = (s.sat < 5 && s.spd <= 3) ? 0 : s.spd;
        const act = classifyMotion(d.spd);
        d.activity = act.label;
        d.activityIcon = act.icon;
        /* Show GPS loader when No Fix */
        const loader = document.getElementById('gpsLoader');
        if (loader && !d.isNearby) {
            loader.style.display = d.fix ? 'none' : 'flex';
        }
        renderDeviceList();
    };
}

function onSOSFor(deviceId) {
    return function(e) {
        const active = e.target.value.getUint8(0) === 1;
        handleSOS(deviceId, active);
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

function onScanFor(deviceId) {
    return function(e) {
        const list = parseScan(e.target.value);
        nearbyDevices = list;
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
            } catch(e) {
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
        onStsFor(deviceId)( v );
    } catch(e) {
        if (d.dev && d.dev.gatt.connected) log(`${d.name}: read err`, 'err');
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
        /* Show GPS loader until fix */
        const loader = document.getElementById('gpsLoader');
        if (loader) loader.style.display = 'flex';
        btDev.addEventListener('gattserverdisconnected', () => onDeviceDisconnect(deviceId));

        const server = await btDev.gatt.connect();
        state.srv = server;
        const svc = await server.getPrimaryService(SVC);

        state.chrLoc = await svc.getCharacteristic(CHR_LOC);
        await state.chrLoc.startNotifications();
        state.chrLoc.addEventListener('characteristicvaluechanged', onLocFor(deviceId));
        log(`${deviceName}: Location ✓`, 'ok');

        state.chrSts = await svc.getCharacteristic(CHR_STS);
        log(`${deviceName}: Status ✓`, 'ok');

        try {
            state.chrSos = await svc.getCharacteristic(CHR_SOS);
            await state.chrSos.startNotifications();
            state.chrSos.addEventListener('characteristicvaluechanged', onSOSFor(deviceId));
            log(`${deviceName}: SOS ✓`, 'ok');
        } catch(e) {}

        try {
            state.chrScan = await svc.getCharacteristic(CHR_SCAN);
            await state.chrScan.startNotifications();
            state.chrScan.addEventListener('characteristicvaluechanged', onScanFor(deviceId));
            log(`${deviceName}: Scan ✓`, 'ok');
        } catch(e) { log(`${deviceName}: Scan не поддерживается`, 'inf'); }

        if (btDev.watchAdvertisements) {
            try {
                await btDev.watchAdvertisements();
                btDev.addEventListener('advertisementreceived', (e) => {
                    state.rssi = e.rssi;
                });
            } catch(e) {}
        }

        await readStsFor(deviceId);
        state.interval = setInterval(() => readStsFor(deviceId), 2000);

        if (mapOk) addDeviceToMap(state);
        if (!selectedDeviceId) selectedDeviceId = deviceId;

        renderDeviceList();
        updateDeviceCount();
        log(`${deviceName} подключён ✓`, 'ok');

    } catch(e) {
        log('Ошибка: ' + e.message, 'err');
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
    if (d.interval) clearInterval(d.interval);
    if (d.marker) d.marker.remove();
    if (d.track) d.track.remove();
    log(`${d.name} отключён`, 'err');
    sendToServer('/api/disconnect', { deviceName: d.name });
    devices.delete(deviceId);
    if (selectedDeviceId === deviceId) {
        selectedDeviceId = devices.size > 0 ? devices.keys().next().value : null;
    }
    renderDeviceList();
    updateDeviceCount();
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
        card.className = 'device-card' + (id === selectedDeviceId ? ' active' : '') + (d.sosActive ? ' sos' : '');
        card.onclick = () => focusDevice(id);

        if (d.isNearby) {
            /* BLE tracked device — show type icon and RSSI */
            const nd = nearbyDevices.find(n => n.mac === d.nearbyMac);
            const rssi = nd ? nd.rssi : d.nearbyRssi;
            const dist = estimateDistance(rssi);
            const typeIcon = d.nearbyType != null ? deviceIcon(d.nearbyType) : '<span class="material-symbols-outlined" style="font-size:16px">bluetooth</span>';
            card.innerHTML = `
                <div class="device-header">
                    <div class="device-color" style="background:${d.color}"></div>
                    <div class="device-name">${typeIcon} ${d.name}</div>
                    <button class="device-disconnect" onclick="event.stopPropagation();disconnectDevice('${id}')" title="Убрать">✕</button>
                </div>
                <div class="device-stats">
                    <span>${rssi}dBm</span>
                    <span>~${dist}м</span>
                </div>
            `;
        } else {
            /* GPS Tracker — show compact GPS info */
            const statusDot = d.sosActive
                ? '<span class="material-symbols-outlined" style="font-size:16px;color:#ef4444">warning</span>'
                : d.fix
                    ? '<span class="material-symbols-outlined" style="font-size:16px;color:#22c55e">circle</span>'
                    : '<span class="material-symbols-outlined" style="font-size:16px;color:#eab308">circle</span>';
            card.innerHTML = `
                <div class="device-header">
                    <div class="device-color" style="background:${d.color}"></div>
                    <div class="device-name">${statusDot} ${d.name}</div>
                    <button class="device-disconnect" onclick="event.stopPropagation();disconnectDevice('${id}')" title="Отключить">✕</button>
                </div>
                <div class="device-stats">
                    <span>${d.fix ? 'Fix' : 'No Fix'}</span>
                    <span><span class="material-symbols-outlined" style="font-size:13px">satellite_alt</span> ${d.sat}</span>
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

    /* Filter out tracked devices */
    const filtered = nearbyDevices.filter(nd => !devices.has('nearby_' + nd.mac));

    if (filtered.length === 0) {
        el.innerHTML = '<div class="no-devices">Нет устройств рядом</div>';
    } else {
        el.innerHTML = filtered.map(nd => {
            const dist = estimateDistance(nd.rssi);
            const bars = nd.rssi > -50 ? '▓▓▓▓' : nd.rssi > -70 ? '▓▓▓░' : nd.rssi > -85 ? '▓▓░░' : '▓░░░';
            return `<div class="nearby-card">
                <div class="nearby-name">${deviceIcon(nd.type)} ${nd.name}</div>
                <div class="nearby-info">
                    <span class="nearby-signal">${bars} ${nd.rssi}dBm</span>
                    <span class="nearby-dist">~${dist}м</span>
                    <button class="nearby-btn" onclick="trackNearbyDevice('${nd.mac}','${nd.name.replace(/'/g,'')}',${nd.rssi},${nd.type})">+</button>
                </div>
            </div>`;
        }).join('');
    }
    const countEl = document.getElementById('nearbyCount');
    if (countEl) countEl.textContent = filtered.length;

    /* Auto-update tracked nearby devices positions */
    updateTrackedNearbyPositions();
}

function trackNearbyDevice(mac, name, rssi, type) {
    const deviceId = 'nearby_' + mac;
    if (devices.has(deviceId)) return;

    /* Get dongle position as base */
    let baseLat = 0, baseLon = 0;
    devices.forEach(d => {
        if (d.lastLat && !d.id.startsWith('nearby_')) {
            baseLat = d.lastLat;
            baseLon = d.lastLon;
        }
    });

    if (!baseLat) { log('Нет GPS — позиция трекера неизвестна', 'err'); return; }

    const color = getNextColor();
    const state = createDeviceState(deviceId, name, color);
    state.lastLat = baseLat;
    state.lastLon = baseLon;
    state.isNearby = true;
    state.nearbyMac = mac;
    state.nearbyRssi = rssi;
    state.nearbyType = type != null ? type : 0;
    devices.set(deviceId, state);

    if (mapOk) addDeviceToMap(state);
    updateDevicePosition(deviceId, baseLat, baseLon);
    renderDeviceList();
    renderNearbyDevices();
    updateDeviceCount();
    log(`${name} добавлен на карту`, 'ok');
    /* Notify Telegram (skip GPS Tracker) */
    if (!name.startsWith('GPS')) {
        sendToServer('/api/track', { deviceName: name, action: 'add' });
    }
}

function untrackNearbyDevice(mac) {
    const did = 'nearby_' + mac;
    const d = devices.get(did);
    /* Notify Telegram before removing */
    if (d && !d.name.startsWith('GPS')) {
        sendToServer('/api/track', { deviceName: d.name, action: 'remove' });
    }
    disconnectDevice(did);
    renderNearbyDevices();
}

function updateTrackedNearbyPositions() {
    /* Get dongle position */
    let baseLat = 0, baseLon = 0;
    devices.forEach(d => {
        if (d.lastLat && !d.id.startsWith('nearby_')) {
            baseLat = d.lastLat;
            baseLon = d.lastLon;
        }
    });
    if (!baseLat) return;

    nearbyDevices.forEach(nd => {
        const did = 'nearby_' + nd.mac;
        const d = devices.get(did);
        if (!d) return;
        d.nearbyRssi = nd.rssi;
        /* Position = dongle position (nearby device is close) */
        updateDevicePosition(did, baseLat, baseLon);
    });
}

function estimateDistance(rssi) {
    const d = Math.pow(10, (RSSI_TX_POWER - rssi) / (10 * RSSI_N));
    return d < 1 ? '<1' : Math.round(d).toString();
}

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(() => console.log('SW registered')).catch(() => {});
}
