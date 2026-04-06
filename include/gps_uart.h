/**
 * @file gps_uart.h
 * @brief GPS UART driver for NEO-6M module on PCA10059.
 *
 * Receives raw NMEA data from GPS module via UART and assembles
 * complete NMEA lines for the parser.
 */
#ifndef GPS_UART_H
#define GPS_UART_H

#include <stdint.h>
#include <stdbool.h>

#include "nrf_gpio.h"

/** @brief GPS UART pin configuration (PCA10059 edge connector) */
#define GPS_UART_TX_PIN     NRF_GPIO_PIN_MAP(0, 17)   /**< nRF TX → GPS RX */
#define GPS_UART_RX_PIN     NRF_GPIO_PIN_MAP(0, 15)   /**< nRF RX ← GPS TX */
#define GPS_UART_CTS_PIN    NRF_UART_PSEL_DISCONNECTED
#define GPS_UART_RTS_PIN    NRF_UART_PSEL_DISCONNECTED

/** @brief GPS UART baud rate (NEO-6M default) */
#define GPS_UART_BAUDRATE   NRF_UART_BAUDRATE_9600

/** @brief Maximum NMEA sentence length (standard = 82 chars + \r\n + null) */
#define GPS_NMEA_MAX_LEN    128

/**
 * @brief Callback type invoked when a complete NMEA line is received.
 *
 * @param[in] p_line  Null-terminated NMEA sentence string (e.g. "$GPRMC,...")
 * @param[in] length  Length of the string (excluding null terminator)
 */
typedef void (*gps_uart_line_handler_t)(const char *p_line, uint16_t length);

/**
 * @brief Initialize the GPS UART peripheral.
 *
 * @param[in] line_handler  Callback for complete NMEA lines. Can be NULL
 *                          if polling via gps_uart_process() is used instead.
 *
 * @retval NRF_SUCCESS              Initialization successful.
 * @retval NRF_ERROR_INVALID_STATE  UART already initialized.
 */
uint32_t gps_uart_init(gps_uart_line_handler_t line_handler);

/**
 * @brief Process incoming UART data (call from main loop).
 *
 * Reads available bytes from the FIFO and assembles NMEA lines.
 * When a complete line is assembled, the registered callback is invoked.
 */
void gps_uart_process(void);

/**
 * @brief Deinitialize the GPS UART peripheral.
 */
void gps_uart_uninit(void);

/**
 * @brief Get UART diagnostic counters.
 *
 * @param[out] p_bytes  Total bytes received from GPS UART (can be NULL).
 * @param[out] p_lines  Total complete NMEA lines received (can be NULL).
 */
void gps_uart_get_diagnostics(uint32_t *p_bytes, uint32_t *p_lines);

/**
 * @brief Configure NEO-6M for optimal performance via UBX protocol.
 *
 * Sends UBX CFG-NAV5 command to set:
 * - Navigation mode: Pedestrian (better indoor sensitivity)
 * - Fix mode: Auto 2D/3D (accepts 2D fix with 3 satellites)
 * - Min elevation: 5° (considers low-horizon satellites)
 *
 * Should be called after gps_uart_init() with a short delay.
 */
void gps_uart_configure(void);

#endif /* GPS_UART_H */
