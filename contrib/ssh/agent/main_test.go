package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

type fakeSigner struct {
	ids      []identity
	err      error
	gotHost  []byte
	gotFlags uint32
}

func (f *fakeSigner) Identities() ([]identity, error) { return f.ids, f.err }

func (f *fakeSigner) Sign(key, data []byte, flags uint32, hostKey []byte) ([]byte, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.gotHost, f.gotFlags = hostKey, flags
	return append([]byte("sig:"), data...), nil
}

// roundTrip sends one framed message and returns the framed reply's body.
func roundTrip(t *testing.T, c net.Conn, msg []byte) []byte {
	t.Helper()
	if _, err := c.Write(appendString(nil, msg)); err != nil {
		t.Fatal(err)
	}
	var n [4]byte
	if _, err := io.ReadFull(c, n[:]); err != nil {
		t.Fatal(err)
	}
	out := make([]byte, binary.BigEndian.Uint32(n[:]))
	if _, err := io.ReadFull(c, out); err != nil {
		t.Fatal(err)
	}
	return out
}

func pipe(t *testing.T, s Signer) net.Conn {
	client, server := net.Pipe()
	go func() { _ = serve(server, s); server.Close() }()
	t.Cleanup(func() { client.Close() })
	return client
}

func TestListsTheBrokersIdentities(t *testing.T) {
	key := []byte("\x00\x00\x00\x0bssh-ed25519pub")
	c := pipe(t, &fakeSigner{ids: []identity{{Key: base64.StdEncoding.EncodeToString(key), Comment: "alice@scooter"}}})
	out := roundTrip(t, c, []byte{requestIdentities})
	want := []byte{identitiesAnswer, 0, 0, 0, 1}
	want = appendString(want, key)
	want = appendString(want, []byte("alice@scooter"))
	if !bytes.Equal(out, want) {
		t.Fatalf("got %x want %x", out, want)
	}
}

func TestAnUnreachableBrokerListsNothing(t *testing.T) {
	c := pipe(t, &fakeSigner{err: errors.New("down")})
	if out := roundTrip(t, c, []byte{requestIdentities}); !bytes.Equal(out, []byte{identitiesAnswer, 0, 0, 0, 0}) {
		t.Fatalf("got %x", out)
	}
}

func TestSignsWithTheSessionBoundHost(t *testing.T) {
	f := &fakeSigner{}
	c := pipe(t, f)
	bind := appendString([]byte{extension}, []byte(sessionBindExtension))
	bind = appendString(bind, []byte("hostkey"))
	if out := roundTrip(t, c, bind); !bytes.Equal(out, []byte{agentSuccess}) {
		t.Fatalf("session-bind: %x", out)
	}
	req := appendString([]byte{signRequest}, []byte("key"))
	req = appendString(req, []byte("data"))
	req = binary.BigEndian.AppendUint32(req, 4)
	out := roundTrip(t, c, req)
	if !bytes.Equal(out, appendString([]byte{signResponse}, []byte("sig:data"))) {
		t.Fatalf("got %x", out)
	}
	if string(f.gotHost) != "hostkey" || f.gotFlags != 4 {
		t.Fatalf("host %q flags %d", f.gotHost, f.gotFlags)
	}
}

func TestARefusedSignatureFails(t *testing.T) {
	c := pipe(t, &fakeSigner{err: errors.New("403")})
	req := appendString([]byte{signRequest}, []byte("key"))
	req = appendString(req, []byte("data"))
	req = binary.BigEndian.AppendUint32(req, 0)
	if out := roundTrip(t, c, req); !bytes.Equal(out, []byte{agentFailure}) {
		t.Fatalf("got %x", out)
	}
}

func TestOtherRequestsFail(t *testing.T) {
	c := pipe(t, &fakeSigner{})
	for _, msg := range [][]byte{{17}, {22}, {19}, {}} { // add identity, lock, remove all, empty
		if out := roundTrip(t, c, msg); !bytes.Equal(out, []byte{agentFailure}) {
			t.Fatalf("%x: got %x", msg, out)
		}
	}
}

func TestATruncatedSignRequestFails(t *testing.T) {
	c := pipe(t, &fakeSigner{})
	if out := roundTrip(t, c, []byte{signRequest, 0, 0, 0, 9, 'k'}); !bytes.Equal(out, []byte{agentFailure}) {
		t.Fatalf("got %x", out)
	}
}

func TestTheBrokerClientSendsTheTokenAndDecodes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/ssh/identities":
			_, _ = w.Write([]byte(`{"identities":[{"key":"a2V5","comment":"c"}]}`))
		case "/ssh/sign":
			_, _ = w.Write([]byte(`{"signature":"c2ln"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	tok := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tok, []byte("tok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	b := &Broker{URL: srv.URL + "/", TokenPath: tok, Client: srv.Client()}
	ids, err := b.Identities()
	if err != nil || len(ids) != 1 || ids[0].Key != "a2V5" {
		t.Fatalf("identities %v %v", ids, err)
	}
	sig, err := b.Sign([]byte("key"), []byte("data"), 0, nil)
	if err != nil || string(sig) != "sig" {
		t.Fatalf("sign %q %v", sig, err)
	}
}
