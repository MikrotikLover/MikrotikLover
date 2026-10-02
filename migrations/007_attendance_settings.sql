-- 007: attendance settings (batch 2)

INSERT INTO settings (setting_key, setting_value) VALUES
 ('default_shift_id',     'null'),   -- shift used for employees without a shift group (NULL = hours only, no late/OT)
 ('scan_repeat_seconds',  '60'),     -- barcode kiosk: ignore a repeat scan of the same card within N seconds
 ('kiosk_token',          'null'),   -- secret for the barcode kiosk page (generated on first use)
 ('tv_token',             'null');   -- secret for the live TV attendance screen (generated on first use)

-- Faster look-ups used by daily post and reports
ALTER TABLE attendance_punches ADD KEY idx_punch_processed (is_processed, punch_time);
ALTER TABLE attendance_daily   ADD KEY idx_att_source (source, att_date);
ALTER TABLE leave_register     ADD KEY idx_lr_dates (status, from_date, to_date);
