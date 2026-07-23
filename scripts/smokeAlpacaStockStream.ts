import { config } from "../src/config.js";
import { AlpacaStockStreamService } from "../src/services/alpacaStockStream.js";

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const stream = new AlpacaStockStreamService({
  config: {
    ...config.alpaca.stockStream,
    enabled: true,
    symbols: ["AAPL"]
  },
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
});

const timeoutMs = 15_000;
const startedAt = Date.now();

try {
  await stream.start();

  while (Date.now() - startedAt < timeoutMs) {
    const status = stream.getStatus();
    const marketDataReceived = Boolean(
      stream.getLatestTrade("AAPL") ||
        stream.getLatestQuote("AAPL") ||
        stream.getLatestBar("AAPL")
    );
    if (status.authenticated && (status.subscribed || marketDataReceived)) {
      break;
    }
    await wait(100);
  }
} finally {
  const status = stream.getStatus();
  const marketDataReceived = Boolean(
    stream.getLatestTrade("AAPL") ||
      stream.getLatestQuote("AAPL") ||
      stream.getLatestBar("AAPL")
  );
  const controlResponseReceived = status.authenticated || status.subscribed;

  console.log(`Connected: ${status.connected ? "yes" : "no"}`);
  console.log(`Authenticated: ${status.authenticated ? "yes" : "no"}`);
  console.log(`Subscribed: ${status.subscribed ? "yes" : "no"}`);
  console.log(`Feed: ${status.feed}`);
  console.log("Symbol: AAPL");
  console.log(`Market data received: ${marketDataReceived ? "yes" : "no"}`);

  if (!controlResponseReceived && !marketDataReceived) {
    process.exitCode = 1;
  }

  await stream.stop();
}
