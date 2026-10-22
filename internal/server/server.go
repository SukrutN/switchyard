package server

import (
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/SukrutN/switchyard/internal/wire"
)

// Version is the single source of the product string: WELCOME label, logs,
// readiness line, and the changelog all echo it.
const Version = "0.4.0"

// ServerLabel is what WELCOME advertises as the peer identity.
func ServerLabel() string { return "switchyard/" + Version }

// Config defaults exist so a plain NewServer(Config{Addr: ...}) is already a
// sane yard: 1 MiB frames, 512-deep delivery queues, heartbeats that keep a
// quiet client alive for Idle+Grace total silence.
const (
	DefaultMaxBody      = 1 << 20 // 1 MiB, below the 4 MiB protocol ceiling
	DefaultOutBuf       = 512
	DefaultCtlBuf       = 256 // receipts, pongs, refusals — never silently dropped
	DefaultIdle         = 30 * time.Second
	DefaultGrace        = 10 * time.Second
	DefaultWriteTimeout = 10 * time.Second
	DefaultAckWait      = 10 * time.Second // lane redelivery default (§7)
)

// Config is identical in meaning to its name. Zero values fall back to the
// defaults; the one field worth setting by hand is Addr. Lanes stay off
// until DataDir is set — a yard without a data dir refuses stream ops with
// STREAM_DISABLED rather than pretending to persist.
type Config struct {
	Addr         string        // listen spec, e.g. "127.0.0.1:4780"
	MaxBody      uint32        // frame body ceiling, ≤ wire.MaxBodyBytes
	OutBuf       int           // deliver-queue depth per session
	CtlBuf       int           // control-queue depth per session
	Idle         time.Duration // silence before the yard sends PING
	Grace        time.Duration // silence after PING before the yard closes
	WriteTimeout time.Duration // per-frame write budget
	DataDir      string        // enables durable lanes when non-empty
	AckWait      time.Duration // lane consumer default redelivery delay
	NoSync       bool          // skip per-record fsync (tests/dev only; NOT durable)
	// The gate and the wrap: AuthToken demands AUTHENTICATE before HELLO
	// (§2.28); CertFile+KeyFile together make every session ride TLS (§1).
	// Half a keypair is a boot refusal, not a silent downgrade.
	AuthToken string
	CertFile  string
	KeyFile   string
	Log       *slog.Logger
}

func (c *Config) withDefaults() {
	if c.MaxBody == 0 {
		c.MaxBody = DefaultMaxBody
	}
	if c.MaxBody > wire.MaxBodyBytes {
		c.MaxBody = wire.MaxBodyBytes
	}
	if c.OutBuf <= 0 {
		c.OutBuf = DefaultOutBuf
	}
	if c.CtlBuf <= 0 {
		c.CtlBuf = DefaultCtlBuf
	}
	if c.Idle <= 0 {
		c.Idle = DefaultIdle
	}
	if c.Grace <= 0 {
		c.Grace = DefaultGrace
	}
	if c.WriteTimeout <= 0 {
		c.WriteTimeout = DefaultWriteTimeout
	}
	if c.AckWait <= 0 {
		c.AckWait = DefaultAckWait
	}
	if c.Log == nil {
		c.Log = slog.Default()
	}
}

// Server owns the listener, the routing hub, and the session bookkeeping.
// One Server per process is the intended use; nothing is global.
type Server struct {
	cfg    Config
	hub    *Hub
	ln     net.Listener
	log    *slog.Logger
	mu     sync.Mutex // guards closed + the wg Add/intent pairing
	closed bool
	wg     sync.WaitGroup
}

// NewServer binds immediately — bring-up errors surface here, not at Run.
// Lane recovery happens before the first accept: a client that connects
// never races the replay.
func NewServer(cfg Config) (*Server, error) {
	cfg.withDefaults()
	if cfg.Addr == "" {
		cfg.Addr = "127.0.0.1:4780"
	}
	ln, err := listenTLS(cfg)
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", cfg.Addr, err)
	}
	syncEach := !cfg.NoSync
	lanes := newLaneRegistry(cfg.DataDir, syncEach, cfg.Log)
	hub := newHub(lanes)
	hub.token = cfg.AuthToken
	if lanes.enabled() {
		if n := lanes.load(); n > 0 {
			cfg.Log.Info("lanes recovered", "count", n, "dir", cfg.DataDir)
		}
	} else {
		cfg.Log.Info("lanes disabled", "reason", "no data dir configured")
	}
	return &Server{cfg: cfg, hub: hub, ln: ln, log: cfg.Log}, nil
}

// listenTLS binds the yard's listener: plain TCP unless both a certificate
// and a key are configured, in which case every accepted session rides TLS
// (§1) — same frames, same magic, same disciplines, a wrapped socket. One
// half of a keypair is refused at boot: a half-open door is a lie about
// being secured that only a clean startup error prevents.
func listenTLS(cfg Config) (net.Listener, error) {
	if cfg.CertFile == "" && cfg.KeyFile == "" {
		return net.Listen("tcp", cfg.Addr)
	}
	if cfg.CertFile == "" || cfg.KeyFile == "" {
		return nil, errors.New("tls needs both cert and key; one alone is refused at boot")
	}
	cert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("load tls keypair: %w", err)
	}
	return tls.Listen("tcp", cfg.Addr, &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	})
}

// Addr reports the bound spec — the tests use an ephemeral port and need the
// real answer, ":0" lies.
func (srv *Server) Addr() string { return srv.ln.Addr().String() }

// Hub exposes the routing center for operator introspection (console, tests).
// Not for runtime mutation by callers; the sessions own the mutations.
func (srv *Server) Hub() *Hub { return srv.hub }

// Run accepts connections until the listener closes. Transient accept
// failures retry with a small backoff; a poisoned listener gives up at 50.
func (srv *Server) Run() error {
	fails := 0
	for {
		conn, err := srv.ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			fails++
			if fails > 50 {
				return fmt.Errorf("accept: %w", err)
			}
			srv.log.Warn("accept failed, retrying", "err", err, "attempt", fails)
			time.Sleep(time.Duration(fails) * 10 * time.Millisecond)
			continue
		}
		fails = 0
		if tc, ok := conn.(*net.TCPConn); ok {
			_ = tc.SetKeepAlive(true) // spurs live long; OS-level liveness helps
		}
		go srv.serveConn(conn)
	}
}

// serveConn owns one connection end to end. Stop-safety: the closed flag and
// the WaitGroup are paired under mu, so Stop's Wait can never miss a
// session that is about to start.
func (srv *Server) serveConn(conn net.Conn) {
	srv.mu.Lock()
	if srv.closed {
		srv.mu.Unlock()
		conn.Close()
		return
	}
	srv.wg.Add(1)
	srv.mu.Unlock()
	defer srv.wg.Done()
	defer conn.Close()

	id := srv.hub.nextID()
	s := newSession(id, &srv.cfg, srv.hub, srv.log, conn)
	srv.hub.register(s)
	err := s.serve()
	s.detachAllLanes() // positions stay durable; sweeper goroutines stop here
	srv.hub.unregister(id)

	reason := "bye"
	if err != nil {
		reason = err.Error()
	}
	srv.log.Info("client out", "session", id, "name", s.peerName, "reason", reason)
}

// Stop closes the listener and every open connection, then waits for the
// session goroutines to land. Lanes close last: their journals are already
// fsync-per-record, so a Stop loses nothing — handles just go away tidily.
// Idempotent; safe to call from a signal path.
func (srv *Server) Stop() {
	srv.mu.Lock()
	srv.closed = true
	srv.mu.Unlock()
	_ = srv.ln.Close()
	srv.hub.closeAll() // readers are parked on deadlines; closing unblocks them now
	srv.wg.Wait()
	srv.hub.lanes.shutdown()
}
