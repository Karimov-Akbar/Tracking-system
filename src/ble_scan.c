/* BLE Scanner – реализация
 * Пассивное сканирование BLE-рекламы
 * Определение типа устройства по Appearance
 * Замена слабых устройств когда буфер полон
 */

#include "ble_scan.h"
#include "ble.h"
#include "ble_gap.h"
#include "nrf_sdh_ble.h"
#include "app_timer.h"
#include "nrf_log.h"

#include <string.h>
#include <stdio.h>

static scanned_device_t m_devices[MAX_SCANNED_DEVICES];
static uint8_t          m_device_count = 0;
static bool             m_scanning     = false;

/* Буфер для данных сканирования */
static uint8_t m_scan_buffer_data[BLE_GAP_SCAN_BUFFER_EXTENDED_MIN];
static ble_data_t m_scan_buffer = {
    .p_data = m_scan_buffer_data,
    .len    = sizeof(m_scan_buffer_data)
};

/* Параметры сканирования */
static ble_gap_scan_params_t const m_scan_params = {
    .active        = 1,
    .interval      = MSEC_TO_UNITS(200, UNIT_0_625_MS),
    .window        = MSEC_TO_UNITS(200, UNIT_0_625_MS),
    .timeout       = 0,
    .scan_phys     = BLE_GAP_PHY_1MBPS,
    .filter_policy = BLE_GAP_SCAN_FP_ACCEPT_ALL,
    .extended      = 0
};

/* Извлечь имя из AD structures */
static bool extract_name(const uint8_t *data, uint16_t len, char *name, uint8_t max_len)
{
    uint16_t pos = 0;
    while (pos < len) {
        uint8_t ad_len  = data[pos];
        if (ad_len == 0 || pos + ad_len >= len) break;
        uint8_t ad_type = data[pos + 1];

        if (ad_type == 0x09 || ad_type == 0x08) {
            uint8_t name_len = ad_len - 1;
            if (name_len > max_len) name_len = max_len;
            memcpy(name, &data[pos + 2], name_len);
            name[name_len] = '\0';
            return true;
        }
        pos += ad_len + 1;
    }
    return false;
}

/* Извлечь Appearance из AD structures */
static uint16_t extract_appearance(const uint8_t *data, uint16_t len)
{
    uint16_t pos = 0;
    while (pos < len) {
        uint8_t ad_len  = data[pos];
        if (ad_len == 0 || pos + ad_len >= len) break;
        uint8_t ad_type = data[pos + 1];
        if (ad_type == 0x19 && ad_len >= 3) {
            return (uint16_t)data[pos + 2] | ((uint16_t)data[pos + 3] << 8);
        }
        pos += ad_len + 1;
    }
    return 0;
}

/* Извлечь Manufacturer Specific Data company ID (AD type 0xFF) */
static uint16_t extract_manufacturer_id(const uint8_t *data, uint16_t len)
{
    uint16_t pos = 0;
    while (pos < len) {
        uint8_t ad_len  = data[pos];
        if (ad_len == 0 || pos + ad_len >= len) break;
        uint8_t ad_type = data[pos + 1];

        /* 0xFF = Manufacturer Specific Data, company ID in first 2 bytes */
        if (ad_type == 0xFF && ad_len >= 3) {
            return (uint16_t)data[pos + 2] | ((uint16_t)data[pos + 3] << 8);
        }
        pos += ad_len + 1;
    }
    return 0xFFFF; /* Not found */
}

/* Определить тип устройства по BLE Appearance + имени + manufacturer */
static uint8_t classify_device(uint16_t appearance, const char *name, uint16_t mfr_id)
{
    /* По Appearance */
    uint16_t cat = appearance >> 6;
    switch (cat) {
        case 1:  return DEV_TYPE_PHONE;
        case 2:  return DEV_TYPE_COMPUTER;
        case 3:  return DEV_TYPE_WATCH;
        case 4:  return DEV_TYPE_WATCH;
        case 5:  return DEV_TYPE_TV;
        case 7:  return DEV_TYPE_TAG;
        case 15: return DEV_TYPE_HEADPHONE;
        case 37: return DEV_TYPE_SPEAKER;
        case 38: return DEV_TYPE_HEADPHONE;
        default: break;
    }

    /* По Manufacturer ID */
    if (mfr_id != 0xFFFF) {
        switch (mfr_id) {
            case 0x004C: return DEV_TYPE_GENERIC;  /* Apple (could be anything) */
            case 0x00E0: return DEV_TYPE_PHONE;    /* Google → likely Android phone */
            case 0x0075: return DEV_TYPE_PHONE;    /* Samsung */
            case 0x027D: return DEV_TYPE_PHONE;    /* Huawei / Honor */
            case 0x0006: return DEV_TYPE_COMPUTER; /* Microsoft */
            case 0x0059: return DEV_TYPE_GENERIC;  /* Nordic Semi */
            case 0x010F: return DEV_TYPE_PHONE;    /* Xiaomi */
            case 0x038F: return DEV_TYPE_HEADPHONE;/* Bose */
            case 0x000A: return DEV_TYPE_HEADPHONE;/* Qualcomm (BT audio) */
            case 0x0310: return DEV_TYPE_PHONE;    /* Realme */
            case 0x0237: return DEV_TYPE_PHONE;    /* OPPO */
            default: break;
        }
    }

    /* По имени */
    if (name[0] != '\0') {
        if (strstr(name, "Phone") || strstr(name, "phone") ||
            strstr(name, "Galaxy") || strstr(name, "iPhone") ||
            strstr(name, "HUAWEI") || strstr(name, "Pixel") ||
            strstr(name, "Redmi") || strstr(name, "POCO") ||
            strstr(name, "Xiaomi") || strstr(name, "OPPO") ||
            strstr(name, "Nokia") || strstr(name, "realme") ||
            strstr(name, "vivo") || strstr(name, "OnePlus") ||
            strstr(name, "GR-AC"))
            return DEV_TYPE_PHONE;

        if (strstr(name, "AirPod") || strstr(name, "Pods") ||
            strstr(name, "Buds") || strstr(name, "JBL") ||
            strstr(name, "Sony") || strstr(name, "WH-") ||
            strstr(name, "WF-") || strstr(name, "QC") ||
            strstr(name, "Bose") || strstr(name, "ear") ||
            strstr(name, "audio"))
            return DEV_TYPE_HEADPHONE;

        if (strstr(name, "Band") || strstr(name, "Watch") ||
            strstr(name, "Fit") || strstr(name, "Mi "))
            return DEV_TYPE_WATCH;

        if (strstr(name, "Speaker") || strstr(name, "Boom") ||
            strstr(name, "Echo") || strstr(name, "Home") ||
            strstr(name, "Yandex"))
            return DEV_TYPE_SPEAKER;

        if (strstr(name, "TV") || strstr(name, "Fire"))
            return DEV_TYPE_TV;

        if (strstr(name, "WBB") || strstr(name, "AP"))
            return DEV_TYPE_GENERIC;
    }

    return DEV_TYPE_UNKNOWN;
}

/* Сгенерировать имя на основе manufacturer ID */
static void generate_name_from_mfr(char *name, uint8_t max_len, uint16_t mfr_id, const uint8_t *addr)
{
    const char *prefix;
    switch (mfr_id) {
        case 0x004C: prefix = "Apple"; break;
        case 0x00E0: prefix = "Android"; break;
        case 0x0075: prefix = "Samsung"; break;
        case 0x027D: prefix = "Huawei"; break;
        case 0x0006: prefix = "Windows"; break;
        case 0x010F: prefix = "Xiaomi"; break;
        case 0x038F: prefix = "Bose"; break;
        case 0x0310: prefix = "Realme"; break;
        case 0x0237: prefix = "OPPO"; break;
        default:     prefix = "BLE"; break;
    }
    snprintf(name, max_len + 1, "%s_%02X%02X", prefix, addr[1], addr[0]);
}

/* Найти устройство по MAC */
static int find_device(const uint8_t *addr)
{
    for (int i = 0; i < m_device_count; i++) {
        if (memcmp(m_devices[i].addr, addr, 6) == 0) return i;
    }
    return -1;
}

/* Найти слот для нового устройства (заменить самый слабый если полно) */
static int find_slot(int8_t new_rssi)
{
    if (m_device_count < MAX_SCANNED_DEVICES) {
        return m_device_count++;
    }
    
    /* Буфер полон — найти устройство с самым слабым RSSI */
    int weakest = 0;
    for (int i = 1; i < MAX_SCANNED_DEVICES; i++) {
        if (m_devices[i].rssi < m_devices[weakest].rssi) {
            weakest = i;
        }
    }
    
    /* Заменить только если новое устройство сильнее */
    if (new_rssi > m_devices[weakest].rssi) {
        return weakest;
    }
    
    return -1; /* Слишком слабый сигнал */
}

void ble_scan_init(void)
{
    memset(m_devices, 0, sizeof(m_devices));
    m_device_count = 0;
    m_scanning = false;
}

void ble_scan_start(void)
{
    if (m_scanning) return;
    uint32_t err = sd_ble_gap_scan_start(&m_scan_params, &m_scan_buffer);
    if (err == NRF_SUCCESS) {
        m_scanning = true;
        NRF_LOG_INFO("BLE scan started");
    } else {
        NRF_LOG_WARNING("Scan start err: %d", err);
    }
}

void ble_scan_stop(void)
{
    if (!m_scanning) return;
    sd_ble_gap_scan_stop();
    m_scanning = false;
    NRF_LOG_INFO("BLE scan stopped");
}

void ble_scan_on_ble_evt(const void *p_evt)
{
    const ble_evt_t *p_ble_evt = (const ble_evt_t *)p_evt;

    if (p_ble_evt->header.evt_id != BLE_GAP_EVT_ADV_REPORT) return;

    const ble_gap_evt_adv_report_t *rpt = &p_ble_evt->evt.gap_evt.params.adv_report;

    char name[SCAN_DEVICE_NAME_LEN + 1] = {0};
    bool has_real_name = extract_name(rpt->data.p_data, rpt->data.len, name, SCAN_DEVICE_NAME_LEN);
    
    uint16_t appearance = extract_appearance(rpt->data.p_data, rpt->data.len);
    uint16_t mfr_id = extract_manufacturer_id(rpt->data.p_data, rpt->data.len);

    int idx = find_device(rpt->peer_addr.addr);

    if (idx >= 0) {
        /* Update existing device */
        m_devices[idx].rssi      = rpt->rssi;
        m_devices[idx].last_seen = app_timer_cnt_get();
        m_devices[idx].active    = true;
        
        /* Only update name if we got a REAL name */
        if (has_real_name) {
            strncpy(m_devices[idx].name, name, SCAN_DEVICE_NAME_LEN);
            m_devices[idx].dev_type = classify_device(appearance, name, mfr_id);
        } else if (appearance != 0 || mfr_id != 0xFFFF) {
            m_devices[idx].dev_type = classify_device(appearance, m_devices[idx].name, mfr_id);
        }
    } else {
        /* New device */
        if (!has_real_name) {
            if (mfr_id != 0xFFFF) {
                generate_name_from_mfr(name, SCAN_DEVICE_NAME_LEN, mfr_id, rpt->peer_addr.addr);
            } else {
                snprintf(name, sizeof(name), "BLE_%02X%02X",
                         rpt->peer_addr.addr[1], rpt->peer_addr.addr[0]);
            }
        }
        
        uint8_t dev_type = classify_device(appearance, name, mfr_id);

        int slot = find_slot(rpt->rssi);
        if (slot >= 0) {
            scanned_device_t *d = &m_devices[slot];
            memcpy(d->addr, rpt->peer_addr.addr, 6);
            d->rssi      = rpt->rssi;
            d->last_seen  = app_timer_cnt_get();
            d->active     = true;
            d->dev_type   = dev_type;
            strncpy(d->name, name, SCAN_DEVICE_NAME_LEN);
            d->name[SCAN_DEVICE_NAME_LEN] = '\0';
            NRF_LOG_INFO("Scan: %s (RSSI:%d type:%d mfr:0x%04X)", name, rpt->rssi, dev_type, mfr_id);
        }
    }

    /* Continue scanning */
    sd_ble_gap_scan_start(NULL, &m_scan_buffer);
}

const scanned_device_t *ble_scan_get_devices(void)
{
    return m_devices;
}

uint8_t ble_scan_get_count(void)
{
    return m_device_count;
}

void ble_scan_cleanup(void)
{
    uint32_t now = app_timer_cnt_get();
    uint32_t timeout_ticks = APP_TIMER_TICKS(SCAN_TIMEOUT_SEC * 1000);

    for (int i = 0; i < m_device_count; i++) {
        uint32_t elapsed = app_timer_cnt_diff_compute(now, m_devices[i].last_seen);
        if (elapsed > timeout_ticks) {
            m_devices[i].active = false;
        }
    }
    
    /* Компактируем: удаляем неактивные */
    int write = 0;
    for (int read = 0; read < m_device_count; read++) {
        if (m_devices[read].active) {
            if (write != read) {
                m_devices[write] = m_devices[read];
            }
            write++;
        }
    }
    m_device_count = write;
}

uint16_t ble_scan_pack(uint8_t *buf, uint16_t buf_size)
{
    /* Формат: [count:1] + для каждого: [MAC:6][RSSI:1][type:1][nameLen:1][name:N] */
    uint16_t pos = 0;
    uint8_t active_count = 0;

    for (int i = 0; i < m_device_count; i++) {
        if (m_devices[i].active) active_count++;
    }

    if (pos + 1 > buf_size) return 0;
    buf[pos++] = active_count;

    for (int i = 0; i < m_device_count && pos < buf_size - 10; i++) {
        if (!m_devices[i].active) continue;

        uint8_t nlen = (uint8_t)strlen(m_devices[i].name);
        if (nlen > SCAN_DEVICE_NAME_LEN) nlen = SCAN_DEVICE_NAME_LEN;
        if (pos + 9 + nlen > buf_size) break;

        memcpy(&buf[pos], m_devices[i].addr, 6);  pos += 6;
        buf[pos++] = (uint8_t)m_devices[i].rssi;
        buf[pos++] = m_devices[i].dev_type;
        buf[pos++] = nlen;
        memcpy(&buf[pos], m_devices[i].name, nlen); pos += nlen;
    }

    return pos;
}
