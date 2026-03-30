#!/bin/bash
# Qar pre-install script
# Creates the qar system user and required directories.
set -e

QAR_USER="qar"
QAR_GROUP="qar"

# Create system group if it doesn't exist
if ! getent group "$QAR_GROUP" > /dev/null 2>&1; then
    groupadd --system "$QAR_GROUP"
fi

# Create system user if it doesn't exist
if ! getent passwd "$QAR_USER" > /dev/null 2>&1; then
    useradd --system --gid "$QAR_GROUP" --home-dir /opt/qar --no-create-home \
        --shell /usr/sbin/nologin "$QAR_USER"
fi

# Create data directories
mkdir -p /qar/content/tv /qar/content/movies /qar/content/web
mkdir -p /qar/disks/default/tv /qar/disks/default/movies /qar/disks/default/web
mkdir -p /qar/downloads
mkdir -p /qar/config
mkdir -p /qar/config/qBittorrent/config
mkdir -p /qar/data

# Create config directory
mkdir -p /etc/qar

# Set ownership
chown -R "$QAR_USER:$QAR_GROUP" /qar

echo "Qar pre-install complete."
