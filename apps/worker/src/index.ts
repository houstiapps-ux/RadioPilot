import { createConnection } from "node:net";

import { parseDxClusterLine } from "@radio-pilot/shared";
import { createClient } from "redis";
import { startSnapshotLoop } from "./snapshot.js";

const dxHost = process.env.DX_CLUSTER_HOST ?? "127.0.0.1";
const dxPort = Number(process.env.DX_CLUSTER_PORT ?? "7300");
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const logLevel = process.env.LOG_LEVEL ?? "info";
const reconnectBaseDelayMs = 1_000;
const reconnectMaxDelayMs = 30_000;

const redis = createClient({ url: redisUrl });

let reconnectDelayMs = reconnectBaseDelayMs;
let reconnectTimer: NodeJS.Timeout | undefined;

await redis.connect();
startSnapshotLoop(redis);
connectToDxCluster();

function connectToDxCluster(): void {
  const socket = createConnection({ host: dxHost, port: dxPort });
  let buffer = "";
  let closed = false;

  socket.setEncoding("utf8");

  socket.on("connect", () => {
    reconnectDelayMs = reconnectBaseDelayMs;
    console.info(`DX cluster connected at ${dxHost}:${dxPort}`);
  });

  socket.on("data", (chunk: string) => {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      void handleLine(line).catch((error: Error) => {
        console.error("Failed to handle DX line", error);
      });
    }
  });

  socket.on("error", (error: Error) => {
    console.error("DX cluster socket error", error);
  });

  socket.on("close", () => {
    if (closed) {
      return;
    }

    closed = true;
    scheduleReconnect();
  });
}

async function handleLine(line: string): Promise<void> {
  if (!line.startsWith("DX de")) {
    return;
  }

  const parsedSpot = parseDxClusterLine(line);

  if (!parsedSpot) {
    debug(`Failed to parse DX line: ${line}`);
    return;
  }

  const now = Date.now();
  const payload = JSON.stringify({
    ...parsedSpot,
    receivedAt: new Date(now).toISOString(),
    rawLine: line,
  });

  await redis.zAdd("spots:recent", { score: now, value: payload });
  await redis.set("freshness:dxcluster", String(now));
}

function scheduleReconnect(): void {
  const delayMs = reconnectDelayMs;

  console.warn(`DX cluster disconnected; reconnecting in ${delayMs}ms`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectToDxCluster();
  }, delayMs);

  reconnectDelayMs = Math.min(reconnectDelayMs * 2, reconnectMaxDelayMs);
}

function debug(message: string): void {
  if (logLevel === "debug") {
    console.debug(message);
  }
}
