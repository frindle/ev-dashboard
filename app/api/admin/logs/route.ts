import { NextRequest } from 'next/server';
import { readRivianRaw, readTeslaRaw } from '@/lib/rawState';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';

// Serves all log files the app writes to the keys volume over HTTP.
//
// This endpoint exposes all logging that was previously only reachable by
// shelling into the container. It provides access to:
// - Raw provider payloads (rivian-state-debug.json, tesla-api-bodies.jsonl)
// - Current state files (rivian-push-state.json, rivian-parallax.json, tesla-state.json)  
// - Daily log files for both Rivian and Tesla telemetry
//
// Query params:
//   ?type=raw            raw provider payloads (default: all types)
//   ?type=current        current state files only 
//   ?type=daily          daily log files only
//   ?date=YYYY-MM-DD     specific date to filter daily logs (required for daily type)
//   ?start=HH:MM         start time for filtering daily logs (optional, requires date)
//   ?end=HH:MM           end time for filtering daily logs (optional, requires date)
//
// Read-only: serves files, issues no provider API calls, so hitting it cannot
// consume rate budget or perturb backoff state. Secrets are redacted by key
// name in lib/rawState.ts on the way out.
//
// NOTE: like every other route under /api/admin here, this has no auth of its own 
// and relies on the deployment being LAN-only. It exposes vehicle location.
// If this app is ever put behind a public ingress, this route needs a guard
// before that happens.

function keysDir(): string {
  return process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
}

async function readCurrentStateFiles() {
  const KEYS_DIR = keysDir();
  
  // Read current state files
  const rivianPushPath = join(KEYS_DIR, 'rivian-push-state.json');
  const parallaxPath = join(KEYS_DIR, 'rivian-parallax.json');
  const teslaStatePath = join(KEYS_DIR, 'tesla-state.json');
  
  const out: Record<string, unknown> = {};
  
  try {
    const rivianPushData = await readFile(rivianPushPath, 'utf-8');
    out.rivianPushState = JSON.parse(rivianPushData);
  } catch (e) {
    out.rivianPushState = { error: (e as Error).message };
  }
  
  try {
    const parallaxData = await readFile(parallaxPath, 'utf-8');
    out.parallaxState = JSON.parse(parallaxData);
  } catch (e) {
    out.parallaxState = { error: (e as Error).message };
  }
  
  try {
    const teslaStateData = await readFile(teslaStatePath, 'utf-8');
    out.teslaState = JSON.parse(teslaStateData);
  } catch (e) {
    out.teslaState = { error: (e as Error).message };
  }
  
  return out;
}

async function readDailyLogs(dateStr?: string, startTime?: string, endTime?: string) {
  const KEYS_DIR = keysDir();
  const pushLogPath = join(KEYS_DIR, 'push-log');
  const parallaxLogPath = join(KEYS_DIR, 'parallax-log');

  const out: Record<string, unknown> = {};
  
  // Read push logs
  try {
    await stat(pushLogPath);
    const files = await readdir(pushLogPath);
    
    if (dateStr) {
      const logFile = `${dateStr}.jsonl`;
      if (files.includes(logFile)) {
        const filePath = join(pushLogPath, logFile);
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim() !== '');
        
        let filteredLines = lines;
        // Apply time filtering if specified
        if (startTime || endTime) {
          filteredLines = lines.filter(line => {
            try {
              const entry = JSON.parse(line);
              const receivedAt = new Date(entry.receivedAt);
              
              if (startTime && receivedAt.getUTCHours() * 60 + receivedAt.getUTCMinutes() < parseTime(startTime)) return false;
              if (endTime && receivedAt.getUTCHours() * 60 + receivedAt.getUTCMinutes() > parseTime(endTime)) return false;
              
              return true;
            } catch {
              return true; // Keep lines that can't be parsed
            }
          });
        }
        
        out.pushLog = filteredLines.map(line => JSON.parse(line));
      }
    } else {
      // Return all push log files if no date specified
      const logFiles: Record<string, any[]> = {};
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          try {
            const filePath = join(pushLogPath, file);
            const content = await readFile(filePath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim() !== '');
            logFiles[file] = lines.map(line => JSON.parse(line));
          } catch (e) {
            logFiles[file] = [{ error: (e as Error).message }];
          }
        }
      }
      out.pushLogFiles = logFiles;
    }
  } catch (e) {
    out.pushLogError = (e as Error).message;
  }

  // Read parallax logs
  try {
    await stat(parallaxLogPath);
    const files = await readdir(parallaxLogPath);
    
    if (dateStr) {
      const logFile = `${dateStr}.jsonl`;
      if (files.includes(logFile)) {
        const filePath = join(parallaxLogPath, logFile);
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim() !== '');
        
        let filteredLines = lines;
        // Apply time filtering if specified
        if (startTime || endTime) {
          filteredLines = lines.filter(line => {
            try {
              const entry = JSON.parse(line);
              const receivedAt = new Date(entry.receivedAt);
              
              if (startTime && receivedAt.getUTCHours() * 60 + receivedAt.getUTCMinutes() < parseTime(startTime)) return false;
              if (endTime && receivedAt.getUTCHours() * 60 + receivedAt.getUTCMinutes() > parseTime(endTime)) return false;
              
              return true;
            } catch {
              return true; // Keep lines that can't be parsed
            }
          });
        }
        
        out.parallaxLog = filteredLines.map(line => JSON.parse(line));
      }
    } else {
      // Return all parallax log files if no date specified
      const logFiles: Record<string, any[]> = {};
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          try {
            const filePath = join(parallaxLogPath, file);
            const content = await readFile(filePath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim() !== '');
            logFiles[file] = lines.map(line => JSON.parse(line));
          } catch (e) {
            logFiles[file] = [{ error: (e as Error).message }];
          }
        }
      }
      out.parallaxLogFiles = logFiles;
    }
  } catch (e) {
    out.parallaxLogError = (e as Error).message;
  }

  return out;
}

function parseTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const type = (url.searchParams.get('type') ?? 'all').toLowerCase();
  const date = url.searchParams.get('date');
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');

  // Validate parameters
  if (type !== 'all' && type !== 'raw' && type !== 'current' && type !== 'daily') {
    return Response.json(
      { error: `unknown type '${type}'`, valid: ['all', 'raw', 'current', 'daily'] },
      { status: 400 },
    );
  }

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json(
      { error: `invalid date format '${date}'`, valid: 'YYYY-MM-DD' },
      { status: 400 },
    );
  }

  if ((start || end) && !date) {
    return Response.json(
      { error: 'date parameter required when using start/end time filters' },
      { status: 400 },
    );
  }

  if (start && !/^\d{2}:\d{2}$/.test(start)) {
    return Response.json(
      { error: `invalid start time format '${start}'`, valid: 'HH:MM' },
      { status: 400 },
    );
  }

  if (end && !/^\d{2}:\d{2}$/.test(end)) {
    return Response.json(
      { error: `invalid end time format '${end}'`, valid: 'HH:MM' },
      { status: 400 },
    );
  }

  const out: Record<string, unknown> = { ts: new Date().toISOString() };

  // Handle different types of logs
  if (type === 'raw' || type === 'all') {
    try {
      out.raw = await readRivianRaw();
      out.teslaBodies = await readTeslaRaw(50); // Default limit for API bodies
    } catch (e) {
      out.error = (e as Error).message;
    }
  }

  if (type === 'current' || type === 'all') {
    try {
      const currentState = await readCurrentStateFiles();
      Object.assign(out, currentState);
    } catch (e) {
      out.currentError = (e as Error).message;
    }
  }

  if (type === 'daily' || type === 'all') {
    try {
      const dailyLogs = await readDailyLogs(date ?? undefined, start ?? undefined, end ?? undefined);
      Object.assign(out, dailyLogs);
    } catch (e) {
      out.dailyError = (e as Error).message;
    }
  }

  return Response.json(out);
}