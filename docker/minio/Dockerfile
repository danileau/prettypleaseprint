# MinIO, built from source, for the platforms this project supports.
#
# Why this exists at all: MinIO withdrew its community distribution. The image
# is gone from Docker Hub (404), its quay.io repository refuses an anonymous
# pull, and dl.min.io answers 410 for the server binary and for mc on every
# architecture. Upstream's own Dockerfile.release downloads those binaries, so
# it cannot be used either — there is nothing left to download.
#
# The source is still public and AGPL-3.0, so this compiles it. Same release
# tag as the image the deployment already runs, which is the property that
# matters: identical server version means an identical on-disk format, so
# moving onto this image is not a data migration.
#
# Deliberately faithful to upstream's runtime layout rather than a tidier one
# of our own: the same ubi9/ubi-micro base, the same entrypoint taken from the
# source tree, the same env defaults. Anything else would be a second variable
# when this image is already replacing a known-good one.
#
# The build args are MINIO_TAG and MC_TAG, NOT MINIO_RELEASE and MC_RELEASE.
# That is not a style choice. Docker exposes every ARG to RUN as an environment
# variable, and each project's buildscripts/gen-ldflags.go reads an env var of
# its own name — MINIO_RELEASE, MC_RELEASE — as the *prefix* it puts in front of
# the version. Name the arg after the release and the prefix silently becomes
# the whole tag, so the binary reports
# `RELEASE.2025-09-07T16-13-09Z.2025-09-07T16-13-09Z`. It builds, it runs, and
# only the version string is wrong, which is the one thing someone debugging
# this image reads first.

ARG MINIO_TAG=RELEASE.2025-09-07T16-13-09Z
ARG MC_TAG=RELEASE.2025-08-13T08-35-41Z

# Pinned to the toolchain go.mod asks for at that tag (go 1.24.0 / toolchain
# go1.24.2; mc needs only 1.23, so one builder covers both). $BUILDPLATFORM
# keeps the compiler on the native architecture and cross-compiles instead of
# emulating it — Go does this well, and QEMU for a build this size is minutes
# against seconds.
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build

ARG MINIO_TAG
ARG MC_TAG
ARG TARGETARCH

ENV CGO_ENABLED=0 GOOS=linux
RUN apk add --no-cache git ca-certificates

# A full clone, not --depth 1: gen-ldflags.go shells out to `git log` for the
# commit id, and the version it stamps has to come from real history rather
# than a truncated graft.
RUN git clone --branch "${MINIO_TAG}" https://github.com/minio/minio /src/minio
WORKDIR /src/minio
# gen-ldflags.go takes the version as an ISO-8601 timestamp and builds the
# release tag as ${MINIO_RELEASE}.<timestamp>, defaulting that prefix to
# DEVELOPMENT. So the tag has to be turned back into a timestamp (upstream's
# own transformation, lifted from the `hotfix-vars` target in their Makefile)
# and the prefix set explicitly to RELEASE for the one command that reads it.
RUN ISO="$(echo "${MINIO_TAG}" | sed 's#RELEASE\.\([0-9]\+\)-\([0-9]\+\)-\([0-9]\+\)T\([0-9]\+\)-\([0-9]\+\)-\([0-9]\+\)Z#\1-\2-\3T\4:\5:\6Z#')" && \
    LDFLAGS="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${ISO}")" && \
    GOARCH="${TARGETARCH}" go build -tags kqueue -trimpath --ldflags "${LDFLAGS}" -o /out/minio . && \
    cp dockerscripts/docker-entrypoint.sh /out/docker-entrypoint.sh

# mc is not optional garnish: the compose healthcheck is `mc ready local`, so
# an image without it is a container that never reports healthy.
RUN git clone --branch "${MC_TAG}" https://github.com/minio/mc /src/mc
WORKDIR /src/mc
RUN ISO="$(echo "${MC_TAG}" | sed 's#RELEASE\.\([0-9]\+\)-\([0-9]\+\)-\([0-9]\+\)T\([0-9]\+\)-\([0-9]\+\)-\([0-9]\+\)Z#\1-\2-\3T\4:\5:\6Z#')" && \
    LDFLAGS="$(MC_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${ISO}")" && \
    GOARCH="${TARGETARCH}" go build -trimpath --ldflags "${LDFLAGS}" -o /out/mc .

# An empty /data made here so the runtime stage can COPY it in already owned by
# the right uid. Creating it there would need a RUN, and a RUN in the runtime
# stage is what would drag QEMU into the arm64 build.
RUN mkdir -p /out/data

FROM registry.access.redhat.com/ubi9/ubi-micro:latest

ARG MINIO_TAG
ARG MC_TAG

LABEL name="MinIO" \
      vendor="MinIO Inc <dev@min.io>" \
      maintainer="Pretty Please Print <https://github.com/danileau/prettypleaseprint>" \
      version="${MINIO_TAG}" \
      release="${MINIO_TAG}" \
      mc-release="${MC_TAG}" \
      summary="MinIO object storage, built from source for Pretty Please Print." \
      description="MinIO ${MINIO_TAG} and mc ${MC_TAG} compiled from the AGPL-3.0 sources, because MinIO withdrew its published images and binaries. Same release as the upstream image this replaces."

# Upstream also sets MINIO_ACCESS_KEY_FILE, MINIO_SECRET_KEY_FILE,
# MINIO_ROOT_USER_FILE, MINIO_ROOT_PASSWORD_FILE and MINIO_KMS_SECRET_KEY_FILE,
# naming files a credential may be read from instead of an environment
# variable. They are dropped here. This deployment passes MINIO_ROOT_USER and
# MINIO_ROOT_PASSWORD directly from compose and has never used the file route,
# so they enabled nothing and cost a second way to inject a credential.
#
# They also trip AVD-DS-0031 four times, because the names contain SECRET,
# PASSWORD and ACCESS_KEY while the values are only filenames. That is a false
# positive, but removing dead configuration is a better answer to one than an
# ignore file: nothing is silenced, and the finding cannot come back.
#
# MC_CONFIG_DIR stays and is load-bearing: mc writes its configuration on
# first use, $HOME is not reliably writable here, and the healthcheck is
# `mc ready local`.
ENV MINIO_CONFIG_ENV_FILE=config.env \
    MC_CONFIG_DIR=/tmp/.mc

# --chmod on COPY rather than a RUN chmod, so this stage executes nothing. That
# is what lets the arm64 image be assembled on an amd64 builder with no QEMU:
# every instruction here is a file copy, and none of them runs a foreign binary.
COPY --from=build --chmod=755 /out/minio /usr/bin/minio
COPY --from=build --chmod=755 /out/mc /usr/bin/mc
COPY --from=build --chmod=755 /out/docker-entrypoint.sh /usr/bin/docker-entrypoint.sh
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# The object store does not need to be root, and upstream's image only ran that
# way because it always had. 1000:1000 is the uid MinIO's own documentation uses
# for a non-root deployment.
#
# This has a cost and it is not hidden: /data is a bind mount, so the HOST
# directory's ownership decides whether the server can write, and an existing
# deployment's model storage is owned by the root the previous container ran as.
# Moving to this image needs that storage chowned once, which docs/deployment.md
# spells out. It is the one thing in this change that is not a pull-and-restart,
# and it is why the uid is fixed here rather than left to a compose override:
# a number that can drift per deployment is a number somebody chowns to the
# wrong value.
#
# --chown on COPY, like --chmod above, so this stage still executes nothing.
COPY --from=build --chown=1000:1000 /out/data /data

EXPOSE 9000
VOLUME ["/data"]

USER 1000:1000

ENTRYPOINT ["/usr/bin/docker-entrypoint.sh"]
CMD ["minio"]
