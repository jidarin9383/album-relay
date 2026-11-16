FROM mcr.microsoft.com/playwright:v1.57.0-noble
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify socat && rm -rf /var/lib/apt/lists/*
COPY browser/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh && mkdir -p /browser-data && chown pwuser:pwuser /browser-data
USER pwuser
ENV DISPLAY=:99
CMD ["/entrypoint.sh"]
