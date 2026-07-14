import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"

const readRepositoryFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8")

test("recovery service is paper-only, bounded, installed, and lifecycle-triggered", () => {
  const service = readRepositoryFile("server/systemd/alpaca-autonomous-recovery.service")
  const timer = readRepositoryFile("server/systemd/alpaca-autonomous-recovery.timer")
  const lifecycle = readRepositoryFile("server/systemd/alpaca-universe-lifecycle.service")
  const installer = readRepositoryFile("scripts/install-paper-monitoring-systemd.sh")
  const disabler = readRepositoryFile("scripts/disable-paper-monitoring-systemd.sh")

  assert.match(service, /Environment=ALPACA_ENV=paper/)
  assert.match(service, /Environment=ALPACA_LIVE_TRADE=false/)
  assert.match(service, /Environment=AUTOMATED_PAPER_EXECUTION_ENABLED=false/)
  assert.match(service, /ExecStart=\/usr\/bin\/npm run system:recover -- --format=json/)
  assert.match(service, /TimeoutStartSec=60/)
  assert.match(service, /TimeoutStopSec=30/)
  assert.match(service, /KillMode=control-group/)
  assert.match(timer, /OnCalendar=\*-\*-\* \*:07\/15:30/)
  assert.match(timer, /Persistent=true/)
  assert.match(lifecycle, /OnFailure=alpaca-autonomous-recovery\.service/)
  assert.match(installer, /alpaca-autonomous-recovery\.service/)
  assert.match(installer, /alpaca-autonomous-recovery\.timer/)
  assert.match(disabler, /alpaca-autonomous-recovery\.timer/)
})
