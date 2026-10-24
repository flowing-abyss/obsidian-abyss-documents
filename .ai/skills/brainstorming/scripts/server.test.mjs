import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the companion uses an OS-assigned port and serves dollar sequences literally', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'brainstorm-literal-'));
  mkdirSync(path.join(root, 'content'));
  const fragment = '<h1>Price: $$; match: $&; before: $`; after: $\'; group: $1</h1>';
  writeFileSync(path.join(root, 'content', 'screen.html'), fragment);
  const child = spawn(process.execPath, [fileURLToPath(new URL('server.cjs', import.meta.url))], {
    env: {
      ...process.env,
      BRAINSTORM_DIR: root,
      BRAINSTORM_HOST: '127.0.0.1',
      BRAINSTORM_PORT: '0',
      BRAINSTORM_PORT_FILE: path.join(root, 'port'),
      BRAINSTORM_TOKEN_FILE: path.join(root, 'token'),
      BRAINSTORM_TOKEN: 'test-literal-token',
      BRAINSTORM_OWNER_PID: String(process.pid),
      BRAINSTORM_OPEN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('companion did not start')), 5000);
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`companion exited ${code}: ${stderr}`));
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n').find((item) => item.includes('"type":"server-started"'));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
  });
  assert.ok(info.port > 0, 'the startup metadata reports the actual bound TCP port');
  assert.equal(readFileSync(path.join(root, 'port'), 'utf8'), String(info.port));
  assert.equal(readFileSync(path.join(root, 'token'), 'utf8'), 'test-literal-token');
  const response = await fetch(`http://127.0.0.1:${info.port}/`, {
    headers: { Cookie: `brainstorm-key-${info.port}=test-literal-token` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes(fragment), 'the served HTML retains the complete fragment');
  assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//, 'the companion frame stays local');
});
