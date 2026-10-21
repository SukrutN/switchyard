// Package wire is the only definition of the Switchyard line protocol.
// Both the server and every client speak through this package, so the two
// sides can never drift apart: if an op changes shape, one file changes.
//
// Frame layout (big-endian everywhere):
//
//	0..1  magic "SY" (0x53 0x59)
//	2     protocol version (0x01)
//	3     op code
//	4..7  body length, u32
//	8..   body, op-specific, codec in codec.go
//
// The magic pair exists for post-mortem debugging on the wire (hex dumps become
// navigable), not for resync: after a desync the byte offset is unknowable, so
// a bad magic is always fatal. See docs/PROTOCOL.md for the full rationale.
package wire

import "fmt"

// Protocol constants. Bumping Version requires a new op-level design review:
// servers and clients reject mismatched versions with a controlled error.
const (
	Magic1 = 0x53 // 'S'
	Magic2 = 0x59 // 'Y'
	// Version is the current protocol revision.
	Version = 0x01
	// HeaderLen is magic + version + op + body length.
	HeaderLen = 8
	// MaxBodyBytes is the protocol-wide ceiling. The server default matches;
	// a server may configure a lower limit (negotiated via WELCOME), never higher.
	MaxBodyBytes = 4 * 1024 * 1024
)

// Body field limits. Codec and validation share these constants so clients and
// servers cannot disagree about sizes at runtime.
const (
	MaxSubjectLen  = 255
	MaxTokenCount  = 32
	MaxTokenLen    = 64
	MaxReplyLen    = 255
	MaxClientName  = 64
	MaxSpeechLabel = 16 // client's "spoken by" tag, e.g. "cli", "go-sdk"
	MaxServerLabel = 48
	// MaxStreamName caps stream and consumer names (§3.1): a subject-charter
	// token under the filesystem-safe charset. Names become directory names,
	// so len here and charset-server-side are two halves of one rule.
	MaxStreamName = 64
	// MaxKeyLen caps KV keys (§3.2). Keys live inside journal record bodies,
	// never as directories, so the length cap is the whole wire half; the
	// charset half rides with the server like every charter's byte rule.
	MaxKeyLen = 128
)

// Policy flags inside bodies. Bit 0 of the flag byte means "the optional
// reply subject is present" — that flag is deliberately the same bit in every
// body that carries one, so client code can branch on a single convention.
// Bit 1 follows the same convention for optional filter patterns on consumer
// bodies: present or absent, never present-and-empty.
const (
	FlagReplyPresent  = 0x01
	FlagFilterPresent = 0x02
	// FlagKVFound marks a KV_VALUE body whose key holds a live value; only
	// found answers carry a payload section (§2.22). Bit 0, family-scoped
	// like every flag byte above it.
	FlagKVFound = 0x01
	// FlagLaneQuarantined marks a LANE_STATE body whose lane's writes have
	// failed once and it now refuses more until restart (§2.27).
	FlagLaneQuarantined = 0x01
	// FlagConsumerAttached marks one LANE_STATE consumer row whose session
	// is live right now; clear means parked, holding its floor (§2.27).
	FlagConsumerAttached = 0x01
	// FlagFatal marks an Error frame whose receipt must end the session.
	FlagFatal = 0x01
)

// Op is one of the line's operations. Numeric values are part of the protocol;
// see docs/PROTOCOL.md §1 before renumbering anything.
type Op byte

// Frame ops, version 1.
const (
	OpHello     Op = 0x01 // client→server: open a session
	OpWelcome   Op = 0x02 // server→client: handshake ack, carries server limits
	OpPing      Op = 0x03 // client→server: liveness probe
	OpPong      Op = 0x04 // server→client: liveness ack; also sent unsolicited
	OpPublish   Op = 0x05 // client→server: a message for the yard
	OpSubscribe Op = 0x06 // client→server: open a subscription
	OpUnsub     Op = 0x07 // client→server: close a subscription
	OpDeliver   Op = 0x08 // server→client: a message on one of your spurs
	OpError     Op = 0x09 // server→client: the server refused something, with a reason
	OpBye       Op = 0x0A // both directions: graceful close, no body
)

// Frame ops, stream family (§2.8–§2.17). Appended numbers, untouched older
// ones — the op table grows by appending and never re-means an op.
const (
	OpStreamCreate   Op = 0x0B // client→server: open a durable lane
	OpStreamReady    Op = 0x0C // server→client: lane opened, next seq advertised
	OpStreamPublish  Op = 0x0D // client→server: journal a message on a lane
	OpStreamReceipt  Op = 0x0E // server→client: journal write confirmed, seq assigned
	OpConsumerAttach Op = 0x0F // client→server: attach (or resume) a push consumer
	OpConsumerReady  Op = 0x10 // server→client: consumer live, next delivery seq advertised
	OpStreamDeliver  Op = 0x11 // server→client: one lane message for one consumer
	OpAck            Op = 0x12 // client→server: consumer ack, one sequence at a time
	OpStreamDelete   Op = 0x13 // client→server: delete a lane and its positions
	OpStreamGone     Op = 0x14 // server→client: delete confirmed (to attached consumers)
)

// Frame ops, KV family (§2.18–§2.23). Second append: KV records journal
// alongside stream messages under the same lanes, so the family reuses the
// receipt and keeps its numbers clear of the first family entirely.
const (
	OpKVSet     Op = 0x15 // client→server: journal a key-value pair on a lane
	OpKVGet     Op = 0x16 // client→server: read one key
	OpKVDelete  Op = 0x17 // client→server: journal a tombstone for one key
	OpKVKeys    Op = 0x18 // client→server: list a lane's live keys
	OpKVValue   Op = 0x19 // server→client: KV_GET answer, found flag included
	OpKVKeyList Op = 0x1A // server→client: KV_KEYS answer, sorted keys
)

// Frame ops, console family (§2.24–§2.27). Third append: the yardmaster's
// read-only view of the yard — one summary op and one drill-down, each with
// its own state reply. No mutation rides these ops; the console is a lens,
// not a lever.
const (
	OpYardInfo  Op = 0x1B // client→server: ask for the yard's summary
	OpYardState Op = 0x1C // server→client: version, uptime, lanes, quarantined
	OpLaneInfo  Op = 0x1D // client→server: ask one lane's detail
	OpLaneState Op = 0x1E // server→client: seq, journal bytes, keys, consumers
)

// String makes operator-facing logs name operations instead of showing bytes.
func (o Op) String() string {
	switch o {
	case OpHello:
		return "HELLO"
	case OpWelcome:
		return "WELCOME"
	case OpPing:
		return "PING"
	case OpPong:
		return "PONG"
	case OpPublish:
		return "PUBLISH"
	case OpSubscribe:
		return "SUBSCRIBE"
	case OpUnsub:
		return "UNSUBSCRIBE"
	case OpDeliver:
		return "DELIVER"
	case OpError:
		return "ERROR"
	case OpBye:
		return "BYE"
	case OpStreamCreate:
		return "STREAM_CREATE"
	case OpStreamReady:
		return "STREAM_READY"
	case OpStreamPublish:
		return "STREAM_PUBLISH"
	case OpStreamReceipt:
		return "STREAM_RECEIPT"
	case OpConsumerAttach:
		return "CONSUMER_ATTACH"
	case OpConsumerReady:
		return "CONSUMER_READY"
	case OpStreamDeliver:
		return "STREAM_DELIVER"
	case OpAck:
		return "ACK"
	case OpStreamDelete:
		return "STREAM_DELETE"
	case OpStreamGone:
		return "STREAM_GONE"
	case OpKVSet:
		return "KV_SET"
	case OpKVGet:
		return "KV_GET"
	case OpKVDelete:
		return "KV_DELETE"
	case OpKVKeys:
		return "KV_KEYS"
	case OpKVValue:
		return "KV_VALUE"
	case OpKVKeyList:
		return "KV_KEYLIST"
	case OpYardInfo:
		return "YARD_INFO"
	case OpYardState:
		return "YARD_STATE"
	case OpLaneInfo:
		return "LANE_INFO"
	case OpLaneState:
		return "LANE_STATE"
	default:
		return fmt.Sprintf("OP(0x%02X)", byte(o))
	}
}

// Frame is one line transaction: an op plus its (possibly empty) body.
type Frame struct {
	Op   Op
	Body []byte
}

// ErrorResponse carries a server refusal back to the client. Code values are
// protocol-stable (docs/PROTOCOL.md §6); the message is for humans, and its
// wording may change without a protocol bump.
type ErrorResponse struct {
	Code    byte
	Message string
	Fatal   bool // server will close the session after sending this
}

// Client ops bodies.

// Hello is the handshake opener. Name is display-only for logs; Label says
// which client family is speaking ("cli", "go-sdk") so the server can flag
// client-specific behavior drift early.
type Hello struct {
	Name  string
	Label string
}

// Welcome is the handshake ack and the one true definition of server limits:
// whatever MaxBody says here outranks the constant.
type Welcome struct {
	ServerLabel string
	MaxBody     uint32
}

// Publish is one message entering the yard. Subject must be concrete
// (no wildcards). Reply is optional (FlagReplyPresent).
type Publish struct {
	Subject string
	Reply   string
	Payload []byte
	// HasReply records whether Reply was set on encode; decode fills it.
	HasReply bool
}

// Subscribe opens a subscription. Sid is client-assigned and the server echoes
// it on every Deliver; the client owns the mapping from Sid to its own state.
type Subscribe struct {
	Pattern string
	Sid     uint32
}

// Unsub closes a subscription.
type Unsub struct {
	Sid uint32
}

// Deliver is one message leaving the yard toward one subscriber. Seq is
// per-subscription, starting at 1, gapless — clients use it to detect loss.
type Deliver struct {
	Subject  string
	Sid      uint32
	Seq      uint32
	Reply    string
	Payload  []byte
	HasReply bool
}

// Stream ops bodies (§2.8–§2.17).

// StreamCreate opens a durable lane. Name is §3.1-chartered; the server owns
// the charset check, the codec owns the length half of it.
type StreamCreate struct {
	Name string
}

// StreamReady is the STREAM_CREATE answer. Seq is the next number the lane
// will assign — 1 for a fresh lane, past the last journaled record after
// recovery.
type StreamReady struct {
	Name string
	Seq  uint64
}

// StreamPublish journals one message on a lane. Subject must be concrete and
// its first token must equal the lane's name (server-side checks).
type StreamPublish struct {
	Stream   string
	Subject  string
	Reply    string
	Payload  []byte
	HasReply bool
}

// StreamReceipt confirms a journaled publish: the bytes are on disk and Seq
// is the lane's order for this message, global to every consumer.
type StreamReceipt struct {
	Stream string
	Seq    uint64
}

// ConsumerAttach opens or resumes a push consumer on a lane. Consumer names
// are durable: reattach after a session loss resumes from the persisted
// floor. Filter is an optional §3 pattern over message subjects.
type ConsumerAttach struct {
	Stream        string
	Consumer      string
	Sid           uint32
	Filter        string
	HasFilter     bool
	AckWaitMillis uint32 // 0 = yard default
}

// ConsumerReady is the CONSUMER_ATTACH answer and the lane's settle frame:
// Next is the first sequence the client should expect, and the consumer is
// live from here on.
type ConsumerReady struct {
	Stream        string
	Consumer      string
	Sid           uint32
	Next          uint64
	AckWaitMillis uint32
}

// StreamDeliver is one lane message toward one consumer. Seq is the lane's
// sequence — shared by every consumer of the lane — not a per-session counter.
type StreamDeliver struct {
	Subject  string
	Sid      uint32
	Seq      uint64
	Reply    string
	Payload  []byte
	HasReply bool
}

// Ack advances a consumer's position one sequence at a time. No reply frame
// exists for it; the floor advance is silent by contract (§2.15).
type Ack struct {
	Sid uint32
	Seq uint64
}

// StreamDelete removes a lane: journal and consumer positions included.
type StreamDelete struct {
	Name string
}

// StreamGone confirms a delete to sessions that held consumers on it.
type StreamGone struct {
	Name string
}

// KV ops bodies (§2.18–§2.23).

// KVSet journals one key-value pair on a lane. Payload may be empty — the
// receipt proves the write, not the value's length.
type KVSet struct {
	Lane    string
	Key     string
	Payload []byte
}

// KVGet asks for one key; the answer is a KVValue, found or not.
type KVGet struct {
	Lane string
	Key  string
}

// KVDelete journals a tombstone. Delete of a missing key still journals
// and still gets a receipt — the tombstone is the record (§2.20).
type KVDelete struct {
	Lane string
	Key  string
}

// KVKeys asks for a lane's live keys; the answer is a KVKeyList.
type KVKeys struct {
	Lane string
}

// KVValue is the KV_GET answer. Found tells whether the value rides; Seq is
// the journal sequence of the set that wrote it, 0 when not found.
type KVValue struct {
	Lane    string
	Key     string
	Seq     uint64
	Found   bool
	Payload []byte
}

// KVKeyList is the KV_KEYS answer: a lane's live keys, ascending bytewise.
type KVKeyList struct {
	Lane string
	Keys []string
}

// Console ops bodies (§2.24–§2.27): the yardmaster's read-only view.

// YardInfo asks for the yard's summary; the exact body is empty.
type YardInfo struct{}

// YardLane is one row of YardState's lane table: name and last journaled
// sequence (0 for a lane with no rows yet).
type YardLane struct {
	Name string
	Seq  uint64
}

// YardState is the YARD_INFO answer. Rows are snapshots taken lane by lane
// under each lane's own lock — consecutive rows may differ by the moments
// between reads; nothing pretends to a global freeze.
type YardState struct {
	Version     string
	UptimeSec   uint64
	Sessions    uint32
	Lanes       []YardLane
	Quarantined []string
}

// LaneInfo asks one lane for its detail; the body is the lane name alone.
type LaneInfo struct {
	Lane string
}

// LaneConsumer is one consumer row of LaneState: durable position, delivered
// rows not yet acked, and whether a session is attached right now.
type LaneConsumer struct {
	Name     string
	Floor    uint64
	Pending  uint32
	Attached bool
}

// LaneState is the LANE_INFO answer.
type LaneState struct {
	Lane         string
	Seq          uint64
	Quarantined  bool
	JournalBytes uint64
	KeyCount     uint32
	Consumers    []LaneConsumer
}
