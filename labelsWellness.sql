WITH loan_summaries AS (
  SELECT
      t.loan_id,
      l.user_id,
      l.status AS loan_status,
      l.created_at,
      l.updated_at AS closed_at,
      SUM(CASE
            WHEN t.status = 'POSTED' AND t.transaction_direction = 'CREDIT'
            THEN t.transaction_amount + COALESCE(t.advance_fee, 0) + COALESCE(t.transfer_fee, 0)
            ELSE 0
          END) AS total_credit,
      SUM(CASE
            WHEN t.status = 'POSTED' AND t.transaction_direction = 'DEBIT'
            THEN t.transaction_amount
            ELSE 0
          END) AS total_debit
  FROM transactions t
  JOIN loans l ON l.id = t.loan_id
  WHERE l.status = 'CLOSED'
  GROUP BY t.loan_id, l.user_id, l.status, l.created_at, l.updated_at
)
SELECT
    user_id,
    loan_id,
    loan_status,
    created_at,
    closed_at,
    total_credit,
    total_debit,
    total_credit - total_debit AS balance_difference
FROM loan_summaries
WHERE total_credit != total_debit
ORDER BY closed_at DESC;
