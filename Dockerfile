# syntax=docker/dockerfile:1
# The switchyard image: prove the whole suite inside the build, then ship
# static binaries on distroless. One image carries the yard, the console,
# and the client; compose picks the entrypoint per service.
FROM golang:1.25 AS build
WORKDIR /src
COPY go.mod ./
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go test ./...
RUN CGO_ENABLED=0 go build -o /bin/ ./cmd/...

FROM gcr.io/distroless/static-debian12
COPY --from=build /bin/ /usr/local/bin/
# The platform's probes should hit the metrics port's /health; the metrics
# page itself stays open for the scraper when the port is bound to localhost.
EXPOSE 4780 4781 8060
ENTRYPOINT ["/usr/local/bin/switchyard"]
