CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
INSERT INTO "roles" ("id", "name", "description", "permissions", "is_system") VALUES
	('role_owner', 'Owner', 'Full access to everything, including anything added later.', '["*"]'::jsonb, true),
	('role_admin', 'Admin', 'Manages the workspace, people, channels and automations.', '["workspace.manage","inboxes.manage","users.manage","roles.manage","automations.manage","folders.manage_shared","system.admin"]'::jsonb, true),
	('role_agent', 'Agent', 'Works the inbox. No workspace administration.', '[]'::jsonb, true);--> statement-breakpoint
ALTER TABLE "team_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "teams" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "team_members" CASCADE;--> statement-breakpoint
DROP TABLE "teams" CASCADE;--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_owner_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_assigned_team_id_teams_id_fk";
--> statement-breakpoint
DROP INDEX "contacts_owner_team_idx";--> statement-breakpoint
DROP INDEX "conversations_team_idx";--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "role_id" text DEFAULT 'role_agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_id" text DEFAULT 'role_agent' NOT NULL;--> statement-breakpoint
UPDATE "users" SET "role_id" = CASE "role"::text WHEN 'owner' THEN 'role_owner' WHEN 'admin' THEN 'role_admin' ELSE 'role_agent' END;--> statement-breakpoint
UPDATE "invites" SET "role_id" = CASE "role"::text WHEN 'owner' THEN 'role_owner' WHEN 'admin' THEN 'role_admin' ELSE 'role_agent' END;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "owner_team_id";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "assigned_team_id";--> statement-breakpoint
DROP TYPE "public"."user_role";--> statement-breakpoint
UPDATE "automation_rules" SET "actions" = "actions" - 'assignToTeamId' WHERE "actions" ? 'assignToTeamId';--> statement-breakpoint
UPDATE "macros" SET "actions" = "actions" - 'assignToTeamId' WHERE "actions" ? 'assignToTeamId';--> statement-breakpoint
DELETE FROM "saved_views" WHERE "filters" ? 'teamId';
