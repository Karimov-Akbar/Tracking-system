/* BLE Scanner – обнаружение ближайших BLE-устройств
 * Использует Observer role (S140 SoftDevice)
 * Сохраняет список обнаруженных устройств: имя, MAC, RSSI, тип
 */

#ifndef BLE_SCAN_H
#define BLE_SCAN_H

#include <stdint.h>
#include <stdbool.h>

#define MAX_SCANNED_DEVICES   30
#define SCAN_DEVICE_NAME_LEN  16
#define SCAN_TIMEOUT_SEC      15

/* Типы устройств (на основе BLE Appearance) */
#define DEV_TYPE_UNKNOWN   0
#define DEV_TYPE_PHONE     1
#define DEV_TYPE_COMPUTER  2
#define DEV_TYPE_WATCH     3
#define DEV_TYPE_HEADPHONE 4
#define DEV_TYPE_SPEAKER   5
#define DEV_TYPE_TV        6
#define DEV_TYPE_TAG       7
#define DEV_TYPE_GENERIC   8

/* Одно обнаруженное устройство */
typedef struct {
    uint8_t  addr[6];               /* MAC адрес */
    int8_t   rssi;                  /* Уровень сигнала */
    uint8_t  dev_type;              /* Тип устройства */
    char     name[SCAN_DEVICE_NAME_LEN + 1]; /* Имя (если есть) */
    uint32_t last_seen;             /* Время последнего обнаружения (тики) */
    bool     active;                /* Устройство ещё в радиусе */
} scanned_device_t;

/* Инициализация модуля сканирования */
void ble_scan_init(void);

/* Запуск/остановка сканирования */
void ble_scan_start(void);
void ble_scan_stop(void);

/* Обработка BLE-событий (вызывать из ble_evt_handler) */
void ble_scan_on_ble_evt(const void *p_ble_evt);

/* Получить список устройств */
const scanned_device_t *ble_scan_get_devices(void);
uint8_t ble_scan_get_count(void);

/* Очистить неактивные (не видны > SCAN_TIMEOUT_SEC) */
void ble_scan_cleanup(void);

/* Упаковать список в буфер для BLE-характеристики
 * Формат: [count:1][MAC:6][RSSI:1][type:1][nameLen:1][name:N] × count
 * Возвращает длину данных */
uint16_t ble_scan_pack(uint8_t *buf, uint16_t buf_size);

#endif /* BLE_SCAN_H */
