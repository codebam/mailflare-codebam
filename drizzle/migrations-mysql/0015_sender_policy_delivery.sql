CREATE TABLE `sender_policies` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`address` varchar(320) NOT NULL,
	`policy` varchar(64) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `sender_policies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `sender_policies` ADD CONSTRAINT `sender_policies_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX `sender_policies_mailbox_address_idx` ON `sender_policies` (`mailbox_id`,`address`);--> statement-breakpoint
CREATE TABLE `rule_outbound_log` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`sender` varchar(320) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `rule_outbound_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `rule_outbound_log` ADD CONSTRAINT `rule_outbound_log_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `rule_outbound_log_mailbox_sender_idx` ON `rule_outbound_log` (`mailbox_id`,`sender`,`created_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `delivered_to` longtext;--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `delivery_status` longtext;--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `delivery_detail` longtext;