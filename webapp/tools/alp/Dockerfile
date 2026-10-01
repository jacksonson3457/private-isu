FROM golang:1.24-alpine AS builder

ARG ALP_VERSION=v1.0.21

RUN CGO_ENABLED=0 go install github.com/tkuchiki/alp/cmd/alp@${ALP_VERSION}

FROM alpine:3.22

COPY --from=builder /go/bin/alp /usr/local/bin/alp

ENTRYPOINT ["alp"]
