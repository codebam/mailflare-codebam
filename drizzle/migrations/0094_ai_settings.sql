ALTER TABLE `mailbox_agent_settings` ADD COLUMN `classify_enabled` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `mailbox_agent_settings` ADD COLUMN `extract_items_enabled` integer DEFAULT true NOT NULL;