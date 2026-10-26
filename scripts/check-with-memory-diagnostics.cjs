const { spawn, execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');

function snapshot() {
  console.log(`FSK_BUILD_MEMORY ${new Date().toISOString()}`);
  for (const path of [
    '/sys/fs/cgroup/memory.current',
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory.events',
    '/sys/fs/cgroup/memory/memory.usage_in_bytes',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ]) {
    if (existsSync(path)) console.log(path, readFileSync(path, 'utf8').trim());
  }
  if (process.platform === 'linux') {
    console.log(execFileSync('free', ['-m'], { encoding: 'utf8' }));
    console.log(execFileSync('df', ['-h', '/tmp'], { encoding: 'utf8' }));
    console.log(execFileSync('ps', ['-eo', 'pid,ppid,rss,comm', '--sort=-rss'], {
      encoding: 'utf8',
    }).split('\n').slice(0, 12).join('\n'));
  }
}

snapshot();
const monitor = setInterval(snapshot, 5000);
const check = spawn('pnpm', ['run', 'check:all'], { stdio: 'inherit' });
check.on('error', (error) => {
  clearInterval(monitor);
  console.error(error.message);
  process.exitCode = 1;
});
check.on('exit', (code, signal) => {
  clearInterval(monitor);
  snapshot();
  console.log('FSK_BUILD_CHECK_EXIT', { code, signal });
  process.exitCode = code ?? 1;
});
