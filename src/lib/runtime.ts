export const isVercelRuntime = (): boolean =>
  process.env.VERCEL === "1" || process.env.VERCEL === "true";
