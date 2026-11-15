CREATE TABLE `access_tokens` (
	`id` varchar(191) NOT NULL,
	`token_hash` varchar(191) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191),
	`name` longtext NOT NULL,
	`scopes` longtext NOT NULL,
	`created_at` bigint NOT NULL,
	`last_used_at` bigint,
	CONSTRAINT `access_tokens_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `access_tokens` ADD CONSTRAINT `access_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `access_tokens` ADD CONSTRAINT `access_tokens_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX `access_tokens_token_hash_idx` ON `access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `access_tokens_user_idx` ON `access_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `access_tokens_mailbox_idx` ON `access_tokens` (`mailbox_id`);