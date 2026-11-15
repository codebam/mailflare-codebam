CREATE TABLE `access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text,
	`name` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_tokens_token_hash_idx` ON `access_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `access_tokens_user_idx` ON `access_tokens` (`user_id`);
--> statement-breakpoint
CREATE INDEX `access_tokens_mailbox_idx` ON `access_tokens` (`mailbox_id`);