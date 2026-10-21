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
)

// Policy flags inside bodies. Bit 0 of the flag byte means "the optional
// reply subject is present" — that flag is deliberately the same bit in every
// body that carries one, so client code can branch on a single convention.
const (
	FlagReplyPresent = 0x01
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
