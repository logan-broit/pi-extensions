import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";

export interface CollectedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface OtlpValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values: OtlpValue[] };
}

export interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status?: { code?: number; message?: string };
}

export interface OtlpExport {
  resourceSpans: {
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: { scope: { name: string; version?: string }; spans: OtlpSpan[] }[];
  }[];
}

// This decoder is independent of the production OTel serializer and mapping constants.
// exporter-trace-otlp-http uses OTLP JSON, not OTLP protobuf.
export function decodeExport(request: CollectedRequest): OtlpExport {
  const body = request.headers["content-encoding"] === "gzip" ? gunzipSync(request.body) : request.body;
  return JSON.parse(body.toString("utf8")) as OtlpExport;
}

export async function startCollector(
  handler: (request: CollectedRequest, response: ServerResponse, index: number) => void = (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  },
) {
  const requests: CollectedRequest[] = [];
  const waiting = new Map<number, (request: CollectedRequest) => void>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const collected = { url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks) };
      const index = requests.push(collected) - 1;
      handler(collected, response, index);
      waiting.get(index)?.(collected);
      waiting.delete(index);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Collector did not bind TCP.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    next(index = 0): Promise<CollectedRequest> {
      const request = requests[index];
      return request ? Promise.resolve(request) : new Promise((resolve) => waiting.set(index, resolve));
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
