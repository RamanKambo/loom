-- Authored migration of invoicing.invoices to contract version 2: adds the currency column and backfills it.
-- The backfill value comes from decision dec.currency-backfill.
SET XACT_ABORT ON;
BEGIN TRANSACTION;
ALTER TABLE [invoicing].[invoices] ADD [currency] NCHAR(3) NULL;
EXEC (N'UPDATE [invoicing].[invoices] SET [currency] = N''EUR'' WHERE [currency] IS NULL;');
EXEC (N'ALTER TABLE [invoicing].[invoices] ALTER COLUMN [currency] NCHAR(3) NOT NULL;');
COMMIT TRANSACTION;
