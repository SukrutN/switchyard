// Command switchyard runs the broker: a yard that accepts TCP sessions,
// routes publishes to subscriptions, and tells the truth about why it
// refuses anything.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/SukrutN/switchyard/internal/metrics"
	"github.com/SukrutN/switchyard/internal/server"
)

func main() {
	var (
		addr     = flag.String("addr", "127.0.0.1:4780", "listen spec: host:port")
		maxBody  = flag.Int64("max-body", int64(server.DefaultMaxBody), "frame body ceiling in bytes")
		logLevel = flag.String("log-level", "info", "debug|info|warn|error")
		// Lanes stay off without a data dir: durability needs a home.
		dataDir = flag.String("data-dir", "", "enable durable streams; journal dir (e.g. ./data)")
		ackWait = flag.Duration("ack-wait", server.DefaultAckWait, "lane redelivery default per consumer, overridable on attach")
		// Heartbeats are here for operators who care; defaults match code.
		idle  = flag.Duration("idle", server.DefaultIdle, "silence before the yard pings a client")
		grace = flag.Duration("grace", server.DefaultGrace, "silence after the ping before the yard closes")
		// The gate and the wrap: a token demands AUTHENTICATE before HELLO;
		// cert+key together wrap every session in TLS.
		authToken = flag.String("auth", "", "demand this shared token before HELLO")
		certFile  = flag.String("cert", "", "TLS certificate PEM; requires -key")
		keyFile   = flag.String("key", "", "TLS private key PEM; requires -cert")
		// The metrics port: the yard's own facts in Prometheus text, plus a
		// health page, on a port the scraper can reach. Empty keeps it off.
		metricsAddr  = flag.String("metrics", "", "serve /metrics and /health on this host:port (e.g. 127.0.0.1:4781)")
		metricsToken = flag.String("metrics-auth", "", "token the metrics port demands as a Bearer header; empty means open")
	)
	flag.Parse()

	lvl := slog.LevelInfo
	switch *logLevel {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lvl}))

	cfg := server.Config{
		Addr:    *addr,
		MaxBody: uint32(*maxBody),
		DataDir: *dataDir,
		AckWait: *ackWait,
		Idle:    *idle,
		Grace:   *grace,
		// The gate and the wrap: both live in one config so the yard's
		// secrets are set once, at boot, nowhere else.
		AuthToken: *authToken,
		CertFile:  *certFile,
		KeyFile:   *keyFile,
		Log:       log,
	}
	srv, err := server.NewServer(cfg)
	if err != nil {
		log.Error("start failed", "err", err)
		os.Exit(1)
	}

	runErr := make(chan error, 1)
	go func() { runErr <- srv.Run() }()

	// The metrics port rides alongside the yard: the same facts the console
	// answers, in Prometheus text. It fails the process if it cannot bind,
	// because a yard that promised its scraper a page must keep it.
	var metricsSrv *http.Server
	if *metricsAddr != "" {
		metricsSrv = &http.Server{
			Addr:              *metricsAddr,
			Handler:           metrics.Handler(srv.Metrics(), srv.YardStats, *metricsToken),
			ReadHeaderTimeout: 5 * time.Second,
		}
		go func() {
			log.Info("metrics open", "addr", *metricsAddr, "auth", onOff(*metricsToken))
			if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("metrics port failed", "err", err)
				runErr <- err
			}
		}()
	}

	lanes := "off"
	if *dataDir != "" {
		lanes = *dataDir
	}
	auth := "off"
	if *authToken != "" {
		auth = "on"
	}
	wrap := "off"
	if *certFile != "" || *keyFile != "" {
		wrap = "on"
	}
	keep := "off"
	if *metricsAddr != "" {
		keep = *metricsAddr
	}
	log.Info("yard open",
		"addr", srv.Addr(),
		"maxBody", cfg.MaxBody,
		"lanes", lanes,
		"idle", *idle, "grace", *grace,
		"auth", auth, "tls", wrap,
		"metrics", keep,
		"version", server.Version,
	)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-runErr:
		if err != nil {
			log.Error("run ended with error", "err", err)
		}
	case sig := <-stop:
		log.Info("shutting down", "signal", sig.String())
	}
	if metricsSrv != nil {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = metricsSrv.Shutdown(shutdownCtx)
	}
	done := make(chan struct{})
	go func() { srv.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		log.Warn("stop did not land in 5s; exiting")
	}
	fmt.Fprintf(os.Stderr, "switchyard: closed\n")
}

// onOff words a flag for the boot line.
func onOff(value string) string {
	if value != "" {
		return "on"
	}
	return "off"
}
