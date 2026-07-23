import { config } from "../config.js";
import {
  selectExpressionWithPolicy,
  type StrategySelectionInput
} from "./strategySelectionLogic.js";

export const selectExpression = (input: StrategySelectionInput) =>
  selectExpressionWithPolicy(input, config.enableAggressivePaperStrategies);
