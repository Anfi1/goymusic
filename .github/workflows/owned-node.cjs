// The probe ignores its parent's pipes: EOF cannot make a broken ownership test pass.
const { spawn } = require('node:child_process');
const { existsSync, renameSync, writeFileSync } = require('node:fs');

if (process.argv[2] === 'branch') {
  spawn(process.execPath, [__filename], { stdio: 'ignore', windowsHide: true });
} else {
  writeFileSync(`${__filename}.tmp`, String(process.pid));
  renameSync(`${__filename}.tmp`, `${__filename}.ready`);
}
// Only test teardown removes this temporary copy, after recording any survivors.
const timer = setInterval(() => {
  if (!existsSync(__filename)) clearInterval(timer);
}, 500);
