CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_mailbox_name_idx` ON `labels` (`mailbox_id`,`name_key`);
--> statement-breakpoint
CREATE TABLE `message_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`label_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_labels_message_label_idx` ON `message_labels` (`message_id`,`label_id`);
--> statement-breakpoint
CREATE INDEX `message_labels_label_idx` ON `message_labels` (`label_id`);