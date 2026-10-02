-- Conformance fixture for probe (f): satisfies every check the generated
-- contract-tests.sql runs against routine ordering.sp_place_order (params
-- @p_total DECIMAL(12,2) and @p_note NVARCHAR(280), in this order; result
-- columns order_id NVARCHAR(64) NOT NULL and status NVARCHAR(16) NOT NULL, in
-- this order).
-- OUTPUT inserted.<column> propagates the table's NOT NULL metadata into the
-- result set, which sys.dm_exec_describe_first_result_set_for_object reports;
-- a plain variable SELECT would come back nullable. Applied against the
-- projected schema.sql; Loom itself never executes it.
CREATE PROCEDURE [ordering].[sp_place_order]
    @p_total DECIMAL(12,2),
    @p_note NVARCHAR(280) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @order_id NVARCHAR(64) = CONVERT(NVARCHAR(64), NEWID());

    INSERT INTO [ordering].[orders] ([id], [status], [total], [note])
    OUTPUT inserted.[id] AS order_id, inserted.[status] AS status
    VALUES (@order_id, N'placed', @p_total, @p_note);
END
GO
