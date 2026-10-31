// scooter-ssh-agent: an ssh-agent whose only key lives in the broker.
//
// It answers the agent protocol on a unix socket, forwarding identity listing and
// signing to the broker's /ssh routes with the pod's SA token. Any other
// request (adding keys, locking) is refused. Standard library only.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// Message numbers from draft-miller-ssh-agent.
const (
	agentFailure         = 5
	agentSuccess         = 6
	requestIdentities    = 11
	identitiesAnswer     = 12
	signRequest          = 13
	signResponse         = 14
	extension            = 27
	maxMessage           = 256 * 1024
	sessionBindExtension = "session-bind@openssh.com"
)

// Broker calls the broker's /ssh routes.
type Broker struct {
	URL       string
	TokenPath string
	Client    *http.Client
}

type identity struct {
	Key     string `json:"key"`
	Comment string `json:"comment"`
}

func (b *Broker) do(method, path string, body any, out any) error {
	token, err := os.ReadFile(b.TokenPath)
	if err != nil {
		return fmt.Errorf("broker token: %w", err)
	}
	var rd io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, strings.TrimRight(b.URL, "/")+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("broker %s %s: %d %s", method, path, resp.StatusCode, bytes.TrimSpace(msg))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (b *Broker) Identities() ([]identity, error) {
	var out struct {
		Identities []identity `json:"identities"`
	}
	err := b.do(http.MethodGet, "/ssh/identities", nil, &out)
	return out.Identities, err
}

func (b *Broker) Sign(key, data []byte, flags uint32, hostKey []byte) ([]byte, error) {
	in := map[string]any{
		"key":   base64.StdEncoding.EncodeToString(key),
		"data":  base64.StdEncoding.EncodeToString(data),
		"flags": flags,
	}
	if hostKey != nil {
		in["host_key"] = base64.StdEncoding.EncodeToString(hostKey)
	}
	var out struct {
		Signature string `json:"signature"`
	}
	if err := b.do(http.MethodPost, "/ssh/sign", in, &out); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(out.Signature)
}

// Signer is what a connection needs from the broker.
type Signer interface {
	Identities() ([]identity, error)
	Sign(key, data []byte, flags uint32, hostKey []byte) ([]byte, error)
}

func appendString(buf, s []byte) []byte {
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(s)))
	return append(buf, s...)
}

// readString takes one SSH string off the front of p.
func readString(p []byte) ([]byte, []byte, error) {
	if len(p) < 4 {
		return nil, nil, errors.New("short string length")
	}
	n := binary.BigEndian.Uint32(p)
	if uint32(len(p)-4) < n {
		return nil, nil, errors.New("short string")
	}
	return p[4 : 4+n], p[4+n:], nil
}

// conn serves one client connection; hostKey is the last session-bind's host key.
type conn struct {
	signer  Signer
	hostKey []byte
}

func (c *conn) handle(msg []byte) []byte {
	if len(msg) == 0 {
		return []byte{agentFailure}
	}
	switch msg[0] {
	case requestIdentities:
		ids, err := c.signer.Identities()
		if err != nil {
			log.Printf("identities: %v", err)
			ids = nil
		}
		out := []byte{identitiesAnswer}
		out = binary.BigEndian.AppendUint32(out, uint32(len(ids)))
		for _, id := range ids {
			key, err := base64.StdEncoding.DecodeString(id.Key)
			if err != nil {
				return []byte{agentFailure}
			}
			out = appendString(out, key)
			out = appendString(out, []byte(id.Comment))
		}
		return out
	case signRequest:
		key, rest, err := readString(msg[1:])
		if err != nil {
			return []byte{agentFailure}
		}
		data, rest, err := readString(rest)
		if err != nil || len(rest) < 4 {
			return []byte{agentFailure}
		}
		sig, err := c.signer.Sign(key, data, binary.BigEndian.Uint32(rest), c.hostKey)
		if err != nil {
			log.Printf("sign: %v", err)
			return []byte{agentFailure}
		}
		return appendString([]byte{signResponse}, sig)
	case extension:
		name, rest, err := readString(msg[1:])
		if err != nil || string(name) != sessionBindExtension {
			return []byte{agentFailure}
		}
		// Kept so the broker can log where a signature went.
		hostKey, _, err := readString(rest)
		if err != nil {
			return []byte{agentFailure}
		}
		c.hostKey = append([]byte(nil), hostKey...)
		return []byte{agentSuccess}
	default:
		return []byte{agentFailure}
	}
}

func serve(rw io.ReadWriter, signer Signer) error {
	c := &conn{signer: signer}
	var lenBuf [4]byte
	for {
		if _, err := io.ReadFull(rw, lenBuf[:]); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		n := binary.BigEndian.Uint32(lenBuf[:])
		if n > maxMessage {
			return fmt.Errorf("message of %d bytes is too large", n)
		}
		msg := make([]byte, n)
		if _, err := io.ReadFull(rw, msg); err != nil {
			return err
		}
		if _, err := rw.Write(appendString(nil, c.handle(msg))); err != nil {
			return err
		}
	}
}

func main() {
	socket := flag.String("socket", "/run/scooter-ssh-agent/agent.sock", "unix socket to listen on")
	broker := flag.String("broker", os.Getenv("BROKER_URL"), "broker base URL")
	token := flag.String("token", "/var/run/secrets/broker/token", "projected SA token path")
	flag.Parse()
	if *broker == "" {
		log.Fatal("no broker URL (-broker or BROKER_URL)")
	}
	_ = os.Remove(*socket)
	ln, err := net.Listen("unix", *socket)
	if err != nil {
		log.Fatal(err)
	}
	// The pod is one tenant, so every local user may use the agent.
	if err := os.Chmod(*socket, 0o666); err != nil {
		log.Fatal(err)
	}
	b := &Broker{URL: *broker, TokenPath: *token, Client: &http.Client{Timeout: 30 * time.Second}}
	for {
		cn, err := ln.Accept()
		if err != nil {
			log.Fatal(err)
		}
		go func() {
			defer cn.Close()
			if err := serve(cn, b); err != nil {
				log.Printf("connection: %v", err)
			}
		}()
	}
}
