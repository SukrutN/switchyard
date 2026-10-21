// Command spur is the switchyard reference client CLI.
//
// Operating a yard means answering questions from a terminal, fast:
//
//	spur ping                              is the yard alive? how fast?
//	spur sub  'orders.*.paid' --count 3    watch a pattern
//	spur pub  'orders.9001.paid' 'ok'      fire one message
//
// Quote subjects in shells: '*' is a glob character and shells eat it.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"time"

	"github.com/SukrutN/switchyard/internal/client"
	"github.com/SukrutN/switchyard/internal/wire"
)

const usage = `spur — a switchyard client

usage:
  spur ping  [-addr host:port]
  spur sub   [-addr host:port] [-count N] PATTERN [PATTERN...]
  spur pub   [-addr host:port] [-reply SUBJECT] [-n N] SUBJECT [PAYLOAD]

Common flags: -addr (default 127.0.0.1:4780).

Subjects follow the switchyard charter: dot-separated tokens;
'*' matches one token, '>' trails and captures the rest.
Quote patterns in your shell. sid numbers station to station.`

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "spur:", err)
		if err == errUsage {
			fmt.Fprintln(os.Stderr)
			fmt.Fprintln(os.Stderr, usage)
		}
		os.Exit(exitCode(err))
	}
}

var errUsage = usageError{"bad usage"}

type usageError struct{ why string }

func (u usageError) Error() string { return u.why }

func exitCode(err error) int {
	switch err.(type) {
	case usageError:
		return 2
	default:
		return 1
	}
}

func run() error {
	if len(os.Args) < 2 {
		return errUsage
	}
	args, cmd := os.Args[2:], os.Args[1]
	switch cmd {
	case "ping":
		return cmdPing(args)
	case "sub":
		return cmdSub(args)
	case "pub":
		return cmdPub(args)
	case "-h", "help", "--help":
		fmt.Println(usage)
		return nil
	default:
		return fmt.Errorf("unknown command %q", cmd)
	}
}

// newFlagset owns the common flags so every subcommand speaks the same dial.
func newFlagset(name string) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	addr := fs.String("addr", "127.0.0.1:4780", "yard to talk to")
	return fs, addr
}

// dial performs the handshake; the returned client must Close.
func dial(addr string) (*client.Client, error) {
	return client.Dial(context.Background(), addr, client.Options{
		Name:  "spur",
		Label: "spur-cli",
	})
}

// watchErrors prints server refusals as they land; a fatal one aborts the
// command with an error. Runs on its own goroutine, wired to stop.
func watchErrors(c *client.Client, stop <-chan struct{}) <-chan error {
	out := make(chan error, 1)
	go func() {
		for {
			select {
			case e := <-c.Errors():
				fmt.Fprintf(os.Stderr, "spur: server %s: %s\n", codeName(e.Code), e.Message)
				if e.Fatal {
					out <- e
					return
				}
			case <-stop:
				out <- nil
				return
			}
		}
	}()
	return out
}

// toStruct bridges a signal channel into the generic done-channel shape the
// watcher consumes.
func toStruct(c <-chan os.Signal) <-chan struct{} {
	out := make(chan struct{})
	go func() {
		for range c {
			out <- struct{}{}
		}
	}()
	return out
}

// codeName mirrors wire.NameFor — spur prints names, not hex, to operators.
func codeName(code byte) string {
	name := map[byte]string{
		wire.CodeBadSubject:   "bad-subject",
		wire.CodeDupSub:       "duplicate-subscription",
		wire.CodeNoSub:        "no-such-subscription",
		wire.CodeTooLarge:     "payload-too-large",
		wire.CodeSlowConsumer: "slow-consumer",
		wire.CodeIdleTimeout:  "idle-timeout",
	}[code]
	if name == "" {
		return fmt.Sprintf("error-0x%02X", code)
	}
	return name
}

func cmdPing(args []string) error {
	fs, addr := newFlagset("ping")
	if err := fs.Parse(args); err != nil {
		return err
	}
	c, err := dial(*addr)
	if err != nil {
		return err
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	if err := c.Ping(ctx); err != nil {
		return err
	}
	w := c.Welcome()
	fmt.Printf("pong in %s from %s (accepts bodies to %d bytes)\n",
		time.Since(start).Round(100*time.Microsecond), w.ServerLabel, w.MaxBody)
	return nil
}

func cmdSub(args []string) error {
	fs, addr := newFlagset("sub")
	count := fs.Int("count", 0, "deliveries to print, 0 = until Ctrl+C")
	if err := fs.Parse(args); err != nil {
		return err
	}
	patterns := fs.Args()
	if len(patterns) == 0 {
		return usageError{"sub needs at least one pattern"}
	}

	c, err := dial(*addr)
	if err != nil {
		return err
	}
	defer c.Close()

	for i, p := range patterns {
		sid := uint32(i + 1)
		if err := c.Subscribe(sid, p); err != nil {
			return fmt.Errorf("subscribe %q: %w", p, err)
		}
	}
	fmt.Fprintf(os.Stderr, "spur: watching %d patterns - Ctrl+C to stop\n", len(patterns))

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	defer signal.Stop(sig)
	errs := watchErrors(c, toStruct(sig))

	limit := *count
	seen := 0
	for {
		select {
		case d := <-c.Deliveries():
			printDelivery(d)
			seen++
			if limit > 0 && seen >= limit {
				return nil
			}
		case e := <-errs:
			return e
		case <-sig:
			fmt.Fprintf(os.Stderr, "spur: done (%d delivered)\n", seen)
			return nil
		}
	}
}

func printDelivery(d client.Delivery) {
	show := d.Payload
	if len(show) > 300 {
		show = show[:300] // display cap only; nothing edits the bytes
	}
	if d.HasReply {
		fmt.Printf("[sid%x #%d] %s (reply->%s) %s\n", d.Sid, d.Seq, d.Subject, d.Reply, show)
		return
	}
	fmt.Printf("[sid%x #%d] %s %s\n", d.Sid, d.Seq, d.Subject, show)
}

func cmdPub(args []string) error {
	fs, addr := newFlagset("pub")
	reply := fs.String("reply", "", "reply subject embedded in the message")
	nf := fs.Int("n", 1, "publish the same message n times")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) < 1 || len(rest) > 2 {
		return usageError{"usage: spur pub [-n N] SUBJECT [PAYLOAD]"}
	}
	subject := rest[0]
	payload := []byte("")
	if len(rest) == 2 {
		payload = []byte(rest[1])
	}

	c, err := dial(*addr)
	if err != nil {
		return err
	}
	defer c.Close()

	for i := 0; i < *nf; i++ {
		if err := c.PublishReply(subject, *reply, payload); err != nil {
			return fmt.Errorf("publish: %w", err)
		}
	}
	if *nf == 1 {
		fmt.Printf("published %s (%d bytes)\n", subject, len(payload))
	} else {
		fmt.Printf("published %d× %s (%d bytes each)\n", *nf, subject, len(payload))
	}
	return nil
}
