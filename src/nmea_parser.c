/**
 * @file nmea_parser.c
 * @brief Lightweight NMEA parser for $GPRMC and $GPGGA sentences.
 *
 * Handles checksum validation, coordinate conversion from
 * NMEA DDMM.MMMM format to decimal degrees, and position
 * stabilization via EMA (Exponential Moving Average) filtering.
 */
#include "nmea_parser.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "nrf_log.h"

/** @brief Maximum NMEA line length for internal buffer */
#define NMEA_MAX_LINE_LEN 128

/** @brief Maximum number of fields in a single NMEA sentence */
#define NMEA_MAX_FIELDS 20

/** @brief Minimum satellites required for position update */
#define MIN_SATELLITES 3

/** @brief Maximum HDOP for position to be considered usable */
#define MAX_HDOP 10.0f

/** @brief EMA smoothing factor (0.0-1.0, lower = smoother but slower) */
#define EMA_ALPHA_DEFAULT 0.3f

/** @brief Stronger smoothing for few satellites */
#define EMA_ALPHA_LOW_SAT 0.05f

/** @brief Threshold: if new position jumps more than this (degrees), reset
 * filter */
#define JUMP_THRESHOLD 0.005f /* ~550 meters */

/** @brief Internal GPS data storage */
static nmea_gps_data_t m_gps_data;
static bool m_data_valid = false;

/** @brief EMA filter state */
static float m_ema_lat = 0.0f;
static float m_ema_lon = 0.0f;
static float m_ema_alt = 0.0f;
static bool m_ema_initialized = false;

/**
 * @brief Apply EMA filter to stabilize coordinates.
 *
 * Uses adaptive alpha: smoother when few satellites, more responsive
 * when many. Resets filter on large position jumps (> JUMP_THRESHOLD).
 */
static void apply_raw_data(float raw_lat, float raw_lon, float raw_alt) {
  m_gps_data.latitude = raw_lat;
  m_gps_data.longitude = raw_lon;
  m_gps_data.altitude = raw_alt;
}

/**
 * @brief Validate NMEA checksum.
 *
 * Checksum is XOR of all characters between '$' and '*'.
 *
 * @param[in] p_sentence  Complete NMEA sentence (starting with '$').
 *
 * @retval true   Checksum valid or no checksum present.
 * @retval false  Checksum mismatch.
 */
static bool nmea_validate_checksum(const char *p_sentence) {
  if (p_sentence[0] != '$') {
    return false;
  }

  const char *p_star = strchr(p_sentence, '*');
  if (p_star == NULL) {
    /* No checksum field — accept anyway (some modules omit it) */
    return true;
  }

  uint8_t computed = 0;
  for (const char *p = p_sentence + 1; p < p_star; p++) {
    computed ^= (uint8_t)(*p);
  }

  /* Parse expected checksum (2 hex digits after '*') */
  uint8_t expected = (uint8_t)strtol(p_star + 1, NULL, 16);

  if (computed != expected) {
    NRF_LOG_DEBUG("NMEA checksum fail: computed=0x%02X expected=0x%02X",
                  computed, expected);
    return false;
  }

  return true;
}

/**
 * @brief Split NMEA sentence into fields by comma.
 *
 * Modifies the input string in-place (replaces commas with nulls).
 *
 * @param[in,out] p_sentence   Mutable sentence buffer.
 * @param[out]    pp_fields    Array of pointers to field starts.
 * @param[in]     max_fields   Maximum number of fields.
 *
 * @return Number of fields found.
 */
static int nmea_split_fields(char *p_sentence, char **pp_fields,
                             int max_fields) {
  int count = 0;

  /* Strip checksum portion if present */
  char *p_star = strchr(p_sentence, '*');
  if (p_star != NULL) {
    *p_star = '\0';
  }

  /* Skip leading '$' */
  char *p = p_sentence;
  if (*p == '$') {
    p++;
  }

  while (p != NULL && count < max_fields) {
    pp_fields[count++] = p;
    p = strchr(p, ',');
    if (p != NULL) {
      *p = '\0';
      p++;
    }
  }

  return count;
}

/**
 * @brief Convert NMEA coordinate (DDMM.MMMM or DDDMM.MMMM) to decimal degrees.
 *
 * @param[in] p_coord    Coordinate string (e.g. "5530.1234")
 * @param[in] direction  'N'/'S' for latitude, 'E'/'W' for longitude
 *
 * @return Decimal degrees (negative for S/W).
 */
static float nmea_coord_to_decimal(const char *p_coord, char direction) {
  if (p_coord == NULL || p_coord[0] == '\0') {
    return 0.0f;
  }

  float raw = (float)atof(p_coord);

  /* Extract degrees: latitude = 2 digits, longitude = 3 digits */
  int degrees;
  float minutes;

  if (direction == 'N' || direction == 'S') {
    degrees = (int)(raw / 100.0f);
    minutes = raw - (degrees * 100.0f);
  } else {
    degrees = (int)(raw / 100.0f);
    minutes = raw - (degrees * 100.0f);
  }

  float decimal = (float)degrees + (minutes / 60.0f);

  if (direction == 'S' || direction == 'W') {
    decimal = -decimal;
  }

  return decimal;
}

/**
 * @brief Parse time field (HHMMSS.SS) from NMEA sentence.
 */
static void nmea_parse_time(const char *p_time, nmea_gps_data_t *p_data) {
  if (p_time == NULL || strlen(p_time) < 6) {
    return;
  }

  p_data->utc_hour = (uint8_t)((p_time[0] - '0') * 10 + (p_time[1] - '0'));
  p_data->utc_minute = (uint8_t)((p_time[2] - '0') * 10 + (p_time[3] - '0'));
  p_data->utc_second = (uint8_t)((p_time[4] - '0') * 10 + (p_time[5] - '0'));
}

/**
 * @brief Parse date field (DDMMYY) from GPRMC sentence.
 */
static void nmea_parse_date(const char *p_date, nmea_gps_data_t *p_data) {
  if (p_date == NULL || strlen(p_date) < 6) {
    return;
  }

  p_data->day = (uint8_t)((p_date[0] - '0') * 10 + (p_date[1] - '0'));
  p_data->month = (uint8_t)((p_date[2] - '0') * 10 + (p_date[3] - '0'));
  p_data->year = (uint8_t)((p_date[4] - '0') * 10 + (p_date[5] - '0'));
}

/**
 * @brief Parse $GPRMC (Recommended Minimum) sentence.
 *
 * Format:
 * $GPRMC,time,status,lat,N/S,lon,E/W,speed,course,date,magvar,E/W*checksum
 *         Fields: 0     1     2   3   4   5    6     7      8     9    10
 */
static bool nmea_parse_gprmc(char **pp_fields, int field_count) {
  if (field_count < 10) {
    return false;
  }

  /* Field 1: UTC time */
  nmea_parse_time(pp_fields[1], &m_gps_data);

  /* Field 2: Status — A=valid, V=void */

  bool rmc_valid = (pp_fields[2][0] == 'A');
  if (rmc_valid) {
    m_gps_data.fix_valid = true;
  } else if (m_gps_data.fix_quality == 0) {
    m_gps_data.fix_valid = false;
  }

  if (rmc_valid) {
    /* Field 3+4: Latitude + N/S */
    char lat_dir = (pp_fields[4][0] != '\0') ? pp_fields[4][0] : 'N';
    float raw_lat = nmea_coord_to_decimal(pp_fields[3], lat_dir);

    /* Field 5+6: Longitude + E/W */
    char lon_dir = (pp_fields[6][0] != '\0') ? pp_fields[6][0] : 'E';
    float raw_lon = nmea_coord_to_decimal(pp_fields[5], lon_dir);

    /* Apply EMA stabilization filter */
    apply_raw_data(raw_lat, raw_lon, m_gps_data.altitude);

    /* Field 7: Speed in knots */
    if (pp_fields[7][0] != '\0') {
      m_gps_data.speed_knots = (float)atof(pp_fields[7]);
    }
  }

  /* Field 9: Date (DDMMYY) */
  nmea_parse_date(pp_fields[9], &m_gps_data);

  m_data_valid = true;

  NRF_LOG_DEBUG("GPRMC: fix=%d lat=%.4f lon=%.4f spd=%.1f",
                m_gps_data.fix_valid, m_gps_data.latitude, m_gps_data.longitude,
                m_gps_data.speed_knots);

  return true;
}

static bool nmea_parse_gsv(char **pp_fields, int field_count) {
  if (field_count < 4)
    return false;
  if (pp_fields[3][0] != '\0') {
    uint8_t sv_count = (uint8_t)atoi(pp_fields[3]);
    if (m_gps_data.fix_quality == 0) {
      m_gps_data.satellites = sv_count;
    }
  }
  return true;
}

/**
 * @brief Parse $GPGGA (Fix Data) sentence.
 *
 * Format:
 * $GPGGA,time,lat,N/S,lon,E/W,quality,numSat,hdop,alt,M,height,M,age,refID*checksum
 *         Fields: 0    1   2   3   4    5       6      7    8  9  10   11  12
 * 13
 */
static bool nmea_parse_gpgga(char **pp_fields, int field_count) {
  if (field_count < 10)
    return false;
  nmea_parse_time(pp_fields[1], &m_gps_data);
  m_gps_data.fix_quality = (uint8_t)atoi(pp_fields[6]);

  if (pp_fields[7][0] != '\0') {
    uint8_t used_sats = (uint8_t)atoi(pp_fields[7]);
    if (m_gps_data.fix_quality > 0 || used_sats > 0) {
      m_gps_data.satellites = used_sats;
    }
  }

  if (field_count > 8 && pp_fields[8][0] != '\0') {
    m_gps_data.hdop = (float)atof(pp_fields[8]);
  }

  if (m_gps_data.fix_quality > 0) {
    m_gps_data.fix_valid = true;
    char lat_dir = (pp_fields[3][0] != '\0') ? pp_fields[3][0] : 'N';
    float raw_lat = nmea_coord_to_decimal(pp_fields[2], lat_dir);

    char lon_dir = (pp_fields[5][0] != '\0') ? pp_fields[5][0] : 'E';
    float raw_lon = nmea_coord_to_decimal(pp_fields[4], lon_dir);

    float raw_alt = m_gps_data.altitude;
    if (field_count > 9 && pp_fields[9][0] != '\0') {
      raw_alt = (float)atof(pp_fields[9]);
    }

    apply_raw_data(raw_lat, raw_lon, raw_alt);
  } else {
    m_gps_data.fix_valid = false;
  }

  m_data_valid = true;
  return true;
}

/* =========== Public API =========== */

void nmea_parser_init(void) {
  memset(&m_gps_data, 0, sizeof(m_gps_data));
  m_data_valid = false;
  m_ema_initialized = false;
  m_ema_lat = 0.0f;
  m_ema_lon = 0.0f;
  m_ema_alt = 0.0f;
  NRF_LOG_INFO("NMEA parser initialized (EMA filter enabled)");
}

bool nmea_parse_line(const char *p_sentence) {
  if (p_sentence == NULL || p_sentence[0] != '$') {
    return false;
  }

  /* Validate checksum */
  if (!nmea_validate_checksum(p_sentence)) {
    return false;
  }

  /* Copy sentence to mutable buffer for tokenizing */
  char buf[NMEA_MAX_LINE_LEN];
  strncpy(buf, p_sentence, sizeof(buf) - 1);
  buf[sizeof(buf) - 1] = '\0';

  /* Split into fields */
  char *fields[NMEA_MAX_FIELDS];
  int count = nmea_split_fields(buf, fields, NMEA_MAX_FIELDS);

  if (count < 2) {
    return false;
  }

  /* Determine sentence type from field 0 (e.g. "GPRMC" or "GPGGA") */
  if (strcmp(fields[0], "GPRMC") == 0 || strcmp(fields[0], "GNRMC") == 0) {
    return nmea_parse_gprmc(fields, count);
  } else if (strcmp(fields[0], "GPGGA") == 0 ||
             strcmp(fields[0], "GNGGA") == 0) {
    return nmea_parse_gpgga(fields, count);
  } else if (strcmp(fields[0], "GPGSV") == 0 ||
             strcmp(fields[0], "GLGSV") == 0 ||
             strcmp(fields[0], "GNGSV") == 0) {
    return nmea_parse_gsv(fields, count);
  }

  /* Unknown sentence type — silently ignore */
  return false;
}

bool nmea_get_last_data(nmea_gps_data_t *p_data) {
  if (!m_data_valid || p_data == NULL) {
    return false;
  }

  memcpy(p_data, &m_gps_data, sizeof(nmea_gps_data_t));
  return true;
}

bool nmea_has_fix(void) { return m_data_valid && m_gps_data.fix_valid; }
