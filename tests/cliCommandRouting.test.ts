import assert from "node:assert/strict";
import test from "node:test";

import {
  isPaperExitReviewCommand,
  isPaperPortfolioReviewCommand
} from "../src/lib/cliCommandRouting.js";

test("paper:exit:review resolves only to the exit review workflow", () => {
  assert.equal(isPaperPortfolioReviewCommand("paper:exit:review"), false);
  assert.equal(isPaperExitReviewCommand("paper:exit:review"), true);
});

test("paper portfolio and nested aliases retain their existing routing", () => {
  assert.equal(isPaperPortfolioReviewCommand("paper:portfolio:review"), true);
  assert.equal(isPaperPortfolioReviewCommand("paper", "portfolio", "review"), true);
  assert.equal(isPaperExitReviewCommand("paper", "exit-review"), true);
});
