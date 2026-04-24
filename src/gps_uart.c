/**
 * @file gps_uart.c
 * @brief GPS UART driver implementation using app_uart_fifo.
 */
#include "gps_uart.h"

#include <string.h>
#include <stdio.h>

#include "app_uart.h"
#include "app_error.h"
#include "nrf_uart.h"
#include "nrf_log.h"
#include "nrf_delay.h"

/** @brief UART FIFO buffer sizes */
#define UART_TX_BUF_SIZE    64
#define UART_RX_BUF_SIZE    256

/** @brief Line assembly buffer */
static char     m_line_buf[GPS_NMEA_MAX_LEN];
static uint16_t m_line_pos = 0;

/** @brief Registered line callback */
static gps_uart_line_handler_t m_line_handler = NULL;

/** @brief Initialization flag */
static bool m_initialized = false;

/** @brief Diagnostic counters */
static uint32_t m_bytes_received = 0;
static uint32_t m_lines_received = 0;


/**
 * @brief UART event handler (called from interrupt context).
 */
static void uart_event_handler(app_uart_evt_t *p_event)
{
    switch (p_event->evt_type)
    {
        case APP_UART_COMMUNICATION_ERROR:
            NRF_LOG_WARNING("GPS UART comm error: 0x%08X", p_event->data.error_communication);
            break;

        case APP_UART_FIFO_ERROR:
            NRF_LOG_WARNING("GPS UART FIFO error: 0x%08X", p_event->data.error_code);
            app_uart_flush();
            break;

        case APP_UART_DATA_READY:
            /* Data will be read in gps_uart_process() */
            break;

        default:
            break;
    }
}


/* Forward declarations for GPS config functions */
static void gps_send_str(const char *str);
static void gps_send_nmea(const char *body);
static void gps_send_ubx(uint8_t cls, uint8_t id, const uint8_t *payload, uint16_t plen);
static void gps_send_config(void);


uint32_t gps_uart_init(gps_uart_line_handler_t line_handler)
{
    if (m_initialized)
    {
        return NRF_ERROR_INVALID_STATE;
    }

    m_line_handler = line_handler;
    m_line_pos     = 0;
    memset(m_line_buf, 0, sizeof(m_line_buf));

    const app_uart_comm_params_t comm_params =
    {
        .rx_pin_no    = GPS_UART_RX_PIN,
        .tx_pin_no    = GPS_UART_TX_PIN,
        .rts_pin_no   = GPS_UART_RTS_PIN,
        .cts_pin_no   = GPS_UART_CTS_PIN,
        .flow_control = APP_UART_FLOW_CONTROL_DISABLED,
        .use_parity   = false,
        .baud_rate    = GPS_UART_BAUDRATE,
    };

    uint32_t err_code;

    APP_UART_FIFO_INIT(&comm_params,
                       UART_RX_BUF_SIZE,
                       UART_TX_BUF_SIZE,
                       uart_event_handler,
                       APP_IRQ_PRIORITY_LOWEST,
                       err_code);

    if (err_code == NRF_SUCCESS)
    {
        m_initialized = true;
        NRF_LOG_INFO("GPS UART initialized (RX=P0.15, TX=P0.17, 9600 baud)");

        /* Configure NEO-6M for max accuracy and fast start */
        gps_send_config();
    }

    return err_code;
}


/**
 * @brief Send a string to GPS module via UART.
 */
static void gps_send_str(const char *str)
{
    while (*str) {
        app_uart_put(*str++);
    }
}

/**
 * @brief Calculate NMEA checksum and send command with $...*XX\r\n
 */
static void gps_send_nmea(const char *body)
{
    uint8_t cksum = 0;
    for (const char *p = body; *p; p++) cksum ^= *p;

    char buf[80];
    int len = snprintf(buf, sizeof(buf), "$%s*%02X\r\n", body, cksum);
    (void)len;
    gps_send_str(buf);
}

/**
 * @brief Send UBX binary command to GPS.
 */
static void gps_send_ubx(uint8_t cls, uint8_t id, const uint8_t *payload, uint16_t plen)
{
    uint8_t ck_a = 0, ck_b = 0;

    app_uart_put(0xB5);
    app_uart_put(0x62);

    uint8_t hdr[4] = { cls, id, (uint8_t)(plen & 0xFF), (uint8_t)(plen >> 8) };
    for (int i = 0; i < 4; i++) { app_uart_put(hdr[i]); ck_a += hdr[i]; ck_b += ck_a; }
    for (int i = 0; i < plen; i++) { app_uart_put(payload[i]); ck_a += payload[i]; ck_b += ck_a; }

    app_uart_put(ck_a);
    app_uart_put(ck_b);
}

/**
 * @brief Configure NEO-6M for max accuracy and hot start.
 */
static void gps_send_config(void)
{
    /* 1. Disable unused NMEA sentences (GLL, VTG) to save UART bandwidth */
    gps_send_nmea("PUBX,40,GLL,0,0,0,0");
    gps_send_nmea("PUBX,40,VTG,0,0,0,0");

    /* 2. Set Portable navigation mode (0) for better sensitivity near windows
     * UBX-CFG-NAV5: class=0x06, id=0x24, len=36 */
    uint8_t nav5[36] = {0};
    nav5[0] = 0x01;  /* mask: apply dynModel */
    nav5[1] = 0x00;
    nav5[2] = 0x00;  /* dynModel = Portable */
    nav5[3] = 0x03;  /* fixMode = auto 2D/3D */
    gps_send_ubx(0x06, 0x24, nav5, sizeof(nav5));

    /* 3. Enable SBAS for better accuracy
     * UBX-CFG-SBAS: class=0x06, id=0x16, len=8 */
    uint8_t sbas[8] = {0x01, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00};
    gps_send_ubx(0x06, 0x16, sbas, sizeof(sbas));

    /* 4. Save config to BBR + Flash so it persists across reboots
     * UBX-CFG-CFG: saveMask=0xFFFF, deviceMask=0x17 */
    uint8_t cfg_save[13] = {0};
    cfg_save[4] = 0xFF; /* saveMask LSB */
    cfg_save[5] = 0xFF; /* saveMask MSB */
    cfg_save[12] = 0x17; /* deviceMask: BBR|Flash|SPI */
    gps_send_ubx(0x06, 0x09, cfg_save, sizeof(cfg_save));

    NRF_LOG_INFO("GPS: configured (portable, SBAS) & saved to flash");
}


void gps_uart_process(void)
{
    if (!m_initialized)
    {
        return;
    }

    uint8_t byte;

    /* Read all available bytes from the FIFO */
    while (app_uart_get(&byte) == NRF_SUCCESS)
    {
        m_bytes_received++;
        /* Ignore carriage return, use newline as sentence terminator */
        if (byte == '\r')
        {
            continue;
        }

        if (byte == '\n')
        {
            /* End of NMEA sentence */
            if (m_line_pos > 0)
            {
                m_line_buf[m_line_pos] = '\0';
                m_lines_received++;

                NRF_LOG_DEBUG("GPS NMEA [%d]: %s", m_line_pos, m_line_buf);

                if (m_line_handler != NULL)
                {
                    m_line_handler(m_line_buf, m_line_pos);
                }

                m_line_pos = 0;
            }
            continue;
        }

        /* Append byte to line buffer */
        if (m_line_pos < (GPS_NMEA_MAX_LEN - 1))
        {
            m_line_buf[m_line_pos++] = (char)byte;
        }
        else
        {
            /* Line too long — discard and reset */
            NRF_LOG_WARNING("GPS NMEA line overflow, discarding");
            m_line_pos = 0;
        }
    }
}


void gps_uart_uninit(void)
{
    if (m_initialized)
    {
        app_uart_close();
        m_initialized  = false;
        m_line_handler = NULL;
        m_line_pos     = 0;
    }
}


void gps_uart_get_diagnostics(uint32_t *p_bytes, uint32_t *p_lines)
{
    if (p_bytes != NULL)
    {
        *p_bytes = m_bytes_received;
    }
    if (p_lines != NULL)
    {
        *p_lines = m_lines_received;
    }
}


/**
 * @brief Send a single byte to GPS module via UART.
 */
static void send_ubx_byte(uint8_t byte)
{
    uint32_t err;
    do {
        err = app_uart_put(byte);
    } while (err == NRF_ERROR_NO_MEM);  /* Retry if TX FIFO full */
}


/**
 * @brief Send a complete UBX message to the GPS module.
 *
 * Calculates Fletcher checksum and wraps payload with sync header.
 *
 * @param[in] cls      UBX message class
 * @param[in] id       UBX message ID
 * @param[in] p_data   Payload data
 * @param[in] len      Payload length
 */
static void send_ubx_message(uint8_t cls, uint8_t id,
                              const uint8_t *p_data, uint16_t len)
{
    /* Sync header */
    send_ubx_byte(0xB5);
    send_ubx_byte(0x62);

    /* Class + ID */
    send_ubx_byte(cls);
    send_ubx_byte(id);

    /* Length (little-endian) */
    send_ubx_byte((uint8_t)(len & 0xFF));
    send_ubx_byte((uint8_t)((len >> 8) & 0xFF));

    /* Fletcher checksum init */
    uint8_t ck_a = 0, ck_b = 0;

    /* Checksum includes class, id, length, and payload */
    ck_a += cls;   ck_b += ck_a;
    ck_a += id;    ck_b += ck_a;
    ck_a += (uint8_t)(len & 0xFF);        ck_b += ck_a;
    ck_a += (uint8_t)((len >> 8) & 0xFF); ck_b += ck_a;

    /* Payload */
    for (uint16_t i = 0; i < len; i++)
    {
        send_ubx_byte(p_data[i]);
        ck_a += p_data[i];
        ck_b += ck_a;
    }

    /* Checksum */
    send_ubx_byte(ck_a);
    send_ubx_byte(ck_b);
}


void gps_uart_configure(void)
{
    if (!m_initialized)
    {
        return;
    }

    /*
     * STEP 0: Factory-reset all saved GPS module settings.
     * UBX-CFG-CFG: Class=0x06, ID=0x09, Length=13 bytes
     *
     * clearMask = 0x0000FFFF (clear ALL saved config sections)
     * saveMask  = 0x00000000 (don't save yet)
     * loadMask  = 0x0000FFFF (reload defaults from ROM)
     * deviceMask = 0x17      (BBR + Flash + EEPROM)
     *
     * This wipes any Power Save Mode, PM2, or other stale settings
     * that were previously saved to the NEO-6M's internal flash.
     */
    uint8_t cfg_reset[13] = {0};

    /* clearMask: bytes 0-3 = 0xFFFF (clear everything) */
    cfg_reset[0] = 0xFF;
    cfg_reset[1] = 0xFF;
    cfg_reset[2] = 0x00;
    cfg_reset[3] = 0x00;

    /* saveMask: bytes 4-7 = 0 (don't save) */

    /* loadMask: bytes 8-11 = 0xFFFF (reload ROM defaults) */
    cfg_reset[8]  = 0xFF;
    cfg_reset[9]  = 0xFF;
    cfg_reset[10] = 0x00;
    cfg_reset[11] = 0x00;

    /* deviceMask: byte 12 = BBR | Flash | EEPROM */
    cfg_reset[12] = 0x17;

    send_ubx_message(0x06, 0x09, cfg_reset, sizeof(cfg_reset));

    NRF_LOG_INFO("GPS: factory reset sent (clearing old PSM config)");

    /* Give the module time to process the reset */
    nrf_delay_ms(200);

    /*
     * STEP 1: Explicitly disable Power Save Mode.
     * UBX-CFG-RXM: Class=0x06, ID=0x11, Length=2 bytes
     *
     * lpMode = 0 → Continuous mode (no sleeping, full acquisition power)
     *
     * This overrides any remnant PSM config that may have survived
     * in the module's volatile memory after the factory reset.
     */
    uint8_t cfg_rxm[2] = {0};
    cfg_rxm[0] = 0x00;  /* reserved */
    cfg_rxm[1] = 0x00;  /* lpMode: 0 = Continuous (PSM OFF) */

    send_ubx_message(0x06, 0x11, cfg_rxm, sizeof(cfg_rxm));

    NRF_LOG_INFO("GPS: Power Save Mode explicitly DISABLED");

    /*
     * STEP 2: Configure navigation model.
     * UBX-CFG-NAV5: Class=0x06, ID=0x24, Length=36 bytes
     *
     * Key settings:
     *   mask     = 0x0005 → apply dynModel + fixMode
     *   dynModel = 3      → Pedestrian (best for portable trackers)
     *   fixMode  = 3      → Auto 2D/3D (accepts 2D fix with 3 satellites)
     *   minElev  = 5      → 5° minimum elevation (accept low satellites)
     */
    uint8_t cfg_nav5[36] = {0};

    /* mask: bits 0 (dynModel) + 2 (fixMode) = 0x0005 */
    cfg_nav5[0] = 0x05;
    cfg_nav5[1] = 0x00;

    /* dynModel: 3 = Pedestrian (best for wearable/portable trackers) */
    cfg_nav5[2] = 0x03;

    /* fixMode: 3 = Auto 2D/3D */
    cfg_nav5[3] = 0x03;

    /* fixedAlt (not used in auto mode) */
    /* fixedAltVar (not used) */

    /* minElev: 5 degrees — byte offset 10 */
    cfg_nav5[10] = 0x05;

    /* pDop: 250 (25.0) — bytes offset 12-13 */
    cfg_nav5[12] = 0xFA;
    cfg_nav5[13] = 0x00;

    /* tDop: 250 (25.0) — bytes offset 14-15 */
    cfg_nav5[14] = 0xFA;
    cfg_nav5[15] = 0x00;

    /* pAcc: 100m — bytes offset 16-17 */
    cfg_nav5[16] = 0x64;
    cfg_nav5[17] = 0x00;

    /* tAcc: 350m — bytes offset 18-19 */
    cfg_nav5[18] = 0x5E;
    cfg_nav5[19] = 0x01;

    /* staticHoldThresh: 0 (disabled) — byte offset 20 */
    cfg_nav5[20] = 0x00;

    /* dgnssTimeout: 60s — byte offset 21 */
    cfg_nav5[21] = 0x3C;

    send_ubx_message(0x06, 0x24, cfg_nav5, sizeof(cfg_nav5));

    NRF_LOG_INFO("GPS configured: Pedestrian mode, Auto 2D/3D, minElev=5");

    /*
     * STEP 3: Save all current settings to BBR + EEPROM.
     * UBX-CFG-CFG: Class=0x06, ID=0x09, Length=13 bytes
     *
     * This ensures the CLEAN config (no PSM, Pedestrian mode)
     * is saved and will survive power cycles.
     */
    uint8_t cfg_cfg[13] = {0};

    /* clearMask: bytes 0-3 = 0 (don't clear again) */

    /* saveMask: bytes 4-7 = 0x1F (save all config sections) */
    cfg_cfg[4] = 0x1F;
    cfg_cfg[5] = 0x00;
    cfg_cfg[6] = 0x00;
    cfg_cfg[7] = 0x00;

    /* loadMask: bytes 8-11 = 0 */

    /* deviceMask: byte 12 = BBR | Flash | EEPROM */
    cfg_cfg[12] = 0x17;

    send_ubx_message(0x06, 0x09, cfg_cfg, sizeof(cfg_cfg));

    NRF_LOG_INFO("GPS config saved to BBR/EEPROM (PSM cleared, hot start enabled)");
}
