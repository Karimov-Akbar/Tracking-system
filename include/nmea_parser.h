/**
 * @file nmea_parser.h
 * @brief Lightweight NMEA 0183 parser for $GPRMC and $GPGGA sentences.
 *
 * Parses GPS coordinates, altitude, speed, satellite count, and fix status
 * from standard NMEA sentences produced by NEO-6M.
 */
#ifndef NMEA_PARSER_H
#define NMEA_PARSER_H

#include <stdint.h>
#include <stdbool.h>

/** @brief Parsed GPS data structure */
typedef struct
{
    float    latitude;       /**< Latitude in decimal degrees (+ = N, - = S) */
    float    longitude;      /**< Longitude in decimal degrees (+ = E, - = W) */
    float    altitude;       /**< Altitude in meters (from GPGGA) */
    float    speed_knots;    /**< Speed over ground in knots (from GPRMC) */
    float    hdop;           /**< Horizontal dilution of precision (from GPGGA) */
    uint8_t  satellites;     /**< Number of satellites in use (from GPGGA) */
    uint8_t  fix_quality;    /**< Fix quality: 0=invalid, 1=GPS, 2=DGPS (GPGGA) */
    bool     fix_valid;      /**< true if RMC status == 'A' (data valid) */
    uint8_t  utc_hour;       /**< UTC hours */
    uint8_t  utc_minute;     /**< UTC minutes */
    uint8_t  utc_second;     /**< UTC seconds */
    uint8_t  day;            /**< Day of month (from GPRMC) */
    uint8_t  month;          /**< Month (from GPRMC) */
    uint8_t  year;           /**< Year (2-digit, from GPRMC) */
} nmea_gps_data_t;

/**
 * @brief Initialize the NMEA parser.
 *
 * Clears internal state and stored GPS data.
 */
void nmea_parser_init(void);

/**
 * @brief Parse a single NMEA sentence.
 *
 * Supports $GPRMC and $GPGGA. Other sentences are silently ignored.
 * Validates checksum before parsing.
 *
 * @param[in] p_sentence  Null-terminated NMEA sentence (with or without leading '$')
 *
 * @retval true   Sentence was parsed successfully.
 * @retval false  Sentence was ignored, checksum invalid, or parse error.
 */
bool nmea_parse_line(const char *p_sentence);

/**
 * @brief Get the latest parsed GPS data.
 *
 * @param[out] p_data  Pointer to structure that will receive the data.
 *
 * @retval true   Data is available (at least one successful parse).
 * @retval false  No data has been parsed yet.
 */
bool nmea_get_last_data(nmea_gps_data_t *p_data);

/**
 * @brief Check if a valid fix has been acquired.
 *
 * @retval true   GPS fix is valid.
 * @retval false  No valid fix.
 */
bool nmea_has_fix(void);

#endif /* NMEA_PARSER_H */
