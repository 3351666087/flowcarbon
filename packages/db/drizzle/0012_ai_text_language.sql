-- 0011 labelled what was already stored by the language its requester uses today, and people change language. Each
-- text says itself what it was written in: Chinese has Han characters, and a citation or a tenant's name aside the
-- headline and the first answer are all in one language.
UPDATE "ai_briefs" SET "locale" = CASE WHEN "output"->>'headline' ~ '[一-鿿]' THEN 'zh' ELSE 'en' END WHERE "output" IS NOT NULL;--> statement-breakpoint
UPDATE "ai_explanations" SET "locale" = CASE WHEN "output"->>'whatHappened' ~ '[一-鿿]' THEN 'zh' ELSE 'en' END WHERE "output" IS NOT NULL;
