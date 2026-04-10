const SVC = '12340001-1234-5678-1234-56789abcdef0';
const CHR_LOC = '12340002-1234-5678-1234-56789abcdef0';
const CHR_STS = '12340003-1234-5678-1234-56789abcdef0';
const CHR_SOS = '12340004-1234-5678-1234-56789abcdef0';
const CHR_SCAN = '12340005-1234-5678-1234-56789abcdef0';

const API_URL = ''; // Nginx proxies /api and everything locally instead of port 3001 directly.

const DEVICE_COLORS = [
    '#4e7cff', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa',
    '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1'
];

let devices = new Map();
let selectedDeviceId = null;
let colorIndex = 0;

let map = null, mapOk = false;
let geofences = [];
let isInsideZone = {};
let heatLayer = null, heatPts = [];
let nearbyDevices = [];

const MIN_MOVE_M = 10;
const RSSI_TX_POWER = -59;
const RSSI_N = 2.0;

function getNextColor() {
    const c = DEVICE_COLORS[colorIndex % DEVICE_COLORS.length];
    colorIndex++;
    return c;
}

function createDeviceState(id, name, color) {
    return {
        id, name, color,
        dev: null, srv: null,
        chrLoc: null, chrSts: null, chrSos: null, chrScan: null,
        marker: null, track: null, label: null,
        pts: [], trackHistory: [],
        lastLat: 0, lastLon: 0,
        lastSpeed: 0, lastSat: 0,
        fix: false, sosActive: false,
        activity: '—', activityIcon: '',
        sat: 0, spd: 0, alt: 0,
        interval: null, nCount: 0
    };
}
