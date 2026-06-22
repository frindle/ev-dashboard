// Container entrypoint: launches Next.js (dashboard), the Tesla Fleet Telemetry
// receiver, and Tesla's vehicle-command HTTP proxy in the same process tree.
// If any of them crashes we exit non-zero so Docker restarts the container.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KEYS_DIR = process.env.KEYS_DIR || '/app/keys';
const PROXY_PORT = process.env.PROXY_PORT || '4443';

const children = [];

function launch(name, command, args, opts = {}) {
  const critical = opts.critical !== false; // default: process death = container death
  delete opts.critical;
  console.log(`[supervisor] starting ${name}: ${command} ${args.join(' ')}`);
  const proc = spawn(command, args, { stdio: 'inherit', ...opts });
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
