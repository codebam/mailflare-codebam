CREATE TABLE `agent_actions` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`tool` longtext NOT NULL,
	`message_id` varchar(191),
	`subject` longtext,
	`thread_key` longtext,
	`before_state` longtext,
	`after_state` longtext,
	`undoable` boolean NOT NULL DEFAULT false,
	`undone_at` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `agent_actions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `agent_actions` ADD CONSTRAINT `agent_actions_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_actions` ADD CONSTRAINT `agent_actions_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `agent_actions_mailbox_created_idx` ON `agent_actions` (`mailbox_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL DEFAULT '',
	`name` longtext NOT NULL,
	`name_key` varchar(191) NOT NULL,
	`color` longtext,
	`created_at` bigint NOT NULL,
	CONSTRAINT `categories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_mailbox_name_idx` ON `categories` (`mailbox_id`,`name_key`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`message_id` varchar(191),
	`kind` varchar(64) NOT NULL DEFAULT 'task',
	`title` longtext NOT NULL,
	`details` longtext,
	`due_at` bigint,
	`status` varchar(64) NOT NULL DEFAULT 'open',
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `items` ADD CONSTRAINT `items_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `items` ADD CONSTRAINT `items_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `items_mailbox_status_idx` ON `items` (`mailbox_id`,`status`);--> statement-breakpoint
CREATE INDEX `items_mailbox_due_idx` ON `items` (`mailbox_id`,`due_at`);