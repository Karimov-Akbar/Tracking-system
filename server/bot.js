require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3001;
const TRACKER_URL = process.env.TRACKER_URL || 'https://tracker.muhandisd.uz';

const bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, params: { timeout: 10 } } });
const app = express();
app.use(cors());
app.use(express.json());

bot.on('polling_error', (err) => {
    if (err.code !== 'ETELEGRAM') console.error('Polling error:', err.code);
});

let subscribedChats = new Set();
let deviceLocations = {};
let deviceSOS = {};

const fs = require('fs');
const CHATS_FILE = __dirname + '/chats.json';
try {
    if (fs.existsSync(CHATS_FILE)) {
        subscribedChats = new Set(JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')));
    }
} catch(e) {}

function saveChats() {
    fs.writeFileSync(CHATS_FILE, JSON.stringify([...subscribedChats]));
}

bot.onText(/\/start/, (msg) => {
    subscribedChats.add(msg.chat.id);
    saveChats();
    bot.sendMessage(msg.chat.id,
        `🛰️ *GPS Tracker — Система мониторинга*\n\n` +
        `Вы подписаны на уведомления!\n\n` +
        `/status — все устройства\n` +
        `/devices — список устройств\n` +
        `/location — координаты всех\n` +
        `/stop — отписаться\n\n` +
        `🌐 Дашборд: ${TRACKER_URL}`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/stop/, (msg) => {
    subscribedChats.delete(msg.chat.id);
    saveChats();
    bot.sendMessage(msg.chat.id, '🔕 Вы отписались.');
});

bot.onText(/\/status/, (msg) => {
    const names = Object.keys(deviceLocations);
    if (names.length === 0) {
        bot.sendMessage(msg.chat.id, '❌ Нет активных устройств.');
        return;
    }
    let text = `📡 *Статус устройств (${names.length})*\n\n`;
    names.forEach(name => {
        const d = deviceLocations[name];
        const ago = Math.round((Date.now() - d.timestamp) / 1000);
        const sos = deviceSOS[name] ? '🆘' : '✅';
        text += `${sos} *${name}*\n`;
        text += `📍 \`${d.lat.toFixed(6)}, ${d.lon.toFixed(6)}\`\n`;
        text += `🛰️ ${d.sat || '—'} спутн. · 🚀 ${d.spd || 0} км/ч\n`;
        text += `⏱️ ${ago}с назад\n\n`;
    });
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/devices/, (msg) => {
    const names = Object.keys(deviceLocations);
    if (names.length === 0) {
        bot.sendMessage(msg.chat.id, '❌ Нет активных устройств.');
        return;
    }
    let text = `📋 *Устройства (${names.length}):*\n\n`;
    names.forEach((name, i) => {
        const sos = deviceSOS[name] ? '🆘' : '🟢';
        text += `${i+1}. ${sos} ${name}\n`;
    });
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/location/, (msg) => {
    const names = Object.keys(deviceLocations);
    if (names.length === 0) {
        bot.sendMessage(msg.chat.id, '❌ Нет активных устройств.');
        return;
    }
    names.forEach(name => {
        const d = deviceLocations[name];
        if (d.lat && d.lon) {
            bot.sendMessage(msg.chat.id, `📍 *${name}:*`, { parse_mode: 'Markdown' }).catch(() => {});
            bot.sendLocation(msg.chat.id, d.lat, d.lon).catch(() => {});
        }
    });
});

app.post('/api/location', (req, res) => {
    const { deviceName, lat, lon, sat, spd, fix } = req.body;
    const name = deviceName || 'Unknown';
    deviceLocations[name] = { lat, lon, sat, spd, fix, timestamp: Date.now() };
    res.json({ ok: true });
});

app.post('/api/sos', (req, res) => {
    const { active, deviceName, lat, lon } = req.body;
    const name = deviceName || 'Unknown';
    deviceSOS[name] = active;

    const message = active
        ? `🆘 *SOS: ${name}*\n\n📍 \`${lat?.toFixed(6) || '—'}, ${lon?.toFixed(6) || '—'}\`\n🕐 ${new Date().toLocaleTimeString('ru-RU')}\n\n🗺️ [Карта](https://www.google.com/maps?q=${lat},${lon})`
        : `✅ *SOS снят: ${name}*`;

    for (const chatId of subscribedChats) {
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
        if (active && lat && lon) bot.sendLocation(chatId, lat, lon).catch(() => {});
    }
    res.json({ ok: true, notified: subscribedChats.size });
});

app.post('/api/geofence', (req, res) => {
    const { event, deviceName, zoneName, lat, lon } = req.body;
    const name = deviceName || 'Unknown';
    const emoji = event === 'exit' ? '🚨' : '✅';
    const action = event === 'exit' ? 'ПОКИНУЛ' : 'ВЕРНУЛСЯ в';

    const message =
        `${emoji} *${name} ${action} зону "${zoneName}"*\n\n` +
        `📍 \`${lat?.toFixed(6) || '—'}, ${lon?.toFixed(6) || '—'}\`\n` +
        `🕐 ${new Date().toLocaleTimeString('ru-RU')}\n\n` +
        `🗺️ [Карта](https://www.google.com/maps?q=${lat},${lon})`;

    for (const chatId of subscribedChats) {
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => {});
    }
    res.json({ ok: true, notified: subscribedChats.size });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        subscribers: subscribedChats.size,
        devices: Object.keys(deviceLocations).length,
        deviceList: Object.keys(deviceLocations)
    });
});

app.listen(PORT, () => {
    console.log(`GPS Tracker server on port ${PORT}`);
    console.log(`Telegram bot active. ${subscribedChats.size} subscribers.`);
});
