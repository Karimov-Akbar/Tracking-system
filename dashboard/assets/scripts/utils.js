function distM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
              Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
              Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function rssiToDistance(rssi) {
    if (rssi === 0) return -1;
    return Math.pow(10, (RSSI_TX_POWER - rssi) / (10 * RSSI_N));
}

function log(msg, cls = '') {
    const box = document.getElementById('logBox');
    if (!box) return;
    const row = document.createElement('div');
    row.className = 'log-row ' + cls;
    const t = new Date().toLocaleTimeString('ru-RU');
    row.innerHTML = `<span class="t">${t}</span><span class="m">${msg}</span>`;
    box.prepend(row);
    while (box.children.length > 80) box.removeChild(box.lastChild);
}

function classifyMotion(speed) {
    if (speed < 1)  return { label: 'Стоит',     icon: '🧍', color: '#6b7280' };
    if (speed < 6)  return { label: 'Идёт',      icon: '🚶', color: '#22c55e' };
    if (speed < 15) return { label: 'Бежит',     icon: '🏃', color: '#f59e0b' };
    if (speed < 40) return { label: 'Велосипед', icon: '🚲', color: '#3b82f6' };
    return              { label: 'Авто',      icon: '🚗', color: '#ef4444' };
}

async function sendToServer(path, data) {
    try {
        await fetch(API_URL + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    } catch(e) {}
}
