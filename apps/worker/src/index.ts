import dotenv from "dotenv";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDxClusterLine, type ParsedSpot } from "@radio-pilot/shared";
import { createClient } from "redis";
import { fetchDxHeatSpots } from "./sources/dxheat.js";
import { startSnapshotLoop } from "./snapshot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const telnetIac = 255;
const telnetDo = 253;
const telnetDont = 254;
const telnetWill = 251;
const telnetWont = 252;
const telnetSb = 250;
const telnetSe = 240;
type ByteChunk = Uint8Array<ArrayBufferLike>;

const dxHost = process.env.DX_CLUSTER_HOST ?? "ei7mre.ath.cx";
const dxPort = Number(process.env.DX_CLUSTER_PORT ?? 7300);
const dxCallsign = process.env.DX_CLUSTER_CALLSIGN ?? "EI5JEB";
const spotSource = process.env.SPOT_SOURCE ?? "dxheat";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const logLevel = process.env.LOG_LEVEL ?? "info";
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
const dedupeWindowMs = 15 * 60 * 1000;
const recentSpotRetentionMs = 60 * 60 * 1000;
const reconnectBaseDelayMs = 1_000;
const reconnectMaxDelayMs = 30_000;

const redis = createClient({ url: redisUrl });
const recentTelnetSpotFingerprints = new Map<string, number>();

let reconnectDelayMs = reconnectBaseDelayMs;
let reconnectTimer: NodeJS.Timeout | undefined;

console.info("Connecting to Redis");
await redis.connect();
console.info("Redis connected");
startSnapshotLoop(redis);
console.info(`Starting spot worker with source ${spotSource}`);
startSpotSource();

function startSpotSource(): void {
  if (spotSource === "dxheat") {
    startDxHeatPolling();
    return;
  }

  if (spotSource !== "telnet") {
    throw new Error(`Unsupported SPOT_SOURCE: ${spotSource}`);
  }

  connectToDxCluster();
}

function connectToDxCluster(): void {
  const socket = createConnection({ host: dxHost, port: dxPort });
  let buffer = "";
  let closed = false;
  let loginSent = false;
  let telnetBuffer: ByteChunk = new Uint8Array(0);

  socket.on("connect", () => {
    reconnectDelayMs = reconnectBaseDelayMs;
    console.info(`DX cluster connected to ${dxHost}:${dxPort}`);
  });

  socket.on("data", (chunk: Buffer) => {
    const processed = processTelnetChunk(socket, chunk, telnetBuffer);
    telnetBuffer = processed.remaining;

    if (processed.text.length === 0) {
      return;
    }

    buffer += processed.text;
    maybeSendLogin(socket, buffer, loginSent, () => {
      loginSent = true;
    });

    while (true) {
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      void handleTelnetLine(line).catch((error: Error) => {
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
    console.warn(`DX cluster disconnected from ${dxHost}:${dxPort}`);
    scheduleReconnect();
  });
}

function processTelnetChunk(
  socket: ReturnType<typeof createConnection>,
  chunk: Buffer,
  carry: ByteChunk,
): { text: string; remaining: ByteChunk } {
  const input = carry.length > 0 ? Buffer.concat([Buffer.from(carry), chunk]) : chunk;
  const output: number[] = [];
  let index = 0;

  while (index < input.length) {
    const byte = input[index];

    if (byte !== telnetIac) {
      output.push(byte);
      index += 1;
      continue;
    }

    if (index + 1 >= input.length) {
      return {
        text: Buffer.from(output).toString("utf8"),
        remaining: input.subarray(index),
      };
    }

    const command = input[index + 1];

    if (command === telnetIac) {
      output.push(telnetIac);
      index += 2;
      continue;
    }

    if (command === telnetWill || command === telnetWont || command === telnetDo || command === telnetDont) {
      if (index + 2 >= input.length) {
        return {
          text: Buffer.from(output).toString("utf8"),
          remaining: input.subarray(index),
        };
      }

      const option = input[index + 2];
      respondToTelnetNegotiation(socket, command, option);
      index += 3;
      continue;
    }

    if (command === telnetSb) {
      let endIndex = index + 2;

      while (endIndex + 1 < input.length) {
        if (input[endIndex] === telnetIac && input[endIndex + 1] === telnetSe) {
          break;
        }

        endIndex += 1;
      }

      if (endIndex + 1 >= input.length) {
        return {
          text: Buffer.from(output).toString("utf8"),
          remaining: input.subarray(index),
        };
      }

      index = endIndex + 2;
      continue;
    }

    index += 2;
  }

  return {
    text: Buffer.from(output).toString("utf8"),
    remaining: Buffer.alloc(0),
  };
}

function respondToTelnetNegotiation(
  socket: ReturnType<typeof createConnection>,
  command: number,
  option: number,
): void {
  let responseCommand: number | undefined;

  if (command === telnetDo) {
    responseCommand = telnetWont;
  } else if (command === telnetWill) {
    responseCommand = telnetDont;
  }

  if (responseCommand === undefined) {
    return;
  }

  socket.write(Buffer.from([telnetIac, responseCommand, option]));
  debug(`DX cluster telnet negotiation ${command} ${option} -> ${responseCommand}`);
}

function maybeSendLogin(
  socket: ReturnType<typeof createConnection>,
  buffer: string,
  loginSent: boolean,
  markLoginSent: () => void,
): void {
  if (loginSent) {
    return;
  }

  const promptWindow = buffer.slice(-128);

  if (!/(?:^|[\r\n])\s*(?:login|call):\s*$/im.test(promptWindow)) {
    return;
  }

  socket.write(`${dxCallsign}\r\n`);
  markLoginSent();
  console.info(`DX cluster login sent as ${dxCallsign}`);
}

async function handleTelnetLine(line: string): Promise<void> {
  if (!line.startsWith("DX de")) {
    return;
  }

  const parsedSpot = parseDxClusterLine(line);

  if (!parsedSpot) {
    debug(`Failed to parse DX line: ${line}`);
    return;
  }

  await persistSpot(parsedSpot, line);
}

function startDxHeatPolling(): void {
  console.info(`DXHeat polling started with interval ${pollIntervalMs}ms`);
  void runDxHeatPollingLoop();
}

async function pollDxHeat(): Promise<void> {
  try {
    const parsedSpots = await fetchDxHeatSpots();

    if (parsedSpots.length === 0) {
      debug("DXHeat returned no parseable spots");
      return;
    }

    let processedCount = 0;

    for (const spot of parsedSpots) {
      try {
        const stored = await persistDxHeatSpot(spot);

        if (stored) {
          processedCount += 1;
        }
      } catch (error) {
        console.error("DXHeat spot processing failed", error);
      }
    }

    if (processedCount > 0) {
      await redis.set("freshness:dxcluster", String(Date.now()));
    }

    await pruneRecentSortedSpots();

    console.info(`DXHeat poll processed ${processedCount}/${parsedSpots.length} spots`);
  } catch (error) {
    console.error("DXHeat polling failed", error);
  }
}

async function runDxHeatPollingLoop(): Promise<void> {
  while (true) {
    await pollDxHeat();
    await delay(pollIntervalMs);
  }
}

async function persistSpot(parsedSpot: ParsedSpot, rawLine?: string): Promise<void> {
  const now = Date.now();
  const fingerprint = [
    parsedSpot.spotterCallsign,
    parsedSpot.spottedCallsign,
    parsedSpot.frequencyKHz.toFixed(1),
    parsedSpot.comment,
  ].join("|");

  pruneRecentSpots(now);

  if (recentTelnetSpotFingerprints.has(fingerprint)) {
    debug(`Skipping duplicate spot ${fingerprint}`);
    return;
  }

  recentTelnetSpotFingerprints.set(fingerprint, now);
  const payload = JSON.stringify({
    ...parsedSpot,
    receivedAt: new Date(now).toISOString(),
    rawLine,
  });

  await redis.zAdd("spots:recent", { score: now, value: payload });
  await pruneRecentSortedSpots();
  await redis.set("freshness:dxcluster", String(now));
}

function pruneRecentSpots(now: number): void {
  for (const [fingerprint, seenAt] of recentTelnetSpotFingerprints.entries()) {
    if (now - seenAt > dedupeWindowMs) {
      recentTelnetSpotFingerprints.delete(fingerprint);
    }
  }
}

async function persistDxHeatSpot(parsedSpot: ParsedSpot): Promise<boolean> {
  const observedAtMs = parsedSpot.observedAt ? Date.parse(parsedSpot.observedAt) : Number.NaN;

  if (!Number.isFinite(observedAtMs)) {
    console.error("DXHeat spot skipped: invalid observedAt", parsedSpot);
    return false;
  }

  const dedupeId = buildDxHeatDedupeId(parsedSpot);
  const dedupeKey = `dedupe:dxheat:${dedupeId}`;
  const deduped = await redis.set(dedupeKey, "1", {
    PX: dedupeWindowMs,
    NX: true,
  });

  if (deduped !== "OK") {
    debug(`Skipping duplicate DXHeat spot ${dedupeId}`);
    return false;
  }

  const payload = JSON.stringify({
    ...parsedSpot,
    receivedAt: new Date().toISOString(),
  });

  await redis.zAdd("spots:recent", { score: observedAtMs, value: payload });
  return true;
}

function buildDxHeatDedupeId(parsedSpot: ParsedSpot): string {
  if (parsedSpot.id.length > 0) {
    return parsedSpot.id;
  }

  return [
    parsedSpot.observedAt ?? "",
    parsedSpot.spotterCallsign,
    parsedSpot.spottedCallsign,
    parsedSpot.frequencyHz ?? Math.round(parsedSpot.frequencyKHz * 1000),
    parsedSpot.comment,
  ].join("|");
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    debug("DX cluster reconnect already scheduled");
    return;
  }

  const delayMs = reconnectDelayMs;

  console.warn(`DX cluster reconnect scheduled in ${delayMs}ms`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    console.info(`DX cluster reconnecting to ${dxHost}:${dxPort}`);
    connectToDxCluster();
  }, delayMs);

  reconnectDelayMs = Math.min(reconnectDelayMs * 2, reconnectMaxDelayMs);
}

async function pruneRecentSortedSpots(): Promise<void> {
  const cutoff = Date.now() - recentSpotRetentionMs;
  await redis.zRemRangeByScore("spots:recent", 0, cutoff);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function debug(message: string): void {
  if (logLevel === "debug") {
    console.debug(message);
  }
}
