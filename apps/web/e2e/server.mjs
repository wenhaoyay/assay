// Start Assay for the E2E suite on a fresh, seeded database (never the dev database).
import { spawn, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const win = process.platform === 'win32'
const py = process.env.ASSAY_PYTHON ?? resolve(root, win ? '.venv/Scripts/python.exe' : '.venv/bin/python')
const db = resolve(root, 'data/e2e.db')
for (const suffix of ['', '-wal', '-shm']) rmSync(db + suffix, { force: true })
const env = { ...process.env, DATABASE_URL: `sqlite:///${db.split('\\').join('/')}` }
const seed = spawnSync(py, ['-m', 'assay.cli', 'seed', '--run', '--trials', '2'], { cwd: root, env, stdio: 'inherit' })
if (seed.status !== 0) process.exit(seed.status ?? 1)
spawn(py, ['-m', 'assay.cli', 'serve', '--port', '8041'], { cwd: root, env, stdio: 'inherit' })
