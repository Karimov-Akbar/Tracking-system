function exportGPX(deviceId) {
    const id = deviceId || selectedDeviceId;
    if (!id) { log('Выберите устройство', 'err'); return; }
    const d = devices.get(id);
    if (!d || d.trackHistory.length === 0) { log('Нет данных для экспорта', 'err'); return; }

    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPS Tracker BLE" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${d.name}</name><trkseg>
`;
    for (const pt of d.trackHistory) gpx += `    <trkpt lat="${pt.lat}" lon="${pt.lon}"><time>${pt.time}</time></trkpt>\n`;
    gpx += `  </trkseg></trk></gpx>`;

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
    a.download = `${d.name}_${new Date().toISOString().slice(0,10)}.gpx`;
    a.click();
    log(`GPX экспорт: ${d.name} (${d.trackHistory.length} точек)`, 'ok');
}
