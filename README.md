# MicroPython Visual

A freeform board of **value blocks**. Each block can be bound to a pin on an
ESP32-S3 running MicroPython; the Python program on the device is regenerated
and re-sent whenever a binding changes, and live telemetry drives the block
values and sparklines.

Open **`index.html`** with any static server (the p5.vscode live server is
fine). Chrome or Edge on desktop is required for the device features
(Web Serial); everything else works in any browser.

## Using it

| Action | How |
| --- | --- |
| New block | **`+`** (top-right) or press `n` |
| Remove a block | hover it and click the **×** — on a phone, press-and-hold first |
| Move a block | drag it anywhere |
| Rename a block / change its icon | click the label or the icon and type (emoji welcome) |
| Bind a pin | click the **pin chip** → pick *digital in / analog in / digital out / PWM out / UART*, a GPIO, and then a **pull resistor** (digital in) or an **input voltage range** (analog in) |
| Read a value from serial text (UART) | pin chip → **UART** → type the text to look for (e.g. `Distance: `) — see below |
| Change how a value reads | click the **value** → number / voltage / percent, toggle the sparkline (shown to the *left* of the value), **auto-scale** its range, invert HIGH/LOW, set an output HIGH/LOW, or a **PWM** display (percent / average voltage) + frequency |
| Set a PWM duty cycle | drag the little **range slider** on the block itself (left of the value) |
| Edit the title | click it and type — the marker grows with the text |

An empty label / icon / title is left blank; a faint `_` placeholder appears
only while you hover the block, so you can still find and click it. The
value's icon/text sits flush against the right edge of the block.

A digital input shows **HIGH / LOW**; an analog input shows the raw
**0–4095**, or a voltage / percent. A **PWM output** has a mini range slider on the block for its duty cycle;
the value shows either `0–100 %` or the **average voltage**
(`duty × 3.3 V`), and the value menu picks the frequency
(100 Hz / 500 Hz / 1 kHz / 5 kHz / 25 kHz). Generated as
`PWM(Pin(g), freq=…, duty_u16=…)`.

### UART mode

A **UART** block isn't tied to a GPIO. It scans every incoming serial line
for the text you gave it; on a line that contains it, the **first number
after that text** (int or decimal, negative allowed) becomes the block's
value. For `Distance: ` a line like `Distance: 42.5 cm` shows `42.5`.

This reads the board's existing serial output, so it works with **any
firmware** — Arduino sketch, C, whatever — and needs **no MicroPython**. When
every block is a UART block the app just opens the port and reads; it never
sends REPL bytes or offers to flash. UART blocks can have a sparkline
(auto-scaled, since the range is unknown).

### ADC range (attenuation)

The ESP32-S3 ADC is read with `atten=` set from the pin menu — default
**11 dB** (`0–3100 mV`), the widest range:

| Menu item | ADC constant | Input range |
| --- | --- | --- |
| `0 – 950 mV` | `ADC.ATTN_0DB` | 0 – 950 mV |
| `0 – 1250 mV` | `ADC.ATTN_2_5DB` | 0 – 1250 mV |
| `0 – 1750 mV` | `ADC.ATTN_6DB` | 0 – 1750 mV |
| `0 – 3100 mV` *(default)* | `ADC.ATTN_11DB` | 0 – 3100 mV |

The voltage readout scales to the chosen range. When the raw value is
saturated (`4095`) it shows e.g. **`>3.100 V`**, since the true input may be
higher than the range allows.

The **whole state** — every block (including its live value and sparkline
history), the title, and the demo / webcam toggles — is kept in
`localStorage` and restored on reload.

**Webcam background** (device menu) puts the live camera feed behind the
board, rotated to fill a portrait screen; the blocks stay opaque on top. The
preference is remembered, though the browser may need one tap to re-grant the
camera after a reload.

## The device

Click the **connect** chip → *Connect an ESP32…* and pick the serial port.

- If a **MicroPython REPL answers**, the app immediately pushes the generated
  program and starts reading telemetry.
- If **not**, it offers to flash the bundled firmware
  (`firmware/ESP32_GENERIC_S3-*.bin`, the latest from
  <https://micropython.org/download/ESP32_GENERIC_S3/>) with
  [esptool-js](https://github.com/espressif/esptool-js), vendored at
  `libraries/esptool-bundle.js`. *Load firmware file…* flashes any local `.bin`.

The generated program (see `generateProgram()` in `device.js`) is a small
read loop that prints one JSON telemetry line per sample:

```python
import json, time
from machine import Pin, ADC

_i4 = Pin(4, Pin.IN, Pin.PULL_UP)   # pull resistor from the pin menu
try:
    _a5 = ADC(Pin(5), atten=ADC.ATTN_11DB)   # input range from the pin menu
except TypeError:
    _a5 = ADC(Pin(5)); _a5.atten(ADC.ATTN_11DB)

while True:
    d = {}
    d['4'] = _i4.value()
    try:
        d['5'] = _a5.read()
    except Exception:
        d['5'] = None
    print(chr(30) + json.dumps(d))   # 0x1e-prefixed telemetry
    time.sleep_ms(80)
```

**Demo data (no device)** in the same menu drives the blocks with a
synthetic feed so the UI can be explored without hardware.

## Files

```
index.html          shell
app.css / app.js     the editor (vanilla, ES modules — no framework)
device.js            Web Serial + raw-REPL + esptool-js flashing + code-gen
libraries/esptool-bundle.js   vendored esptool-js 0.6.1
firmware/            bundled MicroPython image (see firmware/README.md)
FigmaExport/         original Figma reference frames (kept for the look; not loaded)
```

The old p5/Figma prototype files (`sketch*.js`, `figma.js`, `style.css`,
`app.html`) are left in place but unused.
