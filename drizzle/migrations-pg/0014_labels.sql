CREATE TABLE "labels" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"color" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_mailbox_name_idx" ON "labels" USING btree ("mailbox_id","name_key");--> statement-breakpoint
CREATE TABLE "message_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"label_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_labels_message_label_idx" ON "message_labels" USING btree ("message_id","label_id");--> statement-breakpoint
CREATE INDEX "message_labels_label_idx" ON "message_labels" USING btree ("label_id");