CREATE TABLE `sender_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`address` text NOT NULL,
	`policy` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sender_policies_mailbox_address_idx` ON `sender_policies` (`mailbox_id`,`address`);
--> statement-breakpoint
CREATE TABLE `rule_outbound_log` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`kind` text NOT NULL,
	`sender` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rule_outbound_log_mailbox_sender_idx` ON `rule_outbound_log` (`mailbox_id`,`sender`,`created_at`);
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `delivered_to` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `delivery_status` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `delivery_detail` text;