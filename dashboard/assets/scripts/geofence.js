let drawingMode = false;
let drawPoints = [];
let drawPolyline = null;
let drawMarkers = [];
let pendingZoneName = '';
let isDrawing = false;

function addGeofence() {
    if (!mapOk) { log('Сначала дождитесь GPS fix', 'err'); return; }

    const mode = prompt('Тип зоны:\n1 — Круг\n2 — Нарисовать', '2');

    if (mode === '1') {
        const name = prompt('Название зоны:', 'Безопасная зона');
        if (!name) return;
        const radius = parseInt(prompt('Радиус (метры):', '100')) || 100;
        const center = map.getCenter();
        createCircleZone(name, center.lat, center.lng, radius);
        return;
    }

    pendingZoneName = prompt('Название зоны:', 'Безопасная зона');
    if (!pendingZoneName) return;
    startDrawing();
}

function createCircleZone(name, lat, lon, radius) {
    const id = 'zone_' + Date.now();
    const circle = L.circle([lat, lon], {
        radius, color: '#22c55e', fillColor: '#22c55e',
        fillOpacity: 0.1, weight: 2, dashArray: '5,5'
    }).addTo(map);
    circle.bindTooltip(name, { permanent: true, direction: 'center', className: 'zone-label' });
    geofences.push({ id, name, type: 'circle', lat, lon, radius, shape: circle });
    isInsideZone[id] = {};
    saveGeofences();
    log(`Зона "${name}" создана (${radius}м)`, 'ok');
}

function startDrawing() {
    drawingMode = true;
    drawPoints = [];
    drawPolyline = L.polyline([], { color: '#22c55e', weight: 3, opacity: .8 }).addTo(map);
    map.dragging.disable();
    map.touchZoom.disable();
    map.doubleClickZoom.disable();
    const container = map.getContainer();
    container.style.cursor = 'crosshair';
    container.addEventListener('mousedown', onDrawStart);
    container.addEventListener('mousemove', onDrawMove);
    container.addEventListener('mouseup', onDrawEnd);
    container.addEventListener('touchstart', onDrawStart, { passive: false });
    container.addEventListener('touchmove', onDrawMove, { passive: false });
    container.addEventListener('touchend', onDrawEnd);
    log('🖊️ Зажмите и рисуйте зону. Отпустите для завершения.', 'inf');
}

function getLatLng(e) {
    let cx, cy;
    if (e.touches && e.touches.length) { cx = e.touches[0].clientX; cy = e.touches[0].clientY; }
    else { cx = e.clientX; cy = e.clientY; }
    const rect = map.getContainer().getBoundingClientRect();
    return map.containerPointToLatLng(L.point(cx - rect.left, cy - rect.top));
}

function onDrawStart(e) {
    if (!drawingMode) return;
    e.preventDefault();
    isDrawing = true;
    drawPoints = [];
    const ll = getLatLng(e);
    drawPoints.push([ll.lat, ll.lng]);
    drawPolyline.setLatLngs(drawPoints);
}

function onDrawMove(e) {
    if (!drawingMode || !isDrawing) return;
    e.preventDefault();
    const ll = getLatLng(e);
    drawPoints.push([ll.lat, ll.lng]);
    drawPolyline.setLatLngs(drawPoints);
}

function onDrawEnd(e) {
    if (!drawingMode || !isDrawing) return;
    isDrawing = false;
    stopDrawing();
    if (drawPoints.length < 5) {
        log('Слишком короткий контур', 'err');
        if (drawPolyline) { drawPolyline.remove(); drawPolyline = null; }
        return;
    }
    const simplified = simplify(drawPoints, 0.00005);
    if (drawPolyline) { drawPolyline.remove(); drawPolyline = null; }
    const id = 'zone_' + Date.now();
    const polygon = L.polygon(simplified, {
        color: '#22c55e', fillColor: '#22c55e',
        fillOpacity: 0.1, weight: 2, dashArray: '5,5'
    }).addTo(map);
    polygon.bindTooltip(pendingZoneName, { permanent: true, direction: 'center', className: 'zone-label' });
    geofences.push({ id, name: pendingZoneName, type: 'polygon', points: simplified, shape: polygon });
    isInsideZone[id] = {};
    saveGeofences();
    log(`Зона "${pendingZoneName}" создана (${simplified.length} точек)`, 'ok');
}

function stopDrawing() {
    drawingMode = false;
    const container = map.getContainer();
    container.style.cursor = '';
    container.removeEventListener('mousedown', onDrawStart);
    container.removeEventListener('mousemove', onDrawMove);
    container.removeEventListener('mouseup', onDrawEnd);
    container.removeEventListener('touchstart', onDrawStart);
    container.removeEventListener('touchmove', onDrawMove);
    container.removeEventListener('touchend', onDrawEnd);
    map.dragging.enable();
    map.touchZoom.enable();
    map.doubleClickZoom.enable();
}

function simplify(pts, tol) {
    if (pts.length <= 2) return pts;
    let mx = 0, idx = 0;
    const a = pts[0], b = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
        const d = perpDist(pts[i], a, b);
        if (d > mx) { mx = d; idx = i; }
    }
    if (mx > tol) {
        const l = simplify(pts.slice(0, idx + 1), tol);
        const r = simplify(pts.slice(idx), tol);
        return l.slice(0, -1).concat(r);
    }
    return [a, b];
}

function perpDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.sqrt((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2);
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    return Math.sqrt((p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2);
}

function removeGeofences() {
    if (!confirm('Удалить все зоны?')) return;
    if (drawingMode) stopDrawing();
    if (drawPolyline) { drawPolyline.remove(); drawPolyline = null; }
    geofences.forEach(z => z.shape.remove());
    geofences = [];
    isInsideZone = {};
    saveGeofences();
    log('Все зоны удалены', 'inf');
}

function pointInPolygon(lat, lon, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i][0], yi = polygon[i][1];
        const xj = polygon[j][0], yj = polygon[j][1];
        if (((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi))
            inside = !inside;
    }
    return inside;
}

function checkGeofences(deviceId, lat, lon) {
    const dev = devices.get(deviceId);
    if (!dev) return;

    geofences.forEach(zone => {
        let isIn;
        if (zone.type === 'polygon') isIn = pointInPolygon(lat, lon, zone.points);
        else isIn = distM(lat, lon, zone.lat, zone.lon) <= zone.radius;

        if (!isInsideZone[zone.id]) isInsideZone[zone.id] = {};
        const wasIn = isInsideZone[zone.id][deviceId] !== false;

        if (wasIn && !isIn) {
            log(`⚠️ ${dev.name} ВЫШЕЛ из зоны "${zone.name}"!`, 'err');
            const dist = typeof currentMode !== 'undefined' && currentMode === 'indoor' ? Math.round(distM(lat, lon, zone.lat, zone.lon)) : null;
            sendToServer('/api/geofence', { event: 'exit', deviceName: dev.name, zoneName: zone.name, lat, lon, mode: typeof currentMode !== 'undefined' ? currentMode : 'outdoor', dist, radius: zone.radius });
        } else if (!wasIn && isIn) {
            log(`✅ ${dev.name} вернулся в зону "${zone.name}"`, 'ok');
            const dist = typeof currentMode !== 'undefined' && currentMode === 'indoor' ? Math.round(distM(lat, lon, zone.lat, zone.lon)) : null;
            sendToServer('/api/geofence', { event: 'enter', deviceName: dev.name, zoneName: zone.name, lat, lon, mode: typeof currentMode !== 'undefined' ? currentMode : 'outdoor', dist, radius: zone.radius });
        }

        isInsideZone[zone.id][deviceId] = isIn;
    });
}

function saveGeofences() {
    const data = geofences.map(z => {
        if (z.type === 'polygon') return { id: z.id, name: z.name, type: 'polygon', points: z.points };
        return { id: z.id, name: z.name, type: 'circle', lat: z.lat, lon: z.lon, radius: z.radius };
    });
    localStorage.setItem('geofences', JSON.stringify(data));
}

function loadGeofences() {
    try {
        const data = JSON.parse(localStorage.getItem('geofences') || '[]');
        data.forEach(z => {
            let shape;
            if (z.type === 'polygon') {
                shape = L.polygon(z.points, { color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.1, weight: 2, dashArray: '5,5' }).addTo(map);
            } else {
                shape = L.circle([z.lat, z.lon], { radius: z.radius, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.1, weight: 2, dashArray: '5,5' }).addTo(map);
            }
            shape.bindTooltip(z.name, { permanent: true, direction: 'center', className: 'zone-label' });
            geofences.push({ ...z, shape });
            isInsideZone[z.id] = {};
        });
        if (data.length) log(`Загружено ${data.length} геозон`, 'inf');
    } catch (e) { }
}
