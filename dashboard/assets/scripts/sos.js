function showAlert(message) {
    /* Removed — red SOS banner is sufficient */
}

function handleSOS(deviceId, active) {
    const d = devices.get(deviceId);
    if (!d) return;
    d.sosActive = active;

    const sosBanner = document.getElementById('sosBanner');
    const nameSpan = document.getElementById('sosDeviceName');

    if (active) {
        log(`🆘 SOS от "${d.name}"!`, 'err');
        if (sosBanner) sosBanner.classList.add('show');
        if (nameSpan) nameSpan.textContent = d.name;
        showAlert(`🆘 SOS от ${d.name}!`);
        sendToServer('/api/sos', { active: true, deviceName: d.name, lat: d.lastLat, lon: d.lastLon });
    } else {
        log(`✅ SOS отменён: ${d.name}`, 'ok');
        const anyActive = [...devices.values()].some(dev => dev.sosActive);
        if (!anyActive && sosBanner) sosBanner.classList.remove('show');
        sendToServer('/api/sos', { active: false, deviceName: d.name, lat: d.lastLat, lon: d.lastLon });
    }

    renderDeviceList();
}
