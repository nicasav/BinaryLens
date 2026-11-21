import { decodeBuffer, parseLayout } from "./decoder.js";

self.onmessage = ({ data }) => {
  try {
    const layout = parseLayout(data.layout);
    const result = decodeBuffer(data.buffer, layout, (progress) => {
      self.postMessage({ type: "progress", progress });
    });
    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
