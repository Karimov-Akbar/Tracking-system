function showAlert(message) {
    const el = document.getElementById('alertBanner');
    if (el) {
        el.textContent = message;
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), 8000);
    }
    try { new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbsGczHDdlj8LR17hkNx06Y4a6y9O+dEo3N2WDt8jOxZNfQzlhf7TFzMqjcE86XXqvwsrMroFXP1h0qr3Gy76OZENVcae8x8i+l3BJUW2mu8LDvpp0TWJqo7jBxr+hfFxcaZ+1vsLCr5B0XmNlnLK6v72rl39pZGacsbq9v7OcgW1nZpuwuLy/t6OIcmxnn7C4vL+5qoyBamafr7e8wLutlYd0ameesLa7wL60nIl+c2ZdnrC2u8C/t6GMgXdpZp2vtru/v7ijj4Z6cGWdr7a7wMC5pZGKf3ZmnK+2u8DAu6eTjIB4Zpyvtru/wLynlY6DemWbr7W6v7+9qpiRh3xnm6+1ur+/vaqYkYd8Z5uvtbq/v72qmJGHfA==').play(); } catch(e) {}
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
