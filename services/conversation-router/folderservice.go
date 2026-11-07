package main

// Folder services: allowlisted services manage users' locked folders.

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/chadac-me/scooter/conversation-router/svcauth"
)

// FolderService proves a folder service's bearer, returning the user it asserts.
type FolderService func(ctx context.Context, r *http.Request) (user string, ok bool)

// folderServiceAccounts is the allowlist of folder services.
func folderServiceAccounts() map[string]bool {
	return svcauth.ParseAllowlist(env("FOLDER_SERVICE_ACCOUNTS", ""))
}

// newFolderService proves an allowlisted bearer; nil without an allowlist.
func newFolderService(review reviewTokenFunc, allowed map[string]bool) FolderService {
	if len(allowed) == 0 || review == nil {
		return nil
	}
	verifier := svcauth.NewVerifier(review)
	// Asserters, so the caller names the user in X-Scooter-User.
	policy := svcauth.Policy{Asserters: allowed}
	return func(ctx context.Context, r *http.Request) (string, bool) {
		if svcauth.BearerToken(r) == "" {
			return "", false
		}
		p, err := verifier.Resolve(ctx, r, policy)
		if err != nil {
			logger("folders").Warn("folder service refused",
				slog.String("username", p.ServiceAccount), errAttr(err))
			return "", false
		}
		return p.User, true
	}
}
