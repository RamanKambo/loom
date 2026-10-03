-- Representative rows in the contract version 1 shape: a zero amount, a typical amount and the largest decimal(12,2) value.
INSERT INTO [invoicing].[invoices] ([id], [customer_id], [amount], [status]) VALUES
  (N'9b2f6c1e-0d3a-4c7e-9a51-2f4d8b6e1a01', N'cust-0001', 120.00, N'issued'),
  (N'3c8e1f2a-7b4d-4e9f-8a26-5d1c9e7b3f02', N'cust-0002', 0.00, N'draft'),
  (N'7d4a9b3c-2e5f-4a8b-9c17-6e2f1a8d4c03', N'cust-0001', 9999999999.99, N'settled');
