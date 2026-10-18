ALTER TABLE "email_codes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_codes" ADD COLUMN "email" text;--> statement-breakpoint
-- existing codes were all sent to accounts: take the address from the account
UPDATE "email_codes" c SET "email" = lower(u."email") FROM "users" u WHERE u."id" = c."user_id";--> statement-breakpoint
DELETE FROM "email_codes" WHERE "email" IS NULL;--> statement-breakpoint
ALTER TABLE "email_codes" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "email_codes_email_idx" ON "email_codes" USING btree ("email","purpose");
