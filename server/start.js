// Container entrypoint: launches both Next.js (the dashboard) and the
// Tesla Fleet Telemetry receiver in the same process tree. If either
// crashes we exit non-zero so Docker restarts the container.
const { spawn } = require('child_process');
const path = require('path');

const children = [];

function launch(name, command, args, opts = {}) {
  const proc = spawn(command, args, { stdio: 'inherit', ...opts });
  proc.on('exit', (code, signal) => {
    console.error(`[supervisor] ${name} exited (code=${code} signal=${signal})`);
    children.forEach(c => { if (c !== proc) c.kill('SIGTERM'); });
    process.exit(code === 0 ? 1 : (code ?? 1));
  });
  children.push(proc);
  return proc;
}

// Next.js standalone server
launch('nextjs', 'node', ['server.js']);

// Telemetry receiver
launch('telemetry', 'node', [path.join(__dirname, 'telemetry-server.js')]);

const forward = (sig) => () => {
  console.log(`[supervisor] received ${sig}, forwarding to children`);
  children.forEach(c => c.kill(sig));
};
process.on('SIGTERM', forward('SIGTERM'));
process.on('SIGINT', forward('SIGINT'));
