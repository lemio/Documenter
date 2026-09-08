/*
 * device.js — talk to an ESP32 running MicroPython over Web Serial.
 *
 *   • connect()            – pick a serial port and open it
 *   • detectMicroPython()  – is a MicroPython REPL answering?
 *   • flashMicroPython()   – erase + write the bundled firmware with esptool-js
 *   • run(pythonSource)    – push a script over the raw REPL and let it run
 *   • onData / onStatus    – telemetry + state callbacks
 *
 * The running script prints one telemetry line per sample, prefixed with the
 * RS control byte (0x1e) followed by JSON: "\x1e{\"4\": 1, \"5\": 2048}".
 */

export const TELEMETRY_PREFIX = "\x1e";

// Bundled firmware — the latest ESP32_GENERIC_S3 build from micropython.org.
// Replace the file in firmware/ and this path to update. See firmware/README.md.
export const BUNDLED_FIRMWARE = "./firmware/ESP32_GENERIC_S3-20260824-v1.29.0.bin";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Device {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.state = "disconnected";
    this.mode = "idle"; // idle | repl | flash
    this.onData = () => {};   // parsed telemetry JSON (MicroPython program)
    this.onLine = () => {};   // every other complete serial line (UART mode)
    this.onStatus = () => {};
    this.onLog = () => {};
    this.microPython = false;  // did the last detect find a REPL?
    this._rx = "";
    this._lineTail = "";
    this._streaming = false;
    this._readLoop = null;
  }

  get supported() {
    return "serial" in navigator;
  }

  setStatus(state, detail) {
    this.state = state;
    this.onStatus(state, detail);
  }

  // ---- connection -------------------------------------------------------

  async connect() {
    if (!this.supported) throw new Error("This browser has no Web Serial. Use Chrome or Edge on desktop.");
    this.setStatus("connecting");
    const port = await navigator.serial.requestPort();
    this.port = port;
    await this._openPort();
    this.setStatus("connected");
    return port;
  }

  async _openPort() {
    await this.port.open({ baudRate: 115200 });
    this.mode = "repl";
    this._rx = "";
    this._lineTail = "";
    this._startReading();
  }

  async _releasePort() {
    this._streaming = false;
    this.mode = "idle";
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
      }
    } catch (e) {}
    try {
      if (this.writer) this.writer.releaseLock();
    } catch (e) {}
    this.reader = null;
    this.writer = null;
    if (this._readLoop) {
      try { await this._readLoop; } catch (e) {}
      this._readLoop = null;
    }
  }

  async disconnect() {
    await this._releasePort();
    try { if (this.port) await this.port.close(); } catch (e) {}
    this.port = null;
    this.microPython = false;
    this.setStatus("disconnected");
  }

  _startReading() {
    this.writer = this.port.writable.getWriter();
    this._readLoop = (async () => {
      while (this.port && this.port.readable && this.mode === "repl") {
        let reader;
        try {
          reader = this.port.readable.getReader();
          this.reader = reader;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) this._ingest(dec.decode(value, { stream: true }));
          }
        } catch (e) {
          // stream error / port closed — leave the loop
          break;
        } finally {
          try { reader && reader.releaseLock(); } catch (e) {}
        }
      }
    })();
  }

  _ingest(text) {
    this._rx += text;
    if (this._rx.length > 20000) this._rx = this._rx.slice(-8000);

    // Line parsing runs whether or not a MicroPython program is streaming, so
    // UART-mode blocks can scan the raw serial output of any firmware.
    this._lineTail += text;
    if (this._lineTail.length > 4000 && this._lineTail.indexOf("\n") < 0) {
      this._lineTail = this._lineTail.slice(-1000);
    }
    let nl;
    while ((nl = this._lineTail.indexOf("\n")) >= 0) {
      const line = this._lineTail.slice(0, nl).replace(/\r$/, "");
      this._lineTail = this._lineTail.slice(nl + 1);
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    const i = line.indexOf(TELEMETRY_PREFIX);
    if (i < 0) {
      if (line.trim()) {
        this.onLine(line);
        this.onLog(line);
      }
      return;
    }
    try {
      this.onData(JSON.parse(line.slice(i + 1)));
    } catch (e) {
      /* partial / noisy line — ignore */
    }
  }

  // ---- low level REPL --------------------------------------------------

  async _write(str) {
    if (!this.writer) throw new Error("port not open");
    await this.writer.write(enc.encode(str));
  }

  async _waitFor(needle, timeout = 4000) {
    const start = Date.now();
    for (;;) {
      const idx = this._rx.indexOf(needle);
      if (idx >= 0) {
        const got = this._rx.slice(0, idx + needle.length);
        this._rx = this._rx.slice(idx + needle.length);
        return got;
      }
      if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${JSON.stringify(needle)}`);
      await sleep(20);
    }
  }

  /** Interrupt whatever is running and get a clean raw-REPL prompt. */
  async _enterRaw() {
    this._streaming = false;
    this._rx = "";
    this._lineTail = "";
    await this._write("\r\x03\x03"); // Ctrl-C twice
    await sleep(80);
    this._rx = "";
    this._lineTail = "";
    await this._write("\r\x01"); // Ctrl-A -> raw REPL
    // banner is "raw REPL; CTRL-B to exit\r\n>" — match leniently, then the ">"
    await this._waitFor("raw REPL", 2500);
    await this._waitFor(">", 1000).catch(() => {});
    await sleep(20);
  }

  async _exitRaw() {
    await this._write("\r\x02"); // Ctrl-B -> friendly REPL
  }

  // ---- public: detection --------------------------------------------

  async detectMicroPython() {
    this.setStatus("checking");
    this.microPython = false;
    try {
      this._streaming = false;
      this._rx = "";
      this._lineTail = "";
      await this._write("\r\x03\x03");
      await sleep(120);
      this._rx = "";
      await this._write("\r\x01");
      await this._waitFor("raw REPL", 1800);
      await this._exitRaw();
      await sleep(60);
      this.microPython = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- public: run a program (keeps running, streams telemetry) ------

  async run(pythonSource) {
    if (this.mode !== "repl") throw new Error("device not in REPL mode");
    await this._enterRaw();
    // paste the script, then Ctrl-D to execute
    await this._write(pythonSource);
    await this._write("\x04");
    // MicroPython replies "OK" once it accepts the script
    await this._waitFor("OK", 3000);
    this._rx = "";
    this._lineTail = "";
    this._streaming = true;
    this.setStatus("running");
  }

  /** Stop the running script and drop back to a bare prompt. */
  async halt() {
    if (this.mode !== "repl") return;
    this._streaming = false;
    await this._write("\r\x03\x03");
    await sleep(80);
    this._rx = "";
    this.setStatus("connected");
  }

  // ---- public: flashing --------------------------------------------

  async flashMicroPython({ firmware, onProgress } = {}) {
    if (!this.port) throw new Error("connect first");
    this.setStatus("flashing", "preparing");
    onProgress && onProgress(0, "preparing");

    const bin = firmware || (await this._fetchBundledFirmware());

    // hand the raw port to esptool-js
    const wasStreaming = this._streaming;
    await this._releasePort();
    try { await this.port.close(); } catch (e) {}

    const { ESPLoader, Transport } = await import("./libraries/esptool-bundle.js");
    const transport = new Transport(this.port, false);
    const terminal = {
      clean: () => {},
      writeLine: (l) => this.onLog(l),
      write: (d) => this.onLog(d),
    };
    const esploader = new ESPLoader({ transport, baudrate: 921600, romBaudrate: 115200, terminal });

    try {
      onProgress && onProgress(2, "connecting to bootloader");
      const chip = await esploader.main();
      this.onLog(`detected ${chip}`);

      onProgress && onProgress(5, "erasing + writing firmware");
      await esploader.writeFlash({
        fileArray: [{ data: bin, address: 0 }],
        flashSize: "keep",
        flashMode: "keep",
        flashFreq: "keep",
        eraseAll: true,
        compress: true,
        reportProgress: (_i, written, total) => {
          const pct = 5 + Math.round((written / total) * 92);
          onProgress && onProgress(pct, "writing firmware");
        },
      });

      onProgress && onProgress(98, "resetting");
      await esploader.after("hard_reset");
    } finally {
      try { await transport.disconnect(); } catch (e) {}
    }

    // give MicroPython a moment to boot, then reopen for the REPL
    await sleep(1500);
    try {
      await this._openPort();
    } catch (e) {
      // native-USB S3 boards re-enumerate after flashing — ask for a re-pick
      this.setStatus("disconnected");
      throw new Error("Flashed OK. The board re-enumerated — press connect again to re-select it.");
    }
    onProgress && onProgress(100, "done");
    this.microPython = true;
    this.setStatus("connected");
    void wasStreaming;
  }

  async _fetchBundledFirmware() {
    const res = await fetch(BUNDLED_FIRMWARE);
    if (!res.ok) throw new Error("Could not load the bundled firmware file.");
    return new Uint8Array(await res.arrayBuffer());
  }
}

/*
 * Generate the MicroPython program for a set of pin bindings.
 * bindings: [{ pin: Number, mode: "in"|"analog"|"out"|"pwm", value: 0|1,
 *             pull: "none"|"up"|"down",              // digital input only
 *             atten: "0"|"2_5"|"6"|"11",             // analog input only
 *             pwmFreq: Number, pwmDuty: 0..100 }]    // pwm output only
 */
const PULL = { up: ", Pin.PULL_UP", down: ", Pin.PULL_DOWN", none: "" };
// ESP32-S3 ADC attenuation -> MicroPython ADC constant. 11 dB (0–3100 mV)
// is the default.
const ATTEN = { "0": "ATTN_0DB", "2_5": "ATTN_2_5DB", "6": "ATTN_6DB", "11": "ATTN_11DB" };

export function generateProgram(bindings) {
  const setup = [];
  const readers = [];
  const seen = new Set();

  for (const b of bindings) {
    if (b.pin == null || seen.has(b.pin + ":" + b.mode)) continue;
    seen.add(b.pin + ":" + b.mode);
    const g = b.pin;
    const pull = PULL[b.pull] || "";
    if (b.mode === "analog") {
      const att = "ADC." + (ATTEN[b.atten] || "ATTN_11DB");
      setup.push(
        `try:\n    _a${g} = ADC(Pin(${g}), atten=${att})\n` +
        `except TypeError:\n    _a${g} = ADC(Pin(${g})); _a${g}.atten(${att})`
      );
      readers.push(`    try:\n        d['${g}'] = _a${g}.read()\n    except Exception:\n        d['${g}'] = None`);
    } else if (b.mode === "out") {
      setup.push(`_o${g} = Pin(${g}, Pin.OUT); _o${g}.value(${b.value ? 1 : 0})`);
      readers.push(`    d['${g}'] = _o${g}.value()`);
    } else if (b.mode === "pwm") {
      const freq = Math.max(1, Math.round(b.pwmFreq || 1000));
      const duty = Math.max(0, Math.min(65535, Math.round(((b.pwmDuty || 0) / 100) * 65535)));
      setup.push(
        `try:\n    _p${g} = PWM(Pin(${g}), freq=${freq}, duty_u16=${duty})\n` +
        `except TypeError:\n    _p${g} = PWM(Pin(${g})); _p${g}.freq(${freq}); _p${g}.duty_u16(${duty})`
      );
      readers.push(`    try:\n        d['${g}'] = _p${g}.duty_u16()\n    except Exception:\n        d['${g}'] = None`);
    } else {
      setup.push(`_i${g} = Pin(${g}, Pin.IN${pull})`);
      readers.push(`    d['${g}'] = _i${g}.value()`);
    }
  }

  return [
    "import json, time",
    "from machine import Pin, ADC, PWM",
    "",
    ...setup,
    "",
    "while True:",
    "    d = {}",
    ...(readers.length ? readers : ["    pass"]),
    "    print(chr(30) + json.dumps(d))",  // 0x1e = TELEMETRY_PREFIX
    "    time.sleep_ms(80)",
    "",
  ].join("\n");
}
