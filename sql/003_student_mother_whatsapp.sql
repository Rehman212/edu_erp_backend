-- New Student form: mother name/CNIC + active WhatsApp number
ALTER TABLE student ADD COLUMN IF NOT EXISTS mname varchar(120);
ALTER TABLE student ADD COLUMN IF NOT EXISTS mnic varchar(40);
ALTER TABLE student ADD COLUMN IF NOT EXISTS whatsapp varchar(40);
