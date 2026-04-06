/**
 * @file ble_gps_service.c
 * @brief BLE GATT GPS Service implementation.
 *
 * Custom service with two characteristics:
 * - GPS Location (Notify): 3×float (lat, lon, alt) = 12 bytes
 * - GPS Status  (Read):    fix, quality, satellites, speed = 4 bytes
 */
#include "ble_gps_service.h"

#include <string.h>

#include "ble_gatts.h"
#include "app_error.h"
#include "nrf_log.h"

/** @brief GPS_NMEA_MAX_LEN is defined in gps_uart.h but we only need it for buffer sizing */
#ifndef GPS_NMEA_MAX_LEN
#define GPS_NMEA_MAX_LEN 128
#endif


/**
 * @brief Add the GPS Location characteristic (Notify).
 */
static uint32_t gps_location_char_add(ble_gps_service_t *p_gps_service)
{
    ble_gatts_char_md_t char_md;
    ble_gatts_attr_md_t cccd_md;
    ble_gatts_attr_t    attr_char_value;
    ble_uuid_t          ble_uuid;
    ble_gatts_attr_md_t attr_md;

    /* CCCD metadata (required for notifications) */
    memset(&cccd_md, 0, sizeof(cccd_md));
    BLE_GAP_CONN_SEC_MODE_SET_OPEN(&cccd_md.read_perm);
    BLE_GAP_CONN_SEC_MODE_SET_OPEN(&cccd_md.write_perm);
    cccd_md.vloc = BLE_GATTS_VLOC_STACK;

    /* Characteristic metadata */
    memset(&char_md, 0, sizeof(char_md));
    char_md.char_props.read   = 1;
    char_md.char_props.notify = 1;
    char_md.p_char_user_desc  = NULL;
    char_md.p_char_pf         = NULL;
    char_md.p_user_desc_md    = NULL;
    char_md.p_cccd_md         = &cccd_md;
    char_md.p_sccd_md         = NULL;

    /* UUID */
    ble_uuid.type = p_gps_service->uuid_type;
    ble_uuid.uuid = BLE_UUID_GPS_LOCATION_CHAR;

    /* Attribute metadata */
    memset(&attr_md, 0, sizeof(attr_md));
    BLE_GAP_CONN_SEC_MODE_SET_OPEN(&attr_md.read_perm);
    BLE_GAP_CONN_SEC_MODE_SET_NO_ACCESS(&attr_md.write_perm);
    attr_md.vloc    = BLE_GATTS_VLOC_STACK;
    attr_md.rd_auth = 0;
    attr_md.wr_auth = 0;
    attr_md.vlen    = 0;

    /* Attribute value */
    ble_gps_location_t initial_value = {0};

    memset(&attr_char_value, 0, sizeof(attr_char_value));
    attr_char_value.p_uuid    = &ble_uuid;
    attr_char_value.p_attr_md = &attr_md;
    attr_char_value.init_len  = sizeof(ble_gps_location_t);
    attr_char_value.init_offs = 0;
    attr_char_value.max_len   = sizeof(ble_gps_location_t);
    attr_char_value.p_value   = (uint8_t *)&initial_value;

    return sd_ble_gatts_characteristic_add(p_gps_service->service_handle,
                                           &char_md,
                                           &attr_char_value,
                                           &p_gps_service->location_handles);
}


/**
 * @brief Add the GPS Status characteristic (Read-only).
 */
static uint32_t gps_status_char_add(ble_gps_service_t *p_gps_service)
{
    ble_gatts_char_md_t char_md;
    ble_gatts_attr_t    attr_char_value;
    ble_uuid_t          ble_uuid;
    ble_gatts_attr_md_t attr_md;

    /* Characteristic metadata */
    memset(&char_md, 0, sizeof(char_md));
    char_md.char_props.read = 1;
    char_md.p_char_user_desc = NULL;
    char_md.p_char_pf        = NULL;
    char_md.p_user_desc_md   = NULL;
    char_md.p_cccd_md        = NULL;
    char_md.p_sccd_md        = NULL;

    /* UUID */
    ble_uuid.type = p_gps_service->uuid_type;
    ble_uuid.uuid = BLE_UUID_GPS_STATUS_CHAR;

    /* Attribute metadata */
    memset(&attr_md, 0, sizeof(attr_md));
    BLE_GAP_CONN_SEC_MODE_SET_OPEN(&attr_md.read_perm);
    BLE_GAP_CONN_SEC_MODE_SET_NO_ACCESS(&attr_md.write_perm);
    attr_md.vloc    = BLE_GATTS_VLOC_STACK;
    attr_md.rd_auth = 0;
    attr_md.wr_auth = 0;
    attr_md.vlen    = 0;

    /* Attribute value */
    ble_gps_status_t initial_value = {0};

    memset(&attr_char_value, 0, sizeof(attr_char_value));
    attr_char_value.p_uuid    = &ble_uuid;
    attr_char_value.p_attr_md = &attr_md;
    attr_char_value.init_len  = sizeof(ble_gps_status_t);
    attr_char_value.init_offs = 0;
    attr_char_value.max_len   = sizeof(ble_gps_status_t);
    attr_char_value.p_value   = (uint8_t *)&initial_value;

    return sd_ble_gatts_characteristic_add(p_gps_service->service_handle,
                                           &char_md,
                                           &attr_char_value,
                                           &p_gps_service->status_handles);
}


/* =========== Public API =========== */

uint32_t ble_gps_service_init(ble_gps_service_t *p_gps_service)
{
    uint32_t   err_code;
    ble_uuid_t ble_uuid;

    /* Initialize service structure */
    p_gps_service->conn_handle             = BLE_CONN_HANDLE_INVALID;
    p_gps_service->location_notify_enabled = false;

    /* Add custom UUID base */
    ble_uuid128_t base_uuid = {BLE_UUID_GPS_SERVICE_BASE};
    err_code = sd_ble_uuid_vs_add(&base_uuid, &p_gps_service->uuid_type);
    APP_ERROR_CHECK(err_code);

    /* Set service UUID */
    ble_uuid.type = p_gps_service->uuid_type;
    ble_uuid.uuid = BLE_UUID_GPS_SERVICE;

    /* Add primary service */
    err_code = sd_ble_gatts_service_add(BLE_GATTS_SRVC_TYPE_PRIMARY,
                                        &ble_uuid,
                                        &p_gps_service->service_handle);
    APP_ERROR_CHECK(err_code);

    /* Add characteristics */
    err_code = gps_location_char_add(p_gps_service);
    APP_ERROR_CHECK(err_code);

    err_code = gps_status_char_add(p_gps_service);
    APP_ERROR_CHECK(err_code);

    NRF_LOG_INFO("BLE GPS service initialized");

    return NRF_SUCCESS;
}


void ble_gps_service_on_ble_evt(ble_evt_t const *p_ble_evt, void *p_context)
{
    ble_gps_service_t *p_gps_service = (ble_gps_service_t *)p_context;

    switch (p_ble_evt->header.evt_id)
    {
        case BLE_GAP_EVT_CONNECTED:
            p_gps_service->conn_handle = p_ble_evt->evt.gap_evt.conn_handle;
            break;

        case BLE_GAP_EVT_DISCONNECTED:
            p_gps_service->conn_handle             = BLE_CONN_HANDLE_INVALID;
            p_gps_service->location_notify_enabled = false;
            break;

        case BLE_GATTS_EVT_WRITE:
        {
            const ble_gatts_evt_write_t *p_evt_write = &p_ble_evt->evt.gatts_evt.params.write;

            /* Check if this is a CCCD write for the location characteristic */
            if ((p_evt_write->handle == p_gps_service->location_handles.cccd_handle) &&
                (p_evt_write->len == 2))
            {
                p_gps_service->location_notify_enabled =
                    ble_srv_is_notification_enabled(p_evt_write->data);

                NRF_LOG_INFO("GPS Location notifications %s",
                             p_gps_service->location_notify_enabled ? "ENABLED" : "DISABLED");
            }
        }
        break;

        default:
            break;
    }
}


uint32_t ble_gps_service_location_update(ble_gps_service_t *p_gps_service,
                                          const nmea_gps_data_t *p_gps_data)
{
    /* Prepare location data */
    ble_gps_location_t location;
    location.latitude  = p_gps_data->latitude;
    location.longitude = p_gps_data->longitude;
    location.altitude  = p_gps_data->altitude;

    NRF_LOG_DEBUG("Location update: lat=%d lon=%d alt=%d (x1000)",
                  (int)(location.latitude * 1000),
                  (int)(location.longitude * 1000),
                  (int)(location.altitude * 1000));

    /* Always store the value in the GATT table regardless of connection state.
     * BLE_CONN_HANDLE_INVALID means "update the attribute in memory" —
     * the value will be ready for Read requests as soon as a client connects. */
    ble_gatts_value_t gatts_value;
    memset(&gatts_value, 0, sizeof(gatts_value));
    gatts_value.len     = sizeof(ble_gps_location_t);
    gatts_value.offset  = 0;
    gatts_value.p_value = (uint8_t *)&location;

    uint32_t err_code = sd_ble_gatts_value_set(BLE_CONN_HANDLE_INVALID,
                                                p_gps_service->location_handles.value_handle,
                                                &gatts_value);
    if (err_code != NRF_SUCCESS)
    {
        return err_code;
    }

    /* Send notification only if connected AND notifications are enabled */
    if (p_gps_service->conn_handle != BLE_CONN_HANDLE_INVALID &&
        p_gps_service->location_notify_enabled)
    {
        ble_gatts_hvx_params_t hvx_params;
        uint16_t               hvx_len = sizeof(ble_gps_location_t);

        memset(&hvx_params, 0, sizeof(hvx_params));
        hvx_params.handle = p_gps_service->location_handles.value_handle;
        hvx_params.type   = BLE_GATT_HVX_NOTIFICATION;
        hvx_params.offset = 0;
        hvx_params.p_len  = &hvx_len;
        hvx_params.p_data = (uint8_t *)&location;

        err_code = sd_ble_gatts_hvx(p_gps_service->conn_handle, &hvx_params);

        if (err_code == NRF_ERROR_RESOURCES)
        {
            NRF_LOG_DEBUG("GPS notification skipped (TX buffer full)");
            return NRF_SUCCESS;
        }
    }

    return NRF_SUCCESS;
}


uint32_t ble_gps_service_status_update(ble_gps_service_t *p_gps_service,
                                        const nmea_gps_data_t *p_gps_data)
{
    /* Prepare status data */
    ble_gps_status_t status;
    status.fix_valid   = p_gps_data->fix_valid ? 1 : 0;
    status.fix_quality = p_gps_data->fix_quality;
    status.satellites  = p_gps_data->satellites;

    /* Convert knots to km/h, cap at 255 */
    float speed_kmh = p_gps_data->speed_knots * 1.852f;
    status.speed_kmh = (speed_kmh > 255.0f) ? 255 : (uint8_t)speed_kmh;

    NRF_LOG_DEBUG("Status update: fix=%d qual=%d sat=%d spd=%d",
                  status.fix_valid, status.fix_quality,
                  status.satellites, status.speed_kmh);

    /* Update the characteristic value.
     * Use BLE_CONN_HANDLE_INVALID when not connected — the SoftDevice still
     * stores the value so it is ready for the next Read request. */
    ble_gatts_value_t gatts_value;
    memset(&gatts_value, 0, sizeof(gatts_value));
    gatts_value.len     = sizeof(ble_gps_status_t);
    gatts_value.offset  = 0;
    gatts_value.p_value = (uint8_t *)&status;

    return sd_ble_gatts_value_set(BLE_CONN_HANDLE_INVALID,
                                  p_gps_service->status_handles.value_handle,
                                  &gatts_value);
}
