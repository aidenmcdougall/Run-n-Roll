# osm2pgsql, the standard OpenStreetMap -> PostGIS loader.
# Built from Debian's package so it runs natively on both amd64 and arm64.
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends osm2pgsql ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["osm2pgsql"]
