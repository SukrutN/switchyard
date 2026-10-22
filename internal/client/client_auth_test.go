package client

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"testing"
	"time"

	"github.com/SukrutN/switchyard/internal/wire"
)

// The client's half of the auth pair (§2.28) and the TLS wrap (§1): the
// knock rides before HELLO, a refused gate surfaces as the yard's own
// ClientError, and a wrapped session carries the same frames after.

// gateOn mirrors the real yard's gate byte for byte: the right token nods,
// a wrong token dies, and a HELLO that arrives without any knock dies too.
func gateOn(y *fakeYard, op wire.Op, body []byte) bool {
	switch op {
	case wire.OpAuthenticate:
		a, err := wire.DecodeAuthenticate(body)
		if err != nil {
			replyFailure(y, wire.CodeMalformed, "auth body unreadable")
			return false
		}
		if a.Token != "shh" {
			replyFailure(y, wire.CodeNotAllowed, "that token did not open the gate")
			return false
		}
		nb, _ := wire.EncodeAuthOK(wire.AuthOK{})
		_ = y.wr.WriteFrame(wire.OpAuthOK, nb)
		return true
	default:
		replyFailure(y, wire.CodeNotAllowed, "the yard is tokened; send Authenticate first")
		return false
	}
}

func replyFailure(y *fakeYard, code byte, msg string) {
	eb, _ := wire.EncodeError(wire.ErrorResponse{Code: code, Message: msg, Fatal: true})
	_ = y.wr.WriteFrame(wire.OpError, eb)
}

func TestClientKnock(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// The right token opens the door and the session is ordinary.
	y := newFakeYardGated(t, gateOn, func(y *fakeYard, op wire.Op, body []byte) {
		if op == wire.OpPing {
			_ = y.wr.WriteFrame(wire.OpPong, nil)
		}
	})
	c := dialFake(t, y, Options{Token: "shh"})
	if err := c.Ping(ctx); err != nil {
		t.Fatalf("ping after knock: %v", err)
	}
	if w := c.Welcome(); w.ServerLabel != "fake/1" {
		t.Fatalf("welcome after knock: %+v", w)
	}

	// A wrong token dies at dial with the yard's own words.
	y2 := newFakeYardGated(t, gateOn, nil)
	_, err := Dial(ctx, y2.addr, Options{Token: "banana"})
	var ce ClientError
	if !errors.As(err, &ce) || ce.Code != wire.CodeNotAllowed || !ce.Fatal {
		t.Fatalf("wrong token dial = %v, want fatal NOT_ALLOWED ClientError", err)
	}

	// A client that never knocks meets the gate at HELLO.
	y3 := newFakeYardGated(t, gateOn, nil)
	_, err = Dial(ctx, y3.addr, Options{})
	if !errors.As(err, &ce) || ce.Code != wire.CodeNotAllowed {
		t.Fatalf("no-token dial = %v, want NOT_ALLOWED ClientError", err)
	}
}

func TestLateKnockDiesOnLiveSession(t *testing.T) {
	// The fake mirrors the real yard's post-hello answer: fatal refusal,
	// connection ends.
	y := newFakeYard(t, func(y *fakeYard, op wire.Op, body []byte) {
		if op == wire.OpAuthenticate {
			replyFailure(y, wire.CodeNotAllowed, "authenticate after hello; identity belongs to the door")
		}
	})
	c := dialFake(t, y, Options{Name: "probe"})

	// Identity belongs to the door: a second attempt mid-session is the
	// yard's fatal speech, surfaced on Errors() and the session closes.
	ab, _ := wire.EncodeAuthenticate(wire.Authenticate{Token: "late"})
	_ = c.wr.WriteFrame(wire.OpAuthenticate, ab)
	select {
	case e := <-c.Errors():
		if e.Code != wire.CodeNotAllowed || !e.Fatal {
			t.Fatalf("late knock = %+v, want fatal NOT_ALLOWED", e)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("late knock met silence, want the gate's answer")
	}
	select {
	case <-c.done:
	case <-time.After(3 * time.Second):
		t.Fatalf("fatal refusal did not end the session")
	}
}

// labCertificate is the client-package's own lab cert: one trusted for
// nothing, verified by nobody, SkipVerify's job.
func labCertificate(t *testing.T) *tls.Certificate {
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
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("cert: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	cert, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}),
	)
	if err != nil {
		t.Fatalf("keypair: %v", err)
	}
	return &cert
}

func TestClientTLSDialRidesTheSameFrames(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conf := &tls.Config{Certificates: []tls.Certificate{*labCertificate(t)}, MinVersion: tls.VersionTLS12}

	pong := func(y *fakeYard, op wire.Op, body []byte) {
		if op == wire.OpPing {
			_ = y.wr.WriteFrame(wire.OpPong, nil)
		}
	}

	// Wrapped, gateless, ordinary.
	y := newFakeYardTLS(t, conf, nil, pong)
	c := dialFake(t, y, Options{TLS: true, SkipVerify: true})
	if err := c.Ping(ctx); err != nil {
		t.Fatalf("ping over tls: %v", err)
	}

	// Wrapped and gated: token inside the wrap, exactly the §1/§2.28 story.
	y2 := newFakeYardTLS(t, conf, gateOn, pong)
	c2 := dialFake(t, y2, Options{TLS: true, SkipVerify: true, Token: "shh"})
	if err := c2.Ping(ctx); err != nil {
		t.Fatalf("ping over gated tls: %v", err)
	}

	// Wrapped and gated, wrong token: the gate's refusal survives the wrap.
	y3 := newFakeYardTLS(t, conf, gateOn, nil)
	_, err := Dial(ctx, y3.addr, Options{TLS: true, SkipVerify: true, Token: "banana"})
	var ce ClientError
	if !errors.As(err, &ce) || ce.Code != wire.CodeNotAllowed || !ce.Fatal {
		t.Fatalf("wrong token over tls = %v, want fatal NOT_ALLOWED", err)
	}
}
