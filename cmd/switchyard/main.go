// Command switchyard runs the broker: a yard that accepts TCP sessions,
// routes publishes to subscriptions, and tells the truth about why it
// refuses anything.
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/SukrutN/switchyard/internal/server"
)

func main() {
	var (
		addr     = flag.String("addr", "127.0.0.1:4780", "listen spec: host:port")
		maxBody  = flag.Int64("max-body", int64(server.DefaultMaxBody), "frame body ceiling in bytes")
		logLevel = flag.String("log-level", "info", "debug|info|warn|error")
		// Heartbeats are here for operators who care; defaults match code.
		idle  = flag.Duration("idle", server.DefaultIdle, "silence before the yard pings a client")
		grace = flag.Duration("grace", server.DefaultGrace, "silence after the ping before the yard closes")
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
		Idle:    *idle,
		Grace:   *grace,
		Log:     log,
	}
	srv, err := server.NewServer(cfg)
	if err != nil {
		log.Error("start failed", "err", err)
		os.Exit(1)
	}

	runErr := make(chan error, 1)
	go func() { runErr <- srv.Run() }()

	log.Info("yard open",
		"addr", srv.Addr(),
		"maxBody", cfg.MaxBody,
		"idle", *idle, "grace", *grace,
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
	done := make(chan struct{})
	go func() { srv.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		log.Warn("stop did not land in 5s; exiting")
	}
	fmt.Fprintf(os.Stderr, "switchyard: closed\n")
}
