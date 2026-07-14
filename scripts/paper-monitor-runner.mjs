#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

const TASKS = {
  observatory: {
    command: ["npm", ["run", "observatory:collect"]],
    lockFile: "/tmp/alpaca-market-observatory.lock",
    requireExecution: false
  },
  review: {
    command: ["npm", ["run", "paper:ops:morning", "--", "--format=json"]],
    lockFile: "/tmp/alpaca-paper-monitor-review.lock",
    requireExecution: false
  },
  execute: {
    command: [
      "npm",
      [
        "run",
        "paper:execute:reviewed",
        "--",
        "--confirmPaper",
        "--sections=equityBuys,equityAdds,optionBuys",
        "--format=json"
      ]
    ],
    lockFile: "/tmp/alpaca-paper-monitor-execute.lock",
    requireExecution: true
  },
  "exit-review": {
    command: ["npm", ["run", "paper:ops:review", "--", "--format=json"]],
    finalHourCommand: ["npm", ["run", "paper:ops:late-day", "--", "--format=json"]],
    lockFile: "/tmp/alpaca-paper-monitor-exit-review.lock",
    requireExecution: false
  },
  "exit-execute": {
    command: [
      "npm",
      [
        "run",
        "paper:execute:reviewed",
        "--",
        "--confirmPaper",
        "--sections=equitySells,optionSellToCloseExits",
        "--format=json"
      ]
    ],
    lockFile: "/tmp/alpaca-paper-monitor-exit-execute.lock",
    requireExecution: true
  },
  "zero-dte-engine": {
    command: [
      "npm",
      ["run", "zero-dte:engine", "--", "--confirmPaper", "--format=json"]
    ],
    lockFile: "/tmp/alpaca-zero-dte-engine.lock",
    requireExecution: true
  },
  "zero-dte-exit-review": {
    command: ["npm", ["run", "zero-dte:exit:review", "--", "--format=json"]],
    lockFile: "/tmp/alpaca-zero-dte-exit-review.lock",
    requireExecution: false
  },
  "zero-dte-reconcile": {
    command: ["npm", ["run", "zero-dte:reconcile", "--", "--format=json"]],
    lockFile: "/tmp/alpaca-zero-dte-reconcile.lock",
    requireExecution: false
  },
  "zero-dte-eod": {
    command: ["npm", ["run", "zero-dte:eod", "--", "--format=json"]],
    lockFile: "/tmp/alpaca-zero-dte-eod.lock",
    requireExecution: false
  }
};

const argValue = (name) => {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
};

const hasFlag = (name) => process.argv.slice(2).includes(`--${name}`);
const jsonLine = (payload) => process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
const normalized = (value) => String(value || "").trim().toLowerCase();
const isTrue = (value) => ["true", "1"].includes(normalized(value));
const isFalse = (value) => ["false", "0"].includes(normalized(value));

const redactSecrets = (value) =>
  String(value)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
    .replace(/((?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|secret[_-]?key)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[REDACTED]");

const etParts = (date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second"))
  };
};

const dateKey = (year, month, day) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const utcDate = (year, month, day) => new Date(Date.UTC(year, month - 1, day));
const dayOfWeek = (year, month, day) => utcDate(year, month, day).getUTCDay();

const nthWeekday = (year, month, weekday, n) => {
  let day = 1;
  while (dayOfWeek(year, month, day) !== weekday) day += 1;
  return day + (n - 1) * 7;
};

const lastWeekday = (year, month, weekday) => {
  let day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  while (dayOfWeek(year, month, day) !== weekday) day -= 1;
  return day;
};

const observedFixedHoliday = (year, month, day) => {
  const date = utcDate(year, month, day);
  const weekday = date.getUTCDay();
  if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
};

const easterSunday = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
};

const goodFridayKey = (year) => {
  const date = easterSunday(year);
  date.setUTCDate(date.getUTCDate() - 2);
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
};

const marketHolidayKeys = (year) =>
  new Set([
    observedFixedHoliday(year, 1, 1),
    dateKey(year, 1, nthWeekday(year, 1, 1, 3)),
    dateKey(year, 2, nthWeekday(year, 2, 1, 3)),
    goodFridayKey(year),
    dateKey(year, 5, lastWeekday(year, 5, 1)),
    observedFixedHoliday(year, 6, 19),
    observedFixedHoliday(year, 7, 4),
    dateKey(year, 9, nthWeekday(year, 9, 1, 1)),
    dateKey(year, 11, nthWeekday(year, 11, 4, 4)),
    observedFixedHoliday(year, 12, 25)
  ]);

const marketWindowStatus = (date = new Date()) => {
  const parts = etParts(date);
  const key = dateKey(parts.year, parts.month, parts.day);
  const weekend = parts.weekday === "Sat" || parts.weekday === "Sun";
  const holiday = marketHolidayKeys(parts.year).has(key);
  const minutes = parts.hour * 60 + parts.minute;
  const open = !weekend && !holiday && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
  return {
    open,
    reason: open ? null : "MARKET_CLOSED",
    holiday,
    weekend,
    finalHour: open && minutes >= 15 * 60,
    nowEt: `${key} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`
  };
};

const guardFailures = (task) => {
  const failures = [];
  if (process.env.ALPACA_ENV !== "paper" || process.env.TRADING_MODE !== "paper") {
    failures.push("PAPER_RUNTIME_REQUIRED");
  }
  if (!isFalse(process.env.ALPACA_LIVE_TRADE) || !isFalse(process.env.LIVE_TRADING_ENABLED)) {
    failures.push("LIVE_TRADING_DISABLED_REQUIRED");
  }
  if (task.requireExecution) {
    if (
      !isTrue(process.env.PAPER_ORDER_EXECUTION_ENABLED) ||
      !isTrue(process.env.PAPER_OPTIONS_EXECUTION_ENABLED) ||
      !isTrue(process.env.AUTOMATED_PAPER_EXECUTION_ENABLED)
    ) {
      failures.push("PAPER_EXECUTION_FLAG_REQUIRED");
    }
    if (!task.command[1].includes("--confirmPaper")) {
      failures.push("PAPER_CONFIRMATION_REQUIRED");
    }
  }
  return [...new Set(failures)];
};

const acquireLock = (lockFile) => {
  try {
    mkdirSync(dirname(lockFile), { recursive: true });
    const fd = openSync(lockFile, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    return () => {
      try {
        unlinkSync(lockFile);
      } catch {
        // Best-effort cleanup after the guarded command exits.
      }
    };
  } catch {
    return null;
  }
};

const loadPackageScripts = () => {
  try {
    return Object.keys(JSON.parse(readFileSync("package.json", "utf8")).scripts || {});
  } catch {
    return [];
  }
};

const taskName = argValue("task") || process.argv.slice(2).find((item) => !item.startsWith("--")) || "";
const task = TASKS[taskName];
const now = new Date(argValue("now") || process.env.PAPER_MONITOR_NOW || Date.now());
const dryRun = hasFlag("dry-run") || process.env.PAPER_MONITOR_DRY_RUN === "true";

if (!task) {
  jsonLine({
    ok: false,
    status: "blocked",
    reason: "UNKNOWN_MONITOR_TASK",
    task: taskName || null,
    validTasks: Object.keys(TASKS)
  });
  process.exit(1);
}

const market = marketWindowStatus(now);
const selectedCommand = task.finalHourCommand && market.finalHour ? task.finalHourCommand : task.command;
const scriptName = selectedCommand[1][1];

if (!loadPackageScripts().includes(scriptName)) {
  jsonLine({
    ok: false,
    status: "blocked",
    reason: "MONITOR_COMMAND_MISSING",
    task: taskName,
    scriptName
  });
  process.exit(1);
}

if (!market.open) {
  jsonLine({
    ok: true,
    status: "no_op",
    reason: "MARKET_CLOSED",
    task: taskName,
    market
  });
  process.exit(0);
}

const failedChecks = guardFailures({ ...task, command: selectedCommand });
if (failedChecks.length) {
  jsonLine({
    ok: false,
    status: "blocked",
    reason: failedChecks[0],
    task: taskName,
    failedChecks
  });
  process.exit(1);
}

const releaseLock = acquireLock(task.lockFile);
if (!releaseLock) {
  jsonLine({
    ok: true,
    status: "no_op",
    reason: "LOCK_BUSY",
    task: taskName,
    lockFile: task.lockFile
  });
  process.exit(0);
}

const commandSummary = `${selectedCommand[0]} ${selectedCommand[1].join(" ")}`;
let exitCode = 0;

try {
  if (dryRun) {
    jsonLine({
      ok: true,
      status: "dry_run",
      reason: null,
      task: taskName,
      command: commandSummary,
      market
    });
  } else {
    const result = spawnSync(selectedCommand[0], selectedCommand[1], {
      env: process.env,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024
    });

    if (result.stdout) process.stdout.write(redactSecrets(result.stdout));
    if (result.stderr) process.stderr.write(redactSecrets(result.stderr));

    exitCode = result.status ?? (result.error ? 1 : 0);
  }
} finally {
  releaseLock();
}

process.exit(exitCode);
