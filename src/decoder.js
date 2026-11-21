const INTEGER_PATTERN = /^(u?int|int|uint)(8|16|32|64)$/;
const CHECKSUM_PATTERN = /^(crc8|crc16|crc32|sum|xor)(?:-([a-z0-9-]+))?$/i;
const MAX_LAYOUT_LENGTH = 100_000;
const MAX_LAYOUT_FIELDS = 256;
const MAX_RETAINED_CELLS = 1_000_000;
const MAX_RETAINED_ROWS = 50_000;
const CRC8_TABLE = makeCrcTable(8, 0x07, false);
const CRC8_MAXIM_TABLE = makeCrcTable(8, 0x8c, true);
const CRC16_CCITT_TABLE = makeCrcTable(16, 0x1021, false);
const CRC16_MODBUS_TABLE = makeCrcTable(16, 0xa001, true);
const CRC32_TABLE = makeCrcTable(32, 0xedb88320, true);

export function parseLayout(source) {
  if (source.length > MAX_LAYOUT_LENGTH) throw new Error(`Layout is too long (maximum ${MAX_LAYOUT_LENGTH.toLocaleString()} characters).`);
  const text = source.replace(/\r\n?/g, "\n");
  const messageMatch = /\bmessage\s+([A-Za-z_]\w*)\s*\{/m.exec(text);
  if (!messageMatch) throw new Error("Start your layout with `message Name { ... }`.");

  const bodyStart = messageMatch.index + messageMatch[0].length;
  let depth = 1;
  let bodyEnd = bodyStart;
  for (; bodyEnd < text.length && depth > 0; bodyEnd += 1) {
    if (text[bodyEnd] === "{") depth += 1;
    if (text[bodyEnd] === "}") depth -= 1;
  }
  if (depth !== 0) throw new Error("The message definition is missing a closing `}`.");

  const body = text.slice(bodyStart, bodyEnd - 1);
  const fields = [];
  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\/\/.*$/, "").trim().replace(/;$/, "");
    if (!line) continue;
    const fieldMatch = /^([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(line);
    if (!fieldMatch) throw new Error(`Line ${index + 1}: expected \`fieldName: type\`.`);
    fields.push(parseField(fieldMatch[1], fieldMatch[2], index + 1));
    if (fields.length > MAX_LAYOUT_FIELDS) throw new Error(`A layout can contain at most ${MAX_LAYOUT_FIELDS} fields.`);
  }
  if (fields.length === 0) throw new Error("Add at least one field to the message.");

  const fieldNames = new Set();
  for (const field of fields) {
    if (fieldNames.has(field.name)) throw new Error(`The field \`${field.name}\` is declared more than once.`);
    fieldNames.add(field.name);
    for (const member of field.bitMembers ?? []) {
      if (fieldNames.has(member.name)) throw new Error(`The bitfield member \`${member.name}\` conflicts with another field.`);
      fieldNames.add(member.name);
    }
  }

  const framingLine = text.slice(bodyEnd).split("\n").map((line) => line.replace(/\/\/.*$/, "").trim()).find((line) => line.startsWith("framing:"));
  const framing = parseFraming(framingLine?.slice("framing:".length).trim() ?? "");
  if (framing.lengthPrefixed) {
    const lengthIndex = fields.findIndex((field) => field.name === "length");
    if (lengthIndex < 0 || fields[lengthIndex].kind !== "integer" || fields[lengthIndex].count !== 1) {
      throw new Error("Length-prefixed framing needs a scalar integer field named `length`.");
    }
    if (fields.slice(0, lengthIndex).some((field) => field.kind === "bytes")) {
      throw new Error("The length field must appear before variable-length byte fields.");
    }
  }
  const fixedSize = fields.every((field) => field.count !== null || field.kind === "checksum" || field.kind === "bitfield");
  const recordSize = fixedSize
    ? fields.reduce((size, field) => size + field.byteLength, 0)
    : null;

  if (framing.lengthPrefixed && !fields.some((field) => field.name === "length")) {
    throw new Error("Length-prefixed framing needs a field named `length`.");
  }

  return { name: messageMatch[1], fields, framing, recordSize };
}

function parseField(name, declaration, lineNumber) {
  const constantMatch = /\s*=\s*(0x[0-9a-f]+|\d+)\s*$/i.exec(declaration);
  const constant = constantMatch ? Number(constantMatch[1]) : null;
  let typeText = constantMatch ? declaration.slice(0, constantMatch.index).trim() : declaration.trim();
  let range = null;
  const rangeMatch = /\s+over\s+([A-Za-z_]\w*)(?:\.\.([A-Za-z_]\w*))?\s*$/i.exec(typeText);
  if (rangeMatch) {
    range = [rangeMatch[1], rangeMatch[2] ?? rangeMatch[1]];
    typeText = typeText.slice(0, rangeMatch.index).trim();
  }

  const unitMatch = /\s+unit\s+"([^"]*)"/i.exec(typeText);
  const unit = unitMatch?.[1] ?? "";
  if (unitMatch) typeText = typeText.replace(unitMatch[0], "");
  const scaleMatch = /\s+scale\s+(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i.exec(typeText);
  const scale = scaleMatch ? Number(scaleMatch[1]) : 1;
  if (scaleMatch) typeText = typeText.replace(scaleMatch[0], "");
  const endianMatch = /\s+(big-endian|little-endian)\b/i.exec(typeText);
  const endian = endianMatch ? endianMatch[1].toLowerCase().startsWith("little") : true;
  if (endianMatch) typeText = typeText.replace(endianMatch[0], "");
  typeText = typeText.trim();

  if (!Number.isFinite(scale)) throw new Error(`Line ${lineNumber}: \`${name}\` has an invalid scale.`);

  const bitsMatch = /^bitfield\s+(u?int|int|uint)(8|16|32|64)\s*\{(.*)\}$/i.exec(typeText);
  if (bitsMatch) {
    const bitMembers = bitsMatch[3].split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
      const memberMatch = /^([A-Za-z_]\w*)\s*:\s*(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
      if (!memberMatch) throw new Error(`Line ${lineNumber}: invalid bitfield member \`${part}\`.`);
      const first = Number(memberMatch[2]);
      const last = memberMatch[3] === undefined ? first : Number(memberMatch[3]);
      const width = Number(bitsMatch[2]);
      if (first < 0 || last < first || last >= width) throw new Error(`Line ${lineNumber}: \`${part}\` is outside the ${width}-bit field.`);
      return { name: memberMatch[1], first, last };
    });
    return { name, kind: "bitfield", width: Number(bitsMatch[2]), endian, unit, scale, bitMembers, byteLength: Number(bitsMatch[2]) / 8, count: 1, constant };
  }

  const bytesMatch = /^bytes\s*\[\s*(.+?)\s*\]$/i.exec(typeText);
  if (bytesMatch) {
    return { name, kind: "bytes", expression: bytesMatch[1], byteLength: null, count: null, endian, unit, scale, constant };
  }

  const arrayMatch = /^(.+?)\s*\[\s*(\d+)\s*\]$/.exec(typeText);
  const baseType = arrayMatch ? arrayMatch[1].trim() : typeText;
  const count = arrayMatch ? Number(arrayMatch[2]) : 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) {
    throw new Error(`Line ${lineNumber}: \`${name}\` has an invalid array length.`);
  }

  const checksumMatch = CHECKSUM_PATTERN.exec(baseType);
  if (checksumMatch) {
    const algorithm = `${checksumMatch[1].toLowerCase()}${checksumMatch[2] ? `-${checksumMatch[2].toLowerCase()}` : ""}`;
    if (!["crc8", "crc8-07", "crc8-maxim", "crc16", "crc16-ccitt", "crc16-modbus", "crc32", "crc32-iso", "sum", "xor"].includes(algorithm)) {
      throw new Error(`Line ${lineNumber}: checksum \`${algorithm}\` is not supported.`);
    }
    const byteLength = algorithm.startsWith("crc8") || algorithm === "sum" || algorithm === "xor" ? 1 : algorithm.startsWith("crc16") ? 2 : 4;
    return { name, kind: "checksum", algorithm, range, byteLength, count: 1, endian: endianMatch ? endian : false, unit, scale, constant };
  }

  const integerMatch = INTEGER_PATTERN.exec(baseType);
  if (integerMatch) {
    const signed = integerMatch[1] === "int";
    const width = Number(integerMatch[2]);
    return { name, kind: "integer", signed, width, endian, unit, scale, byteLength: width / 8 * count, count, constant };
  }

  const floatMatch = /^float(32|64)$/i.exec(baseType);
  if (floatMatch) {
    const width = Number(floatMatch[1]);
    return { name, kind: "float", width, endian, unit, scale, byteLength: width / 8 * count, count, constant };
  }

  const enumMatch = /^enum\s+(u?int|int|uint)(8|16|32|64)\s*\{(.*)\}$/i.exec(typeText);
  if (enumMatch) {
    const labels = {};
    for (const part of enumMatch[3].split(",")) {
      const label = /^\s*(-?(?:0x[0-9a-f]+|\d+))\s*:\s*([A-Za-z_]\w*)\s*$/i.exec(part);
      if (!label) throw new Error(`Line ${lineNumber}: invalid enum entry \`${part.trim()}\`.`);
      labels[Number(label[1])] = label[2];
    }
    const width = Number(enumMatch[2]);
    return { name, kind: "integer", signed: enumMatch[1] === "int", width, endian, unit, scale, labels, byteLength: width / 8 * count, count, constant };
  }

  throw new Error(`Line ${lineNumber}: unsupported field type in \`${name}\`: ${typeText}.`);
}

function parseFraming(value) {
  if (!value) return { sync: null, lengthPrefixed: false };
  const syncMatch = /\bsync\s+(0x[0-9a-f]+(?:\s+[0-9a-f]{2})*)/i.exec(value);
  const sync = syncMatch
    ? syncMatch[1].trim().split(/\s+/).map((byte) => Number.parseInt(byte.replace(/^0x/i, ""), 16))
    : null;
  if (sync && sync.length > 16) throw new Error("A sync header can contain at most 16 bytes.");
  if (sync?.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("The sync header must contain hexadecimal bytes.");
  }
  const options = value.replace(syncMatch?.[0] ?? "", "").split(/[\s,]+/).filter(Boolean);
  if (options.some((option) => option !== "fixed-size" && option !== "length-prefixed")) {
    throw new Error("Framing supports `fixed-size`, `length-prefixed`, and `sync 0xA5` (which can be combined with `length-prefixed`).");
  }
  const fixedSize = options.includes("fixed-size");
  const lengthPrefixed = options.includes("length-prefixed");
  if (fixedSize && (sync || lengthPrefixed)) throw new Error("Choose `fixed-size` or sync/length-prefixed framing, not both.");
  return { sync, lengthPrefixed };
}

export function importCStruct(source) {
  if (source.length > MAX_LAYOUT_LENGTH) throw new Error(`C struct is too long (maximum ${MAX_LAYOUT_LENGTH.toLocaleString()} characters).`);
  const text = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const structMatch = /\bstruct\b([\s\S]*?)\{([\s\S]*?)\}/m.exec(text);
  if (!structMatch) throw new Error("No C struct body found. Paste a declaration with `struct { ... }`.");
  const declaredName = structMatch[1].replace(/__attribute__\s*\(\([\s\S]*?\)\)/g, "").trim().match(/^[A-Za-z_]\w*/)?.[0];
  const typedefName = text.slice(structMatch.index + structMatch[0].length).match(/^\s*([A-Za-z_]\w*)\s*;/)?.[1];
  const structName = declaredName ?? typedefName ?? "Packet";

  const typeMap = new Map([
    ["uint8_t", "uint8"], ["int8_t", "int8"], ["unsigned char", "uint8"], ["signed char", "int8"], ["char", "int8"],
    ["uint16_t", "uint16"], ["int16_t", "int16"], ["unsigned short", "uint16"], ["unsigned short int", "uint16"], ["signed short", "int16"], ["signed short int", "int16"], ["short", "int16"], ["short int", "int16"],
    ["uint32_t", "uint32"], ["int32_t", "int32"], ["unsigned int", "uint32"], ["signed int", "int32"], ["int", "int32"],
    ["uint64_t", "uint64"], ["int64_t", "int64"], ["unsigned long long", "uint64"], ["signed long long", "int64"], ["long long", "int64"],
    ["float", "float32"], ["double", "float64"],
  ]);
  const declarations = structMatch[2].split(";").map((part) => part.trim()).filter(Boolean);
  const fields = [];
  let bitMembers = [];
  let bitFieldType = null;
  let bitFieldOffset = 0;
  let bitFieldIndex = 0;
  const flushBitFields = () => {
    if (bitMembers.length === 0 || bitFieldType === null) return;
    bitFieldIndex += 1;
    fields.push(`  __bits_${bitFieldIndex}: bitfield ${bitFieldType} { ${bitMembers.join(", ")} }`);
    bitMembers = [];
    bitFieldType = null;
    bitFieldOffset = 0;
  };
  let bitOffset = 0;
  let bitType = null;
  for (const declaration of declarations) {
    const member = /^(?:(?:const|volatile)\s+)*(uint8_t|int8_t|uint16_t|int16_t|uint32_t|int32_t|uint64_t|int64_t|unsigned\s+(?:char|short(?:\s+int)?|int|long\s+long)|signed\s+(?:char|short(?:\s+int)?|int|long\s+long)|char|short(?:\s+int)?|int|long\s+long|float|double)\s+([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*\])?\s*(?::\s*(\d+))?$/i.exec(declaration);
    if (!member) throw new Error(`Cannot import this C member yet: "${declaration}". Use fixed-size primitive fields and arrays.`);
    const cType = member[1].replace(/\s+/g, " ").toLowerCase();
    let type = typeMap.get(cType);
    if (!type) throw new Error(`Unsupported C type: ${cType}.`);
    const name = member[2];
    const arrayLength = member[3] ? Number(member[3]) : null;
    const bitWidth = member[4] ? Number(member[4]) : null;
    if (arrayLength !== null) {
      flushBitFields();
      if (type.startsWith("float")) throw new Error("Float arrays are not supported by the C struct importer yet.");
      fields.push(`  ${name}: ${type}[${arrayLength}]`);
      bitOffset = 0;
      bitType = null;
      continue;
    }
    if (bitWidth !== null) {
      if (!type.startsWith("uint") || Number(type.slice(4)) < 8) throw new Error(`Bitfield ${name} needs an unsigned integer base type.`);
      if (bitFieldType !== type) {
        flushBitFields();
        bitFieldType = type;
      }
      if (bitType !== type) { bitOffset = 0; bitType = type; }
      const width = Number(type.slice(4));
      if (bitWidth < 1 || bitOffset + bitWidth > width) throw new Error(`Bitfield ${name} exceeds its ${width}-bit storage unit.`);
      bitMembers.push(`${name}: ${bitFieldOffset}${bitWidth > 1 ? `-${bitFieldOffset + bitWidth - 1}` : ""}`);
      bitFieldOffset += bitWidth;
      bitOffset += bitWidth;
      if (bitOffset === width) { flushBitFields(); bitOffset = 0; bitType = null; }
      continue;
    }
    flushBitFields();
    fields.push(`  ${name}: ${type}`);
    bitOffset = 0;
    bitType = null;
  }
  flushBitFields();
  if (fields.length === 0) throw new Error("The struct has no supported fields.");
  return `message ${structName} {\n${fields.join("\n")}\n}`;
}

export function decodeBuffer(buffer, layout, onProgress = () => {}) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const rows = [];
  const errors = [];
  const chartSamples = {};
  const cellsPerRow = layout.fields.reduce((cells, field) => cells + 1 + (field.bitMembers?.length ?? 0) + ((field.count ?? 1) - 1), 0);
  const maxRows = Math.min(MAX_RETAINED_ROWS, Math.max(1, Math.floor(MAX_RETAINED_CELLS / Math.max(1, cellsPerRow))));
  const maxErrors = 200;
  const progressStride = Math.max(1, Math.floor(bytes.length / 100));
  const chartStride = Math.max(1, Math.floor(bytes.length / 750));
  let offset = 0;
  let recordCount = 0;
  let issueCount = 0;
  let nextProgressOffset = progressStride;
  let nextChartOffset = 0;

  const saveIssue = (record, byteOffset, message) => {
    issueCount += 1;
    if (errors.length < maxErrors) errors.push({ record, offset: byteOffset, message });
  };

  while (offset < bytes.length) {
    if (layout.framing.sync) {
      const syncOffset = findSync(bytes, offset, layout.framing.sync);
      if (syncOffset < 0) {
        if (offset < bytes.length) saveIssue(recordCount + 1, offset, "No more sync headers found; trailing bytes could not be framed.");
        break;
      }
      if (syncOffset > offset) saveIssue(recordCount + 1, offset, `Skipped ${syncOffset - offset} byte(s) while searching for the next sync header.`);
      offset = syncOffset;
    }

    const start = offset;
    const values = {};
    const positions = {};
    let cursor = start;
    let frameEnd = bytes.length;
    let recordInvalid = false;

    for (let fieldIndex = 0; fieldIndex < layout.fields.length; fieldIndex += 1) {
      const field = layout.fields[fieldIndex];
      const fieldStart = cursor;
      positions[field.name] = { start: fieldStart, end: fieldStart + field.byteLength };
      const count = field.kind === "bytes" ? evaluateLength(field.expression, values, recordCount + 1) : field.count;
      const size = field.kind === "bytes" ? count : field.byteLength;
      if (size < 0 || size > 100_000_000) {
        saveIssue(recordCount + 1, fieldStart, `Field "${field.name}" has an invalid length (${size}).`);
        recordInvalid = true;
        break;
      }
      if (fieldStart + size > frameEnd || fieldStart + size > bytes.length) {
        saveIssue(recordCount + 1, fieldStart, `Capture ended before field "${field.name}" was complete.`);
        recordInvalid = true;
        break;
      }
      positions[field.name].end = fieldStart + size;

      let value;
      if (field.kind === "bytes") {
        value = bytesToHex(bytes.subarray(fieldStart, fieldStart + size));
      } else if (field.kind === "bitfield") {
        value = readInteger(view, fieldStart, field.width, false, field.endian);
        const raw = BigInt(value);
        for (const member of field.bitMembers) {
          const width = member.last - member.first + 1;
          const mask = (1n << BigInt(width)) - 1n;
          const bitValue = Number((raw >> BigInt(member.first)) & mask);
          values[member.name] = bitValue;
        }
      } else if (field.kind === "checksum") {
        const rangeStart = field.range ? positions[field.range[0]]?.start : start;
        const rangeEnd = field.range ? positions[field.range[1]]?.end : fieldStart;
        if (rangeStart === undefined || rangeEnd === undefined || rangeEnd > fieldStart || rangeStart < start) {
          saveIssue(recordCount + 1, fieldStart, `Checksum "${field.name}" has an invalid coverage range.`);
          recordInvalid = true;
          break;
        }
        const actual = readInteger(view, fieldStart, field.byteLength * 8, false, field.endian);
        const expected = calculateChecksum(bytes.subarray(rangeStart, rangeEnd), field.algorithm);
        if (BigInt(actual) !== BigInt(expected)) {
          saveIssue(recordCount + 1, fieldStart, `${field.name}: expected 0x${BigInt(expected).toString(16)}, got 0x${BigInt(actual).toString(16)}.`);
        }
        value = actual;
      } else if (field.kind === "integer") {
        const rawValues = [];
        for (let index = 0; index < field.count; index += 1) {
          rawValues.push(readInteger(view, fieldStart + index * field.width / 8, field.width, field.signed, field.endian));
        }
        value = field.count > 1 ? rawValues.map((raw) => applyScale(raw, field.scale)) : applyScale(rawValues[0], field.scale);
        if (field.labels && field.count === 1) value = field.labels[rawValues[0]] ?? value;
      } else {
        const rawValues = [];
        for (let index = 0; index < field.count; index += 1) {
          const at = fieldStart + index * field.width / 8;
          const raw = field.width === 32 ? view.getFloat32(at, field.endian) : view.getFloat64(at, field.endian);
          rawValues.push(Number.isFinite(raw) ? applyScale(raw, field.scale, field.width === 32 ? 7 : 15) : String(raw));
        }
        value = field.count > 1 ? rawValues : rawValues[0];
      }
      values[field.name] = value;
      cursor = fieldStart + size;

      if (field.constant !== null && Number(value) !== field.constant) {
        saveIssue(recordCount + 1, fieldStart, `${field.name}: expected ${field.constant}, got ${String(value)}.`);
      }

      if (layout.framing.lengthPrefixed && field.name === "length") {
        const declaredLength = Number(value);
        const prefixEnd = cursor - start;
        const totalLength = prefixEnd + declaredLength;
        if (!Number.isSafeInteger(totalLength) || totalLength < prefixEnd || totalLength > bytes.length - start) {
          saveIssue(recordCount + 1, fieldStart, `Invalid length prefix (${String(value)}); expected a frame length or payload length.`);
          recordInvalid = true;
          break;
        }
        frameEnd = start + totalLength;
      }
    }

    if (recordInvalid) {
      if (!layout.framing.sync) break;
      offset = start + 1;
      continue;
    }
    if (cursor <= start) {
      saveIssue(recordCount + 1, start, "The layout did not consume any bytes; decoding stopped.");
      break;
    }

    recordCount += 1;
    if (rows.length < maxRows) rows.push({ index: recordCount, values, errors: errors.filter((error) => error.record === recordCount).map((error) => error.message) });
    if (offset >= nextChartOffset) {
      for (const field of layout.fields) {
        const value = values[field.name];
        if (typeof value === "number" && Number.isFinite(value)) {
          const samples = chartSamples[field.name] ?? (chartSamples[field.name] = []);
          if (samples.length < 1_000) samples.push({ index: recordCount, value });
        }
      }
      nextChartOffset = offset + chartStride;
    }

    offset = layout.framing.lengthPrefixed ? frameEnd : cursor;
    if (offset < bytes.length && offset <= start) {
      saveIssue(recordCount, start, "Invalid packet boundary; decoding stopped.");
      break;
    }
    if (offset >= nextProgressOffset) {
      onProgress(Math.min(1, offset / bytes.length));
      nextProgressOffset = offset + progressStride;
    }
    if (!layout.framing.sync && !layout.framing.lengthPrefixed && layout.recordSize === null && offset === bytes.length) break;
  }

  onProgress(1);
  return {
    fields: layout.fields.flatMap((field) => [
      { name: field.name, unit: field.unit, kind: field.kind },
      ...(field.bitMembers ?? []).map((member) => ({ name: member.name, unit: "", kind: "bit" })),
    ]),
    rows,
    errors,
    issueCount,
    recordCount,
    byteLength: bytes.length,
    truncatedRows: recordCount > rows.length,
    rowLimit: maxRows,
    chartSamples: Object.fromEntries(Object.entries(chartSamples).map(([name, samples]) => [name, decimate(samples, 360)])),
  };
}

function evaluateLength(expression, values, record) {
  const direct = /^(0x[0-9a-f]+|\d+)$/i.exec(expression);
  if (direct) return Number(direct[1]);
  const calculation = /^([A-Za-z_]\w*)\s*([+-])\s*(0x[0-9a-f]+|\d+)$/i.exec(expression);
  if (calculation) {
    const source = Number(values[calculation[1]]);
    if (!Number.isFinite(source)) throw new Error(`Packet ${record}: length field "${calculation[1]}" must appear before bytes[${expression}].`);
    const amount = Number(calculation[3]);
    return calculation[2] === "+" ? source + amount : source - amount;
  }
  const reference = /^[A-Za-z_]\w*$/.exec(expression);
  if (reference) {
    const value = Number(values[expression]);
    if (Number.isSafeInteger(value)) return value;
  }
  throw new Error(`Packet ${record}: unsupported bytes length expression "${expression}".`);
}

function readInteger(view, offset, width, signed, littleEndian) {
  if (width === 8) return signed ? view.getInt8(offset) : view.getUint8(offset);
  if (width === 16) return signed ? view.getInt16(offset, littleEndian) : view.getUint16(offset, littleEndian);
  if (width === 32) return signed ? view.getInt32(offset, littleEndian) : view.getUint32(offset, littleEndian);
  const value = signed ? view.getBigInt64(offset, littleEndian) : view.getBigUint64(offset, littleEndian);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
}

function applyScale(value, scale, precision = 15) {
  if (typeof value === "bigint") return scale === 1 ? value.toString() : Number(value) * scale;
  if (typeof value !== "number") return value;
  const scaled = value * scale;
  return Number.isInteger(scaled) ? scaled : Number(scaled.toPrecision(precision));
}

function calculateChecksum(bytes, algorithm) {
  if (algorithm === "sum") return bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0);
  if (algorithm === "xor") return bytes.reduce((sum, byte) => sum ^ byte, 0);
  if (algorithm.startsWith("crc8")) {
    const maxim = algorithm === "crc8-maxim";
    const table = maxim ? CRC8_MAXIM_TABLE : CRC8_TABLE;
    let crc = 0;
    for (const byte of bytes) crc = table[(crc ^ byte) & 0xff];
    return crc;
  }
  if (algorithm.startsWith("crc16")) {
    let crc = algorithm === "crc16-modbus" ? 0xffff : 0xffff;
    const reflected = algorithm === "crc16-modbus";
    const table = reflected ? CRC16_MODBUS_TABLE : CRC16_CCITT_TABLE;
    for (const byte of bytes) {
      crc = reflected
        ? (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
        : ((crc << 8) & 0xffff) ^ table[((crc >>> 8) ^ byte) & 0xff];
    }
    return crc & 0xffff;
  }
  if (algorithm.startsWith("crc32")) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  }
  throw new Error(`Unsupported checksum algorithm: ${algorithm}.`);
}

function findSync(bytes, from, sync) {
  outer: for (let offset = from; offset <= bytes.length - sync.length; offset += 1) {
    for (let index = 0; index < sync.length; index += 1) {
      if (bytes[offset + index] !== sync[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function bytesToHex(bytes) {
  const shown = bytes.subarray(0, 24);
  const hex = Array.from(shown, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
  return bytes.length > shown.length ? `${hex} … (${bytes.length} bytes)` : hex;
}

function decimate(samples, limit) {
  if (samples.length <= limit) return samples;
  const stride = (samples.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => samples[Math.round(index * stride)]);
}

function makeCrcTable(width, polynomial, reflected) {
  const table = new Uint32Array(256);
  const mask = width === 32 ? 0xffffffff : (1 << width) - 1;
  for (let value = 0; value < 256; value += 1) {
    let crc = reflected ? value : value << (width - 8);
    for (let bit = 0; bit < 8; bit += 1) {
      crc = reflected
        ? ((crc & 1) ? (crc >>> 1) ^ polynomial : crc >>> 1)
        : ((crc & (1 << (width - 1))) ? (crc << 1) ^ polynomial : crc << 1);
    }
    table[value] = crc & mask;
  }
  return table;
}
