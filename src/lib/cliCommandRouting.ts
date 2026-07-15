export const isPaperPortfolioReviewCommand = (
  command: string | undefined,
  action?: string,
  subaction?: string
): boolean =>
  command === "paper:portfolio:review" ||
  (command === "paper" && action === "portfolio" && subaction === "review");

export const isPaperExitReviewCommand = (
  command: string | undefined,
  action?: string
): boolean =>
  command === "paper:exit:review" || (command === "paper" && action === "exit-review");
