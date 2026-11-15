CREATE TABLE `agent_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`tool` text NOT NULL,
	`message_id` text,
	`subject` text,
	`thread_key` text,
	`before_state` text,
	`after_state` text,
	`undoable` integer DEFAULT false NOT NULL,
	`undone_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_actions_mailbox_created_idx` ON `agent_actions` (`mailbox_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_mailbox_name_idx` ON `categories` (`mailbox_id`,`name_key`);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`message_id` text,
	`kind` text DEFAULT 'task' NOT NULL,
	`title` text NOT NULL,
	`details` text,
	`due_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `items_mailbox_status_idx` ON `items` (`mailbox_id`,`status`);
--> statement-breakpoint
CREATE INDEX `items_mailbox_due_idx` ON `items` (`mailbox_id`,`due_at`);