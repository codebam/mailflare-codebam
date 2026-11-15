CREATE TABLE "sender_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"address" text NOT NULL,
	"policy" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sender_policies" ADD CONSTRAINT "sender_policies_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sender_policies_mailbox_address_idx" ON "sender_policies" USING btree ("mailbox_id","address");--> statement-breakpoint
CREATE TABLE "rule_outbound_log" (
	"id" text PRIMARY KEY NOT NULL,
	"mailbox_id" text NOT NULL,
	"kind" text NOT NULL,
	"sender" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rule_outbound_log" ADD CONSTRAINT "rule_outbound_log_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rule_outbound_log_mailbox_sender_idx" ON "rule_outbound_log" USING btree ("mailbox_id","sender","created_at");--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivered_to" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_detail" text;