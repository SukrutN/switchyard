// Command spur is the switchyard reference client CLI.
//
// Operating a yard means answering questions from a terminal, fast:
//
//	spur ping                              is the yard alive? how fast?
//	spur sub  'orders.*.paid' --count 3    watch a pattern
//	spur pub  'orders.9001.paid' 'ok'      fire one message
//	spur stream create orders              give the yard a lane to journal
//	spur stream push  orders orders.9001.paid ok
//	spur stream watch orders billing       replay + follow a durable consumer
//	spur yard                              the yardmaster's console view
//
// Quote subjects in shells: '*' is a glob character and shells eat it.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/SukrutN/switchyard/internal/client"
	"github.com/SukrutN/switchyard/internal/wire"
)

const usage = `spur — a switchyard client

usage:
  spur ping  [-addr host:port]
  spur sub   [-addr host:port] [-count N] PATTERN [PATTERN...]
  spur pub   [-addr host:port] [-reply SUBJECT] [-n N] SUBJECT [PAYLOAD]
  spur stream create    [-addr host:port] NAME
  spur stream delete    [-addr host:port] NAME
  spur stream push      [-addr host:port] STREAM SUBJECT [PAYLOAD]
  spur stream watch     [-addr host:port] [-filter PATTERN] [-ack=true/false] STREAM CONSUMER
  spur kv set   [-addr host:port] LANE KEY [PAYLOAD]
  spur kv get   [-addr host:port] LANE KEY
  spur kv del   [-addr host:port] LANE KEY
  spur kv keys  [-addr host:port] LANE
  spur yard              read the yard's console: version, uptime, lanes
  spur yard lane LANE    drill into one lane: seq, consumers, positions

Common flags: -addr (default 127.0.0.1:4780), -auth TOKEN (when the yard
demands one), -tls, and -insecure (self-signed lab yards only).

Subjects follow the switchyard charter: dot-separated tokens;
'*' matches one token, '>' trails and captures the rest. Streams pick a
name (letters, digits, '_', '-'); every message published to a stream
uses a SUBJECT whose FIRST token equals the stream name. Durable
consumers remember their position by name: call watch again and it
picks up where it stopped, redelivering anything the last session
never acknowledged.
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
	case "stream":
		return cmdStream(args)
	case "kv":
		return cmdKv(args)
	case "yard":
		return cmdYard(args)
	case "-h", "help", "--help":
		fmt.Println(usage)
		return nil
	default:
		return fmt.Errorf("unknown command %q", cmd)
	}
}

// dialOpts is the common dial vocabulary: where the yard is, how to
// knock on it, and whether the session rides TLS. Every subcommand gets
// the same flags, so one yard needs one spelling everywhere.
type dialOpts struct {
	addr     *string
	token    *string
	tls      *bool
	insecure *bool
}

// newFlagset owns the common flags so every subcommand speaks the same dial.
func newFlagset(name string) (*flag.FlagSet, *dialOpts) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	o := &dialOpts{
		addr:     fs.String("addr", "127.0.0.1:4780", "yard to talk to"),
		token:    fs.String("auth", "", "token if the yard demands one (§2.28)"),
		tls:      fs.Bool("tls", false, "speak TLS to the yard (§1)"),
		insecure: fs.Bool("insecure", false, "skip TLS certificate verification (lab toys, never production)"),
	}
	return fs, o
}

// dial performs the handshake — token first if one is set, wrapped in TLS
// if asked; refusals surface as the yard's own words via ClientError.
func dial(o *dialOpts) (*client.Client, error) {
	return client.Dial(context.Background(), *o.addr, client.Options{
		Name:       "spur",
		Label:      "spur-cli",
		Token:      *o.token,
		TLS:        *o.tls,
		SkipVerify: *o.insecure,
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
		wire.CodeMalformed:      "malformed-frame",
		wire.CodeUnknownOp:      "unknown-operation",
		wire.CodeBadSubject:     "bad-subject",
		wire.CodeDupSub:         "duplicate-subscription",
		wire.CodeNoSub:          "no-such-subscription",
		wire.CodeTooLarge:       "payload-too-large",
		wire.CodeSlowConsumer:   "slow-consumer",
		wire.CodeIdleTimeout:    "idle-timeout",
		wire.CodeStreamUnknown:  "stream-unknown",
		wire.CodeStreamExists:   "stream-exists",
		wire.CodeBadStreamName:  "bad-stream-name",
		wire.CodeStreamSubject:  "stream-subject-mismatch",
		wire.CodeDupConsumer:    "duplicate-consumer",
		wire.CodeNoConsumer:     "no-such-consumer",
		wire.CodeStreamDisabled: "streams-disabled",
		wire.CodeBadKey:         "bad-key",
		wire.CodeServerFault:    "server-fault",
		wire.CodeNotAllowed:     "not-allowed",
	}[code]
	if name == "" {
		return fmt.Sprintf("error-0x%02X", code)
	}
	return name
}

func cmdPing(args []string) error {
	fs, cf := newFlagset("ping")
	if err := fs.Parse(args); err != nil {
		return err
	}
	c, err := dial(cf)
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
	fs, cf := newFlagset("sub")
	count := fs.Int("count", 0, "deliveries to print, 0 = until Ctrl+C")
	if err := fs.Parse(args); err != nil {
		return err
	}
	patterns := fs.Args()
	if len(patterns) == 0 {
		return usageError{"sub needs at least one pattern"}
	}

	c, err := dial(cf)
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
	fs, cf := newFlagset("pub")
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

	c, err := dial(cf)
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

// ---- streams: the yard's journal, one lane at a time ----

func cmdStream(args []string) error {
	if len(args) < 1 {
		return usageError{"stream needs a subcommand: create, delete, push, watch"}
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "create":
		return cmdStreamCreate(rest)
	case "delete":
		return cmdStreamDelete(rest)
	case "push":
		return cmdStreamPush(rest)
	case "watch":
		return cmdStreamWatch(rest)
	default:
		return fmt.Errorf("unknown stream subcommand %q", sub)
	}
}

func cmdStreamCreate(args []string) error {
	fs, cf := newFlagset("stream create")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return usageError{"usage: spur stream create NAME"}
	}
	c, err := dial(cf)
	if err != nil {
		return err
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.StreamCreate(ctx, fs.Arg(0)); err != nil {
		return fmt.Errorf("create %q: %w", fs.Arg(0), err)
	}
	fmt.Printf("lane %s ready - records journal from seq 1\n", fs.Arg(0))
	return nil
}

func cmdStreamDelete(args []string) error {
	fs, cf := newFlagset("stream delete")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return usageError{"usage: spur stream delete NAME"}
	}
	c, err := dial(cf)
	if err != nil {
		return err
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.StreamDelete(ctx, fs.Arg(0)); err != nil {
		return fmt.Errorf("delete %q: %w", fs.Arg(0), err)
	}
	fmt.Printf("lane %s deleted - journal and consumer positions gone\n", fs.Arg(0))
	return nil
}

func cmdStreamPush(args []string) error {
	fs, cf := newFlagset("stream push")
	reply := fs.String("reply", "", "reply subject embedded in the message")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) < 2 || len(rest) > 3 {
		return usageError{"usage: spur stream push STREAM SUBJECT [PAYLOAD]"}
	}
	stream, subject := rest[0], rest[1]
	payload := []byte("")
	if len(rest) == 3 {
		payload = []byte(rest[2])
	}
	if parts := strings.SplitN(subject, ".", 2); parts[0] != stream {
		return usageError{fmt.Sprintf("subject %q's first token is %q; a lane's subject must start with the lane name %q", subject, parts[0], stream)}
	}

	c, err := dial(cf)
	if err != nil {
		return err
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	seq, err := c.StreamPublishReply(ctx, stream, subject, *reply, payload)
	if err != nil {
		return fmt.Errorf("push %s: %w", subject, err)
	}
	fmt.Printf("stored at seq %d in lane %s (%d bytes on the journal)\n", seq, stream, len(payload))
	return nil
}

func cmdStreamWatch(args []string) error {
	fs, cf := newFlagset("stream watch")
	filter := fs.String("filter", "", "subscription pattern to narrow delivery, e.g. 'orders.paid.>'")
	count := fs.Int("count", 0, "deliveries to print, 0 = until Ctrl+C")
	ack := fs.Bool("ack", true, "acknowledge each delivery after printing (off = leave pending)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 2 {
		return usageError{"usage: spur stream watch [-filter PATTERN] [-count N] [-ack] STREAM CONSUMER"}
	}
	stream, consumer := fs.Arg(0), fs.Arg(1)

	c, err := dial(cf)
	if err != nil {
		return err
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	next, wait, err := c.StreamAttach(ctx, stream, consumer, 1, 0, *filter)
	if err != nil {
		return fmt.Errorf("attach %q/%q: %w", stream, consumer, err)
	}
	fmt.Fprintf(os.Stderr, "spur: watching lane %s as consumer %q (next %d, ack wait %s) - Ctrl+C to stop\n",
		stream, consumer, next, wait)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	defer signal.Stop(sig)
	errs := watchErrors(c, toStruct(sig))

	seen := 0
	for {
		select {
		case d := <-c.LaneDeliveries():
			printLaneDelivery(stream, d)
			if *ack {
				if err := c.LaneAck(d.Sid, d.Seq); err != nil {
					return fmt.Errorf("ack %d: %w", d.Seq, err)
				}
			}
			seen++
			if *count > 0 && seen >= *count {
				fmt.Fprintf(os.Stderr, "spur: done (%d delivered)\n", seen)
				return nil
			}
		case e := <-errs:
			return e
		case <-sig:
			fmt.Fprintf(os.Stderr, "spur: done (%d delivered, consumer %q remembers its position)\n", seen, consumer)
			return nil
		}
	}
}

func printLaneDelivery(stream string, d client.LaneDelivery) {
	show := d.Payload
	if len(show) > 300 {
		show = show[:300] // display cap only; nothing edits the bytes
	}
	if d.HasReply {
		fmt.Printf("[lane %s #%d] %s (reply->%s) %s\n", stream, d.Seq, d.Subject, d.Reply, show)
		return
	}
	fmt.Printf("[lane %s #%d] %s %s\n", stream, d.Seq, d.Subject, show)
}

// ---- kv: the same lanes, one key at a time ----

func cmdKv(args []string) error {
	if len(args) < 1 {
		return usageError{"kv needs a subcommand: set, get, del, keys"}
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "set":
		return cmdKvSet(rest)
	case "get":
		return cmdKvGet(rest)
	case "del", "delete":
		return cmdKvDel(rest)
	case "keys", "list":
		return cmdKvKeys(rest)
	default:
		return fmt.Errorf("unknown kv subcommand %q", sub)
	}
}

func cmdKvSet(args []string) error {
	fs, cf := newFlagset("kv set")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 2 && fs.NArg() != 3 {
		return usageError{"usage: spur kv set LANE KEY [PAYLOAD]"}
	}
	lane, key := fs.Arg(0), fs.Arg(1)
	payload := []byte("")
	if fs.NArg() == 3 {
		payload = []byte(fs.Arg(2))
	}
	c, err := dial(cf)
	if err != nil {
		return err
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	seq, err := c.KVSet(ctx, lane, key, payload)
	if err != nil {
		return fmt.Errorf("set %s/%s: %w", lane, key, err)
	}
	fmt.Printf("stored at seq %d (key %s, %d bytes in lane %s)\n", seq, key, len(payload), lane)
	return nil
}

func cmdKvGet(args []string) error {
	fs, cf := newFlagset("kv get")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 2 {
		return usageError{"usage: spur kv get LANE KEY"}
	}
	lane, key := fs.Arg(0), fs.Arg(1)
	c, err := dial(cf)
	if err != nil {
		return err
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	v, err := c.KVGet(ctx, lane, key)
	if err != nil {
		return fmt.Errorf("get %s/%s: %w", lane, key, err)
	}
	if !v.Found {
		return fmt.Errorf("key %s/%s is empty (never set, or deleted)", lane, key)
	}
	if len(v.Payload) == 0 {
		fmt.Fprintf(os.Stderr, "spur: value is empty; the key exists, written at seq %d\n", v.Seq)
		return nil
	}
	if n := len(v.Payload); n > 300 {
		v.Payload = v.Payload[:300] // display cap only; nothing edits the bytes
		fmt.Fprintf(os.Stderr, "spur: displaying first 300 of %d bytes (written at seq %d)\n", n, v.Seq)
	}
	fmt.Println(string(v.Payload))
	return nil
}

func cmdKvDel(args []string) error {
	fs, cf := newFlagset("kv del")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 2 {
		return usageError{"usage: spur kv del LANE KEY"}
	}
	lane, key := fs.Arg(0), fs.Arg(1)
	c, err := dial(cf)
	if err != nil {
		return err
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	seq, err := c.KVDelete(ctx, lane, key)
	if err != nil {
		return fmt.Errorf("del %s/%s: %w", lane, key, err)
	}
	fmt.Printf("tombstone at seq %d (key %s - writes replay, this delete does too)\n", seq, key)
	return nil
}

func cmdKvKeys(args []string) error {
	fs, cf := newFlagset("kv keys")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return usageError{"usage: spur kv keys LANE"}
	}
	lane := fs.Arg(0)
	c, err := dial(cf)
	if err != nil {
		return err
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	keys, err := c.KVKeys(ctx, lane)
	if err != nil {
		return fmt.Errorf("keys %s: %w", lane, err)
	}
	for _, key := range keys {
		fmt.Println(key)
	}
	return nil
}

// ---- yard: the yardmaster's console (§2.24–§2.27) ----

// cmdYard dispatches the read-only console. The lane drill-down is a
// subcommand so its flags follow the house order (flags after the verb):
// `spur yard` and `spur yard lane -addr X orders` both parse naturally.
func cmdYard(args []string) error {
	if len(args) > 0 && args[0] == "lane" {
		return cmdYardLane(args[1:])
	}
	return cmdYardSummary(args)
}

func cmdYardSummary(args []string) error {
	fs, cf := newFlagset("yard")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return usageError{"usage: spur yard  (drill down with: spur yard lane LANE)"}
	}
	c, err := dial(cf)
	if err != nil {
		return err
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	y, err := c.YardInfo(ctx)
	if err != nil {
		return fmt.Errorf("yard: %w", err)
	}
	printYard(y)
	return nil
}

func cmdYardLane(args []string) error {
	fs, cf := newFlagset("yard lane")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return usageError{"usage: spur yard lane LANE"}
	}
	lane := fs.Arg(0)
	c, err := dial(cf)
	if err != nil {
		return err
	}
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	l, err := c.LaneInfo(ctx, lane)
	if err != nil {
		return fmt.Errorf("lane %s: %w", lane, err)
	}
	printLaneState(l)
	return nil
}

func printYard(y client.YardState) {
	fmt.Printf("yard %s - up %s, %d sessions, %d lanes (%d quarantined)\n",
		y.Version, humanUptime(y.UptimeSec), y.Sessions, len(y.Lanes), len(y.Quarantined))
	if len(y.Lanes) == 0 {
		fmt.Println("  (no lanes - a memory-only yard journals nothing)")
	}
	q := make(map[string]bool, len(y.Quarantined))
	for _, name := range y.Quarantined {
		q[name] = true
	}
	for _, row := range y.Lanes {
		if q[row.Name] {
			fmt.Printf("  %-16s seq %-8d QUARANTINED - writes refused until restart\n", row.Name, row.Seq)
		} else {
			fmt.Printf("  %-16s seq %d\n", row.Name, row.Seq)
		}
	}
}

func printLaneState(l client.LaneState) {
	posture := "healthy"
	if l.Quarantined {
		posture = "QUARANTINED - writes refused until restart"
	}
	fmt.Printf("lane %s - seq %d, journal %d bytes, %d keys, %s\n",
		l.Lane, l.Seq, l.JournalBytes, l.KeyCount, posture)
	if len(l.Consumers) == 0 {
		fmt.Println("  (no consumers - attach one with: spur stream watch)")
	}
	for _, c := range l.Consumers {
		spot := "detached"
		if c.Attached {
			spot = "attached"
		}
		fmt.Printf("  %-16s floor %-6d pending %-4d %s\n", c.Name, c.Floor, c.Pending, spot)
	}
}

// humanUptime turns the summary's whole seconds into speech a terminal
// reader parses at a glance: 77s, 2m3s, 1h2m3s, 5d4h2m.
func humanUptime(sec uint64) string {
	d := sec / 86400
	h := sec % 86400 / 3600
	m := sec % 3600 / 60
	s := sec % 60
	switch {
	case d > 0:
		return fmt.Sprintf("%dd%dh%dm", d, h, m)
	case h > 0:
		return fmt.Sprintf("%dh%dm%ds", h, m, s)
	case m > 0:
		return fmt.Sprintf("%dm%ds", m, s)
	default:
		return fmt.Sprintf("%ds", s)
	}
}
