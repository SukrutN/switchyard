package lensweb

import (
	"embed"
	"io/fs"
	"net/http"
)

// The console's pages ride inside the binary: no external assets, no
// CDN, nothing to lose when the network is the thing being watched.
//
//go:embed static
var staticDir embed.FS

// static serves the embedded console pages.
func static() http.Handler {
	sub, err := fs.Sub(staticDir, "static")
	if err != nil {
		// embed errors are compile-time; this cannot happen
		panic(err)
	}
	return http.FileServerFS(sub)
}
