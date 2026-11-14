// Command linehost hosts a sorting line for a switchyard yard.
//
// It consumes release work from a durable lane and speaks it to the
// line's Modbus TCP register surface — fluxline's host command block
// (docs/06-host-block.md in fluxline-plc) — then journals every verdict
// the floor hands back to the same lane:
//
//	linehost -addr 127.0.0.1:4780 -line 127.0.0.1:1502
//
// Work items are JSON on the release subject: {"id":"box-42","gate":2,
// "class":0} releases the next piece toward gate 2; "law":true releases
// per the floor's law. Verdicts come back as receipts: accepted, vetoed,
// refused, expired — the host can only request, the floor decides.
//
// The talker heartbeats HB_HOST at its cadence; freeze it (kill the
// process) and the line falls back to its own law within the watchdog
// window, alarm bit 5 saying so on the wire.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"time"

	"github.com/SukrutN/switchyard/internal/client"
	"github.com/SukrutN/switchyard/internal/linehost"
)

const usage = `linehost — host a sorting line from a switchyard lane

usage:
  linehost [-addr host:port] [-line host:port] [flags]

Work items ride the lane's release subject as JSON:
  {"id":"box-42","gate":2,"class":0}    release-override toward gate 2
  {"id":"box-43","law":true}            release-per-law
Gate codes: 1 L01, 2 L02, 3 L03, 4 RJ; class 0 = any, else the claim
the floor checks. Verdicts journal under the verdict subject as receipts:
{"id":...,"state":"accepted|vetoed|refused|expired",...}.

Common flags: -addr (yard, default 127.0.0.1:4780), -auth TOKEN,
-tls, -insecure (lab yards only), -line (line's Modbus TCP register
server, default 127.0.0.1:1502), -lane, -hb, -patience.`

func main() {
	if err := run(); err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		fmt.Fprintln(os.Stderr, "linehost:", err)
		os.Exit(1)
	}
}

func run() error {
	fs := flag.NewFlagSet("linehost", flag.ContinueOnError)
	addr := fs.String("addr", "127.0.0.1:4780", "yard address host:port")
	auth := fs.String("auth", "", "yard token (when it demands one)")
	tlsOn := fs.Bool("tls", false, "ride TLS to the yard")
	insecure := fs.Bool("insecure", false, "accept any certificate (lab yards only)")
	lineAddr := fs.String("line", "127.0.0.1:1502", "line's Modbus TCP register server")
	unit := fs.Int("unit", 1, "Modbus unit id")
	lane := fs.String("lane", "fluxline", "lane name")
	release := fs.String("release", "", "work subject (default LANE.release)")
	verdicts := fs.String("verdicts", "", "verdict subject (default LANE.verdict)")
	hb := fs.Duration("hb", 500*time.Millisecond, "heartbeat cadence (1-2 Hz per the contract)")
	patience := fs.Duration("patience", 90*time.Second, "how long a pending command may go unacked")
	if err := fs.Parse(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Println(usage)
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("linehost takes no arguments, got %v", fs.Args())
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	opts := client.Options{
		Name:       "linehost",
		Label:      "linehost",
		Token:      *auth,
		TLS:        *tlsOn,
		SkipVerify: *insecure,
	}
	yard, err := client.Dial(ctx, *addr, opts)
	if err != nil {
		return fmt.Errorf("dial yard %s: %w", *addr, err)
	}
	defer yard.Close()
	log.Info("yard dialed", "addr", *addr, "version", yard.Welcome().ServerLabel)

	t := linehost.New(linehost.Config{
		LineAddr: *lineAddr,
		Unit:     byte(*unit),
		Lane:     *lane,
		Release:  *release,
		Verdicts: *verdicts,
		HBEvery:  *hb,
		Patience: *patience,
		Log:      log,
	}, yard)
	err = t.Run(ctx)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
