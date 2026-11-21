import { importCStruct, parseLayout } from "./decoder.js";

const SENSOR_LAYOUT = `message SensorPacket {
  header: uint8 = 0xA5
  sequence: uint8
  temperature: float32 little-endian scale 1.0 unit "°C"
  flags: bitfield uint8 { alarm: 0, low_battery: 1, fault: 2-3 }
  checksum: crc16-ccitt over header..flags
}
framing: sync 0xA5`;

const PRESETS = [
  {
    name: "Sensor packet · CRC16",
    layout: SENSOR_LAYOUT,
  },
  {
    name: "Modbus RTU · read response",
    layout: `message ModbusResponse {
  address: uint8
  function: uint8
  byte_count: uint8
  registers: bytes[byte_count]
  checksum: crc16-modbus little-endian over address..registers
}`,
  },
  {
    name: "Fixed telemetry · little-endian",
    layout: `message Telemetry {
  sample_id: uint32 little-endian
  temperature: float32 little-endian scale 0.1 unit "°C"
  voltage: uint16 little-endian scale 0.001 unit "V"
  flags: uint8
}
framing: fixed-size`,
  },
];

const elements = {
  preset: document.querySelector("#preset-select"),
  editor: document.querySelector("#layout-editor"),
  layoutStatus: document.querySelector("#layout-status"),
  dropZone: document.querySelector("#drop-zone"),
  fileInput: document.querySelector("#file-input"),
  fileSummary: document.querySelector("#file-summary"),
  loadExample: document.querySelector("#load-example"),
  emptyState: document.querySelector("#empty-state"),
  loadingState: document.querySelector("#loading-state"),
  progressLabel: document.querySelector("#progress-label"),
  outputState: document.querySelector("#output-state"),
  resultSubtitle: document.querySelector("#result-subtitle"),
  packetCount: document.querySelector("#packet-count"),
  byteCount: document.querySelector("#byte-count"),
  issueCount: document.querySelector("#issue-count"),
  chartField: document.querySelector("#chart-field"),
  chartContainer: document.querySelector("#chart-container"),
  chartCaption: document.querySelector("#chart-caption"),
  tableCaption: document.querySelector("#table-caption"),
  tableScroll: document.querySelector("#table-scroll"),
  tableHead: document.querySelector("#table-head"),
  tableBody: document.querySelector("#table-body"),
  tableEmpty: document.querySelector("#table-empty"),
  errorList: document.querySelector("#error-list"),
  exportCsv: document.querySelector("#export-csv"),
  exportJson: document.querySelector("#export-json"),
  notice: document.querySelector("#notice"),
  structDialog: document.querySelector("#struct-dialog"),
  structInput: document.querySelector("#struct-input"),
  structError: document.querySelector("#struct-error"),
};

const state = {
  worker: null,
  fileName: "",
  result: null,
  fields: [],
  noticeTimer: null,
  layoutTimer: null,
};

for (const [index, preset] of PRESETS.entries()) {
  const option = document.createElement("option");
  option.value = String(index);
  option.textContent = preset.name;
  elements.preset.append(option);
}
elements.editor.value = SENSOR_LAYOUT;

elements.preset.addEventListener("change", () => {
  const preset = PRESETS[Number(elements.preset.value)];
  if (preset) {
    elements.editor.value = preset.layout;
    validateLayout();
  }
});

elements.editor.addEventListener("input", () => {
  window.clearTimeout(state.layoutTimer);
  state.layoutTimer = window.setTimeout(validateLayout, 180);
});

document.querySelector("#reset-layout").addEventListener("click", () => {
  const preset = PRESETS[Number(elements.preset.value)] ?? PRESETS[0];
  elements.editor.value = preset.layout;
  validateLayout();
});

elements.fileInput.addEventListener("change", () => {
  const [file] = elements.fileInput.files ?? [];
  if (file) decodeFile(file);
  elements.fileInput.value = "";
});

elements.dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    elements.fileInput.click();
  }
});
for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragover");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragover");
  });
}
elements.dropZone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer?.files ?? [];
  if (file) decodeFile(file);
});

elements.loadExample.addEventListener("click", () => {
  elements.preset.value = "0";
  elements.editor.value = SENSOR_LAYOUT;
  validateLayout();
  const buffer = createExampleCapture();
  decodeBuffer(buffer, "sensor-example.bin");
});

document.querySelector("#import-struct").addEventListener("click", () => {
  elements.structError.hidden = true;
  elements.structInput.value = "";
  elements.structDialog.showModal();
  elements.structInput.focus();
});
document.querySelector("#apply-struct").addEventListener("click", () => {
  try {
    elements.editor.value = importCStruct(elements.structInput.value);
    elements.structDialog.close();
    validateLayout();
    showNotice("C struct imported. Add framing, scaling, and checksums to match your protocol.");
  } catch (error) {
    elements.structError.textContent = error instanceof Error ? error.message : String(error);
    elements.structError.hidden = false;
  }
});

elements.chartField.addEventListener("change", renderChart);
elements.tableScroll.addEventListener("scroll", renderTable, { passive: true });
elements.exportCsv.addEventListener("click", () => exportResult("csv"));
elements.exportJson.addEventListener("click", () => exportResult("json"));

function validateLayout() {
  try {
    parseLayout(elements.editor.value);
    elements.layoutStatus.textContent = "Layout ready";
    elements.layoutStatus.classList.remove("error");
    return true;
  } catch (error) {
    elements.layoutStatus.textContent = error instanceof Error ? error.message : String(error);
    elements.layoutStatus.classList.add("error");
    return false;
  }
}

async function decodeFile(file) {
  if (file.size === 0) {
    showNotice("That file is empty. Choose a non-empty binary capture.");
    return;
  }
  if (file.size > 100 * 1024 * 1024) {
    showNotice("Files are limited to 100 MB in this preview.");
    return;
  }
  if (!validateLayout()) {
    showNotice("Fix the layout definition before decoding this capture.");
    return;
  }
  elements.fileSummary.hidden = false;
  elements.fileSummary.textContent = `${file.name} · ${formatBytes(file.size)}`;
  try {
    const buffer = await file.arrayBuffer();
    decodeBuffer(buffer, file.name);
  } catch (error) {
    showNotice(`Could not read the selected file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function decodeBuffer(buffer, name) {
  if (!validateLayout()) return;
  if (state.worker) state.worker.terminate();
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.fileName = name;
  state.result = null;
  state.fields = [];
  elements.emptyState.hidden = true;
  elements.outputState.hidden = true;
  elements.loadingState.hidden = false;
  elements.progressLabel.textContent = "Preparing your capture…";
  elements.notice.hidden = true;
  elements.fileSummary.hidden = false;
  elements.fileSummary.textContent = `${name} · ${formatBytes(buffer.byteLength)}`;
  elements.resultSubtitle.textContent = "Decoding locally in your browser";

  state.worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      elements.progressLabel.textContent = `Reading capture… ${Math.round(data.progress * 100)}%`;
      return;
    }
    elements.loadingState.hidden = true;
    state.worker?.terminate();
    state.worker = null;
    if (data.type === "error") {
      elements.emptyState.hidden = false;
      elements.emptyState.querySelector("h3").textContent = "This layout needs a fix.";
      elements.emptyState.querySelector("p").textContent = data.message;
      elements.resultSubtitle.textContent = "Could not decode this capture";
      return;
    }
    state.result = data.result;
    state.fields = data.result.fields;
    renderResult();
  };
  state.worker.onerror = (event) => {
    elements.loadingState.hidden = true;
    elements.emptyState.hidden = false;
    elements.emptyState.querySelector("h3").textContent = "The decoder stopped unexpectedly.";
    elements.emptyState.querySelector("p").textContent = event.message || "Try the capture again with a simpler layout.";
    state.worker?.terminate();
    state.worker = null;
  };
  state.worker.postMessage({ buffer, layout: elements.editor.value }, [buffer]);
}

function renderResult() {
  const result = state.result;
  elements.outputState.hidden = false;
  elements.emptyState.hidden = true;
  elements.resultSubtitle.textContent = state.fileName;
  elements.packetCount.textContent = result.recordCount.toLocaleString();
  elements.byteCount.textContent = formatBytes(result.byteLength);
  elements.issueCount.textContent = result.issueCount.toLocaleString();
  elements.tableCaption.textContent = result.truncatedRows
    ? `Showing ${result.rows.length.toLocaleString()} of ${result.recordCount.toLocaleString()} packets`
    : `${result.rows.length.toLocaleString()} packet${result.recordCount === 1 ? "" : "s"} decoded`;
  elements.exportCsv.disabled = result.rows.length === 0;
  elements.exportJson.disabled = result.rows.length === 0;
  elements.tableScroll.scrollTop = 0;

  const chartNames = Object.entries(result.chartSamples).filter(([, points]) => points.length > 0).map(([name]) => name);
  elements.chartField.replaceChildren();
  for (const name of chartNames) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    elements.chartField.append(option);
  }
  if (chartNames.length) {
    elements.chartField.value = chartNames.find((name) => state.fields.find((field) => field.name === name)?.kind === "float") ?? chartNames[0];
    elements.chartField.disabled = false;
  } else {
    elements.chartField.disabled = true;
  }

  renderTableHead();
  renderTable();
  renderChart();
  renderErrors();
  if (result.truncatedRows) {
    showNotice(`Large capture decoded. The table and exports include the first ${result.rows.length.toLocaleString()} packets; charts are sampled across the capture.`);
  } else if (result.issueCount) {
    showNotice(`${result.issueCount.toLocaleString()} issue${result.issueCount === 1 ? "" : "s"} found. See the packet diagnostics below the chart.`);
  } else {
    showNotice("Decoded entirely on your device. Your capture was not uploaded.");
  }
}

function renderTableHead() {
  const row = document.createElement("tr");
  for (const heading of ["PACKET", ...state.fields.map((field) => field.name)]) {
    const cell = document.createElement("th");
    cell.textContent = heading.replaceAll("_", " ").toUpperCase();
    row.append(cell);
  }
  elements.tableHead.replaceChildren(row);
}

function renderTable() {
  const result = state.result;
  if (!result) return;
  const rows = result.rows;
  const rowHeight = 32;
  const visibleCount = Math.ceil(elements.tableScroll.clientHeight / rowHeight) + 4;
  const start = Math.max(0, Math.floor(elements.tableScroll.scrollTop / rowHeight) - 2);
  const end = Math.min(rows.length, start + visibleCount);
  const fragment = document.createDocumentFragment();
  if (start > 0) fragment.append(makeSpacer(start * rowHeight, state.fields.length + 1));

  for (let index = start; index < end; index += 1) {
    const row = rows[index];
    const tr = document.createElement("tr");
    if (row.errors.length) tr.classList.add("has-error");
    const indexCell = document.createElement("td");
    indexCell.textContent = String(row.index).padStart(5, "0");
    tr.append(indexCell);
    for (const field of state.fields) {
      const cell = document.createElement("td");
      cell.textContent = formatValue(row.values[field.name], field.unit);
      if (row.errors.some((error) => error.startsWith(`${field.name}:`))) {
        cell.title = row.errors.find((error) => error.startsWith(`${field.name}:`));
      }
      tr.append(cell);
    }
    fragment.append(tr);
  }
  if (end < rows.length) fragment.append(makeSpacer((rows.length - end) * rowHeight, state.fields.length + 1));
  elements.tableBody.replaceChildren(fragment);
  elements.tableEmpty.hidden = rows.length > 0;
}

function makeSpacer(height, columnCount) {
  const row = document.createElement("tr");
  row.setAttribute("aria-hidden", "true");
  const cell = document.createElement("td");
  cell.colSpan = columnCount;
  cell.style.height = `${height}px`;
  cell.style.padding = "0";
  cell.style.border = "0";
  row.append(cell);
  return row;
}

function renderErrors() {
  elements.errorList.replaceChildren();
  const errors = state.result.errors;
  if (errors.length === 0) {
    elements.errorList.hidden = true;
    return;
  }
  for (const error of errors) {
    const item = document.createElement("div");
    item.className = "error-item";
    const label = document.createElement("strong");
    label.textContent = `Packet ${error.record} · byte ${error.offset}: `;
    item.append(label, document.createTextNode(error.message));
    elements.errorList.append(item);
  }
  if (state.result.issueCount > errors.length) {
    const more = document.createElement("div");
    more.className = "error-item";
    more.textContent = `${(state.result.issueCount - errors.length).toLocaleString()} more issue(s) omitted.`;
    elements.errorList.append(more);
  }
  elements.errorList.hidden = false;
}

function renderChart() {
  const fieldName = elements.chartField.value;
  const points = state.result?.chartSamples[fieldName] ?? [];
  const field = state.fields.find((candidate) => candidate.name === fieldName);
  elements.chartContainer.replaceChildren();
  if (!field || points.length === 0) {
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent = "No numeric fields to plot in this capture.";
    elements.chartContainer.append(empty);
    elements.chartCaption.textContent = "Numeric fields from your capture";
    return;
  }

  const width = Math.max(320, elements.chartContainer.clientWidth - 20);
  const height = 128;
  const pad = { top: 10, right: 12, bottom: 20, left: 43 };
  const values = points.map((point) => point.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${fieldName} values over packet number`);

  for (let tick = 0; tick < 4; tick += 1) {
    const ratio = tick / 3;
    const y = pad.top + ratio * (height - pad.top - pad.bottom);
    const value = max - ratio * range;
    const grid = svgElement("line", { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: "chart-grid" });
    const label = svgElement("text", { x: pad.left - 7, y: y + 3, "text-anchor": "end", class: "chart-label" });
    label.textContent = compactNumber(value);
    svg.append(grid, label);
  }

  const pointsText = points.map((point, index) => {
    const x = pad.left + index / Math.max(1, points.length - 1) * (width - pad.left - pad.right);
    const y = pad.top + (max - point.value) / range * (height - pad.top - pad.bottom);
    return `${x},${y}`;
  }).join(" ");
  svg.append(svgElement("polyline", { points: pointsText, class: "chart-line" }));
  for (const index of [0, points.length - 1]) {
    const point = points[index];
    const x = pad.left + index / Math.max(1, points.length - 1) * (width - pad.left - pad.right);
    const y = pad.top + (max - point.value) / range * (height - pad.top - pad.bottom);
    svg.append(svgElement("circle", { cx: x, cy: y, r: 2.5, class: "chart-point" }));
  }
  const axisLabel = svgElement("text", { x: pad.left, y: height - 3, class: "chart-label" });
  axisLabel.textContent = `Packet ${points[0].index}`;
  const axisEnd = svgElement("text", { x: width - pad.right, y: height - 3, "text-anchor": "end", class: "chart-label" });
  axisEnd.textContent = `Packet ${points.at(-1).index}`;
  svg.append(axisLabel, axisEnd);
  elements.chartContainer.append(svg);
  elements.chartCaption.textContent = `${fieldName}${field.unit ? ` · ${field.unit}` : ""} · ${points.length} sampled points`;
}

function svgElement(name, attributes) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function exportResult(format) {
  if (!state.result || state.result.rows.length === 0) return;
  const headers = ["packet", ...state.fields.map((field) => field.name)];
  let content;
  let mimeType;
  let extension;
  if (format === "csv") {
    const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    content = [headers.map(escapeCsv).join(",")];
    for (const row of state.result.rows) {
      content.push([row.index, ...state.fields.map((field) => row.values[field.name])].map(escapeCsv).join(","));
    }
    content = content.join("\r\n");
    mimeType = "text/csv;charset=utf-8";
    extension = "csv";
  } else {
    const packets = state.result.rows.map((row) => ({ packet: row.index, fields: row.values }));
    content = JSON.stringify(packets, null, 2);
    mimeType = "application/json";
    extension = "json";
  }
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.fileName.replace(/\.[^.]*$/, "") || "binarylens"}-decoded.${extension}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createExampleCapture() {
  const packets = [
    [1, 22.8, 0],
    [2, 23.1, 1],
    [3, 23.7, 0],
    [4, 24.2, 4],
    [5, 24.0, 0],
    [6, 23.6, 2],
    [7, 23.3, 0],
    [8, 23.9, 0],
    [9, 24.4, 1],
    [10, 24.1, 0],
    [11, 23.8, 0],
    [12, 24.6, 4],
    [13, 25.0, 0],
    [14, 24.7, 0],
    [15, 24.4, 2],
    [16, 24.9, 0],
  ];
  const packetSize = 9;
  const buffer = new ArrayBuffer(packets.length * packetSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  packets.forEach(([sequence, temperature, flags], index) => {
    const offset = index * packetSize;
    bytes[offset] = 0xa5;
    bytes[offset + 1] = sequence;
    view.setFloat32(offset + 2, temperature, true);
    bytes[offset + 6] = flags;
    view.setUint16(offset + 7, crc16Ccitt(bytes.subarray(offset, offset + 7)), false);
  });
  return buffer;
}

function crc16Ccitt(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
  }
  return crc & 0xffff;
}

function formatValue(value, unit) {
  if (Array.isArray(value)) return value.join(", ");
  if (value === undefined || value === null) return "—";
  return `${String(value)}${unit ? ` ${unit}` : ""}`;
}

function formatBytes(length) {
  if (length < 1024) return `${length} B`;
  if (length < 1024 * 1024) return `${(length / 1024).toFixed(1)} KB`;
  return `${(length / (1024 * 1024)).toFixed(1)} MB`;
}

function compactNumber(value) {
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return Number(value.toPrecision(3)).toString();
}

function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.hidden = false;
  window.clearTimeout(state.noticeTimer);
  state.noticeTimer = window.setTimeout(() => { elements.notice.hidden = true; }, 7000);
}

validateLayout();
