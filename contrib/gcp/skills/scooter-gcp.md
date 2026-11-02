---
name: scooter-gcp
type: knowledge
version: 1.0.0
triggers:
- gcp
- google cloud
- gcloud
- gke
- cloud run
- cloud sql
- bigquery
- gcs
- cloud storage
- cloud monitoring
- cloud logging
- stackdriver
- compute engine
- googleapis
---

# Google Cloud: gcloud, terraform and the REST APIs (scooter-gcp)

`gcloud`, `terraform` and `curl` reach Google Cloud from this sandbox without a
credential of yours. The broker's forge proxy intercepts the `*.googleapis.com`
hosts and swaps in a short-lived token for the deployment's **service
account**. The sandbox holds only the placeholder `scooter-forge-proxy`, so
don't run `gcloud auth login` or look for a key: there is none, and none is
needed.

What you may do is exactly what that service account's IAM roles allow. A 403
`PERMISSION_DENIED` from Google means the role is missing. Tell the user which
permission the error names; don't try to work around it. A 403 carrying an
`X-Scooter-Policy` header is the deployment's policy refusing the call. Report its
message.

## First: where am I?

```bash
gcloud config list                 # the default project, if the deployment set one
gcloud projects list               # the projects the service account can see
```

Pass `--project <id>` when there's no default, or when the task names another
project.

## Monitoring and inspecting

```bash
gcloud compute instances list
gcloud container clusters list
gcloud run services list --region us-central1
gcloud sql instances list
gcloud storage ls
gcloud logging read 'severity>=ERROR' --freshness 1h --limit 50
gcloud monitoring dashboards list
gcloud asset search-all-resources --scope projects/<id>   # inventory of everything
```

For metrics, call the Monitoring API directly. `curl` goes through the proxy
too, and any `Authorization` header you send gets replaced:

```bash
curl -s "https://monitoring.googleapis.com/v3/projects/<id>/timeSeries" \
  --get --data-urlencode 'filter=metric.type="compute.googleapis.com/instance/cpu/utilization"' \
  --data-urlencode "interval.startTime=$(date -u -d '-1 hour' +%FT%TZ)" \
  --data-urlencode "interval.endTime=$(date -u +%FT%TZ)"
```

## Managing resources

Writes work when the roles (and the deployment's scope) allow them. Before
anything destructive or costly (deleting, resizing, changing IAM, creating
billable resources), say exactly what you'll change and get the user's go-ahead.
Prefer `--dry-run` / `terraform plan` first where the tool has one.

`terraform`'s `google` provider picks up the placeholder from
`GOOGLE_OAUTH_ACCESS_TOKEN`. Leave `credentials` unset in the provider block.

## Limits

- **Only known hosts get a token.** The intercepted list is in
  `/etc/scooter/forge-ca/hosts`. A googleapis.com host missing from it is
  reached directly with the placeholder and fails with 401. Regional endpoints
  (`us-central1-run.googleapis.com`) count as separate hosts. Ask the user to add a
  missing one to `contribs.gcp.extraHosts`.
- **HTTP/1.1 REST only.** gRPC clients (some Python/Go client libraries for
  Pub/Sub, Firestore and Spanner) can't go through the proxy. Use gcloud or the
  REST API instead, or the client library's REST transport.
- **Client libraries** don't read the placeholder on their own. In Python, pass
  `google.oauth2.credentials.Credentials("scooter-forge-proxy")`.
- `gcloud auth print-access-token` prints the placeholder, not a real token.
- `gcloud auth list` shows no credentialed accounts. That's expected; ignore
  its advice to log in.
- A 401 whose reason is `CREDENTIALS_MISSING` means the host wasn't
  intercepted (see the first point), not that access is broken.
