DROP INDEX "factor_scope_uq";--> statement-breakpoint
ALTER TABLE "emission_factors" ADD CONSTRAINT "factor_scope_uq" UNIQUE NULLS NOT DISTINCT("org_id","region","year","method");