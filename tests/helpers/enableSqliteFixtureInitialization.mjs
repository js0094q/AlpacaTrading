if (process.env.NODE_TEST_CONTEXT && !process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}

Object.defineProperty(
  globalThis,
  Symbol.for("alpaca.sqlite.test-fixture-initialization"),
  {
    configurable: true,
    value: true,
    writable: true
  }
);
