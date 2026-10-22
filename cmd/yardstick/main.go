// Command yardstick is the yard's measuring rod: reproducible numbers
// against one live yard, scenarios in the yard's own words:
//
//	ping     round-trip probes, p50/p95
//	pubsub   fan-out through the delivery queues, receipts fire-and-forget
//	journal  lane rows and KV sets, receipt per row — the durability number
//
// Run it against a THROWAWAY yard (a fresh data dir); it creates a
// scratch lane named after its own run and leaves the lane behind, so
// the dirt it makes is disposable. On a shared yard, point it politely
// and read the numbers with the noise.
//
// The rod speaks plainly: one journal publisher, receipts awaited, the
// yard's default settings. Faster numbers under bigger flags are stories
// about your disk, not about the yard.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/SukrutN/switchyard/internal/client"
)

const usage = `yardstick — the yard's measuring rod

usage:
  yardstick [ping|pubsub|journal] [flags]

Omitting the verb runs all three, in that order.

Common flags: -addr, -auth TOKEN, -tls, -insecure.
Bench flags:  -n probes/rows per scenario (default 2000), -pubs P (4),
              -subs S fan-out sids (4), -payload B (128).

A run creates one scratch lane named yt-<unixnano> and leaves it behind;
run against a throwaway yard (see scripts/bench.ps1) or accept the dirt
on your own.`

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "yardstick:", err)
		if _, ok := err.(usageError); ok {
			fmt.Fprintln(os.Stderr)
			fmt.Fprintln(os.Stderr, usage)
		}
		os.Exit(exitCode(err))
	}
}

type usageError struct{ why string }

func (u usageError) Error() string { return u.why }

func exitCode(err error) int {
	if _, ok := err.(usageError); ok {
		return 2
	}
	return 1
}

func run() error {
	fs := flag.NewFlagSet("yardstick", flag.ContinueOnError)
	var (
		addr     = fs.String("addr", "127.0.0.1:4780", "yard to measure")
		token    = fs.String("auth", "", "token if the yard demands one")
		tls      = fs.Bool("tls", false, "speak TLS to the yard")
		insecure = fs.Bool("insecure", false, "skip TLS certificate verification (lab toys)")
		n        = fs.Int("n", 2000, "probes/rows per scenario")
		pubs     = fs.Int("pubs", 4, "pubsub publishers in parallel")
		subs     = fs.Int("subs", 4, "pubsub fan-out sids")
		payload  = fs.Int("payload", 128, "payload bytes per row")
	)
	if err := fs.Parse(os.Args[1:]); err != nil {
		return err
	}
	if fs.NArg() > 1 {
		return usageError{"usage: yardstick [ping|pubsub|journal] [flags]"}
	}
	if *n <= 0 || *pubs <= 0 || *subs <= 0 || *payload <= 0 {
		return usageError{"-n, -pubs, -subs, -payload must be positive"}
	}
	verb := "all"
	if fs.NArg() == 1 {
		verb = fs.Arg(0)
	}
	switch verb {
	case "all", "ping", "pubsub", "journal":
	default:
		return usageError{"unknown scenario " + verb}
	}

	// The counting subscriber holds every delivery, so its buffer is the
	// run's honest cap: a number that leaned on dropped work would be a
	// story, not a measurement.
	const subBuf = 262_000
	if int64(*n)*int64(*subs) > subBuf-1000 {
		return usageError{fmt.Sprintf("fan-out load n×subs too deep for the counting reader's buffer; lower -n (cap is %s deliveries)", comma(subBuf-1000))}
	}

	opts := client.Options{
		Name:       "yardstick",
		Label:      "bench",
		Token:      *token,
		TLS:        *tls,
		SkipVerify: *insecure,
		DeliverBuf: subBuf,
		LaneBuf:    subBuf,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	c, err := client.Dial(ctx, *addr, opts)
	if err != nil {
		return err
	}
	defer c.Close()
	w := c.Welcome()
	fmt.Printf("yardstick against %s (max body %s bytes)\n", w.ServerLabel, comma(int(w.MaxBody)))

	cfg := bench{
		n:       *n,
		pubs:    *pubs,
		subs:    *subs,
		payload: *payload,
		pay:     makePayload(*payload),
		lane:    fmt.Sprintf("yt-%x", time.Now().UnixNano()),
		addr:    *addr,
		opts:    opts,
	}
	switch verb {
	case "all":
		if err := benchPing(c, cfg); err != nil {
			return fmt.Errorf("ping: %w", err)
		}
		if err := benchPubsub(c, cfg); err != nil {
			return fmt.Errorf("pubsub: %w", err)
		}
		return benchJournal(ctx, c, cfg)
	case "ping":
		return benchPing(c, cfg)
	case "pubsub":
		return benchPubsub(c, cfg)
	default: // journal
		return benchJournal(ctx, c, cfg)
	}
}

// bench is the run's one shape: every scenario shares it.
type bench struct {
	n       int
	pubs    int
	subs    int
	payload int
	pay     []byte
	lane    string
	addr    string
	opts    client.Options
}

func makePayload(n int) []byte {
	pay := make([]byte, n)
	for i := range pay {
		pay[i] = byte('a' + i%26)
	}
	return pay
}

// benchPing proves the line is alive and says how fast at rest.
func benchPing(c *client.Client, cfg bench) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	durs := make([]time.Duration, 0, cfg.n)
	start := time.Now()
	for i := 0; i < cfg.n; i++ {
		s := time.Now()
		if err := c.Ping(ctx); err != nil {
			return err
		}
		durs = append(durs, time.Since(s))
	}
	elapsed := time.Since(start)
	p50, p95 := percentiles(durs)
	fmt.Printf("%-8s %s ms p50, %s ms p95, %s probes/sec\n",
		"ping", ms(p50), ms(p95), comma(int(float64(cfg.n)/elapsed.Seconds())))
	return nil
}

// benchPubsub is the fan-out engine without receipts: P publishers fire N
// messages; S subscriber sids on one counting reader catch them all. The
// run refuses to print a number that leaned on a dropped delivery.
func benchPubsub(host *client.Client, cfg bench) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	target := int64(cfg.n) * int64(cfg.subs)
	var seen atomic.Int64
	done := make(chan struct{})
	go func() {
		for range host.Deliveries() {
			if seen.Add(1) == target {
				close(done)
			}
		}
		close(done) // deliveries closed = the session ended; the waiter reports
	}()
	defer close(done)

	for i := 0; i < cfg.subs; i++ {
		if err := host.Subscribe(uint32(i+1), ">"); err != nil {
			return fmt.Errorf("subscribe sid %d: %w", i+1, err)
		}
	}

	publishers := make([]*client.Client, cfg.pubs)
	for i := range publishers {
		pc, err := client.Dial(ctx, cfg.addr, cfg.opts)
		if err != nil {
			return fmt.Errorf("publisher %d dial: %w", i, err)
		}
		publishers[i] = pc
		defer pc.Close()
	}

	start := time.Now()
	var wg sync.WaitGroup
	for i, pc := range publishers {
		count := cfg.n / cfg.pubs
		if i == cfg.pubs-1 {
			count = cfg.n - cfg.n/cfg.pubs*(cfg.pubs-1)
		}
		wg.Add(1)
		go func(pc *client.Client, count int) {
			defer wg.Done()
			for j := 0; j < count; j++ {
				if err := pc.Publish("bench.row", cfg.pay); err != nil {
					fmt.Fprintf(os.Stderr, "yardstick: publish: %v\n", err)
					return
				}
			}
		}(pc, count)
	}
	wg.Wait()
	select {
	case <-done:
	case <-time.After(2 * time.Minute):
		return fmt.Errorf("fan-out stalled at %d/%d deliveries", seen.Load(), target)
	}
	elapsed := time.Since(start)
	if d := host.Dropped(); d != 0 {
		return fmt.Errorf("%d deliveries dropped mid-run; the rod refuses a number warmed by dropped work", d)
	}
	rate := float64(target) / elapsed.Seconds()
	fmt.Printf("%-8s %s (deliveries/sec) — %s messages × %d subs, %d B, %d publishers\n",
		"pubsub", comma(int(rate)), comma(cfg.n), cfg.subs, cfg.payload, cfg.pubs)
	return nil
}

// benchJournal runs the durable half — lane rows and KV keys on one
// scratch lane, receipt awaited each time. The yard fsyncs (by default)
// and answers after the bytes are on disk: this is a disk story told
// honestly.
func benchJournal(ctx context.Context, c *client.Client, cfg bench) error {
	if err := c.StreamCreate(ctx, cfg.lane); err != nil {
		return fmt.Errorf("scratch lane %s: %w", cfg.lane, err)
	}

	start := time.Now()
	for i := 0; i < cfg.n; i++ {
		if _, err := c.StreamPublish(ctx, cfg.lane, cfg.lane+".row", cfg.pay); err != nil {
			return fmt.Errorf("lane row %d: %w", i, err)
		}
	}
	rows := time.Since(start)

	start = time.Now()
	for i := 0; i < cfg.n; i++ {
		if _, err := c.KVSet(ctx, cfg.lane, "k"+strconv.Itoa(i), cfg.pay); err != nil {
			return fmt.Errorf("kv set %d: %w", i, err)
		}
	}
	keys := time.Since(start)

	perSec := func(d time.Duration) string { return comma(int(float64(cfg.n) / d.Seconds())) }
	fmt.Printf("%-8s %s rows/sec — %s rows, %d B, receipt each, one lane\n",
		"lane", perSec(rows), comma(cfg.n), cfg.payload)
	fmt.Printf("%-8s %s keys/sec — %s sets, %d B, receipt each\n",
		"kv", perSec(keys), comma(cfg.n), cfg.payload)
	return nil
}

// percentiles: p50 and p95 over sorted probe times.
func percentiles(durs []time.Duration) (p50, p95 time.Duration) {
	sort.Slice(durs, func(i, j int) bool { return durs[i] < durs[j] })
	p50 = durs[len(durs)/2]
	p95 = durs[len(durs)*95/100]
	return p50, p95
}

// ms speaks one duration in millisecond words, decimals for the small.
func ms(d time.Duration) string {
	v := float64(d) / float64(time.Millisecond)
	if v < 10 {
		return strconv.FormatFloat(v, 'f', 3, 64)
	}
	return strconv.FormatFloat(v, 'f', 1, 64)
}

// comma inserts grouping: 1,048,576. Locale-free by choice.
func comma(v int) string {
	s := strconv.Itoa(v)
	if v < 0 {
		return s
	}
	b := make([]byte, 0, len(s)+(len(s)-1)/3)
	for i := 0; i < len(s); i++ {
		if i > 0 && (len(s)-i)%3 == 0 {
			b = append(b, ',')
		}
		b = append(b, s[i])
	}
	return string(b)
}
