-- Create "module_registry" table
CREATE TABLE "module_registry" (
  "id" serial NOT NULL,
  "name" character varying NOT NULL,
  "owner" character varying NOT NULL,
  "description" text NOT NULL,
  "visibility" character varying NOT NULL,
  "version" integer NOT NULL,
  "files_json" text NOT NULL,
  "created_at" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_module_registry_name" to table: "module_registry"
CREATE UNIQUE INDEX "ix_module_registry_name" ON "module_registry" ("name");
-- Create index "ix_module_registry_owner" to table: "module_registry"
CREATE INDEX "ix_module_registry_owner" ON "module_registry" ("owner");
-- Create index "ix_module_registry_visibility" to table: "module_registry"
CREATE INDEX "ix_module_registry_visibility" ON "module_registry" ("visibility");
-- Create "permission_requests" table
CREATE TABLE "permission_requests" (
  "request_id" character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "target_account" character varying NOT NULL,
  "justification" text NOT NULL,
  "status" character varying NOT NULL,
  "risk_level" character varying NOT NULL,
  "policy_document" text NULL,
  "managed_policy_arns" text NOT NULL,
  "policy_summary" text NOT NULL,
  "conversation_url" text NULL,
  "parent_request_id" character varying NULL,
  "requested_at" character varying NOT NULL,
  "approved_at" character varying NULL,
  "approved_by" character varying NULL,
  "denied_at" character varying NULL,
  "denied_by" character varying NULL,
  "deny_reason" text NULL,
  "revoked_at" character varying NULL,
  "iam_role_arn" character varying NULL,
  "iam_policy_arn" character varying NULL,
  "role_expires_at" character varying NULL,
  "credentials_issued_at" character varying NULL,
  "expires_at" character varying NULL,
  PRIMARY KEY ("request_id")
);
-- Create index "ix_permission_requests_conversation_id" to table: "permission_requests"
CREATE INDEX "ix_permission_requests_conversation_id" ON "permission_requests" ("conversation_id");
-- Create index "ix_permission_requests_status" to table: "permission_requests"
CREATE INDEX "ix_permission_requests_status" ON "permission_requests" ("status");
-- Create index "ix_permission_requests_target_account" to table: "permission_requests"
CREATE INDEX "ix_permission_requests_target_account" ON "permission_requests" ("target_account");
-- Create "sandbox_size" table
CREATE TABLE "sandbox_size" (
  "conversation_id" character varying NOT NULL,
  "spec_json" text NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("conversation_id")
);
