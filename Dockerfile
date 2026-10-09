FROM ghcr.io/mon-ius/docker-warp-socks:v8
RUN sed -i 's/"mtu": 1408/"mtu": 1000/' /run/entrypoint.sh
