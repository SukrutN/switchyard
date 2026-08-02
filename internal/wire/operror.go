package wire

import "fmt"

// ProtocolError classifies why decoding failed so the caller can decide between
// "close now" and "tell the client and keep the session". It wraps the raw
// cause, never hides it. (Named to avoid colliding with the OpError opcode.)
type ProtocolError struct {
	Code  byte
	Fatal bool
	Msg   string
}

func (e *ProtocolError) Error() string {
	return fmt.Sprintf("protocol %s (code 0x%02X): %s", NameFor(e.Code), e.Code, e.Msg)
}

// Protocol error codes, stable across releases (docs/PROTOCOL.md §6).
const (
	CodeMalformed     byte = 0x01 // frame could not be parsed — always fatal
	CodeVersion       byte = 0x02 // wrong protocol version on the frame — always fatal
	CodeBadSubject    byte = 0x03 // subject/pattern violates the charter
	CodeDupSub        byte = 0x04 // sid already subscribed by this session
	CodeNoSub         byte = 0x05 // sid unknown (unsubscribe on a dead spur)
	CodeTooLarge      byte = 0x06 // body/payload above this server's advertised limit
	CodeSlowConsumer  byte = 0x07 // reader outran the deliver loop — always fatal
	CodeNotHandshaked byte = 0x08 // op arrived before HELLO/WELCOME completed
	CodeUnknownOp     byte = 0x09 // op number has no meaning in this version — always fatal
	CodeIdleTimeout   byte = 0x0A // no frames for Idle+Grace — always fatal
	// Lane refusals: a naming or routing mistake keeps the session alive.
	CodeStreamUnknown  byte = 0x0B // no lane by that name
	CodeStreamExists   byte = 0x0C // STREAM_CREATE for an existing lane
	CodeBadStreamName  byte = 0x0D // lane name off the §3.1 charter
	CodeStreamSubject  byte = 0x0E // subject's first token is not this lane
	CodeDupConsumer    byte = 0x0F // consumer name live on another session
	CodeNoConsumer     byte = 0x10 // consumer name unknown to this lane
	CodeStreamDisabled byte = 0x11 // yard has no data dir; lanes refused
	CodeServerFault    byte = 0x12 // storage refused the op; nothing pretended
)

// NameFor exposes the operator-facing name of a protocol error code. Lives
// next to the table it mirrors: when a code is added, the name is too.
func NameFor(code byte) string {
	switch code {
	case CodeMalformed:
		return "malformed"
	case CodeVersion:
		return "unsupported-version"
	case CodeBadSubject:
		return "bad-subject"
	case CodeDupSub:
		return "duplicate-subscription"
	case CodeNoSub:
		return "no-such-subscription"
	case CodeTooLarge:
		return "payload-too-large"
	case CodeSlowConsumer:
		return "slow-consumer"
	case CodeNotHandshaked:
		return "not-handshaked"
	case CodeUnknownOp:
		return "unknown-op"
	case CodeIdleTimeout:
		return "idle-timeout"
	case CodeStreamUnknown:
		return "stream-unknown"
	case CodeStreamExists:
		return "stream-exists"
	case CodeBadStreamName:
		return "bad-stream-name"
	case CodeStreamSubject:
		return "stream-subject-mismatch"
	case CodeDupConsumer:
		return "duplicate-consumer"
	case CodeNoConsumer:
		return "no-such-consumer"
	case CodeStreamDisabled:
		return "stream-disabled"
	case CodeServerFault:
		return "server-fault"
	default:
		return "error"
	}
}

// newOpErr builds a decode failure with the exact position it gave up at;
// "at +12" turns debugging a hex dump from archaeology into lookup.
func newOpErr(code byte, fatal bool, format string, args ...any) error {
	return &ProtocolError{Code: code, Fatal: fatal, Msg: fmt.Sprintf(format, args...)}
}
