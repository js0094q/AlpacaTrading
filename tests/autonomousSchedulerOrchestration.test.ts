import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"

const readRepositoryFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8")

test("canonical installer owns every non-broker autonomous paper-ops timer", () => {
  const installer = readRepositoryFile("scripts/install-paper-monitoring-systemd.sh")
  const disabler = readRepositoryFile("scripts/disable-paper-monitoring-systemd.sh")

  for (const workflow of ["morning", "midday", "late-day"]) {
    assert.match(installer, new RegExp(`paper-ops-${workflow}\\.service`))
    assert.match(installer, new RegExp(`paper-ops-${workflow}\\.timer`))
    assert.match(disabler, new RegExp(`paper-ops-${workflow}\\.timer`))
  }
})

test("database-heavy paper-ops windows are staggered from observatory and recovery", () => {
  const observatoryTimer = readRepositoryFile("server/systemd/alpaca-market-observatory.timer")
  const recoveryTimer = readRepositoryFile("server/systemd/alpaca-autonomous-recovery.timer")
  const middayTimer = readRepositoryFile("server/systemd/paper-ops-midday.timer")
  const lateDayTimer = readRepositoryFile("server/systemd/paper-ops-late-day.timer")
  const middayService = readRepositoryFile("server/systemd/paper-ops-midday.service")
  const lateDayService = readRepositoryFile("server/systemd/paper-ops-late-day.service")

  assert.match(observatoryTimer, /OnCalendar=Mon\.\.Fri \*-\*-\* 09\.\.15:0\/15:00/)
  assert.match(recoveryTimer, /OnCalendar=\*-\*-\* \*:07\/15:30/)
  assert.match(middayTimer, /OnCalendar=Mon\.\.Fri \*-\*-\* 12:10:00/)
  assert.match(lateDayTimer, /OnCalendar=Mon\.\.Fri \*-\*-\* 15:25:00/)
  assert.doesNotMatch(middayTimer, /12:00:00/)
  assert.doesNotMatch(lateDayTimer, /15:15:00/)
  assert.match(
    middayService,
    /After=network-online\.target alpaca-market-observatory\.service alpaca-autonomous-recovery\.service/
  )
  assert.match(
    lateDayService,
    /After=network-online\.target alpaca-market-observatory\.service alpaca-autonomous-recovery\.service/
  )
  assert.match(middayService, /Environment=AUTOMATED_PAPER_EXECUTION_ENABLED=false/)
  assert.match(lateDayService, /Environment=AUTOMATED_PAPER_EXECUTION_ENABLED=false/)
})
