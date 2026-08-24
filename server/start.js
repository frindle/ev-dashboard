// Container entrypoint: launches Next.js (dashboard), the Tesla Fleet Telemetry
// receiver, and Tesla's vehicle-command HTTP proxy in the same process tree.
// If any of them crashes we exit non-zero so Docker restarts the container.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KEYS_DIR = process.env.KEYS_DIR || '/app/keys';
const PROXY_PORT = process.env.PROXY_PORT || '4443';

const children = [];

// Persistent logs (survives container recreation, unlike `docker logs` --
// confirmed 2026-08-08: a real 3-day telemetry outage was undiagnosable
// after the fact because every redeploy since then recreated the
// container, and `docker logs` only ever has history back to the LAST
// container start, not the image/volume's actual lifetime). Written to
// the keys volume, one file per day, 7-day retention.
const LOG_DIR = path.join(KEYS_DIR, 'logs');
const LOG_RETENTION_DAYS = 7;
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* non-fatal */ }

function todayLogPath() {
  return path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
}

function pruneOldLogs() {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let files;
  try { files = fs.readdirSync(LOG_DIR); } catch { return; }
  for (const f of files) {
    const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
    if (!m) continue;
    if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) {
      try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch { /* non-fatal */ }
    }
  }
}
pruneOldLogs();
// Re-check daily rather than only at container start -- a long-lived
// container (no redeploys for a while) should still roll old files off.
setInterval(pruneOldLogs, 24 * 60 * 60 * 1000);

function persistLine(name, chunk) {
  // Recomputes todayLogPath() per write (not cached) so writes naturally
  // roll onto the next day's file at midnight with no explicit stream
  // handling. Log volume here is low (a handful of processes on a home
  // dashboard, not a firehose) so the extra path computation per line is
  // not worth optimizing away.
  fs.appendFile(todayLogPath(), chunk.toString().split('\n')
    .filter(Boolean)
    .map(line => `${new Date().toISOString()} [${name}] ${line}\n`)
    .join(''), () => { /* best-effort, never block on log-write failure */ });
}

function launch(name, command, args, opts = {}) {
  const critical = opts.critical !== false; // default: process death = container death
  delete opts.critical;
  console.log(`[supervisor] starting ${name}: ${command} ${args.join(' ')}`);
  // 'pipe' (not 'inherit') so output can be duplicated to both the
  // container's stdout (docker logs, unchanged behavior) and the
  // persistent log file above.
  const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  proc.stdout.on('data', (chunk) => { process.stdout.write(chunk); persistLine(name, chunk); });
  proc.stderr.on('data', (chunk) => { process.stderr.write(chunk); persistLine(name, chunk); });
  proc.on('exit', (code, signal) => {
    console.error(`[supervisor] ${name} exited (code=${code} signal=${signal})`);
    if (critical) {
      children.forEach(c => { if (c !== proc) c.kill('SIGTERM'); });
      process.exit(code === 0 ? 1 : (code ?? 1));
    } else {
      console.warn(`[supervisor] ${name} is non-critical, not restarting container`);
    }
  });
  children.push(proc);
  return proc;
}

// 1. Next.js standalone server
launch('nextjs', 'node', ['server.js']);

// 2. Telemetry receiver
launch('telemetry', 'node', [path.join(__dirname, 'telemetry-server.js')]);

// 2b. Rivian Parallax monitor -- separate websocket service, only place
// live Rivian charging power/current exists (vehicleState has none).
// Non-critical: no rivian-tokens.json yet (fresh install, not logged in)
// shouldn't crash-loop the whole container; it self-retries once tokens
// appear (see parallax-monitor.js).
launch('parallax', 'node', [path.join(__dirname, 'parallax-monitor.js')], { critical: false });

// 2c. Rivian vehicleState push monitor -- persistent graphql-ws subscription
// that replaces the *latency* of the REST poll (the poll itself stays as the
// fallback, see getRivianVehicleState() in lib/rivian.ts). Non-critical for
// the same reason as parallax: no tokens yet must not crash-loop the
// container, and if this dies the dashboard degrades to polling rather than
// going dark.
launch('rivian-ws', 'node', [path.join(__dirname, 'rivian-state-monitor.js')], { critical: false });

// 3. Tesla vehicle-command HTTP proxy — only if the partner private key exists.
//    If not, skip silently so the container can still come up for non-Tesla
//    setup steps.
const partnerKey = path.join(KEYS_DIR, 'private-key.pem');
if (fs.existsSync(partnerKey)) {
  // Ensure the proxy has a self-signed TLS cert for itself
  spawnSync('sh', [path.join(__dirname, '..', 'scripts', 'ensure-proxy-cert.sh')], {
    stdio: 'inherit',
    env: process.env,
  });
  launch('tesla-proxy', 'tesla-http-proxy', [
    '-tls-key', path.join(KEYS_DIR, 'proxy-server.key'),
    '-cert', path.join(KEYS_DIR, 'proxy-server.crt'),
    '-key-file', partnerKey,
    '-port', PROXY_PORT,
    '-host', '127.0.0.1',
    '-verbose',
  ], { critical: false });
} else {
  console.warn(`[supervisor] ${partnerKey} not found; skipping tesla-http-proxy`);
}

const forward = (sig) => () => {
  console.log(`[supervisor] received ${sig}, forwarding to children`);
  children.forEach(c => c.kill(sig));
};
process.on('SIGTERM', forward('SIGTERM'));
process.on('SIGINT', forward('SIGINT'));
