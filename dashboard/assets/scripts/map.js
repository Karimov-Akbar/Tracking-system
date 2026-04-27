function ensureMap(lat, lon) {
    if (mapOk) return;
    const w = document.getElementById('welcomeScreen');
    if (w) w.style.display = 'none';

    map = L.map('map', { zoomControl: false }).setView([lat, lon], 16);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap · CartoDB', maxZoom: 19
    }).addTo(map);

    if (typeof L.heatLayer === 'function') {
        heatLayer = L.heatLayer([], {
            radius: 25, blur: 15, maxZoom: 17,
            gradient: { 0.2: '#2563eb', 0.4: '#7c3aed', 0.6: '#f59e0b', 0.8: '#ef4444', 1: '#fff' }
        });
    }

    loadGeofences();
    mapOk = true;
}

function addDeviceToMap(device) {
    const icon = L.divIcon({
        className: '',
        html: `<div style="position:relative">
            <div style="width:18px;height:18px;background:${device.color};border:3px solid #fff;border-radius:50%;box-shadow:0 0 16px ${device.color}80"></div>
            <div style="position:absolute;top:-20px;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(0,0,0,.7);color:#fff;font:600 10px 'Inter',sans-serif;padding:2px 6px;border-radius:4px;pointer-events:none">${device.name}</div>
        </div>`,
        iconSize: [18, 18], iconAnchor: [9, 9]
    });
    device.marker = L.marker([device.lastLat || 0, device.lastLon || 0], { icon }).addTo(map);
    device.track = L.polyline([], { color: device.color, weight: 3, opacity: .7 }).addTo(map);
}

function updateDevicePosition(deviceId, lat, lon) {
    const d = devices.get(deviceId);
    if (!d) return;

    ensureMap(lat, lon);

    if (!d.marker && mapOk) addDeviceToMap(d);

    if (d.marker) d.marker.setLatLng([lat, lon]);

    if (selectedDeviceId === deviceId || devices.size === 1) {
        map.panTo([lat, lon], { animate: true, duration: .4 });
        document.getElementById('mapCoords').textContent = lat.toFixed(5) + ', ' + lon.toFixed(5);
    }

    if (d.lastSat >= 5) {
        const dist = distM(d.lastLat, d.lastLon, lat, lon);
        if (dist >= MIN_MOVE_M) {
            const activity = classifyMotion(d.lastSpeed);
            d.pts.push([lat, lon]);
            if (d.pts.length > 1000) d.pts.shift();
            if (d.track) {
                d.track.setLatLngs(d.pts);
                d.track.setStyle({ color: activity.color });
            }
            d.trackHistory.push({ lat, lon, time: new Date().toISOString(), speed: d.lastSpeed });
        }
    }

    d.lastLat = lat;
    d.lastLon = lon;

    heatPts.push([lat, lon, 0.5]);
    if (heatPts.length > 3000) heatPts.shift();
    if (heatLayer && map.hasLayer(heatLayer)) heatLayer.setLatLngs(heatPts);

    checkGeofences(deviceId, lat, lon);

    const payload = {
        deviceId,
        deviceName: d.name,
        lat,
        lon,
        sat: d.lastSat,
        spd: d.lastSpeed,
        fix: 1,
        mode: currentMode,
        isNearby: d.isNearby ? true : false,
        dist: d.isNearby ? estimateDistance(d.nearbyRssi) : 0
    };
    sendToServer('/api/location', payload);
}

function focusDevice(deviceId) {
    const d = devices.get(deviceId);
    if (!d || !d.lastLat) return;
    selectedDeviceId = deviceId;
    map.setView([d.lastLat, d.lastLon], 17, { animate: true });
    renderDeviceList();
}

function toggleHeatmap() {
    if (!heatLayer || !mapOk) return;
    const btn = document.getElementById('heatBtn');
    if (map.hasLayer(heatLayer)) {
        map.removeLayer(heatLayer);
        if (btn) btn.classList.remove('active');
    } else {
        heatLayer.addTo(map);
        if (btn) btn.classList.add('active');
    }
}

window.addEventListener('resize', () => {
    if (mapOk && map) {
        setTimeout(() => map.invalidateSize(), 100);
    }
});
