CREATE TABLE `labels` (
	`id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191) NOT NULL,
	`name` longtext NOT NULL,
	`name_key` varchar(191) NOT NULL,
	`color` longtext,
	`created_at` bigint NOT NULL,
	CONSTRAINT `labels_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `labels` ADD CONSTRAINT `labels_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX `labels_mailbox_name_idx` ON `labels` (`mailbox_id`,`name_key`);--> statement-breakpoint
CREATE TABLE `message_labels` (
	`id` varchar(191) NOT NULL,
	`message_id` varchar(191) NOT NULL,
	`label_id` varchar(191) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `message_labels_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `message_labels` ADD CONSTRAINT `message_labels_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_labels` ADD CONSTRAINT `message_labels_label_id_labels_id_fk` FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX `message_labels_message_label_idx` ON `message_labels` (`message_id`,`label_id`);--> statement-breakpoint
CREATE INDEX `message_labels_label_idx` ON `message_labels` (`label_id`);