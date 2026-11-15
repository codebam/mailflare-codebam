CREATE TABLE `rules` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`name` longtext NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`priority` bigint NOT NULL DEFAULT 0,
	`match` longtext NOT NULL,
	`actions` longtext NOT NULL,
	`fired_count` bigint NOT NULL DEFAULT 0,
	`last_fired_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `rules` ADD CONSTRAINT `rules_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `rules_mailbox_priority_idx` ON `rules` (`mailbox_id`,`priority`);--> statement-breakpoint
CREATE TABLE `mailbox_templates` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`name` longtext NOT NULL,
	`subject` longtext NOT NULL,
	`body` longtext NOT NULL,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `mailbox_templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `mailbox_templates` ADD CONSTRAINT `mailbox_templates_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `mailbox_templates_mailbox_idx` ON `mailbox_templates` (`mailbox_id`);--> statement-breakpoint
CREATE TABLE `saved_searches` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`name` longtext NOT NULL,
	`query` longtext NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `saved_searches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `saved_searches` ADD CONSTRAINT `saved_searches_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `saved_searches_mailbox_idx` ON `saved_searches` (`mailbox_id`);--> statement-breakpoint
CREATE TABLE `muted_threads` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`thread_key` varchar(191) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `muted_threads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `muted_threads` ADD CONSTRAINT `muted_threads_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX `muted_threads_mailbox_thread_idx` ON `muted_threads` (`mailbox_id`,`thread_key`);--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `category` longtext;