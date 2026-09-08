# Bundled MicroPython firmware

`device.js` flashes this file with [esptool-js](https://github.com/espressif/esptool-js)
(vendored at `../libraries/esptool-bundle.js`) when a connected board is not
already running MicroPython.

- **File:** `ESP32_GENERIC_S3-20260824-v1.29.0.bin`
- **Source:** <https://micropython.org/download/ESP32_GENERIC_S3/>
- **Flash offset:** `0x0` (the combined image — set in `device.js`)

## Updating

1. Download the newest `ESP32_GENERIC_S3-*.bin` (not the `.app-bin`) from the
   page above.
2. Drop it in this folder.
3. Point `BUNDLED_FIRMWARE` in `../device.js` at the new filename.

The device menu also has **"Load firmware file…"** to flash any local `.bin`
without changing the bundle.
