# BinaryLens

BinaryLens is a local-first binary capture decoder. It runs as a static site, and parses files in a Web Worker on your device; the app makes no network requests and does not upload your capture or decoded data.

## Run locally

Serve this directory over HTTP (ES modules and Web Workers do not work from every `file://` URL):

```sh
python3 -m http.server 4173
```

Then open <http://localhost:4173>. The app has no package install or build step and can also be deployed as static assets, for example on Cloudflare Pages.

## Define a message

Each field goes on its own line. Integer and float fields support byte order, scaling, and units. Fixed arrays and bitfields are supported.

```text
message SensorPacket {
  header: uint8 = 0xA5
  sequence: uint8
  temperature: float32 little-endian scale 0.1 unit "C"
  flags: bitfield uint8 { alarm: 0, low_battery: 1, fault: 2-3 }
  checksum: crc16-ccitt over header..flags
}
framing: sync 0xA5
```

Supported scalar types are `uint8/16/32/64`, `int8/16/32/64`, and `float32/64`. For variable data use `bytes[length]`, where `length` is an earlier integer field, or a simple expression such as `bytes[length - 7]`. Length-prefixed framing uses a field named `length`, interpreted as the number of bytes following the length field (including any remaining fields such as a checksum).

Checksums include `sum`, `xor`, `crc8` (polynomial 0x07), `crc8-maxim`, `crc16-ccitt`, `crc16-modbus`, and `crc32` (ISO-HDLC). CRC16/CRC32 are big-endian by default; add `little-endian` to a checksum field when the wire format stores its bytes least-significant first. A checksum covers the entire record by default, or a named inclusive range such as `crc16-ccitt over header..payload`.

The C/C++ importer handles simple integer/float members, fixed arrays, and unsigned bitfields. Imported fields default to little-endian; add the appropriate byte order and protocol framing in the layout editor.

## Current preview limits

- Captures are limited to 100 MB.
- The decoder retains up to 50,000 decoded packets for the table and exports (fewer for very wide or array-heavy layouts). Numeric plots are sampled across the capture.
- Support and subscription controls are inactive placeholders until those links are configured.
- This first-week MVP does not include account, billing, saved-layout sync, live serial, or team features from later roadmap phases.
- For practical, dependency-free delivery this preview uses browser-native JavaScript and a Web Worker rather than the plan's React/Vite + C++/WebAssembly toolchain. The repository environment did not include Node.js or Emscripten.
