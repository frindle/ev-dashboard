import net from 'node:net';
import { readConfig } from './config';
import { readSolarWebLive } from './solaredge-web';

// Minimal Modbus/TCP client + SunSpec model 103 (single-phase inverter)
// parser for SolarEdge HD-Wave inverters. We poll only what we need to
// render on the dashboard (live AC power, today's & lifetime energy,
// status). No external dependencies — the protocol is small enough that
// a single 80-line module is clearer than wrestling a library.
//
// SolarEdge specifics worth knowing:
// - Default port is 1502, not the Modbus standard 502.
// - Only ONE Modbus/TCP client can be connected at a time. If anything
//   else on the LAN (Home Assistant, an Energy Manager) is polling the
//   inverter, our reads will time out or get refused.
// - After enabling Modbus on the inverter, the first connection must
//   arrive within ~2 minutes or the port closes. Subsequent connects
//   are fine once it's been opened once.
// - SunSpec model 103 starts at register 40069 (address 40068 in the
//   Modbus wire protocol — SunSpec docs use 1-based, Modbus is 0-based).

export interface SolarLive {
  enabled: boolean;       // false when config.solar.enabled is off, or host blank
  reachable: boolean;     // true on successful read in the last poll
  acPowerW: number;       // instantaneous AC output (W)
  dcPowerW: number;       // instantaneous DC input (W)
  dailyKwh: number;       // accumulated today (kWh)
  lifetimeKwh: number;    // total since install (kWh)
  operatingState: number; // 1=off 2=sleeping 3=starting 4=mppt 5=throttled 6=shutting down 7=fault 8=standby
  statusCode: number;     // vendor-specific status
  fetchedAt: string;      // ISO timestamp
  errorMessage?: string;
  approximate?: boolean;  // true when sourced from the web-login fallback (~15min-delayed avg, not live)
}

const FC_READ_HOLDING = 0x03;
const SUNSPEC_BASE = 40069;  // SunSpec address of inverter block start
const BLOCK_LEN = 50;        // registers to read in one shot (covers all live fields)

// Simple in-process cache so multiple dashboard polls within pollIntervalSec
// share a single Modbus read. The inverter only allows one client at a time
// and back-to-back reads from one client work but waste connections.
let cached: { value: SolarLive; at: number } | null = null;

export async function readSolarLive(): Promise<SolarLive> {
  const cfg = readConfig().solar;
  const disabled: SolarLive = {
    enabled: false, reachable: false,
    acPowerW: 0, dcPowerW: 0, dailyKwh: 0, lifetimeKwh: 0,
    operatingState: 0, statusCode: 0, fetchedAt: new Date().toISOString(),
  };
  const useModbus = cfg.enabled && !!cfg.host;
  const useWeb = cfg.enabled && !cfg.host && !!cfg.siteId && !!cfg.username && !!cfg.password;
  if (!useModbus && !useWeb) return disabled;

  const ttlMs = Math.max(1, cfg.pollIntervalSec) * 1000;
  if (cached && Date.now() - cached.at < ttlMs) return cached.value;

  if (useWeb) {
    try {
      const web = await readSolarWebLive();
      const live: SolarLive = {
        enabled: true, reachable: true,
        acPowerW: web.acPowerW, dcPowerW: 0, dailyKwh: web.dailyKwh, lifetimeKwh: 0,
        operatingState: 4, statusCode: 0, fetchedAt: web.fetchedAt, approximate: true,
      };
      cached = { value: live, at: Date.now() };
      return live;
    } catch (e) {
      const errored: SolarLive = {
        ...disabled, enabled: true,
        errorMessage: e instanceof Error ? e.message : String(e),
      };
      cached = { value: errored, at: Date.now() };
      return errored;
    }
  }

  try {
    const registers = await readRegisters(cfg.host, cfg.port, cfg.unitId, SUNSPEC_BASE - 1, BLOCK_LEN);
    const live = parseSunspecModel103(registers);
    cached = { value: live, at: Date.now() };
    return live;
  } catch (e) {
    const errored: SolarLive = {
      ...disabled, enabled: true,
      errorMessage: e instanceof Error ? e.message : String(e),
    };
    cached = { value: errored, at: Date.now() };
    return errored;
  }
}

// ── Modbus/TCP wire protocol (FC03 read holding registers) ──────────────

function readRegisters(host: string, port: number, unitId: number, address: number, quantity: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const txId = Math.floor(Math.random() * 0xffff);
    let buf = Buffer.alloc(0);

    const cleanup = () => { socket.removeAllListeners(); socket.destroy(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('modbus read timeout')); }, 5000);

    socket.once('error', e => { clearTimeout(timer); cleanup(); reject(e); });
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      // Modbus/TCP response header is 9 bytes (MBAP + unit + fc + bytecount),
      // followed by N*2 bytes of register data.
      if (buf.length < 9) return;
      const respTxId = buf.readUInt16BE(0);
      const length = buf.readUInt16BE(4); // bytes following the length field
      if (buf.length < 6 + length) return;
      if (respTxId !== txId) { clearTimeout(timer); cleanup(); reject(new Error('modbus tx id mismatch')); return; }
      const fc = buf.readUInt8(7);
      if (fc & 0x80) {
        const exception = buf.readUInt8(8);
        clearTimeout(timer); cleanup();
        reject(new Error(`modbus exception ${exception} for fc ${fc & 0x7f}`));
        return;
      }
      const byteCount = buf.readUInt8(8);
      const regs: number[] = [];
      for (let i = 0; i < byteCount; i += 2) {
        regs.push(buf.readUInt16BE(9 + i));
      }
      clearTimeout(timer); cleanup();
      resolve(regs);
    });

    socket.connect(port, host, () => {
      const req = Buffer.alloc(12);
      req.writeUInt16BE(txId, 0);
      req.writeUInt16BE(0, 2);          // protocol id
      req.writeUInt16BE(6, 4);          // length of remaining bytes
      req.writeUInt8(unitId, 6);
      req.writeUInt8(FC_READ_HOLDING, 7);
      req.writeUInt16BE(address, 8);
      req.writeUInt16BE(quantity, 10);
      socket.write(req);
    });
  });
}

// ── SunSpec inverter model 103 (single-phase) parser ────────────────────
// Register offsets are SunSpec 1-based; we receive a 0-based array starting
// at SUNSPEC_BASE (40069). So register 40069 is regs[0], 40083 is regs[14].

function parseSunspecModel103(r: number[]): SolarLive {
  const u16 = (offset: number) => r[offset] ?? 0;
  const s16 = (offset: number) => {
    const v = u16(offset);
    return v > 0x7fff ? v - 0x10000 : v;
  };
  const u32 = (offset: number) => ((r[offset] ?? 0) << 16) | (r[offset + 1] ?? 0);

  // Scale factor is signed int16 — e.g. SF=-1 means value × 10^-1.
  const scale = (raw: number, sf: number) => raw * Math.pow(10, sf);

  // Offsets relative to SUNSPEC_BASE (register 40069):
  //   40083 AC current -> r[14],   40084 SF -> r[15]
  //   40092 AC power   -> r[23],   40093 SF -> r[24]
  //   40100 Wh hi      -> r[31],   40101 Wh lo -> r[32], 40102 SF -> r[33]
  //   40107 DC power   -> r[38],   40108 SF -> r[39]
  //   40111 op state   -> r[42]
  //   40117 status     -> r[48]
  const acPowerW  = scale(s16(23), s16(24));
  const dcPowerW  = scale(s16(38), s16(39));
  const lifetimeWh = scale(u32(31), s16(33));
  const operatingState = u16(42);
  const statusCode = u16(48);

  return {
    enabled: true,
    reachable: true,
    acPowerW: Math.round(acPowerW),
    dcPowerW: Math.round(dcPowerW),
    // Daily kWh is not a direct register — we derive it from the lifetime
    // counter elsewhere (snapshot at midnight, subtract). For now we
    // return 0 until the daily-rollup snapshot lands. lifetime is exact.
    dailyKwh: 0,
    lifetimeKwh: Math.round(lifetimeWh / 1000),
    operatingState,
    statusCode,
    fetchedAt: new Date().toISOString(),
  };
}
