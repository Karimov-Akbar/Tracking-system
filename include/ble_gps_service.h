/**
 * @file ble_gps_service.h
 * @brief Custom BLE GATT service for GPS location data.
 *
 * Exposes two characteristics:
 * - GPS Location (Notify): latitude, longitude, altitude (3 x float = 12 bytes)
 * - GPS Status  (Read):    fix_valid, fix_quality, satellites, speed (4 bytes packed)
 */
#ifndef BLE_GPS_SERVICE_H
#define BLE_GPS_SERVICE_H

#include <stdint.h>
#include "ble.h"
#include "ble_srv_common.h"
#include "nrf_sdh_ble.h"
#include "nmea_parser.h"

/** @brief Macro for defining a BLE GPS service instance. */
#define BLE_GPS_SERVICE_DEF(_name)                          \
    static ble_gps_service_t _name;                         \
    NRF_SDH_BLE_OBSERVER(_name ## _obs,                     \
                         BLE_GPS_SERVICE_OBSERVER_PRIO,     \
                         ble_gps_service_on_ble_evt,        \
                         &_name)

/** @brief Observer priority (same as app) */
#define BLE_GPS_SERVICE_OBSERVER_PRIO   2

/**
 * @brief Custom 128-bit UUID base for GPS service.
 *
 * Base: 12345678-1234-5678-1234-56789ABCDEF0
 * Service UUID offset:      0x0001
 * Location char UUID offset: 0x0002
 * Status char UUID offset:   0x0003
 */
#define BLE_UUID_GPS_SERVICE_BASE   {0xF0, 0xDE, 0xBC, 0x9A, 0x78, 0x56, \
                                     0x34, 0x12, 0x78, 0x56, 0x34, 0x12, \
                                     0x78, 0x56, 0x34, 0x12}

#define BLE_UUID_GPS_SERVICE        0x0001
#define BLE_UUID_GPS_LOCATION_CHAR  0x0002
#define BLE_UUID_GPS_STATUS_CHAR    0x0003
#define BLE_UUID_GPS_SOS_CHAR       0x0004
#define BLE_UUID_GPS_SCAN_CHAR      0x0005

/** @brief GPS Location characteristic data (12 bytes) */
typedef struct __attribute__((packed))
{
    float latitude;
    float longitude;
    float altitude;
} ble_gps_location_t;

/** @brief GPS Status characteristic data (4 bytes) */
typedef struct __attribute__((packed))
{
    uint8_t fix_valid;      /**< 0 or 1 */
    uint8_t fix_quality;    /**< 0=none, 1=GPS, 2=DGPS */
    uint8_t satellites;     /**< Satellite count */
    uint8_t speed_kmh;      /**< Speed in km/h (capped at 255) */
} ble_gps_status_t;

/** @brief GPS service structure */
typedef struct
{
    uint16_t                service_handle;
    ble_gatts_char_handles_t location_handles;
    ble_gatts_char_handles_t status_handles;
    ble_gatts_char_handles_t sos_handles;
    ble_gatts_char_handles_t scan_handles;
    uint16_t                conn_handle;
    uint8_t                 uuid_type;
    bool                    location_notify_enabled;
    bool                    sos_notify_enabled;
    bool                    scan_notify_enabled;
} ble_gps_service_t;

/**
 * @brief Initialize the GPS BLE service.
 *
 * @param[in,out] p_gps_service  Pointer to GPS service structure.
 *
 * @retval NRF_SUCCESS  Service initialized successfully.
 */
uint32_t ble_gps_service_init(ble_gps_service_t *p_gps_service);

/**
 * @brief Handle BLE events for the GPS service.
 *
 * @param[in] p_ble_evt      BLE event.
 * @param[in] p_context      Context (pointer to ble_gps_service_t).
 */
void ble_gps_service_on_ble_evt(ble_evt_t const *p_ble_evt, void *p_context);

/**
 * @brief Send GPS location update via notification.
 *
 * @param[in] p_gps_service  Pointer to GPS service instance.
 * @param[in] p_gps_data     Parsed GPS data.
 *
 * @retval NRF_SUCCESS              Notification sent.
 * @retval NRF_ERROR_INVALID_STATE  Not connected or notifications not enabled.
 */
uint32_t ble_gps_service_location_update(ble_gps_service_t *p_gps_service,
                                          const nmea_gps_data_t *p_gps_data);

/**
 * @brief Update GPS status characteristic value.
 *
 * @param[in] p_gps_service  Pointer to GPS service instance.
 * @param[in] p_gps_data     Parsed GPS data.
 *
 * @retval NRF_SUCCESS  Status updated.
 */
uint32_t ble_gps_service_status_update(ble_gps_service_t *p_gps_service,
                                        const nmea_gps_data_t *p_gps_data);

/**
 * @brief Send SOS alert via BLE notification.
 *
 * @param[in] p_gps_service  Pointer to GPS service instance.
 * @param[in] sos_active     1 = SOS triggered, 0 = SOS cleared.
 *
 * @retval NRF_SUCCESS  Notification sent.
 */
uint32_t ble_gps_service_sos_notify(ble_gps_service_t *p_gps_service,
                                    uint8_t sos_active);

/**
 * @brief Send scanned BLE devices list via notification.
 *
 * @param[in] p_gps_service  Pointer to GPS service instance.
 * @param[in] p_data         Packed scan data.
 * @param[in] length         Length of data.
 *
 * @retval NRF_SUCCESS  Notification sent.
 */
uint32_t ble_gps_service_scan_update(ble_gps_service_t *p_gps_service,
                                     const uint8_t *p_data, uint16_t length);

#endif /* BLE_GPS_SERVICE_H */
