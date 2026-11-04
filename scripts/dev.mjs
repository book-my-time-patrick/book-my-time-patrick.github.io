import { spawn } from 'node:child_process';

const useProcessGroups = process.platform !== 'win32';
const children = ['dev:api', 'dev:web'].map((script) =>
  spawn('npm', ['run', script], { stdio: 'inherit', detached: useProcessGroups }),
);
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!useProcessGroups || !child.pid) {
      child.kill('SIGTERM');
      continue;
    }
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') console.error('开发服务结束失败', error.message);
    }
  }
  process.exitCode = code;
}

for (const child of children) {
  child.on('exit', (code) => stop(code ?? 1));
  child.on('error', () => stop(1));
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
