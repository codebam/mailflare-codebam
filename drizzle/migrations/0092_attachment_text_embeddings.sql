CREATE TABLE `attachment_texts` (
	`attachment_id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `message_attachments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `attachment_text_fts` USING fts5(
	`content`,
	content='attachment_texts',
	content_rowid='rowid',
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `attachment_text_fts_ai` AFTER INSERT ON `attachment_texts` BEGIN
	INSERT INTO `attachment_text_fts`(`rowid`, `content`)
	VALUES (new.`rowid`, new.`content`);
END;--> statement-breakpoint
CREATE TRIGGER `attachment_text_fts_ad` AFTER DELETE ON `attachment_texts` BEGIN
	INSERT INTO `attachment_text_fts`(`attachment_text_fts`, `rowid`, `content`)
	VALUES ('delete', old.`rowid`, old.`content`);
END;--> statement-breakpoint
CREATE TRIGGER `attachment_text_fts_au` AFTER UPDATE OF `content` ON `attachment_texts` BEGIN
	INSERT INTO `attachment_text_fts`(`attachment_text_fts`, `rowid`, `content`)
	VALUES ('delete', old.`rowid`, old.`content`);
	INSERT INTO `attachment_text_fts`(`rowid`, `content`)
	VALUES (new.`rowid`, new.`content`);
END;--> statement-breakpoint
INSERT INTO `attachment_text_fts`(`attachment_text_fts`) VALUES ('rebuild');
--> statement-breakpoint
CREATE TABLE `message_embeddings` (
	`message_id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`content_hash` text NOT NULL,
	`embedding` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);