-- Permit the canonical standard-option lane at the durable portfolio
-- arbitration audit boundary. The migration runner owns the transaction.
ALTER TABLE portfolio_arbitration_decisions
  DROP CONSTRAINT portfolio_arbitration_lane_valid;

ALTER TABLE portfolio_arbitration_decisions
  ADD CONSTRAINT portfolio_arbitration_lane_valid CHECK (
    lane IN ('equity', 'options_standard', 'options_0dte', 'options_leaps')
  );
