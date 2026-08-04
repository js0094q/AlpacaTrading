import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyManagedOptionLane,
  newYorkTradingDate,
  optionCalendarDte,
  resolveManagedLeapsMinDte
} from "../src/services/optionLanePolicy.js";

test("preserves explicit trading dates and rejects impossible calendar dates", () => {
  assert.equal(newYorkTradingDate("2026-07-24"), "2026-07-24");
  assert.equal(optionCalendarDte("2026-07-24", "2026-07-24"), 0);
  assert.throws(() => optionCalendarDte("2026-02-30", "2026-02-28"), /INVALID_OPTION_DATE/);
  assert.throws(() => optionCalendarDte("2025-02-29", "2025-02-28"), /INVALID_OPTION_DATE/);
  assert.throws(
    () => newYorkTradingDate("2026-02-30T12:00:00.000Z"),
    /INVALID_OPTION_DATE/
  );
  assert.throws(
    () => newYorkTradingDate("2025-02-29T12:00:00.000-05:00"),
    /INVALID_OPTION_DATE/
  );
  assert.equal(optionCalendarDte("2028-02-29", "2028-02-28"), 1);
});

test("uses New York calendar boundaries across DST and UTC midnight", () => {
  assert.equal(newYorkTradingDate("2026-03-08T04:30:00.000Z"), "2026-03-07");
  assert.equal(newYorkTradingDate("2026-03-08T07:30:00.000Z"), "2026-03-08");
  assert.equal(newYorkTradingDate("2026-11-01T05:30:00.000Z"), "2026-11-01");
  assert.equal(newYorkTradingDate("2026-07-25T01:00:00.000Z"), "2026-07-24");
});

test("applies one managed LEAPS threshold to default and configured boundaries", () => {
  assert.equal(resolveManagedLeapsMinDte(undefined), 270);
  assert.equal(resolveManagedLeapsMinDte("365"), 365);
  assert.equal(
    classifyManagedOptionLane({ expirationDate: "2026-09-27", observedAt: "2026-01-01" }),
    "options_standard"
  );
  assert.equal(
    classifyManagedOptionLane({ expirationDate: "2026-09-28", observedAt: "2026-01-01" }),
    "options_leaps"
  );
  assert.equal(
    classifyManagedOptionLane({
      expirationDate: "2027-01-01",
      observedAt: "2026-01-01",
      managedLeapsMinDte: resolveManagedLeapsMinDte("365")
    }),
    "options_leaps"
  );
  assert.equal(
    classifyManagedOptionLane({
      expirationDate: "2026-12-31",
      observedAt: "2026-01-01",
      managedLeapsMinDte: resolveManagedLeapsMinDte("365")
    }),
    "options_standard"
  );
});
