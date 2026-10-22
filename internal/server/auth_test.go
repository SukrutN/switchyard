package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"testing"
	"time"

	"github.com/SukrutN/switchyard/internal/wire"
)

// The auth pair (§2.28–§2.29) over real sockets. These are the byte-level
// proofs: the gate exists, the wrong token dies, the right token nods, and
// identity belongs to the door. The TLS half proves the same frames ride a
// wrapped socket untouched.

func tokenedServer(t *testing.T) (*Server, *Config) {
	t.Helper()
	return newTestServer(t, func(cc *Config) {
		cc.Addr = "127.0.0.1:0"
		cc.AuthToken = "shh"
	})
}

func sendAuth(t *testing.T, rw *raw, token string) {
	t.Helper()
	ab, err := wire.EncodeAuthenticate(wire.Authenticate{Token: token})
	if err != nil {
		t.Fatalf("encode authenticate %d bytes: %v", len(token), err)
	}
	rw.send(t, wire.OpAuthenticate, ab)
}

// expectFatal expects the ERROR frame's last words: a killed session speaks
// exactly once, and it better be the code the test asked for.
func expectFatal(t *testing.T, rw *raw, wantCode byte) {
	t.Helper()
	op, body, err := rw.read(t, 3*time.Second)
	if err != nil {
		t.Fatalf("awaiting fatal ERROR 0x%02X: %v", wantCode, err)
	}
	if op != wire.OpError {
		t.Fatalf("got %s, want ERROR 0x%02X", op, wantCode)
	}
	e, derr := wire.DecodeError(body)
	if derr != nil {
		t.Fatalf("error frame: %v", derr)
	}
	if !e.Fatal || e.Code != wantCode {
		t.Fatalf("fatal refusal mismatch: %+v, want fatal 0x%02X", e, wantCode)
	}
}

func TestAuthGatesTheDoor(t *testing.T) {
	srv, _ := tokenedServer(t)

	// HELLO without authentication meets the gate: fatal, one answer.
	rw := dialRaw(t, srv.Addr())
	rw.helloRaw(t)
	expectFatal(t, rw, wire.CodeNotAllowed)

	// A wrong token opens nothing; the socket gets no second guess.
	rw2 := dialRaw(t, srv.Addr())
	rw2.helloRaw(t)
	sendAuth(t, rw2, "wrong-password")
	expectFatal(t, rw2, wire.CodeNotAllowed)

	// The right token nods, and the handshake proceeds like any yard's.
	rw3 := dialRaw(t, srv.Addr())
	sendAuth(t, rw3, "shh")
	op, _, err := rw3.read(t, 3*time.Second)
	if op != wire.OpAuthOK || err != nil {
		t.Fatalf("right token: got %s err %v, want AUTH_OK", op, err)
	}
	wt := rw3.hello(t)
	if wt.MaxBody == 0 {
		t.Fatalf("welcome lies about limits: %+v", wt)
	}
	rw3.send(t, wire.OpPing, nil)
	op, _, err = rw3.read(t, 3*time.Second)
	if op != wire.OpPong || err != nil {
		t.Fatalf("after the gate: got %s err %v, want PONG", op, err)
	}

	// An empty token is a shape error, not a wrong password: it dies on its
	// own bytes, before any gate question even gets asked.
	rw4 := dialRaw(t, srv.Addr())
	if _, eerr := wire.EncodeAuthenticate(wire.Authenticate{Token: ""}); eerr == nil {
		t.Fatalf("empty token should not encode")
	}
	rw4.send(t, wire.OpAuthenticate, nil)
	expectFatal(t, rw4, wire.CodeMalformed)
}

// helloRaw sends HELLO and waits for nothing; unlike raw.hello it tolerates
// any answer, because here the refusal IS the test.
func (rw *raw) helloRaw(t *testing.T) {
	t.Helper()
	hb, err := wire.EncodeHello(wire.Hello{Name: "probe", Label: "test"})
	if err != nil {
		t.Fatal(err)
	}
	rw.send(t, wire.OpHello, hb)
}

func TestAuthTokenlessYardAcceptsAndStaysHonest(t *testing.T) {
	srv, _ := newTestServer(t, func(cc *Config) { cc.Addr = "127.0.0.1:0" })

	// A well-formed knock on an open yard nods and moves on: nothing to
	// check, nothing to guess.
	rw := dialRaw(t, srv.Addr())
	sendAuth(t, rw, "whatever-token")
	op, _, err := rw.read(t, 3*time.Second)
	if op != wire.OpAuthOK || err != nil {
		t.Fatalf("tokenless yard: got %s err %v, want AUTH_OK", op, err)
	}
	w := rw.hello(t)
	if w.MaxBody == 0 {
		t.Fatalf("welcome lies about limits: %+v", w)
	}

	// A hand that knocks after the door opened is the wrong hand for this
	// house: fatal, even on a tokenless yard.
	ab, _ := wire.EncodeAuthenticate(wire.Authenticate{Token: "late"})
	rw.send(t, wire.OpAuthenticate, ab)
	expectFatal(t, rw, wire.CodeNotAllowed)
}

func TestHalfKeypairRefusedAtBoot(t *testing.T) {
	cert, key := selfSignedCert(t)
	if _, err := NewServer(Config{Addr: "127.0.0.1:0", CertFile: cert, Log: logDiscard()}); err == nil {
		t.Fatalf("cert without key booted: a half-open door must be refused")
	}
	if _, err := NewServer(Config{Addr: "127.0.0.1:0", KeyFile: key, Log: logDiscard()}); err == nil {
		t.Fatalf("key without cert booted: a half-open door must be refused")
	}
}

func TestTLSSpeaksTheSameFrames(t *testing.T) {
	cert, key := selfSignedCert(t)
	srv, _ := newTestServer(t, func(cc *Config) {
		cc.Addr = "127.0.0.1:0"
		cc.CertFile = cert
		cc.KeyFile = key
		cc.AuthToken = "shh"
	})

	// The wrapped socket carries the same ops: token, nod, welcome.
	rw := dialRawTLS(t, srv.Addr())
	sendAuth(t, rw, "shh")
	op, _, err := rw.read(t, 3*time.Second)
	if op != wire.OpAuthOK || err != nil {
		t.Fatalf("tls auth: got %s err %v, want AUTH_OK", op, err)
	}
	if w := rw.hello(t); w.MaxBody == 0 {
		t.Fatalf("welcome over tls lies about limits: %+v", w)
	}

	// And the same token discipline holds inside the wrap.
	rw2 := dialRawTLS(t, srv.Addr())
	rw2.helloRaw(t)
	expectFatal(t, rw2, wire.CodeNotAllowed)
}

// selfSignedCert writes a fresh lab certificate: localhost and 127.0.0.1
// on it, one day of life. Verification is toggled per-dial; the tests'
// job is the frames, not the PKI.
func selfSignedCert(t *testing.T) (certPath, keyPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "localhost"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("cert: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	certPath, keyPath = t.TempDir()+"/lab.pem", t.TempDir()+"/lab.key"
	writePEM(t, certPath, "CERTIFICATE", der)
	writePEM(t, keyPath, "EC PRIVATE KEY", keyDER)
	return certPath, keyPath
}

func writePEM(t *testing.T, path, kind string, der []byte) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func dialRawTLS(t *testing.T, addr string) *raw {
	t.Helper()
	conn, err := tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatalf("raw tls dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return &raw{conn: conn, r: wire.NewReader(conn, wire.MaxBodyBytes), w: wire.NewWriter(conn)}
}
