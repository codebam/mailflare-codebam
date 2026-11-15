CREATE TABLE "agent_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"tool" text NOT NULL,
	"message_id" text,
	"subject" text,
	"thread_key" text,
	"before_state" text,
	"after_state" text,
	"undoable" boolean DEFAULT false NOT NULL,
	"undone_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_actions_mailbox_created_idx" ON "agent_actions" USING btree ("mailbox_id","created_at");--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"color" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "categories_mailbox_name_idx" ON "categories" USING btree ("mailbox_id","name_key");--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"message_id" text,
	"kind" text DEFAULT 'task' NOT NULL,
	"title" text NOT NULL,
	"details" text,
	"due_at" bigint,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_mailbox_status_idx" ON "items" USING btree ("mailbox_id","status");--> statement-breakpoint
CREATE INDEX "items_mailbox_due_idx" ON "items" USING btree ("mailbox_id","due_at");