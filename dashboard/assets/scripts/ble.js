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
        renderDeviceList();
    };
}

function onSOSFor(deviceId) {
    return function(e) {
        const active = e.target.value.getUint8(0) === 1;
        handleSOS(deviceId, active);
    };
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

        const statusDot = d.sosActive ? '🆘' : (d.fix ? '🟢' : '🟡');

        card.innerHTML = `
            <div class="device-header">
                <div class="device-color" style="background:${d.color}"></div>
                <div class="device-name">${statusDot} ${d.name}</div>
                <button class="device-disconnect" onclick="event.stopPropagation();disconnectDevice('${id}')" title="Отключить">✕</button>
            </div>
            <div class="device-stats">
                <span>${d.fix ? 'Fix' : 'No Fix'}</span>
                <span>🛰️ ${d.sat}</span>
                <span>🚀 ${d.spd} км/ч</span>
                <span>${d.activityIcon} ${d.activity}</span>
            </div>
            ${d.lastLat ? `<div class="device-coords">${d.lastLat.toFixed(5)}, ${d.lastLon.toFixed(5)}</div>` : ''}
        `;
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

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(() => console.log('SW registered')).catch(() => {});
}
