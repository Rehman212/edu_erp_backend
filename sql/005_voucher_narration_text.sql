-- Long voucher narration (wraps on the printed voucher).
ALTER TABLE purmast ALTER COLUMN narp TYPE text;
ALTER TABLE accmast ALTER COLUMN nar TYPE text;
ALTER TABLE accdet ALTER COLUMN snar TYPE text;
