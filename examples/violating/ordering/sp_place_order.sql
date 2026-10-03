-- Violating fixture for the sql.behavior check: breaks exactly one contract of routine
-- ordering.sp_place_order by returning status before order_id. The generated
-- contract-tests.sql must raise THROW 50005 ("first result set columns differ
-- from the contract (expected order_id, status in this order)"). Applied
-- against the projected schema.sql; Loom itself never executes it.
CREATE PROCEDURE [ordering].[sp_place_order]
    @p_total DECIMAL(12,2),
    @p_note NVARCHAR(280) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @order_id NVARCHAR(64) = CONVERT(NVARCHAR(64), NEWID());

    INSERT INTO [ordering].[orders] ([id], [status], [total], [note])
    OUTPUT inserted.[status] AS status, inserted.[id] AS order_id
    VALUES (@order_id, N'placed', @p_total, @p_note);
END
GO
