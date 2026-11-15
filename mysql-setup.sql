CREATE DATABASE IF NOT EXISTS finance_desk CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
CREATE TABLE IF NOT EXISTS finance_desk.finance_record (
  type ENUM('ar','report') NOT NULL,
  id VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  data JSON NOT NULL,
  PRIMARY KEY (type,id),
  CONSTRAINT invoice_balance CHECK (
    type <> 'ar' OR (
      JSON_EXTRACT(data,'$.paid') IS NOT NULL
      AND JSON_EXTRACT(data,'$.amount') IS NOT NULL
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.paid')) AS SIGNED) BETWEEN 0
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.amount')) AS SIGNED)
    )
  )
) ENGINE=InnoDB;
CREATE USER IF NOT EXISTS 'finance_desk_app'@'localhost' IDENTIFIED BY RANDOM PASSWORD;
GRANT SELECT, INSERT, UPDATE ON finance_desk.finance_record TO 'finance_desk_app'@'localhost';
