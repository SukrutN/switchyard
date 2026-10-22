// Command yardmaster is the yard's browser console: a read-only
// companion that dials the yard as an ordinary client — the same gate,
// the same wrap, the same refusals — and mirrors what the console
// family (§2.24–§2.27) and the KV reads (§2.19–§2.21) answer. The
// browser refreshes; the binary just serves honestly.
//
// It owns no levers: nothing in these pages writes to the yard, and
// quarantine is reported, not cleared. A console is a client too.
//
// Run it next to a running yard:
//
//	yardmaster [-addr 127.0.0.1:4780] [-auth TOKEN] [-tls] [-insecure]
//	           [-http 127.0.0.1:8060]
//
// The dial vocabulary matches spur verb for verb; -http is the
// console's own listening address on your machine.
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
	"time"

	"github.com/SukrutN/switchyard/internal/client"
	"github.com/SukrutN/switchyard/internal/lensweb"
)

const dialBudget = 5 * time.Second

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "yardmaster:", err)
		os.Exit(1)
	}
}

type opts struct {
	httpAddr string
	addr     string
	token    string
	tls      bool
	insecure bool
}

func run() error {
	var o opts
	var showHelp bool
	fs := flag.NewFlagSet("yardmaster", flag.ExitOnError)
	fs.StringVar(&o.httpAddr, "http", "127.0.0.1:8060", "the console's own address, browser side")
	fs.StringVar(&o.addr, "addr", "127.0.0.1:4780", "yard to watch")
	fs.StringVar(&o.token, "auth", "", "yard token, spoken before HELLO")
	fs.BoolVar(&o.tls, "tls", false, "wrap the session")
	fs.BoolVar(&o.insecure, "insecure", false,
		"accept any certificate (a lab switch, never an operating mode)")
	fs.BoolVar(&showHelp, "h", false, "print help")
	fs.Parse(os.Args[1:])
	if showHelp {
		fs.Usage()
		return nil
	}

	// the console closes one session per request: nothing can wedge.
	opener := func(ctx context.Context) (lensweb.Prober, error) {
		return client.Dial(ctx, o.addr, client.Options{
			Name:       "yardmaster",
			Label:      "console",
			Token:      o.token,
			TLS:        o.tls,
			SkipVerify: o.insecure,
		})
	}
	meta := lensweb.Meta{
		Target:  o.addr,
		TLS:     o.tls,
		SkipTLS: o.insecure,
		Tokened: o.token != "",
	}

	handler := lensweb.New(opener, meta, dialBudget, slog.Default())
	srv := &http.Server{
		Addr:              o.httpAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	boot(o)

	sctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-sctx.Done()
		shut := context.Background()
		_ = srv.Shutdown(shut)
	}()

	host := o.httpAddr
	fmt.Printf("the console is up: http://%s (watching %s%s)\n", host, o.addr, wrap(o.tls))
	fmt.Println("read-only. nothing here writes to the yard. Ctrl+C to stop.")
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	fmt.Println("the console is down - the yard was only ever being watched")
	return nil
}

func wrap(exactly bool) string {
	if exactly {
		return " over TLS"
	}
	return ""
}

// boot dials once to print the yard's first word, if it has one.
// Either way the console serves and keeps watching.
func boot(o opts) {
	ctx, cancel := context.WithTimeout(context.Background(), dialBudget)
	defer cancel()
	c, err := client.Dial(ctx, o.addr, client.Options{Name: "yardmaster", Label: "console"})
	if err != nil {
		fmt.Println("at boot the yard is dark:", err)
		return
	}
	defer c.Close()
	bctx, bcancel := context.WithTimeout(context.Background(), dialBudget)
	defer bcancel()
	ys, err := c.YardInfo(bctx)
	if err != nil {
		fmt.Println("at boot the yard answered the door but not questions:", err)
		return
	}
	fmt.Printf("at boot the yard answers: version %s, %d lanes\n", ys.Version, len(ys.Lanes))
}
