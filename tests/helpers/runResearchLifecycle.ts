const [mode, databasePath, nowIso, runId] = process.argv.slice(2);
if (!mode || !databasePath || !nowIso) {
  process.exit(2);
}

(globalThis as typeof globalThis & { [key: symbol]: unknown })[
  Symbol.for("alpaca.sqlite.test-fixture-initialization")
] = true;

process.env.RESEARCH_DB_PATH = databasePath;
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";

const [lifecycle, libDb] = await Promise.all([
  import("../../src/services/researchRunLifecycleService.js"),
  import("../../src/lib/db.js")
]);

try {
  if (mode === "recover") {
    const recovered = lifecycle.recoverStaleResearchRuns({
      now: new Date(nowIso),
      source: "concurrent_test"
    });
    process.stdout.write(JSON.stringify({ recovered: recovered.length }));
  } else if (mode === "reserve" && runId) {
    const reservation = lifecycle.reserveResearchRun({
      runId,
      now: new Date(nowIso),
      riskProfile: "moderate",
      optionsEnabled: false,
      configJson: "{}"
    });
    process.stdout.write(JSON.stringify(reservation));
  } else {
    process.exitCode = 2;
  }
} finally {
  libDb.closeDbForTests();
}
