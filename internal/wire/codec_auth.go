package wire

// Auth-pair codecs (§2.28–§2.29): one str16 with its own cap and one
// exact-empty reply. The token is shape-checked here (1..256 bytes) and
// compared by the yard in constant time — the codec has no business
// knowing what the token proves.

// EncodeAuthenticate serializes opAuthenticate: u16 tokenLen|token.
func EncodeAuthenticate(a Authenticate) ([]byte, error) {
	if len(a.Token) == 0 || len(a.Token) > MaxAuthToken {
		return nil, newOpErr(CodeMalformed, false, "token %d bytes out of range [1,%d]", len(a.Token), MaxAuthToken)
	}
	return encStr16(nil, a.Token), nil
}

// DecodeAuthenticate parses opAuthenticate.
func DecodeAuthenticate(b []byte) (Authenticate, error) {
	d := &decoder{buf: b}
	token, err := d.str16(MaxAuthToken, "auth.token")
	if err != nil {
		return Authenticate{}, err
	}
	if err := d.exactEnd(OpAuthenticate); err != nil {
		return Authenticate{}, err
	}
	return Authenticate{Token: token}, nil
}

// EncodeAuthOK serializes opAuthOK: an empty body.
func EncodeAuthOK(AuthOK) ([]byte, error) {
	return []byte{}, nil
}

// DecodeAuthOK parses opAuthOK: nothing, exactly.
func DecodeAuthOK(b []byte) (AuthOK, error) {
	d := &decoder{buf: b}
	if err := d.exactEnd(OpAuthOK); err != nil {
		return AuthOK{}, err
	}
	return AuthOK{}, nil
}
