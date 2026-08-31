// Atlas config for the Scooter shared schemas.
//
// Tables are partitioned across per-service databases on one Postgres server
// (webhooks, scheduler, broker, byoc) — so there is one Atlas env per database,
// each with its own schema.sql (the desired end-state) and migrations/ dir.
//
// Atlas needs a throwaway "dev" Postgres to normalize each schema and compute
// diffs — NOT the shared/production database and NOT a long-lived one.
// `just db-migrate` spins an ephemeral local Postgres per env and passes its URL
// as ATLAS_DEV_URL, so nothing is shared and concurrent runs cannot interfere.

variable "dev_url" {
  type    = string
  default = getenv("ATLAS_DEV_URL")
}

env "webhooks" {
  src = "file://webhooks/schema.sql"
  dev = var.dev_url
  migration { dir = "file://webhooks/migrations" }
  format {
    migrate {
      diff = "{{ sql . \"  \" }}"
    }
  }
}

env "scheduler" {
  src = "file://scheduler/schema.sql"
  dev = var.dev_url
  migration { dir = "file://scheduler/migrations" }
  format {
    migrate {
      diff = "{{ sql . \"  \" }}"
    }
  }
}

env "broker" {
  src = "file://broker/schema.sql"
  dev = var.dev_url
  migration { dir = "file://broker/migrations" }
  format {
    migrate {
      diff = "{{ sql . \"  \" }}"
    }
  }
}

env "byoc" {
  src = "file://byoc/schema.sql"
  dev = var.dev_url
  migration { dir = "file://byoc/migrations" }
  format {
    migrate {
      diff = "{{ sql . \"  \" }}"
    }
  }
}
